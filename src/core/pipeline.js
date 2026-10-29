'use strict';
/**
 * pipeline.js —— 三阶段流水线（契约 §3 pipeline.js）。
 * runPipeline({cfg, state, dataDir, upload, force, cause, logger, onProgress, deps})
 *   → {ok, date, status:'uploaded'|'generated'|'skipped'|'failed', title?, words?, draftMediaId?, error?}
 *
 * 三阶段：
 *   0 收集：collectChanges；无变更且非 force → 写 skipped 历史、静默结束；
 *   1 撰写：buildPrompt → callLlm → parseLlmOutput；格式错保存 raw_llm.txt 并自动重试 1 次；
 *           成功落 output/<date>/article.json + preview.html，更新 lastHead/lastRunDate；
 *   2 上传：token → 封面 → payload → draft，markUploaded + uploaded.json；upload=false 止于 generated。
 * cause='reupload' 时跳过 0/1，直接复用 output/<date>/article.json 走上传。
 * 每次 onProgress(stage, state, detail)；cause 事件归主进程，本模块不产生副作用之外的网络。
 * deps 注入：{now, fetch, retryDelayMs, imageTimeoutMs, logger, coverPath}——测试零真实网络。
 */
const fs = require('node:fs');
const path = require('node:path');
const { collectChanges } = require('./collect');
const { buildPrompt, callLlm, parseLlmOutput, LlmFormatError } = require('./llm');
const { getAccessToken, ensureCoverMaterial, createDraft } = require('./wechat');
const { buildArticlePayload, buildPreviewHtml, countWords, sanitizeHtml } = require('./article');
const { saveStateMerged, recordRun, markUploaded } = require('./state');
const { dayKey } = require('./scheduler');
const { projectContext, buildProjectBlock } = require('./config');
const { styleInjectionFor } = require('./style');
const { stripIllustrations } = require('./illustration');

const noopLogger = { info() {}, warn() {}, error() {} };
const noopProgress = () => {};

/** 任意异常 → IPC 信封 error 形状 {code, message, hint?, errcode?}。 */
function toErrInfo(e) {
  if (!e) return { code: 'E_IO', message: '未知错误' };
  const info = { code: e.code || 'E_IO', message: e.message || String(e) };
  if (e.hint) info.hint = e.hint;
  if (e.errcode !== undefined) info.errcode = e.errcode;
  return info;
}

async function runPipeline({
  cfg,
  state,
  dataDir,
  upload = false,
  force = false,
  cause = 'manual',
  date,
  logger = noopLogger,
  onProgress = noopProgress,
  deps = {},
} = {}) {
  const now = deps.now ? new Date(deps.now) : new Date();
  const day = date || dayKey(now);
  const outDir = path.join(dataDir, 'output', day);
  const ensureOutDir = () => fs.mkdirSync(outDir, { recursive: true });

  // 状态持久化失败只告警不中断（内存中的 state 已更新，主进程可稍后重存）。
  const persist = () => {
    try {
      saveStateMerged(dataDir, state);
    } catch (e) {
      logger.warn(`状态保存失败：${e.message}`);
    }
  };

  logger.info(`开始运行（cause=${cause} upload=${upload} force=${force} date=${day}）`);
  let article = null;
  let head = null;

  if (cause === 'reupload') {
    // 复用当天已生成文章，直接进入上传阶段
    const articlePath = path.join(outDir, 'article.json');
    if (!fs.existsSync(articlePath)) {
      const info = {
        code: 'E_NOT_FOUND',
        message: `${day} 没有已生成的文章（output/${day}/article.json 不存在），无法重新上传`,
      };
      logger.error(info.message);
      return { ok: false, date: day, status: 'failed', error: info };
    }
    try {
      article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
    } catch (e) {
      const info = { code: 'E_IO', message: `读取 ${day} 的 article.json 失败：${e.message}` };
      return { ok: false, date: day, status: 'failed', error: info };
    }
    onProgress(0, 'done', '复用已生成文章');
    onProgress(1, 'done', '复用已生成文章');
  } else {
    // ---------- 阶段 0：收集 ----------
    onProgress(0, 'active', '正在收集仓库动态…');
    if (!cfg || !cfg.content || !cfg.content.repoPath) {
      const info = {
        code: 'E_INVALID_INPUT',
        message: '仓库路径未配置：到「设置 → 内容与文风」选择一个本地项目目录',
      };
      logger.error(info.message);
      return { ok: false, date: day, status: 'failed', error: info };
    }
    let collected;
    try {
      collected = await collectChanges({ repoPath: cfg.content.repoPath, lastHead: state.lastHead }, { force, now });
    } catch (e) {
      const info = toErrInfo(e);
      recordRun(state, { date: day, title: '', status: 'failed', words: null, error: info });
      persist();
      onProgress(0, 'fail', info.message);
      logger.error(`收集变更失败：${info.message}`);
      return { ok: false, date: day, status: 'failed', error: info };
    }
    if (!collected.hasChanges && !force) {
      recordRun(state, { date: day, title: '当天没有新的仓库提交', status: 'skipped', words: null });
      persist();
      onProgress(0, 'done', '自上次运行以来没有新的仓库动态，已跳过');
      logger.info('无变更，静默跳过');
      return { ok: true, date: day, status: 'skipped' };
    }
    onProgress(0, 'done', `已收集仓库动态（${collected.digest.length} 字）`);
    head = collected.head || null;

    // ---------- 阶段 1：撰写 ----------
    const model = (cfg.llm && cfg.llm.model) || 'glm-4.6';
    onProgress(1, 'active', `调用 ${model} 撰写文章…`);
    // 与 v2 三条路径同口径：仓库自动也注入项目背景与文风画像（PRD v2 §3/§4.3）
    const prompt = buildPrompt(collected.digest, cfg, day, {
      projectBlock: buildProjectBlock(projectContext(cfg)),
      styleInjection: styleInjectionFor(cfg, dataDir, collected.digest),
    });
    let formatError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let raw;
      try {
        ({ raw } = await callLlm(cfg, prompt, deps));
      } catch (e) {
        const info = toErrInfo(e);
        recordRun(state, { date: day, title: '', status: 'failed', words: null, error: info });
        persist();
        onProgress(1, 'fail', info.message);
        logger.error(`LLM 调用失败：${info.message}`);
        return { ok: false, date: day, status: 'failed', error: info };
      }
      try {
        article = parseLlmOutput(raw);
        formatError = null;
        break;
      } catch (e) {
        ensureOutDir();
        fs.writeFileSync(path.join(outDir, 'raw_llm.txt'), raw, 'utf8');
        formatError = e;
        if (attempt === 1) {
          onProgress(1, 'active', '输出格式不符，已保存 raw_llm.txt，自动重试一次…');
          logger.warn('LLM 输出格式不符，自动重试 1 次');
        }
      }
    }
    if (!article) {
      const info = toErrInfo(formatError instanceof LlmFormatError ? formatError : formatError);
      recordRun(state, {
        date: day,
        title: '',
        status: 'failed',
        words: null,
        error: info,
      });
      persist();
      onProgress(1, 'fail', `${info.message}（原始输出已保存 output/${day}/raw_llm.txt）`);
      logger.error(`LLM 输出解析失败（重试后仍失败）：${info.message}`);
      return { ok: false, date: day, status: 'failed', error: info };
    }

    // 与素材/对话路径同口径：落盘与预览前先消毒（LLM 输出可能受仓库内容影响）
    article = { ...article, html: sanitizeHtml(article.html) };
    // v2.3：正文插图（<illus> → PNG 内联）。消毒之后、算字数之前；
    // 由主进程注入 deps.materializeIllustrations（core 不能 import electron）。
    // 失败则剥掉占位按无图继续，不阻断整篇。
    if (typeof deps.materializeIllustrations === 'function') {
      try {
        const m = await deps.materializeIllustrations(article, { logger });
        if (m && m.article) article = m.article;
      } catch (e) {
        throw e;
      }
    }
    const words = countWords(article.html);
    ensureOutDir();
    fs.writeFileSync(path.join(outDir, 'article.json'), JSON.stringify(article, null, 2), 'utf8');
    fs.writeFileSync(path.join(outDir, 'preview.html'), buildPreviewHtml(article), 'utf8');
    if (head) state.lastHead = head;
    state.lastRunDate = day;
    recordRun(state, { date: day, title: article.title, status: 'generated', words });
    persist();
    onProgress(1, 'done', `文章生成完成：${words} 字`);
    logger.info(`已生成 ${day} 的文章：《${article.title}》（${words} 字）`);
  }

  // ---------- 阶段 2：上传 ----------
  if (!upload) {
    return { ok: true, date: day, status: 'generated', title: article.title, words: countWords(article.html) };
  }
  onProgress(2, 'active', '上传到草稿箱…');
  try {
    const { token } = await getAccessToken(cfg, deps);
    const { mediaId: thumbMediaId } = await ensureCoverMaterial(cfg, token, state, { ...deps, coverDataUri: article.coverDataUri });
    const payload = await buildArticlePayload(cfg, article, thumbMediaId, token, deps);
    const { mediaId: draftMediaId } = await createDraft(token, payload, deps);
    ensureOutDir();
    fs.writeFileSync(
      path.join(outDir, 'uploaded.json'),
      JSON.stringify({ draft_media_id: draftMediaId, uploaded_at: new Date().toISOString() }, null, 2),
      'utf8'
    );
    markUploaded(state, day, draftMediaId);
    persist();
    onProgress(2, 'done', '草稿上传成功，等待人工发表');
    logger.info(`草稿已上传到公众号草稿箱（draft_media_id=${draftMediaId}）`);
    return { ok: true, date: day, status: 'uploaded', title: article.title, words: countWords(article.html), draftMediaId };
  } catch (e) {
    const info = toErrInfo(e);
    const words = countWords(article.html);
    recordRun(state, { date: day, title: article.title, status: 'failed', words, error: info });
    persist();
    onProgress(2, 'fail', info.message);
    logger.error(`上传失败：${info.message}`);
    return { ok: false, date: day, status: 'failed', title: article.title, words, error: info };
  }
}

module.exports = { runPipeline, toErrInfo };
