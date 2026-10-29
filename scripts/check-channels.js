#!/usr/bin/env node
'use strict';
/**
 * check-channels.js —— IPC 通道一致性核对。
 * 静态解析三处通道清单并交叉比对：
 *   1. preload/preload.js   INVOKE_CHANNELS / EVENT_CHANNELS（白名单）
 *   2. main/ipc.js          handlers 对象注册的通道（ipcMain.handle 唯一接线处）
 *   3. renderer/js          App.api.invoke('…') 与 App.api.on('…') 实际使用
 * 输出 PASS/FAIL 摘要；退出码 0=PASS 1=FAIL（可挂 CI）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const preloadSrc = read('preload/preload.js');
const ipcSrc = read('main/ipc.js');

// 渲染层：递归扫描 renderer/js 下全部 .js（api / app / views）
// 早期这里是硬编码文件清单，新增视图（如 v2.2 的 pool.js）容易漏扫，
// 导致「通道明明用了却显示未使用」——改为目录扫描后新增视图自动纳入核对。
function walkJs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkJs(full));
    else if (ent.name.toLowerCase().endsWith('.js')) out.push(full);
  }
  return out.sort();
}
const rendererSrc = walkJs(path.join(ROOT, 'renderer', 'js'))
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

// 主进程 sendEvent 发出的事件（main.js / ipc.js / logger.js / scheduler-host.js / tray.js）
const mainFiles = ['main/main.js', 'main/ipc.js', 'main/logger.js', 'main/scheduler-host.js'];
const mainSrc = mainFiles.map((f) => read(f)).join('\n');

function extractArrayVar(src, name) {
  const m = new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];').exec(src);
  if (!m) return null;
  return [...m[1].matchAll(/'([\w:-]+)'/g)].map((x) => x[1]);
}

const uniq = (a) => [...new Set(a)];

const preloadInvoke = extractArrayVar(preloadSrc, 'INVOKE_CHANNELS');
const preloadEvents = extractArrayVar(preloadSrc, 'EVENT_CHANNELS');
if (!preloadInvoke || !preloadEvents) {
  console.error('无法解析 preload/preload.js 的通道白名单');
  process.exit(1);
}

// ipc.js handlers：形如 "    'channel': ..."（4 空格缩进的 key）
const ipcHandlers = uniq([...ipcSrc.matchAll(/^ {4}'([\w:-]+)':/gm)].map((m) => m[1]));

// 渲染层使用
const rendererInvoke = uniq([...rendererSrc.matchAll(/App\.api\.invoke\('([\w:-]+)'/g)].map((m) => m[1]));
const rendererOn = uniq([...rendererSrc.matchAll(/App\.api\.on\('([\w:-]+)'/g)].map((m) => m[1]));

// 主进程发出的事件
const mainEmits = uniq([
  ...mainSrc.matchAll(/sendEvent\('([\w:-]+)'/g)].map((m) => m[1]));

function diff(a, b) {
  return a.filter((x) => !b.includes(x));
}

const problems = [];
if (diff(preloadInvoke, ipcHandlers).length) problems.push(`仅 preload 白名单有、ipc 未注册: ${diff(preloadInvoke, ipcHandlers).join(', ')}`);
if (diff(ipcHandlers, preloadInvoke).length) problems.push(`仅 ipc 注册、preload 白名单没有: ${diff(ipcHandlers, preloadInvoke).join(', ')}`);
if (diff(rendererInvoke, preloadInvoke).length) problems.push(`渲染层 invoke 未在 preload 白名单: ${diff(rendererInvoke, preloadInvoke).join(', ')}`);
if (diff(rendererOn, preloadEvents).length) problems.push(`渲染层 on 未在 preload 事件白名单: ${diff(rendererOn, preloadEvents).join(', ')}`);
if (diff(mainEmits, preloadEvents).length) problems.push(`主进程 sendEvent 未在 preload 事件白名单: ${diff(mainEmits, preloadEvents).join(', ')}`);

console.log(`preload INVOKE_CHANNELS: ${preloadInvoke.length} 个`);
console.log(`ipc handlers:           ${ipcHandlers.length} 个`);
console.log(`preload EVENT_CHANNELS: ${preloadEvents.join(', ')}`);
console.log(`渲染层 invoke 使用:      ${rendererInvoke.length} 个 → ${rendererInvoke.join(', ')}`);
console.log(`渲染层 on 订阅:          ${rendererOn.join(', ')}`);
console.log(`主进程 sendEvent:        ${mainEmits.join(', ')}`);
console.log('');
if (problems.length) {
  console.log('一致性: FAIL');
  problems.forEach((p) => console.log('  - ' + p));
  process.exit(1);
}
console.log('一致性: PASS');
