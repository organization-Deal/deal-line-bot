v7.78 Manual Expense — deal-line-bot

อัปที่ root ของ repo หลัง v7.77:
- apply-v778-manual-expense.mjs
- wrangler.toml

เพิ่ม POST /api/expenses/manual
กติกา:
- บันทึกเอง 1 รายการ = ใช้โควตารายการ 1
- ไม่ใช้โควตา AI
- เช็กโควตาก่อนบันทึก
- ตรวจรายการซ้ำระดับสูง
