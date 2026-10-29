'use strict';
/**
 * illustration.js —— 正文插图的「声明解析 + HTML 模板」（v2.3 增量）。
 *
 * 分工：
 * - 本模块（src/core，纯 Node）：把模型写在正文里的 <illus ...> 声明解析出来、
 *   校验并生成排版好的 HTML 卡片；**不碰 Electron、不截图**。
 * - main/illustration.js：拿这里生成的 HTML 去离屏渲染成 PNG（那一步必须用 Electron）。
 *
 * 为什么让模型「声明」而不是「直接写 <img>」：
 * 模型没有画图能力，也生成不了二进制；它只能描述「这里要一张什么图、图里写什么」。
 * 由本地模板统一渲染，好处是中文不会画错、配色与公众号正文一致、不需要任何生图 Key。
 *
 * 声明格式（属性里一律不写引号，多值用 || 分隔，避免模型把属性写坏）：
 *   <illus type="summary" title="标题" items="要点一||要点二||要点三"></illus>
 *   <illus type="compare" title="标题" items="A||B||C" values="12||30||58" unit="%"></illus>
 *   <illus type="flow"    title="标题" items="第一步||第二步||第三步"></illus>
 *   <illus type="quote"   text="金句原文" sub="副标题"></illus>
 *
 * 渲染完成后这些标签会被替换成 <img src="data:image/png;base64,...">：
 * 预览可直接显示，上传时既有的 localizeImages 会自动把它转存到微信图床。
 */

/** 一篇文章最多几张插图（再多会拖慢成文、也让正文变图册）。 */
const MAX_ILLUSTRATIONS = 3;
/** 单个属性值的字符上限（防止模型把整段正文塞进图里）。 */
const MAX_ATTR_CHARS = 120;
/** 每种模板的容量上限（条目数 / 数值数）。 */
const MAX_ITEMS = 6;

const TYPES = ['summary', 'compare', 'flow', 'quote'];

const TYPE_LABEL = {
  summary: '要点总结',
  compare: '数据对比',
  flow: '流程结构',
  quote: '摘录',
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function cpLen(s) {
  return Array.from(String(s == null ? '' : s)).length;
}

function clip(s, n = MAX_ATTR_CHARS) {
  const arr = Array.from(String(s == null ? '' : s).trim());
  return arr.length > n ? arr.slice(0, n).join('') : arr.join('');
}

/** 解析属性串 → 普通对象（只取白名单键，值做长度截断）。 */
function parseAttrs(raw) {
  const out = {};
  const re = /([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(String(raw || '')))) {
    const key = m[1].toLowerCase();
    out[key] = m[2];
  }
  return out;
}

function splitList(s) {
  return String(s || '')
    .split('||')
    .map((x) => clip(x.trim()))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

/**
 * 归一化一条声明 → {type, title, items, values, unit, text, sub} 或 null（非法丢弃）。
 * type 不在白名单、必需字段缺失 → null（调用方决定是删除还是保留原文）。
 */
function normalizeDecl(attrs) {
  const type = String(attrs.type || '').trim().toLowerCase();
  if (!TYPES.includes(type)) return null;
  const title = clip(attrs.title, 60);
  const items = splitList(attrs.items);
  const values = splitList(attrs.values);
  const text = clip(attrs.text, 80);
  const sub = clip(attrs.sub, 60);
  const unit = clip(attrs.unit, 8);

  if (type === 'quote') {
    if (!text) return null;
    return { type, text, sub };
  }
  if (!title || !items.length) return null;
  if (type === 'compare') {
    // 数值缺失/非法 → 降级成 summary（宁可少一张对比图，也不要画一根空条）
    const nums = items.map((_, i) => Number(values[i]));
    if (values.length !== items.length || nums.some((n) => !Number.isFinite(n))) {
      return { type: 'summary', title, items };
    }
    return { type, title, items, values: nums.map(String), unit };
  }
  return { type, title, items };
}

/** 找出正文里所有 <illus> 声明 → [{start, end, raw, attrs, decl}]（decl 非法时为 null）。 */
function findIllustrations(html) {
  const src = String(html == null ? '' : html);
  const out = [];
  const re = /<illus\b([^>]*?)(?:\/>|>\s*<\/illus\s*>)/gi;
  let m;
  while ((m = re.exec(src))) {
    const attrs = parseAttrs(m[1]);
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      attrs,
      decl: normalizeDecl(attrs),
    });
  }
  return out;
}

/** 统计合法声明数量（供上层判断是否需要渲染）。 */
function countIllustrations(html) {
  return findIllustrations(html).filter((x) => x.decl).length;
}

/**
 * 抽出插图声明里的全部文字。
 * 用途：相似度自检。图里的字读者同样会看到，而 extractArticleText 只取标签外文本
 * （属性会被丢掉），不补这一步就等于「把来源原句塞进插图」能绕过护栏。
 */
function illustrationTextOf(html) {
  return findIllustrations(html)
    .filter((x) => x.decl)
    .map(({ decl }) => {
      const parts = [decl.title, decl.text, decl.sub];
      if (Array.isArray(decl.items)) parts.push(decl.items.join(' '));
      if (Array.isArray(decl.values)) parts.push(decl.values.join(' '));
      return parts.filter(Boolean).join(' ');
    })
    .join('\n');
}

/* ------------------------------- 模板 ------------------------------- */

const BASE_CSS = `
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:677px;background:transparent}
  body{font-family:"Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif;
       padding:26px 0;overflow:hidden}
  .card{width:677px;background:#ffffff;border-radius:18px;padding:34px 38px;
        border:1px solid #e6eee9;box-shadow:0 14px 38px -20px rgba(16,60,40,.22)}
  .tag{display:inline-block;background:#dff3e9;color:#0f6e56;font-size:16px;font-weight:600;
       padding:5px 14px;border-radius:999px;letter-spacing:1px}
  h2{font-size:30px;color:#12352a;line-height:1.35;margin:16px 0 22px;font-weight:700}
  .foot{margin-top:24px;padding-top:14px;border-top:1px dashed #dbe7e1;
        font-size:13px;color:#93a09a;letter-spacing:.5px}
`;

function cardOpen(type, title) {
  const label = TYPE_LABEL[type] || '';
  return (
    '<div class="card">' +
    (label ? `<span class="tag">${escapeHtml(label)}</span>` : '') +
    (title ? `<h2>${escapeHtml(title)}</h2>` : '')
  );
}

function tplSummary(decl) {
  const lis = decl.items
    .map((it) => `<li><span class="dot"></span><span class="tx">${escapeHtml(it)}</span></li>`)
    .join('');
  return (
    '<style>' + BASE_CSS + `
      ul{list-style:none}
      li{display:flex;align-items:flex-start;gap:13px;margin:0 0 15px}
      .dot{flex:none;width:11px;height:11px;border-radius:4px;background:#1d9e75;margin-top:11px}
      .tx{font-size:19px;color:#3c4a44;line-height:1.72}
    </style></head><body>` +
    cardOpen('summary', decl.title) +
    '<ul>' + lis + '</ul>' +
    `<div class="foot">要点整理 · 共 ${decl.items.length} 条</div>` +
    '</div></body></html>'
  );
}

function tplCompare(decl) {
  const nums = decl.values.map(Number);
  const max = Math.max(...nums, 1);
  const rows = decl.items
    .map((label, i) => {
      const n = nums[i];
      const pct = Math.max(6, Math.round((n / max) * 100));
      return (
        '<div class="row">' +
        `<div class="lb">${escapeHtml(label)}</div>` +
        '<div class="bar"><span style="width:' + pct + '%"></span></div>' +
        `<div class="vl">${escapeHtml(String(n))}${escapeHtml(decl.unit || '')}</div>` +
        '</div>'
      );
    })
    .join('');
  return (
    '<style>' + BASE_CSS + `
      .row{display:flex;align-items:center;gap:12px;margin:0 0 16px}
      .lb{flex:none;width:132px;font-size:16px;color:#3c4a44;text-align:right}
      .bar{flex:1;height:26px;background:#f1f6f3;border-radius:8px;overflow:hidden}
      .bar span{display:block;height:100%;background:linear-gradient(90deg,#5fd0a4,#1d9e75);border-radius:8px}
      .vl{flex:none;width:88px;font-size:17px;font-weight:700;color:#0f6e56}
    </style></head><body>` +
    cardOpen('compare', decl.title) +
    rows +
    '<div class="foot">数据对比 · 同口径并列</div>' +
    '</div></body></html>'
  );
}

function tplFlow(decl) {
  const items = decl.items
    .map((it, i) => {
      const last = i === decl.items.length - 1;
      return (
        '<div class="step">' +
        '<div class="col"><span class="num">' + (i + 1) + '</span>' + (last ? '' : '<span class="line"></span>') + '</div>' +
        `<div class="tx">${escapeHtml(it)}</div>` +
        '</div>'
      );
    })
    .join('');
  return (
    '<style>' + BASE_CSS + `
      .step{display:flex;gap:16px;align-items:stretch}
      .col{flex:none;width:34px;display:flex;flex-direction:column;align-items:center}
      .num{flex:none;width:30px;height:30px;border-radius:10px;background:#1d9e75;color:#fff;
           font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center}
      .line{flex:1;width:2px;background:#d8eee4;margin:5px 0}
      .tx{font-size:18px;color:#3c4a44;line-height:1.6;padding:3px 0 20px}
      .step:last-child .tx{padding-bottom:0}
    </style></head><body>` +
    cardOpen('flow', decl.title) +
    items +
    '<div class="foot">流程示意 · 按顺序执行</div>' +
    '</div></body></html>'
  );
}

function tplQuote(decl) {
  return (
    '<style>' + BASE_CSS + `
      .card{background:linear-gradient(150deg,#0f6e56,#12352a);border:none;padding:46px 44px}
      .mark{font-size:44px;color:#5fd0a4;line-height:1;font-family:Georgia,serif}
      .q{font-size:29px;color:#f2fbf7;line-height:1.62;font-weight:600;margin:12px 0 18px}
      .sub{font-size:16px;color:#a8d8c6;letter-spacing:.5px}
    </style></head><body>` +
    '<div class="card"><div class="mark">“</div>' +
    `<div class="q">${escapeHtml(decl.text)}</div>` +
    (decl.sub ? `<div class="sub">${escapeHtml(decl.sub)}</div>` : '') +
    '</div></body></html>'
  );
}

/** 声明 → 完整 HTML 文档（可直接 loadURL 到离屏窗口）。非法声明返回 ''。 */
function buildIllustrationHtml(decl) {
  if (!decl || !TYPES.includes(decl.type)) return '';
  const head = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">';
  const body =
    decl.type === 'summary' ? tplSummary(decl)
      : decl.type === 'compare' ? tplCompare(decl)
        : decl.type === 'flow' ? tplFlow(decl)
          : tplQuote(decl);
  // 各模板都从 </style></head><body> 接续，前面补 <head>
  return head + body;
}

/** 插图最终形态（正文里的 <img>）：尺寸由 CSS 控制，宽度铺满正文列。 */
function imgTagOf(dataUri, decl) {
  const alt = decl && (decl.title || decl.text) ? decl.title || decl.text : '配图';
  return (
    '<p style="text-align:center;margin:22px 0;">' +
    `<img src="${dataUri}" alt="${escapeHtml(alt)}" ` +
    'style="width:100%;max-width:677px;height:auto;border-radius:12px;display:block;margin:0 auto;" />' +
    '</p>'
  );
}

/**
 * 用渲染结果替换正文里的声明。
 * results 与 findIllustrations 的输出**按下标一一对应**：
 *   [{ dataUri }] 渲染成功 → 换成 <img>
 *   [{ dataUri: null }] 渲染失败/非法 → 直接删掉占位（不留残缺标签）
 * 超过 MAX_ILLUSTRATIONS 的部分一律删除（不让正文变图册）。
 * 返回 {html, rendered, dropped}。
 */
function applyIllustrations(html, results, { max = MAX_ILLUSTRATIONS } = {}) {
  const src = String(html == null ? '' : html);
  const found = findIllustrations(src);
  if (!found.length) return { html: src, rendered: 0, dropped: 0 };

  const valid = found.filter((x) => x.decl);
  const allowed = new Set(valid.slice(0, max).map((x) => x.start));

  let out = '';
  let cursor = 0;
  let rendered = 0;
  let dropped = 0;
  for (let i = 0; i < found.length; i++) {
    const node = found[i];
    out += src.slice(cursor, node.start);
    cursor = node.end;
    const r = results[i];
    const keep = node.decl && allowed.has(node.start) && r && r.dataUri;
    if (keep) {
      out += imgTagOf(r.dataUri, node.decl);
      rendered += 1;
    } else {
      dropped += 1; // 非法 / 超量 / 渲染失败：清掉占位，正文保持干净
    }
  }
  out += src.slice(cursor);
  return { html: out, rendered, dropped };
}

/** 清掉所有未处理的声明（上传前的兜底：正文里绝不能残留 <illus>）。 */
function stripIllustrations(html) {
  const found = findIllustrations(html);
  if (!found.length) return String(html == null ? '' : html);
  let out = '';
  let cursor = 0;
  for (const n of found) {
    out += String(html).slice(cursor, n.start);
    cursor = n.end;
  }
  return out + String(html).slice(cursor);
}

module.exports = {
  MAX_ILLUSTRATIONS,
  MAX_ATTR_CHARS,
  MAX_ITEMS,
  TYPES,
  TYPE_LABEL,
  escapeHtml,
  parseAttrs,
  normalizeDecl,
  findIllustrations,
  countIllustrations,
  illustrationTextOf,
  buildIllustrationHtml,
  imgTagOf,
  applyIllustrations,
  stripIllustrations,
};
