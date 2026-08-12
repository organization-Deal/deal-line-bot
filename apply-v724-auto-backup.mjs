import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "src/entry-mobile-ux.js");
if (!fs.existsSync(file)) throw new Error("ไม่พบ src/entry-mobile-ux.js — ให้รันที่ root ของ deal-line-bot");

let s = fs.readFileSync(file, "utf8");
const MARKER = "AUTO_BACKUP_ENTRY_V7_24_20260811";

if (s.includes(MARKER)) {
  console.log("✅ v7.24 Auto Backup entry already applied");
  process.exit(0);
}

function mustReplace(from, to, label) {
  if (!s.includes(from)) throw new Error(`หา anchor ไม่เจอ: ${label}`);
  s = s.replace(from, to);
}

mustReplace(
  'import { enhanceMobileWebResponse } from "./mobile-web-ux.js";',
  `import { enhanceMobileWebResponse } from "./mobile-web-ux.js";
import {
  createWorkspaceBackup,
  getWorkspaceBackupDashboard,
  restoreWorkspaceBackupAsCopy,
  runScheduledWorkspaceBackups,
} from "./auto-backup.js"; // ${MARKER}`,
  "backup import"
);

mustReplace(
  'async function wrappedFetch(request, env, ctx) {\n  const url = new URL(request.url);',
  `function backupCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "*");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

function backupJson(data, status = 200) {
  return backupCors(new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  }));
}

function safeEqualBackup(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function backupAccess(env, tenant, token) {
  const owner = await env.KV.get(\`dtoken:\${tenant}\`);
  if (owner && safeEqualBackup(owner, token)) return { ok:true, role:"owner" };
  if (!token) return { ok:false, role:"" };
  const rec = await env.KV.get(\`daccess:\${tenant}:\${token}\`, "json").catch(() => null);
  if (!rec || rec.active === false) return { ok:false, role:"" };
  return { ok:true, role:String(rec.role || "viewer") };
}

async function wrappedFetch(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS" && url.pathname.startsWith("/api/backup")) {
    return backupJson({ ok:true });
  }

  if (url.pathname.startsWith("/api/backup")) {
    const tenant = String(url.searchParams.get("tenant") || "").trim();
    const key = String(url.searchParams.get("k") || "").trim();
    const access = await backupAccess(env, tenant, key);

    if (!tenant || !access.ok) {
      return backupJson({ ok:false, error:"unauthorized" }, 401);
    }

    if (url.pathname === "/api/backup-status" && request.method === "GET") {
      return backupJson(await getWorkspaceBackupDashboard(env, tenant));
    }

    if (url.pathname === "/api/backup-now" && request.method === "POST") {
      if (access.role !== "owner") return backupJson({ ok:false, error:"owner_required" }, 403);
      return backupJson(await createWorkspaceBackup(env, tenant, {
        kind:"manual",
        actor:"dashboard-owner",
        force:true,
      }));
    }

    if (url.pathname === "/api/backup-restore-copy" && request.method === "POST") {
      if (access.role !== "owner") return backupJson({ ok:false, error:"owner_required" }, 403);
      const body = await request.json().catch(() => ({}));
      const out = await restoreWorkspaceBackupAsCopy(env, tenant, body.backupFileId || body.fileId || "");
      return backupJson(out, out.ok ? 200 : 400);
    }

    return backupJson({ ok:false, error:"backup_route_not_found" }, 404);
  }`,
  "wrappedFetch start"
);

mustReplace(
  `export default {
  ...worker,
  fetch: wrappedFetch,
};`,
  `async function wrappedScheduled(controller, env, ctx) {
  if (typeof worker.scheduled === "function") {
    await worker.scheduled(controller, env, ctx);
  }
  ctx.waitUntil(
    runScheduledWorkspaceBackups(env).catch((error) => {
      console.warn("[auto-backup]", error?.message || error);
    })
  );
}

export default {
  ...worker,
  fetch: wrappedFetch,
  scheduled: wrappedScheduled,
};`,
  "default export"
);

fs.writeFileSync(file, s);
console.log("✅ v7.24 Auto Backup entry applied");
console.log("Routes: /api/backup-status /api/backup-now /api/backup-restore-copy");
console.log("Cron: Daily + Monthly Google Drive snapshot");
