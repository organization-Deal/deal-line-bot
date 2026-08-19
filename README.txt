deal-line-bot v7.85.2 — generated mobile-web-ux syntax hotfix

สาเหตุของ deploy fail ล่าสุด:
apply-v785-ci-unified.mjs สร้าง src/mobile-web-ux.js เป็น:
  const CI_THEME_V785 = String.raw\`
ซึ่งมี backslash หน้า backtick และเป็น JavaScript ที่ parse ไม่ได้

v7.85.2:
- เปลี่ยน generator เป็น array.join("\n")
- output ที่ได้เป็น:
  const CI_THEME_V785 = String.raw`
- เก็บ semantic approver audit จาก v7.85.1 ไว้
- ทดสอบ node --check ตัว patcher
- จำลองรัน patcher end-to-end
- ทดสอบ node --check ไฟล์ mobile-web-ux.js ที่ถูก generate แล้ว

วิธีใช้:
1) วาง apply-v785-ci-unified.mjs ทับไฟล์เดิมที่ root repo deal-line-bot
2) ไม่ต้องแก้ wrangler.toml
3) Commit / Upload
4) Deploy ใหม่
