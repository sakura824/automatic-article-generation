/* ============================================================
 * dashboard.js —— 仪表盘：hero、三阶段进度、统计卡、定时卡、一键自检弹窗
 * 数据源：history:list / schedule:get / config:get（window.api），
 *        run:progress / run:finished 事件驱动生成流程。
 * ============================================================ */
(function () {
  'use strict';

  const App = window.App;
  const { $, $$ } = App;

  const G_ICONS = [
    '<i class="fa-solid fa-code-branch"></i>',
    '<i class="fa-solid fa-pen-nib"></i>',
    '<i class="fa-solid fa-paper-plane"></i>',
  ];

  const view = {
    history: [],
    generating: false,
    schedule: null,
    loaded: false,
  };

  /* ---------------- 三阶段进度（设计稿 setStep/resetSteps） ---------------- */
  function setStep(i, state) {
    const el = $('.gstep[data-gs="' + i + '"]');
    if (!el) return;
    el.classList.remove('active', 'done', 'fail');
    if (state) el.classList.add(state);
    const gi = el.querySelector('.gi');
    if (state === 'active') gi.innerHTML = '<i class="fa-solid fa-spinner spin"></i>';
    else if (state === 'done') gi.innerHTML = '<i class="fa-solid fa-check"></i>';
    else if (state === 'fail') gi.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i>';
    else gi.innerHTML = G_ICONS[i];
  }
  function resetSteps() {
    [0, 1, 2].forEach((i) => setStep(i, null));
  }

  /* ---------------- hero 状态卡 ---------------- */
  function heroSet(icoClass, icon, title, sub, metaHtml) {
    $('#heroIco').className = 'status-ico ' + icoClass;
    $('#heroIco').innerHTML = icon;
    $('#heroTitle').textContent = title;
    $('#heroSub').textContent = sub;
    $('#heroMeta').innerHTML = metaHtml || '';
  }

  function renderHero() {
    const genBusy = view.generating;
    const canAuto = !App.autoConfigMissing();
    const wizardDone = !!App.state.wizardDone;
    // 主 CTA 语义（与 hero 提示指向同一动作）：未完成向导 = 打开配置向导；
    // 已配置代码仓库 = 仓库自动（立即生成并上传）；未配置 = 素材成文（v2 主路径）
    view.ctaMode = !wizardDone ? 'wizard' : (canAuto ? 'generate' : 'compose');
    const genBtn = $('#genBtn');
    if (genBtn) {
      genBtn.innerHTML = !wizardDone
        ? '<i class="fa-solid fa-wand-magic-sparkles"></i>打开配置向导'
        : (canAuto
          ? '<i class="fa-solid fa-bolt"></i>立即生成并上传'
          : '<i class="fa-solid fa-feather-pointed"></i>开始素材成文');
      genBtn.title = !wizardDone ? '先完成配置向导（公众号凭证 + 大模型 Key），才能出稿'
        : (canAuto ? '' : '还没配置代码仓库：主路径是「素材成文」；想用仓库自动请到「设置 → 内容与文风」选择仓库目录');
    }
    genBtn.disabled = genBusy;
    const genOnly = $('#genOnlyBtn');
    if (genOnly) {
      genOnly.disabled = genBusy || !wizardDone || !canAuto;
      genOnly.title = canAuto ? '' : '仅生成预览也属于仓库自动模式，需要先配置代码仓库路径';
    }

    // 禁用原因必须在页面上可见：未配仓库时「仅生成预览」不可用，给一行说明
    const note = $('#genOnlyNote');
    if (note) {
      const showNote = wizardDone && !canAuto;
      note.style.display = showNote ? '' : 'none';
      note.textContent = showNote ? '「仅生成预览」属于仓库自动模式：先到「设置 → 内容与文风」选择代码仓库，或用左侧「开始素材成文」。' : '';
    }

    if (genBusy) return; // 进度行展示中，hero 保持原样

    if (!App.state.wizardDone) {
      heroSet('idle', '<i class="fa-solid fa-wand-magic-sparkles"></i>',
        '先完成配置向导',
        '接通公众号与大模型后，这里会显示今天的生成状态',
        '');
      return;
    }

    const today = App.todayKey();
    // 同日可能并存多条记录（v2 创作产物带 id，v1 仓库自动记录无 id）：hero 讲的是
    // 「仓库自动今日运行」状态，必须优先取无 id 的自动记录，否则会被当天早些时候
    // 素材/对话/聚合的「已上传」盖住，掩盖定时任务失败。
    const todayRows = view.history.filter((r) => r.date === today); // 已按「新日期 + 同日创建时间」倒序
    const rec = todayRows.find((r) => !r.id) || todayRows[0]; // 有仓库自动记录优先，否则取当天最新一篇
    if (!rec) {
      heroSet('wait', '<i class="fa-solid fa-circle-info"></i>',
        '今天还没有成文',
        App.autoConfigMissing()
          ? '点右侧「开始素材成文」贴一段素材就能出稿；也可以去「对话共创」「选题雷达」，或到设置里配置代码仓库后启用仓库自动'
          : '点击右侧「立即生成并上传」马上试一次，或等待每日定时任务',
        '');
      return;
    }
    switch (rec.status) {
      case 'uploaded':
        heroSet('', '<i class="fa-solid fa-check"></i>',
          '今天的推文已上传到草稿箱',
          '《' + rec.title + '》· 等你在公众号 App 里审阅发表',
          metaHtml(rec));
        break;
      case 'generated':
        heroSet('wait', '<i class="fa-regular fa-eye"></i>',
          '文章已生成，等待上传',
          '《' + rec.title + '》· 可在历史记录中预览或重新上传',
          metaHtml(rec));
        break;
      case 'skipped':
        heroSet('idle', '<i class="fa-solid fa-mug-hot"></i>',
          '今天没有新的代码提交',
          '仓库今天没有新提交，明天定时任务会继续检查',
          '');
        break;
      case 'failed':
        // state.history[].error 是 {code,message} 对象（pipeline 失败路径写入）——直接拼会显示 [object Object]
        heroSet('err', '<i class="fa-solid fa-circle-exclamation"></i>',
          '今天的任务失败了',
          (rec.error && (rec.error.message || rec.error.hint)) || (typeof rec.error === 'string' ? rec.error : '') ||
            '上传过程出错，点击「立即生成并上传」重试，或到运行日志查看详情',
          '');
        break;
      default:
        heroSet('wait', '<i class="fa-solid fa-circle-info"></i>', '今天还没有运行记录', '', '');
    }
  }

  function metaHtml(rec) {
    const parts = [];
    const isAuto = !rec.id || rec.origin === '自动';
    // 定时文案只属于仓库自动记录：给素材/对话/聚合文章标「09:30 自动执行」会误导
    if (isAuto && App.state.schedule && App.state.schedule.enabled) {
      parts.push('<span><i class="fa-regular fa-clock"></i> ' + App.state.schedule.time + ' 自动执行</span>');
    }
    if (rec.words) parts.push('<span><i class="fa-solid fa-feather"></i> ' + App.fmtWords(rec.words) + ' 字</span>');
    return parts.join('');
  }

  /* ---------------- 统计卡（全部由 history 真实推导，不造数） ---------------- */
  function renderStats() {
    const items = view.history;
    // 「连续自动运行」只算仓库自动的记录（素材/对话/聚合是手动创作，不该计入自动运行天数）
    const autoItems = items.filter((r) => !r.id);
    const byDate = new Map(autoItems.map((r) => [r.date, r]));
    const ranStatus = (s) => s !== 'skipped'; // 有产出（含失败）才算运行过

    let streak = 0;
    const cursor = new Date();
    if (!byDate.has(App.todayKey())) cursor.setDate(cursor.getDate() - 1);
    while (byDate.has(key(cursor)) && ranStatus(byDate.get(key(cursor)).status)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    $('#statStreak').textContent = String(streak);

    // 本月生成 + 本周趋势
    const now = new Date();
    const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const monthCount = items.filter((r) => r.date.startsWith(ym) && (r.status === 'uploaded' || r.status === 'generated')).length;
    $('#statMonth').textContent = String(monthCount);

    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const mondayKey = key(monday);
    const weekCount = items.filter((r) => r.date >= mondayKey && r.date <= App.todayKey() && (r.status === 'uploaded' || r.status === 'generated')).length;
    $('#statTrend').textContent = weekCount > 0 ? '+' + weekCount + ' 本周' : '';
    $('#statTrend').style.display = weekCount > 0 ? '' : 'none';

    // 上传成功率：uploaded / (uploaded + failed)；无分母时连「%」一起隐藏（否则显示「—%」）
    const up = items.filter((r) => r.status === 'uploaded').length;
    const fl = items.filter((r) => r.status === 'failed').length;
    const hasRate = up + fl > 0;
    $('#statRate').textContent = hasRate ? String(Math.round((up / (up + fl)) * 100)) : '—';
    const rateUnit = $('#statRateUnit');
    if (rateUnit) rateUnit.style.display = hasRate ? '' : 'none';
  }

  function key(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ---------------- 最近文章（最近 3 条） ---------------- */
  function renderRecent() {
    const box = $('#recentList');
    // history 已按「新日期优先、同日 createdAt 倒序」返回：取前 3 即最新三篇
    const rows = view.history.slice(0, 3);
    if (!rows.length) {
      box.innerHTML = '<div style="font-size:12.5px;color:var(--text-3);padding:14px 0;">还没有文章记录，完成配置向导并生成第一篇后展示。</div>';
      return;
    }
    box.innerHTML = rows.map((r) => {
      const s = App.STATUS[r.status] || App.STATUS.generated;
      return '<div class="mini-item"><span class="d">' + App.md(r.date) + '</span><span class="t">' +
        escapeHtml(r.title) + '</span><span class="chip ' + s.cls + '">' + s.short + '</span></div>';
    }).join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ---------------- 视图副标题（真实数据，不虚构同步时间） ---------------- */
  function renderSub() {
    const now = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    let sub = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 星期' + week;
    const latest = view.history[0];
    if (latest) {
      sub += ' · 上次运行 ' + (latest.date === App.todayKey() ? '今天' : App.md(latest.date));
    }
    $('#dashSub').textContent = sub;
  }

  /* ---------------- 定时卡 ---------------- */
  function renderSchedule(schedule) {
    view.schedule = schedule || view.schedule;
    App.updateTrayPill(view.schedule);
    App.renderNextRunChip(view.schedule);
    if (view.schedule) {
      App.setSwitch($('#schedSwitch'), view.schedule.enabled);
      if (document.activeElement !== $('#schedTime')) $('#schedTime').value = view.schedule.time;
    }
    // v2.2 起：定时任务类型（auto=仓库自动 / pool=内容池 / radar=选题雷达自动），文案随类型变化——
    // 否则用户切换后仍看到「收集提交」，会以为没生效。
    const mode = (view.schedule && view.schedule.mode) || 'auto';
    const isPool = mode === 'pool';
    const isRadar = mode === 'radar';
    $$('#schedModeRow [data-sm]').forEach((b) => b.classList.toggle('on', b.dataset.sm === mode));
    const desc = $('#schedDesc');
    if (desc) {
      desc.textContent = isPool
        ? '开启后每天从「内容池」取最早的一条题目，自动成文并上传草稿箱。'
        : isRadar
          ? '开启后每天按「聚合来源配置」的关键词搜索全网，自动选排名最前的选题成文并上传草稿箱。'
          : '开启后每天在这个时间自动收集提交、生成文章并上传草稿箱。';
    }
    // 自动模式（仓库定时）开启 → 显示定时任务卡；关闭/未知 → 隐藏，模式入口仍保留
    const schedCard = $('#schedCard');
    const cardOn = !!(view.schedule && view.schedule.enabled);
    if (schedCard) schedCard.style.display = cardOn ? '' : 'none';
    // 定时卡隐藏后 .two-grid 只剩「最近文章」，不收回单列会在右侧留半屏空白
    const grid = schedCard ? schedCard.closest('.two-grid') : null;
    if (grid) grid.classList.toggle('two-grid--single', !cardOn);
    const schedNote = $('#schedNote');
    if (schedNote) {
      let note;
      if (isPool) {
        const n = view.schedule ? view.schedule.poolPending : null;
        if (n === 0) {
          note = '内容池里还没有待写条目：到「内容池」页添加题目，定时到点才有内容可写。';
        } else if (n == null) {
          note = '读取内容池失败（content-pool.json 可能损坏）：到「内容池」页查看。';
        } else {
          note = '内容池还有 <b>' + n + '</b> 条待写，每天写一条；写完后到「内容池」继续补题。';
        }
      } else if (isRadar) {
        note = '按「设置 → 聚合来源配置」的关键词与来源白名单搜索全网，自动选排名最前的选题成文。'
          + '缺关键词或搜索 Key 时会跳过并在日志里说明；敏感话题会自动跳过。';
      } else {
        note = App.autoConfigMissing()
          ? '还没配置代码仓库：定时到点会跳过、不会出稿。请到「设置 → 内容与文风」选择仓库目录。'
          : '到点时电脑需要开机。若当天没开机，下次启动应用会自动补跑当天任务。';
      }
      schedNote.innerHTML = '<i class="fa-solid fa-circle-info" style="margin-top:2px;"></i><span>' + note + '</span>';
    }
    const hint = $('#autoModeHint');
    if (hint) {
      const modeLabel = isPool ? '内容池' : isRadar ? '选题雷达' : '仓库';
      hint.innerHTML = cardOn
        ? '定时 ' + (view.schedule.time || '09:30') + ' · ' + modeLabel + ' <i class="fa-solid fa-arrow-right"></i>'
        : '默认关闭 · 到设置里开启<i class="fa-solid fa-arrow-right"></i>';
    }
  }

  async function saveSchedule(patch) {
    try {
      const s = await App.api.invoke('schedule:set', patch);
      renderSchedule(s);
      return s;
    } catch (e) {
      App.handleErr(e);
      renderSchedule(view.schedule); // 失败回滚 UI
      return null;
    }
  }

  /* ---------------- 生成流程（事件驱动） ----------------
   * v2.4：主按钮按定时任务类型分流——
   *   仓库自动 → run:generate（git 管线）；
   *   内容池   → pool:run-now（取队列最早一条）；
   *   选题雷达 → radar:auto-run（按聚合配置搜索 → 自动选排名最前的选题 → 成文并上传）。
   * 否则用户把定时切到雷达后，点主按钮仍会跑 git 管线，产出一篇代码提交摘要的稿子。 */
  async function runGenerate(upload) {
    if (view.generating) return;
    if (!App.state.wizardDone && App.wizard) { App.wizard.open(); return; }
    const mode = (view.schedule && view.schedule.mode) || 'auto';
    if (mode === 'radar' || mode === 'pool') {
      if (!upload) {
        // 这两种模式没有"仅预览"入口（成文即落盘），引导到对应页面操作
        App.toast(mode === 'radar' ? '选题雷达的预览与勾选成文请到「选题雷达」页操作' : '内容池的预览请到「内容池」页操作');
        App.showView(mode === 'radar' ? 'radar' : 'pool');
        return;
      }
      view.generating = true;
      $('#genBtn').disabled = true;
      $('#genOnlyBtn').disabled = true;
      $('#genProgress').classList.add('on');
      resetSteps();
      try {
        await App.api.invoke(mode === 'radar' ? 'radar:auto-run' : 'pool:run-now', {});
      } catch (e) {
        view.generating = false;
        $('#genProgress').classList.remove('on');
        $('#genBtn').disabled = false;
        $('#genOnlyBtn').disabled = false;
        App.handleErr(e, '生成任务启动失败');
      }
      return;
    }
    if (!upload) {
      // 仓库自动且没有可用仓库时，引导先配置（与开关开启同一判据）
      if (App.autoConfigMissing()) {
        App.toast('仓库自动需要先配置代码仓库路径：已打开「设置 → 内容与文风」', 'err');
        App.showSettingsTab('content');
        return;
      }
    }
    view.generating = true;
    $('#genBtn').disabled = true;
    $('#genOnlyBtn').disabled = true;
    $('#genProgress').classList.add('on');
    resetSteps();
    try {
      await App.api.invoke('run:generate', { upload });
    } catch (e) {
      view.generating = false;
      $('#genProgress').classList.remove('on');
      $('#genBtn').disabled = false;
      $('#genOnlyBtn').disabled = false;
      App.handleErr(e, '生成任务启动失败');
    }
  }

  function onRunProgress(p) {
    if (!p) return;
    setStep(p.stage, p.state);
  }

  function onRunFinished(res) {
    if (!res) return;
    view.generating = false;
    $('#genProgress').classList.remove('on');
    $('#genBtn').disabled = false;
    $('#genOnlyBtn').disabled = false;

    const upload = res.status === 'uploaded';
    if (res.ok) {
      view.lastFail = false;
      resetSteps();
      $('#genProgress').classList.remove('on');
      if (res.status === 'skipped') {
        // 无新提交被跳过时 hero 已说明「今天没有新的代码提交」，不能再提示「预览已生成」
        App.toast('今天没有新的代码提交，已跳过本次生成');
      } else if (upload) App.toast('草稿已上传，去公众号 App 里审阅发表吧');
      else App.toast('预览已生成，可在历史记录中查看');
    } else {
      view.lastFail = true;
      const err = res.error || {};
      // 失败：保留失败阶段标记（run:progress 已置 fail）， 要求 Toast 提供「查看日志」跳转
      App.toast(err.message || '生成失败', 'err', { label: '查看日志', onClick: () => App.showView('logs') });
    }
    refresh();
  }

  /* ---------------- 一键自检弹窗 ---------------- */
  let checking = false;
  async function openCheckModal() {
    App.resetChecks($('#modalChecks'));
    $('#modalCheckFail').style.display = 'none';
    App.openOverlay('checkModal');
    await runSelfCheck();
  }

  async function runSelfCheck() {
    if (checking) return;
    if (!App.state.wizardDone) { App.toast('先完成配置向导，再运行一键自检', 'err'); return; }
    checking = true;
    const restore = App.setBusy($('#selfcheckBtn'), App.BUSY_ICON + '正在自检…');
    try {
      const { items } = await App.api.invoke('selfcheck:run');
      const bad = (items || []).filter((it) => it.state === 'fail');
      if (bad.length) {
        const b = bad[0];
        $('#modalCheckFailMsg').textContent = (b.detail || '自检未通过') + (b.errcode ? '（errcode=' + b.errcode + '）' : '');
        $('#modalCheckFail').style.display = 'flex';
      }
    } catch (e) {
      $('#modalCheckFailMsg').textContent = App.friendlyMessage(e, '自检执行失败，请查看运行日志');
      $('#modalCheckFail').style.display = 'flex';
    } finally {
      checking = false;
      restore();
    }
  }

  /* ---------------- 刷新与初始化 ---------------- */
  async function refresh() {
    try {
      const { items } = await App.api.invoke('history:list', { filter: 'all' });
      view.history = items || [];
    } catch (e) {
      App.handleErr(e, '历史记录读取失败');
      view.history = [];
    }
    try { renderSchedule(await App.api.invoke('schedule:get')); } catch (e) { App.handleErr(e, '定时任务状态读取失败'); }
    if (!view.generating && !view.lastFail) $('#genProgress').classList.remove('on');
    renderSub();
    renderHero();
    renderStats();
    renderRecent();
    view.loaded = true;
  }

  App.viewInits.push(function () {
    $('#genBtn').addEventListener('click', () => {
      if (view.ctaMode === 'wizard') { if (App.wizard) App.wizard.open(); return; }
      if (view.ctaMode === 'compose') { App.showView('compose'); return; }
      runGenerate(true);
    });
    $('#genOnlyBtn').addEventListener('click', () => runGenerate(false));
    $('#selfcheckBtn').addEventListener('click', openCheckModal);
    $('#openDraftbox').addEventListener('click', () => App.openExternal('https://mp.weixin.qq.com/'));

    // 仓库自动模式入口卡（role=button，支持键盘触发）：
    // 与另外三张模式卡一致——进入该模式的配置位置，而不是直接发起一次「生成并上传」。
    // 误点即上传（无二次确认）会污染历史与草稿箱，立即生成的入口保留在定时卡/头部的显式按钮。
    const autoCard = $('#autoModeCard');
    if (autoCard) {
      const openAutoSettings = () => App.showSettingsTab('app');
      autoCard.addEventListener('click', openAutoSettings);
      autoCard.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAutoSettings(); }
      });
    }

    // v2.2 / v2.4：定时任务类型切换（仓库自动 / 内容池 / 选题雷达）
    $$('#schedModeRow [data-sm]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const next = btn.dataset.sm;
        const cur = (view.schedule && view.schedule.mode) || 'auto';
        if (next === cur) return;
        const s = await saveSchedule({ mode: next });
        if (!s) return;
        if (next === 'pool') {
          App.toast('已切换为「内容池」：每天从队列取最早一条题目自动成文');
        } else if (next === 'radar') {
          App.toast('已切换为「选题雷达」：每天搜索全网，自动选排名最前的选题成文并上传草稿箱');
        } else {
          App.toast('已切换为「仓库自动」：每天读代码提交写推文');
          if (App.autoConfigMissing()) {
            App.toast('仓库自动还需要代码仓库路径：到「设置 → 内容与文风」选择', 'err');
          }
        }
      });
    });

    App.bindSwitch($('#schedSwitch'), (on) => {
      // 只有仓库自动模式才强制要求仓库路径；内容池模式不需要
      const mode = (view.schedule && view.schedule.mode) || 'auto';
      if (on && mode === 'auto' && App.autoConfigMissing()) {
        App.setSwitch($('#schedSwitch'), false); // 回滚
        App.toast('仓库自动需要先配置代码仓库路径：已打开「设置 → 内容与文风」', 'err');
        App.showSettingsTab('content');
        return;
      }
      saveSchedule({ enabled: on });
    });
    $('#schedTime').addEventListener('change', () => {
      const v = $('#schedTime').value.trim();
      if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(v)) {
        App.toast('时间格式应为 24 小时制 HH:MM，例如 09:30', 'err');
        $('#schedTime').value = view.schedule ? view.schedule.time : '09:30';
        return;
      }
      const norm = v.split(':').map((x) => x.padStart(2, '0')).join(':');
      saveSchedule({ time: norm });
    });

    App.api.on('run:progress', onRunProgress);
    App.api.on('run:finished', onRunFinished);

    App.viewRefresh.dashboard = refresh;
    refresh();
  });

  /* 供其他视图复用（例如历史页重传后刷新仪表盘 hero） */
  App.dashboardView = { refresh, runSelfCheck };
})();
