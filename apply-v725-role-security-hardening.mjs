import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "src/index.js");
if (!fs.existsSync(file)) {
  throw new Error("ไม่พบ src/index.js — ให้รันที่ root ของ deal-line-bot");
}

let s = fs.readFileSync(file, "utf8");
const MARKER = "ROLE_SECURITY_HARDENING_V7_25_20260811";

if (s.includes(MARKER)) {
  console.log("✅ v7.25 Role Security Hardening already applied");
  process.exit(0);
}

function replaceRequired(from, to, label) {
  if (!s.includes(from)) {
    throw new Error(`หา anchor ไม่เจอ: ${label}\nหยุดก่อนเพื่อไม่แก้ source ผิดเวอร์ชัน`);
  }
  s = s.replace(from, to);
}

// 1) Approver must NOT have the generic /api/batch-status state machine.
//    That endpoint can set payment/cancel states, which is outside approval scope.
replaceRequired(
  'return ["/api/expense-workflow","/api/batch-workflow","/api/batch-status"].includes(path);',
  `// ${MARKER}
    return ["/api/expense-workflow","/api/batch-workflow"].includes(path);`,
  "approver accessCan allowlist"
);

// 2) Defense in depth: even inside /api/batch-workflow Approver may call only approve/reject.
//    Accountant/Owner keep the normal full workflow.
replaceRequired(
  `if (url.pathname === "/api/batch-workflow" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await updateReimbursementBatchWorkflow(env, sheetId, b.batchId, b.action, b.payload || {}, token, { tenant: key });`,
  `if (url.pathname === "/api/batch-workflow" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          if (access.role === "approver" && !["approve", "reject"].includes(String(b.action || ""))) {
            await writeAudit(env, sheetId, token, {
              actor: access.name || "Approver",
              action: "ROLE_DENIED",
              entityType: "reimbursement_batch",
              entityId: b.batchId || "",
              summary: \`ปฏิเสธคำสั่งเกินสิทธิ์ผู้อนุมัติ: \${String(b.action || "")}\`,
              after: { role: access.role, attemptedAction: b.action || "" },
            }).catch(() => {});
            return cors(json({
              ok: false,
              error: "forbidden",
              reason: "approver_action_not_allowed",
              message: "ผู้อนุมัติทำได้เฉพาะ เอกสารผ่าน หรือ ตีกลับ",
            }, 403));
          }
          const out = await updateReimbursementBatchWorkflow(env, sheetId, b.batchId, b.action, b.payload || {}, token, { tenant: key });`,
  "batch-workflow approver action guard"
);

// 3) Reset command rotates only the Owner bearer token.
//    Team daccess tokens are intentionally independent and remain active until Owner revokes them.
replaceRequired(
  "ออกลิงก์ใหม่แล้ว ✅ ลิงก์เก่าทั้งหมดใช้ไม่ได้อีกต่อไป",
  "ออกลิงก์ Owner ใหม่แล้ว ✅ ลิงก์ Owner เดิมใช้ไม่ได้อีกต่อไป · ลิงก์ทีมงานยังใช้ได้ตามสิทธิ์เดิม",
  "reset-link response truth"
);

// Update command help text if this exact legacy copy exists.
s = s.replace(
  "• รีเซ็ตลิงก์ — ยกเลิกลิงก์เก่าทั้งหมด",
  "• รีเซ็ตลิงก์ — ออกลิงก์ Owner ใหม่ (ลิงก์ทีมงานไม่เปลี่ยน)"
);

fs.writeFileSync(file, s);

console.log("✅ v7.25 Role Security Hardening applied");
console.log("Approver: approve/reject only");
console.log("Revoked member token: backend remains 401 unauthorized");
console.log("Reset link: wording now matches Owner-token behavior");
