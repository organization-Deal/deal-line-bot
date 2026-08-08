# Accounting Suite v7.1 — LINE Bot / Worker

Version: `DEAL_LINE_BOT_v7.1_ACCOUNTING_SUITE_20260809`

## Backend ใหม่
- Additive accounting tabs: คู่ค้า, เจ้าหนี้, จ่ายเจ้าหนี้, ยอดยกมา, ปิดงวด, _audit_log, ประวัติเดิม, _migration_log, ผังบัญชี, สมุดรายวัน
- API: today, global search, contacts, statement, payables, opening, migration, period close/reopen, tax, audit, ledger, backup, role access
- Period lock ป้องกันการบันทึก/แก้ไขย้อนหลังในงวดที่ปิดแล้ว
- Automatic journal สำหรับ Expense, Income Invoice, Income Receipt, AP Invoice, AP Payment และ Reimbursement Payment
- Journal dedup ใช้ KV + fallback scan ป้องกันลงบัญชีซ้ำ
- Auto-create / merge Contact Master จากรายรับใหม่และ AP ใหม่
- Audit Log สำหรับ flow สำคัญ
- Role-specific dashboard token: owner/accountant/approver/viewer
- Existing owner dashboard token ยังใช้ได้และถือเป็น owner

## สิ่งที่ไม่เปลี่ยน
- Google Sheet tabs เดิมของรายจ่าย/รายรับ
- LINE OCR / multi-image flow
- Gmail / Drive / reimbursement / reconciliation API เดิม
- Tenant mapping และ dashboard token เดิม

## Deploy
Deploy Worker ก่อน Dashboard เสมอ แล้วตรวจ health root ก่อนเปิดหน้า Accounting Suite.
