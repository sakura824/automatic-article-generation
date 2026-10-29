'use strict';
/**
 * style.test.js —— 文风画像模块（真实模式，WECHAT_DAILY_MOCK 必须未设置）：
 * 样文解析（txt/md/html 兼容）、统计、样文库持久化、画像生成（注入 fetch）/归一/加载、
 * few-shot 挑选、注入块组装、禁用词扫描、错误路径。
 * mock 桩与 mock 端到端在 v2-mock.test.js 覆盖。
 */
delete process.env.WECHAT_DAILY_MOCK;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const style = require('../src/core/style');
const { res, router, tmpDir } = require('./helpers');

const CFG = {
  llm: { baseUrl: 'https://llm.example.com/v4', apiKey: 'sk-style', model: 'glm-4.6', temperature: 0.7 },
};

const SAMPLE_PLAIN = '第一段先抛出一个真实场景，让人想读下去。\n第二段给出数据与例子，节奏短句为主！\n结尾留一个问题给读者？';

/* ------------------------------ 样文解析与统计 ------------------------------ */

test('parseSample：纯文本规范化；空内容 → E_INVALID_INPUT', () => {
  const r = style.parseSample('  第一段  内容 \n\r\n第二段\t内容  ');
  assert.strictEqual(r.text, '第一段 内容\n第二段 内容');
  assert.deepStrictEqual(r.paragraphs, ['第一段 内容', '第二段 内容']);
  assert.throws(() => style.parseSample('   '), (e) => e.code === 'E_INVALID_INPUT');
  assert.throws(() => style.parseSample(''), (e) => e.code === 'E_INVALID_INPUT');
});

test('parseSample：公众号导出 HTML 剥标签/噪声块/实体，正文保留', () => {
  const html = [
    '<html><head><style>.x{color:red}</style><title>标题</title></head>',
    '<body><nav>导航（剔除）</nav>',
    '<div class="rich_media_content">',
    '<p>第一段落：&ldquo;引用&rdquo;与&amp;符号、&mdash;破折号。</p>',
    '<p>第二段落<br>折行同段。</p>',
    '<script>evil()</script>',
    '</div><footer>版权（剔除）</footer></body></html>',
  ].join('\n');
  const r = style.parseSample(html);
  assert.ok(r.text.includes('第一段落：“引用”与&符号、—破折号。'));
  assert.ok(r.text.includes('第二段落\n折行同段。'));
  assert.ok(!r.text.includes('导航'), 'nav 内容剔除');
  assert.ok(!r.text.includes('版权'), 'footer 内容剔除');
  assert.ok(!r.text.includes('evil'), 'script 内容剔除');
  assert.ok(!r.text.includes('.x{color'), 'style 内容剔除');
});

test('computeSampleStats：句子/标点/小标题/高频词，结果确定性', () => {
  const text = ['## 开始写周报前', '列要点十分钟就够了。', '别迷信模板！', '渐进打磨才是关键？', '# 结', '渐进打磨的原理很简单，渐进打磨需要时间。'].join('\n');
  const s = style.computeSampleStats(text);
  assert.strictEqual(s.paraCount, 6);
  assert.strictEqual(s.sentenceCount, 4);
  assert.strictEqual(s.exclamations, 1);
  assert.strictEqual(s.questions, 1);
  assert.strictEqual(s.subtitleCount, 2);
  assert.ok(Array.isArray(s.topBigrams));
  const s2 = style.computeSampleStats(text);
  assert.deepStrictEqual(s, s2);
  assert.ok(s.topBigrams.some(([w]) => w === '渐进'));
});

/* ------------------------------ 样文库 ------------------------------ */

test('addSample/removeSample：指纹 id、重名不重复入库、默认名', () => {
  const samples = [];
  const a = style.addSample(samples, { text: SAMPLE_PLAIN });
  assert.strictEqual(a.duplicate, false);
  assert.ok(a.sample.id.startsWith('sm-'));
  assert.strictEqual(a.sample.name, '样文 1');
  assert.ok(a.sample.words > 0);
  assert.strictEqual(a.sample.addedAt, null || a.sample.addedAt); // ISO 字符串
  // 同文 → 同 id → duplicate
  const b = style.addSample(samples, { text: SAMPLE_PLAIN, name: '改名' });
  assert.strictEqual(b.duplicate, true);
  assert.strictEqual(samples.length, 1);
  // 空文本 → E_INVALID_INPUT
  assert.throws(() => style.addSample(samples, { text: '  ' }), (e) => e.code === 'E_INVALID_INPUT');
  assert.strictEqual(style.removeSample(samples, a.sample.id).id, a.sample.id);
  assert.strictEqual(style.removeSample(samples, 'sm-none'), null);
});

test('样文库持久化：save/load/delete 往返（按加入时间升序）', () => {
  const dir = tmpDir();
  const s1 = style.addSample([], { name: '早', text: '第一篇内容', now: '2026-10-28T08:00:00Z' }).sample;
  const s2 = style.addSample([], { name: '晚', text: '第二篇内容', now: '2026-10-29T08:00:00Z' }).sample;
  style.saveSample(dir, s2);
  style.saveSample(dir, s1);
  const loaded = style.loadSamples(dir);
  assert.deepStrictEqual(loaded.map((x) => x.name), ['早', '晚']);
  style.deleteSample(dir, s1.id);
  assert.deepStrictEqual(style.loadSamples(dir).map((x) => x.name), ['晚']);
  style.deleteSample(dir, s1.id); // 幂等
});

test('readSampleFile：扩展名/大小/存在性校验；scanSampleFolder 扫描与错误记录', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), '文本样文内容', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.md'), '# 标题\nMarkdown 样文', 'utf8');
  fs.writeFileSync(path.join(dir, 'c.html'), '<p>HTML 样文</p>', 'utf8');
  fs.writeFileSync(path.join(dir, 'd.pdf'), 'not a sample', 'utf8');

  const scanned = style.scanSampleFolder(dir);
  assert.deepStrictEqual(scanned.samples.map((s) => s.name), ['a', 'b', 'c']);
  assert.deepStrictEqual(scanned.errors, []);

  assert.throws(() => style.readSampleFile(path.join(dir, 'd.pdf')), (e) => e.code === 'E_INVALID_INPUT');
  assert.throws(() => style.readSampleFile(path.join(dir, 'missing.txt')), (e) => e.code === 'E_IO');
  // 超过 1MiB → E_INVALID_INPUT
  const big = path.join(dir, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(1024 * 1024 + 1), 'utf8');
  assert.throws(() => style.readSampleFile(big), (e) => {
    assert.strictEqual(e.code, 'E_INVALID_INPUT');
    assert.match(e.message, /过大/);
    return true;
  });
  // 读不了的目录 → E_IO
  assert.throws(() => style.scanSampleFolder(path.join(dir, 'no-such-dir')), (e) => e.code === 'E_IO');
});

/* ------------------------------ 画像生成 / 归一 / 加载 ------------------------------ */

test('normalizeProfile：固定形状、去未知字段、禁用词去重去空、非法输入', () => {
  const p = style.normalizeProfile({
    version: 99,
    name: '  我的画像  ',
    updatedAt: '2026-10-29T00:00:00.000Z',
    enabled: 0,
    qualitative: { opening: '提问开头', bogus: 'x' },
    bannedWords: ['首先', '首先', '', '  ', '总之'],
    topBigrams: [['渐进', 5], ['bad', 'x'], [null, 2], ['超负荷', 3], ['extra', 1]],
    stats: { paraCount: 3 },
    sampleCount: 3,
    unknownField: true,
  });
  assert.strictEqual(p.version, 1);
  assert.strictEqual(p.name, '我的画像');
  assert.strictEqual(p.enabled, false);
  assert.deepStrictEqual(p.qualitative, {
    opening: '提问开头', closing: '', sentenceRhythm: '', petPhrases: '', subtitleStyle: '', punctuationEmoji: '',
  });
  assert.deepStrictEqual(p.bannedWords, ['首先', '总之']);
  assert.deepStrictEqual(p.topBigrams, [['渐进', 5], ['超负荷', 3], ['extra', 1]]);
  assert.deepStrictEqual(p.stats, { paraCount: 3 });
  assert.strictEqual(p.sampleCount, 3);
  assert.strictEqual(p.unknownField, undefined);
  assert.strictEqual(style.normalizeProfile(null), null);
  assert.throws(() => style.normalizeProfile('not-an-object'), (e) => e.code === 'E_INVALID_INPUT');
  assert.throws(() => style.normalizeProfile([1]), (e) => e.code === 'E_INVALID_INPUT');
});

test('loadProfile：cfg.style.profile → 归一；无 → null', () => {
  assert.strictEqual(style.loadProfile({}), null);
  assert.strictEqual(style.loadProfile({ style: { profile: null } }), null);
  const p = style.loadProfile({ style: { profile: { qualitative: { opening: 'x' } } } });
  assert.strictEqual(p.qualitative.opening, 'x');
  assert.strictEqual(p.name, '默认文风画像');
});

test('analyzeStyle：真实路径（注入 fetch）——本地统计 + LLM JSON 合并，禁用词并集', async () => {
  const samples = [
    style.addSample([], { name: 'A', text: SAMPLE_PLAIN, now: '2026-10-28T00:00:00Z' }).sample,
    style.addSample([], { name: 'B', text: '任务计划的编排原则。\n先说结论，再给依据！', now: '2026-10-28T01:00:00Z' }).sample,
  ];
  const llmJson = JSON.stringify({
    opening: '场景式开头', closing: '清单式收尾', sentenceRhythm: '短句为主',
    petPhrases: '说白了', subtitleStyle: '整齐排比（需规避）', punctuationEmoji: '少 emoji',
    bannedWordsExtra: ['深入探讨', '赋能'],
  });
  const { fetch, calls } = router([
    [/\/chat\/completions$/, () => res(200, { choices: [{ message: { content: llmJson } }] })],
  ]);
  const r = await style.analyzeStyle(CFG, samples, { deps: { fetch, retryDelayMs: 0 }, now: '2026-10-29T00:00:00Z' });
  assert.strictEqual(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.ok(body.messages[0].content.includes('共 2 篇')); // mock 桩同口径依赖该字样
  assert.ok(body.messages[0].content.includes('[样文1·A]'));
  const p = r.profile;
  assert.strictEqual(p.name, '我的文风画像');
  assert.strictEqual(p.updatedAt, '2026-10-29T00:00:00.000Z');
  assert.strictEqual(p.qualitative.opening, '场景式开头');
  assert.strictEqual(p.sampleCount, 2);
  assert.ok(p.stats.paraCount >= 2);
  // 禁用词 = 默认清单 ∪ LLM 增补（去重）
  for (const w of [...style.DEFAULT_BANNED_WORDS, '深入探讨', '赋能']) {
    assert.ok(p.bannedWords.includes(w), `应包含 ${w}`);
  }
  assert.strictEqual(new Set(p.bannedWords).size, p.bannedWords.length);
  // ```json 围栏同样可解析
  const fenced = router([[/x/, () => res(200, { choices: [{ message: { content: '```json\n' + llmJson + '\n```' } }] })]]);
  const r2 = await style.analyzeStyle(CFG, samples, { deps: { fetch: fenced.fetch, retryDelayMs: 0 } });
  assert.strictEqual(r2.profile.qualitative.opening, '场景式开头');
});

test('analyzeStyle 错误路径：无样文 → E_INVALID_INPUT；LLM 输出非 JSON → E_LLM（LlmFormatError）', async () => {
  await assert.rejects(() => style.analyzeStyle(CFG, [], { deps: {} }), (e) => e.code === 'E_INVALID_INPUT');
  const samples = [style.addSample([], { text: '一样文内容' }).sample];
  const { fetch } = router([[/x/, () => res(200, { choices: [{ message: { content: '我觉得这篇文风很好，就不按 JSON 输出了' } }] })]]);
  await assert.rejects(
    () => style.analyzeStyle(CFG, samples, { deps: { fetch, retryDelayMs: 0 } }),
    (e) => {
      assert.strictEqual(e.code, 'E_LLM');
      assert.match(e.message, /JSON/);
      return true;
    }
  );
  // HTTP 500 → E_LLM（LlmError 语义由 llm 层保证）
  const { fetch: fetch5 } = router([[/x/, () => res(500, 'boom')]]);
  await assert.rejects(() => style.analyzeStyle(CFG, samples, { deps: { fetch: fetch5, retryDelayMs: 0 } }), (e) => e.code === 'E_LLM');
});

/* ------------------------------ few-shot 与注入 ------------------------------ */

test('pickFewShots：主题词重叠优先、同分按字数、count 上限、空输入', () => {
  const mk = (name, text) => style.addSample([], { name, text }).sample;
  const s1 = mk('任务管理', '任务管理的优先级排序原则与每日复盘。');
  const s2 = mk('番茄工作法', '番茄工作法的专注节奏与休息间隔是效率的核心。');
  const s3 = mk('笔记工具', '笔记工具的选择取决于记录与检索习惯。');
  const s4 = mk('笔记工具二', '笔记工具与知识库，另一些笔记内容这里更多字数补偿。');
  assert.deepStrictEqual(style.pickFewShots([s1, s2, s3], '番茄工作法与专注节奏', { count: 2 }).map((x) => x.name), ['番茄工作法', '任务管理']);
  assert.deepStrictEqual(style.pickFewShots([s1, s3, s4], '检索习惯', { count: 3 }).map((x) => x.name), ['笔记工具', '笔记工具二', '任务管理']);
  // 主题为空 → 按入库顺序
  assert.deepStrictEqual(style.pickFewShots([s1, s2, s3], '', { count: 2 }).map((x) => x.name), ['任务管理', '番茄工作法']);
  // 全部零分 → 按入库顺序
  assert.deepStrictEqual(style.pickFewShots([s1, s2], '摄影', { count: 1 }).map((x) => x.name), ['任务管理']);
  assert.deepStrictEqual(style.pickFewShots([], 'x', {}), []);
  assert.strictEqual(style.pickFewShots([s1], '番茄工作法', { count: 5 }).length, 1); // count 不超过样本数
});

test('buildStyleInjection：画像段/范文段/禁用词段；空输入 → 空串；摘录截断', () => {
  const profile = style.normalizeProfile({
    qualitative: { opening: '提问开头', closing: '清单收尾' },
    bannedWords: ['首先', '总之'],
    topBigrams: [['渐进', 5]],
  });
  const shot = style.addSample([], { name: '范文A', text: '短'.repeat(50) }).sample;
  const inj = style.buildStyleInjection(profile, [shot], { maxFewShotChars: 10 });
  assert.ok(inj.includes('【文风画像】'));
  assert.ok(inj.includes('- 开头习惯：提问开头'));
  assert.ok(inj.includes('- 高频词：渐进(5)'));
  assert.ok(inj.includes('【范文参考】'));
  assert.ok(inj.includes('《范文A》'));
  assert.ok(inj.includes('…')); // 截断省略号
  assert.ok(inj.includes('【AI 味禁用词（硬约束，正文中一律不得出现）】首先、总之'));

  // 无画像 → 禁用词回退默认清单（负面清单硬约束不随画像缺失而消失）；仍给出范文段
  const inj2 = style.buildStyleInjection(null, [shot], {});
  assert.ok(inj2.includes('【范文参考】'));
  assert.ok(inj2.includes(style.DEFAULT_BANNED_WORDS[0]));
  // 全空 → 仅默认禁用词清单（硬约束仍在）
  const inj3 = style.buildStyleInjection(null, [], {});
  assert.ok(inj3.startsWith('【AI 味禁用词（硬约束，正文中一律不得出现）】'));
  assert.ok(inj3.includes('首先'));
});

test('scanBannedWords：计数与降序排序（同次数按码点序）；无命中 → 空数组', () => {
  const hits = style.scanBannedWords('首先说a，首先说b，然后赋能与闭环，总之结论。值得注意的是x', ['首先', '赋能', '闭环', '总之', '值得注意的是']);
  assert.deepStrictEqual(hits, [
    { word: '首先', count: 2 },
    { word: '值得注意的是', count: 1 },
    { word: '总之', count: 1 },
    { word: '赋能', count: 1 },
    { word: '闭环', count: 1 },
  ]);
  assert.deepStrictEqual(style.scanBannedWords('干净文本', ['首先']), []);
  assert.deepStrictEqual(style.scanBannedWords('', style.DEFAULT_BANNED_WORDS), []);
});

test('buildStyleInjection：bannedWords 为空数组时回退默认禁用词（空画像不得压掉硬约束）', () => {
  const inj = style.buildStyleInjection({ qualitative: {}, bannedWords: [] }, []);
  assert.ok(inj.includes('首先'), '默认 AI 味禁用词应保留');
  // styleInjectionFor：未启用 → 空串；启用才注入
  const cfg = { style: { enabled: false, profile: { qualitative: { opening: '提问开头' }, bannedWords: [] } } };
  assert.strictEqual(style.styleInjectionFor(cfg, tmpDir(), 'x'), '');
  cfg.style.enabled = true;
  assert.ok(style.styleInjectionFor(cfg, tmpDir(), 'x').includes('提问开头'));
});
