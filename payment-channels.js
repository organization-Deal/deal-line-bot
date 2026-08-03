// Master data ช่องทางการเงินของธุรกิจ
// เก็บใน _settings.payment_channels เป็น JSON เพื่อให้ Dashboard จัดการได้โดยไม่เพิ่ม read quota ใหม่

function bool(value, fallback = false) {
  if (value === true || value === false) return value;
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return !["false", "0", "no", "off", "inactive", "ปิด"].includes(raw);
}

function channelHash(value) {
  let h = 2166136261;
  const text = String(value || "");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).toUpperCase();
}

function clean(value, max = 160) {
  return String(value ?? "").trim().slice(0, max);
}

export function normalizePaymentChannel(raw = {}, index = 0) {
  const type = clean(raw.type || raw.channelType || "bank", 30).toLowerCase() || "bank";
  const bank = clean(raw.bank || raw.provider || raw.wallet || "", 80);
  const number = clean(raw.number || raw.accountNo || raw.account || raw.phone || "", 80);
  const label = clean(raw.label || raw.nickname || raw.name || bank || `ช่องทางการเงิน ${index + 1}`, 100);
  const ownerName = clean(raw.ownerName || raw.accountName || raw.name || "", 120);
  const seed = [type, bank, number, label, index].join("|").toLowerCase();
  const id = clean(raw.id || raw.channelId || `FIN_${channelHash(seed)}`, 80);
  return {
    id,
    label,
    type,
    bank,
    number,
    name: ownerName,
    currency: clean(raw.currency || "THB", 12).toUpperCase() || "THB",
    active: bool(raw.active, true),
    isDefault: bool(raw.isDefault ?? raw.default, false),
    createdAt: clean(raw.createdAt || "", 50),
    updatedAt: clean(raw.updatedAt || "", 50),
  };
}

export function listPaymentChannels(settings = {}, { activeOnly = false } = {}) {
  let raw = settings?.payment_channels;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw || "[]"); } catch { raw = []; }
  }
  if (!Array.isArray(raw)) raw = [];
  const channels = raw
    .map((item, index) => normalizePaymentChannel(item, index))
    .filter((item) => item.id && item.label);
  if (activeOnly) return channels.filter((item) => item.active);
  return channels;
}

export function findPaymentChannel(settings = {}, channelId = "", { activeOnly = false } = {}) {
  const id = String(channelId || "").trim();
  if (!id) return null;
  return listPaymentChannels(settings, { activeOnly }).find((channel) => channel.id === id) || null;
}

export function channelDisplay(channel = {}) {
  const label = String(channel.label || channel.bank || "ช่องทางการเงิน").trim();
  const bank = String(channel.bank || "").trim();
  const number = String(channel.number || "").trim();
  const tail = number.replace(/\D/g, "").slice(-4);
  const details = [bank && bank !== label ? bank : "", tail ? `••••${tail}` : ""].filter(Boolean).join(" · ");
  return details ? `${label} · ${details}` : label;
}

export function channelSnapshot(channel = {}) {
  return {
    paymentChannelId: String(channel.id || ""),
    paymentChannelLabel: String(channel.label || ""),
    paymentChannelType: String(channel.type || "bank"),
    paymentChannelBank: String(channel.bank || ""),
    paymentChannelNumber: String(channel.number || ""),
    paymentChannelName: String(channel.name || ""),
  };
}

export function sourceAccountMatchesChannel(row = {}, channel = {}) {
  if (!channel?.id) return false;
  if (String(row.sourceChannelId || "").trim()) {
    return String(row.sourceChannelId) === String(channel.id);
  }
  // รองรับ Statement รุ่นก่อนที่บันทึกเป็นข้อความบัญชีอย่างเดียว
  const source = String(row.sourceAccount || "").toLowerCase().replace(/\s+/g, "");
  if (!source) return false;
  const candidates = [channel.label, channel.bank, channel.number, channelDisplay(channel)]
    .map((value) => String(value || "").toLowerCase().replace(/\s+/g, ""))
    .filter(Boolean);
  const digits = String(channel.number || "").replace(/\D/g, "");
  if (digits.length >= 4 && source.includes(digits.slice(-4))) return true;
  return candidates.some((candidate) => source === candidate || source.includes(candidate) || candidate.includes(source));
}
