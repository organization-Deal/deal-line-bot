// ระบบรวมรายการย่อยหลายรายการเป็น "ใบเบิกหลัก" ต่อผู้เบิก
// - ใบเบิกปกติ: สร้างอัตโนมัติตามเวลาที่ตั้งไว้ (ค่าเริ่มต้น จันทร์ 11:00 Asia/Bangkok)
// - ใบเบิกด่วน: สร้างทันทีจากรายการที่เลือก
// - สูงสุดค่าเริ่มต้น 10 รายการย่อยต่อ PDF ถ้าเกินจะแบ่ง P1, P2, ...

import { getAccessToken } from "./google-auth.js";
import { getUserToken } from "./oauth.js";
import {
  readExpenses, readSettings,
  updateExpensesByIds, updateExpensesByIdPatches,
  STATUS_DELETED,
} from "./sheets.js";
import { createBatchClaimPdf } from "./batch-documents.js";
import { uploadFile } from "./drive.js";
import { push, textMsg } from "./line.js";
import { buildReimbursementCorrectionCard } from "./card.js";
import {
  listPaymentChannels,
  findPaymentChannel,
  channelDisplay,
  channelSnapshot,
} from "./payment-channels.js";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE = "https://www.googleapis.com/drive/v3";
export const TAB_BATCHES = "รอบเบิก";
export const BATCH_VERSION = "REIMBURSEMENT_ACCOUNTING_TABLE_V5_FINANCE_CHANNELS_20260803";

const LOCAL_BATCH_LOCKS = new Map();
const LOCAL_SCHEDULE_CLAIMS = new Set();

export const BATCH_SCHEMA = [
  { col: "A", key: "createdAt", header: "สร้างเมื่อ" },
  { col: "B", key: "id", header: "batch_id" },
  { col: "C", key: "runNo", header: "เลขรอบเบิก" },
  { col: "D", key: "docId", header: "เลขเอกสาร" },
  { col: "E", key: "type", header: "ประเภทรอบ" },
  { col: "F", key: "status", header: "สถานะรอบ" },
  { col: "G", key: "payerId", header: "รหัสผู้เบิก" },
  { col: "H", key: "payerName", header: "ผู้เบิก" },
  { col: "I", key: "itemCount", header: "จำนวนรายการ" },
  { col: "J", key: "total", header: "ยอดรวม" },
  { col: "K", key: "periodStart", header: "รายการตั้งแต่" },
  { col: "L", key: "periodEnd", header: "รายการถึง" },
  { col: "M", key: "pdfUrl", header: "ใบขอเบิกรวม PDF" },
  { col: "N", key: "itemIds", header: "รหัสรายการ" },
  { col: "O", key: "part", header: "ส่วนที่" },
  { col: "P", key: "approvedAt", header: "อนุมัติเมื่อ" },
  { col: "Q", key: "paidAt", header: "จ่ายเมื่อ" },
  { col: "R", key: "note", header: "หมายเหตุ" },
  // คอลัมน์ S:U คงไว้เพื่อไม่ให้โครงสร้างชีทลูกค้าเดิมเลื่อน แต่ไม่อยู่ใน Flow ปัจจุบัน
  { col: "S", key: "peakStatus", header: "สถานะ PEAK (Legacy)" },
  { col: "T", key: "peakRef", header: "เลขอ้างอิง PEAK" },
  { col: "U", key: "peakAt", header: "บันทึก PEAK เมื่อ" },
  { col: "V", key: "transferStatus", header: "สถานะตั้งโอน" },
  { col: "W", key: "transferRef", header: "เลขอ้างอิงตั้งโอน" },
  { col: "X", key: "transferAt", header: "ตั้งโอนเมื่อ" },
  { col: "Y", key: "paymentSlipUrl", header: "สลิปจ่ายคืน" },
  { col: "Z", key: "paymentSlipAt", header: "แนบสลิปเมื่อ" },
  { col: "AA", key: "lineNotifyStatus", header: "สถานะแจ้ง LINE" },
  { col: "AB", key: "lineNotifyAt", header: "แจ้ง LINE เมื่อ" },
  { col: "AC", key: "rejectionReason", header: "เหตุผลตีกลับ" },
  { col: "AD", key: "auditLog", header: "ประวัติการทำรายการ" },
  { col: "AE", key: "updatedAt", header: "อัปเดตล่าสุด" },
  { col: "AF", key: "reconcileStatus", header: "สถานะกระทบยอด" },
  { col: "AG", key: "reconciliationId", header: "รหัสรายการธนาคาร" },
  { col: "AH", key: "reconciledAt", header: "กระทบยอดเมื่อ" },
  { col: "AI", key: "reconciliationNote", header: "หมายเหตุกระทบยอด" },
  { col: "AJ", key: "paymentChannelId", header: "รหัสช่องทางที่จ่าย" },
  { col: "AK", key: "paymentChannelLabel", header: "ชื่อช่องทางที่จ่าย" },
  { col: "AL", key: "paymentChannelType", header: "ประเภทช่องทางที่จ่าย" },
  { col: "AM", key: "paymentChannelBank", header: "ธนาคาร/ผู้ให้บริการที่จ่าย" },
  { col: "AN", key: "paymentChannelNumber", header: "เลขบัญชีต้นทาง" },
  { col: "AO", key: "paymentChannelName", header: "ชื่อบัญชีต้นทาง" },
];

const LAST_COL = BATCH_SCHEMA[BATCH_SCHEMA.length - 1].col;
const BATCH_HEADER = BATCH_SCHEMA.map((x) => x.header);
const COL = Object.fromEntries(BATCH_SCHEMA.map((x) => [x.key, x.col]));

function columnNumber(a1 = "A") {
  return String(a1 || "A").toUpperCase().split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

function tabName(env) {
  return env.SHEET_TAB || "รายจ่าย";
}

async function authToken(env, token) {
  return token || (await getAccessToken(env));
}

async function call(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Sheets ${res.status}: ${text.slice(0, 320)}`);
    err.status = res.status;
    err.retryAfter = Number(res.headers.get("retry-after") || 0) || 0;
    err.isQuota = res.status === 429 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(text);
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

function rangeUrl(sheetId, tab, a1, suffix = "") {
  return `${SHEETS}/${sheetId}/values/${encodeURIComponent(`${tab}!${a1}`)}${suffix}`;
}

function id8() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

function toNum(v) {
  return Number(String(v ?? "").replace(/[^0-9.-]/g, "")) || 0;
}

function parseDate(input) {
  const nums = String(input || "").match(/\d+/g);
  if (!nums || nums.length < 3) return null;
  let y, m, d;
  if (nums[0].length === 4) [y, m, d] = nums.map(Number);
  else [d, m, y] = nums.map(Number);
  if (y > 2400) y -= 543;
  if (y < 100) y += 2000;
  if (y < 2000 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const p = (n) => String(n).padStart(2, "0");
  return { iso: `${y}-${p(m)}-${p(d)}`, ts: Date.UTC(y, m - 1, d) };
}

function bangkokParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second),
    weekday: weekdayMap[p.weekday],
    isoDate: `${p.year}-${p.month}-${p.day}`,
  };
}

function isoWeek(date = new Date()) {
  const b = bangkokParts(date);
  const d = new Date(Date.UTC(b.year, b.month - 1, b.day));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function payerKey(rec = {}) {
  return String(rec.payerId || rec.payerName || rec.sender || "ไม่ระบุผู้เบิก").trim();
}

function payerName(rec = {}) {
  return String(rec.payerName || rec.sender || "ไม่ระบุผู้เบิก").trim();
}

function isEligible(rec) {
  if (!rec || !String(rec.id || "").trim() || rec.status === STATUS_DELETED) return false;
  if (rec.type === "รายรับ" || rec.type === "income") return false;
  if (rec.paid) return false;
  if (!(Number(rec.amount) > 0)) return false;
  // ป้องกันข้อมูลเก่าก่อนติดตั้งฟีเจอร์ถูกดึงเข้ารอบแบบไม่ตั้งใจ
  // รายการใหม่จากโค้ดชุดนี้จะมี batchType / batchStatus ตั้งแต่ตอนบันทึก
  const enrolled = String(rec.batchType || rec.batchStatus || rec.urgentRequestedAt || "").trim();
  if (!enrolled) return false;
  const hasMainClaim = [rec.batchDocId, rec.batchNo, rec.batchClaimPdfUrl, rec.batchCreatedAt]
    .some((value) => String(value || "").trim());
  if (hasMainClaim) return false;
  // รายการที่ผู้เบิกยืนยันแล้วใช้สถานะ "รอตรวจเอกสาร" ได้ทันที
  // แต่ยังถือเป็นรายการย่อยที่เลือกไปรวมเป็นใบเบิกหลักได้ ตราบใดที่ยังไม่มีเลขใบเบิก
  if (["รวมรอบแล้ว", "ต้องแก้ไข", "รอโอนเงิน", "รอจ่าย", "รอหลักฐานการโอน", "อนุมัติแล้ว", "จ่ายแล้ว", "ยกเลิก"].includes(String(rec.batchStatus || "").trim())) return false;
  return true;
}

function parseList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function payerProfile(settings = {}, key, name) {
  const members = parseList(settings.team_members);
  const norm = (v) => String(v || "").trim().toLowerCase();
  return members.find((m) =>
    (key && norm(m.lineUserId || m.payerId) === norm(key)) ||
    (name && norm(m.name) === norm(name))
  ) || { name };
}

function missingProfileFields(profile = {}) {
  const missing = [];
  if (!String(profile.name || "").trim()) missing.push("ชื่อผู้เบิก");
  if (!String(profile.bank || "").trim()) missing.push("ธนาคาร");
  if (!String(profile.accountNo || "").trim()) missing.push("เลขบัญชี");
  if (!String(profile.accountName || "").trim()) missing.push("ชื่อบัญชี");
  return missing;
}

function maskAccount(value) {
  const raw = String(value || "").replace(/\s+/g, "");
  if (!raw) return "";
  return raw.length <= 4 ? raw : `••••${raw.slice(-4)}`;
}

function batchRowToObject(values, row) {
  const out = { _row: row };
  BATCH_SCHEMA.forEach((s, i) => { out[s.key] = values[i] ?? ""; });
  out.itemCount = toNum(out.itemCount);
  out.total = toNum(out.total);
  out.itemIds = String(out.itemIds || "").split(",").map((x) => x.trim()).filter(Boolean);
  try { out.auditEvents = JSON.parse(out.auditLog || "[]"); } catch { out.auditEvents = []; }
  if (!Array.isArray(out.auditEvents)) out.auditEvents = [];
  return out;
}

export async function ensureBatchTab(env, sheetId, token = null) {
  const t = await authToken(env, token);
  const requiredColumns = columnNumber(LAST_COL);
  const meta = await call(t, `${SHEETS}/${sheetId}?fields=sheets.properties(sheetId,title,gridProperties(columnCount,frozenRowCount))`);
  const sheet = (meta.sheets || []).find((s) => s.properties?.title === TAB_BATCHES);
  const exists = !!sheet;
  if (!exists) {
    await call(t, `${SHEETS}/${sheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{
          addSheet: {
            properties: {
              title: TAB_BATCHES,
              gridProperties: { frozenRowCount: 1, columnCount: requiredColumns },
            },
          },
        }],
      }),
    });
  } else {
    const currentColumns = Number(sheet.properties?.gridProperties?.columnCount || 0);
    const numericSheetId = sheet.properties?.sheetId;
    if (numericSheetId != null && currentColumns > 0 && currentColumns < requiredColumns) {
      await call(t, `${SHEETS}/${sheetId}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({
          requests: [{
            updateSheetProperties: {
              properties: { sheetId: numericSheetId, gridProperties: { columnCount: requiredColumns, frozenRowCount: 1 } },
              fields: "gridProperties.columnCount,gridProperties.frozenRowCount",
            },
          }],
        }),
      });
    }
  }
  await call(t, rangeUrl(sheetId, TAB_BATCHES, `A1:${LAST_COL}1`, "?valueInputOption=USER_ENTERED"), {
    method: "PUT",
    body: JSON.stringify({ values: [BATCH_HEADER] }),
  });
  return { created: !exists, tab: TAB_BATCHES };
}

export async function listBatches(env, sheetId, token = null) {
  const t = await authToken(env, token);
  let data;
  try {
    data = await call(t, rangeUrl(sheetId, TAB_BATCHES, `A2:${LAST_COL}`));
  } catch (e) {
    // ปกติแท็บถูกสร้างตอน migrate แล้ว จึงไม่ควรอ่าน metadata + เขียน header ทุกครั้งที่ Dashboard refresh
    // สร้างแท็บเฉพาะกรณีที่ยังไม่มีจริง ๆ
    if (e?.status !== 400 && e?.status !== 404) throw e;
    await ensureBatchTab(env, sheetId, t);
    data = await call(t, rangeUrl(sheetId, TAB_BATCHES, `A2:${LAST_COL}`));
  }
  return (data.values || [])
    .map((r, i) => batchRowToObject(r, i + 2))
    .filter((r) => r.id)
    .reverse();
}

async function appendBatch(env, sheetId, batch, token = null) {
  const t = await authToken(env, token);
  await ensureBatchTab(env, sheetId, t);
  const full = {
    createdAt: batch.createdAt || new Date().toISOString(),
    id: batch.id || id8(),
    runNo: batch.runNo || "",
    docId: batch.docId || "",
    type: batch.type || "ปกติ",
    status: batch.status || "รอตรวจเอกสาร",
    payerId: batch.payerId || "",
    payerName: batch.payerName || "",
    itemCount: batch.itemCount || 0,
    total: batch.total || 0,
    periodStart: batch.periodStart || "",
    periodEnd: batch.periodEnd || "",
    pdfUrl: batch.pdfUrl || "",
    itemIds: Array.isArray(batch.itemIds) ? batch.itemIds.join(", ") : (batch.itemIds || ""),
    part: batch.part || "1/1",
    approvedAt: batch.approvedAt || "",
    paidAt: batch.paidAt || "",
    note: batch.note || "",
    peakStatus: batch.peakStatus || "ยังไม่บันทึก",
    peakRef: batch.peakRef || "",
    peakAt: batch.peakAt || "",
    transferStatus: batch.transferStatus || "ยังไม่โอน",
    transferRef: batch.transferRef || "",
    transferAt: batch.transferAt || "",
    paymentSlipUrl: batch.paymentSlipUrl || "",
    paymentSlipAt: batch.paymentSlipAt || "",
    lineNotifyStatus: batch.lineNotifyStatus || "ยังไม่แจ้ง",
    lineNotifyAt: batch.lineNotifyAt || "",
    rejectionReason: batch.rejectionReason || "",
    auditLog: batch.auditLog || JSON.stringify([{ at: new Date().toISOString(), action: "created", detail: batch.note || "สร้างใบเบิกหลัก" }]),
    updatedAt: batch.updatedAt || new Date().toISOString(),
    reconcileStatus: batch.reconcileStatus || "",
    reconciliationId: batch.reconciliationId || "",
    reconciledAt: batch.reconciledAt || "",
    reconciliationNote: batch.reconciliationNote || "",
    paymentChannelId: batch.paymentChannelId || "",
    paymentChannelLabel: batch.paymentChannelLabel || "",
    paymentChannelType: batch.paymentChannelType || "",
    paymentChannelBank: batch.paymentChannelBank || "",
    paymentChannelNumber: batch.paymentChannelNumber || "",
    paymentChannelName: batch.paymentChannelName || "",
  };
  const values = BATCH_SCHEMA.map((s) => full[s.key] ?? "");
  const out = await call(t, rangeUrl(sheetId, TAB_BATCHES, `A:${LAST_COL}`, ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"), {
    method: "POST",
    body: JSON.stringify({ values: [values] }),
  });
  const m = String(out.updates?.updatedRange || "").match(/!([A-Z]+)(\d+)/);
  return { ...full, _row: m ? Number(m[2]) : null };
}

async function updateBatchRow(env, sheetId, batchId, patch, token = null, knownRecord = null) {
  const t = await authToken(env, token);
  const rec = knownRecord || (await listBatches(env, sheetId, t)).find((x) => x.id === batchId || x.docId === batchId);
  if (!rec) return { ok: false, reason: "not_found" };
  const data = [];
  for (const [key, raw] of Object.entries(patch || {})) {
    if (!COL[key]) continue;
    const value = Array.isArray(raw) ? raw.join(", ") : raw;
    data.push({ range: `${TAB_BATCHES}!${COL[key]}${rec._row}`, values: [[value]] });
  }
  if (!data.length) return { ok: false, reason: "nothing_to_update" };
  await call(t, `${SHEETS}/${sheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  return { ok: true, record: { ...rec, ...patch } };
}


/**
 * อัปเดตสถานะกระทบยอดหลายใบเบิกด้วย Google Sheets batchUpdate ครั้งเดียว
 * ใช้จาก reconciliation.js เพื่อลด read/write quota
 */
export async function updateBatchReconciliations(env, sheetId, changes = [], token = null, knownBatches = null) {
  const t = await authToken(env, token);
  const batches = Array.isArray(knownBatches) ? knownBatches : await listBatches(env, sheetId, t);
  const byId = new Map(batches.map((batch) => [String(batch.id || ""), batch]));
  const now = new Date().toISOString();
  const data = [];
  const updated = [];
  const errors = [];

  for (const change of Array.isArray(changes) ? changes : []) {
    const batchId = String(change?.batchId || "");
    const rec = byId.get(batchId);
    if (!rec) {
      errors.push({ batchId, reason: "not_found" });
      continue;
    }
    const patch = {
      reconcileStatus: String(change.reconcileStatus || ""),
      reconciliationId: String(change.reconciliationId || ""),
      reconciledAt: String(change.reconciledAt || ""),
      reconciliationNote: String(change.reconciliationNote || ""),
      updatedAt: now,
    };
    const action = patch.reconcileStatus === "กระทบยอดแล้ว" ? "bank_reconciled" : "bank_reconciliation_unlinked";
    patch.auditLog = auditJson(rec, action, {
      reconciliationId: patch.reconciliationId,
      note: patch.reconciliationNote,
    });
    for (const [key, value] of Object.entries(patch)) {
      if (!COL[key]) continue;
      data.push({ range: `${TAB_BATCHES}!${COL[key]}${rec._row}`, values: [[value ?? ""]] });
    }
    updated.push(batchId);
  }

  if (data.length) {
    await call(t, `${SHEETS}/${sheetId}/values:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
    });
  }
  return { ok: errors.length === 0, updated, errors };
}

function auditJson(rec, action, detail = {}) {
  const events = Array.isArray(rec?.auditEvents) ? [...rec.auditEvents] : [];
  events.push({ at: new Date().toISOString(), action, detail });
  return JSON.stringify(events.slice(-80));
}

async function findBatch(env, sheetId, batchId, token = null) {
  const rows = await listBatches(env, sheetId, token);
  return rows.find((x) => x.id === batchId || x.docId === batchId) || null;
}

async function patchBatchExpenses(env, sheetId, itemIds, patch, token = null) {
  const ids = [...new Set((itemIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return { ok: true, updatedIds: [] };
  try {
    return await updateExpensesByIds(env, sheetId, ids, patch, token);
  } catch (e) {
    console.warn("batch expense patch", e.message);
    throw e;
  }
}

function periodOf(items) {
  const dates = items.map((r) => parseDate(r.dateISO || r.dateText || r.date)).filter(Boolean).sort((a, b) => a.ts - b.ts);
  return {
    start: dates[0]?.iso || "",
    end: dates[dates.length - 1]?.iso || "",
  };
}

function splitEvery(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function nextRunNo(env, sheetId, token, type = "ปกติ") {
  const { year, week } = isoWeek();
  const prefix = `${year}-W${String(week).padStart(2, "0")}-${type === "ด่วน" ? "U" : "B"}`;
  const all = await listBatches(env, sheetId, token);
  let max = 0;
  for (const b of all) {
    const m = String(b.runNo || "").match(new RegExp(`^${prefix}(\\d{2})$`));
    if (m) max = Math.max(max, Number(m[1]) || 0);
  }
  return `${prefix}${String(max + 1).padStart(2, "0")}`;
}

function groupItems(items) {
  const map = new Map();
  const ordered = [...items].sort((a, b) =>
    String(a.createdAt || a.dateISO || "").localeCompare(String(b.createdAt || b.dateISO || ""))
  );
  for (const item of ordered) {
    const key = payerKey(item);
    if (!map.has(key)) map.set(key, { key, name: payerName(item), items: [] });
    map.get(key).items.push(item);
  }
  return [...map.values()];
}

async function createReimbursementBatchesUnlocked(env, tenant, sheetId, token, options = {}) {
  const settings = options.settings || await readSettings(env, sheetId, token);
  const type = options.type === "ด่วน" ? "ด่วน" : "ปกติ";
  const mergeItems = String(options.mergeItems ?? settings.batch_merge_items ?? "TRUE").toUpperCase() !== "FALSE";
  const maxItems = mergeItems
    ? Math.max(1, Math.min(10, Number(options.maxItems || settings.batch_max_items || 10)))
    : 1;
  const all = await readExpenses(env, sheetId, token);
  const selected = new Set((options.expenseIds || []).map(String));
  const requestedPayer = String(options.payerKey || "").trim();

  let eligible = all.filter(isEligible);
  if (selected.size) eligible = eligible.filter((r) => selected.has(String(r.id)));
  if (requestedPayer) eligible = eligible.filter((r) => payerKey(r) === requestedPayer);
  if (type === "ด่วน" && !selected.size) eligible = eligible.filter((r) => r.batchType === "ด่วน" || r.batchStatus === "ขอเบิกด่วน");

  if (!eligible.length) return { ok: true, runNo: "", batches: [], itemCount: 0, total: 0, message: "ไม่มีรายการย่อยรอสร้างใบเบิก" };

  const runNo = options.runNo || await nextRunNo(env, sheetId, token, type);
  const groups = groupItems(eligible);
  const created = [];
  const blocked = [];
  let totalAll = 0;
  let itemCount = 0;
  let peopleCreated = 0;

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const profile = payerProfile(settings, group.key, group.name);
    const missing = missingProfileFields(profile);
    if (missing.length) {
      blocked.push({
        payerKey: group.key,
        payerName: group.name,
        itemCount: group.items.length,
        total: group.items.reduce((sum, r) => sum + (Number(r.amount) || 0), 0),
        missing,
      });
      continue;
    }
    peopleCreated += 1;
    const chunks = splitEvery(group.items, maxItems);

    for (let p = 0; p < chunks.length; p++) {
      const items = chunks[p];
      const baseDocId = `${runNo}-${String(g + 1).padStart(3, "0")}`;
      const docId = chunks.length > 1 ? `${baseDocId}-P${p + 1}` : baseDocId;
      const period = periodOf(items);
      const total = items.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
      const batchDraft = {
        id: id8(), runNo, docId, type, status: "รอตรวจเอกสาร",
        payerId: profile.lineUserId || profile.payerId || group.key, payerName: profile.name || group.name,
        itemCount: items.length, total,
        periodStart: period.start, periodEnd: period.end,
        itemIds: items.map((r) => r.id),
        part: `${p + 1}/${chunks.length}`,
        note: options.note || (type === "ด่วน" ? "ผู้เบิกขอรับเงินด่วน" : "สร้างใบเบิกอัตโนมัติ"),
      };

      const pdf = await createBatchClaimPdf(env, batchDraft, items, settings, profile, token);
      let saved;
      try {
        saved = await appendBatch(env, sheetId, { ...batchDraft, pdfUrl: pdf.pdfUrl }, token);
      } catch (e) {
        if (pdf.fileId) {
          await fetch(`https://www.googleapis.com/drive/v3/files/${pdf.fileId}`, {
            method: "DELETE", headers: { Authorization: `Bearer ${token}` },
          }).catch(() => {});
        }
        throw e;
      }

      const itemPatches = new Map(items.map((item) => [String(item.id), {
        payerId: item.payerId || profile.lineUserId || profile.payerId || group.key,
        batchType: type,
        batchStatus: "รอตรวจเอกสาร",
        batchNo: runNo,
        batchDocId: docId,
        batchClaimPdfUrl: pdf.pdfUrl,
        batchPart: `${p + 1}/${chunks.length}`,
        batchCreatedAt: saved.createdAt,
      }]));
      try {
        await updateExpensesByIdPatches(env, sheetId, itemPatches, token);
      } catch (e) {
        // ป้องกันครึ่งรอบ: คืนรายการทั้งหมดกลับเข้าคิว และทำเครื่องหมายใบเบิกว่ายกเลิก
        await updateExpensesByIds(env, sheetId, items.map((item) => item.id), {
          batchType: "ปกติ", batchStatus: "รอตรวจเอกสาร", batchNo: "",
          batchDocId: "", batchClaimPdfUrl: "", batchPart: "", batchCreatedAt: "",
        }, token).catch(() => {});
        await updateBatchRow(env, sheetId, saved.id, {
          status: "ยกเลิก", note: `สร้างใบเบิกไม่สมบูรณ์: ${String(e.message || e).slice(0, 140)}`,
        }, token, saved).catch(() => {});
        if (pdf.fileId) {
          await fetch(`https://www.googleapis.com/drive/v3/files/${pdf.fileId}`, {
            method: "DELETE", headers: { Authorization: `Bearer ${token}` },
          }).catch(() => {});
        }
        throw e;
      }

      created.push(saved);
      totalAll += total;
      itemCount += items.length;
    }
  }

  console.log(`[batch] tenant=${tenant} run=${runNo} type=${type} docs=${created.length} items=${itemCount} total=${totalAll} blocked=${blocked.length}`);
  if (!created.length && blocked.length) {
    return {
      ok: false,
      reason: "missing_payer_profile",
      message: "ยังสร้างใบเบิกไม่ได้ เพราะข้อมูลบัญชีผู้เบิกไม่ครบ",
      runNo: "",
      batches: [],
      itemCount: 0,
      total: 0,
      people: 0,
      blocked,
    };
  }
  return { ok: true, runNo: created.length ? runNo : "", batches: created, itemCount, total: totalAll, people: peopleCreated, blocked };
}

function batchCoordinatorStub(env, tenant) {
  if (!env.MULTI_SESSIONS) return null;
  const id = env.MULTI_SESSIONS.idFromName(`batch-coordinator:${tenant}`);
  return env.MULTI_SESSIONS.get(id);
}

async function coordinatorCall(stub, path, body = {}) {
  const res = await stub.fetch(`https://batch.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.message || data.error || `batch coordinator ${res.status}`);
  return data;
}

async function acquireBatchLock(env, tenant) {
  const stub = batchCoordinatorStub(env, tenant);
  if (stub) {
    const out = await coordinatorCall(stub, "/batch-coordinator/acquire", { ttlMs: 5 * 60 * 1000 });
    return { mode: "durable", stub, token: out.token };
  }

  // Fallback สำหรับกรณี binding ยังไม่พร้อม: กันกดซ้ำภายใน isolate โดยไม่เขียน KV
  const now = Date.now();
  const existing = LOCAL_BATCH_LOCKS.get(tenant);
  if (existing && existing.expiresAt > now) throw new Error("มีการสร้างใบเบิกของธุรกิจนี้กำลังทำงานอยู่ กรุณารอสักครู่");
  const token = crypto.randomUUID();
  LOCAL_BATCH_LOCKS.set(tenant, { token, expiresAt: now + 5 * 60 * 1000 });
  return { mode: "local", tenant, token };
}

async function releaseBatchLock(env, lock) {
  if (!lock) return;
  if (lock.mode === "durable") {
    await coordinatorCall(lock.stub, "/batch-coordinator/release", { token: lock.token }).catch(() => {});
    return;
  }
  const current = LOCAL_BATCH_LOCKS.get(lock.tenant);
  if (current?.token === lock.token) LOCAL_BATCH_LOCKS.delete(lock.tenant);
}

async function claimScheduledRun(env, tenant, slot) {
  const stub = batchCoordinatorStub(env, tenant);
  if (stub) return coordinatorCall(stub, "/batch-coordinator/claim-schedule", { slot });
  const key = `${tenant}:${slot}`;
  if (LOCAL_SCHEDULE_CLAIMS.has(key)) return { ok: true, claimed: false };
  LOCAL_SCHEDULE_CLAIMS.add(key);
  return { ok: true, claimed: true, key };
}

async function releaseScheduledRun(env, tenant, slot) {
  const stub = batchCoordinatorStub(env, tenant);
  if (stub) {
    await coordinatorCall(stub, "/batch-coordinator/release-schedule", { slot }).catch(() => {});
    return;
  }
  LOCAL_SCHEDULE_CLAIMS.delete(`${tenant}:${slot}`);
}

export async function createReimbursementBatches(env, tenant, sheetId, token, options = {}) {
  const lock = await acquireBatchLock(env, tenant);
  try {
    return await createReimbursementBatchesUnlocked(env, tenant, sheetId, token, options);
  } finally {
    await releaseBatchLock(env, lock).catch(() => {});
  }
}

export async function requestUrgentBatch(env, tenant, sheetId, token, expenseIds = []) {
  const ids = [...new Set((Array.isArray(expenseIds) ? expenseIds : [expenseIds]).map(String).filter(Boolean))];
  if (!ids.length) return { ok: false, reason: "no_expense_ids" };

  const wanted = new Set(ids);
  const all = await readExpenses(env, sheetId, token);
  const records = all.filter((rec) => wanted.has(String(rec.id || "")) && isEligible(rec));
  if (!records.length) return { ok: false, reason: "no_eligible_items" };

  const recordIds = records.map((r) => String(r.id));
  await updateExpensesByIds(env, sheetId, recordIds, {
    batchType: "ด่วน",
    batchStatus: "ขอเบิกด่วน",
    urgentRequestedAt: new Date().toISOString(),
  }, token);

  try {
    return await createReimbursementBatches(env, tenant, sheetId, token, {
      type: "ด่วน",
      expenseIds: recordIds,
      note: "สร้างใบเบิกด่วนจากคำขอผู้เบิก",
    });
  } catch (error) {
    await updateExpensesByIds(env, sheetId, recordIds, {
      batchType: "ปกติ",
      batchStatus: "รอตรวจเอกสาร",
      urgentRequestedAt: "",
    }, token).catch(() => {});
    throw error;
  }
}

export async function getBatchDashboard(env, sheetId, token = null) {
  const [expenses, batches, settings] = await Promise.all([
    readExpenses(env, sheetId, token),
    listBatches(env, sheetId, token),
    readSettings(env, sheetId, token),
  ]);
  const paymentChannels = listPaymentChannels(settings);
  const paymentChannelById = new Map(paymentChannels.map((channel) => [String(channel.id), channel]));
  const pending = expenses.filter(isEligible);
  const itemView = (r = {}) => ({
    id: r.id, dateISO: r.dateISO, dateText: r.dateText, createdAt: r.createdAt,
    vendor: r.vendor, transferor: r.transferor, payerName: r.payerName,
    note: r.note, amount: r.amount, category: r.category, docType: r.docType,
    batchType: r.batchType || "ปกติ", batchStatus: r.batchStatus || "รอตรวจเอกสาร",
    imageUrl: r.imageUrl, claimPdfUrl: r.claimPdfUrl, receiptPdfUrl: r.receiptPdfUrl,
    attReceipt: r.attReceipt || "", attTax: r.attTax || "", attSlip: r.attSlip || "", attOther: r.attOther || "",
    duplicateStatus: r.duplicateStatus || "", duplicateOf: r.duplicateOf || "",
    reimbursementSlipUrl: r.reimbursementSlipUrl || "",
  });
  const groups = groupItems(pending).map((g) => {
    const profile = payerProfile(settings, g.key, g.name);
    const missing = missingProfileFields(profile);
    return {
      payerKey: g.key,
      payerId: profile.lineUserId || profile.payerId || g.key || "",
      payerName: profile.name || g.name,
      itemCount: g.items.length,
      total: g.items.reduce((sum, r) => sum + (Number(r.amount) || 0), 0),
      urgentCount: g.items.filter((r) => r.batchType === "ด่วน" || r.batchStatus === "ขอเบิกด่วน").length,
      oldestCreatedAt: g.items.map((r) => r.createdAt).filter(Boolean).sort()[0] || "",
      profileComplete: missing.length === 0,
      missingProfileFields: missing,
      bank: profile.bank || "",
      accountNo: profile.accountNo || "",
      accountName: profile.accountName || "",
      accountMasked: maskAccount(profile.accountNo),
      items: g.items.map(itemView),
    };
  });
  const summarizeRows = (rows) => ({
    count: rows.length,
    itemCount: rows.reduce((sum, b) => sum + (Number(b.itemCount) || 0), 0),
    total: rows.reduce((sum, b) => sum + (Number(b.total) || 0), 0),
  });
  const expensesById = new Map(expenses.map((r) => [String(r.id || ""), r]));
  const enriched = batches.map((b) => {
    const profile = payerProfile(settings, b.payerId, b.payerName);
    const missing = missingProfileFields(profile);
    const items = (b.itemIds || []).map((id) => expensesById.get(String(id))).filter(Boolean).map(itemView);
    const status = String(b.status || "รอตรวจเอกสาร");
    const workflowStep = status === "จ่ายแล้ว" || b.paymentSlipUrl ? "paid"
      : ["ยกเลิก", "ไม่อนุมัติ", "rejected", "Rejected"].includes(status) ? "rejected"
      : status === "ต้องแก้ไข" || status === "ตีกลับ" ? "correction"
      : status === "รอตรวจเอกสาร" || status === "รออนุมัติ" || status === "รวมรอบแล้ว" ? "review"
      : "payment";
    return {
      ...b,
      status,
      bank: profile.bank || "",
      accountNo: profile.accountNo || "",
      accountName: profile.accountName || "",
      accountMasked: maskAccount(profile.accountNo),
      profileComplete: missing.length === 0,
      missingProfileFields: missing,
      items,
      workflowStep,
      paymentChannel: paymentChannelById.get(String(b.paymentChannelId || "")) || (b.paymentChannelId ? {
        id: b.paymentChannelId,
        label: b.paymentChannelLabel || b.paymentChannelBank || "ช่องทางที่จ่าย",
        type: b.paymentChannelType || "bank",
        bank: b.paymentChannelBank || "",
        number: b.paymentChannelNumber || "",
        name: b.paymentChannelName || "",
        active: false,
      } : null),
      documentReady: !!b.pdfUrl && items.length > 0 && items.every((r) => r.imageUrl || r.attReceipt || r.attTax || r.attSlip || r.attOther),
    };
  });
  const rowsByStep = (step) => enriched.filter((b) => b.workflowStep === step);
  const active = enriched.filter((b) => !["จ่ายแล้ว", "ยกเลิก"].includes(String(b.status || "")));
  return {
    ok: true,
    version: BATCH_VERSION,
    paymentChannels,
    settings: {
      enabled: String(settings.batch_enabled || "FALSE").toUpperCase() === "TRUE",
      weekday: Number(settings.batch_weekday ?? 1),
      hour: Number(settings.batch_hour ?? 11),
      minute: Number(settings.batch_minute ?? 0),
      maxItems: Number(settings.batch_max_items || 10),
      mergeItems: String(settings.batch_merge_items ?? "TRUE").toUpperCase() !== "FALSE",
      timezone: settings.batch_timezone || "Asia/Bangkok",
    },
    pending: {
      itemCount: pending.length,
      total: pending.reduce((sum, r) => sum + (Number(r.amount) || 0), 0),
      urgentCount: pending.filter((r) => r.batchType === "ด่วน" || r.batchStatus === "ขอเบิกด่วน").length,
      people: groups.length,
      groups,
    },
    batches: enriched,
    summary: {
      processing: summarizeRows(active),
      awaitingReview: summarizeRows(rowsByStep("review")),
      correctionRequired: summarizeRows(rowsByStep("correction")),
      waitingPayment: summarizeRows(rowsByStep("payment")),
      waitingProof: summarizeRows([]),
      paid: summarizeRows(rowsByStep("paid")),
      rejected: summarizeRows(rowsByStep("rejected")),
      // aliases สำหรับ Dashboard รุ่นก่อน ระหว่าง deploy สอง Repo
      awaitingApproval: summarizeRows(rowsByStep("review")),
      peakPending: summarizeRows([]),
      transferPending: summarizeRows(rowsByStep("payment")),
      slipPending: summarizeRows([]),
    },
  };
}

export async function updateReimbursementBatchStatus(env, sheetId, batchId, status, token = null) {
  const legacy = { "รออนุมัติ": "รอตรวจเอกสาร", "อนุมัติแล้ว": "รอโอนเงิน", "รอจ่าย": "รอโอนเงิน", "ตีกลับ": "ต้องแก้ไข" };
  const normalized = legacy[status] || status;
  const allowed = new Set(["รอตรวจเอกสาร", "ต้องแก้ไข", "รอโอนเงิน", "รอหลักฐานการโอน", "ยกเลิก"]);
  if (!allowed.has(normalized)) {
    if (normalized === "จ่ายแล้ว") return { ok: false, reason: "payment_slip_required", message: "ต้องแนบหลักฐานการโอนก่อน ระบบจึงจะเปลี่ยนเป็นจ่ายแล้ว" };
    return { ok: false, reason: "bad_status" };
  }
  const rec = await findBatch(env, sheetId, batchId, token);
  if (!rec) return { ok: false, reason: "not_found" };
  const now = new Date().toISOString();
  const patch = { status: normalized, updatedAt: now, auditLog: auditJson(rec, "status_changed", { status: normalized }) };
  if (normalized === "รอโอนเงิน") patch.approvedAt = rec.approvedAt || now;
  const out = await updateBatchRow(env, sheetId, batchId, patch, token, rec);
  if (!out.ok) return out;
  await patchBatchExpenses(env, sheetId, rec.itemIds, { paid: false, batchStatus: normalized }, token);
  return out;
}

async function resolveLineRecipient(env, sheetId, rec, token = null, knownItems = []) {
  const direct = String(rec?.payerId || "").trim();
  if (direct.startsWith("U")) return direct;

  try {
    const settings = await readSettings(env, sheetId, token);
    const profile = payerProfile(settings, rec?.payerId, rec?.payerName);
    const profileId = String(profile?.lineUserId || profile?.payerId || "").trim();
    if (profileId.startsWith("U")) return profileId;
  } catch (e) {
    console.warn("resolve batch LINE profile", e.message);
  }

  for (const item of knownItems || []) {
    const itemId = String(item?.payerId || item?.lineUserId || "").trim();
    if (itemId.startsWith("U")) return itemId;
  }
  // รองรับรอบเก่าที่คอลัมน์ผู้เบิกเคยเก็บเป็นชื่อ แต่รายการย่อยยังมี LINE User ID อยู่
  const wanted = new Set((rec?.itemIds || []).map(String));
  if (wanted.size) {
    try {
      const rows = await readExpenses(env, sheetId, token);
      for (const item of rows) {
        if (!wanted.has(String(item.id || ""))) continue;
        const itemId = String(item?.payerId || item?.lineUserId || "").trim();
        if (itemId.startsWith("U")) return itemId;
      }
    } catch (e) {
      console.warn("resolve batch LINE items", e.message);
    }
  }
  return "";
}

async function notifyCorrectionRequired(env, sheetId, rec, items, reason, token = null) {
  const recipientId = await resolveLineRecipient(env, sheetId, rec, token, items);
  if (!recipientId) return { status: "ไม่มี LINE User ID", at: "" };
  const targets = (items || []).slice(0, 4);
  const cards = targets.map((item, index) => buildReimbursementCorrectionCard(item, {
    reason,
    batchId: rec.docId || rec.id,
    position: `${index + 1}/${targets.length}`,
  }));
  const header = textMsg([
    "ฝ่ายบัญชีตีกลับรายการเบิกให้แก้ไข ⚠️",
    `ใบเบิก ${rec.docId || rec.runNo || rec.id}`,
    `เหตุผล: ${reason}`,
    "แก้ไขข้อมูลหรือแนบเอกสารเพิ่ม แล้วกด “ส่งกลับตรวจ” ในการ์ด",
  ].join("\n"));
  try {
    const ok = await push(env, recipientId, [header, ...cards].slice(0, 5));
    return { status: ok ? "แจ้งแก้ไขแล้ว" : "แจ้งแก้ไขไม่สำเร็จ", at: ok ? new Date().toISOString() : "" };
  } catch (e) {
    return { status: `แจ้งแก้ไขไม่สำเร็จ: ${String(e.message || e).slice(0, 100)}`, at: "" };
  }
}

function driveFileId(viewUrl) {
  const raw = String(viewUrl || "");
  const match = raw.match(/drive\.google\.com\/file\/d\/([^/?#]+)/i) || raw.match(/[?&]id=([^&#]+)/i);
  return match?.[1] || "";
}

function driveDirectImageUrl(viewUrl) {
  const raw = String(viewUrl || "");
  const fileId = driveFileId(raw);
  return fileId ? `https://lh3.googleusercontent.com/d/${fileId}` : raw;
}

async function buildUpdatedMainClaim(env, sheetId, rec, token = null) {
  const [settings, expenses] = await Promise.all([
    readSettings(env, sheetId, token),
    readExpenses(env, sheetId, token),
  ]);
  const profile = payerProfile(settings, rec?.payerId, rec?.payerName);
  const wanted = new Set((rec?.itemIds || []).map(String));
  const items = expenses.filter((item) => wanted.has(String(item.id || "")));
  if (!items.length) throw new Error("ไม่พบรายการย่อยสำหรับสร้างใบเบิกหลัก");
  return createBatchClaimPdf(env, rec, items, settings, profile, token);
}

async function removeOldMainClaim(token, oldUrl, newFileId = "") {
  const oldFileId = driveFileId(oldUrl);
  if (!oldFileId || oldFileId === newFileId) return;
  await fetch(`${DRIVE}/files/${oldFileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

async function notifyPaymentComplete(env, sheetId, rec, slipUrl, mediaType = "", token = null) {
  const recipientId = await resolveLineRecipient(env, sheetId, rec, token);
  if (!recipientId) return { status: "ไม่มี LINE User ID", at: "" };
  const text = textMsg([
    "บริษัทโอนเงินคืนแล้ว ✅",
    `ใบเบิก ${rec.docId || rec.runNo || rec.id}`,
    `${rec.itemCount} รายการ · รวม ฿${Number(rec.total || 0).toLocaleString("th-TH", { minimumFractionDigits: 2 })}`,
    `หลักฐานการโอน: ${slipUrl}`,
  ].join("\n"));
  const messages = [text];
  if (String(mediaType || "").toLowerCase().startsWith("image/")) {
    const imageUrl = driveDirectImageUrl(slipUrl);
    messages.push({ type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl });
  }
  try {
    const ok = await push(env, recipientId, messages);
    return { status: ok ? "ส่งแล้ว" : "ส่งไม่สำเร็จ", at: ok ? new Date().toISOString() : "" };
  } catch (e) {
    return { status: `ส่งไม่สำเร็จ: ${String(e.message || e).slice(0, 120)}`, at: "" };
  }
}

export async function updateReimbursementBatchWorkflow(env, sheetId, batchId, action, payload = {}, token = null) {
  const rec = await findBatch(env, sheetId, batchId, token);
  if (!rec) return { ok: false, reason: "not_found", message: "ไม่พบใบเบิก" };
  const now = new Date().toISOString();

  if (action === "approve") {
    const current = String(rec.status || "");
    if (["จ่ายแล้ว", "ยกเลิก"].includes(current)) return { ok: false, reason: "batch_closed", message: "ใบเบิกนี้ปิดงานแล้ว" };
    if (!["รอตรวจเอกสาร", "รออนุมัติ", "รวมรอบแล้ว"].includes(current)) {
      return { ok: false, reason: "not_waiting_review", message: "ใบเบิกนี้ไม่ได้อยู่ในขั้นตรวจเอกสาร" };
    }
    const patch = {
      status: "รอโอนเงิน", approvedAt: rec.approvedAt || now, rejectionReason: "",
      updatedAt: now, auditLog: auditJson(rec, "documents_approved", {}),
    };
    const out = await updateBatchRow(env, sheetId, batchId, patch, token, rec);
    if (out.ok) await patchBatchExpenses(env, sheetId, rec.itemIds, { paid: false, batchStatus: "รอโอนเงิน" }, token);
    return out;
  }

  if (action === "assign_payment_channel") {
    const current = String(rec.status || "");
    const closed = ["ยกเลิก", "ไม่อนุมัติ", "rejected", "Rejected"].includes(current);
    if (closed || (current === "จ่ายแล้ว" && String(rec.reconcileStatus || "") === "กระทบยอดแล้ว")) {
      return { ok: false, reason: "batch_closed", message: "ใบเบิกนี้ปิดงานหรือกระทบยอดแล้ว จึงเปลี่ยนบัญชีที่จ่ายไม่ได้" };
    }
    const settings = await readSettings(env, sheetId, token);
    const channel = findPaymentChannel(settings, payload.paymentChannelId || payload.channelId, { activeOnly: true });
    if (!channel) return { ok: false, reason: "payment_channel_not_found", message: "ไม่พบช่องทางการเงิน หรือช่องทางนี้ถูกปิดใช้งาน" };
    const snapshot = channelSnapshot(channel);
    const patch = {
      ...snapshot,
      updatedAt: now,
      auditLog: auditJson(rec, "payment_channel_assigned", { channelId: channel.id, channel: channelDisplay(channel) }),
    };
    const out = await updateBatchRow(env, sheetId, batchId, patch, token, rec);
    return { ...out, paymentChannel: channel };
  }

  if (action === "peak_recorded") return { ok: false, reason: "peak_removed", message: "ตัดขั้น PEAK ออกจาก Flow แล้ว" };

  if (action === "transfer_set") {
    const current = String(rec.status || "");
    if (!["รอโอนเงิน", "อนุมัติแล้ว", "รอจ่าย"].includes(current)) {
      const message = ["รอตรวจเอกสาร", "รออนุมัติ", "รวมรอบแล้ว"].includes(current)
        ? "ต้องตรวจเอกสารและกดเอกสารผ่านก่อน"
        : "ใบเบิกนี้ไม่ได้อยู่ในสถานะรอโอนเงิน";
      return { ok: false, reason: "batch_not_payable", message };
    }
    const patch = {
      status: "รอหลักฐานการโอน",
      transferStatus: "ตั้งโอนแล้ว", transferRef: "", transferAt: now,
      updatedAt: now, auditLog: auditJson(rec, "transfer_set", {}),
    };
    const out = await updateBatchRow(env, sheetId, batchId, patch, token, rec);
    if (out.ok) await patchBatchExpenses(env, sheetId, rec.itemIds, { paid: false, batchStatus: "รอหลักฐานการโอน" }, token);
    return out;
  }

  if (action === "reject") {
    if (!["รอตรวจเอกสาร", "รออนุมัติ", "รวมรอบแล้ว"].includes(String(rec.status || ""))) {
      return { ok: false, reason: "not_waiting_review", message: "ตีกลับได้เฉพาะใบเบิกที่กำลังตรวจเอกสาร" };
    }
    const reason = String(payload.reason || "").trim();
    if (!reason) return { ok: false, reason: "reason_required", message: "กรุณาระบุเหตุผลที่ตีกลับ" };
    const selected = new Set((Array.isArray(payload.itemIds) ? payload.itemIds : []).map(String));
    const batchItemIds = new Set((rec.itemIds || []).map(String));
    const expenseRows = await readExpenses(env, sheetId, token);
    const allItems = expenseRows.filter((item) =>
      batchItemIds.has(String(item.id || "")) &&
      (!selected.size || selected.has(String(item.id || "")))
    );
    const patch = {
      status: "ต้องแก้ไข", rejectionReason: reason, updatedAt: now,
      auditLog: auditJson(rec, "documents_rejected", { reason, itemIds: [...selected] }),
    };
    let out = await updateBatchRow(env, sheetId, batchId, patch, token, rec);
    if (out.ok) {
      await patchBatchExpenses(env, sheetId, rec.itemIds, { paid: false, batchStatus: "ต้องแก้ไข" }, token);
      const notice = await notifyCorrectionRequired(env, sheetId, rec, allItems.length ? allItems : (rec.itemIds || []).map((id) => ({ id, vendor: "รายการเบิก" })), reason, token);
      const rejectedRecord = { ...rec, ...patch };
      out = await updateBatchRow(env, sheetId, batchId, {
        lineNotifyStatus: notice.status, lineNotifyAt: notice.at, updatedAt: new Date().toISOString(),
        auditLog: auditJson({ ...rejectedRecord, auditEvents: [...(rec.auditEvents || []), { at: now, action: "documents_rejected", detail: { reason } }] }, "correction_notified", { status: notice.status }),
      }, token, rejectedRecord);
      return { ...out, notificationStatus: notice.status };
    }
    return out;
  }

  if (action === "resubmit") {
    if (!["ต้องแก้ไข", "ตีกลับ"].includes(String(rec.status || ""))) {
      return { ok: false, reason: "not_waiting_correction", message: "ใบเบิกนี้ไม่ได้อยู่ในสถานะต้องแก้ไข" };
    }

    // สร้างใบเบิกหลักใหม่จากข้อมูลและหลักฐานล่าสุดก่อนส่งกลับให้บัญชีตรวจ
    // เพื่อให้ PDF หลักมีใบแทนและไฟล์แนบที่พนักงานเพิ่งแก้ไขครบถ้วน
    let mainClaim;
    try {
      mainClaim = await buildUpdatedMainClaim(env, sheetId, rec, token);
    } catch (e) {
      return {
        ok: false,
        reason: "main_claim_regeneration_failed",
        message: `สร้างใบเบิกหลักฉบับอัปเดตไม่สำเร็จ: ${String(e.message || e).slice(0, 180)}`,
      };
    }

    const patch = {
      status: "รอตรวจเอกสาร", rejectionReason: "", pdfUrl: mainClaim.pdfUrl, updatedAt: now,
      auditLog: auditJson(rec, "correction_resubmitted", { mainClaimRegenerated: true }),
    };
    const out = await updateBatchRow(env, sheetId, batchId, patch, token, rec);
    if (out.ok) {
      await patchBatchExpenses(env, sheetId, rec.itemIds, {
        paid: false,
        batchStatus: "รอตรวจเอกสาร",
        batchClaimPdfUrl: mainClaim.pdfUrl,
      }, token);
      await removeOldMainClaim(token, rec.pdfUrl, mainClaim.fileId);
    }
    return { ...out, pdfUrl: mainClaim.pdfUrl };
  }

  if (action === "retry_payment_notification") {
    if (!rec.paymentSlipUrl) return { ok: false, reason: "slip_missing", message: "ยังไม่มีหลักฐานการโอน" };
    const uploadEvent = [...(rec.auditEvents || [])].reverse().find((e) => e?.action === "payment_slip_uploaded");
    const mediaType = String(uploadEvent?.detail?.mediaType || "");
    const notice = await notifyPaymentComplete(env, sheetId, rec, rec.paymentSlipUrl, mediaType, token);
    const out = await updateBatchRow(env, sheetId, batchId, {
      lineNotifyStatus: notice.status, lineNotifyAt: notice.at, updatedAt: now,
      auditLog: auditJson(rec, "payment_notification_retried", { status: notice.status }),
    }, token, rec);
    return { ...out, lineNotifyStatus: notice.status };
  }

  return { ok: false, reason: "bad_action", message: "ไม่รู้จักคำสั่ง Workflow" };
}

async function attachRepaymentProofToExpenses(env, sheetId, itemIds, slipUrl, paidAt, token = null) {
  const wanted = new Set((itemIds || []).map(String));
  if (!wanted.size) return { ok: true, updatedIds: [] };

  const rows = await readExpenses(env, sheetId, token);
  const patches = new Map();

  for (const rec of rows) {
    const id = String(rec.id || "");
    if (!wanted.has(id)) continue;
    const existingOther = String(rec.attOther || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!existingOther.includes(slipUrl)) existingOther.push(slipUrl);
    patches.set(id, {
      paid: true,
      batchStatus: "จ่ายแล้ว",
      attOther: existingOther.join(", "),
      reimbursementSlipUrl: slipUrl,
      reimbursedAt: paidAt,
    });
  }

  return updateExpensesByIdPatches(env, sheetId, patches, token);
}

export async function uploadReimbursementPaymentSlip(env, sheetId, batchId, file, token = null, options = {}) {
  const rec = await findBatch(env, sheetId, batchId, token);
  if (!rec) return { ok: false, reason: "not_found", message: "ไม่พบใบเบิก" };
  const currentStatus = String(rec.status || "");
  const settings = await readSettings(env, sheetId, token);
  const channels = listPaymentChannels(settings, { activeOnly: true });
  const requestedChannelId = String(options.paymentChannelId || rec.paymentChannelId || "").trim();
  const paymentChannel = findPaymentChannel(settings, requestedChannelId, { activeOnly: true });
  if (!channels.length) {
    return { ok: false, reason: "payment_channels_required", message: "กรุณาสร้างช่องทางการเงินของบริษัทก่อนบันทึกการจ่าย" };
  }
  if (!paymentChannel) {
    return { ok: false, reason: "payment_channel_required", message: "กรุณาเลือกบัญชีหรือช่องทางการเงินที่ใช้โอนรายการนี้" };
  }
  if (["ต้องแก้ไข", "ตีกลับ", "รอตรวจเอกสาร", "รออนุมัติ", "รวมรอบแล้ว"].includes(currentStatus)) {
    return { ok: false, reason: "review_required", message: "ต้องให้เอกสารผ่านก่อนแนบหลักฐานการโอน" };
  }
  if (currentStatus === "จ่ายแล้ว" || rec.paymentSlipUrl) return { ok: false, reason: "already_paid", message: "ใบเบิกนี้แนบหลักฐานและปิดงานแล้ว" };
  if (!["รอโอนเงิน", "อนุมัติแล้ว", "รอจ่าย", "รอหลักฐานการโอน"].includes(currentStatus)
      && String(rec.transferStatus || "") !== "ตั้งโอนแล้ว") {
    return { ok: false, reason: "not_ready_for_payment", message: "ใบเบิกนี้ยังไม่พร้อมบันทึกการจ่าย" };
  }
  if (!file || typeof file.arrayBuffer !== "function") return { ok: false, reason: "file_required", message: "กรุณาเลือกไฟล์หลักฐานการโอน" };
  if (Number(file.size || 0) > 12 * 1024 * 1024) return { ok: false, reason: "file_too_large", message: "ไฟล์ต้องไม่เกิน 12 MB" };
  const mediaType = String(file.type || "").toLowerCase();
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
  if (mediaType && !allowedTypes.has(mediaType)) return { ok: false, reason: "unsupported_file_type", message: "รองรับ JPG, PNG, WEBP และ PDF เท่านั้น" };

  const now = new Date().toISOString();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = String(file.name || "slip").split(".").pop().replace(/[^a-zA-Z0-9]/g, "") || "jpg";
  const name = `PAYMENT-${rec.docId || rec.runNo || rec.id}-${Date.now()}.${ext}`;
  const slipUrl = await uploadFile(env, bytes, mediaType || "image/jpeg", name, token, { publicRead: true });
  if (!slipUrl) return { ok: false, reason: "upload_failed", message: "อัปโหลดหลักฐานไป Google Drive ไม่สำเร็จ" };

  const paidPatch = {
    status: "จ่ายแล้ว", approvedAt: rec.approvedAt || now, paidAt: now,
    transferStatus: "ตั้งโอนแล้ว", transferAt: rec.transferAt || now,
    paymentSlipUrl: slipUrl, paymentSlipAt: now,
    ...channelSnapshot(paymentChannel),
    lineNotifyStatus: "กำลังแจ้ง", updatedAt: now,
    auditLog: auditJson(rec, "payment_slip_uploaded", {
      slipUrl, mediaType, paymentChannelId: paymentChannel.id, paymentChannel: channelDisplay(paymentChannel),
    }),
  };
  let out = await updateBatchRow(env, sheetId, batchId, paidPatch, token, rec);
  if (!out.ok) return out;
  await attachRepaymentProofToExpenses(env, sheetId, rec.itemIds, slipUrl, now, token);

  const notice = await notifyPaymentComplete(env, sheetId, rec, slipUrl, mediaType, token);
  const paidRecord = { ...rec, ...paidPatch };
  const notifyUpdate = await updateBatchRow(env, sheetId, batchId, {
    lineNotifyStatus: notice.status, lineNotifyAt: notice.at, updatedAt: new Date().toISOString(),
    auditLog: auditJson({ ...paidRecord, auditEvents: [...(rec.auditEvents || []), { at: now, action: "payment_slip_uploaded", detail: { slipUrl, mediaType } }] }, "line_notified", { status: notice.status }),
  }, token, paidRecord);
  return {
    ok: true, batchId, status: "จ่ายแล้ว", paymentSlipUrl: slipUrl, lineNotifyStatus: notice.status,
    paymentChannel,
    record: notifyUpdate.ok ? notifyUpdate.record : out.record,
    warning: notifyUpdate.ok ? "" : "บันทึกสถานะแจ้ง LINE ไม่สำเร็จ แต่ใบเบิกถูกปิดและแนบหลักฐานแล้ว",
  };
}

function dueNow(settings = {}, now = bangkokParts()) {
  const enabled = String(settings.batch_enabled || "FALSE").toUpperCase() === "TRUE";
  const weekday = Number(settings.batch_weekday ?? 1);
  const hour = Number(settings.batch_hour ?? 11);
  const minute = Number(settings.batch_minute ?? 0);
  const current = now.hour * 60 + now.minute;
  const target = hour * 60 + minute;
  // Cron อาจช้ากว่าเวลาที่ตั้งไว้ได้ จึงให้รันครั้งแรกหลังเวลานัดในวันนั้น
  // แทนการบังคับว่าต้องตรงนาทีเป๊ะ ซึ่งทำให้หลุดรอบได้ง่าย
  return enabled && now.weekday === weekday && current >= target;
}

async function dashboardBatchUrl(env, tenant) {
  const base = String(env.DASHBOARD_URL || "").replace(/\/$/, "");
  const k = await env.KV.get(`dtoken:${tenant}`);
  return base && k ? `${base}/?tenant=${encodeURIComponent(tenant)}&k=${encodeURIComponent(k)}&page=batches` : "";
}

export async function runScheduledReimbursementBatches(env) {
  const now = bangkokParts();
  const list = await env.KV.list({ prefix: "tenant:" });
  const results = [];

  for (const item of list.keys) {
    const tenant = item.name.slice("tenant:".length);
    const sheetId = await env.KV.get(item.name);
    if (!sheetId) continue;
    const token = await getUserToken(env, tenant);
    if (!token) continue;

    let settings;
    try {
      settings = await readSettings(env, sheetId, token);
    } catch (e) {
      console.warn("batch settings", tenant, e.message);
      continue;
    }
    if (!dueNow(settings, now)) continue;

    // หนึ่งธุรกิจรันได้สูงสุด 1 ครั้งต่อวัน โดยใช้ Durable Object แทน KV write
    const scheduleSlot = now.isoDate;
    const claim = await claimScheduledRun(env, tenant, scheduleSlot);
    if (!claim.claimed) continue;

    try {
      const out = await createReimbursementBatches(env, tenant, sheetId, token, { type: "ปกติ", settings });
      if (!out.ok) {
        const details = (out.blocked || []).slice(0, 3).map((x) => `• ${x.payerName}: ${(x.missing || []).join(", ")}`).join("\n");
        await push(env, tenant, textMsg(`ยังสร้างใบเบิกอัตโนมัติไม่ได้ ⚠️\nข้อมูลบัญชีผู้เบิกไม่ครบ\n${details || out.message || "เปิดหน้า ทีมของฉัน เพื่อตรวจข้อมูล"}`)).catch(() => {});
        results.push({ tenant, ...out });
        continue;
      }
      results.push({ tenant, ...out });
      if (out.itemCount > 0) {
        const url = await dashboardBatchUrl(env, tenant);
        const line = [
          `สร้างใบเบิกอัตโนมัติแล้ว ✅`,
          `รหัสรอบจ่าย ${out.runNo}`,
          `${out.people} คน · ${out.itemCount} รายการ`,
          `รวม ฿${Number(out.total || 0).toLocaleString("th-TH", { minimumFractionDigits: 2 })}`,
          out.blocked?.length ? `ยังไม่รวม ${out.blocked.length} คน เพราะข้อมูลบัญชีไม่ครบ` : "",
          url ? `\nตรวจและอนุมัติใบเบิก:\n${url}` : "",
        ].filter(Boolean).join("\n");
        await push(env, tenant, textMsg(line)).catch((e) => console.warn("batch notify", tenant, e.message));
      }
    } catch (e) {
      await releaseScheduledRun(env, tenant, scheduleSlot);
      console.error("scheduled batch", tenant, e);
      await push(env, tenant, textMsg(`สร้างใบเบิกอัตโนมัติไม่สำเร็จ ❌\n${String(e.message || e).slice(0, 180)}\nเปิด Dashboard แล้วสร้างใบเบิกด้วยตนเอง`)).catch(() => {});
      results.push({ tenant, ok: false, error: String(e) });
    }
  }
  return results;
}
