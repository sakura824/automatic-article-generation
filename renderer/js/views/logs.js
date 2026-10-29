/* ============================================================
 * logs.js —— 运行日志：控制台、级别筛选、复制/清空/导出、log:append 实时追加
 * 数据源：logs:list / logs:clear / logs:export / log:append 事件
 * 说明：「模拟运行一次」（#simRun）是设计稿演示元素——真实模式下会伪造日志，
 *      违背「真实事件驱动」，因此仅在演示回退（App.demo）时显示。
 * ============================================================ */
(function () {
  'use strict';

  const App = window.App;
  const { $, $$ } = App;

  const view = { lines: [], filter: 'all' };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function filtered() {
    return view.lines.filter((l) => view.filter === 'all' || l.lv === view.filter);
  }

  function render() {
    const box = $('#logConsole');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const rows = filtered();
    box.innerHTML = rows.map((l) =>
      '<div class="log-line ' + (l.lv === 'ERROR' ? 'err' : l.lv === 'WARN' ? 'warn' : '') + '">' +
      '<span class="log-time">' + escapeHtml(l.t) + '</span>' +
      '<span class="lv lv-' + l.lv + '">' + l.lv + '</span>' +
      '<span class="log-msg">' + escapeHtml(l.m) + '</span>' +
      '</div>').join('') || '<div style="color:oklch(55% 0.01 255);text-align:center;padding:40px;">暂无日志</div>';
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  function append(line) {
    if (!line || !line.lv) return;
    view.lines.push({ t: line.t || '', lv: line.lv, m: line.m || '' });
    if (view.filter === 'all' || view.filter === line.lv) {
      const box = $('#logConsole');
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      const el = document.createElement('div');
      el.className = 'log-line ' + (line.lv === 'ERROR' ? 'err' : line.lv === 'WARN' ? 'warn' : '');
      el.innerHTML =
        '<span class="log-time">' + escapeHtml(line.t || '') + '</span>' +
        '<span class="lv lv-' + line.lv + '">' + line.lv + '</span>' +
        '<span class="log-msg">' + escapeHtml(line.m || '') + '</span>';
      const empty = box.querySelector('div[style]');
      if (empty) empty.remove();
      box.appendChild(el);
      if (nearBottom) box.scrollTop = box.scrollHeight;
    }
  }

  async function refresh() {
    try {
      const { items } = await App.api.invoke('logs:list', { limit: 500 });
      view.lines = items || [];
    } catch (e) {
      view.lines = [];
      App.handleErr(e, '日志读取失败');
    }
    render();
  }

  /* ---------------- 初始化 ---------------- */
  App.viewInits.push(function () {
    // 演示元素：仅浏览器直开（设计走查）时显示
    if (!App.demo) $('#simRun').style.display = 'none';

    $$('#logFilter .fchip').forEach((c) => c.addEventListener('click', () => {
      $$('#logFilter .fchip').forEach((x) => x.classList.remove('on'));
      c.classList.add('on');
      view.filter = c.dataset.lf;
      render();
    }));

    $('#copyLog').addEventListener('click', async () => {
      const rows = filtered();
      if (!rows.length) { App.toast('暂无可复制的日志', 'err'); return; }
      const text = rows.map((l) => '[' + l.t + '] ' + l.lv + ' ' + l.m).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        App.toast('日志已复制到剪贴板');
      } catch (e) {
        App.toast('复制失败：剪贴板不可用', 'err');
      }
    });

    $('#clearLog').addEventListener('click', async () => {
      try {
        await App.api.invoke('logs:clear');
        view.lines.length = 0;
        render();
        App.toast('日志已清空');
      } catch (e) {
        App.handleErr(e, '日志清空失败');
      }
    });

    $('#exportLog').addEventListener('click', async () => {
      try {
        const { path } = await App.api.invoke('logs:export');
        App.toast('已导出日志文件：' + path);
      } catch (e) {
        App.handleErr(e, '日志导出失败');
      }
    });

    App.api.on('log:append', append);
    App.viewRefresh.logs = refresh;
    refresh();
  });
})();
