'use strict';
/**
 * sync-status.test.js —— v2.4 历史状态同步：
 * 判定规则（草稿箱在→不变；草稿箱无+命中发布列表→published；无+未发表→removed）、
 * 定稿状态不重复判定、无 draftMediaId 的条目跳过、标题归一化匹配。
 */
const test = require('node:test');
const assert = require('node:assert');
const sync = require('../src/core/sync');

const entry = (over) => Object.assign({ id: 'a1', date: '2026-10-29', title: '标题A', status: 'uploaded', draftMediaId: 'M1' }, over);

test('computeStatusSync：草稿箱里还在 → 保持 uploaded 不变', () => {
  const r = sync.computeStatusSync(
    [entry()],
    { drafts: [{ mediaId: 'M1', title: '标题A' }], publishedTitles: [] }
  );
  assert.deepStrictEqual(r.updates, []);
  assert.deepStrictEqual(r.counts, { published: 0, removed: 0, unchanged: 1 });
});

test('computeStatusSync：草稿已删 + 标题命中发布列表 → published', () => {
  const r = sync.computeStatusSync(
    [entry()],
    { drafts: [], publishedTitles: [{ title: ' 标题A ' }, { title: '别的文章' }] }
  );
  assert.deepStrictEqual(r.updates, [{ key: 'a1', status: 'published', title: '标题A' }]);
  assert.strictEqual(r.counts.published, 1);
});

test('computeStatusSync：草稿已删 + 未发表 → removed', () => {
  const r = sync.computeStatusSync(
    [entry()],
    { drafts: [{ mediaId: 'M99', title: '别人的稿' }], publishedTitles: [] }
  );
  assert.deepStrictEqual(r.updates, [{ key: 'a1', status: 'removed', title: '标题A' }]);
  assert.strictEqual(r.counts.removed, 1);
});

test('computeStatusSync：定稿状态（published/removed/replaced）不重复判定', () => {
  const r = sync.computeStatusSync(
    [
      entry({ status: 'published', draftMediaId: 'M1' }),
      entry({ status: 'removed', draftMediaId: 'M2' }),
      entry({ status: 'replaced', draftMediaId: 'M3' }),
    ],
    { drafts: [], publishedTitles: [] }
  );
  assert.deepStrictEqual(r.updates, []);
  assert.deepStrictEqual(r.counts, { published: 0, removed: 0, unchanged: 0 });
});

test('computeStatusSync：无 draftMediaId（generated/failed/skipped）跳过', () => {
  const r = sync.computeStatusSync(
    [
      entry({ status: 'generated', draftMediaId: null }),
      entry({ status: 'failed', draftMediaId: null }),
      entry({ status: 'skipped', draftMediaId: null }),
      { date: '2026-10-28', title: 'v1 失败运行', status: 'failed' },
    ],
    { drafts: [], publishedTitles: [] }
  );
  assert.deepStrictEqual(r.updates, []);
});

test('computeStatusSync：标题归一化匹配（连续空白/首尾空白不影响）', () => {
  const r = sync.computeStatusSync(
    [entry({ title: '科技  教育 指南' })],
    { drafts: [], publishedTitles: [{ title: '科技 教育 指南 ' }] }
  );
  assert.strictEqual(r.updates[0].status, 'published');
});

test('computeStatusSync：多条混合判定，key 用 id 优先', () => {
  const r = sync.computeStatusSync(
    [
      entry({ id: 'x1', draftMediaId: 'M1' }),                                    // 还在
      entry({ id: 'x2', draftMediaId: 'M2', title: '已发的', status: 'uploaded' }), // 发了
      entry({ id: 'x3', draftMediaId: 'M3', title: '删了的', status: 'uploaded' }), // 删了
    ],
    {
      drafts: [{ mediaId: 'M1', title: '标题A' }],
      publishedTitles: [{ title: '已发的' }],
    }
  );
  assert.deepStrictEqual(r.updates, [
    { key: 'x2', status: 'published', title: '已发的' },
    { key: 'x3', status: 'removed', title: '删了的' },
  ]);
  assert.strictEqual(r.counts.unchanged, 1);
});

test('computeStatusSync：入参异常安全（null/缺字段不抛错）', () => {
  const r = sync.computeStatusSync(null, null);
  assert.deepStrictEqual(r, { updates: [], counts: { published: 0, removed: 0, unchanged: 0 } });
  const r2 = sync.computeStatusSync([entry()], {});
  assert.strictEqual(r2.updates[0].status, 'removed'); // 草稿箱与发布列表都为空 → removed
});
