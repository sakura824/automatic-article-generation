'use strict';
/**
 * illustration.js（main）—— 把 core 生成的插图 HTML 离屏渲染成 PNG。
 *
 * 为什么必须在主进程：截图依赖 Electron 的 BrowserWindow / capturePage，
 * 而 src/core 按契约禁止 import electron（要能被 node --test 直测）。
 *
 * 实现要点（都是踩坑换来的）：
 * - offscreen:true + show:false：不弹窗、不抢焦点；
 * - 先按 677 宽载入、量出 body.scrollHeight 再 setContentSize，避免固定高度导致的
 *   大片空白或内容被截断（四种模板的内容高度差别很大）；
 * - 输出统一缩放到 1354px 宽（2x）：不同机器 DPI 不同，截图原始像素会漂移；
 * - 串行渲染：同时开多个 offscreen 窗口会让首帧不稳（偶发空图）；
 * - 单张失败只丢一张图，绝不阻断成文（日志留 WARN）。
 */
const { BrowserWindow } = require('electron');
const core = require('../src/core/illustration');
const {visualPlan,coverHtml} = require('../src/core/visual-plan');

/** CSS 逻辑宽度（公众号正文列宽 677px）。 */
const VIEW_WIDTH = 677;
/** 输出像素宽度（2 倍图，手机上不糊）。 */
const OUT_WIDTH = 1354;
/** 高度上限（防御性：模型给 6 条超长条目也不会渲染出巨图）。 */
const MAX_HEIGHT = 2200;
const MIN_HEIGHT = 160;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 串行队列：前一张渲染完再开下一个窗口。 */
let chain = Promise.resolve();

function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

/**
 * 复用同一个隐藏窗口。
 * 早期实现是「每张图新建一个 offscreen 窗口、截完销毁」，连续渲染第 2 张时
 * 渲染进程会崩（crashpad_client_win: not connected / loadURL ERR_FAILED）——
 * 销毁与新建挨太近，进程来不及回收。改成复用一个窗口后稳定。
 */
let sharedWin = null;

function ensureWin() {
  if (sharedWin && !sharedWin.isDestroyed()) return sharedWin;
  sharedWin = new BrowserWindow({
    show: false,
    width: VIEW_WIDTH,
    height: 600,
    frame: false,
    // 插图 HTML 完全由本地模板生成（模型内容已转义），开启 JS 只为读取 scrollHeight
    webPreferences: { offscreen: true, javascript: true, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  sharedWin.on('closed', () => { sharedWin = null; });
  return sharedWin;
}

/** 一批渲染结束后释放隐藏窗口（长期挂着一个窗口会占显存）。 */
function disposeWin() {
  if (sharedWin && !sharedWin.isDestroyed()) {
    try { sharedWin.destroy(); } catch (e) { /* 已销毁 */ }
  }
  sharedWin = null;
}

/**
 * 渲染单张 → {dataUri, width, height} | null。
 * decl 是 core.illustration.normalizeDecl 的产物。
 */
async function renderOne(decl, { logger, customHtml, cover = false } = {}) {
  const html = customHtml || core.buildIllustrationHtml(decl);
  if (!html) return null;

  try {
    const win = ensureWin();
    win.setContentSize(cover ? 900 : VIEW_WIDTH, cover ? 383 : 600);
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await sleep(160); // 等字体与布局稳定（中文首帧偶尔还没排版完）

    let h = 600;
    try {
      const measured = await win.webContents.executeJavaScript(
        `Math.max(${MIN_HEIGHT}, Math.min(document.body.scrollHeight, ${MAX_HEIGHT}))`
      );
      if (Number.isFinite(measured) && measured > 0) h = Math.round(measured);
    } catch (e) {
      h = 600; // 量高失败不致命：退回默认高度，图可能带白边但内容不丢
    }
    win.setContentSize(cover ? 900 : VIEW_WIDTH, cover ? 383 : h);
    await sleep(140);

    let img = await win.capturePage();
    if (!img || img.isEmpty()) {
      await sleep(320); // 首帧偶发空白：再等一次重试
      img = await win.capturePage();
    }
    if (!img || img.isEmpty()) throw new Error('capturePage 返回空图');

    const size = img.getSize();
    const outputWidth = cover ? 900 : OUT_WIDTH;
    if (cover) {
      // Windows display scaling can round 383 logical pixels to a 384 px capture.
      img = img.resize({ width: 900, height: 383, quality: 'best' });
    } else if (size.width !== outputWidth) {
      img = img.resize({ width: outputWidth, quality: 'best' });
    }
    return {
      dataUri: 'data:image/png;base64,' + img.toPNG().toString('base64'),
      width: outputWidth,
      height: img.getSize().height,
    };
  } catch (e) {
    // 窗口可能已经被搞坏：丢掉它，下次重建（避免后续每一张都失败）
    disposeWin();
    if (logger && logger.warn) logger.warn(`插图渲染失败（${decl && decl.type}）：${e.message}`);
    return null;
  }
}

/**
 * 把文章正文里的 <illus> 声明全部渲染并替换成 <img src="data:image/png;base64,...">。
 *
 * 为什么内联 data URI 而不是存文件 + 传路径：
 * - 预览层（renderer）能直接显示，不用额外的读文件通道；
 * - 上传时既有的 article.localizeImages 已经支持 data: 分支，自动转存微信图床；
 * - 文章目录里的 preview.html 仍然自包含，拷走也能看。
 *
 * 返回 {article, rendered, dropped}；渲染失败只减少张数，不改动正文其他部分。
 */
async function materializeArticle(article, { logger, localAssets = [] } = {}) {
  return enqueue(async () => {
    try {
      let html = String(article && article.html || '');
      if (!html.trim()) throw new Error('正文为空，无法生成配图');
      const nodes = core.findIllustrations(html).slice(0, 3);
      const results = [];
      for (const n of nodes) results.push(n.decl ? await renderOne(n.decl, {logger}) : null);
      const applied = core.applyIllustrations(html, results);
      html = core.stripIllustrations(applied.html);
      let rendered = applied.rendered;
      const fallbacks = visualPlan({...article, html});
      while (rendered < 2) {
        const image = await renderOne(fallbacks[rendered % fallbacks.length], {logger});
        if (!image) throw new Error('正文配图渲染失败，请重试生成');
        const tag = core.imgTagOf(image.dataUri, fallbacks[rendered % fallbacks.length]);
        const paragraphs = [...html.matchAll(/<\/p>/gi)];
        const point = paragraphs.length ? paragraphs[Math.min(paragraphs.length - 1, Math.floor(paragraphs.length * (rendered + 1) / 3))] : null;
        const at = point ? point.index + point[0].length : html.length;
        html = html.slice(0, at) + tag + html.slice(at);
        rendered++;
      }
      const withAssets = require('./local-assets').embedLocalAssets({...article,html},localAssets);
      html = withAssets.html;
      const cover = await renderOne(null, {logger, cover:true, customHtml:coverHtml(article)});
      if (!cover) throw new Error('文章封面渲染失败，请重试生成');
      if (logger && logger.info) logger.info(`文章视觉已生成：${rendered} 张正文图 + 独立封面`);
      return {article:{...withAssets,html,coverDataUri:cover.dataUri,visuals:{bodyImages:rendered+(withAssets.assetEvidence||[]).length,generatedImages:rendered,localImages:(withAssets.assetEvidence||[]).length,cover:true,kind:localAssets.length?'信息图与本地素材':'本地信息图'}},rendered,dropped:applied.dropped};
    } catch(e) { e.code = 'E_MEDIA'; throw e; }
    finally { disposeWin(); }
  });
}

module.exports = { renderOne, materializeArticle, disposeWin, VIEW_WIDTH, OUT_WIDTH, MAX_HEIGHT };
