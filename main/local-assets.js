'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {nativeImage}=require('electron');
const {chooseAssets,placeAssets}=require('../src/core/local-assets');
const {escapeHtml}=require('../src/core/illustration');
function embedLocalAssets(article,assets) {
  if(!assets || !assets.length)return {...article,html:placeAssets(article.html,[])};
  const rendered=chooseAssets(article.html,assets).map(asset=>{
    const root=fs.realpathSync(asset.root),full=fs.realpathSync(asset.fullPath);
    if(!full.toLowerCase().startsWith((root+path.sep).toLowerCase()))throw new Error('素材图片超出所选文件夹');
    const stat=fs.statSync(full);if(stat.size>12*1024*1024)throw new Error('素材图片超过12MB');
    let image=nativeImage.createFromPath(full);if(image.isEmpty())throw new Error(`素材图片无法读取：${asset.relative}`);
    const size=image.getSize();if(size.width>1354)image=image.resize({width:1354,quality:'best'});
    const dataUri='data:image/png;base64,'+image.toPNG().toString('base64');
    const caption=asset.title+' · '+(asset.promotional?'产品宣传示意，画面为创意物料':'界面演示，数据为示例');
    const tag=`<p style="text-align:center;margin:24px 0 6px;"><img src="${dataUri}" alt="${escapeHtml(asset.title)}" style="width:100%;max-width:677px;height:auto;border-radius:12px;"></p><p style="text-align:center;color:#888;font-size:12px;">${escapeHtml(caption)}</p>`;
    return {id:asset.id,relative:asset.relative,title:asset.title,sha256:crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),tag};
  });
  return {...article,html:placeAssets(article.html,rendered),assetEvidence:rendered.map(({id,relative,title,sha256})=>({id,relative,title,sha256}))};
}
module.exports={embedLocalAssets};
