/* ============================================================
 * pool.js —— 内容池（v2.2 增量：定时自动成文的题目队列）
 * 数据源（通道名与 payload 对齐 main/ipc.js）：
 *   pool:list  {}                                  → {items, stats}
 *   pool:add   {title, material?, emphasis?}        → {item, stats}
 *   pool:update{id, title?, material?, emphasis?}   → {item, stats}
 *   pool:delete{id}                                → {removed, stats}
 *   pool:run-now {}                                → {runId, item}（异步，结果走 run:finished）
 *   schedule:get {}                                → {enabled, time, mode:'auto'|'pool', poolPending}
 * 交互约定：
 * - 队列按加入顺序写（先加的先写），页面上「待写」按入队顺序展示，「已写/已跳过」按时间倒序；
 * - 「改」把条目载入左侧表单进入更新态，避免为改一个字弹一个面板；
 * - 立即写一条与定时共用 runManager，结果经 run:finished 回来（本页只处理自己发起的那次）。
 * ============================================================ */
(function () {
  'use strict';

  const App = window.App;
  const { $, $$ } = App;

  const view = {
    items: [],
    stats: { total: 0, pending: 0, used: 0, skipped: 0 },
    filter: 'pending',
    editingId: null,
    running: false,
    scheduleMode: 'auto',
    scheduleEnabled: false,
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function cpLen(s) {
    return Array.from(String(s == null ? '' : s)).length;
  }

  function chipOf(it) {
    if (it.status === 'used') return '<span class="chip st-green">已写</span>';
    if (it.status === 'skipped') return '<span class="chip st-gray">已跳过</span>';
    return '<span class="chip st-amber">待写</span>';
  }

  /** 排序：待写按入队顺序（先加的先写）；已写/已跳过按最近时间倒序（刚发生的最相关）。 */
  function sortForDisplay(list) {
    const pending = list.filter((it) => it.status === 'pending')
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const done = list.filter((it) => it.status !== 'pending')
      .sort((a, b) => String(b.usedAt || b.skippedAt || b.createdAt || '').localeCompare(String(a.usedAt || a.skippedAt || a.createdAt || '')));
    return pending.concat(done);
  }

  function rowHtml(it, index) {
    const meta = [];
    if (it.material) meta.push('素材 ' + cpLen(it.material) + ' 字');
    else meta.push('只给题目（AI 自行展开）');
    if (it.emphasis) meta.push('强调：' + escapeHtml(Array.from(it.emphasis).slice(0, 40).join('')));
    if (it.status === 'used' && it.usedAt) meta.push('写于 ' + String(it.usedAt).slice(0, 10));
    if (it.status === 'skipped' && it.skipReason) meta.push(escapeHtml(it.skipReason));
    if (it.status === 'pending' && it.lastError) meta.push('上次失败：' + escapeHtml(Array.from(String(it.lastError)).slice(0, 40).join('')));

    return (
      '<div class="pool-item" data-id="' + escapeHtml(it.id) + '">' +
      '  <div class="pi-main">' +
      '    <div class="pi-title">' + escapeHtml(it.title) + ' ' + chipOf(it) + '</div>' +
      '    <div class="pi-meta">' + meta.join(' · ') + '</div>' +
      '  </div>' +
      '  <div class="pi-actions">' +
      (it.status === 'pending' ? '<span class="pi-rank">#' + (index + 1) + '</span>' : '') +
      '    <button class="btn btn-ghost btn-sm" data-act="edit">改</button>' +
      '    <button class="btn btn-ghost btn-sm" data-act="del">删除</button>' +
      '  </div>' +
      '</div>'
    );
  }

  function render() {
    const list = view.filter === 'all'
      ? sortForDisplay(view.items)
      : sortForDisplay(view.items.filter((it) => it.status === view.filter));

    $('#poolList').innerHTML = list.map((it, i) => rowHtml(it, i)).join('');
    $('#poolEmpty').style.display = list.length ? 'none' : '';

    // 待写条目的序号只对「待写」视图有意义（跨状态混排时序号会跳）
    if (view.filter !== 'pending') $$('#poolList .pi-rank').forEach((el) => { el.style.display = 'none'; });

    const s = view.stats;
    $('#poolStatChip').textContent = '待写 ' + s.pending + ' · 已写 ' + s.used + (s.skipped ? ' · 跳过 ' + s.skipped : '');

    // 定时模式提示：只有内容池模式才会自动写，否则容易以为「加了题就会自动发」
    const banner = $('#poolModeBanner');
    banner.style.display = view.scheduleMode === 'pool' ? 'none' : '';
    if (view.scheduleMode === 'pool' && !view.scheduleEnabled) {
      banner.style.display = '';
      banner.className = 'banner banner-err';
      banner.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="margin-top:2px;"></i>' +
        '<span>定时任务类型是<b>内容池</b>，但<b>总开关没有打开</b>：到「仪表盘 → 每日定时任务」把开关打开，否则到点不会执行。</span>';
    } else if (view.scheduleMode !== 'pool') {
      banner.className = 'banner banner-info';
      banner.innerHTML = '<i class="fa-solid fa-circle-info" style="margin-top:2px;"></i>' +
        '<span>定时任务当前是<b>仓库自动</b>模式（读 git 提交写推文）。要让内容池每天自动写，到「仪表盘 → 每日定时任务」把类型切换成「内容池」。</span>';
    }

    $$('#poolList [data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.closest('.pool-item').dataset.id;
        if (btn.dataset.act === 'del') removeItem(id);
        else startEdit(id);
      });
    });
  }

  async function refresh() {
    try {
      const [list, sched] = await Promise.all([
        App.api.invoke('pool:list', {}),
        App.api.invoke('schedule:get').catch(() => null),
      ]);
      view.items = (list && list.items) || [];
      view.stats = (list && list.stats) || view.stats;
      if (sched) {
        view.scheduleMode = sched.mode || 'auto';
        view.scheduleEnabled = !!sched.enabled;
      }
      render();
    } catch (e) {
      App.handleErr(e, '读取内容池失败');
    }
  }

  function formValues() {
    return {
      title: $('#poolTitle').value.trim(),
      material: $('#poolMaterial').value,
      emphasis: $('#poolEmphasis').value.trim(),
    };
  }

  function clearForm() {
    view.editingId = null;
    $('#poolTitle').value = '';
    $('#poolMaterial').value = '';
    $('#poolEmphasis').value = '';
    $('#poolMatCount').textContent = '0 字';
    $('#poolAddBtn').innerHTML = '<i class="fa-solid fa-plus"></i>加入队列';
    $('#poolAddResult').textContent = '';
  }

  function startEdit(id) {
    const it = view.items.find((x) => x.id === id);
    if (!it) return;
    view.editingId = id;
    $('#poolTitle').value = it.title || '';
    $('#poolMaterial').value = it.material || '';
    $('#poolEmphasis').value = it.emphasis || '';
    $('#poolMatCount').textContent = cpLen(it.material) + ' 字';
    $('#poolAddBtn').innerHTML = '<i class="fa-regular fa-floppy-disk"></i>保存修改';
    $('#poolAddResult').textContent = '正在修改：' + it.title;
    try {
      $('#poolTitle').scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (e) { /* 忽略 */ }
    $('#poolTitle').focus();
  }

  async function submit() {
    const v = formValues();
    if (!v.title) {
      App.toast('题目不能为空', 'err');
      $('#poolTitle').focus();
      return;
    }
    const btn = $('#poolAddBtn');
    const restore = App.setBusy(btn, App.BUSY_ICON + '保存中…');
    try {
      const res = view.editingId
        ? await App.api.invoke('pool:update', { id: view.editingId, ...v })
        : await App.api.invoke('pool:add', v);
      view.stats = res.stats || view.stats;
      const wasEditing = !!view.editingId;
      clearForm();
      await refresh();
      App.toast(wasEditing ? '已保存修改' : '已加入队列，定时到点会自动写这条');
    } catch (e) {
      App.handleErr(e, '保存失败');
    } finally {
      restore();
    }
  }

  async function removeItem(id) {
    const it = view.items.find((x) => x.id === id);
    if (!it) return;
    // 删除不可撤销：已写条目删掉后历史里仍能看到文章（产物在 output/<date>/compose/），这里只删队列项
    if (!window.confirm('从队列里删除「' + it.title + '」？\n（已生成的文章不受影响，仍可在历史记录里找到）')) return;
    try {
      const res = await App.api.invoke('pool:delete', { id });
      if (view.editingId === id) clearForm();
      view.stats = (res && res.stats) || view.stats;
      await refresh();
      App.toast('已删除');
    } catch (e) {
      App.handleErr(e, '删除失败');
    }
  }

  async function runNow() {
    const btn = $('#poolRunNowBtn');
    const restore = App.setBusy(btn, App.BUSY_ICON + '正在写…');
    try {
      const res = await App.api.invoke('pool:run-now', {});
      view.running = true;
      App.toast('开始写《' + ((res.item && res.item.title) || '队列第一条') + '》，完成后会提示');
    } catch (e) {
      App.handleErr(e, '触发失败');
    } finally {
      restore();
    }
  }

  /* ---------------- 初始化 ---------------- */
  App.viewInits.push(function () {
    $('#poolAddBtn').addEventListener('click', submit);
    $('#poolRunNowBtn').addEventListener('click', runNow);

    $('#poolMaterial').addEventListener('input', () => {
      $('#poolMatCount').textContent = cpLen($('#poolMaterial').value) + ' 字';
    });

    $$('#poolFilter [data-pf]').forEach((b) => {
      b.addEventListener('click', () => {
        view.filter = b.dataset.pf;
        $$('#poolFilter [data-pf]').forEach((x) => x.classList.toggle('on', x === b));
        render();
      });
    });

    // 立即写一条的结果（与定时共用 run:finished；只处理本页发起的那次，避免与仪表盘重复提示）
    App.api.on('run:finished', (p) => {
      if (!view.running) return;
      view.running = false;
      if (!p) return;
      if (p.status === 'uploaded') {
        App.toast('《' + (p.title || '') + '》已进草稿箱，去公众号 App 审阅发表吧');
      } else if (p.status === 'failed') {
        App.handleErr({ message: (p.error && p.error.message) || '自动成文失败' }, '自动成文失败');
      }
      refresh();
      if (App.dashboardView) App.dashboardView.refresh();
      if (App.historyView) App.historyView.refresh();
    });

    App.viewRefresh.pool = refresh;
    refresh();
  });
})();
