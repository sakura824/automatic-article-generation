'use strict';
/**
 * verify-installed.js —— 验证「安装目录里的程序」真的可用（不是验证源码目录）。
 * 用独立 userData + mock 模式启动已安装的 exe，检查版本号、设置页签、控制台错误。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright');

// 可用环境变量 OSS_VERIFY_EXE 覆盖；默认指向仓库 dist/ 下的 win-unpacked 产物
const EXE = process.env.OSS_VERIFY_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', '公众号写作助手.exe');

(async () => {
  if (!fs.existsSync(EXE)) {
    console.error('找不到已安装的程序: ' + EXE);
    process.exit(1);
  }
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wdp-verify-'));
  const env = { ...process.env, WECHAT_DAILY_MOCK: '1', WECHAT_DAILY_USERDATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({ executablePath: EXE, args: [], env });
  const win = await app.firstWindow();
  const errs = [];
  win.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
  win.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

  await win.waitForSelector('#genBtn', { timeout: 40000 });
  const ver = (await win.textContent('#verLabel')) || '';
  if (await win.$('#wizClose')) await win.click('#wizClose').catch(() => {});
  await new Promise((r) => setTimeout(r, 300));

  await win.click('.nav-item[data-nav="settings"]');
  await win.waitForSelector('.view[data-view="settings"].on', { timeout: 5000 });

  const tabs = await win.$$eval('#setTabs .tab-btn', (els) => els.map((e) => e.dataset.tab));
  const tabResults = [];
  for (const t of tabs) {
    await win.click(`#setTabs .tab-btn[data-tab="${t}"]`);
    const shown = await win.$eval('.panel.on', (el) => el.dataset.panel).catch(() => '(none)');
    tabResults.push({ tab: t, shown, ok: shown === t });
  }

  const wired = await win.evaluate(() => ({
    settingsView: !!(window.App && window.App.settingsView),
    refresh: !!(window.App && window.App.viewRefresh && window.App.viewRefresh.settings),
    inits: window.App && window.App.viewInits ? window.App.viewInits.length : -1,
  }));
  const hasDeepseek = await win.$eval('#aggSearchProvider', (el) => [...el.options].map((o) => o.value));
  // 页签循环停在最后一个（app），聚合面板此时是隐藏的：先切回来再操作表单
  await win.click('#setTabs .tab-btn[data-tab="aggregate"]');
  await win.waitForSelector('.panel.on[data-panel="aggregate"]', { timeout: 5000 });

  // 场景 1：默认大模型（智谱）+ 选择 deepseek → 必须黄字警告「不能复用」
  await win.selectOption('#aggSearchProvider', 'deepseek');
  await new Promise((r) => setTimeout(r, 250));
  const hintMismatch = await win.textContent('#aggSearchKeyHint');
  const mismatchWarned = /不能复用大模型 Key/.test(hintMismatch || '');

  // 场景 2：走真实 UI 路径把大模型改成 DeepSeek（大模型页签填写 → 保存）→ 提示应变为「可以留空」
  // 注意不能用 window.api.invoke('config:set') 直接调：那样不会触发渲染层的 applyConfig，
  // 页面缓存仍是旧值（第一次验证就栽在这上面，误判成产品 bug）。
  await win.click('#setTabs .tab-btn[data-tab="llm"]');
  await win.fill('#llmUrl', 'https://api.deepseek.com');
  await win.fill('#llmKey', 'sk-verify-0001');
  await win.click('#saveLlm');
  await new Promise((r) => setTimeout(r, 900));
  const baseUrlAfter = await win.evaluate(
    () => (window.App.state.cfg && window.App.state.cfg.llm && window.App.state.cfg.llm.baseUrl) || null
  );
  console.log('[diag] 保存后渲染层 baseUrl =', baseUrlAfter);
  await win.click('#setTabs .tab-btn[data-tab="aggregate"]');
  await new Promise((r) => setTimeout(r, 300));
  await win.selectOption('#aggSearchProvider', 'deepseek');
  await new Promise((r) => setTimeout(r, 300));
  const hintMatch = await win.textContent('#aggSearchKeyHint');
  const placeholderMatch = await win.getAttribute('#aggSearchKey', 'placeholder');
  const matchOk = /可以留空/.test(hintMatch || '') && /留空/.test(placeholderMatch || '');

  // 场景 3：插图链路（v2.3）——安装版能否真的离屏渲染并内联成 data URI
  const illus = await win.evaluate(async () => {
    const r = await window.api.invoke('compose:generate', {
      mode: 'material',
      material: '分级阅读怎么选书：先看兴趣再看级别，一页生词不超过 5 个，同级别读满 10 本再升级。',
      emphasis: '选书标准',
    });
    if (!r || !r.ok) return { ok: false, error: (r && r.error && r.error.message) || '生成失败' };
    const html = (r.data && r.data.article && r.data.article.html) || '';
    return {
      ok: true,
      hasImg: /<img[^>]+src="data:image\/png;base64,/.test(html),
      leftover: /<illus\b/i.test(html),
      len: html.length,
      words: r.data && r.data.words,
    };
  });
  console.log('[diag] compose:generate →', JSON.stringify({ ...illus, html: undefined }));

  // 版本判据从 package.json 读取，避免脚本里写死版本号（随仓版本升级时脚本不用再改）
  const expectedVer = 'v' + require(path.join(__dirname, '..', 'package.json')).version;
  const ok = ver.trim().startsWith(expectedVer) && tabResults.every((r) => r.ok) && wired.settingsView && errs.length === 0
    && hasDeepseek.length === 5 && mismatchWarned && matchOk
    && illus.ok && illus.hasImg && !illus.leftover;
  console.log(JSON.stringify({
    version: ver.trim(),
    expectedVersion: expectedVer,
    tabsOk: tabResults.every((r) => r.ok),
    wired,
    searchProviders: hasDeepseek,
    scenarioMismatch: { warned: mismatchWarned },
    scenarioMatch: { ok: matchOk, placeholder: placeholderMatch },
    illustration: { generated: illus.ok, hasImg: illus.hasImg, leftover: illus.leftover, htmlLen: illus.len },
    errors: errs,
    verdict: ok ? 'PASS 安装版可用（换模型警告 + 同厂商复用 + 插图渲染）' : 'FAIL 见上',
  }, null, 2));
  await app.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('验证失败:', e && e.message ? e.message : e);
  process.exit(1);
});
