'use strict';
/**
 * 预加载桥：只做通道白名单转发，无任何业务逻辑。
 * 渲染层拿到 window.api.invoke(channel, payload) / window.api.on(channel, cb)；
 * 未在白名单内的通道一律返回统一错误信封，不触发 ipcRenderer。
 *
 * v2 增量：对话会话（chat:*）、文风画像（style:*）、选题雷达（radar:*）、
 * 创作成文（compose:*）、样文选择对话框（dialog:pick-samples）；
 * 事件新增 chat:segment（对话分段返回）与 task:progress（雷达/成文进度）。
 */
const { contextBridge, ipcRenderer } = require('electron');

/** 允许 invoke 的通道 = main/ipc.js 通道表 + v2 增量表 */
const INVOKE_CHANNELS = [
  'config:get',
  'config:set',
  'config:export',
  'config:import',
  'wechat:test',
  'llm:test',
  'net:public-ip',
  'selfcheck:run',
  'run:generate',
  'history:list',
  'history:preview',
  'history:reupload',
  'logs:list',
  'logs:clear',
  'logs:export',
  'schedule:get',
  'schedule:set',
  'dialog:pick-repo',
  'dialog:pick-profile',
  'dialog:pick-assets',
  'dialog:pick-cover',
  'shell:open-path',
  'shell:open-external',
  'win:minimize',
  'win:toggle-max',
  'win:close',
  // ---- v2 对话共创 ----
  'chat:list',
  'chat:new',
  'chat:open',
  'chat:send',
  'chat:delete',
  // ---- v2 文风画像（样文 + 画像） ----
  'style:samples:list',
  'style:samples:add',
  'style:samples:import',
  'style:samples:delete',
  'style:analyze',
  'style:profile:get',
  'style:profile:set',
  'style:profile:toggle',
  // ---- v2 选题雷达 ----
  'radar:run',
  'radar:get',
  'radar:select',
  'radar:auto-run',
  // ---- v2.4 打回重写 / 状态同步 ----
  'compose:regenerate',
  'history:sync',
  // ---- v2 创作成文（素材/对话/雷达 → 文章） ----
  'compose:generate',
  'compose:save',
  'compose:upload',
  // ---- v2.2 内容池（定时自动成文的题目队列） ----
  'pool:list',
  'pool:add',
  'pool:update',
  'pool:delete',
  'pool:run-now',
  // ---- v2 对话框 ----
  'dialog:pick-samples',
  'dialog:pick-sample-folder',
];

/** 允许订阅的事件 */
const EVENT_CHANNELS = [
  'run:progress',
  'run:finished',
  'selfcheck:progress',
  'log:append',
  'chat:segment',   // 对话分段返回：sessionId/index/total/text/last
  'task:progress',  // 雷达/成文进度：kind + stage + state + detail（kind ∈ radar|compose）
];

contextBridge.exposeInMainWorld('api', {
  /** 所有 invoke 返回 {ok:true,data} 或 {ok:false,error:{code,message,...}}，不 reject */
  invoke(channel, payload) {
    if (!INVOKE_CHANNELS.includes(channel)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'E_INVALID_INPUT', message: `未知 IPC 通道：${channel}` },
      });
    }
    return ipcRenderer.invoke(channel, payload);
  },

  /** 订阅主进程事件，返回退订函数；非白名单通道返回空操作 */
  on(channel, callback) {
    if (!EVENT_CHANNELS.includes(channel) || typeof callback !== 'function') {
      return () => {};
    }
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
