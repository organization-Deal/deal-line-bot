import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root=process.cwd();
const indexFile=path.join(root,"src","index.js");
const moduleFile=path.join(root,"src","cash-position.js");
const MARK="AUTO_CASH_POSITION_V7_69_20260816";

if(!fs.existsSync(indexFile))throw new Error("ไม่พบ src/index.js");
if(!fs.existsSync(moduleFile))throw new Error("ไม่พบ src/cash-position.js");

let src=fs.readFileSync(indexFile,"utf8");

if(!src.includes('from "./cash-position.js"')){
  const anchor='} from "./accounting-suite.js";';
  if(!src.includes(anchor))throw new Error("v7.69: accounting-suite import anchor changed");
  src=src.replace(anchor,anchor+'\nimport { getCashPosition } from "./cash-position.js"; // '+MARK);
}

if(!src.includes('url.pathname === "/api/cash-position"')){
  const anchor='        /* Accounting Suite v7 — migration / AP / close / tax / audit / ledger */';
  if(!src.includes(anchor))throw new Error("v7.69: accounting route anchor changed");
  const route=`        // ${MARK}
        // Manual finance_balances is a baseline snapshot; real transactions after that
        // automatically move the effective balance by selected paymentChannelId.
        if (url.pathname === "/api/cash-position" && request.method === "GET") {
          return cors(json(await getCashPosition(env, key, sheetId, token)));
        }

`;
  src=src.replace(anchor,route+anchor);
}

fs.writeFileSync(indexFile,src);
execFileSync(process.execPath,["--check",moduleFile],{stdio:"inherit"});
execFileSync(process.execPath,["--check",indexFile],{stdio:"inherit"});

const out=fs.readFileSync(indexFile,"utf8");
for(const [ok,label] of [
  [out.includes('from "./cash-position.js"'),"cash position import"],
  [out.includes('url.pathname === "/api/cash-position"'),"cash position endpoint"],
  [out.includes(MARK),"marker"],
]){
  if(!ok)throw new Error("v7.69 assertion failed: "+label);
}
console.log("✅ "+MARK+" ready");
console.log("✅ manual account balance is now a baseline snapshot");
console.log("✅ income cash received increases the selected account");
console.log("✅ paid reimbursement decreases the selected account");
console.log("✅ AP supplier payment decreases the selected account");
console.log("✅ paid rows before the latest manual baseline are not double-counted");
console.log("✅ existing historical payments after the baseline are calculated automatically");
