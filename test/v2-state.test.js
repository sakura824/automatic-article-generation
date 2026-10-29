'use strict';
/**
 * v2-state.test.js —— v2 增量的数据模型测试（PRD v2 §2 历史来源标注）：
 * recordRun 的 origin/id 语义（带 id 同日多条；无 id 保持 v1 单日单条）、
 * getHistory 的来源筛选（旧数据按「自动」归类）、aggregateConfigOf 默认值兜底、
 * config 契约点（SEARCH_PROVIDERS / DEFAULT_SENSITIVE_KEYWORDS / verticalNotice）。
 */
delete process.env.WECHAT_DAILY_MOCK;

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/core/config');
const state = require('../src/core/state');
const aggregate = require('../src/core/aggregate');

test('recordRun（v2）：origin 写入与枚举外回退「自动」', () => {
  const s = state.defaultState();
  state.recordRun(s, { date: '2026-10-29', title: '素材稿', status: 'generated', words: 10, origin: '素材' });
  state.recordRun(s, { date: '2026-10-28', title: '对话稿', status: 'generated', words: 12, origin: '对话' });
  state.recordRun(s, { date: '2026-10-27', title: '聚合稿', status: 'generated', words: 14, origin: '聚合' });
  state.recordRun(s, { date: '2026-10-26', title: '仓库自动', status: 'skipped', words: null }); // 未传 origin
  state.recordRun(s, { date: '2026-10-25', title: '坏 origin', status: 'failed', words: null, origin: '外星来源' });
  // 存储按日期升序：10-25→10-29，origin 分别为 自动/自动/聚合/对话/素材
  assert.deepStrictEqual(s.history.map((r) => r.origin), ['自动', '自动', '聚合', '对话', '素材']);
  // 来源筛选：all/未传 → 全部
  assert.strictEqual(state.getHistory(s).length, 5);
  assert.strictEqual(state.getHistory(s, 'all').length, 5);
  assert.deepStrictEqual(state.getHistory(s, 'all', '聚合').map((r) => r.title), ['聚合稿']);
  assert.deepStrictEqual(state.getHistory(s, 'all', '素材').map((r) => r.title), ['素材稿']);
  // 旧 v1 数据（无 origin 字段）按「自动」归类
  s.history.push({ date: '2026-10-20', title: '旧数据', status: 'uploaded', words: 1 });
  assert.deepStrictEqual(
    new Set(state.getHistory(s, 'all', '自动').map((r) => r.title)),
    new Set(['旧数据', '仓库自动', '坏 origin'])
  );
});

test('recordRun（v2）：带 id 同日多条并存；无 id 保持 v1 单日单条且不覆盖带 id 条目', () => {
  const s = state.defaultState();
  state.recordRun(s, { id: 'agg-aaa', date: '2026-10-29', title: '聚合A', status: 'generated', words: 1, origin: '聚合' });
  state.recordRun(s, { id: 'agg-bbb', date: '2026-10-29', title: '聚合B', status: 'generated', words: 2, origin: '聚合' });
  assert.strictEqual(s.history.length, 2);
  // 同 id 重跑 → upsert 覆盖
  state.recordRun(s, { id: 'agg-aaa', date: '2026-10-29', title: '聚合A2', status: 'failed', words: 3, origin: '聚合' });
  assert.strictEqual(s.history.length, 2);
  const a = s.history.find((r) => r.id === 'agg-aaa');
  assert.strictEqual(a.title, '聚合A2');
  // 无 id 的 v1 调用：同日另一条（不覆盖带 id 条目）
  state.recordRun(s, { date: '2026-10-29', title: '日报', status: 'uploaded', words: 9 });
  assert.strictEqual(s.history.length, 3);
  assert.ok(s.history.every((r) => r.date <= '2026-10-30'));
  // 无 id 再写一次同日 → 覆盖那条无 id 记录（v1 语义保持）
  state.recordRun(s, { date: '2026-10-29', title: '日报2', status: 'uploaded', words: 10 });
  const sameDay = s.history.filter((r) => r.date === '2026-10-29');
  assert.strictEqual(sameDay.length, 3);
  assert.ok(sameDay.some((r) => r.title === '日报2' && !r.id));
});

test('aggregateConfigOf：缺省/畸形配置兜底为安全默认值', () => {
  const empty = aggregate.aggregateConfigOf({});
  assert.deepStrictEqual(empty, {
    keywords: [], whitelist: [], provider: 'bocha',
    providerLabel: '博查', providerNative: false, providerHost: 'api.bochaai.com',
    apiKey: '', keyFromLlm: false, canReuseLlmKey: false,
    llmHost: '', llmNativeProvider: null,
    dailyLimit: 10, similarityThreshold: 0.3,
    sensitiveKeywords: config.DEFAULT_SENSITIVE_KEYWORDS,
    verticalNotice: { enabled: false, text: '' },
  });
  const bad = aggregate.aggregateConfigOf({ aggregate: { keywords: 'not-array', searchProvider: 42, dailyLimit: -5, similarityThreshold: 0 } });
  assert.deepStrictEqual(bad.keywords, []);
  assert.strictEqual(bad.provider, 'bocha');
  assert.strictEqual(bad.dailyLimit, 10);
  assert.strictEqual(bad.similarityThreshold, 0.3);
  const full = aggregate.aggregateConfigOf({
    aggregate: { keywords: ['科技'], whitelist: ['who.int'], searchProvider: 'tavily', searchApiKey: 'k', dailyLimit: 5, similarityThreshold: 0.4 },
  });
  assert.deepStrictEqual(full, {
    keywords: ['科技'], whitelist: ['who.int'], provider: 'tavily',
    providerLabel: 'Tavily', providerNative: false, providerHost: 'api.tavily.com',
    apiKey: 'k', keyFromLlm: false, canReuseLlmKey: false,
    llmHost: '', llmNativeProvider: null,
    dailyLimit: 5, similarityThreshold: 0.4,
    sensitiveKeywords: config.DEFAULT_SENSITIVE_KEYWORDS,
    verticalNotice: { enabled: false, text: '' },
  });
});

test('config 契约点：SEARCH_PROVIDERS 与适配层一致；敏感词默认预设与领域提示默认关闭', () => {
  // v2.2：native 通道 deepseek / bigmodel（可复用大模型 Key）+ 独立服务 bocha / tavily / serpapi
  assert.deepStrictEqual(config.SEARCH_PROVIDERS, ['bocha', 'deepseek', 'bigmodel', 'tavily', 'serpapi']);
  for (const p of config.SEARCH_PROVIDERS) assert.ok(aggregate.ADAPTERS[p], `适配层应支持 ${p}`);
  assert.deepStrictEqual(config.DEFAULT_SENSITIVE_KEYWORDS, ['断食', '辟谷', '轻断食', '生酮', '减重药物', '降脂药物', '催吐', '绝食', '代餐替代']);
  // 默认配置含 v2 增量块（渲染层设置页的落点）
  const c = config.defaultConfig();
  assert.deepStrictEqual(c.aggregate, {
    articleMode: '', profilePath: '', imagesEnabled: false, imagesDir: '', includeCode: false, repoPath: '', productName: '', promotion: '',
    keywords: [], whitelist: [], searchProvider: 'bocha', searchApiKey: '',
    dailyLimit: 10, autoPickCount: 1, autoSkipSensitive: true, autoRewriteAttempts: 5, autoForceUpload: true, similarityThreshold: 0.3,
    verticalNotice: { enabled: false, text: '' },
    sensitiveKeywords: config.DEFAULT_SENSITIVE_KEYWORDS,
  });
  assert.deepStrictEqual(Object.keys(c.project), ['description', 'techTerms', 'audience', 'styleExtra']);
});
