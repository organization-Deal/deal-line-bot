// ตรวจทิศทางเงินจากสลิปโดยเทียบกับ Master ช่องทางการเงินของบริษัท
// หลักการ: ปลายทางตรงบัญชีบริษัท = เงินเข้า, ต้นทางตรงบัญชีบริษัท = เงินออก
// ไม่ใช้ AI ตัดสินอย่างเดียว — account master เป็น source of truth หลัก

import { listPaymentChannels, channelDisplay } from "./payment-channels.js";

function clean(v, max = 160) { return String(v ?? "").trim().slice(0, max); }
function digits(v) { return String(v ?? "").replace(/\D/g, ""); }
function normName(v) {
  return String(v ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(?:บริษัท|บจก\.?|หจก\.?|จำกัด|นาย|นางสาว|นาง|mr\.?|mrs\.?|ms\.?)/gi, "")
    .replace(/[^0-9a-zก-๙]/gi, "");
}
function normBank(v) {
  return String(v ?? "").normalize("NFKC").toLowerCase().replace(/[^0-9a-zก-๙]/gi, "");
}
function similarName(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 6 && y.length >= 6 && (x.includes(y) || y.includes(x));
}
function accountScore(ocrAccount, masterAccount) {
  const a = digits(ocrAccount), b = digits(masterAccount);
  if (!a || !b) return 0;
  if (a === b && a.length >= 6) return 100;
  // สลิปไทยจำนวนมาก mask เลขบัญชี เหลือเพียง 4 หลักท้าย
  if (a.length >= 4 && b.length >= 4 && a.slice(-4) === b.slice(-4)) return 94;
  if (a.length >= 3 && b.length >= 3 && a.slice(-3) === b.slice(-3)) return 72;
  return 0;
}

function scoreParty(channel, party = {}, settings = {}) {
  let score = 0;
  const reasons = [];
  const account = accountScore(party.account, channel.number);
  if (account) { score += account; reasons.push(account >= 94 ? "เลขบัญชีตรง" : "เลขท้ายบัญชีคล้าย"); }

  const partyName = clean(party.name);
  const channelNameMatched = partyName && channel.name && similarName(partyName, channel.name);
  const companyName = clean(settings.company_name || settings.companyName);
  const companyNameMatched = partyName && companyName && similarName(partyName, companyName);
  // ถ้ามีเลขบัญชีแล้ว ให้ชื่อเป็นเพียงตัว corroborate ไม่ให้ชื่อบริษัทเดียวกันทำทุกบัญชีเสมอกัน
  if (channelNameMatched) {
    score += account ? 3 : 84;
    reasons.push("ชื่อบัญชีตรง");
  } else if (companyNameMatched) {
    score += account ? 2 : 80;
    reasons.push("ชื่อบริษัทตรง");
  }

  const bankA = normBank(party.bank), bankB = normBank(channel.bank);
  if (bankA && bankB && (bankA === bankB || bankA.includes(bankB) || bankB.includes(bankA))) {
    score += account ? 2 : 6;
    reasons.push("ธนาคารตรง");
  }

  return { score: Math.min(100, score), reasons, accountScore: account, nameMatched: !!(channelNameMatched || companyNameMatched) };
}

function bestMatch(channels, party, settings, usage) {
  const rows = channels
    .filter((ch) => ch.active !== false && ch.autoDetect !== false)
    .filter((ch) => usage === "receive" ? ch.canReceive !== false : ch.canPay !== false)
    .map((channel) => ({ channel, ...scoreParty(channel, party, settings) }))
    .sort((a, b) => b.score - a.score || b.accountScore - a.accountScore);
  if (!rows.length) return null;
  const top = rows[0], second = rows[1];
  // ถ้ามีหลายบัญชีชื่อเดียวกัน แต่สลิปอ่านเลขบัญชีไม่ได้ ให้รู้ทิศทางได้แต่ไม่เดาบัญชีปลายทางมั่ว
  if (second && top.accountScore === 0 && second.accountScore === 0 && Math.abs(top.score - second.score) <= 2) {
    return { ...top, ambiguousChannel: true };
  }
  return top;
}

export function classifyTransferByCompanyAccounts(record = {}, settings = {}) {
  const isSlip = record.role === "PAYSLIP" || /สลิป|transfer|payment/i.test(String(record.docType || ""));
  if (!isSlip) return { matched: false, direction: "unknown", type: "", confidence: 0 };

  const channels = listPaymentChannels(settings, { activeOnly: true });
  if (!channels.length) return { matched: false, direction: "unknown", type: "", confidence: 0, reason: "ยังไม่มีบัญชีบริษัทใน Master" };

  const destination = {
    name: record.vendor || record.toName || "",
    account: record.toAccountNumber || record.destinationAccount || "",
    bank: record.toBank || record.destinationBank || "",
  };
  const source = {
    name: record.transferor || record.fromName || "",
    account: record.fromAccountNumber || record.sourceAccount || "",
    bank: record.fromBank || record.sourceBank || "",
  };

  const incoming = bestMatch(channels, destination, settings, "receive");
  const outgoing = bestMatch(channels, source, settings, "pay");
  const inScore = Number(incoming?.score || 0), outScore = Number(outgoing?.score || 0);
  const threshold = 78;

  if (inScore >= threshold && outScore >= threshold) {
    return {
      matched: true,
      direction: "internal_transfer",
      type: "",
      confidence: Math.min(inScore, outScore),
      reason: `พบทั้งต้นทางและปลายทางเป็นบัญชีบริษัท (${channelDisplay(outgoing.channel)} → ${channelDisplay(incoming.channel)})`,
      sourceChannelId: outgoing.channel.id,
      destinationChannelId: incoming.channel.id,
      matchedPaymentChannelId: incoming.ambiguousChannel ? "" : incoming.channel.id,
      matchedPaymentChannelLabel: incoming.ambiguousChannel ? "บัญชีรับเงินของบริษัท (ยังระบุบัญชีไม่ได้)" : channelDisplay(incoming.channel),
      requiresReview: true,
    };
  }

  if (inScore >= threshold && inScore >= outScore + 8) {
    return {
      matched: true,
      direction: "incoming",
      type: "รายรับ",
      confidence: inScore,
      reason: incoming.ambiguousChannel
        ? `ชื่อผู้รับตรงกับบริษัท แต่สลิปยังอ่านเลขบัญชีปลายทางไม่ชัด`
        : `ผู้รับตรงกับบัญชีบริษัท ${channelDisplay(incoming.channel)}${incoming.reasons.length ? ` · ${incoming.reasons.join(" + ")}` : ""}`,
      matchedPaymentChannelId: incoming.ambiguousChannel ? "" : incoming.channel.id,
      matchedPaymentChannelLabel: incoming.ambiguousChannel ? "บัญชีรับเงินของบริษัท" : channelDisplay(incoming.channel),
      requiresReview: false,
    };
  }

  if (outScore >= threshold && outScore >= inScore + 8) {
    return {
      matched: true,
      direction: "outgoing",
      type: "รายจ่าย",
      confidence: outScore,
      reason: outgoing.ambiguousChannel
        ? `ชื่อผู้โอนตรงกับบริษัท แต่สลิปยังอ่านเลขบัญชีต้นทางไม่ชัด`
        : `ผู้โอนตรงกับบัญชีบริษัท ${channelDisplay(outgoing.channel)}${outgoing.reasons.length ? ` · ${outgoing.reasons.join(" + ")}` : ""}`,
      matchedPaymentChannelId: outgoing.ambiguousChannel ? "" : outgoing.channel.id,
      matchedPaymentChannelLabel: outgoing.ambiguousChannel ? "บัญชีจ่ายเงินของบริษัท" : channelDisplay(outgoing.channel),
      requiresReview: false,
    };
  }

  return {
    matched: false,
    direction: "unknown",
    type: "",
    confidence: Math.max(inScore, outScore),
    reason: "ยังยืนยันทิศทางเงินจากบัญชีบริษัทไม่ได้",
    incomingCandidate: incoming?.channel?.id || "",
    outgoingCandidate: outgoing?.channel?.id || "",
  };
}
