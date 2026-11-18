import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawn,execFileSync} from 'node:child_process';
const folder=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(folder,'./runtime'),cfg=JSON.parse(fs.readFileSync(path.join(root,'settings.json'))),state=path.join(folder,'state'),profile=path.join(state,'profiles/desktop');
fs.mkdirSync(profile,{recursive:true});const owner=path.join(state,'desktop-owner.json');
if(fs.existsSync(owner)){const old=JSON.parse(fs.readFileSync(owner));try{process.kill(old.pid,0);if(Number.isSafeInteger(old.pid))try{execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command','[void](New-Object -ComObject WScript.Shell).AppActivate('+old.pid+')'],{windowsHide:true,stdio:'ignore'});}catch{}console.log('CAD DSH desktop is already open: '+old.pid);process.exit(0);}catch(e){if(e.code!=='ESRCH')throw e;}}
const secret=cfg.credentialFile||path.resolve(root,'../../work/private/deepseek.dpapi');
const command="$s=Get-Content -LiteralPath '"+secret.replaceAll("'","''")+"' | ConvertTo-SecureString; [Console]::Write([System.Net.NetworkCredential]::new('', $s).Password)";
const key=execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,env:{...process.env,PSModulePath:'C:/Windows/System32/WindowsPowerShell/v1.0/Modules'}}).trim();if(!key)throw Error('Missing protected DeepSeek credential');
const profileManifestPath=path.join(profile,'package.json');
const priorManifest=fs.existsSync(profileManifestPath)?JSON.parse(fs.readFileSync(profileManifestPath,'utf8')):{};
const installedCad=Object.hasOwn(priorManifest.dependencies||{},'@local/dsh-cad-workflow');
let basic=fs.readFileSync(path.join(root,'patch.yml'),'utf8').replace('__PLUGIN__',new URL('./plugin.mjs',import.meta.url).href).replace('id: independent-cad-tools','id: desktop-cad-tools');
if(installedCad)basic=basic.replace(/- insert:\r?\n    - id: desktop-cad-tools\r?\n      name: [^\r\n]+\r?\n?/,'');
const extras='\n- id: attachment-local\n  config:\n    maxImageBytes: 31457280\n    maxImagePixels: 64000000\n    maxImageDimension: 16000\n    normalizedImageMaxPixels: 64000000\n    normalizedImageMaxDimension: 16000\n    normalizedImageMaxBytes: 31457280\n- id: ui-settings-account\n  config:\n    version: 1\n    step: done\n    purpose: both\n    process: detailed\n    completion: completed\n    usage: detailed\n    developerTools: true\n- id: ui-chat\n  config:\n    transcriptView: detailed\n    performanceUsage: detailed\n';
fs.writeFileSync(profileManifestPath,JSON.stringify({...priorManifest,name:'dsh-cad-desktop-profile',private:true,dependencies:priorManifest.dependencies||{},dsh:{...priorManifest.dsh,profile:{...priorManifest.dsh?.profile,bundles:[...new Set(['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app',...(priorManifest.dsh?.profile?.bundles||[])])]}}},null,2));
fs.writeFileSync(path.join(profile,'cordis.yml'),'[]\n');fs.writeFileSync(path.join(profile,'cordis.patch.yml'),basic+'\n'+fs.readFileSync(path.join(root,'desktop.patch.yml'),'utf8')+extras);
const env={...process.env,DSH_HOME:state,DEEPSEEK_API_KEY:key};delete env.ELECTRON_RUN_AS_NODE;
const debugPort=cfg.desktopDebugPort||9231;
const child=spawn(cfg.dshExecutable,['--remote-debugging-port='+debugPort,'--remote-debugging-address=127.0.0.1','--user-data-dir='+path.join(state,'electron')],{cwd:folder,env,detached:true,stdio:'ignore',windowsHide:false});
fs.writeFileSync(owner,JSON.stringify({pid:child.pid,started_at:new Date().toISOString(),debug_port:debugPort}));child.unref();console.log('Native DSH CAD desktop opened. Upload images in the chat.');
