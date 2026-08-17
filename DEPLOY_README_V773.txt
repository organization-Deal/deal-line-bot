V7.73 Launch Pricing — LINE Bot Backend

ไฟล์ที่เปลี่ยน:
- src/index.js
- src/email.js
- src/admin-ops.js
- src/ai-quota.js (ไฟล์ใหม่)
- pilot-public.js
- wrangler.toml
- apply-v773-launch-pricing.mjs

Pricing ที่ backend บังคับจริง:
- Free: 20 รายการ/เดือน, AI อ่านเอกสาร 5 ใบ, 1 บริษัท
- Lite 199: 200 รายการ/เดือน, AI 30 ใบ, 1 บริษัท
- Pro 399: 1,000 รายการ/เดือน, AI 150 ใบ, 1 บริษัท
- Business 1,290: 3,000 รายการ/เดือน, AI 1,000 ใบ, 2 บริษัท
- Trial Business 30 วัน: 1,000 รายการ/เดือน, AI 100 ใบ

AI quota:
- LINE OCR และเอกสารจากอีเมลใช้โควตาเดียวกันต่อบัญชี
- OCR สำเร็จ 1 เอกสาร = 1 ครั้ง
- fallback/retry ภายใน OCR ครั้งเดียวไม่หักเพิ่ม
- รูปเดิมที่มี cache จะไม่เรียก AI ซ้ำ
- เมื่อ AI ครบโควตา ระบบยังเก็บรูป/อีเมลและให้กรอกข้อมูลเองได้ ไม่ล็อก Workflow ทั้งระบบ

วิธีใช้:
วางไฟล์ตาม path ทับ repo deal-line-bot แล้ว Deploy ตามปกติ
wrangler.toml จะรัน v7.73 audit หลัง v7.72 อัตโนมัติ
