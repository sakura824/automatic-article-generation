'use strict';
/**
 * 调度宿主 + 运行管理器（契约 §1 scheduler-host.js、§6 调度器纯函数、§7 决策 2/8）：
 * - runManager：pipeline 的唯一触发口（run:generate / 托盘 / 定时 / 补跑 / 重新上传），
 *   E_BUSY 互斥，异步执行不阻塞 IPC，结果经 run:progress / run:finished 事件回传；
 * - schedulerHost：每 30s 一个 tick，把 now 显式传给 src/core/scheduler 的纯函数，
 *   由 lastScheduledDate 防重（只在 scheduled/catchup 触发开始时写入，手动运行不改写）；
 *   启动即判定 missedCatchUp（cause='catchup' 补跑当天），tick 命中 shouldFireNow（cause='scheduled'）。
 *
 * src/core/scheduler、src/core/pipeline 由管道实现者并行产出，这里懒加载：
 * 未就绪时记 ERROR 并跳过当次，不掩盖也不崩溃；就绪后自动生效。
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function err(code, message, extra) {
  return Object.assign({ code, message }, extra || {});
}

/** pipeline 侧 logger 桥（core 只拿纯函数风格接口） */
function pipelineLogger(logger) {
  return {
    log: (m) => logger.info(m),
    info: (m) => logger.info(m),
    warn: (m) => logger.warn(m),
    error: (m) => logger.error(m),
    redact: (v) => logger.scrub(v),
  };
}

function createRunManager({ dataDir, store, logger, sendEvent, notify }) {
  let current = null; // { runId, cause, startedAt }
  let seq = 0;

  // 应用内置默认封面：pipeline 上传阶段未配置封面时回退（asar 内 fs 可读）
  const DEFAULT_COVER = require('path').join(__dirname, '..', 'assets', 'default_cover.png');

  function isRunning() {
    return !!current;
  }

  /**
   * 启动一次运行。同步返回 {ok, runId} 或 {ok:false, error:E_BUSY}，
   * 结果随后经 run:finished 事件推送（契约：run:generate 异步返回 {runId}）。
   * opts: { upload, force, cause:'manual'|'scheduled'|'catchup'|'reupload', date? }
   */
  function start(opts) {
    const { upload, force, cause } = opts;
    if (current) {
      return { ok: false, error: err('E_BUSY', `已有任务在运行中（${current.cause}，runId=${current.runId}），请等待完成后再试`) };
    }
    const runId = `run-${Date.now()}-${++seq}`;
    current = { runId, cause, startedAt: Date.now() };
    logger.info(`运行开始：runId=${runId} cause=${cause} upload=${!!upload} force=${!!force}${opts.date ? ' date=' + opts.date : ''}`);
    // nextTick：让调用方（IPC handler）先拿到 {runId} 再开始长任务
    process.nextTick(() => execute(Object.assign({}, opts, { runId })));
    return { ok: true, runId };
  }

  async function execute(opts) {
    const { upload, force, cause, runId, date } = opts;
    let finished = false;
    try {
      const pipeline = require('../src/core/pipeline'); // 懒加载：管道实现者产出后生效
      const cfg = store.loadFullConfig();
      const state = store.loadState();
      const result = await pipeline.runPipeline({
        cfg,
        state,
        dataDir,
        upload: !!upload,
        force: !!force,
        cause,
        date, // reupload 指定日期用；普通运行为 undefined，pipeline 按当天处理
        logger: pipelineLogger(logger),
        deps: {
          coverPath: DEFAULT_COVER, // 未配置封面时回退应用内置默认图（真实模式必需）
          // v2.3：正文插图渲染器（core 不能 import electron，由主进程注入）
          materializeIllustrations: require('./illustration').materializeArticle,
        },
        onProgress: (stage, st, detail) => {
          try {
            sendEvent('run:progress', { stage, state: st, detail: logger.scrub(detail || '') });
          } catch (e) { /* 事件失败不影响运行 */ }
        },
      });
      store.saveStateMerged(state); // pipeline 就地修改 state（lastHead/history），宿主负责落盘；合并写避免覆盖期间的 v2 成文
      finished = true;
      const payload = {
        ok: !!result.ok,
        cause,
        date: result.date || date || null,
        status: result.status || (result.ok ? 'generated' : 'failed'),
        title: result.title || null,
        words: result.words === undefined ? null : result.words,
        draftMediaId: result.draftMediaId || null,
        error: result.error || null,
      };
      sendEvent('run:finished', payload);
      logger.info(`运行结束：runId=${runId} status=${payload.status}${payload.error ? ' error=' + payload.error.message : ''}`);
      notifyResult(payload);
    } catch (e) {
      // 模块缺失 / pipeline 未按契约抛错等情况：如实向界面报 failed，绝不静默
      const message = e && e.message ? e.message : String(e);
      const code = (e && e.code) || 'E_IO';
      logger.error(`运行异常：runId=${runId} ${code} ${message}`);
      if (!finished) {
        const now = new Date();
        const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
        const payload = {
          ok: false,
          cause,
          date: date || today,
          status: 'failed',
          title: null,
          words: null,
          draftMediaId: null,
          error: err(code, message, e && e.errcode ? { errcode: e.errcode } : {}),
        };
        try { sendEvent('run:finished', payload); } catch (err2) { /* 忽略 */ }
        notifyResult(payload);
      }
    } finally {
      current = null;
    }
  }

  /** 系统通知（成功/失败都发；skipped 静默；受 app.notify 开关控制） */
  function notifyResult(payload) {
    if (payload.status === 'skipped') {
      logger.info('今日无仓库变更，已静默跳过（可在历史页筛选“无变更 · 跳过”查看）');
      return;
    }
    if (!store || !notify) return;
    try {
      const cfg = store.loadFullConfig();
      if (cfg.app.notify === false) return;
      if (payload.status === 'uploaded') {
        notify({ title: '公众号写作助手', body: `草稿已上传，记得发表：《${payload.title || payload.date}》` });
      } else if (payload.status === 'generated') {
        notify({ title: '公众号写作助手', body: `已生成今日预览（未上传）：《${payload.title || payload.date}》` });
      } else {
        const msg = payload.error && payload.error.message ? payload.error.message : '未知错误';
        notify({ title: '公众号写作助手', body: `今日任务失败：${msg}（详情见运行日志）` });
      }
    } catch (e) {
      logger.warn(`发送系统通知失败：${e.message}`);
    }
  }

  /**
   * 启动一次「内容池」运行（v2.2 增量）：取池中最早的一条待写题目 → 成文 → 自动上传草稿箱。
   * 与 git 管线共用 E_BUSY 互斥与 run:progress / run:finished 事件，界面上不用区分。
   * 语义要点（都写在 pool.test.js 里锁死）：
   * - 成文落盘后立即 markUsed：文章已经产生，再跑一次只会得到重复稿件；
   * - 上传失败不回退条目状态（历史里是 failed，可在历史页重传）；
   * - 生成失败才 markAttemptFailed（条目保持 pending，连续 3 次自动跳过），不白吃选题。
   */
  function startPool(opts) {
    if (current) {
      return { ok: false, error: err('E_BUSY', `已有任务在运行中（${current.cause}，runId=${current.runId}），请等待完成后再试`) };
    }
    const runId = `run-${Date.now()}-${++seq}`;
    current = { runId, cause: opts.cause, startedAt: Date.now(), kind: 'pool' };
    logger.info(`内容池运行开始：runId=${runId} cause=${opts.cause}`);
    process.nextTick(() => executePool(Object.assign({}, opts, { runId })));
    return { ok: true, runId };
  }

  async function executePool({ cause, runId, date }) {
    const poolCore = require('../src/core/pool');
    let picked = null;
    let composed = false;
    let finished = false;
    const progress = (stage, st, detail) => {
      try {
        sendEvent('run:progress', { stage, state: st, detail: logger.scrub(detail || '') });
      } catch (e) { /* 事件失败不影响运行 */ }
    };
    try {
      const sched = require('../src/core/scheduler');
      const chat = require('../src/core/chat');
      const articles = require('./articles');
      const cfg = store.loadFullConfig();
      const state = store.loadState();
      const today = date || sched.dayKey(new Date());

      const doc = poolCore.loadPool(dataDir);
      picked = poolCore.nextPending(doc);
      if (!picked) {
        // 池空是正常状态，不是错误：报 skipped 且**不写 lastScheduledDate**（调用方保证），
        // 这样用户当天补了内容，30 秒内就会自动补跑今天，不必等到明天。
        finished = true;
        const payload = { ok: true, cause, date: today, status: 'skipped', title: '内容池没有待写条目', words: null, draftMediaId: null, error: null };
        sendEvent('run:finished', payload);
        logger.info('内容池为空，本次跳过（补充题目后会自动补跑当天）');
        return; // notifyResult 不调用：skipped 静默
      }

      progress(0, 'active', `内容池取到：《${picked.title}》，正在撰写…`);
      let injection = '';
      try {
        injection = require('../src/core/style').styleInjectionFor(cfg, dataDir, picked.title);
      } catch (e) {
        injection = ''; // 文风模块异常不阻断成文
      }
      const r = await chat.composeTopic(cfg, {
        topic: picked.title,
        material: picked.material,
        emphasis: picked.emphasis,
        project: require('../src/core/config').projectContext(cfg),
        styleInjection: injection,
      });
      const saved = await articles.saveComposedArticle({
        dataDir,
        state,
        origin: '内容池',
        article: r.article,
        date: today,
        logger,
      });
      composed = true;
      // 成文已落盘 → 立刻标记已用，避免同一天重跑再写一遍同一题
      const freshPool = poolCore.loadPool(dataDir);
      if (freshPool.items.some(it => it.id === picked.id)) poolCore.markUsed(freshPool, picked.id, { articleId: saved.id });
      poolCore.savePool(dataDir, freshPool);
      progress(1, 'done', `已生成《${saved.article.title}》（${saved.words} 字）`);

      progress(2, 'active', '上传到草稿箱…');
      const up = await articles.uploadComposedArticle({
        cfg,
        state,
        dataDir,
        id: saved.id,
        logger,
        deps: { coverPath: DEFAULT_COVER },
      });
      progress(2, 'done', '草稿上传成功，等待人工发表');
      finished = true;
      const payload = {
        ok: true,
        cause,
        date: today,
        status: 'uploaded',
        title: saved.article.title,
        words: saved.words,
        draftMediaId: up.draftMediaId,
        error: null,
      };
      sendEvent('run:finished', payload);
      logger.info(`内容池运行结束：runId=${runId} status=uploaded articleId=${saved.id}`);
      notifyResult(payload);
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      const code = (e && e.code) || 'E_IO';
      logger.error(`内容池运行异常：runId=${runId} ${code} ${message}`);
      // 只有「还没成文」的失败才计入条目失败次数：成文后上传失败不该把已写的题退回队列
      if (picked && !composed) {
        try {
          const fresh = poolCore.loadPool(dataDir); // 重读，避免用旧快照覆盖期间的人工修改
          const r2 = poolCore.markAttemptFailed(fresh, picked.id, { error: message });
          poolCore.savePool(dataDir, fresh);
          if (r2.exhausted) logger.warn(`内容池条目连续失败已达 ${poolCore.MAX_ATTEMPTS} 次，已自动跳过：《${picked.title}》`);
        } catch (e2) {
          logger.warn(`记录内容池失败次数失败：${e2.message}`);
        }
      }
      if (!finished) {
        const now = new Date();
        const today = date || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
        const payload = {
          ok: false,
          cause,
          date: today,
          status: 'failed',
          title: picked ? picked.title : null,
          words: null,
          draftMediaId: null,
          error: err(code, message, e && e.errcode ? { errcode: e.errcode } : {}),
        };
        try { sendEvent('run:finished', payload); } catch (err2) { /* 忽略 */ }
        notifyResult(payload);
      }
    } finally {
      current = null;
    }
  }

  /**
   * 启动一次「选题雷达全自动」运行（v2.4 增量）：
   * 按聚合配置搜索全网 → 自动选排名最前的 1~3 条选题 → 综合成文 → 上传草稿箱。
   * 与内容池 / git 管线共用 E_BUSY 互斥与 run:progress / run:finished 事件。
   * 语义要点：
   * - 敏感话题在选题阶段就跳过（跳过不占名额，保证每天仍有稿）；
   * - 相似度自检没过关（needsRewrite）时**不自动上传**，稿子留在历史里等人工改写——
   *   合规关卡不能被「全自动」绕过；
   * - 搜索失败 / 清单为空如实报 failed / skipped，绝不伪造素材。
   */
  function startRadar(opts) {
    if (current) {
      return { ok: false, error: err('E_BUSY', `已有任务在运行中（${current.cause}，runId=${current.runId}），请等待完成后再试`) };
    }
    const runId = `run-${Date.now()}-${++seq}`;
    current = { runId, cause: opts.cause, startedAt: Date.now(), kind: 'radar' };
    logger.info(`选题雷达运行开始：runId=${runId} cause=${opts.cause}`);
    process.nextTick(() => executeRadar(Object.assign({}, opts, { runId })));
    return { ok: true, runId };
  }

  async function executeRadar({ cause, runId, date }) {
    const sched = require('../src/core/scheduler');
    const aggregate = require('../src/core/aggregate');
    const radarAuto = require('../src/core/radar-auto');
    const configCore = require('../src/core/config');
    const articles = require('./articles');
    let picked = [];
    let composed = false;
    let finished = false;
    const progress = (stage, st, detail) => {
      try {
        sendEvent('run:progress', { stage, state: st, detail: logger.scrub(detail || '') });
      } catch (e) { /* 事件失败不影响运行 */ }
    };
    try {
      const cfg = store.loadFullConfig();
      const state = store.loadState();
      const today = date || sched.dayKey(new Date());
      const ag = cfg.aggregate || {};

      // ---- 1. 搜索全网 → 热点清单
      // 同日已落盘清单可复用（省一次搜索配额），但**关键词改过就必须重搜**，
      // 否则「按当前输入参数搜索」会退化成用早上的旧清单。
      const currentKeywords = require('../src/core/aggregate').aggregateConfigOf(cfg).keywords;
      let radar = null;
      try { radar = aggregate.loadRadar(dataDir, today); } catch (e) { radar = null; }
      const sameKeywords = !!radar && Array.isArray(radar.keywords)
        && radar.keywords.length === currentKeywords.length
        && radar.keywords.every((k, i) => k === currentKeywords[i]);
      if (radar && sameKeywords && Array.isArray(radar.topics) && radar.topics.length) {
        progress(0, 'active', `复用今天已生成的热点清单（${radar.topics.length} 条，关键词未变）`);
        logger.info(`选题雷达：复用 ${today} 已落盘清单（${radar.topics.length} 条），关键词未变不再重复搜索`);
      } else {
        progress(0, 'active', '正在按关键词搜索全网热点…');
        const r = await aggregate.runTopicRadar(cfg, { dataDir, date: today });
        radar = r.radar;
        progress(0, 'done', `搜索到 ${r.topics.length} 条选题${r.keywordErrors.length ? `（${r.keywordErrors.length} 个关键词失败）` : ''}`);
        logger.info(`选题雷达：${today} 清单 ${r.topics.length} 条，去重 ${r.removedCount} 条`);
      }

      // ---- 2. 自动选题：取排名最前的 N 条，跳过需人工确认的敏感话题
      const opts = radarAuto.autoOptionsOf(cfg);
      const pick = radarAuto.pickTopTopics(radar.topics, { count: opts.pickCount, skipSensitive: opts.skipSensitive, keywords: opts.sensitiveKeywords });
      picked = pick.picked;
      if (pick.skipped.length) {
        logger.warn(`选题雷达：跳过 ${pick.skipped.length} 条敏感选题 —— ${pick.skipped.map((s) => `《${s.title}》`).join('、')}`);
      }
      if (!picked.length) {
        finished = true;
        const payload = {
          ok: true, cause, date: today, status: 'skipped',
          title: pick.skipped.length ? '今日选题均为敏感话题，已跳过' : '今天的清单里没有可用选题',
          words: null, draftMediaId: null, error: null,
        };
        sendEvent('run:finished', payload);
        logger.info('选题雷达：没有可自动成文的选题，本次跳过（可在雷达页手动成文）');
        return;
      }
      const chosen = picked.map((t) => `《${t.title}》`).join('、');
      logger.info(`选题雷达：自动选用 ${chosen}`);
      progress(1, 'active', `选用 ${chosen}，正在综合成文…`);

      // ---- 3. 综合成文（与「选题雷达页 → 勾选成文」同一套参数，全部取自当前配置）
      const legacyCode = ag.includeCode === true;
      const articleMode = ag.articleMode || (legacyCode ? 'web-code' : 'web');
      const includeCode = articleMode === 'web-code';
      const includeProfile = articleMode === 'web-profile';
      const topicTitles = picked.map((t) => t.title).join(' ');
      const topicBlob = picked.map((t) => `${t.title} ${t.summary || ''}`).join(' ');

      const projectProfile = includeProfile
        ? require('../src/core/product-profile').readProductProfile({ filePath: ag.profilePath || '', topic: topicTitles })
        : null;
      const localAssets = (includeCode || includeProfile) && ag.imagesEnabled
        ? require('../src/core/local-assets').listLocalAssets({ dir: ag.imagesDir, topic: topicBlob })
        : [];
      let codeContext = null;
      if (includeCode) {
        progress(1, 'active', '正在读取代码库并筛选与选题相关的功能…');
        codeContext = require('../src/core/code-context').collectCodeContext({
          repoPath: String(ag.repoPath || cfg.content.repoPath || '').trim(),
          topic: topicTitles,
        });
      }
      let styleInjection = '';
      try {
        styleInjection = require('../src/core/style').styleInjectionFor(cfg, dataDir, topicTitles);
      } catch (e) {
        styleInjection = ''; // 文风模块异常不阻断成文
      }
      const projectCtx = configCore.projectContext(cfg);
      const res = await aggregate.composeFromTopics(cfg, {
        topics: picked,
        project: (includeCode || includeProfile) ? projectCtx : { audience: projectCtx.audience },
        codeContext,
        productProfile: projectProfile,
        localAssets,
        productName: String(ag.productName || '').trim() || '我的系统',
        promotion: String(ag.promotion || '').trim(),
        styleInjection,
        confirmSensitive: false,
        date: today,
        batchNonce: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        dataDir,
        state,
        // v2.4：全自动模式重写次数取配置（默认 5 次，手动勾选成文仍为 2 次）
        maxRewrites: Number.isInteger(ag.autoRewriteAttempts) ? ag.autoRewriteAttempts : undefined,
        logger: pipelineLogger(logger),
      }, {
        materializeIllustrations: (article, options) => require('./illustration').materializeArticle(article, { ...options, localAssets }),
      });
      if (!res.ok && res.needsConfirmation) {
        // 选题阶段已过滤敏感话题，走到这里说明正文素材仍命中红线：交人工处理，不自动上传
        finished = true;
        const payload = {
          ok: true, cause, date: today, status: 'skipped',
          title: '素材命中敏感话题关键词，已转人工处理',
          words: null, draftMediaId: null, error: null,
        };
        sendEvent('run:finished', payload);
        logger.warn(`选题雷达：素材命中敏感话题关键词（${(res.sensitiveKeywords || []).join('、')}），已跳过自动上传`);
        return;
      }
      if (!res.ok) throw err('E_COMPOSE', '聚合成文失败');
      composed = true;

      const entry = articles.findEntryById(state, res.batchId);
      if (entry && !entry.dir && res.outDir) {
        entry.dir = res.outDir;
        store.saveStateMerged(state);
      }
      progress(1, 'done', `已生成《${res.article.title}》（${res.words} 字，相似度重写 ${res.similarity.rewriteAttempts} 次）`);

      // ---- 4. 相似度关卡（v2.4 按 autoForceUpload 分流）：
      // true（默认，用户要求全自动必须出稿）→ 重写用尽仍超标也照常上传，similarity.json 留痕供核查；
      // false（严格模式）→ 只保存不上传，等人工改写。
      if (res.needsRewrite && ag.autoForceUpload === false) {
        finished = true;
        const payload = {
          ok: true, cause, date: today, status: 'generated',
          title: res.article.title, words: res.words, draftMediaId: null, error: null,
        };
        sendEvent('run:finished', payload);
        logger.warn('选题雷达：相似度自检未过关（自动重写后仍超阈值），稿件已保存但未上传，请到历史页人工改写后上传');
        notifyResult(Object.assign({}, payload, {
          error: err('E_REWRITE_REQUIRED', '相似度偏高，已在历史里保存稿件，需要你改写后再上传'),
        }));
        return;
      }
      if (res.needsRewrite) {
        try {
          const simPath = require('path').join(res.outDir, 'similarity.json');
          const fs = require('fs');
          if (fs.existsSync(simPath)) {
            const sim = JSON.parse(fs.readFileSync(simPath, 'utf8'));
            sim.autoUploadedAt = new Date().toISOString();
            sim.autoUploadedNote = `全自动模式：重写 ${res.similarity.rewriteAttempts} 次后仍超阈值（最高重叠率 ${res.similarity.maxRatio}），按 autoForceUpload=true 强制上传。本文件仅供内部核查，不随文章发布。`;
            fs.writeFileSync(simPath, JSON.stringify(sim, null, 2), 'utf8');
          }
        } catch (e) {
          logger.warn(`similarity.json 留痕失败（不影响上传）：${e.message}`);
        }
        logger.warn(`选题雷达：相似度重写 ${res.similarity.rewriteAttempts} 次后仍超阈值（最高重叠率 ${res.similarity.maxRatio}），按 autoForceUpload=true 强制上传，报告已留痕`);
        progress(2, 'active', '相似度偏高，按全自动设置照常上传…');
      }

      progress(2, 'active', '上传到草稿箱…');
      const up = await articles.uploadComposedArticle({
        cfg, state, dataDir, id: res.batchId, logger, deps: { coverPath: DEFAULT_COVER },
        forceUpload: !!res.needsRewrite, // 重写用尽仍超标时由上方 autoForceUpload 分流决定照常上传，须绕过改写关卡
      });
      progress(2, 'done', '草稿上传成功，等待人工发表');
      finished = true;
      const payload = {
        ok: true,
        cause,
        date: today,
        status: 'uploaded',
        title: res.article.title,
        words: res.words,
        draftMediaId: up.draftMediaId,
        error: null,
      };
      sendEvent('run:finished', payload);
      logger.info(`选题雷达运行结束：runId=${runId} status=uploaded articleId=${res.batchId}`);
      notifyResult(payload);
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      const code = (e && e.code) || 'E_IO';
      logger.error(`选题雷达运行异常：runId=${runId} ${code} ${message}`);
      if (!finished) {
        const now = new Date();
        const today = date || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
        const payload = {
          ok: false,
          cause,
          date: today,
          status: 'failed',
          title: composed ? null : (picked[0] ? picked[0].title : null),
          words: null,
          draftMediaId: null,
          error: err(code, message, e && e.errcode ? { errcode: e.errcode } : {}),
        };
        try { sendEvent('run:finished', payload); } catch (err2) { /* 忽略 */ }
        notifyResult(payload);
      }
    } finally {
      current = null;
    }
  }

  return { start, startPool, startRadar, isRunning };
}

// ---------------------------------------------------------------- 调度宿主

function createSchedulerHost({ dataDir, store, logger, runManager, tray, missingAutoConfig, missingPoolConfig }) {
  const TICK_MS = 30 * 1000; // 契约 §6：每 30s tick
  let timer = null;
  let schedulerMissingLogged = false;
  let trayMissingWarned = false;
  let lastConfigSkipDay = null; // 每天最多提示一次「配置未完成跳过定时」
  let lastPoolEmptyDay = null; // 每天最多提示一次「内容池没有待写条目」
  let lastRollbackWarnKey = null; // 回拨提示按「当前日期+上次触发日期」去重，避免每 30s 刷一条

  function loadScheduler() {
    try {
      return require('../src/core/scheduler'); // 管道实现者产出；懒加载见文件头说明
    } catch (e) {
      if (!schedulerMissingLogged) {
        schedulerMissingLogged = true;
        logger.error(`src/core/scheduler 未就绪，定时调度暂停工作（${e.message}）`);
      }
      return null;
    }
  }

  /** 「下次：明天 09:30」样式（托盘 tooltip 与 schedule:get 共用） */
  function nextRunLabel(cfg, sched, now) {
    if (!cfg.app.schedule.enabled) return null;
    const t = sched.parseTime(cfg.app.schedule.time);
    if (!t) return null;
    const next = sched.nextRunAt(cfg.app.schedule.time, now);
    const todayKey = sched.dayKey(now);
    const tomorrowKey = sched.dayKey(new Date(now.getTime() + 24 * 3600 * 1000));
    const prefix = sched.dayKey(next) === todayKey ? '今天' : (sched.dayKey(next) === tomorrowKey ? '明天' : `${next.getMonth() + 1}-${next.getDate()}`);
    return `${prefix} ${pad2(next.getHours())}:${pad2(next.getMinutes())}`;
  }

  /** 刷新托盘 tooltip（schedule:get/set 与每个 tick 都会调用） */
  function refreshTray() {
    if (!tray || !tray.setTooltip) {
      if (!trayMissingWarned) {
        trayMissingWarned = true;
        logger.warn('托盘引用未注入：托盘 tooltip 无法刷新（下次运行时间 / 定时已暂停不会显示）');
      }
      return;
    }
    try {
      const cfg = store.loadFullConfig();
      const sched = loadScheduler();
      let text = '公众号写作助手';
      if (!cfg.app.schedule.enabled) {
        text += '\n定时已暂停';
      } else if (sched) {
        const label = nextRunLabel(cfg, sched, new Date());
        text += label ? `\n下次：${label}` : '\n定时时间无效（请在设置中修正）';
      } else {
        text += '\n调度模块未就绪';
      }
      tray.setTooltip(text);
    } catch (e) {
      logger.warn(`刷新托盘失败：${e.message}`);
    }
  }

  /** schedule:get / schedule:set 的返回数据（契约 §2） */
  function getScheduleInfo() {
    const cfg = store.loadFullConfig();
    const sched = loadScheduler();
    const out = {
      enabled: !!cfg.app.schedule.enabled,
      time: cfg.app.schedule.time,
      // v2.2：auto=仓库自动 / pool=内容池；poolPending 供仪表盘显示「池里还剩几条」
      mode: cfg.app.schedule.mode || 'auto',
      nextRunAt: null,
      poolPending: null,
    };
    if (out.mode === 'pool') {
      try {
        const poolCore = require('../src/core/pool');
        out.poolPending = poolCore.stats(poolCore.loadPool(dataDir)).pending;
      } catch (e) {
        out.poolPending = null; // 池文件损坏时不阻塞 schedule:get，页面另有提示
      }
    }
    if (out.enabled && sched) {
      const t = sched.parseTime(out.time);
      if (t) out.nextRunAt = sched.nextRunAt(out.time, new Date()).toISOString();
    }
    return out;
  }

  /**
   * 触发一次定时类运行。防重语义（契约 §6）：触发开始时写 lastScheduledDate（无论成败）；
   * 手动 run 不改写它。若此刻已有任务在跑（E_BUSY），本次不写标记、30s 后的 tick 再试，
   * 避免出现“标了但没跑”的丢日。
   * 返回 true 表示已真正发起运行（调用方据此决定是否打「开始运行」日志）。
   */
  function fireScheduled(cause, now, sched) {
    if (runManager.isRunning()) {
      logger.warn(`到点触发（${cause}）但当前有任务在运行，30 秒后重试`);
      return false;
    }
    // 时钟回拨防护：lastScheduledDate 记录的是「触发当天」。
    // 系统时间被回拨到更早的日期时，dayKey(now) 会小于它，shouldFireNow 会再次命中，
    // 结果同一天跑两次（回拨当天 + 时钟回正后）。这里直接跳过并留一条 WARN。
    const stateForGuard = store.loadState();
    if (stateForGuard.lastScheduledDate && sched.dayKey(now) < stateForGuard.lastScheduledDate) {
      const warnKey = `${sched.dayKey(now)}|${stateForGuard.lastScheduledDate}`;
      if (lastRollbackWarnKey !== warnKey) {
        lastRollbackWarnKey = warnKey;
        logger.warn(
          `检测到系统时间回拨（当前 ${sched.dayKey(now)} 早于上次定时触发日期 ${stateForGuard.lastScheduledDate}），` +
          '本次定时不再触发；请检查系统时间'
        );
      }
      return false;
    }
    // ---- 按 schedule.mode 分流（v2.2）：auto=仓库自动（v1 语义），pool=内容池取题 ----
    let cfgAll;
    try {
      cfgAll = store.loadFullConfig();
    } catch (e) {
      logger.warn(`定时触发前读取配置失败（${e.message}），本次不触发`);
      return false;
    }
    const mode = (cfgAll.app.schedule && cfgAll.app.schedule.mode) || 'auto';

    if (mode === 'pool') {
      // 内容池模式的门控：大模型 Key + 公众号凭证（要自动上传），**不要求仓库路径**
      // ——PRD v2 §2 的「代码仓库只是素材来源之一」在这里同样成立。
      if (typeof missingPoolConfig === 'function') {
        try {
          const missing = missingPoolConfig(cfgAll);
          if (missing.length) {
            const today = sched.dayKey(now);
            if (lastConfigSkipDay !== today) {
              lastConfigSkipDay = today;
              logger.warn(`定时任务（内容池）跳过：配置未完成（缺少：${missing.join('、')}）。补全后会自动补跑今天的任务`);
            }
            return false;
          }
        } catch (e) {
          logger.warn(`定时触发前检查配置失败（${e.message}），本次不触发`);
          return false;
        }
      }
      // 池空不写 lastScheduledDate：用户当天补了题目，30 秒内就自动补跑今天，
      // 比「今天已经过了点，明天见」合理得多（每天只提示一次，不刷日志）。
      try {
        const poolCore = require('../src/core/pool');
        if (!poolCore.nextPending(poolCore.loadPool(dataDir))) {
          const today = sched.dayKey(now);
          if (lastPoolEmptyDay !== today) {
            lastPoolEmptyDay = today;
            logger.warn('定时触发（内容池）：池里没有待写条目，已跳过——到「内容池」页添加题目后会自动补跑今天');
          }
          return false;
        }
      } catch (e) {
        logger.warn(`读取内容池失败（${e.message}），本次不触发`);
        return false;
      }
      const poolState = store.loadState();
      poolState.lastScheduledDate = sched.dayKey(now);
      store.saveStateMerged(poolState);
      logger.info(`定时触发（cause=${cause}）：从内容池取题成文（每天 ${(cfgAll.app.schedule && cfgAll.app.schedule.time) || ''}）`);
      const poolStarted = runManager.startPool({ cause });
      if (!poolStarted.ok) {
        logger.error(`定时触发失败：${poolStarted.error.message}`);
        return false;
      }
      return true;
    }

    // ---- v2.4：选题雷达全自动（搜索 → 自动选排名最前的选题 → 成文 → 上传草稿箱）
    if (mode === 'radar') {
      // 门控：大模型 Key + 公众号凭证（要自动上传）+ 搜索关键词 + 搜索 Key。
      // 缺配置不写 lastScheduledDate —— 补全配置后 30 秒内自动补跑今天。
      if (typeof missingPoolConfig === 'function') {
        try {
          const missing = missingPoolConfig(cfgAll);
          if (missing.length) {
            const today = sched.dayKey(now);
            if (lastConfigSkipDay !== today) {
              lastConfigSkipDay = today;
              logger.warn(`定时任务（选题雷达）跳过：配置未完成（缺少：${missing.join('、')}）。补全后会自动补跑今天的任务`);
            }
            return false;
          }
        } catch (e) {
          logger.warn(`定时触发前检查配置失败（${e.message}），本次不触发`);
          return false;
        }
      }
      let radarInfo;
      try {
        radarInfo = require('../src/core/aggregate').aggregateConfigOf(cfgAll);
      } catch (e) {
        logger.warn(`读取聚合配置失败（${e.message}），本次不触发`);
        return false;
      }
      const radarMissing = [];
      if (!radarInfo.keywords.length) radarMissing.push('搜索关键词');
      if (!radarInfo.apiKey) radarMissing.push(`${radarInfo.providerLabel}的搜索 Key`);
      if (radarMissing.length) {
        const today = sched.dayKey(now);
        if (lastConfigSkipDay !== today) {
          lastConfigSkipDay = today;
          logger.warn(`定时任务（选题雷达）跳过：缺少 ${radarMissing.join('、')}。到「设置 → 聚合来源配置」补全后会自动补跑今天`);
        }
        return false;
      }
      const radarState = store.loadState();
      radarState.lastScheduledDate = sched.dayKey(now);
      store.saveStateMerged(radarState);
      logger.info(`定时触发（cause=${cause}）：选题雷达自动成文（每天 ${(cfgAll.app.schedule && cfgAll.app.schedule.time) || ''}）`);
      const radarStarted = runManager.startRadar({ cause });
      if (!radarStarted.ok) {
        logger.error(`定时触发失败：${radarStarted.error.message}`);
        return false;
      }
      return true;
    }

    // 向导未完成 / 仓库自动未配置时定时/补跑不启动，
    // 与 run:generate / 托盘「立即生成并上传」同一判据（missingAutoConfig=仓库自动判据）——
    // 否则首启当天过点就会收到一条「任务失败」通知。不写 lastScheduledDate：
    // 当天完成配置后，shouldFireNow 到点后恒真，30s 内自动补跑今天。
    if (typeof missingAutoConfig === 'function') {
      try {
        const missing = missingAutoConfig(cfgAll);
        if (missing.length) {
          const today = sched.dayKey(now);
          if (lastConfigSkipDay !== today) {
            lastConfigSkipDay = today;
            logger.warn(`定时任务跳过：配置未完成（缺少：${missing.join('、')}）。补全后会自动补跑今天的任务`);
          }
          return false;
        }
      } catch (e) {
        logger.warn(`定时触发前检查配置失败（${e.message}），本次不触发`);
        return false;
      }
    }
    const state = store.loadState();
    state.lastScheduledDate = sched.dayKey(now);
    store.saveStateMerged(state);
    logger.info(`定时触发（cause=${cause}）：开始运行（每天 ${(cfgAll.app.schedule && cfgAll.app.schedule.time) || ''}）`);
    const started = runManager.start({ upload: true, force: false, cause });
    if (!started.ok) {
      logger.error(`定时触发失败：${started.error.message}`);
      return false;
    }
    return true;
  }

  /** 单次判定：boot=true 用 missedCatchUp（启动补跑），否则用 shouldFireNow（常规 tick） */
  function tickOnce(isBoot) {
    const sched = loadScheduler();
    if (!sched) return;
    try {
      const cfg = store.loadFullConfig();
      if (cfg.app.schedule.enabled) {
        const now = new Date();
        const state = store.loadState();
        if (isBoot) {
          // 契约 §6：应用启动 ready 后判定补跑（当天已过点且当天未跑）
          const missed = sched.missedCatchUp(cfg.app.schedule.time, now, state.lastScheduledDate);
          if (missed && missed.catchUp) {
            logger.info(`检测到今天 ${cfg.app.schedule.time} 的定时任务未执行，自动补跑（cause=catchup）`);
            fireScheduled('catchup', now, sched);
          }
        } else if (sched.shouldFireNow(cfg.app.schedule.time, now, state.lastScheduledDate)) {
          // 「开始运行」日志在 fireScheduled 通过全部门控后才打印：
          // 否则配置未完成时每 30s 都会留下一条「开始运行」却没有 runId，误导排查。
          fireScheduled('scheduled', now, sched);
        }
      }
    } catch (e) {
      logger.error(`调度 tick 异常：${e.message}`);
    } finally {
      refreshTray();
    }
  }

  return {
    start() {
      if (timer) return;
      tickOnce(true); // 启动即判定补跑
      timer = setInterval(() => tickOnce(false), TICK_MS);
      logger.info('调度器已启动（每 30 秒判定一次）');
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    refreshTray,
    getScheduleInfo,
  };
}

module.exports = { createRunManager, createSchedulerHost };
