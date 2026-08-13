V7.34 — LINE WORKSPACE REGISTRY
แก้ปัญหา Dashboard เห็นแค่กลุ่ม LINE เก่า ทั้งที่ Bot อยู่/เชื่อมกลุ่มใหม่แล้ว

สาเหตุ:
/api/line-groups เดิมอ่านจาก businessaccount.businesses ทำให้ "ธุรกิจ" กับ "กลุ่ม LINE" ถูกใช้เป็นสารบัญเดียวกัน
กลุ่มใหม่บางกรณีมี tenant/Sheet/Google ครบ แต่ไม่โผล่ในตัวเลือกกลุ่ม LINE

วิธีลง:
1) อัปไฟล์ apply-v734-line-workspace-registry.mjs ไปที่ ROOT ของ repo deal-line-bot
   อยู่ระดับเดียวกับ package.json / wrangler.toml / apply-line-card-review-fix.mjs

2) Cloudflare > Build settings > Deploy command เปลี่ยนเป็น:
node apply-line-card-review-fix.mjs && node apply-v734-line-workspace-registry.mjs && npx wrangler deploy

3) Commit แล้วรอ Build เขียว
Log ต้องเห็น:
✅ LINE_WORKSPACE_REGISTRY_V7_34_20260813 ready

4) กลับ Dashboard หน้าเบิกจ่าย กด "อัปเดตกลุ่ม"
   ระบบ refresh=1 จะ recovery กลุ่มเดิมที่ accountroot ชี้เข้าบัญชีนี้

5) ต่อไปทุกกลุ่มใหม่: แค่ Bot ได้ webhook จากกลุ่ม (join/message/memberJoined) ระบบจะจำ groupId/groupName อัตโนมัติ

สิ่งที่แก้:
- สร้าง LINE Workspace Registry ใน KV แยกจาก Business Account
- /api/line-groups อ่าน Registry แทน business list
- เก็บ groupId / groupName / rootTenant / sheetId / businessName / lastSeenAt
- ทุก webhook ของกลุ่มจะ register อัตโนมัติ
- refresh=1 scan tenant mappings เพื่อกู้กลุ่มเก่าที่เชื่อมก่อนมี Registry
- ไม่เอากลุ่ม LINE ใหม่ไปเพิ่ม business count มั่ว ๆ
- /api/line-members ยังตรวจว่ากลุ่มอยู่ใน account นี้ก่อนดึงสมาชิก

หมายเหตุ:
สคริปต์ idempotent รันซ้ำได้ทุก Build โดยไม่แทรก function ซ้ำ
