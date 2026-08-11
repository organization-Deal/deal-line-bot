import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "src/index.js");
if (!fs.existsSync(file)) {
  throw new Error("ไม่พบ src/index.js — ให้รันที่ root ของ deal-line-bot");
}

let s = fs.readFileSync(file, "utf8");
const MARKER = "CHILD_BUSINESS_SETUP_V7_19_20260811";

if (s.includes(MARKER)) {
  console.log("✅ v7.19 child business setup already applied");
  process.exit(0);
}

const start = s.indexOf("async function checkSetup(env, key, sheet) {");
const end = s.indexOf("\nfunction documentSettingsReady", start);

if (start < 0 || end < 0) {
  throw new Error("หา checkSetup() ไม่เจอ — หยุดก่อนเพื่อไม่แก้ผิด source");
}

const replacement = `// ${MARKER}
async function checkSetup(env, key, sheet) {
  const cacheKey = \`companysetup:v3:\${key}:\${sheet.sheetId}\`;
  try {
    // Multi-business rule:
    // Google Sheet/Drive ของธุรกิจลูกใช้ OAuth ของบัญชีหลักอยู่แล้ว
    // Gmail เป็น account-level integration จึงห้ามเป็น requirement ของ child workspace
    const rootTenant = await getAccountRoot(env, key);
    const isChildWorkspace = Boolean(rootTenant && rootTenant !== key);
    const gmail = isChildWorkspace
      ? { connected: true, reconnectRequired: false, inheritedFromRoot: true }
      : await getGmailStatus(env, key);

    const cached = await env.KV.get(cacheKey, "json").catch(() => null);
    if (cached?.documentsReady === true && cached?.financeReady === true) {
      if (isChildWorkspace || gmail.connected === true) return null;
      const gmailMissing = gmail.reconnectRequired ? "เชื่อม Gmail ใหม่" : "Gmail เจ้าของธุรกิจ";
      return {
        warn: \`ตั้งค่าบริษัทให้ครบก่อนใช้งาน — ยังขาด \${gmailMissing} กดปุ่มด้านล่างเพื่อดำเนินการต่อ\`,
        missing: [gmailMissing],
      };
    }

    const settings = await readSettings(env, sheet.sheetId, sheet.token);
    const documentMissing = [];
    if (!settingValue(settings, "company_name")) documentMissing.push("ชื่อบริษัท");
    if (!settingValue(settings, "tax_id")) documentMissing.push("เลขผู้เสียภาษี");
    if (!settingValue(settings, "approver_name")) documentMissing.push("ชื่อผู้อนุมัติ");
    if (!settingValue(settings, "logo_url", "company_logo_url", "logoUrl")) documentMissing.push("โลโก้บริษัท");
    if (!settingValue(settings, "approver_sign_url", "approverSignUrl", "approver_signature_url", "signature_url")) documentMissing.push("ลายเซ็นผู้อนุมัติ");

    const documentsReady = documentMissing.length === 0;
    const financeReady = activePaymentChannels(settings).length > 0;
    const missing = [...documentMissing];

    if (!financeReady) missing.push("ช่องทางการโอนเงิน");

    // Root business ยังจัดการ Gmail integration ตามเดิม
    // Child business ไม่ต้อง Login Gmail ซ้ำและไม่ถูก block ด้วย Gmail
    if (!isChildWorkspace && !gmail.connected) {
      missing.push(gmail.reconnectRequired ? "เชื่อม Gmail ใหม่" : "Gmail เจ้าของธุรกิจ");
    }

    await env.KV.put(cacheKey, JSON.stringify({
      documentsReady,
      financeReady,
      gmailRequired: !isChildWorkspace,
      inheritedAccountIntegration: isChildWorkspace,
      checkedAt: Date.now(),
    }));

    if (!missing.length) return null;
    return {
      warn: \`ตั้งค่าบริษัทให้ครบก่อนใช้งาน — ยังขาด \${missing.join(" · ")} กดปุ่มด้านล่างเพื่อดำเนินการต่อ\`,
      missing,
    };
  } catch (e) {
    console.warn("checkSetup", e.message);
    return { warn: "ตรวจสถานะการตั้งค่าบริษัทไม่ได้ — เปิด Dashboard เพื่อตรวจข้อมูลบริษัท ผู้อนุมัติ ลายเซ็น และช่องทางการโอนเงิน" };
  }
}
`;

s = s.slice(0, start) + replacement + s.slice(end);
fs.writeFileSync(file, s);

console.log("✅ v7.19 Child Business Flow applied");
console.log("Child setup: company profile → approver/signature → finance");
console.log("Child Gmail: inherited/account-level, not a setup blocker");
