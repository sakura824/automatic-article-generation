'use strict';
/**
 * state.test.js —— state.json 读写：默认值、原子写、损坏处理、单日 upsert、markUploaded、筛选。
 */
delete process.env.WECHAT_DAILY_MOCK;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const state = require('../src/core/state');
const { tmpDir } = require('./helpers');

test('loadState：目录/文件不存在 → 默认形状', () => {
  const s = state.loadState(tmpDir());
  assert.deepStrictEqual(s, {
    lastHead: null,
    lastRunDate: null,
    lastScheduledDate: null,
    cover: null,
    history: [],
  });
});

test('saveState/loadState 往返 + 原子写（不留临时文件）', () => {
  const dir = tmpDir();
  const s = state.defaultState();
  s.lastHead = 'abc123';
  s.lastRunDate = '2026-10-29';
  s.lastScheduledDate = '2026-10-29';
  s.cover = { sha256: 'd1', mediaId: 'M1' };
  s.history.push({ date: '2026-10-29', title: 'T', status: 'uploaded', words: 1024, draftMediaId: 'D1' });
  state.saveState(dir, s);

  const loaded = state.loadState(dir);
  assert.deepStrictEqual(loaded, s);
  // 目录中只有 state.json，无 .tmp 残留
  assert.deepStrictEqual(fs.readdirSync(dir), ['state.json']);
  // 文件为合法 JSON
  assert.ok(JSON.parse(fs.readFileSync(state.statePath(dir), 'utf8')));
});

test('loadState：JSON 损坏 → E_IO（不静默重置）', () => {
  const dir = tmpDir();
  fs.writeFileSync(state.statePath(dir), '{oops', 'utf8');
  assert.throws(() => state.loadState(dir), (e) => {
    assert.strictEqual(e.code, 'E_IO');
    assert.match(e.message, /已损坏/);
    return true;
  });
});

test('loadState：history 非数组 → 回退空数组；其余字段合并', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    state.statePath(dir),
    JSON.stringify({ lastHead: 'h1', history: 'not-an-array' }),
    'utf8'
  );
  const s = state.loadState(dir);
  assert.strictEqual(s.lastHead, 'h1');
  assert.deepStrictEqual(s.history, []);
});

test('recordRun：单日单条 upsert，按日期升序', () => {
  const s = state.defaultState();
  state.recordRun(s, { date: '2026-10-27', title: 'A', status: 'uploaded', words: 100 });
  state.recordRun(s, { date: '2026-10-29', title: 'C', status: 'generated', words: 300 });
  state.recordRun(s, { date: '2026-10-28', title: 'B', status: 'skipped', words: null });
  assert.deepStrictEqual(
    s.history.map((r) => r.date),
    ['2026-10-27', '2026-10-28', '2026-10-29']
  );
  // 同日重跑 → 覆盖，不产生第二条
  state.recordRun(s, { date: '2026-10-28', title: 'B2', status: 'failed', words: 50, error: { code: 'E_WECHAT', message: 'x' } });
  assert.strictEqual(s.history.length, 3);
  const b = s.history.find((r) => r.date === '2026-10-28');
  assert.strictEqual(b.title, 'B2');
  assert.strictEqual(b.status, 'failed');
  assert.deepStrictEqual(b.error, { code: 'E_WECHAT', message: 'x' });
  // 缺 date/status → E_INVALID_INPUT
  assert.throws(() => state.recordRun(s, { status: 'failed' }), (e) => e.code === 'E_INVALID_INPUT');
  assert.throws(() => state.recordRun(s, { date: '2026-10-29' }), (e) => e.code === 'E_INVALID_INPUT');
});

test('markUploaded：更新状态与 draftMediaId 并清除 error；未知日期补一条', () => {
  const s = state.defaultState();
  state.recordRun(s, { date: '2026-10-29', title: 'T', status: 'failed', words: 10, error: { code: 'E_WECHAT', message: 'e' } });
  const entry = state.markUploaded(s, '2026-10-29', 'D9');
  assert.strictEqual(entry.status, 'uploaded');
  assert.strictEqual(entry.draftMediaId, 'D9');
  assert.strictEqual(entry.error, undefined);
  assert.strictEqual(s.history.length, 1);
  // 无记录的日期 → 补一条 uploaded
  state.markUploaded(s, '2026-10-30', 'DA');
  assert.strictEqual(s.history.length, 2);
  const e2 = s.history.find((r) => r.date === '2026-10-30');
  assert.strictEqual(e2.status, 'uploaded');
  assert.strictEqual(e2.draftMediaId, 'DA');
});

test('getHistory：筛选 + 新日期在前 + 返回副本', () => {
  const s = state.defaultState();
  state.recordRun(s, { date: '2026-10-25', title: 'A', status: 'uploaded', words: 1 });
  state.recordRun(s, { date: '2026-10-26', title: 'B', status: 'skipped', words: null });
  state.recordRun(s, { date: '2026-10-27', title: 'C', status: 'failed', words: 3 });
  state.recordRun(s, { date: '2026-10-28', title: 'D', status: 'uploaded', words: 4 });
  assert.deepStrictEqual(
    state.getHistory(s).map((r) => r.date),
    ['2026-10-28', '2026-10-27', '2026-10-26', '2026-10-25']
  );
  assert.deepStrictEqual(
    state.getHistory(s, 'uploaded').map((r) => r.date),
    ['2026-10-28', '2026-10-25']
  );
  assert.deepStrictEqual(state.getHistory(s, 'skipped').map((r) => r.title), ['B']);
  assert.deepStrictEqual(state.getHistory(s, 'failed').map((r) => r.date), ['2026-10-27']);
  assert.deepStrictEqual(state.getHistory(s, 'generated'), []);
  assert.deepStrictEqual(state.getHistory(s, 'all').length, 4);
  assert.deepStrictEqual(state.getHistory(s, undefined).length, 4); // 未知值 → 全部
  // 副本：修改返回值不影响原 state
  const rows = state.getHistory(s);
  rows[0].title = 'MUTATED';
  assert.strictEqual(s.history.find((r) => r.date === '2026-10-28').title, 'D');
});

test('recordRun/getHistory：同日多条按 createdAt 倒序（最近文章要显示最新一篇）', () => {
  const s = state.defaultState();
  state.recordRun(s, { date: '2026-10-29', id: 'a1', title: '早', status: 'generated', createdAt: '2026-10-29T01:00:00.000Z' });
  state.recordRun(s, { date: '2026-10-29', id: 'a2', title: '中', status: 'generated', createdAt: '2026-10-29T05:00:00.000Z' });
  state.recordRun(s, { date: '2026-10-29', id: 'a3', title: '晚', status: 'generated', createdAt: '2026-10-29T09:00:00.000Z' });
  assert.deepStrictEqual(state.getHistory(s).map((r) => r.title), ['晚', '中', '早']);
  // 来源筛选与默认分支同口径（此前 main/ipc 直接返回 state.history 会变成升序）
  state.recordRun(s, { date: '2026-10-29', id: 'm1', origin: '素材', title: '素材稿', status: 'generated', createdAt: '2026-10-29T10:00:00.000Z' });
  assert.deepStrictEqual(state.getHistory(s, 'all', '素材').map((r) => r.title), ['素材稿']);
  assert.deepStrictEqual(state.getHistory(s, 'all', '自动').map((r) => r.title), ['晚', '中', '早']);
});

test('mergeStates/saveStateMerged：旧快照保存不覆盖期间写入的历史与定时标记', () => {
  const dir = tmpDir();
  // 运行开始时的快照（此时 history 为空、lastScheduledDate=null）
  const snapshot = state.loadState(dir);
  snapshot.lastHead = 'HEAD-OLD';

  // 运行期间另一条链路写入成文 + 定时标记
  const live = state.loadState(dir);
  state.recordRun(live, { date: '2026-10-29', id: 'art-1', title: '素材成文', status: 'generated' });
  live.lastScheduledDate = '2026-10-29';
  state.saveState(dir, live);

  // 运行结束：用旧快照合并保存
  state.saveStateMerged(dir, snapshot);
  const onDisk = state.loadState(dir);
  assert.ok(onDisk.history.some((r) => r.id === 'art-1'), '期间写入的成文必须保留');
  assert.strictEqual(onDisk.lastScheduledDate, '2026-10-29', '定时标记不得被旧快照清掉');
  assert.strictEqual(onDisk.lastHead, 'HEAD-OLD', '本次运行写入的 lastHead 生效');

  // 磁盘里已上传的条目不会被内存里的旧 generated 状态降级
  const mem = state.loadState(dir);
  mem.history = mem.history.map((r) => (r.id === 'art-1' ? { ...r, status: 'generated' } : r));
  const up = state.loadState(dir);
  state.markUploadedById(up, 'art-1', 'DRAFT-9');
  state.saveState(dir, up);
  state.saveStateMerged(dir, mem);
  assert.strictEqual(state.loadState(dir).history.find((r) => r.id === 'art-1').status, 'uploaded');
});
