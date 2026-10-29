'use strict';
/**
 * 主进程入口：窗口 1360×880 frameless、单实例锁、生命周期、
 * 开机自启（app.setLoginItemSettings + --hidden）、系统通知。
 * 接线：store(持久化) / logger(日志) / tray(托盘) / runManager+schedulerHost(调度)
 *       / registerIpcHandlers(IPC 唯一接线处)。
 */
const { app, BrowserWindow, Notification } = require('electron');
const path = require('path');

const { createLogger } = require('./logger');
const { createStore } = require('./store');
const { createTray } = require('./tray');
const { createRunManager, createSchedulerHost } = require('./scheduler-host');
const { registerIpcHandlers, missingRunConfig, missingAutoConfig } = require('./ipc');

const WINDOW_WIDTH = 1360;   // 约定：窗口 1360×880
const WINDOW_HEIGHT = 880;

// 测试钩子（仅冒烟测试显式设置时生效）：把 userData 指到独立目录，
// 保证 e2e/冒烟用例从干净配置起步，不污染真实用户数据。
// 必须在 requestSingleInstanceLock() 之前：单实例锁按当时的 userData 目录生成，
// 晚于加锁设置会让多个独立 userData 的实例共用同一把锁而互相退出。
if (process.env.WECHAT_DAILY_USERDATA) {
  app.setPath('userData', process.env.WECHAT_DAILY_USERDATA);
}

// 单实例锁：二次启动 → 聚焦已有窗口（托盘常驻应用的标准行为）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.wechat.article.assistant'); // 与 electron-builder appId 一致，Windows 通知必需

  /** @type {BrowserWindow|null} */
  let win = null;
  let quitting = false; // 托盘「退出」置位后，close 不再拦截
  let store = null;
  let logger = null;
  let tray = null;
  let runManager = null;
  let schedulerHost = null;
  const startHidden = process.argv.includes('--hidden'); // 开机自启带 --hidden 静默驻留

  function sendEvent(channel, payload) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }

  /** 系统通知（成功/失败都发；notify 开关由调用方判断） */
  function notify({ title, body }) {
    try {
      if (!Notification.isSupported()) {
        logger.warn('当前系统不支持通知，消息仅记录日志：' + body);
        return;
      }
      const n = new Notification({ title: title || '公众号写作助手', body: body || '', silent: false });
      n.on('click', () => showMainWindow());
      n.show();
    } catch (e) {
      logger.warn(`发送系统通知失败：${e.message}`);
    }
  }

  function showMainWindow() {
    if (!win || win.isDestroyed()) {
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function createWindow() {
    win = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      minWidth: 1080,
      minHeight: 720,
      show: !startHidden,
      frame: false, // frameless：标题栏由渲染层绘制，经 win:minimize / win:toggle-max / win:close 控制
      backgroundColor: '#f6f7f9',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,   // 约定：渲染层只经 preload 白名单 window.api 通信
        nodeIntegration: false,
        spellcheck: false,
      },
    });

    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      logger.error(`渲染层加载失败（${desc}，code=${code}）：${url}`);
    });

    // 点关闭 = 隐藏到托盘（closeToTray 可在设置中改为退出）；托盘「退出」不拦截
    win.on('close', (e) => {
      if (quitting) return;
      try {
        const cfg = store.loadFullConfig();
        if (cfg.app.closeToTray) {
          e.preventDefault();
          win.hide();
          logger.info('窗口已隐藏到托盘（可在设置中改为直接退出）');
        }
      } catch (err) {
        logger.error(`读取 closeToTray 设置失败，按隐藏到托盘处理：${err.message}`);
        e.preventDefault();
        win.hide();
      }
    });

    win.on('closed', () => { win = null; });

    // 安全：拒绝 window.open 与非本地导航
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('file://')) {
        e.preventDefault();
        logger.warn(`已阻止渲染层导航到：${url}`);
      }
    });
  }

  /** 开机自启：配置驱动，启动与每次 config:set 后调用 */
  function applyAutoLaunch() {
    try {
      const cfg = store.loadFullConfig();
      app.setLoginItemSettings({ openAtLogin: !!cfg.app.autoLaunch, args: ['--hidden'] });
      return !!cfg.app.autoLaunch;
    } catch (e) {
      logger.error(`设置开机自启失败：${e.message}`);
      return false;
    }
  }

  app.on('second-instance', () => showMainWindow());
  app.on('activate', () => showMainWindow()); // macOS dock 点击
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {
    // closeToTray=true 时 close 被拦截，走到这里即真实退出
    app.quit();
  });

  app.whenReady().then(() => {
    const dataDir = app.getPath('userData');
    logger = createLogger({ logsDir: path.join(dataDir, 'logs'), sendEvent });
    store = createStore({ dataDir, logger });
    store.ensureDirs();
    logger.info(`应用启动：dataDir=${dataDir}${process.env.WECHAT_DAILY_MOCK === '1' ? '（WECHAT_DAILY_MOCK=1，微信/LLM 走确定性桩）' : ''}`);

    applyAutoLaunch(); // 使登录项与配置一致（含 --hidden 参数）
    createWindow();

    runManager = createRunManager({ dataDir, store, logger, sendEvent, notify });

    // 托盘先建再注入 schedulerHost：schedulerHost.refreshTray 依赖 tray.setTooltip，
    // 漏传 tray 会让「下次：明天 09:30 / 定时已暂停」的 tooltip 永不更新。
    tray = createTray({
      logger,
      actions: {
        openMainWindow: showMainWindow,
        runNow: () => {
          showMainWindow();
          // 与 run:generate 同一道前置检查：向导未完成时给出可操作提示，而不是让 pipeline 半路失败
          try {
            const missing = missingAutoConfig(store.loadFullConfig());
            if (missing.length) {
              const msg = `仓库自动模式还缺少：${missing.join('、')}`;
              logger.warn(`托盘「立即生成并上传」：${msg}`);
              notify({ title: '公众号写作助手', body: msg });
              return;
            }
          } catch (e) {
            logger.warn(`托盘运行前检查配置失败（${e.message}），仍尝试交由 pipeline 报具体错误`);
          }
          const started = runManager.start({ upload: true, force: false, cause: 'manual' });
          if (!started.ok) logger.warn(`托盘「立即生成并上传」：${started.error.message}`);
        },
        toggleSchedule: () => {
          const cfg = store.loadFullConfig();
          cfg.app.schedule.enabled = !cfg.app.schedule.enabled;
          store.saveFullConfig(cfg);
          schedulerHost.refreshTray();
          logger.info(`托盘切换定时：${cfg.app.schedule.enabled ? '恢复' : '暂停'}（每天 ${cfg.app.schedule.time}）`);
        },
        quit: () => {
          quitting = true;
          app.quit();
        },
        isSchedulePaused: () => {
          try {
            return !store.loadFullConfig().app.schedule.enabled;
          } catch (e) {
            return false;
          }
        },
      },
    });

    // 定时/补跑按 schedule.mode 走两条判据（v2.2）：
    // auto 还要仓库路径；pool（内容池）只要求大模型 Key + 公众号凭证。
    schedulerHost = createSchedulerHost({
      dataDir,
      store,
      logger,
      runManager,
      tray,
      missingAutoConfig,
      missingPoolConfig: missingRunConfig,
    });
    schedulerHost.start();
    schedulerHost.refreshTray();

    registerIpcHandlers({
      store,
      logger,
      getWindow: () => win,
      runManager,
      schedulerHost,
      applyAutoLaunch,
      sendEvent,
    });
  }).catch((e) => {
    // 启动失败必须可见：写 stderr（logger 可能尚未就绪）
    process.stderr.write(`[main] 启动失败：${e && e.stack ? e.stack : e}\n`);
    app.quit();
  });
}
