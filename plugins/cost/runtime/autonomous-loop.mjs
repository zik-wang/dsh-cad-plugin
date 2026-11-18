import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {nativeReview,runDSH} from './native-review.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),pause=ms=>new Promise(r=>setTimeout(r,ms));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function alive(pid){try{process.kill(pid,0);return true}catch(e){return e.code!=='ESRCH'}}
function models(job){return fs.readFileSync(path.join(job,'.host/events.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.type==='model'&&e.session)}
function matches(job,report){const input=JSON.parse(fs.readFileSync(path.join(job,'input.json')));return (report.source_revision||0)===(input.revision||0)&&Object.entries(report.snapshot).every(([p,h])=>{const f=path.join(job,p.startsWith('reference/')?p.replace('reference/','artifacts/'):p);return fs.existsSync(f)&&sha(f)===h})}
export async function autonomousLoop(id,waitPid){
 if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('Invalid task');const job=path.join(root,'jobs',id),statusPath=path.join(job,'autonomous-status.json');
 if(fs.existsSync(path.join(job,'.host/user-acceptance.json'))){console.log('User-accepted candidate is frozen: '+id);return JSON.parse(fs.readFileSync(statusPath));}
 const retained=fs.existsSync(statusPath)?JSON.parse(fs.readFileSync(statusPath)):null;
 if(retained){const history=path.join(job,'.host','state-history');fs.mkdirSync(history,{recursive:true});fs.copyFileSync(statusPath,path.join(history,'autonomous-'+Date.now()+'.json'));}
 const state={task:id,started_at:new Date().toISOString(),state:'waiting_existing_run',controller:'native DSH drafting plus independent native DSH review',uses_codex_model:false,codex_drawing_review:false,rounds:[]};
 const save=()=>fs.writeFileSync(statusPath,JSON.stringify(state,null,2));save();
 try{
  while(waitPid&&alive(waitPid))await pause(10000);
  const authorSession=models(job).at(-1)?.session;if(!authorSession)throw Error('Missing native drawing session');state.drawing_session=authorSession;
  const ownerPath=path.join(job,'.host/runtime-owner.json');
  if(fs.existsSync(ownerPath)){const owner=JSON.parse(fs.readFileSync(ownerPath));if(alive(owner.pid))throw Error('Existing DSH runtime is still active; no concurrent writer allowed');}
  const interruptedRevision=retained?.phase==='revision'&&retained.state!=='delivered'||retained?.state==='blocked_api_balance'&&retained.last_revision_exit!==0&&retained.last_revision_exit!==undefined&&!/_audit_/.test(retained.error||'');
  if(interruptedRevision){
   state.state='dsh_revising';state.phase='revision';state.resumed_interrupted_revision=true;save();
   const log=path.join(job,'autonomous-revisions.jsonl'),offset=fs.existsSync(log)?fs.statSync(log).size:0;
   const prompt='API额度已恢复，请继续刚才中断的修订，沿用保留的代码和已有证据，不要重开图。先cad_info读取最新用户反馈；当前重点是槽端尖细交线和原图细节。完成尚未完成的实际几何修订，同步重建两份DXF、导出PDF和LibreCAD预览，亲自检查后写revision-resolution.json及用户反馈要求的tip-resolution.json和局部证据。不要只修改图纸而遗漏1:1模型，不要因中断而把半成品交验。保留原图规定比例、尺寸和明确的圆角，其他已接受内容尽量保持稳定。最近一次验收报告为 '+(retained.rounds?.at(-1)?.review||'请cad_list查看.host下最新native-review报告')+'。';
   const code=await runDSH([id,'--session-id',authorSession,'--json',prompt],log);state.last_revision_exit=code;save();
   if(code!==0){const tail=fs.readFileSync(log).subarray(offset).toString('utf8');throw Error(tail.includes('Insufficient Balance')?'DeepSeek API HTTP 402 Insufficient Balance; native work retained':'Retained native revision did not finish; candidate not sent for acceptance');}
  }
  const maxRepairs=JSON.parse(fs.readFileSync(path.join(root,'settings.json'))).workflow?.maxRepairRounds??3;
  for(let round=0;round<=maxRepairs;round++){
   if(fs.existsSync(path.join(job,'.host/user-acceptance.json'))){state.state='user_accepted';break;}
   if(!fs.existsSync(path.join(job,'artifacts/drawing.png'))){state.state='drafting';save();const code=await runDSH([id,'--session-id',authorSession,'--json','继续当前任务，保留已读图证据，先完成可运行整图及两份DXF、PDF和LibreCAD预览。你自己写程序并检查。'],path.join(job,'autonomous-drafting.jsonl'));state.draft_exit=code;if(!fs.existsSync(path.join(job,'artifacts/drawing.png')))throw Error('DSH has not generated a complete candidate');}
   state.state='dsh_reviewing';state.phase='review';save();
   let result;
   if(round===0){const previous=fs.readdirSync(path.join(job,'.host')).filter(n=>/^native-review-\d+\.json$/.test(n)).sort().at(-1);if(previous){const p=path.join(job,'.host',previous),r=JSON.parse(fs.readFileSync(p));if(r.verdict==='needs_revision'&&matches(job,r))result={report:r,path:p};}}
   if(!result)result=await nativeReview(id);
   if(fs.existsSync(path.join(job,'.host/user-acceptance.json'))){state.state='user_accepted';break;}
   state.rounds.push({round,review:path.relative(job,result.path),audit_job:result.report.audit_job,verdict:result.report.verdict,drawing_sha256:result.report.snapshot['reference/drawing.dxf'],model_sha256:result.report.snapshot['reference/model_1to1.dxf']});save();
   if(result.report.verdict==='pass'&&matches(job,result.report)){
    const released=path.join(job,'release',Date.now().toString());fs.mkdirSync(released,{recursive:true});const manifest={status:'passed_native_dsh_review',review:path.relative(job,result.path),source_sha256:JSON.parse(fs.readFileSync(path.join(job,'input.json'))).sha256,files:{},meaning:'Automated source fidelity and geometry review passed; not a design signature or manufacturing authorization.'};
    for(const n of ['drawing.dxf','model_1to1.dxf','drawing.pdf','drawing.png','drawing_librecad.pdf']){const src=path.join(job,'artifacts',n);fs.copyFileSync(src,path.join(released,n));manifest.files[n]=sha(src);}
    fs.copyFileSync(result.path,path.join(released,'dsh-review.json'));fs.writeFileSync(path.join(released,'manifest.json'),JSON.stringify(manifest,null,2));state.state='delivered';state.release=path.relative(job,released);break;
   }
   if(round===maxRepairs){state.state='not_accepted';state.reason='Native DSH review still has unresolved checks after '+maxRepairs+' repair rounds; work retained for a focused user clarification or continuation.';break;}
   state.state='dsh_revising';state.phase='revision';save();
   const prompt='继续你自己的制图任务。独立DSH验收会话已经亲自读原图并测量候选，结果在 '+path.relative(job,result.path).replaceAll('\\','/')+'。请cad_read读取。按每条检查回看源图与实际实体，自己改建模代码，重建model_1to1.dxf与drawing.dxf，再导出PDF及LibreCAD预览。先解决真实几何、数量、尺寸箭头所测对象、控制名义值和参考值的优先级，然后排版。不要仅把正确数值写到文字里；不能把横向槽口宽度当深度；不能仅改尺寸测量缓存；重复次数必须落实为实体数量。模型意见也可能错，请用原图与实测依据裁决，不能把需要你用工具验证的事项推给Codex或人工。写artifacts/revision-resolution.json，逐条记录实际修订或有证据拒绝。完成后由DSH独立验收继续检查。\n'+fs.readFileSync(path.join(root,'QUALITY_RULES.txt'),'utf8');
   const revisionLog=path.join(job,'autonomous-revisions.jsonl'),logStart=fs.existsSync(revisionLog)?fs.statSync(revisionLog).size:0;
   const code=await runDSH([id,'--session-id',authorSession,'--json',prompt],revisionLog);state.last_revision_exit=code;save();
   if(code!==0&&fs.readFileSync(revisionLog).subarray(logStart).toString('utf8').includes('Insufficient Balance'))throw Error('DeepSeek API HTTP 402 Insufficient Balance; native work retained');
   if(code!==0)throw Error('Native revision interrupted; work retained, incomplete candidate was not sent for review');
  }
 }catch(e){state.state=/Insufficient Balance/.test(e.message)?'blocked_api_balance':'execution_failed';state.error=e.message;}
 state.finished_at=new Date().toISOString();save();console.log('Autonomous result '+id+': '+state.state);return state;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await autonomousLoop(process.argv[2],process.argv[3]?Number(process.argv[3]):undefined);
