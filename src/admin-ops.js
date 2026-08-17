import { readSettings, readExpenses } from "./sheets.js";
import { getUserToken } from "./oauth.js";
import { getGmailStatus, syncGmailAccount } from "./gmail.js";
import { getBatchDashboard } from "./batches.js";
import { AI_DOCUMENT_LIMITS, getAiQuotaState } from "./ai-quota.js";

const PLAN_CATALOG = Object.freeze({
  free:     { id: "free",     name: "ฟรี",     monthly: 0,    annual: 0,     documentLimit: 20,   aiDocumentLimit: AI_DOCUMENT_LIMITS.free,     businessLimit: 1 },
  starter:  { id: "starter",  name: "Lite",    monthly: 199,  annual: 1990,  documentLimit: 200,  aiDocumentLimit: AI_DOCUMENT_LIMITS.starter,  businessLimit: 1 },
  pro:      { id: "pro",      name: "Pro",     monthly: 399,  annual: 3990,  documentLimit: 1000, aiDocumentLimit: AI_DOCUMENT_LIMITS.pro,      businessLimit: 1 },
  business: { id: "business", name: "Business",monthly: 1290, annual: 12900, documentLimit: 3000, aiDocumentLimit: AI_DOCUMENT_LIMITS.business, businessLimit: 2 },
});

const TRIAL_DAYS = 30;
const TRIAL_DOCUMENT_LIMIT = 1000;
const TRIAL_AI_DOCUMENT_LIMIT = 100;
const ERROR_TTL = 60 * 60 * 24 * 14;
const AUDIT_TTL = 60 * 60 * 24 * 365;

function clean(v, max = 500) { return String(v ?? "").trim().slice(0, max); }
function nowIso() { return new Date().toISOString(); }
function reverseTimeKey(ms = Date.now()) { return String(9999999999999 - ms).padStart(13, "0"); }
function monthKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).formatToParts(d);
    const y = parts.find(p => p.type === "year")?.value || "";
    const m = parts.find(p => p.type === "month")?.value || "";
    return y && m ? `${y}-${m}` : "";
  } catch {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
}
function json(data, status = 200, env = null) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  if (env?.DASHBOARD_URL) {
    try { headers.set("Access-Control-Allow-Origin", new URL(env.DASHBOARD_URL).origin); } catch {}
  }
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}
function adminOk(env, url) { return !!env.ADMIN_KEY && clean(url.searchParams.get("key"), 300) === clean(env.ADMIN_KEY, 300); }

// ADMIN_PIN_SESSION_V7_57_20260816
const ADMIN_SESSION_TTL = 60 * 60 * 8;
const ADMIN_PIN_WINDOW = 60 * 15;
const ADMIN_PIN_MAX_ATTEMPTS = 8;

function safeTextEqual(a,b){
  a=String(a??""); b=String(b??"");
  if(a.length!==b.length)return false;
  let diff=0;
  for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
function adminSessionToken(request){
  const auth=String(request.headers.get("authorization")||"").trim();
  if(!auth.toLowerCase().startsWith("bearer "))return "";
  return clean(auth.slice(7),180);
}
async function adminSessionOk(env,request){
  const token=adminSessionToken(request);
  if(!token)return false;
  const rec=await env.KV.get(`adminsession:v1:${token}`,"json").catch(()=>null);
  return !!rec?.active;
}
async function adminRateKey(request){
  const ip=String(request.headers.get("CF-Connecting-IP")||"unknown").trim().slice(0,120);
  const bytes=new TextEncoder().encode(ip);
  const hash=await crypto.subtle.digest("SHA-256",bytes);
  const hex=[...new Uint8Array(hash)].slice(0,12).map(b=>b.toString(16).padStart(2,"0")).join("");
  return `adminpin:fail:v1:${hex}`;
}
async function adminPinLogin(request,env){
  const expected=String(env.ADMIN_PIN||"").trim();
  if(!/^\d{6}$/.test(expected)){
    return json({ok:false,error:"admin_pin_not_configured",message:"ยังไม่ได้ตั้ง ADMIN_PIN 6 หลักใน Cloudflare Runtime Secret"},503,env);
  }

  const rateKey=await adminRateKey(request);
  const attempts=Number(await env.KV.get(rateKey))||0;
  if(attempts>=ADMIN_PIN_MAX_ATTEMPTS){
    return json({ok:false,error:"too_many_attempts",message:"ลองรหัสผิดหลายครั้ง กรุณารอ 15 นาที"},429,env);
  }

  let body={};
  try{body=await request.json();}catch{}
  const pin=String(body?.pin||"").replace(/\D/g,"").slice(0,6);
  if(!/^\d{6}$/.test(pin)||!safeTextEqual(pin,expected)){
    await env.KV.put(rateKey,String(attempts+1),{expirationTtl:ADMIN_PIN_WINDOW});
    return json({ok:false,error:"invalid_pin",message:"รหัส 6 หลักไม่ถูกต้อง"},401,env);
  }

  await env.KV.delete(rateKey).catch(()=>{});
  const session=(crypto.randomUUID()+crypto.randomUUID()).replace(/-/g,"");
  await env.KV.put(`adminsession:v1:${session}`,JSON.stringify({
    active:true,
    createdAt:nowIso(),
    userAgent:clean(request.headers.get("user-agent"),220),
  }),{expirationTtl:ADMIN_SESSION_TTL});

  return json({ok:true,session,expiresIn:ADMIN_SESSION_TTL},200,env);
}
async function adminPinLogout(request,env){
  const token=adminSessionToken(request);
  if(token)await env.KV.delete(`adminsession:v1:${token}`).catch(()=>{});
  return json({ok:true},200,env);
}

async function listAllKeys(env, prefix, max = 5000) {
  const out = [];
  let cursor;
  let rounds = 0;
  do {
    const page = await env.KV.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    out.push(...(page.keys || []));
    if (page.list_complete || out.length >= max) break;
    cursor = page.cursor;
    rounds++;
  } while (cursor && rounds < 10);
  return out.slice(0, max);
}

async function kvJson(env, key, fallback = null) {
  return (await env.KV.get(key, "json").catch(() => null)) ?? fallback;
}

function parsePaymentChannels(settings = {}) {
  const raw = settings.payment_channels;
  let rows = [];
  if (Array.isArray(raw)) rows = raw;
  else if (raw) { try { rows = JSON.parse(raw); } catch {} }
  if (!Array.isArray(rows)) rows = [];
  return rows.filter(item => !["false","0","no","off","inactive","ปิด"].includes(String(item?.active ?? "true").trim().toLowerCase()));
}

function setupSummary(settings = {}, gmail = {}) {
  const missing = [];
  if (!clean(settings.company_name)) missing.push("ชื่อบริษัท");
  if (!clean(settings.tax_id)) missing.push("เลขผู้เสียภาษี");
  if (!clean(settings.approver_name)) missing.push("ผู้อนุมัติ");
  if (!clean(settings.logo_url || settings.company_logo_url || settings.logoUrl)) missing.push("โลโก้");
  if (!clean(settings.approver_sign_url || settings.approverSignUrl || settings.approver_signature_url || settings.signature_url)) missing.push("ลายเซ็น");
  if (!parsePaymentChannels(settings).length) missing.push("ช่องทางการเงิน");
  return {
    documentsReady: !missing.some(x => ["ชื่อบริษัท","เลขผู้เสียภาษี","ผู้อนุมัติ","โลโก้","ลายเซ็น"].includes(x)),
    financeReady: !missing.includes("ช่องทางการเงิน"),
    gmailReady: gmail.connected === true,
    ready: missing.length === 0,
    missing,
  };
}

async function rootFor(env, tenant) {
  return (await env.KV.get(`accountroot:v1:${tenant}`)) || tenant;
}

async function accountFor(env, root) {
  const raw = await kvJson(env, `businessaccount:v1:${root}`, null);
  const businesses = Array.from(new Set([root, ...(Array.isArray(raw?.businesses) ? raw.businesses : [])].filter(Boolean)));
  return { ...(raw || {}), rootTenant: root, businesses };
}

function trialEndFromStart(start) {
  const ms = Date.parse(start || "");
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + TRIAL_DAYS * 86400000).toISOString();
}

async function rawSubscription(env, root, { normalize = true } = {}) {
  let rec = await kvJson(env, `subscription:v1:${root}`, null);
  if (!rec || typeof rec !== "object") return { exists: false, status: "not_started", plan: "", effectivePlan: "", planName: "ยังไม่เริ่ม Trial", betaActive: false, daysRemaining: 0, trialStartedAt: "", trialEndsAt: "" };

  const now = Date.now();
  if (normalize && rec.status === "beta") {
    const started = rec.trialStartedAt || rec.createdAt || "";
    const expectedEnd = trialEndFromStart(started);
    const endMs = Date.parse(expectedEnd || rec.trialEndsAt || "");
    const patch = {};
    if (rec.plan !== "business") patch.plan = "business";
    if (expectedEnd && rec.trialEndsAt !== expectedEnd) patch.trialEndsAt = expectedEnd;
    if (Object.keys(patch).length) {
      rec = { ...rec, ...patch, trialMode: "business_30d", updatedAt: nowIso() };
      await env.KV.put(`subscription:v1:${root}`, JSON.stringify(rec));
    }
    if (Number.isFinite(endMs) && endMs <= now) {
      rec = { ...rec, status: "free", plan: "free", betaEndedAt: nowIso(), updatedAt: nowIso() };
      await env.KV.put(`subscription:v1:${root}`, JSON.stringify(rec));
    }
  }

  const endMs = Date.parse(rec.trialEndsAt || "");
  const betaActive = rec.status === "beta" && Number.isFinite(endMs) && endMs > now;
  const effectivePlan = betaActive ? "business" : (rec.status === "active" && PLAN_CATALOG[rec.plan] ? rec.plan : "free");
  const plan = PLAN_CATALOG[effectivePlan] || PLAN_CATALOG.free;
  return {
    exists: true,
    ...rec,
    status: betaActive ? "beta" : (rec.status === "active" ? "active" : "free"),
    betaActive,
    effectivePlan,
    planName: betaActive ? "ทดลองใช้ Business ฟรี" : plan.name,
    trialStartedAt: rec.trialStartedAt || rec.createdAt || "",
    trialEndsAt: rec.trialEndsAt || "",
    daysRemaining: betaActive ? Math.max(1, Math.ceil((endMs - now) / 86400000)) : 0,
    documentLimit: betaActive ? TRIAL_DOCUMENT_LIMIT : plan.documentLimit,
    aiDocumentLimit: betaActive ? TRIAL_AI_DOCUMENT_LIMIT : plan.aiDocumentLimit,
    businessLimit: plan.businessLimit,
    priceMonthly: plan.monthly,
    priceAnnual: plan.annual,
  };
}

async function cachedUsage(env, root) {
  const month = monthKey();
  const raw = await env.KV.get(`subusage:v1:${root}:${month}`);
  const documents = Number(raw || 0);
  return { month, documents: Number.isFinite(documents) && documents >= 0 ? documents : 0 };
}

async function refreshUsage(env, root, account = null) {
  const acc = account || await accountFor(env, root);
  let documents = 0;
  for (const tenant of acc.businesses) {
    const sheetId = await env.KV.get(`tenant:${tenant}`);
    if (!sheetId) continue;
    const token = await getUserToken(env, tenant).catch(() => null);
    if (!token) continue;
    const rows = await readExpenses(env, sheetId, token).catch(() => []);
    documents += rows.filter(row => monthKey(row?.createdAt || row?.recordedAt || row?.submittedAt || row?.dateISO || row?.date || "") === monthKey()).length;
  }
  await env.KV.put(`subusage:v1:${root}:${monthKey()}`, String(documents), { expirationTtl: 60 * 60 * 24 * 120 });
  return { month: monthKey(), documents };
}

async function customerRoots(env) {
  const tenantKeys = await listAllKeys(env, "tenant:", 5000);
  const roots = new Set();
  for (const key of tenantKeys) {
    const tenant = key.name.slice("tenant:".length);
    if (tenant) roots.add(await rootFor(env, tenant));
  }
  return [...roots];
}

async function summarizeWorkflow(env, tenant, sheetId, token) {
  if (!sheetId || !token) return { available: false, pendingItems: 0, pendingTotal: 0, batches: 0, review: 0, payment: 0, paid: 0, correction: 0 };
  try {
    const data = await getBatchDashboard(env, sheetId, token);
    const batches = Array.isArray(data?.batches) ? data.batches : [];
    const statusText = b => clean(b.workflowStep || b.status || b.batchStatus || "", 80);
    return {
      available: true,
      pendingItems: Number(data?.pending?.itemCount || 0),
      pendingTotal: Number(data?.pending?.total || 0),
      batches: batches.length,
      review: batches.filter(b => /review|รอตรวจ/.test(statusText(b))).length,
      payment: batches.filter(b => /payment|รอโอน|รอหลักฐาน/.test(statusText(b))).length,
      paid: batches.filter(b => /paid|จ่ายแล้ว/.test(statusText(b))).length,
      correction: batches.filter(b => /correction|แก้ไข|ตีกลับ|rejected/.test(statusText(b))).length,
    };
  } catch (e) {
    return { available: false, error: clean(e?.message || e, 200), pendingItems: 0, pendingTotal: 0, batches: 0, review: 0, payment: 0, paid: 0, correction: 0 };
  }
}

async function customerSummary(env, root, { deep = false, refresh = false } = {}) {
  const account = await accountFor(env, root);
  const sheetId = await env.KV.get(`tenant:${root}`);
  const googleConnected = !!(await env.KV.get(`gtoken:${root}`));
  const hasDashToken = !!(await env.KV.get(`dtoken:${root}`));
  const meta = await kvJson(env, `businessmeta:v1:${root}`, {});
  const gmail = await getGmailStatus(env, root).catch(() => ({ connected: false, reconnectRequired: false, lastError: "" }));
  const subscription = await rawSubscription(env, root);
  const usage = refresh ? await refreshUsage(env, root, account) : await cachedUsage(env, root);
  const aiQuota = await getAiQuotaState(env, root);
  const limit = Number(subscription.documentLimit || 0);
  const percent = limit ? Math.min(999, Math.round((usage.documents / limit) * 100)) : 0;
  const aiLimit = Number(subscription.aiDocumentLimit || aiQuota.limit || 0);
  const aiPercent = aiLimit ? Math.min(999, Math.round((Number(aiQuota.used || 0) / aiLimit) * 100)) : 0;

  let settings = {};
  let workflow = null;
  if (sheetId && googleConnected) {
    const token = await getUserToken(env, root).catch(() => null);
    if (token) {
      settings = await readSettings(env, sheetId, token).catch(() => ({}));
      if (deep) workflow = await summarizeWorkflow(env, root, sheetId, token);
    }
  }
  const setup = setupSummary(settings, gmail);
  const companyName = clean(settings.company_name || meta.name || "") || `Tenant ${root.slice(0, 8)}`;
  const note = await kvJson(env, `adminnote:v1:${root}`, {});

  let attention = "ok";
  const reasons = [];
  if (!googleConnected) { attention = "critical"; reasons.push("Google ไม่เชื่อม"); }
  if (gmail.reconnectRequired) { attention = "critical"; reasons.push("Gmail ต้องเชื่อมใหม่"); }
  else if (!gmail.connected) { if (attention === "ok") attention = "warning"; reasons.push("Gmail ยังไม่เชื่อม"); }
  if (subscription.betaActive && subscription.daysRemaining <= 7) { if (attention === "ok") attention = "warning"; reasons.push(`Trial เหลือ ${subscription.daysRemaining} วัน`); }
  if (percent >= 100) { attention = "critical"; reasons.push("โควตาเต็ม"); }
  else if (percent >= 80) { if (attention === "ok") attention = "warning"; reasons.push(`ใช้โควตา ${percent}%`); }
  if (setup.ready === false) { if (attention === "ok") attention = "warning"; reasons.push("ตั้งค่าบริษัทไม่ครบ"); }
  if (deep && workflow?.correction > 0) { if (attention === "ok") attention = "warning"; reasons.push(`ต้องแก้ไข ${workflow.correction}`); }

  return {
    rootTenant: root,
    companyName,
    sheetId: sheetId || "",
    businessCount: account.businesses.length,
    businesses: account.businesses,
    googleConnected,
    hasDashToken,
    gmail: {
      connected: gmail.connected === true,
      email: gmail.email || "",
      reconnectRequired: gmail.reconnectRequired === true,
      lastSyncAt: gmail.lastSyncAt || "",
      lastSyncCount: Number(gmail.lastSyncCount || 0),
      lastError: clean(gmail.lastError || "", 300),
    },
    subscription,
    usage: { ...usage, percent },
    aiUsage: { month: aiQuota.month, documents: Number(aiQuota.used || 0), limit: aiLimit, percent: aiPercent, remaining: Math.max(0, aiLimit - Number(aiQuota.used || 0)) },
    setup,
    workflow,
    attention,
    attentionReasons: reasons,
    adminNote: note.note || "",
    updatedAt: meta.updatedAt || meta.createdAt || subscription.updatedAt || subscription.createdAt || "",
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function listCustomers(env, { deep = false, refresh = false } = {}) {
  const roots = await customerRoots(env);
  const rows = await mapLimit(roots, 5, root => customerSummary(env, root, { deep, refresh }));
  return rows.sort((a, b) => {
    const score = { critical: 0, warning: 1, ok: 2 };
    return (score[a.attention] ?? 3) - (score[b.attention] ?? 3) || String(a.companyName).localeCompare(String(b.companyName), "th");
  });
}

async function listPilotRequests(env) {
  const keys = await listAllKeys(env, "pilotreq:v1:", 2000);
  const rows = [];
  for (const key of keys) {
    const rec = await kvJson(env, key.name, null);
    if (rec) rows.push(rec);
  }
  rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return rows;
}

async function writeAdminAudit(env, action, tenant, detail = {}) {
  const at = Date.now();
  const rec = { id: crypto.randomUUID(), action: clean(action, 80), tenant: clean(tenant, 180), detail, createdAt: new Date(at).toISOString() };
  await env.KV.put(`adminaudit:v1:${reverseTimeKey(at)}:${rec.id}`, JSON.stringify(rec), { expirationTtl: AUDIT_TTL });
  return rec;
}

export async function recordOpsError(env, { area = "unknown", tenant = "", error = "", meta = {} } = {}) {
  try {
    const at = Date.now();
    const message = clean(error?.message || error || "unknown error", 600);
    const rec = { id: crypto.randomUUID(), area: clean(area, 100), tenant: clean(tenant, 180), message, meta, createdAt: new Date(at).toISOString() };
    await Promise.all([
      env.KV.put(`opserror:v1:${reverseTimeKey(at)}:${rec.id}`, JSON.stringify(rec), { expirationTtl: ERROR_TTL }),
      env.KV.put(`opshealth:v1:${clean(area, 100)}`, JSON.stringify({ status: "error", lastErrorAt: rec.createdAt, lastError: message, tenant: rec.tenant, updatedAt: rec.createdAt }), { expirationTtl: ERROR_TTL }),
    ]);
  } catch {}
}

export async function recordOpsHeartbeat(env, name, data = {}) {
  try {
    const at = nowIso();
    await env.KV.put(`opsheartbeat:v1:${clean(name, 100)}`, JSON.stringify({ name: clean(name, 100), at, ...data }), { expirationTtl: 60 * 60 * 24 * 7 });
  } catch {}
}

async function listRecent(env, prefix, limit = 100) {
  const listed = await env.KV.list({ prefix, limit: Math.min(1000, Math.max(1, Number(limit) || 100)) });
  const rows = [];
  for (const key of listed.keys || []) {
    const rec = await kvJson(env, key.name, null);
    if (rec) rows.push(rec);
  }
  return rows;
}

async function healthSnapshot(env, customers = null) {
  const rows = customers || await listCustomers(env, { deep: false, refresh: false });
  const cron = await kvJson(env, "opsheartbeat:v1:cron", null);
  const cronMs = Date.parse(cron?.at || "");
  const cronStale = !Number.isFinite(cronMs) || Date.now() - cronMs > 3 * 60 * 1000;
  const recentErrors = await listRecent(env, "opserror:v1:", 50);
  const errors24h = recentErrors.filter(r => Date.now() - Date.parse(r.createdAt || 0) <= 86400000).length;
  return {
    worker: { status: "ok", checkedAt: nowIso() },
    cron: { status: cronStale ? "warning" : "ok", lastRunAt: cron?.at || "", detail: cron || {} },
    line: { status: env.LINE_ACCESS_TOKEN && env.LINE_CHANNEL_SECRET ? "ok" : "critical", configured: !!(env.LINE_ACCESS_TOKEN && env.LINE_CHANNEL_SECRET) },
    google: { status: rows.some(r => !r.googleConnected) ? "warning" : "ok", connected: rows.filter(r => r.googleConnected).length, total: rows.length },
    gmail: { status: rows.some(r => r.gmail.reconnectRequired) ? "critical" : rows.some(r => !r.gmail.connected) ? "warning" : "ok", connected: rows.filter(r => r.gmail.connected).length, reconnect: rows.filter(r => r.gmail.reconnectRequired).length, total: rows.length },
    ocr: { status: env.CLAUDE_KEY ? "ok" : "critical", configured: !!env.CLAUDE_KEY, model: env.CLAUDE_MODEL || "" },
    errors: { status: errors24h ? "warning" : "ok", last24h: errors24h, recent: recentErrors.slice(0, 8) },
  };
}

async function overview(env) {
  const customers = await listCustomers(env, { deep: false, refresh: false });
  const pilots = await listPilotRequests(env);
  const health = await healthSnapshot(env, customers);
  const counts = {
    customers: customers.length,
    trial: customers.filter(r => r.subscription.betaActive).length,
    paid: customers.filter(r => r.subscription.status === "active").length,
    free: customers.filter(r => r.subscription.status === "free").length,
    notStarted: customers.filter(r => r.subscription.status === "not_started").length,
    trial7: customers.filter(r => r.subscription.betaActive && r.subscription.daysRemaining <= 7).length,
    quota80: customers.filter(r => r.usage.percent >= 80).length,
    attention: customers.filter(r => r.attention !== "ok").length,
    pilotPending: pilots.filter(r => !["converted","rejected"].includes(r.status)).length,
    gmailReconnect: customers.filter(r => r.gmail.reconnectRequired).length,
  };
  return { ok: true, generatedAt: nowIso(), counts, health, attention: customers.filter(r => r.attention !== "ok").slice(0, 12), pilotLatest: pilots.slice(0, 8) };
}

async function action(env, body) {
  const actionName = clean(body.action, 80);
  const tenant = clean(body.tenant, 180);
  if (!actionName) return { ok: false, error: "missing_action" };

  if (actionName === "pilot_status") {
    const id = clean(body.id, 220);
    const key = `pilotreq:v1:${id}`;
    const rec = await kvJson(env, key, null);
    if (!rec) return { ok: false, error: "pilot_not_found" };
    const allowed = new Set(["pending_google_test_user","google_test_user_added","contacted","onboarding","trial_started","converted","rejected"]);
    const status = allowed.has(clean(body.status, 80)) ? clean(body.status, 80) : rec.status;
    const next = { ...rec, status, adminNote: clean(body.note, 1000) || rec.adminNote || "", updatedAt: nowIso() };
    await env.KV.put(key, JSON.stringify(next), { expirationTtl: 60 * 60 * 24 * 365 });
    await writeAdminAudit(env, "PILOT_STATUS", "", { id, status });
    return { ok: true, record: next };
  }

  if (!tenant) return { ok: false, error: "missing_tenant" };
  const root = await rootFor(env, tenant);

  if (actionName === "activate_plan") {
    const plan = PLAN_CATALOG[body.plan] ? body.plan : "";
    if (!plan || plan === "free") return { ok: false, error: "invalid_paid_plan" };
    const current = await kvJson(env, `subscription:v1:${root}`, {});
    const next = { ...current, schema: "SUBSCRIPTION_V1_20260807", status: "active", plan, cycle: body.cycle === "annual" ? "annual" : "monthly", activatedAt: nowIso(), updatedAt: nowIso(), requestedPlan: "", requestedCycle: "", upgradeRequestedAt: "" };
    if (!next.createdAt) next.createdAt = nowIso();
    await env.KV.put(`subscription:v1:${root}`, JSON.stringify(next));
    await writeAdminAudit(env, "ACTIVATE_PLAN", root, { plan, cycle: next.cycle });
    return { ok: true, subscription: await rawSubscription(env, root) };
  }

  if (actionName === "set_free") {
    const current = await kvJson(env, `subscription:v1:${root}`, {});
    const next = { ...current, schema: "SUBSCRIPTION_V1_20260807", status: "free", plan: "free", updatedAt: nowIso() };
    if (!next.createdAt) next.createdAt = nowIso();
    await env.KV.put(`subscription:v1:${root}`, JSON.stringify(next));
    await writeAdminAudit(env, "SET_FREE", root, {});
    return { ok: true, subscription: await rawSubscription(env, root) };
  }

  if (actionName === "extend_trial") {
    const days = Math.max(1, Math.min(90, Number(body.days || 7)));
    const current = await kvJson(env, `subscription:v1:${root}`, {});
    const baseMs = Math.max(Date.now(), Date.parse(current.trialEndsAt || "") || 0);
    const start = current.trialStartedAt || current.createdAt || nowIso();
    const next = { ...current, schema: "SUBSCRIPTION_V1_20260807", status: "beta", plan: "business", trialMode: "business_30d", trialStartedAt: start, trialEndsAt: new Date(baseMs + days * 86400000).toISOString(), updatedAt: nowIso() };
    if (!next.createdAt) next.createdAt = start;
    await env.KV.put(`subscription:v1:${root}`, JSON.stringify(next));
    await writeAdminAudit(env, "EXTEND_TRIAL", root, { days, trialEndsAt: next.trialEndsAt });
    return { ok: true, subscription: await rawSubscription(env, root) };
  }

  if (actionName === "reset_dashboard_link") {
    const target = tenant || root;
    const token = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
    await env.KV.put(`dtoken:${target}`, token);
    const base = clean(env.DASHBOARD_URL, 500).replace(/\/$/, "");
    const dashboardUrl = base ? `${base}?tenant=${encodeURIComponent(target)}&k=${encodeURIComponent(token)}` : "";
    await writeAdminAudit(env, "RESET_DASHBOARD_LINK", target, {});
    return { ok: true, dashboardUrl };
  }

  if (actionName === "sync_gmail") {
    const result = await syncGmailAccount(env, root, { maxMessages: Math.max(1, Math.min(30, Number(body.maxMessages || 10))), notify: false });
    await writeAdminAudit(env, "SYNC_GMAIL", root, { ok: result?.ok !== false, count: result?.processed || result?.synced || result?.count || 0 });
    return { ok: true, result, gmail: await getGmailStatus(env, root) };
  }

  if (actionName === "refresh_usage") {
    const account = await accountFor(env, root);
    const usage = await refreshUsage(env, root, account);
    await writeAdminAudit(env, "REFRESH_USAGE", root, usage);
    return { ok: true, usage };
  }

  if (actionName === "save_note") {
    const note = clean(body.note, 3000);
    await env.KV.put(`adminnote:v1:${root}`, JSON.stringify({ note, updatedAt: nowIso() }));
    await writeAdminAudit(env, "SAVE_NOTE", root, { note: note.slice(0, 300) });
    return { ok: true, note };
  }

  return { ok: false, error: "unknown_action" };
}

export async function handleAdminOps(request, env, url) {
  const path = url.pathname;

  if (request.method === "POST" && path === "/admin/ops/login") {
    return adminPinLogin(request, env);
  }
  if (request.method === "POST" && path === "/admin/ops/logout") {
    return adminPinLogout(request, env);
  }

  const sessionOk = await adminSessionOk(env, request);
  const legacyKeyOk = adminOk(env, url);
  if (!sessionOk && !legacyKeyOk) {
    return json({ ok: false, error: "unauthorized", message: "Admin session หมดอายุหรือยังไม่ได้เข้าสู่ระบบ" }, 401, env);
  }

  try {
    if (request.method === "GET" && path === "/admin/ops/overview") return json(await overview(env), 200, env);
    if (request.method === "GET" && path === "/admin/ops/customers") {
      const deep = url.searchParams.get("deep") === "1";
      const refresh = url.searchParams.get("refresh") === "1";
      return json({ ok: true, rows: await listCustomers(env, { deep, refresh }), generatedAt: nowIso() }, 200, env);
    }
    if (request.method === "GET" && path === "/admin/ops/customer") {
      const tenant = clean(url.searchParams.get("tenant"), 180);
      if (!tenant) return json({ ok: false, error: "missing_tenant" }, 400, env);
      const root = await rootFor(env, tenant);
      const row = await customerSummary(env, root, { deep: true, refresh: url.searchParams.get("refresh") === "1" });
      const businesses = [];
      for (const businessTenant of row.businesses) {
        const sheetId = await env.KV.get(`tenant:${businessTenant}`);
        const meta = await kvJson(env, `businessmeta:v1:${businessTenant}`, {});
        const dtoken = await env.KV.get(`dtoken:${businessTenant}`);
        const base = clean(env.DASHBOARD_URL, 500).replace(/\/$/, "");
        businesses.push({ tenant: businessTenant, sheetId: sheetId || "", name: meta.name || (businessTenant === root ? row.companyName : ""), dashboardUrl: base && dtoken ? `${base}?tenant=${encodeURIComponent(businessTenant)}&k=${encodeURIComponent(dtoken)}` : "" });
      }
      return json({ ok: true, customer: { ...row, businessesDetail: businesses } }, 200, env);
    }
    if (request.method === "GET" && path === "/admin/ops/pilot") return json({ ok: true, rows: await listPilotRequests(env) }, 200, env);
    if (request.method === "GET" && path === "/admin/ops/errors") return json({ ok: true, rows: await listRecent(env, "opserror:v1:", Number(url.searchParams.get("limit") || 100)) }, 200, env);
    if (request.method === "GET" && path === "/admin/ops/audit") return json({ ok: true, rows: await listRecent(env, "adminaudit:v1:", Number(url.searchParams.get("limit") || 200)) }, 200, env);
    if (request.method === "GET" && path === "/admin/ops/health") return json({ ok: true, health: await healthSnapshot(env) }, 200, env);
    if (request.method === "POST" && path === "/admin/ops/action") {
      const body = await request.json().catch(() => ({}));
      const out = await action(env, body);
      return json(out, out.ok ? 200 : 400, env);
    }
    return json({ ok: false, error: "not_found" }, 404, env);
  } catch (e) {
    await recordOpsError(env, { area: "admin_ops", error: e });
    return json({ ok: false, error: clean(e?.message || e, 500) }, 500, env);
  }
}
