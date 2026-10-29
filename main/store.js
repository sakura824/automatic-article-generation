'use strict';
/**
 * 配置与状态持久化：
 * - config.json 落在 DATA（app.getPath('userData')）；合并/校验/脱敏一律走 src/core/config
 *   （defaultConfig/deepMerge/loadConfig/redactConfig/exportRedacted），本模块独占的唯一职责是
 *   AppSecret / API Key 的 safeStorage（Windows DPAPI）加解密：
 *   · 加密可用 → base64 存 `secrets` 区块（encrypted:true）；
 *   · 不可用 → 明文降级写入（encrypted:false）并在日志注明；
 *   · 解密失败 → 置空并报错，请用户到设置里重填；
 * - state.json 经 src/core/state 读写（tmp+rename 原子写，断电可恢复）；
 * - 任何出口（UI/日志/导出）密钥一律只露末 4 位。
 */
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const config = require('../src/core/config');
const stateCore = require('../src/core/state');

const CONFIG_FILE = 'config.json';
const STATE_FILE = 'state.json';

/**
 * 密钥位。
 * [配置内路径的目标分区, 键名]；分区对象缺失时 loadFullConfig 自动补 {}（旧 v1 配置文件兼容）。
 */
const SECRET_PAIRS = [
  ['wechat', 'appSecret'],
  ['llm', 'apiKey'],
  ['aggregate', 'searchApiKey'],
];

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function createStore({ dataDir, logger }) {
  const configPath = path.join(dataDir, CONFIG_FILE);
  const statePath = path.join(dataDir, STATE_FILE);
  const logsDir = path.join(dataDir, 'logs');
  const outputDir = path.join(dataDir, 'output');
  // v2 增量数据目录：对话会话 / 文风样文 / 选题雷达清单。
  // 聚合与素材/对话成文产物落在 output/<date>/…（由 core/aggregate 与 main/articles 落盘）。
  const sessionsDir = path.join(dataDir, 'sessions');
  const styleSamplesDir = path.join(dataDir, 'style-samples');
  const radarDir = path.join(dataDir, 'radar');

  function ensureDirs() {
    for (const dir of [dataDir, logsDir, outputDir, sessionsDir, styleSamplesDir, radarDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ---------------------------------------------------------------- safeStorage

  function encryptionAvailable() {
    try {
      return !!safeStorage && safeStorage.isEncryptionAvailable();
    } catch (e) {
      return false;
    }
  }

  function encryptToB64(plain) {
    return safeStorage.encryptString(String(plain)).toString('base64');
  }

  function decryptFromB64(b64) {
    return safeStorage.decryptString(Buffer.from(String(b64), 'base64'));
  }

  // ---------------------------------------------------------------- config

  /**
   * 完整配置（内存态，secrets 已解密注入 wechat.appSecret / llm.apiKey）。
   * 磁盘格式（本模块独占定义，core/config.loadConfig 负责默认值合并）：
   *   { ...各分区, secrets: { encrypted:true, appSecret:'<base64>', apiKey:'<base64>' } }
   *   safeStorage 不可用时 { secrets: { encrypted:false, appSecret:'明文', apiKey:'明文' } }。
   * 无 secrets 区块的历史文件：按明文兼容读取。
   */
  function loadFullConfig() {
    ensureDirs();
    let cfg;
    try {
      cfg = config.loadConfig(dataDir); // 默认值 + 文件合并；损坏抛 E_IO
    } catch (e) {
      logger.error(`config.json 读取失败（${e.message}），本次会话按默认配置运行；保存后将以新配置覆盖`);
      cfg = config.defaultConfig();
    }
    const secrets = cfg.secrets && typeof cfg.secrets === 'object' ? cfg.secrets : null;
    if (secrets) {
      const encrypted = secrets.encrypted !== false;
      for (const [target, key] of SECRET_PAIRS) {
        if (!cfg[target] || typeof cfg[target] !== 'object') cfg[target] = {}; // 旧 v1 配置缺 aggregate 分区时补齐
        const stored = secrets[key];
        if (!stored) {
          cfg[target][key] = '';
          continue;
        }
        if (!encrypted) {
          cfg[target][key] = String(stored);
          continue;
        }
        try {
          cfg[target][key] = decryptFromB64(stored);
        } catch (e) {
          logger.error(`解密 ${key} 失败（${e.message}），已置空，请到设置里重新填写`);
          cfg[target][key] = '';
        }
      }
      if (!encryptionAvailable() && encrypted) {
        logger.warn('safeStorage 不可用：密钥将无法在本次会话加密保存（保存时明文降级）');
      }
    } else {
      const hasPlain = SECRET_PAIRS.some(([target, key]) => cfg[target] && cfg[target][key]);
      if (hasPlain) {
        logger.warn('config.json 无 secrets 区块，AppSecret/API Key/搜索 Key 按历史明文兼容读取，下次保存将转入加密区块');
      }
    }
    delete cfg.secrets; // 加密块只在磁盘上存在，内存态一律剥除
    for (const [target, key] of SECRET_PAIRS) {
      if (cfg[target]) logger.registerSecret(cfg[target][key]);
    }
    return cfg;
  }

  /** 保存：密钥抽出进 secrets 区块（加密优先，明文降级注明），正文不含密钥 */
  function saveFullConfig(cfg) {
    ensureDirs();
    const body = config.deepMerge(config.defaultConfig(), clone(cfg));
    const secrets = { encrypted: true };
    let plainFallback = false;
    for (const [target, key] of SECRET_PAIRS) {
      if (body[target]) body[target][key] = ''; // 正文一律不含密钥
      const value = cfg && cfg[target] ? cfg[target][key] : '';
      if (value) {
        if (encryptionAvailable()) {
          secrets[key] = encryptToB64(value);
        } else {
          secrets.encrypted = false;
          secrets[key] = String(value);
          plainFallback = true;
        }
      }
    }
    body.secrets = secrets;
    try {
      const tmp = `${configPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
      fs.renameSync(tmp, configPath);
    } catch (e) {
      throw Object.assign(new Error(`保存 config.json 失败：${e.message}`), { code: 'E_IO' });
    }
    if (plainFallback) {
      logger.warn('safeStorage 不可用，密钥已明文降级落盘（secrets.encrypted=false）——建议检查系统 DPAPI 状态');
    } else {
      logger.info('配置已保存（密钥已加密写入 secrets 区块）');
    }
    for (const [target, key] of SECRET_PAIRS) {
      if (cfg && cfg[target]) logger.registerSecret(cfg[target][key]);
    }
    return loadFullConfig();
  }

  // ---------------------------------------------------------------- 脱敏出口（委托 core，语义一致）

  /** 界面脱敏：密钥只露末 4 位，如 ••••abcd；不携带 secrets 区块 */
  function redactConfigForUi(cfg) {
    return config.redactConfig(cfg);
  }

  /** 配置导出 JSON 文本（完全不含密钥，导入后需重填） */
  function configForExportText(cfg) {
    return config.exportRedacted(cfg);
  }

  // ---------------------------------------------------------------- state（委托 core）

  function loadState() {
    ensureDirs();
    return stateCore.loadState(dataDir);
  }

  function saveState(state) {
    ensureDirs();
    return stateCore.saveState(dataDir, state);
  }

  /** 读盘合并后再写（避免持有旧快照的调用方覆盖掉期间写入的历史/定时标记）。 */
  function saveStateMerged(state) {
    ensureDirs();
    return stateCore.saveStateMerged(dataDir, state);
  }

  return {
    paths: { dataDir, configPath, statePath, logsDir, outputDir, sessionsDir, styleSamplesDir, radarDir },
    ensureDirs,
    deepMerge: config.deepMerge,
    clone,
    loadFullConfig,
    saveFullConfig,
    redactConfigForUi,
    configForExportText,
    loadState,
    saveState,
    saveStateMerged,
  };
}

module.exports = { createStore, clone };
