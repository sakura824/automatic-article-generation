/* ============================================================
 * app.js —— 应用外壳：导航 / 标题栏 / Toast / 快捷键 / 深链接 / 共享工具
 * 依赖 js/api.js（先加载）。视图文件通过 App.viewInits 注册初始化。
 * ============================================================ */
(function () {
  'use strict';

  const App = window.App;

  /* ---------------- DOM 工具 ---------------- */
  App.$ = (s, el) => (el || document).querySelector(s);
  App.$$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  const { $, $$ } = App;

  /* ---------------- 模式标注（契约 §4：界面标注演示模式） ---------------- */
  if (App.demo) {
    document.body.classList.add('demo');
    document.title = '公众号写作助手 · 交互设计稿';
    const ver = $('#verLabel');
    if (ver) ver.textContent = 'v2.1.0 · 演示模式';
  } else {
    document.body.classList.add('electron');
  }

  /* ---------------- 全局状态 ---------------- */
  App.state = {
    cfg: null,            // config:get 返回的脱敏配置
    wizardDone: true,
    schedule: null,       // schedule:get 返回 {enabled,time,nextRunAt}
    ip: null,             // net:public-ip
    aiDisclosureText: '本文由 AI 生成，经人工审阅修改',
  };

  /* ---------------- 设计稿状态枚举（禁止改名，prototype STATUS） ----------------
   * v2.4：published/removed/replaced 为状态同步与打回重写的增量枚举（core state.js STATUS_VALUES）。 */
  App.STATUS = {
    uploaded:  { label: '已上传 · 待发表', cls: 'st-green',  short: '待发表' },
    generated: { label: '已生成 · 未上传', cls: 'st-amber',  short: '未上传' },
    skipped:   { label: '无变更 · 跳过',   cls: 'st-gray',   short: '跳过' },
    failed:    { label: '上传失败',        cls: 'st-red',    short: '失败' },
    published: { label: '已发表',          cls: 'st-green',  short: '已发表' },
    removed:   { label: '已删除 · 未使用', cls: 'st-gray',   short: '已删除' },
    replaced:  { label: '已打回 · 重写',   cls: 'st-violet', short: '已打回' },
  };

  /* ---------------- v2：历史来源标注（PRD v2 §2：素材/对话/自动/聚合） ----------------
   * 键名对齐 core state.js ORIGIN_VALUES（中文枚举）；v1 老记录缺 origin 按「自动」兜底。 */
  App.SOURCE = {
    '素材': { label: '素材成文', cls: 'st-blue',  short: '素材' },
    '对话': { label: '对话共创', cls: 'st-green', short: '对话' },
    '自动': { label: '仓库自动', cls: 'st-gray',  short: '自动' },
    '聚合': { label: '全网聚合', cls: 'st-amber', short: '聚合' },
    '内容池': { label: '内容池定时', cls: 'st-violet', short: '内容池' },
  };

  /** 仓库自动（C 模式）是否已具备运行条件：需要配置代码仓库路径（PRD v2 §2） */
  App.autoConfigMissing = function () {
    const c = (App.state.cfg && App.state.cfg.content) || {};
    return !String(c.repoPath || '').trim();
  };

  /** v2：来源兜底（v1 老记录与缺省 origin 字段一律按仓库自动） */
  App.sourceOf = function (s) { return App.SOURCE[s] || App.SOURCE['自动']; };

  /** v2：选题雷达来源分级（PRD v2 §5.6：L1 官方 / L2 学术 / L3 科普） */
  App.RADAR_LEVEL = {
    L1: { label: 'L1 官方', cls: 'lv-chip lv-l1' },
    L2: { label: 'L2 学术', cls: 'lv-chip lv-l2' },
    L3: { label: 'L3 科普', cls: 'lv-chip lv-l3' },
  };
  App.radarLevelOf = function (lv) { return App.RADAR_LEVEL[lv] || App.RADAR_LEVEL.L3; };

  App.CAUSE_LABEL = { manual: '手动执行', scheduled: '自动执行', catchup: '补跑执行', reupload: '重新上传' };

  /* ---------------- 格式化 ---------------- */
  App.fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : (n == null ? '—' : String(n)));
  App.fmtWords = (w) => (w === 0 || w == null ? '—' : App.fmtNum(w));
  App.md = (dateStr) => (dateStr ? String(dateStr).slice(5) : '');
  App.todayKey = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  /* ---------------- Toast（PRD F3：失败 Toast 支持「查看日志」跳转） ---------------- */
  App.toast = function (msg, type = 'ok', action = null) {
    const box = $('#toasts');
    // 同一时刻只保留 1 条 toast：连续操作时多条竖向叠加会压住标题栏右侧的主动作按钮
    // （素材成文「文风画像」/ 对话「整理成文章」/ 雷达「立即搜索」），点击目标被临时遮挡。
    while (box.firstChild) box.removeChild(box.firstChild);
    const t = document.createElement('div');
    t.className = 'toast' + (type === 'err' ? ' err' : '');
    const icon = type === 'err' ? 'fa-circle-exclamation' : 'fa-circle-check';
    t.innerHTML = '<i class="fa-solid ' + icon + '"></i><span></span>';
    t.querySelector('span').textContent = msg;
    if (action && action.label) {
      const b = document.createElement('button');
      b.className = 'toast-act';
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', () => { dismiss(); if (action.onClick) action.onClick(); });
      t.appendChild(b);
    }
    box.appendChild(t);
    let gone = false;
    function dismiss() {
      if (gone) return;
      gone = true;
      t.classList.add('out');
      setTimeout(() => t.remove(), 320);
    }
    setTimeout(dismiss, action ? 6000 : 3400);
    return t;
  };

  /** 原始 JS 异常（如 “x is not a function”）不该直接出现在中文界面：换成可操作的兜底文案。 */
  App.friendlyMessage = function (e, fallback) {
    const raw = e && e.message ? String(e.message) : '';
    const looksLikeJsError = /is not a function|is not defined|of undefined|of null|Cannot read propert|\[object Object\]/i.test(raw);
    if (!raw || looksLikeJsError) return fallback || '操作未完成，请查看运行日志';
    return raw;
  };

  /** 渲染层单一路径的 API 错误处理（契约 §2） */
  App.handleErr = function (err, fallbackMsg, action) {
    const e = (err && err.code) ? err : { message: (err && err.message) || fallbackMsg || '操作失败' };
    const msg = e.message || fallbackMsg || '操作失败';
    const full = e.hint ? msg + ' ' + e.hint : msg;
    App.toast(full.length > 120 ? msg : full, 'err', action);
    console.error('[api]', e.code || '', e.errcode || '', msg, e.hint || '');
  };

  /* ---------------- 按钮忙碌态（PRD §7：测试中显示正在做什么） ---------------- */
  App.setBusy = function (btn, busyHtml) {
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = busyHtml;
    return function restore() {
      btn.disabled = false;
      btn.innerHTML = original;
    };
  };
  App.BUSY_ICON = '<i class="fa-solid fa-spinner spin"></i>';

  /* ---------------- 横幅（测试连接结果区，沿用设计稿标记结构） ---------------- */
  App.banner = function (type, html) {
    const icon = type === 'ok' ? 'fa-circle-check' : 'fa-circle-exclamation';
    const cls = type === 'ok' ? 'banner-ok' : 'banner-err';
    return '<div class="banner ' + cls + '"><i class="fa-solid ' + icon + '" style="margin-top:2px;"></i><span>' + html + '</span></div>';
  };

  /** 40164 专项卡（PRD §10：捕获后展示当前 IP + 复制按钮 + 后台直达链接） */
  App.ipWhitelistCard = function (ip) {
    return '' +
      '<div class="card" style="box-shadow:none;margin-top:10px;padding:12px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:var(--paper);">' +
      '  <span style="font-size:12.5px;color:var(--text-3);">本机公网 IP</span>' +
      '  <code style="font-size:14px;font-weight:700;letter-spacing:.03em;">' + (ip || '获取中…') + '</code>' +
      '  <button class="btn btn-ghost btn-sm" data-copy-ip><i class="fa-regular fa-copy"></i>复制</button>' +
      '  <button class="btn btn-ghost btn-sm" data-open-whitelist><i class="fa-solid fa-arrow-up-right-from-square"></i>打开白名单设置页</button>' +
      '</div>';
  };
  App.bindIpCardActions = function (container, getIp) {
    $$('[data-copy-ip]', container).forEach((b) => b.addEventListener('click', () => App.copyText(getIp(), '已复制到剪贴板')));
    $$('[data-open-whitelist]', container).forEach((b) => b.addEventListener('click', () => App.openExternal('https://mp.weixin.qq.com/')));
  };

  /* ---------------- 剪贴板 / 外链 ---------------- */
  App.copyText = async function (text, okMsg) {
    try {
      await navigator.clipboard.writeText(text == null ? '' : String(text));
      App.toast(okMsg || '已复制到剪贴板');
    } catch (e) {
      App.toast('复制失败：剪贴板不可用', 'err');
    }
  };
  App.openExternal = function (url) {
    return App.api.invoke('shell:open-external', { url })
      .catch((e) => App.handleErr(e, '打开外部链接失败'));
  };
  App.openPath = function (path) {
    return App.api.invoke('shell:open-path', { path })
      .catch((e) => App.handleErr(e, '打开目录失败'));
  };

  /* ---------------- 开关 ---------------- */
  App.bindSwitch = function (el, onChange) {
    el.addEventListener('click', () => {
      const next = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', String(next));
      if (onChange) onChange(next, el);
    });
  };
  App.setSwitch = function (el, on) {
    el.setAttribute('aria-checked', String(!!on));
  };

  /* ---------------- 密码显隐 ---------------- */
  App.bindEye = function (btn, input, onReveal) {
    if (!btn || !input || btn.dataset.eyeBound === '1') return; // 幂等：避免重复绑定导致一次点击切换两次
    btn.dataset.eyeBound = '1';
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = '<i class="fa-regular ' + (show ? 'fa-eye-slash' : 'fa-eye') + '"></i>';
      if (onReveal) onReveal(show);
    });
  };

  /** 统一绑定页面上所有「眼睛」按钮（index.html 用 data-eye 指向目标输入框 id）。
   *  逐个显式绑定容易漏（设置页 AppSecret / 大模型 Key、向导第 1/2 步曾经全是死按钮）。 */
  App.bindAllEyes = function (root) {
    $$('.input-eye[data-eye]', root || document).forEach((btn) => {
      const input = $('#' + btn.dataset.eye);
      if (input) App.bindEye(btn, input);
    });
  };

  /* ---------------- 弹窗 ---------------- */
  App.openOverlay = function (id) { $('#' + id).classList.add('on'); };
  App.closeOverlay = function (id) { $('#' + id).classList.remove('on'); };

  /* ---------------- 视图切换 + 深链接 ----------------
   * 新增视图必须同时登记在这里：showView 对未登记的名字直接 return（静默），
   * 漏登记的表现是「点了导航没反应、也不报错」——pool 第一次接入就踩过。 */
  const VIEW_NAMES = ['dashboard', 'compose', 'chat', 'radar', 'pool', 'history', 'logs', 'settings'];
  App.currentView = 'dashboard';
  App.viewRefresh = {};   // 各视图注册的刷新函数（切到该页时调用）

  App.showView = function (name) {
    if (!VIEW_NAMES.includes(name)) return;
    App.currentView = name;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
    $$('.view').forEach((v) => v.classList.toggle('on', v.dataset.view === name));
    $('#viewport').scrollTop = 0;
    if (App.viewRefresh[name]) {
      try { App.viewRefresh[name](); } catch (e) { console.error(e); }
    }
  };

  /** v2：跳转设置页并定位页签（如「聚合来源配置」入口），tab 缺省时保持当前页签 */
  App.showSettingsTab = function (tab) {
    App.showView('settings');
    if (!tab || !App.settingsView || !App.settingsView.showTab) return;
    App.settingsView.showTab(tab);
  };

  /* ---------------- 托盘状态 pill（标题栏，随 schedule 数据更新） ---------------- */
  App.updateTrayPill = function (schedule) {
    App.state.schedule = schedule || App.state.schedule;
    const pill = $('#trayPill');
    if (!pill) return;
    const s = App.state.schedule;
    let text = '托盘运行中';
    if (s && s.enabled && s.nextRunAt) {
      const next = new Date(s.nextRunAt);
      const today = App.todayKey();
      const dayKey = next.getFullYear() + '-' + String(next.getMonth() + 1).padStart(2, '0') + '-' + String(next.getDate()).padStart(2, '0');
      const hm = String(next.getHours()).padStart(2, '0') + ':' + String(next.getMinutes()).padStart(2, '0');
      text += ' · ' + (dayKey === today ? '今天 ' : '明天 ') + hm;
    } else if (s && !s.enabled) {
      text += ' · 定时已暂停';
    }
    pill.innerHTML = '<span class="dot dot-green"></span>';
    pill.appendChild(document.createTextNode(text));
  };

  /** schedule:get 的 nextRunAt → 设计稿 nextRun chip 文案 */
  App.renderNextRunChip = function (schedule) {
    const el = $('#nextRun');
    if (!el) return;
    if (schedule && schedule.enabled && schedule.nextRunAt) {
      const next = new Date(schedule.nextRunAt);
      const today = App.todayKey();
      const dayKey = next.getFullYear() + '-' + String(next.getMonth() + 1).padStart(2, '0') + '-' + String(next.getDate()).padStart(2, '0');
      const hm = String(next.getHours()).padStart(2, '0') + ':' + String(next.getMinutes()).padStart(2, '0');
      el.className = 'chip st-blue';
      el.innerHTML = '<i class="fa-solid fa-forward"></i>下次：' + (dayKey === today ? '今天 ' : '明天 ') + hm;
    } else {
      el.className = 'chip st-gray';
      el.innerHTML = '<i class="fa-solid fa-pause"></i>已暂停';
    }
  };

  /* ---------------- 自检进度共享渲染（向导第 4 屏 & 自检弹窗） ---------------- */
  App.setCheckState = function (container, index, state, detail) {
    const item = $('.check-item[data-ck="' + index + '"]', container);
    if (!item) return;
    item.classList.remove('run', 'ok', 'fail');
    if (state) item.classList.add(state);
    const ci = item.querySelector('.ci');
    const cd = item.querySelector('.cd');
    if (state === 'run') ci.innerHTML = '<i class="fa-solid fa-spinner spin"></i>';
    if (state === 'ok') ci.innerHTML = '<i class="fa-solid fa-check"></i>';
    if (state === 'fail') ci.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i>';
    if (state === 'ok' || state === 'fail') cd.textContent = detail || '';
    if (state === 'run') cd.textContent = '';
  };
  App.resetChecks = function (container) {
    $$('.check-item', container).forEach((it) => {
      const ci = it.querySelector('.ci');
      if (!ci.dataset.base) ci.dataset.base = ci.innerHTML;
      ci.innerHTML = ci.dataset.base;
      it.classList.remove('run', 'ok', 'fail');
      it.querySelector('.cd').textContent = '';
    });
  };

  /* ============================================================
   * 外壳事件绑定
   * ============================================================ */
  function bindShell() {
    // 侧边导航 / 跳转链接。进「素材成文」时如当前编辑器是对话/雷达成文，先复位到素材新建态
    const gotoTarget = (name) => {
      if (name === 'compose' && App.composeView && App.composeView.ensureMaterialMode) {
        try { App.composeView.ensureMaterialMode(); } catch (e) { console.error(e); }
      }
      App.showView(name);
    };
    $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => gotoTarget(btn.dataset.nav)));
    $$('[data-goto]').forEach((el) => el.addEventListener('click', () => gotoTarget(el.dataset.goto)));

    // 窗口控制：真实模式走 IPC；演示模式保持设计稿 toast
    $$('.win-btn').forEach((b) => b.addEventListener('click', async () => {
      const map = { min: 'win:minimize', max: 'win:toggle-max', close: 'win:close' };
      if (!App.demo) {
        try { await App.api.invoke(map[b.dataset.win]); } catch (e) { App.handleErr(e); }
        return;
      }
      const tips = { min: '已最小化到任务栏', max: '已切换最大化', close: '已最小化到托盘，每日任务照常执行' };
      App.toast(tips[b.dataset.win]);
    }));

    // 关闭按钮 / 遮罩点击 / Escape
    $$('[data-close]').forEach((b) => b.addEventListener('click', () => App.closeOverlay(b.dataset.close)));
    $$('.overlay, .modal').forEach((ov) => ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('on'); }));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') $$('.overlay.on, .modal.on').forEach((ov) => ov.classList.remove('on'));
    });
  }

  /* ============================================================
   * 启动：加载全局配置 → 初始化视图 → 深链接
   * ============================================================ */
  App.viewInits = [];

  async function loadGlobalState() {
    try {
      const data = await App.api.invoke('config:get');
      App.state.cfg = data.config;
      App.state.wizardDone = !!data.wizardDone;
      if (data.config && data.config.content && data.config.content.aiDisclosure) {
        App.state.aiDisclosureText = data.config.content.aiDisclosure.text || App.state.aiDisclosureText;
      }
    } catch (e) {
      App.state.cfg = null;
      App.state.wizardDone = false;
      App.handleErr(e, '读取配置失败');
    }
    try {
      App.updateTrayPill(await App.api.invoke('schedule:get'));
    } catch (e) { /* 定时状态读取失败不阻塞启动，视图内会重试 */ }
    try {
      const { ip } = await App.api.invoke('net:public-ip');
      App.state.ip = ip;
    } catch (e) { /* IP 获取失败时由设置页按需重试 */ }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindShell();
    App.bindAllEyes();
    App.viewInits.forEach((init) => { try { init(); } catch (e) { console.error(e); } });
    await loadGlobalState();
    // 全局配置就绪后重渲染当前视图（hero 门控 / 托盘 pill 依赖 wizardDone 与 schedule）
    App.showView(App.currentView);
    // compose 视图的素材草稿依赖 App.state.cfg（视图 init 早于配置加载，必须此时再回填一次）
    if (App.composeView && App.composeView.restoreDraft) {
      try { App.composeView.restoreDraft(); } catch (e) { console.error(e); }
    }

    // 深链接（#dashboard/#compose/#chat/#radar/#history/#logs/#settings/#wizard）
    const h = location.hash.replace('#', '');
    if (VIEW_NAMES.includes(h)) App.showView(h);
    if (h === 'wizard' && App.wizard && App.wizard.open) App.wizard.open();

    // 首次使用：检测到无配置 → 自动进入向导（PRD F1）
    if (!App.demo && App.state.wizardDone === false && App.wizard && App.wizard.open) {
      App.wizard.open();
    }
  });
})();
