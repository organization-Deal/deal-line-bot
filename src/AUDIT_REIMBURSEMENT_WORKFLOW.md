# Audit — Reimbursement Workflow

วันที่ตรวจ: 3 สิงหาคม 2569  
Source of Truth: ZIP ล่าสุดของ `deal-line-bot` และ `deal-dashboard`

## ผลการเชื่อมต่อ Bot ↔ Dashboard

Dashboard เรียก route ต่อไปนี้และ Worker มี implementation ตรงกันครบ:

- `GET /api/batches`
- `POST /api/batch-close`
- `POST /api/batch-urgent`
- `POST /api/batch-workflow`
- `POST /api/batch-payment-slip`

Contract ใหม่ส่งข้อมูลที่ฝ่ายบัญชีต้องใช้ครบ ได้แก่เลขบัญชีเต็ม ชื่อบัญชี ธนาคาร รายการย่อย ลิงก์เอกสาร สถานะความพร้อมเอกสาร หลักฐานโอน LINE notification และ Audit log

## สถานะมาตรฐาน

| สถานะ | งานถัดไป |
|---|---|
| `รอเข้ารอบ` | สร้างรอบปกติหรือด่วน |
| `รอตรวจเอกสาร` | ผ่านเอกสารหรือตีกลับ |
| `ต้องแก้ไข` | ผู้เบิกแก้ไข/แนบเอกสารและส่งกลับตรวจ |
| `รอโอนเงิน` | ส่งออกไฟล์โอนและทำรายการโอน |
| `รอหลักฐานการโอน` | แนบสลิป/หลักฐาน |
| `จ่ายแล้ว` | ปิดงานและแจ้ง LINE |

สถานะรุ่นเก่าถูก map เพื่อรองรับข้อมูลเดิม เช่น `รออนุมัติ`, `อนุมัติแล้ว`, `รอจ่าย`, `ตีกลับ`

## การเปลี่ยนแปลงสำคัญ

- เปลี่ยนหน้าเบิกจ่ายเป็นตารางหลักหน้าเดียว
- ทำ Action column ให้ติดด้านขวา เพื่อเห็นงานถัดไปแม้ตารางกว้าง
- เปิดรายละเอียดใน Drawer แทนการเด้งหลายหน้า
- ตัด PEAK ออกจาก Flow แต่รักษาคอลัมน์ Legacy
- เพิ่มตีกลับพร้อมเหตุผลและเลือกรายการที่มีปัญหา
- เพิ่มการ์ด LINE ให้ผู้เบิกแก้ไขและส่งกลับตรวจ
- แก้การหา LINE User ID สำหรับรอบเก่าที่เคยเก็บชื่อแทน ID
- บังคับลำดับสถานะฝั่ง API: ตรวจเอกสารก่อนโอน และบันทึกการโอนก่อนแนบหลักฐาน
- แนบหลักฐานแล้วผูกกลับทุกรายการ เปลี่ยนเป็นจ่ายแล้ว และส่ง LINE
- แปลงลิงก์ Google Drive เป็นลิงก์รูปโดยตรงสำหรับ LINE image message
- LINE ส่งไม่สำเร็จไม่ย้อนสถานะการจ่าย และมีคำสั่งส่งซ้ำ
- ตั้งได้ว่าจะรวมรายการเป็นใบเดียวหรือหนึ่งรายการต่อหนึ่งใบเบิก

## การตรวจที่ทำแล้ว

- JavaScript syntax ของ Dashboard ผ่าน `node --check`
- JavaScript syntax ของ Bot ทุกไฟล์ใน `src/` ผ่าน `node --check`
- import entry `src/index.js` ผ่านและ named exports ตรงกัน
- API route contract ระหว่าง Dashboard และ Worker ตรงกัน
- ตรวจโครงสร้าง Repo และไฟล์ entry ตาม config
- Render หน้า Dashboard ด้วย mock data ครบทุกสถานะ ไม่มี browser console/page error
- เปิด Drawer ของสถานะรอตรวจ และพบ Action `ตีกลับ` / `เอกสารผ่าน` ถูกต้อง
- ตรวจ UI ที่ viewport 1720×1000 และ Action column ยังมองเห็น
- ทดสอบ Workflow จริงด้วย Google Sheets/Drive/LINE API mock แบบ stateful: ตีกลับ → ส่งกลับตรวจ → ผ่านเอกสาร → โอน → แนบหลักฐาน → จ่ายแล้ว ผ่านครบ
- ตรวจว่า LINE payment notification ใช้ลิงก์รูป `lh3.googleusercontent.com` ไม่ใช่หน้า Google Drive HTML

> หมายเหตุ: ไม่สามารถรัน `wrangler deploy --dry-run` ในสภาพแวดล้อมนี้ได้ เพราะไม่มีแพ็กเกจใน cache และ registry ภายในไม่พร้อมใช้งาน จึงต้องรัน `npm ci` และ dry-run/Deploy อีกครั้งใน GitHub หรือ Cloudflare environment ที่เชื่อม npm ได้

## สิ่งที่ยังต้องตรวจหลัง Deploy จริง

- Google Sheets/Drive permissions และ OAuth token ของ Tenant จริง
- LINE push ด้วย User ID จริง ทั้งตีกลับ จ่ายแล้ว และส่งซ้ำ
- Upload หลักฐานจริงและ public URL ที่ LINE เปิดรูปได้
- Cron ปิดรอบอัตโนมัติใน timezone Asia/Bangkok
- Concurrent clicks / duplicate batch creation ใน Cloudflare Durable Object จริง
- Tenant isolation, role permissions, backup/restore และ privacy requirements

## ลำดับ Deploy

1. Deploy `deal-line-bot`
2. ตรวจ Worker version และ `/api/batches` contract
3. Deploy `deal-dashboard`
4. เปิดหน้าเบิกจ่ายจากลิงก์ LINE แล้วทำ UAT ครบหนึ่งรอบ
