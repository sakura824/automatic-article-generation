'use strict';
/**
 * persist.js —— v2 增量数据目录的通用 JSON 存取。
 * 供 chat（会话）/ style（样文）/ aggregate（雷达清单）等模块共用：
 * - 每条数据一个 .json 文件，文件名即 id（无自增主键，便于单条删除/改写）；
 * - 原子写：写临时文件后 rename（与 state.js 同一约定，断电可恢复）；
 * - 读取：不存在 → null（调用方决定默认值）；损坏 → E_IO（不静默重置，避免悄悄丢数据）。
 * 仅 Node 内置模块，禁止 import electron。
 */
const fs = require('node:fs');
const path = require('node:path');

function ioError(message) {
  const e = new Error(message);
  e.code = 'E_IO';
  return e;
}

/** 目录内所有 .json 文件的绝对路径（按文件名升序，稳定顺序）。 */
function jsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw ioError(`读取目录失败：${dir}（${e.message}）`);
  }
  return entries
    .filter((ent) => ent.isFile() && ent.name.toLowerCase().endsWith('.json'))
    .map((ent) => ent.name)
    .sort()
    .map((name) => path.join(dir, name));
}

/** 读取单个 JSON 文件：不存在 → null；损坏 → E_IO。 */
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw ioError(`读取 ${path.basename(file)} 失败：${e.message}`);
  }
  if (!String(raw).trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw ioError(`${path.basename(file)} 已损坏，无法解析：${e.message}（可删除该文件后重试）`);
  }
}

/** 原子写 JSON（mkdir -p + tmp + rename）。dir 缺失视为调用方错误（E_INVALID_INPUT）。 */
function writeJson(dir, name, data) {
  if (!dir || !name) {
    const e = new Error('writeJson 需要 dir 与文件名');
    e.code = 'E_INVALID_INPUT';
    throw e;
  }
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, path.join(dir, name));
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* 清理失败忽略 */
    }
    throw ioError(`保存 ${name} 失败：${e.message}`);
  }
}

/** 删除单个数据文件；不存在视为已删除（幂等）。 */
function removeJson(dir, name) {
  const file = path.join(dir, name);
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch (e) {
      throw ioError(`删除 ${name} 失败：${e.message}`);
    }
  }
  return true;
}

module.exports = { jsonFiles, readJson, writeJson, removeJson, ioError };
