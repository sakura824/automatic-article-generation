#!/usr/bin/env node
'use strict';
// probe-selfcheck.js —— 只读探针：dump selfcheck:run 的真实返回形状（用于核查 selfcheck:run 返回形状）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-evidence', '样式', '_probe-selfcheck.txt');
const lines = [];
const log = (s) => { lines.push(String(s)); console.log(String(s)); };

(async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wdp-probe-repo-'));
  const g = (a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g(['init', '-b', 'main']); g(['config', 'user.email', 'a@b.c']); g(['config', 'user.name', 'a']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# x\n', 'utf8'); g(['add', '-A']); g(['commit', '-m', 'init']);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wdp-probe-ud-'));
  const app = await electron.launch({
    executablePath: require('electron'), args: ['.'], cwd: ROOT,
    env: Object.assign({}, process.env, { WECHAT_DAILY_MOCK: '1', WECHAT_DAILY_USERDATA: userData }),
  });
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('#genBtn', { timeout: 30000 });
    const probe = await win.evaluate(async (repoPath) => {
      const set = await window.api.invoke('config:set', {
        wechat: { appId: 'wxprobe000000001', appSecret: 'mock-secret-probe' },
        llm: { apiKey: 'mock-key-probe' },
        content: { repoPath },
      });
      const raw = await window.api.invoke('selfcheck:run');
      return {
        kind: typeof raw, keys: raw && typeof raw === 'object' ? Object.keys(raw) : null,
        rawOk: raw && raw.ok, dataType: raw && raw.data ? typeof raw.data : null,
        dataKeys: raw && raw.data && typeof raw.data === 'object' ? Object.keys(raw.data) : null,
        itemsType: raw && raw.data ? typeof raw.data.items : null,
        itemsIsArray: Array.isArray(raw && raw.data && raw.data.items),
        itemsSample: JSON.stringify(raw && raw.data && raw.data.items).slice(0, 800),
        whole: JSON.stringify(raw).slice(0, 1200),
      };
    }, repo);
    log('config:set + selfcheck:run 探针结果：');
    log(JSON.stringify(probe, null, 2));
  } catch (e) {
    log('[FATAL] ' + String(e && e.stack ? e.stack : e));
  } finally { try { await app.close(); } catch (_) { } }
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
