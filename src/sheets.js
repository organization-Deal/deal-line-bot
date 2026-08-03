// src/sheets.js — v3.1 duplicate detection
// อ่าน/เขียน Google Sheet — รับ token ได้ (token ลูกค้าจาก OAuth) ถ้าไม่ส่งใช้ service account
//
// เปลี่ยนจาก v2.0:
//   • เพิ่มคอลัมน์ U–X: แนบใบเสร็จ / แนบใบกำกับภาษี / แนบสลิป / แนบหลักฐานอื่น
//     แต่ละช่องเก็บได้หลายลิงก์ คั่นด้วย , (เหมือนช่อง attachment ใน Lark)
//   • addAttachment / removeAttachment / allAttachments / usedFileIds
//   • fileIdFromUrl — ใช้เทียบว่ารูปใน Drive ผูกกับแถวไหนแล้วบ้าง
//
// ⚠️ signature ของ appendExpense / readExpenses เหมือนเดิม index.js ไม่ต้องแก้

import { getAccessToken } from "./google-auth.js";

const API = "https://sheets.googleapis.com/v4/spreadsheets";

export const TAB_SETTINGS = "_settings";

/* ══════════════════════════════════════════════════════════
   สคีมา — ลำดับนี้คือลำดับคอลัมน์จริง ห้ามสลับ ห้ามแทรกกลาง
   จะเพิ่มคอลัมน์ใหม่ ให้ต่อท้ายอย่างเดียว
   ══════════════════════════════════════════════════════════ */
export const SCHEMA = [
  { col: "A", key: "dateText",    header: "วันที่" },
  { col: "B", key: "amount",      header: "ยอด" },
  { col: "C", key: "vendor",      header: "ร้าน/ผู้รับ" },
  { col: "D", key: "category",    header: "หมวด" },
  { col: "E", key: "note",        header: "รายละเอียด" },
  { col: "F", key: "sender",      header: "ผู้ส่ง" },
  { col: "G", key: "imageUrl",    header: "ลิงก์รูป" },
  { col: "H", key: "status",      header: "สถานะ" },
  { col: "I", key: "createdAt",   header: "บันทึกเมื่อ" },
  { col: "J", key: "id",          header: "id" },
  { col: "K", key: "paid",        header: "จ่ายแล้ว" },
  { col: "L", key: "needSlip",    header: "ออกใบแทน" },
  { col: "M", key: "type",        header: "ประเภท" },
  { col: "N", key: "subCategory", header: "หมวดย่อย" },
  { col: "O", key: "docType",     header: "ประเภทเอกสาร" },
  { col: "P", key: "payerName",   header: "ผู้เบิกจ่าย" },
  { col: "Q", key: "vat",         header: "VAT" },
  { col: "R", key: "whtRate",     header: "หัก ณ ที่จ่าย %" },
  { col: "S", key: "slipNo",      header: "เลขที่ใบแทน" },
  { col: "T", key: "dateISO",     header: "วันที่_ISO" },
  { col: "U", key: "attReceipt",  header: "แนบใบเสร็จ" },
  { col: "V", key: "attTax",      header: "แนบใบกำกับภาษี" },
  { col: "W", key: "attSlip",     header: "แนบสลิป" },
  { col: "X", key: "attOther",    header: "แนบหลักฐานอื่น" },
  { col: "Y",  key: "transferor",     header: "ผู้โอน/จากบัญชี" },
  { col: "Z",  key: "claimPdfUrl",    header: "ลิงก์ใบเบิก PDF" },
  { col: "AA", key: "receiptPdfUrl",  header: "ลิงก์ใบแทน PDF" },
  { col: "AB", key: "imageHash",       header: "ลายนิ้วมือไฟล์" },
  { col: "AC", key: "duplicateStatus", header: "สถานะเบิกซ้ำ" },
  { col: "AD", key: "duplicateOf",     header: "อ้างอิงรายการซ้ำ" },
  { col: "AE", key: "payerId",             header: "รหัสผู้เบิก LINE" },
  { col: "AF", key: "batchType",           header: "ประเภทรอบเบิก" },
  { col: "AG", key: "batchStatus",         header: "สถานะรอบเบิก" },
  { col: "AH", key: "batchNo",             header: "เลขรอบเบิก" },
  { col: "AI", key: "batchDocId",          header: "เลขเอกสารรอบเบิก" },
  { col: "AJ", key: "batchClaimPdfUrl",    header: "ใบขอเบิกรวม PDF" },
  { col: "AK", key: "batchPart",           header: "ส่วนเอกสารรอบเบิก" },
  { col: "AL", key: "batchCreatedAt",      header: "สร้างรอบเบิกเมื่อ" },
  { col: "AM", key: "urgentRequestedAt",   header: "ขอเบิกด่วนเมื่อ" },
  { col: "AN", key: "reimbursementSlipUrl", header: "หลักฐานโอนคืน" },
  { col: "AO", key: "reimbursedAt",         header: "โอนคืนเมื่อ" },
];

const LAST_COL = SCHEMA[SCHEMA.length - 1].col;                 // "AM"
export const HEADER = SCHEMA.map((s) => s.header);              // oauth.js / provision.js ใช้ตัวนี้
const COL_OF = Object.fromEntries(SCHEMA.map((s) => [s.key, s.col]));

export const STATUS_PENDING = "รอเบิก";
export const STATUS_DELETED = "ลบแล้ว";

/** ประเภทหลักฐาน — ตรงกับ 4 ช่องแนบไฟล์ในระบบ Lark เดิม */
export const ATTACH_TYPES = [
  { key: "attReceipt", label: "ใบเสร็จ" },
  { key: "attTax",     label: "ใบกำกับภาษี" },
  { key: "attSlip",    label: "สลิปโอนเงิน" },
  { key: "attOther",   label: "หลักฐานอื่น" },
];

/* ══════════════════════════════ helper ══════════════════════════════ */

function tabName(env) {
  return env.SHEET_TAB || "รายจ่าย";
}

async function authToken(env, token) {
  return token || (await getAccessToken(env));
}

function rangeUrl(sheetId, tab, a1, suffix = "") {
  return `${API}/${sheetId}/values/${encodeURIComponent(`${tab}!${a1}`)}${suffix}`;
}

async function call(t, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${t}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

export function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

function toBool(v) {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "TRUE" || s === "ใช่" || s === "1" || s === "YES";
}

/** ดึง fileId ออกจากลิงก์ Drive ทุกรูปแบบ — ใช้เทียบรูปกำพร้า */
export function fileIdFromUrl(url) {
  if (!url) return "";
  const s = String(url);
  let m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/);        // .../file/d/<id>/view
  if (m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);          // ...?id=<id>
  if (m) return m[1];
  m = s.match(/^([a-zA-Z0-9_-]{20,})$/);               // id เปล่า ๆ
  return m ? m[1] : "";
}

/** แตกช่องแนบไฟล์ (คั่นด้วย ,) เป็น array */
function splitUrls(v) {
  if (Array.isArray(v)) return v.map((x) => String(x || "").trim()).filter(Boolean);
  return String(v || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function joinUrls(v) {
  return [...new Set(splitUrls(v))].join(", ");
}

/** ลิงก์หลักฐานทั้งหมดของแถวเดียว รวมคอลัมน์ G ด้วย */
export function allAttachments(rec) {
  const out = [];
  if (rec.imageUrl) out.push({ type: "imageUrl", label: "รูปบิล", url: rec.imageUrl });
  for (const t of ATTACH_TYPES) {
    for (const url of splitUrls(rec[t.key])) out.push({ type: t.key, label: t.label, url });
  }
  if (rec.claimPdfUrl) out.push({ type: "claimPdfUrl", label: "ใบเบิก PDF", url: rec.claimPdfUrl });
  if (rec.receiptPdfUrl) out.push({ type: "receiptPdfUrl", label: "ใบแทน PDF", url: rec.receiptPdfUrl });
  if (rec.batchClaimPdfUrl) out.push({ type: "batchClaimPdfUrl", label: "ใบขอเบิกรวม PDF", url: rec.batchClaimPdfUrl });
  if (rec.reimbursementSlipUrl) out.push({ type: "reimbursementSlipUrl", label: "หลักฐานโอนคืน", url: rec.reimbursementSlipUrl });
  return out;
}

/**
 * รับวันที่ทุกรูปแบบ (2569-07-24 / 24/07/2569 / 2026-07-24 / Date)
 * คืน { text: 'พ.ศ.', iso: 'ค.ศ.' }
 */
export function normalizeDate(input) {
  let dt = null;

  if (input instanceof Date && !isNaN(input)) {
    dt = input;
  } else if (input != null && String(input).trim() !== "") {
    const nums = String(input).match(/\d+/g);
    if (nums && nums.length >= 3) {
      let y, m, d;
      if (nums[0].length === 4) [y, m, d] = nums.map(Number);
      else [d, m, y] = nums.map(Number);
      if (y > 2400) y -= 543;                 // พ.ศ. → ค.ศ.
      if (y < 100) y += 2000;
      const cand = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
      if (!isNaN(cand)) dt = cand;
    }
  }
  if (!dt) dt = new Date();

  const p = (n) => String(n).padStart(2, "0");
  const y = dt.getUTCFullYear(), mo = p(dt.getUTCMonth() + 1), da = p(dt.getUTCDate());
  return { text: `${y + 543}-${mo}-${da}`, iso: `${y}-${mo}-${da}` };
}

/* ══════════════════════════ หัวตาราง ══════════════════════════ */

/** เติมคอลัมน์ที่ขาดให้ครบ — ของเดิมไม่แตะ เรียกซ้ำได้ */
export async function ensureHeaders(env, sheetId, token = null) {
  const t = await authToken(env, token);
  const tab = tabName(env);

  let current = [];
  try {
    const data = await call(t, rangeUrl(sheetId, tab, `A1:${LAST_COL}1`));
    current = (data.values && data.values[0]) || [];
  } catch (e) {
    console.warn("ensureHeaders read:", e.message);
  }

  if (current.length >= HEADER.length) return { changed: false };

  const merged = HEADER.map((h, i) => current[i] || h);
  await call(t, rangeUrl(sheetId, tab, `A1:${LAST_COL}1`, "?valueInputOption=USER_ENTERED"), {
    method: "PUT",
    body: JSON.stringify({ values: [merged] }),
  });

  console.log(`ensureHeaders: ${current.length} → ${HEADER.length} คอลัมน์`);
  return { changed: true, added: HEADER.length - current.length };
}

/** เติม id + วันที่_ISO ให้แถวเก่าที่ยังไม่มี — รันครั้งเดียวพอ เรียกซ้ำไม่พัง */
export async function backfillIds(env, sheetId, token = null) {
  const t = await authToken(env, token);
  const tab = tabName(env);

  const data = await call(t, rangeUrl(sheetId, tab, `A2:${LAST_COL}`));
  const rows = data.values || [];
  const idIdx = SCHEMA.findIndex((s) => s.key === "id");
  const isoIdx = SCHEMA.findIndex((s) => s.key === "dateISO");

  const updates = [];
  rows.forEach((v, i) => {
    const rowNo = i + 2;
    if (!v || !v.length) return;

    if (!v[idIdx]) updates.push({ range: `${tab}!${COL_OF.id}${rowNo}`, values: [[newId()]] });
    if (!v[isoIdx] && v[0]) {
      updates.push({ range: `${tab}!${COL_OF.dateISO}${rowNo}`, values: [[normalizeDate(v[0]).iso]] });
    }
  });

  if (!updates.length) return { filled: 0 };

  await call(t, `${API}/${sheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: updates }),
  });
  return { filled: updates.length };
}

/* ══════════════════════════ เขียน ══════════════════════════ */

export async function appendExpense(env, sheetId, r, meta = {}, token = null) {
  const t = await authToken(env, token);
  const tab = tabName(env);
  const d = normalizeDate(r.date);

  // รูปที่ส่งมาพร้อมบิล → ลงช่องตามประเภทเอกสารที่ OCR อ่านได้
  // multi-document flow ส่งไฟล์หลายใบผ่าน r.attReceipt/r.attTax/r.attSlip/r.attOther ได้โดยตรง
  const link = meta.driveLink || r.imageUrl || "";
  const byDoc = {
    "ใบเสร็จรับเงิน": "attReceipt",
    "ใบกำกับภาษี":   "attTax",
    "สลิปโอนเงิน":   "attSlip",
  };
  const slot = link ? (byDoc[r.docType] || "attOther") : null;

  const full = {
    dateText:    d.text,
    dateISO:     d.iso,
    amount:      Number(r.amount) || 0,
    vendor:      r.vendor || "",
    transferor:  r.transferor || "",
    category:    r.category || "",
    note:        r.note || "",
    sender:      meta.sender || "",
    imageUrl:    link,
    status:      STATUS_PENDING,
    createdAt:   new Date().toISOString(),
    id:          meta.id || newId(),
    paid:        r.paid ? "TRUE" : "FALSE",
    needSlip:    r.needSlip ? "TRUE" : "FALSE",
    type:        r.type || "รายจ่าย",
    subCategory: r.subCategory || "",
    docType:     r.docType || "",
    payerName:   meta.payerName || meta.sender || "",
    vat:         r.vat ? "TRUE" : "",
    whtRate:     r.whtRate || "",
    slipNo:      "",
    attReceipt:  joinUrls(r.attReceipt),
    attTax:      joinUrls(r.attTax),
    attSlip:     joinUrls(r.attSlip),
    attOther:    joinUrls(r.attOther),
    claimPdfUrl: "",
    receiptPdfUrl: "",
    imageHash:       r.imageHash || "",
    duplicateStatus: r.duplicateStatus || "",
    duplicateOf:     r.duplicateOf || "",
    payerId:             meta.payerId || r.payerId || "",
    batchType:           r.batchType || "ปกติ",
    batchStatus:         r.batchStatus || "รอเข้ารอบ",
    batchNo:             r.batchNo || "",
    batchDocId:          r.batchDocId || "",
    batchClaimPdfUrl:    r.batchClaimPdfUrl || "",
    batchPart:           r.batchPart || "",
    batchCreatedAt:      r.batchCreatedAt || "",
    urgentRequestedAt:   r.urgentRequestedAt || "",
    reimbursementSlipUrl: r.reimbursementSlipUrl || "",
    reimbursedAt:         r.reimbursedAt || "",
  };
  if (slot && link) full[slot] = joinUrls([full[slot], link]);
  if (!full.imageUrl) {
    full.imageUrl = splitUrls(full.attReceipt)[0] || splitUrls(full.attTax)[0] ||
      splitUrls(full.attSlip)[0] || splitUrls(full.attOther)[0] || "";
  }

  const values = SCHEMA.map((s) => full[s.key] ?? "");
  const url = rangeUrl(sheetId, tab, `A:${LAST_COL}`,
    ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS");

  const out = await call(t, url, { method: "POST", body: JSON.stringify({ values: [values] }) });

  const m = (out.updates?.updatedRange || "").match(/!([A-Z]+)(\d+)/);
  return { id: full.id, row: m ? Number(m[2]) : null };
}

/* ══════════════════════════ อ่าน ══════════════════════════ */

function toObject(values, rowNumber) {
  const o = { _row: rowNumber };
  SCHEMA.forEach((s, i) => { o[s.key] = values[i] ?? ""; });

  o.amount   = Number(String(o.amount || "0").replace(/[^0-9.-]/g, "")) || 0;
  o.paid     = toBool(o.paid);
  o.needSlip = toBool(o.needSlip);
  o.vat      = toBool(o.vat);
  o.whtRate  = Number(o.whtRate) || 0;

  // alias ให้ของเดิมที่ dashboard ใช้อยู่ไม่พัง
  o.date = o.dateText;
  o.img  = o.imageUrl;

  o.attachments = allAttachments(o);
  return o;
}

export async function readExpenses(env, sheetId, token = null, opts = {}) {
  const t = await authToken(env, token);
  const tab = tabName(env);

  const data = await call(t, rangeUrl(sheetId, tab, `A2:${LAST_COL}`));
  const rows = data.values || [];
  const out = [];

  rows.forEach((v, i) => {
    if (!v || !v.length) return;
    const o = toObject(v, i + 2);
    if (!opts.includeDeleted && o.status === STATUS_DELETED) return;
    out.push(o);
  });

  return out.reverse();
}

/* ══════════════════════ ตรวจจับการเบิกซ้ำ ══════════════════════ */

function normalizeIdentity(v) {
  return String(v || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(?:บริษัท|บจก\.?|หจก\.?|จำกัด|นาย|นางสาว|นาง|mr\.?|mrs\.?|ms\.?|co\.?\s*,?\s*ltd\.?)/gi, "")
    .replace(/[^0-9a-z฀-๿]/g, "");
}

function normalizeText(v) {
  return String(v || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^0-9a-z฀-๿]/g, "");
}

function dateIsoOf(r) {
  if (r && /^\d{4}-\d{2}-\d{2}$/.test(String(r.dateISO || ""))) return String(r.dateISO);
  return normalizeDate(r?.dateText || r?.date || "").iso;
}

function dayDiff(a, b) {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 99999;
  return Math.abs(ta - tb) / 86400000;
}

/**
 * ตรวจรายการคล้ายกันจากข้อมูลในชีท
 * ระดับสูง:
 *   - ไฟล์รูปเดียวกัน (SHA-256 ตรงกัน)
 *   - วัน + ยอด + ผู้รับ ตรงกัน
 * ระดับควรตรวจ:
 *   - ยอด + วัน ตรงกัน และผู้โอน/รายละเอียดคล้ายกัน
 *   - ยอด + ผู้รับ ตรงกันภายใน 7 วัน
 */
export function findDuplicateExpensesInRecords(all = [], candidate = {}, opts = {}) {
  const excludeId = String(opts.excludeId || candidate.id || "").trim();
  const amount = Number(candidate.amount) || 0;
  const iso = dateIsoOf(candidate);
  const vendor = normalizeIdentity(candidate.vendor);
  const transferor = normalizeIdentity(candidate.transferor);
  const note = normalizeText(candidate.note);
  const imageHashes = new Set(splitUrls(candidate.imageHash));

  const matches = [];

  for (const rec of all) {
    if (!rec || (excludeId && String(rec.id) === excludeId)) continue;

    const recAmount = Number(rec.amount) || 0;
    const sameAmount = amount > 0 && Math.abs(amount - recAmount) < 0.01;
    const recIso = dateIsoOf(rec);
    const sameDate = iso === recIso;
    const days = dayDiff(iso, recIso);
    const sameVendor = !!vendor && vendor === normalizeIdentity(rec.vendor);
    const sameTransferor = !!transferor && transferor === normalizeIdentity(rec.transferor);
    const sameNote = !!note && note === normalizeText(rec.note);
    const recHashes = splitUrls(rec.imageHash);
    const sameImage = imageHashes.size > 0 && recHashes.some((h) => imageHashes.has(h));

    let score = 0;
    let reason = "";

    if (sameImage) {
      score = 100;
      reason = "ใช้รูปหลักฐานไฟล์เดียวกัน";
    } else if (sameAmount && sameDate && sameVendor) {
      score = 95;
      reason = "วันที่ ยอดเงิน และผู้รับตรงกัน";
    } else if (sameAmount && sameDate && (sameTransferor || sameNote)) {
      score = 88;
      reason = sameTransferor
        ? "วันที่ ยอดเงิน และผู้โอนตรงกัน"
        : "วันที่ ยอดเงิน และรายละเอียดตรงกัน";
    } else if (sameAmount && sameVendor && days <= 7) {
      score = 78;
      reason = `ยอดและผู้รับตรงกันภายใน ${Math.round(days)} วัน`;
    } else if (sameAmount && sameDate) {
      score = 72;
      reason = "วันที่และยอดเงินตรงกัน";
    }

    if (score < 72) continue;
    matches.push({
      id: rec.id,
      score,
      level: score >= 90 ? "high" : "medium",
      reason,
      date: rec.dateText || rec.date,
      dateISO: rec.dateISO || recIso,
      amount: rec.amount,
      vendor: rec.vendor || "",
      transferor: rec.transferor || "",
      imageUrl: rec.imageUrl || "",
      createdAt: rec.createdAt || "",
      paid: !!rec.paid,
    });
  }

  matches.sort((a, b) => b.score - a.score || String(b.createdAt).localeCompare(String(a.createdAt)));
  const top = matches.slice(0, 3);
  const high = top.some((m) => m.level === "high");

  return {
    hasDuplicate: top.length > 0,
    level: top.length ? (high ? "high" : "medium") : "none",
    matches: top,
  };
}


export async function findDuplicateExpenses(env, sheetId, candidate = {}, token = null, opts = {}) {
  const all = await readExpenses(env, sheetId, token);
  return findDuplicateExpensesInRecords(all, candidate, opts);
}

export async function findRowById(env, sheetId, id, token = null) {
  if (!id) return null;
  const t = await authToken(env, token);
  const tab = tabName(env);

  const data = await call(t, rangeUrl(sheetId, tab, `${COL_OF.id}2:${COL_OF.id}`));
  const ids = data.values || [];
  for (let i = 0; i < ids.length; i++) {
    if ((ids[i][0] || "").trim() === String(id).trim()) return i + 2;
  }
  return null;
}

export async function getExpenseById(env, sheetId, id, token = null) {
  const t = await authToken(env, token);
  const tab = tabName(env);
  const row = await findRowById(env, sheetId, id, t);
  if (!row) return null;

  const data = await call(t, rangeUrl(sheetId, tab, `A${row}:${LAST_COL}${row}`));
  return toObject((data.values && data.values[0]) || [], row);
}

/* ══════════════════════════ แก้ไข ══════════════════════════ */

export async function updateExpenseById(env, sheetId, id, patch, token = null) {
  const t = await authToken(env, token);
  const tab = tabName(env);
  const row = await findRowById(env, sheetId, id, t);
  if (!row) return { ok: false, reason: "not_found" };

  const boolKeys = ["paid", "needSlip", "vat"];
  const data = [];

  for (const [key, raw] of Object.entries(patch)) {
    if (key === "date") continue;
    const col = COL_OF[key];
    if (!col) continue;
    const value = boolKeys.includes(key) ? (raw ? "TRUE" : "FALSE") : raw;
    data.push({ range: `${tab}!${col}${row}`, values: [[value]] });
  }

  if (patch.date !== undefined) {
    const d = normalizeDate(patch.date);
    data.push({ range: `${tab}!${COL_OF.dateText}${row}`, values: [[d.text]] });
    data.push({ range: `${tab}!${COL_OF.dateISO}${row}`,  values: [[d.iso]] });
  }

  if (!data.length) return { ok: false, reason: "nothing_to_update" };

  await call(t, `${API}/${sheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });

  return { ok: true, row };
}

/* ══════════════════════ หลักฐานแนบ ══════════════════════ */

function isAttachKey(k) {
  return ATTACH_TYPES.some((t) => t.key === k);
}

/**
 * แนบรูปเข้ารายการ
 *   type = attReceipt | attTax | attSlip | attOther
 * ถ้าคอลัมน์ G (ลิงก์รูป) ยังว่าง จะเซ็ตให้ด้วย เพื่อให้ปุ่ม "ดูรูปบิล" บนการ์ดใช้ได้
 */
export async function addAttachment(env, sheetId, id, type, url, token = null) {
  if (!isAttachKey(type)) return { ok: false, reason: "bad_type" };
  if (!url) return { ok: false, reason: "no_url" };

  const rec = await getExpenseById(env, sheetId, id, token);
  if (!rec) return { ok: false, reason: "not_found" };

  const fid = fileIdFromUrl(url);
  const already = allAttachments(rec).some((a) => fileIdFromUrl(a.url) === fid);
  if (already) return { ok: true, skipped: "duplicate", record: rec };

  const urls = splitUrls(rec[type]);
  urls.push(url);

  const patch = { [type]: urls.join(", ") };
  if (!rec.imageUrl) patch.imageUrl = url;

  await updateExpenseById(env, sheetId, id, patch, token);
  const updated = await getExpenseById(env, sheetId, id, token);
  return { ok: true, record: updated || { ...rec, ...patch } };
}

/** ถอนรูปออกจากรายการ */
export async function removeAttachment(env, sheetId, id, url, token = null) {
  const rec = await getExpenseById(env, sheetId, id, token);
  if (!rec) return { ok: false, reason: "not_found" };

  const fid = fileIdFromUrl(url);
  const patch = {};

  for (const t of ATTACH_TYPES) {
    const before = splitUrls(rec[t.key]);
    const kept = before.filter((u) => fileIdFromUrl(u) !== fid);
    if (kept.length !== before.length) patch[t.key] = kept.join(", ");
  }
  if (fileIdFromUrl(rec.imageUrl) === fid) patch.imageUrl = "";

  if (!Object.keys(patch).length) return { ok: true, skipped: "not_attached", record: rec };

  await updateExpenseById(env, sheetId, id, patch, token);
  const updated = await getExpenseById(env, sheetId, id, token);
  return { ok: true, record: updated || rec };
}

/** เซ็ตของ fileId ทั้งหมดที่ผูกกับแถวใดแถวหนึ่งแล้ว — ใช้หารูปกำพร้า */
export async function usedFileIds(env, sheetId, token = null) {
  const all = await readExpenses(env, sheetId, token, { includeDeleted: true });
  const set = new Set();
  for (const r of all) {
    for (const a of allAttachments(r)) {
      const fid = fileIdFromUrl(a.url);
      if (fid) set.add(fid);
    }
  }
  return set;
}

/* ══════════════════════ ปุ่มบนการ์ด ══════════════════════ */

export async function togglePaid(env, sheetId, id, token = null) {
  const rec = await getExpenseById(env, sheetId, id, token);
  if (!rec) return { ok: false, reason: "not_found" };
  const next = !rec.paid;
  await updateExpenseById(env, sheetId, id, { paid: next }, token);
  return { ok: true, paid: next, record: { ...rec, paid: next } };
}

export async function toggleNeedSlip(env, sheetId, id, token = null) {
  const rec = await getExpenseById(env, sheetId, id, token);
  if (!rec) return { ok: false, reason: "not_found" };
  const next = !rec.needSlip;
  await updateExpenseById(env, sheetId, id, { needSlip: next }, token);
  return { ok: true, needSlip: next, record: { ...rec, needSlip: next } };
}

/** ลบแบบ soft — เลขแถวไม่ขยับ ลิงก์ในการ์ดเก่าเลยไม่ชี้ผิดแถว */
export async function softDeleteById(env, sheetId, id, token = null) {
  return updateExpenseById(env, sheetId, id, { status: STATUS_DELETED }, token);
}

/* ══════════════════════ สรุป / ใบแทน ══════════════════════ */

export async function getMonthStats(env, sheetId, { category, dateISO } = {}, token = null) {
  const all = await readExpenses(env, sheetId, token);
  const ref = (dateISO || new Date().toISOString()).slice(0, 7);

  let monthTotal = 0, categoryTotal = 0, unpaidTotal = 0;

  for (const r of all) {
    if (r.type === "รายรับ") continue;
    if ((r.dateISO || "").slice(0, 7) === ref) {
      monthTotal += r.amount;
      if (category && r.category === category) categoryTotal += r.amount;
    }
    if (!r.paid) unpaidTotal += r.amount;
  }

  return { monthTotal, categoryTotal: category ? categoryTotal : undefined, unpaidTotal };
}

export async function listForSlip(env, sheetId, token = null, { onlyUnissued = true } = {}) {
  const all = await readExpenses(env, sheetId, token);
  return all.filter((r) => r.needSlip && (!onlyUnissued || !r.slipNo));
}

/* ══════════════════════════ แท็บ _settings ══════════════════════════ */

const DEFAULT_SETTINGS = {
  company_name: "",
  company_address: "",
  tax_id: "",
  logo_url: "",
  approver_name: "",
  approver_sign_url: "",
  doc_prefix: "R",
};

export async function readSettings(env, sheetId, token = null) {
  try {
    const t = await authToken(env, token);
    const data = await call(t, rangeUrl(sheetId, TAB_SETTINGS, "A2:B"));
    const out = { ...DEFAULT_SETTINGS };
    for (const [k, v] of data.values || []) {
      if (k) out[String(k).trim()] = v ?? "";
    }
    return out;
  } catch (e) {
    console.warn("readSettings:", e.message);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function writeSettings(env, sheetId, settings, token = null) {
  const t = await authToken(env, token);
  await ensureSettingsTab(env, sheetId, t);

  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const values = Object.entries(merged).map(([k, v]) => [k, v ?? ""]);

  await call(t, rangeUrl(sheetId, TAB_SETTINGS, "A1:B100", "?valueInputOption=USER_ENTERED"), {
    method: "PUT",
    body: JSON.stringify({ values: [["key", "value"], ...values] }),
  });
  return merged;
}

export async function ensureSettingsTab(env, sheetId, token = null) {
  const t = await authToken(env, token);
  const meta = await call(t, `${API}/${sheetId}?fields=sheets.properties.title`);
  const exists = (meta.sheets || []).some((s) => s.properties?.title === TAB_SETTINGS);
  if (exists) return { created: false };

  await call(t, `${API}/${sheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TAB_SETTINGS } } }] }),
  });
  return { created: true };
}

/* ══════════════════════════ deep link ══════════════════════════ */

export function sheetRowUrl(sheetId, row, gid = 0) {
  if (!sheetId) return null;
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit` +
         (row ? `#gid=${gid}&range=A${row}` : `#gid=${gid}`);
}
