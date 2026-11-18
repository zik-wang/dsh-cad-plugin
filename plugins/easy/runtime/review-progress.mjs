import fs from 'node:fs';
import path from 'node:path';
import {reviewTask} from './review-delivery.mjs';

function readEvents(file){
 if(!fs.existsSync(file))return [];
 return fs.readFileSync(file,'utf8').split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
}
export function reviewProgress(root,auditId,startedAt,now=Date.now()){
 const elapsed=Math.max(0,Math.floor((now-startedAt)/1000));
 if(!auditId)return {phase:'starting',elapsed_seconds:elapsed,line:'准备独立 DSH 审图 · 已等待 '+elapsed+' 秒'};
 const audit=path.join(root,'jobs',auditId),events=readEvents(path.join(audit,'.host/events.jsonl'));
 const calls=events.filter(e=>e.type==='call'||e.type==='view'),last=calls.at(-1),models=events.filter(e=>e.type==='model').length;
 const log=path.join(audit,'native-audit-events.jsonl'),active=fs.existsSync(log)?fs.statSync(log).mtimeMs:startedAt;
 const idle=Math.max(0,Math.floor((now-active)/1000)),tool=last?.name||(last?.type==='view'?'cad_view':'等待首个工具');
 const state={phase:idle>=180?'no_recent_output':'reviewing',audit_job:auditId,elapsed_seconds:elapsed,model_requests:models,tool_calls:calls.length,last_tool:tool,last_output_seconds_ago:idle};
 state.line='独立 DSH 审图 · '+Math.floor(elapsed/60)+'分'+elapsed%60+'秒 · '+calls.length+'次工具 · '+tool+' · '+(idle>=180?'已 '+idle+' 秒无新输出，尚不能判定进程是否卡住':'最近输出 '+idle+' 秒前');
 return state;
}

// Native Jobs publishes progress directly to the desktop. These lines never
// require a model request, and contain no model reasoning or source dimensions.
export async function reviewWithProgress(root,job,exec,jobs,options={}){
 const run=options.reviewTask||reviewTask;
 if(!jobs)return run(root,job,exec.signal);
 const owner=exec.agent?.id||exec.agent?.session?.id,controller=new AbortController();
 const signal=exec.signal?AbortSignal.any([exec.signal,controller.signal]):controller.signal;
 const started=Date.now(),progressFile=path.join(job,'.host/review-progress.json');
 let result,error,auditId,timer;
 const id=jobs.start({kind:'cad-review',label:'CAD 独立审图 · '+path.basename(job),owner,
  ...(exec.callId?{toolCall:{callId:exec.callId,rootCallId:exec.rootCallId||exec.callId}}:{}),
  run(handle){
   const tick=()=>{try{const status=reviewProgress(root,auditId,started);fs.writeFileSync(progressFile,JSON.stringify(status,null,2));handle.updateProgress(status.line);}catch{/* UI telemetry must not change the quality result. */}};
   tick();timer=setInterval(tick,options.intervalMs||2000);
   const done=Promise.resolve().then(()=>run(root,job,signal,{onProgress:event=>{if(event.auditId)auditId=event.auditId;tick();}})).then(value=>{
    result=value;const detail=value.verdict==='pass'?'独立审图通过；交付仍需 cad_deliver':'独立审图完成：需要返修';
    try{fs.writeFileSync(progressFile,JSON.stringify({phase:'completed',verdict:value.verdict,report:value.report,finished_at:new Date().toISOString()},null,2));}catch{}
    return {status:'completed',detail};
   },reason=>{
    error=reason;const phase=signal.aborted?'cancelled':'interrupted';
    try{fs.writeFileSync(progressFile,JSON.stringify({phase,error:reason.message,finished_at:new Date().toISOString()},null,2));}catch{}
    return {status:signal.aborted?'killed':'failed',detail:reason.message};
   }).finally(()=>clearInterval(timer));
   return {done,cancel:reason=>controller.abort(Error(reason||'Native CAD review cancelled'))};
  }
 });
 // Keep a registry waiter attached so one completion is returned by cad_review,
 // instead of also injecting a duplicate completion into the model context.
 let view;do{view=await jobs.wait(id,60000,owner);}while(['running','stopping'].includes(view.status));
 if(error)throw error;
 if(view.status!=='completed')throw Error(view.detail||'Native review interrupted; retained job '+id);
 if(!result)throw Error('Native review ended without a report; retained job '+id);
 return {...result,native_job_id:id};
}
