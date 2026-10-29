/* ============================================================
 * radar.js —— 选题雷达
 * 数据源（通道名与 payload 对齐 main/ipc.js v2 落地约定）：
 *   radar:run    {}                     → {date, generatedAt, topics, keywordErrors, removedCount}
 *   radar:get    {date?}                → {radar:{date, topics, ...}}（无当日清单 → E_NOT_FOUND）
 *   radar:select {date, ids}            → {radar, changed}（勾选持久化，每次全量传）
 *   compose:generate {mode:'radar', ids, date, confirmSensitive}
 *                                       → {articleId, article, words, origin:'聚合', similarity, needsRewrite, sources}
 *                                       敏感话题未确认 → E_CONFIRM_REQUIRED（message=reason）
 *   compose:upload {id}（按成文 id 上传，主进程复用 wechat 链路）
 * 护栏：来源分级 L1/L2/L3（core source.label）、勾选上限 3、敏感话题 E_CONFIRM_REQUIRED
 * 二次确认、n-gram 相似度自检展示、素材来源清单仅内部可见。
 * 事件：task:progress {kind:'radar', stage, state, detail}。
 * ============================================================ */
(function () {
  'use strict';

  const App = window.App;
  const { $, $$ } = App;

  const MAX_PICK = 3;

  const view = {
    topics: [],
    radarDate: null,     // 当日清单日期（radar:select / compose:generate 需要回传）
    fetchedAt: null,
    selected: new Set(),
    fetching: false,
    generating: false,
    confirmArmed: false, // 敏感话题人工确认（E_CONFIRM_REQUIRED 后二次点击才生成）
    lastResult: null,
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /**
   * 热点条目归一化（core buildTopicList：{id,title,summary,source:{name,url,tier,label},heat,publishedAt,keyword,selected}）。
   * 兼容字段别名（topic|title、sourceUrl|source.url），level 缺省按 L3 展示，id 缺失用索引兜底。
   */
  function normalizeTopic(t, i) {
    const src = t && typeof t.source === 'object' && t.source !== null ? t.source : {};
    return {
      id: String((t && t.id) || 'tp-' + (i + 1)),
      level: (t && (t.level || src.label)) || 'L3',
      topic: String((t && (t.title || t.topic)) || ''),
      summary: String((t && (t.summary || t.snippet)) || ''),
      sourceName: String((t && (t.sourceName || src.name)) || ''),
      sourceUrl: String((t && (t.sourceUrl || src.url || t.url)) || ''),
      heat: t && t.heat != null ? t.heat : null,
      publishedAt: (t && t.publishedAt) || null,
      keywords: [t && t.keyword].filter(Boolean),
      selected: !!(t && t.selected), // radar:select 落盘的勾选态（重启后回显）
    };
  }

  /** 敏感闸：compose:generate(mode radar) 未确认时返回 E_CONFIRM_REQUIRED（message=reason） */
  function isConfirmRequired(e) {
    return e && (e.code === 'E_CONFIRM_REQUIRED' || e.needsConfirmation === true);
  }

  /* ---------------- 热点清单 ---------------- */
  function itemHtml(t) {
    const lv = App.radarLevelOf(t.level);
    const checked = view.selected.has(t.id);
    return '<label class="radar-item' + (checked ? ' checked' : '') + '" data-tp="' + escapeHtml(t.id) + '">' +
      '<input type="checkbox" class="radar-check" data-tp-check="' + escapeHtml(t.id) + '"' + (checked ? ' checked' : '') + '>' +
      '<div class="rbody">' +
      '  <div class="topic">' + escapeHtml(t.topic || '') + '</div>' +
      '  <div class="summary">' + escapeHtml(t.summary || '') + '</div>' +
      '  <div class="rmeta">' +
      '    <span class="' + lv.cls + '">' + lv.label + '</span>' +
      (t.sourceName ? '<span><i class="fa-regular fa-newspaper"></i> ' + escapeHtml(t.sourceName) + '</span>' : '') +
      (t.heat != null ? '<span class="heat"><i class="fa-solid fa-fire" style="color:var(--amber);"></i> 热度 ' + escapeHtml(t.heat) + '</span>' : '') +
      (t.sourceUrl ? '<a class="rmeta-link" data-url="' + escapeHtml(t.sourceUrl) + '" title="' + escapeHtml(t.sourceUrl) + '"><i class="fa-solid fa-arrow-up-right-from-square"></i><span class="rl-text">' + escapeHtml(t.sourceUrl.replace(/^https?:\/\//, '')) + '</span></a>' : '') +
      '  </div>' +
      '</div></label>';
  }

  function renderList() {
    const list = $('#radarList');
    if (!view.topics.length) {
      list.innerHTML = '';
      $('#radarEmpty').style.display = '';
      return;
    }
    $('#radarEmpty').style.display = 'none';
    list.innerHTML = view.topics.map(itemHtml).join('');
    // 勾选统一走 checkbox 的 change 事件：label 上的 click 会被浏览器合成第二次 click
    // （label → 内部 checkbox 的激活行为），绑在 label 上会把同一次点选切换两次、勾不上。
    $$('[data-tp-check]', list).forEach((cb) => cb.addEventListener('change', () => {
      togglePick(cb.dataset.tpCheck, cb.checked);
    }));
    // 卡片内来源链接：阻止 label 激活行为（不改变勾选），直接打开外链
    $$('[data-tp]', list).forEach((el) => el.addEventListener('click', (e) => {
      const link = e.target.closest('[data-url]');
      if (link) { e.preventDefault(); e.stopPropagation(); App.openExternal(link.dataset.url); }
    }));
  }

  function togglePick(id, on) {
    if (on && view.selected.size >= MAX_PICK && !view.selected.has(id)) {
      App.toast('一次最多勾选 ' + MAX_PICK + ' 条热点（内容可控、质量最高）', 'err');
      const cb = $('[data-tp-check="' + id + '"]'); // 超限回退原生勾选态
      if (cb) cb.checked = false;
      return;
    }
    if (on) view.selected.add(id); else view.selected.delete(id);
    view.confirmArmed = false; // 选择变化后敏感话题确认重新计
    $('#radarGenResult').classList.remove('on');
    const item = $('[data-tp="' + id + '"]');
    if (item) {
      item.classList.toggle('checked', on);
      const cb = $('[data-tp-check="' + id + '"]', item);
      if (cb) cb.checked = on;
    }
    renderSelCount();
  }

  function renderSelCount() {
    $('#radarSelCount').innerHTML = '<i class="fa-solid fa-check-double"></i>已选 ' + view.selected.size + '/' + MAX_PICK;
    $('#radarGenBtn').disabled = view.selected.size === 0 || view.generating;
  }

  /* ---------------- 配置摘要（空态提示用，来自 config:get 的 aggregate 区） ---------------- */
  function renderCfgHint() {
    const cfg = App.state.cfg || {};
    const agg = cfg.aggregate || {};
    const kw = Array.isArray(agg.keywords) ? agg.keywords : [];
    const al = Array.isArray(agg.whitelist) ? agg.whitelist : [];
    const parts = [];
    parts.push('关键词 ' + (kw.length ? '「' + kw.join('、') + '」' : '未配置'));
    parts.push('白名单 ' + al.length + ' 个来源');
    if (agg.dailyLimit) parts.push('每日 ' + agg.dailyLimit + ' 条');
    let tail = '';
    if (!kw.length) tail = '；先到「聚合来源配置」添加关键词，搜索才知道搜什么';
    else if (!al.length) tail = '；未设来源白名单＝收录全部来源（建议按需配置白名单，只留权威来源）';
    $('#radarEmptyHint').textContent = '点击右上角「立即搜索」抓取一轮。当前：' + parts.join(' · ') + tail;
  }

  function hydrateOptions() {
    const cfg = App.state.cfg || {}, a = cfg.aggregate || {};
    $('#radarKeywords').value = (a.keywords || []).join(' ');
    $('#radarArticleMode').value = a.articleMode || (a.includeCode ? 'web-code' : 'web');
    $('#radarProfilePath').value = a.profilePath || '';
    $('#radarImagesEnabled').checked = !!a.imagesEnabled;
    $('#radarImagesDir').value = a.imagesDir || '';
    $('#radarAssetsFields').style.display = a.imagesEnabled ? '' : 'none';
    $('#radarRepoPath').value = a.repoPath || (cfg.content && cfg.content.repoPath) || '';
    $('#radarProductName').value = a.productName || '';
    $('#radarPromotion').value = a.promotion || '';
    toggleCodeFields();
  }
  function toggleCodeFields() {
    const mode = $('#radarArticleMode').value;
    $('#radarCodeFields').style.display = mode === 'web' ? 'none' : '';
    $('#radarRepoFields').style.display = mode === 'web-code' ? '' : 'none';
    $('#radarProfileFields').style.display = mode === 'web-profile' ? '' : 'none';
    view.confirmArmed = false;
  }
  async function persistOptions(validate = false) {
    const keywords = [...new Set($('#radarKeywords').value.split(/[\s,，、;；]+/).filter(Boolean))];
    const articleMode = $('#radarArticleMode').value;
    const includeCode = articleMode === 'web-code';
    const profilePath = $('#radarProfilePath').value.trim();
    const repoPath = $('#radarRepoPath').value.trim();
    const imagesEnabled = $('#radarImagesEnabled').checked;
    const imagesDir = $('#radarImagesDir').value.trim();
    if (validate && articleMode !== 'web' && imagesEnabled && !imagesDir) throw new Error('请先选择素材图片文件夹');
    const productName = $('#radarProductName').value.trim();
    const promotion = $('#radarPromotion').value.trim();
    if (validate && includeCode && !repoPath) throw new Error('请先选择代码库文件夹');
    if (validate && articleMode === 'web-profile' && !profilePath) throw new Error('请先选择系统功能档案');
    if (validate && articleMode !== 'web' && !productName) throw new Error('请填写文章中使用的系统名称');
    const r = await App.api.invoke('config:set', {aggregate:{keywords,articleMode,profilePath,imagesEnabled,imagesDir,includeCode,repoPath,productName,promotion}});
    App.state.cfg = r.config;
    return {articleMode, includeCode, productName, promotion};
  }

  /* ---------------- 搜索 / 当日清单 ---------------- */
  /** 清空成文结果卡（重新搜索/应用新清单时调用）：旧文章不得再提供「上传/进编辑器」 */
  function clearResultCard() {
    view.lastResult = null;
    const box = $('#radarGenResult');
    if (box) {
      box.classList.remove('on');
      box.innerHTML = '';
    }
  }

  async function fetchTopics() {
    if (view.fetching) return;
    view.fetching = true;
    clearResultCard(); // 旧结果属于上一批热点，重新搜索后必须消失
    const btn = $('#radarFetchBtn');
    const restore = App.setBusy(btn, App.BUSY_ICON + '正在搜索全网…');
    $('#radarErr').classList.remove('on');
    try {
      await persistOptions();
      const res = await App.api.invoke('radar:run', {});
      applyTopics(res);
      const kwErrs = (res && res.keywordErrors) || [];
      if (kwErrs.length) {
        $('#radarErr').innerHTML = App.banner('err', '<b>部分关键词搜索失败：</b>' +
          escapeHtml(kwErrs.map((k) => '「' + k.keyword + '」' + (k.error && k.error.message || '')).join('；')) +
          '（其余关键词结果已正常返回）');
        $('#radarErr').classList.add('on');
      }
      App.toast('今日热点已更新：' + view.topics.length + ' 条');
    } catch (e) {
      showFetchError(e);
    } finally {
      view.fetching = false;
      restore();
    }
  }

  /** 当日已落盘清单恢复（radar:get；无清单 → E_NOT_FOUND，属正常空态不打扰） */
  async function restoreToday() {
    try {
      const res = await App.api.invoke('radar:get', {});
      if (!res || !res.radar) return; // 没有当日清单 = 正常空态，保持空态提示
      applyTopics(res.radar, { keepSelection: true });
    } catch (e) { /* 无当日清单属正常空态 */ }
  }

  function applyTopics(res, opts) {
    const keepSelection = !!(opts && opts.keepSelection);
    const raw = (res && (res.topics || (res.radar && res.radar.topics))) || [];
    view.topics = raw.map(normalizeTopic);
    view.radarDate = (res && res.date) || (res && res.radar && res.radar.date) || view.radarDate || App.todayKey();
    view.selected.clear();
    if (keepSelection) {
      // 回显 radar:select 落盘的勾选（重启/重新加载清单后不再全部丢失）
      view.topics.forEach((t) => { if (t.selected && view.selected.size < MAX_PICK) view.selected.add(t.id); });
    }
    view.confirmArmed = false;
    const genAt = res && (res.generatedAt || (res.radar && res.radar.generatedAt));
    view.fetchedAt = genAt ? hmOf(genAt) : new Date().toTimeString().slice(0, 5);
    const removed = res && (res.removedCount != null ? res.removedCount : (res.radar && res.radar.removedCount));
    $('#radarFetchedAt').textContent = '· 抓取于 ' + view.fetchedAt +
      (removed != null ? '，去重/过滤 ' + removed + ' 条，保留 ' + view.topics.length + ' 条' : '，共 ' + view.topics.length + ' 条');
    renderList();
    renderSelCount();
  }

  function hmOf(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(11, 16) || '—';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function showFetchError(e) {
    $('#radarErr').innerHTML = App.banner('err', '<b>' + escapeHtml(e.message) + '</b>' + (e.hint ? ' ' + escapeHtml(e.hint) : '') +
      (e.code === 'E_NO_CONFIG' || /未配置|Key 未填写/.test(e.message || '') ? ' 请先到「聚合来源配置」填写关键词、白名单与搜索 API Key。' : '') +
      ' <button class="btn btn-ghost btn-sm" id="radarErrCfg" style="margin-left:8px;">去配置</button>');
    $('#radarErr').classList.add('on');
    const goCfg = $('#radarErrCfg');
    if (goCfg) goCfg.addEventListener('click', () => App.showSettingsTab('aggregate'));
    App.handleErr(e, '热点抓取失败');
  }

  /* ---------------- 综合成文 ---------------- */
  function pickedTopics() {
    return view.topics.filter((t) => view.selected.has(t.id));
  }

  async function generate() {
    if (view.generating) return;
    const picked = pickedTopics();
    if (!picked.length) { App.toast('先在清单里勾选 1~3 条热点', 'err'); return; }
    if (!view.radarDate) { App.toast('还没有今日热点清单，先点「立即搜索」', 'err'); return; }

    view.generating = true;
    renderSelCount();
    const btn = $('#radarGenBtn');
    const restore = App.setBusy(btn, App.BUSY_ICON + 'AI 正在综合成文…');
    $('#radarGenResult').classList.remove('on');
    try {
      const options = await persistOptions(true);
      // 1) 勾选持久化（每次全量传当前勾选；ipc radar:select {date, ids}）
      await App.api.invoke('radar:select', { date: view.radarDate, ids: [...view.selected] });
      // 2) 综合成文（主进程敏感话题闸未放行 → E_CONFIRM_REQUIRED，需二次人工确认）
      let res;
      try {
        res = await App.api.invoke('compose:generate', {
          mode: 'radar',
          ids: [...view.selected],
          date: view.radarDate,
          confirmSensitive: view.confirmArmed,
          ...options,
        });
      } catch (e) {
        if (isConfirmRequired(e)) {
          view.confirmArmed = true;
          $('#radarGenResult').innerHTML = App.banner('err',
            '<b>人工确认：</b>' + escapeHtml(e.message || '勾选中包含敏感话题关键词。') +
            ' 确认内容不涉及敏感题材后，<b>再次点击「综合成文」</b>继续；取消请调整勾选。');
          $('#radarGenResult').classList.add('on');
          return;
        }
        throw e;
      }
      view.lastResult = res;
      renderResult(res);
    } catch (e) {
      $('#radarGenResult').innerHTML = App.banner('err', '<b>' + escapeHtml(e.message) + '</b>' + (e.hint ? ' ' + escapeHtml(e.hint) : ''));
      $('#radarGenResult').classList.add('on');
      App.handleErr(e, '综合成文失败');
    } finally {
      view.generating = false;
      restore();
      renderSelCount();
    }
  }

  function similarityChip(sim) {
    if (!sim || (sim.maxRatio == null && sim.ratio == null)) return '<span class="chip st-gray">未做相似度自检</span>';
    const pct = Math.round((Number(sim.maxRatio != null ? sim.maxRatio : sim.ratio) || 0) * 100);
    const thr = Math.round((Number(sim.threshold) || 0) * 100);
    // needsRewrite=true 表示「自动重写后仍超阈值」，此时上传仍会被人工改写关卡拦截，
    // 不能显示成已处理完的「已重写」。
    if (sim.needsRewrite === true || sim.passed === false) {
      return '<span class="chip st-red">相似度 ' + pct + '% 超阈值' +
        (sim.needsRewrite === true ? ' · 已重写仍超阈值，需人工改写' : ' · 需人工处理') + '</span>';
    }
    if ((sim.rewriteAttempts || 0) > 0) return '<span class="chip st-green">相似度 ' + pct + '% · 已自动重写并通过</span>';
    return '<span class="chip st-green">相似度自检通过 ' + pct + '%（阈值 ' + thr + '%）</span>';
  }

  function renderResult(res) {
    const d = res.article || res.draft || {};
    const sources = (res.sources || []).map((s, i) => {
      const src = s && typeof s.source === 'object' && s.source !== null ? s.source : {};
      return {
        label: (s.label || src.label || 'L3'),
        title: s.title || src.title || '',
        name: s.name || src.name || '',
        url: s.url || src.url || '',
        excerpt: s.excerpt || '',
        fetchState: s.fetchState || null,
        index: s.index != null ? s.index : i + 1,
      };
    });
    const lvHtml = sources.map((s) => {
      const lv = App.radarLevelOf(s.label);
      return '<div class="source-row"><span class="' + lv.cls + '">' + lv.label + '</span>' +
        '<div style="flex:1;min-width:0;"><div style="font-weight:600;">' + escapeHtml(s.title || s.name || '') + '</div>' +
        (s.url ? '<a class="s-url" href="#" data-src-url="' + escapeHtml(s.url) + '">' + escapeHtml(s.url) + '</a>' : '') +
        (s.excerpt ? '<div style="color:var(--text-3);font-size:11.5px;margin-top:2px;">' + escapeHtml(s.excerpt) + '</div>' : '') +
        '</div></div>';
    }).join('');
    $('#radarGenResult').innerHTML =
      '<div class="card" style="box-shadow:none;border:1.5px solid oklch(88% 0.04 156);">' +
      '  <div style="padding:16px 20px 0;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
      '    <b style="font-size:14.5px;">《' + escapeHtml(d.title || '') + '》</b>' + similarityChip(res.similarity) +
      (res.words != null ? '<span class="chip st-gray">' + App.fmtNum(res.words) + ' 字</span>' : '') +
      '  </div>' +
      '  <div style="padding:6px 20px 0;color:var(--text-3);font-size:12.5px;">' + escapeHtml(d.digest || '') + '</div>' +
      (d.coverDataUri ? '<div style="padding:14px 20px 0;"><div class="hint">本篇自动封面 · 900 × 383</div><img src="' + escapeHtml(d.coverDataUri) + '" alt="本篇封面" style="width:100%;max-width:720px;border-radius:12px;"></div>' : '') +
      (res.assetEvidence && res.assetEvidence.length ? '<div class="hint" style="padding:10px 20px 0;">已加入本地素材：' + escapeHtml(res.assetEvidence.map(a=>a.relative).join('、')) + '</div>' : '') +
      (res.profileEvidence ? '<div class="hint" style="padding:10px 20px 0;">已结合功能档案：' + escapeHtml(res.profileEvidence.fileName) + ' · 使用 ' + res.profileEvidence.includedChars + ' / ' + res.profileEvidence.originalChars + ' 字符' + (res.profileEvidence.limited ? '（已按选题筛选）' : '') + ' · 本次未读取代码库</div>' : '') +
      (res.codeEvidence ? '<div class="hint" style="padding:10px 20px 0;">已结合系统：' + escapeHtml(d.productName) + ' · 选取 ' + res.codeEvidence.files.length + ' 个相关代码文件作为功能依据</div>' : '') +
      '  <div class="art-body" style="padding:10px 20px 0;">' + (d.html || '') + '</div>' +
      (sources.length ?
      '  <div class="sources-card" style="margin:14px 20px 0;">' +
      '    <div class="sc-head"><i class="fa-solid fa-list-check" style="color:var(--brand-deep);"></i>素材来源清单</div>' +
      '    <div class="sc-note">供人工核查引用出处，<b>不随文章发布</b>。' +
      (sources.some((s) => s.fetchState === 'snippet-only') ? '部分来源正文抓取失败，已按平台约定降级使用搜索摘要（如实标注，未伪造素材）。' : '') +
      '</div>' + lvHtml + '</div>' : '') +
      '  <div style="display:flex;gap:10px;padding:14px 20px 16px;flex-wrap:wrap;">' +
      '    <button class="btn btn-primary" id="radarToEditor"><i class="fa-solid fa-pen-nib"></i>进编辑器修改</button>' +
      '    <button class="btn btn-ghost" id="radarDirectUpload"><i class="fa-solid fa-paper-plane"></i>直接上传草稿箱</button>' +
      '  </div>' +
      '</div>';
    $('#radarGenResult').classList.add('on');

    // 结果卡位于 5 条热点列表之下（1360×881 下 top≈877，几乎全在首屏外）：
    // 成文成功必须有可见反馈——滚动到结果卡并给一条成功 toast。
    try {
      $('#radarGenResult').scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (e) { /* 不支持 options 时忽略 */ }
    App.toast('成文完成：《' + (d.title || '') + '》，可进编辑器修改或直接上传');

    $('#radarToEditor').addEventListener('click', () => {
      if (view.lastResult) App.composeView.loadComposed(view.lastResult, { mode: 'radar', ids: [...view.selected], date: view.radarDate, articleMode: res.generationMode || 'web', includeCode: res.generationMode === 'web-code', productName: d.productName || '', promotion: $('#radarPromotion').value.trim() }); // 成文已落盘，进编辑器继续改
    });
    $('#radarDirectUpload').addEventListener('click', async () => {
      if (!view.lastResult || !view.lastResult.articleId) { App.toast('没有可上传的成文', 'err'); return; }
      const btn2 = $('#radarDirectUpload');
      const restore2 = App.setBusy(btn2, App.BUSY_ICON + '正在上传…');
      try {
        const r = await App.api.invoke('compose:upload', { id: view.lastResult.articleId });
        App.toast('草稿已上传（' + (r.draftMediaId || '') + '），去公众号 App 里审阅发表吧');
        if (App.dashboardView) App.dashboardView.refresh();
        if (App.historyView) App.historyView.refresh();
      } catch (e) {
        App.handleErr(e, '上传失败');
      } finally {
        restore2();
      }
    });
    $$('#radarGenResult [data-src-url]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); App.openExternal(a.dataset.srcUrl); }));
  }

  /* ---------------- 初始化 ---------------- */
  App.viewInits.push(function () {
    hydrateOptions();
    $('#radarArticleMode').addEventListener('change', () => {toggleCodeFields();persistOptions().catch(e=>App.handleErr(e,'保存文章方式失败'));});
    $('#radarImagesEnabled').addEventListener('change', () => {$('#radarAssetsFields').style.display = $('#radarImagesEnabled').checked ? '' : 'none';persistOptions().catch(e=>App.handleErr(e,'保存图片设置失败'));});
    $('#radarPickAssets').addEventListener('click', async () => {
      try { const r = await App.api.invoke('dialog:pick-assets', {});if(r.path){$('#radarImagesDir').value=r.path;await persistOptions();App.toast('素材文件夹已保存，成文时会挑选相关图片');} }
      catch(e){App.handleErr(e,'选择素材失败');}
    });
    $('#radarPickProfile').addEventListener('click', async () => {
      try {
        const r = await App.api.invoke('dialog:pick-profile', {});
        if (r.path) {
          $('#radarProfilePath').value = r.path;
          await persistOptions();
          $('#radarProfileHint').textContent = '已选择 ' + r.fileName + '（' + r.originalChars + ' 字符）。每次成文读取最新内容；档案模式不扫描代码库。';
        }
      } catch(e) { App.handleErr(e,'选择档案失败'); }
    });
    $('#radarPickRepo').addEventListener('click', async () => {
      try { const r = await App.api.invoke('dialog:pick-repo', {}); if (r.path) $('#radarRepoPath').value = r.path; }
      catch(e) { App.handleErr(e, '选择代码库失败'); }
    });
    $('#radarFetchBtn').addEventListener('click', fetchTopics);
    $('#radarGenBtn').addEventListener('click', generate);
    $('#radarConfigBtn').addEventListener('click', () => App.showSettingsTab('aggregate'));

    // v2.4：全自动跑一次 —— 按当前参数搜索 → 自动选排名最前的选题 → 成文 → 上传草稿箱。
    // 与定时任务共用同一条执行路径（runManager.startRadar），进度/结果走 run:progress / run:finished。
    $('#radarAutoBtn').addEventListener('click', async () => {
      const btn = $('#radarAutoBtn');
      if (btn.disabled) return;
      const restore = App.setBusy(btn, App.BUSY_ICON + '已提交全自动任务…');
      try {
        const res = await App.api.invoke('radar:auto-run', {});
        App.toast('全自动任务已开始（runId ' + res.runId.slice(-6) + '），完成后会通知你');
        App.showView && App.showView('logs');
      } catch (e) {
        App.handleErr(e, '启动全自动失败');
      } finally {
        setTimeout(restore, 1200);
      }
    });

    // 雷达长任务进度（主进程 task:progress，kind='radar'）
    App.api.on('task:progress', (p) => {
      if (!p || p.kind !== 'radar' || !view.fetching) return;
      $('#radarFetchedAt').textContent = '· ' + (p.detail || '搜索中…');
    });

    App.viewRefresh.radar = function () { renderCfgHint(); hydrateOptions(); };
    renderCfgHint();
    renderSelCount();
    restoreToday();
  });
})();
