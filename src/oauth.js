// OAuth ของลูกค้า: ให้ลูกค้ากด "เชื่อม Google" เอง → ชีท+รูปบิลไปอยู่ใน Drive ของลูกค้า
// scope drive.file = แตะได้แค่ไฟล์ที่แอปสร้าง (ปลอดภัย + เลี่ยง verify หนัก)
//
// v1.1: หัวคอลัมน์ย้ายไป import จาก sheets.js
//       เดิมไฟล์นี้มี HEADER ของตัวเอง 9 ช่อง → ลูกค้าใหม่ได้ชีทไม่ครบ แล้วโค้ดที่คาดหวัง 24 คอลัมน์จะพัง

import { HEADER } from "./sheets.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets";

const _utok = {}; // cache access token ต่อ tenant (อยู่ใน isolate)

// URL พาลูกค้าไปหน้ายินยอมของ Google
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

// รับ code กลับมา → แลก token → เก็บ refresh token + สร้างชีทให้ลูกค้า
export async function handleCallback(env, url, origin) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state"); // = tenant key
  if (!code || !state) return page("ลิงก์ไม่ถูกต้อง ลองเชื่อมใหม่อีกครั้ง");

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
  if (!res.ok) return page("เชื่อมไม่สำเร็จ 🙏 ลองใหม่: " + (await res.text()));
  const tok = await res.json();

  if (tok.refresh_token) await env.KV.put(`gtoken:${state}`, tok.refresh_token);

  // สร้างชีทใน Drive ของลูกค้าเลย (owned by user = ไม่ติดโควตา)
  try {
    const { sheetId } = await createUserSheet(env, tok.access_token, "DEAL Finance");
    await env.KV.put(`tenant:${state}`, sheetId);
  } catch (e) {
    console.error("create user sheet on callback", e);
  }

  return page("✅ เชื่อม Google สำเร็จ!\nกลับไปที่ LINE แล้วส่งรูปบิลได้เลย");
}

// ขอ access token ของลูกค้าจาก refresh token (null = ยังไม่เชื่อม)
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
  if (!res.ok) { console.error("refresh token error", await res.text()); return null; }
  const j = await res.json();
  _utok[key] = { token: j.access_token, exp: now + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}

// สร้างสเปรดชีทใน Drive ของลูกค้า (ใช้ token ลูกค้า)
export async function createUserSheet(env, token, title) {
  let res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: title, mimeType: "application/vnd.google-apps.spreadsheet" }),
  });
  if (!res.ok) throw new Error("create user sheet: " + res.status + " " + (await res.text()));
  const sheetId = (await res.json()).id;
  const tab = env.SHEET_TAB || "รายจ่าย";

  // ตั้งชื่อแท็บแรก
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ updateSheetProperties: {
      properties: { sheetId: 0, title: tab }, fields: "title",
    } }] }),
  }).catch(() => {});

  // ใส่หัวตาราง — HEADER มาจาก sheets.js จึงครบทุกคอลัมน์เสมอ
  const range = encodeURIComponent(tab + "!A1");
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ values: [HEADER] }),
    }
  );

  // สร้างแท็บ _settings ไว้เลย (โลโก้ / ลายเซ็น / ข้อมูลบริษัท)
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: "_settings" } } }] }),
  }).catch(() => {});

  return { sheetId };
}

function page(msg) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <div style="font-family:sans-serif;max-width:420px;margin:60px auto;text-align:center;padding:24px">
       <div style="font-size:40px">📒</div>
       <h2 style="color:#12674f">DEAL ผู้ช่วยบัญชี</h2>
       <p style="font-size:17px;white-space:pre-line;color:#333">${msg}</p>
     </div>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}
