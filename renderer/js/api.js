/* ============================================================
 * api.js —— 渲染层与主进程之间的唯一通道封装
 *
 * 职责：
 *  1. 统一信封解包：invoke() 返回 data 或抛 ApiError（{code,message,hint?,errcode?}），绝不静默伪造成功；
 *  2. 演示回退：浏览器直开 index.html（无 window.api / preload）时启用 DemoBridge，
 *     实现与 window.api 相同的方法签名与事件名，数据全部取自设计稿示例；
 *  3. 本文件是渲染层唯一允许出现「演示回退分支判断」的文件。
 * ============================================================ */
(function () {
  'use strict';

  const App = (window.App = window.App || {});
  const hasRealApi = typeof window.api === 'object' && window.api !== null;

  /* ---------------- 错误对象 ---------------- */
  class ApiError extends Error {
    constructor(err) {
      super((err && err.message) || '操作失败');
      this.name = 'ApiError';
      this.code = (err && err.code) || 'E_IO';
      this.hint = (err && err.hint) || '';
      this.errcode = (err && err.errcode) || undefined;
    }
  }
  App.ApiError = ApiError;

  /* ============================================================
   * DemoBridge —— 演示回退（无 window.api 时）
   * 与 preload 暴露的 window.api 同签名：invoke(channel, payload) → Promise<{ok,data}|{ok,error}>，
   * on(channel, cb) 订阅事件。数据全部来自 prototype/index.html 的示例。
   * ============================================================ */
  const DEMO_IP = '192.0.2.10'; // RFC 5737 文档保留段（演示用，不指向真实主机）

  const DEMO_HISTORY = [
    { date: '2026-10-28', title: '修复分页 off-by-one：一行代码背后的边界思维', status: 'uploaded',  words: 1024, dir: 'D:\\demo\\output\\2026-10-28', origin: '自动' },
    { date: '2026-10-27', title: '给用户查询服务加上第一层缓存，QPS 从 120 到 900', status: 'uploaded',  words: 968,  dir: 'D:\\demo\\output\\2026-10-27', origin: '自动' },
    { date: '2026-10-27', title: '缓存踩坑复盘：为什么第一层缓存差点把数据库打挂', status: 'generated', words: 1120, dir: 'D:\\demo\\output\\2026-10-27-chat', origin: '对话' },
    { date: '2026-10-26', title: '知识管理工具的三个硬共识', status: 'uploaded',  words: 1246, dir: 'D:\\demo\\output\\2026-10-26-agg', origin: '聚合' },
    { date: '2026-10-26', title: '限流器上线之后：100 req/min 的取舍', status: 'uploaded',  words: 1150, dir: 'D:\\demo\\output\\2026-10-26', origin: '自动' },
    { date: '2026-10-25', title: '当天没有新的代码提交', status: 'skipped',   words: 0,    dir: 'D:\\demo\\output\\2026-10-25', origin: '自动' },
    { date: '2026-10-24', title: '日志系统重构：从 print 到结构化输出', status: 'uploaded',  words: 884,  dir: 'D:\\demo\\output\\2026-10-24', origin: '自动' },
    { date: '2026-10-23', title: 'API Key 轮换实践：把密钥关进配置中心', status: 'generated', words: 1032, dir: 'D:\\demo\\output\\2026-10-23', origin: '素材' },
    { date: '2026-10-22', title: '三周把单测覆盖率从 47% 提到 80%', status: 'failed',    words: 954,  dir: 'D:\\demo\\output\\2026-10-22', origin: '自动' },
  ];

  const DEMO_LOGS = [
    { t: '09:30:00', lv: 'INFO',  m: '应用启动，驻留系统托盘，定时任务 09:30' },
    { t: '09:30:00', lv: 'INFO',  m: '配置加载成功 · 模型 glm-4.6 · 仓库 D:\\projects\\sample-service' },
    { t: '09:30:01', lv: 'INFO',  m: 'access_token 获取成功，有效期 7200s' },
    { t: '09:30:01', lv: 'INFO',  m: '收集仓库动态：3 个提交 / 6 个文件 / diff 12.4KB' },
    { t: '09:30:41', lv: 'INFO',  m: '文章生成完成：《修复分页 off-by-one…》共 1,024 字，耗时 39.6s' },
    { t: '09:30:42', lv: 'INFO',  m: '封面素材已存在，复用 media_id（省一次上传）' },
    { t: '09:30:43', lv: 'INFO',  m: '草稿上传成功 draft_media_id=DEMO8f3a…，等待人工发表' },
    { t: '10-27',    lv: 'WARN',  m: '本机公网 IP 已变化（…10 → …31），请在公众平台白名单更新' },
    { t: '10-22',    lv: 'ERROR', m: 'errcode=40164 调用 IP 不在白名单 —— 前往公众平台添加 192.0.2.10 后重试' },
  ];

  /* 设计稿预览正文（prototype/index.html previewModal 静态内容） */
  const DEMO_ARTICLE_HTML = [
    '<p>昨天下午，测试同学报了一个很刁钻的 bug：翻到第二页时，第一条数据总是和第一页的最后一条重复。排查了半小时，最后发现罪魁祸首是一行分页计算——页码从 0 开始还是从 1 开始，写代码的时候没对齐。</p>',
    '<h3>问题出在哪</h3>',
    '<p>接口约定页码从 1 开始，但内部的偏移计算仍按 0 开始写。当 page=1 时，offset 本应是 0，旧代码却跳过了前 size 条数据：</p>',
    '<pre>start = page * size          # 旧：第 1 页直接跳过 size 条\nstart = (page - 1) * size    # 新：与接口约定对齐</pre>',
    '<h3>比修复更重要的</h3>',
    '<p>这行代码之所以能活到今天，是因为缺少边界测试。这次顺手补上了三个用例：第一页、恰好整除的最后一页、超出总页数的空页。以后谁再动分页逻辑，CI 会替我们盯着。</p>',
    '<p>今天的提交一共 3 个：分页修复、补充边界测试、更新接口文档。改动不大，但值得记住一句话：<b>约定要对齐在同一个地方，而不是散落在每个人的记忆里。</b></p>',
  ].join('');

  const DEMO_CONFIG = {
    wechat: { appId: '', appSecret: '••••••••••••••••••••' },
    llm: {
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: '••••••••••••••••••••',
      model: 'glm-4.6',
      temperature: 0.7,
    },
    content: {
      repoPath: 'D:\\projects\\sample-service',
      coverPath: '',
      author: '',
      audience: '关注效率工具与学习方法的职场读者',
      styleExtra: '像工程师写给同事看：讲清动机和取舍，不堆砌文件清单；标题不标题党。',
      aiDisclosure: { enabled: true, text: '本文由 AI 生成，经人工审阅修改' },
      // v2：素材成文本地草稿（可保存、复用；渲染层经 config:set 持久化）
      material: '',
      emphasis: '',
    },
    // v2：项目背景（所有模式共用）
    project: {
      description: '我们做的是一个面向中小团队的工单系统，解决跨部门工单流转慢、责任不清的问题；读者是使用与运维它的一线工程师。',
      techTerms: '技术栈：Go / MySQL / Redis / K8s\n工单池、分派策略、SLA 计时器\n内部叫「接单」，不叫「认领」',
      audience: '',
      styleExtra: '',
    },
    // v2：文风画像（style.profile 对象，形状对齐 core style.js / mock 桩）
    style: { profile: null, enabled: false },
    // v2：聚合来源配置（键名对齐 core config.js aggregate.*）
    aggregate: {
      keywords: ['科技', '教育', '生活方式'],
      whitelist: ['who.int', 'gov.cn', '人民日报', 'nature.com'],
      searchProvider: 'bocha',
      searchApiKey: '••••••••••••••••',
      dailyLimit: 10,
      similarityThreshold: 0.3,
      verticalNotice: { enabled: false, text: '' },
      sensitiveKeywords: [],
    },
    app: { schedule: { enabled: true, time: '09:30' }, autoLaunch: true, closeToTray: true, notify: true },
  };

  const demo = {
    listeners: {},
    history: DEMO_HISTORY.slice(),
    logs: DEMO_LOGS.slice(),
    config: JSON.parse(JSON.stringify(DEMO_CONFIG)),
    schedule: { enabled: true, time: '09:30' },
    generating: false,
    draftSeq: 0,
    /* ---- v2 演示态（形状对齐 core：chat.js 会话 / style.js 样文 / aggregate.js 清单） ---- */
    samples: [
      { id: 'sm-3f2a91c0d4e5', name: '2026-10 技术栏目样文', text: '（演示样文正文……）', words: 1284, addedAt: '2026-10-20T14:32:00.000Z' },
      { id: 'sm-8b7c22d1e0f6', name: '公众号导出 · 10月合集', text: '（演示样文正文……）', words: 3421, addedAt: '2026-10-22T09:10:00.000Z' },
    ],
    chats: [{
      id: 'chat-20261027163100',
      title: '把缓存方案讲成故事',
      createdAt: '2026-10-27T16:31:00.000Z',
      updatedAt: '2026-10-27T16:40:00.000Z',
      messages: [
        { role: 'user', content: '想写写我们给查询服务加第一层缓存那件事，但从头讲。', t: '2026-10-27T16:31:00.000Z' },
        { role: 'assistant', content: '好题材。先追三个细节：\n1）上线前 QPS 和 P99 是多少？\n2）第一版缓存为什么差点把数据库打挂——是雪崩还是击穿？\n3）最后兜底的方案是「空值缓存」还是「互斥重建」？\n把这三个数字给我，开头就能立住。', t: '2026-10-27T16:32:00.000Z' },
        { role: 'user', content: '上线前 QPS 120、P99 480ms；打挂是因为过期时间设成同一秒，集体回源；最后用互斥重建 + 随机 TTL。', t: '2026-10-27T16:38:00.000Z' },
        { role: 'assistant', content: '数字很硬。建议结构：\n- 开头：一个凌晨告警的场景\n- 中段：为什么「统一过期」是隐形炸弹（讲清原理，不堆代码）\n- 结尾：随机 TTL 这一行小改动背后的启发——系统性风险常藏在「默认值」里\n要不要我按这个结构出一版草稿？', t: '2026-10-27T16:40:00.000Z' },
      ],
    }],
    radarDay: null,
    radarTopics: [],
    composed: {},   // articleId → {article, origin, date}（演示成文登记，compose:upload 按 id 取用）
    profile: null,
  };

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const ok = (data) => ({ ok: true, data });
  const fail = (code, message, hint, errcode) => ({ ok: false, error: { code, message, hint, errcode } });

  function emit(channel, payload) {
    (demo.listeners[channel] || []).forEach((fn) => {
      try { fn(payload); } catch (e) { console.error('[demo] listener error', channel, e); }
    });
  }

  function demoLog(lv, m) {
    const t = new Date().toTimeString().slice(0, 8);
    demo.logs.push({ t, lv, m });
    emit('log:append', { t, lv, m });
  }

  function nowHM() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function nextRunAt(timeStr, base) {
    const [h, m] = timeStr.split(':').map(Number);
    const d = base ? new Date(base) : new Date();
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
    if (t.getTime() <= d.getTime()) t.setDate(t.getDate() + 1);
    return t;
  }

  function demoScheduleGet() {
    return {
      enabled: demo.schedule.enabled,
      time: demo.schedule.time,
      nextRunAt: demo.schedule.enabled ? nextRunAt(demo.schedule.time).toISOString() : null,
    };
  }

  const CHECK_DETAILS = ['access_token 获取成功 · 7200s', '封面素材已就绪 media_id=…9d2f', '测试草稿创建成功', '测试草稿已删除'];

  async function demoSelfCheck() {
    for (let i = 0; i < 4; i++) {
      emit('selfcheck:progress', { index: i, state: 'run', detail: '' });
      await delay(850);
      emit('selfcheck:progress', { index: i, state: 'ok', detail: CHECK_DETAILS[i] });
    }
    return { items: CHECK_DETAILS.map((detail) => ({ id: ['token', 'cover', 'draft', 'cleanup'][CHECK_DETAILS.indexOf(detail)], state: 'ok', detail })) };
  }

  async function demoRunGenerate(payload) {
    if (demo.generating) return fail('E_BUSY', '正在生成中，请等待本次任务完成');
    demo.generating = true;
    const upload = !(payload && payload.upload === false);
    const runId = 'demo-' + (++demo.draftSeq);
    const date = todayStr();
    (async () => {
      const steps = [
        { stage: 0, state: 'active' }, { stage: 0, state: 'done' },
        { stage: 1, state: 'active' }, { stage: 1, state: 'done' },
      ];
      demoLog('INFO', '手动触发：开始生成' + (upload ? '并上传' : '预览'));
      demoLog('INFO', '收集仓库动态：3 个提交 / 6 个文件 / diff 12.4KB');
      emit('run:progress', { stage: 0, state: 'active', detail: '收集仓库动态' });
      await delay(900);
      emit('run:progress', { stage: 0, state: 'done', detail: '' });
      demoLog('INFO', '调用 glm-4.6 撰写文章…');
      emit('run:progress', { stage: 1, state: 'active', detail: 'AI 撰写文章' });
      await delay(900);
      emit('run:progress', { stage: 1, state: 'done', detail: '' });
      demoLog('INFO', '文章生成完成：《把配置中心接进 CI：密钥不再进代码库》共 992 字，耗时 33.8s');
      if (upload) {
        demoLog('INFO', '封面素材已存在，复用 media_id（省一次上传）');
        demoLog('INFO', '上传到草稿箱…');
        emit('run:progress', { stage: 2, state: 'active', detail: '上传到草稿箱' });
        await delay(900);
        emit('run:progress', { stage: 2, state: 'done', detail: '' });
        const mediaId = 'mock-draft-' + String(demo.draftSeq).padStart(3, '0');
        demoLog('INFO', '草稿上传成功 draft_media_id=' + mediaId + '…，等待人工发表');
      }
      demo.history.unshift({
        date,
        title: '把配置中心接进 CI：密钥不再进代码库',
        status: upload ? 'uploaded' : 'generated',
        words: 992,
        dir: 'D:\\demo\\output\\' + date,
        origin: '自动',
      });
      demo.generating = false;
      emit('run:finished', {
        ok: true, cause: 'manual', date,
        status: upload ? 'uploaded' : 'generated',
        title: '把配置中心接进 CI：密钥不再进代码库', words: 992,
      });
    })();
    return ok({ runId });
  }

  async function demoReupload(payload) {
    const item = demo.history.find((r) => r.date === (payload && payload.date));
    if (!item) return fail('E_NOT_FOUND', '没有找到该日期的历史记录');
    const runId = 'demo-reup-' + (++demo.draftSeq);
    demoLog('INFO', '重新上传 ' + item.date + ' 的草稿…');
    (async () => {
      emit('run:progress', { stage: 0, state: 'active', detail: '' });
      await delay(700);
      emit('run:progress', { stage: 0, state: 'done', detail: '' });
      emit('run:progress', { stage: 2, state: 'active', detail: '' });
      await delay(700);
      emit('run:progress', { stage: 2, state: 'done', detail: '' });
      demoLog('INFO', '重新上传完成，draft_media_id=mock-draft-' + String(demo.draftSeq).padStart(3, '0'));
      item.status = 'uploaded';
      demo.generating = false;
      emit('run:finished', { ok: true, cause: 'reupload', date: item.date, status: 'uploaded', title: item.title, words: item.words });
    })();
    return ok({ runId });
  }

  async function demoInvoke(channel, payload) {
    switch (channel) {
      case 'config:get':
        return ok({ config: JSON.parse(JSON.stringify(demo.config)), wizardDone: true });
      case 'config:set': {
        deepMerge(demo.config, payload || {});
        return ok({ config: JSON.parse(JSON.stringify(demo.config)) });
      }
      case 'config:export':
        return ok({ path: '演示模式 · 已导出脱敏配置（示意）' });
      case 'config:import':
        return ok({ config: JSON.parse(JSON.stringify(demo.config)) });
      case 'wechat:test': {
        await delay(1100);
        const appId = (payload && payload.appId || '').trim();
        if (!appId) return fail('E_INVALID_INPUT', 'AppID 未填写。请先到公众平台「基本配置」获取后填入。');
        return ok({ expiresIn: 7200 });
      }
      case 'llm:test': {
        await delay(1100);
        const key = (payload && payload.apiKey || '').trim();
        if (!key) return fail('E_INVALID_INPUT', 'API Key 未填写。请到服务商开放平台申请后填入，免费模型也可用。');
        return ok({ model: (payload && payload.model) || 'glm-4.6', latencyMs: 412 });
      }
      case 'net:public-ip':
        return ok({ ip: DEMO_IP });
      case 'selfcheck:run':
        return ok(await demoSelfCheck());
      case 'run:generate':
        return demoRunGenerate(payload);
      case 'history:list': {
        // 对齐 ipc：filter 同时承载状态（all/uploaded/…）与来源键（ORIGIN_FILTERS，含中文键）
        const ORIGIN_KEYS = { material: '素材', chat: '对话', aggregate: '聚合', auto: '自动', '素材': '素材', '对话': '对话', '聚合': '聚合', '自动': '自动' };
        const filter = (payload && payload.filter) || 'all';
        const originFilter = (payload && payload.origin) || ORIGIN_KEYS[filter] || 'all';
        const statusFilter = originFilter !== 'all' ? 'all' : filter;
        const items = demo.history
          .filter((r) => statusFilter === 'all' || r.status === statusFilter)
          .filter((r) => originFilter === 'all' || (r.origin || '自动') === originFilter)
          .map((r) => ({ date: r.date, title: r.title, status: r.status, words: r.words, dir: r.dir, origin: r.origin || '自动', id: r.id }));
        return ok({ items });
      }
      case 'history:preview': {
        // 对齐 ipc：{id} → v2 成文预览（附 sources/similarity）；{date} → v1 语义
        if (payload && payload.id) {
          const rec = demo.composed[payload.id];
          const row = demo.history.find((h) => h.id === payload.id);
          if (!rec || !row) return fail('E_NOT_FOUND', '成文不存在或已被删除：' + payload.id);
          return ok({
            id: payload.id, title: rec.article.title, author: '演示作者', date: row.date, words: row.words,
            origin: rec.origin, html: rec.article.html,
            sources: rec.sources && rec.sources.length ? rec.sources : null,
            similarity: rec.similarity,
          });
        }
        const item = demo.history.find((r) => r.date === (payload && payload.date));
        if (!item) return fail('E_NOT_FOUND', '没有找到该日期的历史记录');
        return ok({
          title: item.title, author: '演示作者', date: item.date, words: item.words, origin: item.origin || '自动',
          html: item.date === '2026-10-28' ? DEMO_ARTICLE_HTML : '<p>（演示数据）这是 ' + item.date + ' 的文章内容示意，正式版将展示当天生成的完整推文。</p>',
        });
      }
      case 'history:reupload':
        return demoReupload(payload);
      case 'logs:list':
        return ok({ items: demo.logs.slice() });
      case 'logs:clear':
        demo.logs.length = 0;
        return ok({});
      case 'logs:export':
        return ok({ path: '演示模式 · 已导出日志（示意）' });
      case 'schedule:get':
        return ok(demoScheduleGet());
      case 'schedule:set': {
        if (payload && typeof payload.time === 'string') demo.schedule.time = payload.time;
        if (payload && typeof payload.enabled === 'boolean') demo.schedule.enabled = payload.enabled;
        return ok(demoScheduleGet());
      }
      case 'dialog:pick-repo':
        return ok({ path: 'D:\\projects\\sample-service' }); // 与主进程约定一致：{path|null}
      case 'dialog:pick-cover':
        return ok({ path: 'D:\\projects\\sample-service\\assets\\cover-2026.png' });
      case 'shell:open-path':
      case 'shell:open-external':
        demoLog('INFO', '演示模式：已在系统层面打开目标（示意）');
        return ok({});
      case 'win:minimize':
      case 'win:toggle-max':
      case 'win:close':
        return ok({});

      /* ---- v2 通道（名称与 payload/返回对齐 main/ipc.js v2 落地约定） ---- */
      case 'compose:generate':
        return demoComposeGenerate(payload);
      case 'compose:save':
        return demoComposeSave(payload);
      case 'compose:upload':
        return demoComposeUpload(payload);
      case 'chat:list':
        return ok({ items: demo.chats.map((c) => ({
          id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt,
          turns: c.messages.length,
          lastMessage: c.messages.length ? Array.from(c.messages[c.messages.length - 1].content).slice(0, 60).join('') : '',
        })) });
      case 'chat:new': {
        const sid = 'chat-' + new Date().toISOString().replace(/[-:.TZ]/g, '');
        const s = { id: sid, title: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
        demo.chats.unshift(s);
        return ok({ session: JSON.parse(JSON.stringify(s)) }); // 对齐 ipc chat:new → {session}
      }
      case 'chat:open': {
        const s = demo.chats.find((c) => c.id === (payload && payload.id));
        if (!s) return fail('E_NOT_FOUND', '会话不存在或已被删除');
        return ok({ session: JSON.parse(JSON.stringify(s)) });
      }
      case 'chat:send':
        return demoChatSend(payload);
      case 'chat:delete': {
        const before = demo.chats.length;
        demo.chats = demo.chats.filter((c) => c.id !== (payload && payload.id));
        if (demo.chats.length === before) return fail('E_NOT_FOUND', '会话不存在或已被删除');
        return ok({});
      }
      case 'style:samples:list':
        return ok({ items: demo.samples.map((s) => Object.assign({}, s)) });
      case 'style:samples:add': {
        const text = String((payload && payload.text) || '').trim();
        if (!text) return fail('E_INVALID_INPUT', '样文内容为空：粘贴或导入至少一篇');
        const name = String((payload && payload.name) || '').trim() || '样文 ' + (demo.samples.length + 1);
        demo.samples.unshift({ id: 'sm-' + String(demo.samples.length + 1) + Math.random().toString(16).slice(2, 8), name, text, words: text.length, addedAt: new Date().toISOString() });
        demoLog('INFO', '样本库：新增样文「' + name + '」（' + text.length + ' 字）');
        return ok({ sample: demo.samples[0], duplicate: false, total: demo.samples.length });
      }
      case 'style:samples:import':
        demoLog('INFO', '样本库：从文件夹导入样文（演示模式固定返回 2 篇）');
        return ok({ items: demo.samples.slice(0, 2), errors: [], duplicates: 0, total: demo.samples.length });
      case 'style:samples:delete': {
        const before = demo.samples.length;
        demo.samples = demo.samples.filter((s) => s.id !== (payload && payload.id));
        if (demo.samples.length === before) return fail('E_NOT_FOUND', '样本不存在或已被删除');
        return ok({});
      }
      case 'style:analyze': {
        if (!demo.samples.length) return fail('E_INVALID_INPUT', '还没有样文：先在「文章样本库」导入或粘贴至少 1 篇样文再一键分析');
        await delay(1600);
        demoLog('INFO', '文风画像分析完成：样文 ' + demo.samples.length + ' 篇，输出可编辑画像与 AI 味禁用词清单');
        demo.profile = JSON.parse(JSON.stringify(DEMO_STYLE_PROFILE));
        return ok({ profile: demo.profile, model: 'glm-4.6（演示）', sampleCount: demo.samples.length });
      }
      case 'style:profile:get':
        return ok({ profile: demo.profile ? JSON.parse(JSON.stringify(demo.profile)) : null, enabled: !!(demo.config.style && demo.config.style.enabled) });
      case 'style:profile:set': {
        const p = payload && payload.profile;
        if (p != null && (typeof p !== 'object' || Array.isArray(p))) {
          return fail('E_INVALID_INPUT', '文风画像应为对象（可在「设置 → 内容与文风」重新分析生成）');
        }
        demo.profile = p ? Object.assign({ name: '默认文风画像', enabled: true, qualitative: {}, bannedWords: [] }, p) : null;
        return ok({ profile: JSON.parse(JSON.stringify(demo.profile)) });
      }
      case 'style:profile:toggle': {
        if (typeof (payload && payload.enabled) !== 'boolean') return fail('E_INVALID_INPUT', 'enabled 应为布尔值');
        if (payload.enabled && !demo.profile) return fail('E_INVALID_INPUT', '还没有文风画像：先「一键分析」生成画像后再启用');
        demo.config.style.enabled = payload.enabled;
        demoLog('INFO', '文风画像已' + (payload.enabled ? '启用' : '停用'));
        return ok({ enabled: payload.enabled, profile: demo.profile ? JSON.parse(JSON.stringify(demo.profile)) : null });
      }
      case 'radar:run':
        return ok(demoRadarRun());
      case 'radar:get':
        return ok(demo.radarDay ? { radar: { date: demo.radarDay, topics: demo.radarTopics.map((t) => Object.assign({}, t)), generatedAt: new Date().toISOString(), removedCount: 2 } } : fail('E_NOT_FOUND', todayStr() + ' 还没有热点清单：点「立即搜索」生成'));
      case 'radar:select': {
        // ipc 约定：{date, ids}（每次全量传当前勾选）→ {radar, changed}（仅持久化，敏感闸在 compose:generate）
        const ids = (payload && payload.ids) || [];
        if (!Array.isArray(ids)) return fail('E_INVALID_INPUT', 'ids 应为选题 id 字符串数组');
        if (ids.length > 50) return fail('E_INVALID_INPUT', '勾选数量过多（最多 50 条）');
        if (!demo.radarDay) return fail('E_NOT_FOUND', (payload && payload.date || todayStr()) + ' 还没有热点清单');
        return ok({ radar: { date: demo.radarDay, topics: demo.radarTopics.map((t) => Object.assign({}, t, { selected: ids.includes(t.id) })) }, changed: ids.length });
      }
      case 'dialog:pick-samples':
        return ok({ paths: ['D:\\demo\\样文\\2026-10 栏目样文.md', 'D:\\demo\\样文\\缓存复盘.md'] });
      case 'dialog:pick-sample-folder':
        return ok({ path: 'D:\\demo\\样文' });
      default:
        return fail('E_UNAVAILABLE', '演示模式下该操作不可用');
    }
  }

  function deepMerge(target, patch) {
    Object.keys(patch || {}).forEach((k) => {
      const v = patch[k];
      if (v === null || v === undefined) return; // null 语义：保留原值
      if (typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && target[k] !== null) {
        deepMerge(target[k], v);
      } else {
        target[k] = v;
      }
    });
  }

  /* ============================================================
   * v2 演示通道：素材成文 / 对话共创 / 选题雷达 / 文章样本库
   * 通道名对齐 preload v2 白名单；返回形状对齐 core（chat.js / style.js / aggregate.js）。
   * ============================================================ */
  /** 演示热点清单：core buildTopicList 形状 {id,title,summary,source:{name,url,tier,label},heat,publishedAt,keyword} */
  const DEMO_RADAR_TOPICS = [
    { id: 'topic-d1e0a2b3', title: '《数字素养与技能提升行动要点》：全民数字素养怎么补', summary: '行动要点建议把数字学习纳入日常安排，优先补齐信息检索与工具使用两项基础能力。', source: { name: '中国政府网', url: 'https://www.gov.cn/demo-literacy', tier: 1, label: 'L1' }, heat: 92, publishedAt: '2026-10-27T00:00:00.000Z', keyword: '教育' },
    { id: 'topic-c2d1b3e4', title: 'Nature 综述：间隔重复如何显著提升长期记忆保持率', summary: '综述支持把间隔重复作为学习基线：每周 2~3 次复习，配合提取练习效果最佳。', source: { name: 'Nature（间隔重复综述）', url: 'https://www.nature.com/demo-review', tier: 2, label: 'L2' }, heat: 85, publishedAt: '2026-10-26T00:00:00.000Z', keyword: '教育' },
    { id: 'topic-b3c2d4e5', title: '任务管理工具怎么选：先定流程，再挑工具', summary: '多篇评测支持先固定记录与复盘节奏，再挑选顺手的工具，顺序反了会增加切换成本。', source: { name: '科技早报', url: 'https://mp.weixin.qq.com/s/demo-tech', tier: 3, label: 'L3' }, heat: 78, publishedAt: '2026-10-25T00:00:00.000Z', keyword: '科技' },
    { id: 'topic-a4b3c5d6', title: 'WHO：数字设备使用与青少年睡眠的关键事实', summary: '世卫组织建议控制睡前屏幕使用，保持规律作息，为学习与休息留出充足时间。', source: { name: '世界卫生组织官网', url: 'https://www.who.int/demo-sleep', tier: 1, label: 'L1' }, heat: 74, publishedAt: '2026-10-24T00:00:00.000Z', keyword: '生活方式' },
    { id: 'topic-95e4f6a7', title: '每周复盘的长期依从性研究：12 个月坚持率 62%', summary: '研究指出固定频率的周复盘一年坚持率过六成，目标达成率与未复盘组差异显著。', source: { name: 'Nature（行为研究）', url: 'https://www.nature.com/demo-habit', tier: 2, label: 'L2' }, heat: 66, publishedAt: '2026-10-23T00:00:00.000Z', keyword: '生活方式' },
  ];

  /** 演示画像：形状与 core style.js normalizeProfile 对齐（qualitative 嵌套 + bannedWords） */
  const DEMO_STYLE_PROFILE = {
    version: 1,
    name: '我的文风画像',
    updatedAt: null,
    enabled: true,
    qualitative: {
      opening: '多用场景或提问开头，一段话内出现具体数字',
      closing: '以一句行动建议或清单收尾',
      sentenceRhythm: '长短句交替，段落 2~4 句，关键结论独立成段',
      petPhrases: '先说结论、值得记住一句话、这行代码之所以能活到今天',
      subtitleStyle: '短句式小标题，多为问题式或反转式，不排比',
      punctuationEmoji: '逗号为主，破折号引出转折，不堆 emoji',
    },
    bannedWords: ['首先', '其次', '总之', '综上所述', '值得注意的是', '深入探讨', '赋能', '抓手'],
    topBigrams: [['缓存', 6], ['取舍', 4]],
    stats: null,
    sampleCount: 0,
  };

  function demoRadarRun() {
    demo.radarDay = todayStr();
    demo.radarTopics = DEMO_RADAR_TOPICS.map((t) => Object.assign({}, t));
    demoLog('INFO', '选题雷达：按关键词[' + (demo.config.aggregate.keywords || []).join('、') + ']搜索全网，命中 7 条、去重/白名单过滤后保留 5 条');
    return {
      date: demo.radarDay,
      generatedAt: new Date().toISOString(),
      topics: demo.radarTopics.map((t) => Object.assign({}, t)),
      keywordErrors: [],
      removedCount: 2,
    };
  }

  /** 演示聚合成文（对齐 core composeFromTopics 返回：{article, similarity, sources, words}） */
  function demoAggregateResult(picked) {
    return {
      article: {
        title: '把权威共识读薄：这一周效率圈真正值得记的三条',
        digest: '只取来源中的事实、共识与数据，综合改写为原创综述；引用出处反而加分，素材来源清单仅内部核查。',
        html: [
          '<p>先说结论：这周的热点里，真正值得记住的是三条<b>共识</b>，不是三个标题。</p>',
          '<h3>任务拆解：把大目标切小</h3>',
          '<p>权威时间管理指南给出的基线很一致：先拆目标，再排日程。把「写完报告」切成「列大纲、找数据、写初稿」三个 30 分钟块，完成的概率会显著提高。</p>',
          '<h3>工具选型：先定流程，再选工具</h3>',
          '<p>多篇综述性评测把结论写得很清楚：工具的价值取决于它与你的流程是否匹配。先固定记录与复盘的节奏，再挑顺手的工具，顺序反过来只会增加切换成本。</p>',
          '<h3>复盘方法：固定频率比仪式感重要</h3>',
          '<p>建议每周固定一次复盘，只回答两个问题：哪件事花的时间超出预期？下周可以砍掉什么？回答得越具体，下一周的日程就越可控。</p>',
          '<p>本文由 AI 综合权威来源起草，人工审阅后发表。</p>',
        ].join(''),
      },
      words: 1188,
      similarity: {
        threshold: 0.3, n: 2, passed: true, needsRewrite: false,
        maxRatio: 0.07, worstIndex: 0, attempts: 1, rewriteAttempts: 0,
        reports: [],
      },
      sources: picked.map((t, i) => ({
        index: i + 1,
        tier: t.source.tier,
        label: t.source.label,
        name: t.source.name,
        title: t.title,
        url: t.source.url,
        excerpt: Array.from(t.summary).slice(0, 60).join('') + '……',
        fetchState: 'ok',
        usedFor: '事实/共识/数据提取',
      })),
      batchId: 'agg-demo001',
      date: todayStr(),
      origin: '聚合',
      needsRewrite: false,
      dir: 'D:\\demo\\output\\' + todayStr() + '\\aggregate\\agg-demo001',
    };
  }

  /** 演示素材/对话成文（对齐 core composeMaterial 返回：{article, raw, model}） */
  function demoMaterialArticle(emphasis) {
    return {
      article: {
        title: '把素材写成一篇可以发表的推文：先讲人话，再讲原理',
        digest: 'AI 只提取素材中的事实与要点，按你的文风画像重新成文；这篇示例演示了标题、摘要与正文的编辑区。',
        html: [
          '<p>先说结论：<b>素材是你给的，表达是照你的习惯写的。</b>下面这段是编辑区示例，标题、摘要、正文都可以直接改。</p>',
          '<h3>素材说了什么</h3>',
          '<p>左侧素材区里的要点、聊天记录、链接摘要都会被提取成事实与数据，原文的句式和比喻不会被搬运——这是「综合而非抄袭」的硬约束。</p>',
          '<h3>接下来做什么</h3>',
          '<p>改完之后点「上传到草稿箱」，草稿会出现在公众号后台，等你在手机 App 里审阅发表。</p>',
        ].join(''),
      },
      model: 'glm-4.6（演示）',
      note: emphasis ? '已围绕「' + emphasis + '」组织结构（演示数据）' : '',
    };
  }

  async function demoComposeGenerate(payload) {
    const mode = (payload && payload.mode) || 'material'; // ipc 约定：mode ∈ material | chat | radar
    await delay(1300);
    if (mode === 'radar') {
      const ids = (payload && payload.ids) || [];
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3) {
        return fail('E_INVALID_INPUT', '请勾选 1~3 条选题再成文');
      }
      // 敏感话题闸（对齐 ipc：E_CONFIRM_REQUIRED，message=原因）；关键词读演示配置（与 core 默认预设同源）
      const SENSITIVE = (demo.config.aggregate && demo.config.aggregate.sensitiveKeywords) || [];
      const pickedAll = demo.radarTopics.filter((t) => ids.includes(t.id));
      if (!pickedAll.length) return fail('E_NOT_FOUND', '勾选的选题不在当日清单中，请重新搜索后再试');
      const hits = SENSITIVE.filter((kw) => pickedAll.some((t) => t.title.includes(kw)));
      if (hits.length && !(payload && payload.confirmSensitive)) {
        return fail('E_CONFIRM_REQUIRED', '选题命中敏感话题关键词（' + hits.join('、') + '）：按合规要求需人工确认后才能生成，请确认题材安全后重试');
      }
      demoLog('INFO', '全网聚合：综合 ' + pickedAll.length + ' 条热点（' + pickedAll.map((t) => t.source.label).join('/') + '）成文，已通过 n-gram 相似度自检');
      const r = demoAggregateResult(pickedAll);
      const saved = demoSaveComposed(r.article, '聚合', { words: r.words, sources: r.sources, similarity: r.similarity });
      return ok(Object.assign({}, r, saved));
    }
    if (mode === 'chat') {
      const session = demo.chats.find((c) => c.id === (payload && payload.sessionId));
      if (!session) return fail('E_NOT_FOUND', '会话不存在：' + ((payload && payload.sessionId) || '（空）'));
      if (!session.messages.some((m) => m.role === 'user')) {
        return fail('E_INVALID_INPUT', '对话为空，没有可整理的内容：先和 AI 聊几句再点「整理成文章」');
      }
      demoLog('INFO', '对话整理成文完成：会话 ' + session.id);
      const r = demoMaterialArticle(session.title || '');
      const saved = demoSaveComposed(r.article, '对话', { words: 918 });
      return ok(Object.assign({}, saved, { article: r.article, words: 918, origin: '对话' }));
    }
    const material = String((payload && payload.material) || '').trim();
    if (!material) return fail('E_INVALID_INPUT', '素材为空：请先粘贴要点、草稿或链接摘要等素材');
    const emphasis = String((payload && payload.emphasis) || '').trim();
    demoLog('INFO', '素材成文完成：素材 ' + material.length + ' 字' + (emphasis ? '，强调「' + emphasis + '」' : '') + '，注入文风画像与项目背景');
    const r = demoMaterialArticle(emphasis);
    const saved = demoSaveComposed(r.article, '素材', { words: 918 });
    return ok(Object.assign({}, saved, { article: r.article, words: 918, origin: '素材' }));
  }

  async function demoComposeUpload(payload) {
    await delay(1000);
    const id = (payload && payload.id) || '';
    const rec = demo.composed[id];
    if (!rec) return fail('E_NOT_FOUND', '成文不存在或已被删除：' + id);
    const row = demo.history.find((h) => h.id === id);
    if (row) {
      row.status = 'uploaded';
      row.draftMediaId = 'mock-draft-' + String(++demo.draftSeq).padStart(3, '0');
    }
    demoLog('INFO', '草稿上传成功 draft_media_id=' + (row ? row.draftMediaId : 'mock-draft-???') + '（来源：' + rec.origin + '），等待人工发表');
    return ok({ draftMediaId: row ? row.draftMediaId : 'mock-draft-???', words: 918, title: rec.article.title });
  }

  /** 演示编辑保存（对齐 ipc compose:save：title/digest 截断与 html 消毒在主进程，演示桩仅回写） */
  function demoComposeSave(payload) {
    const id = (payload && payload.id) || '';
    const rec = demo.composed[id];
    if (!rec) return fail('E_NOT_FOUND', '成文不存在或已被删除：' + id);
    const patch = payload || {};
    if (patch.title !== undefined) rec.article.title = String(patch.title);
    if (patch.digest !== undefined) rec.article.digest = String(patch.digest);
    if (patch.html !== undefined) rec.article.html = String(patch.html);
    const row = demo.history.find((h) => h.id === id);
    if (row && patch.title !== undefined) row.title = rec.article.title;
    const words = (String(rec.article.html || '').replace(/<[^>]*>/g, ' ').match(/[\u4e00-\u9fff]/g) || []).length;
    demoLog('INFO', '成文已保存：id=' + id + '（' + words + ' 字）');
    return ok({ article: JSON.parse(JSON.stringify(rec.article)), words });
  }

  async function demoChatSend(payload) {
    const content = String((payload && payload.text) || '').trim(); // ipc 约定：{sessionId, text}
    if (!content) return fail('E_INVALID_INPUT', '消息内容不能为空');
    await delay(1100);
    let session = demo.chats.find((c) => c.id === (payload && payload.sessionId));
    if (!session) return fail('E_NOT_FOUND', '会话不存在或已被删除');
    const t1 = new Date().toISOString();
    session.messages.push({ role: 'user', content, t: t1 });
    if (!session.title) session.title = Array.from(content).slice(0, 20).join('');
    const reply = '收到，先追两个细节：\n1）这件事里最反直觉的一个数字是什么？\n2）当时差点选错的方向是哪个？\n给到我之后，我会帮你把结构收成「场景 → 转折 → 取舍 → 启发」四段，随时可以点「把这轮讨论整理成文章」出草稿。';
    const t2 = new Date().toISOString();
    session.messages.push({ role: 'assistant', content: reply, t: t2 });
    session.updatedAt = t2;
    demoLog('INFO', '对话共创：会话 ' + session.id + ' 新增 2 条消息（演示数据）');
    return ok({ session: JSON.parse(JSON.stringify(session)), reply: { role: 'assistant', content: reply, t: t2 } });
  }

  /** 演示成文落盘（对齐 main articles.saveComposedArticle：入历史并入产物登记表） */
  function demoSaveComposed(article, origin, extra) {
    const articleId = 'art-demo' + String(++demo.draftSeq).padStart(3, '0');
    const date = todayStr();
    demo.composed[articleId] = {
      article, origin, date,
      sources: (extra && extra.sources) || [],
      similarity: (extra && extra.similarity) || null,
    };
    demo.history.unshift({
      id: articleId,
      date,
      title: article.title,
      status: 'generated',
      words: extra && extra.words != null ? extra.words : 918,
      dir: 'D:\\demo\\output\\' + date,
      origin,
    });
    return { articleId, date };
  }

  /* ============================================================
   * 对外统一入口（App.api）：视图层不感知演示/真实差异
   * ============================================================ */
  App.demo = !hasRealApi;

  App.api = {
    /**
     * 调用 IPC 通道；成功 resolve(data)，失败 reject(AppError)。
     * 真实环境：window.api.invoke 返回 {ok,data}|{ok,error}（不 reject，）。
     */
    async invoke(channel, payload) {
      let res;
      if (hasRealApi) {
        try {
          res = await window.api.invoke(channel, payload);
        } catch (e) {
          throw new ApiError({ code: 'E_IO', message: '与主进程通信失败：' + (e && e.message ? e.message : e) });
        }
      } else {
        res = await demoInvoke(channel, payload);
      }
      if (res && res.ok) return res.data;
      throw new ApiError(res && res.error);
    },

    /** 订阅主进程事件：run:progress / run:finished / selfcheck:progress / log:append
     *  返回退订函数（preload 的约定就是返回取消订阅）；视图重订阅时必须能解除，否则监听会累积。 */
    on(channel, cb) {
      if (hasRealApi) {
        return window.api.on(channel, cb);
      }
      const list = (demo.listeners[channel] = demo.listeners[channel] || []);
      list.push(cb);
      return () => {
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      };
    },
  };

  App.ipc = hasRealApi ? window.api : null;
})();
