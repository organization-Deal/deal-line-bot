แก้ Build + Multi-document

สาเหตุที่พัง:
1. package.json เปลี่ยน Wrangler เป็น 4.118.0 แต่ package-lock.json ยังเป็น Wrangler 3.114.17 จึง npm ci ไม่ผ่าน
2. โค้ด multi-document รุ่นใหม่ถูกวางผิดที่หน้า root ขณะที่ main = src/index.js ทำให้ Worker ยังใช้โค้ดเก่า

ชุดนี้แก้แล้ว:
- package.json กลับมา sync กับ package-lock.json เดิม (^3.90.0 / resolved 3.114.17)
- wrangler.toml ใช้ SQLite Durable Object migration
- ย้าย index.js, ocr.js, sheets.js, member-profile.js, multi-expense.js เข้า src/ ถูกตำแหน่ง
- ลบไฟล์ซ้ำหน้า root เพื่อลดความสับสน

อัปทั้งชุดหรือใช้ไฟล์จาก ZIP patch โดยรักษา path แล้ว Commit ครั้งเดียว
