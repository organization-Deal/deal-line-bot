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
    en: `${p(d)}/${p(m)}/${y}`,
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
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>
    table.form-grid{border-collapse:collapse;border:1px solid #222}
    table.form-grid th,table.form-grid td{border:1px solid #222}
  </style></head>
  <body style="font-family:'Noto Sans Thai','Sarabun',Tahoma,Arial,sans-serif;color:#111;font-size:10.2pt;line-height:1.45;margin:34px 38px">
  ${body}</body></html>`;
}

function formalCompanyHeader(settings) {
  const address = esc(settings.company_address || "—").replace(/\\n|\n/g, "<br>");
  return `<table style="width:100%;border-collapse:collapse;margin:0 0 8px">
    <tr>
      <td style="width:15%;vertical-align:top;text-align:left;padding-top:1px">
        ${img(settings.logo_url, "โลโก้บริษัท", 74)}
      </td>
      <td style="width:70%;vertical-align:top;text-align:center;padding:0 12px">
        <div style="font-size:15.5pt;font-weight:700;line-height:1.25">${esc(settings.company_name || "—")}</div>
        <div style="font-size:10.5pt;line-height:1.45;margin-top:3px">${address}</div>
        ${settings.tax_id ? `<div style="font-size:10.5pt;line-height:1.45">เลขที่ประจำตัวผู้เสียภาษี : ${esc(settings.tax_id)}</div>` : ""}
      </td>
      <td style="width:15%"></td>
    </tr>
  </table>`;
}

function compactMeta(rows, align = "left") {
  return `<table style="width:100%;border-collapse:collapse;font-size:9.2pt;line-height:1.5;margin:6px 0 14px">
    ${rows.map(([label, value]) => `<tr>
      <td style="width:${align === "right" ? "70%" : "118px"};${align === "right" ? "" : "font-weight:700"}">${align === "right" ? "" : esc(label)}</td>
      <td style="text-align:${align};${align === "right" ? "font-weight:700" : ""}">${align === "right" ? `<span style="font-weight:400">${esc(label)}</span><br>` : ": "}${esc(value || "—")}</td>
    </tr>`).join("")}
  </table>`;
}

function signatureCell(name, role, issueDate, signUrl = "", position = "") {
  const roleLine = position ? `${esc(role)} · ${esc(position)}` : esc(role);
  return `<td style="width:50%;text-align:center;vertical-align:bottom;padding:18px 34px 0">
    <div style="height:48px;line-height:48px;text-align:center">${img(signUrl, `ลายเซ็น ${role}`, 145) || "&nbsp;"}</div>
    <div style="border-top:1px solid #333;margin:0 auto;padding-top:5px;width:82%"></div>
    <div style="font-weight:700">(${esc(name || "—")})</div>
    <div style="font-size:9.4pt;margin-top:2px">${roleLine}</div>
    <div style="font-size:9.2pt;margin-top:2px">วันที่ ${esc(issueDate)}</div>
  </td>`;
}

function formalSignatures(payer, settings, issueDate, payerPosition = "") {
  return `<table style="width:100%;border-collapse:collapse;margin-top:26px;page-break-inside:avoid">
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
  const blankRows = Array.from({ length: 7 }, () => `
    <tr style="height:27px"><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>`).join("");

  return shell("ใบขอเบิก", `
    ${formalCompanyHeader(settings)}

    <table style="width:100%;border-collapse:collapse;margin:8px 0 4px">
      <tr>
        <td style="width:68%"></td>
        <td style="text-align:center;font-size:10pt"><b>เลขที่</b><br><span style="font-size:11pt;font-weight:700">${esc(claimNo)}</span></td>
      </tr>
    </table>

    <div style="text-align:center;font-size:18pt;font-weight:700;margin:10px 0 18px">ใบขอเบิก</div>

    <table class="form-grid" style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:9.8pt" border="1" cellpadding="6">
      <thead>
        <tr style="height:34px">
          <th style="width:8%;text-align:center">ลำดับ</th>
          <th style="width:15%;text-align:center">วันที่</th>
          <th style="width:43%;text-align:center">รายการ</th>
          <th style="width:12%;text-align:center">หน่วย</th>
          <th style="width:22%;text-align:center">จำนวนเงิน<br>(บาท)</th>
        </tr>
      </thead>
      <tbody>
        <tr style="height:42px">
          <td style="text-align:center;vertical-align:middle">1</td>
          <td style="text-align:center;vertical-align:middle">${esc(tx.en)}</td>
          <td style="vertical-align:middle">${esc(detail)}</td>
          <td style="text-align:center;vertical-align:middle">-</td>
          <td style="text-align:right;vertical-align:middle">${money(rec.amount)}</td>
        </tr>
        ${blankRows}
      </tbody>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:10.5pt">
      <tr><td style="width:66%"></td><td style="text-align:right"><b>รวมทั้งสิ้น&nbsp;&nbsp;${money(rec.amount)} บาท</b></td></tr>
    </table>

    <div style="font-size:9.4pt;margin-top:24px;page-break-inside:avoid">
      <div style="font-weight:700;margin-bottom:7px">ข้อมูลการโอนเงิน</div>
      <table style="width:100%;border-collapse:collapse;line-height:1.6">
        <tr>
          <td style="width:15%">ช่องทางการโอน</td><td style="width:35%"><b>${esc(paymentChannel)}</b></td>
          <td style="width:13%">ผู้ขอเบิก</td><td style="width:37%"><b>${esc(payer)}</b></td>
        </tr>
        <tr>
          <td>ชื่อบัญชี</td><td><b>${esc(accountName)}</b></td>
          <td>เลขบัญชี</td><td><b>${esc(accountNo)}</b></td>
        </tr>
        <tr>
          <td>ธนาคาร</td><td><b>${esc(bankName)}</b></td>
          <td>ผู้รับ / ไปยัง</td><td><b>${esc(rec.vendor || "—")}</b></td>
        </tr>
        <tr>
          <td>หลักฐานอ้างอิง</td><td colspan="3">${evidence}</td>
        </tr>
      </table>
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
  const blankRows = Array.from({ length: 8 }, () => `
    <tr style="height:28px"><td>&nbsp;</td><td></td><td></td><td></td></tr>`).join("");

  return shell("ใบรับรองแทนใบเสร็จรับเงิน", `
    ${formalCompanyHeader(settings)}
    ${compactMeta([
      ["เลขที่เอกสาร", receiptNo],
      ["เลขที่ชุด", receiptNo],
      ["วันที่สร้างเอกสาร", issue],
    ])}

    <div style="text-align:center;font-size:17.5pt;font-weight:700;margin:10px 0 4px">ใบรับรองแทนใบเสร็จรับเงิน</div>
    <div style="text-align:center;font-size:11pt;margin-bottom:18px">
      บจ. / หจก. ${esc(settings.company_name || "—")} (ผู้ซื้อ/ผู้รับบริการ)
    </div>

    <table class="form-grid" style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:9.7pt" border="1" cellpadding="6">
      <thead>
        <tr style="height:34px">
          <th style="width:20%;text-align:center">วัน เดือน ปี</th>
          <th style="width:38%;text-align:center">รายละเอียดรายจ่าย</th>
          <th style="width:18%;text-align:center">จำนวนเงิน</th>
          <th style="width:24%;text-align:center">หมายเหตุ</th>
        </tr>
      </thead>
      <tbody>
        <tr style="height:48px">
          <td style="text-align:center;vertical-align:middle">${esc(tx.en)}</td>
          <td style="text-align:center;vertical-align:middle">${esc(detail)}</td>
          <td style="text-align:right;vertical-align:middle">${money(rec.amount)}</td>
          <td style="vertical-align:middle">${esc(note)}</td>
        </tr>
        ${blankRows}
      </tbody>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:10.5pt">
      <tr><td style="width:64%"></td><td style="text-align:right"><b>รวมทั้งสิ้น : ${money(rec.amount)} บาท</b></td></tr>
    </table>

    <div style="margin-top:22px;font-size:9.3pt;line-height:1.6;page-break-inside:avoid">
      <div>ข้าพเจ้า <b>${esc(payer)}</b> (ผู้เบิกจ่าย)${payerPosition ? ` ตำแหน่ง <b>${esc(payerPosition)}</b>` : ""}</div>
      <div style="margin-top:7px">
        ขอรับรองว่า รายจ่ายข้างต้นนี้${esc(noReceiptReason)} และข้าพเจ้าได้จ่ายไปในงานของทางบริษัท / ห้างหุ้นส่วนจำกัดโดยแท้จริง
      </div>
      <div style="margin-top:4px">ผู้โอน / จากบัญชี: <b>${esc(transferor)}</b>&nbsp;&nbsp;&nbsp;&nbsp;ผู้รับ / ไปยัง: <b>${esc(recipient)}</b></div>
      <div style="margin-top:4px">ดังนั้น ในวันที่ ${esc(issue)}</div>
    </div>

    ${formalSignatures(payer, settings, issue, payerPosition)}
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
