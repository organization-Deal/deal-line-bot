import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root=process.cwd();
const target=path.join(root,"apply-v7701-review-state-rescue.mjs");
const MARK="REVIEW_BROWSER_TEST_NODE24_COMPAT_V7_70_1_1_20260817";

if(!fs.existsSync(target))throw new Error("ไม่พบ apply-v7701-review-state-rescue.mjs");

let src=fs.readFileSync(target,"utf8");

if(src.includes('const scriptStart=html.indexOf("<script>");')){
  console.log("✅ "+MARK+" already applied");
  process.exit(0);
}

const lines=src.split(/\r?\n/);
const start=lines.findIndex(line=>line.includes("const m=html.match("));
const end=lines.findIndex((line,index)=>index>=start && line.includes('console.log("✅ generated Review HTML browser script extracted")'));

if(start<0||end<start){
  throw new Error("v7.70.1.1: browser-test anchor changed");
}

const indent=(lines[start].match(/^\s*/)||[""])[0];
const replacement=[
  `${indent}const scriptStart=html.indexOf("<script>");`,
  `${indent}const scriptEnd=scriptStart>=0?html.indexOf("</script>",scriptStart+8):-1;`,
  `${indent}if(scriptStart<0||scriptEnd<0)throw new Error("Review browser script not found");`,
  `${indent}const browserScript=html.slice(scriptStart+8,scriptEnd);`,
  `${indent}fs.writeFileSync(\${JSON.stringify(browserJs)},browserScript,"utf8");`,
  `${indent}console.log("✅ generated Review HTML browser script extracted");`,
];

lines.splice(start,end-start+1,...replacement);
src=lines.join("\n");

fs.writeFileSync(target,src);
execFileSync(process.execPath,["--check",target],{stdio:"inherit"});

const out=fs.readFileSync(target,"utf8");
for(const [ok,label] of [
  [out.includes('const scriptStart=html.indexOf("<script>");'),"indexOf extraction"],
  [out.includes('html.indexOf("</script>",scriptStart+8)'),"closing script lookup"],
  [out.includes("browserScript"),"browser script slice"],
  [!out.includes("const m=html.match("),"broken regex removed"],
]){
  if(!ok)throw new Error("v7.70.1.1 assertion failed: "+label);
}

console.log("✅ "+MARK+" ready");
console.log("✅ removed fragile </script> regex escaping from Review build test");
console.log("✅ generated Review HTML extraction now uses indexOf/slice");
console.log("✅ compatible with Node 24 parser");
