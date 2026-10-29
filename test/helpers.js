'use strict';
/**
 * test/helpers.js —— 测试公共工具：临时目录、真实本地 git 仓库、假 fetch 路由、样例 LLM 输出。
 * 全部测试零真实网络：LLM/微信请求一律走注入的 fetch 路由；git 用本机真实临时仓库（纯本地操作）。
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 创建一次性临时目录。 */
function tmpDir(prefix = 'wdp-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitRun(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message))) : resolve(stdout))
    );
  });
}

/**
 * 在 dir 建一个真实 git 仓库并按序提交。
 * commits: [{files:{'a.txt':'content'}, msg:'...', date?:'2026-09-01T10:00:00'}]
 * 返回每个提交的完整 SHA（按提交顺序）。
 */
async function makeGitRepo(dir, commits) {
  await gitRun(['init', '-b', 'main'], dir);
  await gitRun(['config', 'user.email', 'test@example.com'], dir);
  await gitRun(['config', 'user.name', 'tester'], dir);
  const heads = [];
  for (const c of commits) {
    for (const [name, content] of Object.entries(c.files || {})) {
      const p = path.join(dir, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
    }
    await gitRun(['add', '-A'], dir);
    const env = {};
    if (c.date) {
      env.GIT_AUTHOR_DATE = c.date;
      env.GIT_COMMITTER_DATE = c.date;
    }
    await gitRun(['commit', '-m', c.msg], dir, env);
    heads.push((await gitRun(['rev-parse', 'HEAD'], dir)).trim());
  }
  return heads;
}

/** 构造 fetch Response 形状的最小对象（含 arrayBuffer，供图片下载路径使用）。 */
function res(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const bytes = Buffer.from(text, 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  };
}

/**
 * 假 fetch 路由：handlers = [[/url-regex/, ({url, init, calls}) => res(...)], ...]
 * 记录每次调用到 calls（{url, init}），未命中返回 404。
 */
function router(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [re, handler] of handlers) {
      if (re.test(u)) return handler({ url: u, init, calls });
    }
    return res(404, { errcode: -2, errmsg: 'no route: ' + u });
  };
  return { fetch: fetchImpl, calls };
}

/** 样例 LLM 输出（符合 ===TITLE===/===DIGEST===/===BODY_HTML=== 约定）。 */
const SAMPLE_LLM_RAW = [
  '===TITLE===',
  '修复配置读取的空指针：一次边界条件的排查',
  '===DIGEST===',
  '本次修复了配置为空时的读取崩溃，并补充了对应测试。',
  '===BODY_HTML===',
  '<p style="font-size:15px;color:#3f3f3f;line-height:1.75;">修复 <strong>config 读取</strong> 的空指针问题。</p>',
].join('\n');

module.exports = { tmpDir, gitRun, makeGitRepo, res, router, SAMPLE_LLM_RAW };
