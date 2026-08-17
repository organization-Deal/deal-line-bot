V7.71 — PUBLIC PILOT ROUTE FIX

อาการ:
กรอก Pilot form แล้วกด “ส่งคำขอ”
Browser ไปที่:
https://accoutingsuppor02.organization-23c.workers.dev/pilot/request

แล้วเห็น:
bad signature

สาเหตุ:
src/index.js ปัจจุบันไม่มี /pilot/request route
POST จึงตกลงไปเข้า generic LINE webhook handler
ซึ่งตรวจ x-line-signature และตอบ 401 bad signature

migration เก่า apply-line-card-review-fix.mjs เคยมี Pilot route
แต่ build ปัจจุบันขึ้น:
v7.15 migration already present; skipping re-apply
ทำให้ Pilot route ไม่ถูกใส่กลับมา

V7.71 แยก Pilot ออกจาก migration เก่าเด็ดขาด

UPLOAD ไปที่ root ของ:
organization-Deal/deal-line-bot

ไฟล์:
1. pilot-public.js
2. apply-v771-public-pilot-route.mjs
3. wrangler.toml (Replace)

ไม่ต้องแก้ deal-dashboard

Build ต้องเห็น:
✅ PUBLIC_PILOT_ROUTE_V7_71_20260817 ready
✅ POST /pilot/request is handled before LINE webhook signature validation
✅ pilot submissions are stored in KV pilotreq:v1:*
✅ current Dashboard pilot form fields are accepted
✅ GET /pilot/health added for production verification

และต้อง Deploy สำเร็จถึง:
Uploaded accoutingsuppor02
Deployed accoutingsuppor02 triggers
Success: Deploy command completed
Success! Build completed

หลัง Deploy:
1. เปิด /pilot/health
   ต้องได้ JSON ok:true
2. เปิด Dashboard /pilot.html
3. กรอก TEST PILOT 771
4. กดส่ง
5. ต้องเห็นหน้า “รับคำขอแล้ว” + PILOT-...
6. Internal Ops > Pilot Requests ต้องเห็นรายการใหม่
