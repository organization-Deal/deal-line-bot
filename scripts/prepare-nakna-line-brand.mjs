import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
export function patchLineSender(source,label){
  const importLine='import { naknaAccountingMessages } from "./nakna-line-theme.js";';
  const raw=/Array\.isArray\(messages\)\s*\?\s*messages\s*:\s*\[messages\]/g;
  const count=[...source.matchAll(raw)].length;
  if(!source.includes('https://api.line.me/v2/bot/message/'))throw new Error('Not a LINE sender: '+label);
  if(!count&&!source.includes('messages: naknaAccountingMessages(messages)'))throw new Error('Unknown LINE payload in '+label+'; build stopped');
  let out=source.replace(raw,'naknaAccountingMessages(messages)');
  if(!out.includes(importLine))out=importLine+'\n'+out;
  return {out,count};
}
export function prepare(root){
  const plan=[];
  for(const file of ['src/line.js','src/oauth.js']){
    const full=path.join(root,file);
    if(!fs.existsSync(full))throw new Error('Wrong repo or missing '+file+' — only deal-line-bot');
    const result=patchLineSender(fs.readFileSync(full,'utf8'),file);plan.push({full,...result});
  }
  const theme=path.join(root,'branding/nakna-line-theme.mjs');
  if(!fs.existsSync(theme))throw new Error('Missing theme source');
  execFileSync(process.execPath,['--check',theme],{stdio:'pipe'});
  // Copy after legacy navy build scripts have completed; no monkey-patching global fetch.
  fs.writeFileSync(path.join(root,'src/nakna-line-theme.js'),fs.readFileSync(theme));
  for(const item of plan)fs.writeFileSync(item.full,item.out);
  for(const item of plan)execFileSync(process.execPath,['--check',item.full],{stdio:'pipe'});
  return plan.length;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const n=prepare(process.cwd());console.log('PASS NAKNA-ACCOUNTING-LINE-1.1.0');console.log('PASS '+n+' LINE send paths use final Nakna Flex theme; actions/auth untouched');}
  catch(e){console.error('FAIL Nakna LINE:',e.message);process.exitCode=1;}
}
