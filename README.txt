แก้ Build error:
No matching export in src/approver-line.js for import listLineWorkspacesForAccount

ทำตามนี้:
1) อัป apply-v736-build-compat.mjs ที่ root ของ deal-line-bot
2) Cloudflare Deploy command เปลี่ยนเป็น:
node apply-line-card-review-fix.mjs && node apply-v736-build-compat.mjs && npx wrangler deploy
3) Retry build

ไม่ต้องแก้ Build command และไม่ต้องแก้ src/index.js เพิ่ม
