'use strict';
/**
 * IPC 唯一接线处（契约 §2）：所有 ipcMain.handle 在此注册，统一信封
 * `{ok:true,data}` / `{ok:false,error:{code,message,hint?,errcode?}}`，绝不 reject。
 * code ∈ E_NO_CONFIG / E_INVALID_INPUT / E_NOT_FOUND / E_GIT / E_LLM / E_WECHAT /
 *        E_NET / E_IO / E_UNAVAILABLE / E_BUSY / E_CONFIRM_REQUIRED（v2：敏感话题需人工确认）。
 *
 * 安全边界：shell:open-path 限 DATA 与 content.repoPath 前缀；shell:open-external 仅
 * https 且域名白名单；窗口控制只暴露最小化/最大化切换/关闭（关闭按 closeToTray 处理）。
 * src/core 的网络类模块（wechat/llm/article/mock/state/scheduler）按需懒加载，
 * 未就绪时报明确错误而不是崩溃；config（defaultConfig/validateConfig/importRedacted）
 * 已由 store 在启动时加载，此处直接使用。
 *
 * v2 增量通道（PRD v2 §7）：
 * - 对话共创 chat:list/new/open/send/delete（多轮 messages 持久化 + chat:segment 分段事件）；
 * - 文风画像 style:samples:* / style:analyze / style:profile:*；
 * - 选题雷达 radar:run/get/select（task:progress 进度事件）；
 * - 创作成文 compose:generate/save/upload（素材/对话/雷达三模式，E_CONFIRM_REQUIRED 敏感闸）；
 * - 样文选择对话框 dialog:pick-samples / dialog:pick-sample-folder。
 * 入参校验：类型/长度/枚举白名单全量校验，非法一律 E_INVALID_INPUT（带可操作文案）。
 * 业务逻辑一律调 src/core 与 main/articles，本文件只做接线、校验与事件转发。
 */
const { ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const articles = require('./articles');

const ERROR_CODES = new Set([
  'E_NO_CONFIG', 'E_INVALID_INPUT', 'E_NOT_FOUND', 'E_GIT', 'E_LLM', 'E_WECHAT',
  'E_NET', 'E_IO', 'E_UNAVAILABLE', 'E_BUSY',
  // v2：E_CONFIRM_REQUIRED 敏感话题人工确认（compose:generate mode=radar）；
  //     E_REWRITE_REQUIRED 相似度自检未通过的人工改写关卡（compose:upload，main/articles.rewriteGate）
  'E_CONFIRM_REQUIRED', 'E_REWRITE_REQUIRED',
]);

const EXTERNAL_HOST_WHITELIST = [
  'mp.weixin.qq.com', // 公众平台（IP 白名单引导直达）
  'open.bigmodel.cn', // 智谱开放平台
  'api.deepseek.com', // DeepSeek
  'github.com',       // 历史记录里的仓库链接
];

/** 内网/本机地址判定（shell:open-external 的公网放行规则用）。 */
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;                    // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;           // docker/内网段
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
  }
  if (h.includes(':')) return true; // IPv6 直连一律不放行（含 [::1]）
  return false;
}

/**
 * 外链放行策略：
 * 1) 固定白名单（公众号/大模型服务商/仓库）——v1 引导链接；
 * 2) v2：选题雷达与历史来源清单里的「来源核查」链接（PRD v2 §5.2/§6）是任意公网域名，
 *    固定白名单无法覆盖。这类链接按「https + 公网域名」放行，拒绝内网段/本机/IP 直连与
 *    非常规端口，并把实际打开的 URL 记入运行日志（审计可追溯）。
 */
function isExternalUrlAllowed(u) {
  if (u.protocol !== 'https:') return { allowed: false, reason: `仅允许打开 https 链接，收到协议：${u.protocol}` };
  if (EXTERNAL_HOST_WHITELIST.includes(u.hostname)) return { allowed: true };
  if (u.port && u.port !== '443') return { allowed: false, reason: `来源链接只允许标准 https 端口，收到：${u.port}` };
  if (isPrivateHost(u.hostname)) return { allowed: false, reason: `不允许打开内网/本机地址：${u.hostname}` };
  return { allowed: true };
}

function ok(data) {
  return { ok: true, data };
}

function fail(code, message, extra) {
  return { ok: false, error: Object.assign({ code, message: String(message || '') }, extra || {}) };
}

/** 把 core/未知异常映射为信封错误：优先信任抛错方携带的 code/errcode/hint */
function toError(e, fallbackCode) {
  if (e && typeof e === 'object') {
    const code = ERROR_CODES.has(e.code) ? e.code : (e.errcode != null ? 'E_WECHAT' : fallbackCode);
    const extra = {};
    if (e.errcode != null) extra.errcode = e.errcode;
    if (e.hint) extra.hint = e.hint;
    return fail(code, e.message || '操作失败', extra);
  }
  return fail(fallbackCode, String(e || '操作失败'));
}

function isRedactedPlaceholder(v) {
  return typeof v === 'string' && v.includes('••••');
}

/**
 * 向导完成度检查（config:get 的 wizardDone、定时/补跑门控共用）。
 * PRD v2 §2：代码仓库只是素材来源之一——素材成文 / 对话共创 / 选题雷达都不依赖它，
 * 因此「仓库路径」不再计入向导完成度，只在仓库自动（C 模式）真正要跑时才要求
 * （见 missingAutoConfig）。
 */
function missingRunConfig(cfg) {
  const missing = [];
  if (!cfg.wechat.appId) missing.push('公众号 AppID');
  if (!cfg.wechat.appSecret) missing.push('公众号 AppSecret');
  if (!cfg.llm.apiKey) missing.push('大模型 API Key');
  return missing;
}

/** 仓库自动（C 模式）运行前置检查：run:generate / 托盘「立即生成并上传」/ 定时与补跑共用。 */
function missingAutoConfig(cfg) {
  const missing = missingRunConfig(cfg);
  if (!cfg.content.repoPath) missing.push('代码仓库路径');
  return missing;
}

function core(name) {
  return require(`../src/core/${name}`);
}

function dateReValid(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/* ============================ v2 通用校验与工具 ============================ */

function badInput(message) {
  const e = new Error(message);
  e.code = 'E_INVALID_INPUT';
  throw e;
}

/**
 * 字符串入参校验：非字符串 /（非 optional 时）为空 / 超长（按码点）→ E_INVALID_INPUT。
 * 返回 trim 后的值；optional 为空 → ''。
 */
function str(v, name, { max = Infinity, optional = false } = {}) {
  if (v === undefined || v === null) {
    if (optional) return '';
    badInput(`${name} 不能为空`);
  }
  if (typeof v !== 'string') badInput(`${name} 应为字符串，收到：${typeof v}`);
  const s = v.trim();
  if (!s) {
    if (optional) return '';
    badInput(`${name} 不能为空`);
  }
  if (Array.from(s).length > max) badInput(`${name} 超长（最多 ${max} 字）`);
  return s;
}

/** YYYY-MM-DD 校验；非法 → E_INVALID_INPUT。 */
function requireDate(v, name = '日期') {
  const s = String(v == null ? '' : v).trim();
  if (!dateReValid(s)) badInput(`${name}格式应为 YYYY-MM-DD，收到：${s || '（空）'}`);
  return s;
}

/** 今天的本地日期键（core/scheduler.dayKey，与 v1 调度同源）。 */
function todayKey() {
  return core('scheduler').dayKey(new Date());
}

/** 大模型前置检查（mock 模式同样要求非空，与 llm:test 契约一致）。 */
function requireLlmConfig(cfg, action) {
  if (!cfg.llm || !String(cfg.llm.apiKey || '').trim()) {
    const e = new Error(`大模型 API Key 未填写：到「设置 → 大模型」填写后再${action}`);
    e.code = 'E_NO_CONFIG';
    throw e;
  }
}

/** 文风注入块（PRD v2 §4.3）：实现收敛在 core/style.styleInjectionFor（管线与三条 v2 路径共用）。 */
function buildStyleInjection(cfg, dataDir, topicText) {
  try {
    return core('style').styleInjectionFor(cfg, dataDir, topicText);
  } catch (e) {
    return ''; // 文风模块未就绪不阻断主流程
  }
}

/** 项目上下文：project.* 合并 content.audience/styleExtra（设置页 v1 输入框对 v2 也生效）。 */
function projectCtx(cfg) {
  try {
    return core('config').projectContext(cfg);
  } catch (e) {
    return (cfg && cfg.project) || {};
  }
}

/** core 侧 logger 桥（与 scheduler-host.pipelineLogger 同形状）。 */
function bridgeLogger(logger) {
  return {
    log: (m) => logger.info(m),
    info: (m) => logger.info(m),
    warn: (m) => logger.warn(m),
    error: (m) => logger.error(m),
    redact: (v) => logger.scrub(v),
  };
}

/** 回复切分段（chat:segment 分段返回）：优先在句末标点处断开，每段 ≤120 字，最多 100 段。 */
function splitSegments(text, segChars = 120, maxSegments = 100) {
  const chars = Array.from(String(text || ''));
  if (!chars.length) return [];
  const enders = new Set(['。', '！', '？', '!', '?', '；', ';', '\n']);
  const segments = [];
  let buf = [];
  const flush = () => {
    if (buf.length) {
      segments.push(buf.join(''));
      buf = [];
    }
  };
  for (let i = 0; i < chars.length; i++) {
    buf.push(chars[i]);
    const len = buf.length;
    if ((len >= segChars && enders.has(chars[i])) || len >= segChars * 2) flush();
    if (segments.length >= maxSegments - 1) {
      buf = chars.slice(i + 1);
      flush();
      break;
    }
  }
  flush();
  return segments;
}

/** 分段推送回复（PRD v2 §7「流式或分段返回」）：25ms 间隔逐段 chat:segment，最后一段带 last:true。 */
async function emitChatSegments(sendEvent, sessionId, content) {
  const segments = splitSegments(content);
  for (let i = 0; i < segments.length; i++) {
    sendEvent('chat:segment', {
      sessionId,
      index: i,
      total: segments.length,
      text: segments[i],
      last: i === segments.length - 1,
    });
    if (i < segments.length - 1) await new Promise((r) => setTimeout(r, 25));
  }
}

/** v2 对话单飞：同一会话同时只允许一个 chat:send（跨通道并发保护，E_BUSY）。 */
const busyChats = new Set();

/** 历史来源过滤值 → entry.origin 标签（PRD v2 §2：素材/对话/自动/聚合）。 */
const ORIGIN_FILTERS = {
  material: '素材',
  chat: '对话',
  aggregate: '聚合',
  auto: '自动',
  pool: '内容池',
  素材: '素材',
  对话: '对话',
  聚合: '聚合',
  自动: '自动',
  内容池: '内容池',
};

/** 内部核查文档 → 来源数组（sources.json 为 {…, sources:[…]} 对象；兼容直接存数组的旧形态）。 */
function sourcesArrayOf(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && typeof doc === 'object' && Array.isArray(doc.sources)) return doc.sources;
  return [];
}

/** 应用内置默认封面（electron-builder.yml files 已打包 assets/**；asar 内 fs 可读）。 */
const DEFAULT_COVER = path.join(__dirname, '..', 'assets', 'default_cover.png');

/** 带超时与 2 次重试的 fetch（契约 §8：网络类失败自动重试 2 次） */
async function fetchWithRetry(url, { timeoutMs = 10000, retries = 2 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('网络请求失败');
}

function registerIpcHandlers(deps) {
  const { store, logger, getWindow, runManager, schedulerHost, applyAutoLaunch, sendEvent } = deps;

  function cfgWechatReady(cfg) {
    return !!(cfg.wechat.appId && cfg.wechat.appSecret);
  }

  const handlers = {
    // ------------------------------------------------------------ 配置
    'config:get': () => {
      const cfg = store.loadFullConfig();
      const ready = missingRunConfig(cfg).length === 0;
      return ok({ config: store.redactConfigForUi(cfg), wizardDone: ready });
    },

    'config:set': (p) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        return fail('E_INVALID_INPUT', 'config:set 需要一个对象类型的 patch');
      }
      // 密钥语义（契约 §2）：null → 保留原值；字符串 → 更新（脱敏占位串防御性视为保留）
      const current = store.loadFullConfig();
      const merged = store.deepMerge(store.clone(current), p);
      if (p.wechat && 'appSecret' in p.wechat) {
        const v = p.wechat.appSecret;
        merged.wechat.appSecret = (v === null || v === undefined || isRedactedPlaceholder(v))
          ? current.wechat.appSecret : String(v);
      }
      if (p.llm && 'apiKey' in p.llm) {
        const v = p.llm.apiKey;
        merged.llm.apiKey = (v === null || v === undefined || isRedactedPlaceholder(v))
          ? current.llm.apiKey : String(v);
      }
      // v2：聚合搜索 API Key 与 AppSecret/API Key 同一套语义（store 加密落盘）
      if (p.aggregate && 'searchApiKey' in p.aggregate) {
        const v = p.aggregate.searchApiKey;
        if (!merged.aggregate || typeof merged.aggregate !== 'object') merged.aggregate = {};
        merged.aggregate.searchApiKey = (v === null || v === undefined || isRedactedPlaceholder(v))
          ? (current.aggregate ? current.aggregate.searchApiKey : '') : String(v);
      }
      delete merged.secrets;
      // 定时时间格式与 schedule:set 同源校验，防止经 config:set 写入非法 HH:MM
      if (p.app && typeof p.app.schedule === 'object' && p.app.schedule && 'time' in p.app.schedule) {
        const timeStr = String(p.app.schedule.time);
        let timeValid;
        try {
          timeValid = !!core('scheduler').parseTime(timeStr);
        } catch (e) {
          timeValid = /^([01]\d|2[0-3]):[0-5]\d$/.test(timeStr); // 调度模块未就绪时的降级校验
        }
        if (!timeValid) {
          return fail('E_INVALID_INPUT', `定时时间格式应为 HH:MM（如 09:30），收到：${timeStr}`);
        }
      }
      // 布尔开关的类型校验（缺了它，字符串 'false' 会被当成开启，closeToTray 语义直接反转）
      const boolPaths = [
        ['app.schedule.enabled', p.app && p.app.schedule],
        ['app.autoLaunch', p.app],
        ['app.closeToTray', p.app],
        ['app.notify', p.app],
        ['content.aiDisclosure.enabled', p.content && p.content.aiDisclosure],
        ['aggregate.verticalNotice.enabled', p.aggregate && p.aggregate.verticalNotice],
        ['style.enabled', p.style],
      ];
      for (const [field, holder] of boolPaths) {
        const key = field.split('.').pop();
        if (holder && typeof holder === 'object' && key in holder && typeof holder[key] !== 'boolean' && holder[key] !== null && holder[key] !== undefined) {
          return fail('E_INVALID_INPUT', `${field} 应为布尔值 true/false，收到：${JSON.stringify(holder[key])}`);
        }
      }
      // 校验：只对本次 patch 实际触及的字段报错，允许向导分步保存不完整配置。
      // 精确匹配 patch 里的叶子路径——只按顶层键前缀匹配时，保存 content.material
      // 会被陈旧的 content.repoPath「目录不存在」连坐拒绝。
      const { validateConfig } = core('config');
      const v = validateConfig(merged);
      if (v && v.ok === false && Array.isArray(v.errors)) {
        const touchedPaths = new Set();
        const walk = (obj, prefix) => {
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            if (prefix) touchedPaths.add(prefix);
            return;
          }
          for (const [k, val] of Object.entries(obj)) {
            const next = prefix ? `${prefix}.${k}` : k;
            if (val && typeof val === 'object' && !Array.isArray(val)) walk(val, next);
            else touchedPaths.add(next);
          }
        };
        walk(p, '');
        const touched = (field) => typeof field === 'string' && Array.from(touchedPaths).some((path) => field === path || field.startsWith(path + '.') || path.startsWith(field + '.'));
        const relevant = v.errors.filter((e) => touched(e.field));
        if (relevant.length) {
          return fail('E_INVALID_INPUT', relevant.map((e) => `${e.field}：${e.message}`).join('；'));
        }
      }
      store.saveFullConfig(merged);
      applyAutoLaunch(); // 开机自启开关随配置即时生效
      schedulerHost.refreshTray();
      return ok({ config: store.redactConfigForUi(merged) });
    },

    'config:export': async () => {
      const win = getWindow();
      const r = await dialog.showSaveDialog(win, {
        title: '导出配置（不含密钥）',
        defaultPath: 'wxgzh-daily-config.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePath) return ok({ path: null });
      const cfg = store.loadFullConfig();
      fs.writeFileSync(r.filePath, store.configForExportText(cfg), 'utf8'); // 脱敏导出（core exportRedacted）
      logger.info(`配置已脱敏导出：${r.filePath}`);
      return ok({ path: r.filePath });
    },

    'config:import': async (p) => {
      let importPath = p && p.path;
      if (!importPath) {
        const win = getWindow();
        const r = await dialog.showOpenDialog(win, {
          title: '导入配置',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (r.canceled || !r.filePaths.length) return ok({ config: null });
        importPath = r.filePaths[0];
      }
      let json;
      try {
        json = JSON.parse(fs.readFileSync(importPath, 'utf8'));
      } catch (e) {
        return fail('E_IO', `读取配置文件失败：${e.message}（${importPath}）`);
      }
      // 双保险：导入内容一律不含密钥（即使导出文件被手工塞入也剔除）
      if (json && typeof json === 'object') {
        delete json.secrets;
        if (json.wechat) delete json.wechat.appSecret;
        if (json.llm) delete json.llm.apiKey;
        if (json.aggregate) delete json.aggregate.searchApiKey; // v2 聚合搜索 Key 同一套「导入不带密钥」语义
      }
      const { importRedacted } = core('config');
      const imported = importRedacted(json);
      const saved = store.saveFullConfig(imported);
      applyAutoLaunch();
      schedulerHost.refreshTray();
      logger.info(`配置已导入：${importPath}（密钥未随导入，需要时请到设置里重新填写）`);
      return ok({ config: store.redactConfigForUi(saved) });
    },

    // ------------------------------------------------------------ 连接测试
    'wechat:test': async (p) => {
      const stored = store.loadFullConfig();
      const appId = String((p && p.appId) || '').trim() || stored.wechat.appId;
      const given = p && p.appSecret;
      const appSecret = (typeof given === 'string' && given && !isRedactedPlaceholder(given))
        ? given : stored.wechat.appSecret;
      if (!appId || !appSecret) {
        return fail('E_INVALID_INPUT', 'AppID 与 AppSecret 均不能为空（留空表示沿用已保存的值）');
      }
      try {
        const wechat = core('wechat'); // mock 判定在 core 入口（契约 §4）
        const r = await wechat.getAccessToken(store.deepMerge(store.clone(stored), { wechat: { appId, appSecret } }));
        return ok({ expiresIn: r.expiresIn });
      } catch (e) {
        return toError(e, 'E_NET');
      }
    },

    'llm:test': async (p) => {
      const stored = store.loadFullConfig();
      const patch = {};
      if (p && p.baseUrl) patch.baseUrl = String(p.baseUrl).trim();
      if (p && typeof p.apiKey === 'string' && p.apiKey && !isRedactedPlaceholder(p.apiKey)) patch.apiKey = p.apiKey;
      if (p && p.model) patch.model = String(p.model).trim();
      const merged = store.deepMerge(store.clone(stored), { llm: patch });
      if (!merged.llm.apiKey) {
        return fail('E_INVALID_INPUT', 'API Key 不能为空（留空表示沿用已保存的值）');
      }
      try {
        const llm = core('llm');
        const r = await llm.probeLlm(merged);
        return ok({ model: r.model, latencyMs: r.latencyMs });
      } catch (e) {
        return toError(e, 'E_NET');
      }
    },

    'net:public-ip': async () => {
      const mock = core('mock');
      if (mock.isMock()) return ok({ ip: mock.mockPublicIp() }); // 契约 §4：与设计稿示例一致
      try {
        const r = await fetchWithRetry('https://api.ipify.org?format=json');
        if (!r || !r.ip) throw new Error('响应缺少 ip 字段');
        return ok({ ip: r.ip });
      } catch (e) {
        return fail('E_NET', `获取公网 IP 失败：${e.message}（检查本机网络后重试）`);
      }
    },

    // ------------------------------------------------------------ 自检 / 运行
    'selfcheck:run': async () => {
      const cfg = store.loadFullConfig();
      if (!cfgWechatReady(cfg)) {
        return fail('E_NO_CONFIG', '请先完成配置向导（至少填写公众号 AppID 与 AppSecret）再运行自检');
      }
      const state = store.loadState();
      try {
        const wechat = core('wechat'); // mock 判定在 core 入口（契约 §4）
        // core wechat.runSelfCheck 的 onStep 是单参数对象回调 {index,state,detail,errcode?}，
        // 事件契约（IMPLEMENTATION §2）：selfcheck:progress {index:0..3, state, detail}。
        const { items } = await wechat.runSelfCheck(cfg, state, (ev) => {
          if (!ev || typeof ev !== 'object') return;
          const payload = { index: ev.index, state: ev.state, detail: logger.scrub(ev.detail || '') };
          if (ev.errcode != null) payload.errcode = ev.errcode;
          sendEvent('selfcheck:progress', payload);
        }, { coverPath: DEFAULT_COVER }); // 未配置封面时回退应用内置默认图，避免真实模式 E_IO
        // core/wechat.js:273「持久化由调用方负责」：自检会写入 state.cover（封面素材缓存），
        // 不落盘的话真实模式每次自检都会把同一张封面上传成新的永久素材。
        try {
          store.saveStateMerged(state);
        } catch (e) {
          logger.warn(`自检后封面缓存保存失败：${e.message}（下次自检可能重复上传封面）`);
        }
        // 契约：selfcheck:run → {items:[...]}（数组）；core 已返回 {items}，此处只解包，不再二次包裹
        return ok({ items: Array.isArray(items) ? items : [] });
      } catch (e) {
        return toError(e, 'E_WECHAT');
      }
    },

    'run:generate': (p) => {
      if (runManager.isRunning()) {
        return fail('E_BUSY', '已有任务在运行中，请等待完成后再试');
      }
      const cfg = store.loadFullConfig();
      const missing = missingAutoConfig(cfg);
      if (missing.length) {
        return fail('E_NO_CONFIG', `仓库自动模式还缺少：${missing.join('、')}（到「设置 → 内容与文风」补全仓库路径，或改用素材/对话/雷达模式）`);
      }
      const started = runManager.start({
        upload: !!(p && p.upload),
        force: !!(p && p.force),
        cause: 'manual',
      });
      if (!started.ok) return started.error ? fail(started.error.code, started.error.message) : fail('E_BUSY', '无法开始运行');
      return ok({ runId: started.runId });
    },

    // ------------------------------------------------------------ 历史
    // v2：filter 支持来源筛选（material/chat/aggregate/auto 或中文标签 素材/对话/聚合/自动），
    //     与 v1 状态筛选（all/uploaded/generated/failed/skipped）并存；
    //     v2 创作条目带 id 与 dir（产物目录），v1 条目 dir 回退 output/<date>。
    'history:list': (p) => {
      const filter = p && p.filter ? p.filter : 'all';
      const state = store.loadState();
      const stateCore = core('state');
      let items;
      if (ORIGIN_FILTERS[filter]) {
        // 与默认分支同口径（新日期在前、同日按创建时间倒序）：直接返回 state.history 会变成升序
        items = stateCore.getHistory(state, 'all', ORIGIN_FILTERS[filter]);
      } else {
        items = stateCore.getHistory(state, filter);
      }
      return ok({
        items: items.map((it) => Object.assign({}, it, {
          dir: it.dir || path.join(store.paths.outputDir, it.date),
        })),
      });
    },

    // v2：入参 {id}（创作产物，按 entry.dir 定位）优先；{date} 保持 v1 语义（output/<date>）。
    // id 预览额外返回 sources/similarity（素材来源清单与相似度报告，PRD v2 §5.2：仅内部可见）。
    'history:preview': (p) => {
      const cfg = store.loadFullConfig();
      if (p && p.id) {
        const id = str(p.id, '成文 id', { max: 120 });
        const state = store.loadState();
        const { entry, article } = articles.loadComposedArticle(state, id);
        let words = article.words;
        if (typeof words !== 'number') {
          try {
            words = core('article').countWords(article.html || '');
          } catch (e) {
            words = null; // 字数统计失败不阻塞预览
          }
        }
        return ok({
          id,
          title: article.title || '',
          author: (cfg.content && cfg.content.author) || '',
          date: entry.date || article.date || '',
          words,
          html: article.html || '',
          coverDataUri: article.coverDataUri || null,
          visuals: article.visuals || null,
          assetEvidence: article.assetEvidence || null,
          profileEvidence: article.profileEvidence || null,
          codeEvidence: article.codeEvidence || null,
          generationMode: article.generationMode || null,
          origin: article.origin || entry.origin || null,
          // sources.json 顶层是核查文档对象（{internal,note,date,batchId,generatedAt,topics,sources}），
          // 渲染层按数组使用：这里统一取出 sources 数组（兼容旧版直接落数组的形态）。
          sources: sourcesArrayOf(articles.loadInternalDoc(entry.dir, 'sources.json')),
          similarity: articles.loadInternalDoc(entry.dir, 'similarity.json'),
        });
      }
      const date = String((p && p.date) || '').trim();
      if (!dateReValid(date)) {
        return fail('E_INVALID_INPUT', `日期格式应为 YYYY-MM-DD，收到：${date || '（空）'}`);
      }
      const artFile = path.join(store.paths.outputDir, date, 'article.json');
      if (!fs.existsSync(artFile)) {
        return fail('E_NOT_FOUND', `该日期没有已生成的文章（缺少 output/${date}/article.json）`);
      }
      let article;
      try {
        article = JSON.parse(fs.readFileSync(artFile, 'utf8'));
      } catch (e) {
        return fail('E_IO', `文章文件损坏：${e.message}`);
      }
      let words = article.words;
      if (typeof words !== 'number') {
        try {
          words = core('article').countWords(article.html || '');
        } catch (e) {
          words = null; // 字数统计失败不阻塞预览（契约 §7 决策 7：展示用口径）
        }
      }
      return ok({
        title: article.title || '',
        author: (cfg.content && cfg.content.author) || '',
        date,
        words,
        html: article.html || '',
        coverDataUri: article.coverDataUri || null,
      });
    },

    'history:reupload': (p) => {
      if (runManager.isRunning()) {
        return fail('E_BUSY', '已有任务在运行中，请等待完成后再试');
      }
      const date = String((p && p.date) || '').trim();
      if (!dateReValid(date)) {
        return fail('E_INVALID_INPUT', `日期格式应为 YYYY-MM-DD，收到：${date || '（空）'}`);
      }
      const artFile = path.join(store.paths.outputDir, date, 'article.json');
      const state = store.loadState();
      const inHistory = Array.isArray(state.history) && state.history.some((h) => h && h.date === date && h.status !== 'skipped');
      if (!fs.existsSync(artFile) && !inHistory) {
        return fail('E_NOT_FOUND', `该日期没有可重新上传的文章（output/${date}/article.json 不存在且历史无记录）`);
      }
      const started = runManager.start({ upload: true, force: true, cause: 'reupload', date });
      if (!started.ok) return started.error ? fail(started.error.code, started.error.message) : fail('E_BUSY', '无法开始运行');
      return ok({ runId: started.runId });
    },

    // ------------------------------------------------------------ v2.4 状态同步 / 打回重写

    /**
     * 状态同步：用草稿箱现状（draft/batchget）+ 成功发布列表（freepublish）判定
     * 本地「已上传 · 待发表」条目的真实状态——已发表 / 已删除。
     * 手动触发（历史页按钮）；mock 模式不联网、不改数据。
     */
    'history:sync': async () => {
      const cfg = store.loadFullConfig();
      if (core('mock').isMock()) {
        return ok({ mock: true, changed: 0, published: 0, removed: 0, drafts: 0, note: '演示模式不联网同步' });
      }
      const w = (cfg.wechat || {});
      if (!String(w.appId || '').trim() || !String(w.appSecret || '').trim()) {
        return fail('E_NO_CONFIG', '同步状态需要先配置公众号 AppID / AppSecret（设置 → 公众号凭证）');
      }
      let token;
      try {
        token = (await core('wechat').getAccessToken(cfg)).token;
      } catch (e) {
        return fail(e.code || 'E_NET', e.message, e.errcode ? { errcode: e.errcode } : undefined);
      }
      let drafts;
      let published;
      try {
        drafts = await core('wechat').listDrafts(token);
      } catch (e) {
        return fail(e.code || 'E_NET', `读取草稿箱失败：${e.message}`, e.errcode ? { errcode: e.errcode } : undefined);
      }
      // publishId → 标题缓存在 state，避免每次同步都逐条调 freepublish/get
      const state = store.loadState();
      if (!state.publishTitleCache || typeof state.publishTitleCache !== 'object') state.publishTitleCache = {};
      try {
        published = await core('wechat').listPublishedTitles(token, {}, state.publishTitleCache);
      } catch (e) {
        return fail(e.code || 'E_NET', `读取发布列表失败：${e.message}`, e.errcode ? { errcode: e.errcode } : undefined);
      }
      const sync = core('sync').computeStatusSync(state.history, { drafts, publishedTitles: published });
      for (const u of sync.updates) {
        const entry = state.history.find((h) => h && (h.id || h.date) === u.key);
        if (entry) {
          entry.status = u.status;
          entry.syncedAt = new Date().toISOString();
        }
      }
      if (sync.updates.length) store.saveStateMerged(state);
      logger.info(`状态同步完成：草稿箱 ${drafts.length} 篇，判定已发表 ${sync.counts.published}、已删除 ${sync.counts.removed}，共更新 ${sync.updates.length} 条`);
      return ok({
        changed: sync.updates.length,
        published: sync.counts.published,
        removed: sync.counts.removed,
        unchanged: sync.counts.unchanged,
        drafts: drafts.length,
      });
    },

    /**
     * 打回重写（v2.4，仅聚合成文）：读取该篇留档的选题（sources.json）→
     * 按当前聚合配置重新综合成文（重写次数走 autoRewriteAttempts）→ 上传新稿 →
     * 删除旧草稿（draft/delete，已在公众号删过则跳过）→ 旧条目标记 replaced。
     * 长任务：与 compose:generate 同风格，在 IPC 内联执行；结果一次性返回。
     */
    'compose:regenerate': async (p) => {
      const id = str(p && p.id, '成文 id', { max: 120 });
      const state = store.loadState();
      const entry = articles.findEntryById(state, id);
      if (!entry) return fail('E_NOT_FOUND', `找不到成文记录：${id}`);
      if (entry.origin !== '聚合') {
        return fail('E_INVALID_INPUT', '打回重写目前仅支持「全网聚合」成文（素材/对话成文请在创作页重新生成）');
      }
      if (!entry.dir) return fail('E_NOT_FOUND', '该记录没有关联的文章目录，无法读取原选题');
      const srcFile = path.join(entry.dir, 'sources.json');
      if (!fs.existsSync(srcFile)) {
        return fail('E_NOT_FOUND', '文章目录缺少 sources.json（原选题留档），无法打回重写');
      }
      let topics;
      try {
        const sj = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
        topics = (sj.topics || []).map((t) => ({
          id: t.id || t.title,
          title: t.title,
          url: t.url || '',
          summary: t.summary || '',
          label: t.label || 'L3',
          tier: t.tier || 3,
        })).filter((t) => t.title && t.url);
      } catch (e) {
        return fail('E_IO', `sources.json 损坏：${e.message}`);
      }
      if (!topics.length) return fail('E_NOT_FOUND', '原选题留档为空，无法打回重写（请到选题雷达重新勾选成文）');

      const cfg = store.loadFullConfig();
      const aggregate = core('aggregate');
      const ag = cfg.aggregate || {};
      const legacyCode = ag.includeCode === true;
      const articleMode = ag.articleMode || (legacyCode ? 'web-code' : 'web');
      const includeCode = articleMode === 'web-code';
      const includeProfile = articleMode === 'web-profile';
      const topicTitles = topics.map((t) => t.title).join(' ');
      const topicBlob = topics.map((t) => `${t.title} ${t.summary || ''}`).join(' ');

      sendEvent('task:progress', { kind: 'compose', stage: 0, state: 'active', detail: `打回重写：按原选题「${topics[0].title}」重新搜索素材并综合…` });
      const projectProfile = includeProfile
        ? require('../src/core/product-profile').readProductProfile({ filePath: ag.profilePath || '', topic: topicTitles })
        : null;
      const localAssets = (includeCode || includeProfile) && ag.imagesEnabled
        ? require('../src/core/local-assets').listLocalAssets({ dir: ag.imagesDir, topic: topicBlob })
        : [];
      let codeContext = null;
      if (includeCode) {
        codeContext = require('../src/core/code-context').collectCodeContext({
          repoPath: String(ag.repoPath || cfg.content.repoPath || '').trim(),
          topic: topicTitles,
        });
      }
      let styleInjection = '';
      try {
        styleInjection = buildStyleInjection(cfg, store.paths.dataDir, topicTitles);
      } catch (e) {
        styleInjection = '';
      }
      const projectCtx = core('config').projectContext(cfg);
      const today = core('scheduler').dayKey(new Date());
      const r = await aggregate.composeFromTopics(cfg, {
        topics,
        project: (includeCode || includeProfile) ? projectCtx : { audience: projectCtx.audience },
        codeContext,
        productProfile: projectProfile,
        localAssets,
        productName: String(ag.productName || '').trim() || '我的系统',
        promotion: String(ag.promotion || '').trim(),
        styleInjection,
        confirmSensitive: false,
        date: today,
        batchNonce: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, // 新稿不覆盖旧稿目录
        dataDir: store.paths.dataDir,
        state,
        maxRewrites: Number.isInteger(ag.autoRewriteAttempts) ? ag.autoRewriteAttempts : undefined,
        logger: bridgeLogger(logger),
      }, {
        materializeIllustrations: (article, options) => require('./illustration').materializeArticle(article, { ...options, localAssets }),
      });
      if (!r.ok && r.needsConfirmation) {
        return fail('E_CONFIRM_REQUIRED', r.reason, { sensitiveKeywords: r.sensitiveKeywords });
      }
      if (!r.ok) return fail('E_COMPOSE', '打回重写失败：综合成文未成功');

      const newEntry = articles.findEntryById(state, r.batchId);
      if (newEntry && !newEntry.dir && r.outDir) {
        newEntry.dir = r.outDir;
        store.saveStateMerged(state);
      }
      logger.info(`打回重写：新稿已生成 batchId=${r.batchId}（${r.words} 字，相似度重写 ${r.similarity.rewriteAttempts} 次，needsRewrite=${r.needsRewrite}）`);

      // 上传新稿：autoForceUpload=true 时即使仍超标也照常上传（与定时全自动同一语义）
      const force = r.needsRewrite && ag.autoForceUpload !== false;
      let uploaded = false;
      let draftMediaId = null;
      try {
        const up = await articles.uploadComposedArticle({
          cfg, state, dataDir: store.paths.dataDir, id: r.batchId, logger,
          deps: { coverPath: DEFAULT_COVER },
          forceUpload: !!r.needsRewrite,
        });
        uploaded = true;
        draftMediaId = up.draftMediaId;
      } catch (e) {
        if (r.needsRewrite && e && e.code === 'E_REWRITE_REQUIRED') {
          // 理论不可达（forceUpload 已绕闸），兜底转为「只保存不上传」
          logger.warn(`打回重写：新稿相似度仍超标且未强制上传（${e.message}）`);
          return ok({
            regenerated: true, needsRewrite: true, uploaded: false,
            articleId: r.batchId, words: r.words,
            similarity: r.similarity,
            note: '新稿相似度仍超标，已保存未上传（旧稿保留）',
          });
        }
        throw e;
      }

      // 旧草稿清理：删除成功（或本来就不在）→ 旧条目标记 replaced；删除失败 → 保留原状态并如实返回
      let oldDeleted = false;
      let oldNote = '';
      if (entry.draftMediaId) {
        try {
          const token = (await core('wechat').getAccessToken(cfg)).token;
          await core('wechat').deleteDraft(token, entry.draftMediaId);
          oldDeleted = true;
        } catch (e) {
          const errcode = e && e.errcode;
          if (errcode === 40007 || /api deleted/i.test(String(e.message))) {
            oldDeleted = true; // 草稿已经不存在（用户手动删过）→ 视同完成
          } else {
            oldNote = `旧草稿删除失败（${e.message}），请在公众号后台手动删除`;
            logger.warn(`打回重写：${oldNote}`);
          }
        }
      } else {
        oldDeleted = true; // 旧稿从未上传（如相似度卡关的那篇），无需删除
      }
      if (oldDeleted) {
        entry.status = 'replaced';
        entry.replacedBy = r.batchId;
        entry.replacedAt = new Date().toISOString();
        store.saveStateMerged(state);
      }
      logger.info(`打回重写完成：旧稿 ${oldDeleted ? '已清理' : '删除失败'}，新稿 draft_media_id=${draftMediaId}`);
      return ok({
        regenerated: true,
        uploaded,
        needsRewrite: r.needsRewrite,
        articleId: r.batchId,
        dir: r.outDir,
        words: r.words,
        similarity: r.similarity,
        oldDeleted,
        oldNote,
        draftMediaId,
      });
    },

    // ------------------------------------------------------------ 日志
    'logs:list': (p) => {
      const level = p && p.level ? p.level : undefined;
      const limit = p && p.limit;
      return ok({ items: logger.list({ level, limit: Number.isInteger(limit) ? limit : undefined }) });
    },

    'logs:clear': () => {
      logger.clear();
      return ok({});
    },

    'logs:export': async () => {
      const win = getWindow();
      const stamp = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const r = await dialog.showSaveDialog(win, {
        title: '导出运行日志',
        defaultPath: `app-logs-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}.txt`,
        filters: [{ name: '文本', extensions: ['txt'] }],
      });
      if (r.canceled || !r.filePath) return ok({ path: null });
      fs.writeFileSync(r.filePath, logger.text(), 'utf8');
      return ok({ path: r.filePath });
    },

    // ------------------------------------------------------------ 定时
    'schedule:get': () => ok(schedulerHost.getScheduleInfo()),

    'schedule:set': (p) => {
      p = p || {};
      const patch = {};
      if (p.time !== undefined && p.time !== null) {
        const sched = core('scheduler'); // parseTime 非法返回 null → E_INVALID_INPUT（契约 §6）
        const t = sched.parseTime(String(p.time));
        if (!t) return fail('E_INVALID_INPUT', `定时时间格式应为 HH:MM（如 09:30），收到：${p.time}`);
        patch.time = String(p.time);
      }
      if (p.enabled !== undefined && p.enabled !== null) {
        if (typeof p.enabled !== 'boolean') {
          return fail('E_INVALID_INPUT', `enabled 应为布尔值，收到：${p.enabled}`);
        }
        patch.enabled = p.enabled;
      }
      // v2.2 起：定时任务类型（auto=仓库自动 / pool=内容池 / radar=选题雷达自动）
      if (p.mode !== undefined && p.mode !== null) {
        let modes;
        try {
          modes = core('config').SCHEDULE_MODES;
        } catch (e) {
          modes = ['auto', 'pool', 'radar'];
        }
        if (!modes.includes(p.mode)) {
          return fail('E_INVALID_INPUT', `mode 应为 ${modes.join(' / ')} 之一（auto=仓库自动，pool=内容池，radar=选题雷达自动），收到：${p.mode}`);
        }
        patch.mode = p.mode;
      }
      const cfg = store.loadFullConfig();
      cfg.app.schedule = Object.assign({}, cfg.app.schedule, patch);
      store.saveFullConfig(cfg);
      schedulerHost.refreshTray(); // 更新托盘 tooltip（契约 §2 schedule:set）
      logger.info(`定时设置已更新：enabled=${cfg.app.schedule.enabled} time=${cfg.app.schedule.time} mode=${cfg.app.schedule.mode || 'auto'}`);
      return ok(schedulerHost.getScheduleInfo());
    },

    // ------------------------------------------------------------ v2 对话共创
    // 会话持久化：DATA/sessions/<id>.json（src/core/chat + persist）；回复分段经 chat:segment 推送。
    'chat:list': () => ok({ items: core('chat').listSessions(store.paths.dataDir) }),

    'chat:new': () => {
      const chat = core('chat');
      const session = chat.newSession();
      chat.saveSession(store.paths.dataDir, session);
      logger.info(`新建对话会话：${session.id}`);
      return ok({ session });
    },

    'chat:open': (p) => {
      const id = str(p.id, '会话 id', { max: 120 });
      const session = core('chat').loadSession(store.paths.dataDir, id);
      if (!session) return fail('E_NOT_FOUND', `会话不存在：${id}`);
      return ok({ session });
    },

    'chat:send': async (p) => {
      const id = str(p.sessionId, '会话 id', { max: 120 });
      const text = str(p.text, '消息内容', { max: 20000 });
      const cfg = store.loadFullConfig();
      requireLlmConfig(cfg, '对话');
      if (busyChats.has(id)) {
        return fail('E_BUSY', '该会话正在回复中，请等当前回复结束后再发');
      }
      const chat = core('chat');
      const session = chat.loadSession(store.paths.dataDir, id);
      if (!session) return fail('E_NOT_FOUND', `会话不存在：${id}`);
      busyChats.add(id);
      try {
        // 重试（renderer 的「重试」按钮）：上一条用户消息在首次请求时已落盘，不能重复追加
        const msgs = Array.isArray(session.messages) ? session.messages : [];
        const last = msgs[msgs.length - 1];
        const isRetry = !!(p && p.retry === true) && last && last.role === 'user' && String(last.content) === text;
        if (!isRetry) {
          chat.addMessage(session, { role: 'user', content: text });
          chat.saveSession(store.paths.dataDir, session); // 先存用户消息，回复中断也不丢上下文
        }
        const r = await chat.chatReply(cfg, session, {
          project: projectCtx(cfg),
          styleInjection: buildStyleInjection(cfg, store.paths.dataDir, text),
        });
        chat.saveSession(store.paths.dataDir, r.session); // chatReply 已把 assistant 消息并入 session
        await emitChatSegments(sendEvent, id, r.reply.content); // 分段返回（PRD v2 §7）
        logger.info(`对话回复完成：session=${id} model=${r.model}${r.dropped ? `（早期上下文截断 ${r.dropped} 条）` : ''}`);
        return ok({ session: r.session, reply: r.reply, model: r.model, dropped: r.dropped });
      } finally {
        busyChats.delete(id);
      }
    },

    'chat:delete': (p) => {
      const id = str(p.id, '会话 id', { max: 120 });
      core('chat').deleteSession(store.paths.dataDir, id);
      logger.info(`已删除对话会话：${id}`);
      return ok({});
    },

    // ------------------------------------------------------------ v2 文风画像
    // 样文库：DATA/style-samples/<id>.json（src/core/style，内容指纹为 id，同文自动去重）。
    'style:samples:list': () => ok({ items: core('style').loadSamples(store.paths.dataDir) }),

    'style:samples:add': (p) => {
      const text = str(p.text, '样文内容', { max: 200000 });
      const name = str(p.name, '样文名称', { max: 200, optional: true });
      const style = core('style');
      const samples = style.loadSamples(store.paths.dataDir);
      const { sample, duplicate } = style.addSample(samples, { name, text });
      style.saveSample(store.paths.dataDir, sample);
      if (duplicate) logger.info(`样文与已有样本内容相同，未重复入库：${sample.name}`);
      return ok({ sample, duplicate, total: samples.length });
    },

    'style:samples:import': (p) => {
      const style = core('style');
      const samples = style.loadSamples(store.paths.dataDir);
      const added = [];
      const errors = [];
      let duplicates = 0;
      const addOne = (file) => {
        try {
          const r = style.addSample(samples, { name: file.name, text: file.text });
          if (r.duplicate) {
            duplicates += 1;
            return;
          }
          style.saveSample(store.paths.dataDir, r.sample);
          added.push(r.sample);
        } catch (e) {
          errors.push(`${file.name || file.path || '（未命名）'}：${e.message}`);
        }
      };
      if (p.dirPath) {
        const dirPath = str(p.dirPath, '样文目录', { max: 500 });
        const scanned = style.scanSampleFolder(dirPath);
        errors.push(...scanned.errors); // 单文件失败不阻断，如实记录
        for (const f of scanned.samples) addOne(f);
      }
      if (Array.isArray(p.paths)) {
        const paths = p.paths.slice(0, 50); // 一次最多 50 个文件
        if (paths.some((x) => typeof x !== 'string' || !x.trim())) badInput('paths 应为文件路径字符串数组');
        for (const one of paths) {
          try {
            addOne(style.readSampleFile(one));
          } catch (e) {
            errors.push(`${one}：${e.message}`);
          }
        }
      }
      if (!p.dirPath && !Array.isArray(p.paths)) {
        badInput('请提供要导入的样文：paths（文件路径数组）或 dirPath（文件夹）');
      }
      logger.info(`样文导入：新增 ${added.length} 篇，重复跳过 ${duplicates} 篇，失败 ${errors.length} 个`);
      return ok({ items: added, errors, duplicates, total: samples.length });
    },

    'style:samples:delete': (p) => {
      const id = str(p.id, '样文 id', { max: 120 });
      core('style').deleteSample(store.paths.dataDir, id);
      return ok({});
    },

    'style:analyze': async () => {
      const cfg = store.loadFullConfig();
      requireLlmConfig(cfg, '分析文风画像');
      const style = core('style');
      const samples = style.loadSamples(store.paths.dataDir);
      if (!samples.length) {
        badInput('还没有样文：先在「文章样本库」导入或粘贴至少 1 篇样文再一键分析');
      }
      const r = await style.analyzeStyle(cfg, samples);
      cfg.style.profile = r.profile;
      // PRD v2 §4.3「生成时注入」：分析出画像即启用，否则默认 enabled=false 会让
      // 「导入样文 → 一键分析 → 成文」这条默认流程悄悄不注入；用户仍可在开关里停用。
      cfg.style.enabled = true;
      store.saveFullConfig(cfg);
      logger.info(`文风画像分析完成：${samples.length} 篇样文，model=${r.model}（已启用）`);
      return ok({ profile: r.profile, model: r.model, sampleCount: samples.length, enabled: true });
    },

    'style:profile:get': () => {
      const cfg = store.loadFullConfig();
      const style = core('style');
      return ok({ profile: style.loadProfile(cfg), enabled: !!(cfg.style && cfg.style.enabled) });
    },

    'style:profile:set': (p) => {
      const cfg = store.loadFullConfig();
      const style = core('style');
      const normalized = style.normalizeProfile(p.profile === undefined ? null : p.profile); // null → 清空画像
      cfg.style.profile = normalized;
      store.saveFullConfig(cfg);
      logger.info(normalized ? `文风画像已更新：${normalized.name}` : '文风画像已清空');
      return ok({ profile: normalized });
    },

    'style:profile:toggle': (p) => {
      if (typeof p.enabled !== 'boolean') badInput(`enabled 应为布尔值，收到：${p.enabled}`);
      const cfg = store.loadFullConfig();
      const style = core('style');
      if (p.enabled && !style.loadProfile(cfg)) {
        badInput('还没有文风画像：先「一键分析」生成画像后再启用');
      }
      cfg.style.enabled = p.enabled;
      store.saveFullConfig(cfg);
      logger.info(`文风画像已${p.enabled ? '启用' : '停用'}`);
      return ok({ enabled: p.enabled, profile: style.loadProfile(cfg) });
    },

    // ------------------------------------------------------------ v2 选题雷达
    // 清单：DATA/radar/radar-<date>.json（src/core/aggregate.runTopicRadar 落盘）。
    'radar:run': async () => {
      const cfg = store.loadFullConfig();
      const agg = cfg.aggregate || {};
      const kws = Array.isArray(agg.keywords) ? agg.keywords.map((k) => String(k || '').trim()).filter(Boolean) : [];
      if (!kws.length) {
        badInput('未配置搜索关键词：到「设置 → 聚合来源配置」添加关键词（如 科技 / 教育）后重试');
      }
      // 前置校验直接用 core 的派生态（aggregateConfigOf），与运行期同一口径：
      // 「能不能复用大模型 Key」要同时满足「该通道是厂商自带搜索」+「大模型正是同一家」，
      // 只看 provider 名字会在换模型后把别家的 Key 发到对不上的地址（表现为 404）。
      const aggregate = core('aggregate');
      const info = aggregate.aggregateConfigOf(cfg);
      if (!info.apiKey) {
        if (info.providerNative) {
          const alt = info.llmNativeProvider
            ? `改选「${info.llmNativeProvider}」（与当前大模型同一家，可复用 Key）`
            : '改选独立搜索服务（博查 / Tavily / SerpAPI，与用什么模型无关）';
          badInput(
            `没有可用的搜索 Key：${info.providerLabel} 搜索需要 ${info.providerLabel} 的 Key，` +
            `但当前大模型不是 ${info.providerLabel}（当前 baseUrl=${(cfg.llm && cfg.llm.baseUrl) || '未配置'}）。` +
            `两种解法：① 到「设置 → 聚合来源」${alt}；② 或者在这一页单独填写 ${info.providerLabel} 的搜索 Key。`
          );
        } else {
          badInput(`搜索 API Key 未填写：到「设置 → 聚合来源配置」填写 ${info.providerLabel} 的 Key 后重试`);
        }
      }
      sendEvent('task:progress', { kind: 'radar', stage: 0, state: 'active', detail: `正在按 ${kws.length} 个关键词搜索全网…` });
      try {
        const r = await aggregate.runTopicRadar(cfg, { dataDir: store.paths.dataDir });
        const failNote = r.keywordErrors.length ? `，${r.keywordErrors.length} 个关键词搜索失败已记录` : '';
        sendEvent('task:progress', {
          kind: 'radar',
          stage: 1,
          state: 'done',
          detail: `今日热点清单已生成：${r.topics.length} 条（去重/过滤 ${r.removedCount} 条${failNote}）`,
        });
        logger.info(`选题雷达完成：date=${r.date} 选题 ${r.topics.length} 条（失败关键词 ${r.keywordErrors.length} 个）`);
        return ok({
          date: r.date,
          generatedAt: r.radar.generatedAt,
          topics: r.topics,
          keywordErrors: r.keywordErrors,
          removedCount: r.removedCount,
        });
      } catch (e) {
        sendEvent('task:progress', { kind: 'radar', stage: 1, state: 'fail', detail: logger.scrub(e.message) });
        throw e;
      }
    },

    'radar:get': (p) => {
      const date = p && p.date ? requireDate(p.date) : todayKey();
      const radar = core('aggregate').loadRadar(store.paths.dataDir, date);
      // 契约 §10：无当日清单 → E_NOT_FOUND。这是正常空态（渲染层 restoreToday 静默处理），
      // logIpc 对该通道的 E_NOT_FOUND 不记「IPC 失败」，避免每次启动刷一条告警。
      if (!radar) {
        return fail('E_NOT_FOUND', `${date} 还没有热点清单：点「刷新今日热点」生成`);
      }
      return ok({ radar });
    },

    // 勾选状态持久化：ids = 当前勾选的选题 id 全集（渲染层每次全量传）
    'radar:select': (p) => {
      const date = requireDate(p.date);
      if (!Array.isArray(p.ids)) badInput('ids 应为选题 id 字符串数组');
      const ids = p.ids.map((s) => String(s || '').trim()).filter(Boolean);
      if (ids.length > 50) badInput('勾选数量过多（最多 50 条）');
      const aggregate = core('aggregate');
      const radar = aggregate.loadRadar(store.paths.dataDir, date);
      if (!radar) return fail('E_NOT_FOUND', `${date} 还没有热点清单`);
      const idSet = new Set(ids);
      let changed = 0;
      for (const t of radar.topics || []) {
        const next = idSet.has(t.id);
        if (t.selected !== next) changed += 1;
        t.selected = next;
      }
      const { writeJson } = require('../src/core/persist');
      writeJson(aggregate.radarDir(store.paths.dataDir), `radar-${date}.json`, radar);
      logger.info(`选题勾选已保存：date=${date} 勾选 ${ids.length} 条`);
      return ok({ radar, changed });
    },

    // ------------------------------------------------------------ v2 创作成文
    // 三模式统一入口：material（素材成文）/ chat（对话整理）/ radar（选题勾选成文）。
    // 聚合模式的落盘/相似度自检/敏感闸在 core/aggregate.composeFromTopics 内完成；
    // 素材/对话的落盘与历史在 main/articles 内完成（chat.js 只产出文章三元组）。
    'compose:generate': async (p) => {
      const mode = p.mode;
      if (!['material', 'chat', 'radar'].includes(mode)) {
        badInput(`mode 应为 material / chat / radar，收到：${mode}`);
      }
      const cfg = store.loadFullConfig();
      requireLlmConfig(cfg, '成文');
      const dataDir = store.paths.dataDir;
      const chat = core('chat');
      const aggregate = core('aggregate');
      sendEvent('task:progress', { kind: 'compose', stage: 0, state: 'active', detail: 'AI 正在按你的文风成文…' });

      if (mode === 'material') {
        const material = str(p.material, '素材', { max: 50000 });
        const emphasis = str(p.emphasis, '想强调的点', { max: 500, optional: true });
        const injection = buildStyleInjection(cfg, dataDir, `${emphasis} ${material}`.trim());
        const r = await chat.composeMaterial(cfg, {
          material,
          emphasis,
          project: projectCtx(cfg),
          styleInjection: injection,
        });
        const saved = await articles.saveComposedArticle({
          dataDir,
          state: store.loadState(),
          origin: '素材',
          article: r.article,
          date: todayKey(),
          logger,
        });
        logger.info(`素材成文完成：《${saved.article.title}》（${saved.words} 字）`);
        return ok({
          articleId: saved.id,
          dir: saved.dir,
          article: saved.article,
          words: saved.words,
          origin: '素材',
          date: saved.article.date,
        });
      }

      if (mode === 'chat') {
        const id = str(p.sessionId, '会话 id', { max: 120 });
        const session = chat.loadSession(dataDir, id);
        if (!session) return fail('E_NOT_FOUND', `会话不存在：${id}`);
        const injection = buildStyleInjection(cfg, dataDir, session.title || '');
        const r = await chat.composeFromSession(cfg, session, {
          project: projectCtx(cfg),
          styleInjection: injection,
        });
        const saved = await articles.saveComposedArticle({
          dataDir,
          state: store.loadState(),
          origin: '对话',
          article: r.article,
          date: todayKey(),
          logger,
        });
        logger.info(`对话整理成文完成：《${saved.article.title}》（${saved.words} 字）`);
        return ok({
          articleId: saved.id,
          dir: saved.dir,
          article: saved.article,
          words: saved.words,
          origin: '对话',
          date: saved.article.date,
        });
      }

      // mode === 'radar'：勾选 1~3 条选题 → 综合成文（含敏感话题闸与相似度自检）
      if (!Array.isArray(p.ids) || p.ids.length < 1 || p.ids.length > 3 || p.ids.some((x) => typeof x !== 'string' || !x.trim())) {
        badInput('请勾选 1~3 条选题再成文');
      }
      const radarDate = requireDate(p.date || todayKey());
      const radar = aggregate.loadRadar(dataDir, radarDate);
      if (!radar) {
        return fail('E_NOT_FOUND', `${radarDate} 还没有热点清单：先在选题雷达页点「刷新今日热点」`);
      }
      const ids = p.ids.map((s) => s.trim());
      const topics = (radar.topics || []).filter((t) => ids.includes(t.id));
      if (topics.length !== ids.length) {
        const missing = ids.filter((x) => !(radar.topics || []).some((t) => t.id === x));
        return fail('E_NOT_FOUND', `勾选的选题不在 ${radarDate} 的清单中：${missing.join('、')}`);
      }
      const articleMode = p.articleMode || (p.includeCode === true ? 'web-code' : 'web');
      if (!['web','web-profile','web-code'].includes(articleMode)) badInput('文章方式无效');
      const includeCode = articleMode === 'web-code';
      const includeProfile = articleMode === 'web-profile';
      const productProfile = includeProfile ? require('../src/core/product-profile').readProductProfile({filePath:(cfg.aggregate && cfg.aggregate.profilePath) || '',topic:topics.map(t=>t.title).join(' ')}) : null;
      const localAssets = (includeCode || includeProfile) && cfg.aggregate.imagesEnabled ? require('../src/core/local-assets').listLocalAssets({dir:cfg.aggregate.imagesDir,topic:topics.map(t=>t.title+' '+(t.summary||'')).join(' ')}) : [];
      let codeContext = null;
      const radarRepo = String((cfg.aggregate && cfg.aggregate.repoPath) || cfg.content.repoPath || '').trim();
      const productName = str(p.productName || (cfg.aggregate && cfg.aggregate.productName) || '我的系统', '产品名称', {max:60});
      const promotion = str(p.promotion || (cfg.aggregate && cfg.aggregate.promotion) || '', '推广重点', {max:1000,optional:true});
      if (includeCode) {
        sendEvent('task:progress', {kind:'compose',stage:0,state:'active',detail:'正在读取代码库并筛选与选题相关的功能…'});
        codeContext = require('../src/core/code-context').collectCodeContext({repoPath:radarRepo,topic:topics.map(t=>t.title).join(' ')});
      }
      const state = store.loadState();
      const r = await aggregate.composeFromTopics(cfg, {
        topics,
        project: (includeCode || includeProfile) ? projectCtx(cfg) : {audience:projectCtx(cfg).audience},
        codeContext, productProfile, localAssets, productName, promotion,
        styleInjection: buildStyleInjection(cfg, dataDir, topics.map((t) => t.title).join(' ')),
        confirmSensitive: !!p.confirmSensitive,
        date: radarDate,
        batchNonce: `${Date.now()}-${Math.random().toString(16).slice(2,8)}`, // 「按原选题重新生成」不得覆盖上一稿
        dataDir,
        state,
        logger: bridgeLogger(logger),
      }, {
        // v2.3：插图渲染器由主进程注入（core 不能 import electron）
        materializeIllustrations: (article, options) => require('./illustration').materializeArticle(article, {...options,localAssets}),
      });
      if (!r.ok && r.needsConfirmation) {
        // PRD v2 §5.3：敏感话题默认需人工确认才生成
        return fail('E_CONFIRM_REQUIRED', r.reason, { sensitiveKeywords: r.sensitiveKeywords });
      }
      // composeFromTopics 已落盘并入历史；补记产物目录（entry.dir）供预览/上传定位
      const entry = articles.findEntryById(state, r.batchId);
      if (entry && !entry.dir && r.outDir) {
        entry.dir = r.outDir;
        store.saveStateMerged(state);
      }
      logger.info(`聚合成文完成：batchId=${r.batchId}（${r.words} 字，相似度重写 ${r.similarity.rewriteAttempts} 次）`);
      return ok({
        articleId: r.batchId,
        dir: r.outDir,
        article: r.article,
        words: r.words,
        origin: '聚合',
        date: r.date,
        similarity: r.similarity,
        needsRewrite: r.needsRewrite,
        assetEvidence: r.article.assetEvidence,
        profileEvidence: r.article.profileEvidence,
        codeEvidence: r.article.codeEvidence,
        generationMode: r.article.generationMode,
        sources: r.sources, // 素材来源清单（内部可见，不随文发布）
      });
    },

    // 编辑后保存（创作页编辑器）：title/digest 截断同 parseLlmOutput 口径，html 消毒 + 重算字数
    'compose:save': (p) => {
      const id = str(p.id, '成文 id', { max: 120 });
      const patch = {};
      if (p.title !== undefined) patch.title = str(p.title, '标题', { max: 200 });
      if (p.digest !== undefined) patch.digest = str(p.digest, '摘要', { max: 300 });
      if (p.html !== undefined) {
        if (typeof p.html !== 'string') badInput('html 应为字符串');
        patch.html = p.html;
      }
      if (!Object.keys(patch).length) badInput('没有需要保存的修改：title / digest / html 至少提供一项');
      const r = articles.saveComposedPatch({
        dataDir: store.paths.dataDir,
        state: store.loadState(),
        id,
        patch,
        logger,
      });
      logger.info(`成文已保存：id=${id}（${r.words} 字）`);
      return ok({ article: r.article, words: r.words });
    },

    // 上传到草稿箱（复用 v1 wechat 链路；与 git 管线互斥避免并发写 state/封面缓存）
    'compose:upload': async (p) => {
      if (runManager.isRunning()) {
        return fail('E_BUSY', '已有任务在运行中，请等待完成后再试');
      }
      const id = str(p.id, '成文 id', { max: 120 });
      const cfg = store.loadFullConfig();
      if (!cfg.wechat.appId || !cfg.wechat.appSecret) {
        return fail('E_NO_CONFIG', '公众号 AppID / AppSecret 未配置：到「设置 → 公众号凭证」填写后再上传');
      }
      sendEvent('task:progress', { kind: 'compose', stage: 0, state: 'active', detail: '正在上传到草稿箱…' });
      const r = await articles.uploadComposedArticle({
        cfg,
        state: store.loadState(),
        dataDir: store.paths.dataDir,
        id,
        logger,
        deps: { coverPath: DEFAULT_COVER }, // 未配置封面时回退应用内置默认图
      });
      return ok({ draftMediaId: r.draftMediaId, words: r.words, title: r.title });
    },

    // ------------------------------------------------------------ v2.2 内容池
    // 池文件 DATA/content-pool.json（src/core/pool）。定时任务 mode=pool 时每天取最早一条，
    // 也支持「立即写一条」手动触发；两者共用 runManager.startPool 与 run:progress/run:finished 事件。
    'pool:list': () => {
      const poolCore = core('pool');
      const doc = poolCore.loadPool(store.paths.dataDir);
      return ok({ items: doc.items, stats: poolCore.stats(doc) });
    },

    'pool:add': (p) => {
      p = p || {};
      const poolCore = core('pool');
      const doc = poolCore.loadPool(store.paths.dataDir);
      // 校验与截断统一在 core（题目必填、素材/强调点超长报错），IPC 层不重复实现
      const { item } = poolCore.addItem(doc, { title: p.title, material: p.material, emphasis: p.emphasis });
      poolCore.savePool(store.paths.dataDir, doc);
      logger.info(`内容池新增：${item.title}（待写 ${poolCore.stats(doc).pending} 条）`);
      return ok({ item, stats: poolCore.stats(doc) });
    },

    'pool:update': (p) => {
      p = p || {};
      const id = str(p.id, '条目 id', { max: 120 });
      const patch = {};
      if (p.title !== undefined) patch.title = p.title;
      if (p.material !== undefined) patch.material = p.material;
      if (p.emphasis !== undefined) patch.emphasis = p.emphasis;
      if (!Object.keys(patch).length) badInput('没有需要修改的字段：title / material / emphasis 至少提供一项');
      const poolCore = core('pool');
      const doc = poolCore.loadPool(store.paths.dataDir);
      const item = poolCore.updateItem(doc, id, patch);
      poolCore.savePool(store.paths.dataDir, doc);
      logger.info(`内容池条目已更新：${item.title}`);
      return ok({ item, stats: poolCore.stats(doc) });
    },

    'pool:delete': (p) => {
      p = p || {};
      const id = str(p.id, '条目 id', { max: 120 });
      const poolCore = core('pool');
      const doc = poolCore.loadPool(store.paths.dataDir);
      const removed = poolCore.removeItem(doc, id);
      if (removed) {
        poolCore.savePool(store.paths.dataDir, doc);
        logger.info(`内容池条目已删除：${id}`);
      }
      return ok({ removed, stats: poolCore.stats(doc) });
    },

    // 立即写一条（不等定时）：与定时同一套门控——大模型 Key + 公众号凭证（要自动上传）
    'pool:run-now': () => {
      if (runManager.isRunning()) {
        return fail('E_BUSY', '已有任务在运行中，请等待完成后再试');
      }
      const cfg = store.loadFullConfig();
      const missing = missingRunConfig(cfg);
      if (missing.length) {
        return fail('E_NO_CONFIG', `内容池自动成文还缺少：${missing.join('、')}（到设置页补全后再试）`);
      }
      const poolCore = core('pool');
      const doc = poolCore.loadPool(store.paths.dataDir);
      const next = poolCore.nextPending(doc);
      if (!next) return fail('E_NOT_FOUND', '内容池里没有待写条目：先在「内容池」页添加一条题目');
      const started = runManager.startPool({ cause: 'manual' });
      if (!started.ok) return fail('E_BUSY', started.error.message);
      logger.info(`内容池手动触发：开始写《${next.title}》`);
      return ok({ runId: started.runId, item: next });
    },

    // v2.4：选题雷达全自动立即跑一次（不等定时）——
    // 按当前聚合配置搜索 → 自动选排名最前的 N 条 → 成文 → 上传草稿箱。
    'radar:auto-run': () => {
      if (runManager.isRunning()) {
        return fail('E_BUSY', '已有任务在运行中，请等待完成后再试');
      }
      const cfg = store.loadFullConfig();
      const missing = missingRunConfig(cfg);
      if (missing.length) {
        return fail('E_NO_CONFIG', `选题雷达自动成文还缺少：${missing.join('、')}（到设置页补全后再试）`);
      }
      const info = core('aggregate').aggregateConfigOf(cfg);
      const radarMissing = [];
      if (!info.keywords.length) radarMissing.push('搜索关键词');
      if (!info.apiKey) radarMissing.push(`${info.providerLabel}的搜索 Key`);
      if (radarMissing.length) {
        return fail('E_NO_CONFIG', `选题雷达还缺少：${radarMissing.join('、')}（到「设置 → 聚合来源配置」补全）`);
      }
      const started = runManager.startRadar({ cause: 'manual' });
      if (!started.ok) return fail('E_BUSY', started.error.message);
      logger.info(`选题雷达手动触发：开始搜索并自动成文（关键词 ${info.keywords.length} 个）`);
      return ok({ runId: started.runId });
    },

    // ------------------------------------------------------------ 对话框 / shell / 窗口
    'dialog:pick-repo': async () => {
      const win = getWindow();
      const r = await dialog.showOpenDialog(win, {
        title: '选择代码仓库目录',
        properties: ['openDirectory'],
      });
      return ok({ path: r.canceled || !r.filePaths.length ? null : r.filePaths[0] });
    },

    'dialog:pick-assets': async () => {
      const r = await dialog.showOpenDialog(getWindow(), {title:'选择素材图片文件夹',properties:['openDirectory']});
      if (r.canceled || !r.filePaths.length) return ok({path:null});
      const items = require('../src/core/local-assets').listLocalAssets({dir:r.filePaths[0]});
      return ok({path:r.filePaths[0],available:items.length});
    },

    'dialog:pick-profile': async () => {
      const r = await dialog.showOpenDialog(getWindow(), {title:'选择系统功能档案',properties:['openFile'],filters:[{name:'系统功能档案',extensions:['md','txt']}]});
      if (r.canceled || !r.filePaths.length) return ok({path:null});
      const filePath = r.filePaths[0];
      const info = require('../src/core/product-profile').readProductProfile({filePath});
      return ok({path:filePath,fileName:info.fileName,originalChars:info.originalChars});
    },

    'dialog:pick-cover': async () => {
      const win = getWindow();
      const r = await dialog.showOpenDialog(win, {
        title: '选择封面图',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['jpg', 'png'] }],
      });
      return ok({ path: r.canceled || !r.filePaths.length ? null : r.filePaths[0] });
    },

    // v2：样文文件多选（.txt/.md/.html，兼容公众号导出），配合 style:samples:import {paths}
    'dialog:pick-samples': async () => {
      const win = getWindow();
      const r = await dialog.showOpenDialog(win, {
        title: '选择样文文件（.txt / .md / .html）',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '样文', extensions: ['txt', 'md', 'html', 'htm'] }],
      });
      return ok({ paths: r.canceled ? [] : r.filePaths });
    },

    // v2：样文文件夹选择（单层扫描），配合 style:samples:import {dirPath}
    'dialog:pick-sample-folder': async () => {
      const win = getWindow();
      const r = await dialog.showOpenDialog(win, {
        title: '选择样文文件夹',
        properties: ['openDirectory'],
      });
      return ok({ path: r.canceled || !r.filePaths.length ? null : r.filePaths[0] });
    },

    'shell:open-path': async (p) => {
      const target = path.resolve(String((p && p.path) || ''));
      const cfg = store.loadFullConfig();
      const bases = [path.resolve(store.paths.dataDir)];
      if (cfg.content && cfg.content.repoPath) bases.push(path.resolve(cfg.content.repoPath));
      const allowed = bases.some((base) => target === base || target.startsWith(base + path.sep));
      if (!allowed) {
        return fail('E_IO', '路径不在允许范围内（仅可打开应用数据目录或所配置仓库目录内的位置）');
      }
      const errMsg = await shell.openPath(target);
      if (errMsg) return fail('E_IO', `打开目录失败：${errMsg}`);
      return ok({});
    },

    'shell:open-external': async (p) => {
      const url = String((p && p.url) || '');
      let u;
      try {
        u = new URL(url);
      } catch (e) {
        return fail('E_INVALID_INPUT', `不是有效的 URL：${url || '（空）'}`);
      }
      const verdict = isExternalUrlAllowed(u);
      if (!verdict.allowed) {
        return fail('E_INVALID_INPUT', `${verdict.reason}（只支持在系统浏览器打开 https 公网链接）`);
      }
      logger.info(`打开外部链接：${u.origin}${u.pathname.slice(0, 80)}`);
      await shell.openExternal(url);
      return ok({});
    },

    'win:minimize': () => {
      const w = getWindow();
      if (w) w.minimize();
      return ok({});
    },

    'win:toggle-max': () => {
      const w = getWindow();
      if (w) {
        if (w.isMaximized()) w.unmaximize();
        else w.maximize();
      }
      return ok({});
    },

    'win:close': () => {
      const w = getWindow();
      if (!w) return ok({});
      const cfg = store.loadFullConfig();
      if (cfg.app.closeToTray) {
        w.hide(); // 契约 §2：点关闭 = 隐藏到托盘（设置里可改为退出）
        logger.info('窗口已隐藏到托盘（可在设置中改为直接退出）');
      } else {
        w.close(); // closeToTray=false → 真关闭 → window-all-closed → 退出
      }
      return ok({});
    },
  };

  /** IPC 失败统一留痕：错误只看几秒的 toast 没法排查，日志里必须按通道 + 错误码各留一条。 */
  function logIpc(channel, res) {
    // compose 通道的结束态：渲染层 #composeProgress 依赖该事件（此前只有 radar 会推）
    if (channel.startsWith('compose:')) {
      try {
        sendEvent('task:progress', {
          kind: 'compose',
          stage: 0,
          state: res && res.ok ? 'done' : 'fail',
          detail: res && res.ok ? '' : logger.scrub((res && res.error && res.error.message) || ''),
        });
      } catch (e) { /* 事件失败不影响结果 */ }
    }
    if (res && res.ok === false && res.error) {
      const code = String(res.error.code || '');
      // 真正的失败写 ERROR（日志页「错误」筛选才能捞到）；用户输入类错误降为 WARN；
      // radar:get 的「今天还没有清单」是正常空态（渲染层不展示错误），不写「IPC 失败」。
      if (channel === 'radar:get' && code === 'E_NOT_FOUND') return res;
      const line = logger.scrub(`IPC 失败：${channel} ${code} ${res.error.message || ''}`);
      if (code === 'E_INVALID_INPUT' || code === 'E_BUSY') logger.warn(line);
      else logger.error(line);
    }
    return res;
  }

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, payload) => {
      try {
        return Promise.resolve(fn(payload || {}))
          .then((res) => logIpc(channel, res))
          .catch((e) => logIpc(channel, toError(e, 'E_IO')));
      } catch (e) {
        return logIpc(channel, toError(e, 'E_IO'));
      }
    });
  }
  logger.info(`IPC 就绪：已注册 ${Object.keys(handlers).length} 个通道`);
  return Object.keys(handlers);
}

module.exports = { registerIpcHandlers, missingRunConfig, missingAutoConfig };
