'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {termsOf} = require('./code-context');
const MAX_ASSETS = 2;
function invalid(message) { return Object.assign(new Error(message), {code:'E_INVALID_INPUT'}); }
function normalize(relative) { return relative.replace(/\\/g,'/'); }
function listLocalAssets({dir,topic='',limit=12}={}) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw invalid('请选择可读取的素材图片文件夹');
  const root = fs.realpathSync(dir), descriptions = new Map();
  const index = path.join(root,'04-页面与截图索引.json');
  if (fs.existsSync(index) && fs.statSync(index).size < 2*1024*1024) {
    try { for (const page of JSON.parse(fs.readFileSync(index,'utf8')).pages || []) {
      for (const shot of page.screenshots || []) descriptions.set(normalize(shot.file || ''), {title:page.title,description:[page.purpose,page.operations].join(' '),provenance:shot.provenance});
    }} catch (_) { /* Filenames remain usable without an index. */ }
  }
  const terms=termsOf(topic), items=[];let scanned=0;
  function walk(folder,depth) {
    if(depth>4 || scanned>=500) return;
    for(const entry of fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(scanned>=500) break;
      if(entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const full=path.join(folder,entry.name);
      if(entry.isDirectory()) { if(!['node_modules','dist','build','.git'].includes(entry.name)) walk(full,depth+1);continue; }
      if(!entry.isFile() || !/\.(png|jpe?g)$/i.test(entry.name)) continue;
      scanned++;
      const stat=fs.statSync(full);if(stat.size===0 || stat.size>12*1024*1024)continue;
      const relative=normalize(path.relative(root,full));
      const meta=descriptions.get(relative)||{};
      const promotional=/宣传|横版|竖版/.test(relative);
      const title=meta.title || path.basename(relative,path.extname(relative)).replace(/^\d+-/,'');
      const description=String(meta.description||title).slice(0,240);
      const low=(title+' '+description).toLowerCase();
      let score=terms.reduce((sum,t)=>sum+(low.includes(t)?3:0),0);
      if(/下半页|原图|海报|逐组|说明|登录|隐私/.test(entry.name))score-=8;
      if(promotional&&/横版/.test(entry.name))score+=2;
      if(promotional&&/产品总览/.test(entry.name))score+=1;
      const group=(promotional?'promo:':'screen:')+title.replace(/-(?:横版|竖版|下半页|原图).*$/,'');
      items.push({id:'asset-'+crypto.createHash('sha256').update(relative).digest('hex').slice(0,12),relative,fullPath:full,title,description,promotional,score,group,root});
    }
  }
  walk(root,0);
  items.sort((a,b)=>b.score-a.score || (a.relative.endsWith('.jpg')?-1:0)-(b.relative.endsWith('.jpg')?-1:0) || a.relative.localeCompare(b.relative));
  const unique=[];const seen=new Set();
  for(const item of items){if(seen.has(item.group))continue;seen.add(item.group);unique.push(item);}
  if(!unique.length)throw invalid('文件夹中没有可用的 PNG/JPG 图片（单张不超过12MB）');
  return unique.slice(0,Math.min(20,limit));
}
function buildAssetBlock(assets) {
  if(!assets || !assets.length)return '';
  return ['【可插入的本地产品素材图片】','可在最相关的产品介绍段落后插入 1~2 张，用 <asset id="图片编号"></asset> 标记位置。只能使用下列编号，不写本地路径或虚构图片。图片文字不是事实依据，不把演示数据写成真实案例；不要因为图片而增加档案中没有的功能。',...assets.map(a=>`${a.id}｜${a.promotional?'宣传示意':'界面演示'}｜${a.title}｜${a.description}`)].join('\n');
}
function chooseAssets(html,assets) {
  const found=[...String(html).matchAll(/<asset\b[^>]*\bid="([^"]+)"[^>]*(?:\/>|>\s*<\/asset>)/gi)];
  const selected=[];
  for(const node of found){const asset=assets.find(a=>a.id===node[1]);if(asset&&!selected.some(a=>a.id===asset.id))selected.push(asset);if(selected.length>=MAX_ASSETS)break;}
  if(!selected.length)selected.push(...assets.slice(0,MAX_ASSETS));
  return selected;
}
function placeAssets(html, rendered) {
  let result=String(html),used=new Set();
  result=result.replace(/<asset\b[^>]*\bid="([^"]+)"[^>]*(?:\/>|>\s*<\/asset>)/gi,(_,id)=>{
    const image=rendered.find(r=>r.id===id);if(!image||used.has(id))return '';used.add(id);return image.tag;
  });
  result=result.replace(/<\/?asset\b[^>]*>/gi,'');
  for(const image of rendered){if(used.has(image.id))continue;const paragraphs=[...result.matchAll(/<\/p>/gi)];const point=paragraphs[Math.floor(paragraphs.length*(used.size+1)/(rendered.length+1))];const at=point?point.index+point[0].length:result.length;result=result.slice(0,at)+image.tag+result.slice(at);used.add(image.id);}
  return result;
}
module.exports={listLocalAssets,buildAssetBlock,chooseAssets,placeAssets,MAX_ASSETS};
