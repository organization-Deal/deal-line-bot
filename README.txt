อัปไฟล์ 2 ไฟล์นี้ไว้ที่ Root ของ Repo deal-line-bot:
- wrangler.toml
- package.json

ก่อนอัป เช็กใน src/index.js ว่ามี:
export { MultiExpenseSession } from "./multi-expense.js";

และใน src/multi-expense.js ว่ามี:
export class MultiExpenseSession {

จากนั้น Commit 2 ไฟล์พร้อมกัน แล้วรอ Cloudflare Build.
ห้ามเก็บทั้ง [[migrations]] และ [exports.MultiExpenseSession] พร้อมกัน
