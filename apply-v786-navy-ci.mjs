import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const srcRoot = path.join(root,"src");
const MARK = "RUBJAI_NAVY_CI_V786_20260820";
const NAVY = "#11162E";
const NAVY_HOVER = "#20294F";
const NAVY_DEEP = "#080B1A";
const NAVY_SOFT = "#F0F2F8";
const NAVY_LINE = "#D9DEEA";

if (!fs.existsSync(srcRoot)) throw new Error("v7.86 missing src/");

const MAP = new Map([
  // Current v7.85 Indigo and older blue/purple families
  ["#4F46E5", NAVY],
  ["#4338CA", NAVY_HOVER],
  ["#3730A3", NAVY_DEEP],
  ["#6366F1", NAVY],
  ["#5B5FEF", NAVY],
  ["#5850EC", NAVY],
  ["#5D5FEF", NAVY],
  ["#6C63FF", NAVY],
  ["#5548E8", NAVY],
  ["#7C3AED", NAVY],
  ["#6D28D9", NAVY],
  ["#8B5CF6", NAVY],
  ["#A78BFA", "#B8C0D1"],
  ["#2563EB", NAVY],
  ["#3B82F6", NAVY],
  ["#0071E3", NAVY],
  ["#4B46C4", NAVY],
  ["#312E81", NAVY_DEEP],

  // Soft accent
  ["#EEF2FF", NAVY_SOFT],
  ["#EDE9FE", NAVY_SOFT],
  ["#F0F7FF", NAVY_SOFT],
  ["#EAF1FF", NAVY_SOFT],
  ["#DBEAFE", NAVY_SOFT],
  ["#C7D2FE", NAVY_LINE],
  ["#A5B4FC", "#B8C0D1"],
  ["#DFE3FF", "#E1E5EF"],

  // Current v7.85 dark text/primary
  ["#101828", NAVY],
  ["#1D1D1F", NAVY],
  ["#111827", NAVY],
  ["#111111", NAVY],
  ["#1C1F24", NAVY],
  ["#171719", NAVY],
  ["#000000", NAVY_DEEP],

  // Neutrals
  ["#344054", "#39405A"],
  ["#3A3A3C", "#39405A"],
  ["#6E6E73", "#667085"],
  ["#86868B", "#98A2B3"],
  ["#AEAEB2", "#98A2B3"],
  ["#D2D2D7", "#D9DEE8"],
  ["#E5E5EA", "#E4E7EC"],
]);

const FORBIDDEN = [
  "#4F46E5","#4338CA","#3730A3","#6366F1","#5B5FEF","#5850EC",
  "#5D5FEF","#6C63FF","#5548E8","#7C3AED","#6D28D9","#8B5CF6",
  "#2563EB","#3B82F6","#0071E3","#4B46C4","#312E81",
  "#EEF2FF","#EDE9FE","#C7D2FE","#A5B4FC"
];

const exts = new Set([".js",".mjs",".css",".html"]);
let files = [];
function walk(dir){
  for (const ent of fs.readdirSync(dir,{withFileTypes:true})) {
    const full = path.join(dir,ent.name);
    if (ent.isDirectory()) { walk(full); continue; }
    if (exts.has(path.extname(ent.name).toLowerCase())) files.push(full);
  }
}
walk(srcRoot);

function replaceHexToken(text, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?![0-9A-Fa-f])`, "gi"), to);
}

function recolor(text){
  for (const [from,to] of MAP) text = replaceHexToken(text,from,to);

  text = text
    .replace(/rgba?\(\s*79\s*,\s*70\s*,\s*229\b/gi, m=>m.replace(/79\s*,\s*70\s*,\s*229/i,"17,22,46"))
    .replace(/rgba?\(\s*67\s*,\s*56\s*,\s*202\b/gi, m=>m.replace(/67\s*,\s*56\s*,\s*202/i,"32,41,79"))
    .replace(/rgba?\(\s*99\s*,\s*102\s*,\s*241\b/gi, m=>m.replace(/99\s*,\s*102\s*,\s*241/i,"17,22,46"));

  // Every LINE Flex primary action is Navy regardless of legacy semantic variable.
  text = text.replace(
    /(style\s*:\s*["']primary["'][\s\S]{0,160}?color\s*:\s*)(?:C\.(?:blue|green|orange|label)|["']#[0-9A-Fa-f]{6}["'])/g,
    '$1"#11162E"'
  );

  // AI labels/cards are brand-information, not purple/green.
  text = text.replace(
    /(text\s*:\s*["'][^"']*\bAI\b[^"']*["'][\s\S]{0,160}?color\s*:\s*)(?:C\.(?:blue|green|orange)|["']#[0-9A-Fa-f]{6}["'])/gi,
    '$1"#11162E"'
  );
  text = text.replace(
    /(text\s*:\s*["'][^"']*\bAI\b[^"']*["'][\s\S]{0,220}?backgroundColor\s*:\s*)["']#[0-9A-Fa-f]{6}["']/gi,
    '$1"#F0F2F8"'
  );

  return text;
}

let changed = [];
for (const file of files){
  let src = fs.readFileSync(file,"utf8");
  const before = src;
  src = recolor(src);
  if (src !== before) {
    fs.writeFileSync(file,src);
    changed.push(path.relative(root,file));
  }
}

// Add a specific CSS lock to the existing global LINE web theme.
const mobile = path.join(srcRoot,"mobile-web-ux.js");
if (fs.existsSync(mobile)) {
  let src = fs.readFileSync(mobile,"utf8");
  if (!src.includes("RUBJAI_NAVY_WEB_LOCK_V786")) {
    const css = `
/* RUBJAI_NAVY_WEB_LOCK_V786 */
:root{
  --rubjai-navy:#11162E!important;
  --rubjai-indigo:#11162E!important;
  --rubjai-indigo-hover:#20294F!important;
  --rubjai-indigo-soft:#F0F2F8!important;
}
input[type="checkbox"],input[type="radio"]{accent-color:#11162E!important}
input:focus,select:focus,textarea:focus{border-color:#11162E!important;box-shadow:0 0 0 3px rgba(17,22,46,.10)!important}
button[type="submit"],input[type="submit"],.primary,.btn-primary,
.btn:not(.secondary):not(.ghost):not(.outline),
.deal-auto-line-button,#dealMobileBusy .deal-line-link,#dealLineCloseGuide .deal-close-confirm{
  background:#11162E!important;border-color:#11162E!important;color:#fff!important;
}
button[type="submit"]:hover,.primary:hover,.btn-primary:hover,
.btn:not(.secondary):not(.ghost):not(.outline):hover{
  background:#20294F!important;border-color:#20294F!important;
}
#dealMobileBusy .deal-spinner{
  border-color:#E4E7EC!important;border-top-color:#11162E!important;border-right-color:#D9DEEA!important;
}
#dealMobileBusy .deal-progress i{background:#11162E!important}
.ai-badge,.ai-chip,.ai-pill,.ai-tag,[data-ai-badge],[data-ai-chip],[data-ai="true"]{
  background:#F0F2F8!important;color:#11162E!important;border-color:#D9DEEA!important;
}
`;
    const themePattern = /(<style id=["']rubjai-ci-web-theme-v785["']>[\s\S]*?)(<\/style>)/;
    if (themePattern.test(src)) {
      src = src.replace(themePattern, `$1\n${css}\n$2`);
    } else {
      // Safe fallback: append a separate template literal constant and include it in injection.
      const anchor = /const SCRIPT = String\.raw`<script id="deal-mobile-web-ux-script">/;
      if (!anchor.test(src)) throw new Error("v7.86 mobile theme anchor missing");
      const safeLines = [
        'const CI_THEME_V786 = String.raw`',
        '<style id="rubjai-navy-web-v786">',
        css,
        '</style>',
        '`;'
      ].join("\n");
      src = src.replace(anchor, `${safeLines}\n\n$&`);
      src = src.replace(
        /STYLE\s*\+\s*BRAND_THEME\s*\+\s*(?:CI_THEME_V785\s*\+\s*)?script/g,
        (m)=> m.includes("CI_THEME_V785")
          ? m.replace("+ script","+ CI_THEME_V786 + script")
          : m.replace("+ script","+ CI_THEME_V785 + CI_THEME_V786 + script")
      );
    }
    fs.writeFileSync(mobile,src);
    if (!changed.includes("src/mobile-web-ux.js")) changed.push("src/mobile-web-ux.js");
  }
}

// Final syntax check all src JS/MJS after patch.
for (const file of files.filter(f=>[".js",".mjs"].includes(path.extname(f).toLowerCase()))) {
  execFileSync(process.execPath, ["--check", file], {stdio:"pipe"});
}

// Audit all runtime src files for old brand accents.
let remaining = [];
for (const file of files){
  const src = fs.readFileSync(file,"utf8");
  for (const hex of FORBIDDEN){
    if (src.toUpperCase().includes(hex.toUpperCase())) {
      remaining.push(`${path.relative(root,file)}:${hex}`);
    }
  }
}
if (remaining.length) throw new Error(`v7.86 Navy CI audit old accent remains: ${remaining.slice(0,30).join(", ")}`);

const card = path.join(srcRoot,"card.js");
if (fs.existsSync(card)) {
  const s = fs.readFileSync(card,"utf8");
  if (!s.includes("#11162E")) throw new Error("v7.86 card audit: Navy missing");
}
if (fs.existsSync(mobile)) {
  const s = fs.readFileSync(mobile,"utf8");
  if (!s.includes("RUBJAI_NAVY_WEB_LOCK_V786")) throw new Error("v7.86 mobile web lock missing");
}

console.log(`✅ ${MARK}`);
console.log(`✅ Runtime src files recolored: ${changed.length}`);
console.log("✅ LINE Flex primary buttons: Navy");
console.log("✅ LINE web/loading/forms/AI accents: Navy");
console.log("✅ Old Indigo/Purple/Blue CI literals: 0");
