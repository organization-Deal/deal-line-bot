// src/multi-expense.js — v1.0
// รับรูปหลายใบจาก LINE → OCR ทีละรูป → Durable Object จัดกลุ่มรายการอัตโนมัติ
// ถ้า AI จับคู่ไม่ชัวร์ ผู้ใช้เปิดหน้าตรวจเอกสารแล้วจัดรูปเองก่อนบันทึก

import { push, textMsg } from "./line.js";
import { getUserToken } from "./oauth.js";
import {
  appendExpense, readExpenses, readSettings, updateExpenseById,
  findDuplicateExpensesInRecords, normalizeDate,
} from "./sheets.js";
import { createExpenseDocuments } from "./documents.js";
import {
  createMemberOnboardingUrl, getMemberProfile,
  memberProfileComplete, missingMemberFields,
} from "./member-profile.js";

const SESSION_IDLE_MS = 60 * 60 * 1000;
const DEBOUNCE_MS = 2200;
const AMOUNT_TOLERANCE = 0.01;
const ROLES = ["RECEIPT", "TAX_INVOICE", "PAYSLIP", "PROOF", "OTHER"];
const ROLE_LABEL = {
  RECEIPT: "ใบเสร็จ/บิล",
  TAX_INVOICE: "ใบกำกับภาษี",
  PAYSLIP: "สลิปจ่าย",
  PROOF: "หลักฐานการใช้เงิน",
  OTHER: "อื่น ๆ",
};

const CATEGORIES = [
  "อาหาร & รับรอง",
  "เดินทาง & ขนส่ง",
  "ค่าน้ำ ค่าไฟ ค่าเน็ต",
  "วัสดุ & อุปกรณ์สำนักงาน",
  "การตลาด & โฆษณา",
  "ค่าบริการ & จ้างงาน",
  "อื่น ๆ",
];

function nowIso() { return new Date().toISOString(); }
function uid() { return crypto.randomUUID().replaceAll("-", "").slice(0, 10); }
function money(v) {
  return Number(v || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function norm(v) {
  return String(v || "").normalize("NFKC").toLowerCase()
    .replace(/(?:บริษัท|บจก\.?|หจก\.?|จำกัด|นาย|นางสาว|นาง|mr\.?|mrs\.?|ms\.?)/gi, "")
    .replace(/[^0-9a-z\u0E00-\u0E7F]/g, "");
}
function dateDiffDays(a, b) {
  const ta = Date.parse(`${a || ""}T00:00:00Z`);
  const tb = Date.parse(`${b || ""}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 999;
  return Math.abs(ta - tb) / 86400000;
}
function urlToImage(url) {
  const m = String(url || "").match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  return m ? `https://lh3.googleusercontent.com/d/${m[1]}` : String(url || "");
}
function splitList(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v || "").split(",").map((x) => x.trim()).filter(Boolean);
}
function baseUrl(env) { return String(env.WORKER_URL || "").replace(/\/$/, ""); }
function roleOf(item) {
  if (ROLES.includes(item.role)) return item.role;
  if (item.docType === "สลิปโอนเงิน") return "PAYSLIP";
  if (item.docType === "ใบกำกับภาษี") return "TAX_INVOICE";
  if (["ใบเสร็จรับเงิน", "บิลเงินสด", "ใบแจ้งหนี้"].includes(item.docType)) return "RECEIPT";
  return Number(item.amount) > 0 ? "RECEIPT" : "OTHER";
}
function primaryRole(role) { return role === "RECEIPT" || role === "TAX_INVOICE"; }
function amountKnown(v) { return Number(v) > 0; }
function sameAmount(a, b) { return amountKnown(a) && amountKnown(b) && Math.abs(Number(a) - Number(b)) <= AMOUNT_TOLERANCE; }

async function hashText(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function multiSessionKey(tenant, userId) {
  return (await hashText(`${tenant}|${userId || "anonymous"}`)).slice(0, 40);
}

function stubFor(env, sid) {
  if (!env.MULTI_SESSIONS) throw new Error("MULTI_SESSIONS binding ยังไม่ได้ตั้งใน wrangler.toml");
  return env.MULTI_SESSIONS.get(env.MULTI_SESSIONS.idFromName(sid));
}

async function doJson(stub, path, body = null, method = "POST") {
  const res = await stub.fetch(`https://multi.local${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data.error || `multi session ${res.status}`);
  return data;
}

export async function touchMultiSession(env, meta) {
  const sid = await multiSessionKey(meta.tenant, meta.userId);
  const out = await doJson(stubFor(env, sid), "/touch", { ...meta, sid });
  return { ...out, sid };
}

export async function addMultiImage(env, meta, item) {
  const sid = await multiSessionKey(meta.tenant, meta.userId);
  return doJson(stubFor(env, sid), "/image", { ...meta, sid, item });
}

export async function forceMultiSummary(env, tenant, userId) {
  const sid = await multiSessionKey(tenant, userId);
  return doJson(stubFor(env, sid), "/internal-summary", { sid });
}

export async function cancelMultiSession(env, tenant, userId) {
  const sid = await multiSessionKey(tenant, userId);
  return doJson(stubFor(env, sid), "/internal-cancel", { sid });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function parseBody(request) {
  return request.json().catch(() => ({}));
}

export async function handleMultiHttp(request, env, url) {
  const sid = url.searchParams.get("s") || "";
  const token = url.searchParams.get("k") || "";
  if (!sid || !token) return new Response("ลิงก์ไม่สมบูรณ์", { status: 400 });
  const stub = stubFor(env, sid);

  if (url.pathname === "/multi/review") {
    const check = await stub.fetch(`https://multi.local/state?k=${encodeURIComponent(token)}`);
    if (!check.ok) return new Response(invalidPage(), { status: check.status, headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response(reviewPage(sid, token, env), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" },
    });
  }

  if (url.pathname.startsWith("/multi/api/")) {
    const path = url.pathname.replace("/multi/api", "") || "/state";
    const body = request.method === "GET" ? undefined : await request.arrayBuffer();
    const doUrl = `https://multi.local${path}?k=${encodeURIComponent(token)}`;
    return stub.fetch(new Request(doUrl, {
      method: request.method,
      headers: { "content-type": request.headers.get("content-type") || "application/json" },
      body: body && body.byteLength ? body : undefined,
    }));
  }
  return new Response("Not found", { status: 404 });
}

function emptySession(meta = {}) {
  return {
    sid: meta.sid || "",
    token: crypto.randomUUID().replaceAll("-", ""),
    tenant: meta.tenant || "",
    userId: meta.userId || "",
    targetId: meta.targetId || meta.userId || "",
    displayName: meta.displayName || "",
    sheetId: meta.sheetId || "",
    items: {},
    groups: [],
    ignored: [],
    seq: 0,
    receivedCount: 0,
    inflight: 0,
    failedCount: 0,
    lastTouchAt: "",
    lastSummarySeq: 0,
    status: "collecting",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    saveProgress: null,
    saved: [],
  };
}

function sessionStale(s) {
  return !s || ["done", "cancelled", "error"].includes(s.status) ||
    (Date.now() - Date.parse(s.updatedAt || s.createdAt || 0) > SESSION_IDLE_MS);
}

function groupTemplate() {
  return {
    id: `g_${uid()}`,
    itemIds: [],
    manual: false,
    amount: 0,
    payAmount: 0,
    vendor: "",
    transferor: "",
    date: "",
    category: "อื่น ๆ",
    note: "",
    type: "รายจ่าย",
    docType: "",
    vat: false,
    vatRate: 0,
    whtRate: 0,
    warning: "",
    matchConfidence: 0,
  };
}

function groupItems(s, g) {
  return g.itemIds.map((id) => s.items[id]).filter((x) => x && !x.ignored);
}

function recomputeGroup(s, g) {
  const items = groupItems(s, g);
  const primary = items.find((x) => x.role === "TAX_INVOICE") ||
    items.find((x) => x.role === "RECEIPT") ||
    items.find((x) => amountKnown(x.amount)) || items[0] || {};
  const slip = items.find((x) => x.role === "PAYSLIP") || {};
  const amountSource = items.find((x) => primaryRole(x.role) && amountKnown(x.amount)) ||
    items.find((x) => amountKnown(x.amount)) || {};
  const paymentSource = items.find((x) => x.role === "PAYSLIP" && amountKnown(x.amount)) || {};

  if (!g.manualAmount) g.amount = Number(amountSource.amount || g.amount || 0);
  g.payAmount = Number(paymentSource.amount || 0);
  if (!g.manualVendor) g.vendor = String(primary.vendor || slip.vendor || g.vendor || "");
  if (!g.manualTransferor) g.transferor = String(slip.transferor || primary.transferor || g.transferor || "");
  if (!g.manualDate) g.date = String(primary.date || slip.date || g.date || "");
  if (!g.manualCategory) g.category = String(primary.category || g.category || "อื่น ๆ");
  if (!g.manualNote) g.note = String(primary.note || primary.matchHint || g.note || "");
  g.type = primary.type || "รายจ่าย";
  g.docType = primary.docType || (slip.docType || "");
  g.vat = items.some((x) => x.vat === true || x.role === "TAX_INVOICE");
  g.vatRate = Number(items.find((x) => Number(x.vatRate) > 0)?.vatRate || 0);
  g.whtRate = Number(items.find((x) => Number(x.whtRate) > 0)?.whtRate || 0);

  const hasPrimary = items.some((x) => primaryRole(x.role));
  const hasSlip = items.some((x) => x.role === "PAYSLIP");
  const mismatch = g.amount > 0 && g.payAmount > 0 && Math.abs(g.amount - g.payAmount) > AMOUNT_TOLERANCE;
  if (!items.length) g.warning = "ไม่มีรูปในรายการ";
  else if (!g.amount) g.warning = "ยังอ่านยอดไม่ได้";
  else if (mismatch) g.warning = `ยอดเอกสาร ฿${money(g.amount)} ไม่ตรงกับยอดจ่าย ฿${money(g.payAmount)}`;
  else if (!hasPrimary && hasSlip) g.warning = "ยังไม่พบใบเสร็จหรือใบกำกับภาษี";
  else if (hasPrimary && !hasSlip) g.warning = "ยังไม่พบสลิปหรือหลักฐานชำระเงิน";
  else g.warning = "";
  return g;
}

function groupHasRole(s, g, role) {
  return groupItems(s, g).some((x) => x.role === role);
}

function scoreItemForGroup(s, item, g) {
  const items = groupItems(s, g);
  if (!items.length) return -999;
  let score = 0;
  if (amountKnown(item.amount) && amountKnown(g.amount)) {
    if (!sameAmount(item.amount, g.amount) && !sameAmount(item.amount, g.payAmount)) return -999;
    score += 70;
  }
  if (item.date && g.date) {
    const dd = dateDiffDays(item.date, g.date);
    if (dd === 0) score += 15;
    else if (dd <= 1) score += 7;
    else if (dd > 7) score -= 15;
  }
  const iv = norm(item.vendor);
  const gv = norm(g.vendor);
  if (iv && gv) {
    if (iv === gv) score += 18;
    else if (iv.includes(gv) || gv.includes(iv)) score += 8;
  }
  const refs = [item.referenceNo, item.invoiceNo, item.matchHint].map(norm).filter(Boolean);
  const groupRefs = items.flatMap((x) => [x.referenceNo, x.invoiceNo, x.matchHint]).map(norm).filter(Boolean);
  if (refs.some((r) => groupRefs.includes(r))) score += 25;
  const hint = norm(item.matchHint);
  if (hint && gv && (hint === gv || hint.includes(gv) || gv.includes(hint))) score += 35;

  if (item.role === "PAYSLIP" && groupHasRole(s, g, "PAYSLIP")) score -= 45;
  if (primaryRole(item.role) && items.some((x) => primaryRole(x.role))) score -= 35;
  if (item.role === "PROOF") score += 4;
  return score;
}

function createGroupWithItem(s, item, { manual = false } = {}) {
  const g = groupTemplate();
  g.manual = manual;
  g.itemIds.push(item.id);
  item.groupId = g.id;
  s.groups.push(g);
  recomputeGroup(s, g);
  return g;
}

function placeItem(s, item) {
  item.role = roleOf(item);
  if (item.ignored || item.groupId) return;

  const scored = s.groups
    .map((g) => ({ g, score: scoreItemForGroup(s, item, g) }))
    .filter((x) => x.score > -999)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  const threshold = amountKnown(item.amount) ? 65 : (item.role === "PROOF" ? 35 : 55);
  const confident = best && best.score >= threshold && (!second || best.score - second.score >= 12);
  if (confident) {
    best.g.itemIds.push(item.id);
    item.groupId = best.g.id;
    best.g.matchConfidence = Math.max(best.g.matchConfidence || 0, Math.min(100, best.score));
    recomputeGroup(s, best.g);
    return;
  }

  // เอกสารที่มียอดสร้างรายการรอไว้ก่อน ส่วนรูปหลักฐานที่ไม่มียอดเข้ากองรอจัด
  if (amountKnown(item.amount) && (primaryRole(item.role) || item.role === "PAYSLIP")) {
    createGroupWithItem(s, item);
    return;
  }

  // ถ้ามีเพียงรายการเดียว หลักฐานที่ไม่มีตัวเลขสามารถแนบให้อัตโนมัติได้อย่างปลอดภัย
  if (item.role === "PROOF" && s.groups.length === 1) {
    const g = s.groups[0];
    g.itemIds.push(item.id);
    item.groupId = g.id;
    g.matchConfidence = Math.max(g.matchConfidence || 0, 40);
    recomputeGroup(s, g);
  }

}

function mergeCompatibleGroups(s) {
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < s.groups.length; i++) {
      for (let j = i + 1; j < s.groups.length; j++) {
        const a = recomputeGroup(s, s.groups[i]);
        const b = recomputeGroup(s, s.groups[j]);
        if (a.manual || b.manual) continue;
        if (!sameAmount(a.amount || a.payAmount, b.amount || b.payAmount)) continue;
        const aPrimary = groupItems(s, a).some((x) => primaryRole(x.role));
        const bPrimary = groupItems(s, b).some((x) => primaryRole(x.role));
        const aSlip = groupHasRole(s, a, "PAYSLIP");
        const bSlip = groupHasRole(s, b, "PAYSLIP");
        if (!((aPrimary && bSlip && !aSlip) || (bPrimary && aSlip && !bSlip))) continue;
        if (a.date && b.date && dateDiffDays(a.date, b.date) > 2) continue;
        const keep = aPrimary ? a : b;
        const drop = keep.id === a.id ? b : a;
        for (const itemId of drop.itemIds) {
          if (!keep.itemIds.includes(itemId)) keep.itemIds.push(itemId);
          if (s.items[itemId]) s.items[itemId].groupId = keep.id;
        }
        s.groups = s.groups.filter((g) => g.id !== drop.id);
        recomputeGroup(s, keep);
        changed = true;
        break outer;
      }
    }
  }
}

function refreshAll(s) {
  s.groups = s.groups.filter((g) => g.itemIds.some((id) => s.items[id] && !s.items[id].ignored));
  s.groups.forEach((g) => recomputeGroup(s, g));
  mergeCompatibleGroups(s);
  s.groups.forEach((g) => recomputeGroup(s, g));
}

function publicState(s) {
  refreshAll(s);
  const items = Object.values(s.items)
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
    .map((x) => ({
      ...x,
      roleLabel: ROLE_LABEL[x.role] || x.role,
      imgUrl: x.imgUrl || urlToImage(x.driveUrl),
    }));
  const groups = s.groups.map((g, i) => {
    const members = groupItems(s, g);
    return {
      ...g,
      number: i + 1,
      itemIds: [...g.itemIds],
      images: members.map((x) => ({ id: x.id, role: x.role, roleLabel: ROLE_LABEL[x.role], imgUrl: x.imgUrl || urlToImage(x.driveUrl) })),
      counts: {
        receipt: members.filter((x) => primaryRole(x.role)).length,
        slip: members.filter((x) => x.role === "PAYSLIP").length,
        proof: members.filter((x) => x.role === "PROOF").length,
        other: members.filter((x) => x.role === "OTHER").length,
      },
      ready: !!g.amount && !g.warning,
    };
  });
  const unassigned = items.filter((x) => !x.groupId && !x.ignored);
  const ignored = items.filter((x) => x.ignored);
  return {
    sid: s.sid,
    tenant: s.tenant,
    displayName: s.displayName,
    status: s.status,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    seq: s.seq,
    items,
    groups,
    unassigned,
    ignored,
    counts: {
      images: items.filter((x) => !x.ignored).length,
      groups: groups.length,
      ready: groups.filter((g) => g.ready).length,
      warnings: groups.filter((g) => g.warning).length,
      unassigned: unassigned.length,
      inflight: Number(s.inflight || 0),
      failed: Number(s.failedCount || 0),
    },
    saveProgress: s.saveProgress,
    saved: s.saved || [],
    categories: CATEGORIES,
    roles: ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] })),
  };
}

function summaryCard(s, env) {
  const v = publicState(s);
  const reviewUrl = `${baseUrl(env)}/multi/review?s=${encodeURIComponent(s.sid)}&k=${encodeURIComponent(s.token)}`;
  const needs = v.counts.unassigned + v.counts.warnings;
  return {
    type: "flex",
    altText: `รับเอกสาร ${v.counts.images} รูป พบ ${v.counts.groups} รายการ`,
    contents: {
      type: "bubble", size: "mega",
      body: {
        type: "box", layout: "vertical", paddingAll: "22px", contents: [
          { type: "box", layout: "baseline", contents: [
            { type: "text", text: "ชุดเอกสารล่าสุด", size: "xs", color: "#6E6E73", weight: "bold", flex: 1 },
            { type: "text", text: needs ? "ต้องตรวจ" : "พร้อมบันทึก", size: "xs", color: needs ? "#B54708" : "#248A3D", weight: "bold", align: "end", flex: 1 },
          ] },
          { type: "text", text: `${v.counts.groups} รายการ`, size: "3xl", weight: "bold", color: "#111111", margin: "md" },
          { type: "text", text: `รับแล้ว ${v.counts.images} รูป · AI จัดเข้ารายการ ${v.counts.images - v.counts.unassigned} รูป${v.counts.failed ? ` · อ่านไม่สำเร็จ ${v.counts.failed} รูป` : ""}`, size: "sm", color: "#6E6E73", margin: "sm", wrap: true },
          { type: "box", layout: "horizontal", spacing: "sm", margin: "xl", contents: [
            metricBox("พร้อม", String(v.counts.ready)),
            metricBox("มีคำเตือน", String(v.counts.warnings)),
            metricBox("ยังไม่จัด", String(v.counts.unassigned)),
          ] },
          { type: "text", text: "ส่งรูปเพิ่มต่อได้เลย ระบบจะรวมเข้าชุดเดิมอัตโนมัติ", size: "xs", color: "#6E6E73", wrap: true, margin: "lg" },
        ],
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", paddingAll: "14px", contents: [
          { type: "button", style: "primary", color: "#111111", height: "sm", action: { type: "uri", label: needs ? "ตรวจและจัดรูป" : "ตรวจและบันทึก", uri: reviewUrl } },
          { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "ยกเลิกชุดนี้", data: `act=multi_cancel&s=${encodeURIComponent(s.sid)}` } },
        ],
      },
      styles: { body: { backgroundColor: "#FFFFFF" }, footer: { backgroundColor: "#FFFFFF", separator: true, separatorColor: "#E5E5EA" } },
    },
  };
}

function metricBox(label, value) {
  return {
    type: "box", layout: "vertical", flex: 1, backgroundColor: "#F5F5F7", cornerRadius: "12px", paddingAll: "10px", contents: [
      { type: "text", text: value, size: "lg", weight: "bold", color: "#111111", align: "center" },
      { type: "text", text: label, size: "xxs", color: "#6E6E73", align: "center", margin: "xs" },
    ],
  };
}

function buildRecordFromGroup(s, g, profile) {
  const items = groupItems(s, g);
  const receipt = items.filter((x) => x.role === "RECEIPT").map((x) => x.driveUrl);
  const tax = items.filter((x) => x.role === "TAX_INVOICE").map((x) => x.driveUrl);
  const slip = items.filter((x) => x.role === "PAYSLIP").map((x) => x.driveUrl);
  const other = items.filter((x) => x.role === "PROOF" || x.role === "OTHER").map((x) => x.driveUrl);
  const anchor = items.find((x) => primaryRole(x.role)) || items.find((x) => x.role === "PAYSLIP") || items[0] || {};
  const mainImage = receipt[0] || tax[0] || slip[0] || other[0] || "";
  return {
    amount: Number(g.amount) || 0,
    vendor: g.vendor || anchor.vendor || "",
    transferor: g.transferor || "",
    date: g.date || anchor.date || new Date().toISOString().slice(0, 10),
    category: g.category || "อื่น ๆ",
    note: g.note || anchor.note || "",
    docType: g.docType || anchor.docType || "อื่น ๆ",
    type: g.type || "รายจ่าย",
    vat: g.vat === true,
    vatRate: Number(g.vatRate) || 0,
    whtRate: Number(g.whtRate) || 0,
    needSlip: true,
    imageUrl: mainImage,
    attReceipt: receipt,
    attTax: tax,
    attSlip: slip,
    attOther: other,
    imageHash: items.map((x) => x.imageHash).filter(Boolean).join(", "),
    payerName: profile.name || s.displayName || "",
    payerId: s.userId || "",
    bankName: profile.bank || "",
    bankAccountNo: profile.accountNo || "",
    bankAccountName: profile.accountName || profile.name || "",
    batchType: "ปกติ",
    batchStatus: "รอเข้ารอบ",
  };
}

export class MultiExpenseSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async load() { return (await this.ctx.storage.get("session")) || null; }
  async save(s) { s.updatedAt = nowIso(); await this.ctx.storage.put("session", s); }
  authorized(s, url) { return !!s?.token && url.searchParams.get("k") === s.token; }

  async fetch(request) {
    const url = new URL(request.url);
    let s = await this.load();

    if (url.pathname === "/touch") {
      const b = await parseBody(request);
      const isNew = sessionStale(s);
      if (isNew) s = emptySession(b);
      s.sid = b.sid || s.sid;
      s.tenant = b.tenant || s.tenant;
      s.userId = b.userId || s.userId;
      s.targetId = b.targetId || s.targetId || s.userId;
      s.displayName = b.displayName || s.displayName;
      s.sheetId = b.sheetId || s.sheetId;
      if (s.status !== "collecting") s.status = "collecting";
      s.receivedCount = Number(s.receivedCount || 0) + 1;
      s.inflight = Number(s.inflight || 0) + 1;
      s.lastTouchAt = nowIso();
      await this.save(s);
      // กันกรณี OCR รูปใดรูปหนึ่งล้ม: อย่างช้าจะสรุปชุดภายในประมาณ 15 วินาที
      await this.ctx.storage.setAlarm(Date.now() + 15000);
      return json({ ok: true, isNew, token: s.token, counts: publicState(s).counts });
    }

    if (url.pathname === "/image") {
      const b = await parseBody(request);
      if (sessionStale(s)) s = emptySession(b);
      s.sid = b.sid || s.sid;
      s.tenant = b.tenant || s.tenant;
      s.userId = b.userId || s.userId;
      s.targetId = b.targetId || s.targetId || s.userId;
      s.displayName = b.displayName || s.displayName;
      s.sheetId = b.sheetId || s.sheetId;
      const item = { ...(b.item || {}) };
      item.id = item.id || `i_${uid()}`;
      item.role = roleOf(item);
      item.seq = ++s.seq;
      item.createdAt = nowIso();
      item.imgUrl = item.imgUrl || urlToImage(item.driveUrl);
      item.groupId = null;
      item.ignored = false;
      s.items[item.id] = item;
      s.inflight = Math.max(0, Number(s.inflight || 0) - 1);
      if (item.ocrFailed) s.failedCount = Number(s.failedCount || 0) + 1;
      placeItem(s, item);
      refreshAll(s);
      s.status = "collecting";
      await this.save(s);
      await this.ctx.storage.setAlarm(Date.now() + (s.inflight > 0 ? 5000 : DEBOUNCE_MS));
      return json({ ok: true, itemId: item.id, counts: publicState(s).counts });
    }

    if (url.pathname === "/internal-summary") {
      if (!s || !Object.keys(s.items || {}).length) return json({ error: "ยังไม่มีชุดเอกสาร" }, 404);
      await this.pushSummary(s);
      return json({ ok: true });
    }

    if (url.pathname === "/internal-cancel") {
      if (!s) return json({ error: "ยังไม่มีชุดเอกสาร" }, 404);
      s.status = "cancelled";
      await this.save(s);
      if (s.targetId) await push(this.env, s.targetId, textMsg("ยกเลิกชุดเอกสารแล้วครับ รูปยังอยู่ใน Google Drive"));
      return json({ ok: true });
    }

    if (!s || !this.authorized(s, url)) return json({ error: "ลิงก์หมดอายุหรือไม่ถูกต้อง" }, 401);

    if (url.pathname === "/state") return json({ ok: true, ...publicState(s) });

    if (url.pathname === "/summary") {
      await this.pushSummary(s);
      return json({ ok: true });
    }

    if (url.pathname === "/assign" && request.method === "POST") {
      const b = await parseBody(request);
      const item = s.items[b.itemId];
      if (!item) return json({ error: "ไม่พบรูป" }, 404);
      for (const g of s.groups) g.itemIds = g.itemIds.filter((id) => id !== item.id);
      item.groupId = null;
      item.ignored = false;
      if (b.target === "ignore") item.ignored = true;
      else if (b.target === "unassigned") {}
      else if (b.target === "new") createGroupWithItem(s, item, { manual: true });
      else {
        const g = s.groups.find((x) => x.id === b.target);
        if (!g) return json({ error: "ไม่พบรายการปลายทาง" }, 404);
        g.itemIds.push(item.id); g.manual = true; item.groupId = g.id; recomputeGroup(s, g);
      }
      refreshAll(s); await this.save(s);
      return json({ ok: true, ...publicState(s) });
    }

    if (url.pathname === "/role" && request.method === "POST") {
      const b = await parseBody(request);
      const item = s.items[b.itemId];
      if (!item || !ROLES.includes(b.role)) return json({ error: "ข้อมูลไม่ถูกต้อง" }, 400);
      item.role = b.role;
      item.manualRole = true;
      refreshAll(s); await this.save(s);
      return json({ ok: true, ...publicState(s) });
    }

    if (url.pathname === "/group" && request.method === "POST") {
      const b = await parseBody(request);
      const g = s.groups.find((x) => x.id === b.groupId);
      if (!g) return json({ error: "ไม่พบรายการ" }, 404);
      const patch = b.patch || {};
      if (patch.amount !== undefined) { g.amount = Number(patch.amount) || 0; g.manualAmount = true; }
      if (patch.vendor !== undefined) { g.vendor = String(patch.vendor || "").trim(); g.manualVendor = true; }
      if (patch.transferor !== undefined) { g.transferor = String(patch.transferor || "").trim(); g.manualTransferor = true; }
      if (patch.date !== undefined) { g.date = String(patch.date || "").trim(); g.manualDate = true; }
      if (patch.category !== undefined && CATEGORIES.includes(patch.category)) { g.category = patch.category; g.manualCategory = true; }
      if (patch.note !== undefined) { g.note = String(patch.note || "").trim(); g.manualNote = true; }
      g.manual = true;
      recomputeGroup(s, g); await this.save(s);
      return json({ ok: true, ...publicState(s) });
    }

    if (url.pathname === "/delete-group" && request.method === "POST") {
      const b = await parseBody(request);
      const g = s.groups.find((x) => x.id === b.groupId);
      if (!g) return json({ error: "ไม่พบรายการ" }, 404);
      for (const id of g.itemIds) if (s.items[id]) s.items[id].groupId = null;
      s.groups = s.groups.filter((x) => x.id !== g.id);
      refreshAll(s); await this.save(s);
      return json({ ok: true, ...publicState(s) });
    }

    if (url.pathname === "/commit" && request.method === "POST") {
      const b = await parseBody(request);
      return this.commit(s, { force: b.force === true });
    }

    if (url.pathname === "/cancel" && request.method === "POST") {
      s.status = "cancelled";
      await this.save(s);
      if (s.targetId) await push(this.env, s.targetId, textMsg("ยกเลิกชุดเอกสารแล้วครับ รูปยังอยู่ใน Google Drive"));
      return json({ ok: true });
    }

    return json({ error: "unknown multi action" }, 404);
  }

  async alarm() {
    const s = await this.load();
    if (!s || s.status !== "collecting") return;
    if (Number(s.inflight || 0) > 0) {
      const age = Date.now() - Date.parse(s.lastTouchAt || s.updatedAt || 0);
      if (age < 15000) {
        await this.ctx.storage.setAlarm(Date.now() + 3500);
        return;
      }
      // งาน OCR บางภาพล้ม/หมดเวลา: ไม่ให้ทั้งชุดค้างตลอด
      s.failedCount = Number(s.failedCount || 0) + Number(s.inflight || 0);
      s.inflight = 0;
      await this.save(s);
    }
    if (s.seq === s.lastSummarySeq || !Object.keys(s.items).length) return;
    await this.pushSummary(s);
  }

  async pushSummary(s) {
    if (!s.targetId) return false;
    const ok = await push(this.env, s.targetId, summaryCard(s, this.env));
    if (ok) { s.lastSummarySeq = s.seq; await this.save(s); }
    return ok;
  }

  async commit(s, { force = false } = {}) {
    refreshAll(s);
    const view = publicState(s);
    if (!s.groups.length) return json({ error: "ยังไม่มีรายการให้บันทึก" }, 400);
    if (view.counts.unassigned > 0) return json({ error: `ยังมีรูปที่ไม่ได้จัด ${view.counts.unassigned} รูป`, code: "unassigned" }, 409);
    const invalid = s.groups.filter((g) => !Number(g.amount));
    if (invalid.length) return json({ error: `ยังมี ${invalid.length} รายการที่ไม่มียอด`, code: "missing_amount" }, 409);
    if (s.status === "saving_docs" || s.status === "done") return json({ ok: true, status: s.status, saved: s.saved || [] });

    const token = await getUserToken(this.env, s.tenant);
    if (!token) return json({ error: "Google ของบริษัทหลุด กรุณาเชื่อมใหม่ใน LINE", code: "google_disconnected" }, 401);
    const sheetId = s.sheetId || (await this.env.KV.get(`tenant:${s.tenant}`)) || this.env.DEFAULT_SHEET_ID;
    if (!sheetId) return json({ error: "ไม่พบ Google Sheet ของบริษัท" }, 404);

    const member = await getMemberProfile(this.env, s.tenant, sheetId, token, s.userId, s.displayName || "");
    if (!memberProfileComplete(member.profile)) {
      const profileUrl = await createMemberOnboardingUrl(this.env, {
        tenant: s.tenant, lineUserId: s.userId, displayName: s.displayName || "", pendingId: "",
      });
      return json({
        error: `กรอกข้อมูลผู้เบิกให้ครบก่อน: ${missingMemberFields(member.profile).join(" · ")}`,
        code: "profile_required", profileUrl,
      }, 409);
    }

    const existing = await readExpenses(this.env, sheetId, token);
    const candidates = s.groups.map((g) => buildRecordFromGroup(s, g, member.profile));
    const dup = candidates.map((r, i) => ({ index: i, result: findDuplicateExpensesInRecords(existing, r) }))
      .filter((x) => x.result.hasDuplicate);
    if (dup.length && !force) {
      return json({ error: `พบ ${dup.length} รายการที่อาจเบิกซ้ำ`, code: "duplicates", duplicates: dup }, 409);
    }

    s.status = "saving";
    s.saveProgress = { total: candidates.length, rows: 0, documents: 0, errors: [] };
    s.saved = [];
    await this.save(s);

    for (let i = 0; i < candidates.length; i++) {
      const rec = candidates[i];
      const d = dup.find((x) => x.index === i)?.result;
      if (d?.hasDuplicate) {
        rec.duplicateStatus = d.level === "high" ? "ยืนยันบันทึกซ้ำ — ความเสี่ยงสูง" : "ยืนยันบันทึกซ้ำ — ควรตรวจสอบ";
        rec.duplicateOf = d.matches.map((m) => m.id).filter(Boolean).join(", ");
      }
      const anchorUrl = rec.imageUrl || splitList(rec.attReceipt)[0] || splitList(rec.attSlip)[0] || "";
      const out = await appendExpense(this.env, sheetId, rec, {
        sender: s.displayName || member.profile.name,
        payerName: member.profile.name,
        payerId: s.userId,
        driveLink: anchorUrl,
      }, token);
      const dte = normalizeDate(rec.date);
      const savedRec = {
        ...rec,
        id: out.id,
        _row: out.row,
        dateText: dte.text,
        dateISO: dte.iso,
        status: "รอเบิก",
        paid: false,
        claimPdfUrl: "",
        receiptPdfUrl: "",
      };
      s.saved.push(savedRec);
      s.saveProgress.rows = i + 1;
      await this.save(s);
    }

    s.status = "saving_docs";
    await this.save(s);
    this.ctx.waitUntil(this.finishDocuments(s.sid));
    return json({ ok: true, status: s.status, saved: s.saved, message: `บันทึก ${s.saved.length} รายการแล้ว กำลังสร้างเอกสารอัตโนมัติ` });
  }

  async finishDocuments(expectedSid) {
    let s = await this.load();
    if (!s || s.sid !== expectedSid || s.status !== "saving_docs") return;
    try {
      const token = await getUserToken(this.env, s.tenant);
      const sheetId = s.sheetId || (await this.env.KV.get(`tenant:${s.tenant}`)) || this.env.DEFAULT_SHEET_ID;
      const settings = await readSettings(this.env, sheetId, token);
      const docsReady = !!(settings.company_name && settings.tax_id && settings.approver_name);
      for (let i = 0; i < s.saved.length; i++) {
        const rec = s.saved[i];
        if (!docsReady) {
          s.saveProgress.errors.push({ id: rec.id, error: "ข้อมูลบริษัทไม่ครบ จึงยังไม่สร้าง PDF" });
          continue;
        }
        try {
          const docs = await createExpenseDocuments(this.env, rec, settings, token);
          const patch = { slipNo: docs.receiptNo, claimPdfUrl: docs.claimUrl, receiptPdfUrl: docs.receiptUrl };
          await updateExpenseById(this.env, sheetId, rec.id, patch, token);
          s.saved[i] = { ...rec, ...patch };
          s.saveProgress.documents += 1;
        } catch (e) {
          console.error("multi docs", rec.id, e);
          s.saveProgress.errors.push({ id: rec.id, error: String(e.message || e).slice(0, 180) });
        }
        await this.save(s);
      }
      s.status = "done";
      await this.save(s);
      if (s.targetId) {
        const total = s.saved.reduce((sum, r) => sum + Number(r.amount || 0), 0);
        await push(this.env, s.targetId, textMsg(`บันทึกชุดเอกสารสำเร็จ ✅\n${s.saved.length} รายการ · รวม ฿${money(total)}\nรายการทั้งหมดถูกส่งเข้ารอบเบิกแล้ว`));
      }
    } catch (e) {
      console.error("finish multi documents", e);
      s = await this.load();
      if (s) {
        s.status = "error";
        s.saveProgress = s.saveProgress || { errors: [] };
        s.saveProgress.errors = [...(s.saveProgress.errors || []), { error: String(e.message || e).slice(0, 180) }];
        await this.save(s);
        if (s.targetId) await push(this.env, s.targetId, textMsg("บันทึกรายการแล้ว แต่สร้างเอกสารบางส่วนไม่สำเร็จ กรุณาตรวจหน้าเอกสารใน Dashboard"));
      }
    }
  }
}

function invalidPage() {
  return `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",sans-serif;background:#f5f5f7;color:#111;display:grid;place-items:center;min-height:100vh;margin:0}.c{background:#fff;border-radius:24px;padding:32px;max-width:420px;text-align:center;box-shadow:0 18px 50px #0001}h1{font-size:24px}p{color:#6e6e73}</style><div class="c"><h1>ลิงก์ใช้ไม่ได้แล้ว</h1><p>กลับไป LINE แล้วส่งรูปชุดใหม่อีกครั้ง</p></div></html>`;
}

function reviewPage(sid, token, env) {
  const api = `${baseUrl(env)}/multi/api`;
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>จัดชุดเอกสาร</title>
<style>
:root{--bg:#f5f5f7;--card:#fff;--ink:#111;--muted:#6e6e73;--line:#e5e5ea;--soft:#f2f2f7;--ok:#248a3d;--warn:#b54708;--red:#b42318}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",sans-serif}.wrap{max-width:1180px;margin:auto;padding:24px 18px 70px}.top{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:22px}.eyebrow{font-size:11px;color:var(--muted);font-weight:800;letter-spacing:.08em;text-transform:uppercase}h1{font-size:34px;letter-spacing:-1px;margin:6px 0 5px}.sub{color:var(--muted);font-size:14px}.stats{display:flex;gap:8px;flex-wrap:wrap}.pill{background:#fff;border:1px solid var(--line);border-radius:999px;padding:8px 12px;font-size:12px}.layout{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:18px}.panel{background:var(--card);border:1px solid #0000000a;border-radius:24px;box-shadow:0 14px 38px #0000000c;padding:20px}.panel h2{font-size:18px;margin:0 0 4px}.hint{font-size:12px;color:var(--muted);line-height:1.55}.group{border:1px solid var(--line);border-radius:18px;margin-top:15px;overflow:hidden;background:#fff}.ghead{display:flex;justify-content:space-between;gap:12px;padding:15px 16px;background:#fafafa;border-bottom:1px solid var(--line)}.gtitle{font-size:15px;font-weight:800}.warning{font-size:11px;color:var(--warn);font-weight:700;text-align:right}.ready{color:var(--ok)}.fields{display:grid;grid-template-columns:1.1fr 1.5fr 1fr;gap:10px;padding:14px 16px}.field label{display:block;font-size:10px;color:var(--muted);font-weight:800;margin:0 0 5px}.field input,.field select{width:100%;height:40px;border:1px solid var(--line);border-radius:10px;padding:0 10px;background:#fff;color:#111;font:inherit;font-size:13px}.field.wide{grid-column:span 2}.thumbs{display:flex;gap:10px;overflow-x:auto;padding:0 16px 15px}.thumb{min-width:146px;width:146px;border:1px solid var(--line);border-radius:13px;overflow:hidden;background:#fafafa;padding-bottom:7px}.thumb img{display:block;width:146px;height:96px;object-fit:cover;background:#eee}.thumb .t{font-size:10px;padding:7px 7px 4px;color:#3a3a3c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.thumb select{width:calc(100% - 12px);height:30px;margin:4px 6px 0;border:1px solid var(--line);border-radius:8px;background:#fff;font-size:10px;padding:0 5px}.pool{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}.imgcard{border:1px solid var(--line);border-radius:16px;overflow:hidden;background:#fff}.imgcard img{width:100%;height:150px;object-fit:cover;background:#eee}.imgbody{padding:11px}.meta{font-size:11px;color:var(--muted);line-height:1.55;margin-bottom:8px}.imgbody select{width:100%;height:38px;border:1px solid var(--line);border-radius:10px;background:#fff;padding:0 8px}.actions{position:sticky;top:18px}.summary{background:#111;color:#fff;border-radius:20px;padding:20px;margin-bottom:12px}.summary .big{font-size:30px;font-weight:850;letter-spacing:-1px}.summary .small{font-size:12px;color:#c7c7cc;margin-top:4px}.btn{width:100%;height:48px;border:0;border-radius:13px;font-weight:800;font-size:14px;cursor:pointer;background:#111;color:#fff}.btn.secondary{background:#fff;color:#111;border:1px solid var(--line);margin-top:9px}.btn.danger{color:var(--red)}.note{font-size:11px;color:var(--muted);line-height:1.6;margin-top:12px}.empty{padding:28px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:16px;margin-top:14px}.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#111;color:#fff;padding:11px 15px;border-radius:999px;font-size:12px;opacity:0;pointer-events:none;transition:.2s}.toast.on{opacity:1}.overlay{position:fixed;inset:0;background:#f5f5f7e8;display:none;place-items:center;z-index:10}.overlay.on{display:grid}.done{background:#fff;border-radius:24px;padding:30px;max-width:460px;text-align:center;box-shadow:0 20px 60px #0002}.done h2{font-size:25px}.link{color:#0066cc;text-decoration:none}.roleRow{display:flex;gap:6px;align-items:center;margin-bottom:8px}.roleRow select{flex:1}
@media(max-width:850px){.layout{grid-template-columns:1fr}.actions{position:static;order:-1}.fields{grid-template-columns:1fr 1fr}.pool{grid-template-columns:1fr 1fr}}@media(max-width:560px){.wrap{padding:18px 12px 55px}.top{display:block}h1{font-size:29px}.fields{grid-template-columns:1fr}.field.wide{grid-column:auto}.pool{grid-template-columns:1fr}.panel{padding:16px;border-radius:20px}}
</style></head><body><div class="wrap">
<div class="top"><div><div class="eyebrow">Document matching</div><h1>จัดชุดเอกสาร</h1><div class="sub">AI จับคู่สลิป ใบเสร็จ และหลักฐานให้ก่อน คุณแก้เฉพาะรูปที่ยังไม่แน่ใจ</div></div><div class="stats" id="stats"></div></div>
<div class="layout"><main class="panel"><h2>รายการที่ AI แยกได้</h2><div class="hint">ตรวจยอดและเอกสารของแต่ละรายการก่อนบันทึก</div><div id="groups"></div><div style="height:18px"></div><h2>รูปที่ยังไม่ได้จัด</h2><div class="hint">เลือกรายการปลายทาง หรือสร้างเป็นรายการใหม่</div><div id="pool"></div></main>
<aside class="actions"><div class="summary"><div class="big" id="sumGroups">—</div><div class="small" id="sumText">กำลังโหลด</div></div><div class="panel"><button class="btn" id="saveBtn" onclick="commit(false)">บันทึกทั้งหมด</button><button class="btn secondary" onclick="reload()">โหลดข้อมูลใหม่</button><button class="btn secondary danger" onclick="cancelSession()">ยกเลิกชุดนี้</button><div class="note">รูปที่เลือก “ไม่ใช้” จะไม่ถูกบันทึก แต่ไฟล์ต้นฉบับยังอยู่ใน Google Drive</div></div></aside></div></div>
<div class="toast" id="toast"></div><div class="overlay" id="overlay"><div class="done"><h2 id="doneTitle">กำลังบันทึก</h2><p id="doneText" class="sub">กรุณารอสักครู่</p><button class="btn" onclick="window.close();history.back()">กลับไป LINE</button></div></div>
<script>
const SID=${JSON.stringify(sid)}, KEY=${JSON.stringify(token)}, API=${JSON.stringify(api)};let D=null;
const q=(s)=>document.querySelector(s);const esc=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
function toast(t){const e=q('#toast');e.textContent=t;e.classList.add('on');setTimeout(()=>e.classList.remove('on'),1800)}
async function api(path,body){const r=await fetch(API+path+'?s='+encodeURIComponent(SID)+'&k='+encodeURIComponent(KEY),{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json().catch(()=>({error:'ระบบตอบกลับไม่ถูกต้อง'}));if(!r.ok){const e=new Error(j.error||'เกิดข้อผิดพลาด');e.data=j;throw e}return j}
async function reload(){try{D=await api('/state');render()}catch(e){toast(e.message)}}
function roleOptions(cur){return (D.roles||[]).map(r=>'<option value="'+r.value+'"'+(r.value===cur?' selected':'')+'>'+esc(r.label)+'</option>').join('')}
function groupOptions(cur){let h='<option value="unassigned">ยังไม่จัด</option><option value="new">สร้างรายการใหม่</option>';for(const g of D.groups)h+='<option value="'+g.id+'"'+(g.id===cur?' selected':'')+'>รายการ '+g.number+' · ฿'+Number(g.amount||0).toLocaleString('th-TH')+'</option>';h+='<option value="ignore">ไม่ใช้รูปนี้</option>';return h}
function render(){q('#stats').innerHTML='<span class="pill">'+D.counts.images+' รูป</span><span class="pill">'+D.counts.groups+' รายการ</span><span class="pill">'+D.counts.unassigned+' ยังไม่จัด</span>';q('#sumGroups').textContent=D.counts.groups+' รายการ';q('#sumText').textContent='พร้อม '+D.counts.ready+' · คำเตือน '+D.counts.warnings+' · ยังไม่จัด '+D.counts.unassigned;q('#saveBtn').disabled=D.status==='saving'||D.status==='saving_docs';renderGroups();renderPool();if(D.status==='done'){showDone('บันทึกสำเร็จ',D.saved.length+' รายการถูกส่งเข้ารอบเบิกแล้ว')}else if(D.status==='saving_docs'){showDone('บันทึกรายการแล้ว','ระบบกำลังสร้าง PDF อัตโนมัติ สามารถกลับไป LINE ได้เลย')}}
function renderGroups(){const root=q('#groups');if(!D.groups.length){root.innerHTML='<div class="empty">ยังไม่พบรายการ ส่งรูปเพิ่มหรือจัดรูปจากกองด้านล่าง</div>';return}root.innerHTML=D.groups.map(g=>'<section class="group"><div class="ghead"><div class="gtitle">รายการ '+g.number+' · ฿'+Number(g.amount||0).toLocaleString('th-TH',{minimumFractionDigits:2})+'</div><div class="warning '+(!g.warning?'ready':'')+'">'+esc(g.warning||'เอกสารพร้อม')+'</div></div><div class="fields"><div class="field"><label>จำนวนเงิน</label><input type="number" step="0.01" value="'+esc(g.amount||'')+'" onchange="patchGroup(\''+g.id+'\',{amount:this.value})"></div><div class="field"><label>ผู้รับ / ร้านค้า</label><input value="'+esc(g.vendor||'')+'" onchange="patchGroup(\''+g.id+'\',{vendor:this.value})"></div><div class="field"><label>วันที่รายการ</label><input type="date" value="'+esc(g.date||'')+'" onchange="patchGroup(\''+g.id+'\',{date:this.value})"></div><div class="field"><label>หมวด</label><select onchange="patchGroup(\''+g.id+'\',{category:this.value})">'+D.categories.map(c=>'<option'+(c===g.category?' selected':'')+'>'+esc(c)+'</option>').join('')+'</select></div><div class="field wide"><label>รายละเอียด</label><input value="'+esc(g.note||'')+'" onchange="patchGroup(\''+g.id+'\',{note:this.value})"></div></div><div class="thumbs">'+g.images.map(im=>'<div class="thumb"><img src="'+esc(im.imgUrl)+'"><div class="t">'+esc(im.roleLabel)+'</div><select onchange="changeRole(\''+im.id+'\',this.value)">'+roleOptions(im.role)+'</select><select onchange="assign(\''+im.id+'\',this.value)">'+groupOptions(g.id)+'</select></div>').join('')+'</div></section>').join('')}
function renderPool(){const root=q('#pool');const list=D.items.filter(x=>!x.groupId&&!x.ignored);if(!list.length){root.innerHTML='<div class="empty">ไม่มีรูปค้างจัด</div>';return}root.className='pool';root.innerHTML=list.map(x=>'<div class="imgcard"><img src="'+esc(x.imgUrl)+'"><div class="imgbody"><div class="roleRow"><select onchange="changeRole(\''+x.id+'\',this.value)">'+roleOptions(x.role)+'</select></div><div class="meta">'+(x.ocrFailed?'<b style="color:#B42318">AI อ่านไม่สำเร็จ — จัดรูปเอง</b><br>':'')+esc(x.vendor||x.matchHint||'ไม่พบชื่อ')+'<br>ยอด '+(Number(x.amount)>0?'฿'+Number(x.amount).toLocaleString('th-TH'):'ไม่พบ')+' · '+esc(x.date||'ไม่มีวันที่')+'</div><select onchange="assign(\''+x.id+'\',this.value)">'+groupOptions('unassigned')+'</select></div></div>').join('')}
async function assign(itemId,target){try{D=await api('/assign',{itemId,target});render();toast('จัดรูปแล้ว')}catch(e){toast(e.message)}}async function changeRole(itemId,role){try{D=await api('/role',{itemId,role});render()}catch(e){toast(e.message)}}async function patchGroup(groupId,patch){try{D=await api('/group',{groupId,patch});render()}catch(e){toast(e.message)}}
async function commit(force){try{q('#saveBtn').disabled=true;const r=await api('/commit',{force});D={...D,...r};showDone('บันทึกรายการแล้ว',r.message||'กำลังสร้างเอกสารอัตโนมัติ');setTimeout(reload,1800)}catch(e){q('#saveBtn').disabled=false;if(e.data&&e.data.code==='duplicates'){if(confirm('พบรายการที่อาจเบิกซ้ำ '+e.data.duplicates.length+' รายการ\nต้องการบันทึกต่อหรือไม่?'))return commit(true)}if(e.data&&e.data.code==='profile_required'&&e.data.profileUrl){if(confirm(e.message+'\nเปิดหน้ากรอกข้อมูลตอนนี้หรือไม่?'))location.href=e.data.profileUrl;return}alert(e.message)}}
async function cancelSession(){if(!confirm('ยกเลิกชุดเอกสารนี้?'))return;try{await api('/cancel',{});showDone('ยกเลิกแล้ว','รูปต้นฉบับยังอยู่ใน Google Drive')}catch(e){toast(e.message)}}function showDone(t,x){q('#doneTitle').textContent=t;q('#doneText').textContent=x;q('#overlay').classList.add('on')}
reload();setInterval(()=>{if(D&&['saving','saving_docs'].includes(D.status))reload()},3000);
</script></body></html>`;
}
