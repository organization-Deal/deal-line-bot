import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const indexFile = path.join(root, "src", "index.js");
const MARK = "MANUAL_EXPENSE_ENTRY_V7_78_20260818";

if (!fs.existsSync(indexFile)) throw new Error(`v7.78 missing ${indexFile}`);

let src = fs.readFileSync(indexFile, "utf8");

if (!src.includes(MARK)) {
  const anchor = `        if (url.pathname === "/api/expenses") {
          const rows = await readExpenses(env, sheetId, token);`;

  if (!src.includes(anchor)) throw new Error("v7.78 /api/expenses anchor missing");

  const manualRoute = `        // ${MARK}
        if (url.pathname === "/api/expenses/manual" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const date = String(b.date || "").trim();
          const vendor = String(b.vendor || "").trim();
          const amount = Number(b.amount || 0);
          const category = String(b.category || "อื่น ๆ").trim() || "อื่น ๆ";
          const payerName = String(b.payerName || access.name || "บันทึกจาก Dashboard").trim();
          const note = String(b.note || "").trim();
          const whtRate = Number(b.whtRate || 0);
          const paid = b.paid === true;
          const vat = b.vat === true;

          if (!date) return cors(json({ ok:false, error:"date_required", message:"กรุณาเลือกวันที่รายการ" }, 400));
          if (!vendor) return cors(json({ ok:false, error:"vendor_required", message:"กรุณากรอกร้านค้า / ผู้รับเงิน" }, 400));
          if (!Number.isFinite(amount) || amount <= 0) return cors(json({ ok:false, error:"amount_required", message:"ยอดเงินต้องมากกว่า 0 บาท" }, 400));
          if (vendor.length > 180 || note.length > 500 || payerName.length > 180) {
            return cors(json({ ok:false, error:"field_too_long", message:"ข้อมูลบางช่องยาวเกินกำหนด" }, 400));
          }
          if (!Number.isFinite(whtRate) || whtRate < 0 || whtRate > 100) {
            return cors(json({ ok:false, error:"invalid_wht", message:"หัก ณ ที่จ่ายต้องอยู่ระหว่าง 0–100%" }, 400));
          }

          const before = await getSubscriptionSnapshot(env, key, sheetId, token, { refreshUsage:true });
          const used = Number(before?.usage?.documents || 0);
          const limit = before?.documentLimit == null ? null : Number(before.documentLimit || 0);
          if (limit != null && Number.isFinite(limit) && limit >= 0 && used >= limit) {
            return cors(json({
              ok:false,
              error:"quota_exceeded",
              message:\`เดือนนี้ใช้ครบ \${limit.toLocaleString("th-TH")} รายการแล้ว กรุณาอัปเกรดแพ็กเกจหรือรอรอบเดือนถัดไป\`,
              usage:before.usage,
              documentLimit:limit,
              planName:before.planName || "",
            }, 402));
          }

          const candidate = {
            date,
            amount,
            vendor,
            category,
            note,
            paid,
            vat,
            whtRate:whtRate || "",
            type:"รายจ่าย",
            subCategory:String(b.subCategory || "").trim(),
            docType:"บันทึกเอง",
            transferor:String(b.transferor || "").trim(),
            batchType:"ปกติ",
            batchStatus:paid ? "ชำระแล้ว" : "รอเข้ารอบ",
          };

          const duplicate = await findDuplicateExpenses(env, sheetId, candidate, token).catch(() => ({
            hasDuplicate:false, level:"none", matches:[]
          }));
          if (duplicate?.hasDuplicate && duplicate.level === "high" && b.forceDuplicate !== true) {
            return cors(json({
              ok:false,
              error:"possible_duplicate",
              message:"พบรายการที่คล้ายกันมาก กรุณาตรวจสอบก่อนบันทึกซ้ำ",
              duplicate,
            }, 409));
          }

          const created = await appendExpense(env, sheetId, candidate, {
            sender:payerName || "บันทึกจาก Dashboard",
            payerName:payerName || "บันทึกจาก Dashboard",
            payerId:"",
          }, token);

          const expense = await getExpenseById(env, sheetId, created.id, token).catch(() => null);
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
          }, 201));
        }

${anchor}`;

  src = src.replace(anchor, manualRoute);
  src += `\n\n// ${MARK}\n`;
}

if (!src.includes('"/api/expenses/manual"') || !src.includes("aiConsumed:false")) {
  throw new Error("v7.78 backend audit failed");
}

fs.writeFileSync(indexFile, src);
execFileSync(process.execPath, ["--check", indexFile], { stdio:"inherit" });

console.log(`✅ ${MARK} ready`);
console.log("✅ Manual expense API");
console.log("✅ Monthly quota enforced");
console.log("✅ Manual entry does not consume AI quota");
console.log("✅ Duplicate protection");
