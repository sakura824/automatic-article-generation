'use strict';
/**
 * aggregate.test.js —— 全网聚合成文模块（真实模式，WECHAT_DAILY_MOCK 必须未设置）：
 * 搜索适配层（三家请求构造/响应解析/重试/校验）、正文提取与抓取、来源分级、
 * 白名单/URL/标题去重、热度排序、选题清单、选题雷达（注入 fetch）、
 * n-gram 相似度阈值与重写信号、综合成文（护栏提示词/落盘/敏感闸/降级/重写循环）、错误路径。
 * mock 桩与 mock 端到端在 v2-mock.test.js 覆盖。
 */
delete process.env.WECHAT_DAILY_MOCK;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const aggregate = require('../src/core/aggregate');
const state = require('../src/core/state');
const { res, router, tmpDir } = require('./helpers');

const CFG = {
  llm: { baseUrl: 'https://llm.example.com/v4', apiKey: 'sk-agg', model: 'glm-4.6', temperature: 0.7 },
  project: { description: '习惯打卡小程序', audience: '效率工具用户' },
  aggregate: {
    keywords: ['科技', '生活方式'],
    whitelist: [],
    searchProvider: 'bocha',
    searchApiKey: 'bocha-key',
    dailyLimit: 10,
    similarityThreshold: 0.3,
    verticalNotice: { enabled: false, text: '' },
  },
};

const fmt = (title, digest, html) => `===TITLE===\n${title}\n===DIGEST===\n${digest}\n===BODY_HTML===\n${html}`;

const BOCHA_OK = JSON.stringify({
  code: 200,
  data: {
    webPages: {
      value: [
        { name: 'WHO 健康饮食', url: 'https://www.who.int/zh/news/fact-1', snippet: 's1', dateLastCrawled: '2026-10-28T00:00:00Z' },
        { name: '无日期条目', url: 'https://blog.example.com/x', snippet: 's2' },
        { name: '坏条目', url: 'not-a-url', snippet: ' dropped' },
        { name: '', url: 'https://empty.example.com/', snippet: ' dropped too' },
      ],
    },
  },
});

/* ------------------------------ 搜索适配层 ------------------------------ */

test('ADAPTERS.bocha：POST 请求构造（Bearer/summary/freshness）与响应解析归一化', async () => {
  const req = aggregate.ADAPTERS.bocha.buildRequest({ apiKey: 'k1', query: '科技', count: 7 });
  assert.strictEqual(req.url, 'https://api.bochaai.com/v1/web-search');
  assert.strictEqual(req.init.method, 'POST');
  assert.strictEqual(req.init.headers.Authorization, 'Bearer k1');
  assert.deepStrictEqual(JSON.parse(req.init.body), { query: '科技', count: 7, summary: true, freshness: 'oneWeek' });

  const { fetch, calls } = router([[/bochaai/, () => res(200, BOCHA_OK)]]);
  const items = await aggregate.searchWeb({ provider: 'bocha', apiKey: 'k1', query: '科技', count: 7 }, { fetch, retryDelayMs: 0 });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(items.length, 2); // 坏 URL/空标题被丢弃
  assert.deepStrictEqual(items[0], {
    title: 'WHO 健康饮食',
    url: 'https://www.who.int/zh/news/fact-1',
    snippet: 's1',
    publishedAt: '2026-10-28T00:00:00.000Z',
    rawRank: 0,
  });
  assert.strictEqual(items[1].publishedAt, null);
});

test('ADAPTERS.tavily / serpapi：请求构造与解析', async () => {
  const tv = aggregate.ADAPTERS.tavily.buildRequest({ apiKey: 'kt', query: 'q', count: 5 });
  assert.strictEqual(tv.url, 'https://api.tavily.com/search');
  assert.deepStrictEqual(JSON.parse(tv.init.body), { query: 'q', max_results: 5, search_depth: 'basic', include_answer: false });
  const tvItems = aggregate.ADAPTERS.tavily.parseResponse(
    JSON.stringify({ results: [{ title: 'T', url: 'https://a.example.com/', content: 'c', published_date: '2026-10-27' }] })
  );
  assert.strictEqual(tvItems[0].snippet, 'c');

  const sp = aggregate.ADAPTERS.serpapi.buildRequest({ apiKey: 'ks', query: 'qq', count: 3 });
  assert.ok(sp.url.startsWith('https://serpapi.com/search.json?'));
  assert.ok(sp.url.includes('engine=google'));
  assert.ok(sp.url.includes('api_key=ks'));
  const spItems = aggregate.ADAPTERS.serpapi.parseResponse(
    JSON.stringify({ organic_results: [{ title: 'S', link: 'https://b.example.com/', snippet: 'sn', date: '2026-10-01' }] })
  );
  assert.strictEqual(spItems[0].url, 'https://b.example.com/');
});

const DEEPSEEK_OK = JSON.stringify({
  results: [
    { title: '儿童分级阅读指南', url: 'https://www.example-edu.cn/a/1', snippet: 's1', date: '2026-10-28T00:00:00Z', authority: 3 },
    { title: '只有 summary 的条目', url: 'https://www.example-edu.cn/a/2', summary: '用摘要兜底' },
    { title: '', url: 'https://bad.example.com/', snippet: '空标题丢弃' },
    { title: '坏链接', url: 'not-a-url', snippet: '丢弃' },
  ],
});

test('ADAPTERS.deepseek：域名写死（不跟随 baseUrl）与响应归一化', async () => {
  const req = aggregate.ADAPTERS.deepseek.buildRequest({ apiKey: 'sk-llm', query: '绘本', count: 5 });
  assert.strictEqual(req.url, 'https://api.deepseek.com/v1/tools/search');
  assert.strictEqual(req.init.method, 'POST');
  assert.strictEqual(req.init.headers.Authorization, 'Bearer sk-llm');
  assert.deepStrictEqual(JSON.parse(req.init.body), { query: '绘本', count: 5 });

  // v2.2 修正的核心：即使调用方给了 baseUrl（换了大模型），地址也不得跟随。
  // 跟随会拼出 open.bigmodel.cn/api/paas/v4/tools/search 这种不存在的地址 → 用户只看到 404。
  const foreign = aggregate.ADAPTERS.deepseek.buildRequest({
    apiKey: 'k', query: 'q', count: 1, baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  });
  assert.strictEqual(foreign.url, 'https://api.deepseek.com/v1/tools/search');

  const { fetch, calls } = router([[/deepseek\.com/, () => res(200, DEEPSEEK_OK)]]);
  const items = await aggregate.searchWeb(
    { provider: 'deepseek', apiKey: 'sk-llm', query: '绘本', count: 5 },
    { fetch, retryDelayMs: 0 }
  );
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(items.length, 2); // 空标题 / 坏链接被丢弃
  assert.strictEqual(items[0].title, '儿童分级阅读指南');
  assert.strictEqual(items[0].snippet, 's1');
  assert.strictEqual(items[0].publishedAt, '2026-10-28T00:00:00.000Z');
  assert.strictEqual(items[1].snippet, '用摘要兜底'); // snippet 缺失回退 summary
  assert.strictEqual(items[1].publishedAt, null);
});

test('ADAPTERS.bigmodel：字段名（search_query/search_engine）与 search_result 归一化', async () => {
  const req = aggregate.ADAPTERS.bigmodel.buildRequest({ apiKey: 'glm-key', query: '绘本', count: 6 });
  assert.strictEqual(req.url, 'https://open.bigmodel.cn/api/paas/v4/web_search');
  assert.strictEqual(req.init.headers.Authorization, 'Bearer glm-key');
  const body = JSON.parse(req.init.body);
  assert.strictEqual(body.search_query, '绘本'); // 智谱用 search_query，不是 query
  assert.strictEqual(body.search_engine, 'search_std');
  assert.strictEqual(body.count, 6);

  const ok = JSON.stringify({
    search_result: [
      { title: '官方媒体周报', link: 'https://www.gov.cn/a/1', content: '内容一', media: '官方媒体', publish_date: '2026-10-20' },
      { title: '', link: 'https://bad.example.com/', content: '空标题丢弃' },
    ],
  });
  const { fetch, calls } = router([[/bigmodel\.cn/, () => res(200, ok)]]);
  const items = await aggregate.searchWeb({ provider: 'bigmodel', apiKey: 'glm-key', query: '绘本', count: 6 }, { fetch, retryDelayMs: 0 });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].url, 'https://www.gov.cn/a/1'); // link → url
  assert.strictEqual(items[0].snippet, '内容一');                // content → snippet
  assert.strictEqual(items[0].publishedAt, '2026-10-20T00:00:00.000Z');
});

test('搜索返回业务错误体 → 报可读原因（而不是"缺少 results"）', async () => {
  const { fetch } = router([[/deepseek\.com/, () => res(200, JSON.stringify({ error: { code: '401', message: '无效的令牌' } }))]]);
  await assert.rejects(
    () => aggregate.searchWeb({ provider: 'deepseek', apiKey: 'bad', query: 'q', count: 5 }, { fetch, retryDelayMs: 0 }),
    (e) => {
      assert.match(e.message, /无效的令牌/);
      return true;
    }
  );
});

test('aggregateConfigOf：Key 复用要求「通道是厂商自带」且「大模型同一家」', () => {
  // 大模型 DeepSeek + 通道 deepseek → 复用
  const dsMatch = aggregate.aggregateConfigOf({
    llm: { apiKey: 'sk-llm', baseUrl: 'https://api.deepseek.com' },
    aggregate: { searchProvider: 'deepseek', searchApiKey: '' },
  });
  assert.strictEqual(dsMatch.apiKey, 'sk-llm');
  assert.strictEqual(dsMatch.keyFromLlm, true);
  assert.strictEqual(dsMatch.canReuseLlmKey, true);
  assert.strictEqual(dsMatch.llmNativeProvider, 'deepseek');

  // 换了大模型（智谱）却仍选 deepseek：不得复用，否则会把智谱 Key 发到 DeepSeek 域名
  const switched = aggregate.aggregateConfigOf({
    llm: { apiKey: 'glm-key', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    aggregate: { searchProvider: 'deepseek', searchApiKey: '' },
  });
  assert.strictEqual(switched.apiKey, '');
  assert.strictEqual(switched.canReuseLlmKey, false);
  assert.strictEqual(switched.keyFromLlm, false);
  assert.strictEqual(switched.llmNativeProvider, 'bigmodel'); // 用于提示「可改选智谱」
  assert.strictEqual(switched.providerHost, 'api.deepseek.com');

  // 大模型智谱 + 通道 bigmodel → 复用
  const glm = aggregate.aggregateConfigOf({
    llm: { apiKey: 'glm-key', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    aggregate: { searchProvider: 'bigmodel', searchApiKey: '' },
  });
  assert.strictEqual(glm.apiKey, 'glm-key');
  assert.strictEqual(glm.keyFromLlm, true);

  // 换到 Moonshot：两家 native 通道都不可复用，llmNativeProvider 为 null（提示只能用独立搜索服务）
  const kimi = aggregate.aggregateConfigOf({
    llm: { apiKey: 'sk-kimi', baseUrl: 'https://api.moonshot.cn/v1' },
    aggregate: { searchProvider: 'deepseek', searchApiKey: '' },
  });
  assert.strictEqual(kimi.apiKey, '');
  assert.strictEqual(kimi.llmNativeProvider, null);

  // 独立搜索服务永不回退：把大模型 Key 发给第三方既会 401 也是凭证泄露
  const bocha = aggregate.aggregateConfigOf({
    llm: { apiKey: 'sk-llm', baseUrl: 'https://api.deepseek.com' },
    aggregate: { searchProvider: 'bocha', searchApiKey: '' },
  });
  assert.strictEqual(bocha.apiKey, '');
  assert.strictEqual(bocha.providerNative, false);

  // 自己填了 Key 优先用独立 Key
  const own = aggregate.aggregateConfigOf({
    llm: { apiKey: 'sk-llm', baseUrl: 'https://api.deepseek.com' },
    aggregate: { searchProvider: 'deepseek', searchApiKey: 'sk-own' },
  });
  assert.strictEqual(own.apiKey, 'sk-own');
  assert.strictEqual(own.keyFromLlm, false);
});

test('searchWeb 校验与错误路径：provider/Key/query/count；HTTP 与格式异常', async () => {
  await assert.rejects(() => aggregate.searchWeb({ provider: 'baidu', apiKey: 'k', query: 'q' }, {}), (e) => e.code === 'E_INVALID_INPUT');
  await assert.rejects(() => aggregate.searchWeb({ provider: 'bocha', apiKey: '', query: 'q' }, {}), (e) => e.code === 'E_INVALID_INPUT');
  await assert.rejects(() => aggregate.searchWeb({ provider: 'bocha', apiKey: 'k', query: '  ' }, {}), (e) => e.code === 'E_INVALID_INPUT');
  await assert.rejects(() => aggregate.searchWeb({ provider: 'bocha', apiKey: 'k', query: 'q', count: 99 }, {}), (e) => e.code === 'E_INVALID_INPUT');

  // HTTP 401 → 立即失败不重试
  const { fetch: f401, calls: c401 } = router([[/bochaai/, () => res(401, 'unauthorized')]]);
  await assert.rejects(
    () => aggregate.searchWeb({ provider: 'bocha', apiKey: 'k', query: 'q', count: 5 }, { fetch: f401, retryDelayMs: 0 }),
    (e) => {
      assert.strictEqual(e.code, 'E_NET');
      assert.match(e.message, /HTTP 401/);
      return true;
    }
  );
  assert.strictEqual(c401.length, 1);

  // 500 连续 3 次 → E_NET
  const { fetch: f500, calls: c500 } = router([[/bochaai/, () => res(500, 'boom')]]);
  await assert.rejects(
    () => aggregate.searchWeb({ provider: 'bocha', apiKey: 'k', query: 'q', count: 5 }, { fetch: f500, retryDelayMs: 0 }),
    (e) => e.code === 'E_NET'
  );
  assert.strictEqual(c500.length, 3);

  // 响应缺 webPages.value → 格式异常
  const { fetch: fbad } = router([[/bochaai/, () => res(200, '{"code":200}')]]);
  await assert.rejects(
    () => aggregate.searchWeb({ provider: 'bocha', apiKey: 'k', query: 'q', count: 5 }, { fetch: fbad, retryDelayMs: 0 }),
    (e) => {
      assert.strictEqual(e.code, 'E_NET');
      assert.match(e.message, /格式异常/);
      return true;
    }
  );

  // 网络错误重试后成功
  let n = 0;
  const flaky = async () => {
    n += 1;
    if (n < 3) throw new TypeError('fetch failed');
    return res(200, BOCHA_OK);
  };
  const items = await aggregate.searchWeb({ provider: 'bocha', apiKey: 'k', query: 'q', count: 5 }, { fetch: flaky, retryDelayMs: 0 });
  assert.strictEqual(n, 3);
  assert.ok(items.length >= 1);
});

/* ------------------------------ 正文提取与抓取 ------------------------------ */

test('extractArticleText：title 取 h1、article 优先、噪声块剔除、实体解码、段落化', () => {
  const html = [
    '<html><head><title>页面标题 | 站点名</title></head><body>',
    '<nav>导航</nav>',
    '<article><h1>文章大标题</h1><p>第一段 &ldquo;内容&rdquo;。</p><p>第二段&#x4e8c;内容。</p>',
    '<script>x()</script><style>.a{}</style></article>',
    '<footer>页脚</footer></body></html>',
  ].join('\n');
  const r = aggregate.extractArticleText(html);
  assert.strictEqual(r.title, '文章大标题');
  assert.ok(r.text.includes('第一段 “内容”。'));
  assert.ok(r.text.includes('第二段二内容。'));
  assert.ok(!r.text.includes('导航'));
  assert.ok(!r.text.includes('页脚'));
  assert.deepStrictEqual(r.paragraphs.length >= 2, true);
});

test('fetchArticle：注入 fetch 抓取并提取；非 2xx/空正文 → E_NET；非法 URL → E_INVALID_INPUT', async () => {
  const { fetch, calls } = router([[/example\.com\/a/, () => res(200, '<h1>标题</h1><p>正文内容</p>')]]);
  const r = await aggregate.fetchArticle('https://example.com/a', { fetch, retryDelayMs: 0 });
  assert.strictEqual(r.title, '标题');
  assert.strictEqual(r.text, '标题\n正文内容'); // h1 文本保留为首段（正文一部分）
  assert.strictEqual(r.url, 'https://example.com/a');
  assert.strictEqual(calls[0].init.method, 'GET');

  const { fetch: f404 } = router([[/x/, () => res(404, 'gone')]]);
  await assert.rejects(() => aggregate.fetchArticle('https://example.com/404', { fetch: f404, retryDelayMs: 0 }), (e) => e.code === 'E_NET');

  const { fetch: fempty } = router([[/x/, () => res(200, '<div>   </div>')]]);
  await assert.rejects(
    () => aggregate.fetchArticle('https://example.com/e', { fetch: fempty, retryDelayMs: 0 }),
    (e) => {
      assert.strictEqual(e.code, 'E_NET');
      assert.match(e.message, /提取为空/);
      return true;
    }
  );

  await assert.rejects(() => aggregate.fetchArticle('ftp://x', { fetch: async () => res(200, 'y') }), (e) => e.code === 'E_INVALID_INPUT');
});

/* ------------------------------ 分级 / 去重 / 排序 / 清单 ------------------------------ */

test('gradeSource：域名优先、名称兜底、默认 L3', () => {
  assert.deepStrictEqual(aggregate.gradeSource({ url: 'https://www.who.int/zh/x' }), { tier: 1, label: 'L1', matchedBy: 'domain', matched: 'who.int' });
  assert.strictEqual(aggregate.gradeSource({ url: 'https://sub.gov.cn/a' }).tier, 1);
  assert.strictEqual(aggregate.gradeSource({ url: 'https://x.example.com/', name: 'PubMed 每周速递' }).tier, 2);
  assert.strictEqual(aggregate.gradeSource({ url: 'https://x.example.com/', name: 'Nature 站点' }).label, 'L2');
  assert.deepStrictEqual(aggregate.gradeSource({ url: 'https://blog.example.com/' }), { tier: 3, label: 'L3', matchedBy: 'default' });
  assert.strictEqual(aggregate.gradeSource({ url: 'https://x.example.com/', name: '人民日报健康号' }).tier, 1);
});

test('normalizeUrl：协议/www/query/hash/尾斜杠/大小写 归一', () => {
  assert.strictEqual(aggregate.normalizeUrl('HTTPS://WWW.Who.int/zh/News/Fact-1/'), aggregate.normalizeUrl('https://who.int/zh/news/fact-1?utm_source=x#top'));
  assert.notStrictEqual(aggregate.normalizeUrl('https://who.int/a'), aggregate.normalizeUrl('https://who.int/b'));
});

test('filterByWhitelist：空 → 全部保留；命中主域与子域；记录剔除数', () => {
  const items = [
    { url: 'https://www.who.int/a' },
    { url: 'https://news.people.com.cn/b' },
    { url: 'https://blog.example.com/c' },
  ];
  const r = aggregate.filterByWhitelist(items, ['who.int', 'people.com.cn']);
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.removedCount, 1);
  assert.strictEqual(aggregate.filterByWhitelist(items, []).removedCount, 0);

  // 只按域名后缀匹配：白名单条目包含 host 不算命中（配置笔误不得放行相似域名）
  const typo = aggregate.filterByWhitelist(
    [{ url: 'https://people.com.cn/x' }, { url: 'https://xpeople.com.cn/y' }],
    ['xpeople.com.cn']
  );
  assert.deepStrictEqual(typo.items.map((it) => it.url), ['https://xpeople.com.cn/y']);
});

test('dedupeResults：URL 重复与标题近似重复合并，保留靠前者', () => {
  const items = [
    { title: 'WHO：健康饮食关键事实', url: 'https://www.who.int/zh/news/fact-1', rawRank: 0 },
    { title: 'WHO：健康饮食关键事实', url: 'https://who.int/zh/news/fact-1?utm=weibo', rawRank: 1 }, // URL 重复
    { title: '每周150分钟运动显著降低全因死亡风险（综述解读）', url: 'https://blog1.example.com/a', rawRank: 2 },
    { title: '每周150分钟运动显著降低全因死亡风险（深度解读）', url: 'https://blog2.example.com/b', rawRank: 3 }, // 标题近似
    { title: '另一个独立话题', url: 'https://blog3.example.com/c', rawRank: 4 },
  ];
  const r = aggregate.dedupeResults(items);
  assert.strictEqual(r.items.length, 3);
  assert.strictEqual(r.removedCount, 2);
  assert.strictEqual(r.items[0].url, 'https://www.who.int/zh/news/fact-1');
  assert.strictEqual(r.items[2].title, '另一个独立话题');
});

test('rankResults：级别优先、热度次之、搜索排名兜底；热度有界', () => {
  const items = [
    { title: 'L3 新文章', url: 'https://blog.example.com/1', publishedAt: '2026-10-29T00:00:00Z', rawRank: 0 },
    { title: 'L1 旧文章', url: 'https://www.who.int/x', publishedAt: '2026-01-01T00:00:00Z', rawRank: 1 },
    { title: 'L2 中等', url: 'https://pubmed.ncbi.nlm.nih.gov/2', publishedAt: '2026-10-28T00:00:00Z', rawRank: 2 },
  ];
  const ranked = aggregate.rankResults(items, { now: '2026-10-29T12:00:00Z' });
  assert.deepStrictEqual(ranked.map((r) => r.label), ['L1', 'L2', 'L3']);
  for (const r of ranked) {
    assert.ok(r.heat >= 1 && r.heat <= 100);
    assert.ok(typeof r.heat === 'number');
  }
  // L3 新文章热度 > 同级旧文章（新近度加分）
  const l3 = ranked.filter((r) => r.label === 'L3')[0];
  assert.ok(l3.heat > 20);

  // 多关键词：热度搜索分用「各关键词内排名」，不能用合并后的数组下标
  // （否则第二个关键词的第一名会被当成排名靠后的结果压低）
  const twoQueries = aggregate.rankResults(
    [
      { title: 'A0', url: 'https://blog.example.com/a0', keyword: '科技', rawRank: 0 },
      { title: 'A1', url: 'https://blog.example.com/a1', keyword: '科技', rawRank: 1 },
      { title: 'B0', url: 'https://blog.example.com/b0', keyword: '教育', rawRank: 0 },
    ],
    { now: '2026-10-29T12:00:00Z' }
  );
  const byTitle = Object.fromEntries(twoQueries.map((r) => [r.title, r]));
  assert.strictEqual(byTitle.A0.heat, byTitle.B0.heat, '两个关键词的第一名热度应相同');
  assert.ok(byTitle.B0.heat > byTitle.A1.heat, '第二关键词的第一名不应低于第一关键词的第二名');
});

test('buildTopicList：确定性 id、摘要截断、来源名回退 host', () => {
  const ranked = aggregate.rankResults(
    [
      { title: 'T'.repeat(100), url: 'https://www.who.int/a', snippet: 's'.repeat(120), publishedAt: null, rawRank: 0, name: 'WHO官网' },
      { title: 'B', url: 'https://blog.example.com/b', snippet: '', rawRank: 1 },
    ],
    { now: '2026-10-29T00:00:00Z' }
  );
  const topics = aggregate.buildTopicList(ranked, { limit: 10 });
  assert.strictEqual(topics.length, 2);
  assert.ok(topics[0].id.startsWith('topic-'));
  assert.strictEqual(topics[0].id, aggregate.buildTopicList(ranked, { limit: 10 })[0].id); // 同 URL → 同 id
  assert.strictEqual(topics[0].source.name, 'WHO官网');
  assert.strictEqual(topics[1].source.name, 'blog.example.com');
  assert.strictEqual(topics[0].summary.length, 80 + 1); // 80 字 + …
  assert.strictEqual(topics[1].summary, '');
  const few = aggregate.buildTopicList(ranked, { limit: 1 });
  assert.strictEqual(few.length, 1);
});

/* ------------------------------ 选题雷达 ------------------------------ */

test('runTopicRadar：多关键词合并 + 单词失败如实记录 + 清单落盘', async () => {
  const dir = tmpDir();
  const { fetch, calls } = router([
    [/bochaai/, ({ init }) => {
      const q = JSON.parse(init.body).query;
      if (q === '科技') return res(200, BOCHA_OK);
      return res(500, 'search down');
    }],
  ]);
  const r = await aggregate.runTopicRadar(CFG, { dataDir: dir, date: '2026-10-29', now: '2026-10-29T12:00:00Z', deps: { fetch, retryDelayMs: 0 } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.keywordErrors.map((x) => x.keyword), ['生活方式']);
  assert.match(r.keywordErrors[0].error.message, /HTTP 500/);
  assert.ok(r.topics.length >= 1);
  assert.strictEqual(r.topics[0].source.label, 'L1', '权威来源排前');
  assert.ok(r.savedPath && fs.existsSync(r.savedPath));
  const loaded = aggregate.loadRadar(dir, '2026-10-29');
  assert.deepStrictEqual(loaded.topics, r.topics);
  assert.deepStrictEqual(loaded.keywordErrors, r.keywordErrors);
  assert.ok(calls.length >= 2);

  // 白名单生效：只保留 who.int
  const cfgWl = { ...CFG, aggregate: { ...CFG.aggregate, whitelist: ['who.int'] } };
  const r2 = await aggregate.runTopicRadar(cfgWl, { dataDir: dir, date: '2026-10-29', now: '2026-10-29T12:00:00Z', deps: { fetch, retryDelayMs: 0 } });
  assert.ok(r2.topics.every((t) => aggregate.hostOf(t.source.url).endsWith('who.int')));
});

test('runTopicRadar 错误路径：未配关键词 → E_INVALID_INPUT；全部失败 → E_NET', async () => {
  await assert.rejects(
    () => aggregate.runTopicRadar({ aggregate: { keywords: [] } }, { dataDir: tmpDir() }),
    (e) => {
      assert.strictEqual(e.code, 'E_INVALID_INPUT');
      assert.match(e.message, /未配置搜索关键词/);
      return true;
    }
  );
  const { fetch } = router([[/x/, () => res(500, 'down')]]);
  await assert.rejects(
    () => aggregate.runTopicRadar(CFG, { dataDir: tmpDir(), deps: { fetch, retryDelayMs: 0 } }),
    (e) => {
      assert.strictEqual(e.code, 'E_NET');
      assert.match(e.message, /全部关键词搜索失败/);
      assert.strictEqual(e.keywordErrors.length, 2);
      return true;
    }
  );
});

/* ------------------------------ n-gram 相似度自检 ------------------------------ */

test('ngramSimilarity：完全相同 → 1；无关 → 0；部分重叠介于其间；短文本 → 0', () => {
  const a = '规律运动与均衡饮食是最有共识的两大健康抓手';
  assert.strictEqual(aggregate.ngramSimilarity(a, a), 1);
  assert.strictEqual(aggregate.ngramSimilarity(a, '程序员今天提交了三个修复配置读取缺陷的提交记录'), 0);
  const partial = aggregate.ngramSimilarity(a, '规律运动与均衡饮食很重要，但也要注意休息与心态');
  assert.ok(partial > 0 && partial < 1, `partial=${partial}`);
  assert.strictEqual(aggregate.ngramSimilarity('短', a), 0);
});

test('checkSimilarity：阈值两侧翻转 passed/needsRewrite；报告含雷同片段', () => {
  const source = '世界卫生组织建议成年人每周进行至少一百五十分钟中等强度有氧运动，并每周两天以上的肌肉强化训练。';
  const copied = '先说结论：本文只讨论公开共识。世界卫生组织建议成年人每周进行至少一百五十分钟中等强度有氧运动，这是底线的运动量。';
  const original = '先说结论：本文只讨论公开共识。把运动拆进日常通勤和午休，比一次性补课更容易坚持，也更适合零基础的人。';

  const bad = aggregate.checkSimilarity(copied, [source], { threshold: 0.3 });
  assert.strictEqual(bad.passed, false);
  assert.strictEqual(bad.needsRewrite, true);
  assert.ok(bad.maxRatio > 0.3);
  assert.strictEqual(bad.worstIndex, 0);
  assert.ok(bad.reports[0].runs.length >= 1, '应列出雷同片段');
  assert.ok(bad.reports[0].runs.some((r) => r.text.includes('一百五十分钟')), '摘录来自原文');

  const good = aggregate.checkSimilarity(original, [source], { threshold: 0.3 });
  assert.strictEqual(good.passed, true);
  assert.strictEqual(good.needsRewrite, false);

  // 阈值边界：ratio === threshold 视为通过；略低于实测比率则触发
  const ratio = bad.maxRatio;
  assert.strictEqual(aggregate.checkSimilarity(copied, [source], { threshold: ratio }).passed, true);
  assert.strictEqual(aggregate.checkSimilarity(copied, [source], { threshold: Math.max(0, ratio - 0.0001) }).passed, false);

  // 多来源定位 worstIndex；空来源集 → 通过
  const multi = aggregate.checkSimilarity(copied, ['无关内容一', source], { threshold: 0.3 });
  assert.strictEqual(multi.worstIndex, 1);
  const none = aggregate.checkSimilarity(copied, [], { threshold: 0.3 });
  assert.strictEqual(none.passed, true);
  assert.strictEqual(none.maxRatio, 0);
});

test('sharedRuns：文本末尾的游程也能闭合；短命中被 minRunChars 过滤', () => {
  const runs = aggregate.sharedRuns('abcdefghijklmnop', 'mnop 废话', { minRunChars: 2 });
  assert.ok(runs.some((r) => r.text.includes('mnop')), `runs=${JSON.stringify(runs)}`);
  const tiny = aggregate.sharedRuns('共识', '共识二字很短', { minRunChars: 8 });
  assert.deepStrictEqual(tiny, []);
});

/* ------------------------------ 综合成文 ------------------------------ */

test('buildSynthesisPrompt：护栏约定逐条存在（事实共识/署名/合规约束/清单不随文/禁用词/主题行），领域提示两态', () => {
  const topics = [{ title: '每周三次专注复盘', url: 'https://a.example.com/' }];
  const materials = [{ title: '研究速览', text: '材料正文', label: 'L2', name: 'PubMed', url: 'https://pubmed.ncbi.nlm.nih.gov/1' }];
  const base = {
    topics,
    materials,
    project: { description: '习惯打卡小程序' },
    styleInjection: '【文风画像】\n- 开头习惯：提问',
  };
  const p = aggregate.buildSynthesisPrompt(base);
  for (const s of [
    '主题：每周三次专注复盘',
    '只提取来源中的事实、共识、数据、结论',
    '禁止复用来源的句式、比喻、结构与独特表达',
    '署名出处',
    '不做诊断、治疗、药物建议',
    '不随文发布',
    '禁用词',
    '【项目背景】',
    '习惯打卡小程序',
    '【文风画像】',
    '[材料1·L2·PubMed]',
    '===TITLE===',
  ]) {
    assert.ok(p.includes(s), `提示词应包含：${s}`);
  }
  // verticalNotice 默认关闭：提示词不出现文末提示行
  assert.ok(!p.includes('文末固定追加一句提示'), '默认关闭时不得注入领域提示');
  // 开启后：注入自定义提示句
  const on = aggregate.buildSynthesisPrompt({ ...base, verticalNotice: '本文为个人经验分享，请结合自身情况判断' });
  assert.ok(on.includes('文末固定追加一句提示：本文为个人经验分享，请结合自身情况判断'), '开启后应注入自定义领域提示');
});

test('composeFromTopics：勾选数量校验（0 条与 4 条 → E_INVALID_INPUT）', async () => {
  await assert.rejects(() => aggregate.composeFromTopics(CFG, { topics: [] }, {}), (e) => e.code === 'E_INVALID_INPUT');
  await assert.rejects(
    () => aggregate.composeFromTopics(CFG, { topics: [{ title: 'a', url: 'https://a.example.com/' }, { title: 'b', url: 'https://b.example.com/' }, { title: 'c', url: 'https://c.example.com/' }, { title: 'd', url: 'https://d.example.com/' }] }, {}),
    (e) => {
      assert.strictEqual(e.code, 'E_INVALID_INPUT');
      assert.match(e.message, /1~3 条/);
      return true;
    }
  );
});

test('composeFromTopics：敏感话题默认拦截，确认后放行', async () => {
  const topics = [{ title: '生酮饮食 30 天实测', url: 'https://blog.example.com/keto' }];
  const blocked = await aggregate.composeFromTopics(CFG, { topics, materials: [{ text: '材料' }] }, {});
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.needsConfirmation, true);
  assert.deepStrictEqual(blocked.sensitiveKeywords, ['生酮']);
  const { fetch } = router([
    [/blog\.example\.com/, () => res(200, '<h1>生酮研究</h1><p>生酮饮食的代谢机制研究概述。</p>')],
    [/\/chat\/completions$/, () => res(200, { choices: [{ message: { content: fmt('关于生酮的共识', '只讲机制不讲方案。', '<p>正文</p>') } }] })],
  ]);
  const allowed = await aggregate.composeFromTopics(CFG, { topics, materials: [{ text: '生酮机制材料' }], confirmSensitive: true }, { fetch, retryDelayMs: 0 });
  assert.strictEqual(allowed.ok, true);
});

test('composeFromTopics：正常成文 + 护栏落盘（article/sources/similarity/preview）+ 来源清单不进正文 + 历史记录 origin=聚合', async () => {
  const dir = tmpDir();
  const st = state.defaultState();
  const articleHtml = '<p style="font-size:15px;">规律复盘加持续迭代，是最有共识的组合。</p><p style="color:#999;">本文为经验分享，请结合自身情况判断</p>';
  const { fetch, calls } = router([
    [/who\.int/, () => res(200, '<h1>WHO 事实页</h1><p>每周至少一百五十分钟中等强度运动。</p>')],
    [/\/chat\/completions$/, () => res(200, { choices: [{ message: { content: fmt('每周 150 分钟：给上班族的低门槛方案', '把权威共识拆成可执行的日常安排。', articleHtml) } }] })],
  ]);
  const topics = [
    { id: 'topic-aaa', title: '每周 150 分钟运动', url: 'https://www.who.int/fact', summary: '权威建议摘要', source: { name: 'WHO', url: 'https://www.who.int/fact', tier: 1, label: 'L1' } },
  ];
  const r = await aggregate.composeFromTopics(
    CFG,
    { topics, date: '2026-10-29', now: '2026-10-29T12:00:00Z', dataDir: dir, state: st },
    { fetch, retryDelayMs: 0, logger: { info() {}, warn() {}, error() {} } }
  );
  assert.strictEqual(r.ok, true);
  // batchId 的哈希里带日期：同一组选题第二天成文不会覆盖前一天的记录
  assert.strictEqual(r.batchId, 'agg-' + require('node:crypto').createHash('sha256').update('2026-10-29|topic-aaa', 'utf8').digest('hex').slice(0, 8));
  assert.strictEqual(r.article.title, '每周 150 分钟：给上班族的低门槛方案');
  assert.strictEqual(r.needsRewrite, false);
  assert.strictEqual(r.similarity.attempts, 1);
  assert.strictEqual(r.words, require('../src/core/article').countWords(articleHtml));

  // 落盘四件套
  assert.ok(fs.existsSync(path.join(r.outDir, 'article.json')));
  assert.ok(fs.existsSync(path.join(r.outDir, 'sources.json')));
  assert.ok(fs.existsSync(path.join(r.outDir, 'similarity.json')));
  const preview = fs.readFileSync(path.join(r.outDir, 'preview.html'), 'utf8');
  assert.ok(preview.startsWith('<!doctype html>'), 'preview.html 是纯 HTML 而非 JSON');
  const sourcesJson = JSON.parse(fs.readFileSync(path.join(r.outDir, 'sources.json'), 'utf8'));
  assert.strictEqual(sourcesJson.internal, true);
  assert.match(sourcesJson.note, /不随文章发布/);
  assert.strictEqual(sourcesJson.sources[0].fetchState, 'ok');
  assert.strictEqual(sourcesJson.sources[0].label, 'L1');
  assert.strictEqual(sourcesJson.sources[0].usedFor, '事实/共识/数据提取');
  // 来源清单内部可见、不随文发布：正文不含来源 URL 与清单字样
  assert.ok(!r.article.html.includes('who.int'));
  assert.ok(!r.article.html.includes('参考来源'));

  // 历史记录：带 id 与 origin=聚合
  const entry = st.history.find((h) => h.id === r.batchId);
  assert.ok(entry, '应写入历史');
  assert.strictEqual(entry.origin, '聚合');
  assert.strictEqual(entry.status, 'generated');
  assert.strictEqual(state.getHistory(st, 'all', '聚合').length, 1);
  assert.strictEqual(calls.filter((c) => c.url.includes('chat/completions')).length, 1);
});

test('composeFromTopics：LLM 输出先消毒再落盘/返回（不把 script/on* 带进正文）', async () => {
  const dir = tmpDir();
  const dirty = '<p style="font-size:15px;">正文段落。</p><script>alert(1)</script><p onclick="steal()">带事件属性的段落。</p>';
  const { fetch } = router([
    [/who\.int/, () => res(200, '<h1>WHO</h1><p>每周运动建议。</p>')],
    [/\/chat\/completions$/, () => res(200, { choices: [{ message: { content: fmt('消毒验证', '摘要。', dirty) } }] })],
  ]);
  const r = await aggregate.composeFromTopics(
    CFG,
    {
      topics: [{ id: 'topic-san', title: '每周运动', url: 'https://www.who.int/fact' }],
      date: '2026-10-29', now: '2026-10-29T12:00:00Z', dataDir: dir, state: state.defaultState(),
    },
    { fetch, retryDelayMs: 0, logger: { info() {}, warn() {}, error() {} } }
  );
  assert.strictEqual(r.ok, true);
  assert.ok(!/script/i.test(r.article.html), '返回正文不得含 script');
  assert.ok(!/onclick/i.test(r.article.html), '返回正文不得含事件属性');
  const savedArticle = JSON.parse(fs.readFileSync(path.join(r.outDir, 'article.json'), 'utf8'));
  assert.ok(!/script/i.test(savedArticle.html), '落盘 article.json 不得含 script');
  assert.ok(!/script/i.test(fs.readFileSync(path.join(r.outDir, 'preview.html'), 'utf8')), 'preview.html 不得含 script');
});

test('composeFromTopics：抓取失败降级（snippet-only 如实记录，不伪造素材）', async () => {
  const dir = tmpDir();
  const { fetch } = router([
    [/down\.example\.com/, () => res(500, 'site down')],
    [/\/chat\/completions$/, () => res(200, { choices: [{ message: { content: fmt('降级也如实', '材料只有摘要。', '<p>基于有限材料的正文</p>') } }] })],
  ]);
  const topics = [{ title: '一篇抓不到正文的研究报道', url: 'https://down.example.com/a', summary: '搜索摘要：这项研究发现规律运动有益。' }];
  const r = await aggregate.composeFromTopics(
    CFG,
    { topics, dataDir: dir, date: '2026-10-29', now: '2026-10-29T12:00:00Z' },
    { fetch, retryDelayMs: 0 }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sources[0].fetchState, 'snippet-only');
  assert.match(r.sources[0].fetchError, /HTTP 500/);
  assert.strictEqual(r.sources[0].excerpt, '搜索摘要：这项研究发现规律运动有益。');
  const sourcesJson = JSON.parse(fs.readFileSync(path.join(r.outDir, 'sources.json'), 'utf8'));
  assert.strictEqual(sourcesJson.sources[0].fetchState, 'snippet-only');
});

test('composeFromTopics：相似度超阈值自动重写（第 2 稿通过）；重写提示词含上一稿与雷同片段', async () => {
  const sourceText = '世界卫生组织建议成年人每周进行至少一百五十分钟中等强度有氧运动，并且每周进行两天以上肌肉强化训练，这对健康有明确收益。';
  let n = 0;
  const fetchImpl = async (url) => {
    if (/chat\/completions/.test(url)) {
      n += 1;
      if (n === 1) {
        // 第一稿：大段照抄来源 → 超阈值
        return res(200, {
          choices: [{
            message: {
              content: fmt('照抄稿', '照抄来源的稿子。', `<p>${sourceText}</p>`),
            },
          }],
        });
      }
      // 第二稿：换一种写法
      return res(200, {
        choices: [{ message: { content: fmt('改写稿', '只保留事实换一种写法。', '<p>把运动拆进日常：通勤快走二十分钟，午休做两组自重训练，一周下来就够到权威建议的量。</p>') } }],
      });
    }
    return res(200, `<h1>来源页</h1><p>${sourceText}</p>`);
  };
  const r = await aggregate.composeFromTopics(
    CFG,
    { topics: [{ title: '每周运动量共识', url: 'https://src.example.com/a' }], threshold: 0.3, date: '2026-10-29', now: '2026-10-29T12:00:00Z', dataDir: tmpDir() },
    { fetch: fetchImpl, retryDelayMs: 0 }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.article.title, '改写稿');
  assert.strictEqual(r.similarity.attempts, 2);
  assert.strictEqual(r.similarity.rewriteAttempts, 1);
  assert.strictEqual(r.needsRewrite, false);
});

test('composeFromTopics：重写次数用尽仍超阈值 → needsRewrite 信号返回（不谎报通过）', async () => {
  const sourceText = '这是一段会被反复照抄的来源文本，其中包含足够多的二元组用来触发相似度阈值判定的失败路径与重写信号。';
  const fetchImpl = async (url) => {
    if (/chat\/completions/.test(url)) {
      return res(200, { choices: [{ message: { content: fmt('固执稿', '始终照抄。', `<p>${sourceText}</p>`) } }] });
    }
    return res(200, `<h1>来源</h1><p>${sourceText}</p>`);
  };
  const r = await aggregate.composeFromTopics(
    CFG,
    { topics: [{ title: '固执的来源', url: 'https://src.example.com/b' }], threshold: 0.3, date: '2026-10-29', now: '2026-10-29T12:00:00Z', dataDir: tmpDir() },
    { fetch: fetchImpl, retryDelayMs: 0 }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.needsRewrite, true);
  assert.strictEqual(r.similarity.passed, false);
  assert.strictEqual(r.similarity.attempts, 1 + aggregate.REWRITE_ATTEMPTS);
  assert.strictEqual(r.similarity.maxRatio > 0.3, true);
});

test('composeFromTopics：LLM 格式错误持续 → E_LLM（原始输出已保存）', async () => {
  const dir = tmpDir();
  const fetchImpl = async (url) => {
    if (/chat\/completions/.test(url)) {
      return res(200, { choices: [{ message: { content: '我不会按格式输出，抱歉。' } }] });
    }
    return res(200, '<h1>来源</h1><p>材料正文内容。</p>');
  };
  await assert.rejects(
    () => aggregate.composeFromTopics(
      CFG,
      { topics: [{ title: '格式错误稿', url: 'https://src.example.com/c' }], date: '2026-10-29', now: '2026-10-29T12:00:00Z', dataDir: dir },
      { fetch: fetchImpl, retryDelayMs: 0 }
    ),
    (e) => {
      assert.strictEqual(e.code, 'E_LLM');
      return true;
    }
  );
  // raw-llm-attempt*.json 已保存
  const batchDir = fs.readdirSync(path.join(dir, 'output', '2026-10-29', 'aggregate'))[0];
  const files = fs.readdirSync(path.join(dir, 'output', '2026-10-29', 'aggregate', batchDir));
  assert.ok(files.some((f) => f.startsWith('raw-llm-attempt')), '原始输出已落盘');
});

test('normalizeUrl：保留业务 query（公众号 /s?__biz=&mid=&idx= 不再合并），只剔除跟踪参数', () => {
  const a = 'https://mp.weixin.qq.com/s?__biz=MzA1&mid=1001&idx=1&sn=aa&utm_source=x';
  const b = 'https://mp.weixin.qq.com/s?__biz=MzA1&mid=1002&idx=1&sn=bb';
  assert.notStrictEqual(aggregate.normalizeUrl(a), aggregate.normalizeUrl(b), '不同文章必须是不同的键');
  assert.strictEqual(
    aggregate.normalizeUrl(a),
    aggregate.normalizeUrl('https://mp.weixin.qq.com/s?__biz=MzA1&mid=1001&idx=1&sn=aa'),
    '跟踪参数应被剔除'
  );
  // 去重：三篇不同的公众号文章保留 3 条，id 也各不相同
  const items = [
    { title: 'A', url: a, rawRank: 0 },
    { title: 'B', url: b, rawRank: 1 },
    { title: 'C', url: 'https://mp.weixin.qq.com/s?__biz=MzA1&mid=1003&idx=1&sn=cc', rawRank: 2 },
  ];
  assert.strictEqual(aggregate.dedupeResults(items).items.length, 3);
  const ids = aggregate.buildTopicList(aggregate.rankResults(items), { limit: 10 }).map((t) => t.id);
  assert.strictEqual(new Set(ids).size, 3, '不同选题的 id 不得相同');
});

test('filterByWhitelist：机构名写法可用（设置页 placeholder 承诺的「域名或机构名」）', () => {
  const items = [
    { url: 'https://www.who.int/x', name: '世界卫生组织' },
    { url: 'https://health.people.com.cn/y', name: '人民日报健康号' },
    { url: 'https://blog.example.com/z', name: '某科普博客' },
  ];
  const r = aggregate.filterByWhitelist(items, ['人民日报', '新华社']);
  assert.deepStrictEqual(r.items.map((it) => it.name), ['人民日报健康号']);
  assert.strictEqual(r.removedCount, 2);
});

test('composeFromTopics：batchId 含日期——同一组选题跨天成文不覆盖前一天历史', async () => {
  const dir = tmpDir();
  const st = state.defaultState();
  const { fetch } = router([
    [/who\.int/, () => res(200, '<h1>WHO</h1><p>每周运动建议。</p>')],
    [/\/chat\/completions$/, () => res(200, { choices: [{ message: { content: fmt('跨天成文', '摘要。', '<p>正文</p>') } }] })],
  ]);
  const topics = [{ id: 'topic-same', title: '同一个选题', url: 'https://www.who.int/fact' }];
  const opts = (date) => ({ topics, date, dataDir: dir, state: st, logger: { info() {}, warn() {}, error() {} } });
  const r1 = await aggregate.composeFromTopics(CFG, opts('2026-10-28'), { fetch, retryDelayMs: 0 });
  const r2 = await aggregate.composeFromTopics(CFG, opts('2026-10-29'), { fetch, retryDelayMs: 0 });
  assert.notStrictEqual(r1.batchId, r2.batchId, '跨天的 batchId 必须不同');
  assert.strictEqual(st.history.filter((h) => h.id === r1.batchId).length, 1, '前一天的历史应保留');
  assert.strictEqual(st.history.filter((h) => h.id === r2.batchId).length, 1);
});

test('fetchArticle：拒绝内网/本机地址（SSRF 防护）', async () => {
  await assert.rejects(() => aggregate.fetchArticle('http://127.0.0.1:8080/x'), (e) => e.code === 'E_INVALID_INPUT');
  await assert.rejects(() => aggregate.fetchArticle('http://192.168.1.10/admin'), (e) => e.code === 'E_INVALID_INPUT');
  await assert.rejects(() => aggregate.fetchArticle('http://localhost/x'), (e) => e.code === 'E_INVALID_INPUT');
});

test('gradeSource：机构名按标题匹配（搜索结果没有 name 字段）', () => {
  const g = aggregate.gradeSource({ title: '人民日报：科技周报怎么读', url: 'https://mp.weixin.qq.com/s?__biz=a&mid=1&idx=1' });
  assert.strictEqual(g.tier, 1);
  assert.strictEqual(g.matchedBy, 'name');
  assert.strictEqual(aggregate.gradeSource({ title: '随便一篇科普', url: 'https://blog.example.com/x' }).tier, 3);
});

test('dedupeResults：同题重复按权威度择优（L3 副本不能挤掉 L1/L2 原文）', () => {
  const items = [
    { title: '每周150分钟运动显著降低全因死亡风险', url: 'https://fitpedia.example.com/a', rawRank: 0 },
    { title: '每周150分钟运动显著降低全因死亡风险', url: 'https://pubmed.ncbi.nlm.nih.gov/39999001/', rawRank: 3 },
  ];
  const r = aggregate.dedupeResults(items);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].url, 'https://pubmed.ncbi.nlm.nih.gov/39999001/');
  assert.strictEqual(aggregate.gradeSource(r.items[0]).label, 'L2');
  // URL 归一组同样择优
  const same = aggregate.dedupeResults([
    { title: 'A', url: 'https://www.who.int/x?utm_source=a', rawRank: 0 },
    { title: 'A', url: 'https://who.int/x?utm_source=b', rawRank: 5 },
  ]);
  assert.strictEqual(same.items.length, 1);
});

test('composeFromTopics：敏感词只出现在摘要/素材里也要人工确认', async () => {
  const topics = [{ id: 'topic-sum', title: '代餐替代怎么选', url: 'https://www.who.int/x', summary: '讨论生酮、断食与代餐替代的利弊' }];
  const blocked = await aggregate.composeFromTopics(CFG, { topics, materials: [{ text: '生酮饮食概述' }] }, {});
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.needsConfirmation, true);
  assert.ok(blocked.sensitiveKeywords.includes('生酮'));
});

test('设置页下拉的 data-host 与 ADAPTERS.host 一致（防两处域名漂移）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const m = /<select[^>]*id="aggSearchProvider"[\s\S]*?<\/select>/.exec(html);
  assert.ok(m, '应能找到搜索服务商下拉');
  const pairs = [...m[0].matchAll(/<option value="([\w-]+)"[^>]*data-host="([^"]+)"/g)].map((x) => [x[1], x[2]]);
  assert.strictEqual(pairs.length, Object.keys(aggregate.ADAPTERS).length, '下拉项数量应与适配层通道数一致');
  for (const [name, host] of pairs) {
    assert.ok(aggregate.ADAPTERS[name], 'HTML 里的 ' + name + ' 在适配层不存在');
    assert.strictEqual(host, aggregate.ADAPTERS[name].host, name + ' 的域名与适配层不一致');
  }
});

test('插图里的文字参与相似度自检（防止把来源原句塞进图里绕过护栏）', () => {
  const illCore = require('../src/core/illustration');
  const source = '分级阅读要按孩子的实际阅读能力选书，一页生词不要超过五个，同级别读满十五本再考虑升级';
  const html =
    '<p style="font-size:15px;">本文讲选书这件事的几个判断标准与常见误区。</p>' +
    '<illus type="summary" title="选书标准" items="分级阅读要按孩子的实际阅读能力选书||一页生词不要超过五个||同级别读满十五本再考虑升级"></illus>';

  const withoutIllus = aggregate.extractArticleText(html).text;
  const withIllus = withoutIllus + '\n' + illCore.illustrationTextOf(html);

  const a = aggregate.checkSimilarity(withoutIllus, [source], { threshold: 0.3 });
  const b = aggregate.checkSimilarity(withIllus, [source], { threshold: 0.3 });
  assert.ok(b.maxRatio > a.maxRatio, `带插图文字的重叠率应更高：${a.maxRatio} → ${b.maxRatio}`);
  assert.ok(b.maxRatio >= 0.3, `应触发阈值，实际 ${b.maxRatio}`);
});
