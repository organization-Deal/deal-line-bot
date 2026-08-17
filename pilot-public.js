// Public Pilot request flow — isolated from LINE webhook signature validation.
const PILOT_VERSION = "PUBLIC_PILOT_ROUTE_V7_72_TRIAL_30D_1000_20260817";

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function pilotPage(env, message = "") {
  const worker = String(env.WORKER_URL || "").replace(/\/$/, "");

  return html(`<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>ขอทดลองใช้ · รับจ่ายแบบไม่จำกัด</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f5f5f7;color:#1d1d1f;font-family:"IBM Plex Sans Thai",system-ui,-apple-system,sans-serif;padding:32px 16px}
.wrap{max-width:640px;margin:auto}
.card{background:#fff;border:1px solid #e5e5e7;border-radius:28px;padding:30px;box-shadow:0 18px 50px rgba(0,0,0,.06)}
.eyebrow{font-size:12px;color:#86868b;font-weight:700;letter-spacing:.08em}
h1{font-size:30px;line-height:1.15;margin:8px 0 10px}
p{color:#6e6e73;line-height:1.65;margin:0 0 22px}
.trial{background:#f5f5f7;border-radius:18px;padding:16px;margin-bottom:20px;line-height:1.55}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
label{display:grid;gap:7px;font-size:13px;font-weight:650}
.full{grid-column:1/-1}
input,textarea{width:100%;border:1px solid #d2d2d7;border-radius:14px;padding:13px 14px;font:inherit;background:#fff}
textarea{min-height:96px;resize:vertical}
button{width:100%;border:0;border-radius:15px;background:#1d1d1f;color:#fff;font-weight:750;font-size:15px;padding:15px;margin-top:18px}
.msg{background:#fff7e8;border:1px solid #f2d49c;border-radius:14px;padding:12px 14px;margin-bottom:16px}
.note{font-size:12px;color:#86868b;margin-top:13px}
@media(max-width:600px){.grid{grid-template-columns:1fr}.card{padding:22px}h1{font-size:27px}}
</style>
</head>
<body>
<main class="wrap"><section class="card">
<div class="eyebrow">PILOT PROGRAM</div>
<h1>ขอทดลองใช้ระบบ</h1>
<p>กรอกข้อมูลสั้น ๆ เพื่อให้ทีมงานเตรียมบัญชีทดลองและตั้งค่าระบบให้เหมาะกับธุรกิจของคุณ</p>
<div class="trial"><b>ทดลองใช้แพ็กเกจ Business ฟรี 30 วัน</b><br>เริ่มนับเมื่อเริ่มใช้งานจริง · สูงสุด 1,000 รายการ/เดือน · AI อ่านเอกสารอัตโนมัติ 100 ใบ · ใช้ได้สูงสุด 2 บริษัท</div>
${message ? `<div class="msg">${esc(message)}</div>` : ""}
<form method="post" action="${esc(worker)}/pilot/request">
<div class="grid">
<label>ชื่อผู้ติดต่อ<input name="contactName" required maxlength="100" autocomplete="name"></label>
<label>ชื่อบริษัท / กิจการ<input name="businessName" required maxlength="160"></label>
<label class="full">Gmail / Google Account ที่จะใช้เชื่อมระบบ<input type="email" name="email" required maxlength="200" autocomplete="email"></label>
<label>เบอร์โทรศัพท์<input name="phone" maxlength="80"></label>
<label>LINE ID<input name="lineId" maxlength="100"></label>
<label class="full">ข้อมูลติดต่อเพิ่มเติม<input name="contact" maxlength="160"></label>
<label>จำนวนพนักงานโดยประมาณ<input name="employeeCount" maxlength="80"></label>
<label>เอกสาร/รายการต่อเดือนโดยประมาณ<input name="monthlyDocuments" maxlength="80"></label>
<label class="full">ปัจจุบันบริษัทจัดการเบิกจ่ายด้วยวิธีไหน<input name="currentProcess" maxlength="200"></label>
<label class="full">ปัญหาที่อยากให้ระบบช่วยแก้<textarea name="problem" maxlength="800"></textarea></label>
<label class="full">ฟีเจอร์ที่สนใจ<input name="interests" maxlength="500"></label>
<label>ผู้แนะนำ<input name="referrer" maxlength="120"></label>
<label style="position:absolute;left:-9999px">Website<input name="website" tabindex="-1" autocomplete="off"></label>
</div>
<button type="submit">ส่งคำขอทดลองใช้</button>
<div class="note">การส่งฟอร์มยังไม่เริ่มนับ 30 วัน ทีมงานจะเริ่ม Trial เมื่อเริ่มใช้งานระบบจริง</div>
</form>
</section></main>
</body></html>`);
}

function field(form, key, max = 200) {
  return String(form.get(key) || "").trim().slice(0, max);
}

export async function savePilotRequest(env, request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return pilotPage(env, "ไม่สามารถอ่านข้อมูลจากฟอร์มได้ กรุณาลองส่งใหม่");
  }

  if (field(form, "website", 200)) {
    return pilotPage(env, "รับคำขอแล้ว");
  }

  const contactName = field(form, "contactName", 100);
  const businessName = field(form, "businessName", 160);
  const email = field(form, "email", 200).toLowerCase();

  if (!contactName || !businessName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return pilotPage(env, "กรอกชื่อผู้ติดต่อ ชื่อธุรกิจ และ Gmail/Google Account ให้ครบ");
  }

  const phone = field(form, "phone", 80);
  const lineId = field(form, "lineId", 100);
  const directContact = field(form, "contact", 160);
  const contact = [phone && `โทร ${phone}`, lineId && `LINE ${lineId}`, directContact]
    .filter(Boolean).join(" · ").slice(0, 240);

  const detailParts = [
    field(form, "employeeCount", 80) && `พนักงาน: ${field(form, "employeeCount", 80)}`,
    field(form, "monthlyDocuments", 80) && `เอกสาร/เดือน: ${field(form, "monthlyDocuments", 80)}`,
    field(form, "currentProcess", 200) && `วิธีปัจจุบัน: ${field(form, "currentProcess", 200)}`,
    field(form, "problem", 800) && `ปัญหา: ${field(form, "problem", 800)}`,
    field(form, "interests", 500) && `สนใจ: ${field(form, "interests", 500)}`,
    field(form, "note", 1000),
  ].filter(Boolean);

  const id = `PILOT-${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
  const record = {
    id,
    status: "pending_google_test_user",
    contactName,
    businessName,
    email,
    contact,
    phone,
    lineId,
    referrer: field(form, "referrer", 120),
    note: detailParts.join("\n").slice(0, 1800),
    source: "public_pilot_form",
    version: PILOT_VERSION,
    createdAt: new Date().toISOString(),
  };

  await env.KV.put(
    `pilotreq:v1:${id}`,
    JSON.stringify(record),
    { expirationTtl: 60 * 60 * 24 * 365 }
  );

  return html(`<!doctype html>
<html lang="th"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>รับคำขอแล้ว</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f7;color:#1d1d1f;font-family:"IBM Plex Sans Thai",system-ui,-apple-system,sans-serif;padding:20px}
.card{width:min(520px,100%);background:#fff;border:1px solid #e5e5e7;border-radius:28px;padding:34px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.06)}
.icon{width:54px;height:54px;border-radius:50%;background:#eaf7ee;color:#188038;display:grid;place-items:center;margin:auto;font-size:26px;font-weight:800}
h1{font-size:28px;margin:16px 0 8px}
p{color:#6e6e73;line-height:1.65}
.id{background:#f5f5f7;border-radius:14px;padding:11px 12px;font-weight:700;margin:18px 0}
</style></head>
<body><section class="card">
<div class="icon">✓</div>
<h1>รับคำขอแล้ว</h1>
<p>ทีมงานได้รับคำขอของ <b>${esc(businessName)}</b> แล้ว และจะใช้บัญชี <b>${esc(email)}</b> สำหรับเตรียมระบบทดลอง</p>
<div class="id">${esc(id)}</div>
<p>30 วันจะเริ่มนับเมื่อเริ่มใช้งานระบบจริง ไม่ได้นับจากเวลาที่ส่งฟอร์ม</p>
</section></body></html>`);
}

export function pilotHealth() {
  return { ok: true, version: PILOT_VERSION };
}
