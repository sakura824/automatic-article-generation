// proto-viewer-r1.js —— 仅用于截取设计稿基准的最小 Electron 主进程（加载 prototype/index.html）
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1400,
    height: 940,
    useContentSize: true, // 内容区 1400x940，body padding(28/20) 后 #app = 1360x880
    show: false,
    backgroundColor: '#ededf0',
  });
  win.loadFile(path.resolve(__dirname, '..', '..', 'prototype', 'index.html'));
  win.once('ready-to-show', () => win.show());
});
app.on('window-all-closed', () => app.quit());
