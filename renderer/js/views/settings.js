/* ============================================================
 * settings.js —— 设置：公众号凭证 / 大模型 / 内容与文风(+文章样本库) /
 *                项目背景 / 聚合来源 / 应用 六页签
 * 数据源：config:get / config:set / wechat:test / llm:test / net:public-ip /
 *        schedule:set / dialog:pick-* / config:export / shell:open-external /
 *        v2：style:samples:list|add|import|delete、style:analyze、
 *            style:profile:get|set|toggle（文章样本库与文风画像，main/ipc.js v2 契约）
 *
 * 密钥语义（契约 §2）：config:get 返回脱敏值（仅末 4 位）；输入框带 data-masked
 * 标记时表示「未修改、沿用已存密钥」，保存/测试时以 null 传给主进程（保留原值）。
 * v2 新增脱敏密钥：aggregate.searchApiKey（同语义）。
 * ============================================================ */
(function () {
  'use strict';

  const App = window.App;
  const { $, $$ } = App;

  const view = { cfg: null, hasWxSecret: false, hasLlmKey: false, hasSearchKey: false, samples: [], profile: null };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ---------------- 掩码输入工具 ---------------- */
  function setSecret(input, redacted) {
    if (redacted) {
      input.value = redacted;
      input.dataset.masked = '1';
    } else {
      input.value = '';
      delete input.dataset.masked;
    }
  }
  function watchSecret(input) {
    input.addEventListener('input', () => { delete input.dataset.masked; });
  }
  /** null = 保留原值；空串视为未填写也按 null 传 */
  function secretPayload(input) {
    if (input.dataset.masked === '1') return null;
    const v = input.value.trim();
    return v ? v : null;
  }

  /* ---------------- 禁用态与原因（PRD §7） ---------------- */
  function updateTestWxGate() {
    const appid = $('#wxAppid').value.trim();
    const typed = $('#wxSecret').dataset.masked !== '1' && $('#wxSecret').value.trim().length > 0;
    const btn = $('#testWx');
    const hint = $('#testWxHint');
    let reason = '';
    if (!appid) reason = '先填写 AppID，才能测试连接。';
    else if (!typed && !view.hasWxSecret) reason = '先填写 AppSecret，才能测试连接（首次配置时必须填写）。';
    btn.disabled = !!reason;
    btn.title = reason;
    hint.style.display = reason ? 'block' : 'none';
    hint.textContent = reason;
  }
  function updateTestLlmGate() {
    const typed = $('#llmKey').dataset.masked !== '1' && $('#llmKey').value.trim().length > 0;
    const btn = $('#testLlm');
    const hint = $('#testLlmHint');
    const reason = (typed || view.hasLlmKey) ? '' : '先填写 API Key，才能测试连接（免费模型 glm-4.5-flash 也需要 Key）。';
    btn.disabled = !!reason;
    btn.title = reason;
    hint.style.display = reason ? 'block' : 'none';
    hint.textContent = reason;
  }

  /* ---------------- 测试连接 ---------------- */
  function showResult(box, html) {
    box.innerHTML = html;
    box.classList.add('on');
    App.bindIpCardActions(box, () => App.state.ip || $('#localIp').textContent);
  }

  async function testWx() {
    const btn = $('#testWx');
    if (btn.disabled) return;
    const busy = App.demo ? '正在测试…' : '正在获取 access_token…';
    const restore = App.setBusy(btn, App.BUSY_ICON + busy);
    try {
      const { expiresIn } = await App.api.invoke('wechat:test', {
        appId: $('#wxAppid').value.trim(),
        appSecret: secretPayload($('#wxSecret')),
      });
      const ip = App.state.ip || $('#localIp').textContent;
      showResult($('#testWxResult'),
        App.banner('ok', '<b>连接成功。</b>access_token 获取正常，有效期 ' + expiresIn + ' 秒；IP <code>' + escapeHtml(ip) + '</code> 已在白名单内。'));
    } catch (e) {
      let html = App.banner('err', '<b>' + escapeHtml(e.message) + '</b>' + (e.hint ? ' ' + escapeHtml(e.hint) : ''));
      if (e.errcode === 40164) {
        try { const { ip } = await App.api.invoke('net:public-ip'); App.state.ip = ip; } catch (_) { /* 保留旧值 */ }
        html += App.ipWhitelistCard(App.state.ip);
      }
      showResult($('#testWxResult'), html);
    } finally {
      restore();
      updateTestWxGate();
    }
  }

  async function testLlm() {
    const btn = $('#testLlm');
    if (btn.disabled) return;
    const busy = App.demo ? '正在测试…' : '正在调用模型…';
    const restore = App.setBusy(btn, App.BUSY_ICON + busy);
    try {
      const res = await App.api.invoke('llm:test', {
        baseUrl: $('#llmUrl').value.trim(),
        apiKey: secretPayload($('#llmKey')),
        model: currentModel(),
      });
      showResult($('#testLlmResult'),
        App.banner('ok', '<b>连接成功。</b>模型 ' + escapeHtml(res.model) + ' 可用，延迟 ' + res.latencyMs + 'ms。'));
    } catch (e) {
      showResult($('#testLlmResult'),
        App.banner('err', '<b>' + escapeHtml(e.message) + '</b>' + (e.hint ? ' ' + escapeHtml(e.hint) : '')));
    } finally {
      restore();
      updateTestLlmGate();
    }
  }

  function currentModel() {
    const sel = $('#llmModel');
    return sel.value === '__custom' ? $('#llmCustomModel').value.trim() : sel.value;
  }

  /* ---------------- 保存（分页签 patch，密钥 null=保留） ---------------- */
  async function saveConfig(patch, btn) {
    const restore = App.setBusy(btn, App.BUSY_ICON + '正在保存…');
    try {
      const { config } = await App.api.invoke('config:set', patch);
      applyConfig(config);
      App.toast('更改已保存');
      return true;
    } catch (e) {
      App.handleErr(e, '保存失败');
      return false;
    } finally {
      restore();
    }
  }
  function saveWx() {
    if (!view.cfg) return;
    saveConfig({ wechat: { appId: $('#wxAppid').value.trim(), appSecret: secretPayload($('#wxSecret')) } }, $('#saveWx'));
  }
  function saveLlm() {
    if (!view.cfg) return;
    saveConfig({
      llm: {
        baseUrl: $('#llmUrl').value.trim(),
        apiKey: secretPayload($('#llmKey')),
        model: currentModel(),
        temperature: Number($('#tempRange').value),
      },
    }, $('#saveLlm'));
  }
  function saveContent() {
    if (!view.cfg) return;
    const restore = App.setBusy($('#saveContent'), App.BUSY_ICON + '正在保存…');
    // 必须在 config:set 回填表单之前采集画像：applyConfig 会把旧画像写回编辑区，
    // 之后再 collectProfile 采到的就是旧值，用户的编辑被静默回滚。
    const profile = collectProfile();
    (async () => {
      try {
        // 内容与文风：content 走 config:set；文风画像走专用通道 style:profile:set（core style.js normalizeProfile 形状）
        const { config } = await App.api.invoke('config:set', {
          content: {
            repoPath: $('#repoPath').value,
            coverPath: (view.cfg.content && view.cfg.content.coverPath) || '',
            author: $('#authorName').value.trim(),
            audience: $('#audienceInput').value,
            styleExtra: $('#styleExtraInput').value,
            aiDisclosure: {
              enabled: $('#aiDisclosureSwitch').getAttribute('aria-checked') === 'true',
              text: $('#aiDisclosureText').value,
            },
          },
        });
        applyConfig(config);
        // 无画像且画像表单全空时跳过 style:profile:set：否则会把 null 画像写成空对象，
        // 既让「启用文风画像」误变成可用，又会在启用后把默认 AI 味禁用词清单压掉。
        let next = view.profile;
        if (profileHasContent(profile) || profileHasContent(view.profile)) {
          const saved = await App.api.invoke('style:profile:set', { profile });
          next = saved && saved.profile ? saved.profile : null;
          view.profile = next;
        }
        // 启用态以 cfg.style.enabled 为准（style:profile:set 不改开关）
        applyProfile(next, config && config.style ? config.style.enabled : undefined);
        App.toast('更改已保存');
      } catch (e) {
        App.handleErr(e, '保存失败');
      } finally {
        restore();
      }
    })();
    App.state.aiDisclosureText = $('#aiDisclosureText').value || App.state.aiDisclosureText;
  }
  function saveProject() {
    if (!view.cfg) return;
    saveConfig({
      project: {
        description: $('#projectDescInput').value,
        techTerms: $('#projectTechTermsInput').value,
      },
    }, $('#saveProject'));
  }
  /**
   * 搜索 Key 说明（v2.2）——随「服务商」与「当前大模型」两个变量变化。
   *
   * 关键规则（与 core aggregate.aggregateConfigOf 同口径）：厂商自带搜索（DeepSeek/智谱）
   * 只有在**大模型也是同一家**时才复用大模型 Key；否则必须单独填。换模型后如果继续选着
   * 原来那家，会出现「看着填了 Key、实际发到对不上的地址」的情况，所以这里要主动报警，
   * 而不是等用户点搜索后拿一个 404。
   */
  function llmHostname() {
    const base = (view.cfg && view.cfg.llm && view.cfg.llm.baseUrl) || '';
    try { return new URL(base).hostname.toLowerCase(); } catch (e) { return ''; }
  }

  function updateSearchKeyHint() {
    const hint = $('#aggSearchKeyHint');
    const input = $('#aggSearchKey');
    const sel = $('#aggSearchProvider');
    if (!hint || !input || !sel) return;
    const opt = sel.options[sel.selectedIndex];
    const providerHost = (opt && opt.dataset ? opt.dataset.host : '') || '';
    const providerName = (opt ? opt.textContent : '').split('（')[0];
    const isNative = !!providerHost && (sel.value === 'deepseek' || sel.value === 'bigmodel');
    const llmHost = llmHostname();
    const sameVendor = !!providerHost && !!llmHost && (llmHost === providerHost || llmHost.endsWith('.' + providerHost));
    const llmBase = (view.cfg && view.cfg.llm && view.cfg.llm.baseUrl) || '未配置';

    if (isNative && sameVendor) {
      hint.innerHTML = '当前大模型就是 <b>' + providerName + '</b>（' + llmHost + '），这一栏<b>可以留空</b>：搜索直接复用「大模型」页里的 API Key，不用再注册搜索平台。';
      input.placeholder = '留空即可（自动复用大模型 API Key）';
      return;
    }
    if (isNative && !sameVendor) {
      hint.innerHTML = '⚠️ 当前大模型是 <b>' + escapeHtml(llmHost || '未配置') + '</b>，不是 ' + providerName +
        '，<b>不能复用大模型 Key</b>，必须在下面单独填 ' + providerName + ' 的 Key（否则搜索会失败）。' +
        '建议改选「与当前大模型同一家」的通道，或改用独立搜索服务（博查 / Tavily / SerpAPI，与模型无关、配一次换模型不用动）。';
      input.placeholder = '需要 ' + providerName + ' 的 API Key（无法复用大模型 Key）';
      return;
    }
    if (sel.value === 'bocha') {
      hint.innerHTML = '博查 Key 到 open.bochaai.com 控制台创建（新账号有免费额度）。<b>独立搜索服务：换任何大模型都不用改这里。</b>存储时自动加密（Windows DPAPI），日志只显示末 4 位。';
      input.placeholder = '博查的 API Key（sk- 开头）';
    } else if (sel.value === 'tavily') {
      hint.innerHTML = 'Tavily Key 到 tavily.com 后台获取（每月有免费额度）。<b>独立搜索服务：换任何大模型都不用改这里。</b>存储时自动加密（Windows DPAPI）。';
      input.placeholder = 'Tavily 的 API Key';
    } else {
      hint.innerHTML = 'SerpAPI Key 到 serpapi.com 后台获取（按搜索次数计费）。<b>独立搜索服务：换任何大模型都不用改这里。</b>存储时自动加密（Windows DPAPI）。';
      input.placeholder = 'SerpAPI 的 API Key';
    }
  }

  function saveAggregate() {
    if (!view.cfg) return;
    const daily = parseInt($('#aggDailyLimit').value, 10);
    const thr = parseFloat($('#aggSimThreshold').value);
    if (!(daily >= 1 && daily <= 50)) {
      App.toast('每日聚合数量应为 1~50 之间的整数', 'err');
      $('#aggDailyLimit').focus();
      return;
    }
    if (!(thr > 0 && thr < 1)) {
      App.toast('相似度自检阈值应为 0~1 之间的小数（如 0.3）', 'err');
      $('#aggSimThreshold').focus();
      return;
    }
    // v2.4：选题雷达全自动的选题策略
    const autoPickCount = parseInt($('#aggAutoPickCount').value, 10);
    if (!(autoPickCount >= 1 && autoPickCount <= 3)) {
      App.toast('自动选用条数应为 1~3 之间的整数', 'err');
      return;
    }
    const autoRewriteAttempts = parseInt($('#aggAutoRewriteAttempts').value, 10);
    if (!(autoRewriteAttempts >= 1 && autoRewriteAttempts <= 10)) {
      App.toast('自动重写次数应为 1~10 之间的整数', 'err');
      return;
    }
    saveConfig({
      aggregate: {
        keywords: $('#aggKeywords').value.split(/[\s,，、]+/).map((s) => s.trim()).filter(Boolean),
        whitelist: $('#aggWhitelist').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
        verticalNotice: {
          enabled: $('#aggVerticalNoticeSwitch').getAttribute('aria-checked') === 'true',
          text: String($('#aggVerticalNoticeText').value || '').trim(),
        },
        searchProvider: $('#aggSearchProvider').value,
        searchApiKey: secretPayload($('#aggSearchKey')),
        dailyLimit: daily,
        similarityThreshold: thr,
        autoPickCount,
        autoSkipSensitive: $('#aggSkipSensitive').getAttribute('aria-checked') === 'true',
        autoRewriteAttempts,
        autoForceUpload: $('#aggAutoForceUpload').getAttribute('aria-checked') === 'true',
      },
    }, $('#saveAggregate'));
  }

  /* ---------------- 文风画像（core style.js normalizeProfile 固定形状） ----------------
   * profile = {version, name, updatedAt, enabled, qualitative:{opening,closing,sentenceRhythm,
   *           petPhrases,subtitleStyle,punctuationEmoji}, bannedWords:[], topBigrams, stats, sampleCount}
   * 渲染层只编辑 qualitative 与 bannedWords，其余字段原样保留交给主进程归一。 */
  const PROFILE_TEXT_FIELDS = [
    ['opening', '#spOpening'],
    ['closing', '#spClosing'],
    ['sentenceRhythm', '#spRhythm'],
    ['petPhrases', '#spPetPhrases'],
    ['subtitleStyle', '#spSubtitle'],
    ['punctuationEmoji', '#spPunct'],
  ];

  function applyProfile(profile, enabled) {
    const p = profile && typeof profile === 'object' ? profile : null;
    const q = (p && p.qualitative) || {};
    PROFILE_TEXT_FIELDS.forEach(([k, sel]) => { $(sel).value = typeof q[k] === 'string' ? q[k] : ''; });
    const banned = p && Array.isArray(p.bannedWords) ? p.bannedWords : [];
    $('#spBanned').value = banned.join(', ');
    // 启用态的权威来源是 cfg.style.enabled（style:profile:get 返回的 enabled 字段）
    const on = typeof enabled === 'boolean' ? enabled : !!(p && p.enabled);
    const usable = profileHasContent(p);
    App.setSwitch($('#styleProfileSwitch'), usable ? on : false);
    // 「有画像」= 有实际内容：空对象（saveContent 采集空表单产生的）不算
    $('#styleProfileSwitch').disabled = !usable;
    $('#styleProfileSwitch').title = usable ? '' : '先「一键分析文风」或在下方填写画像，再启用';
    const hint = $('#styleProfileHint');
    if (hint) hint.style.display = usable ? 'none' : '';
  }

  /** 画像是否有实际内容（六项定性描述、禁用词或样文统计任一非空）。
   *  空表单生成的对象只是「空画像」，不能让启用开关变成可用，也不该覆盖 null 画像。 */
  function profileHasContent(p) {
    if (!p || typeof p !== 'object') return false;
    const q = p.qualitative && typeof p.qualitative === 'object' ? p.qualitative : {};
    const anyText = Object.values(q).some((v) => typeof v === 'string' && v.trim());
    const anyBanned = Array.isArray(p.bannedWords) && p.bannedWords.length > 0;
    const anyStats = (Number(p.sampleCount) || 0) > 0 || (Array.isArray(p.topBigrams) && p.topBigrams.length > 0);
    return !!(anyText || anyBanned || anyStats);
  }

  /** 收集画像：保留已有 profile 的其他字段（topBigrams/stats/sampleCount/name），覆盖可编辑项 */
  function collectProfile() {
    const base = (view.profile && typeof view.profile === 'object')
      ? JSON.parse(JSON.stringify(view.profile))
      : ((view.cfg && view.cfg.style && view.cfg.style.profile && typeof view.cfg.style.profile === 'object')
        ? JSON.parse(JSON.stringify(view.cfg.style.profile)) : {});
    const q = (typeof base.qualitative === 'object' && base.qualitative !== null) ? base.qualitative : {};
    PROFILE_TEXT_FIELDS.forEach(([k, sel]) => { q[k] = $(sel).value.trim(); });
    base.qualitative = q;
    base.bannedWords = $('#spBanned').value.split(/[,，、\n]+/).map((s) => s.trim()).filter(Boolean);
    if (base.enabled === undefined) base.enabled = $('#styleProfileSwitch').getAttribute('aria-checked') === 'true';
    return base;
  }

  /** 样文添加时间：按本地时区显示（原先直接 slice ISO 串，会比本地时间慢 8 小时） */
  function fmtSampleTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
    const pad = (n) => String(n).padStart(2, '0');
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    const dayKey = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    return (dayKey === App.todayKey() ? '今天 ' : dayKey + ' ') + hm;
  }

  /* ---------------- 文章样本库（style:samples:* 通道，主进程持久化 data/style-samples/） ---------------- */

  function renderSamples() {
    const box = $('#sampleList');
    if (!view.samples.length) {
      box.innerHTML = '<div class="sample-list-empty">还没有样文。粘贴一篇，或导入一个装着 .txt / .md / .html 的文件夹。</div>';
      return;
    }
    // core loadSamples：{id, name, text, words, addedAt}（启用粒度在文风画像层，不做单篇开关）
    box.innerHTML = view.samples.map((s) =>
      '<div class="sample-item" data-sid="' + escapeHtml(s.id) + '">' +
      '  <span class="si-ico"><i class="fa-regular fa-file-lines"></i></span>' +
      '  <span class="si-name" title="' + escapeHtml(s.name) + '">' + escapeHtml(s.name) + '</span>' +
      '  <span class="si-meta">' + App.fmtNum(s.words) + ' 字 · ' + escapeHtml(fmtSampleTime(s.addedAt)) + '</span>' +
      '  <button class="icon-btn danger" title="删除样本" data-si-del="' + escapeHtml(s.id) + '"><i class="fa-regular fa-trash-can"></i></button>' +
      '</div>'
    ).join('');
    $$('[data-si-del]', box).forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await App.api.invoke('style:samples:delete', { id: b.dataset.siDel });
        App.toast('样本已删除');
        await refreshSamples();
      } catch (e) {
        b.disabled = false;
        App.handleErr(e, '样本删除失败');
      }
    }));
  }

  async function refreshSamples() {
    try {
      const data = await App.api.invoke('style:samples:list', {});
      view.samples = (data && (data.items || data.samples)) || [];
    } catch (e) {
      view.samples = [];
      App.handleErr(e, '样本列表读取失败');
    }
    renderSamples();
  }

  async function refreshProfile() {
    try {
      const data = await App.api.invoke('style:profile:get', {});
      const p = (data && data.profile) || null;
      view.profile = p;
      applyProfile(p, data ? data.enabled : undefined);
    } catch (e) {
      view.profile = null;
      applyProfile(null, false);
      App.handleErr(e, '文风画像读取失败');
    }
  }

  async function analyzeProfile() {
    const btn = $('#sampleAnalyzeBtn');
    const restore = App.setBusy(btn, App.BUSY_ICON + '正在分析…');
    const hint = $('#sampleAnalyzeHint');
    hint.style.display = 'none';
    try {
      const data = await App.api.invoke('style:analyze', {});
      const p = (data && data.profile) || data || null;
      view.profile = p;
      // 后端在分析成功时会自动置 style.enabled=true 并在响应里返回 enabled：启用态以它为准。
      // 读分析前的 view.cfg 快照会让开关停在「关闭」而实际已启用（两个权威源）。
      const enabled = data && typeof data.enabled === 'boolean'
        ? data.enabled
        : (view.cfg && view.cfg.style ? view.cfg.style.enabled : undefined);
      if (view.cfg && view.cfg.style) {
        view.cfg.style.profile = p;
        if (typeof enabled === 'boolean') view.cfg.style.enabled = enabled;
      }
      if (p) applyProfile(p, enabled);
      hint.textContent = '分析完成' + (p && p.sampleCount != null ? '（基于 ' + p.sampleCount + ' 篇样文）' : '') +
        '，画像已启用（生成时自动注入），可直接修改后保存。';
      hint.style.display = 'block';
      App.toast('文风画像已生成');
    } catch (e) {
      hint.textContent = e.message + (e.hint ? ' ' + e.hint : '');
      hint.style.display = 'block';
      App.handleErr(e, '文风分析失败');
    } finally {
      restore();
    }
  }

  function saveApp() {
    if (!view.cfg) return;
    const app = Object.assign({}, view.cfg.app || {});
    app.autoLaunch = $('#appAutoLaunchSwitch').getAttribute('aria-checked') === 'true';
    app.closeToTray = $('#appCloseToTraySwitch').getAttribute('aria-checked') === 'true';
    app.notify = $('#appNotifySwitch').getAttribute('aria-checked') === 'true';
    // 定时开关单独走 schedule:set（与仪表盘同一数据源），避免整包覆盖；
    // 优先取全局最新 schedule 状态，防止覆盖用户在仪表盘刚做的修改
    if (App.state.schedule) {
      app.schedule = { enabled: App.state.schedule.enabled, time: App.state.schedule.time };
    } else if (view.cfg.app && view.cfg.app.schedule) {
      app.schedule = view.cfg.app.schedule;
    }
    saveConfig({ app }, $('#saveApp'));
  }

  /* ---------------- 表单回填 ---------------- */
  function applyConfig(cfg) {
    view.cfg = cfg;
    // 同步全局缓存：雷达页空态提示、compose 素材草稿等读的都是 App.state.cfg，
    // 只在启动时刷新会让它们在设置保存后仍显示旧值。
    App.state.cfg = cfg;
    if (!cfg) return;
    const w = cfg.wechat || {};
    $('#wxAppid').value = w.appId || '';
    setSecret($('#wxSecret'), w.appSecret);
    view.hasWxSecret = !!(w.appSecret && String(w.appSecret).trim());

    const l = cfg.llm || {};
    $('#llmUrl').value = l.baseUrl || '';
    setSecret($('#llmKey'), l.apiKey);
    view.hasLlmKey = !!(l.apiKey && String(l.apiKey).trim());
    reflectPreset(l.baseUrl || '');
    const modelSel = $('#llmModel');
    const opt = Array.from(modelSel.options).find((o) => o.value !== '__custom' && o.value === l.model);
    if (opt) {
      modelSel.value = l.model;
      $('#llmCustomModel').style.display = 'none';
    } else if (l.model) {
      modelSel.value = '__custom';
      $('#llmCustomModel').style.display = '';
      $('#llmCustomModel').value = l.model;
    } else {
      modelSel.selectedIndex = 0;
      $('#llmCustomModel').style.display = 'none';
    }
    $('#tempRange').value = String(typeof l.temperature === 'number' ? l.temperature : 0.7);
    $('#tempVal').textContent = $('#tempRange').value;

    const c = cfg.content || {};
    $('#repoPath').value = c.repoPath || '';
    $('#coverName').textContent = c.coverPath || '';
    $('#authorName').value = c.author || '';
    $('#audienceInput').value = c.audience || '';
    $('#styleExtraInput').value = c.styleExtra || '';
    const ai = c.aiDisclosure || {};
    App.setSwitch($('#aiDisclosureSwitch'), ai.enabled !== false);
    $('#aiDisclosureText').value = ai.text || '本文由 AI 生成，经人工审阅修改';

    // v2：项目背景（所有模式共用；键名对齐 core config.js project.*）
    const p = cfg.project || {};
    $('#projectDescInput').value = p.description || '';
    $('#projectTechTermsInput').value = p.techTerms || '';

    // v2：文风画像（style.profile 为对象；权威态由 style:profile:get 刷新，此处先按 config 回填）
    const st = cfg.style || {};
    applyProfile(st.profile || null, st.enabled);

    // v2：聚合来源配置（键名对齐 core config.js aggregate.*；searchApiKey 同密钥语义）
    const agg = cfg.aggregate || {};
    $('#aggKeywords').value = Array.isArray(agg.keywords) ? agg.keywords.join(' ') : '';
    $('#aggWhitelist').value = Array.isArray(agg.whitelist) ? agg.whitelist.join('\n') : '';
    // 文末领域提示（aggregate.verticalNotice：{enabled, text}）
    const vn = agg.verticalNotice || {};
    App.setSwitch($('#aggVerticalNoticeSwitch'), vn.enabled === true);
    $('#aggVerticalNoticeText').value = String(vn.text || '');
    $('#aggSearchProvider').value = agg.searchProvider || 'bocha';
    setSecret($('#aggSearchKey'), agg.searchApiKey);
    view.hasSearchKey = !!(agg.searchApiKey && String(agg.searchApiKey).trim());
    $('#aggDailyLimit').value = agg.dailyLimit != null ? agg.dailyLimit : 10;
    $('#aggSimThreshold').value = agg.similarityThreshold != null ? agg.similarityThreshold : 0.3;
    // v2.4：选题雷达全自动策略
    $('#aggAutoPickCount').value = String(agg.autoPickCount != null ? agg.autoPickCount : 1);
    App.setSwitch($('#aggSkipSensitive'), agg.autoSkipSensitive !== false);
    $('#aggAutoRewriteAttempts').value = String(agg.autoRewriteAttempts != null ? agg.autoRewriteAttempts : 5);
    App.setSwitch($('#aggAutoForceUpload'), agg.autoForceUpload !== false);

    const a = cfg.app || {};
    App.setSwitch($('#appAutoLaunchSwitch'), a.autoLaunch !== false);
    App.setSwitch($('#appCloseToTraySwitch'), a.closeToTray !== false);
    App.setSwitch($('#appNotifySwitch'), a.notify !== false);
    reflectCloseToTray();

    updateTestWxGate();
    updateTestLlmGate();
    updateSearchKeyHint();
  }

  /** 「关闭窗口最小化到托盘」的行为说明随开关变化（否则关闭时仍写「不退出应用」） */
  function reflectCloseToTray() {
    const el = $('#closeToTrayDesc');
    if (!el) return;
    const on = $('#appCloseToTraySwitch').getAttribute('aria-checked') === 'true';
    el.textContent = on ? '关闭按钮不退出应用，任务照常执行' : '关闭按钮直接退出应用（任务不会继续）';
  }

  function reflectPreset(url) {
    let matched = false;
    $$('#presetChips .pchip').forEach((chip) => {
      const on = chip.dataset.url && chip.dataset.url === url;
      chip.classList.toggle('on', on);
      if (on) matched = true;
    });
    if (!matched) $$('#presetChips .pchip').forEach((chip) => chip.classList.toggle('on', !chip.dataset.url));
  }

  /* ---------------- 页签切换 ---------------- */
  function bindTabs() {
    $$('#setTabs .tab-btn').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
  }

  /** 定位页签（供「聚合来源配置」等跨页入口使用：App.showSettingsTab('aggregate')） */
  function showTab(tab) {
    const btn = $('#setTabs .tab-btn[data-tab="' + tab + '"]');
    if (!btn) return;
    $$('#setTabs .tab-btn').forEach((t) => t.classList.remove('on'));
    btn.classList.add('on');
    $$('.panel').forEach((p) => p.classList.toggle('on', p.dataset.panel === tab));
  }

  /* ---------------- 初始化 ---------------- */
  async function refresh() {
    try {
      const data = await App.api.invoke('config:get');
      applyConfig(data.config);
      App.state.wizardDone = !!data.wizardDone;
    } catch (e) {
      App.handleErr(e, '配置读取失败');
      return;
    }
    try {
      const { ip } = await App.api.invoke('net:public-ip');
      App.state.ip = ip;
      $('#localIp').textContent = ip || '获取失败';
    } catch (e) {
      $('#localIp').textContent = '获取失败';
    }
    if (App.state.schedule) {
      App.setSwitch($('#appScheduleSwitch'), App.state.schedule.enabled);
      if (document.activeElement !== $('#appSchedTime')) {
        $('#appSchedTime').value = App.state.schedule.time || '09:30';
      }
      if (document.activeElement !== $('#appSchedMode')) {
        $('#appSchedMode').value = App.state.schedule.mode || 'auto';
      }
    }
  }

  App.viewInits.push(function () {
    bindTabs();
    watchSecret($('#wxSecret'));
    watchSecret($('#llmKey'));
    watchSecret($('#aggSearchKey')); // v2 第三个密钥框：漏绑会让「已保存」但新 Key 被当成占位符丢弃

    $('#wxAppid').addEventListener('input', updateTestWxGate);
    $('#wxSecret').addEventListener('input', updateTestWxGate);
    $('#llmKey').addEventListener('input', updateTestLlmGate);

    $('#testWx').addEventListener('click', testWx);
    $('#testLlm').addEventListener('click', testLlm);
    $('#saveWx').addEventListener('click', saveWx);
    $('#saveLlm').addEventListener('click', saveLlm);
    $('#saveContent').addEventListener('click', saveContent);
    $('#saveProject').addEventListener('click', saveProject);
    $('#saveAggregate').addEventListener('click', saveAggregate);
    // v2.2：切换搜索服务商时同步刷新 Key 栏说明（DeepSeek 可留空）
    $('#aggSearchProvider').addEventListener('change', updateSearchKeyHint);
    $('#saveApp').addEventListener('click', saveApp);

    // v2：文章样本库（style:samples:* 通道）
    refreshSamples();
    refreshProfile();
    $('#samplePasteBtn').addEventListener('click', () => {
      $('#sampleNameInput').value = '';
      $('#sampleTextInput').value = '';
      $('#sampleModalHint').textContent = '';
      App.openOverlay('sampleModal');
      $('#sampleNameInput').focus();
    });
    $('#sampleFolderBtn').addEventListener('click', async () => {
      try {
        // ipc 契约：dialog:pick-sample-folder → {path}；style:samples:import {dirPath} 单层扫描 .txt/.md/.html
        const { path } = await App.api.invoke('dialog:pick-sample-folder', {});
        if (!path) return;
        const restore = App.setBusy($('#sampleFolderBtn'), App.BUSY_ICON + '导入中…');
        try {
          const res = await App.api.invoke('style:samples:import', { dirPath: path });
          await refreshSamples();
          const errs = (res && res.errors) || [];
          const dup = res && res.duplicates ? res.duplicates : 0;
          const n = res && res.items ? res.items.length : 0;
          App.toast('样文导入完成：新增 ' + n + ' 篇' + (dup ? '，重复跳过 ' + dup + ' 篇' : '') +
            (errs.length ? '，' + errs.length + ' 个文件失败：' + errs[0] : ''));
        } finally { restore(); }
      } catch (e) { App.handleErr(e, '文件夹导入失败'); }
    });
    $('#sampleAnalyzeBtn').addEventListener('click', analyzeProfile);
    $('#sampleSaveBtn').addEventListener('click', async () => {
      const text = $('#sampleTextInput').value.trim();
      if (!text) { $('#sampleModalHint').textContent = '先把样文正文贴进来'; return; }
      const restore = App.setBusy($('#sampleSaveBtn'), App.BUSY_ICON + '保存中…');
      try {
        const res = await App.api.invoke('style:samples:add', { name: $('#sampleNameInput').value.trim(), text });
        App.closeOverlay('sampleModal');
        await refreshSamples();
        App.toast(res && res.duplicate ? '该样文已存在（内容相同，未重复入库）' : '样文已入库');
      } catch (e) {
        $('#sampleModalHint').textContent = e.message || '保存失败';
      } finally { restore(); }
    });

    // v2：文风画像启用开关（style:profile:toggle；权威态是 cfg.style.enabled，无画像时按钮已禁用）
    App.bindSwitch($('#styleProfileSwitch'), async (on) => {
      try {
        const data = await App.api.invoke('style:profile:toggle', { enabled: on });
        view.profile = (data && data.profile) || null;
        if (view.cfg && view.cfg.style) view.cfg.style.enabled = !!(data ? data.enabled : on);
        applyProfile(view.profile, data ? data.enabled : on);
        App.toast(on ? '文风画像已启用，生成时自动注入' : '文风画像已停用');
      } catch (e) {
        App.setSwitch($('#styleProfileSwitch'), !on); // 失败回滚
        App.handleErr(e, '文风画像开关设置失败');
      }
    });

    // AI 内容标识开关（保存时读取 aria-checked；此前只回填不绑定，点击无反应）
    App.bindSwitch($('#aiDisclosureSwitch'));

    // 聚合页：文末领域提示开关（保存时读取 aria-checked，由「保存更改」写入 config:set）
    App.bindSwitch($('#aggVerticalNoticeSwitch'));

    // 应用页三个开关（此前的死控件）：点击切换状态，再由「保存更改」写入 config:set。
    // 定时开关例外——它直接驱动 schedule:set（与仪表盘一致）。
    App.bindSwitch($('#appAutoLaunchSwitch'));
    App.bindSwitch($('#appCloseToTraySwitch'), () => reflectCloseToTray());
    App.bindSwitch($('#appNotifySwitch'));

    // 聚合来源 Key 显隐：已由 App.bindAllEyes 按 data-eye 统一绑定，无需逐个绑（重复绑定会切换两次）

    // 服务商预设
    $$('#presetChips .pchip').forEach((chip) => chip.addEventListener('click', () => {
      $$('#presetChips .pchip').forEach((c) => c.classList.remove('on'));
      chip.classList.add('on');
      if (chip.dataset.url) $('#llmUrl').value = chip.dataset.url;
    }));

    // 模型自定义
    $('#llmModel').addEventListener('change', () => {
      $('#llmCustomModel').style.display = $('#llmModel').value === '__custom' ? '' : 'none';
    });

    // 温度
    $('#tempRange').addEventListener('input', (e) => { $('#tempVal').textContent = e.target.value; });

    // 选择器（契约：dialog:pick-repo / dialog:pick-cover → {path|null}，不是裸字符串）
    $('#browseRepo').addEventListener('click', async () => {
      try {
        const picked = await App.api.invoke('dialog:pick-repo');
        const p = typeof picked === 'string' ? picked : (picked && picked.path) || '';
        if (p) $('#repoPath').value = p;
      } catch (e) { App.handleErr(e, '选择文件夹失败'); }
    });
    $('#coverDrop').addEventListener('click', async () => {
      try {
        const picked = await App.api.invoke('dialog:pick-cover');
        const p = typeof picked === 'string' ? picked : (picked && picked.path) || '';
        if (p) {
          if (view.cfg && view.cfg.content) view.cfg.content.coverPath = p;
          $('#coverName').textContent = p;
        }
      } catch (e) { App.handleErr(e, '选择封面失败'); }
    });

    // IP 白名单卡
    $('#copyIp').addEventListener('click', () => App.copyText($('#localIp').textContent, '已复制到剪贴板'));
    $('#ipWhitelistBtn').addEventListener('click', () => App.openExternal('https://mp.weixin.qq.com/'));

    // 应用页签：定时开关直接驱动 schedule:set（与仪表盘一致）
    App.bindSwitch($('#appScheduleSwitch'), async (on) => {
      // 只有「仓库自动」才要求代码仓库路径；内容池 / 选题雷达不需要（与仪表盘同一判据）
      const mode = (App.state.schedule && App.state.schedule.mode) || 'auto';
      if (on && mode === 'auto' && App.autoConfigMissing()) {
        App.setSwitch($('#appScheduleSwitch'), false);
        App.toast('仓库自动需要先配置代码仓库路径：请在「内容与文风」页选择后再开启每日执行', 'err');
        App.showSettingsTab('content');
        return;
      }
      try {
        const s = await App.api.invoke('schedule:set', { enabled: on });
        App.state.schedule = s;
        App.updateTrayPill(s);
        App.renderNextRunChip(s);
        if (App.dashboardView) App.dashboardView.refresh();
      } catch (e) {
        App.handleErr(e);
        App.setSwitch($('#appScheduleSwitch'), !on); // 失败回滚
      }
    });

    // v2.4：应用页签也能改每日执行时间（与仪表盘同一数据源 schedule:set）
    $('#appSchedTime').addEventListener('change', async () => {
      const v = $('#appSchedTime').value.trim();
      if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(v)) {
        App.toast('时间格式应为 24 小时制 HH:MM，例如 09:30', 'err');
        $('#appSchedTime').value = (App.state.schedule && App.state.schedule.time) || '09:30';
        return;
      }
      const norm = v.split(':').map((x) => x.padStart(2, '0')).join(':');
      try {
        const s = await App.api.invoke('schedule:set', { time: norm });
        App.state.schedule = s;
        App.updateTrayPill(s);
        App.renderNextRunChip(s);
        App.toast('每日执行时间已改为 ' + norm);
        if (App.dashboardView) App.dashboardView.refresh();
      } catch (e) {
        App.handleErr(e);
        $('#appSchedTime').value = (App.state.schedule && App.state.schedule.time) || '09:30';
      }
    });

    // v2.4：定时任务类型（仓库自动 / 内容池 / 选题雷达）——定时关闭时也能先配好
    $('#appSchedMode').addEventListener('change', async () => {
      const next = $('#appSchedMode').value;
      const cur = (App.state.schedule && App.state.schedule.mode) || 'auto';
      if (next === cur) return;
      try {
        const s = await App.api.invoke('schedule:set', { mode: next });
        App.state.schedule = s;
        App.updateTrayPill(s);
        App.renderNextRunChip(s);
        App.toast(next === 'radar'
          ? '已切换为「选题雷达」：每天搜索全网，自动选排名最前的选题成文并上传'
          : next === 'pool'
            ? '已切换为「内容池」：每天从队列取最早一条题目自动成文'
            : '已切换为「仓库自动」：每天读代码提交写推文');
        if (App.dashboardView) App.dashboardView.refresh();
      } catch (e) {
        App.handleErr(e);
        $('#appSchedMode').value = (App.state.schedule && App.state.schedule.mode) || 'auto';
      }
    });

    // 导出配置
    $('#exportCfg').addEventListener('click', async () => {
      try {
        const { path } = await App.api.invoke('config:export');
        App.toast('已导出脱敏配置：' + path);
      } catch (e) { App.handleErr(e, '配置导出失败'); }
    });

    App.viewRefresh.settings = refresh;
    refresh();
  });

  App.settingsView = { showTab };
})();
