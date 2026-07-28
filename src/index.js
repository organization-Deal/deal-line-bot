// DEAL LINE Finance Bot — v1.1
// ถ่ายบิลลง LINE → OCR → ยืนยัน → เขียนชีท (+เก็บรูป) → dashboard
//
// เปลี่ยนจาก v1.0:
//   • ทุกรายการที่บันทึก ตั้ง "ออกใบแทน" = TRUE ตั้งแต่แรก
//     (ออกใบแทนทุกใบที่เบิก แล้วบัญชีค่อยเอาออกในแดชบอร์ดว่าใบไหนไม่ต้องใช้)
//   • การ์ด "บันทึกแล้ว" เตือนทันทีถ้ายังตั้งค่าข้อมูลบริษัทไม่ครบ
//     — ไม่ต้องรอไปเจอตอนจะพิมพ์ใบแทนแล้วเอกสารออกมาโล่ง
//     เช็คผ่าน KV flag `setup:{tenant}` จะได้ไม่ต้องอ่านชีททุกครั้ง
//     flag ถูกล้างอัตโนมัติเมื่อมีการบันทึกตั้งค่าใหม่

import { verifySignature, getMessageContent, reply, textMsg, confirmCard, savedCard, moreCard } from "./line.js";
import { ocrReceipt } from "./ocr.js";
import {
  appendExpense, readExpenses, getExpenseById, updateExpenseById,
  togglePaid, toggleNeedSlip, softDeleteById, listForSlip, normalizeDate,
  ensureHeaders, backfillIds, readSettings, writeSettings, ensureSettingsTab,
  addAttachment, removeAttachment, usedFileIds, ATTACH_TYPES,
} from "./sheets.js";
import { uploadImage, listUploadedImages } from "./drive.js";
import { buildConnectUrl, handleCallback, getUserToken, createUserSheet } from "./oauth.js";

const VERSION = "DEAL_LINE_BOT_v1.1";

const PENDING_ACTS = new Set(["confirm", "cancel"]);
const MSG_STALE = "การ์ดใบนี้เก่าแล้วครับ 🙏 เลื่อนลงไปใช้การ์ดใบล่าสุดของรายการนี้แทน";

/* ═══════════════════ token ประจำ tenant ═══════════════════ */

async function getDashToken(env, key, { create = true } = {}) {
  let t = await env.KV.get(`dtoken:${key}`);
  if (!t && create) {
    t = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    await env.KV.put(`dtoken:${key}`, t);
    console.log(`[token] ออกใหม่ให้ tenant=${key}`);
  }
  return t;
}

async function resetDashToken(env, key) {
  const t = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  await env.KV.put(`dtoken:${key}`, t);
  console.log(`[token] รีเซ็ต tenant=${key}`);
  return t;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ═══════════ เตือนเมื่อยังตั้งค่าไม่ครบ ═══════════ */

/**
 * คืนข้อความเตือนสั้น ๆ ถ้ายังตั้งค่าข้อมูลบริษัทไม่ครบ — ไม่ครบก็คืน null
 * ใช้ KV flag กันอ่านชีทซ้ำทุกครั้งที่บันทึกรายการ
 */
async function setupWarning(env, key, sheet) {
  try {
    if ((await env.KV.get(`setup:${key}`)) === "1") return null;

    const s = await readSettings(env, sheet.sheetId, sheet.token);
    const missing = [];
    if (!s.company_name) missing.push("ชื่อบริษัท");
    if (!s.tax_id) missing.push("เลขผู้เสียภาษี");
    if (!s.approver_name) missing.push("ชื่อผู้อนุมัติ");

    if (!missing.length) {
      await env.KV.put(`setup:${key}`, "1");
      return null;
    }
    return `⚠️ ยังไม่ได้ตั้งค่า ${missing.join(" · ")} — ใบรับรองแทนใบเสร็จที่ออกจะไม่สมบูรณ์ กด "เปิดแดชบอร์ด" ด้านล่างเพื่อตั้งค่า`;
  } catch (e) {
    console.warn("setupWarning", e.message);
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    if (url.pathname === "/oauth/connect") {
      const key = url.searchParams.get("tenant");
      if (!key) return new Response("missing tenant", { status: 400 });
      return Response.redirect(buildConnectUrl(env, url.origin, key), 302);
    }
    if (url.pathname === "/oauth/callback") {
      return await handleCallback(env, url, url.origin);
    }

    /* ══════════════ admin ══════════════ */

    if (url.pathname === "/admin/tenants") {
      if (!adminOk(env, url)) return json({ error: "unauthorized" }, 401);
      try {
        const list = await env.KV.list({ prefix: "tenant:" });
        const out = [];
        for (const k of list.keys) {
          const tenant = k.name.slice("tenant:".length);
          const sheetId = await env.KV.get(k.name);
          out.push({
            tenant, sheetId,
            connected: !!(await env.KV.get(`gtoken:${tenant}`)),
            hasDashToken: !!(await env.KV.get(`dtoken:${tenant}`)),
            setupDone: (await env.KV.get(`setup:${tenant}`)) === "1",
            sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
          });
        }
        return json({ ok: true, count: out.length, defaultSheetId: env.DEFAULT_SHEET_ID || null, tenants: out });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (url.pathname === "/admin/migrate") {
      if (!adminOk(env, url)) return json({ error: "unauthorized" }, 401);
      const key = url.searchParams.get("tenant");
      const override = url.searchParams.get("sheetId");
      const sheetId = override || (key && (await env.KV.get(`tenant:${key}`))) || env.DEFAULT_SHEET_ID;
      if (!sheetId) return json({ error: "no sheet — ใส่ ?sheetId= หรือ ?tenant= ที่ถูก" }, 404);
      try {
        const token = key ? await getUserToken(env, key) : null;
        const headers = await ensureHeaders(env, sheetId, token);
        const ids = await backfillIds(env, sheetId, token);
        const settings = await ensureSettingsTab(env, sheetId, token);
        return json({ ok: true, sheetId, usedOAuthToken: !!token, headers, ids, settings });
      } catch (e) {
        console.error("migrate", e);
        return json({ error: String(e) }, 500);
      }
    }

    /* ══════════════ API ให้ dashboard ══════════════ */

    if (url.pathname.startsWith("/api/")) {
      const key = url.searchParams.get("tenant");
      if (!key) return cors(json({ error: "missing tenant" }, 400));

      const expected = await getDashToken(env, key, { create: false });
      if (!expected || !safeEqual(url.searchParams.get("k") || "", expected)) {
        return cors(json({
          error: "unauthorized",
          hint: 'ลิงก์ไม่ถูกต้องหรือถูกยกเลิกแล้ว — พิมพ์ "แดชบอร์ด" ในกลุ่ม LINE เพื่อขอลิงก์ใหม่',
        }, 401));
      }

      const sheetId = (await env.KV.get(`tenant:${key}`)) || env.DEFAULT_SHEET_ID;
      if (!sheetId) return cors(json({ error: "no sheet for tenant" }, 404));

      try {
        const token = await getUserToken(env, key);

        if (url.pathname === "/api/expenses") {
          return cors(json(await readExpenses(env, sheetId, token)));
        }

        if (url.pathname === "/api/slip-items") {
          const onlyUnissued = url.searchParams.get("all") !== "1";
          return cors(json(await listForSlip(env, sheetId, token, { onlyUnissued })));
        }

        if (url.pathname === "/api/slip-toggle" && request.method === "POST") {
          const b = await request.json();
          let out;
          if (typeof b.value === "boolean") {
            const r = await updateExpenseById(env, sheetId, b.id, { needSlip: b.value }, token);
            out = r.ok ? { ok: true, needSlip: b.value } : r;
          } else {
            out = await toggleNeedSlip(env, sheetId, b.id, token);
          }
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/settings") {
          if (request.method === "POST") {
            const b = await request.json();
            const saved = await writeSettings(env, sheetId, b, token);
            await env.KV.delete(`setup:${key}`);   // ให้เช็คใหม่รอบหน้า
            return cors(json(saved));
          }
          return cors(json(await readSettings(env, sheetId, token)));
        }

        if (url.pathname === "/api/orphans") {
          const [files, used] = await Promise.all([
            listUploadedImages(env, token),
            usedFileIds(env, sheetId, token),
          ]);
          const unlinked = files.filter((f) => !used.has(f.fileId));
          const showAll = url.searchParams.get("all") === "1";
          return cors(json({
            total: files.length,
            linked: files.length - unlinked.length,
            types: ATTACH_TYPES,
            files: showAll ? files : unlinked,
          }));
        }

        if (url.pathname === "/api/attach" && request.method === "POST") {
          const b = await request.json();
          const out = await addAttachment(env, sheetId, b.id, b.type, b.url, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/detach" && request.method === "POST") {
          const b = await request.json();
          const out = await removeAttachment(env, sheetId, b.id, b.url, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        return cors(json({ error: "unknown endpoint" }, 404));
      } catch (e) {
        console.error(url.pathname, e);
        return cors(json({ error: String(e) }, 500));
      }
    }

    if (request.method === "GET") return json({ version: VERSION, ok: true });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

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

/* ═════════════════════════ helper ═════════════════════════ */

function adminOk(env, url) {
  return !!env.ADMIN_KEY && url.searchParams.get("key") === env.ADMIN_KEY;
}

function tenantKey(source = {}) {
  return source.groupId || source.roomId || source.userId || "unknown";
}

async function tenantTitle(env, source) {
  try {
    if (source.groupId) {
      const r = await fetch(`https://api.line.me/v2/bot/group/${source.groupId}/summary`, {
        headers: { Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}` } });
      if (r.ok) return (await r.json()).groupName || "";
    } else if (source.userId) {
      const r = await fetch(`https://api.line.me/v2/bot/profile/${source.userId}`, {
        headers: { Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}` } });
      if (r.ok) return (await r.json()).displayName || "";
    }
  } catch {}
  return "";
}

async function resolveSheet(env, source) {
  const key = tenantKey(source);
  const userTok = await getUserToken(env, key);
  if (userTok) {
    let sheetId = await env.KV.get(`tenant:${key}`);
    if (!sheetId) {
      const title = `DEAL Finance · ${(await tenantTitle(env, source)) || key.slice(0, 8)}`;
      sheetId = (await createUserSheet(env, userTok, title)).sheetId;
      await env.KV.put(`tenant:${key}`, sheetId);
    }
    return { sheetId, token: userTok };
  }
  if (env.DEFAULT_SHEET_ID) return { sheetId: env.DEFAULT_SHEET_ID, token: null };
  return null;
}

async function getDisplayName(env, source) {
  try {
    const uid = source.userId; if (!uid) return "";
    const url = source.groupId
      ? `https://api.line.me/v2/bot/group/${source.groupId}/member/${uid}`
      : `https://api.line.me/v2/bot/profile/${uid}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}` } });
    if (!r.ok) return "";
    return (await r.json()).displayName || "";
  } catch { return ""; }
}

async function dashUrl(env, key, path = "") {
  if (!env.DASHBOARD_URL) return null;
  const base = env.DASHBOARD_URL.replace(/\/$/, "");
  const tok = await getDashToken(env, key);
  return `${base}${path}?tenant=${encodeURIComponent(key)}&k=${tok}`;
}

function monthOf(r) {
  if (r.dateISO && r.dateISO.length >= 7) return r.dateISO.slice(0, 7);
  const d = normalizeDate(r.dateText || r.date);
  return d ? d.iso.slice(0, 7) : "";
}

async function computeStats(env, sheet, rec, justAppended = null) {
  let all = [];
  try {
    all = await readExpenses(env, sheet.sheetId, sheet.token);
  } catch (e) {
    console.warn("stats read", e.message);
    return null;
  }
  if (justAppended && !all.some((r) => r.id === justAppended.id)) all = [...all, justAppended];

  const nowMonth = new Date().toISOString().slice(0, 7);
  let monthTotal = 0, categoryTotal = 0, unpaidTotal = 0;
  for (const r of all) {
    if (r.type === "รายรับ") continue;
    const amt = Number(r.amount) || 0;
    if (monthOf(r) === nowMonth) {
      monthTotal += amt;
      if (rec.category && r.category === rec.category) categoryTotal += amt;
    }
    if (!r.paid) unpaidTotal += amt;
  }
  return { monthTotal, categoryTotal: rec.category ? categoryTotal : undefined, unpaidTotal };
}

async function renderSaved(env, key, sheet, rec, justAppended = null) {
  const [stats, warn, url] = await Promise.all([
    computeStats(env, sheet, rec, justAppended),
    setupWarning(env, key, sheet),
    dashUrl(env, key),
  ]);
  return savedCard(rec, rec.imageUrl || null, url, {
    id: rec.id, stats, insight: warn || undefined,
  });
}

function connectMsg(env, key) {
  const url = `${env.WORKER_URL}/oauth/connect?tenant=${encodeURIComponent(key)}`;
  return {
    type: "flex", altText: "เชื่อม Google เพื่อเริ่มใช้งาน",
    contents: { type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "text", text: "เชื่อม Google ก่อนใช้งาน 🔗", weight: "bold", size: "md", color: "#1F6E56" },
        { type: "text", text: "กดปุ่มด้านล่างเพื่อเชื่อม Google Drive ของคุณ — บิลและชีทจะเก็บในบัญชีของคุณเอง", size: "sm", color: "#8c8c8c", wrap: true },
      ] },
      footer: { type: "box", layout: "vertical", contents: [
        { type: "button", style: "primary", color: "#1F6E56", height: "sm",
          action: { type: "uri", label: "เชื่อม Google", uri: url } },
      ] },
    },
  };
}

async function dashboardMsg(env, key) {
  const url = await dashUrl(env, key);
  return {
    type: "flex", altText: "เปิดแดชบอร์ดสรุปบัญชี",
    contents: { type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "text", text: "\u{1F4CA} สรุปบัญชีของคุณ", weight: "bold", size: "md", color: "#1F6E56" },
        { type: "text", text: "ดูยอดใช้จ่าย ออกใบแทน จับคู่หลักฐาน ตั้งค่าบริษัท — ครบในที่เดียว", size: "sm", color: "#8c8c8c", wrap: true },
        { type: "text", text: "ลิงก์นี้เป็นความลับ — ใครมีลิงก์ก็เปิดดูได้ ถ้าหลุดให้พิมพ์ \"รีเซ็ตลิงก์\"", size: "xxs", color: "#B0847A", wrap: true, margin: "md" },
      ] },
      footer: { type: "box", layout: "vertical", contents: [
        { type: "button", style: "primary", color: "#1F6E56", height: "sm",
          action: { type: "uri", label: "เปิดแดชบอร์ด", uri: url } },
      ] },
    },
  };
}

/* ═════════════════════════ event handler ═════════════════════════ */

async function handleEvent(event, env) {
  const key = tenantKey(event.source);
  console.log(`[event] type=${event.type} tenant=${key} user=${event.source?.userId || "-"}`);

  if (event.type === "join" || event.type === "follow") {
    return reply(env, event.replyToken, [
      textMsg("สวัสดีครับ ผมน้องช่วยบัญชีของ DEAL 📒\nเริ่มใช้งานง่าย ๆ แค่เชื่อม Google ครั้งเดียว แล้วส่งรูปบิลได้เลย"),
      connectMsg(env, key),
    ]);
  }

  if (event.type === "message" && event.message?.type === "image") return handleImage(event, env, key);
  if (event.type === "postback") return handlePostback(event, env, key);
  if (event.type === "message" && event.message?.type === "text") return handleText(event, env, key);
}

/* ───────────────────────── รูป ───────────────────────── */

async function handleImage(event, env, key) {
  const sheet = await resolveSheet(env, event.source);
  if (!sheet) return reply(env, event.replyToken, connectMsg(env, key));

  console.log(`[image] tenant=${key} sheetId=${sheet.sheetId} oauth=${!!sheet.token}`);

  const { base64, mediaType } = await getMessageContent(env, event.message.id);
  const driveLink = await uploadImage(env, base64, mediaType, `bill-${Date.now()}.jpg`, sheet.token);

  const uid = event.source.userId;
  const raw = uid ? await env.KV.get(`attach:${uid}`) : null;
  if (raw) {
    await env.KV.delete(`attach:${uid}`);
    let target;
    try { target = JSON.parse(raw); } catch { target = { id: raw, type: "attOther" }; }
    const out = await addAttachment(env, sheet.sheetId, target.id, target.type || "attOther", driveLink, sheet.token);
    if (!out.ok) return reply(env, event.replyToken, textMsg(MSG_STALE));
    return reply(env, event.replyToken, await renderSaved(env, key, sheet, out.record));
  }

  const record = await ocrReceipt(env, base64, mediaType);
  const sender = await getDisplayName(env, event.source);

  const id = crypto.randomUUID().slice(0, 8);
  await env.KV.put(`pending:${id}`,
    JSON.stringify({ record, driveLink, sheetId: sheet.sheetId, sender }),
    { expirationTtl: 3600 });

  return reply(env, event.replyToken, confirmCard(id, record, { driveLink }));
}

/* ───────────────────────── postback ───────────────────────── */

async function handlePostback(event, env, key) {
  const p = new URLSearchParams(event.postback.data);
  const act = p.get("act");
  const id = p.get("id");
  const field = p.get("f");
  const uid = event.source.userId;

  if (PENDING_ACTS.has(act)) {
    const raw = await env.KV.get(`pending:${id}`);
    if (!raw) return reply(env, event.replyToken, textMsg(MSG_STALE));
    const pending = JSON.parse(raw);

    if (act === "cancel") {
      await env.KV.delete(`pending:${id}`);
      return reply(env, event.replyToken, textMsg('ยกเลิกแล้วครับ ไม่ได้บันทึกลงชีท\nรูปยังอยู่ใน Drive — จับเข้ารายการอื่นได้จากแดชบอร์ด'));
    }

    const token = await getUserToken(env, key);
    const sheet = { sheetId: pending.sheetId, token };

    // ⭐ ทุกรายการที่เบิก ตั้งให้ออกใบแทนไว้ก่อน — บัญชีค่อยเอาออกในแดชบอร์ด
    const toSave = { ...pending.record, needSlip: true };

    const { id: rowId, row } = await appendExpense(
      env, pending.sheetId, toSave,
      { sender: pending.sender, driveLink: pending.driveLink, payerName: pending.sender },
      token
    );
    await env.KV.delete(`pending:${id}`);

    const d = normalizeDate(pending.record.date);
    const rec = {
      ...toSave,
      id: rowId, _row: row,
      imageUrl: pending.driveLink,
      payerName: pending.sender, sender: pending.sender,
      dateText: d.text, dateISO: d.iso,
      status: "รอเบิก", paid: false,
      type: pending.record.type || "รายจ่าย",
    };
    return reply(env, event.replyToken, await renderSaved(env, key, sheet, rec, rec));
  }

  const sheet = await resolveSheet(env, event.source);
  if (!sheet) return reply(env, event.replyToken, connectMsg(env, key));

  if (act === "paid") {
    const out = await togglePaid(env, sheet.sheetId, id, sheet.token);
    if (!out.ok) return reply(env, event.replyToken, textMsg(MSG_STALE));
    return reply(env, event.replyToken, await renderSaved(env, key, sheet, out.record));
  }

  if (act === "more") {
    const rec = await getExpenseById(env, sheet.sheetId, id, sheet.token);
    if (!rec) return reply(env, event.replyToken, textMsg(MSG_STALE));
    return reply(env, event.replyToken, moreCard(rec, { id }));
  }

  if (act === "back") {
    const rec = await getExpenseById(env, sheet.sheetId, id, sheet.token);
    if (!rec) return reply(env, event.replyToken, textMsg(MSG_STALE));
    return reply(env, event.replyToken, await renderSaved(env, key, sheet, rec));
  }

  if (act === "delete") {
    const out = await softDeleteById(env, sheet.sheetId, id, sheet.token);
    if (!out.ok) return reply(env, event.replyToken, textMsg(MSG_STALE));
    return reply(env, event.replyToken, textMsg("ลบรายการแล้วครับ 🗑️"));
  }

  if (act === "attach") {
    if (!uid) return reply(env, event.replyToken, textMsg("ส่งรูปมาในแชทส่วนตัวนะครับ"));
    const type = p.get("t") || "attOther";
    await env.KV.put(`attach:${uid}`, JSON.stringify({ id, type }), { expirationTtl: 600 });
    return reply(env, event.replyToken, textMsg("ส่งรูปหลักฐานมาได้เลยครับ 📸 (ภายใน 10 นาที)"));
  }

  if (act === "edit" || act === "fix") {
    if (!uid) return reply(env, event.replyToken, textMsg("ทำรายการนี้ในแชทส่วนตัวนะครับ"));
    const isPending = !!(await env.KV.get(`pending:${id}`));
    const f = act === "fix" && field ? field : "amount";
    await env.KV.put(`edit:${uid}`,
      JSON.stringify({ id, field: f, scope: isPending ? "pending" : "sheet" }),
      { expirationTtl: 600 });
    return reply(env, event.replyToken, textMsg(promptFor(f)));
  }
}

function promptFor(field) {
  switch (field) {
    case "amount":   return "พิมพ์ยอดเงินที่ถูกต้องมาได้เลย (เฉพาะตัวเลข)";
    case "date":     return "พิมพ์วันที่ที่ถูกต้อง เช่น 24/07/2569 หรือ 2026-07-24";
    case "vendor":   return "พิมพ์ชื่อร้าน/ผู้รับเงินที่ถูกต้อง";
    case "category": return "พิมพ์หมวดที่ถูกต้อง";
    case "note":     return "พิมพ์รายละเอียดที่ถูกต้อง";
    default:         return "พิมพ์ค่าที่ถูกต้องมาได้เลย";
  }
}

/* ───────────────────────── ข้อความ ───────────────────────── */

async function handleText(event, env, key) {
  const text = (event.message.text || "").trim();
  const uid = event.source.userId;

  const editRaw = uid ? await env.KV.get(`edit:${uid}`) : null;
  if (editRaw) {
    let state;
    try { state = JSON.parse(editRaw); }
    catch { state = { id: editRaw, field: "amount", scope: "pending" }; }
    const { id, field, scope } = state;

    let value = text;
    if (field === "amount") {
      value = Number(text.replace(/[^0-9.]/g, ""));
      if (!(value > 0)) {
        return reply(env, event.replyToken, textMsg("พิมพ์เป็นตัวเลขนะครับ เช่น 128 หรือ 128.50"));
      }
    }

    await env.KV.delete(`edit:${uid}`);

    if (scope === "pending") {
      const raw = await env.KV.get(`pending:${id}`);
      if (!raw) return reply(env, event.replyToken, textMsg(MSG_STALE));
      const pending = JSON.parse(raw);
      pending.record[field] = value;
      await env.KV.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: 3600 });
      return reply(env, event.replyToken,
        confirmCard(id, pending.record, { driveLink: pending.driveLink }));
    }

    const sheet = await resolveSheet(env, event.source);
    if (!sheet) return reply(env, event.replyToken, connectMsg(env, key));
    const upd = await updateExpenseById(env, sheet.sheetId, id, { [field]: value }, sheet.token);
    if (!upd.ok) return reply(env, event.replyToken, textMsg(MSG_STALE));
    const rec = await getExpenseById(env, sheet.sheetId, id, sheet.token);
    if (!rec) return reply(env, event.replyToken, textMsg(MSG_STALE));
    return reply(env, event.replyToken, await renderSaved(env, key, sheet, rec));
  }

  if (/^id$/i.test(text)) {
    return reply(env, event.replyToken, textMsg(`tenant key ของที่นี่คือ:\n${key}`));
  }

  if (/^migrate$/i.test(text)) {
    const sheet = await resolveSheet(env, event.source);
    if (!sheet) return reply(env, event.replyToken, connectMsg(env, key));
    try {
      const h = await ensureHeaders(env, sheet.sheetId, sheet.token);
      const i = await backfillIds(env, sheet.sheetId, sheet.token);
      const s = await ensureSettingsTab(env, sheet.sheetId, sheet.token);
      await env.KV.delete(`setup:${key}`);
      return reply(env, event.replyToken, textMsg(
        `อัปเกรดชีทเรียบร้อย ✅\n` +
        `หัวคอลัมน์: ${h.changed ? `เพิ่ม ${h.added} ช่อง` : "ครบอยู่แล้ว"}\n` +
        `เติม id/วันที่: ${i.filled} ช่อง\n` +
        `แท็บ _settings: ${s.created ? "สร้างใหม่" : "มีอยู่แล้ว"}`
      ));
    } catch (e) {
      return reply(env, event.replyToken, textMsg("อัปเกรดไม่สำเร็จ 🙏\n" + String(e).slice(0, 300)));
    }
  }

  if (/^(รีเซ็ตลิงก์|รีเซ็ทลิงก์|reset ?link|revoke)$/i.test(text)) {
    await resetDashToken(env, key);
    const url = await dashUrl(env, key);
    if (!url) return reply(env, event.replyToken, textMsg("ออกลิงก์ใหม่แล้ว แต่ยังไม่ได้ตั้งค่าแดชบอร์ดครับ 🙏"));
    return reply(env, event.replyToken, textMsg(
      "ออกลิงก์ใหม่แล้ว ✅ ลิงก์เก่าทั้งหมดใช้ไม่ได้อีกต่อไป\n\nแดชบอร์ด:\n" + url
    ));
  }

  if (/^(หลักฐาน|จับคู่รูป|files)$/i.test(text)) {
    const url = await dashUrl(env, key, "/files");
    if (!url) return reply(env, event.replyToken, textMsg("ยังไม่ได้ตั้งค่าแดชบอร์ดครับ 🙏"));
    return reply(env, event.replyToken, textMsg("จับคู่รูปหลักฐานเข้ารายการได้ที่นี่ 📎\n" + url));
  }

  if (/^(ใบแทน|ใบรับรอง|receipt)$/i.test(text)) {
    const url = await dashUrl(env, key, "/receipt");
    if (!url) return reply(env, event.replyToken, textMsg("ยังไม่ได้ตั้งค่าแดชบอร์ดครับ 🙏"));
    return reply(env, event.replyToken, textMsg("ออกใบรับรองแทนใบเสร็จได้ที่นี่ 🧾\n" + url));
  }

  if (/เชื่อม|connect/i.test(text)) {
    return reply(env, event.replyToken, connectMsg(env, key));
  }

  if (/สรุป|dashboard|แดชบอร์ด/i.test(text)) {
    if (!env.DASHBOARD_URL) return reply(env, event.replyToken, textMsg("ยังไม่ได้ตั้งค่าแดชบอร์ดครับ 🙏"));
    return reply(env, event.replyToken, await dashboardMsg(env, key));
  }

  if (/^(ช่วย|help|คำสั่ง)$/i.test(text)) {
    return reply(env, event.replyToken, textMsg(
      "ปกติแค่ส่งรูปบิลก็พอครับ ที่เหลือกดจากการ์ดได้เลย 📒\n\n" +
      "คำสั่งเสริม (ถ้าอยากใช้):\n" +
      "• แดชบอร์ด — เปิดหน้ารวมทุกอย่าง\n" +
      "• รีเซ็ตลิงก์ — ยกเลิกลิงก์เก่าทั้งหมด\n" +
      "• เชื่อม — เชื่อม Google"
    ));
  }
}

/* ═════════════════════════ utils ═════════════════════════ */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json" } });
}
function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "*");
  return res;
}
