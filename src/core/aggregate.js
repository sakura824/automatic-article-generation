'use strict';
/**
 * aggregate.js —— 全网聚合成文模块。
 *
 * 职责：
 * - 搜索 API 适配层（博查 bocha / Tavily / SerpAPI 可配，transport 可注入，searchWeb）；
 * - 网页正文提取（extractArticleText）与抓取（fetchArticle，失败抛 E_NET，由调用方降级，不伪造素材）；
 * - 来源分级（gradeSource：L1 指南与官方机构 / L2 学术 / L3 科普）与白名单过滤；
 * - 去重（normalizeUrl + 标题 n-gram 近似去重）与排序（权威度优先 + 热度）；
 * - 选题雷达（runTopicRadar：多关键词搜索 → 清单落盘 dataDir/radar/radar-<date>.json）；
 * - 综合成文（composeFromTopics：只提取事实与共识的提示词约定 + n-gram 相似度自检，
 *   超阈值自动重写并返回重写信号；素材来源清单落盘 sources.json，内部可见不随文发布）；
 * - 敏感话题闸与可选领域提示（敏感话题 isSensitiveTopic 需人工确认才生成；领域提示经 verticalNotice 条件注入）。
 *
 * 依赖注入：搜索/抓取走 deps.fetch（测试零真实网络）；LLM 走 llm.callLlmMessages
 * （mock 模式由 llm.js 按 mockKind='aggregate' 短路）。仅 Node 内置模块。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson } = require('./persist');
const { stripIllustrations, illustrationTextOf } = require('./illustration');
const { callLlmMessages, parseLlmOutput, LlmFormatError } = require('./llm');
const { buildPreviewHtml, countWords, sanitizeHtml } = require('./article');
const { DEFAULT_SENSITIVE_KEYWORDS, projectContext, buildProjectBlock } = require('./config');
const { recordRun, saveStateMerged } = require('./state');
const { dayKey } = require('./scheduler');
const { isMock, mockSearchResults, mockFetchArticle } = require('./mock');

/** 搜索/抓取单次请求超时与重试（与 llm.js 同口径：首次 + 重试 2 次）。 */
const SEARCH_TIMEOUT_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const RETRY_ATTEMPTS = 3;
/** 单条来源材料进入提示词的最大字符数（码点）。 */
const MAX_SOURCE_CHARS = 6000;
/** 选题清单摘要长度（码点）。 */
const MAX_SUMMARY_CHARS = 80;
/** 相似度 n-gram 长度（字符）。 */
const SIMILARITY_N = 2;
/** 自动重写次数上限（首次 + 重写 2 次）。 */
const REWRITE_ATTEMPTS = 2;
/** 标题近似去重阈值（字符二元组包含率）。 */
const TITLE_DUP_THRESHOLD = 0.8;
/** 一次成文允许勾选的选题数上限。 */
const MAX_TOPICS_PER_BATCH = 3;
/** 敏感话题关键词：默认预设见 config.DEFAULT_SENSITIVE_KEYWORDS，可经 aggregate.sensitiveKeywords 覆盖。 */
const SENSITIVE_KEYWORDS = DEFAULT_SENSITIVE_KEYWORDS;

function inputError(message) {
  const e = new Error(message);
  e.code = 'E_INVALID_INPUT';
  return e;
}

function netError(message) {
  const e = new Error(message);
  e.code = 'E_NET';
  return e;
}

function snippet(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function cpSlice(s, n) {
  return Array.from(s).slice(0, n).join('');
}

function isoNow(now) {
  return (now ? new Date(now) : new Date()).toISOString();
}

/* ============================ 搜索 API 适配层 ============================ */

/**
 * 搜索服务商适配层。
 *
 * 下拉里混着两类通道，语义不同，改之前必须分清：
 *   - native=true：**模型厂商自带**的搜索（DeepSeek / 智谱）。域名与厂商绑定，
 *     **绝不跟随 cfg.llm.baseUrl**——跟随的后果是「换模型后被拼成别人域名下的 /tools/search」
 *     这种不存在的地址，表现为 404 且看不出原因（v2.2 真实踩坑）。
 *     这类通道允许复用同一把大模型 Key，但前提是大模型也是这家（见 aggregateConfigOf）。
 *   - native=false：**独立搜索服务**（博查 / Tavily / SerpAPI）。与用什么大模型完全无关，
 *     换模型不受影响，代价是要单独注册一次拿 Key，但只需配一次、之后换任何模型都不用动。
 *
 * 搜索不是大模型的通用能力：目前只有 DeepSeek、智谱开放了等价的公开搜索 API，
 * 其余厂商（Moonshot / Qwen / OpenAI 等）没有可调接口，选它们时只能用独立搜索服务。
 *
 * parseResponse 一律输出归一化条目 {title, url, snippet, publishedAt, rawRank}；
 * 响应缺关键数组 → E_NET（格式异常，错误信息带服务商名以便定位）。
 */
/** 搜索 API 的业务错误体（各家常是 {error:{code,message}} 或 {error:"..."}）→ 可读字符串；无错误返回 ''。
 * 没有这层会出现「返回格式异常（缺少 results）」这种误导性报错，把鉴权/欠费错误盖掉。 */
function apiErrorOf(data) {
  if (!data || typeof data !== 'object') return '';
  const e = data.error;
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (typeof e === 'object') return e.message || e.msg || e.code || JSON.stringify(e).slice(0, 200);
  return '';
}

const ADAPTERS = {
  bocha: {
    label: '博查',
    host: 'api.bochaai.com',
    native: false,
    buildRequest({ apiKey, query, count }) {
      return {
        url: 'https://api.bochaai.com/v1/web-search',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, count, summary: true, freshness: 'oneWeek' }),
        },
      };
    },
    parseResponse(text) {
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw netError(`搜索返回内容不是 JSON：${snippet(text)}`);
      }
      const pages = data && data.data && data.data.webPages && data.data.webPages.value;
      if (!Array.isArray(pages)) throw netError(`博查搜索返回格式异常（缺少 data.webPages.value）：${snippet(text)}`);
      return pages
        .map((r, i) =>
          normalizeItem({ title: r && r.name, url: r && r.url, snippet: (r && r.summary) || (r && r.snippet), publishedAt: r && r.dateLastCrawled, rawRank: i })
        )
        .filter(Boolean);
    },
  },
  tavily: {
    label: 'Tavily',
    host: 'api.tavily.com',
    native: false,
    buildRequest({ apiKey, query, count }) {
      return {
        url: 'https://api.tavily.com/search',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, max_results: count, search_depth: 'basic', include_answer: false }),
        },
      };
    },
    parseResponse(text) {
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw netError(`搜索返回内容不是 JSON：${snippet(text)}`);
      }
      if (!Array.isArray(data && data.results)) throw netError(`Tavily 搜索返回格式异常（缺少 results）：${snippet(text)}`);
      return data.results
        .map((r, i) =>
          normalizeItem({ title: r && r.title, url: r && r.url, snippet: r && r.content, publishedAt: r && r.published_date, rawRank: i })
        )
        .filter(Boolean);
    },
  },
  deepseek: {
    label: 'DeepSeek',
    host: 'api.deepseek.com',
    native: true,
    /**
     * DeepSeek 自研搜索（2026-10-17 开放）：与 chat/completions 同一套 Bearer 鉴权，
     * 所以大模型也用 DeepSeek 时可以复用同一把 Key，不必再注册第三方搜索。
     * 单价 5 元 / 1000 次成功请求，官方对 SEO 作弊与低质 AIGC 做了过滤。
     * 域名写死 —— 搜索是独立服务，不能跟着用户配的大模型 baseUrl 走（换模型会拼出 404）。
     */
    buildRequest({ apiKey, query, count }) {
      return {
        url: 'https://api.deepseek.com/v1/tools/search',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query, count }),
        },
      };
    },
    parseResponse(text) {
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw netError(`搜索返回内容不是 JSON：${snippet(text)}`);
      }
      const apiErr = apiErrorOf(data);
      if (apiErr) throw netError(`DeepSeek 搜索失败：${apiErr}`);
      if (!Array.isArray(data && data.results)) {
        throw netError(`DeepSeek 搜索返回格式异常（缺少 results）：${snippet(text)}`);
      }
      return data.results
        .map((r, i) =>
          normalizeItem({
            title: r && r.title,
            url: r && r.url,
            snippet: (r && r.snippet) || (r && r.summary) || (r && r.content),
            publishedAt: r && r.date,
            rawRank: i,
          })
        )
        .filter(Boolean);
    },
  },
  bigmodel: {
    label: '智谱 GLM',
    host: 'open.bigmodel.cn',
    native: true,
    /**
     * 智谱 Web Search API：POST /paas/v4/web_search，与大模型同一把 Key（Bearer）。
     * 字段名与 OpenAI 风格不同：入参 search_query / search_engine / count，
     * 出参 search_result[{title, link, content, media, publish_date}]。
     * search_std 约 0.01 元/次（search_pro 0.03 元/次），这里用便宜的 std。
     */
    buildRequest({ apiKey, query, count }) {
      return {
        url: 'https://open.bigmodel.cn/api/paas/v4/web_search',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ search_query: query, search_engine: 'search_std', count }),
        },
      };
    },
    parseResponse(text) {
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw netError(`搜索返回内容不是 JSON：${snippet(text)}`);
      }
      const apiErr = apiErrorOf(data);
      if (apiErr) throw netError(`智谱搜索失败：${apiErr}`);
      if (!Array.isArray(data && data.search_result)) {
        throw netError(`智谱搜索返回格式异常（缺少 search_result）：${snippet(text)}`);
      }
      return data.search_result
        .map((r, i) =>
          normalizeItem({
            title: r && r.title,
            url: r && r.link,
            snippet: r && r.content,
            publishedAt: r && r.publish_date,
            rawRank: i,
          })
        )
        .filter(Boolean);
    },
  },
  serpapi: {
    label: 'SerpAPI',
    host: 'serpapi.com',
    native: false,
    buildRequest({ apiKey, query, count }) {
      const u = new URL('https://serpapi.com/search.json');
      u.searchParams.set('engine', 'google');
      u.searchParams.set('q', query);
      u.searchParams.set('num', String(count));
      u.searchParams.set('api_key', apiKey);
      return { url: u.toString(), init: { method: 'GET' } };
    },
    parseResponse(text) {
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw netError(`搜索返回内容不是 JSON：${snippet(text)}`);
      }
      if (!Array.isArray(data && data.organic_results)) {
        throw netError(`SerpAPI 搜索返回格式异常（缺少 organic_results）：${snippet(text)}`);
      }
      return data.organic_results
        .map((r, i) =>
          normalizeItem({ title: r && r.title, url: r && (r.link || r.url), snippet: r && r.snippet, publishedAt: r && r.date, rawRank: i })
        )
        .filter(Boolean);
    },
  },
};

/** 归一化搜索条目；title/url 缺失的条目被丢弃。 */
function normalizeItem({ title, url, snippet: snip, publishedAt, rawRank }) {
  const t = String(title || '').trim();
  const u = String(url || '').trim();
  if (!t || !u || !/^https?:\/\//i.test(u)) return null;
  let pub = null;
  if (publishedAt) {
    const d = new Date(publishedAt);
    if (!Number.isNaN(d.getTime())) pub = d.toISOString();
  }
  return { title: t, url: u, snippet: String(snip || '').replace(/\s+/g, ' ').trim(), publishedAt: pub, rawRank: rawRank || 0 };
}

/**
 * 带重试的 HTTP 请求（与 llm.js 同语义：网络错误/5xx/429 重试，共 RETRY_ATTEMPTS 次）。
 * 最终失败抛 E_NET（HTTP 状态或网络原因写入消息）。
 */
async function httpWithRetry(url, init, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  if (typeof doFetch !== 'function') throw netError('当前环境没有可用的 fetch 实现');
  const timeoutMs = deps.timeoutMs || SEARCH_TIMEOUT_MS;
  const delayMs = deps.retryDelayMs == null ? 1000 : deps.retryDelayMs;
  let lastHttp = null;
  let lastNetErr = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), timeoutMs);
    try {
      const res = await doFetch(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      if (res.ok) return text;
      lastHttp = { status: res.status, text };
      if (!(res.status >= 500 || res.status === 429)) break;
    } catch (e) {
      lastNetErr = e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < RETRY_ATTEMPTS && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  if (lastHttp) throw netError(`搜索 API 调用失败 HTTP ${lastHttp.status}：${snippet(lastHttp.text)}`);
  throw netError(`网络请求失败：${lastNetErr ? lastNetErr.message : '未知错误'}（已重试 ${RETRY_ATTEMPTS - 1} 次仍失败，请检查网络与搜索 API 配置）`);
}

/**
 * 搜索 → 归一化条目数组。
 * mock 模式（WECHAT_DAILY_MOCK=1）在入口短路到 mock.js 的确定性结果，不发请求。
 * 校验：provider 未知 / Key 为空 / query 为空 / count 非法 → E_INVALID_INPUT。
 */
async function searchWeb({ provider, apiKey, query, count = 10 }, deps = {}) {
  if (isMock()) return mockSearchResults();
  const adapter = ADAPTERS[String(provider || '').trim()];
  if (!adapter) {
    throw inputError(`搜索服务商应为 ${Object.keys(ADAPTERS).join(' / ')} 之一，收到：${provider}`);
  }
  const key = String(apiKey || '').trim();
  if (!key) throw inputError(`搜索 API Key 未填写：到「设置 → 聚合来源配置」填写 ${adapter.label} 的 Key`);
  const q = String(query || '').trim();
  if (!q) throw inputError('搜索关键词为空：到「设置 → 聚合来源配置」配置关键词');
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw inputError('单次搜索数量应为 1~50 之间的整数');
  const { url, init } = adapter.buildRequest({ apiKey: key, query: q, count: n });
  const text = await httpWithRetry(url, init, deps);
  return adapter.parseResponse(text);
}

/* ============================ 网页正文提取 ============================ */

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
  '&ldquo;': '“', '&rdquo;': '”', '&lsquo;': '‘', '&rsquo;': '’',
};

function decodeEntities(s) {
  let out = String(s);
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  return out
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/**
 * 网页正文提取 → {title, text, paragraphs}。
 * 剥 script/style/nav/footer 等噪声块与注释；存在 <article> 且其文字量足够时优先取正文块；
 * 块级标签转换行；title 取 <title> 或第一个 <h1>。
 */
function extractArticleText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|head|nav|footer|aside|form|iframe|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  let title = '';
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(s);
  const tTag = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(s);
  if (h1) title = decodeEntities(h1[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  else if (tTag) title = decodeEntities(tTag[1]).replace(/\s+/g, ' ').trim();
  const art = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(s);
  if (art && art[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, '').length >= 80) s = art[1];
  s = s
    .replace(/<\/(p|div|h[1-6]|li|tr|section|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  const paragraphs = s
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u3000]+/g, ' ').trim())
    .filter(Boolean);
  return { title, text: paragraphs.join('\n'), paragraphs };
}

/**
 * 抓取网页正文 → {title, text, url}。
 * mock 模式短路到确定性样例（未知 URL 抛 E_NET，供降级路径测试）；
 * 真实模式 GET 超时 30s，非 2xx / 网络失败 → E_NET。调用方应 try/catch 降级（用摘要兜底），不伪造素材。
 */
async function fetchArticle(url, deps = {}) {
  const u = String(url || '').trim();
  assertPublicHttpUrl(u, '网页地址'); // 拒绝内网/本机/IP 直连（SSRF 防护）
  if (isMock()) {
    const html = mockFetchArticle(u);
    const { title, text } = extractArticleText(html);
    return { title, text, url: u };
  }
  const timeoutMs = deps.fetchTimeoutMs || FETCH_TIMEOUT_MS;
  const text = await httpWithRetry(
    u,
    { method: 'GET', headers: { Accept: 'text/html,application/xhtml+xml' } },
    { ...deps, timeoutMs }
  );
  const { title, text: body } = extractArticleText(text);
  if (!body) throw netError(`网页正文提取为空（可能是反爬或纯脚本渲染）：${u}`);
  return { title, text: body, url: u };
}

/* ============================ 来源分级与去重排序 ============================ */

/**
 * 来源分级：L1 指南与官方机构 / L2 学术 / L3 优质科普（默认兜底）。
 * 域名后缀匹配（host === d || host.endsWith('.' + d)）优先于名称关键词匹配。
 */
const SOURCE_TIERS = [
  {
    tier: 1,
    label: 'L1',
    domains: ['who.int', 'gov.cn', 'people.com.cn'],
    names: ['WHO', '世界卫生组织', '人民日报', '新华社'],
  },
  {
    tier: 2,
    label: 'L2',
    domains: [
      'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov', 'nejm.org',
      'thelancet.com', 'bmj.com', 'jamanetwork.com', 'nature.com', 'sciencedirect.com', 'springer.com',
    ],
    names: ['PubMed', 'NEJM', 'Nature', '柳叶刀', 'Lancet', 'BMJ', 'JAMA'],
  },
];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

/**
 * 内网/本机地址判定（抓取与图片下载的 SSRF 防护，与 main/ipc.js isPrivateHost 同口径）。
 * 搜索结果 URL 由外部内容控制，被投毒的结果不能让主进程去 GET 内网地址。
 */
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return true; // IPv6 直连一律不放行
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

/** 只允许 http(s) + 公网主机（抓取网页/图片前的统一校验）。 */
function assertPublicHttpUrl(url, what) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch (e) {
    throw inputError(`非法的${what || '地址'}：${url || '（空）'}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw inputError(`${what || '地址'}只支持 http(s)：${url}`);
  if (isPrivateHost(u.hostname)) {
    const e = netError(`${what || '地址'}指向内网/本机（${u.hostname}），已拒绝抓取：${url}`);
    e.code = 'E_INVALID_INPUT';
    throw e;
  }
  return u;
}

function matchDomain(host, domains) {
  return domains.find((d) => host === d || host.endsWith(`.${d}`)) || null;
}

/** 来源分级 → {tier:1|2|3, label:'L1'|'L2'|'L3', matchedBy:'domain'|'name'|'default', matched?}。 */
function gradeSource(item) {
  const host = hostOf(item && item.url);
  // 搜索适配层不产出 name（只有 title）：公众号「人民日报：…」这类要靠标题匹配机构名，
  // 否则 L1/L2 白名单名永远命中不了，全部退化成 L3。
  const name = `${String((item && item.name) || '')} ${String((item && item.title) || '')}`;
  for (const t of SOURCE_TIERS) {
    const d = host && matchDomain(host, t.domains);
    if (d) return { tier: t.tier, label: t.label, matchedBy: 'domain', matched: d };
  }
  for (const t of SOURCE_TIERS) {
    const n = t.names.find((kw) => name.includes(kw));
    if (n) return { tier: t.tier, label: t.label, matchedBy: 'name', matched: n };
  }
  return { tier: 3, label: 'L3', matchedBy: 'default' };
}

/** 跟踪类 query 参数（只剔除这些；业务 query 必须保留，否则公众号 /s?__biz=…&mid=… 会全部归一成同一条）。 */
const TRACKING_PARAMS = /^(utm($|_)|spm$|scm$|from$|source$|fbclid$|gclid$|yclid$|mc_cid$|mc_eid$|_hsenc$|_hsmi$|share_token$|share_medium$|share_source$|share_plat$|share_session_id$|share_from$|clicktime$|enterid$)/i;

/**
 * URL 归一键（去重用）：小写协议+主机（去 www.），剔除跟踪参数、去 hash、去路径尾斜杠。
 * 业务 query 保留（公众号每篇文章靠 __biz/mid/idx 区分；只丢 utm_* 之类的跟踪参数）。
 */
function normalizeUrl(url) {
  const raw = String(url || '').trim();
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const p = u.pathname.replace(/\/+$/, '').toLowerCase();
    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (TRACKING_PARAMS.test(k)) continue;
      kept.push([k, v]);
    }
    kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : (a[0] < b[0] ? -1 : 1)));
    const qs = kept.length ? '?' + kept.map(([k, v]) => `${k}=${v}`).join('&') : '';
    return `${u.protocol}//${host}${p}${qs}`;
  } catch (e) {
    return raw.toLowerCase();
  }
}

/** 标题规范化（近似去重用）：只保留 CJK/拉丁/数字并小写。 */
function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff]+/g, '');
}

/**
 * 白名单过滤。whitelist 空 → 全部保留。
 * 条目既可以写域名（who.int / people.com.cn），也可以写机构名（人民日报 / 新华社）——
 * 设置页的 placeholder 就是这么承诺的：域名按 host 后缀匹配，机构名按来源 name 包含匹配。
 */
function filterByWhitelist(items, whitelist) {
  const list = (Array.isArray(whitelist) ? whitelist : [])
    .map((d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, ''))
    .filter(Boolean);
  if (!list.length) return { items: items.slice(), removedCount: 0 };
  const domainEntries = list.filter((d) => d.includes('.'));
  const nameEntries = list.filter((d) => !d.includes('.'));
  const kept = items.filter((it) => {
    const host = hostOf(it.url);
    // 域名匹配只按后缀：host 等于白名单项或是其子域。
    // 反向的 d.includes(host) 会把未列入的相似域名放行（如白名单误写 xpeople.com.cn 时放过 people.com.cn）。
    if (domainEntries.some((d) => host === d || host.endsWith(`.${d}`))) return true;
    if (nameEntries.length) {
      const name = String((it && it.name) || '').toLowerCase();
      const title = String((it && it.title) || '').toLowerCase();
      if (nameEntries.some((n) => (name && name.includes(n)) || (title && title.includes(n)))) return true;
    }
    return false;
  });
  return { items: kept, removedCount: items.length - kept.length };
}

/**
 * 去重（保持原有先后次序）：
 * 1. URL 归一键相同 → 同一组里按「权威度优先、其次搜索排名」选一条；
 * 2. 标题二元组包含率 ≥ TITLE_DUP_THRESHOLD → 同题重复组同样按权威度择优
 *    （避免 L3 副本因为排在前面把 L1/L2 原文挤掉）。
 * 返回 {items: 保留项（原文引用），removedCount}。
 */
function dedupeRankOf(it) {
  const grade = gradeSource(it);
  const rank = Number.isFinite(it && it.rawRank) ? it.rawRank : Number.MAX_SAFE_INTEGER;
  return grade.tier * 1000 + rank; // 数值小者优先：先比级别，再比搜索排名
}

function dedupeResults(items) {
  // 1) URL 归一分组（组内择优，占位保留第一次出现的位置，输出顺序稳定）
  const order = [];
  const groups = new Map();
  let removed = 0;
  for (const it of items) {
    const key = normalizeUrl(it.url);
    if (!groups.has(key)) {
      groups.set(key, it);
      order.push(key);
    } else {
      removed += 1;
      if (dedupeRankOf(it) < dedupeRankOf(groups.get(key))) groups.set(key, it);
    }
  }
  const kept = order.map((k) => groups.get(k));

  // 2) 标题近似去重：同题组按权威度择优
  const kept2 = [];
  const titleGroups = []; // {set, best, outIdx}
  const out = [];
  for (const it of kept) {
    const set = bigramSetN(normalizeTitle(it.title));
    let hit = null;
    if (set.size) {
      hit = titleGroups.find(
        (prev) => prev.set.size && [...set].filter((g) => prev.set.has(g)).length / Math.min(set.size, prev.set.size) >= TITLE_DUP_THRESHOLD
      );
    }
    if (hit) {
      removed += 1;
      if (dedupeRankOf(it) < dedupeRankOf(hit.best)) {
        hit.best = it;
        out[hit.outIdx] = it;
      }
      continue;
    }
    titleGroups.push({ set, best: it, outIdx: out.length });
    out.push(it);
  }
  return { items: out.filter(Boolean), removedCount: removed };
}

const TIER_HEAT_BONUS = { 1: 30, 2: 20, 3: 8 };

/** 新近度加分：≤2 天 +10，≤7 天 +5，未知/更早 0。 */
function recencyBonus(publishedAt, now) {
  if (!publishedAt) return 0;
  const days = (now.getTime() - new Date(publishedAt).getTime()) / 86400000;
  if (days < 0) return 0;
  if (days <= 2) return 10;
  if (days <= 7) return 5;
  return 0;
}

/**
 * 分级 + 热度 + 排序。
 * 热度 = 搜索排名项（55×(1 - rank/total)）+ 级别分（L1=30/L2=20/L3=8）+ 新近度，clamp 1~100。
 * 排序：级别升序 → 热度降序 → 搜索排名升序。返回带 {tier,label,matchedBy,heat,rawRank} 的新数组。
 */
function rankResults(items, { now } = {}) {
  const nowDate = now ? new Date(now) : new Date();
  // 多关键词合并后，数组下标不等于「该关键词内的搜索排名」（若按合并下标算，
  // 第一个关键词的结果被系统性抬升、其余关键词被压低）。这里按关键词统计各自条数，
  // 热度里的搜索排名项统一用 rawRank（缺省时回退合并下标）与所属关键词的实际条数。
  const perKeywordTotal = new Map();
  for (const it of items) {
    const kw = it && it.keyword != null ? String(it.keyword) : '';
    perKeywordTotal.set(kw, (perKeywordTotal.get(kw) || 0) + 1);
  }
  const total = Math.max(1, items.length);
  const ranked = items.map((it, i) => {
    const grade = gradeSource(it);
    const kw = it && it.keyword != null ? String(it.keyword) : '';
    const rank = Number.isFinite(it.rawRank) ? Math.max(0, it.rawRank) : i;
    const denom = Math.max(1, perKeywordTotal.get(kw) || total);
    const heat = Math.max(
      1,
      Math.min(100, Math.round((1 - Math.min(rank, denom) / denom) * 55 + (TIER_HEAT_BONUS[grade.tier] || 0) + recencyBonus(it.publishedAt, nowDate)))
    );
    return { ...it, tier: grade.tier, label: grade.label, matchedBy: grade.matchedBy, heat, rawRank: rank };
  });
  ranked.sort((a, b) => a.tier - b.tier || b.heat - a.heat || a.rawRank - b.rawRank);
  return ranked;
}

/** 选题清单。limit 缺省取 cfg.aggregate.dailyLimit 语义（默认 10）。 */
function buildTopicList(rankedItems, { limit = 10 } = {}) {
  return rankedItems.slice(0, Math.max(1, limit)).map((it) => {
    const key = normalizeUrl(it.url);
    const host = hostOf(it.url);
    const summary = it.snippet ? cpSlice(it.snippet, MAX_SUMMARY_CHARS) + (Array.from(it.snippet).length > MAX_SUMMARY_CHARS ? '…' : '') : '';
    return {
      id: `topic-${crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8)}`,
      title: it.title,
      summary,
      source: { name: it.name || host || it.url, url: it.url, tier: it.tier, label: it.label },
      heat: it.heat,
      publishedAt: it.publishedAt || null,
      keyword: it.keyword || null,
    };
  });
}

/* ============================ 选题雷达 ============================ */

function radarDir(dataDir) {
  return path.join(dataDir, 'radar');
}

/** 读取当日雷达清单：不存在 → null；损坏 → E_IO。 */
function loadRadar(dataDir, date) {
  return readJson(path.join(radarDir(dataDir), `radar-${date}.json`));
}

/** URL → 小写 hostname；非法/空返回 ''（供「大模型是否就是这家」的判断用）。 */
function hostnameOf(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

/** host 是否命中目标域名（含子域）。 */
function hostMatches(host, target) {
  if (!host || !target) return false;
  return host === target || host.endsWith('.' + target);
}

/**
 * 当前大模型自带的搜索通道（deepseek / bigmodel / null）。
 * 用途有二：① 判断能否复用大模型 Key；② 设置页提示「检测到你的模型是 X，搜索可选 X 免注册」。
 * 换到 Moonshot / Qwen / OpenAI 时返回 null —— 它们没有公开搜索 API，只能用独立搜索服务。
 */
function nativeProviderForLlm(llm) {
  const h = hostnameOf(llm && llm.baseUrl);
  if (!h) return null;
  for (const [name, ad] of Object.entries(ADAPTERS)) {
    if (ad.native && hostMatches(h, ad.host)) return name;
  }
  return null;
}

/**
 * 聚合配置 → 运行期搜索参数（含派生状态，供 ipc 校验与设置页提示共用，避免两处口径分叉）。
 * Key 回退规则（v2.2 修正）：只有当「通道是厂商自带搜索」且「大模型正是同一家」时才复用 llm.apiKey。
 * 旧版只看 provider 名字，换模型后会把别家的 Key 发往对不上的地址，表现为 404 且看不出原因。
 */
function aggregateConfigOf(cfg) {
  const a = (cfg && cfg.aggregate) || {};
  const llm = (cfg && cfg.llm) || {};
  const provider = typeof a.searchProvider === 'string' && a.searchProvider ? a.searchProvider : 'bocha';
  const adapter = ADAPTERS[provider] || null;
  const ownKey = String(a.searchApiKey || '').trim();
  const llmNative = nativeProviderForLlm(llm);
  const canReuseLlmKey = !!(adapter && adapter.native && llmNative === provider);
  const llmKey = canReuseLlmKey ? String(llm.apiKey || '').trim() : '';
  const apiKey = ownKey || llmKey;
  return {
    keywords: Array.isArray(a.keywords) ? a.keywords.filter((k) => String(k || '').trim()) : [],
    whitelist: Array.isArray(a.whitelist) ? a.whitelist : [],
    provider,
    providerLabel: adapter ? adapter.label : provider,
    providerNative: !!(adapter && adapter.native),
    providerHost: adapter ? adapter.host : '',
    apiKey,
    keyFromLlm: !ownKey && !!apiKey,
    canReuseLlmKey,
    llmHost: hostnameOf(llm.baseUrl),
    llmNativeProvider: llmNative,
    dailyLimit: Number.isInteger(a.dailyLimit) && a.dailyLimit >= 1 ? a.dailyLimit : 10,
    similarityThreshold: typeof a.similarityThreshold === 'number' && a.similarityThreshold > 0 ? a.similarityThreshold : 0.3,
    // 敏感话题关键词：用户配置优先，空/缺省回退默认预设（isSensitiveTopic 与闸门共用此口径）
    sensitiveKeywords: Array.isArray(a.sensitiveKeywords) && a.sensitiveKeywords.length ? a.sensitiveKeywords : DEFAULT_SENSITIVE_KEYWORDS,
    // 文末领域提示（可选）：enabled 且文本非空时由提示词/上传前补齐逻辑使用
    verticalNotice: {
      enabled: !!(a.verticalNotice && a.verticalNotice.enabled === true && String(a.verticalNotice.text || '').trim()),
      text: String((a.verticalNotice && a.verticalNotice.text) || '').trim(),
    },
  };
}

/**
 * 选题雷达：多关键词搜索 → 白名单过滤 → 去重 → 分级排序 → 清单落盘。
 * 单个关键词失败不阻断（keywordErrors 如实记录）；全部失败 → 抛 E_NET。
 * 落盘 dataDir/radar/radar-<date>.json；返回 {ok, date, topics, keywordErrors, removedCount, savedPath}。
 */
async function runTopicRadar(cfg, { dataDir, date, now, deps = {} } = {}) {
  const agg = aggregateConfigOf(cfg);
  if (!agg.keywords.length) {
    throw inputError('未配置搜索关键词：到「设置 → 聚合来源配置」添加关键词（如 科技 / 教育）后重试');
  }
  const day = date || dayKey(now ? new Date(now) : new Date());
  const perQuery = Math.min(20, Math.max(10, agg.dailyLimit * 2));
  const items = [];
  const keywordErrors = [];
  for (const kw of agg.keywords) {
    try {
      const results = await searchWeb(
        { provider: agg.provider, apiKey: agg.apiKey, query: kw, count: perQuery },
        deps
      );
      for (const r of results) items.push({ ...r, keyword: kw });
    } catch (e) {
      keywordErrors.push({ keyword: kw, error: { code: e.code || 'E_NET', message: e.message } });
    }
  }
  if (!items.length) {
    const first = keywordErrors[0];
    const err = netError(`全部关键词搜索失败${first ? `（如「${first.keyword}」：${first.error.message}）` : ''}`);
    err.keywordErrors = keywordErrors;
    throw err;
  }
  const { items: whitelisted, removedCount: wlRemoved } = filterByWhitelist(items, agg.whitelist);
  if (agg.whitelist.length && !whitelisted.length) {
    const err = inputError(
      `搜索到 ${items.length} 条结果，但全部被来源白名单过滤掉了：当前白名单「${agg.whitelist.join('、')}」没有命中任何来源。` +
      '白名单可填域名（如 who.int / people.com.cn）或来源机构名（如 人民日报 / 新华社），也可以先清空白名单看看搜索质量'
    );
    err.removedCount = wlRemoved;
    throw err;
  }
  const { items: deduped, removedCount: dupRemoved } = dedupeResults(whitelisted);
  const ranked = rankResults(deduped, { now });
  const topics = buildTopicList(ranked, { limit: agg.dailyLimit });
  const payload = {
    date: day,
    generatedAt: isoNow(now),
    keywords: agg.keywords,
    keywordErrors,
    removedCount: wlRemoved + dupRemoved,
    topics,
  };
  let savedPath = null;
  if (dataDir) {
    savedPath = path.join(radarDir(dataDir), `radar-${day}.json`);
    writeJson(radarDir(dataDir), `radar-${day}.json`, payload);
  }
  return { ok: true, date: day, topics, keywordErrors, removedCount: wlRemoved + dupRemoved, savedPath, radar: payload };
}

/* ============================ n-gram 相似度自检 ============================ */

/** 保留 CJK/拉丁/数字的字符索引映射（用于把 n-gram 命中映射回原文摘录）。 */
function charIndexMap(text) {
  const lower = String(text || '').toLowerCase();
  const chars = [];
  const idx = [];
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (/[a-z0-9\u3400-\u4dbf\u4e00-\u9fff]/.test(ch)) {
      chars.push(ch);
      idx.push(i);
    }
  }
  return { chars, idx };
}

/** 两个规范化文本的二元组包含率：|A∩B| / min(|A|,|B|)（任一方不足 n 个字符 → 0）。 */
function ngramSimilarity(aText, bText, { n = SIMILARITY_N } = {}) {
  const A = bigramSetN(aText, n);
  const B = bigramSetN(bText, n);
  if (A.size < n || B.size < n) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return shared / Math.min(A.size, B.size);
}

// bigramSet 支持 n 参数（内部工具）
function bigramSetN(text, n = SIMILARITY_N) {
  const chars = Array.from(text);
  const set = new Set();
  for (let i = 0; i + n <= chars.length; i++) set.add(chars.slice(i, i + n).join(''));
  return set;
}

/**
 * 草稿与来源片段的最大公共连续片段（n-gram 游程合并）→ [{text, chars}]，按长度降序。
 * 命中的相邻 n-gram 合并成游程，再映射回原文位置取摘录（minRunChars 过滤零散短命中）。
 */
function sharedRuns(draftText, sourceText, { n = SIMILARITY_N, maxRuns = 3, minRunChars = 8 } = {}) {
  const draft = charIndexMap(draftText);
  const src = charIndexMap(sourceText);
  const draftSet = bigramSetN(draft.chars.join(''), n);
  const len = src.chars.length;
  const runs = [];
  const pushRun = (start, last) => {
    if (start < 0 || last < start) return;
    const from = src.idx[start];
    const to = src.idx[Math.min(last + n - 1, len - 1)];
    if (to > from) {
      const excerpt = String(sourceText).slice(from, to + 1);
      const chars = Array.from(excerpt).length;
      if (chars >= minRunChars) runs.push({ text: excerpt, chars });
    }
  };
  let start = -1;
  for (let j = 0; j + n <= len; j++) {
    if (draftSet.has(src.chars.slice(j, j + n).join(''))) {
      if (start < 0) start = j;
    } else {
      pushRun(start, j - 1);
      start = -1;
    }
  }
  pushRun(start, len - n); // 收尾：游程延伸到文本末尾
  return runs.sort((a, b) => b.chars - a.chars).slice(0, maxRuns);
}

/**
 * 相似度自检：草稿 vs 每个来源的 n-gram 双向覆盖率。
 * ratio = max(|共享二元组|/来源集, |共享二元组|/草稿集)；任一来源 ratio > threshold → 未通过（返回重写信号）。
 * 返回 {threshold, n, passed, needsRewrite, maxRatio, worstIndex, reports:[{index, ratio, runs}]}。
 */
function checkSimilarity(draftText, sourceTexts, { threshold = 0.3, n = SIMILARITY_N, maxRuns = 3 } = {}) {
  const sources = Array.isArray(sourceTexts) ? sourceTexts : [];
  const draft = charIndexMap(draftText);
  const draftSet = bigramSetN(draft.chars.join(''), n);
  const reports = sources.map((src, index) => {
    const s = charIndexMap(String(src || ''));
    const srcSet = bigramSetN(s.chars.join(''), n);
    let shared = 0;
    for (const g of srcSet) if (draftSet.has(g)) shared += 1;
    const ratioSrc = srcSet.size >= n ? shared / srcSet.size : 0;
    const ratioDraft = draftSet.size >= n ? shared / draftSet.size : 0;
    const ratio = Math.max(ratioSrc, ratioDraft);
    return { index, ratio: Math.round(ratio * 10000) / 10000, runs: shared ? sharedRuns(draftText, String(src || ''), { n, maxRuns }) : [] };
  });
  const worst = reports.reduce((acc, r) => (r.ratio > (acc ? acc.ratio : -1) ? r : acc), null);
  const passed = reports.every((r) => r.ratio <= threshold);
  return {
    threshold,
    n,
    passed,
    needsRewrite: !passed,
    maxRatio: worst ? worst.ratio : 0,
    worstIndex: worst ? worst.index : null,
    reports,
  };
}

/** 敏感话题识别（关键词可配置，默认需人工确认才生成）：入参 keywords 优先，缺省回退默认预设。 */
function isSensitiveTopic(text, keywords) {
  const s = String(text || '');
  const list = Array.isArray(keywords) && keywords.length ? keywords : DEFAULT_SENSITIVE_KEYWORDS;
  return list.filter((kw) => s.includes(kw));
}

/* ============================ 综合成文 ============================ */

const FORMAT_RULES = `输出要求：
1. 标题不超过 24 个字；摘要不超过 100 字。
2. 正文 900~1400 字，微信适配的 HTML：样式全部写在每个标签的 style 属性里；只允许 p、h2、h3、section、strong、em、blockquote、ul、ol、li、code、pre、hr、br 标签；正文颜色 #3f3f3f、字号 15px、行高 1.75；小标题颜色 #1a1a1a；不要插入图片。
3. 严格按下面的格式输出，除该格式外不要输出任何内容：
===TITLE===
标题
===DIGEST===
摘要
===BODY_HTML===
<p>正文 HTML</p>`;

/* buildProjectBlock 来自 core/config：与 chat 同口径，并把 content.audience/styleExtra 作为兜底并入项目上下文。 */

/** 综合成文提示词。
 * verticalNotice：可选的文末领域提示（来自 aggregate.verticalNotice，enabled 且 text 非空时才注入）。 */
function buildSynthesisPrompt({ topics, materials, project, styleInjection, codeBlock, verticalNotice }) {
  const rules = [
    '1. 只提取来源中的事实、共识、数据、结论；禁止复用来源的句式、比喻、结构与独特表达，不得整句改写原文。',
    '2. 提到具体研究、指南、机构时署名出处（如「行业权威指南建议…」）；引用事实出处不等于抄袭；英文来源译写为中文综述。',
    '3. 合规约束：不提供医疗、法律、投资等需要专业资质的建议；不承诺具体效果与期限，不使用「保证」类承诺性表述。',
  ];
  const vn = String(verticalNotice || '').trim();
  if (vn) rules.push(`4. 文末固定追加一句提示：${vn}`);
  rules.push(`${rules.length + 1}. 不要在正文中罗列来源链接或「参考来源」清单（来源清单另行内部保存，不随文发布）。`);
  rules.push(
    codeBlock
      ? `${rules.length + 1}. 结合下方功能资料自然介绍产品的实际相关功能，必须在正文明确写出产品名称；符合文风画像，标注的 AI 味禁用词一律不得出现。`
      : `${rules.length + 1}. 只写选题知识与实用建议，不植入产品、系统、软件或推广邀请；符合文风画像，标注的 AI 味禁用词一律不得出现。`
  );
  const parts = [
    '你是资深公众号作者。请基于下面的「来源材料」，围绕勾选的主题写一篇原创中文文章。',
    `主题：${topics.map((t) => t.title).join(' / ')}`,
    '',
    '硬性规则（违反即视为失败）：',
    ...rules,
    '',
  ];
  const pb = buildProjectBlock(project);
  if (pb) parts.push(pb, '');
  if (styleInjection) parts.push(String(styleInjection).trim(), '');
  if (codeBlock) parts.push(codeBlock, '');
  parts.push(
    `来源材料（只读这些，不得引入材料之外的事实）：\n---\n${materials
      .map((m, i) => `[材料${i + 1}·${m.label || 'L3'}·${m.name || m.url}] ${m.title || ''}\n${cpSlice(String(m.text || ''), MAX_SOURCE_CHARS)}`)
      .join('\n---\n')}\n---`
  );
  parts.push(FORMAT_RULES);
  return parts.join('\n');
}

/** 重写提示词：给出超阈值报告与雷同片段，要求换一种完全不同的写法。 */
function buildRewritePrompt({ topics, materials, project, styleInjection, article, report, codeBlock }) {
  const similar = (report.reports || [])
    .flatMap((r) => (r.runs || []).map((run) => `- 「${run.text}」（与来源 ${r.index + 1} 重叠）`))
    .slice(0, 8);
  const parts = [
    '你上一稿与来源材料的 n-gram 重叠超出阈值，需要重写：只保留事实、数据与结论本身，完全换一种表述、结构与行文顺序；引用具体研究/指南时署名出处。',
    `主题：${topics.map((t) => t.title).join(' / ')}`,
    `相似度：最高重叠率 ${report.maxRatio}（阈值 ${report.threshold}）。上一稿中与来源雷同的片段：`,
    similar.length ? similar.join('\n') : '- （未列出具体片段，请整体降低与来源的措辞重叠）',
    '',
    `上一稿：\n===TITLE===\n${article.title}\n===DIGEST===\n${article.digest}\n===BODY_HTML===\n${article.html}`,
    '',
  ];
  const pb = buildProjectBlock(project);
  if (pb) parts.push(pb, '');
  if (styleInjection) parts.push(String(styleInjection).trim(), '');
  if (codeBlock) parts.push(codeBlock, '');
  parts.push(
    `来源材料：\n---\n${materials
      .map((m, i) => `[材料${i + 1}·${m.label || 'L3'}·${m.name || m.url}] ${m.title || ''}\n${cpSlice(String(m.text || ''), MAX_SOURCE_CHARS)}`)
      .join('\n---\n')}\n---`
  );
  parts.push(FORMAT_RULES);
  return parts.join('\n');
}

function aggregateOutDir(dataDir, date, batchId) {
  return path.join(dataDir, 'output', date, 'aggregate', batchId);
}

/**
 * 勾选成文（选题雷达 → 综合成文）。
 * 入参 opts：{topics(1~3 条), materials?(预取材料，按 topics 下标对齐), project, styleInjection,
 *             confirmSensitive, date, dataDir, state, logger}
 * 流程：敏感话题闸（未确认 → needsConfirmation）→ 抓取正文（失败降级用摘要并如实记录 fetchState）
 *       → 综合提示词 → LLM → 相似度自检 → 超阈值自动重写（最多 REWRITE_ATTEMPTS 次）
 *       → 落盘 article.json / sources.json(内部可见) / similarity.json / preview.html。
 * 返回 {ok:true, date, batchId, article, words, similarity, needsRewrite, sources, outDir}；
 * 敏感未确认返回 {ok:false, needsConfirmation:true, reason, sensitiveKeywords}。
 */
async function composeFromTopics(cfg, opts = {}, deps = {}) {
  const logger = deps.logger || { info() {}, warn() {}, error() {} };
  const rawTopics = Array.isArray(opts.topics) ? opts.topics.filter(Boolean) : [];
  if (rawTopics.length < 1 || rawTopics.length > MAX_TOPICS_PER_BATCH) {
    throw inputError(`请勾选 1~${MAX_TOPICS_PER_BATCH} 条选题再成文（当前 ${rawTopics.length} 条）`);
  }
  // 归一化选题形状：buildTopicList 把 url/tier/label/name 放在 topic.source 里，也接受平铺入参
  const topics = rawTopics.map((t) => ({
    ...t,
    url: t.url || (t.source && t.source.url) || '',
    label: t.label || (t.source && t.source.label) || 'L3',
    tier: t.tier || (t.source && t.source.tier) || 3,
    name: t.name || (t.source && t.source.name) || '',
    summary: t.summary == null ? '' : String(t.summary),
  }));
  const agg = aggregateConfigOf(cfg);
  const threshold = typeof opts.threshold === 'number' && opts.threshold > 0 ? opts.threshold : agg.similarityThreshold;

  // 来源材料：预取优先；否则抓取正文，失败降级为搜索摘要（如实记录，不伪造素材）
  const now = opts.now ? new Date(opts.now) : new Date();
  const materials = [];
  for (let i = 0; i < topics.length; i++) {
    const t = topics[i];
    const provided = opts.materials && opts.materials[i] && typeof opts.materials[i].text === 'string' && opts.materials[i].text.trim();
    if (provided) {
      materials.push({ ...t, ...opts.materials[i], fetchState: 'provided' });
      continue;
    }
    try {
      const { title, text } = await fetchArticle(t.url, deps);
      materials.push({ ...t, title: title || t.title, text, fetchState: 'ok' });
    } catch (e) {
      logger.warn(`来源正文抓取失败，降级使用搜索摘要：${t.url}（${e.message}）`);
      materials.push({
        ...t,
        text: t.summary || '',
        fetchState: 'snippet-only',
        fetchError: e.message,
      });
    }
  }

  // 敏感话题闸（默认需人工确认才生成）。
  // 判定输入覆盖标题 + 摘要 + 来源材料正文：敏感词只出现在摘要或素材正文里同样要确认。
  const sensitiveSource = [topics.map((t) => `${t.title || ''} ${t.summary || ''}`).join(' ')]
    .concat(materials.map((m) => String(m.text || '')))
    .join('\n');
  const sensitiveKeywords = isSensitiveTopic(sensitiveSource, agg.sensitiveKeywords);
  if (sensitiveKeywords.length && !opts.confirmSensitive) {
    return {
      ok: false,
      needsConfirmation: true,
      reason: `选题命中敏感话题关键词（${sensitiveKeywords.join('、')}）：按合规要求需人工确认后才能生成，请确认题材安全后重试`,
      sensitiveKeywords,
    };
  }

  const codeContext = opts.codeContext || null;
  const productProfile = opts.productProfile || null;
  const promoting = !!(codeContext || productProfile);
  const productName = promoting ? String(opts.productName || (codeContext && codeContext.repoName) || '我的系统').trim() : '';
  let codeBlock = productProfile
    ? require('./product-profile').buildProfileBlock(productProfile, {productName,promotion:opts.promotion})
    : require('./code-context').buildCodeBlock(codeContext, {productName,promotion:opts.promotion});
  if (promoting && opts.localAssets && opts.localAssets.length) codeBlock += '\n\n' + require('./local-assets').buildAssetBlock(opts.localAssets);
  const project = opts.project !== undefined ? opts.project : projectContext(cfg);
  const styleInjection = opts.styleInjection || '';
  const date = opts.date || dayKey(now);
  // 哈希里带上日期：recordRun 按 id upsert，若只由选题哈希生成，同一组选题第二天成文
  // 会把前一天的历史条目替换成新日期（旧记录消失、旧产物目录变孤儿）。
  // opts.batchNonce：同日「按原选题重新生成」时由调用方传入，保证新稿不复用旧批次目录/历史条目。
  const nonce = opts.batchNonce ? String(opts.batchNonce) : '';
  const batchId = `agg-${crypto.createHash('sha256').update(date + '|' + (nonce ? nonce + '|' : '') + topics.map((t) => t.id || normalizeUrl(t.url)).join('|'), 'utf8').digest('hex').slice(0, 8)}`;
  const outDir = opts.dataDir ? aggregateOutDir(opts.dataDir, date, batchId) : null;

  const attempt = async (prompt, nth) => {
    const { raw, model } = await callLlmMessages(cfg, [{ role: 'user', content: prompt }], { ...deps, mockKind: 'aggregate' });
    try {
      const parsed = parseLlmOutput(raw);
      if (promoting && !String(parsed.html).includes(productName)) throw new LlmFormatError(`文章未结合产品「${productName}」，请重试`);
      return { article: parsed, raw, model, formatError: null };
    } catch (e) {
      if (outDir) {
        try {
          writeJson(outDir, `raw-llm-attempt${nth}.json`, { raw });
        } catch (_) {
          /* 落盘失败不阻断 */
        }
      }
      return { article: null, raw, model, formatError: e };
    }
  };

  let report = null;
  let article = null;
  let model = null;
  let attempts = 0;
  const materialTexts = materials.map((m) => String(m.text || ''));
  // v2.4：重写次数可配——全自动模式（radar:auto-run / 定时）会传更大的 maxRewrites；
  // 手动勾选成文不传时保持原值 REWRITE_ATTEMPTS(2)，行为不变。上限 10 防止配置写歪导致死烧钱。
  const maxRewrites = Number.isInteger(opts.maxRewrites) && opts.maxRewrites >= 0
    ? Math.min(opts.maxRewrites, 10)
    : REWRITE_ATTEMPTS;
  for (let nth = 1; nth <= 1 + maxRewrites; nth++) {
    attempts = nth;
    // 首次（或上一稿格式错误、没有可对照的上一稿）用综合提示词；有上一稿且超阈值才用重写提示词
    const useRewrite = nth > 1 && article && report;
    const prompt = useRewrite
      ? buildRewritePrompt({ topics, materials, project, styleInjection, article, report, codeBlock })
      : buildSynthesisPrompt({ topics, materials, project, styleInjection, codeBlock, verticalNotice: agg.verticalNotice && agg.verticalNotice.enabled ? agg.verticalNotice.text : '' });
    const r = await attempt(prompt, nth);
    model = r.model;
    if (!r.article) {
      if (nth === 1 + maxRewrites) {
        const e = r.formatError;
        const err = e instanceof LlmFormatError ? e : new Error(`LLM 输出解析失败：${e.message}`);
        err.code = 'E_LLM';
        throw err;
      }
      logger.warn(`第 ${nth} 次输出格式不符，已保存原始输出并重试`);
      continue;
    }
    article = r.article;
    // 相似度自检要把插图声明里的文字一起算进去：extractArticleText 只取标签外文本，
    // 属性里的 items/title 会被丢掉，不补这一步等于「把来源原句塞进插图」就能绕过护栏。
    const illusText = illustrationTextOf(article.html);
    const draftText = extractArticleText(article.html).text + (illusText ? '\n' + illusText : '');
    report = checkSimilarity(draftText, materialTexts, { threshold });
    if (report.passed) break;
    logger.warn(`相似度自检未通过（最高重叠率 ${report.maxRatio} > ${threshold}），自动重写（第 ${nth}/${1 + maxRewrites} 次）`);
  }

  // LLM 输出可能被来源网页内容经提示词注入影响：落盘/预览/返回渲染层前统一消毒，
  // 与素材/对话路径（main/articles.saveComposedArticle）同一口径（R1 代码审查点）。
  article = { ...article, html: sanitizeHtml(article.html), batchId, productName, generationMode:productProfile ? 'web-profile' : (codeContext ? 'web-code' : 'web'), profileEvidence:productProfile ? {fileName:productProfile.fileName,fingerprint:productProfile.fingerprint,originalChars:productProfile.originalChars,includedChars:productProfile.includedChars,limited:productProfile.limited} : null, codeEvidence:codeContext ? {fingerprint:codeContext.fingerprint,files:codeContext.files.map(f=>f.path),scannedFiles:codeContext.scannedFiles} : null };

  // v2.3：正文插图（<illus> → PNG 内联）。位置很关键：必须放在消毒之后、算字数之前，
  // 否则 img 标签会被消毒流程当成可疑内容，字数也会按带标签的文本算错。
  // 渲染失败 → 剥掉占位按无图继续（绝不因为有图没渲染出来就让整篇失败）。
  if (typeof deps.materializeIllustrations === 'function') {
    try {
      const m = await deps.materializeIllustrations(article, { logger });
      if (m && m.article) article = m.article;
    } catch (e) {
      // 配图渲染属于增强项：失败就剥掉插图占位、按无图继续，不能让整篇稿子作废
      // （定时全自动场景尤其致命——一次渲染抖动会白白丢掉当天的文章）。
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`正文配图渲染失败（${(e && e.message) || e}），已按无图继续`);
      }
      article = { ...article, html: stripIllustrations(article.html) };
    }
  }

  const words = countWords(article.html);
  const sourceList = {
    internal: true,
    note: '素材来源清单：仅供人工核查使用，不随文章发布',
    date,
    batchId,
    generatedAt: isoNow(now),
    topics: topics.map((t) => ({ id: t.id || null, title: t.title, url: t.url, label: t.label || 'L3', heat: t.heat == null ? null : t.heat })),
    sources: materials.map((m, i) => ({
      index: i + 1,
      tier: m.tier || 3,
      label: m.label || 'L3',
      name: m.name || hostOf(m.url) || m.url,
      title: m.title || '',
      url: m.url,
      excerpt: cpSlice(String(m.text || ''), 200),
      fetchState: m.fetchState,
      ...(m.fetchError ? { fetchError: m.fetchError } : {}),
      usedFor: '事实/共识/数据提取',
    })),
  };
  const similarity = {
    threshold: report.threshold,
    n: report.n,
    passed: report.passed,
    maxRatio: report.maxRatio,
    worstIndex: report.worstIndex,
    attempts,
    rewriteAttempts: attempts - 1,
    needsRewrite: !report.passed,
    reports: report.reports,
  };

  if (outDir) {
    writeJson(outDir, 'article.json', {
      ...article,
      title: article.title,
      digest: article.digest,
      html: article.html,
      words,
      origin: '聚合',
      batchId,
      topics: sourceList.topics,
      generatedAt: sourceList.generatedAt,
    });
    writeJson(outDir, 'sources.json', sourceList);
    if (productProfile) writeJson(outDir, 'profile-evidence.json', productProfile);
    if (article.assetEvidence) writeJson(outDir, 'image-evidence.json', article.assetEvidence);
    if (codeContext) writeJson(outDir, 'code-evidence.json', {productName, fingerprint:codeContext.fingerprint, scannedFiles:codeContext.scannedFiles, readableFiles:codeContext.readableFiles, truncated:codeContext.truncated, files:codeContext.files});
    writeJson(outDir, 'similarity.json', similarity);
    fs.writeFileSync(
      path.join(outDir, 'preview.html'),
      buildPreviewHtml({ title: article.title, digest: article.digest, html: article.html }),
      'utf8'
    );
    if (opts.state) {
      try {
        recordRun(opts.state, { id: batchId, date, title: article.title, status: 'generated', words, origin: '聚合' });
        saveStateMerged(opts.dataDir, opts.state);
      } catch (e) {
        logger.warn(`历史记录保存失败：${e.message}`);
      }
    }
  }

  return {
    ok: true,
    date,
    batchId,
    article,
    words,
    similarity,
    needsRewrite: similarity.needsRewrite,
    sources: sourceList.sources,
    outDir,
    model,
  };
}

module.exports = {
  ADAPTERS,
  SOURCE_TIERS,
  SENSITIVE_KEYWORDS,
  TITLE_DUP_THRESHOLD,
  SIMILARITY_N,
  REWRITE_ATTEMPTS,
  MAX_TOPICS_PER_BATCH,
  MAX_SOURCE_CHARS,
  searchWeb,
  httpWithRetry,
  normalizeItem,
  extractArticleText,
  fetchArticle,
  gradeSource,
  hostOf,
  isPrivateHost,
  assertPublicHttpUrl,
  normalizeUrl,
  normalizeTitle,
  filterByWhitelist,
  dedupeResults,
  rankResults,
  buildTopicList,
  radarDir,
  loadRadar,
  hostnameOf,
  hostMatches,
  nativeProviderForLlm,
  aggregateConfigOf,
  runTopicRadar,
  ngramSimilarity,
  sharedRuns,
  checkSimilarity,
  isSensitiveTopic,
  buildProjectBlock,
  buildSynthesisPrompt,
  buildRewritePrompt,
  composeFromTopics,
};
