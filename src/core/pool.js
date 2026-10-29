'use strict';
/**
 * pool.js —— 内容池（定时自动成文的题目队列）。
 *
 * 解决的问题：v2 的素材成文 / 对话共创 / 选题雷达都是「点一下才动」，
 * 定时任务只驱动仓库自动（git 增量）那一条。用户想要的「我预先准备一批内容，
 * 每天到点自动写一条并进草稿箱」在 v1/v2 里没有承载物——本模块就是那个承载物。
 *
 * 语义约定：
 * - 队列（FIFO）：nextPending 取**最早入池**的 pending 条目，先准备的先写；
 * - 状态机：pending → used（成功成文并落盘）；pending → skipped（人工跳过 / 连续失败 3 次）；
 *   生成失败**不消耗**条目（保持 pending，记 lastError 与 attempts），避免一次网络抖动就吃掉一篇选题；
 * - 幂等：used 条目永不再被取；同一天只写一条由调度侧 lastScheduledDate 保证（本模块不管日期）；
 * - 单文件存储 DATA/content-pool.json（条目量小、顺序重要，单文件比一文件一条更好维护），
 *   原子写沿用 persist.writeJson（tmp + rename，断电可恢复）。
 *
 * 仅 Node 内置模块，禁止 import electron。
 */
const path = require('node:path');
const { readJson, writeJson } = require('./persist');

const POOL_FILE = 'content-pool.json';
const POOL_VERSION = 1;
/** 池容量上限：条目再多也不会一天写两篇，纯防误操作把文件撑大。 */
const MAX_ITEMS = 200;
const MAX_TITLE = 120;
const MAX_MATERIAL = 50000;
const MAX_EMPHASIS = 500;
/** 同一条目连续失败达到此次数即自动跳过，避免一条坏数据每天失败、把后面的选题堵死。 */
const MAX_ATTEMPTS = 3;

const STATUS_VALUES = ['pending', 'used', 'skipped'];

function inputError(message) {
  const e = new Error(message);
  e.code = 'E_INVALID_INPUT';
  return e;
}

function notFound(message) {
  const e = new Error(message);
  e.code = 'E_NOT_FOUND';
  return e;
}

function ioError(message) {
  const e = new Error(message);
  e.code = 'E_IO';
  return e;
}

function isoNow(now) {
  return (now ? new Date(now) : new Date()).toISOString();
}

function cpLen(s) {
  return Array.from(String(s == null ? '' : s)).length;
}

function defaultPool() {
  return { version: POOL_VERSION, items: [] };
}

function poolPath(dataDir) {
  return path.join(dataDir, POOL_FILE);
}

/**
 * 读取内容池：不存在 → 空池；损坏 → E_IO（不静默重置，否则用户准备的内容会无声消失）。
 * 结构异常（items 不是数组）同样按空池处理并保留原文件不动——下一次保存才会覆盖。
 */
function loadPool(dataDir) {
  if (!dataDir) throw ioError('读取内容池失败：缺少数据目录');
  const doc = readJson(poolPath(dataDir));
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return defaultPool();
  const items = Array.isArray(doc.items) ? doc.items.filter((it) => it && typeof it === 'object' && it.id) : [];
  return { version: POOL_VERSION, items };
}

/** 原子保存（items 直接落盘；写入前按入池顺序稳定排序）。 */
function savePool(dataDir, pool) {
  if (!dataDir) throw ioError('保存内容池失败：缺少数据目录');
  const items = Array.isArray(pool && pool.items) ? pool.items.slice() : [];
  writeJson(dataDir, POOL_FILE, { version: POOL_VERSION, items });
  return { version: POOL_VERSION, items };
}

/** 条目 id：pl-<YYYYMMDD>-<HHMMSS>-<4 位随机>（同秒多条不冲突）。 */
function newItemId(now) {
  const d = now ? new Date(now) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `pl-${stamp}-${rand}`;
}

/**
 * 入参归一与校验 → {title, material, emphasis}。
 * title 必填（≤120 字）；material/emphasis 选填（material ≤50000，emphasis ≤500）。
 * material 为空时该条是「只给题目，让 AI 自己展开」，成文时走 topic 提示词分支。
 */
function normalizeItemInput(input) {
  const raw = input || {};
  const title = String(raw.title == null ? '' : raw.title).trim();
  if (!title) throw inputError('题目不能为空：这一条写什么主题，例如「分级阅读怎么给 5 岁孩子选书」');
  if (cpLen(title) > MAX_TITLE) throw inputError(`题目超长（最多 ${MAX_TITLE} 字，当前 ${cpLen(title)} 字）`);
  const material = String(raw.material == null ? '' : raw.material).trim();
  if (cpLen(material) > MAX_MATERIAL) throw inputError(`素材超长（最多 ${MAX_MATERIAL} 字，当前 ${cpLen(material)} 字）`);
  const emphasis = String(raw.emphasis == null ? '' : raw.emphasis).trim();
  if (cpLen(emphasis) > MAX_EMPHASIS) throw inputError(`强调点超长（最多 ${MAX_EMPHASIS} 字，当前 ${cpLen(emphasis)} 字）`);
  return { title, material, emphasis };
}

/** 入池（追加到队尾）→ {item, total}。超上限抛 E_INVALID_INPUT。 */
function addItem(pool, input, { now } = {}) {
  if (!pool || !Array.isArray(pool.items)) throw inputError('addItem 需要内容池对象');
  if (pool.items.length >= MAX_ITEMS) {
    throw inputError(`内容池已满（上限 ${MAX_ITEMS} 条）：先删掉一些已用条目再添加`);
  }
  const clean = normalizeItemInput(input);
  const item = {
    id: newItemId(now),
    title: clean.title,
    material: clean.material,
    emphasis: clean.emphasis,
    status: 'pending',
    createdAt: isoNow(now),
    attempts: 0,
  };
  pool.items.push(item);
  return { item, total: pool.items.length };
}

/** 按 id 定位（返回引用）；未找到 → null。 */
function findItem(pool, id) {
  if (!pool || !Array.isArray(pool.items)) return null;
  return pool.items.find((it) => it && it.id === String(id || '')) || null;
}

/**
 * 修改条目（仅 title/material/emphasis）。已用条目也允许改——用户可能想修好下个月复用；
 * 但**不允许改 status**（状态只能经 markUsed / markSkipped / reset 流转）。
 */
function updateItem(pool, id, patch) {
  const item = findItem(pool, id);
  if (!item) throw notFound(`内容池里没有 id=${id} 的条目（可能已被删除）`);
  const merged = normalizeItemInput({
    title: patch && patch.title !== undefined ? patch.title : item.title,
    material: patch && patch.material !== undefined ? patch.material : item.material,
    emphasis: patch && patch.emphasis !== undefined ? patch.emphasis : item.emphasis,
  });
  item.title = merged.title;
  item.material = merged.material;
  item.emphasis = merged.emphasis;
  item.updatedAt = isoNow(patch && patch.now);
  return item;
}

/** 删除条目（幂等：不存在返回 false）。 */
function removeItem(pool, id) {
  if (!pool || !Array.isArray(pool.items)) return false;
  const idx = pool.items.findIndex((it) => it && it.id === String(id || ''));
  if (idx < 0) return false;
  pool.items.splice(idx, 1);
  return true;
}

/**
 * 取下一条待写条目（FIFO：最早入池的 pending）→ item 或 null。
 * createdAt 相同（同秒批量导入）时按数组顺序兜底，保证「先加的先用」不被排序打乱。
 */
function nextPending(pool) {
  if (!pool || !Array.isArray(pool.items)) return null;
  let best = null;
  let bestIdx = -1;
  for (let i = 0; i < pool.items.length; i++) {
    const it = pool.items[i];
    if (!it || it.status !== 'pending') continue;
    if (best === null) {
      best = it;
      bestIdx = i;
      continue;
    }
    const a = String(it.createdAt || '');
    const b = String(best.createdAt || '');
    if (a < b || (a === b && i < bestIdx)) {
      best = it;
      bestIdx = i;
    }
  }
  return best;
}

/** 标记已用（成文成功）→ item；未找到 E_NOT_FOUND。 */
function markUsed(pool, id, { articleId, now } = {}) {
  const item = findItem(pool, id);
  if (!item) throw notFound(`内容池里没有 id=${id} 的条目，无法标记已用`);
  item.status = 'used';
  item.usedAt = isoNow(now);
  if (articleId) item.articleId = String(articleId);
  delete item.lastError;
  return item;
}

/** 标记跳过（人工跳过 / 连续失败自动跳过）。 */
function markSkipped(pool, id, { reason, now } = {}) {
  const item = findItem(pool, id);
  if (!item) throw notFound(`内容池里没有 id=${id} 的条目，无法标记跳过`);
  item.status = 'skipped';
  item.skippedAt = isoNow(now);
  if (reason) item.skipReason = String(reason);
  return item;
}

/**
 * 记录一次生成失败 → {item, exhausted}。
 * 条目保持 pending（失败不该吃掉选题）；attempts 达到 MAX_ATTEMPTS 自动跳过，返回 exhausted=true。
 */
function markAttemptFailed(pool, id, { error, now } = {}) {
  const item = findItem(pool, id);
  if (!item) throw notFound(`内容池里没有 id=${id} 的条目`);
  item.attempts = (Number(item.attempts) || 0) + 1;
  item.lastError = error ? String(error) : '未知错误';
  item.lastTriedAt = isoNow(now);
  if (item.attempts >= MAX_ATTEMPTS) {
    markSkipped(pool, id, { reason: `连续失败 ${item.attempts} 次，已跳过：${item.lastError}`, now });
    return { item, exhausted: true };
  }
  return { item, exhausted: false };
}

/** 统计 → {total, pending, used, skipped}。 */
function stats(pool) {
  const items = Array.isArray(pool && pool.items) ? pool.items : [];
  const out = { total: items.length, pending: 0, used: 0, skipped: 0 };
  for (const it of items) {
    if (it && STATUS_VALUES.includes(it.status)) out[it.status] += 1;
  }
  return out;
}

/** 把已用条目放回队列（「重新排队」），返回放回条数。 */
function resetUsed(pool) {
  const items = Array.isArray(pool && pool.items) ? pool.items : [];
  let n = 0;
  for (const it of items) {
    if (it && it.status === 'used') {
      it.status = 'pending';
      delete it.usedAt;
      delete it.articleId;
      n += 1;
    }
  }
  return n;
}

module.exports = {
  POOL_FILE,
  POOL_VERSION,
  MAX_ITEMS,
  MAX_TITLE,
  MAX_MATERIAL,
  MAX_EMPHASIS,
  MAX_ATTEMPTS,
  STATUS_VALUES,
  defaultPool,
  poolPath,
  loadPool,
  savePool,
  newItemId,
  normalizeItemInput,
  addItem,
  findItem,
  updateItem,
  removeItem,
  nextPending,
  markUsed,
  markSkipped,
  markAttemptFailed,
  resetUsed,
  stats,
};
