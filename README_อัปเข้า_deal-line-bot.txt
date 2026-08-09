LINE Bot v7.9 — Backend Guard ห้ามรวมใบเบิกซ้ำ
==============================================

อัปเข้า:
organization-Deal/deal-line-bot

ทับไฟล์เดิมที่ root:
apply-line-card-review-fix.mjs

Cloudflare Deploy command เดิมของคุณใช้ต่อได้เลย:
node apply-line-card-review-fix.mjs && npx wrangler deploy

ไม่ต้องเปลี่ยน Deploy command

รอบ build ใหม่ log ต้องขึ้น:
✅ LINE card + review + reimbursement duplicate lock applied
Changed: src/index.js, src/oauth.js, src/multi-expense.js, src/batches.js

Backend จะ reject ถ้ามีการส่ง batchIds ของใบเบิกหลักมาให้รวมซ้ำ
ต่อให้มีคนข้าม UI แล้วยิง API เองก็รวมซ้ำไม่ได้
