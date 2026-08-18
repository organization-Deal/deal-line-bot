v7.83 — Fix VAT 7% checkbox UI

ปัญหา:
CSS ของฟอร์มตั้งเบิกใช้ .f input กับ input ทุกชนิด
ทำให้ checkbox VAT โดน width:100% และ min-height:44px จึงกลายเป็นสี่เหลี่ยมใหญ่

แก้:
- Text input/select/textarea ยังใช้ layout เดิม
- checkbox/radio ถูกแยกออกจาก CSS ช่องกรอก
- VAT checkbox เป็น 16x16 px
- checkbox กับข้อความ "มี VAT 7%" อยู่บรรทัดเดียวกัน

วิธีอัป:
อัป 2 ไฟล์นี้ไว้ที่ root ของ deal-line-bot
1) apply-v783-vendor-requisition-vat-checkbox-ui.mjs
2) wrangler.toml

จากนั้นรอ Cloudflare deploy เขียว แล้ว Ctrl+Shift+R
