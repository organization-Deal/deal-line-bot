STRIPE BILLING V7.74 — ขั้นตอนหลังอัป GitHub

1) Cloudflare Worker: accoutingsuppor02
   Settings > Variables and Secrets > Add secret
   ชื่อ: STRIPE_SECRET_KEY
   ค่า: sk_live_... จาก Stripe
   ห้ามใส่ sk_live_ ลง GitHub

2) Deploy LINE Bot แล้วเปิด:
   https://accoutingsuppor02.organization-23c.workers.dev/stripe/health
   ต้องเห็น secretConfigured:true

3) Stripe > Developers > Webhooks > Add endpoint
   Endpoint URL:
   https://accoutingsuppor02.organization-23c.workers.dev/stripe/webhook

   เลือก Events:
   - checkout.session.completed
   - invoice.paid
   - invoice.payment_failed
   - customer.subscription.updated
   - customer.subscription.deleted

4) Stripe จะให้ Signing secret ขึ้นต้น whsec_
   กลับไป Cloudflare Worker > Variables and Secrets > Add secret
   ชื่อ: STRIPE_WEBHOOK_SECRET
   ค่า: whsec_...

5) เปิด /stripe/health ใหม่
   ต้องเห็น secretConfigured:true และ webhookConfigured:true

6) Stripe > Settings > Billing > Customer portal
   เปิดอย่างน้อย:
   - Update payment method
   - Cancel subscription
   - Switch subscription plan / price สำหรับ Lite, Pro, Business

พฤติกรรมระบบ:
- ช่วง Trial 30 วัน: เลือกแพ็กได้ แต่ไม่เก็บบัตรและไม่ตัดเงิน
- หลัง Trial/Free: เลือกแพ็กเสียเงิน -> Stripe Checkout
- ลูกค้าที่มี Subscription อยู่แล้ว: เปลี่ยน/ยกเลิกผ่าน Customer Portal ป้องกันสมัครซ้ำ
- Webhook เป็นผู้ยืนยันสิทธิ์แพ็กหลัง Stripe แจ้งว่าจ่ายสำเร็จ
