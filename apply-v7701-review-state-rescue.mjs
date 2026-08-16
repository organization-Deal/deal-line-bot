import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root=process.cwd();
const file=path.join(root,"src","multi-expense.js");
const MARK="REVIEW_STATE_RESCUE_V7_70_1_20260816";

if(!fs.existsSync(file))throw new Error("ไม่พบ src/multi-expense.js");
let src=fs.readFileSync(file,"utf8");
if(src.includes(MARK)){console.log("✅ "+MARK+" already applied");process.exit(0);}

/* Persistent reload error instead of silent toast + stuck ฿— */
const oldReload=`async function reload(){try{D=await api('/state');render()}catch(e){toast(e.message)}}`;
const newReload=`// ${MARK}
async function reload(){
  try{
    const state=await api('/state');
    if(!state||state.ok===false||!state.counts||!Array.isArray(state.groups)||!Array.isArray(state.items)){
      throw new Error(state?.error||'ข้อมูลชุดเอกสารไม่สมบูรณ์');
    }
    D=state;
    render();
  }catch(e){
    D=null;
    const message=String(e?.message||'โหลดข้อมูลชุดเอกสารไม่สำเร็จ');
    const top=q('#topStatus'),vat=q('#sumVat'),count=q('#sumCount'),total=q('#sumTotal');
    const ready=q('#readyPill'),warn=q('#warnPill'),images=q('#imagePill');
    const groups=q('#groups'),pool=q('#pool'),save=q('#saveBtn');
    if(top)top.textContent='โหลดข้อมูลไม่สำเร็จ';
    if(total)total.textContent='—';
    if(vat)vat.textContent=message;
    if(count)count.textContent='กด “โหลดข้อมูลใหม่” เพื่อลองอีกครั้ง';
    if(ready)ready.textContent='พร้อม 0';
    if(warn){warn.textContent='ต้องตรวจ';warn.style.display='inline-flex'}
    if(images)images.textContent='— เอกสาร';
    if(groups)groups.innerHTML='<div class="empty">ยังดึงข้อมูลรายการไม่ได้ กรุณากด “โหลดข้อมูลใหม่”</div>';
    if(pool)pool.innerHTML='';
    if(save)save.disabled=true;
    toast(message);
    console.error('[review-state]',message,e);
  }
}`;
if(!src.includes(oldReload))throw new Error("v7.70.1: reload anchor changed");
src=src.replace(oldReload,newReload);

/* Defensive render header: support both old and v7.70 state shapes */
const v770=`function render(){
  const total=D.groups.reduce((s,g)=>s+Number(g.amount||0),0);
  const vat=D.groups.reduce((s,g)=>s+vatOf(g),0);
  const processingFailed=Number(D.counts.processingFailed||0);
  const needs=Number(D.counts.warnings||0)+Number(D.counts.unassigned||0)+processingFailed;`;

const legacy=`function render(){
  const total=D.groups.reduce((s,g)=>s+Number(g.amount||0),0);
  const vat=D.groups.reduce((s,g)=>s+vatOf(g),0);
  const needs=Number(D.counts.warnings||0)+Number(D.counts.unassigned||0);`;

const safe=`function render(){
  if(!D||typeof D!=='object')throw new Error('ไม่มีข้อมูลชุดเอกสาร');
  D.counts=D.counts&&typeof D.counts==='object'?D.counts:{};
  D.groups=Array.isArray(D.groups)?D.groups:[];
  D.items=Array.isArray(D.items)?D.items:[];
  D.saved=Array.isArray(D.saved)?D.saved:[];
  D.roles=Array.isArray(D.roles)?D.roles:[];
  D.categories=Array.isArray(D.categories)?D.categories:[];
  D.expenseCategories=Array.isArray(D.expenseCategories)?D.expenseCategories:[];
  D.incomeCategories=Array.isArray(D.incomeCategories)?D.incomeCategories:[];
  const total=D.groups.reduce((s,g)=>s+Number(g?.amount||0),0);
  const vat=D.groups.reduce((s,g)=>s+vatOf(g||{}),0);
  const processingFailed=Number(D.counts.processingFailed||0);
  const inflight=Number(D.counts.inflight||0);
  const needs=Number(D.counts.warnings||0)+Number(D.counts.unassigned||0)+processingFailed;`;

if(src.includes(v770))src=src.replace(v770,safe);
else if(src.includes(legacy))src=src.replace(legacy,safe);
else throw new Error("v7.70.1: render anchor changed");

/* Replace status block from v7.70 if present, otherwise legacy block */
const statusV770=`  q('#sumCount').textContent=D.counts.groups+' รายการ · '+(processingFailed
    ?('รับ '+Number(D.counts.received||0)+' รูป · อ่านแล้ว '+Number(D.counts.images||0)+' · ล้มเหลว '+processingFailed)
    :(D.counts.unassigned?'ยังไม่จัด '+D.counts.unassigned+' รูป':'จัดรูปครบแล้ว'));
  q('#readyPill').textContent='พร้อม '+Number(D.counts.ready||0);
  q('#warnPill').textContent='ต้องตรวจ '+needs;
  q('#warnPill').style.display=needs?'inline-flex':'none';
  q('#imagePill').textContent=processingFailed
    ?('รับ '+Number(D.counts.received||0)+' · อ่าน '+Number(D.counts.images||0))
    :(Number(D.counts.images||0)+' เอกสาร');
  q('#topStatus').textContent=processingFailed
    ?('มี '+processingFailed+' รูปที่ต้องส่งใหม่')
    :(needs?'มี '+needs+' จุดที่ต้องตรวจ':'พร้อมบันทึก');
  q('#saveBtn').textContent='บันทึก '+Number(D.counts.groups||0)+' รายการ';
  q('#saveBtn').disabled=D.status==='saving'||D.status==='saving_docs'||!D.counts.groups||processingFailed>0;`;

const statusLegacy=`  q('#sumCount').textContent=D.counts.groups+' รายการ · '+(D.counts.unassigned?'ยังไม่จัด '+D.counts.unassigned+' รูป':'จัดรูปครบแล้ว');
  q('#readyPill').textContent='พร้อม '+Number(D.counts.ready||0);
  q('#warnPill').textContent='ต้องตรวจ '+needs;
  q('#warnPill').style.display=needs?'inline-flex':'none';
  q('#imagePill').textContent=Number(D.counts.images||0)+' เอกสาร';
  q('#topStatus').textContent=needs?'มี '+needs+' จุดที่ต้องตรวจ':'พร้อมบันทึก';
  q('#saveBtn').textContent='บันทึก '+Number(D.counts.groups||0)+' รายการ';
  q('#saveBtn').disabled=D.status==='saving'||D.status==='saving_docs'||!D.counts.groups;`;

const statusSafe=`  const received=Math.max(Number(D.counts.received||0),Number(D.counts.images||0));
  const processed=Number(D.counts.images||0);
  const groupCount=Number(D.counts.groups||D.groups.length||0);
  q('#sumCount').textContent=processingFailed
    ?(groupCount+' รายการ · รับ '+received+' รูป · อ่านแล้ว '+processed+' · ล้มเหลว '+processingFailed)
    :(inflight
      ?(groupCount+' รายการ · กำลังอ่านอีก '+inflight+' รูป')
      :(groupCount+' รายการ · '+(D.counts.unassigned?'ยังไม่จัด '+D.counts.unassigned+' รูป':'จัดรูปครบแล้ว')));
  q('#readyPill').textContent='พร้อม '+Number(D.counts.ready||0);
  q('#warnPill').textContent=processingFailed?'รูปมีปัญหา '+processingFailed:('ต้องตรวจ '+needs);
  q('#warnPill').style.display=(needs||inflight)?'inline-flex':'none';
  q('#imagePill').textContent=received>processed?('รับ '+received+' · อ่าน '+processed):(processed+' เอกสาร');
  q('#topStatus').textContent=processingFailed
    ?('มี '+processingFailed+' รูปที่ต้องส่งใหม่')
    :(inflight?('กำลังอ่านเอกสาร '+inflight+' รูป'):(needs?'มี '+needs+' จุดที่ต้องตรวจ':'พร้อมบันทึก'));
  q('#saveBtn').textContent='บันทึก '+groupCount+' รายการ';
  q('#saveBtn').disabled=D.status==='saving'||D.status==='saving_docs'||!groupCount||processingFailed>0||inflight>0;`;

if(src.includes(statusV770))src=src.replace(statusV770,statusSafe);
else if(src.includes(statusLegacy))src=src.replace(statusLegacy,statusSafe);
else throw new Error("v7.70.1: status block changed");

/* Defensive helpers */
src=src.replace(
  `function roleOptions(cur){return (D.roles||[]).map`,
  `function roleOptions(cur){return (Array.isArray(D?.roles)?D.roles:[]).map`
);
src=src.replace(
  `for(const g of D.groups){`,
  `for(const g of (Array.isArray(D?.groups)?D.groups:[])){`
);

/* Export page renderer ONLY so build can validate the actual browser script */
if(!src.includes("export { reviewPage as __reviewPageForBuildTest };")){
  src += `\n\n// ${MARK} build browser-runtime validation hook\nexport { reviewPage as __reviewPageForBuildTest };\n`;
}

fs.writeFileSync(file,src);
execFileSync(process.execPath,["--check",file],{stdio:"inherit"});

/* Validate the JavaScript inside the real generated Review HTML */
const tester=path.join(root,".review-browser-test.mjs");
const browserJs=path.join(root,".review-browser-runtime.js");

fs.writeFileSync(tester,`
import fs from "node:fs";
import { __reviewPageForBuildTest } from "./src/multi-expense.js";
const html=__reviewPageForBuildTest("test-sid","test-token",{WORKER_URL:"https://example.invalid"});
const m=html.match(/<script>([\\\\s\\\\S]*?)<\\\\/script>/i);
if(!m)throw new Error("Review browser script not found");
fs.writeFileSync(${JSON.stringify(browserJs)},m[1],"utf8");
console.log("✅ generated Review HTML browser script extracted");
`);

try{
  execFileSync(process.execPath,[tester],{stdio:"inherit"});
  execFileSync(process.execPath,["--check",browserJs],{stdio:"inherit"});
}finally{
  try{fs.unlinkSync(tester)}catch{}
  try{fs.unlinkSync(browserJs)}catch{}
}

console.log("✅ "+MARK+" ready");
console.log("✅ Review page no longer stays silently at ฿— / กำลังโหลด");
console.log("✅ old and v7.70 Durable Object state shapes are supported");
console.log("✅ received / processed / failed / inflight counts render safely");
console.log("✅ Save is blocked while images are incomplete");
console.log("✅ state API errors remain visible on screen");
console.log("✅ generated Review HTML browser JavaScript passed node --check");
