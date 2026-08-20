import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root=process.cwd(), indexFile=path.join(root,"src","index.js"), reconFile=path.join(root,"src","reconciliation.js");
for(const f of [indexFile,reconFile])if(!fs.existsSync(f))throw new Error("v7.88 missing "+path.relative(root,f));
let index=fs.readFileSync(indexFile,"utf8"), recon=fs.readFileSync(reconFile,"utf8");

index=index.replace('import { uploadTenantImage, listUploadedImages } from "./drive.js";','import { uploadTenantImage, uploadTenantFile, listUploadedImages } from "./drive.js";');
if(!index.includes("updateReconciliationNote,")){
  index=index.replace('  unlinkReconciliationMatch, ignoreReconciliationRow,\n} from "./reconciliation.js";','  unlinkReconciliationMatch, ignoreReconciliationRow, updateReconciliationNote,\n} from "./reconciliation.js";');
}
if(!recon.includes('key: "sourceFileUrl"')){
  const a='  { col: "T", key: "sourceChannelLabel", header: "ชื่อช่องทางการเงิน" },';
  if(!recon.includes(a))throw new Error("v7.88 schema anchor missing");
  recon=recon.replace(a,a+'\n  { col: "U", key: "sourceFileUrl", header: "ลิงก์ Statement ต้นฉบับ" },');
}
recon=recon.replace(/export const RECONCILIATION_VERSION = "[^"]+";/,'export const RECONCILIATION_VERSION = "BANK_RECONCILIATION_V3_EVIDENCE_20260820";');
if(!recon.includes('const sourceFileUrl = String(payload.sourceFileUrl')){
  const a='  const sourceFile = String(payload.fileName || "statement").trim().slice(0, 180);';
  if(!recon.includes(a))throw new Error("v7.88 source file anchor missing");
  recon=recon.replace(a,a+'\n  const sourceFileUrl = String(payload.sourceFileUrl || "").trim().slice(0, 500);');
}
if(!recon.includes('sourceFileUrl,\n      fingerprint'))recon=recon.replace('      sourceFile,\n      fingerprint,','      sourceFile,\n      sourceFileUrl,\n      fingerprint,');
if(!recon.includes('sourceFileUrl,\n    sourceChannelId'))recon=recon.replace('    sourceFile,\n    sourceChannelId: channel.id,','    sourceFile,\n    sourceFileUrl,\n    sourceChannelId: channel.id,');

if(!recon.includes("export async function updateReconciliationNote")){
  const anchor='export async function ignoreReconciliationRow(env, sheetId, reconciliationId, note = "", token = null) {';
  const at=recon.indexOf(anchor);
  if(at<0)throw new Error("v7.88 ignore function anchor missing");
  const fn=`export async function updateReconciliationNote(env, sheetId, reconciliationId, note = "", token = null) {
  const t = await authToken(env, token);
  const rows = await listReconciliationRows(env, sheetId, t, { createIfMissing: true });
  const row = rows.find((item) => String(item.id || "") === String(reconciliationId || ""));
  if (!row) return { ok: false, reason: "not_found", message: "ไม่พบรายการธนาคาร" };
  const cleanNote = String(note || "").trim().slice(0, 500);
  const now = new Date().toISOString();
  await updateStatementRows(t, sheetId, [{ row, patch: { note: cleanNote, updatedAt: now } }]);
  return { ok: true, reconciliationId: row.id, note: cleanNote, updatedAt: now };
}

`;
  recon=recon.slice(0,at)+fn+recon.slice(at);
}

const oldImport=`        if (url.pathname === "/api/reconciliation-import" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const out = await importReconciliationRows(env, sheetId, body, token);
          return cors(json(out, out.ok ? 200 : 400));
        }`;
const newImport=`        if (url.pathname === "/api/reconciliation-import" && request.method === "POST") {
          const contentType = String(request.headers.get("content-type") || "").toLowerCase();
          let body = {};
          if (contentType.includes("multipart/form-data")) {
            const form = await request.formData();
            const file = form.get("file");
            let rows = [];
            try { rows = JSON.parse(String(form.get("rows") || "[]")); } catch {}
            body = {
              fileName: String(form.get("fileName") || file?.name || "statement"),
              sourceChannelId: String(form.get("sourceChannelId") || ""),
              rows: Array.isArray(rows) ? rows : [],
            };
            if (!file || typeof file.arrayBuffer !== "function") return cors(json({ ok:false, reason:"statement_file_required", message:"กรุณาเลือกไฟล์ Statement ต้นฉบับ" },400));
            if (Number(file.size || 0) > 15 * 1024 * 1024) return cors(json({ ok:false, reason:"statement_file_too_large", message:"Statement ต้องไม่เกิน 15 MB" },400));
            const allowed = new Set(["text/csv","application/csv","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/octet-stream"]);
            const mediaType = String(file.type || "application/octet-stream").toLowerCase();
            const ext = String(file.name || "").split(".").pop().toLowerCase();
            if ((file.type && !allowed.has(mediaType)) || !["csv","xlsx","xls"].includes(ext)) return cors(json({ ok:false, reason:"statement_file_type", message:"รองรับ Statement CSV, XLSX และ XLS เท่านั้น" },400));
            const settings = await readSettings(env, sheetId, token);
            const bytes = new Uint8Array(await file.arrayBuffer());
            const safeBase = String(file.name || "statement").replace(/[\\\\/:*?"<>|]+/g,"-").replace(/\\s+/g," ").trim().slice(0,120) || "statement";
            const rawUrl = await uploadTenantFile(env,key,bytes,mediaType || "application/octet-stream",\`STATEMENT-\${Date.now()}-\${safeBase}\`,token,{
              category:"originals",publicRead:false,companyName:settings.company_name || "พื้นที่บริษัท",transactionDate:new Date().toISOString(),
            });
            if (!rawUrl) return cors(json({ ok:false, reason:"statement_drive_upload_failed", message:"เก็บ Statement ต้นฉบับใน Google Drive ไม่สำเร็จ จึงยังไม่นำเข้ากระทบยอด" },500));
            body.sourceFileUrl = rawUrl;
          } else {
            body = await request.json().catch(() => ({}));
          }
          const out = await importReconciliationRows(env, sheetId, body, token);
          if(out.ok)await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"RECONCILE_IMPORT",entityType:"reconciliation",entityId:body.fileName||"statement",summary:\`นำเข้า Statement \${out.imported||0} รายการ\`,after:{sourceFile:out.sourceFile,sourceFileUrl:out.sourceFileUrl||"",sourceChannelId:out.sourceChannelId,imported:out.imported}});
          return cors(json(out, out.ok ? 200 : 400));
        }`;
if(index.includes(oldImport))index=index.replace(oldImport,newImport);
else if(!index.includes("statement_drive_upload_failed"))throw new Error("v7.88 reconciliation import route anchor missing");

const confirmAnchor='          const body = await request.json().catch(() => ({}));\n          const out = await confirmReconciliationMatches(env, sheetId, body, token);';
if(index.includes(confirmAnchor))index=index.replace(confirmAnchor,'          const body = await request.json().catch(() => ({}));\n          body.matchedBy = String(access.name || body.matchedBy || "Dashboard");\n          const out = await confirmReconciliationMatches(env, sheetId, body, token);');

if(!index.includes('url.pathname === "/api/reconciliation-note"')){
  const anchor='        if (url.pathname === "/api/reconciliation-ignore" && request.method === "POST") {';
  const at=index.indexOf(anchor);
  if(at<0)throw new Error("v7.88 note route anchor missing");
  const route=`        if (url.pathname === "/api/reconciliation-note" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const out = await updateReconciliationNote(env, sheetId, body.reconciliationId || body.id, body.note || "", token);
          if(out.ok)await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"RECONCILE_NOTE",entityType:"reconciliation",entityId:body.reconciliationId||body.id,summary:"บันทึกเหตุผล/หมายเหตุการกระทบยอด",after:{note:out.note}});
          return cors(json(out, out.ok ? 200 : 400));
        }

`;
  index=index.slice(0,at)+route+index.slice(at);
}

fs.writeFileSync(indexFile,index,"utf8");fs.writeFileSync(reconFile,recon,"utf8");
execFileSync(process.execPath,["--check",indexFile],{stdio:"pipe"});execFileSync(process.execPath,["--check",reconFile],{stdio:"pipe"});
const checks=[
 index.includes("statement_drive_upload_failed"),index.includes("/api/reconciliation-note"),index.includes("body.matchedBy = String(access.name"),
 recon.includes('key: "sourceFileUrl"'),recon.includes("export async function updateReconciliationNote")
];
if(checks.some(v=>!v))throw new Error("v7.88 audit failed");
console.log("✅ V7.88 reconciliation evidence backend");
console.log("✅ raw Statement -> private Google Drive");
console.log("✅ actual user/time + note audit");
