import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const file = path.join(root, "src/index.js");
const MARKER = "RESTORE_LEGACY_LINE_GROUPS_V7_37_20260814";

if (!fs.existsSync(file)) throw new Error("ไม่พบ src/index.js — ให้รันที่ root ของ deal-line-bot");

let s = fs.readFileSync(file, "utf8");

if (!s.includes(MARKER)) {
  const oldBlock = `    let mappedBusiness = String((await env.KV.get(lineWorkspaceBusinessKey(groupTenant))) || "").trim();
    if (!mappedBusiness && account.businesses.includes(groupTenant)) mappedBusiness = groupTenant;
    if (!mappedBusiness && businessSheetId && String(row.sheetId || "").trim() === businessSheetId) {
      mappedBusiness = businessTenant;
      await env.KV.put(lineWorkspaceBusinessKey(groupTenant), businessTenant).catch(() => {});
    }
    if (mappedBusiness !== businessTenant) continue;`;

  const newBlock = `    // ${MARKER}
    // กลุ่ม LINE รุ่นเก่าเคยถูกเก็บเหมือนเป็น business tenant
    // ถ้าใช้ Sheet เดียวกับบริษัทปัจจุบัน ให้ถือว่าเป็น LINE alias ของบริษัทนี้ก่อน
    // แล้วค่อย fallback ไป logic business เดิม เพื่อไม่ให้กลุ่มเก่าหายจาก Dashboard
    let mappedBusiness = String((await env.KV.get(lineWorkspaceBusinessKey(groupTenant))) || "").trim();
    const rowSheetId = String(row.sheetId || "").trim();
    const sameBusinessSheet = !!businessSheetId && !!rowSheetId && rowSheetId === businessSheetId;

    if (!mappedBusiness && sameBusinessSheet) {
      mappedBusiness = businessTenant;
      await env.KV.put(lineWorkspaceBusinessKey(groupTenant), businessTenant).catch(() => {});
    }
    if (!mappedBusiness && account.businesses.includes(groupTenant)) {
      mappedBusiness = groupTenant;
    }
    if (mappedBusiness !== businessTenant) continue;`;

  if (!s.includes(oldBlock)) {
    throw new Error("หา anchor getLineGroupsOverview v7.35/v7.36 ไม่เจอ — หยุดเพื่อไม่แก้ผิดเวอร์ชัน");
  }

  s = s.replace(oldBlock, newBlock);
  fs.writeFileSync(file, s);
}

execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log("✅ " + MARKER + " ready");
