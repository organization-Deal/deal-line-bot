import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "src/index.js");
if (!fs.existsSync(file)) throw new Error("ไม่พบ src/index.js — ให้รันที่ root ของ deal-line-bot");

let s = fs.readFileSync(file, "utf8");
const MARKER = "APPROVER_ASSIGNMENT_CONFIRM_V7_26_3_20260812";

if (s.includes(MARKER)) {
  console.log("✅ v7.26.3 Approver Assignment Confirmation already applied");
  process.exit(0);
}

function mustReplace(from, to, label) {
  if (!s.includes(from)) throw new Error(`หา anchor ไม่เจอ: ${label}\nต้องรัน v7.26 และ v7.26.2 ก่อน`);
  s = s.replace(from, to);
}

const oldCreate = `async function createDashAccess(env,key,{name="",role="viewer",lineUserId=""}={}){
  const r=["accountant","approver","viewer"].includes(role)?role:"viewer",token=crypto.randomUUID().replace(/-/g,"").slice(0,24);
  const rec={name:String(name||DASH_ROLES[r]).trim().slice(0,120),role:r,lineUserId:String(lineUserId||"").trim().slice(0,120),active:true,createdAt:new Date().toISOString()};
  await env.KV.put(\`daccess:\${key}:\${token}\`,JSON.stringify(rec));return {...rec,token};
}`;

const newCreate = `async function createDashAccess(env,key,{
    name="",
    role="viewer",
    lineUserId="",
    lineGroupTenant="",
    lineGroupName="",
    companyName="",
  }={}){
  // ${MARKER}
  const r=["accountant","approver","viewer"].includes(role)?role:"viewer",token=crypto.randomUUID().replace(/-/g,"").slice(0,24);
  const rec={
    name:String(name||DASH_ROLES[r]).trim().slice(0,120),
    role:r,
    lineUserId:String(lineUserId||"").trim().slice(0,120),
    lineGroupTenant:r==="approver"?String(lineGroupTenant||"").trim().slice(0,120):"",
    lineGroupName:r==="approver"?String(lineGroupName||"").trim().slice(0,160):"",
    companyName:String(companyName||"").trim().slice(0,160),
    active:true,
    createdAt:new Date().toISOString()
  };
  await env.KV.put(\`daccess:\${key}:\${token}\`,JSON.stringify(rec));return {...rec,token};
}`;
mustReplace(oldCreate, newCreate, "createDashAccess context");

const oldNotify = `            if(rec.role==="approver"&&rec.lineUserId){
              ctx.waitUntil(notifyApproverAssignment(env,key,record).catch(e=>console.warn("approver assignment notify",e?.message||e)));
            }
            return cors(json({ok:true,record}));`;

const newNotify = `            let lineNotification={attempted:false,sent:false};
            if(rec.role==="approver"&&rec.lineUserId){
              lineNotification=await notifyApproverAssignment(env,key,record)
                .catch(e=>({ok:false,sent:false,accepted:false,reason:String(e?.message||e).slice(0,180)}));
            }
            return cors(json({ok:true,record,lineNotification}));`;
mustReplace(oldNotify, newNotify, "wait for assignment LINE push");

const oldBind = `            ctx.waitUntil(notifyApproverAssignment(env,key,record).catch(e=>console.warn("approver line bind notify",e?.message||e)));
            return cors(json({ok:true,record}));`;

const newBind = `            const lineNotification=await notifyApproverAssignment(env,key,record)
              .catch(e=>({ok:false,sent:false,accepted:false,reason:String(e?.message||e).slice(0,180)}));
            return cors(json({ok:true,record,lineNotification}));`;
mustReplace(oldBind, newBind, "wait for line bind notification");

fs.writeFileSync(file, s);
console.log("✅ v7.26.3 Approver Assignment Confirmation applied");
console.log("Create Approver: waits for LINE push result");
console.log("Role record: stores company + LINE group context");
console.log("Dashboard can show sent / failed truthfully");
