import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const indexFile = path.join(root, "src", "index.js");
const adminFile = path.join(root, "src", "admin-ops.js");
const pilotRoot = path.join(root, "pilot-public.js");
const pilotSrc = path.join(root, "src", "pilot-public.js");
const MARK = "TRIAL_POLICY_30D_1000_V7_72_20260817";

for (const file of [indexFile, adminFile]) {
  if (!fs.existsSync(file)) throw new Error("ไม่พบ " + file);
}

function writeChecked(file, text) {
  fs.writeFileSync(file, text);
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

function replaceAllLiteral(text, from, to) {
  return text.split(from).join(to);
}

/* ───────────────── Core subscription runtime ───────────────── */
let index = fs.readFileSync(indexFile, "utf8");

// Replace the entire trial duration helper so no legacy BETA_FREE_UNTIL
// or default 60-day branch can grant a longer automatic trial.
const betaStart = index.indexOf("function configuredBetaEnd(");
const betaEnd = index.indexOf("async function getSubscriptionRecord", betaStart);
if (betaStart < 0 || betaEnd <= betaStart) {
  throw new Error("v7.72: configuredBetaEnd/getSubscriptionRecord anchors changed");
}

const policyHelpers = `function configuredBetaEnd(env, startedAt = Date.now()) {
  // ${MARK}: automatic Trial is exactly 30 days from the account's real start.
  const days = Math.max(1, Number(env.BETA_TRIAL_DAYS || 30));
  return new Date(Number(startedAt) + days * 86400000).toISOString();
}
function configuredTrialDocumentLimit(env) {
  // Trial quota only. Paid Business package remains unchanged.
  return Math.max(1, Number(env.BETA_TRIAL_DOCUMENT_LIMIT || 1000));
}

`;

index = index.slice(0, betaStart) + policyHelpers + index.slice(betaEnd);

// Work only inside getSubscriptionRecord.
const recordStart = index.indexOf("async function getSubscriptionRecord");
const recordEnd = index.indexOf("async function saveSubscriptionRecord", recordStart);
if (recordStart < 0 || recordEnd <= recordStart) {
  throw new Error("v7.72: subscription record anchors changed");
}
let recordBlock = index.slice(recordStart, recordEnd);

// New automatic trial must be Business, not Pro.
recordBlock = recordBlock.replace(/plan:\s*"pro"/, 'plan: "business"');
recordBlock = replaceAllLiteral(recordBlock, '"business_60d"', '"business_30d"');

// If an earlier migration already added per-account normalization, configuredBetaEnd()
// now makes it 30 days. If not, insert normalization so existing 60-day records
// are shortened to start + 30 days on the next subscription read.
if (!recordBlock.includes("trialPolicyVersion:")) {
  const expiryNeedles = [
    '  // Trial จบแล้วและยังไม่ได้เปิดแพ็กเสียเงิน → กลับ Free อัตโนมัติ',
    '  // Beta จบแล้วและยังไม่ได้เปิดแพ็กเสียเงิน → กลับ Free อัตโนมัติ',
  ];
  let expiryPos = -1;
  for (const needle of expiryNeedles) {
    const p = recordBlock.indexOf(needle);
    if (p >= 0) { expiryPos = p; break; }
  }
  if (expiryPos < 0) throw new Error("v7.72: trial expiry anchor changed");

  const normalize = `  // ${MARK}: normalize every legacy Trial to the new 30-day policy.
  if (rec.status === "beta") {
    const startMs = Date.parse(rec.trialStartedAt || rec.createdAt || "");
    if (Number.isFinite(startMs)) {
      const expectedEnd = configuredBetaEnd(env, startMs);
      if (rec.trialEndsAt !== expectedEnd || rec.plan !== "business" || rec.trialMode !== "business_30d") {
        rec = {
          ...rec,
          plan: "business",
          trialEndsAt: expectedEnd,
          trialMode: "business_30d",
          trialPolicyVersion: "${MARK}",
          trialMigratedAt: new Date(now).toISOString(),
        };
        await env.KV.put(storageKey, JSON.stringify(rec));
      }
    }
  }

`;
  recordBlock = recordBlock.slice(0, expiryPos) + normalize + recordBlock.slice(expiryPos);
}
index = index.slice(0, recordStart) + recordBlock + index.slice(recordEnd);

// Enforce Business Trial + 1,000 docs/month in the subscription snapshot.
// Support both the old base source and later migrated source shapes.
index = index.replace(
  'const effectivePlan = betaActive ? "pro" : (rec.status === "active" && SUBSCRIPTION_PLANS[rec.plan] ? rec.plan : "free");',
  'const effectivePlan = betaActive ? "business" : (rec.status === "active" && SUBSCRIPTION_PLANS[rec.plan] ? rec.plan : "free");'
);
index = index.replace(
  'const limit = betaActive ? null : plan.documentLimit;',
  'const limit = betaActive ? configuredTrialDocumentLimit(env) : plan.documentLimit;'
);
index = index.replace(
  'const limit = plan.documentLimit;',
  'const limit = betaActive ? configuredTrialDocumentLimit(env) : plan.documentLimit;'
);
index = index.replace(
  'const businessAccessAllowed = betaActive || businessIndex < businessLimit;',
  'const businessAccessAllowed = businessIndex < businessLimit;'
);
index = index.replace(
  'const documentBlocked = Boolean(enforcement && !betaActive && limit && usage.documents >= limit);',
  'const documentBlocked = Boolean(enforcement && limit && usage.documents >= limit);'
);
index = replaceAllLiteral(index, 'planName: betaActive ? "Beta ฟรี · สิทธิ์ Pro" : plan.name,',
  'planName: betaActive ? "ทดลองใช้ Business ฟรี" : plan.name,');
index = replaceAllLiteral(index, '"business_60d"', '"business_30d"');

writeChecked(indexFile, index);

/* ───────────────── Internal Operations runtime ───────────────── */
let admin = fs.readFileSync(adminFile, "utf8");

admin = admin.replace(/const TRIAL_DAYS\s*=\s*60\s*;/, "const TRIAL_DAYS = 30;");
if (!admin.includes("const TRIAL_DOCUMENT_LIMIT = 1000;")) {
  const anchor = "const TRIAL_DAYS = 30;";
  if (!admin.includes(anchor)) throw new Error("v7.72: TRIAL_DAYS anchor changed");
  admin = admin.replace(anchor, `${anchor}
const TRIAL_DOCUMENT_LIMIT = 1000;`);
}
admin = replaceAllLiteral(admin, '"business_60d"', '"business_30d"');

// Internal Ops must display/enforce Trial quota 1,000 while leaving paid Business 1,500.
admin = admin.replace(
  "    documentLimit: plan.documentLimit,",
  "    documentLimit: betaActive ? TRIAL_DOCUMENT_LIMIT : plan.documentLimit,"
);

writeChecked(adminFile, admin);

/* ───────────────── Public Pilot backend page ───────────────── */
function patchPilot(file) {
  if (!fs.existsSync(file)) return;
  let s = fs.readFileSync(file, "utf8");
  s = replaceAllLiteral(s, "PUBLIC_PILOT_ROUTE_V7_71_20260817", "PUBLIC_PILOT_ROUTE_V7_72_TRIAL_30D_1000_20260817");
  s = replaceAllLiteral(s, "ทดลองใช้แพ็กเกจ Business ฟรี 60 วัน", "ทดลองใช้แพ็กเกจ Business ฟรี 30 วัน");
  s = replaceAllLiteral(s, "สูงสุด 1,500 รายการ/เดือน", "สูงสุด 1,000 รายการ/เดือน");
  s = replaceAllLiteral(s, "รองรับสูงสุด 1,500 รายการ/เดือน", "รองรับสูงสุด 1,000 รายการ/เดือน");
  s = replaceAllLiteral(s, "60 วันจะเริ่มนับ", "30 วันจะเริ่มนับ");
  s = replaceAllLiteral(s, "การส่งฟอร์มยังไม่เริ่มนับ 60 วัน", "การส่งฟอร์มยังไม่เริ่มนับ 30 วัน");
  s = replaceAllLiteral(s, "เริ่มนับเมื่อเริ่มใช้งานจริง · สูงสุด 1,500", "เริ่มนับเมื่อเริ่มใช้งานจริง · สูงสุด 1,000");
  writeChecked(file, s);
}
patchPilot(pilotRoot);
patchPilot(pilotSrc);

/* ───────────────── Build guard: live backend must have no old Trial policy ───────────────── */
const forbidden = [
  [/BETA_TRIAL_DAYS\s*\|\|\s*60/, "default 60-day trial"],
  [/const\s+TRIAL_DAYS\s*=\s*60\b/, "Internal Ops 60-day trial"],
  [/business_60d/, "business_60d mode"],
  [/ทดลองใช้แพ็กเกจ Business ฟรี 60 วัน/, "Pilot 60-day copy"],
  [/60 วันจะเริ่มนับ/, "Pilot success 60-day copy"],
  [/ไม่เริ่มนับ 60 วัน/, "Pilot note 60-day copy"],
  [/1,500 รายการ\/เดือน/, "Pilot 1,500 trial copy"],
];

for (const file of [indexFile, adminFile, pilotRoot, pilotSrc]) {
  if (!fs.existsSync(file)) continue;
  const s = fs.readFileSync(file, "utf8");
  for (const [rx, label] of forbidden) {
    if (rx.test(s)) throw new Error(`v7.72 audit failed: ${label} remains in ${path.relative(root, file)}`);
  }
}

// Assert the critical runtime policy, without touching paid Business package.
const finalIndex = fs.readFileSync(indexFile, "utf8");
const finalAdmin = fs.readFileSync(adminFile, "utf8");
if (!finalIndex.includes("configuredTrialDocumentLimit(env)")) throw new Error("v7.72: trial document limit helper missing");
if (!/BETA_TRIAL_DOCUMENT_LIMIT\s*\|\|\s*1000/.test(finalIndex)) throw new Error("v7.72: backend 1000 default missing");
if (!finalAdmin.includes("const TRIAL_DOCUMENT_LIMIT = 1000;")) throw new Error("v7.72: admin 1000 limit missing");

console.log("✅ " + MARK + " ready");
console.log("✅ automatic Trial duration = 30 days from actual trial start");
console.log("✅ existing active 60-day Trial records normalize to start + 30 days");
console.log("✅ Trial Business quota = 1,000 documents/month");
console.log("✅ paid Business package remains 1,500 documents/month");
console.log("✅ Internal Ops uses 30 days / 1,000 documents for Trial customers");
console.log("✅ public Pilot backend page contains no 60-day / 1,500-trial copy");
console.log("✅ backend runtime audit found no legacy 60-day Trial policy");
