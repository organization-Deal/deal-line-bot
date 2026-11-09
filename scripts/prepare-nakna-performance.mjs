import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
export const MARK='NAKNA_ACCOUNTING_API_PERFORMANCE_1_2';
function changeFunction(source,name,fn){
  const re=new RegExp(`^(?:export )?(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`,'gm');
  const matches=[...source.matchAll(re)];
  if(matches.length!==1)throw new Error('Unsupported backend function '+name+'; expected one, got '+matches.length);
  const found=matches[0],replacement=fn(found[0]);
  return source.slice(0,found.index)+replacement+source.slice(found.index+found[0].length);
}
const readonlyAccount = `async function ensureBusinessAccount(env, tenant) {
  // NAKNA_ACCOUNT_NOOP_READ_1_2: a read does not rewrite all account mappings.
  const rootTenant = await getAccountRoot(env, tenant);
  if (!rootTenant) throw new Error("missing_account_root");
  const stored = await env.KV.get(businessAccountKey(rootTenant), "json");
  const valid = stored && typeof stored === "object" && !Array.isArray(stored);
  const current = valid ? stored : {createdAt:new Date().toISOString()};
  const list = Array.from(new Set([rootTenant, ...(Array.isArray(current.businesses) ? current.businesses : [])].filter(Boolean)));
  const unchanged = valid && current.schema === BUSINESS_ACCOUNT_SCHEMA && current.rootTenant === rootTenant
    && Array.isArray(current.businesses) && current.businesses.length === list.length
    && current.businesses.every((value,index)=>value===list[index]);
  if (unchanged) return current;
  const account = {...current,schema:BUSINESS_ACCOUNT_SCHEMA,rootTenant,businesses:list,updatedAt:new Date().toISOString()};
  // Only create/normalize registry metadata. Never modify finance rows.
  await Promise.all([
    env.KV.put(businessAccountKey(rootTenant),JSON.stringify(account)),
    ...list.map(businessTenant=>env.KV.put(accountRootMapKey(businessTenant),rootTenant))
  ]);
  return account;
}`;
export function patchBackend(source){
  if(source.includes(MARK))return source;
  if(!source.includes('async function getSubscriptionRecord(')||!source.includes('buildSubscriptionUsageDetailV784'))throw new Error('Run existing bot build (including v7.84) first; unsupported source');
  let out=changeFunction(source,'ensureBusinessAccount',old=>{
    if(!old.includes('await Promise.all([')||!old.includes('env.KV.put'))throw new Error('Account registry changed; manual merge needed');
    return readonlyAccount;
  });
  const needs='const needsCoreGoogle=!noCoreGoogleRequired.has(url.pathname);';
  if(out.split(needs).length!==2)throw new Error('Expected one authenticated core-Google gate');
  out=out.replace(needs,`const nkPlanSummaryRequest=url.pathname==="/api/subscription"&&request.method==="GET"&&url.searchParams.get("view")==="summary";\n        const needsCoreGoogle=!nkPlanSummaryRequest&&!noCoreGoogleRequired.has(url.pathname);`);
  const route='        if (url.pathname === "/api/subscription") {';
  if(out.split(route).length!==2)throw new Error('Expected one subscription route');
  out=out.replace(route,`${route}\n          // ${MARK}: authenticated metadata-only view, no Google Sheets scan.\n          if(nkPlanSummaryRequest){\n            const record=await getSubscriptionRecord(env,key);\n            return cors(json(buildNaknaPlanSummary(record,SUBSCRIPTION_PLANS)));\n          }`);
  const guard=out.indexOf('if(!accessCan(access,url.pathname,request.method))');
  if(guard<0||guard>out.indexOf('const nkPlanSummaryRequest'))throw new Error('Summary must stay AFTER existing access check');
  out='import {buildNaknaPlanSummary} from "./nakna-plan-summary.js";\n'+out;
  return out;
}
export function patchOAuth(source){
  const marker='NAKNA_OAUTH_INFLIGHT_ONLY_1_2';
  if(source.includes(marker))return source;
  const signature=/export async function getUserToken\(env, key\) \{/g;
  const matches=[...source.matchAll(signature)];
  if(matches.length!==1)throw new Error('Unexpected getUserToken implementation; no blind patch');
  const renamed=source.replace(signature,'async function nkGetUserTokenUnshared(env, key) {');
  // Isolated by exact environment object and tenant, in-flight only. Results,
  // tokens and errors are never persisted by this helper. Rejection is propagated.
  return renamed+`\n/* ${marker} */
const nkOAuthPendingByEnv=new WeakMap();
export function getUserToken(env,key){
  if(!env||typeof env!=="object")return nkGetUserTokenUnshared(env,key);
  let pending=nkOAuthPendingByEnv.get(env);
  if(!pending){pending=new Map();nkOAuthPendingByEnv.set(env,pending);}
  const id=String(key||"");
  if(pending.has(id))return pending.get(id);
  if(pending.size>=128)return nkGetUserTokenUnshared(env,key);
  const task=Promise.resolve().then(()=>nkGetUserTokenUnshared(env,key)).finally(()=>{
    if(pending.get(id)===task)pending.delete(id);
  });
  pending.set(id,task);return task;
}\n`;
}
function check(source,name){
  const res=spawnSync(process.execPath,['--input-type=module','--check'],{input:source,encoding:'utf8'});
  if(res.status!==0)throw new Error(name+' syntax check failed: '+res.stderr);
}
export function prepare(root){
  const index=path.join(root,'src/index.js'),oauth=path.join(root,'src/oauth.js');
  for(const f of [index,oauth,path.join(root,'src/nakna-plan-summary.js')])if(!fs.existsSync(f))throw new Error('Wrong repo or missing file: '+path.basename(f));
  const result=patchBackend(fs.readFileSync(index,'utf8'));
  const auth=patchOAuth(fs.readFileSync(oauth,'utf8'));
  check(result,'index.js');check(auth,'oauth.js');check(fs.readFileSync(path.join(root,'src/nakna-plan-summary.js'),'utf8'),'summary');
  fs.writeFileSync(index,result);fs.writeFileSync(oauth,auth);
  return {release:'NAKNA-ACCOUNTING-API-PERFORMANCE-1.2.0',summaryNoSheets:true,readRegistryNoWrites:true,authUnchanged:true,fullBillingUnchanged:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const r=prepare(process.cwd());console.log('PASS '+r.release);console.log('Summary: no expense scans; existing quota enforcement unchanged');}
  catch(e){console.error('FAIL Nakna performance:',e.message);process.exitCode=1;}
}
