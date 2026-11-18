import fs from 'node:fs';import path from 'node:path';import {nativeReview} from './native-review.mjs';import {read,write,sha} from './task-store.mjs';
export function matchesFiles(job,files){return Object.entries(files).every(([n,h])=>{const p=path.join(job,n.replace(/^reference\//,'artifacts/'));return fs.existsSync(p)&&sha(fs.readFileSync(p))===h;});}
const activeReviews=new Set();
const candidateFiles=['drawing.dxf','model_1to1.dxf','drawing.pdf','drawing.png','drawing_librecad.pdf','drawing_librecad.png'];
export function reviewCandidateKey(revision,files){return sha(JSON.stringify({revision,files:candidateFiles.map(n=>[n,files['artifacts/'+n]||files['reference/'+n]||null])}));}
export function reconcileReviewBudget(job){
 const revision=read(path.join(job,'input.json')).revision||0,host=path.join(job,'.host');
 const reports=fs.readdirSync(host).filter(n=>/^native-review-\d+\.json$/.test(n)).sort().map(n=>({path:path.join(host,n),report:read(path.join(host,n))})).filter(x=>(x.report.source_revision||0)===revision&&x.report.snapshot&&candidateFiles.every(n=>x.report.snapshot['reference/'+n])&&['pass','needs_revision'].includes(x.report.verdict));
 const candidates=[...new Set(reports.map(x=>reviewCandidateKey(revision,x.report.snapshot)))],budgetPath=path.join(host,'review-budget.json');
 const previous=fs.existsSync(budgetPath)?read(budgetPath):null;
 if(previous&&!previous.accounting&&!fs.existsSync(path.join(host,'review-budget-legacy.json')))write(path.join(host,'review-budget-legacy.json'),{...previous,migrated_at:new Date().toISOString(),reason:'Legacy count charged invocations, including crashes and cancellation, instead of distinct candidates with submitted reports.'});
 const budget={revision,count:candidates.length,candidates,accounting:'distinct_candidates_with_native_reports'};write(budgetPath,budget);return {budget,reports};
}
function feedback(result,max,count,extra={}){return {verdict:result.report.verdict,report:result.relativePath,checks:result.report.checks,feedback_checks:result.report.feedback_checks,issues:result.report.issues,unresolved:result.report.unresolved,remaining_reviews:Math.max(0,max-count),...extra};}
export async function reviewTask(root,job,signal,options={}){
 if(activeReviews.has(job))throw Error('A native review is already running for this task. Preserve the candidate and wait for its result.');
 const input=read(path.join(job,'input.json')),revision=input.revision||0,p=path.join(job,'.host/preflight.json');
 if(input.protocol==='cad-desktop-v2'&&(!fs.existsSync(p)||!read(p).passed||read(p).source_revision!==revision||!matchesFiles(job,read(p).files)))throw Error('Call cad_preflight; resolve its issues and rerun it after every geometry/export change.');
 const {budget,reports}=reconcileReviewBudget(job);
 const max=read(path.join(root,'settings.json')).workflow?.maxReviewAttempts??4;
 const current=reports.filter(x=>matchesFiles(job,x.report.snapshot));
 if(current.length){
  // An unchanged candidate does not get another chance to erase a blocking report.
  const result=current.findLast(x=>x.report.verdict==='needs_revision')||current.at(-1);
  write(path.join(job,'autonomous-status.json'),{task:path.basename(job),state:result.report.verdict==='pass'?'ready_to_deliver':'desktop_revising',revision,review:path.relative(job,result.path),uses_codex_model:false});
  return feedback({...result,relativePath:path.relative(job,result.path)},max,budget.count,{reused_existing_report:true});
 }
 if(budget.count>=max)throw Error('This source revision reached '+max+' distinct candidates with completed independent reviews. Preserve work and ask one focused clarification.');
 const files=Object.fromEntries(candidateFiles.map(n=>['artifacts/'+n,sha(fs.readFileSync(path.join(job,'artifacts',n)))])),key=reviewCandidateKey(revision,files),attemptPath=path.join(job,'.host/review-attempts.jsonl');
 const attempts=fs.existsSync(attemptPath)?fs.readFileSync(attemptPath,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
 const failures=attempts.filter(a=>a.candidate===key&&a.phase==='error').length,maxFailures=read(path.join(root,'settings.json')).workflow?.maxReviewInfrastructureFailures??4;
 if(failures>=maxFailures)throw Error('Native review infrastructure failed '+failures+' times for this unchanged candidate. Work is retained; repair the runtime before retrying. No quality review has been charged.');
 const attempt={candidate:key,revision,time:new Date().toISOString()};fs.appendFileSync(attemptPath,JSON.stringify({...attempt,phase:'started'})+'\n');activeReviews.add(job);
 write(path.join(job,'autonomous-status.json'),{task:path.basename(job),state:'desktop_reviewing',revision,uses_codex_model:false});
 let result;try{result=await (options.nativeReview||nativeReview)(path.basename(job),{signal,onProgress:options.onProgress});}catch(error){fs.appendFileSync(attemptPath,JSON.stringify({...attempt,phase:signal?.aborted?'cancelled':'error',time:new Date().toISOString(),error:error.message})+'\n');reconcileReviewBudget(job);write(path.join(job,'autonomous-status.json'),{task:path.basename(job),state:/Insufficient Balance/.test(error.message)?'blocked_api_balance':'desktop_review_interrupted',revision,error:error.message,uses_codex_model:false});throw error;}finally{activeReviews.delete(job);}
 fs.appendFileSync(attemptPath,JSON.stringify({...attempt,phase:'submitted',time:new Date().toISOString(),report:path.relative(job,result.path)})+'\n');const completed=reconcileReviewBudget(job).budget;
 write(path.join(job,'autonomous-status.json'),{task:path.basename(job),state:result.report.verdict==='pass'?'ready_to_deliver':'desktop_revising',revision,review:path.relative(job,result.path),uses_codex_model:false});
 return feedback({...result,relativePath:path.relative(job,result.path)},max,completed.count);
}
export function deliverTask(job){
 const input=read(path.join(job,'input.json')),files=fs.readdirSync(path.join(job,'.host')).filter(n=>/^native-review-\d+\.json$/.test(n)).sort();
 if(!files.length)throw Error('No native DSH review; call cad_review first');
 const reportPath=path.join(job,'.host',files.at(-1)),report=read(reportPath);
 if(report.verdict!=='pass'||!report.matches_current||(report.source_revision||0)!==(input.revision||0)||!matchesFiles(job,report.snapshot))throw Error('Latest review is not a passing review of the current source and candidate');
 if(input.protocol==='cad-desktop-v2'){
  const pre=read(path.join(job,'.host/preflight.json'));
  if(!pre.passed||pre.source_revision!==input.revision||!matchesFiles(job,pre.files))throw Error('Preflight is stale or failed');
 }
 const release=path.join(job,'release','desktop-'+Date.now());fs.mkdirSync(release,{recursive:true});const hashes={};
 for(const n of ['drawing.dxf','model_1to1.dxf','drawing.pdf','drawing.png','drawing_librecad.pdf','drawing_librecad.png','tip_detail.png','tip_source.png','feature-checks.json','revision-resolution.json']){
  const src=path.join(job,'artifacts',n);if(fs.existsSync(src)){fs.copyFileSync(src,path.join(release,n));hashes[n]=sha(fs.readFileSync(src));}
 }
 fs.copyFileSync(reportPath,path.join(release,'dsh-review.json'));
 write(path.join(release,'manifest.json'),{status:'passed_native_dsh_review',source_revision:input.revision||0,source_hashes:input.sources||[{path:input.source,sha256:input.sha256}],files:hashes,reviewer:report.session,meaning:'Automated source fidelity review, not a manufacturing design signature.'});
 write(path.join(job,'autonomous-status.json'),{task:path.basename(job),state:'delivered',release:path.relative(job,release),uses_codex_model:false,finished_at:new Date().toISOString()});
 return {status:'passed_native_dsh_review',directory:release,files:Object.keys(hashes).map(n=>path.join(release,n)),next:'Use cad_view on artifacts/drawing.png and important detail crops, then provide the absolute DXF/PDF links.'};
}
