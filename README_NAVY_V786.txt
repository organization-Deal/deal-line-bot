รับจ่ายแบบไม่จำกัด — LINE BOT NAVY CI v7.86

ไฟล์:
1) apply-v786-navy-ci.mjs -> root repo deal-line-bot
2) wrangler.toml          -> วางทับ

ตัว v7.86 จะรันหลัง v7.85 เป็นตัวสุดท้าย

ครอบคลุม:
- LINE Flex Card ทุกไฟล์ใน src แบบ recursive
- ปุ่ม primary ทุกการ์ด LINE -> #11162E
- การ์ดอนุมัติ / จ่าย / เบิก / OAuth / Profile / Multi expense
- หน้าเว็บที่เปิดจาก LINE
- Loading / Spinner / Progress
- Form focus / checkbox / radio
- AI badge / AI chip / AI accent -> Navy + Navy Soft
- ล้าง Indigo / Purple / Blue CI เดิมออกจาก runtime src
- รักษาเขียว/แดงไว้เฉพาะ semantic status จริง เช่น จ่ายแล้ว / error

Cloudflare Build จะรัน:
... apply-v785-ci-unified.mjs
&& apply-v786-navy-ci.mjs

ถ้า Build ผ่าน จะเห็น:
✅ RUBJAI_NAVY_CI_V786_20260820
✅ Old Indigo/Purple/Blue CI literals: 0
