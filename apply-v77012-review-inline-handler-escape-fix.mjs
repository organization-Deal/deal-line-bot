import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root=process.cwd();
const file=path.join(root,"src","multi-expense.js");
const MARK="REVIEW_INLINE_HANDLER_ESCAPE_V7_70_1_2_20260817";

if(!fs.existsSync(file))throw new Error("ไม่พบ src/multi-expense.js");

let src=fs.readFileSync(file,"utf8");

if(src.includes(MARK)){
  console.log("✅ "+MARK+" already applied");
  process.exit(0);
}

const start=src.indexOf("function renderGroups(){");
const end=src.indexOf("function renderPool(){",start);

if(start<0||end<=start){
  throw new Error("v7.70.1.2: renderGroups/renderPool anchors changed");
}

let block=src.slice(start,end);

// reviewPage() is inside a server-side template literal.
// One backslash before ' is consumed while generating the HTML.
// Browser JS needs that backslash to survive, so source must contain TWO.
const oneBackslashQuote=String.fromCharCode(92,39);
const twoBackslashQuote=String.fromCharCode(92,92,39);

const before=block.split(oneBackslashQuote).length-1;
if(before<4){
  throw new Error("v7.70.1.2: expected inline-handler quote escapes were not found");
}

block=block.split(oneBackslashQuote).join(twoBackslashQuote);

src =
  src.slice(0,start) +
  `// ${MARK}\n` +
  block +
  src.slice(end);

fs.writeFileSync(file,src);
execFileSync(process.execPath,["--check",file],{stdio:"inherit"});

const out=fs.readFileSync(file,"utf8");
if(!out.includes(MARK))throw new Error("v7.70.1.2 marker missing");

const fixedStart=out.indexOf("function renderGroups(){");
const fixedEnd=out.indexOf("function renderPool(){",fixedStart);
const fixedBlock=out.slice(fixedStart,fixedEnd);

for(const name of ["patchGroup(","changeRole(","assign(","deleteGroup("]){
  if(!fixedBlock.includes(name+twoBackslashQuote)){
    throw new Error("v7.70.1.2 escaped handler missing: "+name);
  }
}

console.log("✅ "+MARK+" ready");
console.log("✅ renderGroups inline onclick/onchange quotes now survive server-side template rendering");
console.log("✅ patchGroup / changeRole / assign / deleteGroup handler escaping fixed");
console.log("✅ V7.70.1 browser-runtime test will validate the generated Review JavaScript next");
