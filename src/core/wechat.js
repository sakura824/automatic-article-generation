'use strict';
/**
 * wechat.js —— 微信公众号接口（移植 run_daily.py:125-210、541-564）。
 * 覆盖：access_token 获取、永久素材 multipart 上传、uploadimg、draft/add、draft/delete，
 * 错误码（40164/40001/40013/48001/45009/40007/41001）映射为中文处理建议。
 * 契约 §4：所有网络函数入口先判 isMock()，命中则委托 mock.js 的确定性桩；
 * fetch 可注入（deps.fetch），测试零真实网络。multipart 边界构造照搬命令行版。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isMock, mockAccessToken, mockCoverMediaId, nextMockDraftId, nextMockImageUrl } = require('./mock');

const WECHAT_API = 'https://api.weixin.qq.com';
/** 网络类错误总尝试次数 = 首次 + 重试 2 次（PRD §8）。 */
const RETRY_ATTEMPTS = 3;
const TOKEN_TIMEOUT_MS = 60 * 1000;
const UPLOAD_TIMEOUT_MS = 120 * 1000;

/** 错误码 → 中文处理建议（与命令行版 ERRCODE_HINTS 一致）。 */
const ERRCODE_HINTS = {
  40164:
    '调用 IP 不在白名单。登录 mp.weixin.qq.com →「设置与开发 → 基本配置 → IP白名单」，把 errmsg 里给出的 IP 加进去再试。',
  40001: 'AppSecret 不正确或已被重置。请到公众平台「设置与开发 → 基本配置」重新获取并更新。',
  40013: 'AppID 不正确，请检查配置中的 AppID。',
  48001:
    '该账号没有此接口的权限。到「设置与开发 → 接口权限」确认「草稿箱」「素材管理」是否显示已获得。',
  45009: '接口调用频率超限，明天再试。',
  40007: '封面图格式不支持，请换成 jpg/png（建议 900×383）。',
  41001: 'access_token 缺失或已过期，请重新获取。',
};

/**
 * errcode → 处理建议。40164 的 hint 从 errmsg 提取第一个 IPv4 地址，
 * 提取不到时回退通用文案；未知 errcode 返回 ''。
 */
function hintFor(errcode, errmsg) {
  const code = Number(errcode);
  if (code === 40164) {
    const m = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(String(errmsg || ''));
    if (m) {
      return `调用 IP 不在白名单：请把 IP ${m[1]} 添加到 mp.weixin.qq.com「设置与开发 → 基本配置 → IP白名单」后重试。`;
    }
    return ERRCODE_HINTS[40164];
  }
  return ERRCODE_HINTS[code] || '';
}

/** 微信接口业务错误：携带 errcode/errmsg/hint，code 固定 E_WECHAT（IPC 信封直接透传）。 */
class WechatError extends Error {
  constructor(resp) {
    const errcode = resp && resp.errcode !== undefined ? Number(resp.errcode) : undefined;
    const errmsg = (resp && resp.errmsg) || '';
    const hint = hintFor(errcode, errmsg);
    super(
      hint
        ? `微信接口错误 errcode=${errcode} errmsg=${errmsg}；处理建议：${hint}`
        : `微信接口错误：${JSON.stringify(resp).slice(0, 300)}`
    );
    this.name = 'WechatError';
    this.code = 'E_WECHAT';
    this.errcode = errcode;
    this.errmsg = errmsg;
    this.hint = hint;
  }
}

function inputError(message) {
  const e = new Error(message);
  e.code = 'E_INVALID_INPUT';
  return e;
}

function ioError(message) {
  const e = new Error(message);
  e.code = 'E_IO';
  return e;
}

function snippet(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * 微信 HTTP 封装（带网络类重试）：返回解析后的 JSON 对象。
 * - 2xx 但非 JSON → E_NET（微信接口恒为 JSON，视作异常响应）；
 * - 非 2xx 且 body 可解析出 errcode → 原样返回（调用方抛 WechatError，与 Python _http 一致）；
 * - 其余非 2xx（5xx/429 重试耗尽）→ E_NET。
 */
async function wechatHttp(url, init, deps = {}, timeoutMs = TOKEN_TIMEOUT_MS) {
  const doFetch = deps.fetch || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    const e = new Error('当前环境没有可用的 fetch 实现');
    e.code = 'E_NET';
    throw e;
  }
  const retryDelayMs = deps.retryDelayMs == null ? 1000 : deps.retryDelayMs;
  let lastHttp = null;
  let lastNetErr = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('请求超时')), timeoutMs);
    try {
      const res = await doFetch(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = null;
      }
      if (res.ok) {
        if (data && typeof data === 'object') return data;
        throw new Error(`微信接口返回非 JSON：${snippet(text)}`);
      }
      if (data && typeof data === 'object' && data.errcode !== undefined) {
        return data; // 微信以 JSON body 表达业务错误
      }
      lastHttp = { status: res.status, text };
      const retryable = res.status >= 500 || res.status === 429;
      if (!retryable) break;
    } catch (e) {
      lastNetErr = e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < RETRY_ATTEMPTS && retryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  if (lastHttp) {
    const e = new Error(`微信接口 HTTP ${lastHttp.status}：${snippet(lastHttp.text)}`);
    e.code = 'E_NET';
    e.status = lastHttp.status;
    throw e;
  }
  const e = new Error(
    `网络请求失败：${lastNetErr ? lastNetErr.message : '未知错误'}（已重试 ${RETRY_ATTEMPTS - 1} 次仍失败，请检查本机能否访问 api.weixin.qq.com）`
  );
  e.code = 'E_NET';
  throw e;
}

/** multipart/form-data 边界构造（照搬 http_post_multipart）。 */
function buildMultipartBody(filename, data, contentType, boundary) {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8'
  );
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return Buffer.concat([head, payload, tail]);
}

async function postMultipart(url, filename, data, contentType, deps = {}) {
  const boundary = '----wxdaily' + crypto.randomUUID().replace(/-/g, '');
  const body = buildMultipartBody(filename, data, contentType, boundary);
  return wechatHttp(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    },
    deps,
    UPLOAD_TIMEOUT_MS
  );
}

/**
 * 获取 access_token → {token, expiresIn}。
 * 失败（响应无 access_token）抛 WechatError。
 */
async function getAccessToken(cfg, deps = {}) {
  if (isMock()) return mockAccessToken(deps.now);
  const w = (cfg && cfg.wechat) || {};
  const appId = String(w.appId || '').trim();
  const appSecret = String(w.appSecret || '').trim();
  if (!appId || !appSecret) {
    throw inputError('AppID / AppSecret 未填写完整，无法获取 access_token：到「设置 → 公众号凭证」补全后重试');
  }
  const url =
    `${WECHAT_API}/cgi-bin/token?grant_type=client_credential` +
    `&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`;
  const data = await wechatHttp(url, { method: 'GET' }, deps);
  if (!data.access_token) throw new WechatError(data);
  return { token: data.access_token, expiresIn: Number(data.expires_in) || 7200 };
}

/**
 * wechat:test 通道的连接测试 → {expiresIn}。
 * 先校验非空（mock 下空值仍报 E_INVALID_INPUT，与契约一致），mock 命中即成功。
 */
async function testConnection(credentials, deps = {}) {
  const appId = String((credentials && credentials.appId) || '').trim();
  const appSecret = String((credentials && credentials.appSecret) || '').trim();
  if (!appId) throw inputError('AppID 未填写：到公众平台「设置与开发 → 基本配置」获取后填入');
  if (!appSecret) throw inputError('AppSecret 未填写：到公众平台「基本配置」重新获取后填入');
  if (isMock()) return { expiresIn: 7200 };
  const { expiresIn } = await getAccessToken({ wechat: { appId, appSecret } }, deps);
  return { expiresIn };
}

/**
 * 解析封面路径：优先用户在设置中配置的 cfg.content.coverPath，
 * 其次 deps.coverPath（主进程传入的应用内置默认封面 assets/default_cover.png）；
 * 都没有或都不可访问 → null（mock 模式用占位字节，真实模式抛 E_IO）。
 */
function resolveCoverPath(cfg, deps = {}) {
  const candidates = [];
  const p = cfg && cfg.content && cfg.content.coverPath;
  if (p) candidates.push(p);
  if (deps.coverPath) candidates.push(deps.coverPath);
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (e) {
      // 忽略不可访问路径，继续候选
    }
  }
  return null;
}

/**
 * 封面永久素材 → {mediaId, reused}。
 * 按 sha256 指纹缓存（state.cover），同图不重传；成功后写回 state.cover（持久化由调用方负责）。
 * deps: {fetch?, coverPath?, retryDelayMs?}。找不到封面：mock 模式用固定占位字节，真实模式抛 E_IO。
 */
async function ensureCoverMaterial(cfg, token, state, deps = {}) {
  const coverPath = resolveCoverPath(cfg, deps);
  let bytes;
  let filename;
  let mime;
  if (deps.coverDataUri) {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(deps.coverDataUri);
    if (!match) throw ioError('自动封面格式无效，请重新生成文章');
    bytes = Buffer.from(match[1], 'base64');
    filename = 'article-cover.png';
    mime = 'image/png';
  } else if (coverPath) {
    bytes = fs.readFileSync(coverPath);
    const ext = path.extname(coverPath).toLowerCase();
    const isPng = ext === '.png';
    if (!isPng && ext !== '.jpg' && ext !== '.jpeg') {
      throw new WechatError({ errcode: 40007, errmsg: `不支持的封面格式 ${ext || '(无后缀)'}` });
    }
    filename = 'cover' + (isPng ? '.png' : '.jpg');
    mime = isPng ? 'image/png' : 'image/jpeg';
  } else if (isMock()) {
    bytes = Buffer.from('mock-cover');
    filename = 'cover.png';
    mime = 'image/png';
  } else {
    throw ioError('找不到封面图：请在「设置 → 内容与文风」选择一张 jpg/png（建议 900×383）');
  }

  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const cached = state && state.cover;
  if (cached && cached.sha256 === digest && cached.mediaId) {
    return { mediaId: cached.mediaId, reused: true };
  }

  let mediaId;
  if (isMock()) {
    mediaId = mockCoverMediaId(digest);
  } else {
    const data = await postMultipart(
      `${WECHAT_API}/cgi-bin/material/add_material?access_token=${encodeURIComponent(token)}&type=image`,
      filename,
      bytes,
      mime,
      deps
    );
    if (!data.media_id) throw new WechatError(data);
    mediaId = data.media_id;
  }
  if (state) state.cover = { sha256: digest, mediaId };
  return { mediaId, reused: false };
}

/**
 * 正文配图上传（uploadimg）→ {url}。正文外链图必须换微信图床，否则发布时被过滤。
 * deps: {fetch?, retryDelayMs?}
 */
async function uploadContentImage(token, bytes, filename = 'img.png', contentType = 'image/png', deps = {}) {
  if (isMock()) return { url: nextMockImageUrl() };
  const data = await postMultipart(
    `${WECHAT_API}/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(token)}`,
    filename,
    bytes,
    contentType,
    deps
  );
  if (!data.url) throw new WechatError(data);
  return { url: data.url };
}

/**
 * 创建草稿（draft/add，articles 单篇）→ {mediaId}。
 * deps: {fetch?, retryDelayMs?}
 */
async function createDraft(token, payload, deps = {}) {
  if (isMock()) return { mediaId: nextMockDraftId() };
  const data = await wechatHttp(
    `${WECHAT_API}/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ articles: [payload] }),
    },
    deps,
    UPLOAD_TIMEOUT_MS
  );
  if (!data.media_id) throw new WechatError(data);
  return { mediaId: data.media_id };
}

/**
 * 删除草稿（draft/delete）→ {deleted:true}。errcode 非 0 抛 WechatError。
 * deps: {fetch?, retryDelayMs?}
 */
async function deleteDraft(token, mediaId, deps = {}) {
  if (isMock()) return { deleted: true };
  const data = await wechatHttp(
    `${WECHAT_API}/cgi-bin/draft/delete?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ media_id: mediaId }),
    },
    deps
  );
  const errcode = data && data.errcode !== undefined ? Number(data.errcode) : 0;
  if (errcode !== 0) throw new WechatError(data);
  return { deleted: true };
}

const SELF_CHECK_IDS = ['token', 'cover', 'draft', 'cleanup'];

/**
 * 一键自检（4 步：token/素材/建测试草稿/删草稿），逐项回调 onStep({index, state, detail, errcode?})，
 * index 0..3 对应设计稿 .check-item[data-ck]。任何一步失败即停止，其余步骤 items 标记 fail（未执行）。
 * 返回 {items:[{id, state:'ok'|'fail', detail, errcode?}]}。
 * deps 透传给底层网络函数（fetch 等）。
 */
async function runSelfCheck(cfg, state, onStep = () => {}, deps = {}) {
  const items = [];
  const emit = (index, st, detail, errcode) => {
    const ev = { index, state: st, detail };
    if (errcode !== undefined) ev.errcode = errcode;
    onStep(ev);
  };
  try {
    emit(0, 'run', '正在获取 access_token…');
    const { token, expiresIn } = await getAccessToken(cfg, deps);
    const d0 = `access_token 获取成功 · ${expiresIn}s`;
    emit(0, 'ok', d0);
    items.push({ id: SELF_CHECK_IDS[0], state: 'ok', detail: d0 });

    emit(1, 'run', '正在上传封面永久素材…');
    const { mediaId } = await ensureCoverMaterial(cfg, token, state, deps);
    const d1 = `封面素材已就绪 media_id=…${String(mediaId).slice(-4)}`;
    emit(1, 'ok', d1);
    items.push({ id: SELF_CHECK_IDS[1], state: 'ok', detail: d1 });

    emit(2, 'run', '正在创建测试草稿…');
    const { mediaId: draftId } = await createDraft(
      token,
      {
        title: '接口连通性测试（可直接删除）',
        content: '<p style="font-size:15px;">这是公众号写作助手的连通性测试草稿，确认无误后可直接删除。</p>',
        thumb_media_id: mediaId,
        need_open_comment: 0,
        only_fans_can_comment: 0,
      },
      deps
    );
    emit(2, 'ok', '测试草稿创建成功');
    items.push({ id: SELF_CHECK_IDS[2], state: 'ok', detail: '测试草稿创建成功' });

    emit(3, 'run', '正在清理测试草稿…');
    await deleteDraft(token, draftId, deps);
    emit(3, 'ok', '测试草稿已删除');
    items.push({ id: SELF_CHECK_IDS[3], state: 'ok', detail: '测试草稿已删除' });
    return { items };
  } catch (e) {
    const from = items.length; // 下一个未完成步骤的下标
    for (let i = from; i < SELF_CHECK_IDS.length; i++) {
      const item = { id: SELF_CHECK_IDS[i], state: 'fail' };
      if (i === from) {
        item.detail = e.message;
        if (e.errcode !== undefined) item.errcode = e.errcode;
      } else {
        item.detail = '未执行（前置步骤失败）';
      }
      items.push(item);
    }
    return { items };
  }
}

/**
 * 草稿箱列表（draft/batchget，分页拉全）→ [{mediaId, title, updateTime}]。
 * 用途：状态同步——本地「已上传待发表」的稿子如果不在草稿箱里，
 * 要么已发表、要么被删除，结合发布列表即可判定真实状态。
 * deps: {fetch?, retryDelayMs?}
 */
async function listDrafts(token, deps = {}, { maxPages = 10 } = {}) {
  if (isMock()) return [];
  const out = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const data = await wechatHttp(
      `${WECHAT_API}/cgi-bin/draft/batchget?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ offset, count: 20, no_content: 0 }),
      },
      deps
    );
    const errcode = data && data.errcode !== undefined ? Number(data.errcode) : 0;
    if (errcode !== 0) throw new WechatError(data);
    const items = Array.isArray(data.item) ? data.item : [];
    for (const it of items) {
      const news = (it.content && it.content.news_item) || [];
      out.push({
        mediaId: it.media_id,
        title: news[0] && news[0].title ? String(news[0].title) : '',
        updateTime: it.update_time || null,
      });
    }
    const total = Number(data.total) || out.length;
    offset += items.length;
    if (out.length >= total || items.length < 20) break;
  }
  return out;
}

/**
 * 成功发布列表（freepublish/batchget + freepublish/get 取标题）→ [{publishId, articleId, title}]。
 * publishId → 标题的查询结果经 cache 对象复用，避免每次同步都逐条调 get。
 * deps: {fetch?, retryDelayMs?}
 */
async function listPublishedTitles(token, deps = {}, cache = {}, { maxPages = 10 } = {}) {
  if (isMock()) return [];
  const out = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const data = await wechatHttp(
      `${WECHAT_API}/cgi-bin/freepublish/batchget?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ offset, count: 20, no_content: 0 }),
      },
      deps
    );
    const errcode = data && data.errcode !== undefined ? Number(data.errcode) : 0;
    if (errcode !== 0) throw new WechatError(data);
    const items = Array.isArray(data.item) ? data.item : [];
    for (const it of items) {
      const publishId = it.publish_id;
      let title = cache[publishId];
      if (!title) {
        const detail = await wechatHttp(
          `${WECHAT_API}/cgi-bin/freepublish/get?access_token=${encodeURIComponent(token)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ publish_id: publishId }),
          },
          deps
        );
        const derr = detail && detail.errcode !== undefined ? Number(detail.errcode) : 0;
        if (derr !== 0) throw new WechatError(detail);
        const news = (detail.article_detail && detail.article_detail.news_item) || [];
        title = news[0] && news[0].title ? String(news[0].title) : '';
        cache[publishId] = title;
      }
      out.push({ publishId, articleId: it.article_id || null, title, updateTime: it.update_time || null });
    }
    const total = Number(data.total) || out.length;
    offset += items.length;
    if (out.length >= total || items.length < 20) break;
  }
  return out;
}

module.exports = {
  WECHAT_API,
  ERRCODE_HINTS,
  WechatError,
  hintFor,
  getAccessToken,
  testConnection,
  ensureCoverMaterial,
  uploadContentImage,
  createDraft,
  deleteDraft,
  listDrafts,
  listPublishedTitles,
  runSelfCheck,
};
