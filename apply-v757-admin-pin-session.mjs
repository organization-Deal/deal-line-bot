import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const file=path.join(process.cwd(),"src","admin-ops.js");
const MARK="ADMIN_PIN_SESSION_V7_57_20260816";
if(!fs.existsSync(file))throw new Error("ไม่พบ src/admin-ops.js");
let src=fs.readFileSync(file,"utf8");

if(src.includes(MARK)){
  console.log("ℹ️ "+MARK+" already present");
  process.exit(0);
}

const adminAnchor='function adminOk(env, url) { return !!env.ADMIN_KEY && clean(url.searchParams.get("key"), 300) === clean(env.ADMIN_KEY, 300); }';
if(!src.includes(adminAnchor))throw new Error("หา adminOk anchor ไม่เจอ");

const helpers=`${adminAnchor}

// ${MARK}
const ADMIN_SESSION_TTL = 60 * 60 * 8;
const ADMIN_PIN_WINDOW = 60 * 15;
const ADMIN_PIN_MAX_ATTEMPTS = 8;

function safeTextEqual(a,b){
  a=String(a??""); b=String(b??"");
  if(a.length!==b.length)return false;
  let diff=0;
  for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
function adminSessionToken(request){
  const auth=String(request.headers.get("authorization")||"").trim();
  if(!auth.toLowerCase().startsWith("bearer "))return "";
  return clean(auth.slice(7),180);
}
async function adminSessionOk(env,request){
  const token=adminSessionToken(request);
  if(!token)return false;
  const rec=await env.KV.get(\`adminsession:v1:\${token}\`,"json").catch(()=>null);
  return !!rec?.active;
}
async function adminRateKey(request){
  const ip=String(request.headers.get("CF-Connecting-IP")||"unknown").trim().slice(0,120);
  const bytes=new TextEncoder().encode(ip);
  const hash=await crypto.subtle.digest("SHA-256",bytes);
  const hex=[...new Uint8Array(hash)].slice(0,12).map(b=>b.toString(16).padStart(2,"0")).join("");
  return \`adminpin:fail:v1:\${hex}\`;
}
async function adminPinLogin(request,env){
  const expected=String(env.ADMIN_PIN||"").trim();
  if(!/^\\d{6}$/.test(expected)){
    return json({ok:false,error:"admin_pin_not_configured",message:"ยังไม่ได้ตั้ง ADMIN_PIN 6 หลักใน Cloudflare Runtime Secret"},503,env);
  }

  const rateKey=await adminRateKey(request);
  const attempts=Number(await env.KV.get(rateKey))||0;
  if(attempts>=ADMIN_PIN_MAX_ATTEMPTS){
    return json({ok:false,error:"too_many_attempts",message:"ลองรหัสผิดหลายครั้ง กรุณารอ 15 นาที"},429,env);
  }

  let body={};
  try{body=await request.json();}catch{}
  const pin=String(body?.pin||"").replace(/\\D/g,"").slice(0,6);
  if(!/^\\d{6}$/.test(pin)||!safeTextEqual(pin,expected)){
    await env.KV.put(rateKey,String(attempts+1),{expirationTtl:ADMIN_PIN_WINDOW});
    return json({ok:false,error:"invalid_pin",message:"รหัส 6 หลักไม่ถูกต้อง"},401,env);
  }

  await env.KV.delete(rateKey).catch(()=>{});
  const session=(crypto.randomUUID()+crypto.randomUUID()).replace(/-/g,"");
  await env.KV.put(\`adminsession:v1:\${session}\`,JSON.stringify({
    active:true,
    createdAt:nowIso(),
    userAgent:clean(request.headers.get("user-agent"),220),
  }),{expirationTtl:ADMIN_SESSION_TTL});

  return json({ok:true,session,expiresIn:ADMIN_SESSION_TTL},200,env);
}
async function adminPinLogout(request,env){
  const token=adminSessionToken(request);
  if(token)await env.KV.delete(\`adminsession:v1:\${token}\`).catch(()=>{});
  return json({ok:true},200,env);
}`;

src=src.replace(adminAnchor,helpers);

const oldStart=`export async function handleAdminOps(request, env, url) {
  if (!adminOk(env, url)) return json({ ok: false, error: "unauthorized" }, 401, env);
  try {
    const path = url.pathname;`;

const newStart=`export async function handleAdminOps(request, env, url) {
  const path = url.pathname;

  if (request.method === "POST" && path === "/admin/ops/login") {
    return adminPinLogin(request, env);
  }
  if (request.method === "POST" && path === "/admin/ops/logout") {
    return adminPinLogout(request, env);
  }

  const sessionOk = await adminSessionOk(env, request);
  const legacyKeyOk = adminOk(env, url);
  if (!sessionOk && !legacyKeyOk) {
    return json({ ok: false, error: "unauthorized", message: "Admin session หมดอายุหรือยังไม่ได้เข้าสู่ระบบ" }, 401, env);
  }

  try {`;

if(!src.includes(oldStart))throw new Error("หา handleAdminOps anchor ไม่เจอ");
src=src.replace(oldStart,newStart);

fs.writeFileSync(file,src);
execFileSync(process.execPath,["--check",file],{stdio:"inherit"});

const finalText=fs.readFileSync(file,"utf8");
for(const required of [MARK,'"/admin/ops/login"',"adminSessionOk(env, request)"]){
  if(!finalText.includes(required))throw new Error("patch ไม่ครบ: "+required);
}

console.log("✅ "+MARK+" ready");
console.log("✅ 6-digit ADMIN_PIN login endpoint enabled");
console.log("✅ 8-hour temporary admin session enabled");
console.log("✅ PIN brute-force limit enabled: 8 attempts / 15 minutes");
console.log("✅ legacy ADMIN_KEY fallback kept temporarily");
