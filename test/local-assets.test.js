'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {tmpDir}=require('./helpers');const assets=require('../src/core/local-assets');
test('图片目录按页面说明匹配主题，去掉同主题PNG/JPG与状态图重复项',()=>{
 const dir=tmpDir();fs.mkdirSync(path.join(dir,'界面截图'));fs.mkdirSync(path.join(dir,'宣传图'));
 for(const name of ['界面截图/01-任务列表.png','界面截图/01-任务列表-勾选状态.png','界面截图/03-进度统计.png','宣传图/02-产品总览-横版.jpg','宣传图/02-产品总览-横版.png'])fs.writeFileSync(path.join(dir,name),'test-image');
 fs.writeFileSync(path.join(dir,'04-页面与截图索引.json'),JSON.stringify({pages:[{title:'任务列表',purpose:'记录和整理每日任务',operations:'勾选完成、切换状态',screenshots:[{file:'界面截图/01-任务列表.png'},{file:'界面截图/01-任务列表-勾选状态.png'}]},{title:'进度统计',purpose:'任务完成情况汇总',screenshots:[{file:'界面截图/03-进度统计.png'}]}]}));
 const list=assets.listLocalAssets({dir,topic:'任务 记录 效率'});assert.equal(list[0].title,'任务列表');assert.equal(list.filter(x=>x.title==='任务列表').length,1);assert.equal(list.filter(x=>x.relative.includes('产品总览')).length,1);assert(list.find(x=>x.relative.includes('产品总览')).relative.endsWith('.jpg'));assert(assets.buildAssetBlock(list).includes(list[0].id));assert(!assets.buildAssetBlock(list).includes(dir));
});
test('插图仅使用已登记编号，去重并限制数量，未知标记清理；未声明时自动插入',()=>{
 const list=[{id:'a'},{id:'b'},{id:'c'}];const picked=assets.chooseAssets('<asset id="unknown"></asset><asset id="b"></asset><asset id="b"></asset><asset id="a"></asset><asset id="c"></asset>',list);assert.deepEqual(picked.map(x=>x.id),['b','a']);
 const result=assets.placeAssets('<p>正文</p><asset id="b"></asset><asset id="unknown"></asset>',[{id:'b',tag:'<img src="data:known">'},{id:'a',tag:'<img src="data:other">'}]);assert(!result.includes('<asset'));assert.equal((result.match(/<img/g)||[]).length,2);
 assert.equal(assets.chooseAssets('<p>没有声明</p>',list).length,2);
});
test('不存在或没有图片的文件夹明确报错，不读取其他类型文件',()=>{
 const dir=tmpDir();fs.writeFileSync(path.join(dir,'notes.md'),'档案');assert.throws(()=>assets.listLocalAssets({dir}),/没有可用/);assert.throws(()=>assets.listLocalAssets({dir:path.join(dir,'missing')}),/请选择/);
});
