FIX 2026-08-12 — Gmail / Dashboard Access / LINE Approver

แก้ 3 อาการจากรูป:
1) Gmail
   - /api/gmail-status ตรวจ token จริงเมื่อ Dashboard เปิด
   - จำว่า tenant นี้เคยเชื่อม Gmail แล้ว
   - ถ้า token หมดอายุ/หาย จะขึ้น "ต้องเชื่อม Gmail ใหม่" แทน "ยังไม่ได้เชื่อม"
   - กดเชื่อมใหม่แล้วข้อมูลเดิมใน Sheet/Drive ไม่หาย
   - การกด Disconnect โดยผู้ใช้เองจะล้างสถานะ "เคยเชื่อม" ตามปกติ

2) สิทธิ์ Dashboard
   - ปุ่มแดงแก้เป็นพื้นแดง + ตัวอักษรขาว อ่านได้
   - เปลี่ยนข้อความปุ่มเป็น "ลบสิทธิ์"
   - revoke endpoint เดิมยังทำงานเหมือนเดิม

3) LINE ผู้อนุมัติ
   - Worker รอผล push จริงตอนสร้างสิทธิ์ ไม่รายงานสำเร็จหลอก
   - เก็บสถานะส่ง LINE ของแต่ละสิทธิ์ (sent/failed)
   - เพิ่มปุ่ม "ส่ง LINE ใหม่" โดยไม่ต้องสร้างสิทธิ์ซ้ำ
   - ถ้าส่งส่วนตัวไม่ได้ ระบบจะไม่เอาลิงก์สิทธิ์ส่วนตัวไปโพสต์ในกลุ่ม
   - ระบบส่งข้อความ fallback ที่ปลอดภัยเข้า LINE กลุ่ม (ถ้ามีกลุ่ม) ให้ผู้อนุมัติเพิ่ม OA เป็นเพื่อน
   - เพิ่ม/เปิด LINE member directory + approver notifications ใน Worker source ที่ deploy จริง

ไฟล์หลักที่เปลี่ยน:
BOT
- src/index.js
- src/gmail.js
- src/approver-line.js
- src/batches.js
- src/entry-mobile-ux.js (version marker)

DASHBOARD
- index.html (cache bust v7.27)
- assets/dashboard.js
- assets/reimbursement-batch-lock.js

ลำดับ Deploy:
1. Deploy deal-line-bot ก่อน
2. Deploy deal-dashboard
3. เปิด Dashboard แล้ว Hard Refresh 1 ครั้ง

หมายเหตุ Gmail สำคัญ:
โค้ดแก้การตรวจสถานะและ UX แล้ว แต่ถ้า Google OAuth Consent Screen ยังเป็น Testing
Google อาจทำให้ refresh token หมดอายุตามนโยบายของ OAuth Testing ได้
token ที่หมดอายุไปแล้วต้องกด "เชื่อม Gmail ใหม่" 1 ครั้ง — โค้ดไม่สามารถชุบ token ที่ Google ยกเลิกแล้วได้
ถ้าต้องการไม่ให้เกิดซ้ำในการใช้งานจริง ต้องย้าย OAuth app ไป Production/Verification ตาม Google Cloud
