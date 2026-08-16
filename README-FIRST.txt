V7.70.1 — REVIEW STATE RESCUE

Upload to organization-Deal/deal-line-bot ROOT:
1. apply-v7701-review-state-rescue.mjs
2. wrangler.toml (replace)

Keep apply-v770-multi-image-no-silent-loss.mjs in the repo.
Dashboard does not need a deploy.

This fixes the Review page that opens but stays at:
฿—
กำลังโหลด
พร้อม 0
0 เอกสาร

After this:
- Successful state load shows the real amount/items.
- Failed state load shows a persistent error instead of silently staying blank.
- Old and v7.70 session shapes both work.
- Save is blocked while images are still processing or failed.
- Cloudflare build now generates the REAL Review HTML, extracts its browser JS, and runs node --check on it.

Build log must contain:
✅ REVIEW_STATE_RESCUE_V7_70_1_20260816 ready
✅ Review page no longer stays silently at ฿— / กำลังโหลด
✅ old and v7.70 Durable Object state shapes are supported
✅ received / processed / failed / inflight counts render safely
✅ Save is blocked while images are incomplete
✅ state API errors remain visible on screen
✅ generated Review HTML browser JavaScript passed node --check
