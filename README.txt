V7.37 — กู้กลุ่ม LINE เก่าที่หายจาก Dashboard

สาเหตุ:
โค้ด v7.35/v7.36 เช็ก account.businesses ก่อนเช็กว่า LINE Group เก่าใช้ Sheet เดียวกับบริษัทปัจจุบัน
ทำให้กลุ่มรุ่นเก่าอย่าง Test1111 ถูกตีความเป็นธุรกิจแยกและถูก filter ออกจากรายการ LINE Groups

วิธีลง:
1) อัป apply-v737-restore-legacy-line-groups.mjs ที่ root ของ deal-line-bot
2) Deploy command:
node apply-line-card-review-fix.mjs && node apply-v736-build-compat.mjs && node apply-v737-restore-legacy-line-groups.mjs && npx wrangler deploy
3) Deploy ให้ผ่าน
4) Dashboard > กลุ่ม LINE > อัปเดตรายชื่อ

ไม่ต้องเชื่อมกลุ่ม Test1111 ใหม่
ไม่แตะ Sheet/Drive/Gmail/ข้อมูลรายการเดิม
