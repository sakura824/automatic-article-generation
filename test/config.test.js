'use strict';
/**
 * config.test.js —— 默认配置、加载合并、校验文案、脱敏导出/导入。
 */
delete process.env.WECHAT_DAILY_MOCK;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/core/config');
const { tmpDir } = require('./helpers');

test('defaultConfig：结构与各面板字段约定一致', () => {
  const c = config.defaultConfig();
  assert.deepStrictEqual(c.wechat, { appId: '', appSecret: '' });
  assert.strictEqual(c.llm.baseUrl, config.PRESETS.bigmodel);
  assert.strictEqual(c.llm.model, 'glm-4.6');
  assert.strictEqual(c.llm.temperature, 0.7);
  // 产品已改为通用创作工作台——AI 标识不再假设「仓库提交」来源，读者画像默认留空
  assert.deepStrictEqual(c.content.aiDisclosure, { enabled: true, text: '本文由 AI 生成，经人工审阅修改' });
  assert.strictEqual(c.content.audience, '');
  // 仓库自动（C 模式）默认关闭——「开关默认关闭，想挂机再用」；时间仍是设计稿的 09:30
  // v2.2：mode 默认 auto（旧配置无该字段时按 auto 处理，行为不变）
  assert.deepStrictEqual(c.app.schedule, { enabled: false, time: '09:30', mode: 'auto' });
  assert.strictEqual(c.app.closeToTray, true);
  assert.strictEqual(c.app.notify, true);
  assert.deepStrictEqual(config.PRESETS, {
    bigmodel: 'https://open.bigmodel.cn/api/paas/v4',
    deepseek: 'https://api.deepseek.com',
  });
});

test('loadConfig：无文件 → 默认；有文件 → 深合并；损坏 → E_IO', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(config.loadConfig(dir), config.defaultConfig());

  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ wechat: { appId: 'wx1' }, llm: { model: 'deepseek-chat' }, app: { schedule: { time: '08:00' } } }),
    'utf8'
  );
  const c = config.loadConfig(dir);
  assert.strictEqual(c.wechat.appId, 'wx1');
  assert.strictEqual(c.wechat.appSecret, ''); // 未覆盖的字段保持默认
  assert.strictEqual(c.llm.model, 'deepseek-chat');
  assert.strictEqual(c.llm.baseUrl, config.PRESETS.bigmodel);
  assert.deepStrictEqual(c.app.schedule, { enabled: false, time: '08:00', mode: 'auto' }); // 对象级深合并

  fs.writeFileSync(path.join(dir, 'config.json'), '{{bad', 'utf8');
  assert.throws(() => config.loadConfig(dir), (e) => e.code === 'E_IO');
});

function validConfig() {
  const c = config.defaultConfig();
  c.wechat = { appId: 'wx1234567890', appSecret: 'secret123456' };
  c.llm = { baseUrl: config.PRESETS.bigmodel, apiKey: 'sk-abc', model: 'glm-4.6', temperature: 0.7 };
  c.content.repoPath = process.cwd();
  return c;
}

test('validateConfig：默认配置报缺项且文案具体可操作；完整配置通过', () => {
  const r0 = config.validateConfig(config.defaultConfig());
  assert.strictEqual(r0.ok, false);
  const fields = r0.errors.map((e) => e.field);
  assert.ok(fields.includes('wechat.appId'));
  assert.ok(fields.includes('wechat.appSecret'));
  assert.ok(fields.includes('llm.apiKey'));
  // 代码仓库只是素材来源之一——空值不再算缺项（仅仓库自动模式需要，默认关闭）
  assert.ok(!fields.includes('content.repoPath'), '仓库路径可选，不应在默认配置里报缺');
  for (const e of r0.errors) {
    assert.ok(e.message.length > 10, '错误文案必须具体');
    assert.ok(!/操作失败/.test(e.message), '禁用“操作失败”式文案');
  }

  assert.deepStrictEqual(config.validateConfig(validConfig()), { ok: true, errors: [] });

  // 非法 Base URL / 时间 / 温度 / 不存在的仓库
  const bad = validConfig();
  bad.llm.baseUrl = 'open.bigmodel.cn';
  bad.app.schedule.time = '9:30';
  bad.llm.temperature = 3;
  const r1 = config.validateConfig(bad);
  const byField = Object.fromEntries(r1.errors.map((e) => [e.field, e.message]));
  assert.match(byField['llm.baseUrl'], /http\(s\)/);
  assert.match(byField['app.schedule.time'], /HH:MM/);
  assert.match(byField['llm.temperature'], /0~2/);
  bad.content.repoPath = 'D:/definitely/not/exist-xyz';
  const r2 = config.validateConfig(bad);
  assert.ok(r2.errors.some((e) => e.field === 'content.repoPath' && /不存在/.test(e.message)));

  // 仓库路径留空 = 合法（素材/对话/雷达三模式不依赖仓库，）
  const noRepo = validConfig();
  noRepo.content.repoPath = '';
  assert.deepStrictEqual(config.validateConfig(noRepo), { ok: true, errors: [] });
});

test('redactSecret / redactConfig：只留末 4 位，剔除顶层 secrets 块', () => {
  assert.strictEqual(config.redactSecret('abcdefghabcd'), '••••abcd');
  assert.strictEqual(config.redactSecret(''), '');
  const c = validConfig();
  c.secrets = { appSecretEnc: 'Zm9v' };
  const r = config.redactConfig(c);
  assert.strictEqual(r.wechat.appSecret, '••••3456');
  assert.strictEqual(r.llm.apiKey, '••••-abc');
  assert.strictEqual(r.secrets, undefined);
  // 原配置不被修改
  assert.strictEqual(c.wechat.appSecret, 'secret123456');
});

test('exportRedacted → importRedacted：往返不含密钥，导入后需重填', () => {
  const c = validConfig();
  c.content.styleExtra = '多举真实案例';
  const text = config.exportRedacted(c);
  assert.ok(!text.includes('secret123456'), '导出不得包含 AppSecret 明文');
  assert.ok(!text.includes('sk-abc'), '导出不得包含 API Key 明文');
  assert.ok(text.includes('••••3456'));

  const imported = config.importRedacted(text);
  assert.strictEqual(imported.content.styleExtra, '多举真实案例');
  assert.strictEqual(imported.wechat.appSecret, ''); // 脱敏占位清空
  assert.strictEqual(imported.llm.apiKey, '');
  assert.strictEqual(imported.wechat.appId, 'wx1234567890'); // 非密钥字段保留
  // 对象入参同样支持；非法 JSON → E_IO
  assert.deepStrictEqual(config.importRedacted(config.redactConfig(c)).wechat.appSecret, '');
  assert.throws(() => config.importRedacted('{bad'), (e) => e.code === 'E_IO');
});

test('projectContext：project.* 为主，content.audience/styleExtra 作为兜底（设置页老输入对 v2 也生效）', () => {
  const cfg = config.defaultConfig();
  cfg.content.audience = '效率工具爱好者';
  cfg.content.styleExtra = '多用短句';
  cfg.project.description = '任务助手';
  const ctx = config.projectContext(cfg);
  assert.strictEqual(ctx.audience, '效率工具爱好者');
  assert.strictEqual(ctx.styleExtra, '多用短句');
  assert.strictEqual(ctx.description, '任务助手');
  // project 自己的值优先
  cfg.project.audience = '项目背景里的受众';
  assert.strictEqual(config.projectContext(cfg).audience, '项目背景里的受众');
  const block = config.buildProjectBlock(ctx);
  assert.ok(block.includes('【项目背景】'));
});
