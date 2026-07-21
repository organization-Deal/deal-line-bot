// Uploads the bill image to Drive and returns a viewable link.
// Optional: only runs when DRIVE_FOLDER_ID is set. The service account must
// have access to that folder (share the folder with the SA email as Editor).
import { getAccessToken } from "./google-auth.js";

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function uploadImage(env, base64, mediaType, name) {
  const folderId = env.DRIVE_FOLDER_ID;
  if (!folderId) return null; // feature disabled

  const token = await getAccessToken(env);
  const metadata = { name, parents: [folderId] };
  const boundary = "----deal" + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();

  const pre =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`;
  const post = `\r\n--${boundary}--`;

  const body = new Uint8Array([...enc.encode(pre), ...base64ToBytes(base64), ...enc.encode(post)]);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  if (!res.ok) {
    console.error("Drive upload error:", res.status, await res.text());
    return null;
  }
  const file = await res.json();

  // make it viewable by anyone with the link (best-effort)
  await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions?supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  }).catch(() => {});

  return file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`;
}
