// ระบบรวมหลายรายการเป็น "รอบเบิก" ต่อผู้เบิก
// - รอบปกติ: ปิดอัตโนมัติตามเวลาที่ตั้งไว้ (ค่าเริ่มต้น จันทร์ 11:00 Asia/Bangkok)
// - รอบด่วน: สร้างทันทีจากรายการที่เลือก
// - สูงสุดค่าเริ่มต้น 10 รายการต่อ PDF ถ้าเกินจะแบ่ง P1, P2, ...

import { getAccessToken } from "./google-auth.js";
import { getUserToken } from "./oauth.js";
import {
  readExpenses, getExpenseById, updateExpenseById, readSettings,
  STATUS_DELETED,
} from "./sheets.js";
import { createBatchClaimPdf } from "./batch-documents.js";
import { uploadFile } from "./drive.js";
import { push, textMsg } from "./line.js";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
export const TAB_BATCHES = "รอบเบิก";
export const BATCH_VERSION = "REIMBURSEMENT_PAYMENT_WORKFLOW_V4_20260803";

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
  { col: "S", key: "peakStatus", header: "สถานะ PEAK" },
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
];

const LAST_COL = BATCH_SCHEMA[BATCH_SCHEMA.length - 1].col;
const BATCH_HEADER = BATCH_SCHEMA.map((x) => x.header);
const COL = Object.fromEntries(BATCH_SCHEMA.map((x) => [x.key, x.col]));

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
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${text.slice(0, 320)}`);
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
  if (String(rec.batchDocId || "").trim()) return false;
  if (["รวมรอบแล้ว", "อนุมัติแล้ว", "จ่ายแล้ว", "ยกเลิก"].includes(String(rec.batchStatus || "").trim())) return false;
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
  const meta = await call(t, `${SHEETS}/${sheetId}?fields=sheets.properties`);
  const exists = (meta.sheets || []).some((s) => s.properties?.title === TAB_BATCHES);
  if (!exists) {
    await call(t, `${SHEETS}/${sheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{
          addSheet: {
            properties: {
              title: TAB_BATCHES,
              gridProperties: { frozenRowCount: 1 },
            },
          },
        }],
      }),
    });
  }
  await call(t, rangeUrl(sheetId, TAB_BATCHES, `A1:${LAST_COL}1`, "?valueInputOption=USER_ENTERED"), {
    method: "PUT",
    body: JSON.stringify({ values: [BATCH_HEADER] }),
  });
  return { created: !exists, tab: TAB_BATCHES };
}

export async function listBatches(env, sheetId, token = null) {
  const t = await authToken(env, token);
  await ensureBatchTab(env, sheetId, t);
  const data = await call(t, rangeUrl(sheetId, TAB_BATCHES, `A2:${LAST_COL}`));
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
    status: batch.status || "รออนุมัติ",
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
    transferStatus: batch.transferStatus || "ยังไม่ตั้งโอน",
    transferRef: batch.transferRef || "",
    transferAt: batch.transferAt || "",
    paymentSlipUrl: batch.paymentSlipUrl || "",
    paymentSlipAt: batch.paymentSlipAt || "",
    lineNotifyStatus: batch.lineNotifyStatus || "ยังไม่แจ้ง",
    lineNotifyAt: batch.lineNotifyAt || "",
    rejectionReason: batch.rejectionReason || "",
    auditLog: batch.auditLog || JSON.stringify([{ at: new Date().toISOString(), action: "created", detail: batch.note || "สร้างรอบเบิก" }]),
    updatedAt: batch.updatedAt || new Date().toISOString(),
  };
  const values = BATCH_SCHEMA.map((s) => full[s.key] ?? "");
  const out = await call(t, rangeUrl(sheetId, TAB_BATCHES, `A:${LAST_COL}`, ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"), {
    method: "POST",
    body: JSON.stringify({ values: [values] }),
  });
  const m = String(out.updates?.updatedRange || "").match(/!([A-Z]+)(\d+)/);
  return { ...full, _row: m ? Number(m[2]) : null };
}

async function updateBatchRow(env, sheetId, batchId, patch, token = null) {
  const t = await authToken(env, token);
  const rows = await listBatches(env, sheetId, t);
  const rec = rows.find((x) => x.id === batchId || x.docId === batchId);
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
  for (const id of itemIds || []) {
    await updateExpenseById(env, sheetId, id, patch, token).catch((e) => {
      console.warn("batch expense patch", id, e.message);
    });
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
  const maxItems = Math.max(1, Math.min(10, Number(options.maxItems || settings.batch_max_items || 10)));
  const all = await readExpenses(env, sheetId, token);
  const selected = new Set((options.expenseIds || []).map(String));
  const requestedPayer = String(options.payerKey || "").trim();

  let eligible = all.filter(isEligible);
  if (selected.size) eligible = eligible.filter((r) => selected.has(String(r.id)));
  if (requestedPayer) eligible = eligible.filter((r) => payerKey(r) === requestedPayer);
  if (type === "ด่วน" && !selected.size) eligible = eligible.filter((r) => r.batchType === "ด่วน" || r.batchStatus === "ขอเบิกด่วน");

  if (!eligible.length) return { ok: true, runNo: "", batches: [], itemCount: 0, total: 0, message: "ไม่มีรายการรอเข้ารอบ" };

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
        id: id8(), runNo, docId, type, status: "รออนุมัติ",
        payerId: group.key, payerName: group.name,
        itemCount: items.length, total,
        periodStart: period.start, periodEnd: period.end,
        itemIds: items.map((r) => r.id),
        part: `${p + 1}/${chunks.length}`,
        note: options.note || (type === "ด่วน" ? "ผู้เบิกขอรับเงินด่วน" : "ปิดรอบอัตโนมัติ"),
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

      const patched = [];
      try {
        for (const item of items) {
          await updateExpenseById(env, sheetId, item.id, {
            payerId: item.payerId || group.key,
            batchType: type,
            batchStatus: "รวมรอบแล้ว",
            batchNo: runNo,
            batchDocId: docId,
            batchClaimPdfUrl: pdf.pdfUrl,
            batchPart: `${p + 1}/${chunks.length}`,
            batchCreatedAt: saved.createdAt,
          }, token);
          patched.push(item);
        }
      } catch (e) {
        // ป้องกันครึ่งรอบ: คืนรายการที่ patch ไปแล้วกลับเข้าคิว และทำเครื่องหมาย summary ว่ายกเลิก
        for (const item of patched) {
          await updateExpenseById(env, sheetId, item.id, {
            batchType: "ปกติ", batchStatus: "รอเข้ารอบ", batchNo: "",
            batchDocId: "", batchClaimPdfUrl: "", batchPart: "", batchCreatedAt: "",
          }, token).catch(() => {});
        }
        await updateBatchRow(env, sheetId, saved.id, {
          status: "ยกเลิก", note: `สร้างรอบไม่สมบูรณ์: ${String(e.message || e).slice(0, 140)}`,
        }, token).catch(() => {});
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
      message: "ยังสร้างรอบไม่ได้ เพราะข้อมูลบัญชีผู้เบิกไม่ครบ",
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
  if (existing && existing.expiresAt > now) throw new Error("มีการปิดรอบของธุรกิจนี้กำลังทำงานอยู่ กรุณารอสักครู่");
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

  const records = [];
  for (const id of ids) {
    const rec = await getExpenseById(env, sheetId, id, token);
    if (!rec || !isEligible(rec)) continue;
    records.push(rec);
    await updateExpenseById(env, sheetId, id, {
      batchType: "ด่วน",
      batchStatus: "ขอเบิกด่วน",
      urgentRequestedAt: new Date().toISOString(),
    }, token);
  }
  if (!records.length) return { ok: false, reason: "no_eligible_items" };

  try {
    return await createReimbursementBatches(env, tenant, sheetId, token, {
      type: "ด่วน",
      expenseIds: records.map((r) => r.id),
      note: "สร้างรอบด่วนจากคำขอผู้เบิก",
    });
  } catch (error) {
    for (const r of records) {
      await updateExpenseById(env, sheetId, r.id, {
        batchType: "ปกติ",
        batchStatus: "รอเข้ารอบ",
        urgentRequestedAt: "",
      }, token).catch(() => {});
    }
    throw error;
  }
}

export async function getBatchDashboard(env, sheetId, token = null) {
  const [expenses, batches, settings] = await Promise.all([
    readExpenses(env, sheetId, token),
    listBatches(env, sheetId, token),
    readSettings(env, sheetId, token),
  ]);
  const pending = expenses.filter(isEligible);
  const groups = groupItems(pending).map((g) => {
    const profile = payerProfile(settings, g.key, g.name);
    const missing = missingProfileFields(profile);
    return {
      payerKey: g.key,
      payerName: g.name,
      itemCount: g.items.length,
      total: g.items.reduce((sum, r) => sum + (Number(r.amount) || 0), 0),
      urgentCount: g.items.filter((r) => r.batchType === "ด่วน" || r.batchStatus === "ขอเบิกด่วน").length,
      oldestCreatedAt: g.items.map((r) => r.createdAt).filter(Boolean).sort()[0] || "",
      profileComplete: missing.length === 0,
      missingProfileFields: missing,
      bank: profile.bank || "",
      accountMasked: maskAccount(profile.accountNo),
      items: g.items.map((r) => ({
        id: r.id, dateISO: r.dateISO, createdAt: r.createdAt, vendor: r.vendor,
        note: r.note, amount: r.amount, category: r.category,
        batchType: r.batchType || "ปกติ", batchStatus: r.batchStatus || "รอเข้ารอบ",
        imageUrl: r.imageUrl, claimPdfUrl: r.claimPdfUrl, receiptPdfUrl: r.receiptPdfUrl,
      })),
    };
  });
  const summarizeRows = (rows) => ({
    count: rows.length,
    itemCount: rows.reduce((sum, b) => sum + (Number(b.itemCount) || 0), 0),
    total: rows.reduce((sum, b) => sum + (Number(b.total) || 0), 0),
  });
  const active = batches.filter((b) => !["จ่ายแล้ว", "ยกเลิก", "ตีกลับ"].includes(b.status));
  const enriched = batches.map((b) => {
    const profile = payerProfile(settings, b.payerId, b.payerName);
    const missing = missingProfileFields(profile);
    return {
      ...b,
      bank: profile.bank || "",
      accountNo: profile.accountNo || "",
      accountName: profile.accountName || "",
      accountMasked: maskAccount(profile.accountNo),
      profileComplete: missing.length === 0,
      missingProfileFields: missing,
      workflowStep: b.status === "จ่ายแล้ว" ? "paid"
        : b.status === "รออนุมัติ" ? "approval"
        : b.peakStatus !== "บันทึกแล้ว" ? "peak"
        : b.transferStatus !== "ตั้งโอนแล้ว" ? "transfer"
        : !b.paymentSlipUrl ? "slip"
        : "paid",
    };
  });
  return {
    ok: true,
    version: BATCH_VERSION,
    settings: {
      enabled: String(settings.batch_enabled || "FALSE").toUpperCase() === "TRUE",
      weekday: Number(settings.batch_weekday ?? 1),
      hour: Number(settings.batch_hour ?? 11),
      minute: Number(settings.batch_minute ?? 0),
      maxItems: Number(settings.batch_max_items || 10),
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
      awaitingApproval: summarizeRows(batches.filter((b) => b.status === "รออนุมัติ")),
      peakPending: summarizeRows(batches.filter((b) => b.status === "อนุมัติแล้ว" && b.peakStatus !== "บันทึกแล้ว")),
      transferPending: summarizeRows(batches.filter((b) => b.peakStatus === "บันทึกแล้ว" && b.transferStatus !== "ตั้งโอนแล้ว" && b.status !== "จ่ายแล้ว")),
      slipPending: summarizeRows(batches.filter((b) => b.transferStatus === "ตั้งโอนแล้ว" && !b.paymentSlipUrl && b.status !== "จ่ายแล้ว")),
      paid: summarizeRows(batches.filter((b) => b.status === "จ่ายแล้ว")),
      rejected: summarizeRows(batches.filter((b) => ["ยกเลิก", "ตีกลับ"].includes(b.status))),
    },
  };
}

export async function updateReimbursementBatchStatus(env, sheetId, batchId, status, token = null) {
  const allowed = new Set(["รออนุมัติ", "อนุมัติแล้ว", "ยกเลิก", "ตีกลับ"]);
  if (!allowed.has(status)) {
    if (status === "จ่ายแล้ว") return { ok: false, reason: "payment_slip_required", message: "ต้องแนบสลิปการจ่ายคืนก่อน ระบบจึงจะเปลี่ยนเป็นจ่ายแล้ว" };
    return { ok: false, reason: "bad_status" };
  }
  const rec = await findBatch(env, sheetId, batchId, token);
  if (!rec) return { ok: false, reason: "not_found" };
  const now = new Date().toISOString();
  const patch = { status, updatedAt: now, auditLog: auditJson(rec, status === "อนุมัติแล้ว" ? "approved" : "status_changed", { status }) };
  if (status === "อนุมัติแล้ว") patch.approvedAt = now;
  const out = await updateBatchRow(env, sheetId, batchId, patch, token);
  if (!out.ok) return out;

  if (status === "อนุมัติแล้ว") {
    await patchBatchExpenses(env, sheetId, rec.itemIds, { paid: false, batchStatus: "อนุมัติแล้ว" }, token);
  } else if (status === "รออนุมัติ") {
    await patchBatchExpenses(env, sheetId, rec.itemIds, { paid: false, batchStatus: "รวมรอบแล้ว" }, token);
  } else if (["ยกเลิก", "ตีกลับ"].includes(status)) {
    await patchBatchExpenses(env, sheetId, rec.itemIds, {
      paid: false, batchType: "ปกติ", batchStatus: "รอเข้ารอบ", batchNo: "",
      batchDocId: "", batchClaimPdfUrl: "", batchPart: "", batchCreatedAt: "",
    }, token);
  }
  return out;
}

export async function updateReimbursementBatchWorkflow(env, sheetId, batchId, action, payload = {}, token = null) {
  const rec = await findBatch(env, sheetId, batchId, token);
  if (!rec) return { ok: false, reason: "not_found", message: "ไม่พบรอบเบิก" };
  const now = new Date().toISOString();

  if (action === "approve") return updateReimbursementBatchStatus(env, sheetId, batchId, "อนุมัติแล้ว", token);

  if (action === "peak_recorded") {
    if (rec.status !== "อนุมัติแล้ว") return { ok: false, reason: "approve_first", message: "ต้องอนุมัติรอบก่อนบันทึกเข้า PEAK" };
    const patch = {
      peakStatus: "บันทึกแล้ว", peakRef: String(payload.reference || "").trim(), peakAt: now,
      updatedAt: now, auditLog: auditJson(rec, "peak_recorded", { reference: String(payload.reference || "").trim() }),
    };
    const out = await updateBatchRow(env, sheetId, batchId, patch, token);
    if (out.ok) await patchBatchExpenses(env, sheetId, rec.itemIds, { batchStatus: "บันทึก PEAK แล้ว" }, token);
    return out;
  }

  if (action === "transfer_set") {
    if (rec.peakStatus !== "บันทึกแล้ว") return { ok: false, reason: "peak_first", message: "ต้องบันทึกบัญชีใน PEAK ก่อนตั้งโอน" };
    const patch = {
      transferStatus: "ตั้งโอนแล้ว", transferRef: String(payload.reference || "").trim(), transferAt: now,
      updatedAt: now, auditLog: auditJson(rec, "transfer_set", { reference: String(payload.reference || "").trim() }),
    };
    const out = await updateBatchRow(env, sheetId, batchId, patch, token);
    if (out.ok) await patchBatchExpenses(env, sheetId, rec.itemIds, { batchStatus: "ตั้งโอนแล้ว" }, token);
    return out;
  }

  if (action === "reject") {
    const reason = String(payload.reason || "").trim();
    if (!reason) return { ok: false, reason: "reason_required", message: "กรุณาระบุเหตุผลที่ตีกลับ" };
    const patch = {
      status: "ตีกลับ", rejectionReason: reason, updatedAt: now,
      auditLog: auditJson(rec, "rejected", { reason }),
    };
    const out = await updateBatchRow(env, sheetId, batchId, patch, token);
    if (out.ok) {
      await patchBatchExpenses(env, sheetId, rec.itemIds, {
        paid: false, batchType: "ปกติ", batchStatus: "รอเข้ารอบ", batchNo: "",
        batchDocId: "", batchClaimPdfUrl: "", batchPart: "", batchCreatedAt: "",
      }, token);
    }
    return out;
  }

  return { ok: false, reason: "bad_action", message: "ไม่รู้จักคำสั่ง Workflow" };
}

export async function uploadReimbursementPaymentSlip(env, sheetId, batchId, file, token = null) {
  const rec = await findBatch(env, sheetId, batchId, token);
  if (!rec) return { ok: false, reason: "not_found", message: "ไม่พบรอบเบิก" };
  if (rec.status !== "อนุมัติแล้ว") return { ok: false, reason: "approve_first", message: "ต้องอนุมัติรอบก่อน" };
  if (rec.peakStatus !== "บันทึกแล้ว") return { ok: false, reason: "peak_first", message: "ต้องบันทึกบัญชีใน PEAK ก่อน" };
  if (rec.transferStatus !== "ตั้งโอนแล้ว") return { ok: false, reason: "transfer_first", message: "ต้องตั้งโอนก่อนแนบสลิป" };
  if (!file || typeof file.arrayBuffer !== "function") return { ok: false, reason: "file_required", message: "กรุณาเลือกไฟล์สลิป" };
  if (Number(file.size || 0) > 12 * 1024 * 1024) return { ok: false, reason: "file_too_large", message: "ไฟล์ต้องไม่เกิน 12 MB" };

  const now = new Date().toISOString();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = String(file.name || "slip").split(".").pop().replace(/[^a-zA-Z0-9]/g, "") || "jpg";
  const name = `PAYMENT-${rec.docId || rec.runNo || rec.id}-${Date.now()}.${ext}`;
  const slipUrl = await uploadFile(env, bytes, file.type || "image/jpeg", name, token, { publicRead: true });
  if (!slipUrl) return { ok: false, reason: "upload_failed", message: "อัปโหลดสลิปไป Google Drive ไม่สำเร็จ" };

  let out = await updateBatchRow(env, sheetId, batchId, {
    status: "จ่ายแล้ว", paidAt: now, paymentSlipUrl: slipUrl, paymentSlipAt: now,
    lineNotifyStatus: "กำลังแจ้ง", updatedAt: now,
    auditLog: auditJson(rec, "payment_slip_uploaded", { slipUrl }),
  }, token);
  if (!out.ok) return out;
  await patchBatchExpenses(env, sheetId, rec.itemIds, { paid: true, batchStatus: "จ่ายแล้ว" }, token);

  let notifyStatus = "ไม่มี LINE User ID";
  let notifyAt = "";
  if (String(rec.payerId || "").startsWith("U")) {
    const lines = [
      "บริษัทโอนเงินคืนแล้ว ✅",
      `รอบ ${rec.runNo || rec.docId}`,
      `${rec.itemCount} รายการ · รวม ฿${Number(rec.total || 0).toLocaleString("th-TH", { minimumFractionDigits: 2 })}`,
      `สลิปการโอน: ${slipUrl}`,
    ].join("\n");
    try {
      await push(env, rec.payerId, textMsg(lines));
      notifyStatus = "ส่งแล้ว";
      notifyAt = new Date().toISOString();
    } catch (e) {
      notifyStatus = `ส่งไม่สำเร็จ: ${String(e.message || e).slice(0, 120)}`;
    }
  }
  out = await updateBatchRow(env, sheetId, batchId, {
    lineNotifyStatus: notifyStatus, lineNotifyAt: notifyAt, updatedAt: new Date().toISOString(),
    auditLog: auditJson({ ...rec, auditEvents: [...(rec.auditEvents || []), { at: now, action: "payment_slip_uploaded", detail: { slipUrl } }] }, "line_notified", { status: notifyStatus }),
  }, token);
  return { ok: true, batchId, status: "จ่ายแล้ว", paymentSlipUrl: slipUrl, lineNotifyStatus: notifyStatus, record: out.record };
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
        await push(env, tenant, textMsg(`ยังปิดรอบเบิกอัตโนมัติไม่ได้ ⚠️\nข้อมูลบัญชีผู้เบิกไม่ครบ\n${details || out.message || "เปิดหน้า ทีมของฉัน เพื่อตรวจข้อมูล"}`)).catch(() => {});
        results.push({ tenant, ...out });
        continue;
      }
      results.push({ tenant, ...out });
      if (out.itemCount > 0) {
        const url = await dashboardBatchUrl(env, tenant);
        const line = [
          `ปิดรอบเบิกอัตโนมัติแล้ว ✅`,
          `รอบ ${out.runNo}`,
          `${out.people} คน · ${out.itemCount} รายการ`,
          `รวม ฿${Number(out.total || 0).toLocaleString("th-TH", { minimumFractionDigits: 2 })}`,
          out.blocked?.length ? `ยังไม่รวม ${out.blocked.length} คน เพราะข้อมูลบัญชีไม่ครบ` : "",
          url ? `\nตรวจและอนุมัติรอบเบิก:\n${url}` : "",
        ].filter(Boolean).join("\n");
        await push(env, tenant, textMsg(line)).catch((e) => console.warn("batch notify", tenant, e.message));
      }
    } catch (e) {
      await releaseScheduledRun(env, tenant, scheduleSlot);
      console.error("scheduled batch", tenant, e);
      await push(env, tenant, textMsg(`ปิดรอบเบิกไม่สำเร็จ ❌\n${String(e.message || e).slice(0, 180)}\nเปิด Dashboard แล้วกดปิดรอบด้วยตนเอง`)).catch(() => {});
      results.push({ tenant, ok: false, error: String(e) });
    }
  }
  return results;
}
