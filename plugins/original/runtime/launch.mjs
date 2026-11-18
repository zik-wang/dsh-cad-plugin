import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawn,execFileSync} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
const settings=JSON.parse(fs.readFileSync(path.join(root,'settings.json'),'utf8'));
const argv=process.argv.slice(2),id=argv.shift();if(!/^[a-zA-Z0-9_-]+$/.test(id||''))throw Error('Task id required');
const job=path.join(root,'jobs',id);if(!fs.existsSync(path.join(job,'input.json')))throw Error('Unknown task');
const desktop=argv[0]==='--desktop';
const ownerFile=path.join(job,'.host','runtime-owner.json');fs.mkdirSync(path.dirname(ownerFile),{recursive:true});
if(fs.existsSync(ownerFile)){
 const owner=JSON.parse(fs.readFileSync(ownerFile,'utf8'));let alive=true;
 try{process.kill(owner.pid,0)}catch(e){if(e.code==='ESRCH')alive=false;}
 if(alive){console.error('This task already has a DSH '+owner.mode+' runtime (PID '+owner.pid+'). Use its existing window/session; concurrent hosts are refused.');process.exit(desktop&&owner.mode==='desktop'?0:2);}
}
// Each task owns one state directory. The live-process check prevents concurrent hosts;
// a completed batch can later be viewed in the desktop without losing its native history.
const state=settings.stateDirectory?path.join(settings.stateDirectory,id):path.resolve(root,id==='source1'?'../../work/dsh-independent-state':'../../work/dsh-independent-batch-state/'+id);fs.mkdirSync(state,{recursive:true});
const secret=settings.credentialFile||path.resolve(root,'../../work/private/deepseek.dpapi');
const command="$s=Get-Content -LiteralPath '"+secret.replaceAll("'","''")+"' | ConvertTo-SecureString; [Console]::Write([System.Net.NetworkCredential]::new('', $s).Password)";
const key=execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,env:{...process.env,PSModulePath:'C:/Windows/System32/WindowsPowerShell/v1.0/Modules'}}).trim();
if(!key)throw Error('Missing API credential');
const overlay=path.join(state,id+'.patch.yml');fs.writeFileSync(overlay,fs.readFileSync(path.join(root,'patch.yml'),'utf8').replace('__PLUGIN__',new URL('./tools.mjs',import.meta.url).href));
const env={...process.env,DSH_HOME:state,ELECTRON_RUN_AS_NODE:'1',DEEPSEEK_API_KEY:key,INDEPENDENT_CAD_JOB:job,INDEPENDENT_CAD_ROOT:root};
if(argv[0]==='--desktop'){
 const profile=path.join(state,'profiles','desktop');fs.mkdirSync(profile,{recursive:true});
 fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({name:'dsh-independent-desktop',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}},null,2));
 fs.writeFileSync(path.join(profile,'cordis.yml'),'[]\n');fs.writeFileSync(path.join(profile,'cordis.patch.yml'),fs.readFileSync(overlay,'utf8')+'\n'+fs.readFileSync(path.join(root,'desktop.patch.yml'),'utf8'));
 delete env.ELECTRON_RUN_AS_NODE;
 const app=spawn(settings.dshExecutable,['--remote-debugging-port='+(id==='source1'?'9229':'0'),'--remote-debugging-address=127.0.0.1','--user-data-dir='+path.join(state,'electron')],{cwd:job,env,windowsHide:false,detached:true,stdio:'ignore'});
 fs.writeFileSync(ownerFile,JSON.stringify({pid:app.pid,mode:'desktop',started_at:new Date().toISOString()}));
 app.unref();console.log('Independent DSH desktop started for '+id);process.exit(0);
}
const cli=path.join(path.dirname(settings.dshExecutable),'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
const child=spawn(settings.dshExecutable,['--expose-internals',cli,'headless','--patch',overlay,...argv],{cwd:job,env,windowsHide:true,stdio:'inherit'});
fs.writeFileSync(ownerFile,JSON.stringify({pid:child.pid,launcher_pid:process.pid,mode:'headless',started_at:new Date().toISOString()}));
child.on('error',e=>{console.error(e.message);process.exitCode=1});child.on('exit',c=>{if(fs.existsSync(ownerFile)&&JSON.parse(fs.readFileSync(ownerFile,'utf8')).pid===child.pid)fs.unlinkSync(ownerFile);process.exitCode=c||0});
