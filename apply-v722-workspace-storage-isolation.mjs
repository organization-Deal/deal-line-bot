import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const driveFile = path.join(root, "src/drive-folders.js");
const indexFile = path.join(root, "src/index.js");

if (!fs.existsSync(driveFile)) throw new Error("ไม่พบ src/drive-folders.js — ให้รันที่ root ของ deal-line-bot");
if (!fs.existsSync(indexFile)) throw new Error("ไม่พบ src/index.js — ให้รันที่ root ของ deal-line-bot");

const MARKER = "WORKSPACE_STORAGE_ISOLATION_V7_22_20260811";

function mustReplace(text, from, to, label) {
  if (!text.includes(from)) {
    throw new Error(`หา anchor ไม่เจอ: ${label}\nหยุดก่อนเพื่อไม่แก้ source ผิดเวอร์ชัน`);
  }
  return text.replace(from, to);
}

let d = fs.readFileSync(driveFile, "utf8");

if (!d.includes(MARKER)) {
  d = mustReplace(
    d,
    'const APP_ROOT_NAME = "รับจ่ายแบบไม่จำกัด";',
    `const APP_ROOT_NAME = "รับจ่ายแบบไม่จำกัด";
const TENANT_APP_PROPERTY = "accountingWorkspaceTenant"; // ${MARKER}`,
    "tenant app property"
  );

  d = mustReplace(
    d,
    `async function createFolder(token, name, parentId = "") {
  const body = { name: cleanName(name), mimeType: FOLDER_MIME };
  if (parentId) body.parents = [parentId];
  return driveJson(token, \`${"${DRIVE}"}/files?fields=id,name,parents,webViewLink&supportsAllDrives=true\`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}`,
    `async function createFolder(token, name, parentId = "", appProperties = null) {
  const body = { name: cleanName(name), mimeType: FOLDER_MIME };
  if (parentId) body.parents = [parentId];
  if (appProperties && typeof appProperties === "object") body.appProperties = appProperties;
  return driveJson(token, \`${"${DRIVE}"}/files?fields=id,name,parents,webViewLink,appProperties&supportsAllDrives=true\`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}`,
    "createFolder appProperties"
  );

  d = mustReplace(
    d,
    `async function findOrCreateFolder(token, name, parentId = "") {
  return (await findFolder(token, name, parentId)) || createFolder(token, name, parentId);
}`,
    `async function findOrCreateFolder(token, name, parentId = "") {
  return (await findFolder(token, name, parentId)) || createFolder(token, name, parentId);
}

async function findTenantCompanyFolder(token, tenant, parentId) {
  const clauses = [
    \`mimeType = '\${FOLDER_MIME}'\`,
    \`'\${q(parentId)}' in parents\`,
    \`appProperties has { key='\${TENANT_APP_PROPERTY}' and value='\${q(tenant)}' }\`,
    "trashed = false",
  ];
  const params = new URLSearchParams({
    q: clauses.join(" and "),
    pageSize: "10",
    orderBy: "createdTime",
    fields: "files(id,name,parents,webViewLink,appProperties)",
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const data = await driveJson(token, \`${"${DRIVE}"}/files?\${params}\`);
  return data.files?.[0] || null;
}

async function claimTenantCompanyFolder(token, folderId, tenant) {
  if (!folderId || !tenant) return;
  await driveJson(
    token,
    \`${"${DRIVE}"}/files/\${encodeURIComponent(folderId)}?fields=id,name,appProperties&supportsAllDrives=true\`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appProperties: { [TENANT_APP_PROPERTY]: String(tenant) } }),
    }
  );
}`,
    "tenant folder lookup helpers"
  );

  d = mustReplace(
    d,
    `  const complete = stored
    && stored.mode === mode
    && stored.companyFolderId
    && (stored.claimsBaseFolderId || stored.claimsFolderId)
    && (stored.replacementsBaseFolderId || stored.replacementsFolderId)
    && (stored.originalsBaseFolderId || stored.originalsFolderId)
    && (stored.paymentsBaseFolderId || stored.paymentsFolderId)
    && (stored.emailBaseFolderId || stored.emailFolderId);

  if (complete) {`,
    `  let complete = stored
    && stored.mode === mode
    && stored.companyFolderId
    && (stored.claimsBaseFolderId || stored.claimsFolderId)
    && (stored.replacementsBaseFolderId || stored.replacementsFolderId)
    && (stored.originalsBaseFolderId || stored.originalsFolderId)
    && (stored.paymentsBaseFolderId || stored.paymentsFolderId)
    && (stored.emailBaseFolderId || stored.emailFolderId);

  // v7.22: companyFolderId must belong to exactly one tenant.
  // Older versions found company folders by display name only, so two workspaces
  // with the same/default company name could accidentally point to one folder.
  if (complete) {
    const meta = await getFile(
      accessToken,
      stored.companyFolderId,
      "id,name,parents,trashed,appProperties"
    );
    const claimedBy = String(meta?.appProperties?.[TENANT_APP_PROPERTY] || "");
    if (claimedBy && claimedBy !== String(tenant)) {
      console.warn(\`[drive-isolation] tenant=\${tenant} sharedFolder=\${stored.companyFolderId} claimedBy=\${claimedBy}; splitting workspace\`);
      complete = false;
    } else if (!claimedBy && meta && !meta.trashed) {
      // First workspace touching a legacy folder claims it.
      // If another tenant pointed to the same folder, its next request sees
      // the mismatch and gets a brand-new isolated folder.
      await claimTenantCompanyFolder(accessToken, stored.companyFolderId, tenant);
    }
  }

  if (complete) {`,
    "validate stored folder tenant ownership"
  );

  d = mustReplace(
    d,
    `  const appRoot = await findOrCreateFolder(accessToken, APP_ROOT_NAME, serviceParentId);
  const company = await findOrCreateFolder(accessToken, desiredCompanyName, appRoot.id);
  const sub = {};`,
    `  const appRoot = await findOrCreateFolder(accessToken, APP_ROOT_NAME, serviceParentId);

  // Never locate a workspace folder by company name alone.
  // Display names may duplicate; tenant appProperty is the unique identity.
  let company = await findTenantCompanyFolder(accessToken, tenant, appRoot.id);
  if (!company) {
    company = await createFolder(
      accessToken,
      desiredCompanyName,
      appRoot.id,
      { [TENANT_APP_PROPERTY]: String(tenant) }
    );
  } else if (company.name !== desiredCompanyName) {
    await renameFolder(accessToken, company.id, desiredCompanyName).catch(() => {});
  }

  const sub = {};`,
    "create isolated tenant company folder"
  );

  d = mustReplace(
    d,
    `    version: 2,
    tenant,`,
    `    version: 3,
    isolation: "tenant-app-property",
    tenant,`,
    "stored folder version"
  );

  fs.writeFileSync(driveFile, d);
}

let i = fs.readFileSync(indexFile, "utf8");
if (!i.includes("driveorganized:${key}:${sheetId}:v3-tenant-isolation")) {
  i = mustReplace(
    i,
    'const organizeKey = `driveorganized:${key}:${sheetId}:v2-monthly`;',
    'const organizeKey = `driveorganized:${key}:${sheetId}:v3-tenant-isolation`;',
    "force one-time file reorganization after isolation"
  );
  fs.writeFileSync(indexFile, i);
}

console.log("✅ v7.22 Workspace Storage Isolation applied");
console.log("Sheet: one sheetId per LINE workspace (existing behavior retained)");
console.log("Drive: one companyFolderId per tenant, enforced by Drive appProperties");
console.log("Migration: referenced files will reorganize once using v3 isolation key");
