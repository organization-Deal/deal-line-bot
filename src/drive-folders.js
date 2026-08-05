// จัดโครงสร้าง Google Drive แยกตาม tenant/บริษัท
// โหมด OAuth: สร้างใต้ My Drive ของบัญชีลูกค้า
// โหมด service account: สร้างใต้ DRIVE_FOLDER_ID ที่แชร์ให้ service account

import { getAccessToken } from "./google-auth.js";

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
  const body = {
    name: cleanName(name),
    mimeType: FOLDER_MIME,
  };
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

function folderUrl(id) {
  return id ? `https://drive.google.com/drive/folders/${encodeURIComponent(id)}` : "";
}

export function folderIdForCategory(folders, category = "") {
  const key = String(category || "").toLowerCase();
  if (["claim", "claims", "batch", "ใบเบิก"].includes(key)) return folders?.claimsFolderId || folders?.companyFolderId || "";
  if (["replacement", "replacements", "receipt", "ใบแทน"].includes(key)) return folders?.replacementsFolderId || folders?.companyFolderId || "";
  if (["payment", "payments", "payment-slip", "หลักฐานการโอน"].includes(key)) return folders?.paymentsFolderId || folders?.companyFolderId || "";
  if (["email", "mail", "เอกสารจากอีเมล"].includes(key)) return folders?.emailFolderId || folders?.companyFolderId || "";
  if (["asset", "assets", "company", "settings"].includes(key)) return folders?.companyFolderId || "";
  return folders?.originalsFolderId || folders?.companyFolderId || "";
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

  // เส้นทางเร็ว: โฟลเดอร์ครบแล้ว ไม่ต้องยิง Drive API ซ้ำทุกครั้งที่อัปไฟล์
  const complete = stored
    && stored.mode === mode
    && stored.companyFolderId
    && stored.claimsFolderId
    && stored.replacementsFolderId
    && stored.originalsFolderId
    && stored.paymentsFolderId
    && stored.emailFolderId;

  if (complete) {
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
    stored.updatedAt = new Date().toISOString();
    await env.KV.put(kvKey(tenant), JSON.stringify(stored));
    return { ...stored, accessToken };
  }

  const appRoot = await findOrCreateFolder(accessToken, APP_ROOT_NAME, serviceParentId);
  const company = await findOrCreateFolder(accessToken, desiredCompanyName, appRoot.id);
  const sub = {};
  for (const [key, name] of Object.entries(SUBFOLDERS)) {
    sub[key] = await findOrCreateFolder(accessToken, name, company.id);
  }

  stored = {
    version: 1,
    tenant,
    mode,
    companyName: desiredCompanyName,
    appRootFolderId: appRoot.id,
    companyFolderId: company.id,
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

  if (options.sheetId) {
    await moveFileToFolder(accessToken, options.sheetId, company.id);
  }

  await env.KV.put(kvKey(tenant), JSON.stringify(stored));
  return { ...stored, accessToken };
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

/**
 * ย้ายเฉพาะไฟล์ที่อ้างอิงอยู่ในชีทของ tenant นี้ จึงไม่ปนไฟล์ของ tenant อื่น
 * ใช้สำหรับจัดระเบียบไฟล์เก่าหลังเปิดใช้โครงสร้างโฟลเดอร์ครั้งแรก
 */
export async function organizeTenantReferencedFiles(token, folders, expenses = [], emailDocuments = []) {
  const targets = new Map();
  const add = (value, category) => {
    for (const url of urls(value)) {
      const id = fileIdFromUrl(url);
      if (!id) continue;
      // หลักฐานการโอนมีลำดับความสำคัญสูงกว่าหลักฐานทั่วไป
      if (!targets.has(id) || category === "payments") targets.set(id, category);
    }
  };

  for (const rec of expenses || []) {
    add(rec.claimPdfUrl, "claims");
    add(rec.batchClaimPdfUrl, "claims");
    add(rec.receiptPdfUrl, "replacements");
    add(rec.reimbursementSlipUrl, "payments");
    add(rec.paymentSlipUrl, "payments");
    add(rec.imageUrl, "originals");
    add(rec.attReceipt, "originals");
    add(rec.attTax, "originals");
    add(rec.attSlip, "originals");
    add(rec.attOther, "originals");
  }
  for (const doc of emailDocuments || []) add(doc.driveUrl || doc.url, "email");

  let moved = 0;
  let failed = 0;
  const entries = [...targets.entries()];
  for (let i = 0; i < entries.length; i += 8) {
    const chunk = entries.slice(i, i + 8);
    const result = await Promise.all(chunk.map(async ([fileId, category]) => {
      try {
        const ok = await moveFileToFolder(token, fileId, folderIdForCategory(folders, category));
        return ok;
      } catch (error) {
        console.warn("organize tenant Drive file", fileId, category, error.message);
        return false;
      }
    }));
    moved += result.filter(Boolean).length;
    failed += result.filter((ok) => !ok).length;
  }
  return { total: entries.length, moved, failed };
}
