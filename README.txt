LINE BOT v7.85.1 — CI AUDIT HOTFIX

ปัญหาจาก Build Log:
Error: v7.85 CI audit failed: approverIndigo

สาเหตุ:
src/approver-line.js ไม่มีความจำเป็นต้องมี literal #4F46E5 เสมอ
แต่ audit เดิมบังคับ approver.includes("#4F46E5") ทำให้ build fail
แม้ไฟล์นั้นจะไม่มี primary button ที่ผิด CI

วิธีใช้:
1. วาง apply-v785-ci-unified.mjs ทับไฟล์ชื่อเดิมที่ root ของ deal-line-bot
2. ไม่ต้องแก้ wrangler.toml
3. Commit / Upload
4. Deploy ใหม่

Audit ใหม่:
- ไม่บังคับว่า approver-line.js ต้องมี #4F46E5
- จะ fail เฉพาะเมื่อพบ primary button ที่ยังใช้ legacy dark/green/orange
- node --check ผ่านแล้ว
