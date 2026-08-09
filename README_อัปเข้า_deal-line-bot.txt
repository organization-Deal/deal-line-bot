v7.11 — Persist Paid Status

อัปเข้า organization-Deal/deal-line-bot:
- apply-line-card-review-fix.mjs ทับตัวเดิมที่ root

Deploy command เดิม:
node apply-line-card-review-fix.mjs && npx wrangler deploy

Log ที่ถูกต้อง:
✅ LINE card + review + reimbursement + paid expense sync applied
Changed: src/index.js, src/oauth.js, src/multi-expense.js, src/batches.js

การแก้ใน src/batches.js มีจุดเดียว:
ตอนแนบหลักฐานโอนคืน เพิ่ม status: "จ่ายแล้ว"
