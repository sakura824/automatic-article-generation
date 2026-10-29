'use strict';
/**
 * collect.test.js —— git 采集：真实本地临时仓库（无网络）验证增量/全量/截断/降级/错误路径。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_PATCH_CHARS,
  NO_COMMIT_FALLBACK,
  GitError,
  git,
  isGitRepo,
  collectByMtime,
  collectChanges,
} = require('../src/core/collect');
const { tmpDir, makeGitRepo, gitRun } = require('./helpers');

const NOW = new Date(2026, 9, 29, 10, 0, 0); // 2026-10-29 10:00 本地

test('git() 封装：正常返回 stdout，失败抛 E_GIT', async () => {
  const dir = tmpDir();
  await makeGitRepo(dir, [{ files: { 'a.txt': 'x' }, msg: 'init' }]);
  const out = await git(['rev-parse', 'HEAD'], dir);
  assert.match(out.trim(), /^[0-9a-f]{40}$/);
  await assert.rejects(() => git(['log', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef..HEAD'], dir), (e) => {
    assert.ok(e instanceof GitError);
    assert.strictEqual(e.code, 'E_GIT');
    return true;
  });
});

test('isGitRepo', async () => {
  const dir = tmpDir();
  assert.strictEqual(isGitRepo(dir), false);
  await makeGitRepo(dir, [{ files: { 'a.txt': 'x' }, msg: 'init' }]);
  assert.strictEqual(isGitRepo(dir), true);
});

test('collectChanges 无 lastHead → 近 2 天提交（--since 路径）', async () => {
  const dir = tmpDir();
  const [h1, h2] = await makeGitRepo(dir, [
    { files: { 'src/a.js': 'a' }, msg: 'feat: 新增用户查询服务 UserService' },
    { files: { 'src/b.js': 'b' }, msg: 'fix: 修复分页 off-by-one' },
  ]);
  const r = await collectChanges({ repoPath: dir, lastHead: null }, { now: NOW });
  assert.strictEqual(r.hasChanges, true);
  assert.strictEqual(r.head, h2);
  assert.ok(r.digest.includes('## 提交记录'));
  assert.ok(r.digest.includes('feat: 新增用户查询服务 UserService'));
  assert.ok(r.digest.includes('fix: 修复分页 off-by-one'));
  assert.ok(!r.digest.includes('## 变更文件')); // since 路径无 diff
  assert.ok(h1 && h2);
});

test('collectChanges 有 lastHead → 增量 lastHead..HEAD（log/stat/name/patch）', async () => {
  const dir = tmpDir();
  const [h1, h2] = await makeGitRepo(dir, [
    { files: { 'src/a.js': 'const a = 1;\n' }, msg: 'init: 项目初始化' },
    { files: { 'src/b.js': 'const b = 2;\n', 'README.md': '# doc\n' }, msg: 'fix: 修复分页 off-by-one' },
  ]);
  const r = await collectChanges({ repoPath: dir, lastHead: h1 }, { now: NOW });
  assert.strictEqual(r.hasChanges, true);
  assert.strictEqual(r.head, h2);
  assert.ok(r.digest.includes('## 提交记录'));
  assert.ok(r.digest.includes('## 变更文件'));
  assert.ok(r.digest.includes('A\tsrc/b.js') || r.digest.includes('A\tsrc/b.js'));
  assert.ok(r.digest.includes('## 变更规模'));
  assert.ok(r.digest.includes('## 关键代码改动（节选）'));
  assert.ok(r.digest.includes('+const b = 2;'));
  assert.ok(!r.digest.includes('init: 项目初始化')); // 增量不含上次已处理的提交
});

test('collectChanges lastHead === HEAD → 无变更', async () => {
  const dir = tmpDir();
  const [h1] = await makeGitRepo(dir, [{ files: { 'a.txt': 'x' }, msg: 'init' }]);
  const r = await collectChanges({ repoPath: dir, lastHead: h1 }, { now: NOW });
  assert.deepStrictEqual(r, { digest: null, head: h1, hasChanges: false });
});

test('collectChanges patch 超长截断加注', async () => {
  const dir = tmpDir();
  const bigLine = 'x'.repeat(80) + '\n';
  const [h1] = await makeGitRepo(dir, [{ files: { 'src/a.js': 'a\n' }, msg: 'init' }]);
  // 增量路径（lastHead..HEAD）才产生 diff：提交一个远超 40000 字符的大文件
  fs.writeFileSync(path.join(dir, 'src/big.txt'), bigLine.repeat(900), 'utf8');
  await gitRun(['add', '-A'], dir);
  await gitRun(['commit', '-m', 'feat: 导入大文件'], dir);
  const r = await collectChanges({ repoPath: dir, lastHead: h1 }, { now: NOW });
  assert.strictEqual(r.hasChanges, true);
  assert.ok(r.digest.includes('……（diff 过长已截断）'));
  const patch = r.digest.split('```diff\n')[1] || '';
  // 截断发生在 40000 + 注记之内
  assert.ok(patch.length <= MAX_PATCH_CHARS + 40);
});

test('collectChanges force：lastHead=HEAD 时回退最近提交', async () => {
  const dir = tmpDir();
  const [h] = await makeGitRepo(dir, [{ files: { 'a.txt': 'x' }, msg: 'feat: 唯一提交' }]);
  const r = await collectChanges({ repoPath: dir, lastHead: h }, { force: true, now: NOW });
  assert.strictEqual(r.hasChanges, true);
  assert.ok(r.digest.includes('feat: 唯一提交'));
});

test('collectChanges force：仓库无近 2 天提交 → 占位摘要', async () => {
  const dir = tmpDir();
  await makeGitRepo(dir, [
    { files: { 'a.txt': 'x' }, msg: 'old commit', date: '2026-08-01T10:00:00' }, // 远早于 2 天前
  ]);
  const head = (await require('../src/core/collect').git(['rev-parse', 'HEAD'], dir)).trim();
  // 非 force：无变更
  const plain = await collectChanges({ repoPath: dir, lastHead: null }, { now: NOW });
  assert.strictEqual(plain.hasChanges, false);
  // force：回退仍无 → 占位文本
  const forced = await collectChanges({ repoPath: dir, lastHead: head }, { force: true, now: NOW });
  assert.strictEqual(forced.hasChanges, true);
  assert.strictEqual(forced.digest, NO_COMMIT_FALLBACK);
});

test('collectChanges 非 git 目录 → 按 mtime 降级', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'fresh.txt'), 'new', 'utf8');
  const old = path.join(dir, 'old.txt');
  fs.writeFileSync(old, 'old', 'utf8');
  const past = new Date(NOW.getTime() - 3 * 86400 * 1000);
  fs.utimesSync(old, past, past);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'x', 'utf8');

  const r = await collectChanges({ repoPath: dir }, { now: NOW });
  assert.strictEqual(r.hasChanges, true);
  assert.strictEqual(r.head, '');
  assert.ok(r.digest.startsWith('## 最近 24 小时内修改过的文件'));
  assert.ok(r.digest.includes('fresh.txt'));
  assert.ok(!r.digest.includes('old.txt')); // 3 天前修改，不在 24h 窗口
  assert.ok(!r.digest.includes('node_modules')); // 跳过目录
});

test('collectByMtime：24h 内无修改 → 无变更', async () => {
  const dir = tmpDir();
  const p = path.join(dir, 'a.txt');
  fs.writeFileSync(p, 'x', 'utf8');
  const past = new Date(NOW.getTime() - 2 * 86400 * 1000);
  fs.utimesSync(p, past, past);
  const r = collectByMtime(dir, { now: NOW });
  assert.deepStrictEqual(r, { digest: null, head: '', hasChanges: false });
});

test('collectChanges 仓库路径不存在 → E_IO；未配置 → E_INVALID_INPUT', async () => {
  await assert.rejects(
    () => collectChanges({ repoPath: path.join(tmpDir(), 'nope') }, { now: NOW }),
    (e) => {
      assert.strictEqual(e.code, 'E_IO');
      return true;
    }
  );
  await assert.rejects(
    () => collectChanges({ repoPath: '' }, { now: NOW }),
    (e) => {
      assert.strictEqual(e.code, 'E_INVALID_INPUT');
      return true;
    }
  );
});
