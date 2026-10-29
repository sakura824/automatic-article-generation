'use strict';
/**
 * v2-mock.test.js —— WECHAT_DAILY_MOCK=1 下的 v2 确定性桩与端到端链路（PRD v2 §8：
 * 对话与素材两条新流程全程用 mock 模式验证；聚合链路同理）。
 * 断言：所有网络函数短路到 mock.js 桩（注入的 fetch 一旦被调用立即失败）、输出确定性可断言。
 * 本文件在顶部打开 mock 开关（node --test 每个文件独立进程，互不影响）。
 */
process.env.WECHAT_DAILY_MOCK = '1';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const state = require('../src/core/state');
const chat = require('../src/core/chat');
const style = require('../src/core/style');
const aggregate = require('../src/core/aggregate');
const { isMock, MOCK_SEARCH_RESULTS } = require('../src/core/mock');
const { tmpDir } = require('./helpers');

assert.strictEqual(isMock(), true, '本文件必须在 mock 模式下运行');

let fetchCalled = 0;
const forbiddenFetch = async () => {
  fetchCalled += 1;
  throw new Error('mock 模式下不应发起任何网络请求');
};
const DEPS = { fetch: forbiddenFetch, retryDelayMs: 0 };
const CFG = {
  llm: { model: 'glm-4.6' },
  project: { description: '任务打卡小程序' },
  aggregate: { keywords: ['科技', '生活'], whitelist: [], searchProvider: 'bocha', searchApiKey: '', dailyLimit: 10, similarityThreshold: 0.3 },
};

test('对话共创（mock 端到端）：多轮回复 → 整理成文章，全程零网络且输出确定性', async () => {
  const dir = tmpDir();
  const s = chat.newSession({ id: 'chat-e2e', title: '深度工作选题', now: '2026-10-29T08:00:00Z' });
  chat.addMessage(s, { role: 'user', content: '想写一篇深度工作的科普', now: '2026-10-29T08:00:01Z' });
  const r1 = await chat.chatReply(CFG, s, { deps: DEPS });
  assert.strictEqual(fetchCalled, 0);
  assert.ok(r1.reply.content.startsWith('【演示回复】收到你的想法：「想写一篇深度工作的科普」'));
  chat.addMessage(s, { role: 'user', content: '请把这轮讨论整理成文章', now: '2026-10-29T08:01:00Z' });
  const c1 = await chat.composeFromSession(CFG, s, { deps: DEPS });
  const c2 = await chat.composeFromSession(CFG, s, { deps: DEPS });
  assert.strictEqual(c1.raw, c2.raw, '同输入输出字节一致');
  assert.ok(c1.article.title.startsWith('【演示】深度工作选题'));
  assert.ok(c1.article.html.includes('<p'));
  // 持久化往返
  chat.saveSession(dir, s);
  assert.deepStrictEqual(chat.loadSession(dir, 'chat-e2e').messages.length, s.messages.length);
});

test('素材成文（mock 端到端）：素材 + 想强调的点 → 成文，零网络且标题内嵌强调点', async () => {
  const m1 = await chat.composeMaterial(CFG, { material: '深蹲三个要点：髋、膝、踝对齐；呼吸节奏；负重渐进。', emphasis: '循序渐进不受伤', deps: DEPS });
  const m2 = await chat.composeMaterial(CFG, { material: '深蹲三个要点：髋、膝、踝对齐；呼吸节奏；负重渐进。', emphasis: '循序渐进不受伤', deps: DEPS });
  assert.strictEqual(fetchCalled, 0);
  assert.strictEqual(m1.raw, m2.raw);
  assert.ok(m1.article.title.includes('循序渐进不受伤'));
  // 空素材 → E_INVALID_INPUT（mock 下仍保持禁用态逻辑可测）
  await assert.rejects(() => chat.composeMaterial(CFG, { material: '  ', deps: DEPS }), (e) => e.code === 'E_INVALID_INPUT');
});

test('文风画像（mock 端到端）：分析 → 画像 → few-shot → 注入块，输出确定性', async () => {
  const samples = [];
  style.addSample(samples, { name: '样文A', text: '第一段抛场景。第二段给数据！结尾提问？', now: '2026-10-28T00:00:00Z' });
  style.addSample(samples, { name: '样文B', text: '另一个样文内容，讨论训练安排与恢复。', now: '2026-10-28T01:00:00Z' });
  const r1 = await style.analyzeStyle(CFG, samples, { deps: DEPS, now: '2026-10-29T00:00:00Z' });
  const r2 = await style.analyzeStyle(CFG, samples, { deps: DEPS, now: '2026-10-29T00:00:00Z' });
  assert.strictEqual(fetchCalled, 0);
  assert.deepStrictEqual(r1.profile, r2.profile, '画像确定性');
  assert.strictEqual(r1.profile.sampleCount, 2);
  assert.ok(r1.profile.qualitative.opening.includes('2 篇样文'));
  assert.ok(r1.profile.bannedWords.includes('深入探讨')); // mock LLM 增补并集
  const few = style.pickFewShots(samples, '训练安排与恢复', { count: 2 });
  assert.strictEqual(few[0].name, '样文B');
  const inj = style.buildStyleInjection(r1.profile, few);
  assert.ok(inj.includes('【文风画像】') && inj.includes('【范文参考】') && inj.includes('【AI 味禁用词'));
});

test('选题雷达（mock 端到端）：搜索→去重→分级→清单落盘，L1 靠前、重复被合并', async () => {
  const dir = tmpDir();
  const r = await aggregate.runTopicRadar(CFG, { dataDir: dir, date: '2026-10-29', now: '2026-10-29T12:00:00Z', deps: DEPS });
  assert.strictEqual(fetchCalled, 0);
  assert.strictEqual(r.ok, true);
  // 2 个关键词 × 7 条 mock 结果 = 14 条：跨关键词同 URL 7 条 + 组内 URL 重复 1 条 + 标题近似 1 条
  assert.strictEqual(r.removedCount, 2 * MOCK_SEARCH_RESULTS.length - 5);
  assert.strictEqual(r.topics.length, 5);
  assert.deepStrictEqual(r.keywordErrors, []);
  // L1 权威来源排前
  assert.strictEqual(r.topics[0].source.label, 'L1');
  assert.ok(r.topics[0].source.url.includes('who.int'));
  assert.ok(r.topics.some((t) => t.source.label === 'L2'));
  assert.ok(r.topics.every((t) => t.id.startsWith('topic-') && t.heat >= 1 && t.heat <= 100));
  // 落盘可回读
  const loaded = aggregate.loadRadar(dir, '2026-10-29');
  assert.deepStrictEqual(loaded.topics, r.topics);
  // 同日再跑 → 清单一致（确定性）
  const r2 = await aggregate.runTopicRadar(CFG, { dataDir: dir, date: '2026-10-29', now: '2026-10-29T12:00:00Z', deps: DEPS });
  assert.deepStrictEqual(r2.topics, r.topics);
});

test('聚合成文（mock 端到端）：勾选 2 条 → 抓正文 → 成文 → 相似度通过 → 四件套落盘 + 历史记录', async () => {
  const dir = tmpDir();
  // 先跑一次雷达生成当日清单，再从清单勾选 2 条
  const radar = await aggregate.runTopicRadar(CFG, { dataDir: dir, date: '2026-10-29', now: '2026-10-29T12:00:00Z', deps: DEPS });
  assert.strictEqual(radar.ok, true);
  const topics = radar.topics.slice(0, 2); // WHO(L1) + 政府指南(L1)
  const st = state.defaultState();
  const r = await aggregate.composeFromTopics(
    CFG,
    { topics, date: '2026-10-29', now: '2026-10-29T13:00:00Z', dataDir: dir, state: st },
    DEPS
  );
  assert.strictEqual(fetchCalled, 0);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.needsRewrite, false);
  assert.ok(r.article.title.startsWith('【演示】'));
  // verticalNotice 默认关闭 → mock 稿文末不再硬编码固定提示行（提示改由 verticalNotice 注入逻辑负责）
  assert.ok(!r.article.html.includes('请咨询专业人士'), '默认关闭时 mock 稿文末不带固定提示');
  // 四件套
  assert.ok(fs.existsSync(path.join(r.outDir, 'article.json')));
  const sourcesJson = JSON.parse(fs.readFileSync(path.join(r.outDir, 'sources.json'), 'utf8'));
  assert.strictEqual(sourcesJson.internal, true);
  assert.strictEqual(sourcesJson.sources.length, 2);
  assert.ok(sourcesJson.sources.every((x) => x.fetchState === 'ok'));
  assert.ok(sourcesJson.sources.every((x) => x.usedFor === '事实/共识/数据提取'));
  const similarityJson = JSON.parse(fs.readFileSync(path.join(r.outDir, 'similarity.json'), 'utf8'));
  assert.strictEqual(similarityJson.passed, true);
  const preview = fs.readFileSync(path.join(r.outDir, 'preview.html'), 'utf8');
  assert.ok(preview.startsWith('<!doctype html>'));
  // 来源清单不随文发布：正文不含来源链接
  assert.ok(!r.article.html.includes('who.int'));
  // 历史记录：origin=聚合 + id=batchId
  const entry = st.history.find((h) => h.id === r.batchId);
  assert.ok(entry && entry.origin === '聚合' && entry.status === 'generated');
});

test('聚合成文（mock 降级路径）：未知 URL 抓取失败 → snippet-only 如实记录', async () => {
  const dir = tmpDir();
  const topics = [{ id: 'topic-unknown', title: '抓不到正文的来源', url: 'https://unknown.example.com/x', summary: '只有搜索摘要可用。' }];
  const r = await aggregate.composeFromTopics(CFG, { topics, dataDir: dir, date: '2026-10-29', now: '2026-10-29T13:00:00Z' }, DEPS);
  assert.strictEqual(fetchCalled, 0);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sources[0].fetchState, 'snippet-only');
  assert.match(r.sources[0].fetchError, /mock 模式未提供该 URL 的正文样例/);
  assert.strictEqual(r.sources[0].excerpt, '只有搜索摘要可用。');
});

test('聚合成文（mock 相似度防线）：材料即 mock 稿原文 → 超阈值重写 2 次仍不通过 → needsRewrite 信号', async () => {
  // 先生成一份 mock 稿，把它的正文原样作为「来源材料」喂回去 → 相似度必然 1.0
  const first = await aggregate.composeFromTopics(
    CFG,
    { topics: [{ id: 'topic-seed', title: '种子选题', url: MOCK_SEARCH_RESULTS[0].url }] },
    DEPS
  );
  const leakedText = first.article.title + first.article.digest + first.article.html;
  const second = await aggregate.composeFromTopics(
    CFG,
    { topics: [{ id: 'topic-leak', title: '泄漏选题', url: MOCK_SEARCH_RESULTS[1].url }], materials: [{ text: leakedText }], threshold: 0.3 },
    DEPS
  );
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.needsRewrite, true, '超阈值必须返回重写信号');
  assert.strictEqual(second.similarity.passed, false);
  assert.strictEqual(second.similarity.attempts, 1 + aggregate.REWRITE_ATTEMPTS);
  assert.ok(second.similarity.maxRatio > 0.3);
});

test('mock 桩直接断言：搜索结果与抓取正文的确定性', () => {
  assert.strictEqual(aggregate.searchWeb.length >= 1, true);
  const a = aggregate.searchWeb({}, DEPS);
  // 同步路径在 mock 下返回 Promise —— 等价性交给上面的端到端用例，这里断言已知条目数
  return a.then((items) => {
    assert.strictEqual(items.length, MOCK_SEARCH_RESULTS.length);
    assert.ok(items.every((x) => x.title && x.url));
  });
});
