import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "src/index.js");
if (!fs.existsSync(file)) throw new Error("ไม่พบ src/index.js — ให้รันที่ root ของ deal-line-bot");

let s = fs.readFileSync(file, "utf8");
const MARKER = "APPROVER_GROUP_DIRECTORY_V7_26_2_20260812";

if (s.includes(MARKER)) {
  console.log("✅ v7.26.2 Approver Group Directory already applied");
  process.exit(0);
}

const oldBlock = `        if (url.pathname === "/api/line-members") {
          if(access.role!=="owner")return cors(json({ok:false,error:"owner_only"},403));
          return cors(json(await listLineWorkspaceMembers(env,key,{
            sheetId,
            token,
            refresh:url.searchParams.get("refresh")!=="0",
          })));
        }`;

const newBlock = `        if (url.pathname === "/api/line-members") {
          if(access.role!=="owner")return cors(json({ok:false,error:"owner_only"},403));

          // ${MARKER}
          // Owner may use a LINE group inside the SAME account only as the member directory.
          // This never grants access to arbitrary groupIds from another customer/account.
          const requestedSourceTenant = String(url.searchParams.get("sourceTenant") || "").trim();
          let sourceTenant = key;

          if (requestedSourceTenant && requestedSourceTenant !== key) {
            const groups = await getLineGroupsOverview(env,key,{refresh:false});
            const allowed = (groups.rows || []).find((row) =>
              String(row.tenant || "") === requestedSourceTenant &&
              (String(row.sourceType || "") === "group" || String(row.groupId || "").startsWith("C"))
            );
            if (!allowed) {
              return cors(json({
                ok:false,
                error:"line_group_not_in_account",
                message:"กลุ่ม LINE นี้ไม่ได้อยู่ในบัญชี/Workspace ชุดนี้",
              },403));
            }
            sourceTenant = requestedSourceTenant;
          }

          const sourceSheetId = (await env.KV.get(\`tenant:\${sourceTenant}\`)) || sheetId;
          const sourceToken = (await getUserToken(env,sourceTenant).catch(()=>null)) || token;

          const out = await listLineWorkspaceMembers(env,sourceTenant,{
            sheetId:sourceSheetId,
            token:sourceToken,
            refresh:url.searchParams.get("refresh")!=="0",
          });

          return cors(json({
            ...out,
            selectedSourceTenant:sourceTenant,
            approvalTenant:key,
          }));
        }`;

if (!s.includes(oldBlock)) {
  throw new Error("หา /api/line-members ของ v7.26 ไม่เจอ — ต้องรัน apply-v726-line-approver-notify.mjs ก่อน v7.26.2");
}

s = s.replace(oldBlock, newBlock);
fs.writeFileSync(file, s);

console.log("✅ v7.26.2 Approver Group Directory applied");
console.log("Fix: Approver selector can read a LINE group inside the same account");
console.log("Security: arbitrary/cross-customer groupId is rejected");
