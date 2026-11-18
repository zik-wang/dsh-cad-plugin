import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
export const REQUEST_RESERVE=.12;
export function estimateReserve(session){
 let context=0, recentOutput=0;
 for(let n=session.seq-1;n>=0;n--){const e=session.eventAt(n);if(e?.type==='assistant/message'&&e.data?.usage){const u=e.data.usage;recentOutput=u.outputTokens||0;context=(u.inputTokens||0)+(u.cacheReadTokens||0)+(u.cacheWriteTokens||0)+(u.outputTokens||0);break;}}
 // Reserve all prior input at uncached peak price with growth margin, plus an adaptive output estimate (not an output limit).
 // This is an estimate, NOT a guaranteed provider invoice ceiling.
 return Math.max(.12,(context*1.25+12000)*2/1e6+Math.max(8192,recentOutput*1.5)*8/1e6);
}
export const charge=u=>((u.inputTokens||0)*2+(u.cacheReadTokens||0)*.04+(u.cacheWriteTokens||0)*2+(u.outputTokens||0)*8)/1e6;
export function account(root,policy,mutate){
 const dir=path.join(root,'cost-accounts',policy.lane==='development'?'development':'production');fs.mkdirSync(dir,{recursive:true});
 if(!/^[a-f0-9]{64}$/.test(policy.account))throw Error('Invalid cost account');
 const file=path.join(dir,policy.account+'.json'),lock=file+'.lock';let fd;
 try{fd=fs.openSync(lock,'wx');}catch{throw Error('Cost ledger busy; request refused without spending.');}
 try{let d=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)): {limit:policy.limitCny,spent:0,pending:{},receipts:{},requests:{}};
 const result=mutate(d);const tmp=file+'.'+randomUUID();fs.writeFileSync(tmp,JSON.stringify(d,null,2));fs.renameSync(tmp,file);return result;
 }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
export function reserve(root,policy,session,review=false,scope=session,estimated=REQUEST_RESERVE){return account(root,policy,d=>{
 const key=randomUUID();const spent=d.spent+Object.values(d.pending).reduce((s,p)=>s+p.amount,0);
 if(review&&(d.requests[scope]||0)>=24)throw Error('CAD request count limit reached; work retained. Review must submit evidenced failures early.');
 if(!Number.isFinite(estimated)||estimated<=0)throw Error('Invalid reservation estimate');
 if(spent+estimated>d.limit+1e-9)throw Error(`本对话预算检查：已记账 ${d.spent.toFixed(4)} 元，进行中预留 ${(spent-d.spent).toFixed(4)} 元，本次预计预留 ${estimated.toFixed(4)} 元，剩余 ${Math.max(0,d.limit-spent).toFixed(4)} 元，上限 ${d.limit} 元。${d.spent>=d.limit?'累计记账已达上限':'余额不足以覆盖本次预计请求，并非已经花完预算'}。同一对话继续不重置，新对话独立记账。`);
 if(Object.values(d.pending).some(p=>p.session===session))throw Error('Previous request has no settled usage; refusing automatic retry to avoid unknown charges.');
 d.pending[key]={session,amount:estimated,time:new Date().toISOString()};d.requests[scope]=(d.requests[scope]||0)+1;return key;
});}
export function settle(root,policy,session,event){if(event.type!=='assistant/message'||!event.data?.usage)return;
 return account(root,policy,d=>{const id=session+':'+event.seq;if(d.receipts[id])return;
 const pending=Object.keys(d.pending).find(k=>d.pending[k].session===session);if(!pending)return;
 const amount=charge(event.data.usage);d.spent+=amount;d.receipts[id]={amount,usage:event.data.usage,time:event.time};delete d.pending[pending];});
}

export function recoverHistory(root,policy,session,events){return account(root,policy,d=>{
 d.provisional??={};let recovered=0,estimated=0;
 const time=e=>new Date(e.time).getTime();
 const messages=events.filter(e=>e.type==='assistant/message'&&e.data?.usage);
 const record=e=>{const id=session+':'+e.seq;if(d.receipts[id])return false;const amount=charge(e.data.usage);d.spent+=amount;d.receipts[id]={amount,usage:e.data.usage,time:e.time,recovered:true};recovered++;return true;};
 // Only close reservations backed by a recorded terminal turn. Never release a live request.
 for(const [key,p] of Object.entries(d.pending)){if(p.session!==session)continue;
  const start=new Date(p.time).getTime(),end=events.find(e=>e.type==='turn/end'&&time(e)>=start);
  const response=messages.find(e=>time(e)>=start&&(!end||time(e)<=time(end)));if(!response&&!end)continue;
  if(response)record(response);else{d.spent+=p.amount;d.provisional[key]={session,amount:p.amount,start,end:time(end),terminal_seq:end.seq,reason:end.data?.reason,status:'estimated_not_provider_charge'};estimated++;}
  delete d.pending[key];
 }
 // A later recovery can replace an estimate with the original response receipt.
 for(const [key,p] of Object.entries(d.provisional)){if(p.session!==session||p.status!=='estimated_not_provider_charge')continue;
  const response=messages.find(e=>time(e)>=p.start&&time(e)<=p.end);if(response){d.spent-=p.amount;record(response);p.status='reconciled';p.receipt=session+':'+response.seq;}
 }
 // Recover usage after accounting began, including completions while a plugin was reloaded.
 const seqs=Object.keys(d.receipts).filter(k=>k.startsWith(session+':')).map(k=>Number(k.slice(session.length+1)));
 if(seqs.length){const first=Math.min(...seqs);for(const e of messages)if(e.seq>=first)record(e);}
 return {recovered,estimated,spent:d.spent,pending:Object.keys(d.pending).length,provisional_cny:Object.values(d.provisional).filter(p=>p.status==='estimated_not_provider_charge').reduce((s,p)=>s+p.amount,0)};
});}

export function installCostControl(ctx,root,job,input){
 const parent=input.kind==='cad_review'?JSON.parse(fs.readFileSync(path.join(root,'jobs',input.review_of,'input.json'))):input;
 const policy=parent.costPolicy;if(!policy?.enabled)return {enabled:false};
 const cursors=new WeakMap();
 function sync(session){if(!session)return;const history=()=>session.snapshotEvents?session.snapshotEvents():Array.from({length:session.seq},(_,i)=>session.eventAt(i));if(!cursors.has(session))recoverHistory(root,policy,session.id,history());let n=cursors.get(session)??session.seq;let ended=false;while(n<session.seq){const e=session.eventAt(n++);settle(root,policy,session.id,e);if(e.type==='turn/end')ended=true;}if(ended)recoverHistory(root,policy,session.id,history());cursors.set(session,n);}
 ctx.on('session/event',session=>{if(cursors.has(session))sync(session);});
 ctx.on('agent/request',async(e,next)=>{const p=await next();const s=e.agent?.session;if(!s)throw Error('Missing session for cost accounting');sync(s);reserve(root,policy,s.id,input.kind==='cad_review',input.kind==='cad_review'?path.basename(job):'author',estimateReserve(s));const {maxTokens:_pluginLegacyOutputLimit,...providerDefaults}=p;return providerDefaults;});
 return {enabled:true,policy};
}
