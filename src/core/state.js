'use strict';
/**
 * state.js —— 状态 JSON 读写。
 * state 形状：{lastHead, lastRunDate, lastScheduledDate, cover:{sha256,mediaId},
 *              history:[{date,title,status,words,draftMediaId?,error?}]}
 * status 枚举同设计稿：'uploaded' | 'generated' | 'skipped' | 'failed'。
 * 保存为 tmp+rename 原子写，断电可恢复；历史单日单条 upsert，按日期升序存储。
 */
const fs = require('node:fs');
const path = require('node:path');

/** v2.4：状态枚举扩展——
 * published = 已发表（状态同步：草稿箱无此稿且命中发布列表）；
 * removed   = 已删除（状态同步：草稿箱无此稿且未发表，用户在公众号里删了）；
 * replaced  = 已打回（用户对该稿点了「打回重写」，新稿已生成/上传，旧稿不再追踪）。 */
const STATUS_VALUES = ['uploaded', 'generated', 'skipped', 'failed', 'published', 'removed', 'replaced'];
/** v2 历史来源枚举。
 * 「内容池」为 v2.2 增量：定时任务从内容池取题自动成文，与手动「素材成文」区分开，
 * 否则历史里分不清哪条是挂机写的、哪条是自己点的。 */
const ORIGIN_VALUES = ['素材', '对话', '自动', '聚合', '内容池'];

function defaultState() {
  return {
    lastHead: null,
    lastRunDate: null,
    lastScheduledDate: null,
    cover: null,
    history: [],
  };
}

function statePath(dir) {
  return path.join(dir, 'state.json');
}

function ioError(message) {
  const e = new Error(message);
  e.code = 'E_IO';
  return e;
}

/** 读取 state：不存在 → 默认值；损坏 → E_IO（不静默重置，避免悄悄丢历史）。 */
function loadState(dir) {
  const p = statePath(dir);
  if (!fs.existsSync(p)) return defaultState();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw ioError(`读取 state.json 失败：${e.message}`);
  }
  if (!String(raw).trim()) return defaultState();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw ioError(`state.json 已损坏，无法解析：${e.message}（可删除该文件重试，历史记录会清空）`);
  }
  return { ...defaultState(), ...data, history: Array.isArray(data.history) ? data.history : [] };
}

/**
 * 原子保存：写临时文件后 rename 覆盖（Node 在 Windows 上 rename 会替换已有文件）。
 * 目录不存在则递归创建。
 */
function saveState(dir, state) {
  if (!dir) throw ioError('保存 state 失败：缺少数据目录');
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.state.json.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(state == null ? defaultState() : state, null, 2), 'utf8');
    fs.renameSync(tmp, statePath(dir));
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* 清理失败忽略 */
    }
    throw ioError(`保存 state.json 失败：${e.message}`);
  }
}

function compareDate(a, b) {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
}

/** 同日多条（v2 素材/对话/聚合）按创建时间倒序；createdAt 缺省的旧记录排在同日末尾。 */
function compareEntry(a, b) {
  const d = compareDate(a, b);
  if (d !== 0) return d;
  const ca = (a && a.createdAt) || '';
  const cb = (b && b.createdAt) || '';
  return ca < cb ? -1 : ca > cb ? 1 : 0;
}

/**
 * 合并两份 state（磁盘快照 + 内存快照）——用于「持有旧快照的调用方最后才保存」的场景：
 * 运行中（pipeline/定时）拿到的 state 快照在结束时会整文件写回，若期间其它 v2 成文已写入
 * 历史，旧快照会把它们覆盖掉（成文目录还在、历史条目消失），lastScheduledDate 也可能被清掉
 * 导致同一天定时再跑一次。
 * 规则：标量取「较晚/非空」；history 以磁盘为基础按 (id 或 date) upsert 内存条目，
 * 且磁盘里已上传的条目不会被内存里的旧状态降级。
 */
function mergeStates(disk, memory) {
  const base = disk && typeof disk === 'object' ? disk : defaultState();
  const mem = memory && typeof memory === 'object' ? memory : defaultState();
  const later = (a, b) => (a && b ? (a > b ? a : b) : (a || b || null));
  const out = { ...defaultState(), ...base };
  out.lastHead = mem.lastHead || base.lastHead || null;
  out.lastRunDate = later(base.lastRunDate, mem.lastRunDate);
  out.lastScheduledDate = later(base.lastScheduledDate, mem.lastScheduledDate);
  out.cover = mem.cover || base.cover || null;
  const keyOf = (r) => (r && r.id ? 'id:' + r.id : 'date:' + (r && r.date));
  const map = new Map();
  for (const r of Array.isArray(base.history) ? base.history : []) {
    if (r) map.set(keyOf(r), r);
  }
  for (const r of Array.isArray(mem.history) ? mem.history : []) {
    if (!r) continue;
    const k = keyOf(r);
    const prev = map.get(k);
    if (prev && prev.status === 'uploaded' && r.status !== 'uploaded') {
      map.set(k, prev);
      continue;
    }
    map.set(k, r);
  }
  out.history = [...map.values()].sort(compareEntry);
  return out;
}

/**
 * 读磁盘最新 state → 与内存快照合并 → 原子写回，并把合并结果回写到传入的 state 对象
 * （调用方后续读 state.history 仍是有效的）。返回合并后的 state。
 */
function saveStateMerged(dir, state) {
  if (!dir) throw ioError('保存 state 失败：缺少数据目录');
  let disk = null;
  try {
    disk = loadState(dir);
  } catch (e) {
    disk = null; // 磁盘损坏时按内存快照写入（loadState 已在别处抛错给用户，这里不阻断保存）
  }
  const merged = mergeStates(disk, state);
  saveState(dir, merged);
  if (state && typeof state === 'object') {
    for (const k of Object.keys(merged)) state[k] = merged[k];
  }
  return state || merged;
}

/**
 * 按 date upsert 单条历史记录（v1：单日单条）。
 * v2 增量：
 * - run.origin ∈ ORIGIN_VALUES（素材/对话/自动/聚合）写入 entry.origin；未提供 → '自动'（v1 仓库自动）；
 * - run.id（如聚合批次 id）提供时按 id upsert，同一天可并存多条不同 id 的记录
 *   （聚合/素材/对话模式一天可能成文多篇）；无 id 的调用保持 v1「单日单条」语义，
 *   且不会覆盖带 id 的条目。
 * run 必填 {date, status}，可选 {title, words, draftMediaId, error, origin, id}。
 * 记录后保持按日期升序；返回该条目（引用）。
 */
function recordRun(state, run) {
  if (!state || !run || !run.date || !run.status) {
    const e = new Error('recordRun 需要 {date, status}');
    e.code = 'E_INVALID_INPUT';
    throw e;
  }
  if (!Array.isArray(state.history)) state.history = [];
  const entry = {
    date: run.date,
    title: run.title == null ? '' : run.title,
    status: run.status,
    words: run.words == null ? null : run.words,
    origin: ORIGIN_VALUES.includes(run.origin) ? run.origin : '自动',
    createdAt: run.createdAt || new Date().toISOString(), // 同日多条排序用（操作审查：最近文章要按新→旧）
  };
  if (run.id) entry.id = String(run.id);
  if (run.draftMediaId) entry.draftMediaId = run.draftMediaId;
  if (run.error) entry.error = run.error;
  const idx = run.id
    ? state.history.findIndex((r) => r && r.id === entry.id)
    : state.history.findIndex((r) => r && !r.id && r.date === run.date);
  if (idx >= 0) {
    const prev = state.history[idx] || {};
    // 同日重跑保留原创建时间，避免 upsert 让旧记录排到最新
    if (!run.createdAt && prev.createdAt) entry.createdAt = prev.createdAt;
    state.history[idx] = entry;
  } else state.history.push(entry);
  state.history.sort(compareEntry);
  return entry;
}

/** 标记某日已上传：更新 status/draftMediaId 并清除 error；当天无记录则补一条。 */
function markUploaded(state, date, mediaId) {
  if (!state || !date) {
    const e = new Error('markUploaded 需要 state 与 date');
    e.code = 'E_INVALID_INPUT';
    throw e;
  }
  if (!Array.isArray(state.history)) state.history = [];
  // 只匹配不带 id 的 v1 条目：同一天可能并存 v2 创作产物（带 id），不得被 v1 上传误标
  let entry = state.history.find((r) => r && !r.id && r.date === date);
  if (!entry) {
    entry = { date, title: '', status: 'uploaded', words: null, createdAt: new Date().toISOString() };
    state.history.push(entry);
  }
  entry.status = 'uploaded';
  if (mediaId) entry.draftMediaId = mediaId;
  delete entry.error;
  state.history.sort(compareEntry);
  return entry;
}

/**
 * v2 增量：按 id 标记创作产物已上传（main/articles.js 的 compose:upload 使用）。
 * 未找到 → E_NOT_FOUND（创作产物必须先经 recordRun 带 id 入列）。
 */
function markUploadedById(state, id, mediaId) {
  if (!state || !id) {
    const e = new Error('markUploadedById 需要 state 与 id');
    e.code = 'E_INVALID_INPUT';
    throw e;
  }
  if (!Array.isArray(state.history)) state.history = [];
  const entry = state.history.find((r) => r && r.id === id);
  if (!entry) {
    const e = new Error(`历史记录中没有 id=${id} 的创作产物，无法标记已上传`);
    e.code = 'E_NOT_FOUND';
    throw e;
  }
  entry.status = 'uploaded';
  if (mediaId) entry.draftMediaId = mediaId;
  delete entry.error;
  state.history.sort(compareEntry);
  return entry;
}

/**
 * 读取历史（新日期在前，返回副本）。
 * filter ∈ 'all'|'uploaded'|'generated'|'skipped'|'failed'；'all'/undefined/未知值 → 全部。
 * origin（v2 增量）：'all'/undefined → 全部来源；否则按 entry.origin 过滤，
 * 旧 v1 数据没有 origin 字段，按 '自动' 归类。
 */
function getHistory(state, filter, origin) {
  const items = Array.isArray(state && state.history) ? state.history : [];
  const rows = items
    .filter((r) => !filter || filter === 'all' || (r && r.status === filter))
    .filter((r) => {
      if (!origin || origin === 'all') return true;
      const o = (r && r.origin) || '自动';
      return o === origin;
    });
  return rows
    .slice()
    .sort((a, b) => compareEntry(b, a))
    .map((r) => ({ ...r }));
}

module.exports = {
  STATUS_VALUES,
  ORIGIN_VALUES,
  defaultState,
  statePath,
  loadState,
  saveState,
  recordRun,
  markUploaded,
  markUploadedById,
  getHistory,
  compareEntry,
  mergeStates,
  saveStateMerged,
};
