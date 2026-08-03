// กระทบยอดธนาคารสำหรับใบเบิกที่จ่ายแล้ว
// Statement 1 รายการ ↔ ใบเบิกหลัก 1 ใบ

import { getAccessToken } from "./google-auth.js";
import {
  ensureBatchTab,
  listBatches,
  updateBatchReconciliations,
} from "./batches.js";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
export const TAB_RECONCILIATION = "กระทบยอดธนาคาร";
export const RECONCILIATION_VERSION = "BANK_RECONCILIATION_V1_20260803";

const SCHEMA = [
  { col: "A", key: "importedAt", header: "นำเข้าเมื่อ" },
  { col: "B", key: "id", header: "reconciliation_id" },
  { col: "C", key: "transactionDate", header: "วันที่ธนาคาร" },
  { col: "D", key: "amount", header: "ยอดเงินออก" },
  { col: "E", key: "description", header: "รายละเอียดธนาคาร" },
  { col: "F", key: "reference", header: "เลขอ้างอิงธนาคาร" },
  { col: "G", key: "sourceAccount", header: "บัญชีบริษัท" },
  { col: "H", key: "sourceFile", header: "ไฟล์ Statement" },
  { col: "I", key: "fingerprint", header: "ลายนิ้วมือรายการ" },
  { col: "J", key: "status", header: "สถานะกระทบยอด" },
  { col: "K", key: "batchId", header: "batch_id" },
  { col: "L", key: "batchDocId", header: "เลขใบเบิก" },
  { col: "M", key: "matchScore", header: "คะแนนจับคู่" },
  { col: "N", key: "matchedAt", header: "กระทบยอดเมื่อ" },
  { col: "O", key: "matchedBy", header: "ผู้กระทบยอด" },
  { col: "P", key: "note", header: "หมายเหตุ" },
  { col: "Q", key: "rawJson", header: "ข้อมูลต้นฉบับ" },
  { col: "R", key: "updatedAt", header: "อัปเดตล่าสุด" },
];

const HEADER = SCHEMA.map((x) => x.header);
const LAST_COL = SCHEMA[SCHEMA.length - 1].col;
const COL = Object.fromEntries(SCHEMA.map((x) => [x.key, x.col]));

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

function id10() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

function toNum(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let raw = String(value ?? "").trim();
  if (!raw) return 0;
  const parenNegative = /^\(.*\)$/.test(raw);
  raw = raw.replace(/[(),฿\s]/g, "").replace(/[^0-9+\-.]/g, "");
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return parenNegative ? -Math.abs(n) : n;
}

function normalizeIsoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const nums = raw.match(/\d+/g);
  if (!nums || nums.length < 3) return "";
  let y, m, d;
  if (nums[0].length === 4) [y, m, d] = nums.map(Number);
  else [d, m, y] = nums.map(Number);
  if (y > 2400) y -= 543;
  if (y < 100) y += 2000;
  if (y < 2000 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
}

function dateDistanceDays(a, b) {
  if (!a || !b) return 9999;
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 9999;
  return Math.abs(Math.round((ta - tb) / 86400000));
}

function paidDate(batch = {}) {
  const direct = normalizeIsoDate(batch.paidAt || batch.paymentSlipAt || batch.updatedAt || "");
  return direct;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^0-9a-zก-๙]/gi, "")
    .trim();
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function rowToObject(values, rowNo) {
  const out = { _row: rowNo };
  SCHEMA.forEach((s, i) => { out[s.key] = values[i] ?? ""; });
  out.amount = Math.abs(toNum(out.amount));
  out.matchScore = toNum(out.matchScore);
  try { out.raw = JSON.parse(out.rawJson || "{}"); } catch { out.raw = {}; }
  return out;
}

export async function ensureReconciliationTab(env, sheetId, token = null) {
  const t = await authToken(env, token);
  const meta = await call(t, `${SHEETS}/${sheetId}?fields=sheets.properties`);
  const exists = (meta.sheets || []).some((s) => s.properties?.title === TAB_RECONCILIATION);
  if (!exists) {
    await call(t, `${SHEETS}/${sheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{
          addSheet: {
            properties: {
              title: TAB_RECONCILIATION,
              gridProperties: { frozenRowCount: 1 },
            },
          },
        }],
      }),
    });
  }
  await call(t, rangeUrl(sheetId, TAB_RECONCILIATION, `A1:${LAST_COL}1`, "?valueInputOption=USER_ENTERED"), {
    method: "PUT",
    body: JSON.stringify({ values: [HEADER] }),
  });
  await ensureBatchTab(env, sheetId, t);
  return { created: !exists, tab: TAB_RECONCILIATION };
}

export async function listReconciliationRows(env, sheetId, token = null, { createIfMissing = false } = {}) {
  const t = await authToken(env, token);
  let data;
  try {
    data = await call(t, rangeUrl(sheetId, TAB_RECONCILIATION, `A2:${LAST_COL}`));
  } catch (error) {
    if (!createIfMissing || (error?.status !== 400 && error?.status !== 404)) throw error;
    await ensureReconciliationTab(env, sheetId, t);
    data = await call(t, rangeUrl(sheetId, TAB_RECONCILIATION, `A2:${LAST_COL}`));
  }
  return (data.values || [])
    .map((row, index) => rowToObject(row, index + 2))
    .filter((row) => row.id)
    .reverse();
}

function isPaidBatch(batch = {}) {
  return String(batch.status || "") === "จ่ายแล้ว" || !!String(batch.paymentSlipUrl || "").trim();
}

function batchSearchText(batch = {}) {
  return normalizeText([
    batch.docId,
    batch.runNo,
    batch.payerName,
    batch.accountNo,
    batch.accountName,
    batch.bank,
  ].join(" "));
}

function suggestionFor(row, batches, linkedBatchIds = new Set()) {
  if (["กระทบยอดแล้ว", "ข้าม"].includes(String(row.status || ""))) return null;
  const bankText = normalizeText(`${row.description || ""} ${row.reference || ""}`);
  const candidates = [];

  for (const batch of batches) {
    const batchId = String(batch.id || "");
    if (!batchId || linkedBatchIds.has(batchId)) continue;
    const amountDiff = Math.abs(Number(batch.total || 0) - Number(row.amount || 0));
    if (amountDiff > 0.01) continue;

    const gapDays = dateDistanceDays(row.transactionDate, paidDate(batch));
    let score = 60;
    if (gapDays === 0) score += 30;
    else if (gapDays === 1) score += 24;
    else if (gapDays === 2) score += 16;
    else if (gapDays === 3) score += 8;
    else if (gapDays <= 7) score += 2;

    const docToken = normalizeText(batch.docId || batch.runNo || "");
    if (docToken && bankText.includes(docToken)) score += 20;

    const payerToken = normalizeText(batch.payerName || "");
    if (payerToken.length >= 5 && bankText.includes(payerToken.slice(0, Math.min(12, payerToken.length)))) score += 8;

    const accountDigits = String(batch.accountNo || "").replace(/\D/g, "");
    if (accountDigits.length >= 4 && bankText.includes(accountDigits.slice(-4))) score += 5;

    candidates.push({
      batchId,
      docId: batch.docId || batch.runNo || batch.id,
      payerName: batch.payerName || "",
      amount: Number(batch.total || 0),
      paidDate: paidDate(batch),
      paymentSlipUrl: batch.paymentSlipUrl || "",
      score,
      gapDays,
      amountDiff,
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.gapDays - b.gapDays || String(a.docId).localeCompare(String(b.docId)));
  const best = candidates[0] || null;
  const second = candidates[1] || null;
  const uniqueHighConfidence = !!best && best.score >= 84 && (!second || best.score - second.score >= 8);
  return {
    best,
    candidates: candidates.slice(0, 8),
    autoSuggested: uniqueHighConfidence,
  };
}

function decorateRows(rows, paidBatches) {
  const batchById = new Map(paidBatches.map((batch) => [String(batch.id || ""), batch]));
  const unavailableBatchIds = new Set([
    ...rows
      .filter((row) => String(row.status || "") === "กระทบยอดแล้ว" && row.batchId)
      .map((row) => String(row.batchId)),
    ...paidBatches
      .filter((batch) => String(batch.reconcileStatus || "") === "กระทบยอดแล้ว")
      .map((batch) => String(batch.id || "")),
  ].filter(Boolean));

  return rows.map((row) => {
    const linkedBatch = row.batchId ? batchById.get(String(row.batchId)) : null;
    const suggestion = suggestionFor(row, paidBatches, unavailableBatchIds);
    let displayStatus = String(row.status || "").trim();
    if (!displayStatus || displayStatus === "ยังไม่จับคู่") {
      if (suggestion?.autoSuggested) {
        displayStatus = "แนะนำอัตโนมัติ";
        // กันไม่ให้ Statement สองบรรทัดแนะนำใบเบิกเดียวกันในชุดเดียวกัน
        if (suggestion.best?.batchId) unavailableBatchIds.add(String(suggestion.best.batchId));
      } else if (suggestion?.best) displayStatus = "ต้องตรวจ";
      else displayStatus = "ไม่พบคู่";
    }
    return {
      ...row,
      displayStatus,
      linkedBatch: linkedBatch ? {
        id: linkedBatch.id,
        docId: linkedBatch.docId || linkedBatch.runNo || linkedBatch.id,
        payerName: linkedBatch.payerName || "",
        total: Number(linkedBatch.total || 0),
        paidAt: linkedBatch.paidAt || linkedBatch.paymentSlipAt || "",
        paymentSlipUrl: linkedBatch.paymentSlipUrl || "",
        pdfUrl: linkedBatch.pdfUrl || "",
      } : null,
      suggestion,
    };
  });
}

function summarize(rows, paidBatches) {
  const reconciled = rows.filter((row) => row.displayStatus === "กระทบยอดแล้ว");
  const suggested = rows.filter((row) => row.displayStatus === "แนะนำอัตโนมัติ");
  const review = rows.filter((row) => row.displayStatus === "ต้องตรวจ");
  const unmatched = rows.filter((row) => row.displayStatus === "ไม่พบคู่");
  const ignored = rows.filter((row) => row.displayStatus === "ข้าม");
  const reconciledBatchIds = new Set([
    ...reconciled.map((row) => String(row.batchId || "")),
    ...paidBatches.filter((batch) => String(batch.reconcileStatus || "") === "กระทบยอดแล้ว").map((batch) => String(batch.id || "")),
  ].filter(Boolean));
  const unreconciledPaidBatches = paidBatches.filter((batch) => !reconciledBatchIds.has(String(batch.id || "")));
  const total = (list) => list.reduce((sum, row) => sum + Number(row.amount || row.total || 0), 0);
  return {
    statementRows: rows.length,
    statementTotal: total(rows.filter((row) => row.displayStatus !== "ข้าม")),
    reconciled: { count: reconciled.length, total: total(reconciled) },
    suggested: { count: suggested.length, total: total(suggested) },
    review: { count: review.length, total: total(review) },
    unmatched: { count: unmatched.length, total: total(unmatched) },
    ignored: { count: ignored.length, total: total(ignored) },
    paidBatches: { count: paidBatches.length, total: total(paidBatches) },
    unreconciledPaidBatches: { count: unreconciledPaidBatches.length, total: total(unreconciledPaidBatches) },
  };
}

export async function getReconciliationDashboard(env, sheetId, token = null) {
  const t = await authToken(env, token);
  const [rows, batches] = await Promise.all([
    listReconciliationRows(env, sheetId, t, { createIfMissing: true }),
    listBatches(env, sheetId, t),
  ]);
  const paidBatches = batches.filter(isPaidBatch);
  const decorated = decorateRows(rows, paidBatches);
  return {
    ok: true,
    version: RECONCILIATION_VERSION,
    rows: decorated,
    paidBatches: paidBatches.map((batch) => ({
      id: batch.id,
      docId: batch.docId || batch.runNo || batch.id,
      payerName: batch.payerName || "",
      total: Number(batch.total || 0),
      paidAt: batch.paidAt || batch.paymentSlipAt || "",
      paymentSlipUrl: batch.paymentSlipUrl || "",
      pdfUrl: batch.pdfUrl || "",
      reconcileStatus: batch.reconcileStatus || "",
      reconciliationId: batch.reconciliationId || "",
    })),
    summary: summarize(decorated, paidBatches),
  };
}

function normalizedImportRow(input = {}) {
  const date = normalizeIsoDate(input.transactionDate || input.date || input.postedDate || "");
  const rawAmount = toNum(input.amount ?? input.debit ?? input.withdrawal ?? 0);
  const amount = Math.abs(rawAmount);
  const direction = String(input.direction || "เงินออก").trim();
  return {
    transactionDate: date,
    amount,
    direction,
    description: String(input.description || input.detail || input.memo || "").trim(),
    reference: String(input.reference || input.ref || "").trim(),
    sourceAccount: String(input.sourceAccount || "").trim(),
    raw: input.raw && typeof input.raw === "object" ? input.raw : input,
  };
}

export async function importReconciliationRows(env, sheetId, payload = {}, token = null) {
  const t = await authToken(env, token);
  await ensureReconciliationTab(env, sheetId, t);
  const existing = await listReconciliationRows(env, sheetId, t);
  const existingFingerprints = new Set(existing.map((row) => String(row.fingerprint || "")).filter(Boolean));
  const sourceFile = String(payload.fileName || "statement").trim().slice(0, 180);
  const defaultAccount = String(payload.sourceAccount || "").trim().slice(0, 120);
  const inputRows = Array.isArray(payload.rows) ? payload.rows.slice(0, 5000) : [];
  const now = new Date().toISOString();
  const appendValues = [];
  let skippedInvalid = 0;
  let skippedIncoming = 0;
  let skippedDuplicate = 0;

  for (const input of inputRows) {
    const row = normalizedImportRow(input);
    if (!row.transactionDate || !(row.amount > 0)) {
      skippedInvalid++;
      continue;
    }
    if (/เงินเข้า|credit|deposit|รับเงิน/i.test(row.direction)) {
      skippedIncoming++;
      continue;
    }
    row.sourceAccount = row.sourceAccount || defaultAccount;
    const identityParts = [
      row.transactionDate,
      row.amount.toFixed(2),
      normalizeText(row.description),
      normalizeText(row.reference),
      normalizeText(row.sourceAccount),
    ];
    // ถ้าธนาคารไม่มีเลขอ้างอิง ให้ใช้ชื่อไฟล์+เลขแถวช่วยแยก
    // เพื่อไม่ตัดรายการจริงสองรายการที่ยอด/วัน/รายละเอียดเหมือนกันทิ้ง
    if (!normalizeText(row.reference)) {
      identityParts.push(normalizeText(sourceFile), String(row.raw?.row || ""));
    }
    const fingerprint = await sha256Hex(identityParts.join("|"));
    if (existingFingerprints.has(fingerprint)) {
      skippedDuplicate++;
      continue;
    }
    existingFingerprints.add(fingerprint);
    const full = {
      importedAt: now,
      id: `RC_${id10()}`,
      transactionDate: row.transactionDate,
      amount: row.amount,
      description: row.description,
      reference: row.reference,
      sourceAccount: row.sourceAccount,
      sourceFile,
      fingerprint,
      status: "ยังไม่จับคู่",
      batchId: "",
      batchDocId: "",
      matchScore: "",
      matchedAt: "",
      matchedBy: "",
      note: "",
      rawJson: JSON.stringify(row.raw || {}),
      updatedAt: now,
    };
    appendValues.push(SCHEMA.map((column) => full[column.key] ?? ""));
  }

  if (appendValues.length) {
    await call(t, rangeUrl(sheetId, TAB_RECONCILIATION, `A:${LAST_COL}`, ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"), {
      method: "POST",
      body: JSON.stringify({ values: appendValues }),
    });
  }

  return {
    ok: true,
    imported: appendValues.length,
    skippedInvalid,
    skippedIncoming,
    skippedDuplicate,
    sourceFile,
  };
}

async function updateStatementRows(token, sheetId, changes) {
  const data = [];
  for (const change of changes) {
    const row = change.row;
    const patch = change.patch || {};
    for (const [key, value] of Object.entries(patch)) {
      if (!COL[key]) continue;
      data.push({ range: `${TAB_RECONCILIATION}!${COL[key]}${row._row}`, values: [[value ?? ""]] });
    }
  }
  if (!data.length) return { updated: 0 };
  await call(token, `${SHEETS}/${sheetId}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  return { updated: changes.length };
}

function validatePairs(rows, paidBatches, pairs, { force = false } = {}) {
  const rowById = new Map(rows.map((row) => [String(row.id || ""), row]));
  const batchById = new Map(paidBatches.map((batch) => [String(batch.id || ""), batch]));
  const usedStatements = new Set();
  const usedBatches = new Set();
  const existingLinked = new Map(rows
    .filter((row) => String(row.status || "") === "กระทบยอดแล้ว" && row.batchId)
    .map((row) => [String(row.batchId), String(row.id)]));
  const valid = [];
  const errors = [];

  for (const pair of pairs) {
    const reconciliationId = String(pair.reconciliationId || pair.id || "");
    const batchId = String(pair.batchId || "");
    const row = rowById.get(reconciliationId);
    const batch = batchById.get(batchId);
    if (!row || !batch) {
      errors.push({ reconciliationId, batchId, reason: "not_found" });
      continue;
    }
    if (usedStatements.has(reconciliationId) || usedBatches.has(batchId)) {
      errors.push({ reconciliationId, batchId, reason: "duplicate_pair" });
      continue;
    }
    if (String(row.status || "") === "กระทบยอดแล้ว") {
      errors.push({ reconciliationId, batchId, reason: "statement_already_reconciled" });
      continue;
    }
    const linkedTo = existingLinked.get(batchId);
    const batchLinkedTo = String(batch.reconciliationId || "");
    if ((linkedTo && linkedTo !== reconciliationId)
        || (String(batch.reconcileStatus || "") === "กระทบยอดแล้ว" && batchLinkedTo !== reconciliationId)) {
      errors.push({ reconciliationId, batchId, reason: "batch_already_reconciled" });
      continue;
    }
    const amountDiff = Math.abs(Number(row.amount || 0) - Number(batch.total || 0));
    if (!force && amountDiff > 0.01) {
      errors.push({ reconciliationId, batchId, reason: "amount_mismatch", amountDiff });
      continue;
    }
    usedStatements.add(reconciliationId);
    usedBatches.add(batchId);
    valid.push({ row, batch, note: String(pair.note || "").trim(), score: Number(pair.score || 100) });
  }
  return { valid, errors };
}

export async function confirmReconciliationMatches(env, sheetId, payload = {}, token = null) {
  const t = await authToken(env, token);
  const pairs = Array.isArray(payload.pairs) ? payload.pairs.slice(0, 500) : [payload];
  const [rows, batches] = await Promise.all([
    listReconciliationRows(env, sheetId, t, { createIfMissing: true }),
    listBatches(env, sheetId, t),
  ]);
  const paidBatches = batches.filter(isPaidBatch);
  const { valid, errors } = validatePairs(rows, paidBatches, pairs, { force: payload.force === true });
  if (!valid.length) return { ok: false, reason: "no_valid_matches", errors };

  const now = new Date().toISOString();
  const matchedBy = String(payload.matchedBy || "Dashboard").trim().slice(0, 120) || "Dashboard";
  const batchChanges = valid.map(({ row, batch, note }) => ({
    batchId: batch.id,
    reconciliationId: row.id,
    reconcileStatus: "กระทบยอดแล้ว",
    reconciledAt: now,
    reconciliationNote: note,
  }));

  await updateBatchReconciliations(env, sheetId, batchChanges, t, batches);
  try {
    await updateStatementRows(t, sheetId, valid.map(({ row, batch, note, score }) => ({
      row,
      patch: {
        status: "กระทบยอดแล้ว",
        batchId: batch.id,
        batchDocId: batch.docId || batch.runNo || batch.id,
        matchScore: score,
        matchedAt: now,
        matchedBy,
        note,
        updatedAt: now,
      },
    })));
  } catch (error) {
    await updateBatchReconciliations(env, sheetId, valid.map(({ batch }) => ({
      batchId: batch.id,
      reconciliationId: "",
      reconcileStatus: "",
      reconciledAt: "",
      reconciliationNote: "",
    })), t, batches).catch(() => {});
    throw error;
  }

  return { ok: true, confirmed: valid.length, errors };
}

export async function unlinkReconciliationMatch(env, sheetId, reconciliationId, token = null) {
  const t = await authToken(env, token);
  const [rows, batches] = await Promise.all([
    listReconciliationRows(env, sheetId, t, { createIfMissing: true }),
    listBatches(env, sheetId, t),
  ]);
  const row = rows.find((item) => String(item.id || "") === String(reconciliationId || ""));
  if (!row) return { ok: false, reason: "not_found", message: "ไม่พบรายการธนาคาร" };
  const now = new Date().toISOString();
  if (row.batchId) {
    await updateBatchReconciliations(env, sheetId, [{
      batchId: row.batchId,
      reconciliationId: "",
      reconcileStatus: "",
      reconciledAt: "",
      reconciliationNote: "",
    }], t, batches);
  }
  await updateStatementRows(t, sheetId, [{
    row,
    patch: {
      status: "ยังไม่จับคู่",
      batchId: "",
      batchDocId: "",
      matchScore: "",
      matchedAt: "",
      matchedBy: "",
      note: "",
      updatedAt: now,
    },
  }]);
  return { ok: true };
}

export async function ignoreReconciliationRow(env, sheetId, reconciliationId, note = "", token = null) {
  const t = await authToken(env, token);
  const rows = await listReconciliationRows(env, sheetId, t, { createIfMissing: true });
  const row = rows.find((item) => String(item.id || "") === String(reconciliationId || ""));
  if (!row) return { ok: false, reason: "not_found", message: "ไม่พบรายการธนาคาร" };
  if (row.batchId) return { ok: false, reason: "unlink_first", message: "ยกเลิกการจับคู่ก่อนจึงจะข้ามรายการได้" };
  const now = new Date().toISOString();
  await updateStatementRows(t, sheetId, [{
    row,
    patch: { status: "ข้าม", note: String(note || "").trim(), updatedAt: now },
  }]);
  return { ok: true };
}
