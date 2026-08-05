// จัดโครงสร้าง Google Drive แยกตาม tenant/บริษัท และเดือนที่รายการเข้าระบบ
// โครงสร้าง: บริษัท > ประเภทเอกสาร > ปี พ.ศ. > เดือน
// โหมด OAuth: สร้างใต้ My Drive ของบัญชีลูกค้า
// โหมด service account: สร้างใต้ DRIVE_FOLDER_ID ที่แชร์ให้ service account

import { getAccessToken } from "./google-auth.js";

export const DRIVE_FOLDER_VERSION = "TENANT_DRIVE_MONTHLY_V3_1_20260805";

const DRIVE = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const APP_ROOT_NAME = "รับจ่ายแบบไม่จำกัด";

const SUBFOLDERS = Object.freeze({
  claims: "ใบเบิก",
  replacements: "ใบแทนใบเสร็จ",
  originals: "หลักฐานต้นฉบับ",
  payments: "หลักฐานการโอน",
  email: "เอกสารจากอีเมล",
});

const THAI_MONTHS = Object.freeze([
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
]);

function cleanName(value, fallback = "พื้นที่บริษัท") {
  const text = String(value || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (text || fallback).slice(0, 120);
}

function q(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function parseTransactionDate(input) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) return input;
  const raw = String(input || "").trim();
  if (raw) {
    const nums = raw.match(/\d+/g)?.map(Number) || [];
    const looksDayFirst = nums.length >= 3 && String(nums[0]).length < 4
      && /^[0-9]{1,2}[\/-][0-9]{1,2}[\/-][0-9]{2,4}/.test(raw);

    // วันที่ไทย/วัน-เดือน-ปี ต้อง parse เองก่อน เพราะ JS อาจตีปี พ.ศ. เป็น ค.ศ.
    if (looksDayFirst) {
      let [day, month, year] = nums;
      if (year > 2400) year -= 543;
      if (year < 100) year += 2000;
      const parsed = new Date(Date.UTC(year, Math.max(0, month - 1), Math.max(1, day)));
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }

    const direct = new Date(raw);
    if (!Number.isNaN(direct.getTime())) return direct;

    if (nums.length >= 3) {
      let year;
      let month;
      let day;
      if (String(nums[0]).length === 4) [year, month, day] = nums;
      else [day, month, year] = nums;
      if (year > 2400) year -= 543;
      if (year < 100) year += 2000;
      const parsed = new Date(Date.UTC(year, Math.max(0, month - 1), Math.max(1, day)));
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  return new Date();
}

export function drivePeriod(input) {
  const date = parseTransactionDate(input);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const monthNo = String(month).padStart(2, "0");
  return {
    key: `${year}-${monthNo}`,
    year,
    buddhistYear: year + 543,
    month,
    monthNo,
    yearFolderName: String(year + 543),
    monthFolderName: `${monthNo} ${THAI_MONTHS[month - 1]}`,
    iso: `${year}-${monthNo}-01`,
  };
}

async function authToken(env, token) {
  return token || getAccessToken(env);
}

async function driveJson(token, url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`Drive ${res.status}: ${text.slice(0, 360)}`);
  return text ? JSON.parse(text) : {};
}

async function getFile(token, fileId, fields = "id,name,mimeType,parents,trashed") {
  if (!fileId) return null;
  try {
    return await driveJson(
      token,
      `${DRIVE}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`
    );
  } catch (error) {
    if (/Drive 404:/.test(String(error?.message || error))) return null;
    throw error;
  }
}

async function findFolder(token, name, parentId = "") {
  const clauses = [
    `mimeType = '${FOLDER_MIME}'`,
    `name = '${q(name)}'`,
    "trashed = false",
  ];
  if (parentId) clauses.push(`'${q(parentId)}' in parents`);
  const params = new URLSearchParams({
    q: clauses.join(" and "),
    pageSize: "10",
    orderBy: "createdTime",
    fields: "files(id,name,parents,webViewLink)",
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const data = await driveJson(token, `${DRIVE}/files?${params}`);
  return data.files?.[0] || null;
}

async function createFolder(token, name, parentId = "") {
  const body = { name: cleanName(name), mimeType: FOLDER_MIME };
  if (parentId) body.parents = [parentId];
  return driveJson(token, `${DRIVE}/files?fields=id,name,parents,webViewLink&supportsAllDrives=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function findOrCreateFolder(token, name, parentId = "") {
  return (await findFolder(token, name, parentId)) || createFolder(token, name, parentId);
}

async function renameFolder(token, folderId, name) {
  if (!folderId || !name) return;
  await driveJson(token, `${DRIVE}/files/${encodeURIComponent(folderId)}?fields=id,name&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: cleanName(name) }),
  });
}

export async function moveFileToFolder(token, fileId, folderId) {
  if (!token || !fileId || !folderId) return false;
  const file = await getFile(token, fileId, "id,parents,trashed");
  if (!file || file.trashed) return false;
  const parents = Array.isArray(file.parents) ? file.parents : [];
  if (parents.includes(folderId) && parents.length === 1) return true;
  const params = new URLSearchParams({
    addParents: folderId,
    fields: "id,parents",
    supportsAllDrives: "true",
  });
  const remove = parents.filter((id) => id && id !== folderId);
  if (remove.length) params.set("removeParents", remove.join(","));
  await driveJson(token, `${DRIVE}/files/${encodeURIComponent(fileId)}?${params}`, { method: "PATCH" });
  return true;
}

function kvKey(tenant) {
  return `drivefolders:${tenant}`;
}

function periodKvKey(tenant, periodKey) {
  return `driveperiod:${tenant}:${periodKey}`;
}

function folderUrl(id) {
  return id ? `https://drive.google.com/drive/folders/${encodeURIComponent(id)}` : "";
}

function categoryBaseFolderId(folders, category = "") {
  const key = String(category || "").toLowerCase();
  if (["claim", "claims", "batch", "ใบเบิก"].includes(key)) return folders?.claimsBaseFolderId || folders?.claimsFolderId || folders?.companyFolderId || "";
  if (["replacement", "replacements", "receipt", "ใบแทน"].includes(key)) return folders?.replacementsBaseFolderId || folders?.replacementsFolderId || folders?.companyFolderId || "";
  if (["payment", "payments", "payment-slip", "หลักฐานการโอน"].includes(key)) return folders?.paymentsBaseFolderId || folders?.paymentsFolderId || folders?.companyFolderId || "";
  if (["email", "mail", "เอกสารจากอีเมล"].includes(key)) return folders?.emailBaseFolderId || folders?.emailFolderId || folders?.companyFolderId || "";
  if (["asset", "assets", "company", "settings"].includes(key)) return folders?.companyFolderId || "";
  return folders?.originalsBaseFolderId || folders?.originalsFolderId || folders?.companyFolderId || "";
}

function periodCategoryFolderId(periodFolders, category = "") {
  const key = String(category || "").toLowerCase();
  if (["claim", "claims", "batch", "ใบเบิก"].includes(key)) return periodFolders?.claimsFolderId || "";
  if (["replacement", "replacements", "receipt", "ใบแทน"].includes(key)) return periodFolders?.replacementsFolderId || "";
  if (["payment", "payments", "payment-slip", "หลักฐานการโอน"].includes(key)) return periodFolders?.paymentsFolderId || "";
  if (["email", "mail", "เอกสารจากอีเมล"].includes(key)) return periodFolders?.emailFolderId || "";
  if (["asset", "assets", "company", "settings"].includes(key)) return "";
  return periodFolders?.originalsFolderId || "";
}

/** คืนโฟลเดอร์ประเภทหลัก ใช้สำหรับเปิดดู/ค้นไฟล์ครอบคลุมทุกเดือน */
export function folderIdForCategory(folders, category = "") {
  return categoryBaseFolderId(folders, category);
}

/** คืนโฟลเดอร์ปี/เดือนของวันที่รายการเข้าระบบ ใช้เป็นปลายทางตอนอัปโหลด */
export function monthlyFolderIdForCategory(folders, category = "") {
  return periodCategoryFolderId(folders?.currentPeriod, category)
    || categoryBaseFolderId(folders, category);
}

async function ensurePeriodFoldersDirect(token, folders, transactionDate) {
  const period = drivePeriod(transactionDate);
  const out = { key: period.key, year: period.buddhistYear, month: period.month, monthName: period.monthFolderName };
  for (const key of Object.keys(SUBFOLDERS)) {
    const baseFolderId = categoryBaseFolderId(folders, key);
    if (!baseFolderId) continue;
    const yearFolder = await findOrCreateFolder(token, period.yearFolderName, baseFolderId);
    const monthFolder = await findOrCreateFolder(token, period.monthFolderName, yearFolder.id);
    out[`${key}YearFolderId`] = yearFolder.id;
    out[`${key}FolderId`] = monthFolder.id;
  }
  return out;
}

export async function ensureTenantPeriodFolders(env, tenant, folders, token, transactionDate = null) {
  if (!tenant || !folders || !token) throw new Error("missing tenant/folders/token for monthly Drive folders");
  const period = drivePeriod(transactionDate);
  const key = periodKvKey(tenant, period.key);
  if (env?.KV) {
    const raw = await env.KV.get(key);
    if (raw) {
      try {
        const cached = JSON.parse(raw);
        const complete = cached?.claimsFolderId && cached?.replacementsFolderId
          && cached?.originalsFolderId && cached?.paymentsFolderId && cached?.emailFolderId;
        if (complete && cached.companyFolderId === folders.companyFolderId) return cached;
      } catch {}
    }
  }

  const created = {
    ...(await ensurePeriodFoldersDirect(token, folders, transactionDate)),
    tenant,
    companyFolderId: folders.companyFolderId,
    createdAt: new Date().toISOString(),
  };
  if (env?.KV) await env.KV.put(key, JSON.stringify(created));
  return created;
}

export async function getStoredTenantDriveFolders(env, tenant) {
  if (!tenant || !env?.KV) return null;
  const raw = await env.KV.get(kvKey(tenant));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function ensureTenantDriveFolders(env, tenant, token = null, options = {}) {
  if (!tenant) throw new Error("missing tenant for Drive folders");
  const accessToken = await authToken(env, token);
  if (!accessToken) throw new Error("Google Drive ยังไม่ได้เชื่อม");

  const mode = token ? "oauth" : "service-account";
  const serviceParentId = token ? "" : String(env.DRIVE_FOLDER_ID || "").trim();
  if (!token && !serviceParentId) throw new Error("DRIVE_FOLDER_ID not set");

  let stored = await getStoredTenantDriveFolders(env, tenant);
  const desiredCompanyName = cleanName(options.companyName || stored?.companyName || "พื้นที่บริษัท");

  const complete = stored
    && stored.mode === mode
    && stored.companyFolderId
    && (stored.claimsBaseFolderId || stored.claimsFolderId)
    && (stored.replacementsBaseFolderId || stored.replacementsFolderId)
    && (stored.originalsBaseFolderId || stored.originalsFolderId)
    && (stored.paymentsBaseFolderId || stored.paymentsFolderId)
    && (stored.emailBaseFolderId || stored.emailFolderId);

  if (complete) {
    // รองรับข้อมูล v3.0 เดิม โดยตั้งชื่อ base ให้ชัดก่อนคืนค่า
    stored.claimsBaseFolderId ||= stored.claimsFolderId;
    stored.replacementsBaseFolderId ||= stored.replacementsFolderId;
    stored.originalsBaseFolderId ||= stored.originalsFolderId;
    stored.paymentsBaseFolderId ||= stored.paymentsFolderId;
    stored.emailBaseFolderId ||= stored.emailFolderId;

    if (desiredCompanyName && stored.companyName !== desiredCompanyName) {
      await renameFolder(accessToken, stored.companyFolderId, desiredCompanyName).catch((e) => {
        console.warn("rename company Drive folder", e.message);
      });
      stored.companyName = desiredCompanyName;
    }
    if (options.sheetId && stored.sheetId !== options.sheetId) {
      await moveFileToFolder(accessToken, options.sheetId, stored.companyFolderId);
      stored.sheetId = options.sheetId;
    }
    stored.version = 2;
    stored.updatedAt = new Date().toISOString();
    await env.KV.put(kvKey(tenant), JSON.stringify(stored));
    const currentPeriod = await ensureTenantPeriodFolders(
      env, tenant, stored, accessToken, options.transactionDate || options.createdAt || null
    );
    return { ...stored, currentPeriod, accessToken };
  }

  const appRoot = await findOrCreateFolder(accessToken, APP_ROOT_NAME, serviceParentId);
  const company = await findOrCreateFolder(accessToken, desiredCompanyName, appRoot.id);
  const sub = {};
  for (const [key, name] of Object.entries(SUBFOLDERS)) {
    sub[key] = await findOrCreateFolder(accessToken, name, company.id);
  }

  stored = {
    version: 2,
    tenant,
    mode,
    companyName: desiredCompanyName,
    appRootFolderId: appRoot.id,
    companyFolderId: company.id,
    claimsBaseFolderId: sub.claims.id,
    replacementsBaseFolderId: sub.replacements.id,
    originalsBaseFolderId: sub.originals.id,
    paymentsBaseFolderId: sub.payments.id,
    emailBaseFolderId: sub.email.id,
    // คง field เดิมไว้เพื่อ backward compatibility
    claimsFolderId: sub.claims.id,
    replacementsFolderId: sub.replacements.id,
    originalsFolderId: sub.originals.id,
    paymentsFolderId: sub.payments.id,
    emailFolderId: sub.email.id,
    driveUrl: folderUrl(company.id),
    appRootUrl: folderUrl(appRoot.id),
    sheetId: options.sheetId || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (options.sheetId) await moveFileToFolder(accessToken, options.sheetId, company.id);
  await env.KV.put(kvKey(tenant), JSON.stringify(stored));

  const currentPeriod = await ensureTenantPeriodFolders(
    env, tenant, stored, accessToken, options.transactionDate || options.createdAt || null
  );
  return { ...stored, currentPeriod, accessToken };
}

export function tenantDriveFolderUrl(folders) {
  return folders?.driveUrl || folderUrl(folders?.companyFolderId || "");
}

function fileIdFromUrl(value) {
  const raw = String(value || "");
  return (
    raw.match(/drive\.google\.com\/file\/d\/([^/?#]+)/i)?.[1] ||
    raw.match(/[?&]id=([^&#]+)/i)?.[1] ||
    raw.match(/lh3\.googleusercontent\.com\/d\/([^/?#]+)/i)?.[1] ||
    ""
  );
}

function urls(value) {
  return String(value || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function entryDate(record = {}) {
  return record.submittedAt || record.createdAt || record.created_at || record.createdDate
    || record.recordedAt || record.requestedAt || record.receivedAt || record.addedAt
    || record.batchCreatedAt || record.updatedAt || new Date().toISOString();
}

/**
 * ย้ายเฉพาะไฟล์ที่อ้างอิงอยู่ในชีทของ tenant นี้ จึงไม่ปนไฟล์ของ tenant อื่น
 * ไฟล์เก่าถูกแยกเดือนตามวันที่ตั้งเบิก/วันที่รายการเข้าระบบ ไม่ใช้วันที่ตามใบเสร็จ
 */
export async function organizeTenantReferencedFiles(token, folders, expenses = [], emailDocuments = []) {
  const targets = new Map();
  const add = (value, category, transactionDate) => {
    for (const url of urls(value)) {
      const id = fileIdFromUrl(url);
      if (!id) continue;
      const old = targets.get(id);
      if (!old || category === "payments") targets.set(id, { category, transactionDate });
    }
  };

  for (const rec of expenses || []) {
    const date = entryDate(rec);
    add(rec.claimPdfUrl, "claims", date);
    add(rec.batchClaimPdfUrl, "claims", date);
    add(rec.receiptPdfUrl, "replacements", date);
    add(rec.reimbursementSlipUrl, "payments", date);
    add(rec.paymentSlipUrl, "payments", date);
    add(rec.imageUrl, "originals", date);
    add(rec.attReceipt, "originals", date);
    add(rec.attTax, "originals", date);
    add(rec.attSlip, "originals", date);
    add(rec.attOther, "originals", date);
  }
  for (const doc of emailDocuments || []) {
    add(doc.driveUrl || doc.url, "email", entryDate(doc));
  }

  let moved = 0;
  let failed = 0;
  const periodCache = new Map();
  const entries = [...targets.entries()];
  for (let i = 0; i < entries.length; i += 8) {
    const chunk = entries.slice(i, i + 8);
    const result = await Promise.all(chunk.map(async ([fileId, target]) => {
      try {
        const periodKey = drivePeriod(target.transactionDate).key;
        let periodFolders = periodCache.get(periodKey);
        if (!periodFolders) {
          periodFolders = await ensurePeriodFoldersDirect(token, folders, target.transactionDate);
          periodCache.set(periodKey, periodFolders);
        }
        const targetFolder = periodCategoryFolderId(periodFolders, target.category)
          || categoryBaseFolderId(folders, target.category);
        return await moveFileToFolder(token, fileId, targetFolder);
      } catch (error) {
        console.warn("organize tenant Drive file", fileId, target.category, error.message);
        return false;
      }
    }));
    moved += result.filter(Boolean).length;
    failed += result.filter((ok) => !ok).length;
  }
  return { total: entries.length, moved, failed };
}
