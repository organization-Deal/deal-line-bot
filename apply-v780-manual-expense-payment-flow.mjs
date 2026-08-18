import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const file = path.join(process.cwd(), "src", "index.js");
const MARK = "MANUAL_EXPENSE_PAYMENT_FLOW_V7_80_20260818";

if (!fs.existsSync(file)) throw new Error("v7.80 missing src/index.js");

let src = fs.readFileSync(file, "utf8");

if (!src.includes(MARK)) {
  // 1) Manual create: use cached usage counter instead of forcing a second Sheet scan.
  src = src.replace(
    `          const before = await getSubscriptionSnapshot(env, key, sheetId, token, { refreshUsage:true });`,
    `          const before = await getSubscriptionSnapshot(env, key, sheetId, token);`
  );

  // 2) Manual create: ALWAYS enters the ledger as "รอจ่าย".
  //    A separate payment-confirm endpoint is the only path that can mark it "จ่ายแล้ว".
  //    This prevents a stale browser from marking a row paid without a slip.
  const oldTail = `          const expense = await getExpenseById(env, sheetId, created.id, token).catch(() => null);
          const after = await getSubscriptionSnapshot(env, key, sheetId, token, { refreshUsage:true }).catch(() => null);

          return cors(json({
            ok:true,
            id:created.id,
            row:created.row,
            expense,
            usage:after?.usage || null,
            documentLimit:after?.documentLimit ?? limit,
            aiConsumed:false,
            source:"manual_dashboard",
          }, 201));`;

  const newTail = `          await updateExpenseById(env, sheetId, created.id, {
            status:"รอจ่าย",
            paid:false,
            batchStatus:"รอจ่าย",
          }, token);

          await syncSubscriptionUsageAfterSavedExpense(env, key, sheetId, token)
            .catch((e) => console.warn("manual expense usage", e?.message || e));

          const expense = {
            id:created.id,
            date,
            dateISO:date,
            amount,
            vendor,
            category,
            note:candidate.note || "",
            sender:payerName || "บันทึกจาก Dashboard",
            payerName:payerName || "บันทึกจาก Dashboard",
            status:"รอจ่าย",
            paid:false,
            vat,
            whtRate:whtRate || "",
            docType:candidate.docType || "บันทึกเอง",
            transferor:"",
            attOther:candidate.attOther || "",
            createdAt:new Date().toISOString(),
            batchStatus:"รอจ่าย",
            source:"manual_dashboard",
          };

          return cors(json({
            ok:true,
            id:created.id,
            row:created.row,
            expense,
            status:"รอจ่าย",
            documentLimit:limit,
            aiConsumed:false,
            source:"manual_dashboard",
          }, 201));`;

  if (!src.includes(oldTail)) {
    throw new Error("v7.80 manual create tail anchor missing — deploy v7.78/v7.79 first");
  }
  src = src.replace(oldTail, newTail);

  // 3) Payment completion for a manual expense:
  //    upload slip to Drive -> attach as attSlip -> mark row paid.
  const expensesAnchor = `        if (url.pathname === "/api/expenses") {
          const rows = await readExpenses(env, sheetId, token);`;

  if (!src.includes(expensesAnchor)) throw new Error("v7.80 expenses anchor missing");

  const payRoute = `        // ${MARK}
        if (url.pathname === "/api/expenses/manual/pay" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const id = String(b.id || "").trim();
          const paymentMethod = String(b.paymentMethod || "").trim();
          const paidAt = String(b.paidAt || "").trim();
          const file = b.file && typeof b.file === "object" ? b.file : null;

          if (!id) return cors(json({ ok:false, error:"id_required", message:"ไม่พบรายการที่ต้องการบันทึกการจ่าย" }, 400));

          const rec = await getExpenseById(env, sheetId, id, token);
          if (!rec) return cors(json({ ok:false, error:"not_found", message:"ไม่พบรายการรายจ่ายนี้" }, 404));

          if (String(rec.status || "") === "จ่ายแล้ว" || rec.paid === true) {
            return cors(json({
              ok:true,
              alreadyPaid:true,
              id,
              status:"จ่ายแล้ว",
              slipUrl:rec.attSlip || "",
              paymentMethod:rec.transferor || "",
            }));
          }

          if (!paymentMethod) {
            return cors(json({ ok:false, error:"payment_method_required", message:"กรุณาเลือกบัญชีหรือช่องทางที่ใช้จ่าย" }, 400));
          }
          if (!file?.base64) {
            return cors(json({ ok:false, error:"slip_required", message:"กรุณาแนบสลิปหรือหลักฐานการโอน" }, 400));
          }

          const mediaType = String(file.mediaType || "image/jpeg").toLowerCase();
          const allowed = ["image/jpeg","image/png","image/webp","application/pdf"];
          if (!allowed.includes(mediaType)) {
            return cors(json({ ok:false, error:"invalid_file_type", message:"รองรับ JPG, PNG, WEBP และ PDF เท่านั้น" }, 400));
          }

          const base64 = String(file.base64 || "").replace(/^data:[^;]+;base64,/, "");
          if (!base64 || base64.length > 12_000_000) {
            return cors(json({ ok:false, error:"file_too_large", message:"ไฟล์สลิปต้องไม่เกินประมาณ 8 MB" }, 400));
          }

          const safeName = String(file.name || ("payment-" + id + "-" + Date.now())).replace(/[\\\\/:*?"<>|]+/g, "-").slice(0, 160);
          const slipUrl = await uploadTenantImage(
            env, key, base64, mediaType, safeName, token,
            { category:"originals", transactionDate:paidAt || rec.dateISO || rec.date || new Date().toISOString() }
          );
          if (!slipUrl) {
            return cors(json({ ok:false, error:"upload_failed", message:"อัปโหลดหลักฐานการโอนไม่สำเร็จ กรุณาลองอีกครั้ง" }, 502));
          }

          const attached = await addAttachment(env, sheetId, id, "attSlip", slipUrl, token);
          if (!attached?.ok) {
            return cors(json({ ok:false, error:"attach_failed", message:"อัปโหลดไฟล์แล้ว แต่ผูกสลิปกับรายการไม่สำเร็จ" }, 500));
          }

          const updated = await updateExpenseById(env, sheetId, id, {
            status:"จ่ายแล้ว",
            paid:true,
            batchStatus:"ชำระแล้ว",
            transferor:paymentMethod,
          }, token);
          if (!updated?.ok) {
            return cors(json({ ok:false, error:"update_failed", message:"แนบสลิปแล้ว แต่เปลี่ยนสถานะเป็นจ่ายแล้วไม่สำเร็จ" }, 500));
          }

          return cors(json({
            ok:true,
            id,
            status:"จ่ายแล้ว",
            paid:true,
            slipUrl,
            paymentMethod,
            paidAt,
          }));
        }

${expensesAnchor}`;

  src = src.replace(expensesAnchor, payRoute);
  src += `\n\n// ${MARK}\n`;
}

if (!src.includes('"/api/expenses/manual/pay"')) throw new Error("v7.80 pay route audit failed");
if (!src.includes('status:"รอจ่าย"')) throw new Error("v7.80 pending status audit failed");
if (src.includes('const after = await getSubscriptionSnapshot(env, key, sheetId, token, { refreshUsage:true })')) {
  throw new Error("v7.80 slow after-save refresh still present");
}

fs.writeFileSync(file, src);
execFileSync(process.execPath, ["--check", file], { stdio:"inherit" });

console.log(`✅ ${MARK} ready`);
console.log("✅ Manual save returns faster (no second Sheet scan)");
console.log("✅ New manual expenses always start as รอจ่าย");
console.log("✅ POST /api/expenses/manual/pay uploads slip and marks จ่ายแล้ว");
