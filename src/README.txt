V7.32 — FIX: กลุ่ม LINE ใหม่ไม่ขึ้นในตัวเลือกผู้อนุมัติ

สาเหตุจริง
1) Dashboard โหลดกลุ่มจาก account.businesses เท่านั้น
2) กลุ่ม LINE ใหม่เคยเชื่อม Google / มี tenant:<groupId> อยู่แล้ว
3) คำสั่ง "เชื่อมธุรกิจ XXXXXXX" ถูก backend ปฏิเสธทันทีเพราะเจอ existingSheet
4) กลุ่มจึงไม่เคยถูกเพิ่มเข้า businessaccount ของบัญชีหลัก
5) หน้า "สิทธิ์เข้า Dashboard" จึงเห็นเฉพาะกลุ่มเก่า

ไฟล์ที่แก้
- src/index.js

สิ่งที่แก้
- อนุญาตนำ "ธุรกิจ standalone ที่มีข้อมูลเดิมแล้ว" เข้าบัญชีหลักด้วย invite code
- ไม่ทับ Google Sheet เดิม
- ไม่ทับ Google refresh token เดิม
- ไม่ทับ Drive / settings เดิม
- ยังบล็อกกรณีธุรกิจนั้นอยู่ใต้บัญชีอื่นจริง ๆ
- หลังรวมสำเร็จ account.businesses จะมี group tenant ใหม่นี้
- /api/line-groups และตัวเลือก LINE ผู้อนุมัติจะมองเห็นกลุ่มใหม่
- ทำคำสั่งซ้ำแบบ idempotent ได้ถ้าอยู่บัญชีเดียวกันแล้ว

วิธีลง
1) เข้า GitHub deal-line-bot
2) เข้าโฟลเดอร์ src
3) อัปโหลด index.js จาก ZIP นี้ทับของเดิม
4) Commit
5) รอ Cloudflare Deploy ให้ผ่าน
6) จาก Dashboard สร้างรหัส "เพิ่มธุรกิจ" ใหม่
7) ในกลุ่ม LINE ใหม่ พิมพ์: เชื่อมธุรกิจ <รหัส>
8) กลับ Dashboard แล้ว Refresh / Hard Refresh หน้า "สิทธิ์เข้า Dashboard"

ผลที่ควรได้
- LINE ตอบ "รวมธุรกิจเดิมเข้าบัญชีสำเร็จ"
- ข้อมูล Sheet / Drive / การตั้งค่าเดิมยังอยู่ครบ
- Dropdown กลุ่ม LINE แสดงทั้งกลุ่มเก่าและกลุ่มใหม่
