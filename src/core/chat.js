'use strict';
/**
 * chat.js —— 对话共创会话模块。
 *
 * 职责：
 * - 会话对象与多轮消息（newSession/addMessage），本地持久化（persist.js，dataDir/sessions/<id>.json）；
 * - 上下文组装（buildChatContext）：system（项目背景 + 文风约束）+ 最近 N 条消息；
 * - 会话回复（chatReply）：多消息 LLM 调用（llm.callLlmMessages，mockKind='chat'）；
 * - 「整理成文章」指令（isComposeCommand / composeFromSession）：把整轮讨论整理为
 *   ===TITLE===/===DIGEST===/===BODY_HTML=== 格式的文章；
 * - 创作页「素材成文」（buildMaterialPrompt / composeMaterial）。
 *
 * 依赖注入：LLM 调用统一走 llm.callLlmMessages（fetch/超时可经 deps 注入，测试零真实网络；
 * mock 模式由 llm.js 入口按 mockKind 短路到 mock.js 确定性桩）。仅 Node 内置模块。
 */
const path = require('node:path');
const { jsonFiles, readJson, writeJson, removeJson, ioError } = require('./persist');
const { callLlmMessages, parseLlmOutput, WECHAT_HTML_RULES, ILLUSTRATION_RULES } = require('./llm');
const configCore = require('./config');

/** 上下文默认携带的最大消息条数（不含 system）。 */
const DEFAULT_MAX_TURNS = 20;
/** 整理成文/素材成文时，单条历史消息在提示词中的截断长度。 */
const MAX_TRANSCRIPT_MSG_CHARS = 2000;
/** 「整理成文章」触发词。 */
const COMPOSE_COMMAND_RE = /整理成\s*一?\s*篇?\s*文章|生成文章|整理成文/;

function inputError(message) {
  const e = new Error(message);
  e.code = 'E_INVALID_INPUT';
  return e;
}

function sessionDir(dataDir) {
  return path.join(dataDir, 'sessions');
}

function isoNow(now) {
  return (now ? new Date(now) : new Date()).toISOString();
}

/**
 * 新建会话 → {id, title, createdAt, updatedAt, messages:[]}。
 * id 缺省由时间戳生成（dataDir 内自动避让重名，saveSession 兜底）；测试可显式传 id。
 */
function newSession({ id, title, now } = {}) {
  const t = isoNow(now);
  const sid = String(id || `chat-${t.replace(/[-:.TZ]/g, '')}`);
  return { id: sid, title: String(title || '').trim(), createdAt: t, updatedAt: t, messages: [] };
}

/**
 * 追加一条消息 → 返回该消息（引用）。
 * role ∈ 'user'|'assistant'；content 必须为非空字符串（trim 后）。
 */
function addMessage(session, { role, content, now } = {}) {
  if (!session || !Array.isArray(session.messages)) throw inputError('addMessage 需要会话对象');
  if (!['user', 'assistant'].includes(role)) {
    throw inputError(`消息 role 只能为 user / assistant，收到：${role}`);
  }
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) throw inputError('消息内容不能为空');
  const msg = { role, content: text, t: isoNow(now) };
  session.messages.push(msg);
  session.updatedAt = msg.t;
  if (role === 'user' && !session.title) {
    session.title = Array.from(text).slice(0, 20).join('');
  }
  return msg;
}

/** 持久化会话（dataDir/sessions/<id>.json，原子写；id 作文件名不合法字符替换为 _）。 */
function saveSession(dataDir, session) {
  if (!dataDir) throw ioError('保存会话失败：缺少数据目录');
  if (!session || !session.id) throw inputError('saveSession 需要带 id 的会话对象');
  const name = `${String(session.id).replace(/[\\/:*?"<>|]/g, '_')}.json`;
  writeJson(sessionDir(dataDir), name, session);
  return session;
}

/** 读取会话：不存在 → null；损坏 → E_IO。 */
function loadSession(dataDir, id) {
  const name = `${String(id || '').replace(/[\\/:*?"<>|]/g, '_')}.json`;
  return readJson(path.join(sessionDir(dataDir), name));
}

/** 删除会话（幂等）。 */
function deleteSession(dataDir, id) {
  const name = `${String(id || '').replace(/[\\/:*?"<>|]/g, '_')}.json`;
  return removeJson(sessionDir(dataDir), name);
}

/** 会话列表（按更新时间倒序）：[{id, title, updatedAt, createdAt, turns, lastMessage}]。 */
function listSessions(dataDir) {
  return jsonFiles(sessionDir(dataDir))
    .map((file) => {
      try {
        return readJson(file);
      } catch (e) {
        const bad = ioError(`会话文件损坏：${path.basename(file)}（${e.message}，可删除该文件后重试）`);
        bad.file = file;
        throw bad;
      }
    })
    .filter(Boolean)
    .map((s) => ({
      id: s.id,
      title: s.title || (s.messages && s.messages[0] && Array.from(s.messages[0].content).slice(0, 20).join('')) || '',
      createdAt: s.createdAt || null,
      updatedAt: s.updatedAt || null,
      turns: Array.isArray(s.messages) ? s.messages.length : 0,
      lastMessage:
        s.messages && s.messages.length ? Array.from(s.messages[s.messages.length - 1].content).slice(0, 60).join('') : '',
    }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

/** 项目背景块（config.project：description/techTerms/audience/styleExtra），无内容返回空串。 */
function buildProjectBlock(project) {
  const p = project || {};
  const lines = [];
  if (p.description) lines.push(`- 系统简介：${p.description}`);
  if (p.techTerms) lines.push(`- 术语表：${p.techTerms}`);
  if (p.audience) lines.push(`- 受众：${p.audience}`);
  if (p.styleExtra) lines.push(`- 风格补充：${p.styleExtra}`);
  return lines.length ? `【项目背景】\n${lines.join('\n')}` : '';
}

/** 对话模式 system 提示词：写作搭档定位 + 项目背景 + 文风约束（可选）。 */
function buildSystemPrompt({ project, styleInjection } = {}) {
  const parts = [
    '你是用户的公众号写作搭档，正在与用户多轮对话：主动追问细节、给出结构与素材建议，帮用户把想法聊清楚。用户没有明确要求成文时，不要输出整篇文章；用词与用户的项目保持一致。',
  ];
  const pb = buildProjectBlock(project);
  if (pb) parts.push(pb);
  if (styleInjection) parts.push(String(styleInjection).trim());
  return parts.join('\n\n');
}

/**
 * 组装多轮上下文 → {messages, dropped}。
 * messages = [system?, ...最近 maxTurns 条消息]；超出部分从最旧一侧丢弃并计入 dropped。
 */
/** 多轮上下文总字符预算（system 之外）：条数达标后按字符从最旧一侧继续丢弃，避免把模型上下文顶爆。 */
const MAX_CONTEXT_CHARS = 24000;
/** 成文提示词里「讨论记录」区块的字符预算。 */
const MAX_TRANSCRIPT_CHARS = 24000;

function buildChatContext(session, { system, maxTurns = DEFAULT_MAX_TURNS, maxChars = MAX_CONTEXT_CHARS } = {}) {
  const history = (session && Array.isArray(session.messages) ? session.messages : []).filter(
    (m) => m && typeof m.content === 'string' && m.content.trim()
  );
  const kept = history.slice(-Math.max(1, maxTurns));
  let chars = kept.reduce((n, m) => n + Array.from(m.content).length, 0);
  const max = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : MAX_CONTEXT_CHARS;
  while (kept.length > 1 && chars > max) {
    const removed = kept.shift();
    chars -= Array.from(removed.content).length;
  }
  const messages = [];
  const sys = String(system || '').trim();
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of kept) messages.push({ role: m.role, content: m.content });
  return { messages, dropped: history.length - kept.length };
}

/** 项目背景取值：opts 显式传入优先，否则回退 cfg.project（三处成文/对话入口共用）。 */
function projectOf(cfg, opts = {}) {
  // 未显式传入时按 config.projectContext 合并 project.* 与 content.audience/styleExtra
  return opts.project !== undefined ? opts.project : configCore.projectContext(cfg);
}

/**
 * 会话回复：组装上下文 → LLM → 追加 assistant 消息。
 * 返回 {session, reply:{role,content,t}, raw, model}；网络/格式错误原样抛出（IPC 层转信封）。
 * deps 透传给 callLlmMessages（fetch/timeoutMs/retryDelayMs 可注入）。
 */
async function chatReply(cfg, session, { deps = {}, project, styleInjection, maxTurns } = {}) {
  const opts = { project, styleInjection };
  const context = buildChatContext(session, {
    system: buildSystemPrompt({ project: projectOf(cfg, opts), styleInjection }),
    maxTurns,
  });
  const { raw, model } = await callLlmMessages(cfg, context.messages, { ...deps, mockKind: 'chat' });
  const reply = addMessage(session, { role: 'assistant', content: raw, now: deps.now });
  return { session, reply, raw, model, dropped: context.dropped };
}

/** 「整理成文章」指令识别（对话页按钮/输入框共用）。 */
function isComposeCommand(text) {
  return COMPOSE_COMMAND_RE.test(String(text || ''));
}

/** 单条消息在成文提示词中的截断。 */
function clipMsg(text) {
  const s = String(text || '').trim();
  return Array.from(s).length > MAX_TRANSCRIPT_MSG_CHARS
    ? `${Array.from(s).slice(0, MAX_TRANSCRIPT_MSG_CHARS).join('')}…（已截断）`
    : s;
}

/** 会话转编号文本（按时间顺序）。 */
function transcript(session) {
  const all = (session && Array.isArray(session.messages) ? session.messages : []).filter((m) => m && m.content);
  const lines = all.map((m, i) => `[${i + 1}] ${m.role === 'user' ? '用户' : '助手'}：${clipMsg(m.content)}`);
  let total = lines.reduce((n, l) => n + Array.from(l).length + 1, 0);
  let start = 0;
  while (start < lines.length - 1 && total > MAX_TRANSCRIPT_CHARS) {
    total -= Array.from(lines[start]).length + 1;
    start += 1;
  }
  const kept = lines.slice(start);
  if (start > 0) kept.unshift(`（早期 ${start} 条消息因长度限制未纳入本次成文）`);
  return kept.join('\n');
}

/**
 * 成文公共规则块（v1 ===TITLE=== 约定格式 + 微信适配 HTML，与 buildPrompt 同一口径）。
 * v2.3：微信 HTML 约束与插图规范改为直接引用 llm.js 的常量——此前这里是复制粘贴的第二份，
 * 改一处漏一处就会让「素材成文」和「仓库自动」的排版要求悄悄分叉。
 */
const FORMAT_RULES = `输出要求：
1. 标题不超过 24 个字；摘要不超过 100 字。
2. 正文 800~1200 字。${WECHAT_HTML_RULES}
${ILLUSTRATION_RULES}
3. 严格按下面的格式输出，除该格式外不要输出任何内容：
===TITLE===
标题
===DIGEST===
摘要
===BODY_HTML===
<p>正文 HTML</p>`;

/** 会话主题词（标题或第一条用户消息前 20 字，用于提示词「主题：」行，mock 桩据此内嵌标题）。 */
/**
 * 会话主题词（用于提示词「主题：」行，mock 桩据此内嵌标题）。
 * 优先级：最近一条用户消息里显式写的「主题：…」→ 会话标题 → 首条用户消息前 20 字。
 * 只取会话标题会让后续轮次里写的「主题：…」失效，成文主题停在第一轮内容。
 */
function sessionTopic(session) {
  const msgs = (session && Array.isArray(session.messages) ? session.messages : []).filter((m) => m && m.role === 'user' && m.content);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = /主题[：:]\s*([^\n]+)/.exec(String(msgs[i].content));
    if (m && m[1] && m[1].trim()) return Array.from(m[1].trim()).slice(0, 40).join('');
  }
  const t = (session && session.title) || '';
  if (t) return Array.from(t).slice(0, 20).join('');
  const first = msgs[0];
  return first ? clipMsg(Array.from(first.content).slice(0, 20).join('')) : '';
}

/**
 * 「整理成文章」提示词（单条 user 消息）：成文规则 + 项目背景 + 文风约束 + 编号讨论记录。
 */
function buildComposePrompt(session, { project, styleInjection } = {}) {
  const parts = [
    '请把下面这轮讨论整理成一篇公众号文章：提炼已确认的想法与结论、补全逻辑，不要引入讨论中不存在的事实。',
    `主题：${sessionTopic(session)}`,
  ];
  const pb = buildProjectBlock(project);
  if (pb) parts.push(pb);
  if (styleInjection) parts.push(String(styleInjection).trim());
  parts.push(`本轮讨论记录（按时间顺序）：\n---\n${transcript(session)}\n---`);
  parts.push(FORMAT_RULES);
  return parts.join('\n\n');
}

/**
 * 对话 → 文章：===TITLE=== 解析交给 parseLlmOutput。
 * 返回 {article:{title,digest,html}, raw, model}。
 */
async function composeFromSession(cfg, session, { deps = {}, project, styleInjection } = {}) {
  const msgs = (session && session.messages) || [];
  if (!msgs.some((m) => m && m.role === 'user' && m.content && m.content.trim())) {
    throw inputError('对话为空，没有可整理的内容：先和 AI 聊几句再点「整理成文章」');
  }
  const proj = projectOf(cfg, { project });
  const messages = [];
  const sys = buildSystemPrompt({ project: proj, styleInjection });
  if (sys) messages.push({ role: 'system', content: sys });
  messages.push({ role: 'user', content: buildComposePrompt(session, { project: proj, styleInjection }) });
  const { raw, model } = await callLlmMessages(cfg, messages, { ...deps, mockKind: 'compose' });
  return { article: parseLlmOutput(raw), raw, model };
}

/**
 * 创作页「素材成文」提示词。
 */
function buildMaterialPrompt({ material, emphasis, project, styleInjection } = {}) {
  const mat = clipMsg(material);
  if (!mat) throw inputError('素材为空：请先粘贴要点、草稿或链接摘要等素材');
  const point = String(emphasis || '').trim();
  const topic = point ? Array.from(point).slice(0, 20).join('') : clipMsg(Array.from(mat).slice(0, 20).join(''));
  const parts = [
    '请根据下面的素材写一篇公众号文章：以素材为准展开，围绕「想强调的点」组织详略，不要引入素材之外的事实。',
    `主题：${topic}`,
  ];
  if (point) parts.push(`今天想强调的点：${point}`);
  const pb = buildProjectBlock(project);
  if (pb) parts.push(pb);
  if (styleInjection) parts.push(String(styleInjection).trim());
  parts.push(`素材：\n---\n${mat}\n---`);
  parts.push(FORMAT_RULES);
  return parts.join('\n\n');
}

/**
 * 「只给一个题目」的成文提示词（内容池条目没填素材时使用，v2.2 增量）。
 * 与 buildMaterialPrompt 的差别：没有素材可循，所以要**明确禁止编造事实**，
 * 并要求给出可执行做法而非空泛科普；格式与文风硬约束沿用同一份 FORMAT_RULES。
 */
function buildTopicPrompt({ topic, emphasis, project, styleInjection } = {}) {
  const t = String(topic || '').trim();
  if (!t) throw inputError('题目为空：内容池条目需要一条题目');
  const point = String(emphasis || '').trim();
  const parts = [
    '请围绕下面这个题目写一篇公众号文章。注意：',
    '1. 不要写成教科书式的科普通稿，给出可执行的做法、判断标准和常见误区；',
    '2. 可以讲公认常识，但**不要编造具体数据、研究结论、机构名称或引文**；不确定的地方用「通常」「多数情况下」这类限定表述；',
    '3. 详略围绕题目本身，不要凑字数。',
    `主题：${Array.from(t).slice(0, 20).join('')}`,
  ];
  if (point) parts.push(`今天想强调的点：${point}`);
  const pb = buildProjectBlock(project);
  if (pb) parts.push(pb);
  if (styleInjection) parts.push(String(styleInjection).trim());
  parts.push(`题目：${t}`);
  parts.push(FORMAT_RULES);
  return parts.join('\n\n');
}

/** 素材 → 文章（与 composeFromSession 同一解析与 mock 路由，mockKind='compose'）。 */
async function composeMaterial(cfg, { material, emphasis, project, styleInjection, deps = {} } = {}) {
  const prompt = buildMaterialPrompt({ material, emphasis, project: projectOf(cfg, { project }), styleInjection });
  const { raw, model } = await callLlmMessages(cfg, [{ role: 'user', content: prompt }], { ...deps, mockKind: 'compose' });
  return { article: parseLlmOutput(raw), raw, model, prompt };
}

/**
 * 内容池条目 → 文章（定时任务用，v2.2 增量）。两条分支：
 * - 有条目素材 → 等义于「素材成文」（composeMaterial）；
 * - 只有题目 → buildTopicPrompt（禁止编造事实的展开式提示词）。
 * 返回形状与 composeMaterial 一致：{article:{title,digest,html}, raw, model, prompt}。
 */
async function composeTopic(cfg, { topic, material, emphasis, project, styleInjection, deps = {} } = {}) {
  const mat = String(material || '').trim();
  const point = String(emphasis || '').trim() || String(topic || '').trim();
  if (mat) return composeMaterial(cfg, { material: mat, emphasis: point, project, styleInjection, deps });
  const prompt = buildTopicPrompt({ topic, emphasis, project: projectOf(cfg, { project }), styleInjection });
  const { raw, model } = await callLlmMessages(cfg, [{ role: 'user', content: prompt }], { ...deps, mockKind: 'compose' });
  return { article: parseLlmOutput(raw), raw, model, prompt };
}

module.exports = {
  DEFAULT_MAX_TURNS,
  MAX_TRANSCRIPT_MSG_CHARS,
  COMPOSE_COMMAND_RE,
  sessionDir,
  newSession,
  addMessage,
  saveSession,
  loadSession,
  deleteSession,
  listSessions,
  buildProjectBlock,
  projectOf,
  buildSystemPrompt,
  buildChatContext,
  chatReply,
  isComposeCommand,
  buildComposePrompt,
  composeFromSession,
  buildMaterialPrompt,
  composeMaterial,
  buildTopicPrompt,
  composeTopic,
};
