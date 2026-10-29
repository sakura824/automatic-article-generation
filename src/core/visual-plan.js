'use strict';
const {escapeHtml}=require('./illustration');
function plain(s){return String(s||'').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi,'').replace(/<[^>]*>/g,' ').replace(/&[^;]+;/g,' ').replace(/\s+/g,' ').trim();}
function clip(s,n){return Array.from(plain(s)).slice(0,n).join('');}
function visualPlan(article){
 const html=String(article.html||'').replace(/<illus\b[\s\S]*?<\/illus>/gi,'');
 const paragraphs=[...html.matchAll(/<(?:p|li|h[2-4])\b[^>]*>([\s\S]*?)<\/(?:p|li|h[2-4])>/gi)].map(m=>plain(m[1])).filter(s=>s.length>8&&!/个体差异|AI 生成|人工审阅/.test(s));
 const points=[...new Set(paragraphs.map(s=>clip(s,52)))].slice(0,6);
 if(points.length<2)for(const s of plain(html).split(/[。！？；]/).filter(s=>s.length>5)){const t=clip(s,52);if(!points.includes(t))points.push(t);if(points.length>=4)break;}
 if(!points.length)points.push(clip(article.digest||article.title,52));
 const mid=Math.max(1,Math.ceil(points.length/2));
 return [{type:'summary',title:clip(article.title,30),items:points.slice(0,mid)},{type:'summary',title:'把重点变成行动',items:points.slice(mid).length?points.slice(mid):points.slice(0,mid)}];
}
function coverHtml(article){
 const title=clip(article.title,52),digest=clip(article.digest||plain(article.html),80),salt=String(article.id||article.batchId||article.createdAt||article.html||'');
 let hash=0;for(const c of title+salt)hash=(hash*31+c.charCodeAt(0))>>>0;
 const palettes=[['#062d31','#20d3a2'],['#122447','#6eb5ff'],['#302041','#d5a2fd'],['#3b281c','#ffbc70']];const [bg,accent]=palettes[hash%palettes.length];
 return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>*{box-sizing:border-box}html,body{margin:0;width:900px;height:383px;overflow:hidden}body{background:${bg};color:white;font-family:'Microsoft YaHei',sans-serif}.orb{position:absolute;border:2px solid ${accent};border-radius:50%;width:380px;height:380px;right:-80px;top:0;opacity:.25}.orb.two{width:270px;height:270px;right:35px;top:56px}.content{position:relative;padding:38px 52px;width:770px}.tag{font-size:15px;letter-spacing:4px;color:${accent};margin-bottom:20px}.title{font-size:${title.length>32?36:44}px;line-height:1.32;font-weight:800;max-height:174px;overflow:hidden}.digest{margin-top:18px;color:#d4dfe1;line-height:1.6;font-size:17px;max-width:670px;max-height:56px;overflow:hidden}.line{position:absolute;left:52px;bottom:26px;width:72px;height:5px;background:${accent};border-radius:4px}</style></head><body><div class="orb"></div><div class="orb two"></div><div class="content"><div class="tag">${escapeHtml(article.productName||'知识 · 方法 · 实践')}</div><div class="title">${escapeHtml(title)}</div><div class="digest">${escapeHtml(digest)}</div></div><div class="line"></div></body></html>`;
}
module.exports={plain,visualPlan,coverHtml};
