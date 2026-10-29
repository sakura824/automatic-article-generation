#!/usr/bin/env node
'use strict';
/**
 * smoke-electron.js —— Playwright _electron 冒烟测试。
 *
 * 覆盖（v2 联调 ask 第 3 项）：
 *   1. 应用能启动、主窗口出现、无 pageerror / console error；
 *   2. 首次启动自动进入配置向导，可关闭；
 *   3. 七个视图（仪表盘/素材成文/对话共创/选题雷达/历史/日志/设置）切换无报错并截图；
 *   4. v1 mock 全链路：注入 mock 配置（临时 git 仓库）→ 「立即生成并上传」→ uploaded；
 *   5. v2 三条新流程（mock）：
 *      a. 素材成文：compose:generate mode=material → 编辑器加载；
 *      b. 对话共创：chat:send（含 chat:segment 分段）→「整理成文章」→ 编辑器加载；
 *      c. 选题雷达：radar:run（搜索/去重/分级）→ 勾选 → compose:generate mode=radar
 *         （相似度自检 + 素材来源清单内部可见）→ 进编辑器。
 *
 * 运行：npm run smoke（或 node scripts/smoke-electron.js）。
 * 证据：test-evidence/e2e-smoke-<YYYY-MM-DD>/ 截图 + test-evidence/e2e-smoke-<YYYY-MM-DD>.txt 摘要。
 * 退出码：0 = 全部通过；1 = 存在失败（摘要里逐条列出）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const pad2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const STAMP = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
const SHOT_DIR = path.join(ROOT, 'test-evidence', `e2e-smoke-${STAMP}`);
const SUMMARY = path.join(ROOT, 'test-evidence', `e2e-smoke-${STAMP}.txt`);

const results = []; // {name, ok, detail}
const pageErrors = [];
const consoleErrors = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' —— ' + detail : ''}`);
}

async function shot(win, name) {
  const file = path.join(SHOT_DIR, name);
  await win.screenshot({ path: file });
  return file;
}

/** 断言元素可见文本/值命中正则（正则以 source 字符串传入页面上下文重建）。 */
async function textMatches(win, sel, re, timeout = 60000) {
  try {
    await win.waitForFunction(
      ([s, r]) => {
        const el = document.querySelector(s);
        if (!el) return false;
        const text = (el.textContent || '') + ' ' + (el.value || '');
        return new RegExp(r).test(text);
      },
      [sel, re.source],
      { timeout }
    );
    return true;
  } catch (e) {
    return false;
  }
}

function makeGitRepo(dir) {
  const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 'smoke@example.com']);
  g(['config', 'user.name', 'smoke']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# smoke repo\n\n今日修复了登录页的一个边界问题。\n', 'utf8');
  g(['add', '-A']);
  g(['commit', '-m', 'fix: 登录页边界条件修复']);
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'test-evidence'), { recursive: true });

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wdp-smoke-ud-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wdp-smoke-repo-'));
  makeGitRepo(repo);

  const app = await electron.launch({
    executablePath: require('electron'), // desktop-app node_modules 的 electron.exe
    args: ['.'],
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      WECHAT_DAILY_MOCK: '1',        // 微信/LLM/搜索走确定性桩
      WECHAT_DAILY_USERDATA: userData, // main.js 测试钩子：独立 userData，从干净配置起步
    }),
  });

  let win = null;
  try {
    app.on('window', (w) => {
      w.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
      w.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
    });
    win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 1. 窗口与应用外壳
    await win.waitForSelector('#genBtn', { timeout: 30000 });
    record('窗口打开且应用外壳渲染（#genBtn 可见）', true);
    const title = await win.title();
    record('页面标题', title === '公众号写作助手', `title="${title}"`);

    // 2. 首启向导（wizardDone=false 自动打开）
    await win.waitForSelector('#wizard.on', { timeout: 10000 });
    await shot(win, '00-wizard-firstboot.png');
    record('首次启动自动进入配置向导', true);
    await win.click('#wizClose');
    await win.waitForSelector('#wizard.on', { state: 'detached', timeout: 5000 });
    record('向导可关闭并回到仪表盘', true);

    // 3. v1 四视图 + v2 三视图切换
    const views = [
      ['dashboard', '01-dashboard.png', '.view[data-view="dashboard"].on'],
      ['compose', '02-compose.png', '.view[data-view="compose"].on'],
      ['chat', '03-chat.png', '.view[data-view="chat"].on'],
      ['radar', '04-radar.png', '.view[data-view="radar"].on'],
      ['pool', '04b-pool.png', '.view[data-view="pool"].on'],
      ['history', '05-history.png', '.view[data-view="history"].on'],
      ['logs', '06-logs.png', '.view[data-view="logs"].on'],
      ['settings', '07-settings.png', '.view[data-view="settings"].on'],
    ];
    for (const [name, file, sel] of views) {
      await win.click(`.nav-item[data-nav="${name}"]`);
      await win.waitForSelector(sel, { timeout: 5000 });
      await shot(win, file);
      record(`视图切换：${name}`, true);
    }
    // 3b. 设置页六个页签逐个切换
    // v2.2 真实教训：renderer 某个文件少一个括号会让整页交互静默失效，
    // 而 .view.on 依然正常——只验证「视图能切过去」查不出这类问题，必须点进去看面板。
    await win.click('.nav-item[data-nav="settings"]');
    await win.waitForSelector('.view[data-view="settings"].on', { timeout: 5000 });
    const tabNames = await win.$$eval('#setTabs .tab-btn', (els) => els.map((e) => e.dataset.tab));
    let tabAllOk = tabNames.length === 6;
    let tabFailAt = tabAllOk ? '' : `页签数量=${tabNames.length}`;
    for (const t of tabAllOk ? tabNames : []) {
      await win.click(`#setTabs .tab-btn[data-tab="${t}"]`);
      const shown = await win.$eval('.panel.on', (el) => el.dataset.panel).catch(() => '(none)');
      if (shown !== t) { tabAllOk = false; tabFailAt = `${t} → 显示 ${shown}`; break; }
    }
    record('设置页六个页签均可切换', tabAllOk, tabAllOk ? `tabs=${tabNames.join(',')}` : `失败于 ${tabFailAt}`);
    const settingsWired = await win.evaluate(
      () => !!(window.App && window.App.settingsView && window.App.viewRefresh && window.App.viewRefresh.settings)
    );
    record('设置视图已注册（App.settingsView / viewRefresh.settings）', settingsWired);
    await shot(win, '07b-settings-aggregate.png');

    // 日志视图应有主进程启动日志（log:append 真实事件驱动）
    const logText = await win.textContent('#logConsole');
    record('日志视图收到主进程 log:append', /应用启动/.test(logText || ''), `len=${(logText || '').length}`);

    // 4. 注入 mock 配置（llm/apiKey 供成文，aggregate 供雷达；定时关闭避免与手动运行竞争）
    const setRes = await win.evaluate(async (repoPath) => {
      const r = await window.api.invoke('config:set', {
        wechat: { appId: 'wxsmoke0000000001', appSecret: 'mock-secret-0001' },
        llm: { apiKey: 'mock-key-0001' },
        content: { repoPath },
        aggregate: { keywords: ['科技', '教育'], whitelist: [], searchApiKey: 'mock-search-key-0001' },
        app: { schedule: { enabled: false } },
      });
      return r;
    }, repo);
    record('config:set 注入 mock 配置（含 v2 aggregate 区）', !!(setRes && setRes.ok && setRes.data && setRes.data.config), JSON.stringify(setRes && setRes.error ? setRes.error : {}).slice(0, 200));

    await win.reload();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForSelector('#genBtn:not([disabled])', { timeout: 15000 });
    record('向导完成后 genBtn 解锁（wizardDone=true）', true);

    // 5. v1 mock 全链路：立即生成并上传
    await win.click('#genBtn');
    await win.waitForFunction(
      () => {
        const el = document.querySelector('#heroTitle');
        return /草稿箱|预览/.test((el && el.textContent) || '');
      },
      undefined,
      { timeout: 60000 }
    );
    const heroText = await win.textContent('#heroTitle');
    // 成功后 onRunFinished 会 resetSteps() 清掉 done 标记（dashboard.js），所以以 hero 文案为准
    record('v1 mock 运行全链路完成（run:finished → hero 更新）', /草稿箱/.test(heroText), `hero="${heroText}"`);
    await shot(win, '08-run-uploaded.png');

    // 产物与状态落盘核对（v1）
    const outDir = path.join(userData, 'output');
    const days = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
    const day = days[0];
    const articleOk = day && fs.existsSync(path.join(outDir, day, 'article.json'));
    const uploadedOk = day && fs.existsSync(path.join(outDir, day, 'uploaded.json'));
    record('v1 产物落盘：article.json + uploaded.json', !!articleOk && !!uploadedOk, `output/${day}`);

    // 6. v2 素材成文：compose:generate mode=material → 编辑器
    await win.click('.nav-item[data-nav="compose"]');
    await win.waitForSelector('.view[data-view="compose"].on', { timeout: 5000 });
    await win.fill('#matInput', '今天修了登录页 token 过期后不自动刷新的问题：\n1）症状：用户放置 2 小时后操作全部静默失败；\n2）根因：刷新用的 refresh_token 也过期了，且失败分支没打日志；\n3）修法：刷新失败统一重定向登录页，并埋点记录 code。');
    await win.fill('#emphasisInput', '静默失败最难排查');
    await win.click('#composeGenBtn');
    const matOk = await textMatches(win, '#draftTitle', /【演示】/);
    const editorVisible = await win.isVisible('#editorPanel');
    record('v2 素材成文（compose:generate mode=material → 编辑器加载）', matOk && editorVisible, `title="${await win.inputValue('#draftTitle')}"`);
    // v2.3：正文插图链路（mock 样文里带一条 <illus>，渲染后应变成 data:image/png 的 <img>）
    const draftedHtml = await win.inputValue('#draftBody');
    const illusOk = /<img[^>]+src="data:image\/png;base64,/.test(draftedHtml || '');
    const illusLeftover = /<illus\b/i.test(draftedHtml || '');
    record(
      'v2.3 正文插图（<illus> → 渲染为 <img data:image/png>，无残留占位）',
      illusOk && !illusLeftover,
      `img=${illusOk} 残留=${illusLeftover} 正文长度=${(draftedHtml || '').length}`
    );
    await shot(win, '09-compose-generated.png');
    // 切到预览模式，确认 data: 图片在 CSP 下能显示（img-src 已放宽）
    await win.click('#previewModeBtn');
    await new Promise((r) => setTimeout(r, 300));
    const previewShown = await win.evaluate(() => {
      const img = document.querySelector('#draftPreview img');
      return img ? { ok: img.complete && img.naturalWidth > 0, w: img.naturalWidth } : { ok: false, w: 0 };
    });
    record('v2.3 预览模式下插图正常显示（CSP 允许 data: 图片）', previewShown.ok, `naturalWidth=${previewShown.w}`);
    await shot(win, '09b-compose-illustration.png');
    await win.click('#editModeBtn');

    // 7. v2 对话共创：chat:send（分段事件）→ 整理成文章
    await win.click('.nav-item[data-nav="chat"]');
    await win.waitForSelector('.view[data-view="chat"].on', { timeout: 5000 });
    await win.fill('#chatInput', '想把权限系统重构写成一篇：主题：权限系统的最小实现');
    await win.click('#chatSendBtn');
    const replyOk = await textMatches(win, '#chatStream', /【演示回复】/);
    record('v2 对话回复（chat:send → chat:segment 分段固化显示）', replyOk);
    await shot(win, '10-chat-reply.png');
    await win.click('#chatToComposeBtn');
    const chatComposeOk = await textMatches(win, '#draftTitle', /权限系统/);
    record('v2 整理成文章（compose:generate mode=chat → 编辑器加载）', chatComposeOk, `title="${await win.inputValue('#draftTitle')}"`);
    await shot(win, '11-chat-composed.png');

    // 8. v2 选题雷达：radar:run → 勾选 → 聚合成文（相似度自检 + 来源清单）
    await win.click('.nav-item[data-nav="radar"]');
    await win.waitForSelector('.view[data-view="radar"].on', { timeout: 5000 });
    await win.click('#radarFetchBtn');
    await win.waitForSelector('#radarList .radar-item', { timeout: 60000 });
    const topicCount = await win.$$eval('#radarList .radar-item', (els) => els.length);
    record('v2 选题雷达（radar:run → 清单渲染，去重/分级）', topicCount > 0, `topics=${topicCount}`);
    await shot(win, '12-radar-topics.png');
    // 勾选前两条（点条目内的 .topic 文本区，避开 rmeta 行的外链 data-url——链接点击不改变勾选）
    await win.click('#radarList .radar-item:nth-child(1) .topic');
    await win.click('#radarList .radar-item:nth-child(2) .topic');
    const checkedCount = await win.evaluate(() => document.querySelectorAll('#radarList .radar-item.checked').length);
    record('v2 勾选选题', checkedCount === 2, `checked=${checkedCount}`);
    await win.click('#radarGenBtn');
    const genOk = await textMatches(win, '#radarGenResult', /相似度/);
    const genText = genOk ? await win.textContent('#radarGenResult') : '';
    record(
      'v2 聚合成文（compose:generate mode=radar → 相似度自检 + 来源清单内部可见）',
      genOk && /素材来源清单/.test(genText) && /不随文章发布/.test(genText),
      genText.replace(/\s+/g, ' ').slice(0, 120)
    );
    await shot(win, '13-radar-composed.png');
    await win.click('#radarToEditor');
    const radarEditorOk = await win.isVisible('#editorPanel');
    record('v2 聚合成文进编辑器（origin=聚合 可继续修改）', radarEditorOk);
    await shot(win, '14-radar-editor.png');

    // 8b. v2.2 内容池：加题 → 切定时模式 → 立即写一条（成文 + 上传，与定时同一执行体）
    await win.click('.nav-item[data-nav="pool"]');
    await win.waitForSelector('.view[data-view="pool"].on', { timeout: 5000 });
    await win.fill('#poolTitle', '【演示】内容池自动写的第一条题目');
    await win.fill('#poolEmphasis', '强调按队列顺序写，先加的先写');
    await win.click('#poolAddBtn');
    await win.waitForSelector('#poolList .pool-item', { timeout: 15000 });
    const poolCount = await win.$$eval('#poolList .pool-item', (els) => els.length);
    record('v2.2 内容池加入题目（pool:add → 列表渲染）', poolCount === 1, `items=${poolCount}`);
    await shot(win, '15-pool-add.png');

    // 切定时模式（验证 schedule:set mode 通道 + schedule:get 返回 poolPending）
    const modeRes = await win.evaluate(async () => window.api.invoke('schedule:set', { mode: 'pool' }));
    const modeOk = !!(modeRes && modeRes.ok && modeRes.data && modeRes.data.mode === 'pool' && modeRes.data.poolPending === 1);
    record('v2.2 定时模式切换为内容池（schedule:set mode=pool，poolPending 透出）', modeOk, JSON.stringify(modeRes && modeRes.data ? { mode: modeRes.data.mode, pending: modeRes.data.poolPending } : (modeRes && modeRes.error) || {}).slice(0, 160));

    // 立即写一条：队列被消耗（待写归零）+ 历史新增 origin=内容池
    await win.click('#poolRunNowBtn');
    await win.waitForFunction(
      () => {
        const el = document.querySelector('#poolStatChip');
        return el && /待写 0/.test(el.textContent || '');
      },
      undefined,
      { timeout: 120000 }
    );
    record('v2.2 内容池立即写一条（跑完自动刷新队列状态）', true, await win.textContent('#poolStatChip'));
    await new Promise((r) => setTimeout(r, 500)); // 等历史/仪表盘刷新落定再截图
    await shot(win, '16-pool-written.png');

    // v2 状态落盘核对：四种来源各一条带 id 的历史
    const stateJson = JSON.parse(fs.readFileSync(path.join(userData, 'state.json'), 'utf8'));
    const v2Origins = (stateJson.history || []).filter((h) => h.id).map((h) => h.origin);
    record(
      'v2 历史落盘（素材/对话/聚合/内容池 各带 id 条目）',
      v2Origins.includes('素材') && v2Origins.includes('对话') && v2Origins.includes('聚合') && v2Origins.includes('内容池'),
      `origins=${JSON.stringify(v2Origins)}`
    );
    const poolItem = (stateJson.history || []).find((h) => h.origin === '内容池');
    record('v2.2 内容池成文为已上传状态（自动进草稿箱）', !!(poolItem && poolItem.status === 'uploaded'), poolItem ? `status=${poolItem.status} words=${poolItem.words}` : 'no entry');

    // 9. 无未捕获异常 / console error（覆盖以上全部交互）
    record('无 pageerror（未捕获异常）', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
    record('无 console.error', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300));
  } catch (e) {
    record('冒烟流程执行', false, String(e && e.message ? e.message : e));
    if (win) {
      try { await shot(win, '99-error-state.png'); } catch (_) { /* 截图失败不掩盖原错误 */ }
    }
  } finally {
    try { await app.close(); } catch (_) { /* 尽力关闭 */ }
  }

  // 摘要落盘
  const passed = results.filter((r) => r.ok).length;
  const lines = [
    `# 公众号写作助手 Electron 冒烟（playwright _electron，WECHAT_DAILY_MOCK=1，v2 八视图 + 内容池）`,
    `运行时间：${new Date().toISOString()}  Node ${process.version}`,
    `命令：node scripts/smoke-electron.js`,
    `结果：${passed}/${results.length} 项通过${passed === results.length ? '（全部通过）' : '（存在失败）'}`,
    '',
    ...results.map((r) => `[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' —— ' + r.detail : ''}`),
    '',
    `截图目录：test-evidence/e2e-smoke-${STAMP}/`,
  ];
  fs.writeFileSync(SUMMARY, lines.join('\n'), 'utf8');
  console.log(`\n摘要已写入：${SUMMARY}`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error('[smoke] 未预期失败：', e);
  process.exit(1);
});
