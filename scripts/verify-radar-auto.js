#!/usr/bin/env node
'use strict';
/**
 * verify-radar-auto.js —— v2.4 选题雷达全自动的界面验证（Playwright _electron，mock 模式）。
 * 覆盖：仪表盘三种定时类型 + 原生时间选择器、设置页新参数、雷达页「全自动跑一次」按钮，
 * 并真实点击一次全自动按钮，等到 run:finished（mock 搜索 → 自动选题 → 成文 → 上传草稿箱）。
 *
 * 运行：node scripts/verify-radar-auto.js
 * 证据：test-evidence/radar-auto-<date>/ 截图 + 文本摘要；退出码 0=通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const pad2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const STAMP = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
const SHOT_DIR = path.join(ROOT, 'test-evidence', `radar-auto-${STAMP}`);
const SUMMARY = path.join(ROOT, 'test-evidence', `radar-auto-${STAMP}.txt`);
fs.mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' —— ' + detail : ''}`);
}

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-radar-'));
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: Object.assign({}, process.env, { WECHAT_DAILY_MOCK: '1', WECHAT_DAILY_USERDATA: userData }),
  });
  const win = await app.firstWindow();
  const pageErrors = [];
  win.on('pageerror', (e) => pageErrors.push(String(e && e.message)));
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1200);

  // 配置向导会挡住首屏，先关掉
  try { await win.evaluate(() => { const el = document.querySelector('#wizard.on'); if (el) el.classList.remove('on'); }); } catch (e) { /* 忽略 */ }

  /* ---- 1. 设置 → 应用：定时开关 / 时间 / 任务类型 ---- */
  await win.evaluate(() => { if (window.App && App.showSettingsTab) App.showSettingsTab('app'); });
  await win.waitForTimeout(700);

  const appTimeOk = await win.evaluate(() => {
    const el = document.querySelector('#appSchedTime');
    return !!el && el.getAttribute('type') === 'time';
  });
  record('应用页含每日执行时间选择器（type=time）', appTimeOk);

  const modeSelectOk = await win.evaluate(() => {
    const el = document.querySelector('#appSchedMode');
    return !!el && Array.from(el.options).map((o) => o.value).join(',') === 'auto,pool,radar';
  });
  record('应用页含定时任务类型（仓库自动/内容池/选题雷达）', modeSelectOk);

  // 改时间 → 应落盘
  await win.evaluate(() => {
    const el = document.querySelector('#appSchedTime');
    el.value = '07:15';
    el.dispatchEvent(new Event('change'));
  });
  await win.waitForTimeout(1200);
  const timeSaved = await win.evaluate(() => (window.App && App.state.schedule && App.state.schedule.time) || '');
  record('应用页改时间后生效（07:15）', timeSaved === '07:15', timeSaved);

  // 改类型 → 选题雷达
  await win.evaluate(() => {
    const el = document.querySelector('#appSchedMode');
    el.value = 'radar';
    el.dispatchEvent(new Event('change'));
  });
  await win.waitForTimeout(1200);
  const modeSaved = await win.evaluate(() => (window.App && App.state.schedule && App.state.schedule.mode) || '');
  record('应用页切类型后生效（radar）', modeSaved === 'radar', modeSaved);

  // 开启每日定时（仪表盘那张卡片在定时关闭时本就隐藏，所以从这里开）
  await win.click('#appScheduleSwitch');
  await win.waitForTimeout(1300);
  const enabledNow = await win.evaluate(() => !!(window.App && App.state.schedule && App.state.schedule.enabled));
  record('开启每日定时成功', enabledNow, String(enabledNow));
  await win.screenshot({ path: path.join(SHOT_DIR, '01-settings-app.png') });

  /* ---- 2. 仪表盘：定时卡出现，三种类型 + 时间选择器 ---- */
  await win.evaluate(() => { if (window.App && App.showView) App.showView('dashboard'); });
  await win.waitForTimeout(600);
  const cardVisible = await win.evaluate(() => {
    const el = document.querySelector('#schedCard');
    return !!el && getComputedStyle(el).display !== 'none';
  });
  record('定时开启后仪表盘显示定时任务卡', cardVisible);
  const chips = await win.evaluate(() => Array.from(document.querySelectorAll('#schedModeRow [data-sm]')).map((b) => b.dataset.sm));
  record('仪表盘定时类型含 auto/pool/radar', chips.join(',') === 'auto,pool,radar', chips.join(','));
  const activeChip = await win.evaluate(() => {
    const on = document.querySelector('#schedModeRow [data-sm].on');
    return on ? on.dataset.sm : '';
  });
  record('仪表盘当前选中「选题雷达」', activeChip === 'radar', activeChip);
  const timeType = await win.evaluate(() => document.querySelector('#schedTime').getAttribute('type'));
  record('仪表盘时间输入是原生选择器（type=time）', timeType === 'time', String(timeType));
  const descText = await win.evaluate(() => document.querySelector('#schedDesc').textContent || '');
  record('描述文案随类型更新（提到搜索全网）', /搜索全网/.test(descText), descText.slice(0, 40));
  await win.screenshot({ path: path.join(SHOT_DIR, '02-dashboard-radar.png') });

  /* ---- 3. 设置 → 聚合来源配置：自动选题参数 ---- */
  await win.evaluate(() => { if (window.App && App.showSettingsTab) App.showSettingsTab('aggregate'); });
  await win.waitForTimeout(700);
  const autoPickOk = await win.evaluate(() => {
    const el = document.querySelector('#aggAutoPickCount');
    return !!el && Array.from(el.options).map((o) => o.value).join(',') === '1,2,3';
  });
  record('聚合配置含「自动选用前 N 条」（1/2/3）', autoPickOk);
  const skipSwitchOk = await win.evaluate(() => !!document.querySelector('#aggSkipSensitive'));
  record('聚合配置含「自动跳过敏感话题」开关', skipSwitchOk);

  // 全新档案需要先把「跑得起来」的配置写全：大模型 Key / 公众号凭证 / 关键词 / 搜索 Key
  const seed = await win.evaluate(async () => {
    try {
      const r = await App.api.invoke('config:set', {
        wechat: { appId: 'wxmockappid', appSecret: 'mockappsecret' },
        llm: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'mock-llm-key', model: 'glm-4.6' },
      });
      return !!(r && r.config);
    } catch (e) { return 'ERR ' + e.message; }
  });
  record('注入大模型 Key / 公众号凭证', seed === true, String(seed));

  // 关键词 + 搜索 Key + 自动选 2 条 → 保存
  await win.evaluate(() => {
    document.querySelector('#aggKeywords').value = '科技 教育';
    document.querySelector('#aggSearchProvider').value = 'bocha';
    const k = document.querySelector('#aggSearchKey');
    k.value = 'mock-search-key';
    k.dispatchEvent(new Event('input'));
    document.querySelector('#aggAutoPickCount').value = '2';
  });
  await win.click('#saveAggregate');
  await win.waitForTimeout(1500);
  const savedPick = await win.evaluate(async () => {
    try {
      const r = await App.api.invoke('config:get', {});
      const cfg = (r && r.config) || r || {};
      return JSON.stringify({
        pick: cfg.aggregate && cfg.aggregate.autoPickCount,
        keywords: cfg.aggregate && cfg.aggregate.keywords,
        skip: cfg.aggregate && cfg.aggregate.autoSkipSensitive,
      });
    } catch (e) { return 'ERR ' + e.message; }
  });
  record('聚合配置保存成功（选 2 条 / 关键词 / 跳过敏感）',
    /"pick":2/.test(savedPick) && /科技/.test(savedPick), savedPick);
  await win.screenshot({ path: path.join(SHOT_DIR, '03-settings-aggregate.png') });

  /* ---- 4. 雷达页：全自动按钮 + 真实跑一次 ---- */
  await win.evaluate(() => { if (window.App && App.showView) App.showView('radar'); });
  await win.waitForTimeout(600);
  const autoBtn = await win.evaluate(() => {
    const b = document.querySelector('#radarAutoBtn');
    return !!b && !b.disabled && b.textContent.trim();
  });
  record('雷达页有「全自动跑一次」按钮', !!autoBtn, String(autoBtn));

  // 监听日志/历史里出现上传成功字样：直接等 run:finished 经 IPC 渲染到日志视图
  await win.click('#radarAutoBtn');
  let uploaded = false;
  let lastLog = '';
  for (let i = 0; i < 60; i++) {
    await win.waitForTimeout(1000);
    const logs = await win.evaluate(async () => {
      try {
        const r = await App.api.invoke('logs:list', { limit: 300 });
        const items = (r && r.items) || [];
        // 日志条目形状：{ t, lv, m }（见 main/logger.js list()）
        return items.map((e) => `[${e.lv}] ${e.m}`).join('\n');
      } catch (e) { return ''; }
    });
    lastLog = logs;
    if (/选题雷达运行结束：.*status=uploaded/.test(logs)) { uploaded = true; break; }
    if (/选题雷达运行异常：/.test(logs)) break;
  }
  record('全自动跑一次：搜索→选题→成文→上传草稿箱成功', uploaded, uploaded ? '' : lastLog.slice(-300));

  // 历史里应出现一条「聚合」来源记录
  const histOk = await win.evaluate(async () => {
    try {
      const r = await App.api.invoke('history:list', {});
      const items = r && (r.items || r.history) || [];
      return items.some((h) => h.origin === '聚合' && h.status === 'uploaded');
    } catch (e) { return false; }
  });
  record('历史记录出现「聚合」来源且状态 uploaded', histOk);
  await win.screenshot({ path: path.join(SHOT_DIR, '04-radar-auto-done.png') });

  record('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));

  await app.close();

  const failed = results.filter((r) => !r.ok);
  const lines = [
    `# 选题雷达全自动 · 界面验证 ${STAMP}`,
    '',
    ...results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' —— ' + r.detail : ''}`),
    '',
    `结果：${results.length - failed.length}/${results.length} 通过`,
    `截图：${SHOT_DIR}`,
  ];
  fs.writeFileSync(SUMMARY, lines.join('\n'), 'utf8');
  console.log('\n' + lines.slice(-2).join('\n'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exit(1);
});
