'use strict';
/**
 * article.js —— 文章加工（移植 run_daily.py:379-437）。
 * HTML 消毒（剥 script/style/iframe、on* 属性、javascript:）、AI 标识 footer、
 * 正文外链图片下载后换微信图床 URL（fetch/上传均可注入，测试零真实网络）、
 * 草稿 payload 组装、预览 HTML、展示口径字数统计。
 */
const { uploadContentImage } = require('./wechat');

/**
 * 消毒 HTML：
 * 1. 剥 <script>/<style>/<iframe> 整块（含内容）；
 * 2. 剥未闭合/自闭合的 <script|style|iframe> 残留标签（比命令行版更严，避免漏网）；
 * 3. 剥 on* 事件属性（带引号/不带引号的值都处理）；
 * 4. 删除 javascript: 协议串。
 */
function sanitizeHtml(html) {
  let s = String(html == null ? '' : html);
  s = s.replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<(script|style|iframe)\b[^>]*\/?>/gi, '');
  s = s.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/javascript:/gi, '');
  return s.trim();
}

function isPngType(t) {
  return /png/i.test(String(t || ''));
}

/** 内网/本机地址判定（与 aggregate.isPrivateHost 同口径；正文图片 URL 来自 LLM/来源网页，必须校验）。 */
function isPrivateImageHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

/**
 * 正文图片本地化：外链/ data:URI 下载后经 uploadimg 换微信图床 URL。
 * 仅处理双引号 src（与命令行版同一正则口径）；相对路径保留原样；
 * 单张失败只告警保留原样，不阻断整篇。
 * deps: {fetch?, uploadImage?(bytes, filename, contentType) → {url}, logger?{warn}}
 */
async function localizeImages(token, html, deps = {}) {
  const logger = deps.logger || { warn() {} };
  const doFetch = deps.fetch || globalThis.fetch;
  const uploadImage =
    deps.uploadImage ||
    ((bytes, filename, contentType) => uploadContentImage(token, bytes, filename, contentType, deps));
  const matches = [...String(html).matchAll(/<img[^>]*\ssrc="([^"]+)"/gi)];
  let result = String(html);
  for (const m of matches) {
    const src = m[1];
    try {
      let bytes;
      let filename;
      let contentType;
      if (src.startsWith('data:')) {
        const comma = src.indexOf(',');
        const head = src.slice(0, comma);
        const b64 = src.slice(comma + 1);
        const png = isPngType(head);
        bytes = Buffer.from(b64, 'base64');
        contentType = png ? 'image/png' : 'image/jpeg';
        filename = 'img.' + (png ? 'png' : 'jpg');
      } else if (/^https?:\/\//i.test(src)) {
        // 正文图片 URL 来自 LLM/来源网页：内网/本机地址一律不抓（SSRF 防护），保留原样
        let imgUrl;
        try {
          imgUrl = new URL(src);
        } catch (e) {
          logger.warn(`警告：正文图片地址非法（${src.slice(0, 60)}…），保留原样`);
          continue;
        }
        if (isPrivateImageHost(imgUrl.hostname)) {
          logger.warn(`警告：正文图片指向内网/本机（${imgUrl.hostname}），已跳过：${src.slice(0, 60)}…`);
          continue;
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), deps.imageTimeoutMs || 60 * 1000);
        let res;
        try {
          res = await doFetch(src, { signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // 跟随重定向后的最终地址也要校验（失败按原图处理，由外层 catch 记录）
        if (res.url) {
          const finalUrl = new URL(res.url);
          if (isPrivateImageHost(finalUrl.hostname)) throw new Error(`重定向到内网地址：${finalUrl.hostname}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || 'image/png';
        const png = isPngType(contentType);
        filename = 'img.' + (png ? 'png' : 'jpg');
        bytes = buf;
      } else {
        continue; // 相对路径等：保留原样
      }
      const { url } = await uploadImage(bytes, filename, contentType);
      result = result.replace(m[0], m[0].replace(src, url));
    } catch (e) {
      if (deps.requireImages && /^data:image\/(?:png|jpeg);base64,/.test(src)) {
        const failure = new Error(`正文配图上传失败：${e.message}，本篇未上传，请重试`);
        failure.code = 'E_MEDIA';
        throw failure;
      }
      logger.warn(`警告：正文图片处理失败（${src.slice(0, 60)}…）：${e.message}，保留原样`);
    }
  }
  return result;
}

/**
 * 组装 draft/add 请求体（buildArticlePayload 移植）：
 * title/author/digest/content/thumb_media_id/need_open_comment:1/only_fans_can_comment:0；
 * 正文先消毒、文末按配置追加 AI 标识 footer；token 存在时对 <img> 做 localizeImages。
 * deps: {fetch?, uploadImage?, logger?}
 */
async function buildArticlePayload(cfg, article, thumbMediaId, token, deps = {}) {
  let html = sanitizeHtml(article && article.html);
  if (!html) {
    const e = new Error('生成的正文为空，无法创建草稿');
    e.code = 'E_INVALID_INPUT';
    throw e;
  }
  const ai = (cfg && cfg.content && cfg.content.aiDisclosure) || {};
  const footer = ai.enabled !== false && ai.text ? String(ai.text).trim() : '';
  if (footer) {
    html += `<p style="color:#999;font-size:13px;text-align:center;margin-top:24px;">${footer}</p>`;
  }
  if (token && html.includes('<img')) {
    html = await localizeImages(token, html, {...deps,requireImages:!!(article.visuals && article.visuals.bodyImages)});
  }
  return {
    title: article.title,
    author: (cfg && cfg.content && cfg.content.author) || '',
    digest: article.digest,
    content: html,
    thumb_media_id: thumbMediaId,
    need_open_comment: 1,
    only_fans_can_comment: 0,
  };
}

/** 预览页文本转义（title/digest 来自 LLM 输出，不能当 HTML 拼接）。 */
function escapeHtmlText(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 本地预览文件（preview_html 移植，浏览器直接打开）。 */
function buildPreviewHtml(article) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<title>预览 - ' +
    escapeHtmlText(article && article.title) +
    '</title></head>' +
    '<body style="background:#eee;margin:0">' +
    '<div style="max-width:640px;margin:24px auto;background:#fff;padding:32px;' +
    'border-radius:8px;font-family:-apple-system,microsoft yahei,sans-serif">' +
    (article && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(article.coverDataUri || '') ? '<img alt="本篇封面" style="width:100%;border-radius:12px;" src="' + article.coverDataUri + '">' : '') +
    '<h1 style="color:#1a1a1a;">' +
    escapeHtmlText(article && article.title) +
    '</h1>' +
    '<p style="color:#888;">摘要：' +
    escapeHtmlText(article && article.digest) +
    '</p><hr>' +
    (article && article.html) +
    '</div></body></html>'
  );
}

/**
 * 展示口径字数（契约 §7 决策 7：非严格字数）：
 * 去标签 → CJK 字符数 + 英文单词数（数字串不计）。
 */
function countWords(html) {
  let text = String(html == null ? '' : html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  const latinWords = (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
  return cjk + latinWords;
}

module.exports = {
  sanitizeHtml,
  localizeImages,
  buildArticlePayload,
  buildPreviewHtml,
  countWords,
};
