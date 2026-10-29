'use strict';
/**
 * probe-illustration.js —— 临时验证（用 electron 直接跑，不是 playwright）：
 * 渲染四种插图模板并落 PNG，供肉眼核对 + 记录耗时。
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/probe-illustration.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const ill = require('../main/illustration');
const core = require('../src/core/illustration');

const DECLS = [
  {
    type: 'summary',
    title: '分级阅读怎么给孩子选书',
    items: '先看兴趣，再看级别：读得下去比读得高级重要||一页生词不超过 5 个，才谈得上独立阅读||同一级别读够 10~15 本，再往上升一档',
  },
  { type: 'compare', title: '三种启蒙方式的时间投入', items: '亲子共读||自然拼读||分级阅读', values: '5||3||8', unit: '小时/周' },
  {
    type: 'flow',
    title: '选书的四个步骤',
    items: '看孩子的兴趣点，列三个候选主题||用五指法试读，一页超过 5 个生词就降级||同级别读满 10 本再评估，别急着升级||每季度回看一次，按实际阅读量调整',
  },
  { type: 'quote', text: '读得下去，比读得高级更重要。', sub: '—— 分级阅读的第一原则' },
];

app.whenReady().then(async () => {
  const dir = path.join(__dirname, '..', 'test-evidence', 'illustration-probe');
  fs.mkdirSync(dir, { recursive: true });
  for (const d of DECLS) {
    const t0 = Date.now();
    const r = await ill.renderOne(core.normalizeDecl(d), {
      logger: { warn: (m) => console.log('  WARN', m) },
    });
    console.log(JSON.stringify({
      type: d.type,
      ok: !!r,
      ms: Date.now() - t0,
      w: r && r.width,
      h: r && r.height,
      kb: r ? Math.round((r.dataUri.length * 3) / 4 / 1024) : 0,
    }));
    if (r) fs.writeFileSync(path.join(dir, d.type + '.png'), Buffer.from(r.dataUri.split(',')[1], 'base64'));
  }
  console.log('输出目录:', dir);
  app.quit();
}).catch((e) => {
  console.error('渲染失败:', e && e.message ? e.message : e);
  app.exit(1);
});
