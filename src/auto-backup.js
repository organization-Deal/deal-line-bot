// v7.24 — Automatic Google Drive backups per workspace
// Daily: 30 days, Monthly: 12 months, Manual: retained until user removes it.
// Restore never overwrites the current sheet; it creates a safe copy first.

import { getUserToken } from "./oauth.js";
import { ensureTenantDriveFolders } from "./drive-folders.js";

const DRIVE = "https://www.googleapis.com/drive/v3";
const BACKUP_VERSION = "AUTO_BACKUP_V7_24_20260811";

function clean(value, max = 160) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function bangkokParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: Number(get("hour") || 0),
    minute: Number(get("minute") || 0),
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    monthKey: `${get("year")}-${get("month")}`,
  };
}

function statusKey(tenant) { return `backupstatus:v1:${tenant}`; }
function historyKey(tenant) { return `backuphistory:v1:${tenant}`; }
function queueKey(dateKey) { return `backupqueue:v1:${dateKey}`; }

async function driveJson(token, url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`Drive ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

function q(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findFolder(token, name, parentId) {
  const params = new URLSearchParams({
    q: [
      "mimeType = 'application/vnd.google-apps.folder'",
      `name = '${q(name)}'`,
      `'${q(parentId)}' in parents`,
      "trashed = false",
    ].join(" and "),
    fields: "files(id,name,webViewLink,createdTime)",
    pageSize: "10",
    orderBy: "createdTime",
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const data = await driveJson(token, `${DRIVE}/files?${params}`);
  return data.files?.[0] || null;
}

async function createFolder(token, name, parentId) {
  return driveJson(
    token,
    `${DRIVE}/files?fields=id,name,webViewLink,createdTime&supportsAllDrives=true`,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
    }
  );
}

async function ensureFolder(token, name, parentId) {
  return (await findFolder(token, name, parentId)) || createFolder(token, name, parentId);
}

async function ensureBackupFolders(env, tenant, token, sheetId, companyName = "") {
  const tenantFolders = await ensureTenantDriveFolders(env, tenant, token, {
    companyName: companyName || "พื้นที่บริษัท",
    sheetId,
  });
  const backup = await ensureFolder(token, "Backup", tenantFolders.companyFolderId);
  const [daily, monthly, manual, restore] = await Promise.all([
    ensureFolder(token, "Daily", backup.id),
    ensureFolder(token, "Monthly", backup.id),
    ensureFolder(token, "Manual", backup.id),
    ensureFolder(token, "Restore", backup.id),
  ]);
  return {
    tenantFolders,
    backup,
    daily,
    monthly,
    manual,
    restore,
    backupUrl: `https://drive.google.com/drive/folders/${backup.id}`,
  };
}

async function sheetMeta(token, sheetId) {
  return driveJson(
    token,
    `${DRIVE}/files/${encodeURIComponent(sheetId)}?fields=id,name,modifiedTime,webViewLink&supportsAllDrives=true`
  );
}

function snapshotName(companyName, kind, stamp) {
  const type = kind === "monthly" ? "Monthly" : kind === "manual" ? "Manual" : "Daily";
  return `${clean(companyName || "Workspace", 100)} · Backup ${type} · ${stamp}`;
}

async function copySheet(token, sourceSheetId, parentId, name, appProperties = {}) {
  return driveJson(
    token,
    `${DRIVE}/files/${encodeURIComponent(sourceSheetId)}/copy?fields=id,name,createdTime,modifiedTime,webViewLink,parents,appProperties&supportsAllDrives=true`,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        parents: [parentId],
        appProperties,
      }),
    }
  );
}

async function listFolderFiles(token, parentId, { limit = 100 } = {}) {
  const params = new URLSearchParams({
    q: `'${q(parentId)}' in parents and trashed = false`,
    fields: "files(id,name,createdTime,modifiedTime,webViewLink,appProperties)",
    pageSize: String(Math.max(1, Math.min(1000, limit))),
    orderBy: "createdTime desc",
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const data = await driveJson(token, `${DRIVE}/files?${params}`);
  return data.files || [];
}

async function deleteFile(token, fileId) {
  const response = await fetch(
    `${DRIVE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    throw new Error(`Drive delete ${response.status}: ${text.slice(0, 200)}`);
  }
}

async function pruneDaily(token, folderId, days = 30) {
  const files = await listFolderFiles(token, folderId, { limit: 500 });
  const cutoff = Date.now() - Math.max(1, days) * 86400000;
  const old = files.filter((file) => Date.parse(file.createdTime || "") < cutoff);
  for (const file of old) await deleteFile(token, file.id);
  return old.length;
}

async function pruneMonthly(token, folderId, months = 12) {
  const files = await listFolderFiles(token, folderId, { limit: 200 });
  const keep = Math.max(1, months);
  const old = files.slice(keep);
  for (const file of old) await deleteFile(token, file.id);
  return old.length;
}

async function getCompanyName(env, tenant, token, sheetId) {
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent("ตั้งค่า!A:B")}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.ok) {
      const data = await response.json();
      const map = Object.fromEntries((data.values || []).filter((r) => r?.[0]).map((r) => [String(r[0]), r[1] || ""]));
      return clean(map.company_name || map["ชื่อบริษัท"] || "", 120);
    }
  } catch {}
  const meta = await env.KV.get(`businessmeta:v1:${tenant}`, "json").catch(() => null);
  return clean(meta?.name || "", 120) || `Workspace ${String(tenant).slice(-6)}`;
}

async function pushHistory(env, tenant, item) {
  const key = historyKey(tenant);
  const current = await env.KV.get(key, "json").catch(() => []);
  const rows = Array.isArray(current) ? current : [];
  rows.unshift(item);
  await env.KV.put(key, JSON.stringify(rows.slice(0, 80)), { expirationTtl: 86400 * 400 });
}

async function writeStatus(env, tenant, patch) {
  const current = await env.KV.get(statusKey(tenant), "json").catch(() => ({}));
  const next = {
    ...(current && typeof current === "object" ? current : {}),
    ...patch,
    version: BACKUP_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await env.KV.put(statusKey(tenant), JSON.stringify(next), { expirationTtl: 86400 * 400 });
  return next;
}

async function backupContext(env, tenant) {
  const sheetId = await env.KV.get(`tenant:${tenant}`);
  if (!sheetId) throw new Error("ยังไม่มี Google Sheet ของ Workspace นี้");
  const token = await getUserToken(env, tenant);
  if (!token) throw new Error("Google token ไม่พร้อม กรุณาเชื่อม Google ที่บัญชีหลักใหม่");
  const companyName = await getCompanyName(env, tenant, token, sheetId);
  const folders = await ensureBackupFolders(env, tenant, token, sheetId, companyName);
  return { sheetId, token, companyName, folders };
}

export async function createWorkspaceBackup(env, tenant, {
  kind = "daily",
  actor = "system",
  force = false,
} = {}) {
  tenant = String(tenant || "").trim();
  if (!tenant) return { ok: false, error: "missing_tenant" };

  const time = new Date();
  const th = bangkokParts(time);
  const status = await env.KV.get(statusKey(tenant), "json").catch(() => ({}));

  if (kind === "daily" && !force && status?.lastDailyDate === th.dateKey) {
    return { ok: true, skipped: true, reason: "already_backed_up_today", status };
  }

  const startedAt = new Date().toISOString();
  await writeStatus(env, tenant, {
    state: "running",
    runningKind: kind,
    runningStartedAt: startedAt,
    lastError: "",
  });

  try {
    const { sheetId, token, companyName, folders } = await backupContext(env, tenant);
    const source = await sheetMeta(token, sheetId);
    let targetFolder = folders.daily;
    if (kind === "monthly") targetFolder = folders.monthly;
    if (kind === "manual") targetFolder = folders.manual;

    const stamp = kind === "monthly" ? th.monthKey : `${th.dateKey} ${String(th.hour).padStart(2,"0")}:${String(th.minute).padStart(2,"0")}`;
    const copy = await copySheet(
      token,
      sheetId,
      targetFolder.id,
      snapshotName(companyName, kind, stamp),
      {
        accountingBackup: "1",
        accountingBackupVersion: "v7.24",
        accountingBackupType: kind,
        accountingBackupTenant: tenant,
        accountingSourceSheet: sheetId,
      }
    );

    let pruned = 0;
    if (kind === "daily") pruned = await pruneDaily(token, folders.daily.id, Number(env.BACKUP_DAILY_RETENTION_DAYS || 30));
    if (kind === "monthly") pruned = await pruneMonthly(token, folders.monthly.id, Number(env.BACKUP_MONTHLY_RETENTION_MONTHS || 12));

    const item = {
      ok: true,
      tenant,
      kind,
      actor,
      createdAt: copy.createdTime || new Date().toISOString(),
      backupFileId: copy.id,
      backupName: copy.name,
      backupUrl: copy.webViewLink || `https://docs.google.com/spreadsheets/d/${copy.id}/edit`,
      folderUrl: folders.backupUrl,
      sourceSheetId: sheetId,
      sourceModifiedTime: source.modifiedTime || "",
      pruned,
    };

    const patch = {
      state: "ok",
      lastSuccessAt: item.createdAt,
      lastBackupFileId: copy.id,
      lastBackupUrl: item.backupUrl,
      backupFolderUrl: folders.backupUrl,
      lastError: "",
    };
    if (kind === "daily") {
      patch.lastDailyDate = th.dateKey;
      patch.lastDailyAt = item.createdAt;
      patch.lastDailyFileId = copy.id;
    }
    if (kind === "monthly") {
      patch.lastMonthlyKey = th.monthKey;
      patch.lastMonthlyAt = item.createdAt;
      patch.lastMonthlyFileId = copy.id;
    }
    if (kind === "manual") {
      patch.lastManualAt = item.createdAt;
      patch.lastManualFileId = copy.id;
    }

    await writeStatus(env, tenant, patch);
    await pushHistory(env, tenant, item);
    return item;
  } catch (error) {
    const item = {
      ok: false,
      tenant,
      kind,
      actor,
      createdAt: new Date().toISOString(),
      error: clean(error?.message || error, 500),
    };
    await writeStatus(env, tenant, {
      state: "error",
      lastAttemptAt: item.createdAt,
      lastError: item.error,
    });
    await pushHistory(env, tenant, item);
    return item;
  }
}

async function ensureMonthlyIfNeeded(env, tenant) {
  const th = bangkokParts();
  const status = await env.KV.get(statusKey(tenant), "json").catch(() => ({}));
  if (status?.lastMonthlyKey === th.monthKey) return { ok: true, skipped: true };
  return createWorkspaceBackup(env, tenant, { kind: "monthly", actor: "auto-monthly" });
}

async function buildDailyQueue(env, dateKey) {
  const items = [];
  let cursor;
  do {
    const listed = await env.KV.list({
      prefix: "tenant:",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const entry of listed.keys || []) {
      const tenant = String(entry.name || "").slice("tenant:".length);
      if (tenant && !tenant.includes(":")) items.push({ tenant, attempts: 0 });
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor && items.length < 10000);

  const unique = [...new Map(items.map((item) => [item.tenant, item])).values()];
  const queue = { dateKey, createdAt: new Date().toISOString(), items: unique, processed: 0, failed: 0 };
  await env.KV.put(queueKey(dateKey), JSON.stringify(queue), { expirationTtl: 86400 * 3 });
  return queue;
}

export async function runScheduledWorkspaceBackups(env) {
  const th = bangkokParts();
  const backupHour = Number(env.BACKUP_DAILY_HOUR ?? 2);
  if (th.hour !== backupHour) return { ok: true, skipped: true, reason: "outside_backup_window" };

  const key = queueKey(th.dateKey);
  let queue = await env.KV.get(key, "json").catch(() => null);
  if (!queue || queue.dateKey !== th.dateKey || !Array.isArray(queue.items)) {
    queue = await buildDailyQueue(env, th.dateKey);
  }

  if (!queue.items.length) {
    return { ok: true, complete: true, processed: queue.processed || 0, failed: queue.failed || 0 };
  }

  const batchSize = Math.max(1, Math.min(20, Number(env.BACKUP_CRON_BATCH || 5)));
  const batch = queue.items.splice(0, batchSize);

  for (const job of batch) {
    const daily = await createWorkspaceBackup(env, job.tenant, { kind: "daily", actor: "auto-daily" });

    if (!daily.ok && Number(job.attempts || 0) < 2) {
      queue.items.push({ tenant: job.tenant, attempts: Number(job.attempts || 0) + 1 });
    } else {
      queue.processed = Number(queue.processed || 0) + 1;
      if (!daily.ok) queue.failed = Number(queue.failed || 0) + 1;
      if (daily.ok) await ensureMonthlyIfNeeded(env, job.tenant);
    }
  }

  queue.updatedAt = new Date().toISOString();
  await env.KV.put(key, JSON.stringify(queue), { expirationTtl: 86400 * 3 });

  return {
    ok: true,
    dateKey: th.dateKey,
    processedThisRun: batch.length,
    remaining: queue.items.length,
    processed: queue.processed || 0,
    failed: queue.failed || 0,
  };
}

export async function getWorkspaceBackupDashboard(env, tenant) {
  const status = await env.KV.get(statusKey(tenant), "json").catch(() => ({}));
  const history = await env.KV.get(historyKey(tenant), "json").catch(() => []);
  let driveRows = [];
  let backupFolderUrl = status?.backupFolderUrl || "";

  try {
    const { token, folders } = await backupContext(env, tenant);
    backupFolderUrl = folders.backupUrl;
    const [daily, monthly, manual] = await Promise.all([
      listFolderFiles(token, folders.daily.id, { limit: 35 }),
      listFolderFiles(token, folders.monthly.id, { limit: 15 }),
      listFolderFiles(token, folders.manual.id, { limit: 30 }),
    ]);

    driveRows = [
      ...daily.map((x) => ({ ...x, kind: "daily" })),
      ...monthly.map((x) => ({ ...x, kind: "monthly" })),
      ...manual.map((x) => ({ ...x, kind: "manual" })),
    ].sort((a, b) => String(b.createdTime || "").localeCompare(String(a.createdTime || "")));
  } catch (error) {
    if (!status?.lastError) status.lastError = clean(error?.message || error, 300);
  }

  return {
    ok: true,
    version: BACKUP_VERSION,
    autoEnabled: true,
    schedule: `ทุกวันประมาณ ${String(Number(env.BACKUP_DAILY_HOUR ?? 2)).padStart(2,"0")}:00 น.`,
    dailyRetentionDays: Number(env.BACKUP_DAILY_RETENTION_DAYS || 30),
    monthlyRetentionMonths: Number(env.BACKUP_MONTHLY_RETENTION_MONTHS || 12),
    status: status || {},
    backupFolderUrl,
    rows: driveRows.slice(0, 50),
    history: Array.isArray(history) ? history.slice(0, 20) : [],
    restoreMode: "copy_only",
  };
}

export async function restoreWorkspaceBackupAsCopy(env, tenant, backupFileId) {
  backupFileId = String(backupFileId || "").trim();
  if (!backupFileId) return { ok: false, error: "missing_backup_file" };

  try {
    const { token, companyName, folders } = await backupContext(env, tenant);
    const source = await driveJson(
      token,
      `${DRIVE}/files/${encodeURIComponent(backupFileId)}?fields=id,name,createdTime,mimeType,appProperties&supportsAllDrives=true`
    );

    if (source.mimeType !== "application/vnd.google-apps.spreadsheet") {
      return { ok: false, error: "backup_not_spreadsheet" };
    }
    const sourceTenant = String(source.appProperties?.accountingBackupTenant || "");
    if (sourceTenant && sourceTenant !== String(tenant)) {
      return { ok: false, error: "backup_tenant_mismatch" };
    }

    const th = bangkokParts();
    const restored = await copySheet(
      token,
      backupFileId,
      folders.restore.id,
      `${clean(companyName,100)} · Restore · ${th.dateKey} ${String(th.hour).padStart(2,"0")}:${String(th.minute).padStart(2,"0")}`,
      {
        accountingRestoreCopy: "1",
        accountingRestoreTenant: tenant,
        accountingRestoreSource: backupFileId,
      }
    );

    const item = {
      ok: true,
      tenant,
      kind: "restore-copy",
      actor: "owner",
      createdAt: restored.createdTime || new Date().toISOString(),
      backupFileId,
      restoreFileId: restored.id,
      restoreName: restored.name,
      restoreUrl: restored.webViewLink || `https://docs.google.com/spreadsheets/d/${restored.id}/edit`,
    };
    await pushHistory(env, tenant, item);
    return item;
  } catch (error) {
    return { ok: false, error: clean(error?.message || error, 500) };
  }
}

export { BACKUP_VERSION };
