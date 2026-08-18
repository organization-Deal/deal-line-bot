import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const file = path.join(process.cwd(), "src", "index.js");
const MARK = "PRO_MANUAL_EXPENSE_V7_79_20260818";
if (!fs.existsSync(file)) throw new Error("v7.79 missing src/index.js");
let src = fs.readFileSync(file, "utf8");

if (!src.includes(MARK)) {
  const old = `          const candidate = {
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
          };`;

  const replacement = `          const qty = Math.max(0.0001, Number(b.qty || 1));
          const unitPrice = Math.max(0, Number(b.unitPrice || amount));
          const discount = Math.max(0, Number(b.discount || 0));
          const itemName = String(b.itemName || "").trim();
          const paymentMethod = String(b.paymentMethod || "").trim();
          const docType = String(b.docType || "บันทึกเอง").trim() || "บันทึกเอง";
          const detailParts = [];
          if (itemName) detailParts.push(itemName);
          if (qty !== 1 || Math.abs(unitPrice - amount) > 0.009) {
            detailParts.push(\`จำนวน \${qty.toLocaleString("th-TH")} × \${unitPrice.toLocaleString("th-TH",{minimumFractionDigits:2,maximumFractionDigits:2})} บาท\`);
          }
          if (discount > 0) detailParts.push(\`ส่วนลด \${discount.toLocaleString("th-TH",{minimumFractionDigits:2,maximumFractionDigits:2})} บาท\`);
          if (note) detailParts.push(note);

          const candidate = {
            date,
            amount,
            vendor,
            category,
            note:detailParts.join(" · "),
            paid,
            vat,
            whtRate:whtRate || "",
            type:"รายจ่าย",
            subCategory:String(b.subCategory || "").trim(),
            docType,
            transferor:paymentMethod || String(b.transferor || "").trim(),
            batchType:"ปกติ",
            batchStatus:paid ? "ชำระแล้ว" : "รอเข้ารอบ",
            attOther:Array.isArray(b.attachmentUrls) ? b.attachmentUrls.filter(Boolean).join(", ") : "",
          };`;

  if (!src.includes(old)) throw new Error("v7.79 requires v7.78 manual-expense first");
  src = src.replace(old, replacement);
  src += `\n\n// ${MARK}\n`;
}

fs.writeFileSync(file, src);
execFileSync(process.execPath, ["--check", file], { stdio:"inherit" });
console.log(`✅ ${MARK}`);
