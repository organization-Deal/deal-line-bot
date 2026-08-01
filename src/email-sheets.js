// Google Sheets storage for documents imported from forwarded emails.

import { getAccessToken } from "./google-auth.js";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
export const TAB_EMAIL = "Email_Inbox";

export const EMAIL_SCHEMA = [
  { col: "A", key: "receivedAt", header: "ได้รับเมื่อ" },
  { col: "B", key: "id", header: "email_doc_id" },
  { col: "C", key: "messageId", header: "Message-ID" },
  { col: "D", key: "status", header: "สถานะ" },
  { col: "E", key: "from", header: "ผู้ส่งอีเมล" },
  { col: "F", key: "subject", header: "หัวข้ออีเมล" },
  { col: "G", key: "filename", header: "ชื่อไฟล์" },
  { col: "H", key: "mimeType", header: "ชนิดไฟล์" },
  { col: "I", key: "driveUrl", header: "ลิงก์ไฟล์ต้นฉบับ" },
  { col: "J", key: "fileHash", header: "ลายนิ้วมือไฟล์" },
  { col: "K", key: "docType", header: "ประเภทเอกสาร" },
  { col: "L", key: "vendor", header: "ผู้ขาย/ผู้ให้บริการ" },
  { col: "M", key: "taxId", header: "เลขผู้เสียภาษีผู้ขาย" },
  { col: "N", key: "invoiceNo", header: "เลขที่เอกสาร" },
  { col: "O", key: "documentDate", header: "วันที่เอกสาร" },
  { col: "P", key: "dueDate", header: "วันครบกำหนด" },
  { col: "Q", key: "servicePeriod", header: "รอบบริการ" },
  { col: "R", key: "subtotal", header: "ก่อน VAT" },
  { col: "S", key: "vatAmount", header: "VAT" },
  { col: "T", key: "amount", header: "ยอดรวม" },
  { col: "U", key: "currency", header: "สกุลเงิน" },
  { col: "V", key: "category", header: "หมวด" },
  { col: "W", key: "note", header: "รายละเอียด" },
  { col: "X", key: "isSubscription", header: "รายจ่ายประจำ" },
  { col: "Y", key: "subscriptionName", header: "ชื่อแพ็กเกจ/บริการ" },
  { col: "Z", key: "confidence", header: "ความมั่นใจ AI" },
  { col: "AA", key: "flag", header: "สิ่งที่ควรตรวจ" },
  { col: "AB", key: "duplicateStatus", header: "สถานะซ้ำ" },
  { col: "AC", key: "duplicateOf", header: "อ้างอิงรายการซ้ำ" },
  { col: "AD", key: "expenseId", header: "รายการรายจ่ายที่สร้าง" },
  { col: "AE", key: "updatedAt", header: "แก้ไขล่าสุด" },
  { col: "AF", key: "recipient", header: "อีเมลรับเอกสาร" },
  { col: "AG", key: "bodyPreview", header: "ตัวอย่างข้อความอีเมล" },
];

const LAST_COL = EMAIL_SCHEMA.at(-1).col;
const HEADER = EMAIL_SCHEMA.map(x => x.header);
const COL = Object.fromEntries(EMAIL_SCHEMA.map(x => [x.key, x.col]));

async function tokenOf(env, token) { return token || (await getAccessToken(env)); }
function rangeUrl(sheetId, a1, suffix = "") {
  return `${API}/${sheetId}/values/${encodeURIComponent(`${TAB_EMAIL}!${a1}`)}${suffix}`;
}
async function call(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Email Sheets ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
function bool(v) { return ["TRUE", "1", "YES", "ใช่"].includes(String(v || "").trim().toUpperCase()); }
function number(v) { return Number(String(v || "0").replace(/[^0-9.-]/g, "")) || 0; }
function newId() { return `em_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`; }

export async function ensureEmailInboxTab(env, sheetId, token = null) {
  const t = await tokenOf(env, token);
  const meta = await call(
    t,
    `${API}/${sheetId}?fields=sheets.properties(sheetId,title,gridProperties.frozenRowCount)`,
  );
  const sheet = (meta.sheets || []).find(s => s.properties?.title === TAB_EMAIL);
  const exists = Boolean(sheet);

  if (!exists) {
    // frozenRowCount ต้องอยู่ใต้ gridProperties ตาม Google Sheets API schema
    await call(t, `${API}/${sheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{
          addSheet: {
            properties: {
              title: TAB_EMAIL,
              gridProperties: { frozenRowCount: 1 },
            },
          },
        }],
      }),
    });
  } else if (Number(sheet.properties?.gridProperties?.frozenRowCount || 0) < 1) {
    // ชีทมีอยู่แล้วแต่ยังไม่ได้ตรึงหัวตาราง
    await call(t, `${API}/${sheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{
          updateSheetProperties: {
            properties: {
              sheetId: sheet.properties.sheetId,
              gridProperties: { frozenRowCount: 1 },
            },
            fields: "gridProperties.frozenRowCount",
          },
        }],
      }),
    });
  }

  let current = [];
  try {
    const d = await call(t, rangeUrl(sheetId, `A1:${LAST_COL}1`));
    current = d.values?.[0] || [];
  } catch {}
  if (current.length < HEADER.length) {
    const merged = HEADER.map((h, i) => current[i] || h);
    await call(t, rangeUrl(sheetId, `A1:${LAST_COL}1`, "?valueInputOption=USER_ENTERED"), {
      method: "PUT", body: JSON.stringify({ values: [merged] }),
    });
  }
  return { created: !exists, headersAdded: Math.max(0, HEADER.length - current.length) };
}

function toObject(values, row) {
  const o = { _row: row };
  EMAIL_SCHEMA.forEach((s, i) => { o[s.key] = values[i] ?? ""; });
  o.subtotal = number(o.subtotal);
  o.vatAmount = number(o.vatAmount);
  o.amount = number(o.amount);
  o.confidence = number(o.confidence);
  o.isSubscription = bool(o.isSubscription);
  return o;
}

export async function readEmailInbox(env, sheetId, token = null) {
  const t = await tokenOf(env, token);
  await ensureEmailInboxTab(env, sheetId, t);
  const d = await call(t, rangeUrl(sheetId, `A2:${LAST_COL}`));
  return (d.values || []).map((v, i) => toObject(v, i + 2)).filter(x => x.id).reverse();
}

export async function appendEmailInbox(env, sheetId, record = {}, token = null) {
  const t = await tokenOf(env, token);
  await ensureEmailInboxTab(env, sheetId, t);
  const now = new Date().toISOString();
  const full = {
    receivedAt: record.receivedAt || now,
    id: record.id || newId(),
    messageId: record.messageId || "",
    status: record.status || "รอตรวจสอบ",
    from: record.from || "",
    subject: record.subject || "",
    filename: record.filename || "",
    mimeType: record.mimeType || "",
    driveUrl: record.driveUrl || "",
    fileHash: record.fileHash || "",
    docType: record.docType || "",
    vendor: record.vendor || "",
    taxId: record.taxId || "",
    invoiceNo: record.invoiceNo || "",
    documentDate: record.documentDate || "",
    dueDate: record.dueDate || "",
    servicePeriod: record.servicePeriod || "",
    subtotal: Number(record.subtotal) || 0,
    vatAmount: Number(record.vatAmount) || 0,
    amount: Number(record.amount) || 0,
    currency: record.currency || "THB",
    category: record.category || "อื่น ๆ",
    note: record.note || "",
    isSubscription: record.isSubscription ? "TRUE" : "FALSE",
    subscriptionName: record.subscriptionName || "",
    confidence: Number(record.confidence) || 0,
    flag: record.flag || "",
    duplicateStatus: record.duplicateStatus || "",
    duplicateOf: record.duplicateOf || "",
    expenseId: record.expenseId || "",
    updatedAt: now,
    recipient: record.recipient || "",
    bodyPreview: record.bodyPreview || "",
  };
  const values = EMAIL_SCHEMA.map(s => full[s.key] ?? "");
  const out = await call(t, rangeUrl(sheetId, `A:${LAST_COL}`, ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"), {
    method: "POST", body: JSON.stringify({ values: [values] }),
  });
  const m = (out.updates?.updatedRange || "").match(/!([A-Z]+)(\d+)/);
  return { ...full, id: full.id, _row: m ? Number(m[2]) : null };
}

async function rowById(env, sheetId, id, token) {
  const t = await tokenOf(env, token);
  const d = await call(t, rangeUrl(sheetId, `${COL.id}2:${COL.id}`));
  const rows = d.values || [];
  for (let i = 0; i < rows.length; i++) if (String(rows[i][0] || "") === String(id)) return i + 2;
  return null;
}

export async function getEmailInboxById(env, sheetId, id, token = null) {
  const t = await tokenOf(env, token);
  const row = await rowById(env, sheetId, id, t);
  if (!row) return null;
  const d = await call(t, rangeUrl(sheetId, `A${row}:${LAST_COL}${row}`));
  return toObject(d.values?.[0] || [], row);
}

export async function updateEmailInbox(env, sheetId, id, patch = {}, token = null) {
  const t = await tokenOf(env, token);
  const row = await rowById(env, sheetId, id, t);
  if (!row) return { ok: false, reason: "not_found" };
  const boolKeys = new Set(["isSubscription"]);
  const data = [];
  for (const [key, value] of Object.entries({ ...patch, updatedAt: new Date().toISOString() })) {
    if (!COL[key]) continue;
    data.push({ range: `${TAB_EMAIL}!${COL[key]}${row}`, values: [[boolKeys.has(key) ? (value ? "TRUE" : "FALSE") : value]] });
  }
  if (!data.length) return { ok: false, reason: "nothing_to_update" };
  await call(t, `${API}/${sheetId}/values:batchUpdate`, {
    method: "POST", body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  return { ok: true, row };
}

function norm(v) {
  return String(v || "").normalize("NFKC").toLowerCase()
    .replace(/(?:บริษัท|บจก\.?|หจก\.?|จำกัด|co\.?\s*,?\s*ltd\.?|invoice|receipt)/gi, "")
    .replace(/[^0-9a-z฀-๿]/g, "");
}
function dayDiff(a, b) {
  const x = Date.parse(`${a}T00:00:00Z`), y = Date.parse(`${b}T00:00:00Z`);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) / 86400000 : 99999;
}

export async function findEmailDuplicate(env, sheetId, candidate = {}, token = null) {
  const all = await readEmailInbox(env, sheetId, token);
  const matches = [];
  for (const r of all) {
    let score = 0, reason = "";
    if (candidate.messageId && candidate.filename && candidate.messageId === r.messageId && candidate.filename === r.filename) {
      score = 100; reason = "อีเมลและไฟล์เดียวกัน";
    } else if (candidate.fileHash && candidate.fileHash === r.fileHash) {
      score = 100; reason = "ไฟล์แนบเดียวกัน";
    } else if (candidate.invoiceNo && norm(candidate.invoiceNo) === norm(r.invoiceNo) && norm(candidate.vendor) === norm(r.vendor)) {
      score = 96; reason = "เลขที่เอกสารและผู้ขายตรงกัน";
    } else if (Number(candidate.amount) > 0 && Math.abs(Number(candidate.amount) - Number(r.amount)) < 0.01 &&
      norm(candidate.vendor) && norm(candidate.vendor) === norm(r.vendor) && dayDiff(candidate.documentDate, r.documentDate) <= 3) {
      score = 82; reason = "ผู้ขาย ยอด และวันที่ใกล้กัน";
    }
    if (score) matches.push({ id: r.id, score, reason, vendor: r.vendor, amount: r.amount, documentDate: r.documentDate, driveUrl: r.driveUrl });
  }
  matches.sort((a, b) => b.score - a.score);
  return { hasDuplicate: matches.length > 0, level: matches[0]?.score >= 95 ? "high" : matches.length ? "medium" : "none", matches: matches.slice(0, 3) };
}

export function buildSubscriptions(rows = []) {
  const groups = new Map();
  for (const r of rows) {
    if (!r.isSubscription || ["ไม่ใช่เอกสาร", "ข้ามแล้ว", "อ่านไม่สำเร็จ"].includes(r.status)) continue;
    const key = norm(r.subscriptionName || r.vendor);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => String(a.documentDate || a.receivedAt).localeCompare(String(b.documentDate || b.receivedAt)));
    const last = list.at(-1);
    const amounts = list.map(x => Number(x.amount) || 0).filter(x => x > 0);
    let avgDays = 30;
    if (list.length > 1) {
      const diffs = [];
      for (let i = 1; i < list.length; i++) {
        const a = Date.parse(list[i - 1].documentDate || list[i - 1].receivedAt);
        const b = Date.parse(list[i].documentDate || list[i].receivedAt);
        if (Number.isFinite(a) && Number.isFinite(b)) diffs.push((b - a) / 86400000);
      }
      if (diffs.length) avgDays = Math.max(1, Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length));
    }
    const base = new Date(last.documentDate || last.receivedAt || Date.now());
    base.setUTCDate(base.getUTCDate() + avgDays);
    out.push({
      key: norm(last.subscriptionName || last.vendor),
      name: last.subscriptionName || last.vendor || "ไม่ระบุบริการ",
      vendor: last.vendor || "",
      currency: last.currency || "THB",
      lastAmount: Number(last.amount) || 0,
      averageAmount: amounts.length ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0,
      count: list.length,
      lastDate: last.documentDate || last.receivedAt,
      nextExpected: base.toISOString().slice(0, 10),
      variable: amounts.length > 1 && Math.max(...amounts) - Math.min(...amounts) > Math.max(...amounts) * 0.05,
      latestId: last.id,
    });
  }
  return out.sort((a, b) => String(b.lastDate).localeCompare(String(a.lastDate)));
}
