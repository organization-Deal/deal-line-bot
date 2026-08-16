import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root=process.cwd();
const file=path.join(root,"src","index.js");
const MARK="CONNECTION_STATUS_READONLY_V7_61_20260816";

if(!fs.existsSync(file))throw new Error("ไม่พบ src/index.js");
let src=fs.readFileSync(file,"utf8");

if(src.includes(MARK)){
  console.log("ℹ️ "+MARK+" already present");
  process.exit(0);
}
if(!src.includes("GOOGLE_STATUS_ROUTE_FIX_V7_51_1_20260815")){
  throw new Error("ต้องมี v7.51.1 ก่อน v7.61");
}

function mustReplace(from,to,label){
  const count=src.split(from).length-1;
  if(count!==1)throw new Error(`${label}: ต้องพบ 1 จุด แต่พบ ${count}`);
  src=src.replace(from,to);
}

// 1) Status endpoints ต้องเป็น read-only.
// การกด "ตรวจสถานะ" ห้าม refresh/revoke/เปลี่ยน auth state.
mustReplace(
  'return cors(json(await getGoogleConnectionStatus(env,key,{validate:true})));',
  'return cors(json(await getGoogleConnectionStatus(env,key,{validate:false})));',
  "Google status validate"
);

mustReplace(
  'return cors(json(await getGmailStatus(env, key, { validate: true })));',
  'return cors(json(await getGmailStatus(env, key, { validate: false })));',
  "Gmail status validate"
);

// 2) Endpoint ที่ไม่ต้องใช้ Google Sheet/Drive ห้ามเรียก getUserToken โดยไม่จำเป็น.
// เดิมแค่เปิด Business switcher / ดู Gmail status ก็ไปแตะ Google token refresh.
const oldGuard=`      try {
        const token = await getUserToken(env, key);

        // ถ้า Core Google OAuth ใช้ไม่ได้ ห้าม endpoint บัญชีเดินต่อด้วย token=null
        // ยกเว้น endpoint ที่อ่านจาก KV / Gmail / LINE และไม่ต้องอ่าน Sheet
        const noCoreGoogleRequired=new Set([
          "/api/businesses",
          "/api/gmail-status",
          "/api/accounting/whoami",
          "/api/line-groups",
          "/api/line-workspaces/invite",
          "/api/line-groups/invite"
        ]);
        if(!token&&!noCoreGoogleRequired.has(url.pathname)){
          const google=await getGoogleConnectionStatus(env,key,{validate:false});
          return cors(json({
            ok:false,
            error:"google_reconnect_required",
            message:"Google Sheet / Drive ของธุรกิจนี้ต้องเชื่อมใหม่ ข้อมูลเดิมยังอยู่",
            google,
          },401));
        }
`;

const newGuard=`      try {
        // ${MARK}
        // Read-only / KV / LINE / Gmail-management endpoints ต้องไม่แตะ Core Google token.
        const noCoreGoogleRequired=new Set([
          "/api/businesses",
          "/api/businesses/invite",
          "/api/gmail-status",
          "/api/gmail-disconnect",
          "/api/accounting/whoami",
          "/api/line-groups",
          "/api/line-workspaces/invite",
          "/api/line-groups/invite"
        ]);
        const needsCoreGoogle=!noCoreGoogleRequired.has(url.pathname);
        const token=needsCoreGoogle?await getUserToken(env,key):null;

        // token=null มี 2 ความหมายที่ต้องแยก:
        // A) refresh token ถูก revoke/expired จริง -> 401 และให้เชื่อมใหม่
        // B) Google/network ตอบพลาดชั่วคราว -> 503 ห้ามหลอกว่า OAuth หลุด
        if(needsCoreGoogle&&!token){
          const google=await getGoogleConnectionStatus(env,key,{validate:false});
          if(google.reconnectRequired===true){
            return cors(json({
              ok:false,
              error:"google_reconnect_required",
              message:"สิทธิ์ Google Sheet / Drive หมดอายุหรือถูกยกเลิก กรุณาเชื่อมใหม่ ข้อมูลเดิมยังอยู่",
              google,
            },401));
          }
          return cors(json({
            ok:false,
            error:"google_temporarily_unavailable",
            message:"Google ตอบกลับไม่สำเร็จชั่วคราว การเชื่อมต่อเดิมยังไม่ถูกยกเลิก กรุณาลองใหม่",
            google,
          },503));
        }
`;

mustReplace(oldGuard,newGuard,"Core Google auth guard");

fs.writeFileSync(file,src);
execFileSync(process.execPath,["--check",file],{stdio:"inherit"});

// Static assertions
const out=fs.readFileSync(file,"utf8");
if(!out.includes(MARK))throw new Error("marker หาย");
if(out.includes('getGoogleConnectionStatus(env,key,{validate:true})'))throw new Error("Google status ยัง validate=true");
if(out.includes('getGmailStatus(env, key, { validate: true })'))throw new Error("Gmail status ยัง validate=true");
if(!out.includes('error:"google_temporarily_unavailable"'))throw new Error("ไม่มี transient Google branch");
if(!out.includes('if(google.reconnectRequired===true)'))throw new Error("reconnect guard ไม่ชัดเจน");

console.log("✅ "+MARK+" ready");
console.log("✅ status buttons are read-only");
console.log("✅ business/Gmail status buttons no longer touch Core Google token");
console.log("✅ transient Google failure returns 503, not fake reconnect 401");
