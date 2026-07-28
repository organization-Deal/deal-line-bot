// สร้าง Google Sheet ใหม่ให้ 1 กลุ่ม/ลูกค้า อัตโนมัติ (ไม่ต้องขอ id เอง)
// ใช้กับโหมด service account เท่านั้น — โหมด OAuth ใช้ createUserSheet() ใน oauth.js
//
// v1.1: หัวคอลัมน์ย้ายไป import จาก sheets.js
//       เดิมไฟล์นี้มี HEADER ของตัวเอง 9 ช่อง → ชีทที่สร้างใหม่จะไม่ครบ

import { getAccessToken } from "./google-auth.js";
import { HEADER } from "./sheets.js";

export async function createTenantSheet(env, title) {
  const token = await getAccessToken(env);
  const tab = env.SHEET_TAB || "รายจ่าย";

  // 1) สร้างไฟล์สเปรดชีทใน "โฟลเดอร์ที่แชร์ให้ service account" (ผ่าน Drive API)
  //    service account ไม่มี Drive ของตัวเอง จึงต้องสร้างในโฟลเดอร์ที่เราแชร์ (DRIVE_FOLDER_ID)
  const folderId = env.DRIVE_FOLDER_ID;
  if (!folderId) throw new Error("DRIVE_FOLDER_ID not set");

  let res = await fetch(
    "https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: title,
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents: [folderId],
      }),
    }
  );
  if (!res.ok) throw new Error("create sheet: " + res.status + " " + (await res.text()));
  const sheetId = (await res.json()).id;
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;

  // ตั้งชื่อแท็บแรกให้เป็น SHEET_TAB
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ updateSheetProperties: {
      properties: { sheetId: 0, title: tab }, fields: "title",
    } }] }),
  }).catch(() => {});

  // 2) ใส่หัวคอลัมน์แถวแรก — HEADER มาจาก sheets.js จึงครบทุกคอลัมน์เสมอ
  const range = encodeURIComponent(tab + "!A1");
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ values: [HEADER] }),
    }
  );

  // สร้างแท็บ _settings ไว้เลย
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: "_settings" } } }] }),
  }).catch(() => {});

  // 3) แชร์แบบ "ใครมีลิงก์ก็ดูได้" เพื่อให้ลูกค้าเปิดชีทของตัวเองได้
  await fetch(
    `https://www.googleapis.com/drive/v3/files/${sheetId}/permissions?supportsAllDrives=true`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    }
  ).catch(() => {});

  // 4) (ถ้าตั้ง ADMIN_EMAIL) แชร์ให้แอดมิน DEAL เป็น editor เพื่อรวมชีทลูกค้าทุกเจ้าไว้ที่เดียว
  if (env.ADMIN_EMAIL) {
    await fetch(
      `https://www.googleapis.com/drive/v3/files/${sheetId}/permissions?supportsAllDrives=true&sendNotificationEmail=false`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ role: "writer", type: "user", emailAddress: env.ADMIN_EMAIL }),
      }
    ).catch(() => {});
  }

  return { sheetId, url };
}
