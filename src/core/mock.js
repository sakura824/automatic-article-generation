'use strict';
/**
 * mock.js —— mock 模式的唯一开关与确定性桩（契约 §4）。
 *
 * 开关唯一：isMock() = process.env.WECHAT_DAILY_MOCK === '1'。
 * llm.js 的 callLlm/probeLlm 与 wechat.js 所有网络函数在入口处先判 isMock()，
 * 命中则委托本模块的确定性桩——主进程侧零改动、渲染层零感知，npm test 亦用同一开关。
 *
 * 全部桩内容确定性、可断言：
 *   - token        = mock-token-<YYYYMMDD>
 *   - 封面 mediaId = mock-media-<sha256 前 8 位>
 *   - 草稿 mediaId = mock-draft-<序号 3 位>（进程内自增）
 *   - uploadimg    = mock://img/<序号>（进程内自增）
 *   - public-ip    = 192.0.2.10（RFC 5737 文档保留段，确定性）
 *   - LLM 返回固定 ===TITLE===/===DIGEST===/===BODY_HTML=== 样文（标题内嵌 prompt 中的日期）
 */

function isMock() {
  return process.env.WECHAT_DAILY_MOCK === '1';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时区 YYYYMMDD（mock token 的一部分，按天确定）。 */
function ymd(d) {
  const dt = d instanceof Date ? d : new Date();
  return `${dt.getFullYear()}${pad2(dt.getMonth() + 1)}${pad2(dt.getDate())}`;
}

/**
 * mock LLM 输出：固定样文，标题内嵌 prompt 中出现的第一个日期（YYYY-MM-DD），
 * 没有则用本地今天。对相同 prompt 输出字节一致，可直接断言。
 */
function mockLlmCall(cfg, prompt) {
  const m = /\d{4}-\d{2}-\d{2}/.exec(String(prompt || ''));
  const date = m ? m[0] : ymd().replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  const raw = [
    '===TITLE===',
    `【演示】${date} 的项目进展日报`,
    '===DIGEST===',
    '这是一篇 mock 模式的确定性样文：变更收集、AI 撰写与草稿箱上传链路已跑通；配置真实凭证后即可生成正式内容。',
    '===BODY_HTML===',
    `<p style="font-size:15px;color:#3f3f3f;line-height:1.75;">这是 <strong>mock 模式</strong> 输出的演示文章（${date}），用于在未接入真实大模型时验证整条流水线。</p>`,
    '<h2 style="color:#1a1a1a;">接下来做什么</h2>',
    '<ul style="font-size:15px;color:#3f3f3f;line-height:1.75;">',
    '<li>在「设置 → 大模型」填入 API Key 与模型名</li>',
    '<li>在「设置 → 公众号凭证」测试连接，并把本机公网 IP 加入白名单</li>',
    '<li>回到仪表盘点「立即生成并上传」</li>',
    '</ul>',
  ].join('\n');
  const model = (cfg && cfg.llm && cfg.llm.model) || 'glm-4.6';
  return { raw, model, latencyMs: 0 };
}

/** mock access_token：mock-token-<YYYYMMDD>，7200s。 */
function mockAccessToken(now) {
  return { token: `mock-token-${ymd(now || new Date())}`, expiresIn: 7200 };
}

/** mock 封面素材 mediaId：mock-media-<sha256 前 8 位>（同图指纹相同 → 缓存可复用）。 */
function mockCoverMediaId(sha256Hex) {
  return `mock-media-${String(sha256Hex).slice(0, 8)}`;
}

let draftSeq = 0;
let imgSeq = 0;

/** mock 草稿 mediaId：mock-draft-001、002…（进程内自增，确定可断言）。 */
function nextMockDraftId() {
  draftSeq += 1;
  return `mock-draft-${String(draftSeq).padStart(3, '0')}`;
}

/** mock 图床 URL：mock://img/001、002…（进程内自增，确定可断言）。 */
function nextMockImageUrl() {
  imgSeq += 1;
  return `mock://img/${String(imgSeq).padStart(3, '0')}`;
}

/** mock 本机公网 IP（RFC 5737 文档保留段，确定性、可断言）。 */
function mockPublicIp() {
  return '192.0.2.10';
}

/* ------------------------------------------------------------------ *
 * v2 增量桩（PRD v2：对话共创 / 素材成文 / 文风画像 / 全网聚合）
 * 全部确定性、可断言；mock 模式下各模块入口短路到这里，不发起任何网络。
 * ------------------------------------------------------------------ */

/** 取字符串前 n 个码点（避免 emoji 截半）。 */
function head(str, n) {
  return Array.from(String(str || '').trim()).slice(0, n).join('');
}

/** 取最近一条用户消息文本（无则空串）。 */
function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) return m.content.trim();
  }
  return '';
}

/**
 * mock 会话回复：引用最后一条用户消息开头，给三条固定追问，确定性。
 * 同一输入输出字节一致，可直接断言。
 */
function mockChatReply(messages) {
  const q = head(lastUserText(messages), 24) || '（空）';
  return [
    `【演示回复】收到你的想法：「${q}」。`,
    '为了把这轮讨论聊透，我想先确认三点：',
    '1. 这条内容最想给读者留下的一个印象是什么？',
    '2. 你希望开头从哪个场景或问题切入？',
    '3. 有没有已经想好要用到的例子或数字？',
    '补充完这几点后，你随时可以点「整理成文章」，我会按你的文风画像成稿。',
  ].join('\n');
}

/** 主题词清洗：多主题只取第一条；去掉首尾空白与「/ 、·，、：；-」等截断残留。 */
function cleanTopic(raw) {
  const first = String(raw || '').split(/\s+\/\s+|／/)[0];
  return first
    .replace(/^[\s/、，,·:：;；\-—–]+/, '')
    .replace(/[\s/、，,·:：;；\-—–]+$/, '')
    .trim();
}

/**
 * mock 成文输出（对话「整理成文章」/ 创作页「素材成文」共用，llm mockKind='compose'）：
 * ===TITLE===/===DIGEST===/===BODY_HTML=== 三段格式，标题内嵌主题词——
 * 取最后一条用户消息中「主题：」行（无则取正文前 14 字），确定性可断言。
 */
function mockComposeOutput(messages) {
  const last = String(lastUserText(messages));
  const m = /主题[：:]\s*(.+)/.exec(last);
  const topic = head(cleanTopic(m ? m[1] : last), 14) || '今天的想法';
  return [
    '===TITLE===',
    `【演示】${topic}的成文`,
    '===DIGEST===',
    `这是 mock 模式的确定性成文样文：围绕「${topic}」整理成稿，接入真实大模型后按你的文风画像输出正式内容。`,
    '===BODY_HTML===',
    `<p style="font-size:15px;color:#3f3f3f;line-height:1.75;">围绕<strong>${topic}</strong>，本文先把结论放在开头：这是一个演示稿件，用于在未接入真实大模型时验证成文链路。</p>`,
    // v2.3：带一条插图声明，让 e2e 能验证「<illus> → 渲染 → <img data:...>」整条链路
    '<illus type="summary" title="这篇稿子的三个要点" items="结构来自你提供的素材与讨论||文风按画像与禁用词约束注入||插图由本地模板渲染成图，不需要生图 Key"></illus>',
    '<h2 style="color:#1a1a1a;">为什么这样写</h2>',
    '<ul style="font-size:15px;color:#3f3f3f;line-height:1.75;">',
    '<li>结构来自你的素材/讨论，细节保留原意</li>',
    '<li>接入真实模型后，将按文风画像与禁用词约束成稿</li>',
    '</ul>',
  ].join('\n');
}

/**
 * mock 文风画像分析（llm mockKind='style'）：返回与真实 LLM 约定相同的 JSON 字符串，
 * 由 style.js 的解析器统一处理（含剥离 ```json 围栏）。qualitative 文案内嵌样文篇数
 * （从提示词「共 N 篇」提取，确定性）。
 */
function mockStyleProfileRaw(messages) {
  const joined = (Array.isArray(messages) ? messages : []).map((x) => x && x.content).join('\n');
  const m = /共\s*(\d+)\s*篇/.exec(joined);
  const n = m ? Number(m[1]) : 0;
  return JSON.stringify({
    opening: `【演示】多用场景或提问开头（基于 ${n} 篇样文统计）`,
    closing: '【演示】以一句行动建议或清单收尾',
    sentenceRhythm: '【演示】长短句交替，段落 2~4 句',
    petPhrases: n ? '【演示】样文中高频口头禅将在此列出' : '【演示】暂无样本',
    subtitleStyle: '【演示】短句式小标题，不排比',
    punctuationEmoji: '【演示】逗号为主，偶尔感叹号，不堆 emoji',
    bannedWordsExtra: ['深入探讨', '赋能'],
  });
}

/** mock 聚合成文输出（llm mockKind='aggregate'）：标题内嵌综合提示词「主题：」行前 14 字。 */
function mockAggregateArticle(messages) {
  const last = String(lastUserText(messages));
  const product = /产品名称：([^\n]+)/.exec(last);
  const productParagraph = product ? '<p>例如，在' + product[1].replace(/[<>&]/g, '') + '里，可以把已有的相关功能用于记录与复盘。这是依据所选代码资料生成的产品结合演示。</p>' : '';
  const m = /主题[：:]\s*(.+)/.exec(last);
  const topic = head(cleanTopic(m ? m[1] : last), 14) || '今日话题';
  return [
    '===TITLE===',
    `【演示】${topic}：一篇聚合科普`,
    '===DIGEST===',
    `这是 mock 模式的确定性聚合样文：围绕「${topic}」只提取来源中的事实与共识写成，未复用任何来源句式。`,
    '===BODY_HTML===',
    '<p style="font-size:15px;color:#3f3f3f;line-height:1.75;">先把结论放在开头：证据优先、循序渐进，这是演示稿件，用于验证「选题雷达 → 综合成文」链路。</p>',
    productParagraph,
    '<h2 style="color:#1a1a1a;">可以怎么做</h2>',
    '<p style="font-size:15px;color:#3f3f3f;line-height:1.75;">把大目标拆成每天可执行的小动作，记录并复盘，比一次性的狠劲更可靠。</p>',
  ].join('\n');
}

/**
 * mock 搜索结果：7 条确定性条目（领域无关：科技 / 教育 / 生活方式）——
 * 覆盖 L1（WHO/政府门户）、L2（arXiv/Nature）、L3（科普），
 * 含 1 组 URL 重复（index 1 与 6 同文不同参）与 1 组标题近似重复（index 2 与 5），
 * 供去重/分级/排序逻辑在 mock 下即可完整验证。
 */
const MOCK_SEARCH_RESULTS = [
  {
    title: 'WHO：青少年屏幕使用与睡眠建议要点',
    url: 'https://www.who.int/zh/news-room/fact-sheets/detail/screen-time-sleep',
    snippet: '世界卫生组织建议控制睡前屏幕使用、保持规律作息，为学习与休息留出充足时间。',
    publishedAt: '2026-10-28T00:00:00.000Z',
  },
  {
    title: '教育部：中小学人工智能通识教育指南（2024 年版）要点',
    url: 'https://www.gov.cn/zhengce/202402/ai-education-guide.html',
    snippet: '指南提出分学段普及通识内容、强化动手实践、坚持伦理教育三大原则。',
    publishedAt: '2026-10-27T00:00:00.000Z',
  },
  {
    title: '每周 150 分钟专注练习即可显著提升技能掌握率',
    url: 'https://arxiv.org/abs/2501.09901',
    snippet: '对照实验显示，达到每周 150 分钟刻意练习者技能测试成绩提升约 31%。',
    publishedAt: '2026-10-26T00:00:00.000Z',
  },
  {
    title: 'Nature 研究综述：间隔重复学习的频率与节奏建议',
    url: 'https://www.nature.com/articles/s41586-024-08333-x',
    snippet: '建议每周对核心知识点进行 2~3 次间隔复习，组间间隔 2~3 天。',
    publishedAt: '2026-10-20T00:00:00.000Z',
  },
  {
    title: '数字素养与技能提升行动核心任务速览',
    url: 'https://www.gov.cn/zhengce/202402/digital-literacy.html',
    snippet: '行动提出数字学习资源供给、全民数字素养培训等核心任务。',
    publishedAt: '2026-10-25T00:00:00.000Z',
  },
  {
    title: '每周 150 分钟专注练习显著提升技能掌握率（综述解读）',
    url: 'https://learnnote.example.com/150min-practice-review',
    snippet: '一篇科普综述解读了 150 分钟练习建议背后的研究证据。',
    publishedAt: '2026-10-28T08:00:00.000Z',
  },
  {
    title: '教育部：中小学人工智能通识教育指南（2024 年版）要点解读',
    url: 'https://www.gov.cn/zhengce/202402/ai-education-guide.html?utm_source=weibo',
    snippet: '带 utm 参数的重复链接，正文与 index 1 相同，用于验证 URL 去重。',
    publishedAt: '2026-10-27T00:00:00.000Z',
  },
];

/** mock 搜索：固定返回上述 7 条（与 query 无关，确定性）。 */
function mockSearchResults() {
  return MOCK_SEARCH_RESULTS.map((r) => ({ ...r }));
}

/** mock 抓取正文：已知 URL → 确定性 HTML（供 extractArticleText 提取）；未知 URL → E_NET（降级路径可测）。 */
function mockFetchArticle(url) {
  const known = MOCK_SEARCH_RESULTS.find((r) => r.url === url);
  if (!known) {
    const e = new Error(`mock 模式未提供该 URL 的正文样例：${url}`);
    e.code = 'E_NET';
    throw e;
  }
  return [
    '<!doctype html><html><head><title>' + known.title + '</title></head><body>',
    '<nav>导航链接（应被剔除）</nav>',
    '<article>',
    '<h1>' + known.title + '</h1>',
    '<p>' + known.snippet + '</p>',
    '<p>正文第二段：本文只讨论公开的权威共识，不构成个体化建议；具体执行请结合自身情况调整。</p>',
    '<p>正文第三段：证据显示，规律复盘与持续迭代是最有共识的两大抓手；任何承诺快速见效的说法都应保持警惕。</p>',
    '</article>',
    '<footer>版权信息（应被剔除）</footer>',
    '</body></html>',
  ].join('\n');
}

module.exports = {
  isMock,
  mockLlmCall,
  mockAccessToken,
  mockCoverMediaId,
  nextMockDraftId,
  nextMockImageUrl,
  mockPublicIp,
  // v2 增量桩（chat / compose / style / aggregate，与 llm.js mockKind 路由对应）
  mockChatReply,
  mockComposeOutput,
  mockStyleProfileRaw,
  mockAggregateArticle,
  mockSearchResults,
  mockFetchArticle,
  MOCK_SEARCH_RESULTS,
};
