// Email document ingestion shared by Cloudflare Email Routing and Gmail OAuth sync.

import { parseEmail, bytesToBase64 } from "./email-mime.js";
import { analyzeEmailDocument } from "./email-ocr.js";
import { getAiQuotaState, consumeAiDocument, readAiDocumentCache, writeAiDocumentCache, unwrapAiDocumentCache } from "./ai-quota.js";
import {
  ensureEmailInboxTab, appendEmailInbox, readEmailInbox, getEmailInboxById,
  updateEmailInbox, findEmailDuplicate, buildSubscriptions,
} from "./email-sheets.js";
import { uploadTenantFile } from "./drive.js";
import { getUserToken } from "./oauth.js";
import { appendExpense, findDuplicateExpenses } from "./sheets.js";
import { push, textMsg } from "./line.js";

const SUPPORTED = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
function supportedAttachment(a = {}) {
  const mime = String(a.mimeType || "").toLowerCase();
  const name = String(a.filename || "").toLowerCase();
  const extOk = /\.(pdf|jpe?g|png|webp|heic|heif)$/.test(name);
  if (!SUPPORTED.has(mime) && !(mime === "application/octet-stream" && extOk)) return false;
  if (/(logo|icon|avatar|signature|facebook|instagram|twitter|linkedin|spacer|pixel)/i.test(name)) return false;
  return true;
}
const MAX_DOCS = 6;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

function normalizedMime(item = {}) {
  const mime = String(item.mimeType || "").toLowerCase();
  const name = String(item.filename || "").toLowerCase();
  if (mime !== "application/octet-stream") return mime || "application/octet-stream";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (/\.jpe?g$/.test(name)) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".heic")) return "image/heic";
  return mime;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, x => x.toString(36).padStart(2, "0")).join("").slice(0, 16);
}

function emailTokenFromRecipient(address = "") {
  const local = String(address).split("@")[0].toLowerCase();
  const plus = local.lastIndexOf("+");
  return (plus >= 0 ? local.slice(plus + 1) : local).replace(/[^a-z0-9]/g, "");
}

export async function getEmailInboxInfo(env, tenant, { create = true } = {}) {
  let token = await env.KV.get(`emailtoken:${tenant}`);
  if (!token && create) {
    token = randomToken();
    await env.KV.put(`emailtoken:${tenant}`, token);
    await env.KV.put(`emailinbox:${token}`, tenant);
  }
  if (!token) return { enabled: false, token: "", address: "", domain: env.EMAIL_DOMAIN || "" };
  await env.KV.put(`emailinbox:${token}`, tenant);
  const domain = String(env.EMAIL_DOMAIN || "").trim().toLowerCase();
  const prefix = String(env.EMAIL_PREFIX || "bills").trim().toLowerCase();
  return {
    enabled: !!domain,
    token,
    domain,
    address: domain ? `${prefix}+${token}@${domain}` : "",
  };
}

export async function rotateEmailInbox(env, tenant) {
  const old = await env.KV.get(`emailtoken:${tenant}`);
  if (old) await env.KV.delete(`emailinbox:${old}`);
  const token = randomToken();
  await env.KV.put(`emailtoken:${tenant}`, token);
  await env.KV.put(`emailinbox:${token}`, tenant);
  return getEmailInboxInfo(env, tenant, { create: false });
}

async function sha256(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, b => b.toString(16).padStart(2, "0")).join("");
}

function safeName(name = "document") {
  return String(name).replace(/[\\/:*?"<>|\x00-\x1F]/g, "-").slice(0, 140) || "document";
}

function looksAccounting(subject = "", text = "") {
  return /(invoice|receipt|tax invoice|billing|payment|ใบเสร็จ|ใบกำกับ|ใบแจ้งหนี้|ชำระเงิน|subscription|renewal)/i.test(`${subject}\n${text}`);
}

function manualEmailAnalysis(message = "โควตาอ่านเอกสารอัตโนมัติครบแล้ว กรุณากรอกข้อมูลเอง") {
  return {
    isAccountingDocument: true, docType: "ใบแจ้งหนี้", vendor: "", taxId: "", invoiceNo: "", date: "", dueDate: "", servicePeriod: "",
    subtotal: 0, vatAmount: 0, vatRate: 0, amount: 0, currency: "THB", category: "อื่น ๆ", note: "",
    isSubscription: false, subscriptionName: "", flag: message, confidence: 0,
  };
}

async function dashboardUrl(env, tenant, page = "email") {
  const base = String(env.DASHBOARD_URL || "").replace(/\/$/, "");
  const k = await env.KV.get(`dtoken:${tenant}`);
  if (!base || !k) return "";
  return `${base}/?tenant=${encodeURIComponent(tenant)}&k=${encodeURIComponent(k)}&page=${encodeURIComponent(page)}`;
}

export async function notifyEmailRecords(env, tenant, records, subject) {
  if (!env.LINE_ACCESS_TOKEN || !tenant || !records.length) return;
  const review = records.filter(x => x.status === "รอตรวจสอบ").length;
  const dup = records.filter(x => x.status === "สงสัยซ้ำ").length;
  const invalid = records.filter(x => x.status === "ไม่ใช่เอกสาร").length;
  const total = records.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const currencies = [...new Set(records.map(x => x.currency).filter(Boolean))];
  const amount = currencies.length === 1 && total > 0 ? `\nยอดรวมที่อ่านได้: ${currencies[0]} ${total.toLocaleString("th-TH", { minimumFractionDigits: 2 })}` : "";
  const url = await dashboardUrl(env, tenant, "email");
  const lines = [
    "พบเอกสารจากอีเมลใหม่",
    subject ? `หัวข้อ: ${subject}` : "",
    `รอตรวจสอบ ${review} · สงสัยซ้ำ ${dup} · ไม่ใช่เอกสาร ${invalid}`,
    amount,
    url ? `\nเปิดตรวจสอบ:\n${url}` : "",
  ].filter(Boolean);
  await push(env, tenant, textMsg(lines.join("\n")));
}

async function processOne(env, tenant, sheetId, token, base, item) {
  const fileHash = await sha256(item.content);
  const mediaType = normalizedMime(item);
  const bodyPreview = String(base.text || "").replace(/\s+/g, " ").trim().slice(0, 1500);
  const driveUrl = await uploadTenantFile(
    env,
    tenant,
    item.content,
    mediaType,
    `Email-${new Date().toISOString().slice(0, 10)}-${safeName(item.filename)}`,
    token,
    { category: "email", publicRead: false, transactionDate: base.receivedAt || new Date().toISOString() }
  );

  let analysis = unwrapAiDocumentCache(await readAiDocumentCache(env, tenant, "email-document", fileHash));
  if (!analysis) {
    const aiQuota = await getAiQuotaState(env, tenant);
    if (aiQuota.blocked) {
      analysis = manualEmailAnalysis(`ใช้จำนวนอ่านเอกสารอัตโนมัติครบ ${aiQuota.limit} ใบแล้ว · ไฟล์ถูกเก็บไว้ กรุณากรอกข้อมูลเองหรือเพิ่มจำนวนอ่านเอกสาร`);
    } else {
      analysis = await analyzeEmailDocument(env, {
        base64: bytesToBase64(item.content),
        mediaType,
        filename: item.filename,
        subject: base.subject,
        bodyText: bodyPreview,
        sender: base.from,
      });
      await consumeAiDocument(env, tenant, 1);
      await writeAiDocumentCache(env, tenant, "email-document", fileHash, analysis).catch(() => {});
    }
  }

  const candidate = {
    receivedAt: base.receivedAt || new Date().toISOString(),
    messageId: base.messageId,
    from: base.from,
    subject: base.subject,
    filename: item.filename,
    mimeType: mediaType,
    driveUrl: driveUrl || "",
    fileHash,
    docType: analysis.docType,
    vendor: analysis.vendor,
    taxId: analysis.taxId,
    invoiceNo: analysis.invoiceNo,
    documentDate: analysis.date,
    dueDate: analysis.dueDate,
    servicePeriod: analysis.servicePeriod,
    subtotal: analysis.subtotal,
    vatAmount: analysis.vatAmount,
    amount: analysis.amount,
    currency: analysis.currency,
    category: analysis.category,
    note: analysis.note,
    isSubscription: analysis.isSubscription,
    subscriptionName: analysis.subscriptionName,
    confidence: analysis.confidence,
    flag: analysis.flag,
    recipient: base.recipient,
    bodyPreview,
  };

  const duplicate = await findEmailDuplicate(env, sheetId, candidate, token);
  candidate.duplicateStatus = duplicate.hasDuplicate ? (duplicate.level === "high" ? "ซ้ำสูง" : "ควรตรวจ") : "";
  candidate.duplicateOf = duplicate.matches.map(x => x.id).join(", ");
  candidate.status = !analysis.isAccountingDocument ? "ไม่ใช่เอกสาร" : duplicate.hasDuplicate ? "สงสัยซ้ำ" : "รอตรวจสอบ";
  return appendEmailInbox(env, sheetId, candidate, token);
}

async function processTextOnly(env, tenant, sheetId, token, base) {
  const text = String(base.text || "").trim();
  const bytes = new TextEncoder().encode(`${base.subject}\n\n${text}`);
  const textHash = await sha256(bytes);
  let analysis = unwrapAiDocumentCache(await readAiDocumentCache(env, tenant, "email-text", textHash));
  if (!analysis) {
    const aiQuota = await getAiQuotaState(env, tenant);
    if (aiQuota.blocked) {
      analysis = manualEmailAnalysis(`ใช้จำนวนอ่านเอกสารอัตโนมัติครบ ${aiQuota.limit} ใบแล้ว · อีเมลถูกเก็บไว้ กรุณากรอกข้อมูลเองหรือเพิ่มจำนวนอ่านเอกสาร`);
    } else {
      analysis = await analyzeEmailDocument(env, {
        subject: base.subject,
        bodyText: text.slice(0, 12000),
        sender: base.from,
        filename: "เนื้อหาอีเมล",
      });
      await consumeAiDocument(env, tenant, 1);
      await writeAiDocumentCache(env, tenant, "email-text", textHash, analysis).catch(() => {});
    }
  }
  const candidate = {
    receivedAt: base.receivedAt || new Date().toISOString(), messageId: base.messageId, from: base.from,
    subject: base.subject, filename: "เนื้อหาอีเมล", mimeType: "text/plain",
    fileHash: textHash, docType: analysis.docType, vendor: analysis.vendor,
    taxId: analysis.taxId, invoiceNo: analysis.invoiceNo, documentDate: analysis.date,
    dueDate: analysis.dueDate, servicePeriod: analysis.servicePeriod, subtotal: analysis.subtotal,
    vatAmount: analysis.vatAmount, amount: analysis.amount, currency: analysis.currency,
    category: analysis.category, note: analysis.note, isSubscription: analysis.isSubscription,
    subscriptionName: analysis.subscriptionName, confidence: analysis.confidence, flag: analysis.flag,
    recipient: base.recipient, bodyPreview: text.replace(/\s+/g, " ").slice(0, 1500),
  };
  const duplicate = await findEmailDuplicate(env, sheetId, candidate, token);
  candidate.duplicateStatus = duplicate.hasDuplicate ? (duplicate.level === "high" ? "ซ้ำสูง" : "ควรตรวจ") : "";
  candidate.duplicateOf = duplicate.matches.map(x => x.id).join(", ");
  candidate.status = !analysis.isAccountingDocument ? "ไม่ใช่เอกสาร" : duplicate.hasDuplicate ? "สงสัยซ้ำ" : "รอตรวจสอบ";
  return appendEmailInbox(env, sheetId, candidate, token);
}


/**
 * Process one normalized email from any provider.
 * parsed = { subject, messageId, from, recipient, text, receivedAt, attachments[] }
 * Each attachment item = { filename, mimeType, content: Uint8Array }
 */
export async function processNormalizedEmail(env, tenant, parsed = {}, { notify = true, ctx = null } = {}) {
  const sheetId = (await env.KV.get(`tenant:${tenant}`)) || env.DEFAULT_SHEET_ID;
  if (!sheetId) throw new Error("Accounting inbox is not connected");
  const token = await getUserToken(env, tenant);
  if (!token) throw new Error("Google Drive/Sheets ยังไม่ได้เชื่อม");
  await ensureEmailInboxTab(env, sheetId, token);

  const base = {
    subject: parsed.subject || "",
    messageId: parsed.messageId || `email-${Date.now()}`,
    from: parsed.from || "",
    recipient: parsed.recipient || "",
    text: parsed.text || "",
    receivedAt: parsed.receivedAt || new Date().toISOString(),
  };
  const docs = (parsed.attachments || [])
    .filter(supportedAttachment)
    .filter(a => a.content?.byteLength > 6000 && a.content.byteLength <= MAX_FILE_BYTES)
    .sort((a, b) => (String(a.mimeType).includes("pdf") ? -1 : 0) - (String(b.mimeType).includes("pdf") ? -1 : 0))
    .slice(0, MAX_DOCS);

  const records = [];
  try {
    if (docs.length) {
      for (const item of docs) records.push(await processOne(env, tenant, sheetId, token, base, item));
    } else if (looksAccounting(base.subject, base.text)) {
      records.push(await processTextOnly(env, tenant, sheetId, token, base));
    } else {
      records.push(await appendEmailInbox(env, sheetId, {
        receivedAt: base.receivedAt, messageId: base.messageId, from: base.from,
        subject: base.subject, filename: "ไม่มีไฟล์เอกสาร", mimeType: "text/plain",
        status: "ไม่ใช่เอกสาร", docType: "ไม่ใช่เอกสารบัญชี", recipient: base.recipient,
        bodyPreview: base.text.replace(/\s+/g, " ").slice(0, 1500), confidence: 1,
      }, token));
    }
    if (notify && records.length) {
      const work = notifyEmailRecords(env, tenant, records, base.subject).catch(e => console.error("email notify", e));
      if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
    }
    return records;
  } catch (error) {
    console.error("email process failed", error);
    const failed = await appendEmailInbox(env, sheetId, {
      receivedAt: base.receivedAt, messageId: base.messageId, from: base.from,
      subject: base.subject, filename: "ประมวลผลไม่สำเร็จ", status: "อ่านไม่สำเร็จ",
      flag: String(error?.message || error).slice(0, 250), recipient: base.recipient,
      bodyPreview: base.text.replace(/\s+/g, " ").slice(0, 1500),
    }, token).catch(e => {
      console.error("email error log failed", e);
      return null;
    });
    if (failed) records.push(failed);
    throw error;
  }
}

export async function handleIncomingEmail(message, env, ctx) {
  if (message.rawSize > 25 * 1024 * 1024) {
    message.setReject("Message too large");
    return;
  }
  const inboxToken = emailTokenFromRecipient(message.to);
  const tenant = inboxToken ? await env.KV.get(`emailinbox:${inboxToken}`) : "";
  if (!tenant) {
    message.setReject("Unknown accounting inbox");
    return;
  }

  const parsed = await parseEmail(message.raw);
  const normalized = {
    subject: parsed.subject || message.headers.get("subject") || "",
    messageId: parsed.messageId || message.headers.get("message-id") || `cf-${Date.now()}`,
    from: parsed.from || message.from,
    recipient: message.to,
    text: parsed.text || "",
    receivedAt: new Date().toISOString(),
    attachments: parsed.attachments || [],
  };

  try {
    const records = await processNormalizedEmail(env, tenant, normalized, { notify: true, ctx });
    console.log(`[email-routing] tenant=${tenant} subject=${normalized.subject.slice(0, 80)} docs=${records.length}`);
  } catch (error) {
    console.error("email routing failed", error);
    ctx.waitUntil(push(env, tenant, textMsg(`อ่านเอกสารจากอีเมลไม่สำเร็จ\n${String(error?.message || error).slice(0, 180)}`)).catch(() => {}));
  }
}

export async function listEmailDocuments(env, sheetId, token) {
  return readEmailInbox(env, sheetId, token);
}

export async function listSubscriptions(env, sheetId, token) {
  return buildSubscriptions(await readEmailInbox(env, sheetId, token));
}

export async function approveEmailDocument(env, sheetId, id, token, { force = false } = {}) {
  const rec = await getEmailInboxById(env, sheetId, id, token);
  if (!rec) return { ok: false, reason: "not_found" };
  if (rec.expenseId) return { ok: true, skipped: true, expenseId: rec.expenseId };
  if (!rec.amount || !rec.vendor) return { ok: false, reason: "missing_data", hint: "กรอกผู้ขายและยอดเงินก่อนบันทึก" };

  const expense = {
    amount: rec.amount,
    vendor: rec.vendor,
    transferor: "",
    date: rec.documentDate || rec.receivedAt,
    category: rec.category || "อื่น ๆ",
    note: rec.note || rec.subject,
    docType: rec.docType || "ใบเสร็จรับเงิน",
    type: "รายจ่าย",
    vat: rec.vatAmount > 0,
    vatRate: rec.subtotal > 0 ? Math.round((rec.vatAmount / rec.subtotal) * 10000) / 100 : 0,
    whtRate: 0,
    needSlip: false,
    // ใบเสร็จ/หลักฐานชำระเงินมักเป็นรายการที่ชำระแล้ว ส่วนใบแจ้งหนี้ยังรอจ่าย
    paid: /ใบเสร็จ|หลักฐานการชำระเงิน/.test(String(rec.docType || "")),
    imageHash: rec.fileHash,
  };
  const dup = await findDuplicateExpenses(env, sheetId, expense, token);
  if (dup.hasDuplicate && !force) return { ok: false, reason: "duplicate", duplicateCheck: dup };
  if (dup.hasDuplicate) {
    expense.duplicateStatus = dup.level === "high" ? "ซ้ำสูง · ยืนยันจากอีเมล" : "ควรตรวจ · ยืนยันจากอีเมล";
    expense.duplicateOf = dup.matches.map(x => x.id).join(", ");
  }
  const out = await appendExpense(env, sheetId, expense, {
    sender: `Email · ${rec.from}`,
    payerName: "ระบบอีเมล",
    driveLink: rec.driveUrl,
  }, token);
  await updateEmailInbox(env, sheetId, id, { status: "บันทึกแล้ว", expenseId: out.id }, token);
  return { ok: true, expenseId: out.id, row: out.row };
}

export async function patchEmailDocument(env, sheetId, id, patch, token) {
  const allowed = new Set(["status", "vendor", "taxId", "invoiceNo", "documentDate", "dueDate", "servicePeriod", "subtotal", "vatAmount", "amount", "currency", "category", "note", "isSubscription", "subscriptionName", "flag"]);
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) if (allowed.has(k)) clean[k] = v;
  return updateEmailInbox(env, sheetId, id, clean, token);
}
