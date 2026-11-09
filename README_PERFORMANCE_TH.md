# นากนะ บัญชี — Performance 1.2.0

ชุดนี้ต่อจาก Accounting Recovery / LINE Rebrand 1.1 ที่ติดตั้งแล้ว ไม่ใช่โค้ด HR
วันที่ตรวจ source: 9 พฤศจิกายน 2026

## ขอบเขตที่ตรวจได้จริง
- อ่านซอร์สปัจจุบันและสคริปต์ build จาก GitHub ผ่าน connector
- Node unit/integration harness 51 กรณีผ่าน (ใช้ข้อมูลจำลอง)
- ทดลองตัวเตรียม frontend บน build fixture: patch, การคงธีม, ลำดับโหลด network guard, cache version และรันซ้ำผ่าน
- ยังไม่ได้ build repository เต็มด้วย Wrangler หรือทดสอบ API ของบัญชีจริง
- ไม่ได้ Commit/Push/Deploy ขึ้น Production; สิทธิ์ GitHub ที่เชื่อมอยู่ยังไม่มี push
- ไม่อ้างว่าเวลาโหลดจริงลดลงกี่วินาที จนกว่าจะวัดก่อน/หลังใน Production

## สิ่งที่ไม่เปลี่ยน
ไม่เปลี่ยนสี/ฟอนต์/มาสคอต, ไม่ลบข้อมูล, ไม่แก้ยอดเงินหรือรายการ, ไม่เปลี่ยนการอนุมัติ/จ่าย/ลิงก์ที่ใช้เข้าเว็บ
ไม่มี schema migration, ไม่ต้องเปลี่ยน Secret, ไม่มีการเพิ่ม persistent cache ของรายการเงิน
Full billing และการบังคับโควตาเดิมยังทำงานตามเดิม

## ลำดับติดตั้ง
ติดตั้งฝั่ง deal-line-bot ก่อน แล้วจึง deal-dashboard
ไฟล์ต้องอยู่ที่ root ของ repo ตามโครงสร้าง ZIP ไม่ต้องอัป ZIP ทั้งก้อนหรือสร้างโฟลเดอร์ครอบ
ตรวจ diff และเก็บ commit เดิมสำหรับย้อนกลับก่อนอัปเดต

## ชุดนี้สำหรับ organization-Deal/deal-line-bot

เพิ่ม src/nakna-plan-summary.js, scripts/prepare-nakna-performance.mjs,
scripts/install-nakna-performance.mjs และ tests/performance.test.mjs
ไม่แนบ src/index.js ทั้งไฟล์เพื่อไม่ทับงานอื่น

### วิธี deploy
ตั้ง Cloudflare Deploy command เป็น:
```bash
node scripts/install-nakna-performance.mjs && npx wrangler deploy
```
ตัว installer แทรกขั้นตอน performance ต่อท้าย [build] เดิมใน wrangler.toml โดยไม่เปลี่ยนชื่อ Worker, bindings, vars หรือ migration
เมื่อสคริปต์เก่ารันครบแล้ว จะ patch source เฉพาะจุด ถ้ารูปแบบโค้ดไม่ตรงจะหยุดก่อน deploy
หากติดตั้งในเครื่อง local ให้ commit การแก้ wrangler.toml ที่ installer ทำไว้ด้วย จากนั้นใช้ npm run deploy ตามเดิมได้

ต้องเห็น:
```
PASS NAKNA-ACCOUNTING-API-PERFORMANCE-1.2.0
```

### ผลที่เปลี่ยน
1. GET /api/subscription?view=summary ส่งเฉพาะชื่อ/สถานะแพ็กเกจและวันสิ้นสุดทดลองใช้ โดยอ่าน metadata เดิม ไม่เรียก Google token หรือ scan Sheets
2. endpoint ยังอยู่หลัง resolveDashAccess และ accessCan เดิม ไม่เปิดให้เข้าถึงข้ามบริษัท
3. summary ไม่มี usage, blocked หรือสิทธิ์อนุมัติ และ frontend ไม่ใช้ข้อมูล summary ตัดสินสิทธิ์
4. การอ่าน registry ธุรกิจที่ครบอยู่แล้วไม่ rewrite ค่าและ mapping ทุกครั้ง; ยังสร้าง/normalize ครั้งแรกเมื่อจำเป็น
5. รวมคำขอ refresh token ที่กำลังรอของ tenant และ environment เดียวกัน ไม่เพิ่ม cache ข้ามเวลา; error/null ยังถูกส่งกลับตามเดิม
6. full subscription เดิมยังคำนวณ usageDetail; ไม่ใช้ summary แทนการตรวจโควตาการบันทึก

### ทดสอบก่อน deploy
```bash
node --test tests/performance.test.mjs
```
หลัง deploy เปิดหน้า overview แล้วตรวจ request /api/subscription ว่ามี view=summary และตอบ summaryOnly:true
ตรวจหน้าแพ็กเกจว่าโหลดข้อมูลเต็มได้ตามเดิม และทดสอบบัญชีที่ไม่มีสิทธิ์ว่าได้ 401/403
ไม่ต้องเรียก endpoint โดยแปะ tenant/key ในที่สาธารณะ

### ย้อนกลับ
revert commit ชุดนี้และการแทรก build command แล้ว deploy commit เดิม
ไม่มีการลบข้อมูลที่ต้องกู้คืน
