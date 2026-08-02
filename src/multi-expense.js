// src/multi-expense.js — v1.6 (LINE card hotfix + fallback summary)
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
function explicitVatItem(item) {
  if (!item || item.role !== "TAX_INVOICE") return false;
  const vatAmount = Number(item.vatAmount || 0);
  const vatRate = Number(item.vatRate || 0);
  return vatAmount > 0 || (item.vat === true && vatRate > 0);
}
function groupVatAmount(s, g) {
  const item = groupItems(s, g).find(explicitVatItem);
  if (!item || g.vat !== true) return 0;
  const explicit = Number(item.vatAmount || g.vatAmount || 0);
  if (explicit > 0) return explicit;
  const rate = Number(g.vatRate || item.vatRate || 0);
  const amount = Number(g.amount || 0);
  return rate > 0 && amount > 0 ? amount * rate / (100 + rate) : 0;
}
function identityTokens(item) {
  return [item?.vendor, item?.matchHint, item?.invoiceNo, item?.referenceNo]
    .map(norm).filter((x) => x && x.length >= 4);
}
function identityOverlap(aItems, bItems) {
  const a = aItems.flatMap(identityTokens);
  const b = bItems.flatMap(identityTokens);
  return a.some((x) => b.some((y) => x === y || (x.length >= 6 && y.length >= 6 && (x.includes(y) || y.includes(x)))));
}

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
    vatAmount: 0,
    manualVat: false,
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
  if (!g.manualVat) {
    const vatItem = items.find(explicitVatItem);
    g.vat = !!vatItem;
    g.vatRate = vatItem ? Number(vatItem.vatRate || 7) : 0;
    g.vatAmount = vatItem ? Number(vatItem.vatAmount || 0) : 0;
  }
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
  let hasIdentity = false;

  if (amountKnown(item.amount) && amountKnown(g.amount)) {
    if (!sameAmount(item.amount, g.amount) && !sameAmount(item.amount, g.payAmount)) return -999;
    score += 42; // ยอดตรงอย่างเดียวไม่พอให้จับคู่อัตโนมัติ
  }

  if (item.date && g.date) {
    const dd = dateDiffDays(item.date, g.date);
    if (dd === 0) score += 18;
    else if (dd <= 1) score += 7;
    else if (dd > 7) score -= 20;
  }

  const iv = norm(item.vendor);
  const gv = norm(g.vendor);
  if (iv && gv) {
    if (iv === gv) { score += 30; hasIdentity = true; }
    else if (iv.length >= 6 && gv.length >= 6 && (iv.includes(gv) || gv.includes(iv))) {
      score += 16; hasIdentity = true;
    } else {
      score -= 12;
    }
  }

  const refs = [item.referenceNo, item.invoiceNo, item.matchHint].map(norm).filter((x) => x && x.length >= 4);
  const groupRefs = items.flatMap((x) => [x.referenceNo, x.invoiceNo, x.matchHint])
    .map(norm).filter((x) => x && x.length >= 4);
  if (refs.some((r) => groupRefs.some((gr) => r === gr || (r.length >= 6 && gr.length >= 6 && (r.includes(gr) || gr.includes(r)))))) {
    score += 38;
    hasIdentity = true;
  }

  if (item.role === "PAYSLIP" && groupHasRole(s, g, "PAYSLIP")) score -= 60;
  if (primaryRole(item.role) && items.some((x) => primaryRole(x.role))) score -= 50;

  // รูปหลักฐานที่ไม่มีข้อมูลยืนยัน ห้ามแนบมั่วอัตโนมัติ
  if (item.role === "PROOF" && !hasIdentity) return -999;

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
  const threshold = amountKnown(item.amount) ? 72 : 70;
  const confident = best && best.score >= threshold && (!second || best.score - second.score >= 18);
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

  // รูปหลักฐานที่ไม่มีข้อมูลเชื่อมโยง จะรอให้ผู้ใช้จัดเองเสมอ

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

        const aItems = groupItems(s, a);
        const bItems = groupItems(s, b);
        const aPrimary = aItems.some((x) => primaryRole(x.role));
        const bPrimary = bItems.some((x) => primaryRole(x.role));
        const aSlip = groupHasRole(s, a, "PAYSLIP");
        const bSlip = groupHasRole(s, b, "PAYSLIP");
        if (!((aPrimary && bSlip && !aSlip) || (bPrimary && aSlip && !bSlip))) continue;

        const identityMatched = identityOverlap(aItems, bItems);
        const exactDate = !!a.date && !!b.date && dateDiffDays(a.date, b.date) === 0;
        const aVendor = norm(a.vendor), bVendor = norm(b.vendor);
        const oneSideMissingVendor = !aVendor || !bVendor;

        // ป้องกันยอดเท่ากันแล้วจับมั่ว: ต้องมีชื่อ/เลขอ้างอิงตรง
        // หรือเป็นยอดที่ตรงวันเดียวกันและฝั่งหนึ่งไม่มีชื่อจริง ๆ
        if (!identityMatched && !(exactDate && oneSideMissingVendor)) continue;

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
  s.groups = s.groups.filter((g) => g.manualEmpty === true || g.itemIds.some((id) => s.items[id] && !s.items[id].ignored));
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
  const total = v.groups.reduce((sum, g) => sum + Number(g.amount || 0), 0);
  const vatTotal = s.groups.reduce((sum, g) => sum + groupVatAmount(s, g), 0);
  const preview = v.groups.slice(0, 6);
  const rows = [
    {
      type: "box", layout: "horizontal", alignItems: "center", contents: [
        { type: "text", text: "ตรวจรายการก่อนบันทึก", size: "lg", weight: "bold", color: "#111111", flex: 1, wrap: true },
        { type: "text", text: `${v.counts.groups} รายการ`, size: "sm", color: "#6E6E73", align: "end" },
      ],
    },
    { type: "separator", margin: "lg", color: "#E5E5EA" },
  ];

  preview.forEach((g, index) => {
    const title = g.category && g.category !== "อื่น ๆ" ? g.category : (g.vendor || "ยังไม่ระบุหมวด");
    const detail = g.note || g.vendor || "ยังไม่มีรายละเอียด";
    const payType = g.counts?.slip ? "เงินโอน" : "เอกสาร";
    rows.push({
      type: "box", layout: "vertical", margin: index === 0 ? "lg" : "xl", contents: [
        {
          type: "box", layout: "horizontal", contents: [
            { type: "text", text: `${index + 1}. ${title}`, size: "md", weight: "bold", color: "#111111", flex: 1, wrap: true },
            { type: "text", text: `฿${money(g.amount)}`, size: "md", weight: "bold", color: "#111111", align: "end", flex: 0 },
          ],
        },
        { type: "text", text: detail, size: "sm", color: "#6E6E73", wrap: true, margin: "xs" },
        { type: "text", text: `${payType} · ${g.images.length} รูป`, size: "xs", color: "#8E8E93", wrap: true, margin: "xs" },
        ...(g.warning ? [{ type: "text", text: g.warning, size: "xs", color: "#B54708", wrap: true, margin: "xs" }] : []),
      ],
    });
  });

  if (v.groups.length > preview.length) {
    rows.push({ type: "text", text: `และอีก ${v.groups.length - preview.length} รายการ`, size: "sm", color: "#6E6E73", margin: "lg" });
  }

  const summaryContents = [
    {
      type: "box", layout: "horizontal", alignItems: "center", contents: [
        { type: "text", text: "ยอดรวม", size: "sm", color: "#6E6E73", flex: 1 },
        { type: "text", text: `฿${money(total)}`, size: "xl", weight: "bold", color: "#111111", align: "end" },
      ],
    },
  ];
  if (vatTotal > 0.005) {
    summaryContents.push({
      type: "text",
      text: `VAT ตามเอกสาร ฿${money(vatTotal)} · ยอดก่อน VAT ฿${money(Math.max(0, total - vatTotal))}`,
      size: "xs", color: "#6E6E73", margin: "sm", wrap: true,
    });
  }
  if (needs) {
    summaryContents.push({
      type: "text", text: `มี ${needs} จุดที่ต้องตรวจ`, size: "xs",
      color: "#B54708", margin: "sm", wrap: true,
    });
  }
  rows.push({
    type: "box", layout: "vertical", margin: "xl", backgroundColor: "#F5F5F7",
    cornerRadius: "14px", paddingAll: "14px", contents: summaryContents,
  });

  return {
    type: "flex",
    altText: `ตรวจ ${v.counts.groups} รายการ รวม ${money(total)} บาท`,
    contents: {
      type: "bubble", size: "mega",
      body: { type: "box", layout: "vertical", paddingAll: "20px", backgroundColor: "#FFFFFF", contents: rows },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", paddingAll: "14px", contents: [
          { type: "button", style: "primary", color: "#111111", height: "sm", action: { type: "uri", label: "ตรวจและยืนยัน", uri: reviewUrl } },
          { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "ยกเลิกชุด", data: `act=multi_cancel&s=${encodeURIComponent(s.sid)}` } },
        ],
      },
      styles: {
        body: { backgroundColor: "#FFFFFF" },
        footer: { backgroundColor: "#FFFFFF", separator: true, separatorColor: "#E5E5EA" },
      },
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
        g.itemIds.push(item.id); g.manual = true; g.manualEmpty = false; item.groupId = g.id; recomputeGroup(s, g);
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

    if (url.pathname === "/new-group" && request.method === "POST") {
      const g = groupTemplate();
      g.manual = true;
      g.manualEmpty = true;
      g.category = "อื่น ๆ";
      s.groups.push(g);
      await this.save(s);
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
      if (patch.vatMode !== undefined) {
        const rate = Number(patch.vatMode || 0);
        g.vat = rate > 0;
        g.vatRate = rate > 0 ? rate : 0;
        g.vatAmount = 0;
        g.manualVat = true;
      }
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

    const reviewUrl = `${baseUrl(this.env)}/multi/review?s=${encodeURIComponent(s.sid)}&k=${encodeURIComponent(s.token)}`;
    let ok = await push(this.env, s.targetId, summaryCard(s, this.env));

    // กัน Flex Message ผิด schema แล้วหายเงียบ: ส่งลิงก์ข้อความธรรมดาสำรองทันที
    if (!ok) {
      console.error(`[multi-summary] flex rejected; sending text fallback sid=${s.sid} seq=${s.seq}`);
      const v = publicState(s);
      const total = v.groups.reduce((sum, g) => sum + Number(g.amount || 0), 0);
      ok = await push(this.env, s.targetId, textMsg(
        `ตรวจชุดเอกสาร ${v.counts.groups} รายการ รวม ${money(total)} บาท\n` +
        `เปิดเพื่อตรวจ จัดรูป และยืนยันบันทึก:\n${reviewUrl}`
      ));
    }

    if (ok) {
      s.lastSummarySeq = s.seq;
      await this.save(s);
    }
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
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>ตรวจและยืนยัน</title>
<style>
:root{--bg:#f7f6f3;--card:#fff;--ink:#1d1d1f;--muted:#77736e;--line:#e8e4dd;--field:#f4f1ec;--accent:#9f1d1d;--danger:#b42318;--ok:#248a3d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Thai",sans-serif}.wrap{max-width:1160px;margin:auto;padding:34px 20px 118px}.hero{text-align:center;padding:20px 10px 30px}.eyebrow{font-size:12px;color:var(--muted);font-weight:700;letter-spacing:.04em}.total{font-size:52px;line-height:1;font-weight:850;letter-spacing:-2px;margin:10px 0 8px}.total .currency{font-size:24px;color:#a29d96;margin-right:5px}.sub{font-size:13px;color:var(--muted);line-height:1.55}.sectionTitle{font-size:13px;font-weight:800;margin:0 0 10px}.list{background:var(--card);border:1px solid var(--line);border-radius:22px;overflow:hidden}.group{padding:22px 18px;border-bottom:1px solid var(--line)}.group:last-child{border-bottom:0}.ghead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:12px}.gtitle{font-size:17px;font-weight:800}.gdesc{font-size:12px;color:var(--muted);line-height:1.5;margin-top:3px}.gamount{font-size:17px;font-weight:850;white-space:nowrap}.warn{font-size:11px;color:#b54708;margin-top:5px;text-align:right}.ready{color:var(--ok)}.fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}.field.full{grid-column:1/-1}.field label{display:block;font-size:10px;color:var(--muted);font-weight:700;margin:0 0 5px}.field input,.field select{width:100%;height:44px;border:0;border-radius:12px;padding:0 13px;background:var(--field);color:var(--ink);font:inherit;font-size:14px}.thumbs{display:flex;gap:12px;overflow:auto;padding-top:14px;padding-bottom:4px}.thumb{position:relative;min-width:158px;width:158px;background:#faf9f7;border:1px solid var(--line);border-radius:14px;padding:8px}.thumb img{display:block;width:140px;height:104px;object-fit:cover;border-radius:10px;background:#eee;border:1px solid var(--line);cursor:zoom-in}.thumb label{display:block;font-size:9px;color:var(--muted);font-weight:700;margin:7px 2px 3px}.thumb select{width:140px;height:34px;border:0;background:var(--field);border-radius:9px;font-size:11px;padding:0 7px}.moveSelect{font-weight:700;color:#1d1d1f}.delete{border:0;background:transparent;color:var(--danger);font-size:12px;font-weight:750;padding:8px 0 0;cursor:pointer}.empty{padding:34px 18px;text-align:center;color:var(--muted)}.poolWrap{margin-top:28px}.pool{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.imgcard{background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden}.imgcard img{display:block;width:100%;height:150px;object-fit:cover;background:#eee}.imgbody{padding:11px}.meta{font-size:11px;color:var(--muted);line-height:1.55;margin:6px 0 9px}.imgbody label{display:block;font-size:10px;color:var(--muted);font-weight:700;margin:8px 0 4px}.imgbody select{width:100%;height:40px;border:0;background:var(--field);border-radius:10px;padding:0 8px}.bottom{position:fixed;left:0;right:0;bottom:0;background:#ffffffee;backdrop-filter:blur(16px);border-top:1px solid var(--line);padding:12px max(18px,calc((100vw - 1120px)/2));z-index:8}.bottomInner{display:grid;grid-template-columns:minmax(160px,.7fr) minmax(260px,1.3fr);gap:10px}.btn{height:52px;border-radius:14px;border:1px solid var(--line);background:#fff;color:var(--ink);font:inherit;font-weight:800;cursor:pointer}.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn:disabled{opacity:.45}.minor{display:flex;justify-content:flex-end;gap:14px;margin:12px 2px 0}.linkBtn{border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;cursor:pointer}.toast{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);background:#111;color:#fff;padding:11px 15px;border-radius:999px;font-size:12px;opacity:0;pointer-events:none;transition:.2s;z-index:12}.toast.on{opacity:1}.overlay{position:fixed;inset:0;background:#f7f6f3e8;display:none;place-items:center;z-index:20}.overlay.on{display:grid}.done{background:#fff;border-radius:24px;padding:30px;max-width:460px;text-align:center;box-shadow:0 20px 60px #0002}.done h2{font-size:25px}.done .btn{width:100%;margin-top:10px}
@media(max-width:760px){.wrap{padding:22px 12px 112px}.hero{padding-top:8px}.total{font-size:44px}.fields{grid-template-columns:1fr}.pool{grid-template-columns:repeat(2,minmax(0,1fr))}.bottom{padding:10px 12px}.bottomInner{grid-template-columns:1fr 1.7fr}.group{padding:18px 14px}.thumb{min-width:148px;width:148px}.thumb img,.thumb select{width:130px}}@media(max-width:480px){.pool{grid-template-columns:1fr 1fr}.ghead{gap:8px}.gtitle{font-size:15px}.gamount{font-size:15px}.bottomInner{grid-template-columns:1fr 1.5fr}.btn{font-size:13px}}
</style></head><body><div class="wrap">
<div class="hero"><div class="eyebrow">ตรวจชุดเอกสาร</div><div class="total"><span class="currency">฿</span><span id="sumTotal">—</span></div><div class="sub" id="sumVat">กำลังโหลด</div><div class="sub" id="sumCount"></div></div>
<div class="sectionTitle">รายการ</div><div class="list" id="groups"></div>
<div class="poolWrap"><div class="sectionTitle">รูปที่ยังไม่ได้จัด</div><div class="pool" id="pool"></div></div>
<div class="minor"><button class="linkBtn" onclick="reload()">โหลดข้อมูลใหม่</button><button class="linkBtn" style="color:#b42318" onclick="cancelSession()">ยกเลิกชุดนี้</button></div></div>
<div class="bottom"><div class="bottomInner"><button class="btn" onclick="addBlank()">+ เปล่า</button><button class="btn primary" id="saveBtn" onclick="commit(false)">ยืนยันบันทึก</button></div></div>
<div class="toast" id="toast"></div><div class="overlay" id="overlay"><div class="done"><h2 id="doneTitle">กำลังบันทึก</h2><p id="doneText" class="sub">กรุณารอสักครู่</p><button class="btn primary" onclick="window.close();history.back()">กลับไป LINE</button></div></div>
<script>
const SID=${JSON.stringify(sid)},KEY=${JSON.stringify(token)},API=${JSON.stringify(api)};let D=null;
const q=(s)=>document.querySelector(s);const esc=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
function toast(t){const e=q('#toast');e.textContent=t;e.classList.add('on');setTimeout(()=>e.classList.remove('on'),1800)}
async function api(path,body){const r=await fetch(API+path+'?s='+encodeURIComponent(SID)+'&k='+encodeURIComponent(KEY),{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json().catch(()=>({error:'ระบบตอบกลับไม่ถูกต้อง'}));if(!r.ok){const e=new Error(j.error||'เกิดข้อผิดพลาด');e.data=j;throw e}return j}
function roleOptions(cur){return (D.roles||[]).map(r=>'<option value="'+r.value+'"'+(r.value===cur?' selected':'')+'>'+esc(r.label)+'</option>').join('')}
function groupOptions(cur,label){let h='<option value="" selected disabled>'+esc(label||'ย้ายรูปไป...')+'</option><option value="unassigned">พักไว้ในรูปค้างจัด</option><option value="new">แยกเป็นรายการใหม่</option>';for(const g of D.groups){if(g.id!==cur)h+='<option value="'+g.id+'">ย้ายไป รายการ '+g.number+' · ฿'+Number(g.amount||0).toLocaleString('th-TH')+'</option>'}h+='<option value="ignore">ไม่ใช้รูปนี้</option>';return h}
function titleOf(g){return g.category&&g.category!=='อื่น ๆ'?g.category:(g.vendor||'ยังไม่ระบุหมวด')}
function vatOf(g){if(g.vat!==true)return 0;const explicit=Number(g.vatAmount||0);if(explicit>0)return explicit;const r=Number(g.vatRate||0),a=Number(g.amount||0);return r>0?a*r/(100+r):0}
async function reload(){try{D=await api('/state');render()}catch(e){toast(e.message)}}
function render(){const total=D.groups.reduce((s,g)=>s+Number(g.amount||0),0);const vat=D.groups.reduce((s,g)=>s+vatOf(g),0);q('#sumTotal').textContent=total.toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});q('#sumVat').textContent=vat>0.005?'VAT ตามเอกสาร '+vat.toLocaleString('th-TH',{minimumFractionDigits:2})+' บาท · ยอดก่อน VAT '+Math.max(0,total-vat).toLocaleString('th-TH',{minimumFractionDigits:2})+' บาท':'ไม่มี VAT ที่ต้องนำมาคำนวณ';q('#sumCount').textContent=D.counts.groups+' รายการ · '+(D.counts.unassigned?'ยังไม่จัด '+D.counts.unassigned+' รูป':'จัดครบแล้ว');q('#saveBtn').disabled=D.status==='saving'||D.status==='saving_docs';renderGroups();renderPool();if(D.status==='done')showDone('บันทึกสำเร็จ',D.saved.length+' รายการถูกส่งเข้ารอบเบิกแล้ว');else if(D.status==='saving_docs')showDone('บันทึกรายการแล้ว','ระบบกำลังสร้าง PDF อัตโนมัติ สามารถกลับไป LINE ได้เลย')}
function renderGroups(){const root=q('#groups');if(!D.groups.length){root.innerHTML='<div class="empty">ยังไม่มีรายการ กด “+ เปล่า” หรือจัดรูปด้านล่างเข้ารายการ</div>';return}root.innerHTML=D.groups.map(g=>'<section class="group"><div class="ghead"><div><div class="gtitle">'+esc(titleOf(g))+'</div><div class="gdesc">'+esc(g.note||g.vendor||'ยังไม่มีรายละเอียด')+' · '+g.images.length+' รูป</div></div><div><div class="gamount">฿'+Number(g.amount||0).toLocaleString('th-TH',{minimumFractionDigits:2})+'</div><div class="warn '+(!g.warning?'ready':'')+'">'+esc(g.warning||'พร้อมบันทึก')+'</div></div></div><div class="fields"><div class="field full"><label>ชื่อรายการ</label><input value="'+esc(g.note||'')+'" onchange="patchGroup(\\''+g.id+'\\',{note:this.value})"></div><div class="field"><label>ยอด (บาท)</label><input type="number" step="0.01" value="'+esc(g.amount||'')+'" onchange="patchGroup(\\''+g.id+'\\',{amount:this.value})"></div><div class="field"><label>หมวด</label><select onchange="patchGroup(\\''+g.id+'\\',{category:this.value})">'+D.categories.map(c=>'<option'+(c===g.category?' selected':'')+'>'+esc(c)+'</option>').join('')+'</select></div><div class="field"><label>ผู้รับ / ร้านค้า</label><input value="'+esc(g.vendor||'')+'" onchange="patchGroup(\\''+g.id+'\\',{vendor:this.value})"></div><div class="field"><label>วันที่รายการ</label><input type="date" value="'+esc(g.date||'')+'" onchange="patchGroup(\\''+g.id+'\\',{date:this.value})"></div><div class="field"><label>VAT</label><select onchange="patchGroup(\\''+g.id+'\\',{vatMode:this.value})"><option value="0"'+(!(g.vat===true&&Number(g.vatRate)>0)?' selected':'')+'>ไม่มี VAT</option><option value="7"'+(g.vat===true&&Number(g.vatRate)===7?' selected':'')+'>VAT 7%</option></select></div></div><div class="thumbs">'+g.images.map(im=>'<div class="thumb"><a href="'+esc(im.imgUrl)+'" target="_blank" rel="noopener"><img src="'+esc(im.imgUrl)+'"></a><label>ประเภทเอกสาร</label><select onchange="changeRole(\\''+im.id+'\\',this.value)">'+roleOptions(im.role)+'</select><label>ย้ายรูปไป</label><select class="moveSelect" onchange="assign(\\''+im.id+'\\',this.value)">'+groupOptions(g.id,'เลือกปลายทาง')+'</select></div>').join('')+'</div><button class="delete" onclick="deleteGroup(\\''+g.id+'\\')">ลบรายการ</button></section>').join('')}
function renderPool(){const root=q('#pool');const list=D.items.filter(x=>!x.groupId&&!x.ignored);if(!list.length){root.innerHTML='<div class="empty" style="grid-column:1/-1">ไม่มีรูปค้างจัด</div>';return}root.innerHTML=list.map(x=>'<div class="imgcard"><a href="'+esc(x.imgUrl)+'" target="_blank" rel="noopener"><img src="'+esc(x.imgUrl)+'"></a><div class="imgbody"><label>ประเภทเอกสาร</label><select onchange="changeRole(\\''+x.id+'\\',this.value)">'+roleOptions(x.role)+'</select><div class="meta">'+(x.ocrFailed?'<b style="color:#b42318">AI อ่านไม่สำเร็จ</b><br>':'')+esc(x.vendor||x.matchHint||'ไม่พบชื่อ')+'<br>ยอด '+(Number(x.amount)>0?'฿'+Number(x.amount).toLocaleString('th-TH'):'ไม่พบ')+'</div><label>จัดรูปเข้า</label><select class="moveSelect" onchange="assign(\\''+x.id+'\\',this.value)">'+groupOptions('','เลือกรายการปลายทาง')+'</select></div></div>').join('')}
async function assign(itemId,target){if(!target)return;try{D=await api('/assign',{itemId,target});render();toast('ย้ายรูปแล้ว')}catch(e){toast(e.message)}}
async function changeRole(itemId,role){try{D=await api('/role',{itemId,role});render()}catch(e){toast(e.message)}}
async function patchGroup(groupId,patch){try{D=await api('/group',{groupId,patch});render()}catch(e){toast(e.message)}}
async function addBlank(){try{D=await api('/new-group',{});render();window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'});toast('เพิ่มรายการเปล่าแล้ว')}catch(e){toast(e.message)}}
async function deleteGroup(groupId){if(!confirm('ลบรายการนี้และนำรูปกลับไปกองรูปค้างจัด?'))return;try{D=await api('/delete-group',{groupId});render()}catch(e){toast(e.message)}}
async function commit(force){try{q('#saveBtn').disabled=true;const r=await api('/commit',{force});D={...D,...r};showDone('บันทึกรายการแล้ว',r.message||'กำลังสร้างเอกสารอัตโนมัติ');setTimeout(reload,1800)}catch(e){q('#saveBtn').disabled=false;if(e.data&&e.data.code==='duplicates'){if(confirm('พบรายการที่อาจเบิกซ้ำ '+e.data.duplicates.length+' รายการ\\nต้องการบันทึกต่อหรือไม่?'))return commit(true)}if(e.data&&e.data.code==='profile_required'&&e.data.profileUrl){if(confirm(e.message+'\\nเปิดหน้ากรอกข้อมูลตอนนี้หรือไม่?'))location.href=e.data.profileUrl;return}alert(e.message)}}
async function cancelSession(){if(!confirm('ยกเลิกชุดเอกสารนี้?'))return;try{await api('/cancel',{});showDone('ยกเลิกแล้ว','รูปต้นฉบับยังอยู่ใน Google Drive')}catch(e){toast(e.message)}}
function showDone(t,x){q('#doneTitle').textContent=t;q('#doneText').textContent=x;q('#overlay').classList.add('on')}
reload();setInterval(()=>{if(D&&['saving','saving_docs'].includes(D.status))reload()},3000);
</script></body></html>`;
}

