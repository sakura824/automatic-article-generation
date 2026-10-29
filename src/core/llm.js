'use strict';
/**
 * llm.js —— OpenAI 兼容 /chat/completions 调用与输出解析（移植 run_daily.py:293-374）。
 * 契约 §3/§4：
 *  - buildPrompt(digest, cfg, dateStr)：===TITLE===/===DIGEST===/===BODY_HTML=== 约定格式，
 *    微信适配 HTML 约束、读者画像 + 风格补充；
 *  - callLlm(cfg, prompt)：Bearer 鉴权、超时 300s、网络类错误重试 2 次（PRD §8）；
 *  - parseLlmOutput：标题 58 字、摘要 118 字（超长加 …）截断，格式不符抛 LlmFormatError；
 *  - probeLlm：测试连接，返回模型名与延迟；
 *  - mock 模式（WECHAT_DAILY_MOCK=1）在入口短路到 mock.js 的确定性桩。
 * fetch 可注入（deps.fetch），测试零真实网络。
 */
const { isMock, mockLlmCall } = require('./mock');

/** 单次请求超时（契约：300s）。 */
const LLM_TIMEOUT_MS = 300 * 1000;
/** 总尝试次数 = 首次 + 网络类重试 2 次。 */
const LLM_RETRY_ATTEMPTS = 3;
const MAX_TITLE = 58;
const MAX_DIGEST = 118;

class LlmError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmError';
    this.code = 'E_LLM';
  }
}

/** LLM 输出不符合 ===TITLE===/===DIGEST===/===BODY_HTML=== 约定格式（pipeline 据此存 raw_llm.txt 并重试 1 次）。 */
class LlmFormatError extends LlmError {
  constructor(message) {
    super(message);
    this.name = 'LlmFormatError';
    this.kind = 'format';
  }
}

function inputError(message) {
  const e = new Error(message);
  e.code = 'E_INVALID_INPUT';
  return e;
}

function snippet(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** baseUrl 拼接：去掉尾部 / 后接 /chat/completions（bigmodel 预设与命令行版 URL 一致）。 */
function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw inputError('Base URL 未填写：可选预设 bigmodel / deepseek，或填完整服务地址');
  return `${base}/chat/completions`;
}

/** 按代码点截取（与 Python 按码位切片一致，避免 emoji 被截半）。 */
function cpSlice(s, n) {
  return Array.from(s).slice(0, n).join('');
}

function cpLen(s) {
  return Array.from(s).length;
}

/**
 * 带重试的 HTTP 请求（供 callLlm/probeLlm）。
 * - 网络类错误（fetch reject / 超时）与 5xx/429 重试，共 LLM_RETRY_ATTEMPTS 次；
 * - 其余非 2xx 立即失败；
 * - 返回 {status, text}；最终失败抛 LlmError（HTTP）或 code=E_NET 的 Error（网络）。
 * deps: {fetch?, timeoutMs?, retryDelayMs?}
 */
async function requestWithRetry(url, init, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new LlmError('当前环境没有可用的 fetch 实现');
  }
  const timeoutMs = deps.timeoutMs || LLM_TIMEOUT_MS;
  const delayMs = deps.retryDelayMs == null ? 1000 : deps.retryDelayMs;
  let lastHttp = null;
  let lastNetErr = null;
  for (let attempt = 1; attempt <= LLM_RETRY_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), timeoutMs);
    try {
      const res = await doFetch(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      if (res.ok) return { status: res.status, text };
      lastHttp = { status: res.status, text };
      const retryable = res.status >= 500 || res.status === 429;
      if (!retryable) break;
    } catch (e) {
      lastNetErr = e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < LLM_RETRY_ATTEMPTS && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  if (lastHttp) {
    const err = new LlmError(`LLM API 调用失败 HTTP ${lastHttp.status}：${snippet(lastHttp.text)}`);
    err.status = lastHttp.status;
    throw err;
  }
  const netErr = new Error(
    `网络请求失败：${lastNetErr ? lastNetErr.message : '未知错误'}（已重试 ${LLM_RETRY_ATTEMPTS - 1} 次仍失败，请检查网络与 Base URL）`
  );
  netErr.code = 'E_NET';
  throw netErr;
}

function llmConfigOf(cfg) {
  return (cfg && cfg.llm) || {};
}

const DEFAULT_AUDIENCE = '关注内容的读者'; // 未填写读者画像时的通用兜底（PRD v2 §3）

/**
 * 微信适配 HTML 约束（v2 起 compose.js 等多处共用同一份文案，避免口径漂移）。
 * 文本与 v1 buildPrompt 第 4 条逐字一致（llm.test.js 断言其内容）。
 */
const WECHAT_HTML_RULES =
  '正文必须是微信适配的 HTML：所有样式一律写在每个标签的 style 属性里（微信会剔除 <style> 标签和 class）；' +
  '只允许 p、h2、h3、section、strong、em、blockquote、ul、ol、li、code、pre、hr、br 标签；' +
  '正文颜色 #3f3f3f、字号 15px、行高 1.75；小标题颜色 #1a1a1a；' +
  '代码块用 <pre style="background:#f6f8fa;padding:12px;border-radius:6px;font-size:13px;white-space:pre-wrap">；' +
  '不要插入 <img> 标签或任何外部图片，也不要外部链接的 CSS/JS（需要配图时用下面的插图声明，系统会渲染成图片）。';

/**
 * 插图声明规范（v2.3）：模型没有画图能力，只能描述「这里要一张什么图、图里写什么」，
 * 由本地模板统一渲染成 PNG。属性值里禁止引号、多值用 || 分隔——模型写 JSON 属性容易写坏。
 * 与 illustration.js 的解析规则严格对应（模板见 core/illustration.js）。
 */
const ILLUSTRATION_RULES =
  '配图（可选，最多 3 张，只在真正需要「一眼看清」的地方用，不要每段都插）：' +
  '需要插图时，在该位置单独写一行 <illus ...></illus>，属性值里不要写引号，多个值用 || 分隔：\n' +
  '  · 要点总结：<illus type="summary" title="小节标题" items="要点一||要点二||要点三"></illus>\n' +
  '  · 数据对比：<illus type="compare" title="对比标题" items="项目A||项目B" values="12||30" unit="%"></illus>（values 与 items 一一对应，只能放正文里已经写过的数字）\n' +
  '  · 流程结构：<illus type="flow" title="流程标题" items="第一步||第二步||第三步"></illus>\n' +
  '  · 金句摘录：<illus type="quote" text="正文里的一句关键话" sub="可选副标题"></illus>\n' +
  '系统会把标签渲染成图片，所以图里的文字必须是你正文已有内容的提炼，不要在图里新增事实、数字或结论。';

/**
 * 构造写作 prompt（逐字移植 build_prompt，Config 键名换为桌面版结构）。
 * ctx（v2 增量）：{projectBlock?, styleInjection?}——项目背景与文风画像注入，
 * 与素材/对话/聚合三条 v2 路径同口径（此前仓库自动模式完全不注入）。
 */
function buildPrompt(digest, cfg, dateStr, ctx = {}) {
  const content = (cfg && cfg.content) || {};
  const audience = String(content.audience || '').trim() || DEFAULT_AUDIENCE;
  const extra = String(content.styleExtra || '');
  const projectBlock = String((ctx && ctx.projectBlock) || '').trim();
  const styleInjection = String((ctx && ctx.styleInjection) || '').trim();
  return `你是一位面向${audience}的微信公众号写手。请根据下面的仓库提交记录，写一篇今天的项目进展推文。

写作要求：
1. 标题：不超过 24 个字，有信息量、不标题党。
2. digest（摘要）：不超过 100 字。
3. 正文：800~1200 字。结构：一两句话开头引入 → 挑 2~4 个最有价值的变更，讲清楚做了什么、为什么做、对使用者有什么影响（不要罗列全部文件）→ 自然收尾。语气自然，不用"首先/其次/最后"式八股，不夸大。
4. ${WECHAT_HTML_RULES}
${ILLUSTRATION_RULES}
5. 严格按下面的格式输出，除该格式外不要输出任何内容：
===TITLE===
标题
===DIGEST===
摘要
===BODY_HTML===
<p>正文 HTML</p>
${projectBlock ? '\n' + projectBlock + '\n' : ''}${styleInjection ? '\n' + styleInjection + '\n' : ''}
读者：${audience}
${extra}

仓库提交记录（${dateStr}）：
---
${digest}
---`;
}

/**
 * 调用 LLM（多轮 messages 形态，v2 对话/成文/画像共用）→ {raw, model, latencyMs}。
 * payload：{model, messages:[{role,content},...], temperature}；Bearer 鉴权；超时 300s。
 * mock 模式在入口短路到确定性桩，按 deps.mockKind 选择桩内容：
 *   'v1'（默认，callLlm 走这里）→ mockLlmCall；'chat' → mockChatReply；
 *   'style' → mockStyleProfileRaw；'compose' → mockComposeOutput；'aggregate' → mockAggregateArticle。
 */
async function callLlmMessages(cfg, messages, deps = {}) {
  if (!Array.isArray(messages) || !messages.length || messages.some((m) => !m || typeof m.content !== 'string' || !m.content.trim())) {
    throw inputError('messages 不能为空，且每条必须含非空 content');
  }
  if (isMock()) {
    const kind = deps.mockKind || 'v1';
    const mock = require('./mock'); // 延迟 require：桩函数按需取用
    if (kind === 'chat') return { raw: mock.mockChatReply(messages), model: (cfg.llm && cfg.llm.model) || 'glm-4.6', latencyMs: 0 };
    if (kind === 'style') return { raw: mock.mockStyleProfileRaw(messages), model: (cfg.llm && cfg.llm.model) || 'glm-4.6', latencyMs: 0 };
    if (kind === 'compose') return { raw: mock.mockComposeOutput(messages), model: (cfg.llm && cfg.llm.model) || 'glm-4.6', latencyMs: 0 };
    if (kind === 'aggregate') return { raw: mock.mockAggregateArticle(messages), model: (cfg.llm && cfg.llm.model) || 'glm-4.6', latencyMs: 0 };
    return mockLlmCall(cfg, messages.map((m) => m.content).join('\n'));
  }
  const llm = llmConfigOf(cfg);
  const apiKey = String(llm.apiKey || '').trim();
  if (!apiKey) throw inputError('API Key 未填写：请到「设置 → 大模型」填写后再生成');
  const model = String(llm.model || '').trim() || 'glm-4.6';
  const url = chatCompletionsUrl(llm.baseUrl);
  const payload = {
    model,
    messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user', content: m.content })),
    temperature: typeof llm.temperature === 'number' ? llm.temperature : 0.7,
  };
  const started = Date.now();
  const { text } = await requestWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    },
    deps
  );
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new LlmError(`LLM 返回内容不是 JSON：${snippet(text)}`);
  }
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string') {
    throw new LlmError(`LLM 返回格式异常（缺少 choices[0].message.content）：${snippet(text)}`);
  }
  return { raw: content, model: typeof data.model === 'string' ? data.model : model, latencyMs: Date.now() - started };
}

/**
 * 调用 LLM → {raw, model, latencyMs}（单条 user 消息的便捷形态，v1 管线沿用）。
 * payload：{model, messages:[{role:'user',content}], temperature}；Bearer 鉴权；超时 300s。
 * mock 模式在入口短路到确定性桩（fetch 不会被调用）。
 */
async function callLlm(cfg, prompt, deps = {}) {
  if (isMock()) return mockLlmCall(cfg, prompt);
  return callLlmMessages(cfg, [{ role: 'user', content: String(prompt) }], deps);
}

const LLM_FORMAT_RE = /===TITLE===\s*\n([\s\S]*?)\n===DIGEST===\s*\n([\s\S]*?)\n===BODY_HTML===\s*\n([\s\S]*)/;

/**
 * 解析 ===TITLE===/===DIGEST===/===BODY_HTML=== 输出。
 * 标题 ≤58 字（空白折叠、按码点截断）；摘要 ≤118 字（超长截断加 …）；正文为标记之后的原文（trim）。
 * 格式不符抛 LlmFormatError（pipeline 保留 raw_llm.txt 并自动重试 1 次）。
 */
function parseLlmOutput(raw) {
  const m = LLM_FORMAT_RE.exec(String(raw == null ? '' : raw));
  if (!m) {
    throw new LlmFormatError('LLM 输出不符合约定的 ===TITLE===/===DIGEST===/===BODY_HTML=== 格式');
  }
  const title = cpSlice(String(m[1]).replace(/\s+/g, ' ').trim(), MAX_TITLE);
  let digest = String(m[2]).replace(/\s+/g, ' ').trim();
  if (cpLen(digest) > MAX_DIGEST) digest = cpSlice(digest, MAX_DIGEST) + '…';
  const html = m[3].trim();
  return { title, digest, html };
}

/**
 * 测试连接 → {model, latencyMs}。
 * 先校验非空（mock 模式下空值仍报 E_INVALID_INPUT，与 IPC 契约一致），mock 命中则直接成功。
 */
async function probeLlm(cfg, deps = {}) {
  const llm = llmConfigOf(cfg);
  const apiKey = String(llm.apiKey || '').trim();
  const model = String(llm.model || '').trim();
  const baseUrl = String(llm.baseUrl || '').trim();
  if (!apiKey) throw inputError('API Key 未填写：填入后才能测试连接');
  if (!model) throw inputError('模型名未填写：例如 glm-4.6 或 deepseek-chat');
  const url = chatCompletionsUrl(baseUrl); // baseUrl 为空时抛 E_INVALID_INPUT
  if (isMock()) return { model, latencyMs: 0 };
  const started = Date.now();
  await requestWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '连接测试，请回复 OK' }],
        temperature: 0,
        max_tokens: 8,
      }),
    },
    { ...deps, timeoutMs: deps.timeoutMs || 30 * 1000 }
  );
  return { model, latencyMs: Date.now() - started };
}

module.exports = {
  LLM_TIMEOUT_MS,
  LLM_RETRY_ATTEMPTS,
  MAX_TITLE,
  MAX_DIGEST,
  WECHAT_HTML_RULES,
  ILLUSTRATION_RULES,
  LlmError,
  LlmFormatError,
  chatCompletionsUrl,
  requestWithRetry,
  buildPrompt,
  callLlm,
  callLlmMessages,
  parseLlmOutput,
  probeLlm,
};
