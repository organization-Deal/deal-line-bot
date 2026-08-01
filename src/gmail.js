// Gmail OAuth + automatic invoice/receipt sync for beta users.
// Uses gmail.readonly only. Tokens are stored per tenant in Cloudflare KV.

import { getUserToken } from "./oauth.js";
import { processNormalizedEmail, notifyEmailRecords } from "./email.js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const _accessCache = new Map();

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function jsonParse(raw, fallback = {}) {
  try { return JSON.parse(raw || ""); } catch { return fallback; }
}

async function readMeta(env, tenant) {
  return jsonParse(await env.KV.get(`gmail:meta:${tenant}`), {});
}

async function writeMeta(env, tenant, patch = {}) {
  const current = await readMeta(env, tenant);
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await env.KV.put(`gmail:meta:${tenant}`, JSON.stringify(next));
  return next;
}

async function dashboardReturnUrl(env, tenant, status = "connected") {
  const base = String(env.DASHBOARD_URL || "").replace(/\/$/, "");
  const k = await env.KV.get(`dtoken:${tenant}`);
  if (!base || !k) return "";
  return `${base}/?tenant=${encodeURIComponent(tenant)}&k=${encodeURIComponent(k)}&page=email&gmail=${encodeURIComponent(status)}`;
}

export async function buildGmailConnectUrl(env, origin, tenant) {
  if (!env.GOOGLE_OAUTH_CLIENT_ID) throw new Error("GOOGLE_OAUTH_CLIENT_ID ยังไม่ได้ตั้ง");
  const state = randomState();
  await env.KV.put(`gmail:state:${state}`, JSON.stringify({
    tenant,
    createdAt: new Date().toISOString(),
    returnUrl: await dashboardReturnUrl(env, tenant),
  }), { expirationTtl: 600 });

  const p = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: `${origin}/gmail/callback`,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

function resultPage(title, message, href = "") {
  const button = href ? `<a href="${href}">กลับไปหน้าเอกสารจากอีเมล</a>` : "";
  return new Response(`<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f7;color:#1d1d1f;font-family:system-ui,-apple-system,sans-serif;padding:24px}.card{width:min(440px,100%);background:white;border:1px solid #e5e5e7;border-radius:24px;padding:32px;box-shadow:0 18px 50px rgba(0,0,0,.08);text-align:center}.mark{width:54px;height:54px;border-radius:16px;background:#111;color:#fff;display:grid;place-items:center;margin:0 auto 18px;font-size:24px;font-weight:800}h1{font-size:23px;margin:0 0 10px}p{font-size:14px;line-height:1.65;color:#6e6e73;margin:0 0 22px;white-space:pre-line}a{display:block;background:#111;color:#fff;padding:13px 16px;border-radius:13px;text-decoration:none;font-weight:700}</style><div class="card"><div class="mark">@</div><h1>${title}</h1><p>${message}</p>${button}</div></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function handleGmailCallback(env, url, origin) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateRaw = state ? await env.KV.get(`gmail:state:${state}`) : null;
  if (state) await env.KV.delete(`gmail:state:${state}`);
  const st = jsonParse(stateRaw, null);
  if (!code || !st?.tenant) return resultPage("เชื่อม Gmail ไม่สำเร็จ", "ลิงก์หมดอายุหรือข้อมูลไม่ครบ กรุณากลับไปกดเชื่อมใหม่จาก Dashboard");

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: `${origin}/gmail/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    const detail = (await tokenRes.text()).slice(0, 300);
    console.error("gmail oauth exchange", tokenRes.status, detail);
    return resultPage("เชื่อม Gmail ไม่สำเร็จ", "Google ไม่สามารถออกสิทธิ์ให้ระบบได้ กรุณาตรวจว่าบัญชีนี้ถูกเพิ่มเป็น Test user แล้วลองใหม่", st.returnUrl || "");
  }

  const tok = await tokenRes.json();
  const existingRefresh = await env.KV.get(`gmail:refresh:${st.tenant}`);
  const refresh = tok.refresh_token || existingRefresh;
  if (!refresh) return resultPage("เชื่อม Gmail ไม่สำเร็จ", "ไม่ได้รับ Refresh token กรุณายกเลิกสิทธิ์แอปในบัญชี Google แล้วกดเชื่อมใหม่", st.returnUrl || "");

  await env.KV.put(`gmail:refresh:${st.tenant}`, refresh);
  const profileRes = await fetch(`${API}/profile`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  const profile = profileRes.ok ? await profileRes.json() : {};
  const now = new Date().toISOString();
  await writeMeta(env, st.tenant, {
    connected: true,
    email: profile.emailAddress || "",
    connectedAt: now,
    lastError: "",
    reconnectRequired: false,
    betaTesting: true,
  });
  await env.KV.put(`gmailtenant:${st.tenant}`, "1");
  _accessCache.set(st.tenant, { token: tok.access_token, exp: Date.now() + (Number(tok.expires_in) || 3600) * 1000 });

  const back = st.returnUrl || await dashboardReturnUrl(env, st.tenant);
  if (back) return Response.redirect(back, 302);
  return resultPage("เชื่อม Gmail สำเร็จ", `เชื่อม ${profile.emailAddress || "บัญชี Google"} แล้ว ระบบจะค้นหาใบเสร็จและใบกำกับภาษีให้อัตโนมัติ`);
}

async function gmailAccessToken(env, tenant) {
  const cached = _accessCache.get(tenant);
  if (cached && cached.exp - 60000 > Date.now()) return cached.token;
  const refresh = await env.KV.get(`gmail:refresh:${tenant}`);
  if (!refresh) return null;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.error(`[gmail] refresh failed tenant=${tenant}`, res.status, detail);
    const invalid = /invalid_grant|expired|revoked/i.test(detail);
    await writeMeta(env, tenant, { lastError: detail, reconnectRequired: invalid, connected: !invalid });
    return null;
  }
  const j = await res.json();
  _accessCache.set(tenant, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}

export async function getGmailStatus(env, tenant) {
  const refresh = await env.KV.get(`gmail:refresh:${tenant}`);
  const meta = await readMeta(env, tenant);
  return {
    connected: !!refresh && meta.reconnectRequired !== true,
    email: meta.email || "",
    connectedAt: meta.connectedAt || "",
    lastSyncAt: meta.lastSyncAt || "",
    lastSyncCount: Number(meta.lastSyncCount || 0),
    lastCheckedCount: Number(meta.lastCheckedCount || 0),
    lastError: meta.lastError || "",
    reconnectRequired: meta.reconnectRequired === true,
    betaTesting: true,
    autoSync: true,
  };
}

export async function disconnectGmail(env, tenant) {
  const refresh = await env.KV.get(`gmail:refresh:${tenant}`);
  if (refresh) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }).catch(() => {});
  }
  await Promise.all([
    env.KV.delete(`gmail:refresh:${tenant}`),
    env.KV.delete(`gmail:meta:${tenant}`),
    env.KV.delete(`gmailtenant:${tenant}`),
  ]);
  _accessCache.delete(tenant);
  return { ok: true };
}

function base64UrlToBytes(value = "") {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeText(value = "") {
  const bytes = base64UrlToBytes(value);
  try { return new TextDecoder("utf-8").decode(bytes); } catch { return ""; }
}

function htmlToText(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function headerMap(headers = []) {
  const map = {};
  for (const h of headers || []) map[String(h.name || "").toLowerCase()] = String(h.value || "");
  return map;
}

const SUPPORTED = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

async function parseGmailMessage(token, message) {
  const headers = headerMap(message.payload?.headers);
  const texts = [];
  const htmls = [];
  const attachments = [];

  async function walk(part = {}) {
    const mimeType = String(part.mimeType || "").toLowerCase();
    const filename = String(part.filename || "");
    if (part.parts?.length) for (const child of part.parts) await walk(child);
    if (!part.body) return;

    if (filename && (SUPPORTED.has(mimeType) || /\.(pdf|jpe?g|png|webp|heic|heif)$/i.test(filename))) {
      let content = null;
      if (part.body.data) content = base64UrlToBytes(part.body.data);
      else if (part.body.attachmentId) {
        const r = await fetch(`${API}/messages/${message.id}/attachments/${part.body.attachmentId}`, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) content = base64UrlToBytes((await r.json()).data || "");
      }
      if (content?.byteLength) attachments.push({ filename, mimeType: mimeType || "application/octet-stream", content });
      return;
    }

    if (part.body.data && mimeType === "text/plain") texts.push(decodeText(part.body.data));
    if (part.body.data && mimeType === "text/html") htmls.push(decodeText(part.body.data));
  }

  await walk(message.payload || {});
  const text = texts.join("\n\n").trim() || htmlToText(htmls.join("\n"));
  return {
    subject: headers.subject || "",
    messageId: `gmail:${message.id}`,
    from: headers.from || "",
    recipient: headers.to || "",
    text: text.slice(0, 20000),
    receivedAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : new Date().toISOString(),
    attachments,
  };
}

function gmailQuery(meta, env) {
  const initialDays = Math.max(7, Math.min(90, Number(env.GMAIL_INITIAL_LOOKBACK_DAYS || 45)));
  const last = Date.parse(meta.lastSyncAt || "");
  const start = Number.isFinite(last) ? new Date(last - 2 * 86400000) : new Date(Date.now() - initialDays * 86400000);
  const y = start.getUTCFullYear();
  const m = String(start.getUTCMonth() + 1).padStart(2, "0");
  const d = String(start.getUTCDate()).padStart(2, "0");
  return `after:${y}/${m}/${d} {invoice receipt billing "tax invoice" "payment receipt" "ใบเสร็จ" "ใบกำกับภาษี" "ใบแจ้งหนี้" "ชำระเงิน" subscription renewal}`;
}

async function syncGmailAccountUnlocked(env, tenant, { maxMessages = 15, notify = true } = {}) {
  const access = await gmailAccessToken(env, tenant);
  if (!access) return { ok: false, reason: "not_connected_or_expired", ...(await getGmailStatus(env, tenant)) };
  const sheetId = (await env.KV.get(`tenant:${tenant}`)) || env.DEFAULT_SHEET_ID;
  if (!sheetId) return { ok: false, reason: "no_sheet" };
  const driveToken = await getUserToken(env, tenant);
  if (!driveToken) return { ok: false, reason: "google_drive_not_connected" };

  const meta = await readMeta(env, tenant);
  const q = gmailQuery(meta, env);
  const params = new URLSearchParams({ q, maxResults: String(Math.max(1, Math.min(30, Number(maxMessages) || 15))) });
  const listRes = await fetch(`${API}/messages?${params}`, { headers: { Authorization: `Bearer ${access}` } });
  if (!listRes.ok) {
    const detail = (await listRes.text()).slice(0, 300);
    await writeMeta(env, tenant, { lastError: detail });
    return { ok: false, reason: "gmail_list_failed", detail };
  }

  const list = await listRes.json();
  const records = [];
  let checked = 0;
  for (const ref of list.messages || []) {
    if (await env.KV.get(`gmailmsg:${tenant}:${ref.id}`)) continue;
    const msgRes = await fetch(`${API}/messages/${ref.id}?format=full`, { headers: { Authorization: `Bearer ${access}` } });
    if (!msgRes.ok) continue;
    checked++;
    const parsed = await parseGmailMessage(access, await msgRes.json());
    try {
      const made = await processNormalizedEmail(env, tenant, parsed, { notify: false });
      records.push(...made);
      await env.KV.put(`gmailmsg:${tenant}:${ref.id}`, "1", { expirationTtl: 180 * 86400 });
    } catch (e) {
      console.error(`[gmail] process tenant=${tenant} message=${ref.id}`, e);
    }
  }

  const now = new Date().toISOString();
  await writeMeta(env, tenant, {
    connected: true,
    lastSyncAt: now,
    lastSyncCount: records.length,
    lastCheckedCount: checked,
    lastError: "",
    reconnectRequired: false,
  });
  if (notify && records.length) await notifyEmailRecords(env, tenant, records, "ซิงก์จาก Gmail");
  console.log(`[gmail] tenant=${tenant} checked=${checked} records=${records.length}`);
  return { ok: true, checked, imported: records.length, lastSyncAt: now };
}

export async function syncGmailAccount(env, tenant, options = {}) {
  const lockKey = `gmail:sync_lock:${tenant}`;
  if (await env.KV.get(lockKey)) return { ok: false, reason: "sync_in_progress" };
  await env.KV.put(lockKey, "1", { expirationTtl: 180 });
  try {
    return await syncGmailAccountUnlocked(env, tenant, options);
  } finally {
    await env.KV.delete(lockKey).catch(() => {});
  }
}

export async function syncConnectedGmailAccounts(env, { limit = 5 } = {}) {
  const max = Math.max(1, Math.min(20, Number(limit) || 5));
  const cursor = await env.KV.get("gmail:cron_cursor");
  const listed = await env.KV.list({ prefix: "gmailtenant:", limit: max, ...(cursor ? { cursor } : {}) });
  let synced = 0;
  for (const key of listed.keys || []) {
    const tenant = key.name.slice("gmailtenant:".length);
    try {
      await syncGmailAccount(env, tenant, {
        maxMessages: Number(env.GMAIL_CRON_MAX_MESSAGES || 5),
        notify: true,
      });
      synced++;
    } catch (e) {
      console.error(`[gmail cron] tenant=${tenant}`, e);
    }
  }
  if (listed.list_complete) await env.KV.delete("gmail:cron_cursor");
  else if (listed.cursor) await env.KV.put("gmail:cron_cursor", listed.cursor);
  return { ok: true, synced, complete: listed.list_complete === true };
}
