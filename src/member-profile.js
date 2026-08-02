import { getUserToken, buildConnectUrl } from "./oauth.js";
import { readSettings, writeSettings } from "./sheets.js";

const SESSION_TTL = 30 * 60;

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function parseTeamMembers(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function norm(v) {
  return String(v || "").trim().toLowerCase();
}

export function findMemberProfile(settings = {}, { lineUserId = "", name = "" } = {}) {
  const members = parseTeamMembers(settings.team_members);
  return members.find((m) =>
    (lineUserId && norm(m.lineUserId || m.payerId) === norm(lineUserId)) ||
    (name && norm(m.name) === norm(name))
  ) || null;
}

export function missingMemberFields(profile = {}) {
  const missing = [];
  if (!String(profile.name || "").trim()) missing.push("ชื่อ–นามสกุล");
  if (!String(profile.bank || "").trim()) missing.push("ธนาคาร");
  if (!String(profile.accountNo || "").trim()) missing.push("เลขบัญชี");
  if (!String(profile.accountName || "").trim()) missing.push("ชื่อบัญชี");
  return missing;
}

export function memberProfileComplete(profile = {}) {
  return missingMemberFields(profile).length === 0;
}

export async function getMemberProfile(env, tenant, sheetId, token, lineUserId, displayName = "") {
  let settings = await readSettings(env, sheetId, token);
  let profile = findMemberProfile(settings, { lineUserId, name: displayName });

  // ถ้า Admin เตรียมข้อมูลไว้ด้วยชื่อ แต่ยังไม่ได้ผูก LINE ให้ผูกอัตโนมัติเมื่อเจ้าตัวตั้งเบิกครั้งแรก
  if (profile && lineUserId && !String(profile.lineUserId || profile.payerId || "").trim()) {
    const members = parseTeamMembers(settings.team_members);
    const idx = members.findIndex((m) => norm(m.name) === norm(profile.name));
    if (idx >= 0) {
      members[idx] = { ...members[idx], lineUserId, updatedAt: new Date().toISOString() };
      settings = await writeSettings(env, sheetId, {
        ...settings,
        team_members: JSON.stringify(members),
      }, token);
      profile = members[idx];
    }
  }

  return {
    settings,
    profile: profile || {
      name: displayName || "",
      role: "พนักงาน",
      lineUserId: lineUserId || "",
      bank: "",
      accountNo: "",
      accountName: "",
    },
  };
}

export async function createMemberOnboardingUrl(env, data = {}) {
  const token = crypto.randomUUID().replaceAll("-", "");
  await env.KV.put(`member-onboard:${token}`, JSON.stringify({
    tenant: data.tenant || "",
    lineUserId: data.lineUserId || "",
    displayName: data.displayName || "",
    pendingId: data.pendingId || "",
    createdAt: new Date().toISOString(),
  }), { expirationTtl: SESSION_TTL });

  const base = String(env.WORKER_URL || "").replace(/\/$/, "");
  return `${base}/member/onboard?t=${encodeURIComponent(token)}`;
}

function pageShell(content, title = "ข้อมูลผู้เบิก") {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<style>
:root{--bg:#f5f5f7;--card:#fff;--ink:#111;--muted:#6e6e73;--line:#e5e5ea;--accent:#111;--ok:#248a3d}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:560px;margin:0 auto;padding:24px 16px 48px}.brand{font-weight:800;font-size:14px;letter-spacing:-.2px;margin-bottom:18px}.card{background:var(--card);border:1px solid rgba(0,0,0,.06);border-radius:24px;padding:24px;box-shadow:0 14px 40px rgba(0,0,0,.06)}
h1{font-size:28px;line-height:1.15;letter-spacing:-.8px;margin:0 0 8px}p{color:var(--muted);font-size:14px;line-height:1.65;margin:0 0 22px}.field{margin:0 0 15px}.field label{display:block;font-size:12px;font-weight:700;margin:0 0 7px}.field input,.field select{width:100%;height:48px;border:1px solid var(--line);border-radius:13px;padding:0 14px;background:#fff;color:var(--ink);font:inherit;outline:none}.field input:focus,.field select:focus{border-color:#111;box-shadow:0 0 0 3px rgba(0,0,0,.06)}
.row{display:grid;grid-template-columns:1fr 1.25fr;gap:12px}.note{background:#f5f5f7;border-radius:14px;padding:13px 14px;font-size:12px;color:var(--muted);line-height:1.55;margin:8px 0 18px}.btn{width:100%;height:50px;border:0;border-radius:14px;background:var(--accent);color:#fff;font-size:15px;font-weight:800;cursor:pointer}.btn.secondary{background:#fff;color:#111;border:1px solid var(--line);margin-top:10px}.success{text-align:center;padding:12px 0}.check{width:58px;height:58px;border-radius:50%;background:#eaf7ed;color:var(--ok);display:grid;place-items:center;font-size:28px;margin:0 auto 18px}.error{padding:12px 14px;background:#fff0ef;color:#b42318;border-radius:12px;font-size:13px;margin-bottom:16px}
@media(max-width:520px){.row{grid-template-columns:1fr}.card{padding:20px;border-radius:20px}h1{font-size:25px}}
</style>
</head><body><div class="wrap"><div class="brand">รับจ่ายได้หมด · Business Finance</div>${content}</div></body></html>`;
}

function invalidPage(message = "ลิงก์หมดอายุหรือถูกใช้แล้ว") {
  return new Response(pageShell(`<div class="card success"><div class="check" style="background:#f2f2f7;color:#6e6e73">!</div><h1>${esc(message)}</h1><p>กลับไปที่ LINE แล้วกดบันทึกรายการใหม่อีกครั้ง</p><button class="btn secondary" onclick="history.back()">กลับ</button></div>`, "ลิงก์หมดอายุ"), {
    status: 410,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}


function reconnectPage(env, url, tenant, message = "สิทธิ์ Google หมดอายุหรือเชื่อมต่อไม่สมบูรณ์") {
  const connectUrl = buildConnectUrl(env, url.origin, tenant);
  return new Response(pageShell(`<div class="card success">
    <div class="check" style="background:#fff4e5;color:#b54708">!</div>
    <h1>${esc(message)}</h1>
    <p>ระบบยังเขียนข้อมูลลง Google Sheet ไม่ได้ ให้เชื่อม Google ใหม่หนึ่งครั้ง แล้วกลับมาเปิดลิงก์กรอกข้อมูลเดิมอีกครั้ง</p>
    <a class="btn" style="display:grid;place-items:center;text-decoration:none" href="${esc(connectUrl)}">เชื่อม Google ใหม่</a>
    <button class="btn secondary" onclick="location.reload()">ลองอีกครั้ง</button>
  </div>`, "เชื่อม Google ใหม่"), {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function saveErrorPage(message = "บันทึกข้อมูลไม่สำเร็จ") {
  return new Response(pageShell(`<div class="card success">
    <div class="check" style="background:#fff0ef;color:#b42318">!</div>
    <h1>บันทึกข้อมูลไม่สำเร็จ</h1>
    <p>${esc(message)}<br>ข้อมูลที่กรอกยังไม่ถูกลบ สามารถย้อนกลับแล้วลองบันทึกใหม่ได้</p>
    <button class="btn" onclick="history.back()">กลับไปแก้ไข</button>
  </div>`, "บันทึกไม่สำเร็จ"), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function formPage(session, profile = {}, error = "") {
  const bankOptions = ["SCB", "KBANK", "KTB", "BBL", "BAY", "TTB", "GSB", "CIMB", "UOB", "KKP", "LH BANK", "อื่น ๆ"];
  const currentBank = String(profile.bank || "").trim();
  const customBank = currentBank && !bankOptions.some((b) => norm(b) === norm(currentBank))
    ? [`<option value="${esc(currentBank)}" selected>${esc(currentBank)}</option>`]
    : [];
  const options = [`<option value="">เลือกธนาคาร</option>`, ...customBank, ...bankOptions.map((b) => `<option value="${esc(b)}"${norm(b) === norm(currentBank) ? " selected" : ""}>${esc(b)}</option>`)].join("");
  const body = `<div class="card">
    <h1>ตั้งค่าบัญชีรับเงินครั้งแรก</h1>
    <p>กรอกเพียงครั้งเดียวสำหรับบริษัทนี้ หลังจากนั้นตั้งเบิกได้ทันทีโดยไม่ต้องกรอกเลขบัญชีซ้ำทุกครั้ง</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ""}
    <form method="post" action="/member/onboard?t=${esc(session.token)}">
      <div class="field"><label>ชื่อ–นามสกุล</label><input name="name" value="${esc(profile.name || session.displayName || "")}" autocomplete="name" required></div>
      <div class="field"><label>ชื่อเล่น (ไม่บังคับ)</label><input name="nickname" value="${esc(profile.nickname || "")}" autocomplete="nickname"></div>
      <div class="field"><label>แผนก / บทบาท (ไม่บังคับ)</label><input name="role" value="${esc(profile.role || "พนักงาน")}" placeholder="เช่น ฝ่ายขาย, Operation"></div>
      <div class="row">
        <div class="field"><label>ธนาคาร</label><select name="bank" required>${options}</select></div>
        <div class="field"><label>เลขบัญชีรับเงิน</label><input name="accountNo" value="${esc(profile.accountNo || "")}" inputmode="numeric" autocomplete="off" required></div>
      </div>
      <div class="field"><label>ชื่อบัญชี</label><input name="accountName" value="${esc(profile.accountName || profile.name || session.displayName || "")}" autocomplete="off" required></div>
      <div class="note">ข้อมูลนี้ใช้สำหรับสร้างใบขอเบิกรวมและจ่ายเงินคืนให้พนักงาน ระบบจะไม่แสดงเลขบัญชีเต็มในกลุ่ม LINE</div>
      <button class="btn" type="submit">บันทึกข้อมูลผู้เบิก</button>
    </form>
  </div>`;
  return pageShell(body);
}

function successPage(name) {
  return pageShell(`<div class="card success"><div class="check">✓</div><h1>บันทึกข้อมูลแล้ว</h1><p>ข้อมูลผู้เบิกของ ${esc(name || "คุณ")} พร้อมใช้งานแล้ว<br>กลับไป LINE แล้วกด “บันทึกรายการต่อ” ได้เลย</p><button class="btn" onclick="window.close();setTimeout(()=>history.back(),250)">กลับไป LINE</button></div>`, "บันทึกสำเร็จ");
}

export async function handleMemberOnboarding(request, env, url) {
  const sessionToken = url.searchParams.get("t") || "";
  const raw = sessionToken ? await env.KV.get(`member-onboard:${sessionToken}`) : null;
  if (!raw) return invalidPage();

  let session;
  try { session = JSON.parse(raw); } catch { return invalidPage(); }
  session.token = sessionToken;

  const sheetId = await env.KV.get(`tenant:${session.tenant}`) || env.DEFAULT_SHEET_ID;
  if (!sheetId) return invalidPage("ยังไม่พบ Google Sheet ของบริษัท");
  const userToken = await getUserToken(env, session.tenant);
  if (!userToken) {
    console.error("member onboarding: missing Google user token", { tenant: session.tenant });
    return reconnectPage(env, url, session.tenant);
  }

  const settings = await readSettings(env, sheetId, userToken);
  const existing = findMemberProfile(settings, {
    lineUserId: session.lineUserId,
    name: session.displayName,
  }) || {};

  if (request.method === "GET") {
    return new Response(formPage(session, existing), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
      },
    });
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const form = await request.formData();
  const profile = {
    name: String(form.get("name") || "").trim(),
    nickname: String(form.get("nickname") || "").trim(),
    role: String(form.get("role") || "พนักงาน").trim() || "พนักงาน",
    lineUserId: session.lineUserId || String(existing.lineUserId || "").trim(),
    bank: String(form.get("bank") || "").trim(),
    accountNo: String(form.get("accountNo") || "").replace(/[^0-9-]/g, "").trim(),
    accountName: String(form.get("accountName") || "").trim(),
    source: "line_onboarding",
    updatedAt: new Date().toISOString(),
  };

  const missing = missingMemberFields(profile);
  if (missing.length) {
    return new Response(formPage(session, profile, `กรอกข้อมูลให้ครบ: ${missing.join(" · ")}`), {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const members = parseTeamMembers(settings.team_members);
  const idx = members.findIndex((m) =>
    (profile.lineUserId && norm(m.lineUserId || m.payerId) === norm(profile.lineUserId)) ||
    norm(m.name) === norm(profile.name)
  );
  if (idx >= 0) members[idx] = { ...members[idx], ...profile };
  else members.push(profile);

  try {
    await writeSettings(env, sheetId, {
      ...settings,
      team_members: JSON.stringify(members),
    }, userToken);
  } catch (error) {
    console.error("member onboarding save failed", {
      tenant: session.tenant,
      sheetId,
      lineUserId: session.lineUserId,
      message: error?.message || String(error),
      stack: error?.stack || "",
    });

    const msg = String(error?.message || error || "");
    if (/401|403|invalid_grant|unauthorized|permission|insufficient/i.test(msg)) {
      return reconnectPage(env, url, session.tenant, "สิทธิ์ Google ใช้งานไม่ได้");
    }
    return saveErrorPage(msg.slice(0, 220) || "เกิดข้อผิดพลาดระหว่างเขียนข้อมูลลง Google Sheet");
  }

  await env.KV.delete(`member-onboard:${sessionToken}`);

  return new Response(successPage(profile.name), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
