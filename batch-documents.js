// สร้าง "ใบเบิกหลัก" 1 ไฟล์ต่อผู้เบิก
// โครงเอกสาร: หน้าสรุปใบเบิก (จบแยกหน้า) → ใบแทนของแต่ละรายการ → หลักฐาน/ใบเสร็จของแต่ละรายการ
// รองรับสูงสุด 10 รายการต่อใบเบิกตามค่าระบบ

export const BATCH_DOCUMENT_VERSION = "REIMBURSEMENT_MAIN_CLAIM_PACKET_V4_20260805";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
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
  if (!res.ok) console.warn("shareAnyone main claim", fileId, res.status, await res.text());
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

function replacementSignatureCell(name, role, signUrl = "") {
  return `<td width="50%" style="width:50%;border:0;text-align:center;vertical-align:bottom;padding:22px 18px 0">
    <div style="height:45px">${img(signUrl, `ลายเซ็น ${role}`, 120) || "&nbsp;"}</div>
    <div style="width:74%;border-top:1px solid #333;margin:0 auto 6px"></div>
    <div style="font-size:10pt;font-weight:700">(${esc(name || "—")})</div>
    <div style="font-size:9.5pt;font-weight:700">${esc(role)}</div>
  </td>`;
}

function hardPageBreak() {
  // Google Docs HTML import ignores page-break on some section/div elements.
  // A standalone paragraph with page-break-before is handled more reliably.
  return `<p style="page-break-before:always;break-before:page;margin:0;height:0;line-height:0;font-size:0">&nbsp;</p>`;
}

function shell(title, body) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    @page{size:A4;margin:11mm 12mm}
    body{font-family:'Sarabun','Noto Sans Thai',Tahoma,Arial,sans-serif;color:#111;font-size:9.2pt;line-height:1.35;margin:0}
    table{border-collapse:collapse}.grid{border:1px solid #222}.grid th,.grid td{border:1px solid #222}.nob,.nob tr,.nob td{border:0!important}
    .page-break{page-break-before:always;break-before:page}
    .break-after{page-break-after:always;break-after:page}
    .keep{page-break-inside:avoid;break-inside:avoid}
    .muted{color:#666}.doc-link{color:#111;text-decoration:underline}
  </style></head><body>${body}</body></html>`;
}

function findPeriod(items) {
  const dates = items.map((r) => parseDate(r.dateISO || r.dateText || r.date)).filter((d) => Number.isFinite(d.ts));
  if (!dates.length) return { start: "—", end: "—" };
  dates.sort((a, b) => a.ts - b.ts);
  return { start: dates[0].en, end: dates[dates.length - 1].en };
}

function splitUrls(value) {
  return String(value || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function driveFileId(url) {
  const raw = String(url || "");
  return (
    raw.match(/drive\.google\.com\/file\/d\/([^/?#]+)/i)?.[1] ||
    raw.match(/[?&]id=([^&#]+)/i)?.[1] ||
    raw.match(/lh3\.googleusercontent\.com\/d\/([^/?#]+)/i)?.[1] ||
    ""
  );
}

function directDriveImage(url) {
  const id = driveFileId(url);
  return id ? `https://lh3.googleusercontent.com/d/${id}` : String(url || "");
}

function attachmentCandidates(item = {}) {
  const rows = [
    ["หลักฐานต้นฉบับ", item.imageUrl],
    ...splitUrls(item.attReceipt).map((url, i) => [`ใบเสร็จ${i ? ` ${i + 1}` : ""}`, url]),
    ...splitUrls(item.attTax).map((url, i) => [`ใบกำกับภาษี${i ? ` ${i + 1}` : ""}`, url]),
    ...splitUrls(item.attSlip).map((url, i) => [`สลิปต้นฉบับ${i ? ` ${i + 1}` : ""}`, url]),
    ...splitUrls(item.attOther).map((url, i) => [`เอกสารอื่น${i ? ` ${i + 1}` : ""}`, url]),
  ];
  const seen = new Set();
  return rows
    .filter(([, url]) => url && !seen.has(String(url)) && seen.add(String(url)))
    .map(([label, url]) => ({ label, url: String(url) }));
}

async function driveMetadata(token, url) {
  const id = driveFileId(url);
  if (!id) return null;
  const fields = "id,name,mimeType,thumbnailLink,webViewLink";
  const res = await fetch(`${DRIVE}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

function guessMime(url = "") {
  const clean = String(url).split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif)$/.test(clean)) return "image/unknown";
  if (/\.pdf$/.test(clean)) return "application/pdf";
  return "";
}

async function resolveAttachment(token, candidate) {
  const meta = await driveMetadata(token, candidate.url);
  const mimeType = String(meta?.mimeType || guessMime(candidate.url));
  let previewUrl = "";
  let previewOnly = false;
  if (mimeType.startsWith("image/")) {
    previewUrl = directDriveImage(candidate.url);
  } else if (mimeType === "application/pdf" && meta?.thumbnailLink) {
    previewUrl = String(meta.thumbnailLink).replace(/=s\d+$/, "=s1600");
    previewOnly = true;
  } else if (!mimeType && /^https?:/i.test(candidate.url)) {
    previewUrl = candidate.url;
  }
  return {
    ...candidate,
    name: meta?.name || candidate.label,
    mimeType,
    previewUrl,
    previewOnly,
  };
}

async function hydrateItems(token, items) {
  return Promise.all(items.map(async (item) => ({
    ...item,
    packetAttachments: await Promise.all(attachmentCandidates(item).map((a) => resolveAttachment(token, a))),
  })));
}

function needsReplacementReceipt(item = {}) {
  const value = String(item.needSlip ?? "").trim().toLowerCase();
  return !!item.receiptPdfUrl || ["true", "1", "yes", "y", "ออกใบแทน", "ต้องออก", "on", "มี"].includes(value);
}

function issueDateFor(item = {}, batch = {}) {
  const raw = item.submittedAt || item.createdAt || item.created_at || item.createdDate || item.recordedAt || batch.createdAt || batch.created_at || batch.createdDate || todayBangkok().iso;
  return parseDate(raw).en;
}

function metaNumberFor(item = {}, batch = {}, index = 0) {
  return item.expenseId || item.recordId || item.itemId || item.reimbursementId || item.rowId || item.id || `${batch.docId || batch.runNo || 'BATCH'}-${index + 1}`;
}

function replacementReceiptSection(item, settings, payer, batch, index) {
  if (!needsReplacementReceipt(item)) return "";
  const tx = parseDate(item.dateISO || item.dateText || item.date).en;
  const issue = issueDateFor(item, batch);
  const claimant = payer.name || item.payerName || item.sender || "—";
  const position = payer.role || item.payerPosition || item.position || item.employeePosition || "พนักงาน";
  const detail = item.note || item.category || item.vendor || "ค่าใช้จ่าย";
  const reason = item.noReceiptReason || "ไม่อาจเรียกเก็บใบเสร็จรับเงินจากผู้รับได้ และนำค่าใช้จ่ายไปใช้ในงานของบริษัทโดยแท้จริง";
  const documentNo = metaNumberFor(item, batch, index);
  const requestNo = item.requestNo || item.reqNo || batch.docId || batch.runNo || "—";
  const blankRows = Array.from({ length: 9 }, () => `<tr style="height:34px"><td></td><td></td><td></td><td></td></tr>`).join("");
  return `
    ${hardPageBreak()}
    ${companyHeader(settings)}
    <table class="nob" border="0" width="100%" style="width:100%;margin:6px 0 4px">
      <tr>
        <td style="border:0;font-size:9.2pt;line-height:1.5">
          <div><b>เลขที่เอกสาร:</b> ${esc(documentNo)}</div>
          <div><b>เลขคำขอ:</b> ${esc(requestNo)}</div>
          <div><b>วันที่สร้างเอกสาร:</b> ${esc(issue)}</div>
        </td>
      </tr>
    </table>
    <div style="text-align:center;font-size:18pt;font-weight:700;margin:18px 0 6px">ใบรับรองแทนใบเสร็จรับเงิน</div>
    <div style="text-align:center;font-size:11.2pt;font-weight:700;margin-bottom:16px">บจ. / หจก. ${esc(settings.company_name || "—")} (ผู้ซื้อ/ผู้รับบริการ)</div>

    <table class="grid" border="1" cellspacing="0" cellpadding="6" width="100%" style="width:100%;table-layout:fixed;font-size:9.1pt">
      <thead>
        <tr style="height:34px">
          <th width="25%">วัน เดือน ปี</th>
          <th width="39%">รายละเอียดรายจ่าย</th>
          <th width="18%">จำนวนเงิน</th>
          <th width="18%">หมายเหตุ</th>
        </tr>
      </thead>
      <tbody>
        <tr style="height:56px">
          <td style="text-align:center">${esc(tx)}</td>
          <td>${esc(detail)}</td>
          <td style="text-align:center">${money(item.amount)}</td>
          <td>${esc(item.receiptNote || "")}</td>
        </tr>
        ${blankRows}
      </tbody>
    </table>
    <div style="text-align:right;font-size:11pt;font-weight:700;margin-top:8px">รวมทั้งสิ้น : ${money(item.amount)} บาท</div>

    <div class="keep" style="margin-top:20px;font-size:9.1pt;line-height:1.65">
      <div>ข้าพเจ้า <b>${esc(claimant)}</b> (ผู้เบิกจ่าย) ตำแหน่ง ${esc(position)}</div>
      <div style="margin-top:7px">ขอรับรองว่า รายจ่ายข้างต้นนี้${esc(reason)}</div>
      <div style="margin-top:7px">วันที่ตั้งเบิก ${esc(issue)}</div>
    </div>

    <table class="nob keep" border="0" cellspacing="0" cellpadding="0" width="100%" style="width:100%;margin-top:26px">
      <tr>
        ${replacementSignatureCell(claimant, "ผู้เบิกจ่าย", payer.signatureUrl || "")}
        ${replacementSignatureCell(settings.approver_name || "—", "ผู้อนุมัติ", settings.approver_sign_url || "")}
      </tr>
      <tr>
        <td style="border:0;text-align:center;font-size:8.8pt;padding-top:6px">วันที่ ${esc(issue)}</td>
        <td style="border:0;text-align:center;font-size:8.8pt;padding-top:6px">วันที่ ${esc(issue)}</td>
      </tr>
    </table>`;
}

function evidenceSection(item, index) {
  const attachments = Array.isArray(item.packetAttachments) ? item.packetAttachments : [];
  const tx = parseDate(item.dateISO || item.dateText || item.date).en;
  const title = item.vendor || item.note || item.category || "รายการเบิก";
  const head = `${hardPageBreak()}
    <div style="font-size:8.5pt;color:#666">เอกสารประกอบใบเบิก · รายการที่ ${index + 1}</div>
    <div style="font-size:15pt;font-weight:700;margin:4px 0 8px">${esc(title)}</div>
    <table class="grid" border="1" cellspacing="0" cellpadding="5" width="100%" style="width:100%;font-size:8.8pt;margin-bottom:12px">
      <tr><td width="18%"><b>วันที่</b></td><td width="32%">${esc(tx)}</td><td width="18%"><b>ยอดเงิน</b></td><td width="32%" style="text-align:right">${money(item.amount)} บาท</td></tr>
      <tr><td><b>หมวด</b></td><td>${esc(item.category || "—")}</td><td><b>ผู้โอน</b></td><td>${esc(item.transferor || item.payerName || "—")}</td></tr>
      <tr><td><b>รายละเอียด</b></td><td colspan="3">${esc(item.note || "—")}</td></tr>
    </table>`;
  if (!attachments.length) {
    return `${head}<div style="border:1px dashed #999;padding:28px;text-align:center;color:#666">ยังไม่มีหลักฐานแนบสำหรับรายการนี้</div>`;
  }
  const body = attachments.map((a, i) => `<div style="${i ? "page-break-before:always;break-before:page;" : ""}page-break-inside:avoid;break-inside:avoid">
      <div style="font-size:10pt;font-weight:700;margin-bottom:6px">${esc(a.label)}${a.name && a.name !== a.label ? ` · ${esc(a.name)}` : ""}</div>
      ${a.previewUrl ? `<div style="text-align:center;border:1px solid #ddd;padding:8px"><img src="${esc(a.previewUrl)}" alt="${esc(a.label)}" width="620" style="width:620px;max-height:850px;height:auto;object-fit:contain"></div>` : `<div style="border:1px dashed #aaa;padding:24px;text-align:center">ไฟล์แนบไม่สามารถแสดงตัวอย่างใน PDF ได้</div>`}
      ${a.previewOnly ? `<div style="font-size:8pt;color:#666;margin-top:5px">ภาพนี้เป็นหน้าตัวอย่างของไฟล์ PDF ต้นฉบับ</div>` : ""}
      <div style="font-size:8.2pt;margin-top:5px"><a class="doc-link" href="${esc(a.url)}">เปิดไฟล์ต้นฉบับ</a></div>
    </div>`).join("");
  return `${head}${body}`;
}

function buildSummarySection(batch, items, settings = {}, payer = {}) {
  const issue = issueDateFor({}, batch);
  const period = findPeriod(items);
  const total = items.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const typeLabel = batch.type === "ด่วน" ? "ใบเบิกด่วน" : "ใบเบิกปกติ";
  const rows = items.map((r, i) => {
    const d = parseDate(r.dateISO || r.dateText || r.date).en;
    const detail = r.note || r.vendor || r.category || "ค่าใช้จ่าย";
    const evidenceCount = Array.isArray(r.packetAttachments) ? r.packetAttachments.length : 0;
    return `<tr style="height:31px;page-break-inside:avoid;break-inside:avoid">
      <td style="text-align:center">${i + 1}</td>
      <td style="text-align:center">${esc(d)}</td>
      <td>${esc(detail)}</td>
      <td style="text-align:center">${evidenceCount}</td>
      <td style="text-align:center">${needsReplacementReceipt(r) ? "มี" : "—"}</td>
      <td style="text-align:right">${money(r.amount)}</td>
    </tr>`;
  }).join("");
  const blankCount = Math.max(0, 10 - items.length);
  const blanks = Array.from({ length: blankCount }, () =>
    `<tr style="height:26px"><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>`
  ).join("");
  const evidenceCount = items.reduce((sum, r) => sum + (Array.isArray(r.packetAttachments) ? r.packetAttachments.length : 0), 0);
  const replacementCount = items.filter(needsReplacementReceipt).length;

  return `
    <div class="break-after">
      ${companyHeader(settings)}
      <table class="nob" border="0" width="100%" style="width:100%;border:0;margin:2px 0 8px">
        <tr>
          <td style="border:0;font-size:8.7pt;vertical-align:bottom">
            <div><b>ประเภท:</b> ${esc(typeLabel)}</div>
            <div><b>ช่วงรายการ:</b> ${esc(period.start)} – ${esc(period.end)}</div>
          </td>
          <td style="border:0;text-align:right;font-size:8.8pt;vertical-align:bottom">
            <div><b>เลขที่ใบเบิก</b></div><div style="font-size:10.5pt;font-weight:700">${esc(batch.docId)}</div>
          </td>
        </tr>
      </table>

      <div style="text-align:center;font-size:18pt;font-weight:700;margin:4px 0 2px">ใบเบิก</div>
      <div style="text-align:center;font-size:9.2pt;margin-bottom:11px">${esc(typeLabel)} · รวม ${items.length} รายการย่อยไว้ในเอกสารฉบับเดียว</div>

      <table class="grid" border="1" cellspacing="0" cellpadding="5" width="100%" style="width:100%;table-layout:fixed;font-size:8.6pt">
        <thead><tr style="height:31px">
          <th width="6%">ลำดับ</th><th width="13%">วันที่</th><th width="43%">รายการ</th><th width="10%">หลักฐาน</th><th width="10%">ใบแทน</th><th width="18%">จำนวนเงิน<br>(บาท)</th>
        </tr></thead>
        <tbody>${rows}${blanks}</tbody>
      </table>

      <div style="text-align:right;font-size:10.2pt;font-weight:700;margin-top:8px">รวมทั้งสิ้น ${money(total)} บาท</div>

      <div style="font-size:8.7pt;line-height:1.55;margin-top:14px;page-break-inside:avoid;break-inside:avoid">
        <div><b>ผู้ขอเบิก:</b> ${esc(payer.name || batch.payerName || "—")}${payer.role ? ` · ${esc(payer.role)}` : ""}</div>
        <div><b>ชื่อบัญชี:</b> ${esc(payer.accountName || payer.name || batch.payerName || "—")}&nbsp;&nbsp;&nbsp;&nbsp;<b>เลขบัญชี:</b> ${esc(payer.accountNo || "—")}</div>
        <div><b>ธนาคาร:</b> ${esc(payer.bank || "—")}&nbsp;&nbsp;&nbsp;&nbsp;<b>เอกสารในชุด:</b> หลักฐาน ${evidenceCount} ไฟล์ · ใบแทน ${replacementCount} ใบ</div>
        <div><b>รหัสรอบจ่าย:</b> ${esc(batch.runNo)}&nbsp;&nbsp;&nbsp;&nbsp;<b>จัดทำเมื่อ:</b> ${esc(issue)}</div>
      </div>

      <div style="font-size:8.2pt;color:#666;margin-top:12px">หน้าถัดไปเป็นใบแทนและหลักฐานของรายการย่อย เรียงตามลำดับในตารางด้านบน</div>
    </div>`;
}

function buildBatchHtml(batch, items, settings = {}, payer = {}) {
  const summary = buildSummarySection(batch, items, settings, payer);
  const appendices = items.map((item, i) => `${replacementReceiptSection(item, settings, payer, batch, i)}${evidenceSection(item, i)}`).join("");
  return shell(`ใบเบิก ${batch.docId}`, `${summary}${appendices}`);
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
  if (!token) throw new Error("ไม่มี Google OAuth token สำหรับสร้างใบเบิกหลัก");
  if (!batch?.docId) throw new Error("ไม่มีเลขที่ใบเบิก");
  if (!Array.isArray(items) || !items.length) throw new Error("ไม่มีรายการสำหรับสร้างใบเบิก");

  const hydratedItems = await hydrateItems(token, items);
  console.log(`[main-claim-document] version=${BATCH_DOCUMENT_VERSION} doc=${batch.docId} items=${hydratedItems.length}`);
  const result = await htmlToPdf(token, `ใบเบิก_${batch.docId}`, buildBatchHtml(batch, hydratedItems, settings, payer));
  return { docId: batch.docId, pdfUrl: result.url, fileId: result.fileId };
}
