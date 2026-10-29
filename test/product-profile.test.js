'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {tmpDir}=require('./helpers');
const {readProductProfile,buildProfileBlock,MAX_CONTEXT_CHARS}=require('../src/core/product-profile');
test('功能档案每次读最新内容，并保留原档指纹与字符统计',()=>{
 const filePath=path.join(tmpDir(),'系统功能.md');fs.writeFileSync(filePath,'# 任务管理工具\n\n已实现：任务记录、优先级管理。');const a=readProductProfile({filePath});assert.match(a.excerpt,/任务记录/);assert.equal(a.originalChars,a.includedChars);assert.equal(a.limited,false);
 fs.writeFileSync(filePath,'# 任务管理工具\n\n新增功能：任务复盘。');const b=readProductProfile({filePath});assert.match(b.excerpt,/新增功能/);assert.notEqual(a.fingerprint,b.fingerprint);
 const prompt=buildProfileBlock(b,{productName:'任务管理工具'});assert.match(prompt,/产品名称：任务管理工具/);assert.match(prompt,/不读取或推断代码库/);assert.match(prompt,/未实现/);
});
test('长档案本地筛选相关功能并优先保留宣传限制，发送内容不超过6000字符',()=>{
 const filePath=path.join(tmpDir(),'系统功能.txt');const blocks=['# 任务管理工具\n目标用户是个人效率爱好者','## 尚未实现\n不能宣传自动审批与效果承诺',...Array.from({length:35},(_,i)=>`## 模块${i}\n`+'普通管理功能说明。'.repeat(50)),'## 数据与复盘\n任务数据统计，复盘记录分析。'];fs.writeFileSync(filePath,blocks.join('\n\n'));
 const r=readProductProfile({filePath,topic:'数据 复盘'});assert(r.limited);assert(r.includedChars<=MAX_CONTEXT_CHARS);assert.match(r.excerpt,/任务数据统计/);assert.match(r.excerpt,/不能宣传/);
});
test('支持UTF16记事本文件，拒绝空文件、非法编码、错误格式与超大文件',()=>{
 const dir=tmpDir(),filePath=path.join(dir,'档案.txt');fs.writeFileSync(filePath,Buffer.concat([Buffer.from([255,254]),Buffer.from('系统功能：任务记录','utf16le')]));assert.match(readProductProfile({filePath}).excerpt,/任务记录/);
 fs.writeFileSync(filePath,'');assert.throws(()=>readProductProfile({filePath}),/为空/);fs.writeFileSync(filePath,Buffer.from([0xff,0x81,0x80]));assert.throws(()=>readProductProfile({filePath}),/编码|UTF/);fs.writeFileSync(filePath,'x'.repeat(256*1024+1));assert.throws(()=>readProductProfile({filePath}),/256 KB/);assert.throws(()=>readProductProfile({filePath:path.join(dir,'not-found.md')}),/不存在/);assert.throws(()=>readProductProfile({filePath:path.join(dir,'archive.pdf')}),/md/);
});
