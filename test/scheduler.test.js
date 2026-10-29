'use strict';
/**
 * scheduler.test.js —— 调度器纯函数边界：
 * nextRunAt 跨日边界、parseTime 非法输入全表、shouldFireNow 同日防重、
 * missedCatchUp 昨天/未过点、时钟回拨、跨月。时区全部用本地时间断言。
 */
const test = require('node:test');
const assert = require('node:assert');
const { parseTime, dayKey, timeOfToday, nextRunAt, shouldFireNow, missedCatchUp } = require('../src/core/scheduler');

const D = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0);

test('parseTime 合法输入', () => {
  assert.deepStrictEqual(parseTime('09:30'), { h: 9, m: 30 });
  assert.deepStrictEqual(parseTime('00:00'), { h: 0, m: 0 });
  assert.deepStrictEqual(parseTime('23:59'), { h: 23, m: 59 });
  assert.deepStrictEqual(parseTime(' 09:30 '), { h: 9, m: 30 }); // 首尾空白可容忍
});

test('parseTime 非法输入全表 → null', () => {
  for (const bad of ['25:00', '9:30', '09:5', '09:60', '', '  ', 'abc', '0930', '09-30', '09:30:00', null, undefined, 930, '24:00', '-1:30', '０９:３０']) {
    assert.strictEqual(parseTime(bad), null, `parseTime(${JSON.stringify(bad)}) 应为 null`);
  }
});

test('dayKey 本地时区 YYYY-MM-DD，含补零', () => {
  assert.strictEqual(dayKey(D(2026, 10, 29, 5, 0)), '2026-10-29');
  assert.strictEqual(dayKey(D(2026, 2, 5, 23, 59)), '2026-02-05');
  assert.strictEqual(dayKey(D(2027, 1, 1, 0, 0)), '2027-01-01');
  assert.throws(() => dayKey(new Date('not-a-date')), /E_INVALID_INPUT|有效日期/);
});

test('nextRunAt 跨日边界：未到 → 今天，已到 → 明天', () => {
  // 08:00 的任务，now=06:00 → 今天 08:00
  assert.deepStrictEqual(nextRunAt('08:00', D(2026, 10, 29, 6, 0)), D(2026, 10, 29, 8, 0));
  // now=10:00 → 明天 08:00
  assert.deepStrictEqual(nextRunAt('08:00', D(2026, 10, 29, 10, 0)), D(2026, 10, 30, 8, 0));
  // now 恰好等于 HH:MM → 已到点，明天（与 shouldFireNow 的 <= 语义一致）
  assert.deepStrictEqual(nextRunAt('08:00', D(2026, 10, 29, 8, 0)), D(2026, 10, 30, 8, 0));
  // 23:59：now=23:58:30 → 今天 23:59
  assert.deepStrictEqual(nextRunAt('23:59', D(2026, 10, 29, 23, 58, 30)), D(2026, 10, 29, 23, 59));
  // 跨月进位：10-31 10:00 的 08:00 任务 → 11-01 08:00
  assert.deepStrictEqual(nextRunAt('08:00', D(2026, 10, 31, 10, 0)), D(2026, 11, 1, 8, 0));
  // 非法时间 → null
  assert.strictEqual(nextRunAt('9:30', D(2026, 10, 29, 10, 0)), null);
  assert.strictEqual(nextRunAt('', D(2026, 10, 29, 10, 0)), null);
});

test('shouldFireNow：到点恒真、未到点 false、同日防重', () => {
  const yesterday = '2026-10-28';
  // 未到点
  assert.strictEqual(shouldFireNow('09:30', D(2026, 10, 29, 9, 29, 59), yesterday), false);
  // 到点（含整点）
  assert.strictEqual(shouldFireNow('09:30', D(2026, 10, 29, 9, 30, 0), yesterday), true);
  assert.strictEqual(shouldFireNow('09:30', D(2026, 10, 29, 10, 0), yesterday), true); // 30s tick 下到点后恒真
  // 同日防重：同日同参必 false
  assert.strictEqual(shouldFireNow('09:30', D(2026, 10, 29, 10, 0), '2026-10-29'), false);
  assert.strictEqual(shouldFireNow('09:30', D(2026, 10, 29, 23, 59), '2026-10-29'), false);
  // 非法时间 false
  assert.strictEqual(shouldFireNow('9:30', D(2026, 10, 29, 10, 0), yesterday), false);
});

test('missedCatchUp：lastScheduledDate=昨天且过点 → true；未过点 → false；当天已跑 → false', () => {
  assert.deepStrictEqual(missedCatchUp('09:30', D(2026, 10, 29, 10, 0), '2026-10-28'), { catchUp: true });
  assert.deepStrictEqual(missedCatchUp('09:30', D(2026, 10, 29, 9, 0), '2026-10-28'), { catchUp: false });
  assert.deepStrictEqual(missedCatchUp('09:30', D(2026, 10, 29, 10, 0), '2026-10-29'), { catchUp: false });
  assert.deepStrictEqual(missedCatchUp('09:30', D(2026, 10, 29, 0, 1), '2026-10-28'), { catchUp: false });
});

test('时钟回拨语义', () => {
  // 回拨仍在同一天：lastScheduledDate=今天，任意时刻都不再触发
  assert.strictEqual(shouldFireNow('09:30', D(2026, 10, 29, 8, 0), '2026-10-29'), false);
  // 回拨到昨天（lastScheduledDate 是“未来”日期）：dayKey(now) !== lastScheduledDate → 触发一次，
  // 触发后 lastScheduledDate 被改写为今天，之后每个真实日期至多触发一次。
  assert.strictEqual(shouldFireNow('09:30', D(2026, 10, 28, 10, 0), '2026-10-29'), true);
  // 回拨到昨天但未到点：不触发
  assert.strictEqual(shouldFireNow('09:30', D(2026, 10, 28, 8, 0), '2026-10-29'), false);
  // 回拨后的 nextRunAt 正常指向“明天”
  assert.deepStrictEqual(nextRunAt('09:30', D(2026, 10, 28, 10, 0)), D(2026, 10, 29, 9, 30));
});

test('timeOfToday 与 nextRunAt 返回独立 Date（不被后续修改污染）', () => {
  const now = D(2026, 10, 29, 6, 0);
  const a = nextRunAt('09:30', now);
  a.setFullYear(1999);
  const b = nextRunAt('09:30', now);
  assert.strictEqual(b.getFullYear(), 2026);
});
