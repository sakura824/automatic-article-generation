'use strict';
/**
 * v2-articles.test.js —— main/articles.js 的相似度改写关卡（PRD v2 §5.1/§5.4 联调验收点）：
 * - 聚合成文 similarity.needsRewrite=true → compose:upload 被阻止（E_REWRITE_REQUIRED）；
 * - compose:save 人工编辑正文 → similarity.manualEditAt 记录 → 上传放行；
 * - 素材/对话成文（无 similarity.json）上传不受关卡影响。
 * articles.js 仅依赖 Node 内置模块与 src/core（无 electron），可被 node --test 直测。
 */
delete process.env.WECHAT_DAILY_MOCK;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const articles = require('../main/articles');
const state = require('../src/core/state');
const { tmpDir, router, res } = require('./helpers');

function writeSimilarity(dir, sim) {
  fs.writeFileSync(path.join(dir, 'similarity.json'), JSON.stringify(sim, null, 2), 'utf8');
}

const DAY = '2026-10-29';

/** 上传链路的公共 deps：临时真实封面（wechat.ensureCoverMaterial 要求）+ 注入 fetch。 */
function makeCoverDeps(routing) {
  const cover = path.join(tmpDir('wdp-'), 'cover.png');
  fs.writeFileSync(cover, Buffer.from('fake-png'));
  const { fetch, calls } = router(routing);
  return { fetch, calls, deps: { fetch, retryDelayMs: 0, coverPath: cover } };
}

/** 按 core aggregate.composeFromTopics + main/ipc 的真实落盘形态构造一条聚合产物：
 *  output/<date>/aggregate/<batchId>/article.json（core 写）+ 历史 entry.dir（ipc 补记）。 */
function makeAggregateArtifact(dataDir, st) {
  const batchId = 'agg-test0001';
  const outDir = path.join(dataDir, 'output', DAY, 'aggregate', batchId);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, 'article.json'),
    JSON.stringify({ title: '聚合稿', digest: 'd', html: '<p>正文</p>', words: 2, origin: '聚合', batchId }, null, 2),
    'utf8'
  );
  const entry = state.recordRun(st, { id: batchId, date: DAY, title: '聚合稿', status: 'generated', words: 2, origin: '聚合' });
  entry.dir = outDir;
  return { batchId, outDir, entry };
}

test('改写关卡：needsRewrite=true → upload 抛 E_REWRITE_REQUIRED，含重叠率与操作指引', async () => {
  const dataDir = tmpDir('wdp-art-');
  const st = state.defaultState();
  // 模拟 core aggregate.composeFromTopics 落盘形态（article.json + similarity.json）+ ipc 补记 entry.dir
  const art = makeAggregateArtifact(dataDir, st);
  writeSimilarity(art.outDir, {
    threshold: 0.3, n: 2, passed: false, maxRatio: 0.42, worstIndex: 0,
    attempts: 3, rewriteAttempts: 2, needsRewrite: true, reports: [],
  });

  const gate = articles.rewriteGate(art.entry, art.outDir);
  assert.ok(gate, 'needsRewrite=true 必须命中关卡');
  assert.strictEqual(gate.code, 'E_REWRITE_REQUIRED');
  assert.match(gate.message, /42%/);
  assert.match(gate.message, /人工改写/);

  // 上传链路在关卡处中断（不触微信）
  let fetchCalls = 0;
  const { fetch } = router([[/\//, () => { fetchCalls += 1; return res(200, {}); }]]);
  await assert.rejects(
    () => articles.uploadComposedArticle({
      cfg: { wechat: { appId: 'wx', appSecret: 's' }, llm: {}, content: {} },
      state: st, dataDir, id: art.batchId, deps: { fetch, retryDelayMs: 0 },
    }),
    (e) => e.code === 'E_REWRITE_REQUIRED'
  );
  assert.strictEqual(fetchCalls, 0, '被关卡阻止时不得发出任何网络请求');
});

test('改写关卡：compose:save 编辑正文记录 manualEditAt → 上传放行；报告保留作审计', async () => {
  const dataDir = tmpDir('wdp-art-');
  const st = state.defaultState();
  const art = makeAggregateArtifact(dataDir, st);
  writeSimilarity(art.outDir, {
    threshold: 0.3, passed: false, maxRatio: 0.5, rewriteAttempts: 2, needsRewrite: true, reports: [{ index: 1, ratio: 0.5, runs: [] }],
  });

  // 人工改写正文并保存
  const r = articles.saveComposedPatch({
    dataDir, state: st, id: art.batchId, patch: { html: '<p>改写后的原创正文，与来源无重叠。</p>' }, now: Date.now(),
  });
  assert.ok(r.words > 0);
  const sim = JSON.parse(fs.readFileSync(path.join(art.outDir, 'similarity.json'), 'utf8'));
  assert.ok(sim.manualEditAt, '编辑后 similarity.json 记录 manualEditAt');
  assert.strictEqual(sim.needsRewrite, true, '报告与结论保留（审计）');
  assert.strictEqual(sim.maxRatio, 0.5);
  assert.ok(!articles.rewriteGate(art.entry, art.outDir), 'manualEditAt 后关卡放行');

  // 放行后上传：走 mock fetch 全链路到 draft
  const { fetch, calls, deps } = makeCoverDeps([
    [/\/cgi-bin\/token/, () => res(200, { access_token: 'TK', expires_in: 7200 })],
    [/\/cgi-bin\/material\/add_material/, () => res(200, { media_id: 'COVR' })],
    [/\/cgi-bin\/draft\/add/, () => res(200, { media_id: 'DRAFTV2' })],
  ]);
  const up = await articles.uploadComposedArticle({
    cfg: { wechat: { appId: 'wx', appSecret: 's' }, llm: {}, content: { author: '老王', aiDisclosure: { enabled: true, text: 'AI 起草' } } },
    state: st, dataDir, id: art.batchId, deps,
  });
  assert.strictEqual(up.draftMediaId, 'DRAFTV2');
  const entry = articles.findEntryById(st, art.batchId);
  assert.strictEqual(entry.status, 'uploaded');
  assert.strictEqual(entry.draftMediaId, 'DRAFTV2');
  assert.ok(fs.existsSync(path.join(art.outDir, 'uploaded.json')));
  assert.ok(calls.some((c) => /draft\/add/.test(c.url)));
});

test('改写关卡：原样回传正文的 compose:save 不算人工改写 → 仍拦截上传', async () => {
  // 渲染层「上传到草稿箱」会先无条件保存一次当前正文（compose.js upload → saveEdits），
  // 若「收到 html 就记 manualEditAt」，一字未改也能解锁关卡。
  const dataDir = tmpDir('wdp-art-');
  const st = state.defaultState();
  const art = makeAggregateArtifact(dataDir, st);
  writeSimilarity(art.outDir, {
    threshold: 0.3, passed: false, maxRatio: 0.62, rewriteAttempts: 2, needsRewrite: true, reports: [],
  });
  const originalHtml = JSON.parse(fs.readFileSync(path.join(art.outDir, 'article.json'), 'utf8')).html;

  articles.saveComposedPatch({ dataDir, state: st, id: art.batchId, patch: { html: originalHtml }, now: Date.now() });
  const sim = JSON.parse(fs.readFileSync(path.join(art.outDir, 'similarity.json'), 'utf8'));
  assert.strictEqual(sim.manualEditAt, undefined, '正文未变化不得记录 manualEditAt');
  const gate = articles.rewriteGate(art.entry, art.outDir);
  assert.ok(gate, '原样保存后关卡必须继续拦截');
  assert.strictEqual(gate.code, 'E_REWRITE_REQUIRED');

  // 真正改动正文后才放行
  articles.saveComposedPatch({ dataDir, state: st, id: art.batchId, patch: { html: '<p>完全重写后的原创正文。</p>' }, now: Date.now() });
  assert.ok(!articles.rewriteGate(art.entry, art.outDir), '正文实际变化后关卡放行');
});

test('来源清单泄露兜底：正文含 sources.json 里的来源 URL → 上传被拒（E_REWRITE_REQUIRED）', async () => {
  const dataDir = tmpDir('wdp-art-');
  const st = state.defaultState();
  const saved = await articles.saveComposedArticle({
    dataDir, state: st, origin: '素材', date: '2026-10-29',
    article: { title: '带链接的稿', digest: 'd', html: '<p>参考 https://www.who.int/x 的说法</p>' },
  });
  fs.writeFileSync(
    path.join(saved.dir, 'sources.json'),
    JSON.stringify({ internal: true, sources: [{ index: 1, label: 'L1', url: 'https://www.who.int/x' }] }, null, 2),
    'utf8'
  );
  const leak = articles.sourceLeakGuard(saved.dir, '<p>参考 https://www.who.int/x 的说法</p>');
  assert.ok(leak, '正文出现来源链接必须命中兜底校验');
  assert.strictEqual(leak.code, 'E_REWRITE_REQUIRED');
  await assert.rejects(
    () => articles.uploadComposedArticle({
      cfg: { wechat: { appId: 'wx', appSecret: 's' }, llm: {}, content: {} },
      state: st, dataDir, id: saved.id, deps: { fetch: async () => { throw new Error('no net'); }, retryDelayMs: 0 },
    }),
    (e) => e.code === 'E_REWRITE_REQUIRED'
  );
});

test('素材/对话成文无 similarity.json → 不受关卡影响，直接可上传', async () => {
  const dataDir = tmpDir('wdp-art-');
  const st = state.defaultState();
  const saved = await articles.saveComposedArticle({
    dataDir, state: st, origin: '素材', date: '2026-10-29',
    article: { title: '素材稿', digest: 'd', html: '<p>正文</p>' },
  });
  assert.ok(!articles.rewriteGate(saved.entry, saved.dir), '无 similarity.json → 放行');
  const { deps } = makeCoverDeps([
    [/\/cgi-bin\/token/, () => res(200, { access_token: 'TK', expires_in: 7200 })],
    [/\/cgi-bin\/material\/add_material/, () => res(200, { media_id: 'COVR' })],
    [/\/cgi-bin\/draft\/add/, () => res(200, { media_id: 'DRAFT2' })],
  ]);
  const up = await articles.uploadComposedArticle({
    cfg: { wechat: { appId: 'wx', appSecret: 's' }, llm: {}, content: {} },
    state: st, dataDir, id: saved.id, deps,
  });
  assert.strictEqual(up.draftMediaId, 'DRAFT2');
});

test('来源清单兜底：标题/摘要里的来源链接同样拦截；sources.json 损坏时 fail-closed', async () => {
  const dataDir = tmpDir('wdp-art-');
  const st = state.defaultState();
  const saved = await articles.saveComposedArticle({
    dataDir, state: st, origin: '素材', date: '2026-10-29',
    article: { title: '正常标题', digest: '摘要', html: '<p>正文</p>' },
  });
  fs.writeFileSync(
    path.join(saved.dir, 'sources.json'),
    JSON.stringify({ internal: true, sources: [{ index: 1, url: 'https://www.who.int/x' }] }, null, 2),
    'utf8'
  );
  // 正文干净、只在标题里贴链接 → 也必须拦
  assert.ok(articles.sourceLeakGuard(saved.dir, { html: '<p>正文</p>', title: '见 https://www.who.int/x', digest: '' }));
  // 省略协议的写法也命中
  assert.ok(articles.sourceLeakGuard(saved.dir, { html: '<p>参考 www.who.int/x 的说法</p>', title: '', digest: '' }));
  // 干净内容放行
  assert.strictEqual(articles.sourceLeakGuard(saved.dir, { html: '<p>正文</p>', title: '正常标题', digest: '摘要' }), null);

  // 损坏 → fail-closed
  fs.writeFileSync(path.join(saved.dir, 'sources.json'), '{oops', 'utf8');
  const bad = articles.sourceLeakGuard(saved.dir, { html: '<p>正文</p>', title: 't', digest: 'd' });
  assert.ok(bad && bad.code === 'E_REWRITE_REQUIRED', '来源清单损坏时必须拦截而不是放过');
});

test('rewriteGate：similarity.json 损坏 → fail-closed（不能悄悄放行）', async () => {
  const dataDir = tmpDir('wdp-art-');
  const st = state.defaultState();
  const art = makeAggregateArtifact(dataDir, st);
  fs.writeFileSync(path.join(art.outDir, 'similarity.json'), '{oops', 'utf8');
  const gate = articles.rewriteGate(art.entry, art.outDir);
  assert.ok(gate, '损坏时必须拦截');
  assert.strictEqual(gate.code, 'E_REWRITE_REQUIRED');
  // 文件不存在（素材/对话产物）仍放行
  const saved = await articles.saveComposedArticle({
    dataDir, state: st, origin: '素材', date: '2026-10-29',
    article: { title: '素材稿', digest: 'd', html: '<p>正文</p>' },
  });
  assert.strictEqual(articles.rewriteGate(saved.entry, saved.dir), null);
});

test('文末领域提示：verticalNotice 开启且文末无提示 → 上传前幂等补齐；关闭 → 不补', async () => {
  const dataDir = tmpDir('wdp-art-');
  const st = state.defaultState();
  const art = makeAggregateArtifact(dataDir, st);
  const NOTICE = '本文为个人经验分享，请结合自身情况判断';

  // 正文不含提示 → 开启后上传 payload 里被补齐
  const { fetch, calls, deps } = makeCoverDeps([
    [/\/cgi-bin\/token/, () => res(200, { access_token: 'TK', expires_in: 7200 })],
    [/\/cgi-bin\/material\/add_material/, () => res(200, { media_id: 'COVR' })],
    [/\/cgi-bin\/draft\/add/, () => res(200, { media_id: 'D1' })],
  ]);
  await articles.uploadComposedArticle({
    cfg: { wechat: { appId: 'wx', appSecret: 's' }, llm: {}, content: {}, aggregate: { verticalNotice: { enabled: true, text: NOTICE } } },
    state: st, dataDir, id: art.batchId, deps,
  });
  const body = JSON.parse(calls.find((c) => /draft\/add/.test(c.url)).init.body);
  assert.ok(body.articles[0].content.includes(NOTICE), '文末领域提示应按设置补齐');

  // 默认关闭 → 不补
  const art2 = makeAggregateArtifact(dataDir, st);
  const { fetch: f2, calls: c2, deps: d2 } = makeCoverDeps([
    [/\/cgi-bin\/token/, () => res(200, { access_token: 'TK', expires_in: 7200 })],
    [/\/cgi-bin\/material\/add_material/, () => res(200, { media_id: 'COVR' })],
    [/\/cgi-bin\/draft\/add/, () => res(200, { media_id: 'D2' })],
  ]);
  await articles.uploadComposedArticle({
    cfg: { wechat: { appId: 'wx', appSecret: 's' }, llm: {}, content: {} },
    state: st, dataDir, id: art2.batchId, deps: d2,
  });
  const body2 = JSON.parse(c2.find((c) => /draft\/add/.test(c.url)).init.body);
  assert.ok(!body2.articles[0].content.includes(NOTICE), '默认关闭时不补齐');
});
