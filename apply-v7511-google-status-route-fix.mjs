import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root=process.cwd();
const file=path.join(root,"src","index.js");
const MARK="GOOGLE_STATUS_ROUTE_FIX_V7_51_1_20260815";
if(!fs.existsSync(file))throw new Error("ไม่พบ src/index.js");

let src=fs.readFileSync(file,"utf8");
if(src.includes(MARK)){
  console.log("ℹ️ "+MARK+" already present");
  process.exit(0);
}
if(!src.includes("PRODUCTION_GOOGLE_AUTH_GUARD_V7_51_20260815")){
  throw new Error("ต้องรัน v7.51 ก่อน v7.51.1");
}
if(!src.includes("getGoogleConnectionStatus")){
  throw new Error("ไม่พบ getGoogleConnectionStatus import");
}

/* v7.51 จับ getUserToken ตัวแรกผิดตัว จึงไปยัด API guard ใน /admin/subscription */
const misplaced=`        // PRODUCTION_GOOGLE_AUTH_GUARD_V7_51_20260815
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
        }
`;
const misplacedCount=src.split(misplaced).length-1;
if(misplacedCount!==1)throw new Error(`บล็อก v7.51 ผิดตำแหน่งพบ ${misplacedCount} จุด`);
src=src.replace(misplaced,"");

/* วาง /api/google-status หลังยืนยัน dashboard link แต่ก่อน role policy
   เพื่อให้ทุก role ที่มีลิงก์ถูกต้องตรวจ connection ได้ */
const accessAnchor=`      if (!access.ok) {
        return cors(json({error:"unauthorized",hint:'ลิงก์ไม่ถูกต้องหรือถูกยกเลิกแล้ว — พิมพ์ "แดชบอร์ด" ในกลุ่ม LINE เพื่อขอลิงก์ใหม่'},401));
      }
`;
if(!src.includes(accessAnchor))throw new Error("หา dashboard access anchor ไม่เจอ");
src=src.replace(accessAnchor,accessAnchor+`
      // ${MARK}
      if(url.pathname==="/api/google-status"&&request.method==="GET"){
        try{
          return cors(json(await getGoogleConnectionStatus(env,key,{validate:true})));
        }catch(error){
          console.error("[google-status]",error);
          return cors(json({
            ok:false,connected:false,reconnectRequired:false,
            reason:"status_unavailable",message:"ตรวจสถานะ Google ไม่สำเร็จชั่วคราว"
          },503));
        }
      }
`);

/* ใส่ auth guard ใน try ของ /api/* ตัวจริง ไม่ใช่ admin */
const normalTokenAnchor=`      try {
        const token = await getUserToken(env, key);

        if (url.pathname === "/api/subscription") {`;
if(!src.includes(normalTokenAnchor))throw new Error("หา normal /api token anchor ไม่เจอ");
src=src.replace(normalTokenAnchor,`      try {
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

        if (url.pathname === "/api/subscription") {`);

fs.writeFileSync(file,src);
execFileSync(process.execPath,["--check",file],{stdio:"inherit"});

/* Assertions: route must be in normal /api area, never admin subscription */
const out=fs.readFileSync(file,"utf8");
const apiStart=out.indexOf('/* ══════════════ API ให้ dashboard ══════════════ */');
const statusPos=out.indexOf('url.pathname==="/api/google-status"');
const adminPos=out.indexOf('url.pathname === "/admin/subscription"');
if(!(apiStart>=0&&statusPos>apiStart))throw new Error("/api/google-status ยังไม่ได้อยู่ใน Dashboard API block");
if(statusPos>adminPos&&statusPos<apiStart)throw new Error("/api/google-status ยังอยู่ใน admin block");
const statusCount=(out.match(/url\.pathname==="\/api\/google-status"/g)||[]).length;
if(statusCount!==1)throw new Error(`/api/google-status route count=${statusCount}`);

console.log("✅ "+MARK+" ready");
console.log("✅ /api/google-status moved into normal Dashboard API router");
console.log("✅ normal accounting APIs fail closed when Core Google OAuth is unavailable");
