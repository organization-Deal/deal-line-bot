import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const file = path.join(process.cwd(), "src", "cash-position.js");
const MARK = "CASH_POSITION_STABILITY_V7_69_2_20260817";
if (!fs.existsSync(file)) throw new Error("ไม่พบ src/cash-position.js");
let src = fs.readFileSync(file, "utf8");
if (src.includes(MARK)) {
  console.log("✅ " + MARK + " already applied");
  process.exit(0);
}

const versionOld = 'export const CASH_POSITION_VERSION = "AUTO_CASH_POSITION_V7_69_20260816";';
const versionNew = `export const CASH_POSITION_VERSION = "AUTO_CASH_POSITION_V7_69_2_20260817"; // ${MARK}`;
if (!src.includes(versionOld)) throw new Error("v7.69.2: version anchor changed");
src = src.replace(versionOld, versionNew);

const eventOld = `function eventTime(row = {}, type = "") {
  if (type === "income") return row.createdAt || row.receivedAt || row.receivedDate || "";
  if (type === "reimbursement") return row.paidAt || row.paymentSlipAt || row.updatedAt || row.createdAt || "";
  if (type === "ap") return row.createdAt || row.paidAt || row.paidDate || "";
  return row.updatedAt || row.createdAt || "";
}`;
const eventNew = `function eventTime(row = {}, type = "") {
  // Use immutable money-movement timestamps. An unrelated later edit must never
  // move a transaction across the manual balance baseline.
  if (type === "income") return row.receivedAt || row.receivedDate || row.createdAt || "";
  if (type === "reimbursement") return row.paidAt || row.paymentSlipAt || row.createdAt || "";
  if (type === "ap") return row.paidAt || row.paidDate || row.createdAt || "";
  return row.createdAt || "";
}`;
if (!src.includes(eventOld)) throw new Error("v7.69.2: eventTime block changed");
src = src.replace(eventOld, eventNew);

const oldReads = `  const [settings, batches, incomePayments, payables] = await Promise.all([
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
  ]);`;
const newReads = `  let settings, batches, incomePayments, payables;
  try {
    // Accounting balance must be all-or-nothing. Never turn a failed Sheet read
    // into [] and then publish a fake balance as ok:true.
    [settings, batches, incomePayments, payables] = await Promise.all([
      readSettings(env, sheetId, token),
      listBatches(env, sheetId, token),
      listIncomePayments(env, sheetId, token),
      getPayables(env, sheetId, token),
    ]);
  } catch (error) {
    const message = String(error?.message || error || "cash position source unavailable").slice(0, 220);
    console.warn("cash position incomplete snapshot rejected", message);
    const e = new Error("cash_position_incomplete: " + message);
    e.code = "cash_position_incomplete";
    throw e;
  }`;
if (!src.includes(oldReads)) throw new Error("v7.69.2: partial snapshot block changed");
src = src.replace(oldReads, newReads);

const oldReturn = `  return {
    ...out,
    tenant: clean(tenant, 120),
    calculatedAt: new Date().toISOString(),
  };`;
const newReturn = `  return {
    ...out,
    complete: true,
    sourceStatus: { settings: true, batches: true, incomePayments: true, payables: true },
    tenant: clean(tenant, 120),
    calculatedAt: new Date().toISOString(),
  };`;
if (!src.includes(oldReturn)) throw new Error("v7.69.2: return block changed");
src = src.replace(oldReturn, newReturn);

fs.writeFileSync(file, src);
execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });

const out = fs.readFileSync(file, "utf8");
if (!out.includes(MARK)) throw new Error("v7.69.2 marker missing");
if (!out.includes("cash position incomplete snapshot rejected")) throw new Error("partial snapshot guard missing");
if (!out.includes("complete: true")) throw new Error("complete flag missing");
if (!out.includes('row.paidAt || row.paymentSlipAt || row.createdAt')) throw new Error("immutable paid timestamp missing");

console.log("✅ " + MARK + " ready");
console.log("✅ incomplete Google Sheets snapshots can no longer overwrite cash balances");
console.log("✅ cash position is now all-or-nothing across settings / batches / income / AP");
console.log("✅ mutable updatedAt no longer changes whether a payment is before/after baseline");
console.log("✅ only complete cash snapshots return complete:true");
