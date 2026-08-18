v7.82 — แยก UX เว็บทั่วไป vs LINE

สาเหตุ:
src/entry-mobile-ux.js ใส่ mobile-web-ux ให้ HTML ทุกหน้า
และ mobile-web-ux เดิมเห็นคำว่า "กลับไป LINE" ก็แสดงหน้าสอนกด X เสมอ
แม้เปิดจาก Chrome/Dashboard ปกติ

อัปเข้า root ของ deal-line-bot:
1) apply-v782-web-vs-line-success.mjs
2) wrangler.toml

หลัง Deploy:
- เปิดฟอร์มจาก LINE: พฤติกรรมเดิม ใช้ X/LIFF เพื่อกลับ LINE
- เปิดฟอร์มจาก Dashboard/Chrome: ไม่ขึ้นหน้าสอนกด X
- ปุ่มท้ายหน้าเปลี่ยนเป็น "ปิดหน้านี้และกลับ Dashboard" ถ้าเปิดเป็นแท็บจาก Dashboard
- ถ้าไม่มี opener จะเป็น "กลับไปหน้าก่อนหน้า"

ทดสอบ:
A) Dashboard > + ตั้งเบิก > กรอก > ส่ง
   ต้องไม่เห็น overlay "กด X มุมขวาบน"
B) LINE > พิมพ์ "ตั้งเบิกคู่ค้า" > กรอก > ส่ง
   UX กลับ LINE ยังทำงานเหมือนเดิม
