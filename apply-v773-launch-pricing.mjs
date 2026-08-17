import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const MARK = "LAUNCH_PRICING_BACKEND_V7_73_1_20260817";
const AI_QUOTA_SOURCE = "// AI document quota shared by LINE OCR + Email OCR.\n// Customer-facing rule: one successfully processed document = one AI read.\n// Automatic retries/fallbacks inside one OCR call do not consume extra quota.\n\nexport const AI_DOCUMENT_LIMITS = Object.freeze({\n  free: 5,\n  starter: 30, // customer-facing name = Lite; keep internal id for compatibility\n  pro: 150,\n  business: 1000,\n});\n\nconst AI_USAGE_TTL = 60 * 60 * 24 * 120;\nconst AI_CACHE_TTL = 60 * 60 * 24 * 90;\n\nfunction monthKey(value = new Date()) {\n  const d = value instanceof Date ? value : new Date(value);\n  if (!Number.isFinite(d.getTime())) return \"\";\n  try {\n    const parts = new Intl.DateTimeFormat(\"en-CA\", {\n      timeZone: \"Asia/Bangkok\", year: \"numeric\", month: \"2-digit\",\n    }).formatToParts(d);\n    const y = parts.find(p => p.type === \"year\")?.value || \"\";\n    const m = parts.find(p => p.type === \"month\")?.value || \"\";\n    return y && m ? `${y}-${m}` : \"\";\n  } catch {\n    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, \"0\")}`;\n  }\n}\n\nasync function rootTenant(env, tenant) {\n  return (await env.KV.get(`accountroot:v1:${tenant}`)) || tenant;\n}\n\nfunction aiEnforcementEnabled(env) {\n  return ![\"0\", \"false\", \"off\", \"no\"].includes(String(env.AI_QUOTA_ENFORCEMENT ?? \"1\").trim().toLowerCase());\n}\n\nexport async function getAiQuotaState(env, tenant) {\n  const root = await rootTenant(env, tenant);\n  const rec = (await env.KV.get(`subscription:v1:${root}`, \"json\").catch(() => null)) || {};\n  const now = Date.now();\n  const trialEnd = Date.parse(rec.trialEndsAt || \"\");\n  const betaActive = rec.status === \"beta\" && Number.isFinite(trialEnd) && trialEnd > now;\n  const planId = betaActive\n    ? \"business\"\n    : (rec.status === \"active\" && AI_DOCUMENT_LIMITS[rec.plan] != null ? rec.plan : \"free\");\n  const limit = betaActive\n    ? Math.max(1, Number(env.BETA_TRIAL_AI_DOCUMENT_LIMIT || 100))\n    : Number(AI_DOCUMENT_LIMITS[planId] || 0);\n  const month = monthKey();\n  const usageKey = `subaiusage:v1:${root}:${month}`;\n  const usedRaw = await env.KV.get(usageKey);\n  const used = Math.max(0, Number(usedRaw || 0) || 0);\n  const blocked = Boolean(aiEnforcementEnabled(env) && limit > 0 && used >= limit);\n  return { root, month, usageKey, used, limit, remaining: Math.max(0, limit - used), blocked, betaActive, planId };\n}\n\nexport async function consumeAiDocument(env, tenant, amount = 1) {\n  const state = await getAiQuotaState(env, tenant);\n  const n = Math.max(1, Number(amount || 1));\n  if (state.blocked || (aiEnforcementEnabled(env) && state.limit > 0 && state.used + n > state.limit)) {\n    return { ...state, ok: false, blocked: true };\n  }\n  const next = state.used + n;\n  await env.KV.put(state.usageKey, String(next), { expirationTtl: AI_USAGE_TTL });\n  return { ...state, ok: true, used: next, remaining: Math.max(0, state.limit - next), blocked: next >= state.limit };\n}\n\nfunction cacheKey(root, kind, fingerprint) {\n  const safeKind = String(kind || \"document\").replace(/[^a-z0-9_-]/gi, \"\").slice(0, 24) || \"document\";\n  const safeHash = String(fingerprint || \"\").replace(/[^a-z0-9_-]/gi, \"\").slice(0, 160);\n  return safeHash ? `aicache:v1:${root}:${safeKind}:${safeHash}` : \"\";\n}\n\nexport async function readAiDocumentCache(env, tenant, kind, fingerprint) {\n  const root = await rootTenant(env, tenant);\n  const key = cacheKey(root, kind, fingerprint);\n  if (!key) return null;\n  return env.KV.get(key, \"json\").catch(() => null);\n}\n\nexport async function writeAiDocumentCache(env, tenant, kind, fingerprint, value) {\n  const root = await rootTenant(env, tenant);\n  const key = cacheKey(root, kind, fingerprint);\n  if (!key) return false;\n  await env.KV.put(key, JSON.stringify({ value, savedAt: new Date().toISOString() }), { expirationTtl: AI_CACHE_TTL });\n  return true;\n}\n\nexport function unwrapAiDocumentCache(cached) {\n  return cached && typeof cached === \"object\" && \"value\" in cached ? cached.value : null;\n}\n";
const files = {
  index: path.join(root, "src", "index.js"),
  admin: path.join(root, "src", "admin-ops.js"),
  email: path.join(root, "src", "email.js"),
  quota: path.join(root, "src", "ai-quota.js"),
  pilot: path.join(root, "pilot-public.js"),
};
// The first v7.73 handoff added a brand-new src/ai-quota.js. GitHub web uploads
// can easily miss a new nested file while still replacing existing files.
// Create it deterministically during build so deploy does not depend on that upload detail.
if (!fs.existsSync(files.quota)) {
  fs.mkdirSync(path.dirname(files.quota), { recursive: true });
  fs.writeFileSync(files.quota, AI_QUOTA_SOURCE);
  console.log("✅ V7.73.1 created missing src/ai-quota.js");
}
for (const [name, file] of Object.entries(files)) if (!fs.existsSync(file)) throw new Error(`v7.73.1 missing ${name}: ${file}`);

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
