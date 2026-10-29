#!/usr/bin/env node
'use strict';
/**
 * proto-shot-r1.js —— 截取 prototype/index.html 设计稿基准（只读）。
 * 用 _electron.launch 拉起 viewer 窗口（内容区 1400x940，body padding 28/20 后
 * #app 恰为 1360x880，与 Electron 主窗口同尺寸），逐视图/页签截图。
 * 输出：test-evidence/round-1/样式/prototype-ref/
 * 注意：原型依赖 cdn.tailwindcss.com 与 cdnjs（FontAwesome 6.5.2），加载失败会记录。
 */
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PROTO = path.resolve(ROOT, '..', 'prototype', 'index.html');
const OUT = path.join(ROOT, 'test-evidence', 'round-1', '样式', 'prototype-ref');
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.join(__dirname, 'proto-viewer-r1.js')],
    cwd: ROOT,
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('load');
    await win.waitForTimeout(2500); // CDN 字体 + 动画
    const failed = await win.evaluate(() => performance.getEntriesByType('resource').filter((r) => r.responseStatus && r.responseStatus >= 400).map((r) => r.name));
    log(`原型资源加载失败（status>=400）：${failed.length} ${failed.join(' , ')}`);
    const fa = await win.evaluate(() => ({
      free900: document.fonts.check('900 12px "Font Awesome 6 Free"'),
      brands: document.fonts.check('12px "Font Awesome 6 Brands"'),
    }));
    log(`原型 FA 字体：${JSON.stringify(fa)}`);
    const size = await win.evaluate(() => {
      const a = document.querySelector('#app');
      const r = a.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    log(`原型 #app 尺寸：${size.w}x${size.h}`);
    const shot = async (n) => { await win.screenshot({ path: path.join(OUT, n) }); log(`[shot] prototype-ref/${n}`); };
    await shot('proto-dashboard.png');
    await win.evaluate(() => showView('history'));
    await win.waitForTimeout(400);
    await shot('proto-history.png');
    await win.evaluate(() => showView('logs'));
    await win.waitForTimeout(400);
    await shot('proto-logs.png');
    await win.evaluate(() => showView('settings'));
    await win.waitForTimeout(400);
    await shot('proto-settings-wx.png');
    await win.click('.tab-btn[data-tab="llm"]');
    await win.waitForTimeout(300);
    await shot('proto-settings-llm.png');
    await win.click('.tab-btn[data-tab="content"]');
    await win.waitForTimeout(300);
    await shot('proto-settings-content.png');
    await win.click('.tab-btn[data-tab="app"]');
    await win.waitForTimeout(300);
    await shot('proto-settings-app.png');
    await win.evaluate(() => showView('dashboard'));
    await win.click('#openWizard');
    await win.waitForSelector('#wizard.on', { timeout: 5000 });
    await win.waitForTimeout(500);
    await shot('proto-wizard-step0.png');
  } catch (e) {
    log(`[FATAL] ${String(e && e.stack ? e.stack : e)}`);
  } finally {
    try { await app.close(); } catch (_) { }
  }
  fs.writeFileSync(path.join(OUT, '_proto-shot.txt'), lines.join('\n'), 'utf8');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
