import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const files = {
  index: path.join(root, 'src/index.js'),
  oauth: path.join(root, 'src/oauth.js'),
  multi: path.join(root, 'src/multi-expense.js'),
  batches: path.join(root, 'src/batches.js'),
  adminOps: path.join(root, 'src/admin-ops.js'),
};

for (const [name, file] of Object.entries(files)) {
  if (!fs.existsSync(file)) throw new Error(`ไม่พบ ${file} — ให้รันสคริปต์นี้ที่ root ของ deal-line-bot`);
}

function mustReplace(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`หา anchor ไม่เจอ: ${label}\nหยุดก่อนเพื่อไม่แก้ผิดเวอร์ชัน`);
  return text.replace(from, to);
}

function patchIndex() {
  let s = fs.readFileSync(files.index, 'utf8');
  s = mustReplace(
    s,
    '} from "./accounting-suite.js";\n\nexport { MultiExpenseSession } from "./multi-expense.js";',
    '} from "./accounting-suite.js";\nimport { handleAdminOps, recordOpsError, recordOpsHeartbeat } from "./admin-ops.js";\n\nexport { MultiExpenseSession } from "./multi-expense.js";',
    'admin ops import'
  );
  s = mustReplace(
    s,
    '{ type: "text", text: "เชื่อม Google ก่อนใช้งาน 🔗", weight: "bold", size: "md", color: "#1F6E56" },',
    '{ type: "text", text: "เชื่อม Google ก่อนใช้งาน", weight: "bold", size: "md", color: "#1D1D1F" },',
    'connect card title'
  );
  s = mustReplace(
    s,
    '{ type: "button", style: "primary", color: "#1F6E56", height: "sm",\n          action: { type: "uri", label: "เชื่อม Google", uri: url } },',
    '{ type: "button", style: "primary", color: "#1D1D1F", height: "sm",\n          action: { type: "uri", label: "เชื่อม Google", uri: url } },',
    'connect card button'
  );
  // v7.10: กันรวม "ใบเบิกหลักเดิม" ซ้ำ เฉพาะ /api/batch-close
  // ไม่แตะ src/batches.js core และไม่กระทบ GET /api/batches
  const batchCloseOld = `          const out = await createReimbursementBatches(env, key, sheetId, token, {
            type: b.type === "ด่วน" ? "ด่วน" : "ปกติ",
            payerKey: b.payerKey || "",
            expenseIds: Array.isArray(b.expenseIds) ? b.expenseIds : [],
            batchIds: Array.isArray(b.batchIds) ? b.batchIds : [],
            note: b.note || "สร้างหรือรวมใบเบิกด้วยตนเองจาก Dashboard",
          });`;
  const batchCloseNew = `          const requestedExistingBatchIds = Array.isArray(b.batchIds)
            ? [...new Set(b.batchIds.map((id) => String(id || "").trim()).filter(Boolean))]
            : [];
          if (requestedExistingBatchIds.length) {
            return cors(json({
              ok: false,
              reason: "already_batched_items_not_mergeable",
              message: "ใบเบิกที่รวมแล้ว ไม่สามารถนำไปรวมเป็นใบเบิกใหม่ซ้ำได้",
              blockedBatchIds: requestedExistingBatchIds,
            }, 409));
          }
          const out = await createReimbursementBatches(env, key, sheetId, token, {
            type: b.type === "ด่วน" ? "ด่วน" : "ปกติ",
            payerKey: b.payerKey || "",
            expenseIds: Array.isArray(b.expenseIds) ? b.expenseIds : [],
            batchIds: [],
            note: b.note || "สร้างใบเบิกด้วยตนเองจาก Dashboard",
          });`;
  s = mustReplace(s, batchCloseOld, batchCloseNew, 'batch-close duplicate guard');

  // v7.12 COMMERCIAL PILOT — trial 60 วันต่อบัญชี + สิทธิ์ Business
  s = mustReplace(
    s,
    `function configuredBetaEnd(env, startedAt = Date.now()) {\n  const fixed = String(env.BETA_FREE_UNTIL || "").trim();\n  if (fixed) {\n    const parsed = Date.parse(fixed);\n    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();\n  }\n  const days = Math.max(1, Number(env.BETA_TRIAL_DAYS || 60));\n  return new Date(Number(startedAt) + days * 86400000).toISOString();\n}`,
    `function configuredBetaEnd(env, startedAt = Date.now()) {\n  // Commercial Pilot: ทุกบัญชีได้ Trial ของตัวเอง นับจากวันเริ่มใช้งานครั้งแรก\n  // ไม่ใช้วันสิ้นสุด Beta กลางร่วมกันอีกต่อไป\n  const days = Math.max(1, Number(env.BETA_TRIAL_DAYS || 60));\n  return new Date(Number(startedAt) + days * 86400000).toISOString();\n}`,
    'per-account 60-day trial'
  );
  s = mustReplace(s, '      plan: "pro",', '      plan: "business",', 'new trial business plan');
  s = mustReplace(
    s,
    `  // Beta จบแล้วและยังไม่ได้เปิดแพ็กเสียเงิน → กลับ Free อัตโนมัติ\n  if (rec.status === "beta" && Number.isFinite(Date.parse(rec.trialEndsAt || "")) && Date.parse(rec.trialEndsAt) <= now) {`,
    `  // migrate บัญชี Beta เดิมจากวันสิ้นสุดกลาง → 60 วันนับจากวันเริ่มของบัญชีนั้น\n  if (rec.status === "beta") {\n    const startMs = Date.parse(rec.trialStartedAt || rec.createdAt || "");\n    if (Number.isFinite(startMs)) {\n      const expectedEnd = configuredBetaEnd(env, startMs);\n      if (rec.trialEndsAt !== expectedEnd || rec.plan !== "business") {\n        rec = { ...rec, plan: "business", trialEndsAt: expectedEnd, trialMode: "business_60d", trialMigratedAt: new Date(now).toISOString() };\n        await env.KV.put(storageKey, JSON.stringify(rec));\n      }\n    }\n  }\n\n  // Trial จบแล้วและยังไม่ได้เปิดแพ็กเสียเงิน → กลับ Free อัตโนมัติ\n  if (rec.status === "beta" && Number.isFinite(Date.parse(rec.trialEndsAt || "")) && Date.parse(rec.trialEndsAt) <= now) {`,
    'migrate existing beta records'
  );
  s = mustReplace(s, '  const effectivePlan = betaActive ? "pro" : (rec.status === "active" && SUBSCRIPTION_PLANS[rec.plan] ? rec.plan : "free");', '  const effectivePlan = betaActive ? "business" : (rec.status === "active" && SUBSCRIPTION_PLANS[rec.plan] ? rec.plan : "free");', 'trial effective business');
  s = mustReplace(s, '  const limit = betaActive ? null : plan.documentLimit;', '  const limit = plan.documentLimit;', 'trial business document limit');
  s = mustReplace(s, '  const businessAccessAllowed = betaActive || businessIndex < businessLimit;', '  const businessAccessAllowed = businessIndex < businessLimit;', 'trial business count limit');
  s = mustReplace(s, '  const documentBlocked = Boolean(enforcement && !betaActive && limit && usage.documents >= limit);', '  const documentBlocked = Boolean(enforcement && limit && usage.documents >= limit);', 'trial document enforcement');
  s = mustReplace(s, '    planName: betaActive ? "Beta ฟรี · สิทธิ์ Pro" : plan.name,', '    planName: betaActive ? "ทดลองใช้ Business ฟรี" : plan.name,', 'trial plan name');
  s = mustReplace(
    s,
    'return { ok: false, reason: "business_limit", message: limit <= 1 ? "เพิ่มธุรกิจได้ตั้งแต่แพ็กเกจ Pro" : `สิทธิ์ปัจจุบันเพิ่มได้สูงสุด ${limit} ธุรกิจ` };',
    'return { ok: false, reason: "business_limit", message: `สิทธิ์แพ็กเกจปัจจุบันเพิ่มได้สูงสุด ${limit} ธุรกิจ` };',
    'business limit generic message'
  );
  s = mustReplace(
    s,
    `    return textMsg(\`ธุรกิจนี้อยู่นอกสิทธิ์แพ็กเกจปัจจุบัน\nแพ็กเกจ Pro รองรับสูงสุด 3 ธุรกิจ\nข้อมูลเดิมยังเปิดดูและจัดการได้ แต่การรับเอกสารใหม่ของธุรกิจนี้ถูกพักไว้\n\nอัปเกรดแพ็กเกจ:\n\${upgradeUrl}\`);`,
    `    return textMsg(\`ธุรกิจนี้อยู่นอกสิทธิ์แพ็กเกจปัจจุบัน\nสิทธิ์ปัจจุบันรองรับสูงสุด \${Number(snapshot?.businessLimit || 1)} ธุรกิจ\nข้อมูลเดิมยังเปิดดูและจัดการได้ แต่การรับเอกสารใหม่ของธุรกิจนี้ถูกพักไว้\n\nเลือกแพ็กเกจ:\n\${upgradeUrl}\`);`,
    'quota business message'
  );

  // Public Pilot request form — เก็บคำขอใน KV เพื่อให้ทีมเพิ่ม Gmail Test User แบบ manual
  s = mustReplace(
    s,
    'export default {\n  async fetch(request, env, ctx) {',
    `function pilotEsc(v) {\n  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");\n}\nfunction pilotPage(env, message = "") {\n  const worker = String(env.WORKER_URL || "").replace(/\\/$/, "");\n  return new Response(\`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>ขอทดลองใช้ · รับจ่ายแบบไม่จำกัด</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font-family:system-ui,-apple-system,sans-serif;padding:28px 16px}.wrap{max-width:620px;margin:auto}.card{background:#fff;border:1px solid #e5e5e7;border-radius:26px;padding:28px;box-shadow:0 16px 48px rgba(0,0,0,.07)}.eyebrow{font-size:12px;color:#86868b;font-weight:700;letter-spacing:.08em}h1{font-size:30px;margin:8px 0 8px}p{color:#6e6e73;line-height:1.65;margin:0 0 24px}.trial{background:#f5f5f7;border-radius:16px;padding:14px 16px;margin:0 0 20px;font-size:14px;line-height:1.55}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}label{display:grid;gap:7px;font-size:13px;font-weight:650}label.full{grid-column:1/-1}input,textarea{width:100%;border:1px solid #d2d2d7;border-radius:13px;padding:13px 14px;font:inherit;background:#fff}textarea{min-height:90px;resize:vertical}button{width:100%;border:0;border-radius:14px;background:#1d1d1f;color:#fff;font-weight:750;font-size:15px;padding:14px;margin-top:18px}.note{font-size:12px;color:#86868b;margin-top:14px}.msg{background:#fff7e8;border:1px solid #f2d49c;border-radius:14px;padding:12px 14px;margin-bottom:16px;font-size:13px}@media(max-width:600px){.grid{grid-template-columns:1fr}.card{padding:22px}h1{font-size:27px}}</style></head><body><main class="wrap"><div class="card"><div class="eyebrow">INVITE-ONLY PILOT</div><h1>ขอทดลองใช้รับจ่ายแบบไม่จำกัด</h1><p>ช่วง Pilot เปิดให้ผ่านการแนะนำแบบจำกัดจำนวน ทีมงานจะตรวจอีเมลและเปิดสิทธิ์ให้ก่อนเริ่มใช้งาน</p><div class="trial"><b>ทดลองใช้ Business ฟรี 60 วัน</b><br>เริ่มนับเมื่อเริ่มใช้งานระบบจริง · สูงสุด 1,500 รายการ/เดือน · 10 ธุรกิจ<br>Gmail Automation ยังเป็น Beta และต้องเพิ่มอีเมลเป็น Test User ก่อน</div>\${message ? \`<div class="msg">\${pilotEsc(message)}</div>\` : ""}<form method="post" action="\${worker}/pilot/request"><div class="grid"><label>ชื่อผู้ติดต่อ<input name="contactName" required maxlength="100" autocomplete="name"></label><label>ชื่อธุรกิจ<input name="businessName" required maxlength="160"></label><label class="full">อีเมล Google ที่จะใช้เชื่อมระบบ<input type="email" name="email" required maxlength="200" autocomplete="email"></label><label>เบอร์ / LINE ติดต่อ<input name="contact" maxlength="120"></label><label>ผู้แนะนำ<input name="referrer" maxlength="120" placeholder="ถ้ามี"></label><label class="full">ข้อมูลเพิ่มเติม<textarea name="note" maxlength="1000" placeholder="เช่น จำนวนบริษัท / ปริมาณเอกสารต่อเดือน"></textarea></label><label style="position:absolute;left:-9999px">Website<input name="website" tabindex="-1" autocomplete="off"></label></div><button type="submit">ส่งคำขอทดลองใช้</button><div class="note">การส่งฟอร์มยังไม่เริ่มนับ 60 วัน ทีมงานจะเริ่ม Trial เมื่อบัญชีเริ่มใช้งานระบบจริง</div></form></div></main></body></html>\`, { headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"} });\n}\nasync function savePilotRequest(env, request) {\n  const form = await request.formData();\n  if (String(form.get("website") || "").trim()) return pilotPage(env, "รับคำขอแล้ว");\n  const email = String(form.get("email") || "").trim().toLowerCase().slice(0, 200);\n  const contactName = String(form.get("contactName") || "").trim().slice(0, 100);\n  const businessName = String(form.get("businessName") || "").trim().slice(0, 160);\n  const contact = String(form.get("contact") || "").trim().slice(0, 120);\n  const referrer = String(form.get("referrer") || "").trim().slice(0, 120);\n  const note = String(form.get("note") || "").trim().slice(0, 1000);\n  if (!contactName || !businessName || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return pilotPage(env, "กรอกชื่อ ธุรกิจ และอีเมล Google ให้ครบ");\n  const id = \`PILOT-\${Date.now()}-\${crypto.randomUUID().slice(0,8)}\`;\n  const record = { id, status:"pending_google_test_user", contactName, businessName, email, contact, referrer, note, createdAt:new Date().toISOString() };\n  await env.KV.put(\`pilotreq:v1:\${id}\`, JSON.stringify(record), { expirationTtl: 60*60*24*365 });\n  return new Response(\`<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f7;color:#1d1d1f;font-family:system-ui,-apple-system,sans-serif;padding:20px}.card{max-width:520px;background:white;border-radius:26px;padding:32px;border:1px solid #e5e5e7;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,.07)}h1{font-size:26px}p{color:#6e6e73;line-height:1.65}.id{background:#f5f5f7;border-radius:12px;padding:10px;font-weight:700}</style><div class="card"><h1>รับคำขอแล้ว ✓</h1><p>ทีมงานจะนำอีเมล <b>\${pilotEsc(email)}</b> ไปเปิดสิทธิ์ Pilot / Gmail Test User และติดต่อกลับก่อนเริ่มใช้งาน</p><div class="id">\${pilotEsc(id)}</div><p>60 วันจะเริ่มนับเมื่อเริ่มใช้งานระบบจริง ไม่ได้นับจากเวลาที่ส่งฟอร์ม</p></div></html>\`, { headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"} });\n}\nasync function pilotAdminPage(env) {\n  const listed = await env.KV.list({ prefix:"pilotreq:v1:", limit:1000 });\n  const rows=[];\n  for (const key of listed.keys || []) { const r=await env.KV.get(key.name,"json").catch(()=>null); if(r)rows.push(r); }\n  rows.sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));\n  const trs=rows.map(r=>\`<tr><td>\${pilotEsc(new Date(r.createdAt).toLocaleString("th-TH",{timeZone:"Asia/Bangkok"}))}</td><td><b>\${pilotEsc(r.businessName)}</b><br><small>\${pilotEsc(r.contactName)}</small></td><td><a href="mailto:\${encodeURIComponent(r.email)}">\${pilotEsc(r.email)}</a><br><small>\${pilotEsc(r.contact)}</small></td><td>\${pilotEsc(r.referrer||"—")}</td><td>\${pilotEsc(r.status||"pending")}</td><td>\${pilotEsc(r.note||"")}</td></tr>\`).join("");\n  return new Response(\`<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:24px;background:#f5f5f7;color:#1d1d1f}h1{margin-top:0}.wrap{max-width:1200px;margin:auto;background:#fff;border:1px solid #e5e5e7;border-radius:22px;padding:22px;overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:11px;border-bottom:1px solid #eee;vertical-align:top}th{white-space:nowrap}a{color:#06c}</style><div class="wrap"><h1>Pilot requests (\${rows.length})</h1><table><thead><tr><th>เวลา</th><th>ธุรกิจ</th><th>อีเมล</th><th>ผู้แนะนำ</th><th>สถานะ</th><th>หมายเหตุ</th></tr></thead><tbody>\${trs||'<tr><td colspan="6">ยังไม่มีคำขอ</td></tr>'}</tbody></table></div></html>\`, { headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"} });\n}\n\nexport default {\n  async fetch(request, env, ctx) {`,
    'pilot form helpers'
  );
  s = mustReplace(
    s,
    '    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));',
    `    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));\n\n    if (url.pathname.startsWith("/admin/ops/")) return handleAdminOps(request, env, url);\n    if (url.pathname === "/pilot" && request.method === "GET") return pilotPage(env);\n    if (url.pathname === "/pilot/request" && request.method === "POST") return savePilotRequest(env, request);\n    if (url.pathname === "/admin/pilot-requests" && request.method === "GET") {\n      if (!adminOk(env, url)) return new Response("unauthorized", { status: 401 });\n      return pilotAdminPage(env);\n    }`,
    'pilot endpoints'
  );

  s = mustReplace(
    s,
    '        console.error(url.pathname, e);',
    '        console.error(url.pathname, e);\n        await recordOpsError(env, { area: `api:${url.pathname}`, tenant: key || "", error: e });',
    'api ops error hook'
  );
  s = mustReplace(
    s,
    '  console.error(`[${label}]`, error);',
    '  console.error(`[${label}]`, error);\n  await recordOpsError(env, { area: `line:${label}`, tenant: tenantKey(event?.source || {}), error });',
    'line ops error hook'
  );
  const oldScheduled = `  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.allSettled([
      syncConnectedGmailAccounts(env, {
        limit: Number(env.GMAIL_SYNC_BATCH || 5),
      }).catch(e => console.error("gmail scheduled sync", e)),
      runScheduledReimbursementBatches(env)
        .catch(e => console.error("reimbursement scheduled batch", e)),
    ]));
  },`;
  const newScheduled = `  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const startedAt = Date.now();
      const [gmail, reimbursement] = await Promise.allSettled([
        syncConnectedGmailAccounts(env, { limit: Number(env.GMAIL_SYNC_BATCH || 5) }),
        runScheduledReimbursementBatches(env),
      ]);
      if (gmail.status === "rejected") await recordOpsError(env, { area: "cron:gmail", error: gmail.reason });
      if (reimbursement.status === "rejected") await recordOpsError(env, { area: "cron:reimbursement", error: reimbursement.reason });
      await recordOpsHeartbeat(env, "cron", {
        durationMs: Date.now() - startedAt,
        gmail: gmail.status === "fulfilled" ? { ok: true, result: gmail.value } : { ok: false, error: String(gmail.reason?.message || gmail.reason || "") },
        reimbursement: reimbursement.status === "fulfilled" ? { ok: true, result: reimbursement.value } : { ok: false, error: String(reimbursement.reason?.message || reimbursement.reason || "") },
      });
    })());
  },`;
  s = mustReplace(s, oldScheduled, newScheduled, 'ops cron heartbeat');

  fs.writeFileSync(files.index, s);
}

function patchOauth() {
  let s = fs.readFileSync(files.oauth, 'utf8');
  const start = s.indexOf('function connectedCard(');
  const end = s.indexOf('\nexport async function handleCallback', start);
  if (start < 0 || end < 0) throw new Error('หา connectedCard ไม่เจอ');
  let b = s.slice(start, end);
  b = mustReplace(b, 'color: setupUrl ? undefined : "#12674F"', 'color: setupUrl ? undefined : "#1D1D1F"', 'connected dashboard button');
  b = mustReplace(
    b,
    '{ type: "text", text: linkedExisting ? "✅ เชื่อมธุรกิจเดิมสำเร็จ" : "✅ เชื่อม Google สำเร็จ", weight: "bold", size: "md", color: "#12674F" },',
    '{ type: "text", text: linkedExisting ? "เชื่อมธุรกิจเดิมสำเร็จ" : "เชื่อม Google สำเร็จ", weight: "bold", size: "md", color: "#1D1D1F" },',
    'connected card heading'
  );
  b = mustReplace(b, 'color: r.ok ? "#12674F" : "#B0B7BD"', 'color: r.ok ? "#3A3A3C" : "#B0B7BD"', 'connected card checks');
  s = s.slice(0, start) + b + s.slice(end);
  fs.writeFileSync(files.oauth, s);
}

function patchMulti() {
  let s = fs.readFileSync(files.multi, 'utf8');

  // คำบน Flex ให้เข้าใจว่า primary บันทึกจริง ส่วนเว็บเป็นทางเลือกสำหรับตรวจ/แก้
  if (s.includes('label: "ยืนยันรายการถูกต้อง"')) s = s.replace('label: "ยืนยันรายการถูกต้อง"', 'label: "ยืนยันและบันทึก"');
  if (s.includes('label: "ตรวจและแก้ไข"')) s = s.replace('label: "ตรวจและแก้ไข"', 'label: "ตรวจ / แก้ไขก่อน"');
  s = s.replace('รับจ่ายได้หมด · DOCUMENT REVIEW', 'รับจ่ายแบบไม่จำกัด · DOCUMENT REVIEW');

  // BUG FIX: reviewPage() เป็น template literal ซ้อน JS string อีกชั้น
  // source เดิมมี backslash 1 ชั้น ทำให้ HTML ที่ generate ออกมาเหลือ quote ไม่ escaped
  // ส่งผลให้ทั้ง <script> syntax error และ reload() ไม่เคยทำงาน
  for (const variable of ['g.id', 'im.id']) {
    const oldEsc = "\\''+" + variable + "+'\\'";
    const fixedEsc = "\\\\\\''+" + variable + "+'\\\\\\'";
    if (s.includes(oldEsc)) s = s.split(oldEsc).join(fixedEsc);
  }

  const oldReload = "async function reload(){try{D=await api('/state');render()}catch(e){toast(e.message)}}";
  const newReload = `let LOAD_RETRY=0,LOAD_TIMER=null;\nasync function reload(){\n  try{\n    D=await api('/state');\n    LOAD_RETRY=0;clearTimeout(LOAD_TIMER);\n    render();\n  }catch(e){\n    q('#topStatus').textContent='โหลดข้อมูลไม่สำเร็จ';\n    q('#sumVat').textContent='กำลังลองใหม่อัตโนมัติ · หรือกด “โหลดข้อมูลใหม่”';\n    toast(e.message||'โหลดข้อมูลไม่สำเร็จ');\n    clearTimeout(LOAD_TIMER);\n    const wait=Math.min(15000,2000*Math.max(1,++LOAD_RETRY));\n    LOAD_TIMER=setTimeout(reload,wait);\n  }\n}`;
  s = mustReplace(s, oldReload, newReload, 'review reload handler');
  fs.writeFileSync(files.multi, s);
}


function patchBatches() {
  let s = fs.readFileSync(files.batches, 'utf8');

  // v7.11: ตอนแนบสลิปจ่ายคืน ให้ legacy status ของรายการย่อยเปลี่ยนเป็น "จ่ายแล้ว" ด้วย
  // เดิมเขียน paid=true + batchStatus=จ่ายแล้ว แต่ status ยังค้าง "รอเบิก"
  const oldPaidPatch = `    patches.set(id, {
      paid: true,
      batchStatus: "จ่ายแล้ว",
      attOther: existingOther.join(", "),
      reimbursementSlipUrl: slipUrl,
      reimbursedAt: paidAt,
    });`;
  const newPaidPatch = `    patches.set(id, {
      status: "จ่ายแล้ว",
      paid: true,
      batchStatus: "จ่ายแล้ว",
      attOther: existingOther.join(", "),
      reimbursementSlipUrl: slipUrl,
      reimbursedAt: paidAt,
    });`;

  s = mustReplace(s, oldPaidPatch, newPaidPatch, 'sync paid expense status');
  fs.writeFileSync(files.batches, s);
}

function syntaxCheck() {
  for (const file of Object.values(files)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });

  // Regression test สำคัญ: parse JavaScript ที่ reviewPage generate ออกมาจริง
  const temp = path.join(path.dirname(files.multi), `.tmp-review-check-${Date.now()}.mjs`);
  const generated = path.join(os.tmpdir(), `review-generated-${Date.now()}.js`);
  try {
    fs.writeFileSync(temp, fs.readFileSync(files.multi, 'utf8') + '\nexport { reviewPage };\n');
    return import(pathToFileURL(temp).href + `?v=${Date.now()}`).then(({ reviewPage }) => {
      const html = reviewPage('syntax-test-sid', 'syntax-test-token', { WORKER_URL: 'https://example.invalid' });
      const match = html.match(/<script>([\s\S]*?)<\/script>/);
      if (!match) throw new Error('หา generated review script ไม่เจอ');
      fs.writeFileSync(generated, match[1]);
      execFileSync(process.execPath, ['--check', generated], { stdio: 'inherit' });
    }).finally(() => {
      try { fs.unlinkSync(temp); } catch {}
      try { fs.unlinkSync(generated); } catch {}
    });
  } catch (e) {
    try { fs.unlinkSync(temp); } catch {}
    try { fs.unlinkSync(generated); } catch {}
    throw e;
  }
}

patchIndex();
patchOauth();
patchMulti();
patchBatches();
await syntaxCheck();
console.log('\n✅ v7.13 Commercial Pilot + Internal Admin Ops applied');
console.log('Changed: src/index.js, src/oauth.js, src/multi-expense.js, src/batches.js + src/admin-ops.js · Admin monitoring enabled');
