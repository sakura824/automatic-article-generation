'use strict';
/**
 * scheduler.js —— 调度器纯函数（契约 §6，独立单测，不依赖 electron）。
 * 纯函数只吃参数不吃时钟：now 一律显式传入，时间均为本地时区。
 * 防重语义：lastScheduledDate 只在 scheduled/catchup 触发开始时写入（无论成败），
 * 因此 30s tick 下到点后 shouldFireNow 恒真由 lastScheduledDate 防重；
 * 手动 run 不改写它；当天定时已跑 → shouldFireNow / missedCatchUp 均为 false。
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 'HH:MM' → {h,m}；非法（'25:00'/'9:30'/空/非字符串）→ null。首尾空白可容忍。 */
function parseTime(s) {
  if (typeof s !== 'string') return null;
  const m = TIME_RE.exec(s.trim());
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Date → 本地时区 'YYYY-MM-DD'。非有效日期抛 E_INVALID_INPUT。 */
function dayKey(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) {
    const e = new Error('dayKey 需要一个有效日期');
    e.code = 'E_INVALID_INPUT';
    throw e;
  }
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** timeStr 在 now 当天对应的时刻；timeStr 非法 → null。 */
function timeOfToday(timeStr, now) {
  const t = parseTime(timeStr);
  if (!t) return null;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.h, t.m, 0, 0);
}

/**
 * 下次运行时间：今天 HH:MM 尚未到 → 今天；已到（含恰好等于）→ 明天。
 * timeStr 非法 → null。跨月/跨年由 Date 自动进位。
 */
function nextRunAt(timeStr, now) {
  const t = timeOfToday(timeStr, now);
  if (!t) return null;
  if (t.getTime() > now.getTime()) return t;
  return new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, t.getHours(), t.getMinutes(), 0, 0);
}

/**
 * 是否应在本 tick 触发定时任务：
 * timeOfToday <= now 且 dayKey(now) !== lastScheduledDate（同日防重）。
 * timeStr 非法 → false。
 */
function shouldFireNow(timeStr, now, lastScheduledDate) {
  const t = timeOfToday(timeStr, now);
  if (!t) return false;
  return t.getTime() <= now.getTime() && dayKey(now) !== lastScheduledDate;
}

/**
 * 错过补跑判定（应用 ready 后与每个 tick 均调用）：
 * 当天已过点且 lastScheduledDate !== 今天 → {catchUp:true}，命中则以 cause='catchup' 补跑当天。
 */
function missedCatchUp(timeStr, now, lastScheduledDate) {
  return { catchUp: shouldFireNow(timeStr, now, lastScheduledDate) };
}

module.exports = {
  parseTime,
  dayKey,
  timeOfToday,
  nextRunAt,
  shouldFireNow,
  missedCatchUp,
};
