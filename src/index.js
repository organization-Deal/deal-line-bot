// DEAL LINE Finance Bot — MVP
// ถ่ายบิลลง LINE → OCR (Claude) → การ์ดยืนยัน → เก็บรูป Drive + เขียนแถวเข้า Google Sheet
// + เปิด API /api/expenses ให้ dashboard ดึงข้อมูลจริงจากชีทของแต่ละกลุ่ม

import { verifySignature, getMessageContent, reply, textMsg, confirmCard, savedCard } from "./line.js";
import { ocrReceipt } from "./ocr.js";
import { appendExpense, readExpenses } from "./sheets.js";
import { uploadImage } from "./drive.js";
import { createTenantSheet } from "./provision.js";

const VERSION = "DEAL_LINE_BOT_v0.4";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight (dashboard เรียกข้ามโดเมนได้)
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    // ---- API สำหรับ dashboard: อ่านรายจ่ายของ tenant นั้น ----
    if (url.pathname === "/api/expenses") {
      const key = url.searchParams.get("tenant");
      if (!key) return cors(json({ error: "missing tenant" }, 400));
      const sheetId = await env.KV.get(`tenant:${key}`);
      if (!sheetId) return cors(json({ error: "no sheet for tenant" }, 404));
      try {
        return cors(json(await readExpenses(env, sheetId)));
      } catch (e) {
        console.error("api/expenses", e);
        return cors(json({ error: String(e) }, 500));
      }
    }

    if (request.method === "GET") return json({ version: VERSION, ok: true });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    // ---- LINE webhook ----
    const raw = await request.text();
    if (!(await verifySignature(env, raw, request.headers.get("x-line-signature"))))
      return new Response("bad signature", { status: 401 });

    let body;
    try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

    for (const event of body.events || [])
      ctx.waitUntil(handleEvent(event, env).catch((e) => console.error("handleEvent", e)));
    return new Response("ok");
  },
};

function tenantKey(source = {}) {
  return source.groupId || source.roomId || source.userId || "unknown";
}

async function tenantTitle(env, source) {
  try {
    if (source.groupId) {
      const r = await fetch(`https://api.line.me/v2/bot/group/${source.groupId}/summary`, {
        headers: { Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}` },
      });
      if (r.ok) return (await r.json()).groupName || "";
    } else if (source.userId) {
      const r = await fetch(`https://api.line.me/v2/bot/profile/${source.userId}`, {
        headers: { Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}` },
      });
      if (r.ok) return (await r.json()).displayName || "";
    }
  } catch {}
  return "";
}

async function getOrCreateSheet(env, source) {
  const key = tenantKey(source);
  const mapped = await env.KV.get(`tenant:${key}`);
  if (mapped) return { sheetId: mapped, url: await env.KV.get(`tenanturl:${key}`) };

  const name = await tenantTitle(env, source);
  const title = `DEAL Finance · ${name || key.slice(0, 8)}`;
  const { sheetId, url } = await createTenantSheet(env, title);
  await env.KV.put(`tenant:${key}`, sheetId);
  if (url) await env.KV.put(`tenanturl:${key}`, url);
  return { sheetId, url, created: true };
}

async function getDisplayName(env, source) {
  try {
    const uid = source.userId;
    if (!uid) return "";
    const url = source.groupId
      ? `https://api.line.me/v2/bot/group/${source.groupId}/member/${uid}`
      : `https://api.line.me/v2/bot/profile/${uid}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}` } });
    if (!r.ok) return "";
    return (await r.json()).displayName || "";
  } catch {
    return "";
  }
}

async function handleEvent(event, env) {
  if (event.type === "join" || event.type === "follow") {
    try {
      const { url } = await getOrCreateSheet(env, event.source);
      return reply(env, event.replyToken, textMsg(
        "สวัสดีครับ ผมน้องช่วยบัญชีของ DEAL 📒\n" +
        "ส่งรูปบิล/สลิปเข้ามาได้เลย เดี๋ยวผมอ่านให้แล้วสรุปให้ตรวจ\n\n" +
        (url ? "ข้อมูลทั้งหมดเก็บที่ชีทของคุณ:\n" + url : "") +
        (env.DASHBOARD_URL ? "\n\nอยากดูสรุปยอดแบบแดชบอร์ด พิมพ์ \"สรุป\" ได้เลย" : "")
      ));
    } catch (e) { console.error("provision on join", e); return; }
  }

  if (event.type === "message" && event.message?.type === "image") {
    let sheet;
    try { sheet = await getOrCreateSheet(env, event.source); }
    catch (e) {
      console.error("provision", e);
      return reply(env, event.replyToken, textMsg("ระบบยังเชื่อม Google ไม่ได้ชั่วคราว ลองใหม่อีกครั้งนะครับ 🙏"));
    }

    const { base64, mediaType } = await getMessageContent(env, event.message.id);
    const driveLink = await uploadImage(env, base64, mediaType, `bill-${Date.now()}.jpg`);
    const record = await ocrReceipt(env, base64, mediaType);
    const sender = await getDisplayName(env, event.source);

    const id = crypto.randomUUID().slice(0, 8);
    await env.KV.put(
      `pending:${id}`,
      JSON.stringify({ record, driveLink, sheetId: sheet.sheetId, sender }),
      { expirationTtl: 3600 }
    );
    return reply(env, event.replyToken, confirmCard(id, record));
  }

  if (event.type === "postback") {
    const p = new URLSearchParams(event.postback.data);
    const act = p.get("act");
    const id = p.get("id");
    const raw = await env.KV.get(`pending:${id}`);
    if (!raw) return reply(env, event.replyToken, textMsg("รายการนี้หมดอายุแล้ว ส่งรูปใหม่อีกทีนะครับ 🙏"));
    const pending = JSON.parse(raw);

    if (act === "confirm") {
      await appendExpense(env, pending.sheetId, pending.record, { sender: pending.sender, driveLink: pending.driveLink });
      await env.KV.delete(`pending:${id}`);
      return reply(env, event.replyToken, savedCard(pending.record, pending.driveLink));
    }
    if (act === "edit") {
      await env.KV.put(`edit:${event.source.userId}`, id, { expirationTtl: 600 });
      return reply(env, event.replyToken, textMsg("พิมพ์ยอดเงินที่ถูกต้องมาได้เลย (เฉพาะตัวเลข)"));
    }
  }

  if (event.type === "message" && event.message?.type === "text") {
    const text = (event.message.text || "").trim();
    const editId = event.source.userId ? await env.KV.get(`edit:${event.source.userId}`) : null;
    if (editId) {
      const amt = Number(text.replace(/[^0-9.]/g, ""));
      const raw = await env.KV.get(`pending:${editId}`);
      if (amt > 0 && raw) {
        const pending = JSON.parse(raw);
        pending.record.amount = amt;
        await env.KV.put(`pending:${editId}`, JSON.stringify(pending), { expirationTtl: 3600 });
        await env.KV.delete(`edit:${event.source.userId}`);
        return reply(env, event.replyToken, confirmCard(editId, pending.record));
      }
      return reply(env, event.replyToken, textMsg("พิมพ์เป็นตัวเลขนะครับ เช่น 128 หรือ 128.50"));
    }

    // คำสั่ง "สรุป" → ส่งปุ่มเปิดแดชบอร์ดของกลุ่มนี้ (ฝัง tenant ให้อัตโนมัติ)
    if (/สรุป|dashboard|แดชบอร์ด/i.test(text)) {
      if (!env.DASHBOARD_URL)
        return reply(env, event.replyToken, textMsg("ยังไม่ได้ตั้งค่าแดชบอร์ดครับ 🙏"));
      return reply(env, event.replyToken, dashboardMsg(env, tenantKey(event.source)));
    }
  }
}

function dashboardMsg(env, key) {
  const url = `${env.DASHBOARD_URL}?tenant=${encodeURIComponent(key)}`;
  return {
    type: "flex",
    altText: "เปิดแดชบอร์ดสรุปบัญชี",
    contents: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", spacing: "sm",
        contents: [
          { type: "text", text: "\u{1F4CA} สรุปบัญชีของคุณ", weight: "bold", size: "md", color: "#1F6E56" },
          { type: "text", text: "ดูยอดใช้จ่าย รอเบิก จ่ายแล้ว และรายการทั้งหมด", size: "sm", color: "#8c8c8c", wrap: true },
        ],
      },
      footer: {
        type: "box", layout: "vertical",
        contents: [
          { type: "button", style: "primary", color: "#1F6E56", height: "sm",
            action: { type: "uri", label: "เปิดแดชบอร์ด", uri: url } },
        ],
      },
    },
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "*");
  return res;
}
