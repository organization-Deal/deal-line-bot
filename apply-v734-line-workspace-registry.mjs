import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const indexFile = path.join(root, 'src/index.js');
const approverFile = path.join(root, 'src/approver-line.js');
const MARKER = 'LINE_WORKSPACE_REGISTRY_V7_34_20260813';

for (const file of [indexFile, approverFile]) {
  if (!fs.existsSync(file)) throw new Error(`ไม่พบ ${file} — ให้รันที่ root ของ deal-line-bot`);
}

function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`หา anchor ไม่เจอ: ${label}`);
  return text.replace(from, to);
}

function patchApprover() {
  let s = fs.readFileSync(approverFile, 'utf8');
  if (s.includes(MARKER)) return false;

  const constAnchor = 'const NOTIFY_PREFIX = "approvernotify:v1:";';
  const registryCode = `${constAnchor}\nconst LINE_WORKSPACE_REGISTRY_MARKER = "${MARKER}";\nconst LINE_WORKSPACE_PREFIX = "lineworkspace:v1:";\nconst LINE_WORKSPACE_OWNER_PREFIX = "lineworkspaceowner:v1:";`;
  s = replaceOnce(s, constAnchor, registryCode, 'approver registry constants');

  const fnAnchor = `function accessPrefix(tenant) {\n  return \`daccess:\${tenant}:\`;\n}\n`;
  const registryFns = String.raw`

function lineWorkspaceType(tenant = "") {
  const id = clean(tenant, 120);
  if (/^C/i.test(id)) return "group";
  if (/^R/i.test(id)) return "room";
  if (/^U/i.test(id)) return "direct";
  return "workspace";
}

function lineWorkspaceKey(rootTenant, tenant) {
  return \`\${LINE_WORKSPACE_PREFIX}\${clean(rootTenant, 120)}:\${clean(tenant, 120)}\`;
}

function lineWorkspaceOwnerKey(tenant) {
  return \`\${LINE_WORKSPACE_OWNER_PREFIX}\${clean(tenant, 120)}\`;
}

async function lineAccountRoot(env, tenant) {
  tenant = clean(tenant, 120);
  if (!tenant) return "";
  return clean((await env.KV.get(\`accountroot:v1:\${tenant}\`)) || tenant, 120);
}

async function lineWorkspaceBusinessName(env, tenant, sheetId = "") {
  try {
    sheetId = clean(sheetId || (await env.KV.get(\`tenant:\${tenant}\`)) || "", 180);
    if (!sheetId) return "";
    const token = await getUserToken(env, tenant).catch(() => null);
    const settings = await readSettings(env, sheetId, token).catch(() => ({}));
    return clean(
      settings.company_name || settings.companyName || settings.business_name || settings.businessName || "",
      120
    );
  } catch { return ""; }
}

async function saveLineWorkspace(env, tenant, {
  rootTenant = "",
  groupName = "",
  source = "webhook",
  refresh = false,
} = {}) {
  tenant = clean(tenant, 120);
  const sourceType = lineWorkspaceType(tenant);
  if (!tenant || !["group", "room"].includes(sourceType)) return null;

  const resolvedRoot = clean(rootTenant || await lineAccountRoot(env, tenant), 120) || tenant;
  const ownerKey = lineWorkspaceOwnerKey(tenant);
  const previousRoot = clean(await env.KV.get(ownerKey), 120);
  const currentKey = lineWorkspaceKey(resolvedRoot, tenant);
  const existing = await env.KV.get(currentKey, "json").catch(() => null);
  const now = new Date().toISOString();

  let resolvedName = clean(groupName || existing?.groupName || "", 120);
  let connected = existing?.connected !== false;
  let error = "";
  if (refresh || !resolvedName) {
    try {
      const name = await workspaceName(env, tenant);
      if (name) resolvedName = name;
      connected = true;
    } catch (e) {
      error = clean(e?.message || e, 160);
    }
  }
  if (!resolvedName) {
    resolvedName = sourceType === "group"
      ? \`LINE Group ···\${tenant.slice(-6)}\`
      : \`LINE Room ···\${tenant.slice(-6)}\`;
  }

  const sheetId = clean((await env.KV.get(\`tenant:\${tenant}\`)) || existing?.sheetId || "", 180);
  const businessName = await lineWorkspaceBusinessName(env, tenant, sheetId)
    || clean(existing?.businessName || "", 120);

  const next = {
    schema: "LINE_WORKSPACE_REGISTRY_V1",
    version: LINE_WORKSPACE_REGISTRY_MARKER,
    rootTenant: resolvedRoot,
    tenant,
    groupId: sourceType === "group" ? tenant : "",
    sourceType,
    groupName: resolvedName,
    businessName,
    sheetId,
    connected,
    error,
    source: clean(source, 80),
    firstSeenAt: existing?.firstSeenAt || now,
    lastSeenAt: now,
    updatedAt: now,
  };

  if (previousRoot && previousRoot !== resolvedRoot) {
    await env.KV.delete(lineWorkspaceKey(previousRoot, tenant)).catch(() => {});
  }
  await Promise.all([
    env.KV.put(ownerKey, resolvedRoot),
    env.KV.put(currentKey, JSON.stringify(next)),
  ]);
  return next;
}

async function rememberLineWorkspace(env, event) {
  const source = event?.source || {};
  const tenant = clean(source.groupId || source.roomId || "", 120);
  if (!tenant) return null;
  return saveLineWorkspace(env, tenant, {
    source: \`webhook:\${event?.type || "event"}\`,
    refresh: event?.type === "join",
  });
}

async function registeredLineWorkspaces(env, rootTenant) {
  const rows = [];
  let cursor;
  do {
    const page = await env.KV.list({
      prefix: \`\${LINE_WORKSPACE_PREFIX}\${rootTenant}:\`,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    const records = await Promise.all((page.keys || []).map((entry) =>
      env.KV.get(entry.name, "json").catch(() => null)
    ));
    for (const rec of records) if (rec?.tenant) rows.push(rec);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && rows.length < 5000);
  return rows;
}

async function lineWorkspaceCandidatesFromAccess(env, tenants = []) {
  const out = new Set();
  for (const tenant of [...new Set(tenants.map((x) => clean(x, 120)).filter(Boolean))]) {
    let cursor;
    do {
      const page = await env.KV.list({
        prefix: \`daccess:\${tenant}:\`,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of page.keys || []) {
        const rec = await env.KV.get(entry.name, "json").catch(() => null);
        const groupTenant = clean(rec?.lineGroupTenant || "", 120);
        if (/^[CR]/i.test(groupTenant)) out.add(groupTenant);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  return out;
}

async function lineWorkspaceCandidatesFromTenantMap(env, rootTenant, maxPages = 5) {
  const out = new Set();
  let cursor;
  let pages = 0;
  do {
    const page = await env.KV.list({
      prefix: "tenant:",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    const ids = (page.keys || [])
      .map((entry) => String(entry.name || "").slice("tenant:".length))
      .filter((tenant) => /^[CR]/i.test(tenant));
    const roots = await Promise.all(ids.map(async (tenant) => ({
      tenant,
      root: await lineAccountRoot(env, tenant),
    })));
    for (const row of roots) if (row.root === rootTenant) out.add(row.tenant);
    cursor = page.list_complete ? undefined : page.cursor;
    pages += 1;
  } while (cursor && pages < maxPages);
  return out;
}

export async function listLineWorkspacesForAccount(env, currentTenant, { refresh = false } = {}) {
  currentTenant = clean(currentTenant, 120);
  const rootTenant = await lineAccountRoot(env, currentTenant);
  const candidates = new Set();

  if (/^[CR]/i.test(currentTenant)) candidates.add(currentTenant);

  const account = await env.KV.get(\`businessaccount:v1:\${rootTenant}\`, "json").catch(() => null);
  const businesses = [...new Set([
    rootTenant,
    ...(Array.isArray(account?.businesses) ? account.businesses : []),
  ].map((x) => clean(x, 120)).filter(Boolean))];
  for (const tenant of businesses) if (/^[CR]/i.test(tenant)) candidates.add(tenant);

  for (const rec of await registeredLineWorkspaces(env, rootTenant)) {
    if (/^[CR]/i.test(rec.tenant || "")) candidates.add(clean(rec.tenant, 120));
  }

  const accessCandidates = await lineWorkspaceCandidatesFromAccess(env, businesses);
  for (const tenant of accessCandidates) candidates.add(tenant);

  // refresh=1 ใช้เป็น recovery path สำหรับกลุ่มที่เชื่อมไว้ก่อนมี Registry
  // scan เฉพาะ tenant ที่ accountroot ปัจจุบันชี้กลับมาบัญชีนี้ จึงไม่ดึงกลุ่มลูกค้ารายอื่นปน
  if (refresh) {
    for (const tenant of await lineWorkspaceCandidatesFromTenantMap(env, rootTenant)) candidates.add(tenant);
  }

  const rows = [];
  for (const tenant of candidates) {
    const mappedRoot = await lineAccountRoot(env, tenant);
    const trustedByAccess = accessCandidates.has(tenant);
    if (mappedRoot !== rootTenant && !trustedByAccess) continue;
    const rec = await saveLineWorkspace(env, tenant, {
      rootTenant,
      source: refresh ? "dashboard:refresh" : "dashboard:list",
      refresh,
    });
    if (!rec) continue;
    rows.push({
      tenant: rec.tenant,
      businessName: rec.businessName || "",
      isRoot: rec.tenant === rootTenant,
      isCurrent: rec.tenant === currentTenant,
      sheetId: rec.sheetId || "",
      sourceType: rec.sourceType,
      groupId: rec.groupId || "",
      groupName: rec.groupName || "",
      connected: rec.connected !== false,
      error: rec.error || "",
      lastSeenAt: rec.lastSeenAt || "",
      registryVersion: LINE_WORKSPACE_REGISTRY_MARKER,
    });
  }

  rows.sort((a, b) =>
    Number(b.isCurrent) - Number(a.isCurrent)
    || String(a.groupName || a.tenant).localeCompare(String(b.groupName || b.tenant), "th")
  );

  return {
    ok: true,
    rootTenant,
    currentTenant,
    rows,
    groupCount: rows.filter((row) => row.sourceType === "group").length,
    refreshedAt: new Date().toISOString(),
    registryVersion: LINE_WORKSPACE_REGISTRY_MARKER,
  };
}
`;
  s = replaceOnce(s, fnAnchor, fnAnchor + registryFns, 'approver registry functions');

  const rememberAnchor = `export async function rememberLineEventMembers(env, event) {\n  const source = event?.source || {};\n  const tenant = sourceTenant(source);\n  if (!tenant) return { ok: false, reason: "no_tenant" };\n\n  const jobs = [];`;
  const rememberReplacement = `export async function rememberLineEventMembers(env, event) {\n  const source = event?.source || {};\n  const tenant = sourceTenant(source);\n  if (!tenant) return { ok: false, reason: "no_tenant" };\n\n  const workspaceRecord = await rememberLineWorkspace(env, event).catch((e) => {\n    console.warn("remember LINE workspace", tenant, e?.message || e);\n    return null;\n  });\n\n  const jobs = [];`;
  s = replaceOnce(s, rememberAnchor, rememberReplacement, 'remember workspace on webhook');

  s = s.replace(
    'if (!jobs.length) return { ok: true, remembered: 0 };',
    'if (!jobs.length) return { ok: true, remembered: 0, workspaceRegistered: !!workspaceRecord };'
  );
  s = s.replace(
    'remembered: settled.filter((x) => x.status === "fulfilled" && x.value).length,\n  };',
    'remembered: settled.filter((x) => x.status === "fulfilled" && x.value).length,\n    workspaceRegistered: !!workspaceRecord,\n  };'
  );

  s = s.replace(/const VERSION = "LINE_[^"]+";/, 'const VERSION = "LINE_WORKSPACE_NOTIFY_V7_34_REGISTRY_20260813";');
  fs.writeFileSync(approverFile, s);
  return true;
}

function patchIndex() {
  let s = fs.readFileSync(indexFile, 'utf8');
  if (s.includes(MARKER)) return false;

  const importAnchor = `  rememberLineEventMembers,\n  listLineWorkspaceMembers,`;
  const importReplacement = `  rememberLineEventMembers,\n  listLineWorkspaceMembers,\n  listLineWorkspacesForAccount,`;
  s = replaceOnce(s, importAnchor, importReplacement, 'index registry import');

  const start = s.indexOf('async function getLineGroupsOverview(env, currentTenant, { refresh = false } = {}) {');
  const endAnchor = '\nasync function saveBusinessMeta(env, tenant, patch = {}) {';
  const end = s.indexOf(endAnchor, start);
  if (start < 0 || end < 0) throw new Error('หา function getLineGroupsOverview ไม่เจอ');
  const replacement = `async function getLineGroupsOverview(env, currentTenant, { refresh = false } = {}) {\n  // ${MARKER}: LINE groups แยกจาก business list แล้ว\n  // กลุ่มที่ Bot เห็นจาก webhook จะถูกเก็บใน LINE Workspace Registry อัตโนมัติ\n  return listLineWorkspacesForAccount(env, currentTenant, { refresh });\n}\n`;
  s = s.slice(0, start) + replacement + s.slice(end);

  s = s.replace(/const VERSION = "DEAL_LINE_BOT_[^"]+";/, 'const VERSION = "DEAL_LINE_BOT_v7.34_LINE_WORKSPACE_REGISTRY_20260813";');
  fs.writeFileSync(indexFile, s);
  return true;
}

const changedApprover = patchApprover();
const changedIndex = patchIndex();

for (const file of [approverFile, indexFile]) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log(`✅ ${MARKER} ready; index=${changedIndex ? 'patched' : 'already'} approver=${changedApprover ? 'patched' : 'already'}`);
