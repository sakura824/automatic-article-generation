'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');const {_electron}=require('playwright');
const ROOT=path.resolve(__dirname,'..'),evidence=path.join(ROOT,'test-evidence/v242');fs.mkdirSync(evidence,{recursive:true});
// 900×600 演示图（zlib 手工打包 PNG，零依赖）：替代 1×1 占位——过小的占位图会让本地素材嵌入链路整体失败。
function makeDemoPng(width,height){
 const zlib=require('zlib');
 const table=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);table[n]=c>>>0;}
 const crc32=(buf)=>{let c=0xFFFFFFFF;for(const b of buf)c=table[(c^b)&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;};
 const chunk=(type,data)=>{const h=Buffer.alloc(4);h.writeUInt32BE(data.length);const body=Buffer.concat([Buffer.from(type,'ascii'),data]);const t=Buffer.alloc(4);t.writeUInt32BE(crc32(body));return Buffer.concat([h,body,t]);};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
 const rows=[];for(let y=0;y<height;y++){const row=Buffer.alloc(1+width*3);for(let x=0;x<width;x++){row[1+x*3]=(x*255/width)|0;row[2+x*3]=(y*255/height)|0;row[3+x*3]=96;}rows.push(row);}
 return Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]);
}
(async()=>{
 const env={...process.env,WECHAT_DAILY_MOCK:'1',WECHAT_DAILY_USERDATA:fs.mkdtempSync(path.join(os.tmpdir(),'wdp-v242-'))};delete env.ELECTRON_RUN_AS_NODE;
 console.log('Launching isolated Electron');
 const exe=process.env.VERIFY_EXE;const app=await _electron.launch({executablePath:exe||require('electron'),args:exe?[]:[ROOT],env,timeout:25000});let errors=[];
 try{
 console.log('Electron launched');const win=await app.firstWindow();win.setDefaultTimeout(20000);console.log('Window ready');win.on('pageerror',e=>errors.push(e.message));await win.waitForSelector('#genBtn');console.log('Shell ready');
 await win.waitForSelector('#wizard.on');await win.click('#wizClose');await win.waitForSelector('#wizard.on',{state:'hidden'});
 const demoRepo=fs.mkdtempSync(path.join(os.tmpdir(),'oss-demo-repo-'));fs.writeFileSync(path.join(demoRepo,'README.md'),'# 示例工具\n\n已实现：任务记录与优先级管理。\n');const cfgJson=JSON.stringify({wechat:{appId:'mock-app',appSecret:'mock-secret'},llm:{baseUrl:'https://api.deepseek.com',apiKey:'mock-key',model:'deepseek-chat'},aggregate:{keywords:['科技','教育','生活方式'],searchProvider:'deepseek',repoPath:demoRepo.split(path.sep).join('/'),productName:'示例工具',promotion:'结合真实功能，帮助执行计划与复盘'}});await win.evaluate(async(cfgJson)=>{const r=await window.api.invoke('config:set',JSON.parse(cfgJson));if(!r.ok)throw Error(JSON.stringify(r));window.App.state.cfg=r.data.config;},cfgJson);
 await win.click('.nav-item[data-nav="radar"]');await win.fill('#radarKeywords','科技 教育 生活方式');await win.click('#radarFetchBtn');await win.waitForSelector('[data-tp-check]');await win.locator('[data-tp-check]').first().check();await win.click('#radarGenBtn');await win.waitForSelector('#radarToEditor',{timeout:60000});
 let a=await win.evaluate(()=>window.App.state); // Validate persisted result via history and IPC, not renderer's private view state.
 const first=await win.evaluate(async()=>{const h=await window.api.invoke('history:list',{});const e=h.data.items.find(x=>x.origin==='聚合');const r=await window.api.invoke('history:preview',{id:e.id});return {id:e.id,...r.data};});
 assert.equal(first.generationMode,'web');assert(!first.codeEvidence);assert((first.html.match(/src="data:image\/png;base64,/g)||[]).length>=2);assert(first.coverDataUri.startsWith('data:image/png;base64,'));fs.writeFileSync(path.join(evidence,'web-cover.png'),Buffer.from(first.coverDataUri.split(',')[1],'base64'));
 console.log('Web mode and automatic images passed');await win.screenshot({path:path.join(evidence,'web-article.png'),fullPage:true});
 await win.selectOption('#radarArticleMode','web-code');await win.fill('#radarProductName','示例工具');await win.click('#radarGenBtn');await win.waitForFunction(id=>!document.querySelector('#radarGenBtn').disabled&&document.querySelector('#radarGenResult').textContent.includes('已结合系统'),first.id,{timeout:60000});
 const second=await win.evaluate(async()=>{const h=await window.api.invoke('history:list',{});const e=h.data.items.find(x=>x.origin==='聚合');const r=await window.api.invoke('history:preview',{id:e.id});return {id:e.id,...r.data};});
 assert.equal(second.generationMode,'web-code');assert(second.codeEvidence.files.length);assert(second.html.includes('示例工具'));assert.notEqual(second.id,first.id);const coverSize=Buffer.from(second.coverDataUri.split(',')[1],'base64');assert.equal(coverSize.readUInt32BE(16),900);assert.equal(coverSize.readUInt32BE(20),383);assert((second.html.match(/src="data:image\/png;base64,/g)||[]).length>=2);
 fs.writeFileSync(path.join(evidence,'code-cover.png'),Buffer.from(second.coverDataUri.split(',')[1],'base64'));const match=/src="(data:image\/png;base64,[^"]+)/.exec(second.html);fs.writeFileSync(path.join(evidence,'body-illustration.png'),Buffer.from(match[1].split(',')[1],'base64'));
 console.log('Code promotion mode passed');await win.locator('#radarGenResult').screenshot({path:path.join(evidence,'result-card.png')});await win.locator('#radarArticleMode').scrollIntoViewIfNeeded();await win.screenshot({path:path.join(evidence,'radar-options.png')});await win.screenshot({path:path.join(evidence,'code-article.png'),fullPage:true});await win.click('#radarToEditor');await win.waitForSelector('#draftCoverBox:visible');await win.click('#draftRegenBtn');await win.waitForFunction(()=>!document.querySelector('#draftRegenBtn').disabled,null,{timeout:60000});
 const latest=await win.evaluate(async()=>{const h=await window.api.invoke('history:list',{});const e=h.data.items.find(x=>x.origin==='聚合');const r=await window.api.invoke('history:preview',{id:e.id});return {id:e.id,...r.data};});assert.equal(latest.generationMode,'web-code');assert.notEqual(latest.id,second.id);
 const upload=await win.evaluate(async id=>await window.api.invoke('compose:upload',{id}),latest.id);assert(upload.ok,JSON.stringify(upload));
 // Use the actual selection button; only the OS dialog is replaced with a deterministic choice.
 const profileFile=path.join(env.WECHAT_DAILY_USERDATA,'我的系统功能.md');fs.writeFileSync(profileFile,'# 示例工具\n\n已经实现：任务记录、日程计划。\n\n尚未实现：自动审批，不能宣传代替人工判断。');
 await app.evaluate(({dialog}, filePath)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[filePath]});},profileFile);
 await win.click('.nav-item[data-nav="radar"]');await win.selectOption('#radarArticleMode','web-profile');await win.click('#radarPickProfile');await win.waitForFunction(p=>document.querySelector('#radarProfilePath').value===p,profileFile);
 const selectedProfile=await win.evaluate(async()=>{const r=await window.api.invoke('config:get');return r.data.config.aggregate;});assert.equal(selectedProfile.profilePath,profileFile);assert.equal(selectedProfile.articleMode,'web-profile');assert.equal(selectedProfile.includeCode,false);
 await win.evaluate(()=>{document.querySelector('#radarRepoPath').value='Z:/nonexistent-repo-profile-test';});
 await win.locator('#radarArticleMode').scrollIntoViewIfNeeded();await win.screenshot({path:path.join(evidence,'profile-options.png')});
 await win.click('#radarGenBtn');await win.waitForFunction(()=>!document.querySelector('#radarGenBtn').disabled&&document.querySelector('#radarGenResult').textContent.includes('已结合功能档案'),null,{timeout:60000});
 const profileArticle=await win.evaluate(async()=>{const h=await window.api.invoke('history:list',{});const e=h.data.items.find(x=>x.origin==='聚合');const r=await window.api.invoke('history:preview',{id:e.id});return {id:e.id,...r.data};});assert.equal(profileArticle.generationMode,'web-profile');assert(profileArticle.profileEvidence);assert(!profileArticle.codeEvidence);assert(profileArticle.html.includes('示例工具'));assert(profileArticle.coverDataUri);assert((profileArticle.html.match(/src="data:image\/png;base64,/g)||[]).length>=2);
 fs.appendFileSync(profileFile,'\n\n新增：任务复盘。');await win.click('#radarToEditor');await win.click('#draftRegenBtn');await win.waitForFunction(()=>!document.querySelector('#draftRegenBtn').disabled,null,{timeout:60000});
 const updatedProfile=await win.evaluate(async()=>{const h=await window.api.invoke('history:list',{});const e=h.data.items.find(x=>x.origin==='聚合');const r=await window.api.invoke('history:preview',{id:e.id});return {id:e.id,...r.data};});assert.equal(updatedProfile.generationMode,'web-profile');assert.notEqual(updatedProfile.profileEvidence.fingerprint,profileArticle.profileEvidence.fingerprint);assert(updatedProfile.profileEvidence.originalChars>profileArticle.profileEvidence.originalChars);

 console.log('Profile selection, saved path, no-code mode, fresh file reads and regeneration passed');
 const materialDir=fs.mkdtempSync(path.join(os.tmpdir(),'oss-demo-assets-'));const DEMO_PNG=makeDemoPng(900,600);const DEMO_JPG=Buffer.from(await win.evaluate(async(pngB64)=>{const img=new Image();img.src='data:image/png;base64,'+pngB64;await new Promise((r,j)=>{img.onload=r;img.onerror=j;});const c=document.createElement('canvas');c.width=900;c.height=600;c.getContext('2d').drawImage(img,0,0,900,600);return c.toDataURL('image/jpeg',0.85).split(',')[1];},DEMO_PNG.toString('base64')),'base64');fs.writeFileSync(path.join(materialDir,'01-任务看板-界面.png'),DEMO_PNG);fs.writeFileSync(path.join(materialDir,'02-产品总览-横版.jpg'),DEMO_JPG);fs.mkdirSync(path.join(materialDir,'宣传图'),{recursive:true});fs.writeFileSync(path.join(materialDir,'宣传图','03-产品总览-横版.jpg'),DEMO_JPG);
 await app.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]});},materialDir);
 await win.click('.nav-item[data-nav="radar"]');await win.check('#radarImagesEnabled');await win.click('#radarPickAssets');await win.waitForFunction(p=>document.querySelector('#radarImagesDir').value===p,materialDir);
 await win.click('#radarGenBtn');await win.waitForFunction(()=>!document.querySelector('#radarGenBtn').disabled&&document.querySelector('#radarGenResult').textContent.includes('已加入本地素材'),null,{timeout:60000});
 const assetArticle=await win.evaluate(async()=>{const h=await window.api.invoke('history:list',{});const e=h.data.items.find(x=>x.origin==='聚合');const r=await window.api.invoke('history:preview',{id:e.id});return {id:e.id,...r.data};});
 assert(assetArticle.assetEvidence.length>0&&assetArticle.assetEvidence.length<=2);assert((assetArticle.html.match(/src="data:image\/png;base64,/g)||[]).length>=3);assert(/界面演示|产品宣传示意/.test(assetArticle.html));assert(!assetArticle.html.includes('<asset'));assert(assetArticle.coverDataUri);
 await win.locator('#radarGenResult').screenshot({path:path.join(evidence,'local-images-article.png')});
 await win.locator('#radarImagesEnabled').scrollIntoViewIfNeeded();await win.screenshot({path:path.join(evidence,'material-folder-options.png')});
 const assetUpload=await win.evaluate(async id=>await window.api.invoke('compose:upload',{id}),assetArticle.id);assert(assetUpload.ok,JSON.stringify(assetUpload));
 console.log('Local screenshot/promo insertion and mock image upload passed: '+assetArticle.assetEvidence.map(x=>x.relative).join(', '));
 await app.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]});},materialDir+'/宣传图');
 await win.click('#radarPickAssets');await win.waitForFunction(p=>document.querySelector('#radarImagesDir').value===p,materialDir+'/宣传图');await win.click('#radarGenBtn');
 await win.waitForFunction(()=>!document.querySelector('#radarGenBtn').disabled&&document.querySelector('#radarGenResult').textContent.includes('已加入本地素材'),null,{timeout:60000});
 const promoArticle=await win.evaluate(async()=>{const h=await window.api.invoke('history:list',{});const e=h.data.items.find(x=>x.origin==='聚合');const r=await window.api.invoke('history:preview',{id:e.id});return {id:e.id,...r.data};});assert(promoArticle.assetEvidence.every(x=>x.relative.endsWith('.jpg')));assert(promoArticle.html.includes('产品宣传示意'));assert(!promoArticle.html.includes('<asset'));
 console.log('JPG promo-only folder passed');


 // All other creative entrances share the same visual generation.
 const material=await win.evaluate(async()=>await window.api.invoke('compose:generate',{mode:'material',material:'任务要循序渐进，记录用于了解习惯，结合个人情况安排。',emphasis:'任务和记录'}));assert(material.ok,JSON.stringify(material));assert(material.data.article.coverDataUri);assert((material.data.article.html.match(/src="data:image\/png;base64,/g)||[]).length>=2);
 assert.deepEqual(errors,[]);const summary={version:await win.textContent('#verLabel'),webMode:true,codeMode:true,profileMode:true,localAssetImages:true,promoImages:true,assetEvidence:assetArticle.assetEvidence,profileSelectionSaved:true,profileReadsLatest:true,profileDoesNotScanCode:true,codeFiles:second.codeEvidence.files,regenerateKeepsCodeMode:true,bodyImagesAtLeastTwo:true,cover:true,mockUpload:upload.ok,materialImages:true,errors};fs.writeFileSync(path.join(evidence,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
