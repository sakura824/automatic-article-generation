'use strict';
/**
 * wechat-mock.test.js —— WECHAT_DAILY_MOCK=1 下的确定性桩：
 * llm 与 wechat 全部网络函数短路到 mock；自检 4 步全 ok 且 detail 文案同设计稿 CHECK_LABELS。
 * 本文件在顶部打开 mock 开关（node --test 每个文件独立进程，互不影响）。
 */
process.env.WECHAT_DAILY_MOCK = '1';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isMock } = require('../src/core/mock');
const { callLlm, probeLlm, parseLlmOutput } = require('../src/core/llm');
const {
  getAccessToken,
  testConnection,
  ensureCoverMaterial,
  uploadContentImage,
  createDraft,
  deleteDraft,
  runSelfCheck,
} = require('../src/core/wechat');
const { tmpDir } = require('./helpers');

let fetchCalled = 0;
const forbiddenFetch = async () => {
  fetchCalled += 1;
  throw new Error('mock 模式下不应发起任何网络请求');
};
const DEPS = { fetch: forbiddenFetch, retryDelayMs: 0 };

test('isMock 开关', () => {
  assert.strictEqual(isMock(), true);
  assert.strictEqual(process.env.WECHAT_DAILY_MOCK, '1');
});

test('mock LLM：固定样文（===TITLE===/===DIGEST===/===BODY_HTML===），标题内嵌 prompt 日期，不发网络请求', async () => {
  const r = await callLlm({ llm: { model: 'glm-4.6' } }, '仓库提交记录（2026-10-29）：\nabc fix: x', DEPS);
  assert.strictEqual(fetchCalled, 0);
  assert.strictEqual(r.model, 'glm-4.6');
  assert.strictEqual(r.latencyMs, 0);
  const article = parseLlmOutput(r.raw); // 桩输出必须能被解析器接受
  assert.ok(article.title.includes('2026-10-29'), '标题内嵌 prompt 中的日期');
  assert.ok(article.digest.length > 0);
  assert.ok(article.html.includes('<p'));
  // 同 prompt 输出确定性
  const r2 = await callLlm({ llm: { model: 'glm-4.6' } }, '仓库提交记录（2026-10-29）：\nabc fix: x', DEPS);
  assert.strictEqual(r.raw, r2.raw);
});

test('mock LLM：probeLlm 校验非空后成功（空值仍报 E_INVALID_INPUT）', async () => {
  const r = await probeLlm({ llm: { baseUrl: 'https://x', apiKey: 'k', model: 'glm-4.6' } }, DEPS);
  assert.deepStrictEqual(r, { model: 'glm-4.6', latencyMs: 0 });
  await assert.rejects(
    () => probeLlm({ llm: { baseUrl: 'https://x', apiKey: '', model: 'glm-4.6' } }, DEPS),
    (e) => e.code === 'E_INVALID_INPUT'
  );
});

test('mock token：mock-token-<YYYYMMDD>，7200s', async () => {
  const r = await getAccessToken({ wechat: { appId: 'a', appSecret: 'b' } }, DEPS);
  assert.match(r.token, /^mock-token-\d{8}$/);
  assert.strictEqual(r.expiresIn, 7200);
  assert.strictEqual(fetchCalled, 0);
});

test('mock testConnection：非空成功、空值 E_INVALID_INPUT', async () => {
  assert.deepStrictEqual(await testConnection({ appId: 'a', appSecret: 'b' }, DEPS), { expiresIn: 7200 });
  await assert.rejects(() => testConnection({ appId: '', appSecret: 'b' }, DEPS), (e) => e.code === 'E_INVALID_INPUT');
  await assert.rejects(() => testConnection({ appId: 'a', appSecret: '' }, DEPS), (e) => e.code === 'E_INVALID_INPUT');
});

test('mock 封面素材：mediaId 取 sha256 前 8 位，指纹缓存 reused', async () => {
  const dir = tmpDir();
  const cover = path.join(dir, 'cover.png');
  const bytes = Buffer.from('mock-cover-bytes');
  fs.writeFileSync(cover, bytes);
  const want = 'mock-media-' + crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  const state = {};
  const first = await ensureCoverMaterial({ content: { coverPath: cover } }, 'tk', state, DEPS);
  assert.deepStrictEqual(first, { mediaId: want, reused: false });
  assert.deepStrictEqual(state.cover, { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mediaId: want });
  const second = await ensureCoverMaterial({ content: { coverPath: cover } }, 'tk', state, DEPS);
  assert.deepStrictEqual(second, { mediaId: want, reused: true });
  // 无封面文件：mock 模式使用固定占位字节，不报错
  const noCover = await ensureCoverMaterial({ content: { coverPath: '' } }, 'tk', {}, DEPS);
  assert.match(noCover.mediaId, /^mock-media-[0-9a-f]{8}$/);
  assert.strictEqual(fetchCalled, 0);
});

test('mock uploadimg / 草稿：序号自增（3 位），格式固定', async () => {
  const u1 = await uploadContentImage('tk', Buffer.from('x'), 'img.png', 'image/png', DEPS);
  const u2 = await uploadContentImage('tk', Buffer.from('y'), 'img.png', 'image/png', DEPS);
  assert.match(u1.url, /^mock:\/\/img\/\d{3}$/);
  assert.match(u2.url, /^mock:\/\/img\/\d{3}$/);
  const n1 = Number(u1.url.slice(-3));
  const n2 = Number(u2.url.slice(-3));
  assert.strictEqual(n2, n1 + 1);

  const d1 = await createDraft('tk', { title: 't' }, DEPS);
  const d2 = await createDraft('tk', { title: 't' }, DEPS);
  assert.match(d1.mediaId, /^mock-draft-\d{3}$/);
  assert.match(d2.mediaId, /^mock-draft-\d{3}$/);
  assert.strictEqual(Number(d2.mediaId.slice(-3)), Number(d1.mediaId.slice(-3)) + 1);
  assert.deepStrictEqual(await deleteDraft('tk', d1.mediaId, DEPS), { deleted: true });
  assert.strictEqual(fetchCalled, 0);
});

test('mock runSelfCheck：4 步全 ok，detail 文案同设计稿 CHECK_LABELS', async () => {
  const events = [];
  const { items } = await runSelfCheck({ content: { coverPath: '' } }, {}, (ev) => events.push(ev), DEPS);
  assert.deepStrictEqual(items.map((i) => [i.id, i.state]), [
    ['token', 'ok'],
    ['cover', 'ok'],
    ['draft', 'ok'],
    ['cleanup', 'ok'],
  ]);
  assert.strictEqual(items[0].detail, 'access_token 获取成功 · 7200s');
  assert.match(items[1].detail, /^封面素材已就绪 media_id=…\w{4}$/);
  assert.strictEqual(items[2].detail, '测试草稿创建成功');
  assert.strictEqual(items[3].detail, '测试草稿已删除');
  assert.deepStrictEqual(
    events.map((e) => e.state),
    ['run', 'ok', 'run', 'ok', 'run', 'ok', 'run', 'ok']
  );
  assert.strictEqual(fetchCalled, 0);
});
