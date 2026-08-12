LINE Card + Document Review Fix v7.6

แก้ 2 ปัญหา:
1) การ์ด LINE เชื่อม Google/เชื่อมธุรกิจยังใช้สีเขียวเป็น brand color
   -> เปลี่ยน primary action + heading เป็นดำ/ขาว/เทา
   -> สีเขียวยังเก็บไว้เฉพาะ semantic status เช่น รายรับ/พร้อม เท่านั้น

2) หน้า “ตรวจและยืนยัน” เปิดแล้วค้าง กำลังโหลด / 0 เอกสาร
   ROOT CAUSE: JavaScript ที่ reviewPage() generate มี quote escaping ผิดใน renderGroups()
   ทำให้ browser parse <script> ไม่ผ่านทั้งก้อน และ reload() ไม่ถูกเรียกเลย
   -> แก้ quote escaping
   -> เพิ่ม retry + persistent load status ถ้า API ล้มจริง
   -> เปลี่ยนปุ่ม LINE เป็น “ยืนยันและบันทึก” / “ตรวจ / แก้ไขก่อน” ให้ flow ชัดขึ้น

ไฟล์ที่แก้เท่านั้น:
- src/index.js
- src/oauth.js
- src/multi-expense.js

วิธีใช้กับ repo ล่าสุด (ปลอดภัยกว่าเอาไฟล์เก่าทับ):
1. วาง apply-line-card-review-fix.mjs ที่ root ของ deal-line-bot
2. รัน: node apply-line-card-review-fix.mjs
3. ถ้าขึ้น ✅ แปลว่า syntax + generated review script ผ่าน
4. commit/push แล้ว deploy Worker

สคริปต์มี anchor guards: ถ้า source ไม่ตรงเวอร์ชันที่ตรวจ จะหยุดทันที ไม่แก้มั่ว
