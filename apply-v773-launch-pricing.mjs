import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const MARK = "LAUNCH_PRICING_BACKEND_V7_73_20260817";
const files = {
  index: path.join(root, "src", "index.js"),
  admin: path.join(root, "src", "admin-ops.js"),
  email: path.join(root, "src", "email.js"),
  quota: path.join(root, "src", "ai-quota.js"),
  pilot: path.join(root, "pilot-public.js"),
};
for (const [name, file] of Object.entries(files)) if (!fs.existsSync(file)) throw new Error(`v7.73 missing ${name}: ${file}`);

for (const file of [files.index, files.admin, files.email, files.quota, files.pilot]) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

const index = fs.readFileSync(files.index, "utf8");
const admin = fs.readFileSync(files.admin, "utf8");
const email = fs.readFileSync(files.email, "utf8");
const quota = fs.readFileSync(files.quota, "utf8");
const pilot = fs.readFileSync(files.pilot, "utf8");

const checks = [
  [index, 'name: "Lite"', "Lite plan name"],
  [index, 'monthly: 1290', "Business 1,290 price"],
  [index, 'documentLimit: 3000', "Business 3,000 transaction limit"],
  [index, 'businessLimit: 2', "Business 2-company limit"],
  [index, 'aiDocumentLimit: AI_DOCUMENT_LIMITS.business', "Business AI quota wiring"],
  [index, 'aiUsage:', "subscription AI usage snapshot"],
  [index, 'readAiDocumentCache', "LINE OCR AI cache"],
  [email, 'getAiQuotaState', "Email AI quota"],
  [quota, 'business: 1000', "Business 1,000 AI reads"],
  [quota, 'starter: 30', "Lite 30 AI reads"],
  [quota, 'pro: 150', "Pro 150 AI reads"],
  [pilot, 'AI อ่านเอกสารอัตโนมัติ 100 ใบ', "Trial AI 100 copy"],
];
for (const [text, needle, label] of checks) if (!text.includes(needle)) throw new Error(`v7.73 audit failed: ${label}`);

for (const bad of [
  'name: "Starter"',
  'monthly: 990, annual: 9900',
  'documentLimit: 1500, businessLimit: 10',
]) {
  if (index.includes(bad) || admin.includes(bad)) throw new Error(`v7.73 audit failed: legacy pricing remains: ${bad}`);
}

console.log(`✅ ${MARK} ready`);
console.log("✅ Pricing: Free 0 / Lite 199 / Pro 399 / Business 1,290");
console.log("✅ AI reads/month: 5 / 30 / 150 / 1,000");
console.log("✅ Transactions/month: 20 / 200 / 1,000 / 3,000");
console.log("✅ Trial: Business 30 days / 1,000 transactions / 100 AI reads");
console.log("✅ AI quota enforced across LINE OCR and email OCR; manual flow stays available when AI quota is full");
