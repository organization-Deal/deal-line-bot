// src/card.js — v4.0
// การ์ด Flex สำหรับบอท "รับจ่ายได้หมด"
//
// เปลี่ยนจาก v3.2 — จัดปุ่มใหม่ให้ใช้ง่ายขึ้น:
//   • ตัดปุ่ม "ออกใบแทน" ออกจากการ์ด — ไปติ๊กในแดชบอร์ดแทน (ทุกรายการออกได้ บัญชีเลือกเอง)
//   • ตัดปุ่ม "เปิดชีท" ออก — ไปอยู่ในแดชบอร์ด
//   • การ์ดบันทึกแล้ว: ปุ่มหลัก [จ่ายแล้ว] เด่นอันเดียว
//     + แถวลิงก์เล็ก แก้ไข · ดูบิล · เพิ่มเติม
//     + ปุ่มล่าง 📊 เปิดแดชบอร์ด
//   • "เพิ่มเติม" (act=more) เด้งการ์ดเมนูรอง: แนบรูป · ลบ
//   • การ์ดรอตรวจ: เหลือ บันทึก / แก้ไข / ยกเลิก เหมือนเดิม แต่ตัดลิงก์ออกใบแทนออก
//
// postback ทั้งหมด:
//   act=confirm  act=cancel  act=edit  act=fix&f=
//   act=paid     act=delete  act=attach  act=more  act=back

export const CARD_VERSION = '4.0';

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
  tintGreen: '#F1FBF4',
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

  if (y > 2400) y -= 543;
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
    type: 'box', layout: 'vertical', width: '5px',
    backgroundColor: color, contents: [{ type: 'filler' }],
  };
}

function hairRow(label, value, { low = false, id = null, field = '' } = {}) {
  if (!has(value)) return null;
  const row = {
    type: 'box', layout: 'baseline', spacing: 'md',
    paddingTop: '11px', paddingBottom: '11px',
    contents: [
      { type: 'text', text: label, size: 'xs', color: C.secondary, flex: 4 },
      {
        type: 'text', text: low ? `${value}  ›` : String(value),
        size: 'sm', color: low ? C.orange : C.label,
        wrap: true, align: 'end', flex: 7,
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

function insightBox(insight) {
  if (!has(insight)) return null;
  return {
    type: 'box', layout: 'vertical', backgroundColor: C.tintBlue,
    cornerRadius: '10px', paddingAll: '12px', margin: 'lg',
    contents: [{ type: 'text', text: String(insight), size: 'xxs', color: C.blue, wrap: true }],
  };
}

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
    rec.paid ? 'จ่ายแล้ว' : 'ยังไม่จ่าย',
  ].join('  ·  ');

  /* ---------- หัว ---------- */
  const head = [
    { type: 'text', text: stateText, size: 'xxs', color: accent, weight: 'bold' },
    {
      type: 'text', text: `${isIncome ? '+' : MINUS}฿${money(rec.amount)}`,
      size: '3xl', weight: 'bold', color: isIncome ? C.green : C.label, margin: 'md',
    },
    {
      type: 'text', text: title, size: 'md', weight: 'bold', color: C.label,
      wrap: true, maxLines: 2, margin: 'md',
      action: isLow(rec, 'vendor')
        ? { type: 'postback', label: 'แก้ไข', data: pb('fix', id, { f: 'vendor' }) } : undefined,
    },
    {
      type: 'text', text: meta, size: 'xs', color: C.secondary, margin: 'xs', wrap: true,
      action: isLow(rec, 'date')
        ? { type: 'postback', label: 'แก้ไข', data: pb('fix', id, { f: 'date' }) } : undefined,
    },
    statsLine(opts.stats),
  ].filter(Boolean);

  if (mode === 'confirm') {
    head.push({
      type: 'text', text: 'AI อ่านมาจากบิล — ช่องสีส้มคือที่ไม่ชัวร์ แตะแก้ได้',
      size: 'xxs', color: C.orange, margin: 'md', wrap: true,
    });
  }

  /* ---------- รายละเอียด ---------- */
  const detail = hairList([
    hairRow('หมวดหมู่', rec.category, { low: isLow(rec, 'category'), id, field: 'category' }),
    hairRow('เอกสาร', rec.docType),
    hairRow('โน้ต', rec.note, { low: isLow(rec, 'note'), id, field: 'note' }),
    ...taxRows(rec),
  ]);

  const inner = {
    type: 'box', layout: 'vertical', flex: 1,
    paddingStart: '20px', paddingEnd: '20px', paddingTop: '20px', paddingBottom: '14px',
    contents: [...head, insightBox(opts.insight || rec.flag), detail].filter(Boolean),
  };

  const body = {
    type: 'box', layout: 'horizontal', paddingAll: '0px', spacing: 'none',
    contents: [accentBar(accent), inner],
  };

  /* ---------- footer ---------- */
  const footer = {
    type: 'box', layout: 'vertical', spacing: 'sm',
    paddingStart: '14px', paddingEnd: '14px', paddingTop: '6px', paddingBottom: '10px',
    contents: [],
  };

  if (mode === 'confirm') {
    footer.contents.push({
      type: 'button', style: 'primary', color: C.blue, height: 'sm',
      action: { type: 'postback', label: 'บันทึก', data: pb('confirm', id) },
    });
    footer.contents.push({
      type: 'box', layout: 'horizontal', contents: [
        { type: 'button', style: 'link', height: 'sm', color: C.blue,
          action: { type: 'postback', label: 'แก้ไข', data: pb('edit', id) } },
        { type: 'button', style: 'link', height: 'sm', color: C.secondary,
          action: { type: 'postback', label: 'ยกเลิก', data: pb('cancel', id) } },
      ],
    });
  } else {
    // ปุ่มหลัก: จ่ายแล้ว / ยังไม่จ่าย
    footer.contents.push({
      type: 'button',
      style: rec.paid ? 'secondary' : 'primary',
      color: rec.paid ? undefined : C.green,
      height: 'sm',
      action: {
        type: 'postback',
        label: rec.paid ? '✓ จ่ายแล้ว — กดเพื่อยกเลิก' : 'จ่ายแล้ว',
        data: pb('paid', id),
      },
    });

    // ลิงก์เล็ก: แก้ไข · ดูบิล · เพิ่มเติม
    const driveLink = opts.driveLink || rec.imageUrl;
    const links = [
      textLink('แก้ไข', { type: 'postback', label: 'แก้ไข', data: pb('edit', id) }),
    ];
    if (driveLink) {
      links.push(dot());
      links.push(textLink('ดูบิล', { type: 'uri', label: 'ดูบิล', uri: driveLink }));
    }
    links.push(dot());
    links.push(textLink('เพิ่มเติม', { type: 'postback', label: 'เพิ่มเติม', data: pb('more', id) }, C.secondary));
    links.push({ type: 'filler' });

    footer.contents.push({
      type: 'box', layout: 'baseline', spacing: 'sm', paddingTop: '4px', contents: links,
    });

    // ปุ่มล่าง: เปิดแดชบอร์ด
    if (opts.dashboardUrl) {
      footer.contents.push({ type: 'separator', color: C.separator, margin: 'sm' });
      footer.contents.push({
        type: 'button', style: 'link', height: 'sm', color: C.blue,
        action: { type: 'uri', label: '📊 เปิดแดชบอร์ด', uri: opts.dashboardUrl },
      });
    }
  }

  return {
    type: 'flex',
    altText: `${stateText} ${isIncome ? 'รายรับ' : 'รายจ่าย'} ฿${money(rec.amount)} — ${title}`,
    contents: {
      type: 'bubble', size: 'giga', body, footer,
      styles: {
        body: { backgroundColor: C.white },
        footer: { backgroundColor: C.white, separator: true, separatorColor: C.separator },
      },
    },
  };
}

/* ─────────────── การ์ดเมนูรอง (กด "เพิ่มเติม") ─────────────── */

export function buildMoreCard(rec = {}, opts = {}) {
  const id = opts.id ?? rec.id ?? '';
  const title = has(rec.vendor) ? String(rec.vendor) : 'รายการนี้';

  const item = (emoji, label, sub, action, danger = false) => ({
    type: 'box', layout: 'vertical', paddingTop: '12px', paddingBottom: '12px',
    action,
    contents: [
      { type: 'box', layout: 'baseline', contents: [
        { type: 'text', text: `${emoji}  ${label}`, size: 'sm', weight: 'bold',
          color: danger ? C.red : C.label, flex: 0 },
        { type: 'text', text: '›', size: 'sm', color: C.tertiary, align: 'end' },
      ]},
      { type: 'text', text: sub, size: 'xxs', color: C.secondary, margin: 'xs', wrap: true },
    ],
  });

  const rows = [
    item('📎', 'แนบรูปหลักฐาน', 'ส่งรูปใบเสร็จ/สลิปเพิ่มให้รายการนี้',
      { type: 'postback', label: 'แนบรูป', data: pb('attach', id) }),
    { type: 'separator', color: C.separator },
    item('🗑', 'ลบรายการ', 'เอารายการนี้ออกจากบัญชี',
      { type: 'postback', label: 'ลบ', data: pb('delete', id) }, true),
  ];

  return {
    type: 'flex', altText: 'ตัวเลือกเพิ่มเติม',
    contents: {
      type: 'bubble', size: 'mega',
      body: {
        type: 'box', layout: 'vertical', paddingAll: '20px',
        contents: [
          { type: 'text', text: 'เพิ่มเติม', size: 'xs', color: C.secondary, weight: 'bold' },
          { type: 'text', text: title, size: 'md', weight: 'bold', wrap: true, maxLines: 1, margin: 'xs' },
          { type: 'box', layout: 'vertical', margin: 'md', contents: rows },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingStart: '14px', paddingEnd: '14px', paddingBottom: '8px',
        contents: [{
          type: 'button', style: 'link', height: 'sm', color: C.secondary,
          action: { type: 'postback', label: '‹ กลับ', data: pb('back', id) },
        }],
      },
    },
  };
}

export const buildConfirmCard = (rec, opts = {}) =>
  buildRecordCard(rec, { ...opts, mode: 'confirm' });

export const buildSavedCard = (rec, opts = {}) =>
  buildRecordCard(rec, { ...opts, mode: 'saved' });

export default {
  buildRecordCard, buildConfirmCard, buildSavedCard, buildMoreCard,
  formatDateTH, normalizeDate, money, CARD_VERSION,
};
