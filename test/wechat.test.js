'use strict';
/**
 * wechat.test.js —— 微信模块真实模式（注入 fetch，零真实网络）：
 * multipart 边界构造、access_token 错误码映射（40164/40001/40013/48001/41001/未知）、
 * 素材缓存、uploadimg、draft/add、draft/delete、自检失败中止。
 */
delete process.env.WECHAT_DAILY_MOCK;

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
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
  runSelfCheck,
} = require('../src/core/wechat');
const { tmpDir, res, router } = require('./helpers');

const DEPS = { retryDelayMs: 0 };

test('hintFor：40164 从 errmsg 提取 IP；其余映射通用文案；未知 → 空', () => {
  const h = hintFor(40164, 'invalid ip 192.0.2.10 ipv6 ::ffff:192.0.2.10, have 198.51.100.7 hint 5');
  assert.ok(h.includes('192.0.2.10'), 'hint 应包含 errmsg 提取的 IP');
  assert.ok(h.includes('IP白名单'));
  assert.strictEqual(hintFor(40164, 'no ip here'), ERRCODE_HINTS[40164]);
  assert.ok(hintFor(40001, '').includes('AppSecret 不正确或已被重置'));
  assert.ok(hintFor(40013, '').includes('AppID 不正确'));
  assert.ok(hintFor(48001, '').includes('接口权限'));
  assert.ok(hintFor(45009, '').includes('频率超限'));
  assert.ok(hintFor(40007, '').includes('jpg/png'));
  assert.ok(hintFor(41001, '').includes('access_token'));
  assert.strictEqual(hintFor(99999, ''), '');
  assert.strictEqual(hintFor(undefined, ''), '');
});

test('getAccessToken：URL 与返回值', async () => {
  const { fetch, calls } = router([
    [/\/cgi-bin\/token/, () => res(200, { access_token: 'TK123', expires_in: 7200 })],
  ]);
  const r = await getAccessToken({ wechat: { appId: 'wx123', appSecret: 'sec/+,?' } }, { ...DEPS, fetch });
  assert.deepStrictEqual(r, { token: 'TK123', expiresIn: 7200 });
  assert.strictEqual(
    calls[0].url,
    `${WECHAT_API}/cgi-bin/token?grant_type=client_credential&appid=wx123&secret=sec%2F%2B%2C%3F`
  );
});

test('getAccessToken 错误码映射：40164 带 IP 提示；40001/40013/48001 通用提示', async () => {
  const cases = [
    [{ errcode: 40164, errmsg: 'invalid ip 1.2.3.4 ipv6 ::ffff:1.2.3.4 hint 5' }, /1\.2\.3\.4/, 40164],
    [{ errcode: 40001, errmsg: 'invalid credential' }, /AppSecret 不正确或已被重置/, 40001],
    [{ errcode: 40013, errmsg: 'invalid appid' }, /AppID 不正确/, 40013],
    [{ errcode: 48001, errmsg: 'api unauthorized' }, /接口权限/, 48001],
  ];
  for (const [resp, hintRe, errcode] of cases) {
    const { fetch } = router([[/\/cgi-bin\/token/, () => res(200, resp)]]);
    await assert.rejects(
      () => getAccessToken({ wechat: { appId: 'wx', appSecret: 's' } }, { ...DEPS, fetch }),
      (e) => {
        assert.ok(e instanceof WechatError);
        assert.strictEqual(e.code, 'E_WECHAT');
        assert.strictEqual(e.errcode, errcode);
        assert.match(e.hint, hintRe);
        assert.match(e.message, /处理建议/);
        return true;
      }
    );
  }
});

test('getAccessToken：AppID/AppSecret 缺失 → E_INVALID_INPUT（不发请求）', async () => {
  const { fetch, calls } = router([]);
  await assert.rejects(
    () => getAccessToken({ wechat: { appId: '', appSecret: '' } }, { ...DEPS, fetch }),
    (e) => e.code === 'E_INVALID_INPUT'
  );
  assert.strictEqual(calls.length, 0);
});

test('testConnection：空值 E_INVALID_INPUT；成功返回 expiresIn', async () => {
  const { fetch, calls } = router([
    [/\/cgi-bin\/token/, () => res(200, { access_token: 'T', expires_in: 7200 })],
  ]);
  await assert.rejects(() => testConnection({ appId: '', appSecret: 's' }, { ...DEPS, fetch }), (e) => e.code === 'E_INVALID_INPUT');
  await assert.rejects(() => testConnection({ appId: 'a', appSecret: '' }, { ...DEPS, fetch }), (e) => e.code === 'E_INVALID_INPUT');
  const r = await testConnection({ appId: 'a', appSecret: 's' }, { ...DEPS, fetch });
  assert.deepStrictEqual(r, { expiresIn: 7200 });
  assert.strictEqual(calls.length, 1);
});

test('ensureCoverMaterial：multipart 上传 + sha256 指纹缓存', async () => {
  const dir = tmpDir();
  const cover = path.join(dir, 'cover.png');
  const bytes = Buffer.from('png-bytes-1');
  fs.writeFileSync(cover, bytes);
  const wantDigest = crypto.createHash('sha256').update(bytes).digest('hex');

  let coverUploads = 0;
  const { fetch, calls } = router([
    [/\/cgi-bin\/material\/add_material/, () => {
      coverUploads += 1;
      return res(200, { media_id: 'COVER' + coverUploads });
    }],
  ]);
  const state = {};
  const first = await ensureCoverMaterial({ content: { coverPath: cover } }, 'TK', state, { ...DEPS, fetch });
  assert.deepStrictEqual(first, { mediaId: 'COVER1', reused: false });
  assert.deepStrictEqual(state.cover, { sha256: wantDigest, mediaId: 'COVER1' });

  // 请求体是 multipart：boundary 头 + form-data 描述 + 二进制内容
  const ct = calls[0].init.headers['Content-Type'];
  assert.match(ct, /^multipart\/form-data; boundary=----wxdaily[0-9a-f]+$/);
  const boundary = /boundary=(.+)$/.exec(ct)[1];
  const body = calls[0].init.body.toString('latin1');
  assert.ok(body.includes('Content-Disposition: form-data; name="media"; filename="cover.png"'));
  assert.ok(body.includes('Content-Type: image/png'));
  assert.ok(body.includes('png-bytes-1'));
  assert.ok(body.startsWith(`--${boundary}\r\n`));
  assert.ok(body.endsWith(`\r\n--${boundary}--\r\n`));

  // 同图第二次 → 复用缓存，不再请求
  const second = await ensureCoverMaterial({ content: { coverPath: cover } }, 'TK', state, { ...DEPS, fetch });
  assert.deepStrictEqual(second, { mediaId: 'COVER1', reused: true });
  assert.strictEqual(calls.length, 1);

  // 换图 → 重新上传
  fs.writeFileSync(cover, Buffer.from('png-bytes-2'));
  const third = await ensureCoverMaterial({ content: { coverPath: cover } }, 'TK', state, { ...DEPS, fetch });
  assert.strictEqual(third.reused, false);
  assert.notStrictEqual(third.mediaId, 'COVER1');
  assert.strictEqual(calls.length, 2);
});

test('ensureCoverMaterial：找不到封面 → 真实模式 E_IO', async () => {
  await assert.rejects(
    () => ensureCoverMaterial({ content: { coverPath: '' } }, 'TK', {}, { ...DEPS, fetch: async () => res(200, {}) }),
    (e) => {
      assert.strictEqual(e.code, 'E_IO');
      assert.match(e.message, /找不到封面图/);
      return true;
    }
  );
});

test('uploadContentImage：uploadimg 返回 url；缺 url → WechatError', async () => {
  const { fetch, calls } = router([
    [/\/cgi-bin\/media\/uploadimg/, () => res(200, { url: 'https://mmbiz.qpic.cn/abc' })],
  ]);
  const r = await uploadContentImage('TK', Buffer.from('img'), 'img.png', 'image/png', { ...DEPS, fetch });
  assert.strictEqual(r.url, 'https://mmbiz.qpic.cn/abc');
  assert.strictEqual(calls[0].url, `${WECHAT_API}/cgi-bin/media/uploadimg?access_token=TK`);
  const body = calls[0].init.body.toString('latin1');
  assert.ok(body.includes('filename="img.png"'));
  assert.ok(body.includes('img'));

  const bad = router([[/uploadimg/, () => res(200, { errcode: 40007, errmsg: 'invalid media type' })]]);
  await assert.rejects(
    () => uploadContentImage('TK', Buffer.from('x'), 'img.png', 'image/png', { ...DEPS, fetch: bad.fetch }),
    (e) => {
      assert.ok(e instanceof WechatError);
      assert.strictEqual(e.errcode, 40007);
      return true;
    }
  );
});

test('createDraft：请求体 {articles:[payload]}，返回 media_id', async () => {
  const { fetch, calls } = router([
    [/\/cgi-bin\/draft\/add/, () => res(200, { media_id: 'DRAFT1' })],
  ]);
  const payload = { title: 'T', content: '<p>c</p>', thumb_media_id: 'COVER', need_open_comment: 1 };
  const r = await createDraft('TK', payload, { ...DEPS, fetch });
  assert.strictEqual(r.mediaId, 'DRAFT1');
  assert.strictEqual(calls[0].url, `${WECHAT_API}/cgi-bin/draft/add?access_token=TK`);
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { articles: [payload] });

  const bad = router([[/draft\/add/, () => res(200, { errcode: 45009, errmsg: 'reach max api daily quota' })]]);
  await assert.rejects(
    () => createDraft('TK', payload, { ...DEPS, fetch: bad.fetch }),
    (e) => {
      assert.strictEqual(e.errcode, 45009);
      assert.ok(e.hint.includes('频率超限'));
      return true;
    }
  );
});

test('deleteDraft：errcode=0 成功；非 0 → WechatError（48001 映射）', async () => {
  const ok = router([[/draft\/delete/, () => res(200, { errcode: 0, errmsg: 'ok' })]]);
  assert.deepStrictEqual(await deleteDraft('TK', 'D1', { ...DEPS, fetch: ok.fetch }), { deleted: true });
  assert.deepStrictEqual(JSON.parse(ok.calls[0].init.body), { media_id: 'D1' });

  const denied = router([[/draft\/delete/, () => res(200, { errcode: 48001, errmsg: 'api unauthorized' })]]);
  await assert.rejects(
    () => deleteDraft('TK', 'D1', { ...DEPS, fetch: denied.fetch }),
    (e) => {
      assert.ok(e instanceof WechatError);
      assert.strictEqual(e.errcode, 48001);
      assert.ok(e.hint.includes('接口权限'));
      return true;
    }
  );
});

test('网络层：fetch 一直失败 → E_NET（3 次尝试）', async () => {
  let n = 0;
  const fetch = async () => {
    n += 1;
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    () => getAccessToken({ wechat: { appId: 'a', appSecret: 's' } }, { ...DEPS, fetch }),
    (e) => {
      assert.strictEqual(e.code, 'E_NET');
      assert.match(e.message, /网络请求失败/);
      return true;
    }
  );
  assert.strictEqual(n, 3);
});

test('runSelfCheck：4 步全 ok，onStep 顺序 run→ok', async () => {
  const dir = tmpDir();
  const cover = path.join(dir, 'c.png');
  fs.writeFileSync(cover, Buffer.from('cov'));
  const { fetch, calls } = router([
    [/\/cgi-bin\/token/, () => res(200, { access_token: 'T', expires_in: 7200 })],
    [/\/cgi-bin\/material\/add_material/, () => res(200, { media_id: 'COVR9D2F' })],
    [/\/cgi-bin\/draft\/add/, () => res(200, { media_id: 'DRAFTT' })],
    [/\/cgi-bin\/draft\/delete/, () => res(200, { errcode: 0 })],
  ]);
  const events2 = [];
  const out = await runSelfCheck({ wechat: { appId: 'wx1', appSecret: 's' }, content: { coverPath: cover } }, {}, (ev) => events2.push(ev), { ...DEPS, fetch });
  assert.strictEqual(out.items.length, 4);
  assert.deepStrictEqual(out.items.map((i) => i.id), ['token', 'cover', 'draft', 'cleanup']);
  assert.ok(out.items.every((i) => i.state === 'ok'));
  assert.match(out.items[0].detail, /access_token 获取成功 · 7200s/);
  assert.match(out.items[1].detail, /封面素材已就绪 media_id=…\w{4}/);
  assert.strictEqual(out.items[2].detail, '测试草稿创建成功');
  assert.strictEqual(out.items[3].detail, '测试草稿已删除');
  // 事件序：每步 run → ok
  assert.deepStrictEqual(
    events2.map((e) => e.state),
    ['run', 'ok', 'run', 'ok', 'run', 'ok', 'run', 'ok']
  );
  assert.deepStrictEqual(
    events2.map((e) => e.index),
    [0, 0, 1, 1, 2, 2, 3, 3]
  );
  assert.strictEqual(calls.length >= 4, true);
});

test('runSelfCheck：第 3 步 48001 → 前两步 ok，失败步带 errcode，清理步标记未执行', async () => {
  const dir = tmpDir();
  const cover = path.join(dir, 'c.png');
  fs.writeFileSync(cover, Buffer.from('cov'));
  const { fetch } = router([
    [/\/cgi-bin\/token/, () => res(200, { access_token: 'T', expires_in: 7200 })],
    [/\/cgi-bin\/material\/add_material/, () => res(200, { media_id: 'COVR' })],
    [/\/cgi-bin\/draft\/add/, () => res(200, { errcode: 48001, errmsg: 'api unauthorized' })],
  ]);
  const { items } = await runSelfCheck({ wechat: { appId: 'wx1', appSecret: 's' }, content: { coverPath: cover } }, {}, () => {}, { ...DEPS, fetch });
  assert.deepStrictEqual(items.map((i) => i.state), ['ok', 'ok', 'fail', 'fail']);
  assert.strictEqual(items[2].errcode, 48001);
  assert.match(items[2].detail, /接口权限/);
  assert.strictEqual(items[3].detail, '未执行（前置步骤失败）');
});
