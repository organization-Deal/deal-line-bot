import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const file = path.join(process.cwd(), "src", "vendor-requisition.js");
const MARK = "VENDOR_REQUISITION_VAT_CHECKBOX_UI_V7_83_20260818";

if (!fs.existsSync(file)) {
  throw new Error("v7.83 missing src/vendor-requisition.js — v7.81 must run first");
}

let src = fs.readFileSync(file, "utf8");

if (!src.includes(MARK)) {
  // Root cause:
  // .f input applied full-width / min-height:44px to EVERY input,
  // including input[type=checkbox], so the VAT checkbox became a huge empty square.
  const broadInputCss =
    `.f input,.f select,.f textarea{width:100%;min-height:44px;border:1px solid #d7d7dc;border-radius:11px;padding:9px 11px;background:#fff;font:inherit;font-size:12px;outline:none}`;

  const safeInputCss =
    `.f input:not([type="checkbox"]):not([type="radio"]),.f select,.f textarea{width:100%;min-height:44px;border:1px solid #d7d7dc;border-radius:11px;padding:9px 11px;background:#fff;font:inherit;font-size:12px;outline:none}`;

  if (!src.includes(broadInputCss)) {
    throw new Error("v7.83 input CSS anchor missing");
  }
  src = src.replace(broadInputCss, safeInputCss);

  const oldCheckline =
    `.checkline{margin-top:10px;font-size:10px;color:#555}`;

  const newCheckline =
    `.checkline{margin-top:10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:10px;color:#555}.checkline label{display:inline-flex;align-items:center;gap:7px;cursor:pointer;line-height:1.3}.checkline input[type="checkbox"],.checkline input[type="radio"]{width:16px!important;height:16px!important;min-height:0!important;padding:0!important;margin:0!important;flex:0 0 auto;accent-color:#111}`;

  if (!src.includes(oldCheckline)) {
    throw new Error("v7.83 checkline CSS anchor missing");
  }
  src = src.replace(oldCheckline, newCheckline);

  src += `\n// ${MARK}\n`;
}

fs.writeFileSync(file, src);
execFileSync(process.execPath, ["--check", file], { stdio:"inherit" });

if (
  !src.includes(MARK) ||
  src.includes(`.f input,.f select,.f textarea{width:100%`)
) {
  throw new Error("v7.83 audit failed");
}

console.log(`✅ ${MARK}`);
console.log("✅ VAT checkbox is compact and inline with its label");
console.log("✅ Text inputs keep the normal full-width styling");
