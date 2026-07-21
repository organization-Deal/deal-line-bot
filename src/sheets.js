// อ่าน/เขียน Google Sheet ของแต่ละ tenant
import { getAccessToken } from "./google-auth.js";

// ลำดับคอลัมน์ (ตรงกับหัวตารางที่ provision สร้างให้):
// วันที่ | ยอด | ร้าน/ผู้รับ | หมวด | รายละเอียด | ผู้ส่ง | ลิงก์รูป | สถานะ | บันทึกเมื่อ
export async function appendExpense(env, sheetId, r, meta = {}) {
  const token = await getAccessToken(env);
  const range = encodeURIComponent((env.SHEET_TAB || "รายจ่าย") + "!A:I");
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const row = [
    r.date, r.amount, r.vendor, r.category, r.note,
    meta.sender || "", meta.driveLink || "", "รอเบิก", new Date().toISOString(),
  ];

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error("Sheets append error: " + res.status + " " + (await res.text()));
  return true;
}

// อ่านทุกแถว แปลงเป็นรูปแบบที่ dashboard ใช้ (ใหม่สุดขึ้นก่อน)
export async function readExpenses(env, sheetId) {
  const token = await getAccessToken(env);
  const tab = env.SHEET_TAB || "รายจ่าย";
  const range = encodeURIComponent(tab + "!A2:I"); // ข้ามแถวหัวตาราง
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error("Sheets read error: " + res.status + " " + (await res.text()));
  const { values = [] } = await res.json();

  return values
    .filter((r) => r && r.length)
    .map((r) => ({
      date: r[0] || "",
      amount: Number(String(r[1] || "0").replace(/[^0-9.]/g, "")) || 0,
      vendor: r[2] || "",
      category: r[3] || "",
      note: r[4] || "",
      sender: r[5] || "",
      img: r[6] || "",
      status: r[7] || "รอเบิก",
    }))
    .reverse();
}
