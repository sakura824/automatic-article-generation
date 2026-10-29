#!/usr/bin/env node
'use strict';
/**
 * check-syntax.js —— 渲染层脚本语法体检（逐个文件 node --check）。
 *
 * 为什么单独需要它（v2.2 真实踩坑）：
 * renderer 的 JS 不经打包转译，一个少写的 `}` 会让**整个文件解析失败**，
 * 表现为「某个页面的所有交互都失灵、控制台只有一行 Unexpected token )」。
 * 而原有的三层测试都看不见：
 *   - node --test 只覆盖 src/core 与 main（纯 Node 逻辑），不加载 renderer；
 *   - check-channels 是静态正则，只比对通道字符串，不解析语法；
 *   - 冒烟只验证 `.view.on` 是否出现，页面 CSS 切换正常但页内 JS 已死。
 * 所以把「语法能被解析」这一层单独固化下来，并挂进 npm test 的最前面。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (ent.name.toLowerCase().endsWith('.js')) out.push(full);
  }
  return out.sort();
}

const files = walk(RENDERER);
const failed = [];
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    const detail = String((e && e.stderr) || (e && e.message) || '')
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 3)
      .join(' | ');
    failed.push({ file: path.relative(ROOT, f), detail });
  }
}

if (failed.length) {
  console.error('渲染层脚本语法检查失败：');
  for (const x of failed) console.error(`  ✗ ${x.file}\n    ${x.detail}`);
  console.error(`\n${files.length - failed.length}/${files.length} 通过，${failed.length} 个文件无法解析。`);
  process.exit(1);
}

// 附加体检：每个 views/*.js 都应注册 viewInits（漏注册 = 该页交互静默失效）
const viewDir = path.join(RENDERER, 'js', 'views');
const viewFiles = fs.readdirSync(viewDir).filter((n) => n.endsWith('.js')).sort();
const notRegistered = viewFiles.filter((n) => {
  const src = fs.readFileSync(path.join(viewDir, n), 'utf8');
  return !/App\.viewInits\.push\s*\(/.test(src);
});
if (notRegistered.length) {
  console.error('以下视图文件没有注册 App.viewInits（页面会渲染但交互全失效）：');
  for (const n of notRegistered) console.error('  ✗ renderer/js/views/' + n);
  process.exit(1);
}

console.log(`渲染层语法检查：${files.length}/${files.length} 个文件通过；${viewFiles.length} 个视图均已注册 viewInits。`);
