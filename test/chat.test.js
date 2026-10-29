'use strict';
/**
 * chat.test.js —— 对话会话模块（真实模式，WECHAT_DAILY_MOCK 必须未设置）：
 * 会话对象与消息校验、上下文组装（system + 截断）、持久化往返、
 * 会话回复/整理成文/素材成文（注入 fetch，零真实网络）、错误路径。
 * mock 桩与 mock 端到端在 v2-mock.test.js 覆盖。
 */
delete process.env.WECHAT_DAILY_MOCK;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const chat = require('../src/core/chat');
const { res, router, tmpDir } = require('./helpers');

const CFG = {
  llm: { baseUrl: 'https://llm.example.com/v4', apiKey: 'sk-chat', model: 'glm-4.6', temperature: 0.7 },
  project: { description: '任务打卡小程序，帮助用户记录待办与复盘', techTerms: '任务、复盘', audience: '效率工具用户' },
};

const fmt = (title, digest, html) => `===TITLE===\n${title}\n===DIGEST===\n${digest}\n===BODY_HTML===\n${html}`;

/* ------------------------------ 会话对象与消息 ------------------------------ */

test('newSession/addMessage：默认值、时间戳、标题自动取首条用户消息', () => {
  const s = chat.newSession({ id: 'chat-001', title: '效率选题', now: '2026-10-29T08:00:00Z' });
  assert.strictEqual(s.id, 'chat-001');
  assert.strictEqual(s.title, '效率选题');
  assert.strictEqual(s.createdAt, '2026-10-29T08:00:00.000Z');
  assert.deepStrictEqual(s.messages, []);

  const m = chat.addMessage(s, { role: 'user', content: '  想写一篇深度工作的科普  ', now: '2026-10-29T08:01:00Z' });
  assert.strictEqual(m.role, 'user');
  assert.strictEqual(m.content, '想写一篇深度工作的科普');
  assert.strictEqual(m.t, '2026-10-29T08:01:00.000Z');
  assert.strictEqual(s.updatedAt, m.t);
  // 标题已显式给出 → 不覆盖
  assert.strictEqual(s.title, '效率选题');

  const s2 = chat.newSession({ now: '2026-10-29T09:00:00Z' });
  chat.addMessage(s2, { role: 'user', content: '第一句话作为标题', now: '2026-10-29T09:01:00Z' });
  assert.strictEqual(s2.title, '第一句话作为标题');
  assert.ok(s2.id.startsWith('chat-'), '未传 id 时按时间戳生成');
});

test('addMessage：非法输入 → E_INVALID_INPUT', () => {
  const s = chat.newSession({ id: 'x' });
  assert.throws(() => chat.addMessage(s, { role: 'system', content: 'x' }), (e) => e.code === 'E_INVALID_INPUT');
  assert.throws(() => chat.addMessage(s, { role: 'user', content: '   ' }), (e) => e.code === 'E_INVALID_INPUT');
  assert.throws(() => chat.addMessage(s, { role: 'user', content: 42 }), (e) => e.code === 'E_INVALID_INPUT');
  assert.throws(() => chat.addMessage(null, { role: 'user', content: 'x' }), (e) => e.code === 'E_INVALID_INPUT');
});

/* ------------------------------ 上下文组装 ------------------------------ */

test('buildChatContext：system 在首、保留最近 N 条、dropped 计数', () => {
  const s = chat.newSession({ id: 'ctx' });
  for (let i = 1; i <= 5; i++) {
    chat.addMessage(s, { role: 'user', content: `u${i}` });
    chat.addMessage(s, { role: 'assistant', content: `a${i}` });
  }
  const { messages, dropped } = chat.buildChatContext(s, { system: 'SYS', maxTurns: 6 });
  assert.strictEqual(dropped, 4);
  assert.strictEqual(messages.length, 7);
  assert.deepStrictEqual(messages[0], { role: 'system', content: 'SYS' });
  // 尾部 6 条（10 条历史保留最近 6 条）
  assert.deepStrictEqual(messages.slice(1).map((m) => m.content), ['u3', 'a3', 'u4', 'a4', 'u5', 'a5']);
});

test('buildChatContext：无 system 则不含 system 消息；空会话 → 仅空数组', () => {
  const s = chat.newSession({ id: 'ctx2' });
  const { messages, dropped } = chat.buildChatContext(s, {});
  assert.deepStrictEqual(messages, []);
  assert.strictEqual(dropped, 0);
  chat.addMessage(s, { role: 'user', content: 'hi' });
  const r = chat.buildChatContext(s, { system: '' });
  assert.deepStrictEqual(r.messages.map((m) => m.role), ['user']);
});

test('buildSystemPrompt：项目背景四字段 + 文风约束注入', () => {
  const sys = chat.buildSystemPrompt({ project: CFG.project, styleInjection: '【文风画像】\n- 开头习惯：提问' });
  assert.ok(sys.includes('写作搭档'));
  assert.ok(sys.includes('任务打卡小程序'));
  assert.ok(sys.includes('术语表：任务、复盘'));
  assert.ok(sys.includes('受众：效率工具用户'));
  assert.ok(sys.includes('【文风画像】'));
  // 空项目背景 → 不含占位块
  const sys2 = chat.buildSystemPrompt({});
  assert.ok(!sys2.includes('【项目背景】'));
});

/* ------------------------------ 持久化 ------------------------------ */

test('会话持久化：save/load/delete/list 往返', () => {
  const dir = tmpDir();
  const s1 = chat.newSession({ id: 'chat-a', title: 'A', now: '2026-10-29T08:00:00Z' });
  chat.addMessage(s1, { role: 'user', content: '消息一', now: '2026-10-29T08:00:01Z' });
  const s2 = chat.newSession({ id: 'chat-b', now: '2026-10-29T09:00:00Z' });
  chat.addMessage(s2, { role: 'user', content: '第二条会话', now: '2026-10-29T09:00:01Z' });

  chat.saveSession(dir, s1);
  chat.saveSession(dir, s2);
  const loaded = chat.loadSession(dir, 'chat-a');
  assert.deepStrictEqual(loaded, s1);
  assert.strictEqual(chat.loadSession(dir, 'chat-missing'), null);

  const list = chat.listSessions(dir);
  assert.deepStrictEqual(list.map((x) => x.id), ['chat-b', 'chat-a']); // 按更新时间倒序
  assert.strictEqual(list[0].turns, 1);
  assert.strictEqual(list[0].title, '第二条会话');

  assert.strictEqual(chat.deleteSession(dir, 'chat-a'), true);
  assert.strictEqual(chat.loadSession(dir, 'chat-a'), null);
  assert.strictEqual(chat.deleteSession(dir, 'chat-a'), true); // 幂等
  // 文件名不合法字符被替换
  const s3 = chat.newSession({ id: 'a/b:c', now: '2026-10-29T10:00:00Z' });
  chat.saveSession(dir, s3);
  assert.ok(chat.loadSession(dir, 'a/b:c'));
});

test('会话持久化：损坏文件 → E_IO', () => {
  const dir = tmpDir();
  fs.mkdirSync(chat.sessionDir(dir), { recursive: true });
  fs.writeFileSync(path.join(chat.sessionDir(dir), 'chat-bad.json'), '{oops', 'utf8');
  assert.throws(() => chat.loadSession(dir, 'chat-bad'), (e) => e.code === 'E_IO');
  assert.throws(() => chat.listSessions(dir), (e) => e.code === 'E_IO');
});

/* ------------------------------ 会话回复（真实模式，注入 fetch） ------------------------------ */

test('chatReply：发送 system+多轮 messages，回复追加进会话', async () => {
  const { fetch, calls } = router([
    [/\/chat\/completions$/, () => res(200, { model: 'glm-4.6', choices: [{ message: { content: '建议从场景切入。' } }] })],
  ]);
  const s = chat.newSession({ id: 'reply', title: '选题讨论' });
  chat.addMessage(s, { role: 'user', content: '想写深度工作科普' });
  chat.addMessage(s, { role: 'assistant', content: '好的，先确认受众。' });
  const r = await chat.chatReply(CFG, s, { deps: { fetch, retryDelayMs: 0 } });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://llm.example.com/v4/chat/completions');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer sk-chat');
  const body = JSON.parse(calls[0].init.body);
  assert.deepStrictEqual(
    body.messages.map((m) => m.role),
    ['system', 'user', 'assistant']
  );
  assert.ok(body.messages[0].content.includes('写作搭档'));
  assert.ok(body.messages[0].content.includes('任务打卡小程序'));
  assert.strictEqual(r.reply.role, 'assistant');
  assert.strictEqual(r.reply.content, '建议从场景切入。');
  assert.strictEqual(s.messages[s.messages.length - 1].content, '建议从场景切入。'); // 已追加
});

test('chatReply：HTTP 401 → E_LLM 且会话不追加', async () => {
  const { fetch, calls } = router([[/x/, () => res(401, { error: { message: 'bad key' } })]]);
  const s = chat.newSession({ id: 'reply-err' });
  chat.addMessage(s, { role: 'user', content: 'hi' });
  await assert.rejects(
    () => chat.chatReply(CFG, s, { deps: { fetch, retryDelayMs: 0 } }),
    (e) => e.code === 'E_LLM'
  );
  assert.strictEqual(s.messages.length, 1);
  assert.strictEqual(calls.length, 1);
});

/* ------------------------------ 整理成文章 ------------------------------ */

test('isComposeCommand：触发词识别', () => {
  assert.strictEqual(chat.isComposeCommand('把这轮讨论整理成文章'), true);
  assert.strictEqual(chat.isComposeCommand('整理成一篇文章吧'), true);
  assert.strictEqual(chat.isComposeCommand('帮我生成文章'), true);
  assert.strictEqual(chat.isComposeCommand('今天天气不错'), false);
});

test('buildComposePrompt：主题行、编号讨论记录、成文规则', () => {
  const s = chat.newSession({ id: 'cp', title: '效率怎么写' });
  chat.addMessage(s, { role: 'user', content: '想写深度工作' });
  chat.addMessage(s, { role: 'assistant', content: '建议先讲共识再讲执行' });
  const p = chat.buildComposePrompt(s, { project: CFG.project });
  assert.ok(p.includes('主题：效率怎么写'));
  assert.ok(p.includes('[1] 用户：想写深度工作'));
  assert.ok(p.includes('[2] 助手：建议先讲共识再讲执行'));
  assert.ok(p.includes('===TITLE==='));
  assert.ok(p.includes('【项目背景】'));
  // 超长消息截断
  const s2 = chat.newSession({ id: 'cp2' });
  chat.addMessage(s2, { role: 'user', content: '长'.repeat(3000) });
  const p2 = chat.buildComposePrompt(s2, {});
  assert.ok(p2.includes('（已截断）'));
  // 截断上限 2000 + 规则块约 1100（v2.3 起含插图规范）；未截断时会到 ~4100，
  // 所以 3300 足以证明截断生效，又不会因为规则文案增补就误报。
  assert.ok(Array.from(p2).length < 3300, `实际长度 ${Array.from(p2).length}`);

  // 后续轮次显式写的「主题：…」优先于会话标题（只取标题会让第二轮的主题失效）
  const s3 = chat.newSession({ id: 'cp3', title: '第一轮的话题' });
  chat.addMessage(s3, { role: 'user', content: '第一轮：随便聊聊' });
  chat.addMessage(s3, { role: 'assistant', content: '好的' });
  chat.addMessage(s3, { role: 'user', content: '主题：权限系统的最小实现\n按这个方向整理' });
  const p3 = chat.buildComposePrompt(s3, {});
  assert.ok(p3.includes('主题：权限系统的最小实现'), '应取最近一条显式主题');
});

test('composeFromSession：空会话 → E_INVALID_INPUT；正常路径解析为文章', async () => {
  await assert.rejects(
    () => chat.composeFromSession(CFG, chat.newSession({ id: 'empty' }), { deps: { fetch: async () => { throw new Error('no net'); } } }),
    (e) => e.code === 'E_INVALID_INPUT'
  );

  const { fetch, calls } = router([
    [/\/chat\/completions$/, () => res(200, { choices: [{ message: { content: fmt('动起来：一份不吓人的复盘入门', '从共识讲到执行。', '<p>正文</p>') } }] })],
  ]);
  const s = chat.newSession({ id: 'cp3', title: '复盘' });
  chat.addMessage(s, { role: 'user', content: '聊复盘' });
  const r = await chat.composeFromSession(CFG, s, { deps: { fetch, retryDelayMs: 0 }, project: CFG.project });
  assert.deepStrictEqual(r.article, { title: '动起来：一份不吓人的复盘入门', digest: '从共识讲到执行。', html: '<p>正文</p>' });
  const body = JSON.parse(calls[0].init.body);
  assert.ok(body.messages.some((m) => m.role === 'user' && m.content.includes('整理')));
});

test('composeFromSession：LLM 输出格式不符 → E_LLM', async () => {
  const { fetch } = router([[/x/, () => res(200, { choices: [{ message: { content: '抱歉我不能按格式输出' } }] })]]);
  const s = chat.newSession({ id: 'cp4' });
  chat.addMessage(s, { role: 'user', content: '聊点别的' });
  await assert.rejects(
    () => chat.composeFromSession(CFG, s, { deps: { fetch, retryDelayMs: 0 } }),
    (e) => e.code === 'E_LLM'
  );
});

/* ------------------------------ 素材成文（创作页） ------------------------------ */

test('buildMaterialPrompt：素材为空 → E_INVALID_INPUT；含强调点与主题行', () => {
  assert.throws(() => chat.buildMaterialPrompt({ material: '   ' }), (e) => e.code === 'E_INVALID_INPUT');
  const p = chat.buildMaterialPrompt({ material: '要点一\n要点二', emphasis: '循序渐进不受伤', project: CFG.project });
  assert.ok(p.includes('主题：循序渐进不受伤'));
  assert.ok(p.includes('今天想强调的点：循序渐进不受伤'));
  assert.ok(p.includes('要点一'));
  assert.ok(p.includes('【项目背景】'));
});

test('composeMaterial：真实路径调用并解析（mockKind 由 llm 层在 mock 下分流）', async () => {
  const { fetch, calls } = router([
    [/\/chat\/completions$/, () => res(200, { choices: [{ message: { content: fmt('从零开始的第一周复盘', '给新手的起步清单。', '<p>正文</p>') } }] })],
  ]);
  const r = await chat.composeMaterial(CFG, { material: '番茄工作法三个要点', emphasis: '循序渐进', deps: { fetch, retryDelayMs: 0 } });
  assert.strictEqual(r.article.title, '从零开始的第一周复盘');
  assert.strictEqual(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.deepStrictEqual(body.messages, [{ role: 'user', content: r.prompt }]);
  assert.ok(r.prompt.includes('循序渐进'));
});

test('提示词总长预算：超长会话的上下文与成文提示词都被截断并如实标注', () => {
  const s = chat.newSession({ id: 'long', title: '长会话' });
  for (let i = 0; i < 60; i++) {
    chat.addMessage(s, { role: 'user', content: '长'.repeat(2000) + i });
    chat.addMessage(s, { role: 'assistant', content: '短'.repeat(500) + i });
  }
  const ctx = chat.buildChatContext(s, { system: 'sys' });
  const ctxChars = ctx.messages.reduce((n, m) => n + Array.from(m.content).length, 0);
  assert.ok(ctxChars <= 24000 + 10, '上下文总字符数应受预算约束，实际 ' + ctxChars);
  assert.ok(ctx.dropped > 0, '应报告被丢弃的旧消息数');
  const p = chat.buildComposePrompt(s, {});
  assert.ok(Array.from(p).length < 32000, '成文提示词应受预算约束，实际 ' + Array.from(p).length);
  assert.ok(/早期 \d+ 条消息因长度限制未纳入本次成文/.test(p), '应如实标注截断');
});
