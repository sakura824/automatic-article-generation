#!/usr/bin/env node
'use strict';
/**
 * style-check-r1.js —— 第 1 轮「样式」维度检查（只读检查，不改任何代码）。
 * playwright _electron 以 WECHAT_DAILY_MOCK=1 启动应用：
 *   - 对 v1 四视图 + v2 新页面（素材成文/对话共创/选题雷达、设置三新页签、历史来源筛选）
 *     逐一截图到 test-evidence/round-1/样式/；
 *   - hover / focus 态截图；
 *   - 运行时自动检查：FA 图标字体加载、非 file:// 请求（CDN）、pageerror/console.error、
 *     文本溢出（横向/纵向被裁剪的叶子文本）、视口横向溢出、body 字体。
 * 运行：node scripts/style-check-r1.js
 * 退出码：0 = 脚本自身跑完（不代表样式全通过，问题以报告为准）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-evidence', 'round-1', '样式');
const SUMMARY = path.join(OUT, '_style-check-summary.txt');

const lines = [];        // 摘要
const findings = [];     // 运行时自动检查发现 {tag, detail}
const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
const nonFileRequests = [];

function log(s) { lines.push(s); console.log(s); }

function makeGitRepo(dir) {
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 'style@example.com']);
  g(['config', 'user.name', 'style-check']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# style repo\n\n今日修复了雷达抓取的一个超时问题。\n', 'utf8');
  g(['add', '-A']);
  g(['commit', '-m', 'fix: 雷达抓取超时']);
}

async function shot(win, name) {
  const file = path.join(OUT, name);
  await win.screenshot({ path: file });
  log(`[shot] ${name}`);
  return file;
}

async function step(name, fn) {
  try { await fn(); log(`[step ok] ${name}`); return true; }
  catch (e) { log(`[step FAIL] ${name} —— ${String(e && e.message ? e.message : e).slice(0, 300)}`); return false; }
}

/** 溢出检测：返回被裁剪文本元素清单（启发式，人工复核截图）。 */
const OVERFLOW_FN = () => {
  const out = [];
  const pathOf = (el) => {
    const parts = [];
    let n = el;
    while (n && n.tagName && parts.length < 4) {
      let s = n.tagName.toLowerCase();
      if (n.id) s += '#' + n.id;
      else if (n.className && typeof n.className === 'string') s += '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.');
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join('>');
  };
  for (const el of document.querySelectorAll('body *')) {
    if (!(el instanceof HTMLElement)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    if (!hasOwnText) continue;
    if (el.scrollWidth > el.clientWidth + 3 && (cs.overflowX === 'hidden' || cs.overflowX === 'clip') && cs.textOverflow !== 'ellipsis') {
      out.push({ kind: 'h', sel: pathOf(el), text: (el.textContent || '').trim().slice(0, 36), sw: el.scrollWidth, cw: el.clientWidth });
    }
    if (el.scrollHeight > el.clientHeight + 3 && (cs.overflowY === 'hidden' || cs.overflowY === 'clip')) {
      out.push({ kind: 'v', sel: pathOf(el), text: (el.textContent || '').trim().slice(0, 36), sh: el.scrollHeight, ch: el.clientHeight });
    }
    // 视口外/被父裁剪到 0 高：文本元素自身 rect 高 >0 但内容贴边，交给截图比对
  }
  // 文档级横向溢出
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) {
    out.push({ kind: 'doc-h', sel: 'documentElement', text: '', sw: doc.scrollWidth, cw: doc.clientWidth });
  }
  return out;
};

/** 图标字体检查 */
const ICON_FN = () => {
  const res = { fonts: {}, total: 0, emptyContent: [], familyOk: null };
  try {
    res.fonts['fa-free-900'] = document.fonts.check('900 12px "Font Awesome 6 Free"');
    res.fonts['fa-free-400'] = document.fonts.check('400 12px "Font Awesome 6 Free"');
    res.fonts['fa-brands'] = document.fonts.check('12px "Font Awesome 6 Brands"');
  } catch (e) { res.fonts.err = String(e && e.message); }
  const badge = document.querySelector('.app-badge i');
  if (badge) {
    const cs = getComputedStyle(badge, '::before');
    res.sampleBadge = { content: cs.content, fontFamily: cs.fontFamily };
  }
  const els = [...document.querySelectorAll('i[class*="fa-"]')];
  res.total = els.length;
  for (const el of els) {
    const cs = getComputedStyle(el, '::before');
    if (!cs.content || cs.content === 'none' || cs.content === 'normal' || cs.content === '""') {
      res.emptyContent.push(el.getAttribute('class'));
      if (res.emptyContent.length >= 15) break;
    }
  }
  return res;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wdp-style-ud-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wdp-style-repo-'));
  makeGitRepo(repo);
  log(`# 第 1 轮样式检查 —— node scripts/style-check-r1.js`);
  log(`时间：${new Date().toISOString()}  Node ${process.version}`);
  log(`输出目录：${OUT}`);
  log(`userData：${userData}   repo：${repo}`);
  log('');

  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      WECHAT_DAILY_MOCK: '1',
      WECHAT_DAILY_USERDATA: userData,
    }),
  });

  let win = null;
  try {
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    win.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    win.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
      else if (msg.type() === 'warning') consoleWarnings.push(msg.text());
    });
    win.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith('file://') && !u.startsWith('devtools://') && !u.startsWith('data:')) nonFileRequests.push(u);
    });
    await win.waitForSelector('#genBtn', { timeout: 30000 });
    const vp = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    log(`窗口视口：${vp.width}x${vp.height}（预期 1360x880）  title=${await win.title()}`);

    /* ============ A. 首启向导 5 步 ============ */
    await win.waitForSelector('#wizard.on', { timeout: 10000 });
    await win.waitForTimeout(600);
    await shot(win, '00-wizard-step0-welcome.png');
    await win.click('#wizNext');
    await win.waitForSelector('.wiz-pane[data-wp="1"].on', { timeout: 5000 });
    await win.fill('#wizAppid', 'wxstyle0000000001');
    await win.fill('#wizSecret', 'mock-secret-style');
    await win.waitForTimeout(300);
    await shot(win, '01-wizard-step1-wx.png');
    await win.click('#wizNext');
    await win.waitForSelector('.wiz-pane[data-wp="2"].on', { timeout: 5000 });
    await win.fill('#wizLlmKey', 'mock-key-style');
    await win.waitForTimeout(300);
    await shot(win, '02-wizard-step2-llm.png');
    await win.click('#wizNext');
    await win.waitForSelector('.wiz-pane[data-wp="3"].on', { timeout: 5000 });
    await win.evaluate((p) => {
      const el = document.querySelector('#wizRepo');
      el.value = p;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // updateRepoGate 仅由 wizBrowse 回调触发（IIFE 内部函数），脚本路径下直接解锁按钮；
      // goNext 本身不校验 repo（wizard.js goNext step===3 直接 buildConfigPatch）。
      document.querySelector('#wizNext').disabled = false;
    }, repo);
    await win.waitForTimeout(300);
    await shot(win, '03-wizard-step3-repo.png');
    await win.click('#wizNext');
    await win.waitForSelector('.wiz-pane[data-wp="4"].on', { timeout: 5000 });
    await win.waitForTimeout(1200); // 自检步骤逐步点亮
    await shot(win, '04-wizard-step4-selfcheck.png');
    await win.waitForTimeout(2500); // 等自检走完
    await shot(win, '04b-wizard-step4-selfcheck-done.png');
    await win.click('#wizClose');
    await win.waitForSelector('#wizard.on', { state: 'detached', timeout: 5000 });

    /* ============ B. 注入完整配置（稳定基线） ============ */
    await step('config:set 注入 mock 配置', async () => {
      const r = await win.evaluate(async (repoPath) => {
        const rr = await window.api.invoke('config:set', {
          wechat: { appId: 'wxstyle0000000001', appSecret: 'mock-secret-style' },
          llm: { apiKey: 'mock-key-style' },
          content: { repoPath: repoPath },
          aggregate: { keywords: ['科技', '教育'], whitelist: ['who.int', 'nature.com'], searchApiKey: 'mock-search-style' },
          app: { schedule: { enabled: false } },
        });
        if (!(rr && rr.ok)) throw new Error('config:set 失败 ' + JSON.stringify(rr && rr.error));
        return rr.ok;
      }, repo);
      return r;
    });
    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForSelector('#genBtn:not([disabled])', { timeout: 15000 });
    await win.waitForTimeout(800);

    /* ============ C. 空态七视图 + 设置页签 ============ */
    await step('仪表盘空态截图', async () => { await shot(win, '10-dashboard-empty.png'); });
    await step('仪表盘 schedCard 应隐藏（schedule.enabled=false，PRD v2 §6）', async () => {
      const disp = await win.evaluate(() => getComputedStyle(document.querySelector('#schedCard')).display);
      if (disp !== 'none') findings.push({ tag: 'schedCard', detail: `schedule.enabled=false 时 #schedCard display=${disp}（PRD v2 §6 要求定时任务卡仅在自动模式开启时显示）` });
    });
    for (const [nav, sel, file] of [
      ['compose', '.view[data-view="compose"].on', '12-compose-empty.png'],
      ['chat', '.view[data-view="chat"].on', '13-chat-empty.png'],
      ['radar', '.view[data-view="radar"].on', '14-radar-empty.png'],
      ['history', '.view[data-view="history"].on', '15-history-empty.png'],
      ['logs', '.view[data-view="logs"].on', '16-logs-empty.png'],
      ['settings', '.view[data-view="settings"].on', '17-settings-wx.png'],
    ]) {
      await step(`视图 ${nav} 切换+截图`, async () => {
        await win.click(`.nav-item[data-nav="${nav}"]`);
        await win.waitForSelector(sel, { timeout: 5000 });
        await win.waitForTimeout(450); // viewIn 动画
        await shot(win, file);
      });
    }
    for (const [tab, file] of [
      ['llm', '18-settings-llm.png'],
      ['content', '19-settings-content-samples.png'],
      ['project', '20-settings-project.png'],
      ['aggregate', '21-settings-aggregate.png'],
      ['app', '22-settings-app.png'],
    ]) {
      await step(`设置页签 ${tab}`, async () => {
        await win.click(`.tab-btn[data-tab="${tab}"]`);
        await win.waitForSelector(`.panel[data-panel="${tab}"].on`, { timeout: 5000 });
        await win.waitForTimeout(400);
        await shot(win, file);
      });
    }

    /* ============ D. hover / focus 态 ============ */
    await step('hover：nav-item（对话共创）', async () => {
      await win.hover('.nav-item[data-nav="chat"]');
      await win.waitForTimeout(300);
      await shot(win, '23-hover-nav-chat.png');
    });
    await step('hover：mode-card（选题雷达卡）', async () => {
      await win.click('.nav-item[data-nav="dashboard"]');
      await win.waitForSelector('.view[data-view="dashboard"].on', { timeout: 5000 });
      await win.hover('.mode-card[data-goto="radar"]');
      await win.waitForTimeout(350);
      await shot(win, '24-hover-mode-card.png');
    });
    await step('hover：btn-primary（genBtn）', async () => {
      await win.hover('#genBtn');
      await win.waitForTimeout(300);
      await shot(win, '25-hover-btn-primary.png');
    });
    await step('hover：fchip（历史筛选 chip）', async () => {
      await win.click('.nav-item[data-nav="history"]');
      await win.waitForSelector('.view[data-view="history"].on', { timeout: 5000 });
      await win.hover('#histSrcFilter .fchip[data-sf="聚合"]');
      await win.waitForTimeout(300);
      await shot(win, '26-hover-fchip.png');
    });
    await step('focus：input（素材输入框 :focus 光圈）', async () => {
      await win.click('.nav-item[data-nav="compose"]');
      await win.waitForSelector('.view[data-view="compose"].on', { timeout: 5000 });
      await win.click('#matInput');
      await win.waitForTimeout(300);
      await shot(win, '27-focus-input.png');
    });
    await step('focus-visible：键盘 Tab 到 nav-item', async () => {
      await win.click('#app', { position: { x: 600, y: 300 } }); // 常规点击后焦点归 body
      await win.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
      let hit = false;
      for (let i = 0; i < 14; i++) {
        await win.keyboard.press('Tab');
        const cls = await win.evaluate(() => {
          const a = document.activeElement;
          return a ? a.className : '';
        });
        if (typeof cls === 'string' && cls.includes('nav-item')) { hit = true; break; }
      }
      const fv = await win.evaluate(() => {
        const a = document.activeElement;
        if (!a) return false;
        const cs = getComputedStyle(a);
        return { outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, cls: a.className };
      });
      if (!hit) findings.push({ tag: 'focus-tab', detail: '14 次 Tab 未落到 nav-item，focus-visible 截图可能不对：' + JSON.stringify(fv) });
      if (hit && /none/.test(fv.outline)) findings.push({ tag: 'focus-visible-missing', detail: 'nav-item 键盘聚焦后无可见 outline：' + JSON.stringify(fv) });
      await win.waitForTimeout(200);
      await shot(win, '28-focus-visible-nav.png');
    });

    /* ============ E. mock 数据流程态截图 ============ */
    await step('v1 立即生成并上传（hero 成功态）', async () => {
      await win.click('.nav-item[data-nav="dashboard"]');
      await win.waitForSelector('.view[data-view="dashboard"].on', { timeout: 5000 });
      await win.click('#genBtn');
      await win.waitForFunction(() => /草稿箱|预览/.test((document.querySelector('#heroTitle') || {}).textContent || ''), undefined, { timeout: 60000 });
      await win.waitForTimeout(400);
      await shot(win, '30-dashboard-run-uploaded.png');
    });
    await step('素材成文：生成 → 编辑器', async () => {
      await win.click('.nav-item[data-nav="compose"]');
      await win.waitForSelector('.view[data-view="compose"].on', { timeout: 5000 });
      await win.fill('#matInput', '今天修了雷达抓取超时的问题：\n1）症状：搜索接口 8s 超时后直接静默失败；\n2）根因：AbortController 没有接上重试；\n3）修法：失败统一重试一次并打日志。');
      await win.fill('#emphasisInput', '静默失败最难排查');
      await win.click('#composeGenBtn');
      await win.waitForFunction(() => /【演示】/.test((document.querySelector('#draftTitle') || {}).value || ''), undefined, { timeout: 60000 });
      await win.waitForTimeout(500);
      await shot(win, '31-compose-generated.png');
    });
    await step('素材成文：正文预览模式', async () => {
      await win.click('#previewModeBtn');
      await win.waitForTimeout(400);
      await shot(win, '32-compose-preview.png');
      await win.click('#editModeBtn');
    });
    await step('对话共创：发送 → 回复固化', async () => {
      await win.click('.nav-item[data-nav="chat"]');
      await win.waitForSelector('.view[data-view="chat"].on', { timeout: 5000 });
      await win.fill('#chatInput', '想把权限系统重构写成一篇：主题：权限系统的最小实现');
      await win.click('#chatSendBtn');
      await win.waitForFunction(() => /【演示回复】/.test((document.querySelector('#chatStream') || {}).textContent || ''), undefined, { timeout: 60000 });
      await win.waitForTimeout(400);
      await shot(win, '33-chat-reply.png');
    });
    await step('选题雷达：立即搜索 → 清单', async () => {
      await win.click('.nav-item[data-nav="radar"]');
      await win.waitForSelector('.view[data-view="radar"].on', { timeout: 5000 });
      await win.click('#radarFetchBtn');
      await win.waitForSelector('#radarList .radar-item', { timeout: 60000 });
      await win.waitForTimeout(400);
      await shot(win, '34-radar-topics.png');
    });
    await step('选题雷达：勾选 2 条 + 聚合成文（sim-bar + 来源清单）', async () => {
      await win.click('#radarList .radar-item:nth-child(1) .topic');
      await win.click('#radarList .radar-item:nth-child(2) .topic');
      await win.waitForTimeout(200);
      await shot(win, '35-radar-checked.png');
      await win.click('#radarGenBtn');
      await win.waitForFunction(() => /相似度/.test((document.querySelector('#radarGenResult') || {}).textContent || ''), undefined, { timeout: 60000 });
      await win.waitForTimeout(500);
      await shot(win, '36-radar-composed.png');
    });
    await step('历史：数据态 + 来源列', async () => {
      await win.click('.nav-item[data-nav="history"]');
      await win.waitForSelector('.view[data-view="history"].on', { timeout: 5000 });
      await win.waitForTimeout(600);
      await shot(win, '37-history-data.png');
    });
    await step('历史：来源筛选「素材」/「聚合」', async () => {
      await win.click('#histSrcFilter .fchip[data-sf="素材"]');
      await win.waitForTimeout(400);
      await shot(win, '38-history-filter-sucai.png');
      await win.click('#histSrcFilter .fchip[data-sf="聚合"]');
      await win.waitForTimeout(400);
      await shot(win, '39-history-filter-juhe.png');
      await win.click('#histSrcFilter .fchip[data-sf="all"]');
    });
    await step('历史：hover 行操作 icon-btn', async () => {
      const btn = win.locator('#histBody .icon-btn').first();
      await btn.hover();
      await win.waitForTimeout(300);
      await shot(win, '40-hover-icon-btn.png');
    });
    await step('文章预览弹窗', async () => {
      await win.locator('#histBody [data-pv]').first().click();
      await win.waitForSelector('#previewModal.on', { timeout: 5000 });
      await win.waitForTimeout(400);
      await shot(win, '41-preview-modal.png');
      await win.keyboard.press('Escape');
      await win.waitForTimeout(200);
    });
    await step('Toast 样式（复制日志触发）', async () => {
      await win.click('.nav-item[data-nav="logs"]');
      await win.waitForSelector('.view[data-view="logs"].on', { timeout: 5000 });
      await win.click('#copyLog');
      await win.waitForSelector('#toasts .toast', { timeout: 5000 });
      await win.waitForTimeout(250);
      await shot(win, '42-toast.png');
    });
    await step('设置：粘贴样文弹窗', async () => {
      await win.click('.nav-item[data-nav="settings"]');
      await win.waitForSelector('.view[data-view="settings"].on', { timeout: 5000 });
      await win.click('.tab-btn[data-tab="content"]');
      await win.click('#samplePasteBtn');
      await win.waitForSelector('#sampleModal.on', { timeout: 5000 });
      await win.waitForTimeout(350);
      await shot(win, '43-sample-modal.png');
      await win.keyboard.press('Escape');
    });

    /* ============ F. 运行时自动检查汇总 ============ */
    const icons = await win.evaluate(ICON_FN);
    log('');
    log('== 运行时自动检查 ==');
    log(`FA 字体加载：${JSON.stringify(icons.fonts)}`);
    if (icons.sampleBadge) log(`app-badge 图标 ::before content=${icons.sampleBadge.content}  family=${icons.sampleBadge.fontFamily.split(',')[0]}`);
    log(`页面内 <i class*=fa-> 总数：${icons.total}，::before content 为空的数量：${icons.emptyContent.length}${icons.emptyContent.length ? ' -> ' + icons.emptyContent.join(' | ') : ''}`);
    if (icons.fonts['fa-free-900'] === false || icons.fonts['fa-free-400'] === false || icons.fonts['fa-brands'] === false) {
      findings.push({ tag: 'fa-font', detail: 'FA 字体 document.fonts.check 为 false：' + JSON.stringify(icons.fonts) });
    }
    if (icons.emptyContent.length) findings.push({ tag: 'fa-empty-content', detail: icons.emptyContent.join(' | ') });

    log(`非 file:// 请求（CDN/外链）：${nonFileRequests.length}${nonFileRequests.length ? ' -> ' + [...new Set(nonFileRequests)].slice(0, 10).join(' , ') : ''}`);
    if (nonFileRequests.length) findings.push({ tag: 'non-file-request', detail: [...new Set(nonFileRequests)].join(' , ') });

    log(`pageerror：${pageErrors.length}${pageErrors.length ? ' -> ' + pageErrors.join(' | ').slice(0, 400) : ''}`);
    log(`console.error：${consoleErrors.length}${consoleErrors.length ? ' -> ' + consoleErrors.join(' | ').slice(0, 400) : ''}`);
    log(`console.warning：${consoleWarnings.length}${consoleWarnings.length ? ' -> ' + consoleWarnings.slice(0, 5).join(' | ').slice(0, 300) : ''}`);
    if (pageErrors.length) findings.push({ tag: 'pageerror', detail: pageErrors.join(' | ') });
    if (consoleErrors.length) findings.push({ tag: 'console-error', detail: consoleErrors.join(' | ') });

    // 溢出检测在两个代表性时点：数据态历史页 + 素材成文页
    await win.click('.tab-btn[data-tab="content"]');
    await win.waitForTimeout(300);
    for (const [label, nav, sel] of [
      ['设置-样本库', 'settings', '.view[data-view="settings"].on'],
      ['素材成文', 'compose', '.view[data-view="compose"].on'],
      ['对话共创', 'chat', '.view[data-view="chat"].on'],
      ['选题雷达', 'radar', '.view[data-view="radar"].on'],
      ['历史', 'history', '.view[data-view="history"].on'],
      ['仪表盘', 'dashboard', '.view[data-view="dashboard"].on'],
    ]) {
      await win.click(`.nav-item[data-nav="${nav}"]`);
      await win.waitForSelector(sel, { timeout: 5000 });
      await win.waitForTimeout(450);
      const ov = await win.evaluate(OVERFLOW_FN);
      log(`溢出检测[${label}]：${ov.length} 条${ov.length ? ' -> ' + ov.slice(0, 12).map((o) => `${o.kind}:${o.sel} "${o.text}" ${o.sw}>${o.cw}`).join(' ; ') : ''}`);
      if (ov.length) findings.push({ tag: 'overflow-' + nav, detail: ov.slice(0, 12).map((o) => `${o.kind}:${o.sel} "${o.text}" ${o.sw}>${o.cw}`).join(' ; ') });
    }
    const bodyFont = await win.evaluate(() => getComputedStyle(document.body).fontFamily);
    log(`body font-family：${bodyFont}`);
    const cssVars = await win.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return { brand: cs.getPropertyValue('--brand').trim(), brandDeep: cs.getPropertyValue('--brand-deep').trim(), paper: cs.getPropertyValue('--paper').trim(), ink: cs.getPropertyValue('--ink').trim(), r: cs.getPropertyValue('--r').trim() };
    });
    log(`设计 token 取值：${JSON.stringify(cssVars)}`);

    // 采色对比：侧边栏背景 / 主按钮 / hero 图标底
    const colorSamples = await win.evaluate(() => {
      const g = (sel, prop) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el)[prop] : null;
      };
      return {
        sidebar: g('.sidebar', 'backgroundColor'),
        titlebar: g('.titlebar', 'backgroundColor'),
        btnPrimary: g('.btn-primary', 'backgroundColor'),
        statusIco: g('.status-ico', 'backgroundColor'),
        card: g('.card', 'backgroundColor'),
        chipGreen: g('.chip.st-green', 'color'),
        navActive: (() => {
          const el = document.querySelector('.nav-item.active');
          return el ? getComputedStyle(el).color : null;
        })(),
      };
    });
    log(`颜色采样（数据态 dashboard）：${JSON.stringify(colorSamples)}`);

    /* ============ G. 结果汇总 ============ */
    log('');
    log('== findings（运行时自动检查，需人工结合截图定级）==');
    if (findings.length === 0) log('（无）');
    findings.forEach((f, i) => log(`F${i + 1} [${f.tag}] ${f.detail}`));
    log('');
    log('截图清单见上方 [shot] 行；截图目录：' + OUT);
  } catch (e) {
    log(`[FATAL] ${String(e && e.stack ? e.stack : e)}`);
    if (win) { try { await shot(win, '99-error-state.png'); } catch (_) { } }
  } finally {
    try { await app.close(); } catch (_) { }
  }
  fs.writeFileSync(SUMMARY, lines.join('\n'), 'utf8');
  console.log(`\n摘要已写入：${SUMMARY}`);
  process.exit(0);
})().catch((e) => { console.error('[style-check] 未预期失败：', e); process.exit(1); });
