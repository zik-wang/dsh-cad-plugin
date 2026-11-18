import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath=path.resolve(process.argv[2] || path.join(root,'config.local.json'));
const local=JSON.parse(fs.readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));
const keys=['dshExecutable','python','libreCAD','pythonPackages','credentialFile'];
for(const key of keys){
  if(typeof local[key]!=='string'||!path.isAbsolute(local[key])||!fs.existsSync(local[key]))throw Error(`配置 ${key} 必须是存在的绝对路径`);
  const st=fs.statSync(local[key]);
  if(key==='pythonPackages'?!st.isDirectory():!st.isFile())throw Error(`配置 ${key} 的文件/目录类型不正确`);
}
// Validate all input first, then generate only ignored local machine files.
for(const name of ['original','cost','easy']){
  const folder=path.join(root,'plugins',name),runtime=path.join(folder,'runtime');
  const cfg=JSON.parse(fs.readFileSync(path.join(runtime,'settings.example.json'),'utf8'));
  Object.assign(cfg,Object.fromEntries(keys.map(k=>[k,local[k]])),{stateDirectory:path.join(folder,'state','reviewer-jobs')});
  fs.writeFileSync(path.join(runtime,'settings.json'),JSON.stringify(cfg,null,2)+'\n');
  const pkg=JSON.parse(fs.readFileSync(path.join(folder,'package.json'),'utf8'));
  const url=pathToFileURL(path.join(folder,pkg.main)).href;
  fs.writeFileSync(path.join(folder,'cordis.patch.yml'),`- insert:\n    - id: desktop-cad-${name}-tools\n      name: '${url}'\n`);
  console.log(`${name}: link:${folder}`);
}
console.log('配置完成。DSH 插件库只启用一个 CAD 插件；原版的旧内网服务仍需另行配置。');
