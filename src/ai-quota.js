// AI document quota shared by LINE OCR + Email OCR.
// Customer-facing rule: one successfully processed document = one AI read.
// Automatic retries/fallbacks inside one OCR call do not consume extra quota.

export const AI_DOCUMENT_LIMITS = Object.freeze({
  free: 5,
  starter: 30, // customer-facing name = Lite; keep internal id for compatibility
  pro: 150,
  business: 1000,
});

const AI_USAGE_TTL = 60 * 60 * 24 * 120;
const AI_CACHE_TTL = 60 * 60 * 24 * 90;

function monthKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit",
    }).formatToParts(d);
    const y = parts.find(p => p.type === "year")?.value || "";
    const m = parts.find(p => p.type === "month")?.value || "";
    return y && m ? `${y}-${m}` : "";
  } catch {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
}

async function rootTenant(env, tenant) {
  return (await env.KV.get(`accountroot:v1:${tenant}`)) || tenant;
}

function aiEnforcementEnabled(env) {
  return !["0", "false", "off", "no"].includes(String(env.AI_QUOTA_ENFORCEMENT ?? "1").trim().toLowerCase());
}

export async function getAiQuotaState(env, tenant) {
  const root = await rootTenant(env, tenant);
  const rec = (await env.KV.get(`subscription:v1:${root}`, "json").catch(() => null)) || {};
  const now = Date.now();
  const trialEnd = Date.parse(rec.trialEndsAt || "");
  const betaActive = rec.status === "beta" && Number.isFinite(trialEnd) && trialEnd > now;
  const planId = betaActive
    ? "business"
    : (rec.status === "active" && AI_DOCUMENT_LIMITS[rec.plan] != null ? rec.plan : "free");
  const limit = betaActive
    ? Math.max(1, Number(env.BETA_TRIAL_AI_DOCUMENT_LIMIT || 100))
    : Number(AI_DOCUMENT_LIMITS[planId] || 0);
  const month = monthKey();
  const usageKey = `subaiusage:v1:${root}:${month}`;
  const usedRaw = await env.KV.get(usageKey);
  const used = Math.max(0, Number(usedRaw || 0) || 0);
  const blocked = Boolean(aiEnforcementEnabled(env) && limit > 0 && used >= limit);
  return { root, month, usageKey, used, limit, remaining: Math.max(0, limit - used), blocked, betaActive, planId };
}

export async function consumeAiDocument(env, tenant, amount = 1) {
  const state = await getAiQuotaState(env, tenant);
  const n = Math.max(1, Number(amount || 1));
  if (state.blocked || (aiEnforcementEnabled(env) && state.limit > 0 && state.used + n > state.limit)) {
    return { ...state, ok: false, blocked: true };
  }
  const next = state.used + n;
  await env.KV.put(state.usageKey, String(next), { expirationTtl: AI_USAGE_TTL });
  return { ...state, ok: true, used: next, remaining: Math.max(0, state.limit - next), blocked: next >= state.limit };
}

function cacheKey(root, kind, fingerprint) {
  const safeKind = String(kind || "document").replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "document";
  const safeHash = String(fingerprint || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 160);
  return safeHash ? `aicache:v1:${root}:${safeKind}:${safeHash}` : "";
}

export async function readAiDocumentCache(env, tenant, kind, fingerprint) {
  const root = await rootTenant(env, tenant);
  const key = cacheKey(root, kind, fingerprint);
  if (!key) return null;
  return env.KV.get(key, "json").catch(() => null);
}

export async function writeAiDocumentCache(env, tenant, kind, fingerprint, value) {
  const root = await rootTenant(env, tenant);
  const key = cacheKey(root, kind, fingerprint);
  if (!key) return false;
  await env.KV.put(key, JSON.stringify({ value, savedAt: new Date().toISOString() }), { expirationTtl: AI_CACHE_TTL });
  return true;
}

export function unwrapAiDocumentCache(cached) {
  return cached && typeof cached === "object" && "value" in cached ? cached.value : null;
}
