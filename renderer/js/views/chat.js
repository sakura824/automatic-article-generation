/* ============================================================
 * chat.js —— 对话共创（PRD v2 §2 模式 B / §7 会话通道）
 * 数据源（通道名对齐 preload v2 白名单，core/chat.js 形状）：
 *   chat:list   {}                → {items:[{id,title,createdAt,updatedAt,turns,lastMessage}]}
 *   chat:new    {}                → 会话对象 {id,title,createdAt,updatedAt,messages}
 *   chat:open   {id}              → {session:{id,title,updatedAt,messages:[{role,content,t}]}}
 *   chat:send   {id, content}     → {session, reply:{role,content,t}}（兼容 reply 为字符串）
 *   chat:delete {id}              → {}
 * 事件：chat:segment {sessionId, messageId, index, total, text}（分段流式回复）。
 * 「把这轮讨论整理成文章」：渲染层把转录本交给 compose 页预填（origin=对话），
 * 由 compose:generate {source:'material'} 完成成文——与「成文统一走 compose 通道」一致。
 * ============================================================ */
(function () {
  'use strict';

  const App = window.App;
  const { $, $$ } = App;

  const view = {
    sessions: [],
    sessionId: null,
    messages: [],
    sending: false,
    composing: false,
    segmenting: false, // 本轮回复已用 chat:segment 流式渲染，chat:send 返回后固化为正式消息
    segBuf: '',        // chat:segment 增量分段累积缓冲（每次发送前清空）
    pendingError: null, // 发送失败但未重试成功：切页再回来仍要能看到错误与「重试」，不能丢草稿
  };

  /** 发送失败气泡（含重试）；content 用于重试时回填输入框 */
  function appendErrorBubble(content, message, hint) {
    const box = $('#chatStream');
    if (!box) return;
    const old = $('#chatErrCard');
    if (old) old.remove();
    box.insertAdjacentHTML('beforeend',
      '<div class="chat-msg assistant err" id="chatErrCard"><span class="avatar"><i class="fa-solid fa-circle-exclamation"></i></span>' +
      '<div class="bubble">' + escapeHtml(message || '发送失败') + (hint ? ' ' + escapeHtml(hint) : '') +
      '<div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;">' +
      '<button class="btn btn-ghost btn-sm" id="chatRetryBtn"><i class="fa-solid fa-rotate-right"></i>重试</button>' +
      '<button class="btn btn-ghost btn-sm" id="chatGoSettingsBtn"><i class="fa-solid fa-gear"></i>去设置检查 Key</button>' +
      '</div></div></div>');
    box.scrollTop = box.scrollHeight;
    const retry = $('#chatRetryBtn');
    if (retry) retry.addEventListener('click', () => {
      const card = $('#chatErrCard');
      if (card) card.remove();
      $('#chatInput').value = content;
      send(true); // retry=true：不重复追加用户气泡，主进程也不重复落盘该条用户消息
    });
    const goSettings = $('#chatGoSettingsBtn');
    if (goSettings) goSettings.addEventListener('click', () => App.showSettingsTab('llm'));
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** 会话列表条目归一化（core listSessions：{id,title,createdAt,updatedAt,turns,lastMessage}） */
  function normalizeSessionRow(s, i) {
    return {
      id: String((s && (s.id || s.sessionId)) || 'chat-' + (i + 1)),
      title: (s && s.title) || '',
      updatedAt: (s && s.updatedAt) || null,
      turns: s && s.turns != null ? s.turns : ((s && s.messageCount) || 0),
      lastMessage: (s && s.lastMessage) || '',
    };
  }

  /* ---------------- 消息渲染 ---------------- */
  function hm(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(11, 16);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function bubbleHtml(m) {
    const isUser = m.role === 'user';
    const avatar = isUser ? '<i class="fa-regular fa-user"></i>' : '<i class="fa-solid fa-robot"></i>';
    return '<div class="chat-msg ' + (isUser ? 'user' : 'assistant') + '">' +
      '<span class="avatar">' + avatar + '</span>' +
      '<div class="bubble">' + escapeHtml(m.content) + (m.t ? '<div style="font-size:10.5px;opacity:.6;margin-top:4px;">' + escapeHtml(hm(m.t)) + '</div>' : '') + '</div>' +
      '</div>';
  }

  function renderStream() {
    const box = $('#chatStream');
    if (!view.messages.length) {
      box.innerHTML = $('#chatEmptyTpl').innerHTML;
      $$('#chatStream [data-suggest]').forEach((c) => c.addEventListener('click', () => {
        $('#chatInput').value = c.dataset.suggest;
        $('#chatInput').focus();
        send();
      }));
    } else {
      box.innerHTML = view.messages.map(bubbleHtml).join('');
    }
    box.scrollTop = box.scrollHeight;
    $('#chatMsgCount').innerHTML = '<i class="fa-regular fa-comment-dots"></i>' + view.messages.length + ' 条';
    $('#chatToComposeBtn').disabled = view.messages.length === 0;
    $('#chatDeleteBtn').disabled = !view.sessionId;
    // 未重试成功的失败草稿：重新进入对话页时恢复错误卡与输入框草稿
    if (view.pendingError) {
      appendErrorBubble(view.pendingError.content, view.pendingError.message, view.pendingError.hint);
      if (!$('#chatInput').value.trim()) $('#chatInput').value = view.pendingError.content;
    }
  }

  function updateCount() {
    $('#chatMsgCount').innerHTML = '<i class="fa-regular fa-comment-dots"></i>' + view.messages.length + ' 条';
    $('#chatToComposeBtn').disabled = view.messages.length === 0;
  }

  function appendMessage(m) {
    view.messages.push(m);
    if ($$('#chatStream .chat-msg').length === 0) renderStream();
    else {
      const box = $('#chatStream');
      box.insertAdjacentHTML('beforeend', bubbleHtml(m));
      box.scrollTop = box.scrollHeight;
    }
    updateCount();
  }

  function showTyping() {
    const box = $('#chatStream');
    box.insertAdjacentHTML('beforeend',
      '<div class="chat-msg assistant" id="chatTyping"><span class="avatar"><i class="fa-solid fa-robot"></i></span>' +
      '<div class="bubble typing" id="chatTypingText"><i class="fa-solid fa-spinner spin"></i> AI 正在思考…</div></div>');
    box.scrollTop = box.scrollHeight;
  }
  function setTypingText(text) {
    const el = $('#chatTypingText');
    if (el) el.textContent = text;
  }
  function hideTyping() {
    const el = $('#chatTyping');
    if (el) el.remove();
  }

  /* ---------------- 会话加载 ---------------- */
  function renderSessions() {
    const sel = $('#chatSessionSel');
    sel.innerHTML = view.sessions.map((s) => {
      const label = (s.title || '未命名对话') + '（' + s.turns + ' 条）';
      return '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(label) + '</option>';
    }).join('');
    if (view.sessionId) sel.value = view.sessionId;
  }

  async function loadSessions() {
    try {
      const data = await App.api.invoke('chat:list', {});
      const rows = (data && (data.items || data.sessions)) || [];
      view.sessions = rows.map(normalizeSessionRow);
    } catch (e) {
      view.sessions = [];
      renderStream();
      App.handleErr(e, '会话列表读取失败');
      return;
    }
    if (view.sessions.length && !view.sessionId) view.sessionId = view.sessions[0].id;
    if (!view.sessions.length) { await newSession(true); return; }
    renderSessions();
    await loadSessionMessages();
  }

  async function loadSessionMessages() {
    if (!view.sessionId) { view.messages = []; renderStream(); return; }
    try {
      const data = await App.api.invoke('chat:open', { id: view.sessionId });
      const s = (data && data.session) || data || {};
      view.messages = Array.isArray(s.messages) ? s.messages : [];
    } catch (e) {
      view.messages = [];
      App.handleErr(e, '会话历史读取失败');
    }
    renderStream();
  }

  async function newSession(silent) {
    try {
      const data = await App.api.invoke('chat:new', {});
      const s = (data && data.session) || data || {};
      if (!s.id) throw new Error('主进程未返回新会话 id');
      view.sessionId = s.id;
      view.messages = [];
      // 重新拉列表并选中新会话
      const listData = await App.api.invoke('chat:list', {});
      const rows = (listData && (listData.items || listData.sessions)) || [];
      view.sessions = rows.map(normalizeSessionRow);
      renderSessions();
      renderStream();
      if (!silent) App.toast('已开启新对话');
    } catch (e) {
      App.handleErr(e, '新建会话失败');
    }
  }

  async function deleteSession() {
    if (!view.sessionId) return;
    const btn = $('#chatDeleteBtn');
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.title = '再点一次确认删除当前会话';
      App.toast('再点一次「删除会话」确认删除（不可恢复）');
      setTimeout(() => { btn.dataset.armed = ''; btn.title = '删除当前会话'; }, 4000);
      return;
    }
    btn.dataset.armed = '';
    try {
      await App.api.invoke('chat:delete', { id: view.sessionId });
      view.sessionId = null;
      view.messages = [];
      App.toast('会话已删除');
      await loadSessions();
    } catch (e) {
      App.handleErr(e, '会话删除失败');
    }
  }

  /* ---------------- 发送 ---------------- */
  async function send(retryFlag) {
    const isRetry = retryFlag === true; // 严格比较：事件对象/其它真值都不算重试
    if (view.sending) return;
    const input = $('#chatInput');
    const content = input.value.trim();
    if (!content) { input.focus(); return; }
    view.sending = true;
    view.segmenting = false;
    view.segBuf = ''; // 清空上一轮分段缓冲，避免本轮 typing 气泡残留旧回复前缀
    const sendSessionId = view.sessionId; // 快照：等待期间用户可能切换会话
    $('#chatSendBtn').disabled = true;
    input.value = '';
    // 重试：主进程在调用 LLM 前已把用户消息落盘，本地也已有那条气泡——
    // 再 append 一次会得到两条相同提问（污染上下文），因此重试只补发请求。
    if (!isRetry) appendMessage({ role: 'user', content, t: new Date().toISOString() });
    view.pendingError = null; // 新一轮发送开始，旧的失败草稿清理掉
    showTyping();
    try {
      // ipc 契约：chat:send {sessionId, text, retry?} → {session, reply, model, dropped}
      const res = await App.api.invoke('chat:send', { sessionId: sendSessionId, text: content, retry: isRetry });
      const reply = res && (typeof res.reply === 'string'
        ? { role: 'assistant', content: res.reply }
        : (res && res.reply) || { role: 'assistant', content: (res && res.raw) || '（空回复）' });
      hideTyping();
      // 等待期间用户切到了别的会话：回复属于原会话，不能追加进当前消息流、也不能把 sessionId 拽回去，
      // 只静默刷新会话列表（回复已由主进程落盘，切回原会话即可看到）。
      if (view.sessionId !== sendSessionId) {
        try {
          const listData = await App.api.invoke('chat:list', {});
          view.sessions = ((listData && (listData.items || listData.sessions)) || []).map(normalizeSessionRow);
          renderSessions();
        } catch (_) { /* 列表刷新失败不影响对话 */ }
        return;
      }
      if (res && res.session && res.session.id && res.session.id !== sendSessionId) {
        view.sessionId = res.session.id; // 主进程可能返回归档后的会话 id
      }
      if (view.segmenting) {
        // 分段（chat:segment）已把内容渲染进 typing 气泡：回复气泡随即被隐藏，
        // 必须把累积文本固化为正式消息，否则真实主进程路径下回复会整条消失
        appendMessage({ role: 'assistant', content: view.segBuf || reply.content || '（空回复）', t: reply.t || new Date().toISOString() });
        view.segBuf = '';
      } else {
        appendMessage({ role: 'assistant', content: reply.content || '（空回复）', t: reply.t || new Date().toISOString() });
      }
      // 会话标题可能已更新（core addMessage 以首条用户消息为题），静默同步下拉
      try {
        const listData = await App.api.invoke('chat:list', {});
        view.sessions = ((listData && (listData.items || listData.sessions)) || []).map(normalizeSessionRow);
        renderSessions();
      } catch (_) { /* 列表刷新失败不影响对话 */ }
    } catch (e) {
      hideTyping();
      // 失败的消息没有落盘（缺 Key 等前置错误在 addMessage 之前抛出）：保留草稿与错误卡，
      // 切页去设置修好再回来仍然能一键重试，而不是重打一遍。
      view.pendingError = { content, message: e.message || '发送失败', hint: e.hint || '' };
      if (!$('#chatInput').value.trim()) $('#chatInput').value = content;
      appendErrorBubble(content, view.pendingError.message, view.pendingError.hint);
      App.handleErr(e, '发送失败');
    } finally {
      view.sending = false;
      $('#chatSendBtn').disabled = false;
      input.focus();
    }
  }

  /* ---------------- 整理成文章 ----------------
   * 走主进程 compose:generate {mode:'chat', sessionId}（core composeFromSession），
   * 成文已自动落盘并入历史，随后带着上下文进创作页编辑器继续修改。 */
  async function toCompose() {
    if (!view.messages.length) { App.toast('先聊几轮，再整理成文章', 'err'); return; }
    if (view.composing) return;
    view.composing = true;
    const btn = $('#chatToComposeBtn');
    const restore = App.setBusy(btn, App.BUSY_ICON + 'AI 正在整理成文…');
    try {
      const res = await App.api.invoke('compose:generate', { mode: 'chat', sessionId: view.sessionId });
      App.composeView.loadComposed(res, { mode: 'chat', sessionId: view.sessionId }); // 内部切换到创作页并刷新历史
    } catch (e) {
      App.handleErr(e, '整理成文章失败');
    } finally {
      view.composing = false;
      restore();
    }
  }

  /* ---------------- 初始化 ---------------- */
  App.viewInits.push(function () {
    // 注意：不能直接传 send —— addEventListener 会把 MouseEvent 当第一个参数（truthy）误判为重试
    $('#chatSendBtn').addEventListener('click', () => send());
    $('#chatNewBtn').addEventListener('click', () => newSession(false));
    $('#chatDeleteBtn').addEventListener('click', deleteSession);
    $('#chatToComposeBtn').addEventListener('click', toCompose);
    $('#chatSessionSel').addEventListener('change', () => {
      view.sessionId = $('#chatSessionSel').value || null;
      loadSessionMessages();
    });
    $('#chatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    // 分段流式回复（ipc 契约：chat:segment {sessionId, index, total, text, last}，text 为增量分段）
    App.api.on('chat:segment', (seg) => {
      if (!seg || !seg.text || seg.sessionId !== view.sessionId) return;
      if ($$('#chatStream .chat-msg').length === 0) return;
      view.segmenting = true;
      view.segBuf = (view.segBuf || '') + String(seg.text);
      setTypingText(view.segBuf);
      const box = $('#chatStream');
      box.scrollTop = box.scrollHeight;
    });

    // 空态模板移入内存，避免占位节点干扰流渲染
    const tpl = document.createElement('div');
    tpl.id = 'chatEmptyTpl';
    tpl.style.display = 'none';
    tpl.innerHTML = $('#chatStream').innerHTML;
    document.body.appendChild(tpl);

    App.viewRefresh.chat = loadSessions;
    loadSessions();
  });
})();
