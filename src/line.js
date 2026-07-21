// LINE Messaging API I/O helpers.

// Verify the X-Line-Signature header (HMAC-SHA256 of the raw body, base64).
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

// Download an image the user sent, return { base64, mediaType }.
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

const money = (n) => Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The confirmation card shown after OCR. `id` is the pending-record key.
export function confirmCard(id, r) {
  const row = (label, value) => ({
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      { type: "text", text: label, color: "#8c8c8c", size: "sm", flex: 2 },
      { type: "text", text: String(value || "-"), wrap: true, color: "#333333", size: "sm", flex: 5 },
    ],
  });

  return {
    type: "flex",
    altText: `ตรวจสอบรายจ่าย ${money(r.amount)} บาท`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "ตรวจสอบให้หน่อย ✅", weight: "bold", size: "md", color: "#1F6E56" },
          { type: "text", text: `- ${money(r.amount)} บาท`, weight: "bold", size: "xxl", color: "#D85A30" },
          { type: "separator" },
          row("ร้าน/ผู้รับ", r.vendor),
          row("วันที่", r.date),
          row("หมวด", r.category),
          row("รายละเอียด", r.note),
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "secondary",
            height: "sm",
            action: { type: "postback", label: "✏️ แก้ยอด", data: `act=edit&id=${id}` },
          },
          {
            type: "button",
            style: "primary",
            height: "sm",
            color: "#1F6E56",
            action: { type: "postback", label: "✅ ยืนยัน", data: `act=confirm&id=${id}` },
          },
        ],
      },
    },
  };
}

// The "saved" card shown after the user confirms.
export function savedCard(r, driveLink) {
  const contents = [
    { type: "text", text: "บันทึกแล้ว 🎉", weight: "bold", size: "md", color: "#1F6E56" },
    { type: "text", text: `- ${money(r.amount)} บาท`, weight: "bold", size: "xl", color: "#D85A30" },
    { type: "text", text: `${r.category} · ${r.date}`, size: "sm", color: "#8c8c8c", wrap: true },
  ];
  if (driveLink) {
    contents.push({
      type: "button",
      style: "link",
      height: "sm",
      action: { type: "uri", label: "📎 ดูรูปบิล", uri: driveLink },
    });
  }
  return {
    type: "flex",
    altText: `บันทึกแล้ว ${money(r.amount)} บาท`,
    contents: { type: "bubble", body: { type: "box", layout: "vertical", spacing: "sm", contents } },
  };
}
