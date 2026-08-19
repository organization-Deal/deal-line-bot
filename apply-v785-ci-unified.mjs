import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const MARK = "RUBJAI_CI_UNIFIED_V7_85_1_20260820";
const files = {
  card: path.join(root, "src", "card.js"),
  approver: path.join(root, "src", "approver-line.js"),
  batches: path.join(root, "src", "batches.js"),
  oauth: path.join(root, "src", "oauth.js"),
  index: path.join(root, "src", "index.js"),
  multi: path.join(root, "src", "multi-expense.js"),
  member: path.join(root, "src", "member-profile.js"),
  mobile: path.join(root, "src", "mobile-web-ux.js"),
};

for (const [name,file] of Object.entries(files)) {
  if (!fs.existsSync(file)) throw new Error(`v7.85 missing ${name}: ${path.relative(root,file)}`);
}

const palette = new Map([
  ["#1D1D1F","#101828"],
  ["#111111","#101828"],
  ["#111827","#101828"],
  ["#1C1F24","#101828"],
  ["#3A3A3C","#344054"],
  ["#6E6E73","#667085"],
  ["#8C8C8C","#667085"],
  ["#86868B","#98A2B3"],
  ["#AEAEB2","#98A2B3"],
  ["#B0B7BD","#98A2B3"],
  ["#D2D2D7","#E4E7EC"],
  ["#E5E5EA","#E4E7EC"],
  ["#F5F5F7","#F8FAFC"],
  ["#F0F7FF","#EEF2FF"],
  ["#EAF1FF","#EEF2FF"],
  ["#0071E3","#4F46E5"],
  ["#248A3D","#39705A"],
  ["#147A36","#39705A"],
  ["#12674F","#39705A"],
  ["#1F6E56","#39705A"],
  ["#16A34A","#39705A"],
  ["#F0F8F2","#F1F6F3"],
  ["#EAF7ED","#F1F6F3"],
  ["#E9F7EE","#F1F6F3"],
  ["#EEF6F0","#F1F6F3"],
  ["#D70015","#B42318"],
  ["#DC2626","#B42318"],
  ["#B35C00","#B45309"],
  ["#9A4A00","#B45309"],
  ["#9A5B24","#B45309"],
  ["#B54708","#B45309"],
  ["#FFF8EF","#F8FAFC"],
  ["#FFF4E5","#FFF7ED"],
]);

function replaceHex(text, from, to) {
  return text.replace(new RegExp(from.replace("#","\\#"), "gi"), to);
}
function harmonizePalette(text) {
  for (const [from,to] of palette) text = replaceHex(text, from, to);
  return text;
}
function primaryButtonsIndigo(text) {
  // Direct Flex primary button colors, regardless of the legacy color chosen.
  text = text.replace(
    /(style\s*:\s*["']primary["']\s*,\s*color\s*:\s*["'])#[0-9a-fA-F]{6}(["'])/g,
    "$1#4F46E5$2"
  );
  text = text.replace(
    /(style\s*:\s*["']primary["'][\s\S]{0,90}?color\s*:\s*["'])#(?:101828|39705A|B45309|DC6234)(["'])/g,
    "$1#4F46E5$2"
  );
  return text;
}
function write(name, transform) {
  const file = files[name];
  let src = fs.readFileSync(file, "utf8");
  src = transform(src);
  if (!src.includes(MARK)) src += `\n// ${MARK}\n`;
  fs.writeFileSync(file, src);
  return src;
}

/* ---------- Record cards ---------- */
const card = write("card", (src) => {
  src = harmonizePalette(src);
  src = src.replace(
    "const amountColor = isIncome ? C.green : C.label;",
    "const amountColor = C.label;"
  );
  src = src.replace(
    "color: rec.paid ? undefined : C.green,",
    "color: rec.paid ? undefined : C.blue,"
  );
  src = src.replace(
    /style:\s*'primary',\s*color:\s*C\.orange/g,
    "style: 'primary', color: C.blue"
  );
  return primaryButtonsIndigo(src);
});

/* ---------- Approver / access notification cards ---------- */
const approver = write("approver", (src) => {
  src = harmonizePalette(src);
  src = primaryButtonsIndigo(src);
  // Access / role labels are brand context, not a success state.
  src = src.replace(
    /(text:\s*["']สิทธิ์ใหม่["'][\s\S]{0,90}?color:\s*["'])#39705A(["'])/g,
    "$1#4F46E5$2"
  );
  return src;
});

/* ---------- Batch payment notification ---------- */
const batches = write("batches", (src) => {
  src = harmonizePalette(src);
  src = primaryButtonsIndigo(src);

  // "จ่ายแล้ว" is a success state, not amber.
  src = src.replace(
    /function paymentStatusPill\(text\)\s*\{[\s\S]*?\n\}/,
    (block) => block
      .replace(/backgroundColor:\s*["']#[0-9A-Fa-f]{6}["']/, 'backgroundColor: "#F1F6F3"')
      .replace(/color:\s*["']#[0-9A-Fa-f]{6}["']/, 'color: "#39705A"')
  );

  // Proof attachment is information, not a warning panel.
  src = src.replace(/backgroundColor:\s*["']#FFF7ED["']/g, 'backgroundColor: "#F8FAFC"');
  src = src.replace(
    /(text:\s*["']แนบหลักฐานการโอนเรียบร้อยแล้ว ✅["'][\s\S]{0,100}?color:\s*["'])#B45309(["'])/g,
    "$1#39705A$2"
  );
  src = src.replace(
    /(text:\s*["']เปิดดูสลิปหรือไฟล์หลักฐานการโอนได้จากปุ่มด้านล่าง["'][\s\S]{0,100}?color:\s*["'])#B45309(["'])/g,
    "$1#667085$2"
  );
  return src;
});

/* ---------- OAuth / Google connection card ---------- */
const oauth = write("oauth", (src) => {
  src = harmonizePalette(src);
  src = primaryButtonsIndigo(src);
  // Setup is the primary action if incomplete.
  src = src.replace(/color:\s*["']#DC6234["']/g, 'color: "#4F46E5"');
  // Dashboard is primary when it is the only action.
  src = src.replace(
    /color:\s*setupUrl\s*\?\s*undefined\s*:\s*["']#39705A["']/g,
    'color: setupUrl ? undefined : "#4F46E5"'
  );
  return src;
});

/* ---------- Main bot cards ---------- */
const index = write("index", (src) => {
  src = harmonizePalette(src);
  src = primaryButtonsIndigo(src);

  // These are brand/info labels, not success labels.
  for (const label of [
    "เริ่มใช้งานครั้งแรก",
    "ข้อมูลส่วนตัว",
    "กลุ่ม LINE ใหม่",
    "เชื่อม Google ก่อนใช้งาน 🔗"
  ]) {
    const safe = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    src = src.replace(
      new RegExp(`(text\\s*:\\s*["']${safe}["'][\\s\\S]{0,100}?color\\s*:\\s*["'])#39705A(["'])`, "g"),
      "$1#4F46E5$2"
    );
  }
  return src;
});

/* ---------- Multi-document summary card ---------- */
const multi = write("multi", (src) => {
  src = harmonizePalette(src);
  src = primaryButtonsIndigo(src);

  // Number tokens should support hierarchy without becoming black circles.
  src = src.replace(
    /backgroundColor:\s*["']#101828["']([\s\S]{0,220}?contents:\s*\[\{\s*type:\s*["']text["'][\s\S]{0,140}?color:\s*)["']#FFFFFF["']/g,
    'backgroundColor: "#EEF2FF"$1"#4F46E5"'
  );
  return src;
});

/* ---------- Member onboarding + completion card ---------- */
const member = write("member", (src) => {
  src = harmonizePalette(src);
  return primaryButtonsIndigo(src);
});

/* ---------- Global web pages opened from LINE ---------- */
const mobile = write("mobile", (src) => {
  if (!src.includes("RUBJAI_CI_WEB_THEME_V785")) {
    const anchor = "const SCRIPT = String.raw`<script id=\"deal-mobile-web-ux-script\">";
    if (!src.includes(anchor)) throw new Error("v7.85 mobile theme anchor missing");

    const theme = String.raw`
const CI_THEME_V785 = String.raw\`
<style id="rubjai-ci-web-theme-v785">
:root{
  --rubjai-navy:#101828;
  --rubjai-indigo:#4f46e5;
  --rubjai-indigo-hover:#4338ca;
  --rubjai-indigo-soft:#eef2ff;
  --rubjai-bg:#f7f8fc;
  --rubjai-text:#101828;
  --rubjai-muted:#667085;
  --rubjai-border:#e4e7ec;
  --rubjai-green:#39705a;
  --rubjai-green-soft:#f1f6f3;
  --rubjai-orange:#b45309;
  --rubjai-orange-soft:#fff7ed;
  --rubjai-red:#b42318;
  --rubjai-red-soft:#fff2f1;
}
html,body{background:var(--rubjai-bg)!important;color:var(--rubjai-text)!important}
body,button,input,select,textarea,a,label,p,span,div,section,article,h1,h2,h3,h4,h5,h6,strong,small{
  font-family:"IBM Plex Sans Thai","Noto Sans Thai","Leelawadee UI",sans-serif!important;
}
h1,h2,h3,h4,h5,h6{color:var(--rubjai-text)!important;font-weight:600!important}
input[type="checkbox"],input[type="radio"]{accent-color:var(--rubjai-indigo)!important}
input:focus,select:focus,textarea:focus{
  border-color:var(--rubjai-indigo)!important;
  box-shadow:0 0 0 3px rgba(79,70,229,.10)!important;
  outline:none!important;
}

/* Page CTA hierarchy */
button[type="submit"],input[type="submit"],.primary,.btn-primary,
.btn:not(.secondary):not(.ghost):not(.outline),
.deal-auto-line-button,#dealMobileBusy .deal-line-link,#dealLineCloseGuide .deal-close-confirm{
  background:var(--rubjai-indigo)!important;
  border-color:var(--rubjai-indigo)!important;
  color:#fff!important;
  box-shadow:none!important;
}
button[type="submit"]:hover,.primary:hover,.btn-primary:hover,
.btn:not(.secondary):not(.ghost):not(.outline):hover{
  background:var(--rubjai-indigo-hover)!important;
}
.btn.secondary,.secondary,.ghost,.outline{
  background:#fff!important;
  color:#344054!important;
  border-color:#d0d5dd!important;
}

/* Totals / summaries must not become black panels */
.summary,.summary-card,.total-card,.simple7792-total{
  background:#fff!important;
  color:var(--rubjai-text)!important;
  border:1px solid var(--rubjai-border)!important;
  box-shadow:none!important;
}

/* Global async feedback */
#dealMobileBusy{
  background:rgba(247,248,252,.90)!important;
  color:var(--rubjai-text)!important;
  -webkit-backdrop-filter:blur(14px)!important;
  backdrop-filter:blur(14px)!important;
}
#dealMobileBusy .deal-busy-card{
  background:#fff!important;
  border:1px solid var(--rubjai-border)!important;
  border-radius:22px!important;
  box-shadow:0 24px 60px rgba(16,24,40,.10)!important;
}
#dealMobileBusy .deal-spinner{
  border-color:#e9eaf0!important;
  border-top-color:var(--rubjai-indigo)!important;
  border-right-color:#c7d2fe!important;
}
#dealMobileBusy .deal-progress{background:#eef0f4!important}
#dealMobileBusy .deal-progress i{background:var(--rubjai-indigo)!important}
#dealMobileBusy p{color:var(--rubjai-muted)!important}

/* LINE close/return guide */
#dealLineCloseGuide{
  background:rgba(247,248,252,.94)!important;
  color:var(--rubjai-text)!important;
}
#dealLineCloseGuide .deal-close-card{
  background:#fff!important;
  border:1px solid var(--rubjai-border)!important;
  box-shadow:0 24px 60px rgba(16,24,40,.10)!important;
}
#dealLineCloseGuide .deal-close-arrow-text{
  background:var(--rubjai-indigo-soft)!important;
  color:var(--rubjai-indigo)!important;
  box-shadow:none!important;
}
#dealLineCloseGuide .deal-close-arrow-icon{color:var(--rubjai-indigo)!important}
#dealLineCloseGuide .deal-close-check{
  background:var(--rubjai-green-soft)!important;
  color:var(--rubjai-green)!important;
}
#dealLineCloseGuide .deal-close-main{color:#344054!important}
#dealLineCloseGuide .deal-close-note{
  background:#f8fafc!important;
  color:var(--rubjai-muted)!important;
}

/* Success/error language */
.check{
  background:var(--rubjai-green-soft)!important;
  color:var(--rubjai-green)!important;
}
.error{
  background:var(--rubjai-red-soft)!important;
  color:var(--rubjai-red)!important;
}

/* RUBJAI_CI_WEB_THEME_V785 */
</style>
\`;
`;
    src = src.replace(anchor, theme + "\n" + anchor);
    src = src.replace(
      "const injection = STYLE + BRAND_THEME + script;",
      "const injection = STYLE + BRAND_THEME + CI_THEME_V785 + script;"
    );
  }

  // Keep the old palette variables from competing with the final layer.
  src = src.replace("--rubjai-green:#16a34a;", "--rubjai-green:#39705a;");
  return src;
});


/* ---------- CI audit helpers ----------
   Some modules (e.g. approver-line.js) may legitimately contain
   no primary Flex button and therefore no #4F46E5 literal.
   Audit the actual violation instead of requiring a color literal.
*/
function hasLegacyPrimaryButton(text) {
  return /style\s*:\s*["']primary["'][\s\S]{0,180}?color\s*:\s*(?:["']#(?:101828|111111|111827|1D1D1F|39705A|248A3D|147A36|B45309|B35C00|DC6234)["']|C\.(?:green|orange|label))/i.test(text);
}

/* ---------- Build audit ---------- */
const results = {
  cardIndigo: card.includes("#4F46E5"),
  cardPaidActionIndigo: card.includes("color: rec.paid ? undefined : C.blue"),
  cardIncomeNeutral: card.includes("const amountColor = C.label;"),
  approverCI: !hasLegacyPrimaryButton(approver),
  batchesIndigo: batches.includes("#4F46E5"),
  oauthIndigo: oauth.includes("#4F46E5"),
  indexIndigo: index.includes("#4F46E5"),
  multiNoDarkNumber: !/backgroundColor:\s*["']#101828["']/.test(multi),
  memberIndigo: member.includes("#4F46E5"),
  mobileFinalTheme: mobile.includes("RUBJAI_CI_WEB_THEME_V785") && mobile.includes("CI_THEME_V785 + script"),
};
const failed = Object.entries(results).filter(([,ok]) => !ok).map(([k]) => k);
if (failed.length) throw new Error(`v7.85.1 CI audit failed: ${failed.join(", ")}`);

for (const file of Object.values(files)) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log(`✅ ${MARK}`);
console.log("✅ LINE Flex primary actions = Indigo");
console.log("✅ Success = muted sage, warning/danger semantic only");
console.log("✅ LINE web pages = IBM Plex + white/gray + Indigo");
console.log("✅ Busy/return-to-LINE UI no longer uses black panels/buttons");
console.log("✅ v7.85.1 semantic CI audit:", JSON.stringify(results));
