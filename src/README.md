# รับจ่ายแบบไม่จำกัด — LINE Accounting Bot

Cloudflare Worker สำหรับรับเอกสารผ่าน LINE, OCR, บันทึก Google Sheets/Drive, สร้างเอกสาร PDF, Gmail inbox และจัดการรอบเบิกจ่ายร่วมกับ `deal-dashboard`.

## เวอร์ชันชุดนี้

- Worker: `DEAL_LINE_BOT_v2.3_ACCOUNTING_WORKFLOW`
- Reimbursement API contract: `REIMBURSEMENT_ACCOUNTING_TABLE_V3_20260803`
- LINE card: `5.2_ACCOUNTING_WORKFLOW`

## Workflow เบิกจ่าย

```text
รอเข้ารอบ
  → รอตรวจเอกสาร
  → ต้องแก้ไข → ผู้เบิกแก้/แนบเอกสาร → รอตรวจเอกสาร
  → รอโอนเงิน
  → รอหลักฐานการโอน
  → จ่ายแล้ว → ส่ง LINE พร้อมหลักฐาน
```

ขั้น PEAK ถูกตัดออกจาก Workflow แล้ว แต่คอลัมน์เดิมในแท็บ `รอบเบิก` ยังถูกเก็บเป็น Legacy เพื่อไม่ให้โครงสร้าง Google Sheet ของลูกค้าเดิมเลื่อน

## API ที่ Dashboard ใช้

| Method | Route | หน้าที่ |
|---|---|---|
| GET | `/api/batches` | ส่งคิวรอรวมรอบ รอบที่สร้างแล้ว รายการย่อย บัญชี เอกสาร และสรุปสถานะ |
| POST | `/api/batch-close` | สร้างรอบปกติหรือด่วนจากรายการที่เลือก |
| POST | `/api/batch-urgent` | ขอสร้างรอบด่วนทันที |
| POST | `/api/batch-workflow` | ผ่านเอกสาร ตีกลับ ส่งกลับตรวจ บันทึกโอน และส่ง LINE ซ้ำ |
| POST | `/api/batch-payment-slip` | อัปโหลดหลักฐานโอน ปิดงาน และแจ้ง LINE |
| POST | `/api/batch-status` | Route compatibility สำหรับสถานะรุ่นก่อน |

ทุก route ต้องส่ง `tenant` และ `k` ตามลิงก์ Dashboard ที่ Worker สร้าง

## การรวมรายการ

ตั้งค่าใน `_settings` ผ่าน Dashboard:

- `batch_merge_items=TRUE` รวมรายการของผู้เบิกคนเดียวกันในรอบเดียว สูงสุดตาม `batch_max_items`
- `batch_merge_items=FALSE` สร้างหนึ่งรายการต่อหนึ่งใบเบิก
- รอบด่วนและรอบปกติไม่ถูกรวมเข้าด้วยกัน

## โครงสร้างสำคัญ

```text
src/index.js             Worker entry, webhook และ API routes
src/batches.js           รอบเบิก, data contract, workflow และ LINE notification
src/batch-documents.js   PDF ใบขอเบิกรวม
src/card.js              Flex Message รวมการ์ดแก้ไขรายการ
src/sheets.js            Expense schema และ Google Sheets
src/drive.js             Google Drive upload
src/member-profile.js    โปรไฟล์พนักงานและบัญชีรับเงินแบบ fixed
src/multi-expense.js     รูปหลายรูปและหลายรายการ
src/email*.js / gmail.js Gmail inbox และ OCR เอกสาร
```

## Deploy

```bash
npm ci
npx wrangler deploy
npx wrangler tail
```

Deploy Repo นี้ **ก่อน** `deal-dashboard` เพื่อให้ API contract V3 พร้อมใช้งานก่อนหน้า Dashboard ใหม่ถูกเปิด

Secrets และ bindings ที่ต้องมีดูได้จาก `wrangler.toml` ห้ามใส่ค่าจริงลง Git

## Smoke test หลัง Deploy

1. เปิด Worker root แล้วตรวจว่าได้ `DEAL_LINE_BOT_v2.3_ACCOUNTING_WORKFLOW`
2. เปิด Dashboard และตรวจ `/api/batches` ว่า `version` เริ่มด้วย `REIMBURSEMENT_ACCOUNTING_TABLE_V3`
3. สร้างรายการปกติ 2 รายการและรายการด่วน 1 รายการ
4. ทดสอบสร้างรอบ ตรวจผ่าน ตีกลับ ส่งกลับตรวจ และบันทึกว่าโอนแล้ว
5. แนบหลักฐาน JPG และตรวจ Drive, Google Sheet, Dashboard และ LINE
6. ทดสอบส่ง LINE ไม่สำเร็จ แล้วกดส่งซ้ำจากใบเบิกที่จ่ายแล้ว

รายละเอียดผล Audit อยู่ใน `AUDIT_REIMBURSEMENT_WORKFLOW.md`
