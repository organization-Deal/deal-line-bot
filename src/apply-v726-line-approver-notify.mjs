import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const indexFile = path.join(root, "src/index.js");
const batchesFile = path.join(root, "src/batches.js");

if (!fs.existsSync(indexFile)) throw new Error("ไม่พบ src/index.js — ให้รันที่ root ของ deal-line-bot");
if (!fs.existsSync(batchesFile)) throw new Error("ไม่พบ src/batches.js — ให้รันที่ root ของ deal-line-bot");
if (!fs.existsSync(path.join(root, "src/approver-line.js"))) throw new Error("ไม่พบ src/approver-line.js");

const MARKER = "LINE_APPROVER_NOTIFY_V7_26_20260811";

function mustReplace(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`หา anchor ไม่เจอ: ${label}\nหยุดก่อนเพื่อไม่แก้ source ผิดเวอร์ชัน`);
  return text.replace(from, to);
}

let s = fs.readFileSync(indexFile, "utf8");

if (!s.includes(MARKER)) {
  // Import directory + notification helpers.
  s = mustReplace(
    s,
    'import { classifyTransferByCompanyAccounts } from "./account-direction.js";',
    `import { classifyTransferByCompanyAccounts } from "./account-direction.js";
import {
  rememberLineEventMembers,
  listLineWorkspaceMembers,
  bindApproverLine,
  notifyApproverAssignment,
  notifyApproversForBatchOutput,
} from "./approver-line.js"; // ${MARKER}`,
    "approver-line import"
  );

  // Create Dashboard access: keep lineUserId and immediately send a welcome message
  // when the Owner creates an Approver linked to a LINE member.
  s = mustReplace(
    s,
    'if(request.method==="POST"){const b=await request.json().catch(()=>({}));const rec=await createDashAccess(env,key,b);const base=(env.DASHBOARD_URL||"").replace(/\\/$/,"");return cors(json({ok:true,record:{...rec,url:`${base}?tenant=${encodeURIComponent(key)}&k=${rec.token}`}}));}',
    `if(request.method==="POST"){
            const b=await request.json().catch(()=>({}));
            const rec=await createDashAccess(env,key,b);
            const base=(env.DASHBOARD_URL||"").replace(/\\/$/,"");
            const record={...rec,url:\`${"${base}"}?tenant=\${encodeURIComponent(key)}&k=\${rec.token}\`};
            if(rec.role==="approver"&&rec.lineUserId){
              ctx.waitUntil(notifyApproverAssignment(env,key,record).catch(e=>console.warn("approver assignment notify",e?.message||e)));
            }
            return cors(json({ok:true,record}));
          }`,
    "create access with LINE notification"
  );

  // Owner-only directory + bind endpoint.
  s = mustReplace(
    s,
    `if (url.pathname === "/api/accounting/access-revoke" && request.method === "POST") {
          if(access.role!=="owner")return cors(json({ok:false,error:"owner_only"},403));const b=await request.json().catch(()=>({}));return cors(json(await revokeDashAccess(env,key,b.token||"")));
        }
        if (url.pathname === "/api/accounting/whoami")`,
    `if (url.pathname === "/api/accounting/access-revoke" && request.method === "POST") {
          if(access.role!=="owner")return cors(json({ok:false,error:"owner_only"},403));const b=await request.json().catch(()=>({}));return cors(json(await revokeDashAccess(env,key,b.token||"")));
        }

        if (url.pathname === "/api/line-members") {
          if(access.role!=="owner")return cors(json({ok:false,error:"owner_only"},403));
          return cors(json(await listLineWorkspaceMembers(env,key,{
            sheetId,
            token,
            refresh:url.searchParams.get("refresh")!=="0",
          })));
        }

        if (url.pathname === "/api/accounting/access-line" && request.method === "POST") {
          if(access.role!=="owner")return cors(json({ok:false,error:"owner_only"},403));
          const b=await request.json().catch(()=>({}));
          const out=await bindApproverLine(env,key,b.token||"",b.lineUserId||"");
          if(out.ok){
            const base=(env.DASHBOARD_URL||"").replace(/\\/$/,"");
            const record={...out.record,url:\`${"${base}"}?tenant=\${encodeURIComponent(key)}&k=\${out.record.token}\`};
            ctx.waitUntil(notifyApproverAssignment(env,key,record).catch(e=>console.warn("approver line bind notify",e?.message||e)));
            return cors(json({ok:true,record}));
          }
          return cors(json(out,400));
        }

        if (url.pathname === "/api/accounting/whoami")`,
    "line members + access line endpoints"
  );

  // Manual batch creation from Dashboard -> direct Approver notification.
  s = mustReplace(
    s,
    `if(out.ok)await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"CREATE_BATCH",entityType:"reimbursement_batch",entityId:out.batchId||out.id||"",summary:\`สร้าง/รวมรอบเบิก \${b.type||"ปกติ"}\`,after:out});
          return cors(json(out, out.ok ? 200 : 400));`,
    `if(out.ok){
            await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"CREATE_BATCH",entityType:"reimbursement_batch",entityId:out.batchId||out.id||"",summary:\`สร้าง/รวมรอบเบิก \${b.type||"ปกติ"}\`,after:out});
            ctx.waitUntil(notifyApproversForBatchOutput(env,key,out,{kind:b.type==="ด่วน"?"urgent-dashboard":"manual-dashboard"}).catch(e=>console.warn("approver batch notify",e?.message||e)));
          }
          return cors(json(out, out.ok ? 200 : 400));`,
    "manual batch notification"
  );

  // Urgent batch from Dashboard -> direct Approver notification.
  s = mustReplace(
    s,
    `if(out.ok)await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"REQUEST_URGENT",entityType:"expense",entityId:ids.join(","),summary:\`ขอเบิกด่วน \${ids.length} รายการ\`,after:out});
          return cors(json(out, out.ok ? 200 : 400));`,
    `if(out.ok){
            await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"REQUEST_URGENT",entityType:"expense",entityId:ids.join(","),summary:\`ขอเบิกด่วน \${ids.length} รายการ\`,after:out});
            ctx.waitUntil(notifyApproversForBatchOutput(env,key,out,{kind:"urgent-dashboard"}).catch(e=>console.warn("approver urgent notify",e?.message||e)));
          }
          return cors(json(out, out.ok ? 200 : 400));`,
    "urgent dashboard notification"
  );

  // Learn users from every webhook before normal processing. This does not block the webhook.
  s = mustReplace(
    s,
    `for (const event of body.events || []) {
      const key = tenantKey(event.source);`,
    `for (const event of body.events || []) {
      const key = tenantKey(event.source);
      ctx.waitUntil(
        rememberLineEventMembers(env,event)
          .catch(e=>console.warn("remember LINE member",key,e?.message||e))
      );`,
    "webhook member memory"
  );

  // Urgent batch requested directly from LINE card -> Approver notification too.
  s = mustReplace(
    s,
    `const batch = out.batches[0];
      const updated = await getExpenseById(env, sheet.sheetId, id, sheet.token);`,
    `const batch = out.batches[0];
      await notifyApproversForBatchOutput(env,key,out,{kind:"urgent-line"})
        .catch(e=>console.warn("approver urgent LINE notify",e?.message||e));
      const updated = await getExpenseById(env, sheet.sheetId, id, sheet.token);`,
    "urgent LINE notification"
  );

  fs.writeFileSync(indexFile, s);
}

let b = fs.readFileSync(batchesFile, "utf8");
if (!b.includes(MARKER)) {
  b = mustReplace(
    b,
    'import { push, textMsg } from "./line.js";',
    `import { push, textMsg } from "./line.js";
import { notifyApproversForBatchOutput } from "./approver-line.js"; // ${MARKER}`,
    "batches import"
  );

  b = mustReplace(
    b,
    `await push(env, tenant, textMsg(line)).catch((e) => console.warn("batch notify", tenant, e.message));`,
    `await push(env, tenant, textMsg(line)).catch((e) => console.warn("batch notify", tenant, e.message));
        await notifyApproversForBatchOutput(env,tenant,out,{kind:"scheduled"})
          .catch((e)=>console.warn("approver scheduled notify",tenant,e?.message||e));`,
    "scheduled direct Approver notification"
  );

  fs.writeFileSync(batchesFile, b);
}

console.log("✅ v7.26 LINE Approver Notify applied");
console.log("LINE member directory: webhook + team_members + full group API when available");
console.log("Approver direct notify: scheduled / manual / urgent");
console.log("Approver receives their own role-token Dashboard URL");
