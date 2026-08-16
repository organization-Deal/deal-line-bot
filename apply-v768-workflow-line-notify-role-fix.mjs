import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const file = path.join(root, "src", "index.js");
const MARK = "WORKFLOW_LINE_NOTIFY_ROLE_FIX_V7_68_20260816";

if (!fs.existsSync(file)) {
  throw new Error("ไม่พบ src/index.js");
}

let src = fs.readFileSync(file, "utf8");

if (src.includes(MARK)) {
  console.log("✅ " + MARK + " already applied");
  process.exit(0);
}

// 1) New workflow access: both Approver and Accounting should receive their personal LINE card.
const oldCreateGuard = '            if(rec.role==="approver"&&rec.lineUserId){';
const newCreateGuard = `            // ${MARK}
            if(["approver","accountant"].includes(rec.role)&&rec.lineUserId){`;

if (!src.includes(oldCreateGuard)) {
  throw new Error("v7.68: create access notify guard changed");
}
src = src.replace(oldCreateGuard, newCreateGuard);

// 2) “Send LINE again”: backend notify helper already supports BOTH roles,
// but this route incorrectly blocks Accounting.
const oldResendGuard = '          if(current.role!=="approver"||!current.lineUserId)return cors(json({ok:false,error:"approver_line_not_linked",message:"สิทธิ์นี้ยังไม่ได้ผูก LINE ผู้อนุมัติ"},400));';

const newResendGuard = `          if(!["approver","accountant"].includes(current.role)||!current.lineUserId)return cors(json({
            ok:false,
            error:"workflow_line_not_linked",
            message:"สิทธิ์นี้ยังไม่ได้ผูก LINE สำหรับ Workflow กรุณาเลือกพนักงานจากกลุ่ม LINE ก่อน"
          },400));`;

if (!src.includes(oldResendGuard)) {
  throw new Error("v7.68: access-notify resend guard changed");
}
src = src.replace(oldResendGuard, newResendGuard);

// 3) Return useful delivery/fallback state to Dashboard.
// Keep HTTP 200 because the access record is valid; LINE itself may still require the user
// to open the OA private chat and send “เชื่อม” once.
const oldResponse = `          return cors(json({
            ok:true,
            lineNotification,
            record:saved?{...saved,url:record.url}:record,
          }));`;

const newResponse = `          return cors(json({
            ok:true,
            delivered:lineNotification?.sent===true||lineNotification?.accepted===true,
            fallbackGroupSent:lineNotification?.fallbackGroupSent===true,
            message:(lineNotification?.sent===true||lineNotification?.accepted===true)
              ?"ส่ง LINE ส่วนตัวสำเร็จ"
              :(lineNotification?.fallbackGroupSent===true
                ?"ส่งคำแนะนำเข้า LINE กลุ่มแล้ว ให้ผู้ใช้เปิดแชท LINE OA และพิมพ์ “เชื่อม” แล้วกดส่ง LINE ใหม่อีกครั้ง"
                :"ยังส่ง LINE ส่วนตัวไม่ได้ ให้ผู้ใช้เปิดแชท LINE OA และพิมพ์ “เชื่อม” 1 ครั้ง แล้วลองส่งใหม่"),
            lineNotification,
            record:saved?{...saved,url:record.url}:record,
          }));`;

if (!src.includes(oldResponse)) {
  throw new Error("v7.68: access-notify response block changed");
}
src = src.replace(oldResponse, newResponse);

fs.writeFileSync(file, src);
execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });

const out = fs.readFileSync(file, "utf8");

for (const [ok, label] of [
  [out.includes(MARK), "marker"],
  [out.includes('["approver","accountant"].includes(rec.role)&&rec.lineUserId'), "new access auto-notify both roles"],
  [out.includes('!["approver","accountant"].includes(current.role)||!current.lineUserId'), "resend allows both roles"],
  [!out.includes('error:"approver_line_not_linked"'), "misleading approver-only error removed"],
  [out.includes('fallbackGroupSent:lineNotification?.fallbackGroupSent===true'), "fallback state exposed"],
]) {
  if (!ok) throw new Error("v7.68 assertion failed: " + label);
}

console.log("✅ " + MARK + " ready");
console.log("✅ new Approver access sends LINE automatically when a LINE user is selected");
console.log("✅ new Accounting access also sends LINE automatically");
console.log("✅ Send LINE again works for Approver and Accounting roles");
console.log("✅ misleading approver-only guard removed");
console.log("✅ LINE fallback status is returned to Dashboard");
