DEAL LINE BOT v4.5 — ชุดรวมที่ต้องลงพร้อมกัน

ไฟล์ในชุด:
- wrangler.toml  <-- สำคัญมาก: เปลี่ยน main เป็น src/entry-mobile-ux.js
- src/index.js  <-- การ์ด Dashboard สีดำ
- src/batches.js <-- เวอร์ชัน Build Fix ที่มี Workflow/Reconciliation exports ครบ
- src/entry-mobile-ux.js
- src/mobile-web-ux.js <-- UX บอกผู้ใช้กด X มุมขวาบนเพื่อกลับ LINE + loading กันกดซ้ำ

วิธีลง:
1. ทับไฟล์ทั้ง 5 ตัวใน repo deal-line-bot ตาม path เดิม
2. Commit/Push
3. รอ Cloudflare Deploy
4. เปิด Worker root ต้องเห็น version:
   DEAL_LINE_BOT_v4.5_BLACK_CARD_CLOSE_X_ACTIVE_20260807
   และ mobileWebUx: true

ถ้ายังเห็น v3.9 แปลว่า wrangler.toml ยังไม่ได้ถูกทับ หรือ Cloudflare build ใช้ commit เก่า
