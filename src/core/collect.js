'use strict';
/**
 * collect.js —— 仓库提交收集。
 * 子进程调 git：解析提交记录/变更文件/diff；patch 超 MAX_PATCH_CHARS 截断加注；
 * 非 git 目录降级为按修改时间（24h 内）列文件。
 * 仅 Node 内置模块；git 通过子进程调用，测试用真实本地临时仓库（无网络）。
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** diff 节选上限（与命令行版一致）。 */
const MAX_PATCH_CHARS = 40000;
/** 非 git 兜底：跳过的目录。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.idea']);
/** 非 git 兜底：最多列出的文件数。 */
const MAX_MTIME_FILES = 200;
/** 非 git 兜底：修改时间窗口（毫秒，24h）。 */
const MTIME_WINDOW_MS = 86400 * 1000;
/** force 但仓库近期没有提交时的占位摘要（与命令行版一致）。 */
const NO_COMMIT_FALLBACK = '（仓库近期没有提交，请自由发挥写一篇与项目相关的推文）';

class GitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitError';
    this.code = 'E_GIT';
  }
}

function ioError(message) {
  const e = new Error(message);
  e.code = 'E_IO';
  return e;
}

function clipStderr(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/**
 * spawn `git -C <repoPath> <args...>` 封装；失败抛 GitError（code=E_GIT）。
 * 返回 stdout（UTF-8，无效字节替换为 U+FFFD，与 Python errors="replace" 一致）。
 */
function git(args, repoPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', String(repoPath), ...args],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new GitError(`git ${args[0]} 执行失败：${clipStderr(stderr) || err.message}`));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

function isGitRepo(repoPath) {
  return fs.existsSync(path.join(repoPath, '.git'));
}

const LOG_FORMAT = '%h %ad %an%n  %s%n%b';

/** 有 lastHead → lastHead..HEAD 的 log/diff --stat/--name-status/--unified=1；无 → --since="2 days ago" -20。 */
async function collectGitRange(repoPath, lastHead) {
  const head = (await git(['rev-parse', 'HEAD'], repoPath)).trim();
  if (lastHead && lastHead === head) {
    return { digest: null, head, hasChanges: false };
  }
  const rng = lastHead ? `${lastHead}..HEAD` : null;

  let commits;
  let stat = '';
  let names = '';
  let patch = '';
  if (rng) {
    commits = await git(['log', '--date=short', `--pretty=format:${LOG_FORMAT}`, rng], repoPath);
    stat = await git(['diff', '--stat', rng], repoPath);
    names = await git(['diff', '--name-status', rng], repoPath);
    patch = await git(['diff', '--unified=1', rng], repoPath);
  } else {
    commits = await git(
      ['log', '--date=short', '--since=2 days ago', `--pretty=format:${LOG_FORMAT}`, '-20'],
      repoPath
    );
  }

  if (!commits.trim()) {
    return { digest: null, head, hasChanges: false };
  }

  if (patch.length > MAX_PATCH_CHARS) {
    patch = patch.slice(0, MAX_PATCH_CHARS) + '\n……（diff 过长已截断）';
  }

  const parts = ['## 提交记录\n' + commits.trim()];
  if (names.trim()) parts.push('## 变更文件\n' + names.trim());
  if (stat.trim()) parts.push('## 变更规模\n```\n' + stat.trim() + '\n```');
  if (patch.trim()) parts.push('## 关键代码改动（节选）\n```diff\n' + patch.trim() + '\n```');
  return { digest: parts.join('\n\n'), head, hasChanges: true };
}

/**
 * 非 git 目录兜底：列出最近 24 小时内修改过的文件（仅供 LLM 参考）。
 * 跳过 SKIP_DIRS，最多 MAX_MTIME_FILES 个。now 可注入（测试用），默认当前时间。
 */
function collectByMtime(repoPath, { now = new Date() } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const changed = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return; // 不可读目录跳过（对应 Python 的 OSError 忽略）
    }
    for (const ent of entries) {
      if (changed.length >= MAX_MTIME_FILES) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      try {
        const st = fs.statSync(full);
        if (nowMs - st.mtimeMs < MTIME_WINDOW_MS) changed.push(path.relative(repoPath, full));
      } catch (e) {
        // stat 失败的文件跳过
      }
      if (changed.length >= MAX_MTIME_FILES) return;
    }
  };
  walk(repoPath);
  changed.sort();
  if (!changed.length) return { digest: null, head: '', hasChanges: false };
  return {
    digest: '## 最近 24 小时内修改过的文件\n' + changed.slice(0, MAX_MTIME_FILES).join('\n'),
    head: '',
    hasChanges: true,
  };
}

/**
 * 收集变更 → {digest, head, hasChanges}。
 * - 有 lastHead 按 lastHead..HEAD 增量；无则 --since="2 days ago" -20；
 * - lastHead === HEAD → 无变更；
 * - 无变更且 force → 回退到最近提交（lastHead=null）再试；仍无 → NO_COMMIT_FALLBACK 占位；
 * - 非 git 目录 → collectByMtime 降级；
 * - 仓库路径不存在 → E_IO；git 命令失败 → E_GIT。
 */
async function collectChanges({ repoPath, lastHead }, { force = false, now = new Date() } = {}) {
  if (!repoPath) {
    const e = new Error('仓库路径未配置：到「设置 → 内容与文风」选择一个本地项目目录');
    e.code = 'E_INVALID_INPUT';
    throw e;
  }
  if (!fs.existsSync(repoPath)) {
    throw ioError(`仓库路径不存在：${repoPath}（目录可能被移动或删除，请重新选择）`);
  }
  const isGit = isGitRepo(repoPath);
  let r = isGit ? await collectGitRange(repoPath, lastHead) : collectByMtime(repoPath, { now });
  if (r.digest == null && force) {
    r = isGit ? await collectGitRange(repoPath, null) : collectByMtime(repoPath, { now });
    if (r.digest == null) {
      r = { digest: NO_COMMIT_FALLBACK, head: r.head, hasChanges: true };
    }
  }
  return r;
}

module.exports = {
  MAX_PATCH_CHARS,
  MAX_MTIME_FILES,
  NO_COMMIT_FALLBACK,
  SKIP_DIRS,
  GitError,
  git,
  isGitRepo,
  collectGitRange,
  collectByMtime,
  collectChanges,
};
