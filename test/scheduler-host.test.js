'use strict';
/**
 * scheduler-host.test.js —— 调度宿主的两条执行路径（v2.2）：
 * mode=auto 走仓库自动（要求仓库路径）、mode=pool 走内容池（不要求仓库路径）。
 * 重点锁死三条语义：
 * 1. 池空 → 不写 lastScheduledDate（用户当天补题目后能自动补跑，而不是"明天见"）；
 * 2. 池里有待写条目 → 触发 startPool 且写当天标记；
 * 3. 配置不全（内容池缺大模型 Key/公众号凭证，仓库自动缺仓库路径）→ 不触发、不写标记。
 * 宿主内部用 new Date()，因此把定时时间设为 00:00 保证「今天已过点」，避免依赖运行时刻。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const pool = require('../src/core/pool');
const { createSchedulerHost } = require('../main/scheduler-host');
const { tmpDir } = require('./helpers');

function makeLogger() {
  const lines = [];
  return {
    lines,
    info: (m) => lines.push(['INFO', m]),
    warn: (m) => lines.push(['WARN', m]),
    error: (m) => lines.push(['ERROR', m]),
    scrub: (s) => s,
    registerSecret: () => {},
  };
}

function makeStore(cfg, state) {
  const calls = { saved: [] };
  return {
    calls,
    loadFullConfig: () => cfg,
    loadState: () => JSON.parse(JSON.stringify(state)),
    saveStateMerged: (s) => {
      calls.saved.push(JSON.parse(JSON.stringify(s)));
      Object.assign(state, s);
    },
  };
}

function makeRunManager(running = false) {
  const calls = { start: [], startPool: [] };
  return {
    calls,
    isRunning: () => running,
    start: (opts) => {
      calls.start.push(opts);
      return { ok: true, runId: 'run-auto' };
    },
    startPool: (opts) => {
      calls.startPool.push(opts);
      return { ok: true, runId: 'run-pool' };
    },
  };
}

const CFG_POOL_OK = {
  llm: { apiKey: 'sk-llm' },
  wechat: { appId: 'wx1', appSecret: 'sec' },
  app: { schedule: { enabled: true, time: '00:00', mode: 'pool' } },
};

const CFG_AUTO_OK = {
  llm: { apiKey: 'sk-llm' },
  wechat: { appId: 'wx1', appSecret: 'sec' },
  content: { repoPath: '/tmp/repo' },
  app: { schedule: { enabled: true, time: '00:00', mode: 'auto' } },
};

function bootHost({ cfg, dataDir, runManager, missingAutoConfig, missingPoolConfig, state }) {
  const logger = makeLogger();
  const store = makeStore(cfg, state || { lastScheduledDate: null, history: [] });
  const host = createSchedulerHost({
    dataDir,
    store,
    logger,
    runManager,
    tray: { setTooltip() {} },
    missingAutoConfig: missingAutoConfig || (() => []),
    missingPoolConfig: missingPoolConfig || (() => []),
  });
  host.start(); // 立即执行一次 boot tick（补跑判定）
  host.stop();
  return { host, store, logger };
}

test('内容池模式：池空 → 报 skipped 且不写 lastScheduledDate（当天补题目可自动补跑）', () => {
  const dataDir = tmpDir();
  const runManager = makeRunManager();
  const { store, logger } = bootHost({ cfg: CFG_POOL_OK, dataDir, runManager });

  assert.strictEqual(runManager.calls.startPool.length, 0);
  assert.strictEqual(runManager.calls.start.length, 0);
  assert.strictEqual(store.calls.saved.length, 0, '池空时不得写标记');
  assert.ok(
    logger.lines.some(([, m]) => /没有待写条目/.test(m)),
    '应留下一条「池空」提示'
  );
});

test('内容池模式：有 pending 条目 → 触发 startPool 并写入当天 lastScheduledDate', () => {
  const dataDir = tmpDir();
  const p = pool.defaultPool();
  pool.addItem(p, { title: '分级阅读怎么选书' });
  pool.savePool(dataDir, p);

  const runManager = makeRunManager();
  const state = { lastScheduledDate: null, history: [] };
  const { store } = bootHost({ cfg: CFG_POOL_OK, dataDir, runManager, state });

  assert.strictEqual(runManager.calls.startPool.length, 1);
  assert.strictEqual(runManager.calls.start.length, 0, '内容池模式不得走 git 管线');
  assert.strictEqual(store.calls.saved.length, 1);
  const day = store.calls.saved[0].lastScheduledDate;
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
});

test('内容池模式：缺大模型 Key/公众号凭证 → 不触发、不写标记', () => {
  const dataDir = tmpDir();
  const p = pool.defaultPool();
  pool.addItem(p, { title: '有内容但没配 Key' });
  pool.savePool(dataDir, p);

  const runManager = makeRunManager();
  const { store, logger } = bootHost({
    cfg: { llm: { apiKey: '' }, wechat: { appId: '', appSecret: '' }, app: { schedule: { enabled: true, time: '00:00', mode: 'pool' } } },
    dataDir,
    runManager,
    missingPoolConfig: () => ['大模型 API Key', '公众号 AppID'],
  });

  assert.strictEqual(runManager.calls.startPool.length, 0);
  assert.strictEqual(store.calls.saved.length, 0);
  assert.ok(logger.lines.some(([lv, m]) => lv === 'WARN' && /内容池.*缺少/.test(m)));
});

test('仓库自动模式：没配仓库路径 → 不触发（判据与内容池互不干扰）', () => {
  const dataDir = tmpDir();
  const p = pool.defaultPool();
  pool.addItem(p, { title: '池里有内容也不该走 auto' });
  pool.savePool(dataDir, p);

  const runManager = makeRunManager();
  const { store } = bootHost({
    cfg: { ...CFG_AUTO_OK, content: { repoPath: '' } },
    dataDir,
    runManager,
    missingAutoConfig: () => ['代码仓库路径'],
  });

  assert.strictEqual(runManager.calls.start.length, 0);
  assert.strictEqual(runManager.calls.startPool.length, 0);
  assert.strictEqual(store.calls.saved.length, 0);
});

test('仓库自动模式：配置齐全 → 走 git 管线 start（不受内容池影响）', () => {
  const dataDir = tmpDir();
  const runManager = makeRunManager();
  const { store } = bootHost({ cfg: CFG_AUTO_OK, dataDir, runManager });

  assert.strictEqual(runManager.calls.start.length, 1);
  assert.strictEqual(runManager.calls.start[0].cause, 'catchup'); // 启动补跑
  assert.strictEqual(runManager.calls.startPool.length, 0);
  assert.strictEqual(store.calls.saved.length, 1);
});

test('已有任务在跑（E_BUSY）→ 不写标记，留给 30s 后的 tick 重试', () => {
  const dataDir = tmpDir();
  const p = pool.defaultPool();
  pool.addItem(p, { title: '排队中' });
  pool.savePool(dataDir, p);

  const runManager = makeRunManager(true); // isRunning = true
  const { store, logger } = bootHost({ cfg: CFG_POOL_OK, dataDir, runManager });

  assert.strictEqual(runManager.calls.startPool.length, 0);
  assert.strictEqual(store.calls.saved.length, 0);
  assert.ok(logger.lines.some(([, m]) => /当前有任务在运行/.test(m)));
});

test('getScheduleInfo：内容池模式返回 mode 与 poolPending，仓库模式 poolPending 为 null', () => {
  const poolDir = tmpDir();
  const p = pool.defaultPool();
  pool.addItem(p, { title: 'A' });
  pool.addItem(p, { title: 'B' });
  pool.markUsed(p, p.items[0].id, { articleId: 'art-1' });
  pool.savePool(poolDir, p);

  const hostPool = createSchedulerHost({
    dataDir: poolDir,
    store: makeStore(CFG_POOL_OK, { lastScheduledDate: null }),
    logger: makeLogger(),
    runManager: makeRunManager(),
    tray: { setTooltip() {} },
  });
  const info = hostPool.getScheduleInfo();
  assert.strictEqual(info.mode, 'pool');
  assert.strictEqual(info.poolPending, 1);
  assert.strictEqual(info.enabled, true);
  assert.strictEqual(path.basename(poolDir).length > 0, true);

  const hostAuto = createSchedulerHost({
    dataDir: tmpDir(),
    store: makeStore(CFG_AUTO_OK, { lastScheduledDate: null }),
    logger: makeLogger(),
    runManager: makeRunManager(),
    tray: { setTooltip() {} },
  });
  assert.strictEqual(hostAuto.getScheduleInfo().mode, 'auto');
  assert.strictEqual(hostAuto.getScheduleInfo().poolPending, null);
});
