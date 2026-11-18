import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const digest=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read=(p,fallback=null)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return fallback;}};
const lines=p=>{try{return fs.readFileSync(p,'utf8').split('\n').flatMap(s=>{try{return [JSON.parse(s)];}catch{return [];}});}catch{return [];}};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const at=n=>Number(n.split('_audit_')[1]?.split('_')[0])||0;
const names={image:'drawing.png',pdf:'drawing.pdf',dxf:'drawing.dxf',model:'model_1to1.dxf',librecad:'drawing_librecad.png',librecad_pdf:'drawing_librecad.pdf'};
export function collectReviewHistory(root,id){
 if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('Invalid task id');
 const main=path.join(root,'jobs',id),input=read(path.join(main,'input.json'),{});
 const reports=fs.readdirSync(path.join(main,'.host')).filter(n=>/^native-review-\d+\.json$/.test(n)).sort().map(n=>({path:path.join(main,'.host',n),data:read(path.join(main,'.host',n),{})}));
 const calls=lines(path.join(main,'.host/events.jsonl')).filter(e=>e.type==='call'&&e.name==='cad_review');
 const audits=fs.readdirSync(path.join(root,'jobs')).filter(n=>n.startsWith(id+'_audit_')).sort((a,b)=>at(a)-at(b));
 const versions=new Map(),rounds=[];
 for(const [i,name] of audits.entries()){
  const audit=path.join(root,'jobs',name),task=read(path.join(audit,'input.json'));
  if(!task?.snapshot||task.review_of!==id)continue;
  const key=createHash('sha256').update(JSON.stringify(Object.entries(task.snapshot).sort(([a],[b])=>a.localeCompare(b)))).digest('hex');
  if(!versions.has(key))versions.set(key,versions.size+1);
  const checks=Object.entries(task.snapshot).map(([n,h])=>{const file=path.resolve(audit,n),inside=file.startsWith(path.resolve(audit)+path.sep);return {file:n,sha256:h,verified:inside&&fs.existsSync(file)&&digest(file)===h};});
  const matched=reports.filter(r=>r.data.audit_job===name).at(-1),pending=read(path.join(audit,'artifacts/review.json'));
  const exits=lines(path.join(audit,'runtime-exits.jsonl'));
  const errors=checks.filter(c=>!c.verified),state=errors.length?'integrity_error':matched?matched.data.verdict:pending?'submitted_pending_host':exits.at(-1)?.code&&!fs.existsSync(path.join(audit,'.host/runtime-owner.json'))?'interrupted':'pending';
  const report=matched?.data||pending||{},files=Object.fromEntries(Object.entries(names).filter(([,n])=>fs.existsSync(path.join(audit,'reference',n))).map(([k,n])=>[k,{path:path.join(audit,'reference',n),sha256:digest(path.join(audit,'reference',n)),url:'../../'+name+'/reference/'+n}]));
  rounds.push({id:name,round:versions.get(key),candidate_key:key,frozen_at:new Date(at(name)).toISOString(),source_revision:task.source_revision||0,state,hashes_verified:errors.length===0,hash_checks:checks,files,audit_dir:audit,report_path:matched?.path||(pending?path.join(audit,'artifacts/review.json'):null),report_url:matched?'../.host/'+path.basename(matched.path):pending?'../../'+name+'/artifacts/review.json':null,reviewer_session:report.session||null,checks:report.checks||[],issues:report.issues||[],unresolved:report.unresolved||[],exits,review_tool_calls:calls.filter(c=>Date.parse(c.time)>=at(name)-1000&&Date.parse(c.time)<(audits[i+1]?at(audits[i+1])-1000:Infinity)).map(c=>({time:c.time})),source_files:checks.filter(c=>!c.file.startsWith('reference/')).map(c=>({path:path.join(audit,c.file),url:'../../'+name+'/'+c.file,sha256:c.sha256}))});
 }
 return {task:id,title:input.title||input.sources?.map(s=>s.name).join(' / ')||id,generated_at:new Date().toISOString(),candidate_count:versions.size,rounds,policy:'Each image is the immutable candidate copied BEFORE its independent review. Repeated calls/resumes on the same hashes are not new drawing versions. A later revision is not assumed to fix an issue without a new passing report.'};
}
export function writeReviewHistory(root,id){
 const data=collectReviewHistory(root,id),dir=path.join(root,'jobs',id,'review-history');fs.mkdirSync(dir,{recursive:true});
 const states={pass:'审图通过',needs_revision:'需要返修',pending:'尚无完整报告',submitted_pending_host:'已提交报告，等待主流程确认',interrupted:'运行曾中断，报告未返回',integrity_error:'快照完整性异常'};
 const date=t=>new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>送审版本 · ${esc(data.title)}</title><style>body{margin:0;background:#f4f6f8;color:#17243a;font:16px/1.6 'Segoe UI','Microsoft YaHei',sans-serif}main{max-width:1320px;margin:auto;padding:28px}h1{font-size:28px}a{color:#205dc0}article{background:white;padding:22px;margin:24px 0;border:1px solid #dce2e8;border-radius:12px}img{width:100%;max-height:75vh;object-fit:contain;background:#eef1f4}nav{display:flex;gap:15px;flex-wrap:wrap}small,.note{color:#586678}code{overflow-wrap:anywhere}summary{cursor:pointer;padding:10px 0}li{margin-bottom:12px}.state{font-weight:700}a:focus-visible,summary:focus-visible{outline:3px solid #205dc0} @media(max-width:600px){main{padding:15px}article{padding:14px}}</style><main><p>DSH / 送审版本档案</p><h1>${esc(data.title)}</h1><p>每次独立审图开始前冻结的实际文件。送审图和审图意见一一对应；重试不会覆盖旧图，也不增加图纸版本号。</p><p class="note">记录更新于 ${esc(date(data.generated_at))}（北京时间）。这是文件快照页面；刷新可读取后续写入的版本。</p><nav>${data.rounds.map(r=>`<a href="#${esc(r.id)}">R${String(r.round).padStart(2,'0')} · ${esc(date(r.frozen_at))}</a>`).join('')}</nav>${data.rounds.map(r=>`<article id="${esc(r.id)}"><h2>R${String(r.round).padStart(2,'0')} · 送审前</h2><p>${esc(date(r.frozen_at))} · <span class="state">${esc(states[r.state]||r.state)}</span> · ${r.hashes_verified?'冻结文件哈希一致':'完整性检查失败'}</p>${r.files.image?`<a href="${esc(r.files.image.url)}" target="_blank" rel="noopener"><img src="${esc(r.files.image.url)}" alt="R${r.round} 送审时的真实图纸"></a>`:'<p>没有留存 PNG，不补造历史图片。</p>'}<nav>${Object.entries(r.files).map(([k,f])=>`<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc({image:'PNG',pdf:'PDF',dxf:'工程图 DXF',model:'1:1 DXF',librecad:'LibreCAD PNG',librecad_pdf:'LibreCAD PDF'}[k])}</a>`).join('')}${r.report_url?`<a href="${esc(r.report_url)}" target="_blank" rel="noopener">本轮完整报告 JSON</a>`:''}</nav><p>${r.review_tool_calls.length} 次 review 工具调用（含失败或取消）；${r.exits.filter(e=>e.code!==0).length} 条异常退出记录。次数不等于图纸版本数。</p><details ${r.issues.length?'open':''}><summary>本轮审图意见 · ${r.issues.length} 项</summary>${r.issues.length?'<ol>'+r.issues.map(x=>`<li><b>${esc(x.severity)}</b> ${esc(x.observation)}<br><small>源图依据：${esc(x.source_evidence)}<br>实测依据：${esc(x.measured_evidence)}<br>修订要求：${esc(x.required_change)}</small></li>`).join('')+'</ol>':'<p>尚无完整意见，不能据此认为已通过。</p>'}</details><details><summary>快照与完整性证据</summary><code>${esc(r.id)}</code><ul>${r.hash_checks.map(x=>`<li>${esc(x.file)} · ${x.verified?'一致':'异常'}<br><small><code>${esc(x.sha256)}</code></small></li>`).join('')}</ul></details></article>`).join('')}</main></html>`;
 const atomic=(name,content)=>{const dest=path.join(dir,name),tmp=dest+'.tmp-'+process.pid;fs.writeFileSync(tmp,content);fs.renameSync(tmp,dest);};
 atomic('index.json',JSON.stringify(data,null,2));atomic('index.html',html);return data;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const data=writeReviewHistory(path.resolve(process.argv[2]),process.argv[3]);console.log(JSON.stringify(data));}
