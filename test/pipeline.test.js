'use strict';
/**
 * pipeline.test.js —— 三阶段流水线集成测试（真实模式，注入 fetch + 真实本地临时 git 仓库，零真实网络）：
 * 正常流（生成→上传）、无变更 skipped、force、格式错误重试并留 raw_llm.txt、
 * 上传错误码 48001、仅生成、reupload 复用与缺失、git 错误、仓库未配置。
 */
delete process.env.WECHAT_DAILY_MOCK;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runPipeline } = require('../src/core/pipeline');
const state = require('../src/core/state');
const { tmpDir, makeGitRepo, res, router, SAMPLE_LLM_RAW } = require('./helpers');

const NOW = new Date(2026, 9, 29, 10, 0, 0); // 2026-10-29 10:00 本地
const DAY = '2026-10-29';

function buildEnv({ llmContent = SAMPLE_LLM_RAW, draftResp = () => res(200, { media_id: 'DRAFT1' }) } = {}) {
  const repo = tmpDir('wdp-repo-');
  const dataDir = tmpDir('wdp-data-');
  const cover = path.join(tmpDir('wdp-'), 'cover.png');
  fs.writeFileSync(cover, Buffer.from('fake-png'));
  const cfg = {
    wechat: { appId: 'wx123', appSecret: 'sec' },
    llm: { baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'glm-4.6', temperature: 0.7 },
    content: {
      repoPath: repo,
      coverPath: cover,
      author: '老王',
      audience: '开发者',
      styleExtra: '',
      aiDisclosure: { enabled: true, text: '本文由 AI 根据仓库提交自动起草' },
    },
  };
  const r = router([
    [/\/chat\/completions$/, () => res(200, { model: 'glm-4.6', choices: [{ message: { content: llmContent } }] })],
    [/\/cgi-bin\/token/, () => res(200, { access_token: 'TK', expires_in: 7200 })],
    [/\/cgi-bin\/material\/add_material/, () => res(200, { media_id: 'COVER1' })],
    [/\/cgi-bin\/draft\/add/, draftResp],
    [/\/cgi-bin\/draft\/delete/, () => res(200, { errcode: 0 })],
  ]);
  const deps = { fetch: r.fetch, retryDelayMs: 0, now: NOW };
  return { repo, dataDir, cover, cfg, router: r, deps };
}

function callsTo(r, re) {
  return r.calls.filter((c) => re.test(c.url));
}

test('pipeline 正常流：三阶段完成、产物落盘、状态与历史正确', async () => {
  const { dataDir, cfg, router: r, deps, repo } = buildEnv();
  const heads = await makeGitRepo(repo, [
    { files: { 'src/a.js': 'a\n' }, msg: 'init: 项目初始化' },
    { files: { 'src/b.js': 'b\n' }, msg: 'fix: 修复配置读取空指针' },
  ]);
  const st = state.defaultState();
  const progress = [];
  const logs = [];
  const result = await runPipeline({
    cfg,
    state: st,
    dataDir,
    upload: true,
    cause: 'scheduled',
    logger: { info: (m) => logs.push(['INFO', m]), warn: (m) => logs.push(['WARN', m]), error: (m) => logs.push(['ERROR', m]) },
    onProgress: (stage, s, detail) => progress.push([stage, s, detail]),
    deps,
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 'uploaded');
  assert.strictEqual(result.date, DAY);
  assert.strictEqual(result.draftMediaId, 'DRAFT1');
  assert.strictEqual(result.title, '修复配置读取的空指针：一次边界条件的排查');
  assert.ok(result.words > 0);

  // 进度事件：三阶段各 active→done
  assert.deepStrictEqual(
    progress.map(([s, st2]) => [s, st2]),
    [[0, 'active'], [0, 'done'], [1, 'active'], [1, 'done'], [2, 'active'], [2, 'done']]
  );

  // 产物
  const outDir = path.join(dataDir, 'output', DAY);
  const article = JSON.parse(fs.readFileSync(path.join(outDir, 'article.json'), 'utf8'));
  assert.strictEqual(article.title, result.title);
  assert.ok(fs.readFileSync(path.join(outDir, 'preview.html'), 'utf8').includes('<!doctype html>'));
  const uploaded = JSON.parse(fs.readFileSync(path.join(outDir, 'uploaded.json'), 'utf8'));
  assert.strictEqual(uploaded.draft_media_id, 'DRAFT1');
  assert.ok(uploaded.uploaded_at);
  assert.ok(!fs.existsSync(path.join(outDir, 'raw_llm.txt')));

  // state
  assert.strictEqual(st.lastHead, heads[1]);
  assert.strictEqual(st.lastRunDate, DAY);
  assert.strictEqual(st.cover.mediaId, 'COVER1');
  assert.strictEqual(st.history.length, 1);
  assert.strictEqual(st.history[0].status, 'uploaded');
  assert.strictEqual(st.history[0].draftMediaId, 'DRAFT1');
  assert.ok(st.history[0].words > 0);

  // 网络调用：LLM 1 次；draft/add 的 payload 含 AI footer 与封面 media_id
  assert.strictEqual(callsTo(r, /chat\/completions$/).length, 1);
  const draftCall = callsTo(r, /draft\/add/)[0];
  const payload = JSON.parse(draftCall.init.body).articles[0];
  assert.strictEqual(payload.thumb_media_id, 'COVER1');
  assert.strictEqual(payload.need_open_comment, 1);
  assert.ok(payload.content.includes('本文由 AI 根据仓库提交自动起草'));
  assert.strictEqual(payload.author, '老王');
  assert.match(draftCall.url, /access_token=TK/);
  assert.match(callsTo(r, /cgi-bin\/token/)[0].url, /appid=wx123/);
  // 状态已持久化
  assert.strictEqual(state.loadState(dataDir).lastHead, heads[1]);
});

test('pipeline 无变更（lastHead=HEAD）→ skipped 历史与静默结束，不调 LLM/微信', async () => {
  const { dataDir, cfg, router: r, deps, repo } = buildEnv();
  const [h1, h2] = await makeGitRepo(repo, [
    { files: { 'a.txt': '1' }, msg: 'c1' },
    { files: { 'a.txt': '2' }, msg: 'c2' },
  ]);
  const st = state.defaultState();
  st.lastHead = h2; // 已处理到最新
  const progress = [];
  const result = await runPipeline({
    cfg, state: st, dataDir, upload: true, cause: 'scheduled', deps,
    onProgress: (s, st2) => progress.push([s, st2]),
  });
  assert.deepStrictEqual(result, { ok: true, date: DAY, status: 'skipped' });
  assert.deepStrictEqual(progress, [[0, 'active'], [0, 'done']]);
  assert.strictEqual(callsTo(r, /chat\/completions$/).length, 0);
  assert.strictEqual(callsTo(r, /cgi-bin\//).length, 0);
  assert.strictEqual(st.history.length, 1);
  assert.strictEqual(st.history[0].status, 'skipped');
  assert.strictEqual(st.history[0].title, '当天没有新的仓库提交');
  assert.strictEqual(state.loadState(dataDir).history[0].status, 'skipped');
  assert.ok(h1 !== h2);
});

test('pipeline force：lastHead=HEAD 也会回退最近提交并生成', async () => {
  const { dataDir, cfg, router: r, deps, repo } = buildEnv();
  const [h] = await makeGitRepo(repo, [{ files: { 'a.txt': '1' }, msg: 'feat: 唯一提交' }]);
  const st = state.defaultState();
  st.lastHead = h;
  const result = await runPipeline({ cfg, state: st, dataDir, upload: false, force: true, deps });
  assert.strictEqual(result.status, 'generated');
  assert.strictEqual(callsTo(r, /chat\/completions$/).length, 1);
});

test('pipeline LLM 格式错误：重试 1 次、留 raw_llm.txt、历史 failed(E_LLM)', async () => {
  const { dataDir, cfg, router: r, deps, repo } = buildEnv({ llmContent: '抱歉，我无法按该格式输出。' });
  await makeGitRepo(repo, [{ files: { 'a.txt': 'x' }, msg: 'c1' }]);
  const st = state.defaultState();
  const result = await runPipeline({ cfg, state: st, dataDir, upload: true, deps });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.error.code, 'E_LLM');
  assert.match(result.error.message, /===TITLE===/);
  assert.strictEqual(callsTo(r, /chat\/completions$/).length, 2, '格式错自动重试 1 次');
  const raw = fs.readFileSync(path.join(dataDir, 'output', DAY, 'raw_llm.txt'), 'utf8');
  assert.strictEqual(raw, '抱歉，我无法按该格式输出。');
  assert.strictEqual(st.history[0].status, 'failed');
  assert.strictEqual(st.history[0].error.code, 'E_LLM');
  assert.strictEqual(st.lastRunDate, null, '生成失败不写 lastRunDate');
});

test('pipeline 上传 48001：failed 带 errcode/hint，文章保留可重传', async () => {
  const { dataDir, cfg, router: r, deps, repo } = buildEnv({
    draftResp: () => res(200, { errcode: 48001, errmsg: 'api unauthorized' }),
  });
  await makeGitRepo(repo, [{ files: { 'a.txt': 'x' }, msg: 'c1' }]);
  const st = state.defaultState();
  const result = await runPipeline({ cfg, state: st, dataDir, upload: true, deps });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.error.code, 'E_WECHAT');
  assert.strictEqual(result.error.errcode, 48001);
  assert.match(result.error.hint, /接口权限/);
  assert.strictEqual(result.title, '修复配置读取的空指针：一次边界条件的排查');
  // 文章已生成（可从历史页重新上传），历史记录为 failed 且带 errcode
  assert.ok(fs.existsSync(path.join(dataDir, 'output', DAY, 'article.json')));
  assert.ok(!fs.existsSync(path.join(dataDir, 'output', DAY, 'uploaded.json')));
  assert.strictEqual(st.history[0].status, 'failed');
  assert.strictEqual(st.history[0].error.errcode, 48001);
  assert.strictEqual(st.lastHead.length, 40);
});

test('pipeline 仅生成（upload=false）：止于 generated，不触微信接口', async () => {
  const { dataDir, cfg, router: r, deps, repo } = buildEnv();
  await makeGitRepo(repo, [{ files: { 'a.txt': 'x' }, msg: 'c1' }]);
  const st = state.defaultState();
  const result = await runPipeline({ cfg, state: st, dataDir, upload: false, deps });
  assert.deepStrictEqual(
    { ok: result.ok, status: result.status, date: result.date },
    { ok: true, status: 'generated', date: DAY }
  );
  assert.strictEqual(st.history[0].status, 'generated');
  assert.ok(!fs.existsSync(path.join(dataDir, 'output', DAY, 'uploaded.json')));
  assert.strictEqual(callsTo(r, /cgi-bin\//).length, 0);
});

test('pipeline reupload：复用 article.json 直达上传；缺失 → E_NOT_FOUND', async () => {
  // 先仅生成，再 reupload
  const { dataDir, cfg, router: r, deps, repo } = buildEnv();
  await makeGitRepo(repo, [{ files: { 'a.txt': 'x' }, msg: 'c1' }]);
  const st = state.defaultState();
  await runPipeline({ cfg, state: st, dataDir, upload: false, deps });
  const llmCallsBefore = callsTo(r, /chat\/completions$/).length;

  const progress = [];
  const result = await runPipeline({
    cfg, state: st, dataDir, upload: true, cause: 'reupload', deps,
    onProgress: (s, st2, d) => progress.push([s, st2, d]),
  });
  assert.strictEqual(result.status, 'uploaded');
  assert.strictEqual(result.draftMediaId, 'DRAFT1');
  assert.strictEqual(callsTo(r, /chat\/completions$/).length, llmCallsBefore, 'reupload 不再调 LLM');
  assert.ok(progress.some(([s, st2, d]) => s === 1 && st2 === 'done' && d === '复用已生成文章'));
  assert.strictEqual(st.history[0].status, 'uploaded');

  // 缺失场景
  const empty = tmpDir('wdp-data-');
  const miss = await runPipeline({ cfg, state: state.defaultState(), dataDir: empty, upload: true, cause: 'reupload', date: DAY, deps });
  assert.strictEqual(miss.ok, false);
  assert.strictEqual(miss.error.code, 'E_NOT_FOUND');
  assert.match(miss.error.message, /无法重新上传/);
});

test('pipeline git 错误（lastHead 失效）→ E_GIT，历史 failed', async () => {
  const { dataDir, cfg, router: r, deps, repo } = buildEnv();
  await makeGitRepo(repo, [{ files: { 'a.txt': 'x' }, msg: 'c1' }]);
  const st = state.defaultState();
  st.lastHead = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const result = await runPipeline({ cfg, state: st, dataDir, upload: false, deps });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 'failed');
  assert.strictEqual(result.error.code, 'E_GIT');
  assert.strictEqual(callsTo(r, /chat\/completions$/).length, 0);
  assert.strictEqual(st.history[0].status, 'failed');
  assert.strictEqual(st.history[0].error.code, 'E_GIT');
});

test('pipeline 仓库未配置 → E_INVALID_INPUT', async () => {
  const { dataDir, cfg, deps } = buildEnv();
  cfg.content.repoPath = '';
  const result = await runPipeline({ cfg, state: state.defaultState(), dataDir, upload: false, deps });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'E_INVALID_INPUT');
  assert.match(result.error.message, /仓库路径未配置/);
});

test('pipeline 阶段 1 提示词：注入项目背景与文风画像（与 v2 三条路径同口径）', async () => {
  const { dataDir, cfg, router: r, deps, repo } = buildEnv();
  await makeGitRepo(repo, [
    { files: { 'src/a.js': 'a\n' }, msg: 'init: 项目初始化' },
    { files: { 'src/b.js': 'b\n' }, msg: 'feat: 支持导出' },
  ]);
  cfg.project = { description: '任务记录助手', techTerms: '', audience: '效率工具用户', styleExtra: '' };
  cfg.content.audience = '效率工具用户';
  cfg.style = {
    enabled: true,
    profile: { qualitative: { opening: '提问开头', closing: '', sentenceRhythm: '', petPhrases: '', subtitleStyle: '', punctuationEmoji: '' }, bannedWords: [] },
  };
  const result = await runPipeline({ cfg, state: state.defaultState(), dataDir, upload: false, deps });
  assert.strictEqual(result.ok, true, JSON.stringify(result.error));
  const body = JSON.parse(callsTo(r, /chat\/completions$/)[0].init.body);
  const prompt = body.messages.map((m) => m.content).join('\n');
  assert.ok(prompt.includes('【项目背景】'), '应注入项目背景');
  assert.ok(prompt.includes('任务记录助手'));
  assert.ok(prompt.includes('【文风画像】'), '应注入文风画像');
  assert.ok(prompt.includes('提问开头'));
  assert.ok(/首先|其次/.test(prompt), '默认 AI 味禁用词清单应存在');
});
