'use strict';
/**
 * illustration.test.js —— 插图声明解析与模板：
 * 属性解析、四种类型的归一化、非法声明丢弃、compare 数值非法降级为 summary、
 * 两种闭合写法、渲染结果替换（成功/失败/超量）、清空兜底、XSS 转义。
 */
const test = require('node:test');
const assert = require('node:assert');
const ill = require('../src/core/illustration');

test('parseAttrs：只取 key="value" 形式，忽略裸属性', () => {
  const a = ill.parseAttrs(' type="summary" title="标题" junk items="a||b"');
  assert.strictEqual(a.type, 'summary');
  assert.strictEqual(a.title, '标题');
  assert.strictEqual(a.items, 'a||b');
  assert.strictEqual(a.junk, undefined);
});

test('normalizeDecl：四种类型的字段归一与容量上限', () => {
  const s = ill.normalizeDecl({ type: 'summary', title: '标题', items: '一||二||三' });
  assert.deepStrictEqual(s, { type: 'summary', title: '标题', items: ['一', '二', '三'] });

  const c = ill.normalizeDecl({ type: 'compare', title: '对比', items: 'A||B', values: '12||30', unit: '%' });
  assert.deepStrictEqual(c, { type: 'compare', title: '对比', items: ['A', 'B'], values: ['12', '30'], unit: '%' });

  const f = ill.normalizeDecl({ type: 'flow', title: '流程', items: '第一步||第二步' });
  assert.strictEqual(f.type, 'flow');

  const q = ill.normalizeDecl({ type: 'quote', text: '金句', sub: '副标题' });
  assert.deepStrictEqual(q, { type: 'quote', text: '金句', sub: '副标题' });

  // 条目超过 6 条被截断
  const many = ill.normalizeDecl({ type: 'summary', title: 'T', items: '1||2||3||4||5||6||7||8' });
  assert.strictEqual(many.items.length, ill.MAX_ITEMS);
});

test('normalizeDecl：非法声明返回 null；compare 数值非法降级成 summary', () => {
  assert.strictEqual(ill.normalizeDecl({ type: 'chart', title: 'T', items: 'a' }), null);
  assert.strictEqual(ill.normalizeDecl({ type: 'summary', items: 'a' }), null);       // 缺标题
  assert.strictEqual(ill.normalizeDecl({ type: 'summary', title: 'T', items: '' }), null); // 缺条目
  assert.strictEqual(ill.normalizeDecl({ type: 'quote', text: '' }), null);

  // 数值个数对不上 / 含非数字 → 降级为要点卡，而不是画一根空条
  assert.strictEqual(ill.normalizeDecl({ type: 'compare', title: 'T', items: 'A||B', values: '1' }).type, 'summary');
  assert.strictEqual(ill.normalizeDecl({ type: 'compare', title: 'T', items: 'A||B', values: '1||很多' }).type, 'summary');
});

test('findIllustrations：兼容自闭合与显式闭合两种写法，位置准确', () => {
  const html = '<p>前</p><illus type="summary" title="T" items="a||b"></illus><p>中</p><illus type="quote" text="Q" />';
  const found = ill.findIllustrations(html);
  assert.strictEqual(found.length, 2);
  assert.strictEqual(found[0].decl.type, 'summary');
  assert.strictEqual(found[1].decl.type, 'quote');
  // slice 出来的片段必须就是原标签（保证替换时不吞正文）
  assert.strictEqual(html.slice(found[0].start, found[0].end), found[0].raw);
  assert.strictEqual(html.slice(found[1].start, found[1].end), found[1].raw);
});

test('buildIllustrationHtml：生成可直接渲染的完整文档，且对用户内容做 HTML 转义', () => {
  const doc = ill.buildIllustrationHtml(ill.normalizeDecl({ type: 'summary', title: '标题', items: '一||二' }));
  assert.match(doc, /^<!doctype html>/i);
  assert.match(doc, /<meta charset="utf-8">/);
  assert.match(doc, /677px/);           // 公众号正文列宽
  assert.match(doc, /标题/);
  assert.match(doc, /要点总结/);         // 类型标签

  // 模型输出里带尖括号必须被转义，不能当标签执行
  const xss = ill.buildIllustrationHtml(
    ill.normalizeDecl({ type: 'summary', title: '<script>alert(1)</script>', items: 'a||b' })
  );
  assert.strictEqual(/<script>alert/.test(xss), false);
  assert.match(xss, /&lt;script&gt;/);

  // 四种模板都能出文档，且都不是空壳
  for (const t of ill.TYPES) {
    const d = t === 'quote'
      ? ill.normalizeDecl({ type: t, text: '句子' })
      : ill.normalizeDecl({ type: t, title: 'T', items: t === 'compare' ? 'A||B' : '一||二', values: t === 'compare' ? '1||2' : undefined });
    const html = ill.buildIllustrationHtml(d);
    assert.ok(html.length > 400, `${t} 模板过短`);
    assert.match(html, /<\/body><\/html>/);
  }
});

test('applyIllustrations：成功替换为 img，失败/超量的直接删除', () => {
  const html = '<p>A</p><illus type="summary" title="T1" items="a||b"></illus><p>B</p><illus type="quote" text="Q"></illus><p>C</p>';
  const found = ill.findIllustrations(html);
  assert.strictEqual(found.length, 2);

  const ok = ill.applyIllustrations(html, [
    { dataUri: 'data:image/png;base64,AAA' },
    { dataUri: 'data:image/png;base64,BBB' },
  ]);
  assert.strictEqual(ok.rendered, 2);
  assert.strictEqual(ok.dropped, 0);
  assert.match(ok.html, /<img src="data:image\/png;base64,AAA"/);
  assert.strictEqual(/<illus/.test(ok.html), false); // 标签不得残留
  assert.match(ok.html, /<p>A<\/p>/);                // 正文不能丢
  assert.match(ok.html, /<p>C<\/p>/);

  // 渲染失败（dataUri 为 null）→ 删掉占位，正文其余部分完好
  const fail = ill.applyIllustrations(html, [{ dataUri: null }, { dataUri: 'data:image/png;base64,BBB' }]);
  assert.strictEqual(fail.rendered, 1);
  assert.strictEqual(fail.dropped, 1);
  assert.strictEqual(/<illus/.test(fail.html), false);

  // 超过上限的部分不渲染
  const three = '<illus type="quote" text="1"></illus><illus type="quote" text="2"></illus><illus type="quote" text="3"></illus><illus type="quote" text="4"></illus>';
  const capped = ill.applyIllustrations(three, [
    { dataUri: 'data:image/png;base64,1' },
    { dataUri: 'data:image/png;base64,2' },
    { dataUri: 'data:image/png;base64,3' },
    { dataUri: 'data:image/png;base64,4' },
  ]);
  assert.strictEqual(capped.rendered, ill.MAX_ILLUSTRATIONS);
  assert.strictEqual(capped.dropped, 1);
});

test('applyIllustrations：非法声明即便有渲染结果也不落图', () => {
  const html = '<illus type="chart" title="T" items="a"></illus><p>X</p>';
  const out = ill.applyIllustrations(html, [{ dataUri: 'data:image/png;base64,ZZZ' }]);
  assert.strictEqual(out.rendered, 0);
  assert.strictEqual(out.dropped, 1);
  assert.match(out.html, /<p>X<\/p>/);
});

test('无声明时原样返回；stripIllustrations 清干净', () => {
  const plain = '<p>没有插图</p>';
  const r = ill.applyIllustrations(plain, []);
  assert.strictEqual(r.html, plain);
  assert.strictEqual(r.rendered, 0);

  const withIll = '<p>A</p><illus type="quote" text="Q"></illus><p>B</p>';
  assert.strictEqual(ill.stripIllustrations(withIll), '<p>A</p><p>B</p>');
  assert.strictEqual(ill.countIllustrations(withIll), 1);
  assert.strictEqual(ill.countIllustrations('<illus type="chart"></illus>'), 0); // 非法不算
});

test('illustrationTextOf：抽出插图里的全部文字（供相似度自检）', () => {
  const html = '<p>正文</p>' +
    '<illus type="summary" title="选书标准" items="按实际阅读能力选||一页生词不超过五个"></illus>' +
    '<illus type="quote" text="读得下去比读得高级重要" sub="第一原则"></illus>' +
    '<illus type="bad" title="非法声明"></illus>';
  const t = ill.illustrationTextOf(html);
  assert.match(t, /选书标准/);
  assert.match(t, /一页生词不超过五个/);
  assert.match(t, /读得下去比读得高级重要/);
  assert.match(t, /第一原则/);
  assert.strictEqual(/非法声明/.test(t), false, '非法声明不该被算进去');
  assert.strictEqual(ill.illustrationTextOf('<p>无图</p>'), '');
});
