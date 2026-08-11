import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "src/index.js");
if (!fs.existsSync(file)) throw new Error("ไม่พบ src/index.js — ให้รันที่ root ของ deal-line-bot");

let s = fs.readFileSync(file, "utf8");
const MARKER = "UNIFIED_BUSINESS_READINESS_V7_21_20260811";

if (s.includes(MARKER)) {
  console.log("✅ v7.21 unified business readiness already applied");
  process.exit(0);
}

const start = s.indexOf("async function checkSetup(env, key, sheet) {");
const end = s.indexOf("\nfunction documentSettingsReady", start);

if (start < 0 || end < 0) {
  throw new Error("หา checkSetup() ไม่เจอ — หยุดก่อนเพื่อไม่แก้ source ผิดเวอร์ชัน");
}

const replacement = `// ${MARKER}
async function checkSetup(env, key, sheet) {
  const cacheKey = \`companysetup:v4:\${key}:\${sheet.sheetId}\`;
  try {
    // Business readiness is identical for root and child.
    // Gmail Automation is optional and never blocks LINE/reimbursement workflows.
    const cached = await env.KV.get(cacheKey, "json").catch(() => null);
    if (cached?.documentsReady === true && cached?.financeReady === true) return null;

    const settings = await readSettings(env, sheet.sheetId, sheet.token);
    const missing = [];

    if (!settingValue(settings, "company_name")) missing.push("ชื่อบริษัท");
    if (!settingValue(settings, "tax_id")) missing.push("เลขผู้เสียภาษี");
    if (!settingValue(settings, "logo_url", "company_logo_url", "logoUrl")) missing.push("โลโก้บริษัท");
    if (!settingValue(settings, "approver_name")) missing.push("ชื่อผู้อนุมัติ");
    if (!settingValue(settings, "approver_sign_url", "approverSignUrl", "approver_signature_url", "signature_url")) missing.push("ลายเซ็นผู้อนุมัติ");

    const documentsReady = missing.length === 0;
    const financeReady = activePaymentChannels(settings).length > 0;
    if (!financeReady) missing.push("ช่องทางการเงิน");

    await env.KV.put(cacheKey, JSON.stringify({
      documentsReady,
      financeReady,
      gmailRequired: false,
      checkedAt: Date.now(),
    }));

    if (!missing.length) return null;

    return {
      warn: \`ตั้งค่าธุรกิจให้ครบก่อนใช้งาน — ยังขาด \${missing.join(" · ")}\`,
      missing,
    };
  } catch (e) {
    console.warn("checkSetup", e.message);
    return {
      warn: "ตรวจสถานะการตั้งค่าธุรกิจไม่ได้ — เปิด Dashboard เพื่อตรวจข้อมูลบริษัท ผู้อนุมัติ ลายเซ็น และช่องทางการเงิน"
    };
  }
}
`;

s = s.slice(0, start) + replacement + s.slice(end);
fs.writeFileSync(file, s);

console.log("✅ v7.21 Unified Business Readiness applied");
console.log("Same readiness pattern for root + child");
console.log("Gmail Automation is optional");
