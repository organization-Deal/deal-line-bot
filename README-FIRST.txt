V7.70 — MULTI IMAGE NO SILENT LOSS

อัปเฉพาะ Backend repo:
organization-Deal/deal-line-bot

ROOT:
1. apply-v770-multi-image-no-silent-loss.mjs
2. wrangler.toml (replace)

Dashboard ไม่ต้อง deploy สำหรับบั๊กนี้

ปัญหาที่พบ
LINE รับ 2 รูป แต่ถ้ารูปหนึ่งล้มก่อน OCR/addMultiImage:
- receivedCount = 2
- items = 1
- alarm แค่เพิ่ม failedCount
- Summary ใช้ items.length จึงบอก “1 เอกสาร”
- failedCount ไม่ถูกแสดง
=> รูปที่สองหายเงียบ

V7.70
- ผูกทุกภาพกับ LINE messageId ตั้งแต่ก่อน OCR
- Durable Object เก็บ pendingImages
- เกิน 15 วินาทีแล้วยังไม่เสร็จ => processingFailures
- LINE summary จะแสดง เช่น:
  “1 รายการ · รับ 2 รูป · อ่านแล้ว 1”
  พร้อมข้อความเตือน:
  “มี 1 รูปประมวลผลไม่สำเร็จ กรุณาส่งรูปที่หายไปใหม่ก่อนยืนยัน”
- ไม่อนุญาตให้ Confirm/Save ขณะที่มีรูปหาย
- ถ้ารูปที่ timeout มาช้าทีหลัง ระบบล้าง failure ให้อัตโนมัติ
- ป้องกัน webhook retry นับรูปซ้ำ
- หน้าตรวจเอกสารแสดง รับ/อ่าน/ล้มเหลว และปิดปุ่มบันทึกจนกว่ารูปจะครบ

Build ต้องเห็น:
✅ MULTI_IMAGE_NO_SILENT_LOSS_V7_70_20260816 ready
✅ every LINE image is tracked by messageId before OCR starts
✅ webhook retries do not inflate the received-image count
✅ image processing timeout is visible instead of silently disappearing
✅ summary shows received / processed / failed image counts
✅ incomplete image sets cannot be confirmed silently
✅ late image completion clears its temporary timeout failure
✅ review page disables Save until missing images are resent
