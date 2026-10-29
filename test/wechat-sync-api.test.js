'use strict';
/**
 * wechat-sync-api.test.js —— listDrafts / listPublishedTitles 的响应解析（注入 fetch，不发网络）：
 * draft/batchget 分页聚合与标题提取、freepublish 两段式（batchget → get）与缓存复用、
 * errcode 非 0 抛 WechatError。
 */
const test = require('node:test');
const assert = require('node:assert');
const wechat = require('../src/core/wechat');

delete process.env.WECHAT_DAILY_MOCK; // 本文件走真实 HTTP 解析路径（fetch 注入桩）

/** 构造返回序列化的 fetch 桩 */
function fetchOf(handler) {
  return async (url, init) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(handler(String(url), init ? JSON.parse(init.body) : {})),
  });
}

test('listDrafts：单页解析 media_id 与标题', async () => {
  const calls = [];
  const fetch = fetchOf((url) => {
    calls.push(url);
    return {
      total: 1, item_count: 1,
      item: [{ media_id: 'M1', update_time: 1700000000, content: { news_item: [{ title: '第一篇草稿' }] } }],
    };
  });
  const r = await wechat.listDrafts('TOKEN', { fetch });
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /draft\/batchget/);
  assert.deepStrictEqual(r, [{ mediaId: 'M1', title: '第一篇草稿', updateTime: 1700000000 }]);
});

test('listDrafts：多页分页拉全（20 条/页，按 total 停止）', async () => {
  let page = 0;
  const fetch = fetchOf(() => {
    page += 1;
    const items = Array.from({ length: page === 1 ? 20 : 3 }, (_, i) => ({
      media_id: `M${page}-${i}`,
      content: { news_item: [{ title: `草稿${page}-${i}` }] },
    }));
    return { total: 23, item_count: items.length, item: items };
  });
  const r = await wechat.listDrafts('TOKEN', { fetch });
  assert.strictEqual(page, 2);
  assert.strictEqual(r.length, 23);
});

test('listDrafts：errcode 非 0 → WechatError（带中文处理建议）', async () => {
  const fetch = fetchOf(() => ({ errcode: 48001, errmsg: 'api unauthorized' }));
  await assert.rejects(
    () => wechat.listDrafts('TOKEN', { fetch }),
    (e) => e.name === 'WechatError' && e.errcode === 48001
  );
});

test('listPublishedTitles：batchget → get 两段式，publishId 缓存复用', async () => {
  const getCalls = [];
  const cache = { 'pub-old': '缓存的旧标题' };
  const fetch = fetchOf((url, body) => {
    if (url.includes('freepublish/batchget')) {
      return {
        total: 2, item_count: 2,
        item: [
          { article_id: 'A1', publish_id: 'pub-old', update_time: 1 },
          { article_id: 'A2', publish_id: 'pub-new', update_time: 2 },
        ],
      };
    }
    getCalls.push(body.publish_id);
    return { article_detail: { news_item: [{ title: '新发布的好文章' }] } };
  });
  const r = await wechat.listPublishedTitles('TOKEN', { fetch }, cache);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r.map((x) => x.title), ['缓存的旧标题', '新发布的好文章']);
  assert.deepStrictEqual(getCalls, ['pub-new'], '已缓存的 publishId 不应再调 get');
  assert.strictEqual(cache['pub-new'], '新发布的好文章', '新查询结果写回缓存');
});

test('listPublishedTitles：freepublish/get errcode 非 0 → WechatError', async () => {
  const fetch = fetchOf((url) => {
    if (url.includes('freepublish/batchget')) return { total: 1, item_count: 1, item: [{ article_id: 'A', publish_id: 'P' }] };
    return { errcode: 40007, errmsg: 'invalid media_id' };
  });
  await assert.rejects(
    () => wechat.listPublishedTitles('TOKEN', { fetch }, {}),
    (e) => e.name === 'WechatError' && e.errcode === 40007
  );
});
