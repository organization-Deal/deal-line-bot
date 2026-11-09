import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {patchBackend,patchOAuth,MARK,prepare} from '../scripts/prepare-nakna-performance.mjs';
import {install} from '../scripts/install-nakna-performance.mjs';
// Data URL avoids dependence on the repository's package.json type in this harness.
const {buildNaknaPlanSummary}=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(new URL('../src/nakna-plan-summary.js',import.meta.url))).toString('base64'));
const plans={free:{name:'ฟรี',businessLimit:1},business:{name:'Business',businessLimit:2},pro:{name:'Pro',businessLimit:1}};
const fixedNow=Date.parse('2026-11-09T12:00:00Z');
function backendFixture(){return `const BUSINESS_ACCOUNT_SCHEMA="schema";
function businessAccountKey(k){return "account:"+k;}
function accountRootMapKey(k){return "root:"+k;}
async function getAccountRoot(env,k){return await env.KV.get("root:"+k)||k;}
async function ensureBusinessAccount(env, tenant) {
  await Promise.all([env.KV.put('unused','unused')]);return {};
}
async function getSubscriptionRecord(env,k){return env.record;}
async function buildSubscriptionUsageDetailV784(){throw Error('full-detail');}
async function handler(env,url,request) {
  const key=url.searchParams.get('tenant');
  const access=await env.authorize(key,url.searchParams.get('k'));
  if(!access.ok)return {status:401};
  if(!accessCan(access,url.pathname,request.method))return {status:403};
  const noCoreGoogleRequired=new Set([]);
  const needsCoreGoogle=!noCoreGoogleRequired.has(url.pathname);
  const token=needsCoreGoogle?await env.google():null;
        if (url.pathname === "/api/subscription") {
          return {full:true,token};
        }
}
`;}
function evaluate(src,extra={}){const c={console,Date,Map,WeakMap,Set,Promise,...extra};vm.createContext(c);vm.runInContext(src.replace(/^import .*;\n/gm,'').replace(/export /g,''),c);return c;}
test('summary free plan derives real plan, with no usage/permission flags',()=>{const x=buildNaknaPlanSummary({status:'free'},plans,fixedNow);assert.equal(x.planName,'ฟรี');for(const key of ['usage','blocked','documentBlocked','aiUsage','canAddBusiness'])assert(!(key in x));});
test('active plan summary matches metadata',()=>{assert.equal(buildNaknaPlanSummary({status:'active',plan:'pro'},plans,fixedNow).planName,'Pro');});
test('unexpired trial summary is Business',()=>{const x=buildNaknaPlanSummary({status:'beta',trialEndsAt:'2026-11-10T12:00:00Z'},plans,fixedNow);assert.equal(x.betaActive,true);assert.equal(x.daysRemaining,1);assert.equal(x.effectivePlan,'business');});
test('expired trial is not claimed active',()=>{const x=buildNaknaPlanSummary({status:'beta',trialEndsAt:'2026-11-08'},plans,fixedNow);assert.equal(x.betaActive,false);assert.equal(x.effectivePlan,'free');});
test('invalid plan falls back to server free catalog',()=>{assert.equal(buildNaknaPlanSummary({status:'active',plan:'not-a-plan'},plans,fixedNow).effectivePlan,'free');});
test('unknown metadata fails instead of fabricating plan',()=>assert.throws(()=>buildNaknaPlanSummary(null,plans,fixedNow),/invalid/));
test('patch idempotent',()=>{const x=patchBackend(backendFixture());assert.equal(patchBackend(x),x);assert(x.includes(MARK));});
test('missing expected build fails closed',()=>assert.throws(()=>patchBackend('const unrelated=true;'),/existing bot build/));
test('summary stays behind access control',async()=>{let google=0;const c=evaluate(patchBackend(backendFixture()),{accessCan:()=>true,buildNaknaPlanSummary,SUBSCRIPTION_PLANS:plans,cors:x=>x,json:x=>x});const env={record:{status:'active',plan:'pro'},authorize:async()=>({ok:true}),google:async()=>{google++;throw Error('must not call Google');}};const r=await c.handler(env,new URL('https://t/api/subscription?tenant=a&k=k&view=summary'),{method:'GET'});assert.equal(r.planName,'Pro');assert.equal(google,0);});
test('unauthorized summary cannot read metadata',async()=>{let google=0;const c=evaluate(patchBackend(backendFixture()),{accessCan:()=>true});const r=await c.handler({authorize:async()=>({ok:false}),google:async()=>google++},new URL('https://t/api/subscription?tenant=a&view=summary'),{method:'GET'});assert.equal(r.status,401);assert.equal(google,0);});
test('forbidden role retains 403',async()=>{const c=evaluate(patchBackend(backendFixture()),{accessCan:()=>false});const r=await c.handler({authorize:async()=>({ok:true})},new URL('https://t/api/subscription?tenant=a&view=summary'),{method:'GET'});assert.equal(r.status,403);});
test('normal billing continues through full Google/data branch',async()=>{let google=0;const c=evaluate(patchBackend(backendFixture()),{accessCan:()=>true});const r=await c.handler({authorize:async()=>({ok:true}),google:async()=>{google++;return 'mock-token';}},new URL('https://t/api/subscription?tenant=a&view=full'),{method:'GET'});assert.equal(google,1);assert.equal(r.full,true);});
test('POST never uses read-only summary shortcut',async()=>{let google=0;const c=evaluate(patchBackend(backendFixture()),{accessCan:()=>true});const r=await c.handler({authorize:async()=>({ok:true}),google:async()=>{google++;return 'mock';}},new URL('https://t/api/subscription?tenant=a&view=summary'),{method:'POST'});assert.equal(google,1);assert.equal(r.full,true);});
function registry(data={}){const map=new Map(Object.entries(data));let writes=0;return {env:{KV:{get:async(k,type)=>{const v=map.get(k);return type==='json'&&typeof v==='string'?JSON.parse(v):v||null;},put:async(k,v)=>{writes++;map.set(k,v);}}},map,writes:()=>writes};}
test('healthy registry read performs ZERO writes',async()=>{const r=registry({'account:a':{schema:'schema',rootTenant:'a',businesses:['a','b'],updatedAt:'unchanged'}});const c=evaluate(patchBackend(backendFixture()));const out=await c.ensureBusinessAccount(r.env,'a');assert.equal(r.writes(),0);assert.equal(out.updatedAt,'unchanged');});
test('new registry is created once and second read is read-only',async()=>{const r=registry();const c=evaluate(patchBackend(backendFixture()));await c.ensureBusinessAccount(r.env,'a');const n=r.writes();assert.equal(n,2);await c.ensureBusinessAccount(r.env,'a');assert.equal(r.writes(),n);});
test('registry failure does not overwrite existing account',async()=>{let writes=0;const c=evaluate(patchBackend(backendFixture()));await assert.rejects(c.ensureBusinessAccount({KV:{get:async k=>{if(k.startsWith('root:'))return null;throw Error('kv_unavailable');},put:async()=>writes++}},'a'),/kv_unavailable/);assert.equal(writes,0);});
test('account normalization retains other account fields',async()=>{const r=registry({'account:a':{schema:'old',businesses:['a','a'],custom:'keep'}});const c=evaluate(patchBackend(backendFixture()));const out=await c.ensureBusinessAccount(r.env,'a');assert.equal(out.custom,'keep');assert.equal(out.businesses.length,1);});
const oauth=`export async function getUserToken(env, key) {
  return await env.read(key);
}
`;
test('OAuth patch idempotent',()=>{const x=patchOAuth(oauth);assert.equal(patchOAuth(x),x);});
test('same environment and tenant shares only in-flight OAuth',async()=>{const c=evaluate(patchOAuth(oauth));let n=0,done;const env={read:()=>{n++;return new Promise(r=>done=r);}};const a=c.getUserToken(env,'a'),b=c.getUserToken(env,'a');await Promise.resolve();done('fixture');assert.deepEqual(await Promise.all([a,b]),['fixture','fixture']);assert.equal(n,1);});
test('different tenants never share OAuth result',async()=>{const c=evaluate(patchOAuth(oauth));let n=0;const env={read:async k=>{n++;return k;}};assert.deepEqual(await Promise.all([c.getUserToken(env,'a'),c.getUserToken(env,'b')]),['a','b']);assert.equal(n,2);});
test('different environments never share OAuth result',async()=>{const c=evaluate(patchOAuth(oauth));const a={read:async()=> 'a'},b={read:async()=> 'b'};assert.deepEqual(await Promise.all([c.getUserToken(a,'x'),c.getUserToken(b,'x')]),['a','b']);});
test('OAuth revocation/null not converted to success or cached',async()=>{const c=evaluate(patchOAuth(oauth));let n=0;const env={read:async()=>{n++;return null;}};assert.equal(await c.getUserToken(env,'a'),null);assert.equal(await c.getUserToken(env,'a'),null);assert.equal(n,2);});
test('OAuth failure is retryable and remains a rejection',async()=>{const c=evaluate(patchOAuth(oauth));let n=0;const env={read:async()=>{n++;throw Error('fixture_error');}};await assert.rejects(c.getUserToken(env,'a'),/fixture_error/);await assert.rejects(c.getUserToken(env,'a'),/fixture_error/);assert.equal(n,2);});
test('config installer preserves vars/bindings and is repeatable',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nkperf-'));fs.mkdirSync(path.join(dir,'src'));fs.writeFileSync(path.join(dir,'src/index.js'),'');const tail='\n[vars]\nSHEET_TAB="รายจ่าย"\n[[kv_namespaces]]\nbinding="KV"\nid="fixture-not-production"\n';fs.writeFileSync(path.join(dir,'wrangler.toml'),'name = "accoutingsuppor02"\n[build]\ncommand = "node old.mjs && node scripts/prepare-nakna-line-brand.mjs"\n'+tail);assert.equal(install(dir),true);const s=fs.readFileSync(path.join(dir,'wrangler.toml'),'utf8');assert(s.endsWith(tail));assert.equal(install(dir),false);fs.rmSync(dir,{recursive:true});});
test('wrong repo installer refuses mutation',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nkperf-'));const f=path.join(dir,'wrangler.toml');fs.writeFileSync(f,'name="hr-line"');assert.throws(()=>install(dir),/Wrong repo/);assert.equal(fs.readFileSync(f,'utf8'),'name="hr-line"');fs.rmSync(dir,{recursive:true});});
