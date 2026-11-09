/* Adds a final build step without replacing bindings, vars, names or migrations. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function install(root){
  const f=path.join(root,'wrangler.toml');
  const src=fs.readFileSync(f,'utf8');
  if(!/^name\s*=\s*"accoutingsuppor02"/m.test(src)||!fs.existsSync(path.join(root,'src/index.js')))throw new Error('Wrong repo: use deal-line-bot');
  const cmd='node scripts/prepare-nakna-performance.mjs';
  if(src.includes(cmd))return false;
  const section=/^\[build\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(src);
  if(!section)throw new Error('No existing [build] command; refusing to replace config');
  const re=/^command\s*=\s*"([^"\n]+)"/m;
  const match=re.exec(section[0]);
  if(!match||!match[1].includes('scripts/prepare-nakna-line-brand.mjs'))throw new Error('Install LINE Rebrand 1.1 first; expected final brand build missing');
  const next=section[0].replace(re,'command = "'+match[1]+' && '+cmd+'"');
  fs.writeFileSync(f,src.slice(0,section.index)+next+src.slice(section.index+section[0].length));
  return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(install(process.cwd())?'PASS performance step appended to existing build':'PASS performance step already installed');}
  catch(e){console.error('FAIL:',e.message);process.exitCode=1;}
}
