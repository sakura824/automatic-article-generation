/* ============================================================
 * history.js —— 历史记录：状态筛选 + 来源筛选（PRD v2 §2/§6）、表格、
 *               文章预览弹窗、重新上传
 * 数据源：history:list / history:preview / history:reupload / shell:open-path
 * 来源枚举（App.SOURCE）：material 素材 / chat 对话 / auto 自动 / aggregate 聚合；
 * v1 老记录与缺省 source 字段按 auto 展示（App.sourceOf 兜底）。
 * ============================================================ */
(function () {
  'use strict';

  const App = window.App;
  const { $, $$ } = App;

  const view = { items: [], filter: 'all', sourceFilter: 'all' };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function render() {
    const rows = view.items
      .filter((r) => view.filter === 'all' || r.status === view.filter)
      .filter((r) => view.sourceFilter === 'all' || (r.origin || '自动') === view.sourceFilter);
    $('#histBody').innerHTML = rows.map((r) => {
      const s = App.STATUS[r.status] || App.STATUS.generated;
      const src = App.sourceOf(r.origin);
      // 行内操作按 r.id || r.date 定位：v2 创作产物（素材/对话/聚合，带 id）与 v1 自动记录（按日期）都能唯一命中
      const key = r.id || r.date;
      // v1 失败记录没有自己的正文（按日期存的 article.json 属于当天另一次成功运行）：
      // 给预览/重传会串到别人的文章上，因此只保留「打开文章目录」。
      const v1Failed = !r.id && r.status === 'failed';
      // 已定稿状态（已发表/已删除/已打回）：草稿已不在草稿箱（或已被新稿替代），重传无意义
      const finalized = r.status === 'published' || r.status === 'removed' || r.status === 'replaced';
      // 打回重写：仅聚合成文支持（有原选题留档 sources.json）；已打回过的也可以再次打回
      const canRegen = r.origin === '聚合' && !!r.dir && !!r.id;
      const regenBtn = canRegen
        ? '<button class="icon-btn" title="打回重写：按原选题重新生成一篇并上传，替换这篇" data-regen="' + escapeHtml(key) + '"><i class="fa-solid fa-rotate-left"></i></button>'
        : '';
      const actions = r.status === 'skipped'
        ? '<span style="font-size:12px;color:var(--text-3);">无需操作</span>'
        : (v1Failed
          ? '<span style="font-size:12px;color:var(--text-3);margin-right:6px;">失败运行 · 无正文</span>' +
            '<button class="icon-btn" title="打开文章目录" data-dir="' + escapeHtml(key) + '"><i class="fa-regular fa-folder-open"></i></button>'
          : '<button class="icon-btn" title="预览" data-pv="' + escapeHtml(key) + '"><i class="fa-regular fa-eye"></i></button>' +
            (finalized
              ? ''
              : '<button class="icon-btn" title="重新上传" data-reup="' + escapeHtml(key) + '"><i class="fa-solid fa-paper-plane"></i></button>') +
            regenBtn +
            '<button class="icon-btn" title="打开文章目录" data-dir="' + escapeHtml(key) + '"><i class="fa-regular fa-folder-open"></i></button>');
      return '<tr>' +
        '<td class="date">' + escapeHtml(r.date) + '</td>' +
        '<td class="title">' + escapeHtml(r.title) + '</td>' +
        // 来源列用短标签（App.SOURCE[x].short：素材/对话/自动/聚合）：4 字全称在 92px 列里会折成两行
        '<td><span class="chip chip-nowrap ' + src.cls + '" title="' + escapeHtml(src.label) + '">' + escapeHtml(src.short) + '</span></td>' +
        '<td><span class="chip chip-nowrap ' + s.cls + '">' + s.label + '</span></td>' +
        '<td style="font-variant-numeric:tabular-nums;color:var(--text-2);">' + App.fmtWords(r.words) + '</td>' +
        '<td><div class="row-actions">' + actions + '</div></td>' +
        '</tr>';
    }).join('') || emptyRowHtml();

    $$('[data-empty-go]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.emptyGo === 'compose' && App.composeView && App.composeView.ensureMaterialMode) App.composeView.ensureMaterialMode();
      App.showView(b.dataset.emptyGo);
    }));
    $$('[data-pv]').forEach((b) => b.addEventListener('click', () => openPreview(b.dataset.pv)));
    $$('[data-reup]').forEach((b) => b.addEventListener('click', () => reupload(b.dataset.reup)));
    $$('[data-regen]').forEach((b) => b.addEventListener('click', () => regenerate(b.dataset.regen, b)));
    $$('[data-dir]').forEach((b) => b.addEventListener('click', () => openDir(b.dataset.dir)));
  }

  /** 空表引导：与素材成文/对话/雷达的空态一致，给出创建第一篇的入口（而不是只说「没有记录」） */
  function emptyRowHtml() {
    return '<tr><td colspan="6" style="text-align:center;padding:34px 24px;">' +
      '<div style="font-size:13px;color:var(--text-2);font-weight:600;margin-bottom:6px;">这里还没有文章</div>' +
      '<div style="font-size:12.5px;color:var(--text-3);margin-bottom:14px;">用四种方式之一出第一篇：贴素材、和 AI 对话、勾选热点，或配置仓库后自动生成。</div>' +
      '<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">' +
      '<button class="btn btn-primary btn-sm" data-empty-go="compose"><i class="fa-solid fa-feather-pointed"></i>去素材成文</button>' +
      '<button class="btn btn-ghost btn-sm" data-empty-go="chat"><i class="fa-solid fa-comments"></i>去对话共创</button>' +
      '<button class="btn btn-ghost btn-sm" data-empty-go="radar"><i class="fa-solid fa-satellite-dish"></i>去选题雷达</button>' +
      '</div></td></tr>';
  }

  async function refresh() {
    try {
      // 始终拉全量：主进程只支持单维过滤，若按当前筛选取子集，
      // 切换筛选 / 切页回来 / run:finished 刷新后都会用「上一次的子集」渲染，
      // 出现「明明有记录却显示为空」（两个维度的过滤统一在 render 里做）。
      const { items } = await App.api.invoke('history:list', { filter: 'all' });
      view.items = items || [];
    } catch (e) {
      view.items = [];
      App.handleErr(e, '历史记录读取失败');
    }
    render();
  }

  /* ---------------- 预览弹窗 ---------------- */
  let previewKey = null;      // v2 成文 id 或 v1 日期
  let previewDate = null;
  let previewStatus = null;

  /** 预览页脚：AI 标识关闭时上传的正文不会带这句，预览也必须为空（否则误判文章会带标识） */
  function applyPvFoot() {
    const c = (App.state.cfg && App.state.cfg.content) || {};
    const ai = c.aiDisclosure || {};
    const on = ai.enabled !== false;
    const text = App.state.aiDisclosureText || '本文由 AI 生成，经人工审阅修改';
    const el = $('#pvFoot');
    if (!el) return;
    el.textContent = on ? text : '';
    el.style.display = on ? '' : 'none';
  }

  /** 来源清单 / 相似度自检内部区（history:preview {id} 附带；仅预览可见，不随文发布） */
  function renderInternalDocs(rawSources, similarity) {
    const old = $('#pvInternal');
    if (old) old.remove();
    // 兼容 {…, sources:[…]} 的核查文档形态（主进程已解包为数组，这里再兜一层）
    const sources = Array.isArray(rawSources) ? rawSources
      : (rawSources && Array.isArray(rawSources.sources) ? rawSources.sources : []);
    if (!sources.length && !similarity) return;
    const esc = escapeHtml;
    let html = '<div id="pvInternal" style="margin-top:16px;border-top:1px dashed var(--line);padding-top:14px;">';
    if (similarity && (similarity.maxRatio != null || similarity.ratio != null)) {
      const pct = Math.round((Number(similarity.maxRatio != null ? similarity.maxRatio : similarity.ratio) || 0) * 100);
      const thr = Math.round((Number(similarity.threshold) || 0) * 100);
      const over = similarity.passed === false;
      html += '<div style="font-size:12.5px;margin-bottom:8px;"><b><i class="fa-solid fa-shield-heart" style="color:' + (over ? 'var(--red)' : 'var(--brand-deep)') + ';margin-right:6px;"></i>相似度自检</b>' +
        '<span class="chip ' + (over ? 'st-red' : 'st-green') + '" style="margin-left:8px;">' + pct + '% / 阈值 ' + thr + '%' + ((similarity.rewriteAttempts || 0) > 0 ? ' · 已重写' : '') + '</span></div>';
    }
    if (sources.length) {
      html += '<div style="font-size:12.5px;margin-bottom:4px;"><b><i class="fa-solid fa-list-check" style="color:var(--brand-deep);margin-right:6px;"></i>素材来源清单</b>' +
        '<span style="color:var(--text-3);font-size:11.5px;margin-left:8px;">仅供人工核查，不随文章发布</span></div>';
      html += sources.map((s, i) => {
        const lv = App.radarLevelOf(s.label || (s.source && s.source.label));
        const url = s.url || (s.source && s.source.url) || '';
        const title = s.title || (s.source && s.source.title) || s.name || '';
        return '<div class="source-row"><span class="' + lv.cls + '">' + lv.label + '</span>' +
          '<div style="flex:1;min-width:0;"><div style="font-weight:600;">' + esc(title) + '</div>' +
          (url ? '<div class="s-url">' + esc(url) + '</div>' : '') + '</div></div>';
      }).join('');
    }
    html += '</div>';
    $('#pvBody').insertAdjacentHTML('afterend', html);
  }

  async function openPreview(key) {
    const item = view.items.find((r) => (r.id || r.date) === key);
    if (item && !item.id && item.status === 'failed') {
      // v1 失败记录没有可预览的正文：按日期预览会显示当天另一次成功运行的文章（串号）
      App.toast('这条记录是失败的运行，没有可预览的正文；当天生成的文章请看「已生成」记录', 'err');
      return;
    }
    previewKey = key;
    previewDate = item ? item.date : key;
    previewStatus = item ? item.status : null;
    $('#pvTitle').textContent = item ? item.title : '';
    $('#pvAuthor').textContent = '…';
    $('#pvDate').textContent = previewDate;
    $('#pvWords').textContent = item ? App.fmtWords(item.words) + ' 字' : '—';
    $('#pvBody').innerHTML = '<p style="color:var(--text-3);">正在加载文章内容…</p>';
    renderInternalDocs(null, null);
    applyPvFoot();
    App.openOverlay('previewModal');

    const btn = $('#pvUpload');
    // 已发表/已删除/已打回的稿子草稿已不在（或已被替代），不再提供「上传」
    if (previewStatus === 'uploaded' || previewStatus === 'published' || previewStatus === 'removed' || previewStatus === 'replaced') {
      btn.disabled = true;
      btn.title = previewStatus === 'uploaded' ? '该文章已上传到草稿箱' : '该文章已定稿（已发表 / 已删除 / 已打回），无需再上传';
    } else {
      btn.disabled = false;
      btn.title = '';
    }

    try {
      // v2 成文（有 id）走 {id} 预览，附带来源清单与相似度报告；v1 老记录走 {date}
      const art = await App.api.invoke('history:preview', item && item.id ? { id: item.id } : { date: previewDate });
      $('#pvTitle').textContent = art.title || (item ? item.title : '');
      $('#pvAuthor').textContent = art.author || '—';
      $('#pvDate').textContent = art.date || previewDate;
      $('#pvWords').textContent = App.fmtWords(art.words) + ' 字';
      const coverBox = document.querySelector('.art-cover');
      if (coverBox) { coverBox.innerHTML = art.coverDataUri ? '<img src="' + escapeHtml(art.coverDataUri) + '" alt="本篇封面" style="width:100%;height:100%;object-fit:cover;">' : '<b>' + escapeHtml(art.title || '文章预览') + '</b>'; }
      $('#pvBody').innerHTML = art.html || '<p style="color:var(--text-3);">（无正文内容）</p>';
      applyPvFoot();
      renderInternalDocs(art.sources, art.similarity);
    } catch (e) {
      $('#pvBody').innerHTML = '<p style="color:var(--red);">加载失败：' + escapeHtml(e.message || '') + '</p>';
    }
  }

  /** 生成流程结束后（仅生成预览）从仪表盘唤起最新一篇的预览 */
  function previewLatest() {
    if (view.items.length) openPreview(view.items[0].id || view.items[0].date);
  }

  /* ---------------- 重新上传 / 打开目录（v2：按 id 分流到 compose:upload） ---------------- */
  const reupBusy = new Set();

  /** 按 key（id 或日期）定位历史条目 */
  function findItem(key) {
    return view.items.find((r) => (r.id || r.date) === key) || null;
  }

  async function reupload(key) {
    if (reupBusy.has(key)) return;
    reupBusy.add(key);
    const btn = $('[data-reup="' + key + '"]');
    if (btn) { btn.disabled = true; btn.title = '正在上传…'; }
    try {
      const item = findItem(key);
      if (item && item.id) {
        // v2 创作产物：按成文 id 直接上传（compose:upload，含相似度改写关卡校验）
        const r = await App.api.invoke('compose:upload', { id: item.id });
        App.toast('草稿已上传（' + (r.draftMediaId || '') + '），去公众号 App 里审阅发表吧');
        reupBusy.delete(key); // v2 上传不会触发 run:finished，必须在这里解锁，否则再次点击静默无响应
        refresh();
        return;
      }
      // v1 自动记录：history:reupload → {runId}，进度与结果由 run:progress/run:finished 驱动
      await App.api.invoke('history:reupload', { date: key });
      App.toast('已加入上传队列，稍后可在日志查看进度');
    } catch (e) {
      App.handleErr(e, '重新上传失败');
      reupBusy.delete(key);
      if (btn) { btn.disabled = false; btn.title = '重新上传'; }
    }
    // v1 成功分支：run:finished（cause=reupload）后统一 refresh，行会重建、reupBusy 同步清空
  }

  function openDir(key) {
    const item = findItem(key);
    if (!item || !item.dir) {
      App.toast('该记录没有关联的文章目录', 'err');
      return;
    }
    App.openPath(item.dir);
  }

  /* ---------------- 打回重写（v2.4，仅聚合成文） ----------------
   * 按原选题重新综合成文并自动上传新稿，旧稿从草稿箱删除、条目标记「已打回」。
   * 两段确认：第一次点击置 armed，3 秒内再点执行，避免误触（重写要花几分钟与 token）。 */
  let regenArmedKey = null;
  let regenArmedTimer = null;
  const regenBusy = new Set();

  async function regenerate(key, btn) {
    if (regenBusy.has(key)) return;
    const item = findItem(key);
    if (!item || !item.id) return;
    if (regenArmedKey !== key) {
      regenArmedKey = key;
      if (btn) { btn.style.color = 'var(--red)'; btn.title = '再点一次确认打回重写（将生成新稿并删除这篇旧草稿）'; }
      clearTimeout(regenArmedTimer);
      regenArmedTimer = setTimeout(() => {
        regenArmedKey = null;
        if (btn) { btn.style.color = ''; btn.title = '打回重写：按原选题重新生成一篇并上传，替换这篇'; }
      }, 3000);
      return;
    }
    regenArmedKey = null;
    clearTimeout(regenArmedTimer);
    regenBusy.add(key);
    const restore = App.setBusy(btn, App.BUSY_ICON + '重写中…');
    try {
      const r = await App.api.invoke('compose:regenerate', { id: item.id });
      if (r.uploaded) {
        App.toast('新稿已上传（' + App.fmtWords(r.words) + ' 字），旧稿' + (r.oldDeleted ? '已从草稿箱删除' : '请到公众号后台手动删除'));
      } else if (r.needsRewrite) {
        App.toast('新稿已生成但相似度仍偏高，未上传（可在编辑器里改写后再传）', 'err');
      } else {
        App.toast('新稿已生成');
      }
      refresh();
    } catch (e) {
      App.handleErr(e, '打回重写失败');
    } finally {
      regenBusy.delete(key);
      restore();
    }
  }

  /* ---------------- 同步公众号状态（v2.4） ---------------- */
  let syncBusy = false;
  async function syncStatus(btn) {
    if (syncBusy) return;
    syncBusy = true;
    const restore = App.setBusy(btn, App.BUSY_ICON + '正在同步…');
    try {
      const r = await App.api.invoke('history:sync', {});
      if (r.mock) {
        App.toast('演示模式不联网同步');
      } else if (r.changed > 0) {
        App.toast('同步完成：' + r.published + ' 篇已发表、' + r.removed + ' 篇已删除（草稿箱现有 ' + r.drafts + ' 篇）');
      } else {
        App.toast('状态已核对，与公众号实况一致（草稿箱现有 ' + r.drafts + ' 篇）');
      }
      refresh();
    } catch (e) {
      App.handleErr(e, '同步失败');
    } finally {
      syncBusy = false;
      restore();
    }
  }

  /* ---------------- 顶栏「打开文章目录」 ---------------- */
  function openOutputRoot() {
    const withDir = view.items.find((r) => r.dir);
    if (!withDir) {
      App.toast('还没有生成过文章，目录会在第一次生成后创建', 'err');
      return;
    }
    App.openPath(withDir.dir);
  }

  /* ---------------- 初始化 ---------------- */
  App.viewInits.push(function () {
    $$('#histFilter .fchip').forEach((c) => c.addEventListener('click', () => {
      $$('#histFilter .fchip').forEach((x) => x.classList.remove('on'));
      c.classList.add('on');
      view.filter = c.dataset.f;
      render();
    }));
    // 来源筛选（PRD v2 §6：统一收四种来源，加来源列与筛选）
    $$('#histSrcFilter .fchip').forEach((c) => c.addEventListener('click', () => {
      $$('#histSrcFilter .fchip').forEach((x) => x.classList.remove('on'));
      c.classList.add('on');
      view.sourceFilter = c.dataset.sf;
      render();
    }));
    $('#openOutDir').addEventListener('click', openOutputRoot);
    $('#syncStatusBtn').addEventListener('click', function () { syncStatus(this); });
    $('#pvEdit').addEventListener('click', async () => {
      if (!previewKey) return;
      const item = findItem(previewKey);
      if (!item || !item.id) {
        App.toast('v1 自动生成的文章没有可编辑的成文记录（按日期存放），请在文件里修改后重新上传', 'err');
        return;
      }
      try {
        const art = await App.api.invoke('history:preview', { id: item.id });
        const origin = art.origin || item.origin || '素材';
        const mode = origin === '聚合' ? 'radar' : (origin === '对话' ? 'chat' : 'material');
        App.composeView.loadComposed({
          article: { title: art.title, digest: art.digest, html: art.html },
          articleId: item.id,
          dir: item.dir,
          origin,
          sources: art.sources,
          similarity: art.similarity,
        }, mode === 'material' ? null : { mode, date: art.date });
        App.closeOverlay('previewModal');
      } catch (e) {
        App.handleErr(e, '打开编辑器失败');
      }
    });

    $('#pvUpload').addEventListener('click', () => {
      if (!previewKey) return;
      reupload(previewKey); // v2 按 id 走 compose:upload；v1 按日期走 history:reupload（reupload 内部分流）
      App.closeOverlay('previewModal');
    });

    App.api.on('run:finished', (res) => {
      // 成功/失败/重传都会写入历史（契约 §3 pipeline），统一刷新并解锁重传按钮
      reupBusy.clear();
      if (res) refresh();
    });

    App.viewRefresh.history = refresh;
    refresh();
  });

  App.historyView = { refresh, previewLatest };
})();
