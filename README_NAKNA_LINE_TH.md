# นากนะ บัญชี — LINE Cards 1.1.0

ใช้กับ organization-Deal/deal-line-bot เท่านั้น ไม่ใช่ deal-dashboard หรือ hr-line
อิง src/line.js blob 7f84caef72d65dd675cf70e20941c7e9dd9bbed0 และ src/oauth.js blob f292bcb56d6d8ac0f2f79a19886d5bc3904fbae9
wrangler.toml อิง blob 8fd211f0c441cc650c90affb22d94765df887c22 ที่อ่านรอบนี้

## ทำไมต้องแก้ Repo นี้ด้วย
การ์ด LINE ถูกสร้าง/ส่งจากบอท ไม่ได้ใช้ CSS ของ deal-dashboard
Build เดิมมี apply-v786-navy-ci.mjs และ apply-v787-no-green-cleanup.mjs ซึ่งบังคับ CI เดิม
ชุดนี้ต่อขั้นตอนสุดท้ายหลัง Build เดิม เพื่อแปลง Flex ก่อนส่งออกจริงจาก src/line.js (reply/push) และ src/oauth.js (การ์ดเชื่อมธุรกิจ)

## สิ่งที่แก้
- ปุ่มหลัก Teal #04878A, ข้อความ #153C45/#5C7178, พื้น soft #E8F5F5
- เพิ่มหัว นากนะ บัญชี หากการ์ดไม่มี header; ไม่ลบ custom header เดิม
- หัวข้อความแจ้งเตือน altText ระบุแบรนด์ใหม่
- ไม่แตะลิงก์, query key, postback, จำนวนเงิน, ชื่อบริษัท, Signature/OAuth/LINE token
- สี error และ destructive action แยกจากสีแบรนด์
- ไม่แก้ข้อความธรรมดาที่อาจเป็นชื่อบริษัท หรือประวัติเก่า
- ไม่เปลี่ยนชื่อโปรไฟล์/รูป OA, Rich Menu หรือหน้าเว็บที่อยู่ใน Worker ของบอท ชุดนี้มุ่งการ์ดข้อความที่ส่งผ่าน 3 เส้นทางที่ตรวจ
- ถ้ามี integration อื่นส่ง LINE ตรงโดยไม่ผ่านเส้นทางนี้ต้องตรวจเพิ่ม ไม่อ้างว่าครอบคลุมทุก sender ที่ไม่เคยตรวจ

## ลงไฟล์
วางตามโครงสร้างที่ root ของ deal-line-bot แล้ว Commit/Push
ต้องรวม wrangler.toml ซึ่งเพิ่มคำสั่งท้าย [build] เท่านั้น ค่า bindings/migrations/vars/Worker name คงเดิม
ถ้า wrangler.toml ล่าสุดต่างจากต้นฉบับที่ระบุ ให้รวมเฉพาะ `&& node scripts/prepare-nakna-line-brand.mjs` ท้าย build command เดิมแทนการทับ bindings ใหม่

ก่อน deploy: node --test tests/nakna-line-theme.test.mjs
Deploy command: npx wrangler deploy
ท้าย log ต้องเห็น PASS NAKNA-ACCOUNTING-LINE-1.1.0

## ตรวจหลัง deploy
พิมพ์ “แดชบอร์ด” เพื่อให้บอทส่งการ์ดใหม่ ตรวจชื่อ นากนะ บัญชี + ปุ่ม Teal
ไม่ต้องเชื่อมธุรกิจใหม่เพื่อทดสอบสี
แพตช์นี้ไม่แก้ข้อความที่ส่งไปแล้ว ต้องดูข้อความใหม่เท่านั้น
ชื่อ/รูป OA ในหัวแชตยังต้องตั้งที่ LINE OA Manager แยกต่างหาก
LINE Flex ใช้การแสดงฟอนต์ของ LINE/อุปกรณ์ ไม่ได้ฝัง IBM Plex เหมือนเว็บ

## ผลทดสอบ/ข้อจำกัด
15 unit tests ผ่าน ครอบคลุม palette, bubble/carousel, immutable input, action preservation, no unsupported fontFamily, idempotent sender patch
ยังไม่ได้เรียก LINE validate API หรือส่งข้อความจริงด้วย token ของบัญชี Production
ยังไม่ได้ Deploy; ไม่ได้ใช้หรือแสดงค่า Secret
Rollback โดยคืน commit ก่อนหน้าแล้ว redeploy ไม่ต้องลบข้อมูลธุรกิจ
