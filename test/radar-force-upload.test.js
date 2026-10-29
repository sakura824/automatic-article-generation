'use strict';
/**
 * radar-force-upload.test.js —— 选题雷达全自动的重写策略（v2.4）：
 * maxRewrites 参数控制重写循环次数（默认 2 不变，自动模式传配置值）；
 * 材料=mock 稿原文时相似度必然超标 → 重写用尽返回 needsRewrite（上传决策由调度层按
 * autoForceUpload 分流，属纯配置分支，已在 scheduler-host 中实现）。
 */
process.env.WECHAT_DAILY_MOCK = '1';

const test = require('node:test');
const assert = require('node:assert');
const aggregate = require('../src/core/aggregate');
const { MOCK_SEARCH_RESULTS } = require('../src/core/mock');
const { tmpDir } = require('./helpers');

const DEPS = { retryDelayMs: 0 };
const CFG = {
  llm: { model: 'glm-4.6' },
  aggregate: { keywords: ['科技'], whitelist: [], searchProvider: 'bocha', searchApiKey: '', dailyLimit: 10, similarityThreshold: 0.3 },
};

/** 生成一份 mock 稿，把正文原样当「来源材料」喂回去 → 相似度必然超标 */
async function seedLeakedMaterial() {
  const dir = tmpDir();
  const first = await aggregate.composeFromTopics(
    CFG,
    { topics: [{ id: 'topic-seed', title: '种子选题', url: MOCK_SEARCH_RESULTS[0].url }], dataDir: dir },
    DEPS
  );
  return {
    leakedText: first.article.title + first.article.digest + first.article.html,
    topics: [{ id: 'topic-leak', title: '泄漏选题', url: MOCK_SEARCH_RESULTS[1].url }],
  };
}

test('maxRewrites：不传时保持默认 2 次重写（手动路径行为不变）', async () => {
  const { leakedText, topics } = await seedLeakedMaterial();
  const r = await aggregate.composeFromTopics(
    CFG,
    { topics, materials: [{ text: leakedText }], dataDir: tmpDir() },
    DEPS
  );
  assert.strictEqual(r.needsRewrite, true);
  assert.strictEqual(r.similarity.attempts, 1 + aggregate.REWRITE_ATTEMPTS);
  assert.strictEqual(r.similarity.rewriteAttempts, aggregate.REWRITE_ATTEMPTS);
});

test('maxRewrites：传 5 → 重写 5 次（全自动模式语义：没通过就一直写到通过）', async () => {
  const { leakedText, topics } = await seedLeakedMaterial();
  const r = await aggregate.composeFromTopics(
    CFG,
    { topics, materials: [{ text: leakedText }], maxRewrites: 5, dataDir: tmpDir() },
    DEPS
  );
  assert.strictEqual(r.needsRewrite, true, '5 次重写后仍超标（材料即原文，必然不通过）');
  assert.strictEqual(r.similarity.attempts, 6);
  assert.strictEqual(r.similarity.rewriteAttempts, 5);
});

test('maxRewrites：中途通过则提前结束', async () => {
  // 材料=mock 稿原文时第 1 稿必然超标；不提供材料（正常 mock 流程）时第 1 稿即通过 → attempts=1
  const { topics } = await seedLeakedMaterial();
  const r = await aggregate.composeFromTopics(
    CFG,
    { topics, maxRewrites: 5, dataDir: tmpDir() },
    DEPS
  );
  assert.strictEqual(r.needsRewrite, false);
  assert.strictEqual(r.similarity.attempts, 1);
  assert.strictEqual(r.similarity.rewriteAttempts, 0);
});

test('maxRewrites：越界值收敛到上限 10，非法负值回落默认 2（与不传一致）', async () => {
  const { leakedText, topics } = await seedLeakedMaterial();
  const capped = await aggregate.composeFromTopics(
    CFG,
    { topics, materials: [{ text: leakedText }], maxRewrites: 99, dataDir: tmpDir() },
    DEPS
  );
  assert.strictEqual(capped.similarity.rewriteAttempts, 10);
  const invalid = await aggregate.composeFromTopics(
    CFG,
    { topics, materials: [{ text: leakedText }], maxRewrites: -1, dataDir: tmpDir() },
    DEPS
  );
  assert.strictEqual(invalid.similarity.rewriteAttempts, aggregate.REWRITE_ATTEMPTS);
  assert.strictEqual(invalid.needsRewrite, true);
});
