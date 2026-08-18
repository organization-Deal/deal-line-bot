v7.81 — ตั้งเบิกคู่ค้า / Supplier ผ่าน LINE

อัปที่ root ของ deal-line-bot:
1) apply-v781-vendor-requisition.mjs
2) wrangler.toml

LINE รองรับ:
ตั้งเบิก / ตั้งเบิกคู่ค้า / เบิกคู่ค้า / ตั้งเบิกบริษัท / ขอจ่าย supplier /
ตั้งเบิกช่าง / จ่ายช่าง / ตั้งเบิกบุคคล / จ่าย freelance / เบิกค่าของ

Flow:
LINE -> ฟอร์มส่วนตัว -> ส่งอนุมัติ -> ใช้ Workflow เบิกเดิมของบริษัท
คู่ค้าเก็บใน _settings: vendor_profiles และไม่ปนกับรายชื่อพนักงาน
ไม่ต้องเพิ่ม Secret ใหม่
