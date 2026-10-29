'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {tmpDir,res,router}=require('./helpers');
const code=require('../src/core/code-context'),visual=require('../src/core/visual-plan'),aggregate=require('../src/core/aggregate'),wechat=require('../src/core/wechat');
test('代码资料读取未提交的真实功能，跳过密钥、原型与依赖，并保留可核查行号',()=>{
 const root=tmpDir();for(const d of ['src','design','node_modules'])fs.mkdirSync(path.join(root,d));
 fs.writeFileSync(path.join(root,'README.md'),'# 任务管理工具\n支持任务记录和优先级管理');
 fs.writeFileSync(path.join(root,'src/task.ts'),'export function saveTask() { return "任务记录和优先级管理"; }\nconst apiKey = "sk-this-is-sensitive-123456";');
 fs.writeFileSync(path.join(root,'.env'),'SECRET=do-not-read');fs.writeFileSync(path.join(root,'design/future.html'),'未来功能：保证十天养成七个习惯');fs.writeFileSync(path.join(root,'node_modules/x.js'),'依赖不是系统功能');
 const r=code.collectCodeContext({repoPath:root,topic:'任务管理 优先级'});
 assert(r.files.some(f=>f.path==='src'+path.sep+'task.ts'));const body=JSON.stringify(r);
 assert(!body.includes('sk-this'));assert(!body.includes('未来功能'));assert(!body.includes('do-not-read'));assert.match(body,/1:/);
 const prompt=code.buildCodeBlock(r,{productName:'任务管理工具'});assert.match(prompt,/75%/);assert.match(prompt,/任务管理工具/);assert.match(prompt,/不编造/);
 assert.equal(code.buildCodeBlock(null),'');
});
test('代码片段有预算，未命中选题时仍提供说明；不存在目录明确报错',()=>{
 const root=tmpDir();fs.writeFileSync(path.join(root,'README.md'),'项目介绍\n'.repeat(400));const r=code.collectCodeContext({repoPath:root,maxChars:600});assert(r.files[0].excerpt.length<=600);assert.throws(()=>code.collectCodeContext({repoPath:path.join(root,'missing')}),/选择/);
});
test('无插图声明时从真实正文提取两组图文，封面转义文本且跟随文章主题',()=>{
 const a={title:'优先级怎么排<script>',digest:'根据任务目标调整安排',html:'<p>每项任务先明确优先级，结合个人目标。</p><p>拆分后记录进度，再观察长期变化。</p>'};
 const plan=visual.visualPlan(a);assert.equal(plan.length,2);assert(plan.every(x=>x.items.length));assert.match(plan[0].items.join(''),/优先级/);
 const h=visual.coverHtml(a);assert.match(h,/900px/);assert.match(h,/383px/);assert(!h.includes('<script>'));assert.notEqual(h,visual.coverHtml({...a,title:'任务拆解怎么安排'}));
});
test('上传时每篇自动封面优先于固定封面，并按文章图片计算指纹',async()=>{
 const root=tmpDir(),file=path.join(root,'old.png');fs.writeFileSync(file,'old');const bytes=Buffer.from('new-article-cover');const r=router([[/add_material/,({init})=>{assert(Buffer.from(init.body).includes(bytes));assert(!Buffer.from(init.body).includes(Buffer.from('\r\nold\r\n')));return res(200,{media_id:'new-cover-id'});}]]);
 const state={};const out=await wechat.ensureCoverMaterial({content:{coverPath:file}},'token',state,{fetch:r.fetch,coverDataUri:'data:image/png;base64,'+bytes.toString('base64')});assert.equal(out.mediaId,'new-cover-id');assert(state.cover.sha256);
});
test('全网模式提示词不植入系统，结合模式的首次生成及重写都保留代码依据',()=>{
 const opts={topics:[{title:'任务拆解'}],materials:[{text:'任务应循序渐进',label:'L1'}],project:{},codeBlock:'产品名称：任务管理工具\n代码证据：任务记录'};
 assert(!aggregate.buildSynthesisPrompt({...opts,codeBlock:''}).includes('产品名称：'));assert.match(aggregate.buildSynthesisPrompt(opts),/任务记录/);
 assert.match(aggregate.buildRewritePrompt({...opts,article:{title:'标题',digest:'摘要',html:'正文'},report:{maxRatio:0.8,threshold:0.3,reports:[]}}),/任务记录/);
});

test('自动配图上传失败时不允许静默发布缺图稿', async()=>{
 const {buildArticlePayload}=require('../src/core/article');
 await assert.rejects(()=>buildArticlePayload({content:{}},{title:'标题',digest:'摘要',html:'<p>正文</p><img src="data:image/png;base64,aW1n">',visuals:{bodyImages:2}},'cover','token',{uploadImage:async()=>{throw new Error('test-failure')}}),{code:'E_MEDIA'});
});
