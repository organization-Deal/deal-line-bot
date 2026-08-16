import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const file = path.join(root, "src", "index.js");
const MARK = "ADMIN_OPS_ROUTE_V7_56_20260816";

if (!fs.existsSync(file)) throw new Error("ไม่พบ src/index.js");
let src = fs.readFileSync(file, "utf8");

if (src.includes(MARK)) {
  console.log("ℹ️ " + MARK + " already present");
  process.exit(0);
}

if (!src.includes('from "./admin-ops.js"')) {
  const anchor = 'export { MultiExpenseSession } from "./multi-expense.js";';
  if (!src.includes(anchor)) {
    throw new Error("หา import anchor ไม่เจอ — หยุดก่อนเพื่อไม่แก้ผิดเวอร์ชัน");
  }
  src = src.replace(
    anchor,
    `import { handleAdminOps } from "./admin-ops.js"; // ${MARK}\n\n${anchor}`
  );
}

const routeAnchor = '    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));';
if (!src.includes('url.pathname.startsWith("/admin/ops/")')) {
  if (!src.includes(routeAnchor)) {
    throw new Error("หา fetch route anchor ไม่เจอ — หยุดก่อนเพื่อไม่แก้ผิดเวอร์ชัน");
  }
  src = src.replace(
    routeAnchor,
    `${routeAnchor}

    // ${MARK}
    if (url.pathname.startsWith("/admin/ops/")) {
      return await handleAdminOps(request, env, url);
    }`
  );
}

fs.writeFileSync(file, src);
execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });

const finalText = fs.readFileSync(file, "utf8");
if (!finalText.includes('import { handleAdminOps } from "./admin-ops.js"')) {
  throw new Error("admin-ops import ไม่สำเร็จ");
}
if (!finalText.includes('url.pathname.startsWith("/admin/ops/")')) {
  throw new Error("admin-ops route ไม่สำเร็จ");
}

console.log("✅ " + MARK + " ready");
console.log("✅ src/admin-ops.js wired into Worker");
console.log("✅ /admin/ops/* route enabled");
console.log("✅ ADMIN_KEY validation will now reach backend");
