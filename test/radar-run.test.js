'use strict';
/**
 * radar-run.test.js —— 选题雷达「全自动」整条链路（mock 模式，无网络、无 Electron）：
 * 搜索（桩）→ 自动选题（跳过敏感）→ 综合成文（桩）→ 上传草稿箱（桩）→ 历史入列。
 * 用真实的 createRunManager，验证事件与状态语义，避免只测纯函数却接错线。
 */
process.env.WECHAT_DAILY_MOCK = '1';

const test = require('node:test');
const assert = require('node:assert');
const { createRunManager } = require('../main/scheduler-host');
const { defaultConfig } = require('../src/core/config');
const stateCore = require('../src/core/state');
const { tmpDir } = require('./helpers');

function makeEnv(overrides) {
  const dataDir = tmpDir();
  const cfg = defaultConfig();
  cfg.llm.apiKey = 'sk-mock-key';
  cfg.llm.model = 'glm-4.6';
  cfg.wechat.appId = 'wxmock';
  cfg.wechat.appSecret = 'mocksecret';
  cfg.aggregate.keywords = ['科技', '教育'];
  cfg.aggregate.searchProvider = 'bocha';
  cfg.aggregate.searchApiKey = 'mock-search-key';
  cfg.aggregate.articleMode = 'web';
  cfg.aggregate.productName = '示例产品';
  Object.assign(cfg, overrides ? overrides(cfg) || {} : {});

  let state = stateCore.loadState(dataDir);
  const events = [];
  const store = {
    paths: { dataDir },
    loadFullConfig: () => cfg,
    loadState: () => state,
    // 与真实 store 同语义：落盘并同步内存副本
    saveStateMerged: (s) => { state = stateCore.saveStateMerged(dataDir, s); return state; },
  };
  const logger = { info() {}, warn() {}, error() {}, scrub: (v) => v, log() {} };
  const sendEvent = (name, payload) => events.push({ name, payload });
  const notify = () => {};
  const runManager = createRunManager({ dataDir, store, logger, sendEvent, notify });
  return { dataDir, cfg, store, events, runManager, getState: () => state };
}

function waitFinished(events, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = events.find((e) => e.name === 'run:finished');
      if (hit) { clearInterval(timer); resolve(hit.payload); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error('等待 run:finished 超时')); }
    }, 25);
  });
}

test('选题雷达全自动：搜索 → 自动选题 → 成文 → 上传草稿箱 → 历史入列', async () => {
  const env = makeEnv();
  const started = env.runManager.startRadar({ cause: 'manual' });
  assert.strictEqual(started.ok, true);
  assert.ok(started.runId);

  const done = await waitFinished(env.events);
  assert.strictEqual(done.status, 'uploaded', `应上传成功，实际：${JSON.stringify(done.error || done)}`);
  assert.ok(done.title && done.title.length > 0);
  assert.ok(typeof done.words === 'number' && done.words > 0);
  assert.strictEqual(env.runManager.isRunning(), false, '运行结束后必须释放互斥锁');

  // 进度事件：搜索 → 成文 → 上传 三段都要出现
  const stages = env.events.filter((e) => e.name === 'run:progress').map((e) => e.payload.stage);
  assert.ok(stages.includes(0) && stages.includes(1) && stages.includes(2), `缺少阶段进度：${stages}`);

  // 历史里应有一条「聚合」来源的记录，且已标记上传
  const hist = env.getState().history || [];
  const agg = hist.filter((h) => h.origin === '聚合');
  assert.strictEqual(agg.length, 1, `应有 1 条聚合记录，实际 ${agg.length}`);
  assert.strictEqual(agg[0].status, 'uploaded');
  assert.ok(agg[0].draftMediaId, '应记录草稿 media_id');
});

test('选题雷达全自动：并发触发被 E_BUSY 拒绝', async () => {
  const env = makeEnv();
  const first = env.runManager.startRadar({ cause: 'scheduled' });
  assert.strictEqual(first.ok, true);
  const second = env.runManager.startRadar({ cause: 'manual' });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error.code, 'E_BUSY');
  await waitFinished(env.events);
});

test('选题雷达全自动：关键词为空 → 运行失败并给出可操作原因', async () => {
  const env = makeEnv((cfg) => ({ aggregate: Object.assign({}, cfg.aggregate, { keywords: [] }) }));
  env.runManager.startRadar({ cause: 'manual' });
  const done = await waitFinished(env.events);
  assert.strictEqual(done.status, 'failed');
  assert.match(String(done.error.message), /关键词/);
});
