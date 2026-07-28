// src/card.js — v3.2
// การ์ด Flex สำหรับบอท "รับจ่ายได้หมด"
//
// เปลี่ยนจาก v3.1:
//   • กล่องฟ้า 💡 อ่าน rec.flag เองแล้ว (ocr.js v2.2 เป็นคนส่งมา)
//     ไม่ต้องแก้มืออีก
//
// เปลี่ยนจาก v3.0:
//   • เพิ่มลิงก์ "ออกใบแทน" (act=slip) ทั้งการ์ดรอตรวจและการ์ดบันทึกแล้ว
//     ติ๊กแล้วขึ้น "✓ ออกใบแทน" สีเขียว — index.js เขียนคอลัมน์ L ในชีท
//
// postback ทั้งหมด:
//   act=confirm  act=cancel  act=edit  act=fix&f=
//   act=paid     act=delete  act=attach  act=slip

export const CARD_VERSION = '3.2';

/* ───────────────────── iOS system colors ───────────────────── */
const C = {
  label: '#000000',
  secondary: '#8E8E93',
  tertiary: '#C7C7CC',
  separator: '#E5E5EA',
  white: '#FFFFFF',
  blue: '#007AFF',
  red: '#FF3B30',
  green: '#34C759',
  orange: '#FF9500',
  tintBlue: '#F2F7FF',
};

const LOW_CONF = 0.75;
const MINUS = '\u2212';

/* ────────────────────────── helper ────────────────────────── */

const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';

export function money(n) {
  const num = Number(n);
  if (!isFinite(num)) return '—';
  return Math.abs(num).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function normalizeDate(input) {
  if (!has(input)) return null;
  if (input instanceof Date && !isNaN(input)) return input;

  const nums = String(input).trim().match(/\d+/g);
  if (!nums || nums.length < 3) return null;

  let y, m, d;
  if (nums[0].length === 4) [y, m, d] = nums.map(Number);
  else [d, m, y] = nums.map(Number);

  if (y > 2400) y -= 543;   // พ.ศ. -> ค.ศ.
  if (y < 100) y += 2000;

  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return isNaN(dt) ? null : dt;
}

const TH_MONTH = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];

export function formatDateTH(input) {
  const dt = normalizeDate(input);
  if (!dt) return has(input) ? String(input) : '—';
  return `${dt.getUTCDate()} ${TH_MONTH[dt.getUTCMonth()]} ${dt.getUTCFullYear() + 543}`;
}

function confOf(rec, key) {
  const c = rec.confidence || rec.conf || {};
  return typeof c[key] === 'number' ? c[key] : 1;
}
const isLow = (rec, key) => confOf(rec, key) < LOW_CONF;

function pb(act, id, extra = {}) {
  return new URLSearchParams({ act, id: id == null ? '' : String(id), ...extra }).toString();
}

/* ───────────────────────── ชิ้นส่วน ───────────────────────── */

function accentBar(color) {
  return {
    type: 'box',
    layout: 'vertical',
    width: '5px',
    backgroundColor: color,
    contents: [{ type: 'filler' }],
  };
}

function hairRow(label, value, { low = false, id = null, field = '' } = {}) {
  if (!has(value)) return null;

  const row = {
    type: 'box',
    layout: 'baseline',
    spacing: 'md',
    paddingTop: '11px',
    paddingBottom: '11px',
    contents: [
      { type: 'text', text: label, size: 'xs', color: C.secondary, flex: 4 },
      {
        type: 'text',
        text: low ? `${value}  ›` : String(value),
        size: 'sm',
        color: low ? C.orange : C.label,
        wrap: true,
        align: 'end',
        flex: 7,
      },
    ],
  };

  if (low) row.action = { type: 'postback', label: 'แก้ไข', data: pb('fix', id, { f: field }) };
  return row;
}

function hairList(rows, margin = 'lg') {
  const clean = rows.filter(Boolean);
  if (!clean.length) return null;

  const contents = [];
  clean.forEach((r) => {
    contents.push({ type: 'separator', color: C.separator });
    contents.push(r);
  });

  return { type: 'box', layout: 'vertical', margin, contents };
}

/* ─── A: สรุปเดือนนี้ ─── */
function statsLine(stats) {
  if (!stats) return null;
  const parts = [];
  if (has(stats.monthTotal)) parts.push(`เดือนนี้ ฿${money(stats.monthTotal)}`);
  if (has(stats.categoryTotal)) parts.push(`หมวดนี้ ฿${money(stats.categoryTotal)}`);
  if (has(stats.unpaidTotal)) parts.push(`ค้างจ่าย ฿${money(stats.unpaidTotal)}`);
  if (!parts.length) return null;

  return {
    type: 'text',
    text: parts.join('   ·   '),
    size: 'xxs',
    color: C.secondary,
    margin: 'md',
    wrap: true,
  };
}

/* ─── B: AI ทัก (opts.insight หรือ rec.flag จาก ocr.js) ─── */
function insightBox(insight) {
  if (!has(insight)) return null;
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: C.tintBlue,
    cornerRadius: '10px',
    paddingAll: '12px',
    margin: 'lg',
    contents: [
      { type: 'text', text: String(insight), size: 'xxs', color: C.blue, wrap: true },
    ],
  };
}

/* ─── E: ภาษี ─── */
function taxRows(rec) {
  const total = Number(rec.amount);
  if (!isFinite(total)) return [];

  const hasVat = rec.vat === true || Number(rec.vatRate) > 0 || Number(rec.vatAmount) > 0;
  const whtRate = Number(rec.whtRate || 0);
  if (!hasVat && !whtRate) return [];

  const out = [];
  let base = total;

  if (hasVat) {
    const rate = Number(rec.vatRate) > 0 ? Number(rec.vatRate) : 7;
    const vatAmt = has(rec.vatAmount) ? Number(rec.vatAmount) : total - total / (1 + rate / 100);
    base = total - vatAmt;
    out.push(hairRow('ก่อน VAT', `฿${money(base)}`));
    out.push(hairRow(`VAT ${rate}%`, `฿${money(vatAmt)}`));
  }
  if (whtRate > 0) {
    const wht = base * (whtRate / 100);
    out.push(hairRow(`หัก ณ ที่จ่าย ${whtRate}%`, `${MINUS}฿${money(wht)}`));
    out.push(hairRow('ยอดจ่ายจริง', `฿${money(total - wht)}`));
  }
  return out;
}

/* ─── D: ลิงก์ไปแถวนั้นในชีทลูกค้า ─── */
export function sheetRowUrl({ sheetId, gid = 0, row } = {}) {
  if (!has(sheetId)) return null;
  const anchor = has(row) ? `#gid=${gid}&range=A${row}` : `#gid=${gid}`;
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit${anchor}`;
}

function textLink(text, action, color = C.blue) {
  return { type: 'text', text, size: 'xs', color, weight: 'bold', flex: 0, action };
}

function dot() {
  return { type: 'text', text: '·', size: 'xs', color: C.tertiary, flex: 0 };
}

/* ─────────────────────── การ์ดหลัก ─────────────────────── */

export function buildRecordCard(rec = {}, opts = {}) {
  const mode = opts.mode === 'confirm' ? 'confirm' : 'saved';
  const id = opts.id ?? rec.id ?? '';
  const isIncome = rec.type === 'income' || rec.type === 'รายรับ';

  const accent = mode === 'confirm' ? C.orange : C.green;
  const stateText = mode === 'confirm' ? 'รอตรวจสอบ' : 'บันทึกแล้ว';

  const title = has(rec.vendor) ? String(rec.vendor)
    : has(rec.category) ? String(rec.category)
    : isIncome ? 'รายรับ' : 'รายจ่าย';

  const meta = [
    formatDateTH(rec.date),
    isIncome ? 'รายรับ' : 'รายจ่าย',
    rec.paid ? 'จ่ายแล้ว' : 'ยังไม่จ่าย',
  ].join('  ·  ');

  /* ---------- บล็อกหัว ---------- */
  const head = [
    { type: 'text', text: stateText, size: 'xxs', color: accent, weight: 'bold' },
    {
      type: 'text',
      text: `${isIncome ? '+' : MINUS}฿${money(rec.amount)}`,
      size: '3xl',
      weight: 'bold',
      color: isIncome ? C.green : C.label,
      margin: 'md',
    },
    {
      type: 'text',
      text: title,
      size: 'md',
      weight: 'bold',
      color: C.label,
      wrap: true,
      maxLines: 2,
      margin: 'md',
      action: isLow(rec, 'vendor')
        ? { type: 'postback', label: 'แก้ไข', data: pb('fix', id, { f: 'vendor' }) }
        : undefined,
    },
    {
      type: 'text',
      text: meta,
      size: 'xs',
      color: C.secondary,
      margin: 'xs',
      wrap: true,
      action: isLow(rec, 'date')
        ? { type: 'postback', label: 'แก้ไข', data: pb('fix', id, { f: 'date' }) }
        : undefined,
    },
    statsLine(opts.stats),
  ].filter(Boolean);

  if (mode === 'confirm') {
    head.push({
      type: 'text',
      text: 'AI อ่านมาจากบิล — ช่องสีส้มคือที่ไม่ชัวร์ แตะแก้ได้',
      size: 'xxs',
      color: C.orange,
      margin: 'md',
      wrap: true,
    });
  }

  /* ---------- รายละเอียด ---------- */
  const detail = hairList([
    hairRow('หมวดหมู่', rec.category, { low: isLow(rec, 'category'), id, field: 'category' }),
    hairRow('หมวดย่อย', rec.subCategory),
    hairRow('เอกสาร', rec.docType),
    hairRow('ผู้เบิกจ่าย', rec.payerName || rec.requester),
    hairRow('โน้ต', rec.note, { low: isLow(rec, 'note'), id, field: 'note' }),
    ...taxRows(rec),
  ]);

  /* ---------- แถวลิงก์: รูป + ออกใบแทน ---------- */
  const driveLink = opts.driveLink || rec.imageUrl;

  const links = [
    textLink(driveLink ? 'เพิ่มรูป' : 'แนบรูป', {
      type: 'postback', label: 'แนบรูป', data: pb('attach', id),
    }),
  ];
  if (driveLink) {
    links.push(dot());
    links.push(textLink('ดูรูปบิล', { type: 'uri', label: 'ดูรูปบิล', uri: driveLink }));
  }

  // ติ๊กว่าจะออกใบรับรองแทนใบเสร็จไหม
  links.push(dot());
  links.push(textLink(
    rec.needSlip ? '✓ ออกใบแทน' : 'ออกใบแทน',
    { type: 'postback', label: 'ออกใบแทน', data: pb('slip', id) },
    rec.needSlip ? C.green : C.blue
  ));

  links.push({ type: 'filler' });

  const inner = {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    paddingStart: '20px',
    paddingEnd: '20px',
    paddingTop: '20px',
    paddingBottom: '16px',
    contents: [
      ...head,
      insightBox(opts.insight || rec.flag),
      detail,
      { type: 'separator', color: C.separator, margin: 'none' },
      { type: 'box', layout: 'baseline', spacing: 'sm', margin: 'lg', contents: links },
    ].filter(Boolean),
  };

  const body = {
    type: 'box',
    layout: 'horizontal',
    paddingAll: '0px',
    spacing: 'none',
    contents: [accentBar(accent), inner],
  };

  /* ---------- footer ---------- */
  const footer = {
    type: 'box',
    layout: 'vertical',
    spacing: 'xs',
    paddingStart: '14px',
    paddingEnd: '14px',
    paddingTop: '6px',
    paddingBottom: '8px',
    contents: [],
  };

  if (mode === 'confirm') {
    footer.contents.push({
      type: 'button',
      style: 'primary',
      color: C.blue,
      height: 'sm',
      action: { type: 'postback', label: 'บันทึก', data: pb('confirm', id) },
    });
    footer.contents.push({
      type: 'box',
      layout: 'horizontal',
      contents: [
        {
          type: 'button', style: 'link', height: 'sm', color: C.blue,
          action: { type: 'postback', label: 'แก้ไข', data: pb('edit', id) },
        },
        {
          type: 'button', style: 'link', height: 'sm', color: C.secondary,
          action: { type: 'postback', label: 'ยกเลิก', data: pb('cancel', id) },
        },
      ],
    });
  } else {
    const url = sheetRowUrl({ sheetId: opts.sheetId, gid: opts.gid, row: opts.row });
    const primaryUri = url || opts.dashboardUrl;

    if (primaryUri) {
      footer.contents.push({
        type: 'button',
        style: 'link',
        height: 'sm',
        color: C.blue,
        action: {
          type: 'uri',
          label: url ? 'เปิดชีทของคุณ' : 'ดูแดชบอร์ด',
          uri: primaryUri,
        },
      });
      footer.contents.push({ type: 'separator', color: C.separator });
    }

    footer.contents.push({
      type: 'box',
      layout: 'horizontal',
      contents: [
        {
          type: 'button', style: 'link', height: 'sm', color: C.blue,
          action: {
            type: 'postback',
            label: rec.paid ? 'ยังไม่จ่าย' : 'จ่ายแล้ว',
            data: pb('paid', id),
          },
        },
        {
          type: 'button', style: 'link', height: 'sm', color: C.blue,
          action: { type: 'postback', label: 'แก้ไข', data: pb('edit', id) },
        },
        {
          type: 'button', style: 'link', height: 'sm', color: C.red,
          action: { type: 'postback', label: 'ลบ', data: pb('delete', id) },
        },
      ],
    });
  }

  return {
    type: 'flex',
    altText: `${stateText} ${isIncome ? 'รายรับ' : 'รายจ่าย'} ฿${money(rec.amount)} — ${title}`,
    contents: {
      type: 'bubble',
      size: 'giga',
      body,
      footer,
      styles: {
        body: { backgroundColor: C.white },
        footer: { backgroundColor: C.white, separator: true, separatorColor: C.separator },
      },
    },
  };
}

export const buildConfirmCard = (rec, opts = {}) =>
  buildRecordCard(rec, { ...opts, mode: 'confirm' });

export const buildSavedCard = (rec, opts = {}) =>
  buildRecordCard(rec, { ...opts, mode: 'saved' });

export default {
  buildRecordCard, buildConfirmCard, buildSavedCard,
  formatDateTH, normalizeDate, sheetRowUrl, money, CARD_VERSION,
};
