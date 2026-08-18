v7.80 — Manual Expense Payment Flow (Backend)

อัปต่อจาก v7.79:
- apply-v780-manual-expense-payment-flow.mjs
- wrangler.toml

สิ่งที่แก้:
- บันทึกรายจ่ายใหม่ -> สถานะ "รอจ่าย" เสมอ
- ตัด Sheet refresh ซ้ำหลังบันทึก เพื่อลดอาการค้าง
- เพิ่ม POST /api/expenses/manual/pay
- ตอนโอนแล้ว: อัปสลิปเข้า Drive -> ผูกเป็น attSlip -> เปลี่ยนสถานะ "จ่ายแล้ว"
- ไม่ต้องเพิ่ม Secret ใหม่
