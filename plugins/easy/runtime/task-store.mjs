import fs from 'node:fs';import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
export function write(p,data){fs.mkdirSync(path.dirname(p),{recursive:true});const temp=p+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(data,null,2));fs.renameSync(temp,p);}
export function taskPath(root,id){if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('Invalid task id');return path.join(root,'jobs',id);}
function sourceFiles(job,images,start=0){
 if(images.length>12)throw Error('一次最多接收 12 张图片');
 return images.map((image,i)=>{const ext=({'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'})[image.mediaType];if(!ext)throw Error('请发送 PNG、JPG 或 WEBP 图纸');const b=Buffer.from(image.data);if(!b.length||b.length>30*1024*1024)throw Error('图片为空或超过 30 MB');const name='source_'+String(start+i+1).padStart(3,'0')+ext;fs.writeFileSync(path.join(job,name),b);return {path:name,name:image.name||name,sha256:sha(b),attachment_id:image.attachmentId||null};});
}
export function createTask(root,images,requirements='',title='图片转CAD'){
 if(!images.length)throw Error('请先在当前 DSH 对话中发送图纸图片');
 const id=new Date().toISOString().replace(/\D/g,'').slice(0,14)+'-'+randomUUID().slice(0,8),job=taskPath(root,id);
 for(const n of ['agent','artifacts','.host/history','.host/state-history'])fs.mkdirSync(path.join(job,n),{recursive:true});
 const sources=sourceFiles(job,images);write(path.join(job,'input.json'),{protocol:'cad-desktop-v2',costPolicy:{enabled:true,account:sha(JSON.stringify(sources.map(s=>s.sha256).sort())),lane:(fs.existsSync(path.join(root,'settings.json'))&&read(path.join(root,'settings.json')).workflow?.costLane==='development')?'development':'production',limitCny:10},revision:0,title,source:sources[0].path,sha256:sources[0].sha256,sources,requirements,task:'以本任务图片为唯一原图依据，独立完成可编辑DXF、1:1模型、PDF；检查后通过cad_review与cad_deliver交付。'});
 write(path.join(job,'.host/user-feedback.json'),{id:id+'-detail-gate-r0',user_request:'检查原图全部细小端部、尖端、圆角、倒角交线及重复特征；各投影与1:1模型一致，原图明确比例保持。原图明确圆角不能为了显尖而改成尖底。',required_evidence:'原图局部、实际实体坐标/数量、最终PDF与LibreCAD同区域可见性。'});
 write(path.join(job,'autonomous-status.json'),{task:id,state:'desktop_drafting',created_at:new Date().toISOString(),controller:'Native DSH desktop CAD plugin',uses_codex_model:false});return {id,job,input:read(path.join(job,'input.json'))};
}
export function reviseTask(root,id,images,request){
 const job=taskPath(root,id),file=path.join(job,'input.json'),input=read(file),revision=(input.revision||0)+1;
 const version=path.join(job,'versions','r'+(input.revision||0)+'-'+Date.now());fs.mkdirSync(version,{recursive:true});
 for(const n of fs.readdirSync(path.join(job,'artifacts'))){const p=path.join(job,'artifacts',n);if(fs.statSync(p).isFile())fs.copyFileSync(p,path.join(version,n));}
 fs.copyFileSync(file,path.join(version,'input.json'));
 const accepted=path.join(job,'.host/user-acceptance.json');if(fs.existsSync(accepted))fs.renameSync(accepted,path.join(version,'user-acceptance.json'));
 const prior=input.sources||[{path:input.source,sha256:input.sha256}];
 const added=sourceFiles(job,images,prior.length);
 const requirements=[input.requirements,request].filter(Boolean).join('\n后续修改：');
 write(file,{...input,revision,sources:[...prior,...added],requirements});
 write(path.join(job,'.host/user-feedback.json'),{id:id+'-detail-gate-r'+revision,user_request:request||'结合补充图复核并局部修订，保持已经正确的比例、尺寸和其他区域。',added_sources:added,required_evidence:'对本次要求逐项给出原图、实际几何及导出局部证据；同时回归所有细小端部和多视图一致性。'});
 write(path.join(job,'autonomous-status.json'),{task:id,state:'desktop_revising',revision,previous_version:path.relative(job,version),uses_codex_model:false});return {id,job,input:read(file)};
}
