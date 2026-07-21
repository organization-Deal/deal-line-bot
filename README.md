# DEAL LINE Finance Bot — MVP

บอทไลน์: **ถ่ายบิลลงแชท → OCR (Claude) → การ์ดยืนยัน → เก็บรูปลง Google Drive + เขียนแถวเข้า Google Sheet**
รันบน Cloudflare Worker (แพทเทิร์นเดียวกับ `accsp2026`)

## มันทำอะไร (ขอบเขต MVP wedge)
- รับรูปบิล/สลิปในแชท → อ่านยอด/ร้าน/วันที่/หมวด อัตโนมัติ
- ตอบการ์ด Flex ให้กด **ยืนยัน** หรือ **แก้ยอด**
- ยืนยันแล้ว → อัปรูปเข้า Drive (ได้ลิงก์) + เขียนแถวเข้า Sheet สถานะ `รอเบิก`
- **หลายบริษัท**: 1 กลุ่มไลน์ = 1 บริษัท (ผูกกลุ่ม → ชีท ใน KV) พิมพ์ `id` ในกลุ่มเพื่อดูรหัสกลุ่ม
- ตอบทุกอย่างด้วย **reply message** = ฟรี ไม่กินโควตา push

*ยังไม่รวม (เฟสถัดไป): ใบแทนใบเสร็จ PDF, จับคู่สลิปอัตโนมัติ, รายงานภาษี, onboarding สมัครเอง, payroll*

## โครงไฟล์
```
wrangler.toml         config + KV binding + vars
src/index.js          Worker entry: webhook + routing + pipeline
src/line.js           LINE API + การ์ด Flex
src/ocr.js            Claude OCR (JSON prefill)
src/sheets.js         เขียนแถวเข้า Google Sheet
src/drive.js          อัปรูปเข้า Drive (ปิดได้)
src/google-auth.js    ต่อ Google ด้วย service account (RS256 JWT)
```

## Setup

### 1) ติดตั้ง + KV
```bash
npm install
npx wrangler login
npx wrangler kv namespace create KV
```
เอา `id` ที่ได้ไปแทน `REPLACE_WITH_KV_ID` ใน `wrangler.toml`

### 2) LINE (Developers Console → Messaging API channel)
- เอา **Channel secret** และ **Channel access token (long-lived)** มาใส่เป็น secret (ข้อ 4)
- เปิด **Use webhook** = ON, ปิด auto-reply/greeting
- Webhook URL = `https://deal-line-bot.<you>.workers.dev/` (ได้หลัง deploy ครั้งแรก)

### 3) Google service account (สำหรับ Sheets + Drive)
- สร้าง service account ใน Google Cloud → สร้าง key (JSON) → เอา `client_email` และ `private_key` มา
- **แชร์ Google Sheet** ให้ email ของ service account เป็น **Editor**
- (ถ้าจะเก็บรูป) **แชร์โฟลเดอร์ Drive** ให้ email เดียวกันเป็น Editor แล้วเอา folder id ใส่ `DRIVE_FOLDER_ID`
- ในชีท สร้างแท็บชื่อ `รายจ่าย` แถวแรกใส่หัวคอลัมน์:
  `วันที่ | ยอด | ร้าน/ผู้รับ | หมวด | รายละเอียด | ผู้ส่ง | ลิงก์รูป | สถานะ | บันทึกเมื่อ`
- เอา Sheet id (จาก URL) ใส่ `DEFAULT_SHEET_ID` ใน `wrangler.toml`

### 4) ใส่ secret
```bash
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_ACCESS_TOKEN
npx wrangler secret put CLAUDE_KEY
npx wrangler secret put GOOGLE_SA_EMAIL
npx wrangler secret put GOOGLE_SA_PRIVATE_KEY   # วาง private_key ทั้งก้อน (มี \n ได้ โค้ดแปลงให้)
```

### 5) Deploy
```bash
npx wrangler deploy
```
เอา URL ไปใส่ Webhook URL ใน LINE console แล้วกด Verify

## เทสต์
- เปิด URL ในเบราว์เซอร์ → เห็น `"version":"DEAL_LINE_BOT_v0.1"`
- ดู log สด: `npx wrangler tail`
- แอดบอทเข้ากลุ่มไลน์ → พิมพ์ `id` → ได้รหัสกลุ่ม
- ผูกกลุ่มกับชีท (ตอน MVP ใช้ `DEFAULT_SHEET_ID` ได้เลย ไม่ต้องผูก) → ส่งรูปบิล → การ์ดต้องเด้ง → กดยืนยัน → แถวเข้าไปในชีท

## ผูกกลุ่ม → ชีทเฉพาะบริษัท (หลายบริษัท)
ตอนนี้ผูกมือผ่าน KV:
```bash
npx wrangler kv key put --binding=KV "tenant:<GROUP_ID>" "<SHEET_ID>"
```
เฟสถัดไปค่อยทำหน้า onboarding ให้ลูกค้าผูกเอง
