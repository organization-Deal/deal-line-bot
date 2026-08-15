import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root=process.cwd();
const oauthFile=path.join(root,"src","oauth.js");
const gmailFile=path.join(root,"src","gmail.js");
const indexFile=path.join(root,"src","index.js");
const MARK="PRODUCTION_GOOGLE_AUTH_GUARD_V7_51_20260815";

for(const file of [oauthFile,gmailFile,indexFile]){
  if(!fs.existsSync(file)) throw new Error(`ไม่พบ ${path.relative(root,file)}`);
}
function syntax(file){execFileSync(process.execPath,["--check",file],{stdio:"inherit"});}
function mustReplace(text,from,to,label){
  if(!text.includes(from)) throw new Error(`หา anchor ไม่เจอ: ${label}`);
  return text.replace(from,to);
}

let oauth=fs.readFileSync(oauthFile,"utf8");
if(!oauth.includes(MARK)){
  oauth=mustReplace(
    oauth,
    'const _utok = {};',
    `const _utok = {};
// ${MARK}
const GOOGLE_AUTH_META_PREFIX="googleauth:meta:";
async function readGoogleAuthMeta(env,key){
  try{return JSON.parse((await env.KV.get(GOOGLE_AUTH_META_PREFIX+key))||"{}");}catch{return {};}
}
async function writeGoogleAuthMeta(env,key,patch={}){
  const current=await readGoogleAuthMeta(env,key);
  const next={...current,...patch,updatedAt:new Date().toISOString()};
  await env.KV.put(GOOGLE_AUTH_META_PREFIX+key,JSON.stringify(next));
  return next;
}
function classifyGoogleRefreshError(detail="",status=0){
  const raw=String(detail||"");
  if(/invalid_grant|expired|revoked/i.test(raw))return "invalid_grant";
  if(/admin_policy_enforced/i.test(raw))return "admin_policy_enforced";
  if(/invalid_client|unauthorized_client/i.test(raw))return "oauth_client_error";
  if(status>=500)return "google_unavailable";
  return "refresh_failed";
}
export async function getGoogleConnectionStatus(env,key,{validate=false}={}){
  const refresh=await env.KV.get(\`gtoken:\${key}\`);
  let meta=await readGoogleAuthMeta(env,key);
  let token=null;
  if(validate&&refresh&&meta.reconnectRequired!==true){
    token=await getUserToken(env,key).catch(()=>null);
    meta=await readGoogleAuthMeta(env,key);
  }
  const everConnected=meta.everConnected===true||!!meta.connectedAt||!!refresh;
  const reconnectRequired=meta.reconnectRequired===true||(!refresh&&everConnected);
  return {
    ok:true,
    connected:validate ? !!token&&!reconnectRequired : !!refresh&&!reconnectRequired,
    reconnectRequired,
    everConnected,
    reason:reconnectRequired?(meta.reason||"reconnect_required"):(!refresh?"never_connected":"connected"),
    detail:String(meta.detail||"").slice(0,240),
    connectedAt:meta.connectedAt||"",
    lastValidatedAt:meta.lastValidatedAt||"",
  };
}`,
    "oauth meta insertion"
  );

  const start=oauth.indexOf("export async function getUserToken(env, key) {");
  const end=oauth.indexOf("\nexport async function createUserSheet",start);
  if(start<0||end<0)throw new Error("หา getUserToken ไม่เจอ");
  const replacement=`export async function getUserToken(env, key) {
  const now=Date.now();
  const c=_utok[key];
  if(c&&c.exp-60000>now)return c.token;

  const refresh=await env.KV.get(\`gtoken:\${key}\`);
  if(!refresh){
    delete _utok[key];
    const prev=await readGoogleAuthMeta(env,key);
    const wasConnected=prev.everConnected===true||!!prev.connectedAt;
    await writeGoogleAuthMeta(env,key,{
      connected:false,reconnectRequired:wasConnected,everConnected:wasConnected,
      reason:wasConnected?"missing_refresh_token":"never_connected",detail:"",
      lastValidatedAt:new Date().toISOString(),
    });
    return null;
  }

  let res;
  try{
    res=await fetch("https://oauth2.googleapis.com/token",{
      method:"POST",
      headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({
        client_id:env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret:env.GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token:refresh,
        grant_type:"refresh_token",
      }),
    });
  }catch(error){
    delete _utok[key];
    await writeGoogleAuthMeta(env,key,{
      connected:false,reconnectRequired:false,everConnected:true,
      reason:"google_unavailable",detail:String(error?.message||error).slice(0,240),
      lastValidatedAt:new Date().toISOString(),
    });
    return null;
  }

  if(!res.ok){
    const detail=(await res.text()).slice(0,500);
    const reason=classifyGoogleRefreshError(detail,res.status);
    const reconnectRequired=["invalid_grant","admin_policy_enforced","oauth_client_error"].includes(reason);
    delete _utok[key];
    console.error(\`[google-auth] refresh failed tenant=\${key} status=\${res.status} reason=\${reason} \${detail.slice(0,180)}\`);
    await writeGoogleAuthMeta(env,key,{
      connected:false,reconnectRequired,everConnected:true,reason,
      detail:detail.slice(0,240),lastValidatedAt:new Date().toISOString(),
    });
    return null;
  }

  const j=await res.json();
  _utok[key]={token:j.access_token,exp:now+(Number(j.expires_in)||3600)*1000};
  await writeGoogleAuthMeta(env,key,{
    connected:true,reconnectRequired:false,everConnected:true,reason:"connected",detail:"",
    lastValidatedAt:new Date().toISOString(),
  });
  return j.access_token;
}
`;
  oauth=oauth.slice(0,start)+replacement+oauth.slice(end);

  oauth=mustReplace(
    oauth,
    '  if (refreshToken) await env.KV.put(`gtoken:${state}`, refreshToken);',
    `  if (refreshToken) await env.KV.put(\`gtoken:\${state}\`, refreshToken);
  _utok[state]={token:tok.access_token,exp:Date.now()+(Number(tok.expires_in)||3600)*1000};
  await writeGoogleAuthMeta(env,state,{
    connected:true,reconnectRequired:false,everConnected:true,reason:"connected",detail:"",
    connectedAt:new Date().toISOString(),lastValidatedAt:new Date().toISOString(),
  });`,
    "oauth callback cache reset"
  );

  oauth=mustReplace(
    oauth,
    '  const setupComplete = settingsReady(settings);',
    `  if(sheetId&&String(settings?.company_name||"").trim()){
    const metaKey=\`businessmeta:v1:\${state}\`;
    let currentMeta={};
    try{currentMeta=JSON.parse((await env.KV.get(metaKey))||"{}");}catch{}
    await env.KV.put(metaKey,JSON.stringify({
      ...currentMeta,tenant:state,name:String(settings.company_name).trim(),
      sheetId,updatedAt:new Date().toISOString(),
    }));
  }

  const setupComplete = settingsReady(settings);`,
    "preserve company name"
  );
}
fs.writeFileSync(oauthFile,oauth);
syntax(oauthFile);

let gmail=fs.readFileSync(gmailFile,"utf8");
if(!gmail.includes("GMAIL_SEPARATE_OAUTH_CLIENT_V7_51")){
  gmail=gmail.replace(
    'const API = "https://gmail.googleapis.com/gmail/v1/users/me";',
    `const API = "https://gmail.googleapis.com/gmail/v1/users/me";
// GMAIL_SEPARATE_OAUTH_CLIENT_V7_51
function gmailClientId(env){return env.GMAIL_OAUTH_CLIENT_ID||env.GOOGLE_OAUTH_CLIENT_ID;}
function gmailClientSecret(env){return env.GMAIL_OAUTH_CLIENT_SECRET||env.GOOGLE_OAUTH_CLIENT_SECRET;}`
  );
  gmail=gmail.replaceAll("env.GOOGLE_OAUTH_CLIENT_ID","gmailClientId(env)");
  gmail=gmail.replaceAll("env.GOOGLE_OAUTH_CLIENT_SECRET","gmailClientSecret(env)");
  gmail=gmail.replace(
    "function gmailClientId(env){return env.GMAIL_OAUTH_CLIENT_ID||gmailClientId(env);}",
    "function gmailClientId(env){return env.GMAIL_OAUTH_CLIENT_ID||env.GOOGLE_OAUTH_CLIENT_ID;}"
  );
  gmail=gmail.replace(
    "function gmailClientSecret(env){return env.GMAIL_OAUTH_CLIENT_SECRET||gmailClientSecret(env);}",
    "function gmailClientSecret(env){return env.GMAIL_OAUTH_CLIENT_SECRET||env.GOOGLE_OAUTH_CLIENT_SECRET;}"
  );
}
fs.writeFileSync(gmailFile,gmail);
syntax(gmailFile);

let index=fs.readFileSync(indexFile,"utf8");
if(!index.includes(MARK)){
  index=mustReplace(
    index,
    'import { buildConnectUrl, handleCallback, getUserToken, createUserSheet } from "./oauth.js";',
    'import { buildConnectUrl, handleCallback, getUserToken, getGoogleConnectionStatus, createUserSheet } from "./oauth.js";',
    "oauth import"
  );

  const tokenAnchor='        const token = await getUserToken(env, key);';
  index=mustReplace(
    index,
    tokenAnchor,
    `${tokenAnchor}

        // ${MARK}
        if(url.pathname==="/api/google-status"){
          return cors(json(await getGoogleConnectionStatus(env,key,{validate:true})));
        }
        const googleOptionalEndpoints=new Set([
          "/api/businesses","/api/gmail-status","/api/accounting/whoami"
        ]);
        if(!token&&!googleOptionalEndpoints.has(url.pathname)){
          const google=await getGoogleConnectionStatus(env,key,{validate:false});
          return cors(json({
            ok:false,
            error:"google_reconnect_required",
            message:"Google Sheet / Drive ของธุรกิจนี้ต้องเชื่อมใหม่ ข้อมูลเดิมยังอยู่และระบบจะไม่แสดงเป็นศูนย์",
            google,
          },401));
        }`,
    "API google auth guard"
  );

  const businessesAnchor='          const info=await listBusinessWorkspaces(env,key);';
  index=mustReplace(
    index,
    businessesAnchor,
    `${businessesAnchor}
          const google=await getGoogleConnectionStatus(env,key,{validate:false});`,
    "businesses google status"
  );
  index=index.replace(
    'return cors(json({...info,businesses:current?',
    'return cors(json({...info,google,businesses:current?'
  );
  index=index.replace(
    '          return cors(json(info));\n        }\n\n        if (url.pathname === "/api/businesses/invite"',
    '          return cors(json({...info,google}));\n        }\n\n        if (url.pathname === "/api/businesses/invite"'
  );

  index=mustReplace(
    index,
    '            const saved = await writeSettings(env, sheetId, b, token);',
    `            const saved = await writeSettings(env, sheetId, b, token);
            if(String(saved?.company_name||"").trim()){
              await saveBusinessMeta(env,key,{name:String(saved.company_name).trim(),sheetId});
            }`,
    "settings name persistence"
  );
}
fs.writeFileSync(indexFile,index);
syntax(indexFile);

console.log("✅ "+MARK+" ready");
console.log("✅ exact /api/google-status enabled");
console.log("✅ dead Google OAuth now returns google_reconnect_required instead of silent fallback");
console.log("✅ OAuth callback clears stale access-token cache");
console.log("✅ Gmail can use GMAIL_OAUTH_CLIENT_ID/SECRET separately when configured");
