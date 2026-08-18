import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const mobileFile = path.join(root, "src", "mobile-web-ux.js");
const MARK = "WEB_VS_LINE_RETURN_CONTEXT_V7_82_20260818";

if (!fs.existsSync(mobileFile)) throw new Error(`v7.82 missing ${mobileFile}`);

let src = fs.readFileSync(mobileFile, "utf8");

if (!src.includes(MARK)) {
  const cleanAnchor = `  const clean=v=>String(v||'').replace(/\\s+/g,' ').trim();`;
  if (!src.includes(cleanAnchor)) throw new Error("v7.82 clean anchor missing");

  src = src.replace(cleanAnchor, `${cleanAnchor}
  // ${MARK}
  // LINE in-app browser normally includes "Line/x.y.z" in the user-agent.
  // On a normal browser, do NOT show LINE-only X/close instructions.
  const isLineClient=/\\bLine\\/[0-9.]+/i.test(String(navigator.userAgent||''));
  const isNormalBrowser=!isLineClient;`);

  const clickAnchor = `    if(/กลับ(?:ไป)?\\s*LINE|เปิด\\s*LINE/i.test(text)){
      event.preventDefault();
      event.stopImmediatePropagation();
      returnToLine();
    }`;

  if (!src.includes(clickAnchor)) throw new Error("v7.82 return click anchor missing");

  src = src.replace(clickAnchor, `    if(target.dataset.dealWebReturn==='1'){
      event.preventDefault();
      event.stopImmediatePropagation();
      if(window.opener&&!window.opener.closed){
        window.close();
        return;
      }
      history.back();
      return;
    }
    if(!isLineClient)return;
    if(/กลับ(?:ไป)?\\s*LINE|เปิด\\s*LINE/i.test(text)){
      event.preventDefault();
      event.stopImmediatePropagation();
      returnToLine();
    }`);

  const returnAnchor = `  async function returnToLine(){
    // LIFF เปิดผ่าน LINE Client จริงสามารถปิดหน้าต่างให้ได้ทันที`;
  if (!src.includes(returnAnchor)) throw new Error("v7.82 returnToLine anchor missing");

  src = src.replace(returnAnchor, `  async function returnToLine(){
    // เว็บที่เปิดจาก Dashboard / Chrome / Safari ปกติ ไม่ควรแสดงวิธี "กด X ของ LINE"
    if(!isLineClient){
      if(window.opener&&!window.opener.closed){
        window.close();
        return;
      }
      history.back();
      return;
    }

    // LIFF เปิดผ่าน LINE Client จริงสามารถปิดหน้าต่างให้ได้ทันที`);

  const addButtonAnchor = `  function addReturnButtonWhenNeeded(){
    const bodyText=clean(document.body&&document.body.innerText);`;
  if (!src.includes(addButtonAnchor)) throw new Error("v7.82 addReturnButton anchor missing");

  src = src.replace(addButtonAnchor, `  function addReturnButtonWhenNeeded(){
    if(!isLineClient)return;
    const bodyText=clean(document.body&&document.body.innerText);`);

  const clarifyAnchor = `  function clarifyReturnButtons(){
    document.querySelectorAll('button,a,[role="button"]').forEach(node=>{`;
  if (!src.includes(clarifyAnchor)) throw new Error("v7.82 clarifyReturnButtons anchor missing");

  src = src.replace(clarifyAnchor, `  function clarifyReturnButtons(){
    // Same HTML can be opened from LINE or from the normal Dashboard.
    // LINE keeps the existing "close this page and return to LINE" UX.
    // Normal browser turns that CTA into a normal web navigation action.
    document.querySelectorAll('button,a,[role="button"]').forEach(node=>{
      const raw=clean(node.textContent||node.getAttribute('aria-label')||'');
      if(!/กลับ(?:ไป)?\\s*LINE|เปิด\\s*LINE/i.test(raw))return;

      if(!isLineClient){
        node.dataset.dealWebReturn='1';
        const label=(window.opener&&!window.opener.closed)
          ? 'ปิดหน้านี้และกลับ Dashboard'
          : 'กลับไปหน้าก่อนหน้า';
        if(node.tagName==='INPUT')node.value=label;
        else node.textContent=label;
        return;
      }`);

  // We inserted a new callback prelude above. The old callback already declares `const text`.
  // Keep it, but it is only reached for LINE-client buttons now.
  const bootAnchor = `  const boot=()=>{clarifyReturnButtons();addReturnButtonWhenNeeded();prepareLiff();};`;
  if (!src.includes(bootAnchor)) throw new Error("v7.82 boot anchor missing");
  src = src.replace(bootAnchor,
    `  const boot=()=>{clarifyReturnButtons();addReturnButtonWhenNeeded();if(isLineClient)prepareLiff();};`
  );

  // On normal web success screens, LINE wording in explanatory copy is confusing.
  // Rewrite only short success/help copy that explicitly tells the user to return to LINE.
  const newBoot = `  const adaptNormalBrowserCopy=()=>{
    if(!isNormalBrowser)return;
    const nodes=[...document.querySelectorAll('p,.deal-return-fallback')];
    for(const node of nodes){
      const t=clean(node.textContent||'');
      if(!t||t.length>180)continue;
      if(/แตะ.*X.*LINE|กลับไปยังแชต\\s*LINE|กลับไป(?:ที่)?\\s*LINE/i.test(t)){
        node.textContent=(window.opener&&!window.opener.closed)
          ? 'บันทึกเรียบร้อยแล้ว สามารถปิดหน้านี้เพื่อกลับไป Dashboard ได้'
          : 'บันทึกเรียบร้อยแล้ว สามารถกลับไปหน้าก่อนหน้าได้';
      }
    }
  };
  const boot=()=>{adaptNormalBrowserCopy();clarifyReturnButtons();addReturnButtonWhenNeeded();if(isLineClient)prepareLiff();};`;

  src = src.replace(
    `  const boot=()=>{clarifyReturnButtons();addReturnButtonWhenNeeded();if(isLineClient)prepareLiff();};`,
    newBoot
  );

  src += `\n// ${MARK}\n`;
}

fs.writeFileSync(mobileFile, src);
execFileSync(process.execPath, ["--check", mobileFile], { stdio:"inherit" });

if (!src.includes(MARK) || !src.includes("dealWebReturn") || !src.includes("isLineClient")) {
  throw new Error("v7.82 audit failed");
}

console.log(`✅ ${MARK}`);
console.log("✅ LINE in-app: keeps X/return-to-LINE UX");
console.log("✅ Normal browser: no LINE close guide; button returns to Dashboard/history");
