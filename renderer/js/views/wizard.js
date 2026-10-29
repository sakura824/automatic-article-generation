/* ============================================================
 * wizard.js —— 配置向导（5 屏：欢迎 → 公众号 → 大模型 → 内容 → 自检完成）
 * 数据源：config:get（回填）/ config:set（第 3→4 屏保存）/ wechat:test / llm:test /
 *        dialog:pick-repo / selfcheck:run + selfcheck:progress 事件
 * 每步可即时测试；完成页自动跑一键自检；完成后进入仪表盘。
 * ============================================================ */
(function () {
  'use strict';

  const App = window.App;
  const { $, $$ } = App;

  const WIZ_TITLES = ['欢迎', '第 1 步 · 公众号凭证', '第 2 步 · 大模型', '第 3 步 · 仓库与文风', '完成 · 自检'];
  let step = 0;
  let saving = false;
  let checking = false;

  /* ---------------- 渲染 ---------------- */
  function render() {
    $('#wizDots').innerHTML = WIZ_TITLES.map((_, i) => '<span class="wdot ' + (i <= step ? 'on' : '') + '"></span>').join('');
    $$('.wiz-pane').forEach((p) => p.classList.toggle('on', +p.dataset.wp === step));
    $('#wizStepLabel').textContent = WIZ_TITLES[step];
    $('#wizPrev').style.visibility = step === 0 ? 'hidden' : 'visible';
    const nextBtn = $('#wizNext');
    if (step === 0) nextBtn.innerHTML = '开始配置<i class="fa-solid fa-arrow-right"></i>';
    else if (step === 4) nextBtn.innerHTML = '进入工作台<i class="fa-solid fa-check"></i>';
    else nextBtn.innerHTML = '下一步<i class="fa-solid fa-arrow-right"></i>';
    if (step === 1) updateWxGate();
    if (step === 2) updateLlmGate();
    if (step === 3) updateRepoGate();
  }

  /* ---------------- 禁用态与原因 ---------------- */
  function setGate(btnId, hintId, reason) {
    const btn = $('#' + btnId);
    const hint = $('#' + hintId);
    if (!btn || !hint) return;
    btn.disabled = !!reason;
    btn.title = reason;
    hint.style.display = reason ? 'block' : 'none';
    hint.textContent = reason;
  }

  function hasStoredWxSecret() {
    return !!(App.state.cfg && App.state.cfg.wechat && App.state.cfg.wechat.appSecret);
  }
  function hasStoredLlmKey() {
    return !!(App.state.cfg && App.state.cfg.llm && App.state.cfg.llm.apiKey);
  }
  function wizSecretPayload() {
    const v = $('#wizSecret').value.trim();
    return v ? v : null;
  }
  function wizKeyPayload() {
    const v = $('#wizLlmKey').value.trim();
    return v ? v : null;
  }

  function updateWxGate() {
    const appid = $('#wizAppid').value.trim();
    const canTest = !!appid && (!!$('#wizSecret').value.trim() || hasStoredWxSecret());
    setGate('wizTestWx', 'wizTestWxHint',
      !appid ? '先填写 AppID，才能测试连接。'
        : (!canTest ? '先填写 AppSecret，才能测试连接（首次配置时必须填写）。' : ''));
    setGate('wizNext', 'wizAppidHint', appid ? '' : '先填写 AppID 才能继续下一步。');
  }
  function updateLlmGate() {
    const canTest = !!$('#wizLlmKey').value.trim() || hasStoredLlmKey();
    setGate('wizTestLlm', 'wizTestLlmHint', canTest ? '' : '先填写 API Key，才能测试连接（免费模型 glm-4.5-flash 也需要 Key）。');
    setGate('wizNext', 'wizLlmKeyHint', canTest ? '' : '先填写 API Key 才能继续下一步（免费模型 glm-4.5-flash 也可以）。');
  }
  function updateRepoGate() {
    // 代码仓库只是素材来源之一——素材成文 / 对话共创 / 选题雷达都不需要它，
    // 只有「仓库自动」模式（默认关闭）才要，因此这里不再强制必选。
    setGate('wizNext', 'wizRepoHint', '');
  }

  /* ---------------- 测试连接 ---------------- */
  async function testWx() {
    const btn = $('#wizTestWx');
    if (btn.disabled) return;
    const restore = App.setBusy(btn, App.BUSY_ICON + (App.demo ? '正在测试…' : '正在获取 access_token…'));
    const box = $('#wizTestWxResult');
    try {
      const { expiresIn } = await App.api.invoke('wechat:test', {
        appId: $('#wizAppid').value.trim(),
        appSecret: wizSecretPayload(),
      });
      box.innerHTML = App.banner('ok', '<b>连接成功。</b>access_token 有效期 ' + expiresIn + ' 秒，IP 已在白名单内，可以继续下一步。');
      box.classList.add('on');
    } catch (e) {
      let html = App.banner('err', '<b>' + escapeHtml(e.message) + '</b>' + (e.hint ? ' ' + escapeHtml(e.hint) : ''));
      if (e.errcode === 40164) {
        try { const { ip } = await App.api.invoke('net:public-ip'); App.state.ip = ip; } catch (_) { /* 保留旧值 */ }
        html += App.ipWhitelistCard(App.state.ip);
      }
      box.innerHTML = html;
      box.classList.add('on');
      App.bindIpCardActions(box, () => App.state.ip || $('#wizLocalIp').textContent);
    } finally {
      restore();
      updateWxGate();
    }
  }

  async function testLlm() {
    const btn = $('#wizTestLlm');
    if (btn.disabled) return;
    const restore = App.setBusy(btn, App.BUSY_ICON + (App.demo ? '正在测试…' : '正在调用模型…'));
    const box = $('#wizTestLlmResult');
    try {
      const res = await App.api.invoke('llm:test', {
        baseUrl: $('#wizLlmUrl').value.trim(),
        apiKey: wizKeyPayload(),
        model: $('#wizLlmModel').value,
      });
      box.innerHTML = App.banner('ok', '<b>连接成功。</b>模型 ' + escapeHtml(res.model) + ' 可用，延迟 ' + res.latencyMs + 'ms，可以继续下一步。');
      box.classList.add('on');
    } catch (e) {
      box.innerHTML = App.banner('err', '<b>' + escapeHtml(e.message) + '</b>' + (e.hint ? ' ' + escapeHtml(e.hint) : ''));
      box.classList.add('on');
    } finally {
      restore();
      updateLlmGate();
    }
  }

  /* ---------------- 保存配置 + 自检（第 3→4 屏） ---------------- */
  async function buildConfigPatch() {
    // 以已加载配置为底，仅覆盖向导内可编辑项；密钥 null = 保留已存值
    const cfg = JSON.parse(JSON.stringify(App.state.cfg || {}));
    cfg.wechat = cfg.wechat || {};
    cfg.wechat.appId = $('#wizAppid').value.trim();
    if (wizSecretPayload() !== null) cfg.wechat.appSecret = wizSecretPayload();

    cfg.llm = cfg.llm || {};
    cfg.llm.baseUrl = $('#wizLlmUrl').value.trim();
    if (wizKeyPayload() !== null) cfg.llm.apiKey = wizKeyPayload();
    cfg.llm.model = $('#wizLlmModel').value;

    cfg.content = cfg.content || {};
    cfg.content.repoPath = $('#wizRepo').value;
    cfg.content.audience = $('#wizAudience').value;
    cfg.content.styleExtra = $('#wizStyleExtra').value;

    // 已在设置页维护的项保持原样
    if (cfg.content.author === undefined) cfg.content.author = '';
    if (!cfg.content.aiDisclosure) cfg.content.aiDisclosure = { enabled: true, text: '本文由 AI 生成，经人工审阅修改' };
    if (!cfg.app) cfg.app = { schedule: { enabled: false, time: '09:30' }, autoLaunch: true, closeToTray: true, notify: true };
    // 「仓库自动」默认关闭；已存在（含用户显式开启过）的配置原样保留
    if (cfg.app.schedule && typeof cfg.app.schedule.enabled !== 'boolean') cfg.app.schedule.enabled = false;
    return cfg;
  }

  async function finishWizardChecks() {
    step = 4;
    render();
    $('#wizCheckDone').style.display = 'none';
    $('#wizCheckFail').style.display = 'none';
    App.resetChecks($('#wizChecks'));
    checking = true;
    $('#wizNext').disabled = true;
    try {
      const { items } = await App.api.invoke('selfcheck:run');
      const bad = (items || []).filter((it) => it.state === 'fail');
      if (bad.length) {
        const b = bad[0];
        $('#wizCheckFailMsg').textContent = (b.detail || '自检未通过') + (b.errcode ? '（errcode=' + b.errcode + '）' : '') +
          (b.hint ? ' ' + b.hint : '');
        $('#wizCheckFail').style.display = 'flex';
      } else {
        $('#wizCheckDone').style.display = 'flex';
      }
    } catch (e) {
      // 原始 JS 异常（如 “x is not a function”）不该出现在中文界面：给可操作兜底
      $('#wizCheckFailMsg').textContent = App.friendlyMessage(e, '自检执行失败，请查看运行日志') + (e && e.hint ? ' ' + e.hint : '');
      $('#wizCheckFail').style.display = 'flex';
    } finally {
      checking = false;
      $('#wizNext').disabled = false;
    }
  }

  async function goNext() {
    if (saving || checking) return;
    if (step === 4) {
      App.closeOverlay('wizard');
      const s = App.state.schedule;
      App.toast(s && s.enabled ? '配置完成，明天 ' + s.time + ' 见' : '配置完成');
      App.showView('dashboard');
      try { // 完成后刷新全局配置（含脱敏密钥、AI 标识文案）
        const data = await App.api.invoke('config:get');
        App.state.cfg = data.config;
        App.state.wizardDone = !!data.wizardDone;
        if (data.config && data.config.content && data.config.content.aiDisclosure) {
          App.state.aiDisclosureText = data.config.content.aiDisclosure.text || App.state.aiDisclosureText;
        }
      } catch (_) { /* 仪表盘 refresh 会再次拉取 */ }
      if (App.dashboardView) App.dashboardView.refresh();
      return;
    }
    if (step === 3) {
      // 完成页自动一键自检；先持久化向导内配置
      saving = true;
      const restore = App.setBusy($('#wizNext'), App.BUSY_ICON + '正在保存配置…');
      let patch;
      try { patch = await buildConfigPatch(); } catch (_) { restore(); saving = false; return; }
      try {
        const { config } = await App.api.invoke('config:set', patch);
        App.state.cfg = config;
      } catch (e) {
        App.handleErr(e, '配置保存失败，请检查填写内容');
        restore();
        saving = false;
        return;
      }
      restore();
      saving = false;
      await finishWizardChecks();
      return;
    }
    step++;
    render();
  }

  function goPrev() {
    if (saving || checking || step === 0) return;
    if (step === 4) { step = 3; render(); return; }
    step--;
    render();
  }

  /* ---------------- 打开 / 回填 ---------------- */
  function prefill() {
    const cfg = App.state.cfg;
    if (!cfg) return;
    $('#wizAppid').value = (cfg.wechat && cfg.wechat.appId) || '';
    $('#wizSecret').value = '';
    $('#wizLlmUrl').value = (cfg.llm && cfg.llm.baseUrl) || 'https://open.bigmodel.cn/api/paas/v4';
    $('#wizLlmKey').value = '';
    if (cfg.llm && cfg.llm.model) {
      const sel = $('#wizLlmModel');
      const opt = Array.from(sel.options).find((o) => o.value === cfg.llm.model);
      if (opt) sel.value = cfg.llm.model; else sel.selectedIndex = 0;
    }
    $('#wizRepo').value = (cfg.content && cfg.content.repoPath) || '';
    $('#wizAudience').value = (cfg.content && cfg.content.audience) || '';
    $('#wizStyleExtra').value = (cfg.content && cfg.content.styleExtra) || '';
    if (App.state.ip) $('#wizLocalIp').textContent = App.state.ip;
  }

  function open() {
    step = 0;
    prefill();
    render();
    $('#wizCheckDone').style.display = 'none';
    $('#wizCheckFail').style.display = 'none';
    App.resetChecks($('#wizChecks'));
    App.openOverlay('wizard');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ---------------- 初始化 ---------------- */
  App.viewInits.push(function () {
    $('#openWizard').addEventListener('click', open);
    $('#wizClose').addEventListener('click', () => App.closeOverlay('wizard'));
    $('#wizNext').addEventListener('click', goNext);
    $('#wizPrev').addEventListener('click', goPrev);
    $('#wizTestWx').addEventListener('click', testWx);
    $('#wizTestLlm').addEventListener('click', testLlm);
    $('#wizBrowse').addEventListener('click', async () => {
      try {
        // 约定：dialog:pick-repo → {path|null}，不能把整个对象塞进 input.value
        const picked = await App.api.invoke('dialog:pick-repo');
        const p = typeof picked === 'string' ? picked : (picked && picked.path) || '';
        if (p) {
          $('#wizRepo').value = p;
          updateRepoGate();
        }
      } catch (e) { App.handleErr(e, '选择文件夹失败'); }
    });

    $('#wizAppid').addEventListener('input', updateWxGate);
    $('#wizSecret').addEventListener('input', updateWxGate);
    $('#wizLlmKey').addEventListener('input', updateLlmGate);

    // 自检进度事件（向导第 4 屏 + 一键自检弹窗共用）
    App.api.on('selfcheck:progress', (p) => {
      if (!p) return;
      App.setCheckState($('#wizChecks'), p.index, p.state, p.detail);
      App.setCheckState($('#modalChecks'), p.index, p.state, p.detail);
    });

    App.wizard = { open };
    render();
  });
})();
