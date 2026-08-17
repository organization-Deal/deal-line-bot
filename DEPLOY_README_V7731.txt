V7.73.1 — LINE Bot deploy repair

ใช้กับ repo deal-line-bot ปัจจุบันที่ Cloudflare build ล้มตาม log 17 Aug 2026.

แก้ 2 สาเหตุ:
1) v7.73 หา src/ai-quota.js ไม่เจอ
   - เพิ่มไฟล์ src/ai-quota.js
   - apply-v773 จะสร้างไฟล์นี้เองระหว่าง build หาก GitHub upload พลาดไฟล์ใหม่อีก

2) apply-v751 หา anchor "oauth import" ไม่เจอหลัง src/index.js ถูกอัปเดตเป็นเวอร์ชันใหม่แล้ว
   - ทำ v7.51 ให้ยอมรับ source ที่ผ่าน v7.51.1/v7.61 แล้ว และไม่ re-patch import เก่า

ให้อัปโหลดไฟล์ทั้งหมดโดยรักษา path เดิม:
- apply-v751-production-google-auth.mjs
- apply-v773-launch-pricing.mjs
- src/ai-quota.js

ไม่ต้องแก้ Dashboard.
