// สร้าง Google Sheet ใหม่ให้ 1 กลุ่ม/ลูกค้า อัตโนมัติ (ไม่ต้องขอ id เอง)
import { getAccessToken } from "./google-auth.js";

const HEADER = [
  "วันที่", "ยอด", "ร้าน/ผู้รับ", "หมวด", "รายละเอียด",
  "ผู้ส่ง", "ลิงก์รูป", "สถานะ", "บันทึกเมื่อ",
];

export async function createTenantSheet(env, title) {
  const token = await getAccessToken(env);
  const tab = env.SHEET_TAB || "รายจ่าย";

  // 1) สร้างสเปรดชีทใหม่ พร้อมแท็บชื่อตาม SHEET_TAB
  let res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ properties: { title }, sheets: [{ properties: { title: tab } }] }),
  });
  if (!res.ok) throw new Error("create sheet: " + res.status + " " + (await res.text()));
  const ss = await res.json();
  const sheetId = ss.spreadsheetId;
  const url = ss.spreadsheetUrl;

  // 2) ใส่หัวคอลัมน์แถวแรก
  const range = encodeURIComponent(tab + "!A1");
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ values: [HEADER] }),
    }
  );

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
