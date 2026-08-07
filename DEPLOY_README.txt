รับจ่ายแบบไม่จำกัด — Multi-business Pro v4.9
วันที่ 2026-08-07

สิ่งที่เพิ่ม
1. Multi-business account / Workspace
   - Free: 1 ธุรกิจ
   - Starter: 1 ธุรกิจ
   - Pro: สูงสุด 3 ธุรกิจ
   - Business: สูงสุด 10 ธุรกิจ

2. ช่วง Beta
   - Beta ใช้สิทธิ์ Pro ดังนั้นเพิ่มธุรกิจได้สูงสุด 3 ธุรกิจเพื่อทดสอบ
   - ยังไม่มีการเรียกเก็บเงินจริง

3. Business Switcher
   - มีตัวเลือกธุรกิจใต้โลโก้ด้านซ้าย
   - กดสลับ Workspace ได้
   - Header ชื่อบริษัทกดเพื่อเปิดรายการธุรกิจได้เช่นกัน

4. วิธีเพิ่มธุรกิจใหม่
   - Dashboard > ตัวสลับธุรกิจ > เพิ่มธุรกิจใหม่
   - ระบบสร้างรหัสชั่วคราว 30 นาที
   - เพิ่ม LINE OA เข้า Group ของธุรกิจใหม่
   - ส่งข้อความ: เชื่อมธุรกิจ XXXXXXX
   - Bot จะสร้าง Google Sheet แยกสำหรับธุรกิจใหม่ แล้วผูกเข้า Account เดียวกัน

5. การแยกข้อมูล
   - แต่ละธุรกิจมี Sheet แยก
   - Company settings แยก
   - Gmail ของแต่ละธุรกิจต้องเชื่อม/ตั้งค่าแยก เพื่อไม่ให้อีเมลปนกัน
   - Google Drive/Sheet ใช้สิทธิ์ Google ของ Account หลักในการสร้าง Workspace ใหม่

6. Enforcement หลัง Beta
   - ถ้าแพ็กเกจรองรับแค่ 1 ธุรกิจ แต่เคยสร้างธุรกิจ 2–3 ตอน Beta ข้อมูลเดิมไม่ถูกลบ
   - ธุรกิจที่เกินสิทธิ์จะแสดง PRO lock
   - ยังเปิดดู/จัดการข้อมูลเก่าได้ แต่ระบบหยุดรับเอกสารใหม่จนกว่าจะอัปเกรด

ไฟล์ที่ต้อง Deploy
A) deal-line-bot
   - src/index.js
   - src/entry-mobile-ux.js
   - wrangler.toml

B) deal-dashboard
   - index.html

ลำดับ Deploy
1. Bot ก่อน
2. ตรวจ Worker root ต้องขึ้น:
   DEAL_LINE_BOT_v4.9_MULTI_BUSINESS_PRO_ACTIVE_20260807
3. Dashboard ทีหลัง
4. ทดสอบสร้างรหัสเพิ่มธุรกิจจาก Dashboard
5. เพิ่ม Bot เข้า Group ใหม่ แล้วส่ง "เชื่อมธุรกิจ <รหัส>"

หมายเหตุ
- mobile-web-ux.js ไม่ได้อยู่ใน changed-only เพราะไม่ได้แก้ใน v4.9 และ Repo ปัจจุบันต้องมีไฟล์นี้จาก v4.5+ อยู่แล้ว
- Payment Gateway ยังไม่เปิดจริงตามช่วง Beta
