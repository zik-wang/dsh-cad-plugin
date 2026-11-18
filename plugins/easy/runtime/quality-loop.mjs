import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
function run(args,job,logName,parseEvents=false){return new Promise((resolve,reject)=>{
 const log=fs.createWriteStream(path.join(job,logName),{flags:'a'});const p=spawn(process.execPath,args,{cwd:job,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',pending='';
 p.stdout.on('data',b=>{if(!parseEvents)out+=b;pending+=b;let n;while((n=pending.indexOf('\n'))>=0){const s=pending.slice(0,n);pending=pending.slice(n+1);if(parseEvents){try{const e=JSON.parse(s);if(!['thinking','reasoning'].includes(e.type)){log.write(JSON.stringify(e)+'\n');if(e.type==='tool_call')console.log('DSH revision tool: '+e.tool);}}catch{}}else log.write(s+'\n');}});
 p.stderr.on('data',b=>{log.write(b);process.stderr.write(b)});p.on('error',reject);p.on('exit',code=>{log.end();resolve({code,stdout:out})});
 });}
export async function qualityLoop(id){
 if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('Task id required');const job=path.join(root,'jobs',id),statusFile=path.join(job,'quality-status.json');
 const status={task:id,policy:'DSH drafts and revises; an independent DeepSeek API call reviews. Reviewer opinions must be checked against source.',rounds:[],state:'reviewing',uses_codex_model:false};
 const save=()=>fs.writeFileSync(statusFile,JSON.stringify(status,null,2));save();
 try{
 const nativeSession=()=>fs.readFileSync(path.join(job,'.host/events.jsonl'),'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s)).filter(e=>e.type==='model'&&e.session).at(-1)?.session;
 for(let attempt=0;attempt<2&&!fs.existsSync(path.join(job,'artifacts/drawing.png'));attempt++){
  const session=nativeSession();if(!session)throw Error('No native DSH session to continue');
  status.state='continuing_incomplete_draft';save();
  const prompt='继续当前图片转CAD任务。上一轮尚未产出完整图纸，不算完成。请先把已有读图的明确值、推导与不确定项写入agent/尺寸记录，随后立即分几个较小的cad_write调用写出可运行建模程序及整张图第一版。复用已有裁切，不再为一个模糊局部无限重复分析。不能确认的项写清楚，不猜值、不修改原图明确比例。直接依据原图，然后实际生成model_1to1.dxf、drawing.dxf及PDF/预览。优先完成实际文件，再看预览修订。';
  const draft=await run([path.join(root,'launch.mjs'),id,'--session-id',session,'--json',prompt],job,'dsh-draft-continuations.jsonl',true);status.draft_continuations=(status.draft_continuations||[]).concat({attempt,exit_code:draft.code});save();
 }
 if(!fs.existsSync(path.join(job,'artifacts/drawing.png')))throw Error('DSH has not produced a complete first drawing after bounded continuations');
 status.state='reviewing';save();
 for(let round=0;round<3;round++){
  const r=await run([path.join(root,'review-job.mjs'),id],job,'review-loop.log');if(r.code!==0)throw Error('Review process failed: '+r.code);
  const parsed=JSON.parse(r.stdout),report=JSON.parse(fs.readFileSync(parsed.report,'utf8'));
  status.rounds.push({round,report:path.relative(job,parsed.report),verdict:parsed.verdict,dxf_sha256:report.dxf_sha256});save();
  if(parsed.verdict==='no_obvious_issue'){status.state='no_obvious_issue';status.meaning='Automated visual review found no obvious issue; source ambiguity and manufacturing approval remain separate.';break;}
  if(round===2){status.state='needs_manual_review';break;}
  const session=nativeSession();if(!session)throw Error('No native DSH session to resume');
  const criteria=fs.readFileSync(path.join(root,'QUALITY_RULES.txt'),'utf8');
  const prompt='请继续修订你自己绘制的图纸。另一轮独立DeepSeek复核意见保存在 '+path.relative(job,parsed.report).replaceAll('\\','/')+'，请cad_read读取。这是模型意见而非原图标准，其中可能含误读；必须重看原图验证每项，不能盲目采用它给出的数值或删掉原图已有元素。请自己修改代码、重建DXF、重导出PDF和LibreCAD预览，并实际查看。保留未能确认的问题。通用验收规则：\n'+criteria;
  const revision=await run([path.join(root,'launch.mjs'),id,'--session-id',session,'--json',prompt],job,'dsh-revisions.jsonl',true);if(revision.code!==0)throw Error('DSH revision stopped: '+revision.code);
 }
 }catch(e){status.state='review_failed';status.error=e.message;}
 status.finished_at=new Date().toISOString();save();console.log('Quality result: '+status.state);return status;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await qualityLoop(process.argv[2]);
