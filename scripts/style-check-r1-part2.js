#!/usr/bin/env node
'use strict';
/**
 * style-check-r1-part2.js —— 第 1 轮样式检查（补充，只读）：
 *   A. 仪表盘「一键自检」弹窗失败态截图（selfcheck items 双重包裹导致的用户可见报错）
 *   B. 最小窗口 1080×720 下的布局压力测试
 *   C. 历史来源列 chip 宽度 vs 列宽的量测（文本框换行证据）
 *   D. 设置 tab-bar 在 1080 宽下是否溢出/换行
 * 输出：test-evidence/round-1/样式/ 下 5x-*.png 与 _style-check-part2.txt
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-evidence', 'round-1', '样式');
const SUM = path.join(OUT, '_style-check-part2.txt');
const lines = [];
const log = (s) => { lines.push(String(s)); console.log(String(s)); };
const MEASURE = () => {
  const res = {};
  const th = [...document.querySelectorAll('.view[data-view="history"] .tbl th')].map((e) => ({ t: e.textContent.trim(), w: e.getBoundingClientRect().width, cs: getComputedStyle(e).width }));
  res.th = th;
  const chip = document.querySelector('.view[data-view="history"] #histBody .chip');
  if (chip) {
    const r = chip.getBoundingClientRect();
    const cs = getComputedStyle(chip);
    res.originChip = { text: chip.textContent.trim(), w: r.width, h: r.height, display: cs.display, whiteSpace: cs.whiteSpace, lineHeight: cs.lineHeight, clientH: chip.clientHeight, scrollH: chip.scrollHeight };
    const tds = chip.closest('td') ? chip.closest('td').getBoundingClientRect() : null;
    res.originTd = tds ? { w: tds.width } : null;
  }
  const bar = document.querySelector('#setTabs');
  if (bar) {
    const r = bar.getBoundingClientRect();
    res.tabBar = { w: r.width, scrollW: bar.scrollWidth, h: r.height, scrollH: bar.scrollHeight };
    res.tabBtns = [...bar.children].map((b) => ({ t: b.textContent.trim(), w: Math.round(b.getBoundingClientRect().width), top: Math.round(b.getBoundingClientRect().top) }));
  }
  res.docOverflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  res.mainScroll = (() => { const m = document.querySelector('main'); return m ? { sw: m.scrollWidth, cw: m.clientWidth } : null; })();
  return res;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wdp-s2-repo-'));
  const g = (a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g(['init', '-b', 'main']); g(['config', 'user.email', 'a@b.c']); g(['config', 'user.name', 'a']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# x\n\n今日修复雷达超时。\n', 'utf8'); g(['add', '-A']); g(['commit', '-m', 'fix: 雷达超时']);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wdp-s2-ud-'));

  const app = await electron.launch({
    executablePath: require('electron'), args: ['.'], cwd: ROOT,
    env: Object.assign({}, process.env, { WECHAT_DAILY_MOCK: '1', WECHAT_DAILY_USERDATA: userData }),
  });
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('#genBtn', { timeout: 30000 });
    await win.waitForSelector('#wizard.on', { timeout: 10000 });
    await win.click('#wizClose');
    await win.waitForSelector('#wizard.on', { state: 'detached', timeout: 5000 });
    await win.evaluate(async (repoPath) => {
      await window.api.invoke('config:set', {
        wechat: { appId: 'wxstyle2000000001', appSecret: 'mock-secret-2' },
        llm: { apiKey: 'mock-key-2' },
        content: { repoPath },
        aggregate: { keywords: ['科技', '教育'], whitelist: ['who.int'], searchApiKey: 'mock' },
        app: { schedule: { enabled: false } },
      });
    }, repo);
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForSelector('#genBtn:not([disabled])', { timeout: 15000 });
    await win.waitForTimeout(600);

    /* A. 一键自检弹窗失败态 */
    await win.click('#selfcheckBtn');
    await win.waitForSelector('#checkModal.on', { timeout: 5000 });
    await win.waitForTimeout(1500);
    await win.screenshot({ path: path.join(OUT, '50-selfcheck-modal-fail.png') });
    const modalState = await win.evaluate(() => ({
      failVisible: getComputedStyle(document.querySelector('#modalCheckFail')).display,
      failMsg: document.querySelector('#modalCheckFailMsg').textContent,
      items: [...document.querySelectorAll('#modalChecks .check-item')].map((e) => e.className),
    }));
    log('[A] 一键自检弹窗状态：' + JSON.stringify(modalState));
    await win.keyboard.press('Escape');
    await win.waitForTimeout(300);

    /* C. 测量来源列（需要至少一条历史；先跑一次生成） */
    await win.click('#genBtn');
    await win.waitForFunction(() => /草稿箱|预览/.test((document.querySelector('#heroTitle') || {}).textContent || ''), undefined, { timeout: 60000 });
    await win.click('.nav-item[data-nav="history"]');
    await win.waitForSelector('.view[data-view="history"].on', { timeout: 5000 });
    await win.waitForTimeout(500);
    const m1 = await win.evaluate(MEASURE);
    log('[C] 1360 宽 — 历史表头与来源 chip：' + JSON.stringify(m1.th) + ' | chip=' + JSON.stringify(m1.originChip) + ' | td=' + JSON.stringify(m1.originTd));
    log('[C] doc 横向溢出=' + m1.docOverflowX + ' main=' + JSON.stringify(m1.mainScroll));

    /* D. 设置 tab-bar（1360） */
    await win.click('.nav-item[data-nav="settings"]');
    await win.waitForSelector('.view[data-view="settings"].on', { timeout: 5000 });
    await win.waitForTimeout(400);
    const m2 = await win.evaluate(MEASURE);
    log('[D] 1360 宽 tab-bar：' + JSON.stringify(m2.tabBar) + ' btns=' + JSON.stringify(m2.tabBtns));

    /* B. 最小窗口 1080×720 压测 */
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setSize(1080, 720);
    });
    await win.waitForTimeout(900);
    log('[B] 视口：' + JSON.stringify(await win.evaluate(() => ({ w: innerWidth, h: innerHeight }))));
    const shots = [
      ['settings-content', '.nav-item[data-nav="settings"]', '.view[data-view="settings"].on', '51-1080-settings.png'],
      ['dashboard', '.nav-item[data-nav="dashboard"]', '.view[data-view="dashboard"].on', '52-1080-dashboard.png'],
      ['history', '.nav-item[data-nav="history"]', '.view[data-view="history"].on', '53-1080-history.png'],
      ['compose', '.nav-item[data-nav="compose"]', '.view[data-view="compose"].on', '54-1080-compose.png'],
      ['radar', '.nav-item[data-nav="radar"]', '.view[data-view="radar"].on', '55-1080-radar.png'],
      ['chat', '.nav-item[data-nav="chat"]', '.view[data-view="chat"].on', '56-1080-chat.png'],
    ];
    for (const [label, nav, sel, file] of shots) {
      await win.click(nav);
      await win.waitForSelector(sel, { timeout: 5000 });
      await win.waitForTimeout(450);
      await win.screenshot({ path: path.join(OUT, file) });
      const mm = await win.evaluate(MEASURE);
      log(`[B] ${label} 1080 — doc溢出X=${mm.docOverflowX} main=${JSON.stringify(mm.mainScroll)}` +
        (mm.tabBar ? ' tabBar=' + JSON.stringify(mm.tabBar) + ' tops=' + JSON.stringify(mm.tabBtns.map((b) => b.top)) : '') +
        (mm.originChip ? ' chip=' + JSON.stringify(mm.originChip) : ''));
    }
    // 设置页签在 1080 下切到聚合来源（更长的表单）
    await win.click('.nav-item[data-nav="settings"]');
    await win.waitForTimeout(300);
    await win.click('.tab-btn[data-tab="aggregate"]');
    await win.waitForTimeout(400);
    await win.screenshot({ path: path.join(OUT, '57-1080-settings-aggregate.png') });
    const m3 = await win.evaluate(MEASURE);
    log('[B] settings-aggregate 1080 — tabBar=' + JSON.stringify(m3.tabBar) + ' docX=' + m3.docOverflowX);
  } catch (e) {
    log('[FATAL] ' + String(e && e.stack ? e.stack : e));
    try { const w = await app.firstWindow(); await w.screenshot({ path: path.join(OUT, '59-error.png') }); } catch (_) { }
  } finally { try { await app.close(); } catch (_) { } }
  fs.writeFileSync(SUM, lines.join('\n'), 'utf8');
  console.log('\n写入：' + SUM);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
