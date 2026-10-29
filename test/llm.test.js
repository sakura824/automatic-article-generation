'use strict';
/**
 * llm.test.js —— LLM 模块（真实模式，WECHAT_DAILY_MOCK 必须未设置）：
 * prompt 构造、输出解析（含截断/格式失败）、chat/completions 调用（注入 fetch）、
 * 网络重试、HTTP 错误、mock 关闭路径。mock 桩本身在 wechat-mock.test.js 覆盖。
 */
delete process.env.WECHAT_DAILY_MOCK;

const test = require('node:test');
const assert = require('node:assert');
const {
  MAX_TITLE,
  MAX_DIGEST,
  LlmError,
  LlmFormatError,
  chatCompletionsUrl,
  buildPrompt,
  callLlm,
  parseLlmOutput,
  probeLlm,
} = require('../src/core/llm');
const { res, router, SAMPLE_LLM_RAW } = require('./helpers');

const CFG = {
  llm: { baseUrl: 'https://llm.example.com/v4', apiKey: 'sk-test', model: 'glm-4.6', temperature: 0.7 },
  content: { audience: '一线后端工程师', styleExtra: '多用真实数字举例' },
};

const fmt = (title, digest, html) => `===TITLE===\n${title}\n===DIGEST===\n${digest}\n===BODY_HTML===\n${html}`;

test('chatCompletionsUrl：baseUrl 拼接与尾部斜杠清理', () => {
  assert.strictEqual(chatCompletionsUrl('https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.strictEqual(chatCompletionsUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions');
  assert.throws(() => chatCompletionsUrl(''), (e) => e.code === 'E_INVALID_INPUT');
});

test('buildPrompt：约定格式、读者画像、风格补充、日期', () => {
  const p = buildPrompt('## 提交记录\nabc fix: x', CFG, '2026-10-29');
  for (const s of ['===TITLE===', '===DIGEST===', '===BODY_HTML===', '微信适配的 HTML', '读者：一线后端工程师', '多用真实数字举例', '仓库提交记录（2026-10-29）', '## 提交记录']) {
    assert.ok(p.includes(s), `prompt 应包含 ${s}`);
  }
  // audience 缺省值
  const p2 = buildPrompt('d', { content: {} }, '2026-10-29');
  assert.ok(p2.includes('读者：关注内容的读者')); // 未填读者画像时的通用兜底
});

test('parseLlmOutput 正常解析：title/digest/html', () => {
  const a = parseLlmOutput(SAMPLE_LLM_RAW);
  assert.strictEqual(a.title, '修复配置读取的空指针：一次边界条件的排查');
  assert.strictEqual(a.digest, '本次修复了配置为空时的读取崩溃，并补充了对应测试。');
  assert.ok(a.html.startsWith('<p'));
  // 标题内部空白折叠
  const b = parseLlmOutput(fmt('修   复\n配置', '摘要', '<p>x</p>'));
  assert.strictEqual(b.title, '修 复 配置');
});

test('parseLlmOutput 截断：标题 ≤58 字；摘要 >118 字截断加 …', () => {
  const longTitle = '标'.repeat(80);
  const a = parseLlmOutput(fmt(longTitle, 'd', '<p>x</p>'));
  assert.strictEqual(Array.from(a.title).length, MAX_TITLE);

  const longDigest = '摘'.repeat(200);
  const b = parseLlmOutput(fmt('t', longDigest, '<p>x</p>'));
  assert.strictEqual(Array.from(b.digest).length, MAX_DIGEST + 1); // 118 + …
  assert.ok(b.digest.endsWith('…'));
  assert.strictEqual(b.digest.slice(0, MAX_DIGEST), '摘'.repeat(MAX_DIGEST));

  // 恰好 118 字不加 …
  const exact = parseLlmOutput(fmt('t', '摘'.repeat(MAX_DIGEST), '<p>x</p>'));
  assert.strictEqual(exact.digest, '摘'.repeat(MAX_DIGEST));
});

test('parseLlmOutput 格式解析失败 → LlmFormatError', () => {
  for (const bad of [
    '',
    '抱歉，我无法按该格式输出。',
    '===TITLE===\n只有标题',
    '===TITLE===\nt\n===DIGEST===\nd', // 缺 BODY_HTML
    '===DIGEST===\nd\n===BODY_HTML===\n<p>x</p>', // 缺 TITLE
  ]) {
    assert.throws(() => parseLlmOutput(bad), (e) => {
      assert.ok(e instanceof LlmFormatError);
      assert.strictEqual(e.code, 'E_LLM');
      assert.match(e.message, /===TITLE===/);
      return true;
    }, `应拒绝：${JSON.stringify(bad).slice(0, 40)}`);
  }
  // CRLF 输入同样可解析（\s* 容忍 \r）
  const crlf = parseLlmOutput(fmt('t', 'd', '<p>x</p>').replace(/\n/g, '\r\n'));
  assert.strictEqual(crlf.title, 't');
  assert.strictEqual(crlf.html, '<p>x</p>');
});

test('callLlm 正常流：URL/鉴权/payload 正确，返回 raw/model/latencyMs', async () => {
  const { fetch, calls } = router([
    [/\/chat\/completions$/, () => res(200, { model: 'glm-4.6', choices: [{ message: { content: SAMPLE_LLM_RAW } }] })],
  ]);
  const r = await callLlm(CFG, 'PROMPT', { fetch, retryDelayMs: 0 });
  assert.strictEqual(r.raw, SAMPLE_LLM_RAW);
  assert.strictEqual(r.model, 'glm-4.6');
  assert.ok(typeof r.latencyMs === 'number');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://llm.example.com/v4/chat/completions');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(calls[0].init.body);
  assert.deepStrictEqual(body, {
    model: 'glm-4.6',
    messages: [{ role: 'user', content: 'PROMPT' }],
    temperature: 0.7,
  });
});

test('callLlm 缺少 API Key → E_INVALID_INPUT，且不发请求', async () => {
  const { fetch, calls } = router([]);
  await assert.rejects(
    () => callLlm({ llm: { baseUrl: 'https://x', model: 'm', apiKey: '' } }, 'p', { fetch }),
    (e) => {
      assert.strictEqual(e.code, 'E_INVALID_INPUT');
      return true;
    }
  );
  assert.strictEqual(calls.length, 0);
});

test('callLlm HTTP 401/400：立即抛 E_LLM 且不重试', async () => {
  const { fetch, calls } = router([
    [/\/chat\/completions$/, () => res(401, { error: { message: 'invalid api key' } })],
  ]);
  await assert.rejects(
    () => callLlm(CFG, 'p', { fetch, retryDelayMs: 0 }),
    (e) => {
      assert.ok(e instanceof LlmError);
      assert.strictEqual(e.code, 'E_LLM');
      assert.strictEqual(e.status, 401);
      assert.match(e.message, /HTTP 401/);
      assert.match(e.message, /invalid api key/);
      return true;
    }
  );
  assert.strictEqual(calls.length, 1);
});

test('callLlm 网络错误：重试 2 次后成功（共 3 次）', async () => {
  let n = 0;
  const fetch = async () => {
    n += 1;
    if (n <= 2) throw new TypeError('fetch failed: ECONNRESET');
    return res(200, { choices: [{ message: { content: SAMPLE_LLM_RAW } }] });
  };
  const r = await callLlm(CFG, 'p', { fetch, retryDelayMs: 0 });
  assert.strictEqual(r.raw, SAMPLE_LLM_RAW);
  assert.strictEqual(n, 3);
});

test('callLlm HTTP 500 连续 3 次 → E_LLM（含状态码）', async () => {
  const { fetch, calls } = router([
    [/\/chat\/completions$/, () => res(500, 'upstream error')],
  ]);
  await assert.rejects(
    () => callLlm(CFG, 'p', { fetch, retryDelayMs: 0 }),
    (e) => {
      assert.strictEqual(e.code, 'E_LLM');
      assert.strictEqual(e.status, 500);
      return true;
    }
  );
  assert.strictEqual(calls.length, 3); // 首次 + 重试 2 次
});

test('callLlm fetch 始终抛错 → E_NET（重试 2 次后放弃）', async () => {
  let n = 0;
  const fetch = async () => {
    n += 1;
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    () => callLlm(CFG, 'p', { fetch, retryDelayMs: 0 }),
    (e) => {
      assert.strictEqual(e.code, 'E_NET');
      assert.match(e.message, /网络请求失败/);
      return true;
    }
  );
  assert.strictEqual(n, 3);
});

test('callLlm 响应缺 choices → E_LLM；非 JSON → E_LLM', async () => {
  const bad1 = router([[/x/, () => res(200, { object: 'chat.completion' })]]);
  await assert.rejects(() => callLlm(CFG, 'p', { fetch: bad1.fetch, retryDelayMs: 0 }), (e) => {
    assert.ok(e instanceof LlmError);
    assert.match(e.message, /返回格式异常/);
    return true;
  });
  const bad2 = router([[/x/, () => res(200, '<html>gateway</html>')]]);
  await assert.rejects(() => callLlm(CFG, 'p', { fetch: bad2.fetch, retryDelayMs: 0 }), (e) => {
    assert.ok(e instanceof LlmError);
    assert.match(e.message, /不是 JSON/);
    return true;
  });
});

test('probeLlm：返回模型名与延迟；空值报 E_INVALID_INPUT', async () => {
  const { fetch, calls } = router([[/\/chat\/completions$/, () => res(200, { choices: [{ message: { content: 'OK' } }] })]]);
  const r = await probeLlm(CFG, { fetch, retryDelayMs: 0 });
  assert.strictEqual(r.model, 'glm-4.6');
  assert.ok(r.latencyMs >= 0);
  assert.strictEqual(calls.length, 1);
  for (const bad of [
    { llm: { baseUrl: 'https://x', model: 'm', apiKey: '' } },
    { llm: { baseUrl: 'https://x', model: '', apiKey: 'k' } },
    { llm: { baseUrl: '', model: 'm', apiKey: 'k' } },
  ]) {
    await assert.rejects(() => probeLlm(bad, { fetch }), (e) => e.code === 'E_INVALID_INPUT');
  }
});

test('buildPrompt：注入项目背景与文风画像（仓库自动与 v2 三条路径同口径）', () => {
  const p = buildPrompt('d', { content: {} }, '2026-10-29', {
    projectBlock: '【项目背景】\n- 受众：效率工具用户',
    styleInjection: '【文风画像】\n- 开头习惯：提问开头',
  });
  assert.ok(p.includes('【项目背景】'));
  assert.ok(p.includes('【文风画像】'));
  // 未传 ctx 时不出现这些块（保持 v1 行为）
  const plain = buildPrompt('d', { content: {} }, '2026-10-29');
  assert.ok(!plain.includes('【项目背景】'));
});
