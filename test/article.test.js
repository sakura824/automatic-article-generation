'use strict';
/**
 * article.test.js —— 文章加工：HTML 消毒、AI 标识 footer、payload 组装、
 * 图片本地化（注入 uploadImage/fetch，零真实网络）、预览 HTML、字数统计。
 */
delete process.env.WECHAT_DAILY_MOCK;

const test = require('node:test');
const assert = require('node:assert');
const { sanitizeHtml, localizeImages, buildArticlePayload, buildPreviewHtml, countWords } = require('../src/core/article');
const { parseLlmOutput } = require('../src/core/llm');
const { res, router, SAMPLE_LLM_RAW } = require('./helpers');

const CFG_FULL = {
  content: {
    author: '老王',
    aiDisclosure: { enabled: true, text: '本文由 AI 根据仓库提交自动起草' },
  },
};

test('sanitizeHtml：剥 script/style/iframe 整块', () => {
  assert.strictEqual(sanitizeHtml('<p>a</p><script>alert(1)</script><p>b</p>'), '<p>a</p><p>b</p>');
  assert.strictEqual(sanitizeHtml('<style>body{color:red}</style><p>x</p>'), '<p>x</p>');
  assert.strictEqual(sanitizeHtml('<iframe src="https://evil.example"></iframe><p>y</p>'), '<p>y</p>');
  assert.strictEqual(sanitizeHtml('<script type="text/javascript" src="x.js">evil()</script>'), '');
  assert.strictEqual(sanitizeHtml('<script src="x.js" />'), ''); // 自闭合残留
  // 未闭合标签：标签本身被剥除，剩余内容只是纯文本（不再构成脚本元素）
  const unclosed = sanitizeHtml('<script>alert(1)');
  assert.ok(!/<script/i.test(unclosed));
});

test('sanitizeHtml：剥 on* 属性（引号/无引号）与 javascript:', () => {
  assert.strictEqual(sanitizeHtml('<p onclick="evil()">hi</p>'), '<p>hi</p>');
  assert.strictEqual(sanitizeHtml("<img src='a.png' onerror='x()'>"), "<img src='a.png'>");
  assert.strictEqual(sanitizeHtml('<img src=x onload=alert(1)>'), '<img src=x>');
  assert.strictEqual(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a href="alert(1)">x</a>');
  assert.strictEqual(sanitizeHtml('<a href="JAVASCRIPT:x()">y</a>'), '<a href="x()">y</a>');
  // 正常内容不受影响
  assert.strictEqual(
    sanitizeHtml('  <p style="color:#3f3f3f;">keep <strong>me</strong></p>  '),
    '<p style="color:#3f3f3f;">keep <strong>me</strong></p>'
  );
});

test('buildArticlePayload：字段、AI footer、消毒', async () => {
  const article = { title: 'T', digest: 'D', html: '<p>ok</p><script>bad()</script>' };
  const payload = await buildArticlePayload(CFG_FULL, article, 'THUMB', null);
  assert.deepStrictEqual(payload, {
    title: 'T',
    author: '老王',
    digest: 'D',
    content:
      '<p>ok</p><p style="color:#999;font-size:13px;text-align:center;margin-top:24px;">本文由 AI 根据仓库提交自动起草</p>',
    thumb_media_id: 'THUMB',
    need_open_comment: 1,
    only_fans_can_comment: 0,
  });
});

test('buildArticlePayload：AI 标识关闭 → 无 footer；无配置 → 无 footer', async () => {
  const article = { title: 'T', digest: 'D', html: '<p>ok</p>' };
  const off = await buildArticlePayload({ content: { aiDisclosure: { enabled: false, text: 'x' } } }, article, 'THUMB', null);
  assert.strictEqual(off.content, '<p>ok</p>');
  const none = await buildArticlePayload({}, article, 'THUMB', null);
  assert.strictEqual(none.content, '<p>ok</p>');
  assert.strictEqual(none.author, '');
});

test('buildArticlePayload：正文为空 → E_INVALID_INPUT', async () => {
  await assert.rejects(
    () => buildArticlePayload(CFG_FULL, { title: 'T', digest: 'D', html: '<script>x</script>' }, 'T', null),
    (e) => {
      assert.strictEqual(e.code, 'E_INVALID_INPUT');
      assert.match(e.message, /正文为空/);
      return true;
    }
  );
});

test('localizeImages：外链图下载后换微信图床 URL；相对路径保留；data:URI 解码', async () => {
  const html =
    '<p><img src="https://cdn.example.com/a.png" style="width:100%"></p>' +
    '<p><img src="assets/local.png"></p>' +
    '<p><img src="data:image/png;base64,aGVsbG8="></p>';
  const uploads = [];
  const { fetch, calls } = router([
    [/cdn\.example\.com/, () => res(200, 'pngdata', { 'content-type': 'image/png' })],
  ]);
  const result = await localizeImages('TK', html, {
    fetch,
    uploadImage: async (bytes, filename, contentType) => {
      uploads.push({ bytes: bytes.toString(), filename, contentType });
      return { url: `https://mmbiz.qpic.cn/${uploads.length}.png` };
    },
    logger: { warn: () => {} },
  });
  assert.strictEqual(uploads.length, 2);
  assert.strictEqual(uploads[0].bytes, 'pngdata');
  assert.strictEqual(uploads[0].filename, 'img.png');
  assert.strictEqual(uploads[0].contentType, 'image/png');
  assert.strictEqual(uploads[1].bytes, 'hello'); // data:URI base64 解码
  assert.ok(result.includes('https://mmbiz.qpic.cn/1.png'));
  assert.ok(result.includes('https://mmbiz.qpic.cn/2.png'));
  assert.ok(!result.includes('cdn.example.com'));
  assert.ok(result.includes('src="assets/local.png"'), '相对路径保留原样');
  assert.strictEqual(calls.length, 1, '只有外链图才下载');
});

test('localizeImages：上传失败只告警不中断，原图保留', async () => {
  const warns = [];
  const html = '<p><img src="https://cdn.example.com/a.png"></p><p>tail</p>';
  const { fetch } = router([[/cdn\.example\.com/, () => res(200, 'x', { 'content-type': 'image/png' })]]);
  const result = await localizeImages('TK', html, {
    fetch,
    uploadImage: async () => {
      throw new Error('uploadimg refused');
    },
    logger: { warn: (m) => warns.push(m) },
  });
  assert.ok(result.includes('https://cdn.example.com/a.png'), '失败图保留原 URL');
  assert.ok(result.includes('<p>tail</p>'));
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /正文图片处理失败/);
});

test('buildArticlePayload 带 token：自动做图片本地化（注入链路）', async () => {
  const article = { title: 'T', digest: 'D', html: '<p><img src="https://cdn.example.com/a.png"></p>' };
  const { fetch, calls } = router([
    [/cdn\.example\.com/, () => res(200, 'zz', { 'content-type': 'image/png' })],
  ]);
  const payload = await buildArticlePayload(CFG_FULL, article, 'THUMB', 'TK', {
    fetch,
    uploadImage: async () => ({ url: 'https://mmbiz.qpic.cn/wx.png' }),
    logger: { warn: () => {} },
  });
  assert.ok(payload.content.includes('https://mmbiz.qpic.cn/wx.png'));
  assert.ok(!payload.content.includes('cdn.example.com'));
  assert.strictEqual(calls.length, 1);
});

test('buildPreviewHtml：含标题/摘要/正文与 doctype', () => {
  const article = parseLlmOutput(SAMPLE_LLM_RAW);
  const html = buildPreviewHtml(article);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('预览 - 修复配置读取的空指针：一次边界条件的排查'));
  assert.ok(html.includes('摘要：本次修复了配置为空时的读取崩溃'));
  assert.ok(html.includes('<strong>config 读取</strong>'));
});

test('countWords：去标签后 CJK 字符数 + 英文单词数', () => {
  assert.strictEqual(countWords('<p>你好世界 hello world</p>'), 6); // 4 CJK + 2 words
  assert.strictEqual(countWords('<p>你好<strong>世界</strong></p>'), 4);
  assert.strictEqual(countWords('<p>使用 Node.js 与 Redis 做缓存</p>'), 9); // 6 CJK + Node/js/Redis
  assert.strictEqual(countWords(''), 0);
  assert.strictEqual(countWords('<p>&nbsp;&amp;&lt;</p>'), 0); // 实体不算字
  assert.strictEqual(countWords('<script>var a=1;</script><p>中文</p>'), 2); // script 内容剔除
});
