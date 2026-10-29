#!/usr/bin/env node
'use strict';
/**
 * app:mock 入口：
 * 设 WECHAT_DAILY_MOCK=1 后再拉起 electron，兼容 cmd / Git Bash / PowerShell
 * （不在 npm script 里写 `cross-env` 式内联环境变量，避免跨 shell 差异）。
 * 额外参数原样透传给 electron，例如：npm run app:mock -- --hidden
 */
const path = require('path');
const { spawn } = require('child_process');

let electronBin;
try {
  electronBin = require('electron'); // 安装后该包 main 导出二进制的绝对路径
} catch (e) {
  console.error('[app-mock] 未找到 electron，请先执行 npm install');
  process.exit(1);
}
if (typeof electronBin !== 'string') {
  // 未安装依赖时 require('electron') 返回 index 模块对象，此时退回 PATH 上的 electron
  electronBin = 'electron';
}

const extraArgs = process.argv.slice(2);
const env = Object.assign({}, process.env, { WECHAT_DAILY_MOCK: '1' });
console.log('[app-mock] WECHAT_DAILY_MOCK=1 electron . ' + extraArgs.join(' '));

const child = spawn(electronBin, ['.'].concat(extraArgs), {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  env,
});
child.on('error', (err) => {
  console.error('[app-mock] 启动失败：' + err.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code === null || code === undefined ? 0 : code);
});
