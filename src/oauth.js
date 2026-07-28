// OAuth ของลูกค้า — v1.2
// หน้าจบ OAuth พาไปตั้งค่าข้อมูลบริษัทต่อเลย ไม่ใช่บอกให้กลับ LINE เฉย ๆ

import { HEADER } from "./sheets.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets";
const _utok = {};

export function buildConnectUrl(env, origin, key) {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: `${origin}/oauth/callback`,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
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

  if (tok.refresh_token) await env.KV.put(`gtoken:${state}`, tok.refresh_token);

  try {
    const { sheetId } = await createUserSheet(env, tok.access_token, "DEAL Finance");
    await env.KV.put(`tenant:${state}`, sheetId);
  } catch (e) {
    console.error("create user sheet", e);
  }

  let setupUrl = null;
  if (env.DASHBOARD_URL) {
    const base = env.DASHBOARD_URL.replace(/\/$/, "");
    const t = await getDashToken(env, state);
    setupUrl = `${base}/receipt?tenant=${encodeURIComponent(state)}&k=${t}`;
  }

  return successPage(setupUrl);
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

export async function createUserSheet(env, token, title) {
  let res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: title, mimeType: "application/vnd.google-apps.spreadsheet" }),
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

function successPage(setupUrl) {
  const cta = setupUrl
    ? `<a class="btn" href="${setupUrl}">ตั้งค่าข้อมูลบริษัท →</a>
       <p class="foot">ข้ามไปก่อนก็ได้ — บันทึกบิลได้ตามปกติ<br>แต่ใบรับรองแทนใบเสร็จจะยังไม่สมบูรณ์</p>`
    : `<p class="foot">กลับไปที่ LINE แล้วส่งรูปบิลได้เลย</p>`;

  return html(shell(
    `<div class="mark">📒</div>
     <h1>เชื่อม Google สำเร็จ</h1>
     <p class="lead">เหลืออีกขั้นเดียวก่อนใช้งานเต็มรูปแบบ</p>
     <ul>
       <li class="a"><span class="n">✓</span><span><b>เชื่อม Google แล้ว</b><br>สร้างชีทในบัญชีของคุณเรียบร้อย</span></li>
       <li class="b"><span class="n">2</span><span><b>ตั้งค่าข้อมูลบริษัท</b> — ทำครั้งเดียว<br>ชื่อบริษัท · เลขผู้เสียภาษี · โลโก้ · ลายเซ็น</span></li>
       <li class="c"><span class="n">3</span><span>เริ่มส่งรูปบิลใน LINE</span></li>
     </ul>
     ${cta}`
  ));
}

function page(msg) {
  return html(shell(`<div class="mark">📒</div><h1>DEAL ผู้ช่วยบัญชี</h1><p class="msg">${msg}</p>`));
}

function html(body) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}
