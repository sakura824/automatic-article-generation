'use strict';
/**
 * radar-auto.test.js —— 选题雷达全自动的选题策略：
 * 取前 N 条、跳过敏感话题（不占名额）、清单异常兜底、配置缺省与越界收敛。
 */
const test = require('node:test');
const assert = require('node:assert');
const radarAuto = require('../src/core/radar-auto');

const t = (id, title, summary = '') => ({ id, title, summary, tier: 'L1', source: '人民日报' });

/* ------------------------------ autoOptionsOf ------------------------------ */

test('autoOptionsOf：缺省选 1 条且跳过敏感话题', () => {
  assert.deepStrictEqual(radarAuto.autoOptionsOf({}), { pickCount: 1, skipSensitive: true });
  assert.deepStrictEqual(radarAuto.autoOptionsOf(null), { pickCount: 1, skipSensitive: true });
  assert.deepStrictEqual(radarAuto.autoOptionsOf({ aggregate: {} }), { pickCount: 1, skipSensitive: true });
});

test('autoOptionsOf：显式配置生效，越界值收敛到 1~3', () => {
  assert.deepStrictEqual(
    radarAuto.autoOptionsOf({ aggregate: { autoPickCount: 2, autoSkipSensitive: false } }),
    { pickCount: 2, skipSensitive: false }
  );
  assert.strictEqual(radarAuto.autoOptionsOf({ aggregate: { autoPickCount: 0 } }).pickCount, 1);
  assert.strictEqual(radarAuto.autoOptionsOf({ aggregate: { autoPickCount: 99 } }).pickCount, 3);
  assert.strictEqual(radarAuto.autoOptionsOf({ aggregate: { autoPickCount: 1.5 } }).pickCount, 1);
  // 只有明确的 false 才关闭跳过
  assert.strictEqual(radarAuto.autoOptionsOf({ aggregate: { autoSkipSensitive: 'no' } }).skipSensitive, true);
});

/* ------------------------------ pickTopTopics ------------------------------ */

test('pickTopTopics：按清单顺序取前 count 条', () => {
  const topics = [t('a', '标题A'), t('b', '标题B'), t('c', '标题C')];
  const r = radarAuto.pickTopTopics(topics, { count: 2 });
  assert.deepStrictEqual(r.picked.map((x) => x.id), ['a', 'b']);
  assert.deepStrictEqual(r.skipped, []);
});

test('pickTopTopics：count 缺省为 1，超过 3 收敛为 3', () => {
  const topics = [1, 2, 3, 4, 5].map((i) => t(`t${i}`, `标题${i}`));
  assert.strictEqual(radarAuto.pickTopTopics(topics).picked.length, 1);
  assert.strictEqual(radarAuto.pickTopTopics(topics, { count: 5 }).picked.length, 3);
});

test('pickTopTopics：跳过敏感话题且不占用名额', () => {
  const topics = [
    t('s1', '刷单兼职日结三百靠谱吗'),
    t('s2', '网络博彩平台推荐'),
    t('ok', '任务拆解的新手计划'),
    t('next', '每天走一万步有用吗'),
  ];
  const r = radarAuto.pickTopTopics(topics, { count: 1, keywords: ['刷单', '博彩'] });
  assert.deepStrictEqual(r.picked.map((x) => x.id), ['ok']);
  assert.deepStrictEqual(r.skipped.map((x) => x.id), ['s1', 's2']);
  assert.match(r.skipped[0].reason, /敏感/);
});

test('pickTopTopics：摘要里命中敏感词也算（标题干净也不行）', () => {
  const topics = [{ id: 'x', title: '一周见效计划', summary: '配合刷单服务使用效果更佳' }];
  const r = radarAuto.pickTopTopics(topics, { count: 1, keywords: ['刷单', '博彩'] });
  assert.deepStrictEqual(r.picked, []);
  assert.strictEqual(r.skipped.length, 1);
});

test('pickTopTopics：关闭跳过后，敏感选题照常入选', () => {
  const topics = [t('s1', '博彩平台测评'), t('ok', '任务拆解入门')];
  const r = radarAuto.pickTopTopics(topics, { count: 2, skipSensitive: false });
  assert.deepStrictEqual(r.picked.map((x) => x.id), ['s1', 'ok']);
  assert.deepStrictEqual(r.skipped, []);
});

test('pickTopTopics：空清单 / 非数组 / 脏元素 → 安全返回空结果', () => {
  assert.deepStrictEqual(radarAuto.pickTopTopics([]), { picked: [], skipped: [] });
  assert.deepStrictEqual(radarAuto.pickTopTopics(null), { picked: [], skipped: [] });
  assert.deepStrictEqual(radarAuto.pickTopTopics(undefined), { picked: [], skipped: [] });
  const r = radarAuto.pickTopTopics([null, 'x', 42, t('ok', '有效选题')], { count: 1 });
  assert.deepStrictEqual(r.picked.map((x) => x.id), ['ok']);
});

test('pickTopTopics：全部是敏感话题时返回空 picked（调用方据此跳过今天）', () => {
  const topics = [t('s1', '刷单返利的套路'), t('s2', '博彩群的骗局')];
  const r = radarAuto.pickTopTopics(topics, { count: 1, keywords: ['刷单', '博彩'] });
  assert.deepStrictEqual(r.picked, []);
  assert.strictEqual(r.skipped.length, 2);
});

/* ------------------------------ describePick ------------------------------ */

test('describePick：拼出可读的一句话', () => {
  assert.strictEqual(radarAuto.describePick(t('a', '标题A')), '《标题A》（L1 · 人民日报）');
  assert.strictEqual(radarAuto.describePick({ title: '只有标题' }), '《只有标题》');
  assert.strictEqual(radarAuto.describePick(null), '');
});
