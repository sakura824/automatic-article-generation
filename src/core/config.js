'use strict';
/**
 * config.js —— Config 结构、默认值、加载、校验、脱敏导入导出。
 * 键名与设计稿控件一一对应；仅 Node 内置模块。
 * secrets 的加密落盘（store.js 的 safeStorage/DPAPI）由主进程负责：
 * config.json 里可存在顶层 `secrets` 区块，loadConfig 原样保留、exportRedacted 一律剔除。
 */
const fs = require('node:fs');
const path = require('node:path');

/** LLM 服务商预设（设计稿 pchip chips），OpenAI 兼容 /chat/completions。 */
const PRESETS = {
  bigmodel: 'https://open.bigmodel.cn/api/paas/v4',
  deepseek: 'https://api.deepseek.com',
};

// 产品已是通用创作工作台，AI 标识文案不再假设「仓库提交」来源
const DEFAULT_AI_TEXT = '本文由 AI 生成，经人工审阅修改';
// 读者画像默认留空：由用户按自己的垂类填写
const DEFAULT_AUDIENCE = '';
/** 敏感话题关键词默认预设：默认留空，不内置任何领域词表；用户可在 aggregate.sensitiveKeywords 按自己的领域自行配置。 */
const DEFAULT_SENSITIVE_KEYWORDS = [];
/** 聚合搜索 API 适配层可配的服务商。
 * 两类：native（厂商自带搜索，可复用大模型 Key）= deepseek / bigmodel；
 *      独立搜索服务（与用什么大模型无关，需单独 Key）= bocha / tavily / serpapi。 */
const SEARCH_PROVIDERS = ['bocha', 'deepseek', 'bigmodel', 'tavily', 'serpapi'];

/** 定时任务的执行路径（v2.2 / v2.4 增量）：
 * auto = 仓库自动（读 git 增量写推文，v1 语义，默认值保证旧配置不变）；
 * pool = 内容池（每天从 DATA/content-pool.json 取一条题目自动成文并上传草稿箱）；
 * radar = 选题雷达自动（按聚合配置搜索全网 → 自动选排名最前的选题 → 成文 → 上传草稿箱）。 */
const SCHEDULE_MODES = ['auto', 'pool', 'radar'];

function defaultConfig() {
  return {
    wechat: { appId: '', appSecret: '' },
    llm: { baseUrl: PRESETS.bigmodel, apiKey: '', model: 'glm-4.6', temperature: 0.7 },
    content: {
      repoPath: '',
      coverPath: '',
      author: '',
      audience: DEFAULT_AUDIENCE,
      styleExtra: '',
      aiDisclosure: { enabled: true, text: DEFAULT_AI_TEXT },
      // v2.1：素材成文页的本地草稿（可保存、复用）；渲染层经 config:set 持久化
      material: '',
      emphasis: '',
    },
    // v2.1：项目背景
    project: {
      description: '', // 系统是什么、解决什么问题、给谁看
      techTerms: '',   // 技术栈与常用术语表（AI 用词与系统保持一致）
      audience: '',    // 受众画像
      styleExtra: '',  // 风格补充指令
    },
    // v2.1：文风画像；profile 由 style.js normalizeProfile 固定形状，可编辑
    style: {
      profile: null,
      enabled: false,
    },
    // v2.1：聚合来源配置；searchApiKey 为密钥（store 加密落盘）
    aggregate: {
      articleMode: '', // Legacy configs fall back to includeCode.
      profilePath: '',
      imagesEnabled: false,
      imagesDir: '',
      includeCode: false,
      repoPath: '',
      productName: '',
      promotion: '',
      keywords: [],              // 检索关键词
      whitelist: [],             // 来源白名单（域名，如 people.com.cn）；非空时仅保留命中来源
      searchProvider: 'bocha',   // bocha | deepseek | tavily | serpapi（deepseek 复用大模型 Key）
      searchApiKey: '',          // 密钥：随 wechat.appSecret / llm.apiKey 同一套加密机制
      dailyLimit: 10,            // 每日清单数量上限
      autoPickCount: 1,          // 选题雷达全自动：自动选用排名前 N 条（1~3）
      autoSkipSensitive: true,   // 选题雷达全自动：跳过需人工确认的敏感话题
      autoRewriteAttempts: 5,    // 选题雷达全自动：相似度超阈值时的自动重写次数（1~10）
      autoForceUpload: true,     // 选题雷达全自动：重写用尽仍超标时照常上传（similarity.json 留痕）
      similarityThreshold: 0.3,  // n-gram 相似度自检阈值（§5.1），超出即重写并提示
      verticalNotice: { enabled: false, text: '' }, // 文末领域提示，默认关闭（聚合模式可条件注入）
      sensitiveKeywords: DEFAULT_SENSITIVE_KEYWORDS.slice(), // 敏感话题关键词（命中需人工确认，可覆盖）
    },
    app: {
      // 仓库自动（C 模式）是可选项——「开关默认关闭，想挂机再用」。
      // 时间默认仍是设计稿的 09:30，用户开启后即按该时间执行。
      // mode（v2.2 / v2.4）：auto=仓库自动（默认，旧配置零改动）；pool=内容池取题自动成文；
      // radar=选题雷达自动（搜索→自动选前 N 条→成文→上传草稿箱）。
      schedule: { enabled: false, time: '09:30', mode: 'auto' },
      autoLaunch: false,
      closeToTray: true,
      notify: true,
    },
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：patch 中的值覆盖 base；对象递归，其余整体替换。 */
function deepMerge(base, patch) {
  const out = { ...base };
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function ioError(message) {
  const e = new Error(message);
  e.code = 'E_IO';
  return e;
}

/**
 * 读取并合并 DATA/config.json（不存在 → 纯默认值；损坏 → E_IO）。
 * secrets 解密注入由主进程 store.js 在拿到返回值后进行，本函数不做加解密。
 */
function loadConfig(dataDir) {
  const p = path.join(dataDir, 'config.json');
  if (!fs.existsSync(p)) return defaultConfig();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw ioError(`读取 config.json 失败：${e.message}`);
  }
  if (!String(raw).trim()) return defaultConfig();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw ioError(`config.json 已损坏，无法解析：${e.message}（可修复该文件，或删除后重新配置）`);
  }
  return deepMerge(defaultConfig(), data);
}

/** 密钥脱敏：只显示末 4 位，如 ••••abcd；空值保持空。 */
function redactSecret(s) {
  const str = String(s || '');
  return str ? `••••${str.slice(-4)}` : '';
}

/** 深拷贝并脱敏：wechat.appSecret / llm.apiKey / aggregate.searchApiKey 只留末 4 位；顶层 secrets（加密块）剔除。 */
function redactConfig(cfg) {
  const clone = JSON.parse(JSON.stringify(cfg || {}));
  if (clone.wechat) clone.wechat.appSecret = redactSecret(clone.wechat.appSecret);
  if (clone.llm) clone.llm.apiKey = redactSecret(clone.llm.apiKey);
  if (clone.aggregate) clone.aggregate.searchApiKey = redactSecret(clone.aggregate.searchApiKey);
  delete clone.secrets;
  return clone;
}

/** 脱敏导出为 JSON 文本（主进程弹保存框后直接写入）。 */
function exportRedacted(cfg) {
  return JSON.stringify(redactConfig(cfg), null, 2);
}

/**
 * 导入脱敏配置：JSON 文本或对象 → 深合并到默认值。
 * 脱敏占位（••••xxxx）不是有效密钥，一律清空——导入后需重填。
 */
function importRedacted(json) {
  let data = json;
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json);
    } catch (e) {
      throw ioError(`导入的配置不是有效 JSON：${e.message}`);
    }
  }
  const cfg = deepMerge(defaultConfig(), data || {});
  if (typeof cfg.wechat.appSecret === 'string' && cfg.wechat.appSecret.startsWith('••••')) {
    cfg.wechat.appSecret = '';
  }
  if (typeof cfg.llm.apiKey === 'string' && cfg.llm.apiKey.startsWith('••••')) {
    cfg.llm.apiKey = '';
  }
  if (cfg.aggregate && typeof cfg.aggregate.searchApiKey === 'string' && cfg.aggregate.searchApiKey.startsWith('••••')) {
    cfg.aggregate.searchApiKey = '';
  }
  return cfg;
}

/**
 * 项目上下文：
 * project.* 为主；audience/styleExtra 兼容设置页「内容与文风」里的 content.audience/styleExtra
 * （v1 输入框），保证用户在那里填的受众/风格对 v2 素材/对话/聚合模式同样生效。
 */
function projectContext(cfg) {
  const p = (cfg && cfg.project) || {};
  const c = (cfg && cfg.content) || {};
  const styleExtra = [p.styleExtra, c.styleExtra]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join('\n');
  return {
    description: String(p.description || '').trim(),
    techTerms: String(p.techTerms || '').trim(),
    audience: String(p.audience || '').trim() || String(c.audience || '').trim(),
    styleExtra,
  };
}

/** 项目背景块（提示词注入用），无内容返回空串。 */
function buildProjectBlock(project) {
  const p = project || {};
  const lines = [];
  if (p.description) lines.push(`- 系统简介：${p.description}`);
  if (p.techTerms) lines.push(`- 术语表：${p.techTerms}`);
  if (p.audience) lines.push(`- 受众：${p.audience}`);
  if (p.styleExtra) lines.push(`- 风格补充：${p.styleExtra}`);
  return lines.length ? `【项目背景】\n${lines.join('\n')}` : '';
}

/**
 * 校验配置 → {ok, errors:[{field,message}]}。
 * 文案遵循 具体 + 可操作，禁用“操作失败”。
 * v2 增量字段（project/style/aggregate/content.material 等）只在「存在且非法」时报错，
 * 默认值/旧 v1 配置文件（缺这些键）不受影响——config:set 的 touched 过滤也依赖这一点。
 */
function validateConfig(cfg) {
  const errors = [];
  const c = cfg || {};
  const w = c.wechat || {};
  const l = c.llm || {};
  const ct = c.content || {};
  const app = c.app || {};

  const appId = String(w.appId || '').trim();
  const appSecret = String(w.appSecret || '').trim();
  if (!appId) errors.push({ field: 'wechat.appId', message: 'AppID 未填写：到公众平台「设置与开发 → 基本配置」获取后填入' });
  if (!appSecret) errors.push({ field: 'wechat.appSecret', message: 'AppSecret 未填写或未保存：到公众平台「基本配置」重新获取后填入' });

  const baseUrl = String(l.baseUrl || '').trim();
  if (!baseUrl) {
    errors.push({ field: 'llm.baseUrl', message: 'Base URL 未填写：可选预设 bigmodel / deepseek，或填完整服务地址' });
  } else if (!/^https?:\/\//i.test(baseUrl)) {
    errors.push({ field: 'llm.baseUrl', message: 'Base URL 需要以 http(s):// 开头的完整地址，例如 https://open.bigmodel.cn/api/paas/v4' });
  }
  if (!String(l.apiKey || '').trim()) {
    errors.push({ field: 'llm.apiKey', message: 'API Key 未填写：到所配置的大模型服务商后台创建后填入' });
  }
  if (!String(l.model || '').trim()) {
    errors.push({ field: 'llm.model', message: '模型名未填写：例如 glm-4.6 或 deepseek-chat' });
  }
  const temp = l.temperature;
  if (temp !== undefined && temp !== null && (typeof temp !== 'number' || !(temp >= 0 && temp <= 2))) {
    errors.push({ field: 'llm.temperature', message: '创作温度需为 0~2 之间的数字' });
  }

  // 仓库路径可选：
  // 空值不报错；填了就校验目录存在，避免选中后被移动/删除的路径静默失效。
  const repoPath = String(ct.repoPath || '').trim();
  if (repoPath && !fs.existsSync(repoPath)) {
    errors.push({ field: 'content.repoPath', message: `仓库路径不存在：${repoPath}（目录可能被移动或删除，请重新选择）` });
  }

  const time = app.schedule && app.schedule.time;
  if (time !== undefined && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(time).trim())) {
    errors.push({ field: 'app.schedule.time', message: '定时时间格式应为 HH:MM，例如 09:30' });
  }
  const schedMode = app.schedule && app.schedule.mode;
  if (schedMode !== undefined && schedMode !== null && !SCHEDULE_MODES.includes(schedMode)) {
    errors.push({
      field: 'app.schedule.mode',
      message: `定时任务类型应为 ${SCHEDULE_MODES.join(' / ')} 之一（auto=仓库自动，pool=内容池，radar=选题雷达自动），收到：${schedMode}`,
    });
  }

  // ---------------- v2.1 增量校验（仅在字段存在且非法时报错） ----------------
  const strLen = (v) => Array.from(String(v == null ? '' : v)).length;

  for (const key of ['material', 'emphasis']) {
    const v = ct[key];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      errors.push({ field: `content.${key}`, message: `content.${key} 应为字符串` });
    }
  }

  const proj = c.project || {};
  const PROJECT_LIMITS = { description: 4000, techTerms: 4000, audience: 1000, styleExtra: 2000 };
  for (const [key, max] of Object.entries(PROJECT_LIMITS)) {
    const v = proj[key];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      errors.push({ field: `project.${key}`, message: `project.${key} 应为字符串` });
    } else if (typeof v === 'string' && strLen(v) > max) {
      errors.push({ field: `project.${key}`, message: `project.${key} 超长（最多 ${max} 字，当前 ${strLen(v)} 字）` });
    }
  }

  const st = c.style || {};
  if (st.enabled !== undefined && st.enabled !== null && typeof st.enabled !== 'boolean') {
    errors.push({ field: 'style.enabled', message: 'style.enabled 应为布尔值（是否启用文风画像）' });
  }
  if (st.profile !== undefined && st.profile !== null && !isPlainObject(st.profile)) {
    errors.push({ field: 'style.profile', message: 'style.profile 应为对象（文风画像）或 null' });
  }

  const ag = c.aggregate || {};
  if (ag.searchProvider !== undefined && ag.searchProvider !== null && !SEARCH_PROVIDERS.includes(ag.searchProvider)) {
    errors.push({
      field: 'aggregate.searchProvider',
      message: `聚合搜索服务商应为 ${SEARCH_PROVIDERS.join(' / ')} 之一，收到：${ag.searchProvider}`,
    });
  }
  if (ag.searchApiKey !== undefined && ag.searchApiKey !== null && typeof ag.searchApiKey !== 'string') {
    errors.push({ field: 'aggregate.searchApiKey', message: 'aggregate.searchApiKey 应为字符串' });
  }
  const daily = ag.dailyLimit;
  if (daily !== undefined && daily !== null && (typeof daily !== 'number' || !Number.isInteger(daily) || daily < 1 || daily > 50)) {
    errors.push({ field: 'aggregate.dailyLimit', message: '每日清单数量应为 1~50 之间的整数' });
  }
  // v2.4：选题雷达全自动的选题策略
  const pickCount = ag.autoPickCount;
  if (pickCount !== undefined && pickCount !== null && (typeof pickCount !== 'number' || !Number.isInteger(pickCount) || pickCount < 1 || pickCount > 3)) {
    errors.push({ field: 'aggregate.autoPickCount', message: '自动选用条数应为 1~3 之间的整数' });
  }
  if (ag.autoSkipSensitive !== undefined && ag.autoSkipSensitive !== null && typeof ag.autoSkipSensitive !== 'boolean') {
    errors.push({ field: 'aggregate.autoSkipSensitive', message: '自动跳过敏感话题开关应为布尔值' });
  }
  const rewrites = ag.autoRewriteAttempts;
  if (rewrites !== undefined && rewrites !== null && (typeof rewrites !== 'number' || !Number.isInteger(rewrites) || rewrites < 1 || rewrites > 10)) {
    errors.push({ field: 'aggregate.autoRewriteAttempts', message: '自动重写次数应为 1~10 之间的整数' });
  }
  if (ag.autoForceUpload !== undefined && ag.autoForceUpload !== null && typeof ag.autoForceUpload !== 'boolean') {
    errors.push({ field: 'aggregate.autoForceUpload', message: '相似度超标强制上传开关应为布尔值' });
  }
  const thr = ag.similarityThreshold;
  if (thr !== undefined && thr !== null && (typeof thr !== 'number' || !(thr > 0 && thr < 1))) {
    errors.push({ field: 'aggregate.similarityThreshold', message: '相似度阈值应为 0~1 之间的小数（如 0.3）' });
  }
  // v2 开源版：文末领域提示（verticalNotice）与敏感话题关键词（sensitiveKeywords）
  const vn = ag.verticalNotice;
  if (vn !== undefined && vn !== null) {
    if (!isPlainObject(vn)) {
      errors.push({ field: 'aggregate.verticalNotice', message: 'aggregate.verticalNotice 应为对象（{enabled, text}）' });
    } else {
      if (vn.enabled !== undefined && vn.enabled !== null && typeof vn.enabled !== 'boolean') {
        errors.push({ field: 'aggregate.verticalNotice.enabled', message: 'aggregate.verticalNotice.enabled 应为布尔值' });
      }
      if (vn.text !== undefined && vn.text !== null && typeof vn.text !== 'string') {
        errors.push({ field: 'aggregate.verticalNotice.text', message: 'aggregate.verticalNotice.text 应为字符串' });
      } else if (typeof vn.text === 'string' && strLen(vn.text) > 200) {
        errors.push({ field: 'aggregate.verticalNotice.text', message: `aggregate.verticalNotice.text 超长（最多 200 字，当前 ${strLen(vn.text)} 字）` });
      }
    }
  }
  const sk = ag.sensitiveKeywords;
  if (sk !== undefined && sk !== null) {
    if (!Array.isArray(sk)) {
      errors.push({ field: 'aggregate.sensitiveKeywords', message: 'aggregate.sensitiveKeywords 应为字符串数组' });
    } else if (sk.length > 100) {
      errors.push({ field: 'aggregate.sensitiveKeywords', message: 'aggregate.sensitiveKeywords 数量过多（上限 100 条）' });
    } else {
      const bad = sk.find((it) => typeof it !== 'string' || !strLen(it.trim()) || strLen(it) > 50);
      if (bad !== undefined) {
        errors.push({ field: 'aggregate.sensitiveKeywords', message: 'aggregate.sensitiveKeywords 每条应为 1~50 字的字符串' });
      }
    }
  }
  if (ag.imagesEnabled !== undefined && typeof ag.imagesEnabled !== 'boolean') errors.push({field:'aggregate.imagesEnabled',message:'素材配图开关应为布尔值'});
  if (ag.imagesDir !== undefined && (typeof ag.imagesDir !== 'string' || ag.imagesDir.length>1000)) errors.push({field:'aggregate.imagesDir',message:'素材文件夹路径无效'});
  if (ag.articleMode && !['web','web-profile','web-code'].includes(ag.articleMode)) errors.push({field:'aggregate.articleMode',message:'文章方式无效'});
  if (ag.profilePath !== undefined && (typeof ag.profilePath !== 'string' || ag.profilePath.length > 1000)) errors.push({field:'aggregate.profilePath',message:'档案路径应为不超过 1000 字的文本'});
  if (ag.includeCode !== undefined && typeof ag.includeCode !== 'boolean') errors.push({field:'aggregate.includeCode',message:'结合代码库开关应为布尔值'});
  for (const [key, limit] of [['repoPath',1000],['productName',60],['promotion',1000]]) {
    if (ag[key] !== undefined && (typeof ag[key] !== 'string' || ag[key].length > limit)) errors.push({field:`aggregate.${key}`,message:`${key} 应为不超过 ${limit} 字的文本`});
  }
  for (const key of ['keywords', 'whitelist']) {
    const v = ag[key];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) {
      errors.push({ field: `aggregate.${key}`, message: `aggregate.${key} 应为字符串数组` });
      continue;
    }
    if (v.length > (key === 'keywords' ? 50 : 100)) {
      errors.push({ field: `aggregate.${key}`, message: `aggregate.${key} 数量过多（上限 ${key === 'keywords' ? 50 : 100} 条）` });
      continue;
    }
    const bad = v.find((it) => typeof it !== 'string' || !strLen(it.trim()) || strLen(it) > 200);
    if (bad !== undefined) {
      errors.push({ field: `aggregate.${key}`, message: `aggregate.${key} 每条应为 1~200 字的字符串` });
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  PRESETS,
  DEFAULT_AI_TEXT,
  DEFAULT_AUDIENCE,
  DEFAULT_SENSITIVE_KEYWORDS,
  SEARCH_PROVIDERS,
  SCHEDULE_MODES,
  defaultConfig,
  deepMerge,
  loadConfig,
  projectContext,
  buildProjectBlock,
  validateConfig,
  redactSecret,
  redactConfig,
  exportRedacted,
  importRedacted,
};
