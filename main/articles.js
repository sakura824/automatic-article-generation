'use strict';
/**
 * articles.js —— v2 创作产物（素材/对话成文）的落盘与上传（main 进程侧，边界 B）。
 *
 * 分工：聚合模式（D）的产物由 src/core/aggregate.composeFromTopics 自带落盘
 * （output/<date>/aggregate/<batchId>/ + recordRun origin='聚合'）；本模块补齐
 * 素材/对话两种模式的同构能力（src/core/chat.js 只产出 {title,digest,html}，不落盘）：
 * - 落盘 output/<date>/compose/<articleId>/：article.json + preview.html；
 * - 历史：经 src/core/state.recordRun（v2 已支持 id/origin）入列，origin ∈ '素材'|'对话'；
 * - 上传：复用 wechat.js（token → 封面 → payload → draft），compose:upload 调 uploadById。
 * 合规（PRD v2 §5.2）：素材来源清单只落 sources.json / similarity.json 供内部查看，
 * 一律不进入 article.html，不随文发布。
 */
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeHtml, buildPreviewHtml, buildArticlePayload, countWords } = require('../src/core/article');
const { getAccessToken, ensureCoverMaterial, createDraft } = require('../src/core/wechat');
const { recordRun, markUploadedById, saveStateMerged } = require('../src/core/state');
const { stripIllustrations } = require('../src/core/illustration');

/**
 * 懒加载插图渲染器。
 * 不能在文件头 require('./illustration')：那个模块 import 了 electron，
 * 而 test/v2-articles.test.js 会在纯 node 环境下直接 require 本文件（没有 electron 会抛错）。
 * 渲染失败/环境不支持时返回 null → 调用方跳过插图，正文照常落盘。
 */
function lazyMaterialize() {
  try {
    if (typeof require('electron').BrowserWindow !== 'function') return null;
    return require('./illustration').materializeArticle;
  } catch (e) {
    return null;
  }
}

const MAX_TITLE = 58; // 与 llm.parseLlmOutput 同口径
const MAX_DIGEST = 118;

function ioError(message) {
  const e = new Error(message);
  e.code = 'E_IO';
  return e;
}

function notFound(message) {
  const e = new Error(message);
  e.code = 'E_NOT_FOUND';
  return e;
}

function cpSlice(s, n) {
  return Array.from(String(s || '')).slice(0, n).join('');
}

function isoNow(now) {
  return (now ? new Date(now) : new Date()).toISOString();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 创作产物 id：art-<YYYYMMDD>-<HHMMSS>-<4 位随机>（同秒多篇不冲突）。 */
function newArticleId(now) {
  const d = now ? new Date(now) : new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `art-${stamp}-${rand}`;
}

function composeDir(dataDir, date, articleId) {
  return path.join(dataDir, 'output', date, 'compose', articleId);
}

function articleFile(dir) {
  return path.join(dir, 'article.json');
}

/** 按 id 找历史条目（v2 创作产物）；未找到 → null。 */
function findEntryById(state, id) {
  if (!state || !Array.isArray(state.history)) return null;
  return state.history.find((r) => r && r.id === id) || null;
}

/** 状态保存失败只告警不中断（pipeline 同约定）。 */
function persistState(dataDir, state, logger) {
  try {
    saveStateMerged(dataDir, state);
  } catch (e) {
    if (logger) logger.warn(`状态保存失败：${e.message}`);
  }
}

/**
 * 保存一篇成文 → {id, dir, article, words, entry}。
 * article: {title, digest, html}；origin ∈ '素材'|'对话'|'内容池'；date 为归属日（YYYY-MM-DD）。
 * 「内容池」是 v2.2 增量：定时任务从内容池取题自动成文，走同一条落盘/上传链路，
 * 只在历史来源上区分（否则分不清是挂机写的还是手动点的）。
 */
async function saveComposedArticle({ dataDir, state, origin, article, date, now, logger, materialize } = {}) {
  if (!dataDir) throw ioError('保存成文失败：缺少数据目录');
  if (!['素材', '对话', '内容池'].includes(origin)) {
    const e = new Error(`origin 只能为 素材/对话/内容池，收到：${origin}`);
    e.code = 'E_INVALID_INPUT';
    throw e;
  }
  if (!article || typeof article.html !== 'string' || !article.html.trim()) {
    throw ioError('成文正文为空，无法保存');
  }
  const id = newArticleId(now);
  const dir = composeDir(dataDir, date, id);
  fs.mkdirSync(dir, { recursive: true });
  const clean = {
    id,
    title: cpSlice(String(article.title || '').replace(/\s+/g, ' ').trim(), MAX_TITLE),
    digest: cpSlice(String(article.digest || '').replace(/\s+/g, ' ').trim(), MAX_DIGEST),
    html: sanitizeHtml(article.html),
    origin,
    date,
    createdAt: isoNow(now),
  };

  // v2.3：正文插图（<illus> → PNG 内联）。渲染失败只丢图、不阻断成文。
  // materialize 可由调用方注入（测试用 stub），缺省走主进程渲染器。
  const render = typeof materialize === 'function' ? materialize : lazyMaterialize();
  if (render) {
    try {
      const m = await render(clean, { logger });
      if (m && m.article && typeof m.article.html === 'string') Object.assign(clean, m.article);
    } catch (e) {
      throw e;
    }
  }

  clean.words = countWords(clean.html);
  fs.writeFileSync(articleFile(dir), JSON.stringify(clean, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'preview.html'), buildPreviewHtml(clean), 'utf8');
  const entry = recordRun(state, { id, date, title: clean.title, status: 'generated', words: clean.words, origin });
  entry.dir = dir; // history:list / preview / save / upload 都经 entry.dir 定位产物
  persistState(dataDir, state, logger);
  return { id, dir, article: clean, words: clean.words, entry };
}

/** 按 id 读取成文（entry 缺 dir / 文件缺失 → E_NOT_FOUND；损坏 → E_IO）。 */
function loadComposedArticle(state, id) {
  const entry = findEntryById(state, id);
  if (!entry || !entry.dir || !fs.existsSync(articleFile(entry.dir))) {
    throw notFound(`创作产物不存在或已移动（id=${id}）`);
  }
  let article;
  try {
    article = JSON.parse(fs.readFileSync(articleFile(entry.dir), 'utf8'));
  } catch (e) {
    throw ioError(`成文文件损坏：${e.message}（${entry.dir}）`);
  }
  return { entry, article };
}

/**
 * 编辑后保存（compose:save）：title/digest 截断同 parseLlmOutput 口径，html 消毒后重算字数。
 * 正文被人工真正改写时在 similarity.json 记 manualEditAt —— 相似度改写关卡随之放行
 * （人工改写本身就是关卡要求的动作；报告与 maxRatio 原样保留作审计）。
 * 注意：渲染层「上传到草稿箱」会先无条件保存一次当前正文（compose.js upload → saveEdits），
 * 因此不能「收到 html 字段」就记 manualEditAt——必须与磁盘上已保存的正文实际不同才算人工改写，
 * 否则一字未改也能解锁关卡（PRD v2 §5.1 关卡形同虚设）。
 * 返回 {article, words}；历史条目同步 title/words。
 */
function saveComposedPatch({ dataDir, state, id, patch = {}, now, logger } = {}) {
  const { entry, article } = loadComposedArticle(state, id);
  const prevHtml = String(article.html || '');
  if (patch.title !== undefined) article.title = cpSlice(String(patch.title || '').replace(/\s+/g, ' ').trim(), MAX_TITLE);
  if (patch.digest !== undefined) article.digest = cpSlice(String(patch.digest || '').replace(/\s+/g, ' ').trim(), MAX_DIGEST);
  if (patch.html !== undefined) {
    const html = sanitizeHtml(patch.html);
    if (!html.trim()) throw ioError('编辑后的正文为空，已保留原文');
    article.html = html;
    // 仅当正文确实发生变化时才视为「人工改写」→ 放行改写关卡
    if (html !== prevHtml) {
      const sim = loadInternalDoc(entry.dir, 'similarity.json');
      if (sim && typeof sim === 'object') {
        sim.manualEditAt = isoNow(now);
        try {
          fs.writeFileSync(path.join(entry.dir, 'similarity.json'), JSON.stringify(sim, null, 2), 'utf8');
        } catch (e) {
          if (logger) logger.warn(`similarity.json 更新失败（${e.message}），改写关卡维持原状`);
        }
      }
    }
  }
  article.words = countWords(article.html);
  article.updatedAt = isoNow(now);
  fs.writeFileSync(articleFile(entry.dir), JSON.stringify(article, null, 2), 'utf8');
  fs.writeFileSync(path.join(entry.dir, 'preview.html'), buildPreviewHtml(article), 'utf8');
  entry.title = article.title;
  entry.words = article.words;
  persistState(dataDir, state, logger);
  return { article, words: article.words };
}

/**
 * 相似度人工改写关卡（PRD v2 §5.1，PRD v2 §5.4 人工审阅关卡的主进程消费点）：
 * 聚合成文 similarity.json.needsRewrite=true（自动重写后仍超阈值）时阻止 compose:upload，
 * 直到用户在编辑器修改正文并 compose:save（saveComposedPatch 会记 manualEditAt 放行）。
 * 返回 null（放行）或错误对象。
 */
function rewriteGate(entry, dir) {
  const file = path.join(dir, 'similarity.json');
  let sim = null;
  if (fs.existsSync(file)) {
    // 文件存在但解析失败必须 fail-closed：无法确认是否超阈值时不能放行（与 sourceLeakGuard 同口径）
    try {
      sim = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      const bad = new Error(
        `相似度报告（similarity.json）损坏，无法确认是否已过人工改写关卡：${e.message}。` +
        '请删除该文件后重试，或先在编辑器里完整改写一遍正文再上传'
      );
      bad.code = 'E_REWRITE_REQUIRED';
      return bad;
    }
  }
  if (!sim || sim.needsRewrite !== true || sim.manualEditAt) return null;
  const pct = Math.round((Number(sim.maxRatio) || 0) * 100);
  const thr = Math.round((Number(sim.threshold) || 0) * 100);
  const e = new Error(
    `相似度自检未通过（最高重叠率 ${pct}% > 阈值 ${thr}%，自动重写 ${sim.rewriteAttempts || 0} 次仍超限）：` +
    '这是人工改写关卡——请在编辑器中修改正文与来源雷同的片段并保存，保存后即可上传'
  );
  e.code = 'E_REWRITE_REQUIRED';
  e.similarity = sim;
  return e;
}

/**
 * 「素材来源清单不随文发布」的后置兜底校验（PRD v2 §5.2）：
 * 常规防线是提示词规则 + 清单只落 sources.json；但 LLM 若把来源链接写进正文/标题/摘要，
 * 会原样随草稿发布。这里比对 sources.json 的来源 URL（完整 URL 与「域名+路径」两种写法都查），
 * 覆盖 title/digest；sources.json 存在但解析失败时 fail-closed 拦截。
 * 返回错误对象（调用方拦截）或 null。
 */
function sourceLeakGuard(dir, fields) {
  const file = path.join(dir, 'sources.json');
  let list = [];
  if (fs.existsSync(file)) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      const bad = new Error(
        `素材来源清单（sources.json）损坏，无法确认正文是否含来源链接：${e.message}。` +
        '请删除该文件后重试，或确认正文/标题/摘要里没有引用来源链接'
      );
      bad.code = 'E_REWRITE_REQUIRED';
      return bad;
    }
    list = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.sources) ? doc.sources : []);
  }
  if (!list.length) return null;
  const f = typeof fields === 'string' ? { html: fields } : (fields || {});
  const haystack = [f.html, f.title, f.digest].map((s) => String(s || '')).join('\n').toLowerCase();
  if (!haystack.trim()) return null;
  const hit = list.find((s) => {
    const url = s && s.url ? String(s.url).trim() : '';
    if (!url) return false;
    const lower = url.toLowerCase();
    const bare = lower.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return haystack.includes(lower) || (bare.length > 8 && haystack.includes(bare));
  });
  if (!hit) return null;
  const e = new Error(
    `正文/标题/摘要里出现了素材来源链接（${String(hit.url).slice(0, 80)}）：素材来源清单仅内部可见、不随文章发布（PRD v2 §5.2）。` +
    '请删掉其中的来源链接（引用具体研究时署名来源名称即可，不必贴 URL）并保存后再上传'
  );
  e.code = 'E_REWRITE_REQUIRED';
  e.leakedUrl = hit.url;
  return e;
}

/**
 * 上传成文到草稿箱（compose:upload）：
 * token → 封面 → payload（AI 标识随 cfg.content.aiDisclosure 追加）→ draft → uploaded.json。
 * 成功后历史条目标记 uploaded（markUploadedById）。deps 透传 wechat.js（coverPath/fetch 可注入）。
 * forceUpload=true：跳过相似度改写关卡——仅供全自动路径（雷达定时/打回重写）在
 * autoForceUpload=true 且重写用尽仍超标时使用；手动上传（compose:upload）永远过闸。
 */
async function uploadComposedArticle({ cfg, state, dataDir, id, logger, deps = {}, forceUpload = false } = {}) {
  const { entry, article } = loadComposedArticle(state, id);
  const gate = forceUpload ? null : rewriteGate(entry, entry.dir);
  if (gate) throw gate;
  const leak = sourceLeakGuard(entry.dir, { html: article.html, title: article.title, digest: article.digest });
  if (leak) throw leak;
  const noop = () => {};
  const log = logger || { info: noop, warn: noop, error: noop };
  log.info(`开始上传成文（id=${id} origin=${article.origin}）`);
  // 文末领域提示（可选，aggregate.verticalNotice）：提示词只是软约束，上传前再幂等补齐；
  // 仅当 verticalNotice.enabled=true 且文本非空时补，已含同句则跳过。仅对聚合成文生效。
  let uploadArticle = article;
  if (article.origin === '聚合') {
    const vn = cfg && cfg.aggregate && cfg.aggregate.verticalNotice;
    const noticeText = vn && vn.enabled === true ? String(vn.text || '').trim() : '';
    if (noticeText && !String(article.html || '').includes(noticeText)) {
      uploadArticle = {
        ...article,
        html: `${article.html}<p style="color:#999;font-size:13px;">${noticeText}</p>`,
      };
      log.info('正文缺少文末领域提示，已按设置补齐');
    }
  }
  const { token } = await getAccessToken(cfg, deps);
  const { mediaId: thumbMediaId } = await ensureCoverMaterial(cfg, token, state, { ...deps, coverDataUri: article.coverDataUri });
  const payload = await buildArticlePayload(cfg, uploadArticle, thumbMediaId, token, deps);
  const { mediaId: draftMediaId } = await createDraft(token, payload, deps);
  fs.mkdirSync(entry.dir, { recursive: true });
  fs.writeFileSync(
    path.join(entry.dir, 'uploaded.json'),
    JSON.stringify({ draft_media_id: draftMediaId, uploaded_at: new Date().toISOString() }, null, 2),
    'utf8'
  );
  markUploadedById(state, id, draftMediaId);
  persistState(dataDir, state, log);
  log.info(`成文已上传到草稿箱（id=${id} draft_media_id=${draftMediaId}）`);
  return { draftMediaId, words: article.words, title: article.title };
}

/** 读取成文目录下的内部核查文件（sources.json / similarity.json），不存在 → null。 */
function loadInternalDoc(dir, name) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null; // 内部辅助文件损坏不阻塞预览
  }
}

module.exports = {
  MAX_TITLE,
  MAX_DIGEST,
  newArticleId,
  composeDir,
  findEntryById,
  saveComposedArticle,
  loadComposedArticle,
  saveComposedPatch,
  uploadComposedArticle,
  rewriteGate,
  sourceLeakGuard,
  loadInternalDoc,
};
