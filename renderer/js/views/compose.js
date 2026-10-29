/* ============================================================
 * compose.js —— 创作（素材成文，PRD v2 §2 模式 A / §6）
 * 数据源（通道名与 payload 对齐 main/ipc.js v2 落地契约）：
 *   compose:generate {mode:'material', material, emphasis} → {articleId, dir, article, words, origin, date}
 *   compose:save     {id, title?, digest?, html?}          → {article, words}（编辑后保存）
 *   compose:upload   {id}                                   → {draftMediaId, words, title}（按成文 id 上传）
 *   config:set {content:{material, emphasis}}               → 素材本地草稿（可复用）
 * 事件：task:progress {kind:'compose', stage, state, detail}。
 * 对话共创「整理成文章」走 compose:generate {mode:'chat', sessionId}（chat.js 发起），
 * 经 loadComposed 进入本页编辑；选题雷达「综合成文」同经 loadComposed（origin=聚合）。
 * ============================================================ */
(function () {
  'use strict';

  const App = window.App;
  const { $, $$ } = App;

  const view = {
    articleId: null,    // compose:generate 落盘后的成文 id（compose:save / compose:upload 依赖）
    dir: null,          // 产物目录（来源清单所在）
    origin: '素材',     // 历史来源（core state.ORIGIN_VALUES：素材/对话/自动/聚合）
    sourceMode: 'material', // 当前成文的来源模式：material | chat | radar（决定「重新生成」怎么跑）
    sourceMeta: null,   // chat: {sessionId}；radar: {ids, date}
    sources: [],        // 素材来源清单（内部核查，不随文发布；仅聚合模式返回）
    similarity: null,   // core checkSimilarity 形状 {passed, maxRatio, threshold, needsRewrite, reports}
    generating: false,
    uploading: false,
    saving: false,
  };

  const SOURCE_MODE_LABEL = {
    material: { label: '素材成文', chip: '素材成文', title: '素材成文', sub: '粘贴素材，说一句今天想强调的点，AI 按你的文风画像成文，你审阅后发表。' },
    chat: { label: '对话共创', chip: '来源：对话共创', title: '对话共创 · 编辑成文', sub: '这篇是把对话整理成的文章，改好后上传草稿箱；要继续讨论请回到「对话共创」。' },
    radar: { label: '选题雷达', chip: '来源：选题雷达（全网聚合）', title: '选题雷达 · 编辑成文', sub: '这篇是勾选热点综合成文，引用出处见下方「素材来源清单」（仅内部可见，不随文发布）。' },
  };

  /** 回到「素材成文」新建态：把非素材来源的编辑器复位，恢复左侧素材区与标题。
   *  否则从对话/雷达进过编辑器后，侧栏与仪表盘的「素材成文」都进不去新建素材稿（只能刷新）。 */
  function resetToMaterial() {
    view.sourceMode = 'material';
    view.sourceMeta = null;
    view.origin = '素材';
    view.sources = [];
    view.similarity = null;
    showEditor(false);
    $('#draftPreview').innerHTML = '';
    $('#draftBody').value = '';
    $('#draftTitle').value = '';
    $('#draftDigest').value = '';
    $('#draftWords').textContent = '—';
    applySourceChrome();
    renderSources([]);
    renderSimilarity(null);
  }

  /** 侧栏/仪表盘点「素材成文」时调用：当前是对话/雷达成文则先复位（旧稿仍在历史记录里） */
  function ensureMaterialMode() {
    if (view.sourceMode === 'material') return;
    resetToMaterial();
    App.toast('已切回素材成文（上一篇仍保留在历史记录里，可在历史页打开）');
  }

  /** 按来源模式切换页面外观：素材区显隐、标题、来源标签、重新生成按钮语义 */
  function applySourceChrome() {
    const mode = SOURCE_MODE_LABEL[view.sourceMode] || SOURCE_MODE_LABEL.material;
    const isMaterial = view.sourceMode === 'material';
    const card = $('#composeMaterialCard');
    if (card) card.style.display = isMaterial ? '' : 'none';
    const grid = $('.compose-grid');
    if (grid) grid.classList.toggle('compose-grid--single', !isMaterial);
    const chip = $('#composeSourceChip');
    if (chip) {
      chip.style.display = isMaterial ? 'none' : '';
      chip.textContent = mode.chip;
      // 与历史页同一来源同一颜色（App.SOURCE：素材 st-blue / 对话 st-green / 自动 st-gray / 聚合 st-amber）
      const src = App.sourceOf(view.origin);
      chip.className = 'chip chip-nowrap ' + src.cls;
    }
    const newBtn = $('#composeNewBtn');
    if (newBtn) newBtn.style.display = isMaterial ? 'none' : '';
    const title = $('#composeTitle');
    if (title) title.textContent = mode.title;
    const sub = $('#composeSub');
    if (sub) sub.textContent = mode.sub;
    const regen = $('#draftRegenBtn');
    if (regen) {
      regen.innerHTML = isMaterial
        ? '<i class="fa-solid fa-rotate-right"></i>重新生成'
        : '<i class="fa-solid fa-rotate-right"></i>按' + mode.label + '重新生成';
      regen.title = isMaterial ? '' : '会用原始来源（对话/选题）再生成一篇新文章，当前这篇仍保留在历史记录里';
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** 展示用字数口径：与 core/article.countWords 对齐（去标签后 CJK 字符 + 英文单词） */
  function countWords(html) {
    const text = String(html || '').replace(/<[^>]*>/g, ' ');
    const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const en = (text.match(/[A-Za-z][A-Za-z0-9'-]*/g) || []).length;
    return cjk + en;
  }

  /* ---------------- 编辑区显隐 ---------------- */
  function showEditor(on) {
    $('#editorEmpty').style.display = on ? 'none' : '';
    $('#editorPanel').style.display = on ? '' : 'none';
  }

  function setEditorMode(mode) {
    const editing = mode === 'edit';
    $$('.editor-tabs .fchip').forEach((c) => c.classList.toggle('on', c.dataset.em === mode));
    $('#draftBody').style.display = editing ? '' : 'none';
    $('#draftPreview').style.display = editing ? 'none' : '';
    if (!editing) $('#draftPreview').innerHTML = $('#draftBody').value.trim() || '<p style="color:var(--text-3);">（正文为空）</p>';
  }

  function updateWords() {
    const n = countWords($('#draftBody').value);
    $('#draftWords').textContent = n > 0 ? '约 ' + App.fmtNum(n) + ' 字（展示口径，与上传后统计可能略有差异）' : '—';
  }

  function updateMatCount() {
    const n = $('#matInput').value.trim().length;
    // core chat.js clipMsg：进入提示词的素材截到 2000 字（超出部分截断加注），主进程 IPC 放行到 50000 字
    $('#matCount').textContent = n > 2000
      ? n + ' 字 · 仅前 2000 字进入 AI 提示词，超出部分会被截断'
      : n + ' 字';
  }

  /** 来源条目归一化：core aggregate sourceList.sources（{index,tier,label,name,title,url,excerpt,fetchState}） */
  function normalizeSource(s, i) {
    const src = s && typeof s.source === 'object' && s.source !== null ? s.source : {};
    return {
      index: s && s.index != null ? s.index : i + 1,
      label: (s && (s.label || src.label)) || 'L3',
      name: (s && (s.name || src.name)) || '',
      title: (s && (s.title || src.title)) || '',
      url: (s && (s.url || src.url)) || '',
      excerpt: (s && (s.excerpt || s.note)) || '',
      fetchState: (s && s.fetchState) || null,
    };
  }

  /* ---------------- 成文结果卡（相似度自检 / 来源清单） ---------------- */
  function renderSimilarity(sim) {
    const box = $('#draftSimCard');
    if (!sim || (sim.maxRatio == null && sim.ratio == null)) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const pct = Math.round((Number(sim.maxRatio != null ? sim.maxRatio : sim.ratio) || 0) * 100);
    const thr = Math.round((Number(sim.threshold) || 0) * 100);
    const over = sim.passed === false;
    // needsRewrite=true = 自动重写后仍超阈值：上传仍会被人工改写关卡拦截，
    // 不能显示成「已自动重写」这种处理完的状态（用户会直接点上传然后被挡）。
    const needsHuman = sim.needsRewrite === true;
    const rewrittenAndPassed = !needsHuman && !over && (sim.rewriteAttempts || 0) > 0;
    const badge = needsHuman
      ? '<span class="chip st-red">已重写仍超阈值 · 需人工改写</span>'
      : (over ? '<span class="chip st-red">未通过</span>'
        : (rewrittenAndPassed ? '<span class="chip st-green">已自动重写并通过</span>' : '<span class="chip st-green">通过</span>'));
    box.style.display = '';
    box.innerHTML =
      '<div class="sources-card" style="margin-top:0;">' +
      '  <div class="sc-head"><i class="fa-solid fa-shield-heart" style="color:' + (over ? 'var(--red)' : 'var(--brand-deep)') + ';"></i>相似度自检（与来源片段 n-gram 重叠）' + badge + '</div>' +
      '  <div class="sim-row">' +
      '    <div class="sim-bar' + (over ? ' over' : '') + '"><span style="width:' + Math.min(pct, 100) + '%;"></span></div>' +
      '    <span class="sim-num">' + pct + '% / 阈值 ' + thr + '%</span>' +
      '  </div>' +
      (needsHuman ? '  <div class="sc-note" style="margin:8px 0 0;color:var(--red);">自动重写 ' + (sim.rewriteAttempts || 0) + ' 次后仍超过阈值：请手动改写与来源雷同的段落并保存，保存后即可上传（上传前会再次校验）。</div>' : '') +
      (Array.isArray(sim.reports) && sim.reports.some((r) => r.runs && r.runs.length) ?
        '  <div class="sc-note" style="margin:8px 0 0;">雷同片段：' +
        sim.reports.flatMap((r) => (r.runs || []).map((run) => '「' + escapeHtml(String(run.text || '').slice(0, 40)) + '…」')).slice(0, 3).join('、') +
        '</div>' : '') +
      '</div>';
  }

  function renderSources(list) {
    const box = $('#draftSourcesCard');
    if (!list || !list.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = '';
    box.innerHTML =
      '<div class="sources-card">' +
      '  <div class="sc-head"><i class="fa-solid fa-list-check" style="color:var(--brand-deep);"></i>素材来源清单</div>' +
      '  <div class="sc-note">供人工核查引用出处，<b>不随文章发布</b>；引用规范：提到具体研究 / 指南时署名来源反而加分。</div>' +
      list.map((raw, i) => {
        const s = normalizeSource(raw, i);
        const lv = App.radarLevelOf(s.label);
        return '<div class="source-row"><span class="' + lv.cls + '">' + lv.label + '</span>' +
          '<div style="flex:1;min-width:0;"><div style="font-weight:600;">' + escapeHtml(s.title || s.name || '') + '</div>' +
          (s.url ? '<a class="s-url" href="#" data-src-url="' + escapeHtml(s.url) + '">' + escapeHtml(s.url) + '</a>' : '') +
          (s.excerpt ? '<div style="color:var(--text-3);font-size:11.5px;margin-top:2px;">' + escapeHtml(s.excerpt) + '</div>' : '') +
          '</div></div>';
      }).join('') +
      '</div>';
    $$('#draftSourcesCard [data-src-url]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      App.openExternal(a.dataset.srcUrl);
    }));
  }

  function loadDraft(draft, opts) {
    opts = opts || {};
    view.articleId = opts.articleId || null;
    view.dir = opts.dir || null;
    view.origin = opts.origin || view.origin;
    view.sourceMode = opts.sourceMode || 'material';
    view.sourceMeta = opts.sourceMeta || null;
    view.sources = opts.sources || [];
    view.similarity = opts.similarity || null;
    applySourceChrome();
    if (!draft) { showEditor(false); renderSources([]); renderSimilarity(null); return; }
    showEditor(true);
    $('#draftCoverBox').style.display = draft.coverDataUri ? '' : 'none';
    $('#draftCover').src = draft.coverDataUri || '';
    $('#draftTitle').value = draft.title || '';
    $('#draftDigest').value = draft.digest || '';
    $('#draftBody').value = draft.html || '';
    setEditorMode('edit');
    updateWords();
    renderSources(view.sources);
    renderSimilarity(view.similarity);
  }

  /** 对话共创 / 选题雷达成文结果的统一入口（compose:generate 已落盘并入历史）。
   *  meta：{mode:'chat', sessionId} | {mode:'radar', ids, date}——「重新生成」按原来源重跑时要用。 */
  function loadComposed(res, meta) {
    if (!res || !res.article) return;
    view.origin = res.origin || view.origin;
    view.sourceMode = (meta && meta.mode) || 'material';
    view.sourceMeta = meta || null;
    loadDraft(res.article, {
      articleId: res.articleId || null,
      dir: res.dir || null,
      origin: res.origin,
      sources: res.sources || [],
      similarity: res.similarity || null,
      sourceMode: view.sourceMode,
      sourceMeta: view.sourceMeta,
    });
    App.showView('compose');
    if (App.dashboardView) App.dashboardView.refresh();
    if (App.historyView) App.historyView.refresh();
  }

  /* ---------------- 素材本地草稿（core config.js content.material/emphasis） ---------------- */
  async function persistMaterialDraft() {
    const material = $('#matInput').value;
    const emphasis = $('#emphasisInput').value.trim();
    try {
      const { config } = await App.api.invoke('config:set', { content: { material, emphasis } });
      App.state.cfg = config; // 同步全局缓存，供本页/设置页回填
    } catch (e) {
      console.error('[compose] 素材草稿保存失败', e.code || '', e.message || ''); // 不阻塞成文主流程
    }
  }

  /* ---------------- 生成（mode='material'）/ 编辑保存 / 上传 ---------------- */
  async function generate() {
    if (view.generating) return;
    const material = $('#matInput').value.trim();
    if (!material) {
      App.toast('素材还没有粘贴。把要点、草稿或聊天记录贴进左侧素材区。', 'err');
      $('#matInput').focus();
      return;
    }
    view.generating = true;
    const btn = $('#composeGenBtn');
    const restore = App.setBusy(btn, App.BUSY_ICON + 'AI 正在按你的文风成文…');
    $('#composeGenResult').classList.remove('on');
    try {
      const res = await App.api.invoke('compose:generate', {
        mode: 'material',
        material,
        emphasis: $('#emphasisInput').value.trim(),
      });
      loadDraft(res.article, {
        articleId: res.articleId, dir: res.dir, origin: res.origin || '素材',
        sources: res.sources || [], similarity: res.similarity || null,
      });
      $('#composeGenResult').innerHTML = '';
      persistMaterialDraft(); // 素材草稿落 config（不阻塞、失败仅记日志）
      if (App.dashboardView) App.dashboardView.refresh();
      if (App.historyView) App.historyView.refresh();
      App.toast('草稿已生成并保存，右侧可直接编辑');
    } catch (e) {
      $('#composeGenResult').innerHTML = App.banner('err', '<b>' + escapeHtml(e.message) + '</b>' + (e.hint ? ' ' + escapeHtml(e.hint) : ''));
      $('#composeGenResult').classList.add('on');
      App.handleErr(e, '成文失败');
    } finally {
      view.generating = false;
      restore();
      $('#composeProgress').style.display = 'none';
      $('#composeProgress').textContent = '';
    }
  }

  /** 「重新生成」：按当前成文的来源模式重跑。
   *  此前固定走 mode=material，会把对话/雷达文章替换成一篇用左侧残留素材写的无关文章。 */
  async function regenerate() {
    if (view.sourceMode === 'material') return generate();
    if (view.saving || view.generating) return;
    if (view.sourceMode === 'chat') {
      const sid = view.sourceMeta && view.sourceMeta.sessionId;
      if (!sid) { App.toast('这篇是从历史对话整理的，缺少会话 id，无法按对话重新生成；请到「对话共创」重新整理', 'err'); return; }
      const btn = $('#draftRegenBtn');
      const restore = App.setBusy(btn, App.BUSY_ICON + '正在按对话重新成文…');
      view.generating = true;
      try {
        const res = await App.api.invoke('compose:generate', { mode: 'chat', sessionId: sid });
        App.composeView.loadComposed(res, { mode: 'chat', sessionId: sid });
        App.toast('已按对话重新成文（旧稿仍在历史记录里）');
      } catch (e) {
        App.handleErr(e, '重新生成失败');
      } finally {
        view.generating = false;
        restore();
      }
      return;
    }
    // radar
    const meta = view.sourceMeta || {};
    const ids = Array.isArray(meta.ids) ? meta.ids : [];
    if (!ids.length || !meta.date) { App.toast('这篇是选题雷达成文，缺少选题/日期信息，无法按原来源重新生成；请到「选题雷达」重新勾选成文', 'err'); return; }
    const btn = $('#draftRegenBtn');
    const restore = App.setBusy(btn, App.BUSY_ICON + '正在按选题重新成文…');
    view.generating = true;
    try {
      const res = await App.api.invoke('compose:generate', {
        mode: 'radar', ids, date: meta.date, confirmSensitive: true, regenerate: true, articleMode:meta.articleMode, includeCode:meta.includeCode === true, productName:meta.productName, promotion:meta.promotion,
      });
      App.composeView.loadComposed(res, { ...meta, mode: 'radar', ids, date: meta.date });
      App.toast('已按选题重新成文（旧稿仍在历史记录里）');
    } catch (e) {
      App.handleErr(e, '重新生成失败');
    } finally {
      view.generating = false;
      restore();
    }
  }

  /** 编辑结果保存（compose:save：title/digest 截断与 html 消毒在主进程完成） */
  async function saveEdits(silent) {
    if (view.saving || !view.articleId) {
      if (!view.articleId && !silent) App.toast('还没有可保存的成文', 'err');
      return false;
    }
    view.saving = true;
    const btn = $('#draftSaveBtn');
    const restore = btn ? App.setBusy(btn, App.BUSY_ICON + '保存中…') : null;
    try {
      const res = await App.api.invoke('compose:save', {
        id: view.articleId,
        title: $('#draftTitle').value.trim(),
        digest: $('#draftDigest').value.trim(),
        html: $('#draftBody').value,
      });
      if (!silent) App.toast('修改已保存（' + App.fmtNum(res.words || countWords($('#draftBody').value)) + ' 字）');
      return true;
    } catch (e) {
      if (!silent) App.handleErr(e, '保存失败');
      return false;
    } finally {
      view.saving = false;
      if (restore) restore();
    }
  }

  async function upload() {
    if (view.uploading || !view.articleId) {
      if (!view.articleId) App.toast('还没有可上传的成文，先点「生成文章」', 'err');
      return;
    }
    const title = $('#draftTitle').value.trim();
    const html = $('#draftBody').value.trim();
    if (!title) { App.toast('标题不能为空', 'err'); $('#draftTitle').focus(); return; }
    if (!html) { App.toast('正文不能为空', 'err'); return; }
    view.uploading = true;
    const btn = $('#draftUploadBtn');
    const restore = App.setBusy(btn, App.BUSY_ICON + '正在上传到草稿箱…');
    try {
      const saved = await saveEdits(true); // 先落编辑内容再上传（主进程按成文 id 上传）
      if (!saved) throw Object.assign(new Error('编辑内容保存失败，未上传'), { code: 'E_IO' });
      const res = await App.api.invoke('compose:upload', { id: view.articleId });
      App.toast('草稿已上传（' + (res.draftMediaId || '') + '），去公众号 App 里审阅发表吧');
      if (App.dashboardView) App.dashboardView.refresh();
      if (App.historyView) App.historyView.refresh();
    } catch (e) {
      App.handleErr(e, '上传失败');
    } finally {
      view.uploading = false;
      restore();
    }
  }

  /** 回填上次素材草稿（config.content.material/emphasis）。
   *  视图 init 早于全局配置加载（App.state.cfg 此时为 null），因此启动流程在
   *  loadGlobalState() 之后还会再调一次（App.composeView.restoreDraft）；用户已输入时不覆盖。 */
  function restoreDraft() {
    const c = (App.state.cfg && App.state.cfg.content) || {};
    if (c.material && !$('#matInput').value) {
      $('#matInput').value = c.material;
      if (c.emphasis) $('#emphasisInput').value = c.emphasis;
      updateMatCount();
    }
  }

  /* ---------------- 初始化 ---------------- */
  App.viewInits.push(function () {
    $('#matInput').addEventListener('input', updateMatCount);
    $('#composeGenBtn').addEventListener('click', generate);
    $('#draftRegenBtn').addEventListener('click', regenerate);
    const newBtn = $('#composeNewBtn');
    if (newBtn) newBtn.addEventListener('click', () => { resetToMaterial(); App.toast('已新建一篇素材成文'); });
    $('#draftSaveBtn').addEventListener('click', () => saveEdits(false));
    $('#draftUploadBtn').addEventListener('click', upload);
    $('#composeSampleBtn').addEventListener('click', () => App.showSettingsTab('content'));
    $('#draftBody').addEventListener('input', updateWords);
    $('#editModeBtn').addEventListener('click', () => setEditorMode('edit'));
    $('#previewModeBtn').addEventListener('click', () => setEditorMode('preview'));

    // 成文长任务进度（主进程 task:progress，kind='compose'）
    App.api.on('task:progress', (p) => {
      if (!p || p.kind !== 'compose') return;
      const el = $('#composeProgress');
      if (!el) return;
      if (p.state === 'fail') {
        el.style.display = '';
        el.style.color = 'var(--red)';
        el.textContent = '出错：' + (p.detail || '');
      } else if (p.state === 'active') {
        el.style.display = '';
        el.style.color = '';
        el.textContent = p.detail || '处理中…';
      } else if (p.state === 'done') {
        el.style.display = 'none';
        el.textContent = '';
      }
    });

    updateMatCount();
    showEditor(false);
    applySourceChrome();
    // 恢复上次素材草稿（config.content.material/emphasis；配置尚未加载时由 App 在加载后再调一次）
    restoreDraft();
    // 素材草稿自动保存（防抖）：只在「生成文章」后落盘会让未生成的输入在重启后丢失
    let draftTimer = null;
    const scheduleDraftSave = () => {
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = setTimeout(() => { draftTimer = null; persistMaterialDraft(); }, 800);
    };
    $('#matInput').addEventListener('input', scheduleDraftSave);
    $('#emphasisInput').addEventListener('input', scheduleDraftSave);
    App.viewRefresh.compose = function () {
      // 素材与草稿为页面内状态，切回不重置；草稿为空时补一次回填（配置可能刚在设置页改过）
      if (!App.state.cfg) return;
      restoreDraft();
    };
  });

  App.composeView = { loadComposed, loadDraft, restoreDraft, resetToMaterial, ensureMaterialMode };
})();
