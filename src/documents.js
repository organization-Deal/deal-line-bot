// สร้าง "ใบขอเบิก" + "ใบรับรองแทนใบเสร็จรับเงิน" อัตโนมัติ
// Flow: HTML → Google Docs (Drive import) → export PDF → อัป PDF กลับเข้า Drive
// V3 ปรับ HTML ให้ Google Docs แปลงได้ตรงขึ้น: กำหนดขนาดรูปด้วย attribute,
// ตารางจัดวางทั้งหมด border=0 และลดความสูงเพื่อให้จบในหน้าเดียว

import { ensureTenantDriveFolders, monthlyFolderIdForCategory } from "./drive-folders.js";
export const DOCUMENT_TEMPLATE_VERSION = "FORMAL_DOCS_V3_GOOGLE_SAFE_20260802";

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
    y = now.getUTCFullYear();
    m = now.getUTCMonth() + 1;
    d = now.getUTCDate();
  }
  const p = (x) => String(x || 1).padStart(2, "0");
  return {
    iso: `${y}-${p(m)}-${p(d)}`,
    compact: `${y}${p(m)}${p(d)}`,
    en: `${p(d)}/${p(m)}/${y}`,
    th: `${p(d)}/${p(m)}/${y + 543}`,
  };
}

function concatBytes(...parts) {
  const arrays = parts.map((p) => p instanceof Uint8Array ? p : new Uint8Array(p));
  const total = arrays.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.byteLength;
  }
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
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
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

function img(url, alt, width = 72) {
  if (!url) return "";
  // Google Docs importer มักไม่สน max-width แต่ยอมรับ width attribute
  return `<img src="${esc(url)}" alt="${esc(alt)}" width="${width}" style="width:${width}px;height:auto;border:0">`;
}

function shell(title, body) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    @page{size:A4;margin:12mm 13mm}
    body{font-family:'Sarabun','Noto Sans Thai',Tahoma,Arial,sans-serif;color:#111;font-size:9.4pt;line-height:1.35;margin:0}
    table{border-collapse:collapse}
    table.form-grid{border:1px solid #222}
    table.form-grid th,table.form-grid td{border:1px solid #222}
    .no-border,.no-border tr,.no-border td{border:0!important}
  </style></head><body>${body}</body></html>`;
}

function formalCompanyHeader(settings) {
  const address = esc(settings.company_address || "—").replace(/\\n|\n/g, "<br>");
  return `<table class="no-border" border="0" cellspacing="0" cellpadding="0" width="100%" style="width:100%;border:0;margin:0 0 7px">
    <tr>
      <td width="90" style="width:90px;border:0;vertical-align:top;text-align:left;padding:0">${img(settings.logo_url, "โลโก้บริษัท", 68)}</td>
      <td style="border:0;vertical-align:top;text-align:center;padding:0 10px">
        <div style="font-size:14pt;font-weight:700;line-height:1.2">${esc(settings.company_name || "—")}</div>
        <div style="font-size:9.5pt;line-height:1.35;margin-top:2px">${address}</div>
        ${settings.tax_id ? `<div style="font-size:9.5pt;line-height:1.35">เลขที่ประจำตัวผู้เสียภาษี : ${esc(settings.tax_id)}</div>` : ""}
      </td>
      <td width="90" style="width:90px;border:0"></td>
    </tr>
  </table>`;
}

function claimNumberBlock(claimNo) {
  return `<div style="text-align:right;font-size:9.5pt;line-height:1.35;margin:2px 2px 7px">
    <div><b>เลขที่</b></div><div style="font-size:10.5pt;font-weight:700">${esc(claimNo)}</div>
  </div>`;
}

function replacementMeta(receiptNo, issueDate) {
  return `<div style="font-size:8.8pt;line-height:1.45;margin:5px 0 12px">
    <div><b>เลขที่เอกสาร:</b> ${esc(receiptNo)}</div>
    <div><b>เลขที่ชุด:</b> ${esc(receiptNo)}</div>
    <div><b>วันที่สร้างเอกสาร:</b> ${esc(issueDate)}</div>
  </div>`;
}

function signatureCell(name, role, issueDate, signUrl = "", position = "") {
  const roleLine = position ? `${esc(role)} ตำแหน่ง ${esc(position)}` : esc(role);
  return `<td width="50%" style="width:50%;border:0;text-align:center;vertical-align:bottom;padding:10px 24px 0">
    <div style="height:38px;text-align:center">${img(signUrl, `ลายเซ็น ${role}`, 120) || "&nbsp;"}</div>
    <div style="border-top:1px solid #333;width:78%;margin:0 auto;padding-top:4px"></div>
    <div style="font-weight:700">(${esc(name || "—")})</div>
    <div style="font-size:8.7pt;margin-top:1px">${roleLine}</div>
    <div style="font-size:8.5pt;margin-top:1px">วันที่ ${esc(issueDate)}</div>
  </td>`;
}

function formalSignatures(payer, settings, issueDate, payerPosition = "") {
  return `<table class="no-border" border="0" cellspacing="0" cellpadding="0" width="100%" style="width:100%;border:0;margin-top:15px;page-break-inside:avoid">
    <tr>
      ${signatureCell(payer, "ผู้เบิกจ่าย", issueDate, "", payerPosition)}
      ${signatureCell(settings.approver_name, "ผู้อนุมัติ", issueDate, settings.approver_sign_url || "", settings.approver_position || "")}
    </tr>
  </table>`;
}

function buildClaimHtml(rec, settings, claimNo) {
  const tx = dateParts(rec.dateISO || rec.dateText || rec.date);
  const issue = dateParts(new Date().toISOString()).en;
  const payer = rec.payerName || rec.sender || "—";
  const payerPosition = rec.payerPosition || rec.position || settings.payer_position || "";
  const transferor = rec.transferor || payer;
  const detail = rec.note || rec.category || "ค่าใช้จ่าย";
  const paymentChannel = rec.paymentMethod || rec.docType || "โอนเงิน";
  const accountName = rec.bankAccountName || settings.bank_account_name || transferor || "—";
  const accountNo = rec.bankAccountNo || settings.bank_account_no || "—";
  const bankName = rec.bankName || settings.bank_name || "—";
  const evidence = rec.imageUrl
    ? `<a href="${esc(rec.imageUrl)}" style="color:#111;text-decoration:underline">เปิดหลักฐานต้นฉบับ</a>`
    : "—";
  const blankRows = Array.from({ length: 4 }, () =>
    `<tr style="height:25px"><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>`
  ).join("");

  return shell("ใบขอเบิก", `
    ${formalCompanyHeader(settings)}
    ${claimNumberBlock(claimNo)}

    <div style="text-align:center;font-size:17pt;font-weight:700;margin:5px 0 13px">ใบขอเบิก</div>

    <table class="form-grid" border="1" cellspacing="0" cellpadding="5" width="100%" style="width:100%;table-layout:fixed;font-size:9.1pt">
      <thead>
        <tr style="height:31px">
          <th width="8%" style="width:8%;text-align:center">ลำดับ</th>
          <th width="15%" style="width:15%;text-align:center">วันที่</th>
          <th width="43%" style="width:43%;text-align:center">รายการ</th>
          <th width="12%" style="width:12%;text-align:center">หน่วย</th>
          <th width="22%" style="width:22%;text-align:center">จำนวนเงิน<br>(บาท)</th>
        </tr>
      </thead>
      <tbody>
        <tr style="height:37px">
          <td style="text-align:center;vertical-align:middle">1</td>
          <td style="text-align:center;vertical-align:middle">${esc(tx.en)}</td>
          <td style="vertical-align:middle">${esc(detail)}</td>
          <td style="text-align:center;vertical-align:middle">-</td>
          <td style="text-align:right;vertical-align:middle">${money(rec.amount)}</td>
        </tr>
        ${blankRows}
      </tbody>
    </table>

    <div style="text-align:right;font-size:10pt;font-weight:700;margin-top:8px">รวมทั้งสิ้น ${money(rec.amount)} บาท</div>

    <div style="font-size:8.8pt;margin-top:15px;line-height:1.5;page-break-inside:avoid">
      <div style="font-weight:700;margin-bottom:4px">ข้อมูลการโอนเงิน</div>
      <div>ช่องทางการโอน: <b>${esc(paymentChannel)}</b>&nbsp;&nbsp;&nbsp;&nbsp;ผู้ขอเบิก: <b>${esc(payer)}</b></div>
      <div>ชื่อบัญชี: <b>${esc(accountName)}</b>&nbsp;&nbsp;&nbsp;&nbsp;เลขบัญชี: <b>${esc(accountNo)}</b></div>
      <div>ธนาคาร: <b>${esc(bankName)}</b>&nbsp;&nbsp;&nbsp;&nbsp;ผู้รับ / ไปยัง: <b>${esc(rec.vendor || "—")}</b></div>
      <div>ผู้โอน / จากบัญชี: <b>${esc(transferor)}</b>&nbsp;&nbsp;&nbsp;&nbsp;หลักฐานอ้างอิง: ${evidence}</div>
    </div>

    ${formalSignatures(payer, settings, issue, payerPosition)}
  `);
}

function buildReplacementHtml(rec, settings, receiptNo) {
  const tx = dateParts(rec.dateISO || rec.dateText || rec.date);
  const issue = dateParts(new Date().toISOString()).en;
  const payer = rec.payerName || rec.sender || "—";
  const payerPosition = rec.payerPosition || rec.position || settings.payer_position || "";
  const transferor = rec.transferor || payer;
  const recipient = rec.vendor || "—";
  const detail = rec.note || rec.category || "ค่าใช้จ่าย";
  const noReceiptReason = rec.noReceiptReason || "ไม่อาจเรียกเก็บใบเสร็จรับเงินจากผู้รับได้";
  const note = rec.receiptNote || "";
  const blankRows = Array.from({ length: 7 }, () =>
    `<tr style="height:25px"><td>&nbsp;</td><td></td><td></td><td></td></tr>`
  ).join("");

  return shell("ใบรับรองแทนใบเสร็จรับเงิน", `
    ${formalCompanyHeader(settings)}
    ${replacementMeta(receiptNo, issue)}

    <div style="text-align:center;font-size:16.5pt;font-weight:700;margin:6px 0 3px">ใบรับรองแทนใบเสร็จรับเงิน</div>
    <div style="text-align:center;font-size:10.5pt;margin-bottom:13px">
      บจ. / หจก. ${esc(settings.company_name || "—")} (ผู้ซื้อ/ผู้รับบริการ)
    </div>

    <table class="form-grid" border="1" cellspacing="0" cellpadding="5" width="100%" style="width:100%;table-layout:fixed;font-size:9pt">
      <thead>
        <tr style="height:31px">
          <th width="20%" style="width:20%;text-align:center">วัน เดือน ปี</th>
          <th width="38%" style="width:38%;text-align:center">รายละเอียดรายจ่าย</th>
          <th width="18%" style="width:18%;text-align:center">จำนวนเงิน</th>
          <th width="24%" style="width:24%;text-align:center">หมายเหตุ</th>
        </tr>
      </thead>
      <tbody>
        <tr style="height:42px">
          <td style="text-align:center;vertical-align:middle">${esc(tx.en)}</td>
          <td style="text-align:center;vertical-align:middle">${esc(detail)}</td>
          <td style="text-align:right;vertical-align:middle">${money(rec.amount)}</td>
          <td style="vertical-align:middle">${esc(note)}</td>
        </tr>
        ${blankRows}
      </tbody>
    </table>

    <div style="text-align:right;font-size:10pt;font-weight:700;margin-top:8px">รวมทั้งสิ้น : ${money(rec.amount)} บาท</div>

    <div style="margin-top:15px;font-size:8.8pt;line-height:1.5;page-break-inside:avoid">
      <div>ข้าพเจ้า <b>${esc(payer)}</b> (ผู้เบิกจ่าย)${payerPosition ? ` ตำแหน่ง <b>${esc(payerPosition)}</b>` : ""}</div>
      <div style="margin-top:5px">ขอรับรองว่า รายจ่ายข้างต้นนี้${esc(noReceiptReason)} และข้าพเจ้าได้จ่ายไปในงานของบริษัท / ห้างหุ้นส่วนจำกัดโดยแท้จริง</div>
      <div style="margin-top:3px">ผู้โอน / จากบัญชี: <b>${esc(transferor)}</b>&nbsp;&nbsp;&nbsp;&nbsp;ผู้รับ / ไปยัง: <b>${esc(recipient)}</b></div>
      <div style="margin-top:3px">ดังนั้น ในวันที่ ${esc(issue)}</div>
    </div>

    ${formalSignatures(payer, settings, issue, payerPosition)}
  `);
}

async function htmlToPdfOnDrive(token, name, html, folderId = "") {
  let docId = null;
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
      ...(folderId ? { parents: [folderId] } : {}),
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
export async function createExpenseDocuments(env, rec, settings = {}, token, options = {}) {
  if (!token) throw new Error("ไม่มี Google OAuth token สำหรับสร้างเอกสาร");
  if (!rec?.id) throw new Error("รายการไม่มี id");

  console.log(`[documents] template=${DOCUMENT_TEMPLATE_VERSION} id=${rec.id}`);

  const d = dateParts(rec.dateISO || rec.dateText || rec.date);
  const id = String(rec.id).replace(/[^a-zA-Z0-9]/g, "").slice(-8).toUpperCase();
  const receiptPrefix = String(settings.doc_prefix || "R").replace(/[^a-zA-Z0-9ก-๙_-]/g, "") || "R";
  const claimNo = `REQ-${d.compact}-${id}`;
  const receiptNo = `${receiptPrefix}-${d.compact}-${id}`;

  let claimFolderId = String(options.claimFolderId || "");
  let replacementFolderId = String(options.replacementFolderId || "");
  if (options.tenant && (!claimFolderId || !replacementFolderId)) {
    const folders = await ensureTenantDriveFolders(env, options.tenant, token, {
      companyName: options.companyName || settings.company_name || "พื้นที่บริษัท",
      sheetId: options.sheetId || "",
      transactionDate: rec.submittedAt || rec.createdAt || rec.created_at || rec.recordedAt || new Date().toISOString(),
    });
    claimFolderId ||= monthlyFolderIdForCategory(folders, "claims");
    replacementFolderId ||= monthlyFolderIdForCategory(folders, "replacements");
  }

  const [claim, receipt] = await Promise.all([
    htmlToPdfOnDrive(token, claimNo, buildClaimHtml(rec, settings, claimNo), claimFolderId),
    htmlToPdfOnDrive(token, receiptNo, buildReplacementHtml(rec, settings, receiptNo), replacementFolderId),
  ]);

  return {
    claimNo,
    receiptNo,
    claimUrl: claim.url,
    receiptUrl: receipt.url,
  };
}
