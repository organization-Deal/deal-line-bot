v7.56 — Internal Operations route fix

ต้นเหตุ:
- deal-dashboard/admin.html และ assets/admin.js มีอยู่แล้ว
- src/admin-ops.js ฝั่ง deal-line-bot ก็มีอยู่แล้ว
- แต่ src/index.js ไม่ได้ import handleAdminOps และไม่ได้ route /admin/ops/*
- หน้า Admin จึงขึ้น “ติดต่อ Worker ไม่ได้” แม้ ADMIN_KEY ถูกต้อง

อัปที่ ROOT ของ deal-line-bot:
1) apply-v756-admin-ops-route.mjs
2) wrangler.toml

จากนั้น Deploy accoutingsuppor02 ใหม่

Build log ต้องเห็น:
✅ ADMIN_OPS_ROUTE_V7_56_20260816 ready
✅ src/admin-ops.js wired into Worker
✅ /admin/ops/* route enabled
✅ ADMIN_KEY validation will now reach backend

หลัง Deploy:
- กลับหน้า admin.html
- Hard Refresh
- ใส่ ADMIN_KEY ที่ตั้งใน Cloudflare
- ถ้าคีย์ผิด จะต้องขึ้น “ADMIN_KEY ไม่ถูกต้อง”
- ถ้าคีย์ถูก จะเข้าหลังบ้านได้
