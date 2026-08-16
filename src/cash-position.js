// V7.69 — automatic cash position
// Manual balance = baseline snapshot. After that:
// current = baseline + income cash received - reimbursement paid - AP cash paid.

import { readSettings } from "./sheets.js";
import { listPaymentChannels } from "./payment-channels.js";
import { listBatches } from "./batches.js";
import { listIncomePayments } from "./income.js";
import { getPayables } from "./accounting-suite.js";

export const CASH_POSITION_VERSION = "AUTO_CASH_POSITION_V7_69_20260816";

function num(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}
function clean(v, max = 180) {
  return String(v ?? "").trim().slice(0, max);
}
function parseMap(raw) {
  if (!raw) return {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function timeMs(v) {
  if (!v) return 0;
  const raw = String(v).trim();
  if (!raw) return 0;
  const ts = Date.parse(raw.length === 10 ? `${raw}T23:59:59+07:00` : raw);
  return Number.isFinite(ts) ? ts : 0;
}
function afterBaseline(eventAt, baselineAt) {
  const eventMs = timeMs(eventAt);
  const baseMs = timeMs(baselineAt);
  if (!baseMs) return false; // no manual baseline => do not invent a bank balance
  return eventMs > baseMs;
}
function paidBatch(row = {}) {
  return String(row.status || "").trim() === "จ่ายแล้ว" ||
    Boolean(String(row.paidAt || row.paymentSlipUrl || "").trim());
}
function pendingBatch(row = {}) {
  if (paidBatch(row)) return false;
  const status = String(row.status || "").trim();
  return ["รอโอนเงิน","รอหลักฐานการโอน","อนุมัติแล้ว","รอจ่าย"].includes(status) ||
    String(row.transferStatus || "").trim() === "ตั้งโอนแล้ว";
}
function eventTime(row = {}, type = "") {
  if (type === "income") return row.createdAt || row.receivedAt || row.receivedDate || "";
  if (type === "reimbursement") return row.paidAt || row.paymentSlipAt || row.updatedAt || row.createdAt || "";
  if (type === "ap") return row.createdAt || row.paidAt || row.paidDate || "";
  return row.updatedAt || row.createdAt || "";
}

export function computeCashPosition({
  channels = [],
  baselineMap = {},
  batches = [],
  incomePayments = [],
  apPayments = [],
} = {}) {
  const accounts = [];
  let totalBalance = 0;
  let totalPending = 0;
  let availableCount = 0;

  for (const channel of channels.filter((x) => x?.active !== false)) {
    const id = clean(channel.id, 120);
    if (!id) continue;

    const baseline = baselineMap[id] || null;
    const hasBaseline = baseline && Number.isFinite(Number(String(baseline.balance ?? "").replace(/,/g, "")));
    const baselineValue = hasBaseline ? num(baseline.balance) : 0;
    const baselineAt = clean(baseline?.updatedAt || baseline?.asOf || "", 80);

    let moneyIn = 0;
    let reimbursementOut = 0;
    let payableOut = 0;
    let pendingOut = 0;

    if (hasBaseline && baselineAt) {
      for (const p of incomePayments) {
        if (String(p?.paymentChannelId || "") !== id) continue;
        if (!afterBaseline(eventTime(p, "income"), baselineAt)) continue;
        moneyIn += Math.max(0, num(p.cashAmount));
      }

      for (const b of batches) {
        if (String(b?.paymentChannelId || "") !== id) continue;
        if (paidBatch(b) && afterBaseline(eventTime(b, "reimbursement"), baselineAt)) {
          reimbursementOut += Math.max(0, num(b.total));
        }
      }

      for (const p of apPayments) {
        if (String(p?.paymentChannelId || "") !== id) continue;
        if (!afterBaseline(eventTime(p, "ap"), baselineAt)) continue;
        payableOut += Math.max(0, num(p.cashAmount));
      }
    }

    // Pending is current workload, not historical movement, so it is shown even if no baseline exists.
    for (const b of batches) {
      if (String(b?.paymentChannelId || "") !== id) continue;
      if (pendingBatch(b)) pendingOut += Math.max(0, num(b.total));
    }

    const moneyOut = round2(reimbursementOut + payableOut);
    const balance = hasBaseline && baselineAt
      ? round2(baselineValue + moneyIn - moneyOut)
      : null;
    const afterPending = balance == null ? null : round2(balance - pendingOut);

    if (balance != null) {
      totalBalance += balance;
      availableCount += 1;
    }
    totalPending += pendingOut;

    accounts.push({
      ...channel,
      baseline: hasBaseline ? round2(baselineValue) : null,
      baselineAt,
      baselineNote: clean(baseline?.note || "", 240),
      moneyIn: round2(moneyIn),
      reimbursementOut: round2(reimbursementOut),
      payableOut: round2(payableOut),
      moneyOut,
      balance,
      pendingOut: round2(pendingOut),
      afterPending,
    });
  }

  totalBalance = round2(totalBalance);
  totalPending = round2(totalPending);

  return {
    ok: true,
    version: CASH_POSITION_VERSION,
    accounts,
    summary: {
      accountCount: accounts.length,
      availableCount,
      balance: totalBalance,
      pendingOut: totalPending,
      afterPending: round2(totalBalance - totalPending),
    },
  };
}

export async function getCashPosition(env, tenant, sheetId, token = null) {
  const [settings, batches, incomePayments, payables] = await Promise.all([
    readSettings(env, sheetId, token),
    listBatches(env, sheetId, token).catch((error) => {
      console.warn("cash position batches", error?.message || error);
      return [];
    }),
    listIncomePayments(env, sheetId, token).catch((error) => {
      console.warn("cash position income", error?.message || error);
      return [];
    }),
    getPayables(env, sheetId, token).catch((error) => {
      console.warn("cash position payables", error?.message || error);
      return { payments: [] };
    }),
  ]);

  const channels = listPaymentChannels(settings);
  const baselineMap = parseMap(settings.finance_balances);

  const out = computeCashPosition({
    channels,
    baselineMap,
    batches,
    incomePayments,
    apPayments: Array.isArray(payables?.payments) ? payables.payments : [],
  });

  return {
    ...out,
    tenant: clean(tenant, 120),
    calculatedAt: new Date().toISOString(),
  };
}
