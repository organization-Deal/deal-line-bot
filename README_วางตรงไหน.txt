LINE CARD + DOCUMENT REVIEW FIX v7.6
====================================

ไฟล์ชุดนี้เป็นของ repo:
organization-Deal/deal-line-bot

ตำแหน่งที่ถูกต้อง
------------------
ให้เอาไฟล์ในโฟลเดอร์ PUT_IN_deal-line-bot_ROOT
ไปไว้ที่ ROOT ของ repo deal-line-bot

โครงสร้างต้องออกมาแบบนี้:

deal-line-bot/
├─ package.json
├─ wrangler.toml
├─ apply-line-card-review-fix.mjs    <-- ไฟล์นี้อยู่ตรงนี้
└─ src/
   ├─ index.js
   ├─ oauth.js
   ├─ multi-expense.js
   └─ ...

สำคัญ:
- ห้ามเอา apply-line-card-review-fix.mjs ไปไว้ใน src/
- script จะไปแก้เฉพาะ:
  src/index.js
  src/oauth.js
  src/multi-expense.js
- ไม่แตะ Sheet / Drive / ข้อมูลลูกค้า
- ถ้า source ไม่ตรงเวอร์ชัน script จะหยุด ไม่แก้มั่ว

วิธีรัน
-------
เปิด Terminal / Command Prompt ที่โฟลเดอร์ deal-line-bot แล้วรัน:

node apply-line-card-review-fix.mjs

ถ้าสำเร็จจะขึ้น:
✅ LINE card + review page fix applied

สิ่งที่ patch นี้แก้
-------------------
1. การ์ด LINE เชื่อม Google / เชื่อมธุรกิจ
   - เปลี่ยนสีหลักเขียว -> ดำ/ขาว/เทา

2. การ์ดยืนยันชุดเอกสาร
   - "ยืนยันรายการถูกต้อง" -> "ยืนยันและบันทึก"
   - "ตรวจและแก้ไข" -> "ตรวจ / แก้ไขก่อน"

3. หน้า "ตรวจและยืนยัน"
   - แก้ JavaScript syntax error ที่ทำให้ค้าง "กำลังโหลด"
   - เพิ่ม retry อัตโนมัติเมื่อ API พลาด
   - เปลี่ยนชื่อแบรนด์เป็น "รับจ่ายแบบไม่จำกัด"

DEPLOY
------
หลังรัน patch ให้ commit/push repo deal-line-bot ตามปกติ
Cloudflare Worker ที่ผูก repo นี้จะ deploy จากโค้ดใหม่

ถ้ามึงอัปไฟล์ผ่าน GitHub หน้าเว็บอย่างเดียว:
ไฟล์นี้ไม่ใช่ไฟล์ที่เอาไปแทน src/index.js ตรง ๆ
มันเป็น script สำหรับแก้ 3 ไฟล์ให้ถูกจุดอัตโนมัติ
