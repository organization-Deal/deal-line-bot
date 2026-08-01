// สร้างใบขอเบิกรวมหลายรายการเป็น PDF แล้วเก็บใน Google Drive
// รองรับเอกสารสูงสุดตามจำนวนรายการที่ caller ส่งมา (แนะนำไม่เกิน 10 รายการ/ใบ)

export const BATCH_DOCUMENT_VERSION = "REIMBURSEMENT_BATCH_DOC_V1_20260802";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(v) {
  return (Number(v) || 0).toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function parseDate(input) {
  const nums = String(input || "").match(/\d+/g);
  let y, m, d;
  if (nums && nums.length >= 3) {
    if (nums[0].length === 4) [y, m, d] = nums.map(Number);
    else [d, m, y] = nums.map(Number);
    if (y > 2400) y -= 543;
    if (y < 100) y += 2000;
  } else {
    const now = new Date();
    y = now.getUTCFullYear();
    m = now.getUTCMonth() + 1;
    d = now.getUTCDate();
  }
  const p = (n) => String(n || 1).padStart(2, "0");
  const iso = `${y}-${p(m)}-${p(d)}`;
  return {
    iso,
    en: `${p(d)}/${p(m)}/${y}`,
    th: `${p(d)}/${p(m)}/${y + 543}`,
    ts: Date.parse(`${iso}T00:00:00Z`),
  };
}

function todayBangkok() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const o = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return parseDate(`${o.year}-${o.month}-${o.day}`);
}

function concatBytes(...parts) {
  const arrays = parts.map((p) => p instanceof Uint8Array ? p : new Uint8Array(p));
  const total = arrays.reduce((sum, a) => sum + a.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
}

function multipartBody(metadata, mediaType, media) {
  const boundary = `----reimburse-${crypto.randomUUID().replace(/-/g, "")}`;
  const enc = new TextEncoder();
  const bytes = media instanceof Uint8Array ? media : enc.encode(String(media));
  const pre = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`
  );
  const post = enc.encode(`\r\n--${boundary}--`);
  return { boundary, body: concatBytes(pre, bytes, post) };
}

async function uploadMultipart(token, metadata, mediaType, media, fields = "id,name,webViewLink") {
  const { boundary, body } = multipartBody(metadata, mediaType, media);
  const res = await fetch(`${UPLOAD}?uploadType=multipart&fields=${encodeURIComponent(fields)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${text.slice(0, 320)}`);
  return JSON.parse(text);
}

async function exportPdf(token, docId) {
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 450 * attempt));
    const res = await fetch(
      `${DRIVE}/files/${docId}/export?mimeType=${encodeURIComponent("application/pdf")}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    last = `${res.status}: ${(await res.text()).slice(0, 260)}`;
  }
  throw new Error(`Drive export PDF failed ${last}`);
}

async function shareAnyone(token, fileId) {
  const res = await fetch(`${DRIVE}/files/${fileId}/permissions?supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!res.ok) console.warn("shareAnyone batch", fileId, res.status, await res.text());
}

async function deleteFile(token, fileId) {
  await fetch(`${DRIVE}/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

function img(url, alt, width = 68) {
  if (!url) return "";
  return `<img src="${esc(url)}" alt="${esc(alt)}" width="${width}" style="width:${width}px;height:auto;border:0">`;
}

function companyHeader(settings = {}) {
  const address = esc(settings.company_address || "—").replace(/\\n|\n/g, "<br>");
  return `<table class="nob" border="0" cellspacing="0" cellpadding="0" width="100%" style="width:100%;border:0;margin:0 0 7px">
    <tr>
      <td width="90" style="width:90px;border:0;vertical-align:top;padding:0">${img(settings.logo_url, "โลโก้", 68)}</td>
      <td style="border:0;text-align:center;vertical-align:top;padding:0 10px">
        <div style="font-size:14pt;font-weight:700;line-height:1.22">${esc(settings.company_name || "—")}</div>
        <div style="font-size:9.2pt;line-height:1.35;margin-top:2px">${address}</div>
        ${settings.tax_id ? `<div style="font-size:9.2pt">เลขที่ประจำตัวผู้เสียภาษี : ${esc(settings.tax_id)}</div>` : ""}
      </td>
      <td width="90" style="width:90px;border:0"></td>
    </tr>
  </table>`;
}

function signatureCell(name, role, issueDate, signUrl = "", position = "") {
  return `<td width="50%" style="width:50%;border:0;text-align:center;vertical-align:bottom;padding:12px 22px 0">
    <div style="height:40px">${img(signUrl, `ลายเซ็น ${role}`, 118) || "&nbsp;"}</div>
    <div style="width:78%;border-top:1px solid #333;margin:0 auto;padding-top:4px"></div>
    <div style="font-weight:700">(${esc(name || "—")})</div>
    <div style="font-size:8.6pt">${esc(role)}${position ? ` · ${esc(position)}` : ""}</div>
    <div style="font-size:8.4pt">วันที่ ${esc(issueDate)}</div>
  </td>`;
}

function shell(title, body) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    @page{size:A4;margin:11mm 12mm}
    body{font-family:'Sarabun','Noto Sans Thai',Tahoma,Arial,sans-serif;color:#111;font-size:9.2pt;line-height:1.35;margin:0}
    table{border-collapse:collapse}.grid{border:1px solid #222}.grid th,.grid td{border:1px solid #222}.nob,.nob tr,.nob td{border:0!important}
  </style></head><body>${body}</body></html>`;
}

function findPeriod(items) {
  const dates = items.map((r) => parseDate(r.dateISO || r.dateText || r.date)).filter((d) => Number.isFinite(d.ts));
  if (!dates.length) return { start: "—", end: "—" };
  dates.sort((a, b) => a.ts - b.ts);
  return { start: dates[0].en, end: dates[dates.length - 1].en };
}

function buildBatchHtml(batch, items, settings = {}, payer = {}) {
  const issue = todayBangkok().en;
  const period = findPeriod(items);
  const total = items.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const typeLabel = batch.type === "ด่วน" ? "รอบเบิกด่วน" : "รอบเบิกประจำสัปดาห์";
  const rows = items.map((r, i) => {
    const d = parseDate(r.dateISO || r.dateText || r.date).en;
    const detail = r.note || r.vendor || r.category || "ค่าใช้จ่าย";
    return `<tr style="height:31px;page-break-inside:avoid">
      <td style="text-align:center">${i + 1}</td>
      <td style="text-align:center">${esc(d)}</td>
      <td>${esc(detail)}${r.vendor ? `<div style="font-size:7.9pt;color:#555">ผู้รับ: ${esc(r.vendor)}</div>` : ""}</td>
      <td style="text-align:center">-</td>
      <td style="text-align:right">${money(r.amount)}</td>
    </tr>`;
  }).join("");
  const blankCount = Math.max(0, 10 - items.length);
  const blanks = Array.from({ length: blankCount }, () =>
    `<tr style="height:26px"><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>`
  ).join("");
  const evidenceCount = items.filter((r) => r.imageUrl || r.attReceipt || r.attTax || r.attSlip || r.attOther).length;

  return shell(`ใบขอเบิกรวม ${batch.docId}`, `
    ${companyHeader(settings)}
    <table class="nob" border="0" width="100%" style="width:100%;border:0;margin:2px 0 8px">
      <tr>
        <td style="border:0;font-size:8.7pt;vertical-align:bottom">
          <div><b>ประเภท:</b> ${esc(typeLabel)}</div>
          <div><b>ช่วงรายการ:</b> ${esc(period.start)} – ${esc(period.end)}</div>
        </td>
        <td style="border:0;text-align:right;font-size:8.8pt;vertical-align:bottom">
          <div><b>เลขที่</b></div><div style="font-size:10.5pt;font-weight:700">${esc(batch.docId)}</div>
        </td>
      </tr>
    </table>

    <div style="text-align:center;font-size:17pt;font-weight:700;margin:4px 0 2px">ใบขอเบิกรวม</div>
    <div style="text-align:center;font-size:9.2pt;margin-bottom:11px">${esc(typeLabel)} · ${items.length} รายการ</div>

    <table class="grid" border="1" cellspacing="0" cellpadding="5" width="100%" style="width:100%;table-layout:fixed;font-size:8.8pt">
      <thead><tr style="height:31px">
        <th width="7%">ลำดับ</th><th width="15%">วันที่</th><th width="48%">รายการ</th><th width="10%">หน่วย</th><th width="20%">จำนวนเงิน<br>(บาท)</th>
      </tr></thead>
      <tbody>${rows}${blanks}</tbody>
    </table>

    <div style="text-align:right;font-size:10.2pt;font-weight:700;margin-top:8px">รวมทั้งสิ้น ${money(total)} บาท</div>

    <div style="font-size:8.7pt;line-height:1.55;margin-top:14px;page-break-inside:avoid">
      <div><b>ผู้ขอเบิก:</b> ${esc(payer.name || batch.payerName || "—")}${payer.role ? ` · ${esc(payer.role)}` : ""}</div>
      <div><b>ชื่อบัญชี:</b> ${esc(payer.accountName || payer.name || batch.payerName || "—")}&nbsp;&nbsp;&nbsp;&nbsp;<b>เลขบัญชี:</b> ${esc(payer.accountNo || "—")}</div>
      <div><b>ธนาคาร:</b> ${esc(payer.bank || "—")}&nbsp;&nbsp;&nbsp;&nbsp;<b>หลักฐานครบ:</b> ${evidenceCount}/${items.length} รายการ</div>
      <div><b>รหัสรอบ:</b> ${esc(batch.runNo)}&nbsp;&nbsp;&nbsp;&nbsp;<b>จัดทำเมื่อ:</b> ${esc(issue)}</div>
    </div>

    <table class="nob" border="0" cellspacing="0" cellpadding="0" width="100%" style="width:100%;border:0;margin-top:14px;page-break-inside:avoid"><tr>
      ${signatureCell(payer.name || batch.payerName, "ผู้เบิกจ่าย", issue, payer.signatureUrl || "", payer.role || "")}
      ${signatureCell(settings.approver_name, "ผู้อนุมัติ", issue, settings.approver_sign_url || "", settings.approver_position || "")}
    </tr></table>
  `);
}

async function htmlToPdf(token, name, html) {
  let docId = "";
  try {
    const doc = await uploadMultipart(token, {
      name: `${name} (ต้นฉบับ)`,
      mimeType: "application/vnd.google-apps.document",
    }, "text/html; charset=UTF-8", new TextEncoder().encode(html));
    docId = doc.id;
    const pdf = await exportPdf(token, docId);
    const file = await uploadMultipart(token, {
      name: `${name}.pdf`,
      mimeType: "application/pdf",
    }, "application/pdf", pdf);
    await shareAnyone(token, file.id);
    return { fileId: file.id, url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view` };
  } finally {
    if (docId) await deleteFile(token, docId);
  }
}

export async function createBatchClaimPdf(env, batch, items, settings = {}, payer = {}, token) {
  if (!token) throw new Error("ไม่มี Google OAuth token สำหรับสร้างใบขอเบิกรวม");
  if (!batch?.docId) throw new Error("ไม่มีเลขเอกสารรอบเบิก");
  if (!Array.isArray(items) || !items.length) throw new Error("ไม่มีรายการสำหรับสร้างรอบเบิก");

  console.log(`[batch-document] version=${BATCH_DOCUMENT_VERSION} doc=${batch.docId} items=${items.length}`);
  const result = await htmlToPdf(token, batch.docId, buildBatchHtml(batch, items, settings, payer));
  return { docId: batch.docId, pdfUrl: result.url, fileId: result.fileId };
}
