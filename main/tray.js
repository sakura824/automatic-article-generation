'use strict';
/**
 * 托盘：
 * - 图标用 nativeImage 从 assets/default_cover.png 缩放生成（Windows 托盘 16×16）；
 * - 左键单击 = 打开主界面，右键 = 菜单（打开主界面 / 立即生成并上传 / 暂停定时 / 退出）；
 * - tooltip 由 scheduler-host 刷新：「公众号写作助手 · 下次：明天 09:30」。
 */
const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

function createTray({ logger, actions }) {
  // actions: { openMainWindow, runNow, toggleSchedule, quit, isSchedulePaused }
  const iconPath = path.join(__dirname, '..', 'assets', 'default_cover.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    logger.warn(`托盘图标缺失（${iconPath}），使用空图标`);
    icon = nativeImage.createEmpty();
  } else {
    icon = icon.resize({ width: 16, height: 16 }); // Windows 托盘标准尺寸
  }

  const tray = new Tray(icon);
  tray.setToolTip('公众号写作助手');

  function buildMenu() {
    const paused = typeof actions.isSchedulePaused === 'function' ? actions.isSchedulePaused() : false;
    return Menu.buildFromTemplate([
      { label: '打开主界面', click: () => actions.openMainWindow() },
      { label: '立即生成并上传', click: () => actions.runNow() },
      { label: paused ? '恢复定时' : '暂停定时', click: () => actions.toggleSchedule() },
      { type: 'separator' },
      { label: '退出', click: () => actions.quit() },
    ]);
  }

  // 左键唤起主界面（设计稿 F2：托盘驻留），右键弹出菜单（重建以刷新暂停态文案）
  tray.on('click', () => actions.openMainWindow());
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));

  return {
    tray,
    setTooltip(text) {
      try {
        tray.setToolTip(String(text || '公众号写作助手').slice(0, 120)); // Windows tooltip 上限 128 字符
      } catch (e) {
        logger.warn(`设置托盘 tooltip 失败：${e.message}`);
      }
    },
    refreshMenu() { /* 右键时重建，无需缓存 */ },
    destroy() {
      try { tray.destroy(); } catch (e) { /* 忽略 */ }
    },
  };
}

module.exports = { createTray };
