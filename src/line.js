// LINE Messaging API I/O helpers.
// v1.1 — การ์ดย้ายไปเรนเดอร์ใน card.js แล้ว (index.js ไม่ต้องแก้)

import { buildConfirmCard, buildSavedCard } from "./card.js";

export async function verifySignature(env, rawBody, signature) {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.LINE_CHANNEL_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  let bin = "";
  const bytes = new Uint8Array(mac);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin) === signature;
}

export async function getMessageContent(env, messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error("LINE content error: " + res.status);
  const mediaType = res.headers.get("content-type") || "image/jpeg";
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return { base64: btoa(bin), mediaType };
}

export async function reply(env, replyToken, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: Array.isArray(messages) ? messages : [messages] }),
  });
  if (!res.ok) console.error("LINE reply error:", res.status, await res.text());
}

export function textMsg(text) {
  return { type: "text", text };
}

// การ์ดยืนยันหลัง OCR — id คือ key ของ pending record
export function confirmCard(id, r, opts = {}) {
  return buildConfirmCard(r, { ...opts, id });
}

// การ์ด "บันทึกแล้ว" หลังผู้ใช้กดยืนยัน
export function savedCard(r, driveLink, dashboardUrl, opts = {}) {
  return buildSavedCard(r, { ...opts, driveLink, dashboardUrl });
}
