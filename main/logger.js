'use strict';
/**
 * 主进程日志（契约 §2 事件 log:append、§7 决策 3）：
 * - 环形缓冲（界面 logs:list 数据源）+ 逐行落盘 DATA/logs/app-YYYYMMDD.log；
 * - registerSecret() 注册敏感值后，所有输出统一 scrub() 脱敏：只露末 4 位（PRD §7）；
 * - 仅依赖 Node 内置模块，electron 交互通过注入的 sendEvent 完成，便于复用与检视。
 */
const fs = require('fs');
const path = require('path');

const BUFFER_CAP = 1000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function nowParts(d) {
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
    stamp: `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`,
  };
}

function createLogger({ logsDir, sendEvent }) {
  const buffer = []; // {t, lv, m}
  const secrets = new Set();
  let writeChain = Promise.resolve(); // 串行追加，避免交错

  /**
   * 启动时把当天（及前一天的尾部）日志文件载入缓冲区：
   * 缓冲只是本进程内存，退出重开后「运行日志」页只剩 3 条启动 INFO，
   * 失败排查完全断档（文件里其实有完整记录）。
   */
  function hydrateFromFiles() {
    if (!logsDir) return;
    const now = new Date();
    const prev = new Date(now.getTime() - 24 * 3600 * 1000);
    const days = [nowParts(prev).stamp, nowParts(now).stamp];
    const lineRe = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\] \[(INFO|WARN|ERROR)\] (.*)$/;
    for (const stamp of days) {
      const file = path.join(logsDir, `app-${stamp}.log`);
      let text = '';
      try {
        if (!fs.existsSync(file)) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch (e) {
        continue;
      }
      const lines = text.split(/\r?\n/).filter(Boolean).slice(-400); // 每天最多回填 400 行
      for (const line of lines) {
        const m = lineRe.exec(line);
        if (!m) continue;
        const isPrevDay = m[1] !== nowParts(now).date;
        buffer.push({ t: m[2], lv: m[3], m: isPrevDay ? `[${m[1]}] ${m[4]}` : m[4], file: true });
      }
      if (buffer.length > BUFFER_CAP) buffer.splice(0, buffer.length - BUFFER_CAP);
    }
  }

  function mask(v) {
    const s = String(v);
    return '••••' + s.slice(-4);
  }

  /** 把已注册的敏感值替换为 ••••末4位 */
  function scrub(text) {
    let s = String(text === undefined || text === null ? '' : text);
    for (const sec of secrets) {
      if (s.includes(sec)) s = s.split(sec).join(mask(sec));
    }
    return s;
  }

  function appendToFile(line) {
    if (!logsDir) return;
    writeChain = writeChain
      .then(() => new Promise((resolve) => {
        const { stamp } = nowParts(new Date());
        const file = path.join(logsDir, `app-${stamp}.log`);
        fs.appendFile(file, line + '\n', 'utf8', () => resolve()); // 失败静默：日志不应拖垮主流程
      }))
      .catch(() => {});
  }

  /**
   * lv ∈ INFO/WARN/ERROR（契约 §2）；m 任意可字符串化内容，输出前统一脱敏。
   * 同时：环形缓冲 → log:append 事件 → 文件追加。
   */
  function log(lv, m) {
    const level = lv === 'WARN' || lv === 'ERROR' ? lv : 'INFO';
    const { date, time } = nowParts(new Date());
    const entry = { t: time, lv: level, m: scrub(m) };
    buffer.push(entry);
    if (buffer.length > BUFFER_CAP) buffer.splice(0, buffer.length - BUFFER_CAP);
    if (typeof sendEvent === 'function') {
      try { sendEvent('log:append', entry); } catch (e) { /* 窗口未就绪时忽略 */ }
    }
    appendToFile(`[${date} ${time}] [${level}] ${entry.m}`);
  }

  hydrateFromFiles();

  return {
    log,
    info: (m) => log('INFO', m),
    warn: (m) => log('WARN', m),
    error: (m) => log('ERROR', m),
    /** 注册敏感值（AppSecret / API Key）；长度 <4 的值只掩码不保留，避免误吞短词 */
    registerSecret(v) {
      if (v === undefined || v === null) return;
      const s = String(v);
      if (s.length >= 4 && !s.startsWith('••••')) secrets.add(s);
    },
    scrub,
    /** 界面读取：{level?, limit?} → {items:[{t,lv,m}]}，最新在后（含启动时从文件回填的历史） */
    list({ level, limit } = {}) {
      const cap = Number.isInteger(limit) && limit > 0 ? limit : 200;
      let items = buffer;
      if (level && level !== 'all') items = items.filter((e) => e.lv === level);
      return items.slice(-cap);
    },
    /** 导出用全文（缓冲只存当天 HH:MM:SS，文件头注明导出日期） */
    text() {
      const { date } = nowParts(new Date());
      return [
        `# 公众号写作助手 运行日志（导出于 ${date}，完整历史见 logs/ 目录）`,
      ].concat(buffer.map((e) => `[${e.t}] [${e.lv}] ${e.m}`)).join('\n');
    },
    clear() {
      buffer.length = 0;
      log('INFO', '界面日志已清空（logs/ 目录下的文件保留完整历史）');
    },
  };
}

module.exports = { createLogger };
