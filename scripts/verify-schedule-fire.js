#!/usr/bin/env node
'use strict';
/**
 * verify-schedule-fire.js —— 定时任务真实计时验证（Playwright _electron，mock 模式）。
 *
 * A. 到点触发：把每日时间设成「下一分钟」，等 tick 命中 → 选题雷达自动成文并上传草稿箱。
 * B. 错过补跑：把时间设成已过的时刻、state.lastScheduledDate 改成昨天 → 重启应用后 30s 内补跑。
 *
 * 运行：node scripts/verify-schedule-fire.js    （约 2~3 分钟）
 * 退出码：0 = 两项都通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const pad2 = (n) => String(n).padStart(2, '0');
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' —— ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hm(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function dayKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

async function launch(userData) {
  const app = await electron.launch({
    args: ['.'], cwd: ROOT,
    env: Object.assign({}, process.env, { WECHAT_DAILY_MOCK: '1', WECHAT_DAILY_USERDATA: userData }),
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);
  try { await win.evaluate(() => { const el = document.querySelector('#wizard.on'); if (el) el.classList.remove('on'); }); } catch (e) { /* 忽略 */ }
  return { app, win };
}

async function readLogs(win, limit = 400) {
  try {
    const r = await win.evaluate(async (n) => {
      const res = await App.api.invoke('logs:list', { limit: n });
      return ((res && res.items) || []).map((e) => `[${e.lv}] ${e.t} ${e.m}`).join('\n');
    }, limit);
    return r || '';
  } catch (e) { return ''; }
}

async function seedConfig(win, { time, mode }) {
  return win.evaluate(async (p) => {
    const r = await App.api.invoke('config:set', {
      wechat: { appId: 'wxmockappid', appSecret: 'mockappsecret' },
      llm: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'mock-llm-key', model: 'glm-4.6' },
      aggregate: { keywords: ['科技', '教育'], searchProvider: 'bocha', searchApiKey: 'mock-search-key', articleMode: 'web', autoPickCount: 1, autoSkipSensitive: true },
    });
    const s = await App.api.invoke('schedule:set', { enabled: true, time: p.time, mode: p.mode });
    return { wizardDone: !!(r && r.config), schedule: s };
  }, { time, mode });
}

(async () => {
  /* ---------------- A. 到点触发 ---------------- */
  const userA = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-sched-a-'));
  let a = await launch(userA);
  const nextMin = new Date(Date.now() + 60 * 1000);
  const targetTime = hm(nextMin);
  const seeded = await seedConfig(a.win, { time: targetTime, mode: 'radar' });
  record('A1 配置就绪并设定「下一分钟」触发', seeded.wizardDone === true && seeded.schedule.time === targetTime,
    `time=${seeded.schedule.time} mode=${seeded.schedule.mode} enabled=${seeded.schedule.enabled}`);
  console.log(`     等待 ${targetTime} 到点（最多 100 秒）…`);

  let fired = false;
  let fireLog = '';
  for (let i = 0; i < 100; i++) {
    await sleep(1000);
    const logs = await readLogs(a.win);
    if (/定时触发（cause=scheduled）：选题雷达/.test(logs)) fired = true;
    if (/选题雷达运行结束：.*status=uploaded/.test(logs)) { fireLog = logs; break; }
  }
  const aLogs = fireLog || await readLogs(a.win);
  record('A2 到点触发选题雷达全自动', fired, fired ? '' : '未出现「定时触发（cause=scheduled）」');
  record('A3 自动成文并上传草稿箱', /选题雷达运行结束：.*status=uploaded/.test(aLogs), '');
  const stateA = JSON.parse(fs.readFileSync(path.join(userA, 'state.json'), 'utf8'));
  record('A4 写入 lastScheduledDate（当天防重）', stateA.lastScheduledDate === dayKey(new Date()), String(stateA.lastScheduledDate));
  await a.app.close();

  /* ---------------- B. 错过补跑 ---------------- */
  const userB = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-sched-b-'));
  // 先起一次把配置写好，再改 state 为「昨天」，最后重启模拟「今天开机才打开应用」
  let b = await launch(userB);
  const past = new Date(Date.now() - 5 * 60 * 1000);
  await seedConfig(b.win, { time: hm(past), mode: 'radar' });
  await b.app.close();

  const stateBPath = path.join(userB, 'state.json');
  const stateB = fs.existsSync(stateBPath) ? JSON.parse(fs.readFileSync(stateBPath, 'utf8')) : {};
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
  stateB.lastScheduledDate = dayKey(yesterday);
  fs.writeFileSync(stateBPath, JSON.stringify(stateB, null, 2), 'utf8');

  b = await launch(userB);
  let catchup = false;
  let bLogs = '';
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    bLogs = await readLogs(b.win);
    if (/定时触发（cause=catchup）/i.test(bLogs)) catchup = true;
    if (/选题雷达运行结束：.*status=uploaded/.test(bLogs)) break;
  }
  record('B1 错过补跑：启动后自动补跑今天', catchup, catchup ? '' : bLogs.slice(-200));
  record('B2 补跑同样完成上传', /选题雷达运行结束：.*status=uploaded/.test(bLogs), '');
  const stateB2 = JSON.parse(fs.readFileSync(stateBPath, 'utf8'));
  record('B3 补跑后 lastScheduledDate 更新为今天', stateB2.lastScheduledDate === dayKey(new Date()), String(stateB2.lastScheduledDate));
  await b.app.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('验证脚本异常：', e); process.exit(1); });
