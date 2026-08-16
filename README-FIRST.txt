V7.70.1.2 — REVIEW INLINE HANDLER ESCAPE FIX

Build ล่าสุดยืนยันว่า:
- V7.69.2 ผ่าน
- V7.70 ผ่าน
- V7.70.1.1 ผ่าน
- Review HTML ถูก generate จริงแล้ว

จากนั้น browser-runtime test จับบั๊กจริงในหน้า Review:
SyntaxError: missing ) after argument list

generated JavaScript ผิดเป็น:
patchGroup(''+g.id+'',{...})
changeRole(''+im.id+'',...)
assign(''+im.id+'',...)
deleteGroup(''+g.id+'')

ต้นเหตุ:
reviewPage() เป็น server-side template literal
renderGroups() มี backslash ก่อน single quote แค่ชั้นเดียว
ตอน server generate HTML backslash ถูกกินไป
ทำให้ browser ได้ JavaScript ผิด syntax

V7.70.1.2:
- เพิ่ม escape อีก 1 ชั้นเฉพาะ renderGroups()
- ไม่แตะข้อมูลบัญชี
- ไม่แตะ OCR
- ไม่แตะ Cash Position
- ไม่แตะ Durable Object

UPLOAD ที่ ROOT:
organization-Deal/deal-line-bot

1. apply-v77012-review-inline-handler-escape-fix.mjs
2. wrangler.toml  (Replace)

เก็บไฟล์เดิมทั้งหมดไว้ โดยเฉพาะ:
- apply-v77011-review-build-node24-fix.mjs
- apply-v7701-review-state-rescue.mjs
- apply-v770-multi-image-no-silent-loss.mjs
- apply-v7692-cash-balance-stability.mjs

Build ใหม่ต้องเห็น:
✅ CASH_POSITION_STABILITY_V7_69_2_20260817 ready
✅ MULTI_IMAGE_NO_SILENT_LOSS_V7_70_20260816 ready
✅ REVIEW_BROWSER_TEST_NODE24_COMPAT_V7_70_1_1_20260817 ready
✅ REVIEW_INLINE_HANDLER_ESCAPE_V7_70_1_2_20260817 ready
✅ renderGroups inline onclick/onchange quotes now survive server-side template rendering
✅ generated Review HTML browser script extracted
✅ REVIEW_STATE_RESCUE_V7_70_1_20260816 ready
✅ generated Review HTML browser JavaScript passed node --check

จากนั้นต้องไปต่อจน:
Uploaded accoutingsuppor02
Deployed accoutingsuppor02 triggers
Success: Deploy command completed
Success! Build completed
