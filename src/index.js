// DEAL LINE Finance Bot — v1.3
// ถ่ายบิลลง LINE → OCR → ยืนยัน → เขียนชีท (+เก็บรูป) → dashboard
//
// เปลี่ยนจาก v1.2:
//   • flag ตั้งค่าผูกกับ sheetId ด้วย (setup:{tenant}:{sheetId}) — ชีทเปลี่ยน flag เก่าใช้ไม่ได้ทันที
//   • อ่านตั้งค่าไม่ได้ = ให้ปุ่มเพิ่มข้อมูลบริษัทขึ้น ไม่เงียบ
//   • ล้าง flag ทั้งแบบเก่าและแบบผูก sheetId ตอนบันทึกตั้งค่า / migrate

import { verifySignature, getMessageContent, reply, push, textMsg, confirmCard, savedCard, moreCard } from "./line.js";
import { ocrReceipt } from "./ocr.js";
import {
  appendExpense, readExpenses, getExpenseById, updateExpenseById,
  togglePaid, toggleNeedSlip, softDeleteById, listForSlip, normalizeDate,
  ensureHeaders, backfillIds, readSettings, writeSettings, ensureSettingsTab,
  addAttachment, removeAttachment, usedFileIds, ATTACH_TYPES, findDuplicateExpenses,
} from "./sheets.js";
import { uploadImage, listUploadedImages } from "./drive.js";
import { createExpenseDocuments } from "./documents.js";
import {
  handleIncomingEmail, getEmailInboxInfo, rotateEmailInbox, listEmailDocuments,
  listSubscriptions, approveEmailDocument, patchEmailDocument,
} from "./email.js";
import { ensureEmailInboxTab } from "./email-sheets.js";
import { buildConnectUrl, handleCallback, getUserToken, createUserSheet } from "./oauth.js";
import {
  buildGmailConnectUrl, handleGmailCallback, getGmailStatus,
  syncGmailAccount, syncConnectedGmailAccounts, disconnectGmail,
} from "./gmail.js";
import {
  ensureBatchTab, getBatchDashboard, createReimbursementBatches,
  requestUrgentBatch, updateReimbursementBatchStatus,
  updateReimbursementBatchWorkflow, uploadReimbursementPaymentSlip,
  runScheduledReimbursementBatches,
} from "./batches.js";
import {
  ensureReconciliationTab, getReconciliationDashboard,
  importReconciliationRows, confirmReconciliationMatches,
  unlinkReconciliationMatch, ignoreReconciliationRow,
} from "./reconciliation.js";
import {
  createMemberOnboardingUrl, handleMemberOnboarding,
  getMemberProfile, memberProfileComplete, missingMemberFields,
  findMemberProfile,
} from "./member-profile.js";
import {
  MultiExpenseSession, touchMultiSession, addMultiImage,
  forceMultiSummary, cancelMultiSession, confirmMultiSession, handleMultiHttp,
} from "./multi-expense.js";

export { MultiExpenseSession } from "./multi-expense.js";

const VERSION = "DEAL_LINE_BOT_v2.8_REVIEW_MERGE_CLAIMS_20260805";

const PENDING_ACTS = new Set(["confirm", "confirm_force", "cancel"]);
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

/* ═══════════ เช็คว่าตั้งค่าข้อมูลบริษัทครบหรือยัง ═══════════ */

/**
 * คืน { warn } ถ้ายังไม่ครบ / คืน null ถ้าครบแล้ว
 * ใช้ KV flag `setup:{tenant}:{sheetId}` กันอ่านชีทซ้ำทุกครั้งที่บันทึกรายการ
 * ผูกกับ sheetId เพื่อกัน flag ค้างข้ามชีท — ล้างเมื่อบันทึกตั้งค่าใหม่ / migrate / เชื่อมใหม่
 */
async function checkSetup(env, key, sheet) {
  // ผูก flag กับ sheetId ด้วย — ชีทเปลี่ยนเมื่อไหร่ flag เก่าใช้ไม่ได้ทันที
  const flag = `setup:${key}:${sheet.sheetId}`;
  try {
    if ((await env.KV.get(flag)) === "1") return null;

    const s = await readSettings(env, sheet.sheetId, sheet.token);
    const missing = [];
    if (!s.company_name)  missing.push("ชื่อบริษัท");
    if (!s.tax_id)        missing.push("เลขผู้เสียภาษี");
    if (!s.approver_name) missing.push("ชื่อผู้อนุมัติ");

    if (!missing.length) {
      await env.KV.put(flag, "1");
      return null;
    }
    return { warn: `ยังขาด ${missing.join(" · ")} — ระบบยังสร้างใบเบิกและใบแทนไม่ได้ กดปุ่มส้มด้านล่างเพื่อกรอก (ทำครั้งเดียว)` };
  } catch (e) {
    // อ่านตั้งค่าไม่ได้ = ถือว่ายังไม่ครบ ให้ปุ่มขึ้น ดีกว่าเงียบแล้วลูกค้าไม่รู้ตัว
    console.warn("checkSetup", e.message);
    return { warn: "อ่านข้อมูลบริษัทไม่ได้ — กดปุ่มด้านล่างเพื่อตรวจการตั้งค่า" };
  }
}

function documentSettingsReady(s = {}) {
  return !!(s.company_name && s.tax_id && s.approver_name);
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

    if (url.pathname === "/gmail/connect") {
      const key = url.searchParams.get("tenant");
      if (!key) return new Response("missing tenant", { status: 400 });
      const expected = await getDashToken(env, key, { create: false });
      if (!expected || !safeEqual(url.searchParams.get("k") || "", expected)) {
        return new Response("invalid dashboard link", { status: 401 });
      }
      try {
        return Response.redirect(await buildGmailConnectUrl(env, url.origin, key), 302);
      } catch (e) {
        console.error("gmail connect", e);
        return new Response(String(e), { status: 500 });
      }
    }
    if (url.pathname === "/gmail/callback") {
      return await handleGmailCallback(env, url, url.origin);
    }

    if (url.pathname === "/member/onboard") {
      return handleMemberOnboarding(request, env, url);
    }

    if (url.pathname.startsWith("/multi/")) {
      return handleMultiHttp(request, env, url);
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
            setupDone: (await env.KV.get(`setup:${tenant}:${sheetId}`)) === "1",
            sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
          });
        }
        return json({ ok: true, count: out.length, tenants: out });
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
        const emailInbox = await ensureEmailInboxTab(env, sheetId, token);
        const batchTab = await ensureBatchTab(env, sheetId, token);
        const reconciliationTab = await ensureReconciliationTab(env, sheetId, token);
        return json({ ok: true, sheetId, usedOAuthToken: !!token, headers, ids, settings, emailInbox, batchTab, reconciliationTab });
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
            await env.KV.delete(`setup:${key}`);              // ของเก่า
            await env.KV.delete(`setup:${key}:${sheetId}`);   // ให้เช็คใหม่รอบหน้า
            return cors(json(saved));
          }
          return cors(json(await readSettings(env, sheetId, token)));
        }

        /* Gmail OAuth — เชื่อมโดยตรงสำหรับ Beta */
        if (url.pathname === "/api/gmail-status") {
          return cors(json(await getGmailStatus(env, key)));
        }

        if (url.pathname === "/api/gmail-sync" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await syncGmailAccount(env, key, {
            maxMessages: Math.max(1, Math.min(30, Number(b.maxMessages || 15))),
            notify: b.notify !== false,
          });
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/gmail-disconnect" && request.method === "POST") {
          return cors(json(await disconnectGmail(env, key)));
        }

        /* Email Inbox เดิมแบบ Forward — ยังเก็บไว้เป็น fallback */
        if (url.pathname === "/api/email-inbox-info") {
          if (request.method === "POST") {
            const b = await request.json().catch(() => ({}));
            const info = b.rotate ? await rotateEmailInbox(env, key) : await getEmailInboxInfo(env, key);
            await ensureEmailInboxTab(env, sheetId, token);
            return cors(json({ ok: true, ...info }));
          }
          const info = await getEmailInboxInfo(env, key);
          await ensureEmailInboxTab(env, sheetId, token);
          return cors(json({ ok: true, ...info }));
        }

        if (url.pathname === "/api/email-documents") {
          return cors(json(await listEmailDocuments(env, sheetId, token)));
        }

        if (url.pathname === "/api/subscriptions") {
          return cors(json(await listSubscriptions(env, sheetId, token)));
        }

        if (url.pathname === "/api/email-update" && request.method === "POST") {
          const b = await request.json();
          const out = await patchEmailDocument(env, sheetId, b.id, b.patch || {}, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/email-ignore" && request.method === "POST") {
          const b = await request.json();
          const out = await patchEmailDocument(env, sheetId, b.id, { status: "ข้ามแล้ว" }, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/email-approve" && request.method === "POST") {
          const b = await request.json();
          const out = await approveEmailDocument(env, sheetId, b.id, token, { force: b.force === true });
          return cors(json(out, out.ok ? 200 : (out.reason === "duplicate" ? 409 : 400)));
        }

        /* ใบเบิกหลัก — รวมหลายรายการย่อยของผู้เบิกเป็นไฟล์เดียว */
        if (url.pathname === "/api/batches") {
          return cors(json(await getBatchDashboard(env, sheetId, token)));
        }

        if (url.pathname === "/api/batch-close" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await createReimbursementBatches(env, key, sheetId, token, {
            type: b.type === "ด่วน" ? "ด่วน" : "ปกติ",
            payerKey: b.payerKey || "",
            expenseIds: Array.isArray(b.expenseIds) ? b.expenseIds : [],
            batchIds: Array.isArray(b.batchIds) ? b.batchIds : [],
            note: b.note || "สร้างหรือรวมใบเบิกด้วยตนเองจาก Dashboard",
          });
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/batch-urgent" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const ids = Array.isArray(b.expenseIds) ? b.expenseIds : [b.id].filter(Boolean);
          const out = await requestUrgentBatch(env, key, sheetId, token, ids);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/batch-status" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await updateReimbursementBatchStatus(env, sheetId, b.batchId, b.status, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/batch-workflow" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await updateReimbursementBatchWorkflow(env, sheetId, b.batchId, b.action, b.payload || {}, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/batch-payment-slip" && request.method === "POST") {
          const form = await request.formData();
          const batchId = String(form.get("batchId") || "");
          const paymentChannelId = String(form.get("paymentChannelId") || "");
          const file = form.get("file");
          const out = await uploadReimbursementPaymentSlip(env, sheetId, batchId, file, token, { paymentChannelId });
          return cors(json(out, out.ok ? 200 : 400));
        }

        /* กระทบยอดธนาคาร — Statement ↔ ใบเบิกที่จ่ายแล้ว */
        if (url.pathname === "/api/reconciliation") {
          const channelId = String(url.searchParams.get("channelId") || "");
          return cors(json(await getReconciliationDashboard(env, sheetId, token, { channelId })));
        }

        if (url.pathname === "/api/reconciliation-import" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const out = await importReconciliationRows(env, sheetId, body, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/reconciliation-confirm" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const out = await confirmReconciliationMatches(env, sheetId, body, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/reconciliation-unlink" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const out = await unlinkReconciliationMatch(env, sheetId, body.reconciliationId || body.id, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/reconciliation-ignore" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const out = await ignoreReconciliationRow(env, sheetId, body.reconciliationId || body.id, body.note || "", token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        // สร้าง/สร้างใหม่ ใบเบิก + ใบแทนของรายการเดียว
        // หน้าเอกสารเรียกอัตโนมัติเมื่อเปิดรายการเก่าที่ยังไม่มีไฟล์
        if (url.pathname === "/api/generate-docs" && request.method === "POST") {
          const b = await request.json();
          const rec = await getExpenseById(env, sheetId, b.id, token);
          if (!rec) return cors(json({ error: "not_found" }, 404));
          if (!b.force && rec.claimPdfUrl && rec.receiptPdfUrl) {
            return cors(json({ ok: true, skipped: true, record: rec }));
          }
          const settings = await readSettings(env, sheetId, token);
          if (!documentSettingsReady(settings)) {
            return cors(json({
              error: "settings_incomplete",
              hint: "กรอกชื่อบริษัท เลขผู้เสียภาษี และชื่อผู้อนุมัติก่อนสร้างเอกสาร",
            }, 400));
          }
          const member = findMemberProfile(settings, {
            lineUserId: rec.payerId,
            name: rec.payerName || rec.sender,
          });
          const docRec = member ? {
            ...rec,
            payerName: member.name || rec.payerName,
            bankName: member.bank || "",
            bankAccountNo: member.accountNo || "",
            bankAccountName: member.accountName || member.name || "",
          } : rec;
          const docs = await createExpenseDocuments(env, docRec, settings, token);
          const patch = {
            slipNo: docs.receiptNo,
            claimPdfUrl: docs.claimUrl,
            receiptPdfUrl: docs.receiptUrl,
          };
          await updateExpenseById(env, sheetId, rec.id, patch, token);
          return cors(json({ ok: true, record: { ...rec, ...patch } }));
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
        // อัปโลโก้ / ลายเซ็น เข้า Drive ลูกค้า แล้วคืนลิงก์ที่ฝังในเอกสารได้
        if (url.pathname === "/api/upload-image" && request.method === "POST") {
          const b = await request.json();
          if (!b.base64) return cors(json({ error: "no image" }, 400));
          const link = await uploadImage(
            env, b.base64, b.mediaType || "image/png",
            b.name || `asset-${Date.now()}.png`, token
          );
          if (!link) return cors(json({ error: "upload failed" }, 500));
          const m = String(link).match(/\/d\/([a-zA-Z0-9_-]{20,})/);
          return cors(json({
            ok: true,
            url: m ? `https://lh3.googleusercontent.com/d/${m[1]}` : link,
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
        const quotaExceeded = e?.status === 429 || e?.isQuota || /Sheets 429|RESOURCE_EXHAUSTED|Quota exceeded/i.test(String(e?.message || e));
        if (quotaExceeded) {
          const res = json({
            error: "sheets_rate_limited",
            message: "Google Sheets ถูกเรียกถี่เกินไป ระบบหยุดยิงซ้ำแล้ว กรุณารอประมาณ 1 นาทีแล้วลองใหม่",
            retryAfterSeconds: Math.max(60, Number(e?.retryAfter || 0)),
          }, 429);
          res.headers.set("Retry-After", String(Math.max(60, Number(e?.retryAfter || 0))));
          return cors(res);
        }
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

    for (const event of body.events || []) {
      const key = tenantKey(event.source);
      const isImage = event.type === "message" && event.message?.type === "image";
      const postbackAct = event.type === "postback" ? new URLSearchParams(event.postback?.data || "").get("act") : "";
      const isConfirm = postbackAct === "confirm" || postbackAct === "confirm_force" || postbackAct === "multi_confirm";

      if (isImage) {
        // Session ต่อผู้ส่ง 1 คนในแต่ละบริษัท รองรับส่งรูปหลายใบพร้อมกันโดยไม่ตอบสแปมทุกภาพ
        const userId = event.source?.userId || key;
        const attachingExisting = event.source?.userId
          ? await env.KV.get(`attach:${event.source.userId}`)
          : null;
        if (attachingExisting) {
          await reply(env, event.replyToken, textMsg("รับรูปหลักฐานแล้วครับ กำลังแนบเข้ารายการ… ⏳"));
          ctx.waitUntil(runHeavyTask(
            () => handleImage(event, env, key, "push"),
            env, event, "แนบหลักฐาน", 30000
          ));
          continue;
        }
        let touched = { isNew: true };
        try {
          touched = await touchMultiSession(env, {
            tenant: key,
            userId,
            targetId: lineTarget(event.source),
          });
        } catch (e) {
          console.warn("multi touch", e.message);
        }
        if (touched.isNew) {
          await reply(env, event.replyToken, textMsg(
            `รับชุดเอกสารแล้วครับ ส่งรูปต่อได้เรื่อย ๆ ทั้งสลิป ใบเสร็จ และหลักฐานการใช้เงิน
ระบบจะจัดกลุ่มให้อัตโนมัติหลังรูปหยุดไหล ⏳`
          ));
        }
        ctx.waitUntil(runHeavyTask(
          () => handleImage(event, env, key, "push"),
          env, event, "อ่านรูปชุด", 40000
        ));
        continue;
      }

      if (isConfirm) {
        // ตอบรับทันที แล้วค่อย push การ์ดพร้อมใบเบิก/ใบแทนกลับมา
        await reply(env, event.replyToken, textMsg("รับรายการแล้วครับ กำลังบันทึกและสร้างเอกสารอัตโนมัติ… ⏳"));
        ctx.waitUntil(runHeavyTask(
          () => handlePostback(event, env, key, "push"),
          env, event, "สร้างเอกสาร", 25000
        ));
        continue;
      }

      ctx.waitUntil(handleEvent(event, env).catch((e) => reportEventError(env, event, e, "ประมวลผลรายการ")));
    }
    return new Response("ok");
  },

  async email(message, env, ctx) {
    return handleIncomingEmail(message, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.allSettled([
      syncConnectedGmailAccounts(env, {
        limit: Number(env.GMAIL_SYNC_BATCH || 5),
      }).catch(e => console.error("gmail scheduled sync", e)),
      runScheduledReimbursementBatches(env)
        .catch(e => console.error("reimbursement scheduled batch", e)),
    ]));
  },
};

/* ═════════════════════════ helper ═════════════════════════ */

function adminOk(env, url) {
  return !!env.ADMIN_KEY && url.searchParams.get("key") === env.ADMIN_KEY;
}

function tenantKey(source = {}) {
  return source.groupId || source.roomId || source.userId || "unknown";
}

function lineTarget(source = {}) {
  return source.groupId || source.roomId || source.userId || "";
}

async function sendEvent(env, event, messages, mode = "reply") {
  if (mode === "push") return push(env, lineTarget(event.source), messages);
  return reply(env, event.replyToken, messages);
}

function friendlyError(error, label = "ประมวลผล") {
  const raw = String(error?.message || error || "unknown error");
  if (/429|quota/i.test(raw)) return `${label}ไม่สำเร็จ: โควตา OCR หมดหรือ API ถูกจำกัด`;
  if (/GEMINI_KEY|CLAUDE_KEY|OCR/i.test(raw)) return `${label}ไม่สำเร็จ: ระบบอ่านบิลมีปัญหา`;
  if (/Drive|upload|Google/i.test(raw)) return `${label}ไม่สำเร็จ: Google Drive มีปัญหา`;
  if (/timeout/i.test(raw)) return `${label}นานเกิน 25 วินาที ระบบหยุดงานนี้เพื่อไม่ให้เงียบค้าง`;
  return `${label}ไม่สำเร็จ: ${raw.slice(0, 160)}`;
}

async function reportEventError(env, event, error, label) {
  console.error(`[${label}]`, error);
  const target = lineTarget(event.source);
  if (!target) return false;
  return push(env, target, textMsg(`งานหยุดกลางทาง ❌\n${friendlyError(error, label)}\nลองส่งใหม่อีกครั้ง หากยังขึ้นซ้ำให้เปิด Cloudflare Live Logs ดูข้อความ error`));
}

async function runHeavyTask(task, env, event, label, timeoutMs = 25000) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      }),
    ]);
  } catch (e) {
    await reportEventError(env, event, e, label);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const [stats, setup, dash, documentsPage] = await Promise.all([
    computeStats(env, sheet, rec, justAppended),
    checkSetup(env, key, sheet),
    dashUrl(env, key),
    dashUrl(env, key, "/receipt"),
  ]);
  const setupUrl = setup && documentsPage && rec.id
    ? `${documentsPage}&id=${encodeURIComponent(rec.id)}`
    : (setup ? documentsPage : null);

  return savedCard(rec, rec.imageUrl || null, dash, {
    id: rec.id,
    stats,
    claimUrl: rec.claimPdfUrl || null,
    receiptUrl: rec.receiptPdfUrl || null,
    batchClaimUrl: rec.batchClaimPdfUrl || null,
    documentsUrl: documentsPage,
    // มี setupUrl = ยังตั้งค่าไม่ครบ → แจ้งให้กรอก แต่รายการยังบันทึกตามปกติ
    setupUrl,
    setupWarn: setup ? setup.warn : null,
    docWarn: rec.documentError || null,
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

async function sha256Base64(base64) {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function duplicateMeta(check) {
  if (!check?.hasDuplicate) return { duplicateStatus: "", duplicateOf: "" };
  return {
    duplicateStatus: check.level === "high"
      ? "ยืนยันบันทึกซ้ำ — ความเสี่ยงสูง"
      : "ยืนยันบันทึกซ้ำ — ควรตรวจสอบ",
    duplicateOf: check.matches.map((m) => m.id).filter(Boolean).join(", "),
  };
}

function memberProfileCard(profileUrl, pendingId, displayName, missing = []) {
  const missingText = missing.length ? `ยังขาด: ${missing.join(" · ")}` : "กรอกข้อมูลบัญชีรับเงินให้ครบ";
  return {
    type: "flex",
    altText: "กรอกข้อมูลผู้เบิกครั้งแรก",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box", layout: "vertical", paddingAll: "22px", contents: [
          { type: "text", text: "ตั้งค่าผู้เบิกครั้งแรก", size: "xs", color: "#6E6E73", weight: "bold" },
          { type: "text", text: displayName || "ข้อมูลผู้เบิก", size: "xl", color: "#111111", weight: "bold", wrap: true, margin: "sm" },
          { type: "text", text: "กรอกเพียงครั้งเดียวสำหรับบริษัทนี้ หลังจากนั้นตั้งเบิกได้ทันทีโดยไม่ต้องกรอกเลขบัญชีซ้ำ", size: "sm", color: "#6E6E73", wrap: true, margin: "md" },
          { type: "box", layout: "vertical", backgroundColor: "#F5F5F7", cornerRadius: "14px", paddingAll: "13px", margin: "lg", contents: [
            { type: "text", text: missingText, size: "xs", color: "#3A3A3C", wrap: true },
          ] },
        ],
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", paddingAll: "14px", contents: [
          { type: "button", style: "primary", color: "#111111", height: "sm", action: { type: "uri", label: "กรอกข้อมูลส่วนตัว", uri: profileUrl } },
          { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "บันทึกรายการต่อ", data: `act=confirm&id=${encodeURIComponent(pendingId)}` } },
        ],
      },
      styles: { body: { backgroundColor: "#FFFFFF" }, footer: { backgroundColor: "#FFFFFF" } },
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

async function handleImage(event, env, key, mode = "reply") {
  const respond = (messages) => sendEvent(env, event, messages, mode);
  const uid = event.source.userId;

  // ทำงานที่ไม่ขึ้นต่อกันพร้อมกัน เพื่อลดเวลาจากเดิมที่รอทีละขั้น
  const [sheet, content, sender, attachRaw] = await Promise.all([
    resolveSheet(env, event.source),
    getMessageContent(env, event.message.id),
    getDisplayName(env, event.source),
    uid ? env.KV.get(`attach:${uid}`) : Promise.resolve(null),
  ]);

  if (!sheet) return respond(connectMsg(env, key));
  console.log(`[image] tenant=${key} sheetId=${sheet.sheetId} oauth=${!!sheet.token}`);

  const { base64, mediaType } = content;
  const drivePromise = uploadImage(
    env, base64, mediaType, `bill-${Date.now()}.jpg`, sheet.token
  );

  if (attachRaw) {
    const driveLink = await drivePromise;
    if (!driveLink) throw new Error("Drive upload failed");
    await env.KV.delete(`attach:${uid}`);
    let target;
    try { target = JSON.parse(attachRaw); }
    catch { target = { id: attachRaw, type: "attOther" }; }
    const out = await addAttachment(
      env, sheet.sheetId, target.id, target.type || "attOther", driveLink, sheet.token
    );
    if (!out.ok) return respond(textMsg(MSG_STALE));
    return respond(await renderSaved(env, key, sheet, out.record));
  }

  // อัป Drive และสร้างลายนิ้วมือทำพร้อมกัน ส่วน OCR แยกจับ error
  // เพื่อให้รูปไม่หายจากชุดแม้ AI อ่านไม่สำเร็จ — ผู้ใช้ยังจัดรูปเองได้
  const [driveLink, imageHash] = await Promise.all([
    drivePromise,
    sha256Base64(base64),
  ]);
  if (!driveLink) throw new Error("Drive upload failed");

  let record;
  let ocrFailed = false;
  let ocrError = "";
  try {
    record = await ocrReceipt(env, base64, mediaType);
  } catch (e) {
    ocrFailed = true;
    ocrError = String(e?.message || e).slice(0, 500);
    console.error(`[multi-ocr-failed] tenant=${key} messageId=${event.message.id || ""}`, e);
    record = {
      amount: 0,
      vendor: "",
      transferor: "",
      date: "",
      category: "อื่น ๆ",
      note: "AI อ่านรูปไม่สำเร็จ — กรุณาจัดรูปและกรอกข้อมูลเอง",
      docType: "อื่น ๆ",
      role: "OTHER",
      taxId: "",
      invoiceNo: "",
      referenceNo: "",
      matchHint: "AI อ่านไม่สำเร็จ",
      type: "รายจ่าย",
      vat: false,
      vatRate: 0,
      whtRate: 0,
      flag: "AI อ่านรูปไม่สำเร็จ กรุณาตรวจและจัดรูปด้วยตนเอง",
      confidence: {
        amount: 0,
        vendor: 0,
        transferor: 0,
        date: 0,
        category: 0,
        note: 0,
      },
    };
  }

  const item = {
    ...record,
    ocrFailed,
    ocrError,
    id: `img_${event.message.id || crypto.randomUUID().slice(0, 8)}`,
    lineMessageId: event.message.id || "",
    driveUrl: driveLink,
    imgUrl: (() => {
      const m = String(driveLink).match(/\/d\/([a-zA-Z0-9_-]{20,})/);
      return m ? `https://lh3.googleusercontent.com/d/${m[1]}` : driveLink;
    })(),
    imageHash,
    mediaType,
  };

  const out = await addMultiImage(env, {
    tenant: key,
    userId: uid || key,
    targetId: lineTarget(event.source),
    displayName: sender,
    sheetId: sheet.sheetId,
  }, item);
  console.log(`[multi-image] tenant=${key} groups=${out.counts?.groups || 0} images=${out.counts?.images || 0} unassigned=${out.counts?.unassigned || 0}`);
  // Durable Object จะ debounce แล้ว push การ์ดสรุปเพียงครั้งเดียวหลังรูปหยุดไหล
  return out;

}

/* ───────────────────────── postback ───────────────────────── */

async function handlePostback(event, env, key, mode = "reply") {
  const respond = (messages) => sendEvent(env, event, messages, mode);
  const p = new URLSearchParams(event.postback.data);
  const act = p.get("act");
  const id = p.get("id");
  const field = p.get("f");
  const uid = event.source.userId;

  if (PENDING_ACTS.has(act)) {
    const raw = await env.KV.get(`pending:${id}`);
    if (!raw) return respond(textMsg(MSG_STALE));
    const pending = JSON.parse(raw);

    if (act === "cancel") {
      await env.KV.delete(`pending:${id}`);
      return respond(textMsg("ยกเลิกแล้วครับ ไม่ได้บันทึกลงชีท\nรูปยังอยู่ใน Drive — จับเข้ารายการอื่นได้จากแดชบอร์ด"));
    }

    const token = await getUserToken(env, key);
    const sheet = { sheetId: pending.sheetId, token };

    // ผู้เบิกกรอกข้อมูลบัญชีครั้งเดียวต่อบริษัท จากนั้นระบบจำให้ทุกครั้ง
    let memberProfile = null;
    const isIncome = pending.record?.type === "รายรับ" || pending.record?.type === "income";
    if (!isIncome && uid) {
      const member = await getMemberProfile(
        env, key, pending.sheetId, token, uid, pending.sender || ""
      );
      memberProfile = member.profile;
      if (!memberProfileComplete(memberProfile)) {
        const profileUrl = await createMemberOnboardingUrl(env, {
          tenant: key,
          lineUserId: uid,
          displayName: pending.sender || "",
          pendingId: id,
        });
        const card = memberProfileCard(
          profileUrl, id, pending.sender || "ผู้เบิก", missingMemberFields(memberProfile)
        );

        // ส่งข้อมูลบัญชีเป็นการ์ดส่วนตัวเท่านั้น ไม่ปล่อยลิงก์ข้อมูลส่วนตัวลงในกลุ่ม
        if (event.source.groupId || event.source.roomId) {
          if (await push(env, uid, card)) {
            return respond(textMsg(`ส่งแบบฟอร์มส่วนตัวให้ ${pending.sender || "ผู้เบิก"} แล้วครับ กรอกครั้งเดียวแล้วกลับมากดบันทึกรายการต่อ`));
          }
          return respond(textMsg(`ยังส่งแบบฟอร์มส่วนตัวให้ ${pending.sender || "ผู้เบิก"} ไม่ได้ครับ
กรุณาเพิ่มบอทเป็นเพื่อน แล้วกลับมากด “บันทึก” อีกครั้ง`));
        }
        return respond(card);
      }
    }

    // ตรวจซ้ำอีกรอบตอนกดบันทึก ป้องกันมีคนบันทึกรายการเดียวกันแทรกระหว่างรอตรวจ
    const duplicateCheck = await findDuplicateExpenses(
      env,
      pending.sheetId,
      { ...pending.record, imageHash: pending.imageHash || pending.record.imageHash },
      token
    );
    pending.duplicateCheck = duplicateCheck;

    if (duplicateCheck.hasDuplicate && act !== "confirm_force") {
      await env.KV.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: 3600 });
      return respond(confirmCard(id, pending.record, {
        driveLink: pending.driveLink,
        duplicateCheck,
      }));
    }

    const dupMeta = duplicateCheck.hasDuplicate ? duplicateMeta(duplicateCheck) : {
      duplicateStatus: "",
      duplicateOf: "",
    };

    // ทุกรายการที่เบิก ตั้งให้ออกใบแทนไว้ก่อน — บัญชีค่อยเอาออกในแดชบอร์ด
    const resolvedPayerName = memberProfile?.name || pending.sender || "";
    const toSave = {
      ...pending.record,
      needSlip: true,
      imageHash: pending.imageHash || pending.record.imageHash || "",
      payerName: resolvedPayerName,
      payerId: uid || "",
      bankName: memberProfile?.bank || "",
      bankAccountNo: memberProfile?.accountNo || "",
      bankAccountName: memberProfile?.accountName || resolvedPayerName,
      ...dupMeta,
    };

    const { id: rowId, row } = await appendExpense(
      env, pending.sheetId, toSave,
      { sender: pending.sender, driveLink: pending.driveLink, payerName: resolvedPayerName, payerId: uid || "" },
      token
    );
    // กันกดซ้ำทันทีหลังบันทึกแถวสำเร็จ แม้ขั้นสร้าง PDF จะมีปัญหา
    await env.KV.delete(`pending:${id}`);

    const d = normalizeDate(pending.record.date);
    let rec = {
      ...toSave,
      id: rowId, _row: row,
      imageUrl: pending.driveLink,
      payerName: resolvedPayerName, sender: pending.sender,
      bankName: memberProfile?.bank || "",
      bankAccountNo: memberProfile?.accountNo || "",
      bankAccountName: memberProfile?.accountName || resolvedPayerName,
      dateText: d.text, dateISO: d.iso,
      status: "รอตรวจเอกสาร", paid: false,
      type: pending.record.type || "รายจ่าย",
      claimPdfUrl: "",
      receiptPdfUrl: "",
      imageHash: toSave.imageHash || "",
      duplicateStatus: toSave.duplicateStatus || "",
      duplicateOf: toSave.duplicateOf || "",
      payerId: uid || "",
      batchType: "ปกติ",
      batchStatus: "รอตรวจเอกสาร",
      batchNo: "",
      batchDocId: "",
      batchClaimPdfUrl: "",
    };

    // กดบันทึกครั้งเดียว → สร้างใบเบิก + ใบแทนเป็น PDF → อัป Drive → เขียนลิงก์ลงชีท
    try {
      const settings = await readSettings(env, pending.sheetId, token);
      if (!documentSettingsReady(settings)) {
        rec.documentError = "บันทึกรายการแล้ว — กรอกข้อมูลบริษัทครั้งเดียว จากนั้นระบบจะสร้างใบเบิกและใบแทนให้อัตโนมัติ";
      } else {
        const docs = await createExpenseDocuments(env, rec, settings, token);
        const patch = {
          slipNo: docs.receiptNo,
          claimPdfUrl: docs.claimUrl,
          receiptPdfUrl: docs.receiptUrl,
        };
        await updateExpenseById(env, pending.sheetId, rowId, patch, token);
        rec = { ...rec, ...patch };
      }
    } catch (e) {
      console.error("auto documents", e);
      rec.documentError = "บันทึกรายการแล้ว แต่สร้างใบเบิก/ใบแทน PDF ไม่สำเร็จ กรุณาตรวจข้อมูลบริษัทหรือ Google Drive";
    }

    return respond(await renderSaved(env, key, sheet, rec, rec));
  }

  if (act === "multi_confirm") {
    const out = await confirmMultiSession(env, key, uid || key);
    if (out.ok) return out;

    if (out.code === "profile_required" && out.profileUrl) {
      return respond(textMsg(`${out.error || "กรอกข้อมูลผู้เบิกให้ครบก่อน"}

เปิดกรอกข้อมูล:
${out.profileUrl}`));
    }

    const reviewText = out.reviewUrl ? `

เปิดตรวจและแก้ไข:
${out.reviewUrl}` : "";
    return respond(textMsg(`ยังยืนยันรายการไม่ได้ครับ
${out.error || "กรุณาตรวจข้อมูลอีกครั้ง"}${reviewText}`));
  }

  if (act === "multi_cancel") {
    try {
      await cancelMultiSession(env, key, uid || key);
      return respond(textMsg("ยกเลิกชุดเอกสารแล้วครับ"));
    } catch (e) {
      return respond(textMsg("ยกเลิกชุดไม่สำเร็จ: " + String(e.message || e).slice(0, 120)));
    }
  }

  const sheet = await resolveSheet(env, event.source);
  if (!sheet) return respond(connectMsg(env, key));

  if (act === "batch_resubmit") {
    const rec = await getExpenseById(env, sheet.sheetId, id, sheet.token);
    if (!rec) return respond(textMsg(MSG_STALE));
    if (!rec.batchDocId) return respond(textMsg("รายการนี้ยังไม่ได้อยู่ในใบเบิกที่ถูกตีกลับ"));
    try {
      const out = await updateReimbursementBatchWorkflow(
        env, sheet.sheetId, rec.batchDocId, "resubmit", {}, sheet.token
      );
      if (!out.ok) return respond(textMsg(out.message || "ส่งกลับตรวจไม่สำเร็จ"));
      const updated = await getExpenseById(env, sheet.sheetId, id, sheet.token);
      return respond([
        textMsg(`ส่งใบเบิก ${rec.batchDocId} กลับให้ฝ่ายบัญชีตรวจแล้ว ✅`),
        updated ? await renderSaved(env, key, sheet, updated) : textMsg("ฝ่ายบัญชีได้รับรายการแล้ว"),
      ]);
    } catch (e) {
      return respond(textMsg(`ส่งกลับตรวจไม่สำเร็จ: ${String(e.message || e).slice(0, 160)}`));
    }
  }

  if (act === "urgent") {
    const rec = await getExpenseById(env, sheet.sheetId, id, sheet.token);
    if (!rec) return respond(textMsg(MSG_STALE));
    if (rec.batchDocId || ["รวมรอบแล้ว", "รอตรวจเอกสาร", "ต้องแก้ไข", "รอโอนเงิน", "รอหลักฐานการโอน", "จ่ายแล้ว"].includes(String(rec.batchStatus || ""))) {
      return respond(await renderSaved(env, key, sheet, rec));
    }
    await respond(textMsg("กำลังสร้างใบเบิกด่วนจากรายการนี้… ⏳"));
    try {
      const out = await requestUrgentBatch(env, key, sheet.sheetId, sheet.token, [id]);
      if (!out.ok || !out.batches?.length) {
        return push(env, lineTarget(event.source), textMsg("สร้างใบเบิกด่วนไม่สำเร็จ กรุณาเปิด Dashboard เพื่อตรวจรายการ"));
      }
      const batch = out.batches[0];
      const updated = await getExpenseById(env, sheet.sheetId, id, sheet.token);
      const messages = [
        textMsg(`สร้างใบเบิกด่วนแล้ว ✅
เลขที่ ${batch.docId}
รวม ฿${Number(batch.total || 0).toLocaleString("th-TH", { minimumFractionDigits: 2 })}`),
      ];
      if (updated) messages.push(await renderSaved(env, key, sheet, updated));
      return push(env, lineTarget(event.source), messages);
    } catch (e) {
      console.error("urgent batch", e);
      return push(env, lineTarget(event.source), textMsg(`สร้างใบเบิกด่วนไม่สำเร็จ ❌
${String(e.message || e).slice(0, 180)}`));
    }
  }

  if (act === "paid") {
    const out = await togglePaid(env, sheet.sheetId, id, sheet.token);
    if (!out.ok) return respond(textMsg(MSG_STALE));
    return respond(await renderSaved(env, key, sheet, out.record));
  }

  if (act === "more") {
    const rec = await getExpenseById(env, sheet.sheetId, id, sheet.token);
    if (!rec) return respond(textMsg(MSG_STALE));
    return respond(moreCard(rec, { id, dashboardUrl: await dashUrl(env, key) }));
  }

  if (act === "back") {
    const rec = await getExpenseById(env, sheet.sheetId, id, sheet.token);
    if (!rec) return respond(textMsg(MSG_STALE));
    return respond(await renderSaved(env, key, sheet, rec));
  }

  if (act === "delete") {
    const out = await softDeleteById(env, sheet.sheetId, id, sheet.token);
    if (!out.ok) return respond(textMsg(MSG_STALE));
    return respond(textMsg("ลบรายการแล้วครับ 🗑️"));
  }

  if (act === "attach") {
    if (!uid) return respond(textMsg("ส่งรูปมาในแชทส่วนตัวนะครับ"));
    const type = p.get("t") || "attOther";
    await env.KV.put(`attach:${uid}`, JSON.stringify({ id, type }), { expirationTtl: 600 });
    return respond(textMsg("ส่งรูปหลักฐานมาได้เลยครับ 📸 (ภายใน 10 นาที)"));
  }

  if (act === "edit" || act === "fix") {
    if (!uid) return respond(textMsg("ทำรายการนี้ในแชทส่วนตัวนะครับ"));
    const isPending = !!(await env.KV.get(`pending:${id}`));
    const f = act === "fix" && field ? field : "amount";
    await env.KV.put(`edit:${uid}`,
      JSON.stringify({ id, field: f, scope: isPending ? "pending" : "sheet" }),
      { expirationTtl: 600 });
    return respond(textMsg(promptFor(f)));
  }
}

function promptFor(field) {
  switch (field) {
    case "amount":   return "พิมพ์ยอดเงินที่ถูกต้องมาได้เลย (เฉพาะตัวเลข)";
    case "date":     return "พิมพ์วันที่ที่ถูกต้อง เช่น 24/07/2569 หรือ 2026-07-24";
    case "vendor":     return "พิมพ์ชื่อร้าน/ผู้รับเงินที่ถูกต้อง";
    case "transferor": return "พิมพ์ชื่อผู้โอน/ชื่อบัญชีต้นทางที่ถูกต้อง";
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
      const token = await getUserToken(env, key);
      pending.duplicateCheck = await findDuplicateExpenses(
        env,
        pending.sheetId,
        { ...pending.record, imageHash: pending.imageHash || pending.record.imageHash },
        token
      );
      await env.KV.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: 3600 });
      return reply(env, event.replyToken,
        confirmCard(id, pending.record, {
          driveLink: pending.driveLink,
          duplicateCheck: pending.duplicateCheck,
        }));
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

  if (/^(จัดบิล|จัดเอกสาร|จบชุด|ตรวจชุด)$/i.test(text)) {
    try {
      await forceMultiSummary(env, key, uid || key);
      return reply(env, event.replyToken, textMsg("ส่งการ์ดตรวจชุดเอกสารล่าสุดให้แล้วครับ"));
    } catch (e) {
      return reply(env, event.replyToken, textMsg("ยังไม่มีชุดเอกสารที่กำลังจัดอยู่ครับ"));
    }
  }

  if (/^(ยกเลิกชุด|ทิ้งชุด)$/i.test(text)) {
    try {
      await cancelMultiSession(env, key, uid || key);
      return reply(env, event.replyToken, textMsg("ยกเลิกชุดเอกสารแล้วครับ รูปยังอยู่ใน Google Drive"));
    } catch (e) {
      return reply(env, event.replyToken, textMsg("ยังไม่มีชุดเอกสารให้ยกเลิกครับ"));
    }
  }

  if (/^migrate$/i.test(text)) {
    const sheet = await resolveSheet(env, event.source);
    if (!sheet) return reply(env, event.replyToken, connectMsg(env, key));
    try {
      const h = await ensureHeaders(env, sheet.sheetId, sheet.token);
      const i = await backfillIds(env, sheet.sheetId, sheet.token);
      const s = await ensureSettingsTab(env, sheet.sheetId, sheet.token);
      const e = await ensureEmailInboxTab(env, sheet.sheetId, sheet.token);
      const b = await ensureBatchTab(env, sheet.sheetId, sheet.token);
      await env.KV.delete(`setup:${key}`);
      await env.KV.delete(`setup:${key}:${sheet.sheetId}`);
      return reply(env, event.replyToken, textMsg(
        `อัปเกรดชีทเรียบร้อย ✅\n` +
        `หัวคอลัมน์: ${h.changed ? `เพิ่ม ${h.added} ช่อง` : "ครบอยู่แล้ว"}\n` +
        `เติม id/วันที่: ${i.filled} ช่อง\n` +
        `แท็บ _settings: ${s.created ? "สร้างใหม่" : "มีอยู่แล้ว"}\n` +
        `แท็บ Email_Inbox: ${e.created ? "สร้างใหม่" : "มีอยู่แล้ว"}\n` +
        `แท็บ รอบเบิก: ${b.created ? "สร้างใหม่" : "มีอยู่แล้ว"}`
      ));
    } catch (e) {
      return reply(env, event.replyToken, textMsg("อัปเกรดไม่สำเร็จ 🙏\n" + String(e).slice(0, 300)));
    }
  }

  if (/^(อีเมล|email|อีเมลรับเอกสาร|รับเอกสาร)$/i.test(text)) {
    const base = await dashUrl(env, key);
    const url = base ? `${base}&page=email` : "";
    const status = await getGmailStatus(env, key);
    if (status.connected) {
      return reply(env, event.replyToken, textMsg(
        `เชื่อม Gmail แล้ว ✅\n${status.email || "บัญชี Google"}\n\n` +
        `ระบบจะค้นหาใบเสร็จ ใบกำกับภาษี และ Subscription อัตโนมัติ` +
        (url ? `\n\nเปิดกล่องเอกสาร:\n${url}` : "")
      ));
    }
    return reply(env, event.replyToken, textMsg(
      `เปิดหน้าเอกสารจากอีเมล แล้วกด “เชื่อมต่อ Gmail” ได้เลย` +
      (url ? `\n\n${url}` : "") +
      `\n\nรุ่น Beta ต้องใช้อีเมลที่ถูกเพิ่มเป็น Test user`
    ));
  }

  if (/^(ตั้งค่า|settings|ข้อมูลบริษัท)$/i.test(text)) {
    const url = await dashUrl(env, key, "/receipt");
    if (!url) return reply(env, event.replyToken, textMsg("ยังไม่ได้ตั้งค่าแดชบอร์ดครับ 🙏"));
    return reply(env, event.replyToken, textMsg("กรอกข้อมูลบริษัทได้ที่นี่ ⚙️\n" + url));
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

  if (/^(รอบเบิก|เบิกเป็นรอบ|batch)$/i.test(text)) {
    const base = await dashUrl(env, key);
    const url = base ? `${base}&page=batches` : "";
    return reply(env, event.replyToken, textMsg(
      `เปิดหน้าใบเบิกได้ที่นี่
ระบบรวมรายการย่อยของผู้เบิกคนเดียวเป็นใบเบิกหลัก 1 ไฟล์อัตโนมัติทุกวันจันทร์ 11:00 น.` +
      (url ? `

${url}` : "")
    ));
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
      "ส่งรูปหลายใบต่อกันได้เลย ทั้งสลิป ใบเสร็จ และหลักฐาน ระบบจะจับคู่ให้เป็นหลายรายการอัตโนมัติ 📒\n\n" +
      "คำสั่งเสริม (ถ้าอยากใช้):\n" +
      "• จัดบิล — เรียกการ์ดตรวจชุดล่าสุดทันที\n" +
      "• ยกเลิกชุด — ทิ้งชุดที่กำลังจัด\n" +
      "• แดชบอร์ด — เปิดหน้ารวมทุกอย่าง\n" +
      "• ตั้งค่า — กรอกข้อมูลบริษัท\n" +
      "• อีเมล — เชื่อม Gmail และดูใบเสร็จ/ใบกำกับอัตโนมัติ\n" +
      "• ใบเบิก — ดูรายการย่อยที่รอรวมและใบเบิกหลัก\n" +
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
