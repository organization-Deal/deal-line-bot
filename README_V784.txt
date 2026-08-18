v7.84 — Subscription Usage Detail Backend

เพิ่ม usageDetail ใน GET /api/subscription:
- quota used / limit / remaining
- AI used / limit / remaining
- ใช้รายการไปกับ LINE / บันทึกเอง / ตั้งเบิกคู่ค้า / Gmail / อื่น ๆ
- แยกจำนวนตามธุรกิจในบัญชี
- recent usage 20 รายการล่าสุด
- ไม่เปลี่ยนกฎการคิดโควตาเดิม

อัป 2 ไฟล์เข้า root deal-line-bot:
1) apply-v784-subscription-usage-detail.mjs
2) wrangler.toml
