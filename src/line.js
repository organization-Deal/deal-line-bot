// LINE Messaging API I/O helpers — v1.2
// การ์ดทั้งหมดเรนเดอร์ใน card.js

import { buildConfirmCard, buildSavedCard, buildMoreCard } from "./card.js";

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

// ส่งข้อความภายหลังด้วย push — ใช้เมื่อ OCR / สร้าง PDF ใช้เวลานานเกินกว่าจะถือ replyToken ไว้
export async function push(env, to, messages) {
  if (!to) {
    console.error("LINE push error: missing target");
    return false;
  }
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: Array.isArray(messages) ? messages : [messages] }),
  });
  if (!res.ok) {
    console.error("LINE push error:", res.status, await res.text());
    return false;
  }
  return true;
}

export function textMsg(text) {
  return { type: "text", text };
}

export function confirmCard(id, r, opts = {}) {
  return buildConfirmCard(r, { ...opts, id });
}

export function savedCard(r, driveLink, dashboardUrl, opts = {}) {
  return buildSavedCard(r, { ...opts, driveLink, dashboardUrl });
}

export function moreCard(r, opts = {}) {
  return buildMoreCard(r, opts);
}
