V7.68 — WORKFLOW LINE NOTIFY ROLE FIX

UPLOAD TO:
organization-Deal/deal-line-bot

UPLOAD TO REPO ROOT:
1. apply-v768-workflow-line-notify-role-fix.mjs
2. wrangler.toml  (replace current)

DO NOT upload this to deal-dashboard.
This is Backend / LINE Worker only.

ROOT CAUSE
The backend notification helper already supports:
- approver
- accountant

But /api/accounting/access-notify had an approver-only guard.
That is why an Accounting row showed:
  “สิทธิ์นี้ยังไม่ได้ผูก LINE ผู้อนุมัติ”

FIX
- New Approver access -> auto send LINE
- New Accounting access -> auto send LINE
- Send LINE again works for Approver
- Send LINE again works for Accounting
- If personal LINE is not reachable yet, Dashboard receives a clear fallback status

TO ADD AN APPROVER
1. เลือก “ผู้อนุมัติ”
2. เลือกกลุ่ม LINE
3. เลือกพนักงาน
4. เพิ่มสิทธิ์

If the user can receive OA private messages, LINE is sent automatically.
If not, the user must open the OA private chat and send:
  เชื่อม
once, then Owner presses “ส่ง LINE ใหม่”.

BUILD LOG MUST SHOW
✅ WORKFLOW_LINE_NOTIFY_ROLE_FIX_V7_68_20260816 ready
✅ new Approver access sends LINE automatically when a LINE user is selected
✅ new Accounting access also sends LINE automatically
✅ Send LINE again works for Approver and Accounting roles
✅ misleading approver-only guard removed
✅ LINE fallback status is returned to Dashboard
