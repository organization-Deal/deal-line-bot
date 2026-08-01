// สร้าง "ใบเบิกค่าใช้จ่าย" + "ใบรับรองแทนใบเสร็จ" อัตโนมัติ
// วิธีทำ: HTML → Google Docs (Drive import) → export PDF → อัป PDF กลับเข้า Drive ลูกค้า
// ใช้ scope drive.file เดิมได้ ไม่ต้องขอ OAuth scope เพิ่ม

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

function dateParts(input) {
  const n = String(input || "").match(/\d+/g);
  let y, m, d;
  if (n && n.length >= 3) {
    if (n[0].length === 4) [y, m, d] = n.map(Number);
    else [d, m, y] = n.map(Number);
    if (y > 2400) y -= 543;
    if (y < 100) y += 2000;
  } else {
    const now = new Date();
    y = now.getUTCFullYear(); m = now.getUTCMonth() + 1; d = now.getUTCDate();
  }
  const p = (x) => String(x || 1).padStart(2, "0");
  return {
    iso: `${y}-${p(m)}-${p(d)}`,
    compact: `${y}${p(m)}${p(d)}`,
    th: `${p(d)}/${p(m)}/${y + 543}`,
  };
}

function concatBytes(...parts) {
  const arrays = parts.map((p) => p instanceof Uint8Array ? p : new Uint8Array(p));
  const total = arrays.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.byteLength; }
  return out;
}

function multipartBody(metadata, mediaType, media) {
  const boundary = "----deal-doc-" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const bytes = media instanceof Uint8Array ? media : enc.encode(String(media));
  const pre = enc.encode(
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mediaType}\r\n\r\n`
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
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function shareAnyone(token, fileId) {
  const res = await fetch(`${DRIVE}/files/${fileId}/permissions?supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!res.ok) console.warn("shareAnyone", fileId, res.status, await res.text());
}

async function deleteFile(token, fileId) {
  await fetch(`${DRIVE}/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {});
}

async function exportPdf(token, docId) {
  let last = "";
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise((r) => setTimeout(r, 350 * i));
    const res = await fetch(
      `${DRIVE}/files/${docId}/export?mimeType=${encodeURIComponent("application/pdf")}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    last = `${res.status}: ${(await res.text()).slice(0, 240)}`;
  }
  throw new Error(`Drive export PDF failed ${last}`);
}

function img(url, alt, maxWidth) {
  if (!url) return "";
  return `<img src="${esc(url)}" alt="${esc(alt)}" style="max-width:${maxWidth}px;max-height:72px;object-fit:contain">`;
}

function shell(title, body) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(title)}</title></head>
  <body style="font-family:'Noto Sans Thai','Sarabun',Arial,sans-serif;color:#171717;font-size:11pt;line-height:1.45;margin:28px">
  ${body}</body></html>`;
}

function header(settings, docNo, issueDate) {
  const address = esc(settings.company_address || "—").replace(/\\n|\n/g, "<br>");
  return `<table style="width:100%;border-collapse:collapse;margin-bottom:12px"><tr>
    <td style="width:95px;vertical-align:top">${img(settings.logo_url, "โลโก้", 85)}</td>
    <td style="vertical-align:top"><div style="font-size:15pt;font-weight:700">${esc(settings.company_name || "—")}</div>
      <div>${address}</div>${settings.tax_id ? `<div>เลขประจำตัวผู้เสียภาษี ${esc(settings.tax_id)}</div>` : ""}</td>
    <td style="width:190px;text-align:right;vertical-align:top"><div><b>เลขที่เอกสาร</b> ${esc(docNo)}</div><div><b>วันที่ออก</b> ${esc(issueDate)}</div></td>
  </tr></table>`;
}

function signature(name, role, signUrl = "") {
  return `<td style="width:50%;text-align:center;vertical-align:bottom;padding:28px 18px 0">
    <div style="height:55px">${img(signUrl, "ลายเซ็น", 150)}</div>
    <div style="border-top:1px solid #555;padding-top:5px">ลงชื่อ ${esc(name || "—")}</div>
    <div>(${esc(role)})</div>
  </td>`;
}


function formalReplacementHeader(settings, receiptNo, issueDate) {
  const address = esc(settings.company_address || "—").replace(/\\n|\n/g, "<br>");
  return `<table style="width:100%;border-collapse:collapse;margin-bottom:10px">
    <tr>
      <td style="width:105px;vertical-align:top;text-align:left;padding-top:2px">
        ${img(settings.logo_url, "โลโก้บริษัท", 76)}
      </td>
      <td style="vertical-align:top;text-align:center;padding:0 18px">
        <div style="font-size:16pt;font-weight:700;margin-bottom:3px">${esc(settings.company_name || "—")}</div>
        <div style="font-size:10.5pt;line-height:1.45">${address}</div>
        ${settings.tax_id ? `<div style="font-size:10.5pt">เลขที่ประจำตัวผู้เสียภาษี : ${esc(settings.tax_id)}</div>` : ""}
      </td>
      <td style="width:105px"></td>
    </tr>
  </table>
  <table style="width:100%;border-collapse:collapse;margin:8px 0 22px;font-size:9.5pt">
    <tr><td style="width:105px"><b>เลขที่เอกสาร</b></td><td>: ${esc(receiptNo)}</td></tr>
    <tr><td><b>เลขที่ชุด</b></td><td>: ${esc(receiptNo)}</td></tr>
    <tr><td><b>วันที่สร้างเอกสาร</b></td><td>: ${esc(issueDate)}</td></tr>
  </table>`;
}

function formalSingleSignature(name, issueDate, position = "") {
  const pos = position ? `ตำแหน่ง ${esc(position)}` : "ผู้เบิกจ่าย";
  return `<table style="width:100%;border-collapse:collapse;margin-top:42px">
    <tr>
      <td style="width:22%"></td>
      <td style="width:56%;text-align:center;vertical-align:bottom">
        <div style="height:34px"></div>
        <div style="white-space:nowrap">ลงชื่อ&nbsp;&nbsp;............................................................</div>
        <div style="margin-top:7px">(${esc(name || "—")})</div>
        <div style="margin-top:2px">${pos}</div>
        <div style="margin-top:2px">วันที่ ${esc(issueDate)}</div>
      </td>
      <td style="width:22%"></td>
    </tr>
  </table>`;
}

function buildClaimHtml(rec, settings, claimNo) {
  const tx = dateParts(rec.dateISO || rec.dateText || rec.date);
  const issue = dateParts(new Date().toISOString()).th;
  const payer = rec.payerName || rec.sender || "—";
  const transferor = rec.transferor || payer;
  const detail = rec.note || rec.category || "ค่าใช้จ่าย";
  const evidence = rec.imageUrl
    ? `<a href="${esc(rec.imageUrl)}">เปิดหลักฐานต้นฉบับใน Google Drive</a>`
    : "ไม่มีลิงก์หลักฐานต้นฉบับ";

  return shell("ใบเบิกค่าใช้จ่าย", `
    ${header(settings, claimNo, issue)}
    <div style="text-align:center;font-size:18pt;font-weight:700;margin:18px 0 4px">ใบเบิกค่าใช้จ่าย</div>
    <div style="text-align:center;color:#555;margin-bottom:18px">Expense Reimbursement Form</div>
    <table style="width:100%;border-collapse:collapse" border="1" cellpadding="8">
      <tr><td style="width:26%;background:#f2f2f2"><b>ผู้เบิกจ่าย</b></td><td>${esc(payer)}</td></tr>
      <tr><td style="background:#f2f2f2"><b>วันที่รายการ</b></td><td>${esc(tx.th)}</td></tr>
      <tr><td style="background:#f2f2f2"><b>หมวดค่าใช้จ่าย</b></td><td>${esc(rec.category || "—")}</td></tr>
      <tr><td style="background:#f2f2f2"><b>รายละเอียด</b></td><td>${esc(detail)}</td></tr>
      <tr><td style="background:#f2f2f2"><b>ผู้โอน / จากบัญชี</b></td><td>${esc(transferor || "—")}</td></tr>
      <tr><td style="background:#f2f2f2"><b>ผู้รับ / ไปยัง</b></td><td>${esc(rec.vendor || "—")}</td></tr>
      <tr><td style="background:#f2f2f2"><b>จำนวนเงิน</b></td><td style="font-size:16pt;font-weight:700">${money(rec.amount)} บาท</td></tr>
      <tr><td style="background:#f2f2f2"><b>หลักฐาน</b></td><td>${evidence}</td></tr>
    </table>
    <p style="margin-top:16px">ข้าพเจ้าขอเบิกค่าใช้จ่ายข้างต้น ซึ่งเป็นค่าใช้จ่ายที่เกิดขึ้นเพื่อกิจการของบริษัท และขอรับรองว่าข้อมูลดังกล่าวถูกต้องตามความเป็นจริง</p>
    <table style="width:100%;border-collapse:collapse;margin-top:18px"><tr>
      ${signature(payer, "ผู้เบิกจ่าย")}
      ${signature(settings.approver_name, "ผู้อนุมัติ", settings.approver_sign_url)}
    </tr></table>
  `);
}

function buildReplacementHtml(rec, settings, receiptNo) {
  const tx = dateParts(rec.dateISO || rec.dateText || rec.date);
  const issue = dateParts(new Date().toISOString()).th;
  const payer = rec.payerName || rec.sender || "—";
  const position = rec.payerPosition || rec.position || settings.payer_position || "";
  const transferor = rec.transferor || payer;
  const recipient = rec.vendor || "—";
  const detail = rec.note || rec.category || "ค่าใช้จ่าย";
  const noReceiptReason = rec.noReceiptReason || "ไม่สามารถเรียกเก็บใบเสร็จรับเงินจากผู้รับได้";
  const blankRows = Array.from({ length: 8 }, () => `
    <tr style="height:30px">
      <td>&nbsp;</td><td></td><td></td><td></td>
    </tr>`).join("");

  return shell("ใบรับรองแทนใบเสร็จรับเงิน", `
    ${formalReplacementHeader(settings, receiptNo, issue)}

    <div style="text-align:center;font-size:18pt;font-weight:700;margin:0 0 5px">ใบรับรองแทนใบเสร็จรับเงิน</div>
    <div style="text-align:center;font-size:11pt;margin-bottom:20px">
      ${esc(settings.company_name || "—")} (ผู้ซื้อ/ผู้รับบริการ)
    </div>

    <table style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:10pt" border="1" cellpadding="6">
      <thead>
        <tr style="height:32px">
          <th style="width:18%;text-align:center">วัน เดือน ปี</th>
          <th style="width:38%;text-align:center">รายละเอียดรายจ่าย</th>
          <th style="width:18%;text-align:center">จำนวนเงิน</th>
          <th style="width:26%;text-align:center">หมายเหตุ</th>
        </tr>
      </thead>
      <tbody>
        <tr style="height:52px">
          <td style="text-align:center;vertical-align:middle">${esc(tx.th)}</td>
          <td style="vertical-align:middle">${esc(detail)}</td>
          <td style="text-align:right;vertical-align:middle">${money(rec.amount)}</td>
          <td style="vertical-align:middle">${esc(rec.receiptNote || "")}</td>
        </tr>
        ${blankRows}
      </tbody>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:10.5pt">
      <tr>
        <td style="width:58%"></td>
        <td style="text-align:right"><b>รวมทั้งสิ้น :</b></td>
        <td style="width:22%;text-align:right"><b>${money(rec.amount)} บาท</b></td>
      </tr>
    </table>

    <div style="margin-top:24px;font-size:9.8pt;line-height:1.65">
      <div><b>ข้าพเจ้า ${esc(payer)}</b> (ผู้เบิกจ่าย)${position ? ` ตำแหน่ง ${esc(position)}` : ""}</div>
      <div style="margin-top:7px">
        ขอรับรองว่า รายจ่ายข้างต้นนี้${esc(noReceiptReason)} และได้จ่ายไปเพื่อกิจการของบริษัทโดยแท้จริง
      </div>
      <div style="margin-top:4px">
        ผู้โอน / จากบัญชี: ${esc(transferor)}&nbsp;&nbsp;&nbsp;&nbsp;ผู้รับ / ไปยัง: ${esc(recipient)}
      </div>
      <div style="margin-top:4px">ทั้งนี้ เพื่อใช้เป็นหลักฐานประกอบการเบิกจ่ายตามระเบียบของบริษัท</div>
    </div>

    ${formalSingleSignature(payer, issue, position)}
  `);
}

async function htmlToPdfOnDrive(token, name, html) {
  let docId = null;
  try {
    const doc = await uploadMultipart(token, {
      name: `${name} (ต้นฉบับ)` ,
      mimeType: "application/vnd.google-apps.document",
    }, "text/html; charset=UTF-8", new TextEncoder().encode(html));
    docId = doc.id;

    const pdf = await exportPdf(token, docId);
    const file = await uploadMultipart(token, {
      name: `${name}.pdf`,
      mimeType: "application/pdf",
    }, "application/pdf", pdf);
    await shareAnyone(token, file.id);
    return {
      fileId: file.id,
      url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
    };
  } finally {
    if (docId) await deleteFile(token, docId);
  }
}

/**
 * สร้าง PDF 2 ใบและคืนลิงก์ Drive
 * @returns {{claimNo:string,receiptNo:string,claimUrl:string,receiptUrl:string}}
 */
export async function createExpenseDocuments(env, rec, settings = {}, token) {
  if (!token) throw new Error("ไม่มี Google OAuth token สำหรับสร้างเอกสาร");
  if (!rec?.id) throw new Error("รายการไม่มี id");

  const d = dateParts(rec.dateISO || rec.dateText || rec.date);
  const id = String(rec.id).replace(/[^a-zA-Z0-9]/g, "").slice(-8).toUpperCase();
  const receiptPrefix = String(settings.doc_prefix || "R").replace(/[^a-zA-Z0-9ก-๙_-]/g, "") || "R";
  const claimNo = `REQ-${d.compact}-${id}`;
  const receiptNo = `${receiptPrefix}-${d.compact}-${id}`;

  const [claim, receipt] = await Promise.all([
    htmlToPdfOnDrive(token, claimNo, buildClaimHtml(rec, settings, claimNo)),
    htmlToPdfOnDrive(token, receiptNo, buildReplacementHtml(rec, settings, receiptNo)),
  ]);

  return {
    claimNo,
    receiptNo,
    claimUrl: claim.url,
    receiptUrl: receipt.url,
  };
}
