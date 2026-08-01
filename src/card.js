// src/card.js — v5.0 “Apple-like”
// การ์ด Flex สำหรับบอท "รับจ่ายได้หมด"
//
// เป้าหมายของเวอร์ชันนี้:
//   • ลดความรู้สึกแบบฟอร์ม/ตาราง แล้วจัดลำดับสายตาใหม่
//   • จำนวนเงิน > ผู้รับ > วันที่/เอกสาร > ข้อมูลสำคัญ > การกระทำ
//   • ใช้พื้นที่ว่าง พื้นเทาอ่อน และสีสถานะเท่าที่จำเป็น
//   • เก็บ postback และ API เดิมไว้ทั้งหมด
//
// postback ทั้งหมด:
//   act=confirm  act=cancel  act=edit  act=fix&f=
//   act=paid     act=delete  act=attach  act=more  act=back

export const CARD_VERSION = '5.1-duplicate';

/* ───────────────────── Apple-like palette ───────────────────── */
const C = {
  label: '#1D1D1F',
  secondary: '#6E6E73',
  tertiary: '#AEAEB2',
  separator: '#D2D2D7',
  white: '#FFFFFF',
  grouped: '#F5F5F7',
  blue: '#0071E3',
  red: '#D70015',
  green: '#248A3D',
  orange: '#B35C00',
  tintBlue: '#F0F7FF',
  tintGreen: '#F0F8F2',
  tintOrange: '#FFF7ED',
  tintRed: '#FFF1F2',
};

const LOW_CONF = 0.75;
const MINUS = '\u2212';

/* ───────────────────────── helpers ───────────────────────── */

const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';

export function money(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  return Math.abs(num).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function normalizeDate(input) {
  if (!has(input)) return null;
  if (input instanceof Date && !Number.isNaN(input.getTime())) return input;

  const raw = String(input).trim();

  // ISO datetime / browser-friendly formats
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime()) && /[T:\-]/.test(raw)) return direct;

  const nums = raw.match(/\d+/g);
  if (!nums || nums.length < 3) return null;

  let y;
  let m;
  let d;
  if (nums[0].length === 4) [y, m, d] = nums.map(Number);
  else [d, m, y] = nums.map(Number);

  if (y > 2400) y -= 543;
  if (y < 100) y += 2000;

  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

const TH_MONTH = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];

export function formatDateTH(input) {
  const dt = normalizeDate(input);
  if (!dt) return has(input) ? String(input) : '—';
  return `${dt.getUTCDate()} ${TH_MONTH[dt.getUTCMonth()]} ${dt.getUTCFullYear() + 543}`;
}

function formatRecordedAt(input) {
  if (!has(input)) return null;
  const dt = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(dt.getTime())) return formatDateTH(input);

  const date = `${dt.getDate()} ${TH_MONTH[dt.getMonth()]} ${dt.getFullYear() + 543}`;
  const time = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  return `${date} · ${time}`;
}

function recordedAtOf(rec) {
  return rec.createdAt
    ?? rec.created_at
    ?? rec.savedAt
    ?? rec.saved_at
    ?? rec.recordedAt
    ?? rec.recorded_at
    ?? rec.timestamp
    ?? null;
}

function confOf(rec, key) {
  const c = rec.confidence || rec.conf || {};
  return typeof c[key] === 'number' ? c[key] : 1;
}

const isLow = (rec, key) => confOf(rec, key) < LOW_CONF;

function pb(act, id, extra = {}) {
  return new URLSearchParams({ act, id: id == null ? '' : String(id), ...extra }).toString();
}

/* ─────────────────────── small components ─────────────────────── */

function statusPill(text, tone = 'neutral') {
  const tones = {
    neutral: { bg: C.grouped, fg: C.secondary },
    success: { bg: C.tintGreen, fg: C.green },
    warning: { bg: C.tintOrange, fg: C.orange },
    info: { bg: C.tintBlue, fg: C.blue },
    danger: { bg: C.tintRed, fg: C.red },
  };
  const t = tones[tone] || tones.neutral;

  return {
    type: 'box',
    layout: 'horizontal',
    cornerRadius: '999px',
    backgroundColor: t.bg,
    paddingStart: '10px',
    paddingEnd: '10px',
    paddingTop: '5px',
    paddingBottom: '5px',
    flex: 0,
    contents: [{
      type: 'text', text, size: 'xxs', color: t.fg,
      weight: 'bold', flex: 0,
    }],
  };
}

function infoRow(label, value, { low = false, id = null, field = '', compact = false } = {}) {
  if (!has(value)) return null;

  const row = {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    paddingTop: compact ? '6px' : '8px',
    paddingBottom: compact ? '6px' : '8px',
    contents: [
      {
        type: 'text', text: label, size: 'xs', color: C.secondary,
        flex: 4, wrap: false,
      },
      {
        type: 'text', text: low ? `${value}  ›` : String(value),
        size: 'sm', color: low ? C.orange : C.label,
        weight: low ? 'bold' : 'regular',
        wrap: true, align: 'end', flex: 7,
      },
    ],
  };

  if (low) {
    row.action = {
      type: 'postback', label: 'แก้ไข', data: pb('fix', id, { f: field }),
    };
  }

  return row;
}

function groupedCard(rows, { margin = 'lg' } = {}) {
  const clean = rows.filter(Boolean);
  if (!clean.length) return null;

  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: C.grouped,
    cornerRadius: '16px',
    paddingStart: '14px',
    paddingEnd: '14px',
    paddingTop: '8px',
    paddingBottom: '8px',
    margin,
    contents: clean,
  };
}

function sectionLabel(text, margin = 'xl') {
  return {
    type: 'text', text, size: 'xxs', color: C.secondary,
    weight: 'bold', margin,
  };
}

function noteCard(text, tone = 'info') {
  if (!has(text)) return null;
  const warning = tone === 'warn';
  const danger = tone === 'danger';

  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: danger ? C.tintRed : (warning ? C.tintOrange : C.tintBlue),
    cornerRadius: '14px',
    paddingAll: '13px',
    margin: 'md',
    contents: [{
      type: 'text', text: String(text), size: 'xs',
      color: danger ? C.red : (warning ? C.orange : C.blue),
      wrap: true,
    }],
  };
}

function duplicateWarning(check) {
  if (!check?.hasDuplicate || !Array.isArray(check.matches) || !check.matches.length) return null;

  const high = check.level === 'high';
  const lines = check.matches.slice(0, 2).map((m, i) => {
    const who = has(m.vendor) ? ` · ${m.vendor}` : '';
    return `${i + 1}. ${formatDateTH(m.date || m.dateISO)} · ฿${money(m.amount)}${who}\n${m.reason}`;
  });

  const contents = [
    {
      type: 'text',
      text: high ? 'พบความเสี่ยงเบิกซ้ำสูง' : 'พบรายการที่อาจเบิกซ้ำ',
      size: 'sm', weight: 'bold', color: C.red, wrap: true,
    },
    {
      type: 'text',
      text: `ระบบพบ ${check.matches.length} รายการคล้ายกัน กรุณาตรวจสอบก่อนบันทึก`,
      size: 'xs', color: C.red, margin: 'xs', wrap: true,
    },
    {
      type: 'text',
      text: lines.join('\n\n'),
      size: 'xxs', color: C.label, margin: 'md', wrap: true,
    },
  ];

  const evidence = check.matches.find((m) => has(m.imageUrl));
  if (evidence) {
    contents.push({
      type: 'button', style: 'link', height: 'sm', color: C.blue, margin: 'sm',
      action: { type: 'uri', label: 'เปิดหลักฐานรายการเดิม', uri: evidence.imageUrl },
    });
  }

  return {
    type: 'box', layout: 'vertical',
    backgroundColor: C.tintRed,
    cornerRadius: '16px',
    paddingAll: '14px',
    margin: 'lg',
    contents,
  };
}

function statsLine(stats) {
  if (!stats) return null;
  const parts = [];
  if (has(stats.monthTotal)) parts.push(`เดือนนี้ ฿${money(stats.monthTotal)}`);
  if (has(stats.categoryTotal)) parts.push(`หมวดนี้ ฿${money(stats.categoryTotal)}`);
  if (has(stats.unpaidTotal)) parts.push(`ค้างจ่าย ฿${money(stats.unpaidTotal)}`);
  if (!parts.length) return null;

  return {
    type: 'text', text: parts.join('   ·   '),
    size: 'xxs', color: C.secondary, margin: 'md', wrap: true,
  };
}

function taxRows(rec) {
  const total = Number(rec.amount);
  if (!Number.isFinite(total)) return [];

  const hasVat = rec.vat === true || Number(rec.vatRate) > 0 || Number(rec.vatAmount) > 0;
  const whtRate = Number(rec.whtRate || 0);
  if (!hasVat && !whtRate) return [];

  const out = [];
  let base = total;

  if (hasVat) {
    const rate = Number(rec.vatRate) > 0 ? Number(rec.vatRate) : 7;
    const vatAmt = has(rec.vatAmount)
      ? Number(rec.vatAmount)
      : total - total / (1 + rate / 100);
    base = total - vatAmt;
    out.push(infoRow('ก่อน VAT', `฿${money(base)}`, { compact: true }));
    out.push(infoRow(`VAT ${rate}%`, `฿${money(vatAmt)}`, { compact: true }));
  }

  if (whtRate > 0) {
    const wht = base * (whtRate / 100);
    out.push(infoRow(`หัก ณ ที่จ่าย ${whtRate}%`, `${MINUS}฿${money(wht)}`, { compact: true }));
    out.push(infoRow('ยอดจ่ายจริง', `฿${money(total - wht)}`, { compact: true }));
  }

  return out;
}

function textLink(text, action, color = C.blue) {
  return {
    type: 'text', text, size: 'xs', color,
    weight: 'bold', flex: 0, action,
  };
}

function dot() {
  return { type: 'text', text: '·', size: 'xs', color: C.tertiary, flex: 0 };
}

function documentButton(label, uri, primary = false) {
  return {
    type: 'button',
    style: primary ? 'primary' : 'secondary',
    color: primary ? C.blue : undefined,
    height: 'sm',
    action: { type: 'uri', label, uri },
  };
}

/* ─────────────────────── main record card ─────────────────────── */

export function buildRecordCard(rec = {}, opts = {}) {
  const mode = opts.mode === 'confirm' ? 'confirm' : 'saved';
  const id = opts.id ?? rec.id ?? '';
  const isIncome = rec.type === 'income' || rec.type === 'รายรับ';
  const isTransferSlip = rec.docType === 'สลิปโอนเงิน';

  const title = has(rec.vendor)
    ? String(rec.vendor)
    : has(rec.category)
      ? String(rec.category)
      : isIncome ? 'รายรับ' : 'รายจ่าย';

  const duplicateCheck = opts.duplicateCheck || null;
  const hasDuplicate = !!duplicateCheck?.hasDuplicate;
  const savedAsDuplicate = has(rec.duplicateStatus);

  const statusText = mode === 'confirm'
    ? (hasDuplicate ? 'เสี่ยงเบิกซ้ำ' : 'รอตรวจสอบ')
    : savedAsDuplicate ? 'บันทึกซ้ำแล้ว' : (rec.paid ? 'จ่ายแล้ว' : 'บันทึกแล้ว');

  const statusTone = (hasDuplicate || savedAsDuplicate)
    ? 'danger'
    : mode === 'confirm'
      ? 'warning'
      : rec.paid ? 'success' : 'info';

  const amountColor = isIncome ? C.green : C.label;
  const prefix = isIncome ? '+' : MINUS;

  const docMeta = [formatDateTH(rec.date), rec.docType].filter(has).join('  ·  ');
  const recordedAt = formatRecordedAt(recordedAtOf(rec));

  const transferorValue = isTransferSlip
    ? (has(rec.transferor) ? rec.transferor : 'ไม่พบข้อมูล')
    : rec.transferor;

  const receiverValue = isTransferSlip
    ? (has(rec.vendor) ? rec.vendor : 'ไม่พบข้อมูล')
    : rec.vendor;

  const summaryRows = [
    infoRow(isTransferSlip ? 'จาก' : 'ผู้จ่าย', transferorValue, {
      low: isTransferSlip && (!has(rec.transferor) || isLow(rec, 'transferor')),
      id, field: 'transferor',
    }),
    infoRow(isTransferSlip ? 'ถึง' : 'ร้าน / ผู้รับ', receiverValue, {
      low: isTransferSlip && (!has(rec.vendor) || isLow(rec, 'vendor')),
      id, field: 'vendor',
    }),
    infoRow('หมวด', rec.category, {
      low: isLow(rec, 'category'), id, field: 'category',
    }),
    mode === 'saved'
      ? infoRow('สถานะ', rec.paid ? 'จ่ายแล้ว' : 'ยังไม่จ่าย')
      : null,
    recordedAt ? infoRow('บันทึกเมื่อ', recordedAt) : null,
    ...taxRows(rec),
  ];

  const bodyContents = [
    {
      type: 'box', layout: 'horizontal', alignItems: 'center',
      contents: [
        statusPill(statusText, statusTone),
        { type: 'filler' },
        has(rec.docType)
          ? { type: 'text', text: String(rec.docType), size: 'xxs', color: C.secondary, flex: 0 }
          : null,
      ].filter(Boolean),
    },
    {
      type: 'text',
      text: `${prefix}฿${money(rec.amount)}`,
      size: '4xl', weight: 'bold', color: amountColor,
      margin: 'xl', wrap: false,
    },
    {
      type: 'text', text: title, size: 'lg', weight: 'bold', color: C.label,
      wrap: true, maxLines: 2, margin: 'md',
      action: isLow(rec, 'vendor')
        ? { type: 'postback', label: 'แก้ไข', data: pb('fix', id, { f: 'vendor' }) }
        : undefined,
    },
    {
      type: 'text', text: docMeta || '—', size: 'xs', color: C.secondary,
      margin: 'xs', wrap: true,
      action: isLow(rec, 'date')
        ? { type: 'postback', label: 'แก้ไข', data: pb('fix', id, { f: 'date' }) }
        : undefined,
    },
    statsLine(opts.stats),
  ].filter(Boolean);

  if (mode === 'confirm' && hasDuplicate) {
    bodyContents.push(duplicateWarning(duplicateCheck));
  }

  if (mode === 'confirm') {
    bodyContents.push(noteCard(
      hasDuplicate
        ? 'ตรวจทั้งรายการเดิมและข้อมูลที่ AI อ่านมา หากเป็นคนละรายการจริงจึงค่อยกดบันทึกซ้ำอยู่ดี'
        : 'ตรวจข้อมูลก่อนบันทึก ช่องสีส้มคือข้อมูลที่ AI ยังไม่มั่นใจและแตะแก้ไขได้',
      'warn',
    ));
  }

  if (mode === 'saved' && savedAsDuplicate) {
    bodyContents.push(noteCard(
      `${rec.duplicateStatus}${has(rec.duplicateOf) ? ` · อ้างอิง ${rec.duplicateOf}` : ''}`,
      'danger',
    ));
  }

  const alerts = [
    opts.setupUrl
      ? noteCard(opts.setupWarn || 'ข้อมูลบริษัทยังไม่ครบ เอกสารอัตโนมัติอาจไม่สมบูรณ์', 'warn')
      : null,
    noteCard(opts.docWarn, 'warn'),
    noteCard(opts.insight || rec.flag, 'info'),
  ].filter(Boolean);

  bodyContents.push(...alerts);
  bodyContents.push(groupedCard(summaryRows));

  if (has(rec.note)) {
    bodyContents.push(sectionLabel('หมายเหตุ'));
    bodyContents.push({
      type: 'box', layout: 'vertical', backgroundColor: C.grouped,
      cornerRadius: '14px', paddingAll: '13px', margin: 'md',
      action: isLow(rec, 'note')
        ? { type: 'postback', label: 'แก้ไข', data: pb('fix', id, { f: 'note' }) }
        : undefined,
      contents: [{
        type: 'text', text: isLow(rec, 'note') ? `${rec.note}  ›` : String(rec.note),
        size: 'sm', color: isLow(rec, 'note') ? C.orange : C.label,
        wrap: true,
      }],
    });
  }

  const footerContents = [];

  if (mode === 'confirm') {
    footerContents.push({
      type: 'button', style: 'primary', color: hasDuplicate ? C.red : C.blue, height: 'sm',
      action: {
        type: 'postback',
        label: hasDuplicate ? 'บันทึกซ้ำอยู่ดี' : 'ยืนยันและบันทึก',
        data: pb(hasDuplicate ? 'confirm_force' : 'confirm', id),
      },
    });
    footerContents.push({
      type: 'box', layout: 'horizontal', margin: 'xs', contents: [
        {
          type: 'button', style: 'link', height: 'sm', color: C.blue,
          action: { type: 'postback', label: 'แก้ไขข้อมูล', data: pb('edit', id) },
        },
        {
          type: 'button', style: 'link', height: 'sm', color: C.secondary,
          action: { type: 'postback', label: 'ยกเลิก', data: pb('cancel', id) },
        },
      ],
    });
  } else {
    footerContents.push({
      type: 'button',
      style: rec.paid ? 'secondary' : 'primary',
      color: rec.paid ? undefined : C.green,
      height: 'sm',
      action: {
        type: 'postback',
        label: rec.paid ? '✓ จ่ายแล้ว' : 'ทำเครื่องหมายว่าจ่ายแล้ว',
        data: pb('paid', id),
      },
    });

    const driveLink = opts.driveLink || rec.imageUrl;
    const quickLinks = [
      textLink('แก้ไข', { type: 'postback', label: 'แก้ไข', data: pb('edit', id) }),
    ];

    if (driveLink) {
      quickLinks.push(dot());
      quickLinks.push(textLink('หลักฐาน', { type: 'uri', label: 'หลักฐาน', uri: driveLink }));
    }

    quickLinks.push(dot());
    quickLinks.push(textLink(
      'เพิ่มเติม',
      { type: 'postback', label: 'เพิ่มเติม', data: pb('more', id) },
      C.secondary,
    ));
    quickLinks.push({ type: 'filler' });

    footerContents.push({
      type: 'box', layout: 'baseline', spacing: 'sm',
      paddingTop: '6px', paddingBottom: '2px', contents: quickLinks,
    });

    const docButtons = [];
    if (opts.claimUrl) docButtons.push(documentButton('ใบขอเบิก', opts.claimUrl));
    if (opts.receiptUrl) docButtons.push(documentButton('ใบแทน', opts.receiptUrl));

    if (docButtons.length) {
      footerContents.push(sectionLabel('เอกสาร', 'md'));
      footerContents.push({
        type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm',
        contents: docButtons,
      });
    }

    if (opts.setupUrl) {
      footerContents.push({ type: 'separator', color: C.separator, margin: 'md' });
      footerContents.push({
        type: 'button', style: 'primary', color: C.orange, height: 'sm', margin: 'md',
        action: { type: 'uri', label: 'เพิ่มข้อมูลบริษัท', uri: opts.setupUrl },
      });
    } else if (!docButtons.length && opts.documentsUrl) {
      footerContents.push({ type: 'separator', color: C.separator, margin: 'md' });
      footerContents.push({
        type: 'button', style: 'link', height: 'sm', color: C.blue,
        action: { type: 'uri', label: 'ดูสถานะเอกสาร', uri: opts.documentsUrl },
      });
    }
  }

  return {
    type: 'flex',
    altText: `${statusText} ${isIncome ? 'รายรับ' : 'รายจ่าย'} ฿${money(rec.amount)} — ${title}`,
    contents: {
      type: 'bubble',
      size: 'giga',
      body: {
        type: 'box', layout: 'vertical',
        paddingStart: '22px', paddingEnd: '22px',
        paddingTop: '22px', paddingBottom: '18px',
        contents: bodyContents,
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        paddingStart: '16px', paddingEnd: '16px',
        paddingTop: '10px', paddingBottom: '12px',
        contents: footerContents,
      },
      styles: {
        body: { backgroundColor: C.white },
        footer: {
          backgroundColor: C.white,
          separator: true,
          separatorColor: C.separator,
        },
      },
    },
  };
}

/* ───────────────── secondary menu card ───────────────── */

export function buildMoreCard(rec = {}, opts = {}) {
  const id = opts.id ?? rec.id ?? '';
  const title = has(rec.vendor) ? String(rec.vendor) : 'รายการนี้';

  const item = (label, sub, action, danger = false) => ({
    type: 'box',
    layout: 'vertical',
    backgroundColor: C.grouped,
    cornerRadius: '14px',
    paddingAll: '14px',
    margin: 'sm',
    action,
    contents: [
      {
        type: 'box', layout: 'baseline', contents: [
          {
            type: 'text', text: label, size: 'sm', weight: 'bold',
            color: danger ? C.red : C.label, flex: 0,
          },
          { type: 'filler' },
          { type: 'text', text: '›', size: 'md', color: C.tertiary, flex: 0 },
        ],
      },
      {
        type: 'text', text: sub, size: 'xxs', color: C.secondary,
        margin: 'xs', wrap: true,
      },
    ],
  });

  const rows = [
    item(
      'แนบหลักฐานเพิ่ม',
      'ส่งใบเสร็จหรือสลิปเพิ่มให้รายการนี้',
      { type: 'postback', label: 'แนบหลักฐาน', data: pb('attach', id) },
    ),
  ];

  if (opts.dashboardUrl) {
    rows.push(item(
      'เปิดแดชบอร์ด',
      'ดูรายงาน เอกสาร หลักฐาน และการตั้งค่า',
      { type: 'uri', label: 'เปิดแดชบอร์ด', uri: opts.dashboardUrl },
    ));
  }

  rows.push(item(
    'ลบรายการ',
    'นำรายการนี้ออกจากบัญชี',
    { type: 'postback', label: 'ลบรายการ', data: pb('delete', id) },
    true,
  ));

  return {
    type: 'flex',
    altText: 'ตัวเลือกเพิ่มเติม',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box', layout: 'vertical',
        paddingAll: '22px',
        contents: [
          { type: 'text', text: 'เพิ่มเติม', size: 'xxs', color: C.secondary, weight: 'bold' },
          {
            type: 'text', text: title, size: 'lg', weight: 'bold',
            color: C.label, wrap: true, maxLines: 2, margin: 'sm',
          },
          { type: 'box', layout: 'vertical', margin: 'lg', contents: rows },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        paddingStart: '16px', paddingEnd: '16px', paddingBottom: '10px',
        contents: [{
          type: 'button', style: 'link', height: 'sm', color: C.secondary,
          action: { type: 'postback', label: 'กลับ', data: pb('back', id) },
        }],
      },
      styles: {
        body: { backgroundColor: C.white },
        footer: { backgroundColor: C.white },
      },
    },
  };
}

export const buildConfirmCard = (rec, opts = {}) =>
  buildRecordCard(rec, { ...opts, mode: 'confirm' });

export const buildSavedCard = (rec, opts = {}) =>
  buildRecordCard(rec, { ...opts, mode: 'saved' });

export default {
  buildRecordCard,
  buildConfirmCard,
  buildSavedCard,
  buildMoreCard,
  formatDateTH,
  normalizeDate,
  money,
  CARD_VERSION,
};
