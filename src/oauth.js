// OAuth ของลูกค้า — v1.3
// เปลี่ยนจาก v1.2:
//   • เชื่อมเสร็จ push การ์ดกลับเข้า LINE (callback มาจาก browser ไม่มี replyToken ต้อง push)
//   • ไม่สร้างชีทใหม่ถ้ามีอยู่แล้ว (กันข้อมูลหายตอนเชื่อมซ้ำ)
//   • ล้าง flag setup ตอนเชื่อม เพื่อให้เช็คข้อมูลบริษัทใหม่รอบหน้า

import { HEADER, readSettings } from "./sheets.js";
import { ensureTenantDriveFolders } from "./drive-folders.js";

const SCOPE = "openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets";
const _utok = {};
const DRIVE = "https://www.googleapis.com/drive/v3";

function settingsReady(settings = {}) {
  return !!(settings.company_name && settings.tax_id && settings.approver_name);
}

function configuredBusiness(settings = {}) {
  return !!(settings.company_name || settings.tax_id || settings.approver_name);
}

async function googleDriveIdentity(token) {
  if (!token) return null;
  try {
    const fields = encodeURIComponent("user(displayName,emailAddress,permissionId)");
    const res = await fetch(`${DRIVE}/about?fields=${fields}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const user = (await res.json()).user || {};
    return {
      displayName: String(user.displayName || ""),
      email: String(user.emailAddress || "").trim().toLowerCase(),
      permissionId: String(user.permissionId || ""),
    };
  } catch (error) {
    console.warn("googleDriveIdentity", error?.message || error);
    return null;
  }
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function identityTenantKeys(identity = {}) {
  const keys = [];
  if (identity.permissionId) keys.push(`googleperm:${identity.permissionId}`);
  if (identity.email) keys.push(`googlemail:${await sha256Hex(identity.email)}`);
  return keys;
}

async function mappedTenantForIdentity(env, identity) {
  for (const key of await identityTenantKeys(identity)) {
    const tenant = await env.KV.get(key);
    if (tenant) return tenant;
  }
  return "";
}

async function rememberIdentityTenant(env, identity, tenant) {
  if (!tenant) return;
  for (const key of await identityTenantKeys(identity)) {
    await env.KV.put(key, tenant);
  }
}

async function listTenantSheetOwners(env) {
  const out = new Map();
  let cursor = undefined;
  let pages = 0;
  do {
    const page = await env.KV.list({ prefix: "tenant:", cursor, limit: 1000 });
    for (const item of page.keys || []) {
      const tenant = item.name.slice("tenant:".length);
      const sheetId = await env.KV.get(item.name);
      if (sheetId && !out.has(sheetId)) out.set(sheetId, tenant);
    }
    cursor = page.list_complete ? undefined : page.cursor;
    pages += 1;
  } while (cursor && pages < 5);
  return out;
}

async function listAppSpreadsheets(token) {
  if (!token) return [];
  try {
    const params = new URLSearchParams({
      q: "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
      pageSize: "100",
      orderBy: "modifiedTime desc",
      fields: "files(id,name,modifiedTime,createdTime,parents)",
      spaces: "drive",
    });
    const res = await fetch(`${DRIVE}/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    return (await res.json()).files || [];
  } catch (error) {
    console.warn("listAppSpreadsheets", error?.message || error);
    return [];
  }
}

async function inspectBusinessSheet(env, token, file, owner = "") {
  const settings = await readSettings(env, file.id, token).catch(() => ({}));
  return {
    sheetId: file.id,
    name: file.name || "",
    modifiedTime: file.modifiedTime || "",
    owner,
    settings,
    configured: configuredBusiness(settings),
    ready: settingsReady(settings),
  };
}

async function discoverExistingBusiness(env, token, state, currentSheetId = "", identity = null) {
  const owners = await listTenantSheetOwners(env);
  const mappedTenant = await mappedTenantForIdentity(env, identity);
  const mappedSheetId = mappedTenant ? await env.KV.get(`tenant:${mappedTenant}`) : "";

  const files = await listAppSpreadsheets(token);
  const byId = new Map(files.map((file) => [file.id, file]));
  for (const id of [currentSheetId, mappedSheetId]) {
    if (id && !byId.has(id)) byId.set(id, { id, name: "", modifiedTime: "" });
  }

  const ordered = Array.from(byId.values()).sort((a, b) => {
    const priority = (file) => file.id === mappedSheetId ? 0 : file.id === currentSheetId ? 1 : 2;
    return priority(a) - priority(b)
      || String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || ""));
  });

  const inspected = [];
  for (const file of ordered.slice(0, 30)) {
    const item = await inspectBusinessSheet(env, token, file, owners.get(file.id) || "");
    inspected.push(item);
    if (file.id === mappedSheetId && item.configured) return { ...item, canonicalTenant: mappedTenant || item.owner || state };
    if (file.id === currentSheetId && item.ready) return { ...item, canonicalTenant: item.owner || state };
  }

  const ready = inspected.filter((item) => item.ready);
  const configured = inspected.filter((item) => item.configured);
  const chosen = ready[0] || configured[0] || inspected.find((item) => item.sheetId === currentSheetId) || null;
  return chosen ? { ...chosen, canonicalTenant: chosen.owner || mappedTenant || state } : null;
}

async function copyTenantWorkspaceRefs(env, fromTenant, toTenant, sheetId) {
  if (!toTenant || !sheetId) return;
  await env.KV.put(`tenant:${toTenant}`, sheetId);
  if (fromTenant && fromTenant !== toTenant) {
    const folders = await env.KV.get(`drivefolders:${fromTenant}`);
    if (folders) await env.KV.put(`drivefolders:${toTenant}`, folders);
    const oldSetup = await env.KV.get(`setup:${fromTenant}:${sheetId}`);
    if (oldSetup === "1") await env.KV.put(`setup:${toTenant}:${sheetId}`, "1");
  }
}

export function buildConnectUrl(env, origin, key) {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: `${origin}/oauth/callback`,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: key,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

async function getDashToken(env, key) {
  let t = await env.KV.get(`dtoken:${key}`);
  if (!t) {
    t = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    await env.KV.put(`dtoken:${key}`, t);
  }
  return t;
}

/* ── push เข้า LINE — callback มาจาก browser จึงไม่มี replyToken ── */
async function pushToLine(env, to, messages) {
  if (!env.LINE_ACCESS_TOKEN || !to) return false;
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to,
        messages: Array.isArray(messages) ? messages : [messages],
      }),
    });
    if (!r.ok) console.error("push failed", r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error("push error", e);
    return false;
  }
}

function connectedCard({ setupUrl, dashboardUrl, reused, linkedExisting, setupComplete, companyName }) {
  const business = companyName ? ` “${companyName}”` : "";
  const rows = [
    { ok: true, text: linkedExisting
        ? `พบบัญชี Google เดิม — เชื่อมกลุ่มนี้เข้ากับธุรกิจ${business}แล้ว`
        : reused
          ? `ใช้ธุรกิจเดิม${business} — ข้อมูลเก่าอยู่ครบ`
          : "สร้างพื้นที่ธุรกิจใหม่ในบัญชี Google เรียบร้อย" },
    { ok: setupComplete, text: setupComplete
        ? "ข้อมูลบริษัท โลโก้ และผู้อนุมัติพร้อมใช้งาน"
        : "เพิ่มข้อมูลบริษัท (ทำครั้งเดียว) — ชื่อบริษัท · เลขผู้เสียภาษี · ผู้อนุมัติ" },
    { ok: true, text: "ส่งรูปบิลเข้ามาในกลุ่มนี้ได้เลย" },
  ];

  const buttons = [];
  if (setupUrl) {
    buttons.push({
      type: "button", style: "primary", color: "#DC6234", height: "sm",
      action: { type: "uri", label: "⚙️ เพิ่มข้อมูลบริษัท", uri: setupUrl },
    });
  }
  if (dashboardUrl) {
    buttons.push({
      type: "button", style: setupUrl ? "secondary" : "primary",
      color: setupUrl ? undefined : "#12674F", height: "sm",
      action: { type: "uri", label: "📊 เปิดแดชบอร์ด", uri: dashboardUrl },
    });
  }

  const bubble = {
    type: "bubble",
    body: {
      type: "box", layout: "vertical", spacing: "sm",
      contents: [
        { type: "text", text: linkedExisting ? "✅ เชื่อมธุรกิจเดิมสำเร็จ" : "✅ เชื่อม Google สำเร็จ", weight: "bold", size: "md", color: "#12674F" },
        { type: "text", text: "กลุ่ม LINE นี้จะใช้ Sheet, Drive และข้อมูลบริษัทชุดเดิม", size: "sm", color: "#8c8c8c", wrap: true },
        {
          type: "box", layout: "vertical", margin: "lg", spacing: "sm",
          contents: rows.map((r) => ({
            type: "box", layout: "baseline", spacing: "sm",
            contents: [
              { type: "text", text: r.ok ? "✓" : "○", size: "sm", flex: 0,
                color: r.ok ? "#12674F" : "#B0B7BD" },
              { type: "text", text: r.text, size: "sm", wrap: true, flex: 1,
                color: r.ok ? "#1C1F24" : "#5C6470" },
            ],
          })),
        },
      ],
    },
  };
  if (buttons.length) bubble.footer = { type: "box", layout: "vertical", spacing: "sm", contents: buttons };
  return { type: "flex", altText: linkedExisting ? "เชื่อมธุรกิจเดิมสำเร็จ" : "เชื่อม Google สำเร็จ", contents: bubble };
}

export async function handleCallback(env, url, origin) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return page("ลิงก์ไม่ถูกต้อง ลองกดเชื่อมใหม่จากใน LINE");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: `${origin}/oauth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return page("เชื่อมไม่สำเร็จ ลองใหม่อีกครั้ง");
  const tok = await res.json();

  const identity = await googleDriveIdentity(tok.access_token);
  const currentSheetId = await env.KV.get(`tenant:${state}`);
  const discovered = await discoverExistingBusiness(env, tok.access_token, state, currentSheetId || "", identity);

  let sheetId = discovered?.sheetId || currentSheetId || "";
  let canonicalTenant = discovered?.canonicalTenant || state;
  let settings = discovered?.settings || {};
  let reused = !!sheetId;
  let linkedExisting = !!(sheetId && (sheetId !== currentSheetId || canonicalTenant !== state));

  const canonicalRefresh = canonicalTenant && canonicalTenant !== state
    ? await env.KV.get(`gtoken:${canonicalTenant}`)
    : "";
  const refreshToken = tok.refresh_token || canonicalRefresh || await env.KV.get(`gtoken:${state}`);
  if (refreshToken) await env.KV.put(`gtoken:${state}`, refreshToken);

  try {
    if (!sheetId) {
      const folders = await ensureTenantDriveFolders(env, state, tok.access_token, { companyName: "", sheetId: "" });
      sheetId = (await createUserSheet(env, tok.access_token, "DEAL Finance", {
        parentFolderId: folders.companyFolderId,
      })).sheetId;
      canonicalTenant = state;
      reused = false;
      linkedExisting = false;
      settings = {};
      await env.KV.put(`tenant:${state}`, sheetId);
      await ensureTenantDriveFolders(env, state, tok.access_token, { companyName: "", sheetId });
      console.log(`OAUTH created new sheet for ${state}: ${sheetId}`);
    } else {
      await copyTenantWorkspaceRefs(env, canonicalTenant, state, sheetId);
      settings = Object.keys(settings || {}).length
        ? settings
        : await readSettings(env, sheetId, tok.access_token).catch(() => ({}));
      await ensureTenantDriveFolders(env, state, tok.access_token, {
        companyName: settings.company_name || "พื้นที่บริษัท",
        sheetId,
      });
      console.log(`OAUTH linked ${state} to existing business tenant=${canonicalTenant} sheet=${sheetId}`);
    }
  } catch (e) {
    console.error("create/link user workspace", e);
  }

  if (identity && sheetId) {
    await rememberIdentityTenant(env, identity, canonicalTenant || state);
    await env.KV.put(`googleidentity:${state}`, JSON.stringify({ ...identity, canonicalTenant: canonicalTenant || state, sheetId }));
  }

  const setupComplete = settingsReady(settings);
  if (sheetId) {
    if (setupComplete) {
      await env.KV.put(`setup:${state}:${sheetId}`, "1");
    } else {
      await env.KV.delete(`setup:${state}`);
      await env.KV.delete(`setup:${state}:${sheetId}`);
    }
  }

  let setupUrl = null, dashboardUrl = null;
  if (env.DASHBOARD_URL) {
    const base = env.DASHBOARD_URL.replace(/\/$/, "");
    const t = await getDashToken(env, state);
    const qs = `?tenant=${encodeURIComponent(state)}&k=${t}`;
    setupUrl = setupComplete ? null : `${base}/receipt${qs}`;
    dashboardUrl = `${base}${qs}`;
  }

  await pushToLine(env, state, connectedCard({
    setupUrl, dashboardUrl, reused, linkedExisting, setupComplete,
    companyName: settings.company_name || "",
  }));

  return successPage({
    setupUrl, dashboardUrl, reused, linkedExisting, setupComplete,
    companyName: settings.company_name || "",
  });
}

export async function getUserToken(env, key) {
  const now = Date.now();
  const c = _utok[key];
  if (c && c.exp - 60000 > now) return c.token;

  const refresh = await env.KV.get(`gtoken:${key}`);
  if (!refresh) return null;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) { console.error("refresh error", await res.text()); return null; }
  const j = await res.json();
  _utok[key] = { token: j.access_token, exp: now + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}

export async function createUserSheet(env, token, title, { parentFolderId = "" } = {}) {
  let res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: title,
      mimeType: "application/vnd.google-apps.spreadsheet",
      ...(parentFolderId ? { parents: [parentFolderId] } : {}),
    }),
  });
  if (!res.ok) throw new Error("create sheet: " + res.status);
  const sheetId = (await res.json()).id;
  const tab = env.SHEET_TAB || "รายจ่าย";

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ updateSheetProperties: {
      properties: { sheetId: 0, title: tab }, fields: "title" } }] }),
  }).catch(() => {});

  const range = encodeURIComponent(tab + "!A1");
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ values: [HEADER] }),
    }
  );

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: "_settings" } } }] }),
  }).catch(() => {});

  return { sheetId };
}

function shell(inner) {
  return `<!doctype html><html lang="th"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DEAL ผู้ช่วยบัญชี</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
padding:24px;background:#F5F6F7;color:#1C1F24;font-family:system-ui,-apple-system,sans-serif}
.card{width:100%;max-width:420px;background:#fff;border-radius:16px;padding:30px 26px;
box-shadow:0 4px 24px rgba(0,0,0,.08)}
.mark{font-size:38px;text-align:center}
h1{margin:6px 0 4px;font-size:19px;text-align:center;color:#12674F}
.lead{margin:0 0 20px;font-size:14px;line-height:1.6;text-align:center;color:#5C6470}
ul{margin:0 0 20px;padding:0;list-style:none}
li{display:flex;gap:11px;padding:11px 0;border-top:1px solid #EDEFF1;font-size:14px;line-height:1.5}
li:last-child{border-bottom:1px solid #EDEFF1}
.n{flex:0 0 24px;height:24px;border-radius:50%;display:flex;align-items:center;
justify-content:center;font-size:12px;font-weight:700}
.a .n{background:#DFF5E6;color:#1B8A4B}
.b .n{background:#FFF0D6;color:#B8730A}
.c{color:#8A929C}.c .n{background:#EDEFF1;color:#8A929C}
a.btn{display:block;padding:13px;border-radius:10px;text-align:center;text-decoration:none;
font-size:15px;font-weight:600;background:#12674F;color:#fff}
.foot{margin-top:16px;font-size:12px;line-height:1.6;color:#8A929C;text-align:center}
.msg{font-size:15px;line-height:1.7;white-space:pre-line;text-align:center}
</style><div class="card">${inner}</div></html>`;
}

function successPage({ setupUrl, dashboardUrl, reused, linkedExisting, setupComplete, companyName }) {
  const business = companyName ? ` “${escHtml(companyName)}”` : "";
  const cta = setupUrl
    ? `<a class="btn" href="${setupUrl}">ตั้งค่าข้อมูลบริษัท →</a>
       <p class="foot">กลุ่มนี้เชื่อมกับพื้นที่ธุรกิจแล้ว<br>เหลือกรอกข้อมูลบริษัทที่ยังขาด</p>`
    : dashboardUrl
      ? `<a class="btn" href="${dashboardUrl}">เปิดแดชบอร์ด →</a>
         <p class="foot">กลับไปที่ LINE แล้วส่งรูปบิลในกลุ่มนี้ได้ทันที</p>`
      : `<p class="foot">กลับไปที่ LINE แล้วส่งรูปบิลได้เลย</p>`;

  const first = linkedExisting
    ? `<b>พบธุรกิจเดิม${business}</b><br>กลุ่มนี้ใช้ Sheet, Drive และข้อมูลบริษัทชุดเดิมแล้ว`
    : reused
      ? `<b>ใช้ธุรกิจเดิม${business}</b><br>ข้อมูลเก่ายังอยู่ครบ`
      : `<b>สร้างพื้นที่ธุรกิจใหม่แล้ว</b><br>สร้างชีทในบัญชีของคุณเรียบร้อย`;

  return html(shell(
    `<div class="mark">📒</div>
     <h1>${linkedExisting ? "เชื่อมธุรกิจเดิมสำเร็จ" : "เชื่อม Google สำเร็จ"}</h1>
     <p class="lead">ไม่ต้องสร้างข้อมูลบริษัทซ้ำเมื่อใช้บัญชี Google เดิม</p>
     <ul>
       <li class="a"><span class="n">✓</span><span>${first}</span></li>
       <li class="${setupComplete ? "a" : "b"}"><span class="n">${setupComplete ? "✓" : "2"}</span><span>${setupComplete ? "ข้อมูลบริษัทและผู้อนุมัติพร้อมใช้งาน" : "ตั้งค่าข้อมูลบริษัทที่ยังขาด"}</span></li>
       <li class="a"><span class="n">✓</span><span>เริ่มส่งรูปบิลใน LINE กลุ่มนี้ได้เลย</span></li>
     </ul>
     ${cta}`
  ));
}

function escHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(msg) {
  return html(shell(`<div class="mark">📒</div><h1>DEAL ผู้ช่วยบัญชี</h1><p class="msg">${msg}</p>`));
}

function html(body) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}
