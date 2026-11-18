import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash,randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';
import {writeReviewHistory} from './review-history.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export function runDSH(args,logPath,signal){signal?.throwIfAborted();return new Promise((resolve,reject)=>{const log=fs.createWriteStream(logPath,{flags:'a'}),p=spawn(process.execPath,[path.join(root,'launch.mjs'),...args],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});const abort=()=>{try{const owner=JSON.parse(fs.readFileSync(path.join(root,'jobs',args[0],'.host/runtime-owner.json')));if(owner.launcher_pid===p.pid&&owner.mode==='headless')process.kill(owner.pid);}catch{}p.kill();};signal?.addEventListener('abort',abort,{once:true});let pending='';p.stdout.on('data',b=>{pending+=b;let n;while((n=pending.indexOf('\n'))>=0){const s=pending.slice(0,n);pending=pending.slice(n+1);try{const e=JSON.parse(s);if(!['thinking','reasoning'].includes(e.type)){log.write(JSON.stringify(e)+'\n');if(e.type==='tool_call')console.log('DSH '+args[0]+': '+e.tool)}}catch{}}});p.stderr.on('data',b=>log.write(b));p.on('error',reject);p.on('close',c=>{signal?.removeEventListener('abort',abort);log.end(()=>{if(signal?.aborted)reject(signal.reason||Error('Native DSH review cancelled'));else resolve(c);});});});}
export async function nativeReview(id,{signal,onProgress}={}){
 if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('Invalid task');const main=path.join(root,'jobs',id),input=JSON.parse(fs.readFileSync(path.join(main,'input.json')));
 const refreshHistory=()=>{try{writeReviewHistory(root,id);}catch(error){console.error('Review history presentation could not refresh: '+error.message);}};
 const matchesSnapshot=s=>Object.entries(s).every(([p,h])=>{const f=path.join(main,p.startsWith('reference/')?p.replace('reference/','artifacts/'):p);return fs.existsSync(f)&&sha(f)===h;});
 const pending=fs.readdirSync(path.join(root,'jobs')).filter(n=>n.startsWith(id+'_audit_')).sort().reverse().find(n=>{try{const j=path.join(root,'jobs',n),t=JSON.parse(fs.readFileSync(path.join(j,'input.json')));return t.kind==='cad_review'&&t.review_of===id&&(t.source_revision||0)===(input.revision||0)&&t.snapshot&&Object.keys(t.snapshot).length>=7&&!fs.existsSync(path.join(j,'artifacts/review.json'))&&fs.existsSync(path.join(j,'.host/events.jsonl'))&&matchesSnapshot(t.snapshot);}catch{return false;}});
 const auditId=pending||id+'_audit_'+Date.now()+'_'+randomUUID().slice(0,4),job=path.join(root,'jobs',auditId);
 onProgress?.({auditId,resumed:!!pending});
 for(const d of ['agent','artifacts','reference','.host'])fs.mkdirSync(path.join(job,d),{recursive:true});
 const snapshot=pending?JSON.parse(fs.readFileSync(path.join(job,'input.json'))).snapshot:{};function copy(from,to){fs.copyFileSync(path.join(main,from),path.join(job,to));snapshot[to]=sha(path.join(job,to));}
 if(!pending){
 copy(input.source,input.source);
 for(const s of input.sources||[])if(s.path!==input.source)copy(s.path,s.path);
 for(const f of ['drawing.dxf','model_1to1.dxf','drawing.pdf','drawing.png','drawing_librecad.pdf','drawing_librecad.png'])copy('artifacts/'+f,'reference/'+f);
 const task={kind:'cad_review',source:input.source,sources:input.sources,requirements:input.requirements_source==='native_user_message'?input.requirements:undefined,source_revision:input.revision||0,sha256:snapshot[input.source],review_of:id,snapshot,task:'独立验收reference内候选CAD；以全部源图和明确的原始用户要求为依据，实际测量并提交cad_submit_review。未验证的建模者摘要不作为用户尺寸要求。补充图也是输入；冲突不得自行猜值。不要编写零件答案或重绘。'};
 fs.writeFileSync(path.join(job,'input.json'),JSON.stringify(task,null,2));
 }else console.log('Resuming retained native DSH audit: '+auditId);
 refreshHistory();
 const prompt='请cad_info读取验收任务。你是独立DSH核查会话，不是建模会话。请直接读原图并核对reference候选的两份DXF和两套预览，必要时写短小Python测量脚本，逐一完成8类检查。优先查实际槽/孔/齿数量、尺寸箭头所测方向与几何、控制名义值和参考值优先级、多视图一致性及原图明确比例。不能只检查文件能打开，不能只读标注文字。最后必须cad_submit_review提交基于源图与实测证据的结果。';
 const exitCodes=[];
 for(let i=0;i<2&&!fs.existsSync(path.join(job,'artifacts/review.json'));i++){
  let args=[auditId,'--json',prompt];if(i||pending){const events=fs.readFileSync(path.join(job,'.host/events.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse),sid=events.filter(e=>e.type==='model'&&e.session).at(-1)?.session;if(sid)args=[auditId,'--session-id',sid,'--json','沿用已保留的审图会话，从中断处继续。沿用已经读取和测得的证据，不要重新开展同一检查。完成剩余关键测量后提交cad_submit_review，不要反复无界裁图。不能确认的关键项标uncertain，并保留具体问题。'];}
  const logFile=path.join(job,'native-audit-events.jsonl'),logStart=fs.existsSync(logFile)?fs.statSync(logFile).size:0;
  const code=await runDSH(args,path.join(job,'native-audit-events.jsonl'),signal);exitCodes.push(code);fs.appendFileSync(path.join(job,'runtime-exits.jsonl'),JSON.stringify({attempt:i,code,time:new Date().toISOString()})+'\n');
  refreshHistory();
  if(code!==0&&fs.readFileSync(logFile).subarray(logStart).toString('utf8').includes('Insufficient Balance'))throw Error('DeepSeek API HTTP 402 Insufficient Balance; native work retained: '+auditId);
 }
 const resultFile=path.join(job,'artifacts/review.json');if(!fs.existsSync(resultFile))throw Error('Native DSH audit did not submit a review: '+auditId+'; process exit codes: '+JSON.stringify(exitCodes)+'. Session and work retained; inspect runtime-exits.jsonl and native-audit-events.jsonl.');
 const report=JSON.parse(fs.readFileSync(resultFile));report.audit_job=auditId;report.source_revision=input.revision||0;
 const auditEvents=fs.readFileSync(path.join(job,'.host/events.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse);
 const receipt=auditEvents.filter(e=>e.type==='native-review-submitted').at(-1);
 if(!receipt||receipt.sha256!==sha(resultFile))throw Error('Review submission integrity check failed: '+auditId);
 const cats=['units_structure','dimensions_tolerances','repeated_features','directions_datums','geometry_consistency','view_scales','visual_readability','source_completeness'];
 const failures=auditEvents.filter(e=>e.type==='call'&&e.name==='cad_submit_review').map(e=>e.args).filter(a=>cats.every(c=>a.checks?.some(x=>x.category===c&&typeof x.evidence==='string'&&x.evidence.trim().length>=12))&&(a.verdict==='needs_revision'||a.checks.some(x=>x.status!=='pass')||a.issues?.some(x=>x.severity!=='minor')||a.unresolved?.length));
 if(failures.length){const f=failures.at(-1);Object.assign(report,{verdict:'needs_revision',checks:f.checks,issues:f.issues,unresolved:f.unresolved,decision_policy:'The candidate is unchanged. Earlier native DSH blocking evidence is retained even if a later submission says pass.'});}
 report.matches_current=Object.entries(snapshot).every(([p,h])=>{const f=path.join(main,p.startsWith('reference/')?p.replace('reference/','artifacts/'):p);return fs.existsSync(f)&&sha(f)===h});
 if(!report.matches_current)report.verdict='needs_revision';
 const out=path.join(main,'.host','native-review-'+Date.now()+'.json');fs.writeFileSync(out,JSON.stringify(report,null,2));refreshHistory();console.log('Native DSH review: '+report.verdict);return {report,path:out};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const r=await nativeReview(process.argv[2]);console.log(JSON.stringify({report:r.path,verdict:r.report.verdict}));}
