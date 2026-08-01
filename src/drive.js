// อัปรูปบิล — ถ้ามี token ลูกค้า → เก็บใน Drive ลูกค้า / ไม่มี → โหมด service account (DRIVE_FOLDER_ID)
// v2.0: เพิ่ม listUploadedImages() สำหรับหารูปกำพร้า (อัปแล้วแต่ยังไม่ผูกกับรายการไหน)

import { getAccessToken } from "./google-auth.js";

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function uploadFile(env, data, mediaType, name, token = null, { publicRead = false } = {}) {
  let authToken, parents;
  if (token) {
    // โหมด OAuth: เก็บใน Drive ของลูกค้าเอง (ไม่ต้องมีโฟลเดอร์ ไม่ติดโควตา)
    authToken = token;
    parents = null;
  } else {
    // โหมด service account: ต้องมีโฟลเดอร์ที่แชร์ไว้ (มีโควตาจำกัด)
    const folderId = env.DRIVE_FOLDER_ID;
    if (!folderId) return null;
    authToken = await getAccessToken(env);
    parents = [folderId];
  }

  const metadata = { name };
  if (parents) metadata.parents = parents;
  const boundary = "----deal" + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();
  const pre =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`;
  const post = `\r\n--${boundary}--`;
  const bytes = data instanceof Uint8Array ? data : base64ToBytes(String(data || ""));
  const body = new Uint8Array([...enc.encode(pre), ...bytes, ...enc.encode(post)]);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  if (!res.ok) { console.error("Drive upload error:", res.status, await res.text()); return null; }
  const file = await res.json();

  // เอกสารอีเมล/ใบกำกับเป็นข้อมูลบริษัท: ค่าเริ่มต้นเก็บแบบ private ใน Drive
  // รูปจาก LINE รุ่นเดิมยังเรียก uploadImage() ซึ่งส่ง publicRead=true เพื่อให้หน้า Dashboard แสดงภาพได้
  if (publicRead) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions?supportsAllDrives=true`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    }).catch(() => {});
  }

  return file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`;
}


// backward-compatible alias used by LINE image uploads
export async function uploadImage(env, base64, mediaType, name, token = null) {
  return uploadFile(env, base64, mediaType, name, token, { publicRead: true });
}

/**
 * ลิสต์รูปบิลทั้งหมดที่แอปเคยอัปขึ้นไป
 *
 * scope ที่ใช้คือ drive.file → Drive API จะคืนเฉพาะไฟล์ที่แอปนี้สร้างเองเท่านั้น
 * ไฟล์ส่วนตัวอื่น ๆ ของลูกค้าจะไม่โผล่มาเลย ปลอดภัยโดยธรรมชาติ
 *
 * @returns {Array<{fileId,name,createdTime,viewUrl,imgUrl}>} ใหม่สุดขึ้นก่อน
 */
export async function listUploadedImages(env, token = null, { limit = 200 } = {}) {
  let authToken = token;
  let q = "mimeType contains 'image/' and trashed = false";

  if (!authToken) {
    const folderId = env.DRIVE_FOLDER_ID;
    if (!folderId) return [];
    authToken = await getAccessToken(env);
    q += ` and '${folderId}' in parents`;
  }

  const out = [];
  let pageToken = null;

  do {
    const p = new URLSearchParams({
      q,
      orderBy: "createdTime desc",
      pageSize: String(Math.min(100, limit - out.length)),
      fields: "nextPageToken, files(id,name,createdTime,webViewLink)",
      supportsAllDrives: "true",
    });
    if (pageToken) p.set("pageToken", pageToken);

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${p}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) {
      console.error("Drive list error:", res.status, await res.text());
      break;
    }

    const j = await res.json();
    for (const f of j.files || []) {
      out.push({
        fileId: f.id,
        name: f.name || "",
        createdTime: f.createdTime || "",
        viewUrl: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
        // lh3 ใช้เป็น <img src> ได้ตรง ๆ ต่างจาก webViewLink ที่คืนหน้า HTML
        imgUrl: `https://lh3.googleusercontent.com/d/${f.id}`,
      });
    }

    pageToken = j.nextPageToken;
  } while (pageToken && out.length < limit);

  return out;
}
