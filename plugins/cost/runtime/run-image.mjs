import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {autonomousLoop} from './autonomous-loop.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const source=path.resolve(process.argv[2]||'');
if(!fs.existsSync(source)||!fs.statSync(source).isFile()||!['.png','.jpg','.jpeg','.webp'].includes(path.extname(source).toLowerCase())){
 console.error('Usage: node run-image.mjs <drawing-image.png|jpg|webp>');process.exit(2);
}
const id=new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)+'-'+randomUUID().slice(0,8);
const job=path.join(root,'jobs',id);fs.mkdirSync(path.join(job,'agent'),{recursive:true});fs.mkdirSync(path.join(job,'artifacts'));
const bytes=fs.readFileSync(source),name='source'+path.extname(source).toLowerCase();fs.writeFileSync(path.join(job,name),bytes);
fs.writeFileSync(path.join(job,'input.json'),JSON.stringify({source:name,sha256:createHash('sha256').update(bytes).digest('hex'),task:'根据唯一提供的源图片自主完成可用CAD图纸，输出可编辑DXF、1:1几何DXF、PDF，并保留你自己编写的Python建模代码。'},null,2));
console.log('DSH independent task: '+id+'\nOutput: '+job);
const child=spawn(process.execPath,[path.join(root,'launch.mjs'),id,'--json','请先用cad_info读取任务，只从提供的源图片开始，独立读图、整理尺寸、编写和运行建模Python代码。请实际完成第一版DXF/PDF，查看预览后修正；完成后由独立原生DSH会话核对原图与候选。没有现成零件配方。'],{cwd:job,windowsHide:true,stdio:['ignore','pipe','pipe']});
const eventLog=fs.createWriteStream(path.join(job,'dsh-events.jsonl'));const errLog=fs.createWriteStream(path.join(job,'dsh-stderr.log'));let pending='';
// Retain execution evidence but do not copy model reasoning streams to the deliverable.
child.stdout.on('data',b=>{pending+=b.toString();let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);try{const e=JSON.parse(line);if(e.type!=='thinking'&&e.type!=='reasoning'){eventLog.write(JSON.stringify(e)+'\n');if(e.type==='tool_call')console.log('DSH tool: '+e.tool);if(e.type==='error')console.error(JSON.stringify(e));}}catch{}}});
child.stderr.on('data',b=>{errLog.write(b);process.stderr.write(b)});
child.on('error',e=>{console.error(e.message);eventLog.end();errLog.end();process.exitCode=1});
child.on('exit',async code=>{eventLog.end();errLog.end();console.log('DSH stopped with code '+code+'. File generation is not a manufacturing approval.');process.exitCode=code||0;const logPath=path.join(job,'dsh-events.jsonl');const exhausted=fs.existsSync(logPath)&&fs.readFileSync(logPath,'utf8').includes('"kind":"max-tokens"');if(code===0||exhausted){const s=await autonomousLoop(id);process.exitCode=s.state==='delivered'?0:3;}});
