'use strict';
/**
 * pool.test.js —— 内容池（定时自动成文的题目队列）：
 * 存取往返与损坏兜底、入参校验、FIFO 取条目、状态流转（used/skipped/失败不消耗）、
 * 连续失败自动跳过、修改/删除/统计/重新排队。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../src/core/pool');
const { tmpDir } = require('./helpers');

const CFG_ITEM = { title: '分级阅读怎么给 5 岁孩子选书', material: '素材正文', emphasis: '强调选书标准' };

/* ------------------------------ 存取与校验 ------------------------------ */

test('loadPool：无文件 → 空池；结构异常 → 空池；损坏 JSON → E_IO', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(pool.loadPool(dir), { version: 1, items: [] });

  const bad = tmpDir();
  fs.writeFileSync(path.join(bad, 'content-pool.json'), '{"items":"not-array"}', 'utf8');
  assert.deepStrictEqual(pool.loadPool(bad).items, []);

  const broken = tmpDir();
  fs.writeFileSync(path.join(broken, 'content-pool.json'), '{oops', 'utf8');
  assert.throws(() => pool.loadPool(broken), (e) => e.code === 'E_IO');
});

test('savePool / loadPool 往返：条目、状态、attempts 原样保留', () => {
  const dir = tmpDir();
  const p = pool.defaultPool();
  const { item } = pool.addItem(p, CFG_ITEM, { now: '2026-10-29T01:00:00Z' });
  pool.savePool(dir, p);

  const back = pool.loadPool(dir);
  assert.strictEqual(back.items.length, 1);
  assert.strictEqual(back.items[0].id, item.id);
  assert.strictEqual(back.items[0].title, CFG_ITEM.title);
  assert.strictEqual(back.items[0].status, 'pending');
  assert.strictEqual(back.items[0].attempts, 0);
});

test('addItem：题目必填、长度上限、池容量上限', () => {
  const p = pool.defaultPool();
  assert.throws(() => pool.addItem(p, { title: '   ' }), (e) => e.code === 'E_INVALID_INPUT');
  assert.throws(() => pool.addItem(p, { title: 'x'.repeat(pool.MAX_TITLE + 1) }), (e) => e.code === 'E_INVALID_INPUT');
  assert.throws(() => pool.addItem(p, { title: 't', material: 'x'.repeat(pool.MAX_MATERIAL + 1) }), (e) => e.code === 'E_INVALID_INPUT');
  assert.throws(() => pool.addItem(p, { title: 't', emphasis: 'x'.repeat(pool.MAX_EMPHASIS + 1) }), (e) => e.code === 'E_INVALID_INPUT');

  const full = pool.defaultPool();
  for (let i = 0; i < pool.MAX_ITEMS; i++) full.items.push({ id: `pl-x-${i}`, title: 't', status: 'pending', createdAt: '2026-01-01T00:00:00Z' });
  assert.throws(() => pool.addItem(full, { title: 'one more' }), (e) => e.code === 'E_INVALID_INPUT');

  // 只给题目（不给素材）是合法的：成文时走「题目展开」分支
  const onlyTitle = pool.addItem(pool.defaultPool(), { title: '只给题目' });
  assert.strictEqual(onlyTitle.item.material, '');
  assert.strictEqual(onlyTitle.item.emphasis, '');
});

/* ------------------------------ 队列语义 ------------------------------ */

test('nextPending：FIFO（先入池先写），createdAt 相同按数组顺序；used/skipped 不参与', () => {
  const p = pool.defaultPool();
  const a = pool.addItem(p, { title: 'A' }, { now: '2026-10-01T00:00:00Z' }).item;
  const b = pool.addItem(p, { title: 'B' }, { now: '2026-10-02T00:00:00Z' }).item;
  const c = pool.addItem(p, { title: 'C' }, { now: '2026-10-03T00:00:00Z' }).item;

  assert.strictEqual(pool.nextPending(p).id, a.id);

  pool.markUsed(p, a.id, { articleId: 'art-1' });
  assert.strictEqual(pool.nextPending(p).id, b.id);

  pool.markSkipped(p, b.id, { reason: '人工跳过' });
  assert.strictEqual(pool.nextPending(p).id, c.id);

  pool.markUsed(p, c.id, { articleId: 'art-2' });
  assert.strictEqual(pool.nextPending(p), null);

  // 同秒入池：按数组顺序
  const same = pool.defaultPool();
  const t = '2026-10-29T08:00:00Z';
  const first = pool.addItem(same, { title: '第一条' }, { now: t }).item;
  pool.addItem(same, { title: '第二条' }, { now: t });
  assert.strictEqual(pool.nextPending(same).id, first.id);

  // 乱序写入（用户手工编辑过文件）：仍按 createdAt 取最早
  const messy = pool.defaultPool();
  messy.items.push({ id: 'pl-late', title: '晚', status: 'pending', createdAt: '2026-12-01T00:00:00Z' });
  messy.items.push({ id: 'pl-early', title: '早', status: 'pending', createdAt: '2026-01-01T00:00:00Z' });
  assert.strictEqual(pool.nextPending(messy).id, 'pl-early');
});

test('markAttemptFailed：失败不吃掉选题（保持 pending），连续 3 次自动跳过', () => {
  const p = pool.defaultPool();
  const it = pool.addItem(p, { title: '会失败的一条' }).item;

  let r = pool.markAttemptFailed(p, it.id, { error: 'LLM 超时' });
  assert.strictEqual(r.exhausted, false);
  assert.strictEqual(r.item.status, 'pending');
  assert.strictEqual(r.item.attempts, 1);
  assert.strictEqual(pool.nextPending(p).id, it.id); // 第二天仍会重试

  pool.markAttemptFailed(p, it.id, { error: 'LLM 超时' });
  r = pool.markAttemptFailed(p, it.id, { error: 'LLM 超时' });
  assert.strictEqual(r.exhausted, true);
  assert.strictEqual(r.item.status, 'skipped');
  assert.match(r.item.skipReason, /连续失败 3 次/);
  assert.strictEqual(pool.nextPending(p), null);
});

test('markUsed 清除 lastError；markSkipped 记录原因；未找到 id → E_NOT_FOUND', () => {
  const p = pool.defaultPool();
  const it = pool.addItem(p, { title: 'T' }).item;
  pool.markAttemptFailed(p, it.id, { error: '短暂失败' });
  assert.strictEqual(it.lastError, '短暂失败');

  pool.markUsed(p, it.id, { articleId: 'art-9' });
  assert.strictEqual(it.status, 'used');
  assert.strictEqual(it.articleId, 'art-9');
  assert.strictEqual(it.lastError, undefined);

  assert.throws(() => pool.markUsed(p, 'pl-none'), (e) => e.code === 'E_NOT_FOUND');
  assert.throws(() => pool.markSkipped(p, 'pl-none'), (e) => e.code === 'E_NOT_FOUND');
  assert.throws(() => pool.markAttemptFailed(p, 'pl-none'), (e) => e.code === 'E_NOT_FOUND');
});

/* ------------------------------ 维护类操作 ------------------------------ */

test('updateItem：只改内容字段，不允许改状态；空题目被拒', () => {
  const p = pool.defaultPool();
  const it = pool.addItem(p, CFG_ITEM).item;

  pool.updateItem(p, it.id, { title: '新题目', emphasis: '新强调点' });
  assert.strictEqual(it.title, '新题目');
  assert.strictEqual(it.emphasis, '新强调点');
  assert.strictEqual(it.material, CFG_ITEM.material); // 未传的字段不动

  // 状态不随 patch 变化（状态只能经 markUsed/markSkipped 流转）
  pool.updateItem(p, it.id, { status: 'used', title: '改题' });
  assert.strictEqual(it.status, 'pending');

  assert.throws(() => pool.updateItem(p, it.id, { title: '' }), (e) => e.code === 'E_INVALID_INPUT');
  assert.throws(() => pool.updateItem(p, 'pl-none', { title: 'x' }), (e) => e.code === 'E_NOT_FOUND');
});

test('removeItem 幂等；findItem；stats 与 resetUsed', () => {
  const p = pool.defaultPool();
  const a = pool.addItem(p, { title: 'A' }).item;
  const b = pool.addItem(p, { title: 'B' }).item;
  const c = pool.addItem(p, { title: 'C' }).item;

  pool.markUsed(p, a.id, { articleId: 'art-a' });
  pool.markSkipped(p, b.id, { reason: '不要了' });

  assert.deepStrictEqual(pool.stats(p), { total: 3, pending: 1, used: 1, skipped: 1 });
  assert.strictEqual(pool.findItem(p, c.id).id, c.id);
  assert.strictEqual(pool.findItem(p, 'pl-none'), null);

  assert.strictEqual(pool.removeItem(p, c.id), true);
  assert.strictEqual(pool.removeItem(p, c.id), false);
  assert.strictEqual(pool.stats(p).total, 2);

  assert.strictEqual(pool.resetUsed(p), 1);
  assert.strictEqual(pool.findItem(p, a.id).status, 'pending');
  assert.strictEqual(pool.findItem(p, a.id).articleId, undefined);
  assert.strictEqual(pool.nextPending(p).id, a.id); // 放回队列后仍按 createdAt 排在最前
});
