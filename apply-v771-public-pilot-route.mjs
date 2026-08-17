import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root=process.cwd();
const indexFile=path.join(root,"src","index.js");
const moduleSrc=path.join(root,"pilot-public.js");
const moduleDst=path.join(root,"src","pilot-public.js");
const MARK="PUBLIC_PILOT_ROUTE_V7_71_20260817";

if(!fs.existsSync(indexFile))throw new Error("ไม่พบ src/index.js");
if(!fs.existsSync(moduleSrc))throw new Error("ไม่พบ pilot-public.js ที่ root");

fs.copyFileSync(moduleSrc,moduleDst);
execFileSync(process.execPath,["--check",moduleDst],{stdio:"inherit"});

let src=fs.readFileSync(indexFile,"utf8");

if(src.includes(MARK)){
  console.log("✅ "+MARK+" already applied");
  process.exit(0);
}

const importAnchor='import { verifySignature, getMessageContent, reply, push, textMsg, confirmCard, savedCard, moreCard } from "./line.js";';
if(!src.includes(importAnchor))throw new Error("v7.71: line import anchor changed");

src=src.replace(
  importAnchor,
  `${importAnchor}
import { pilotPage, savePilotRequest, pilotHealth } from "./pilot-public.js"; // ${MARK}`
);

const optionsAnchor='    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));';
if(!src.includes(optionsAnchor))throw new Error("v7.71: OPTIONS routing anchor changed");

src=src.replace(
  optionsAnchor,
  `${optionsAnchor}

    // ${MARK}
    // Public website form: NEVER send this through LINE webhook signature validation.
    if (url.pathname === "/pilot" && request.method === "GET") {
      return pilotPage(env);
    }
    if (url.pathname === "/pilot/request" && request.method === "POST") {
      return savePilotRequest(env, request);
    }
    if (url.pathname === "/pilot/health" && request.method === "GET") {
      return cors(json(pilotHealth()));
    }`
);

fs.writeFileSync(indexFile,src);
execFileSync(process.execPath,["--check",indexFile],{stdio:"inherit"});

const out=fs.readFileSync(indexFile,"utf8");
const routePos=out.indexOf('url.pathname === "/pilot/request"');
const signaturePos=out.indexOf("verifySignature(env, raw");

for(const [ok,label] of [
  [out.includes(MARK),"marker"],
  [out.includes('from "./pilot-public.js"'),"pilot module import"],
  [routePos>=0,"pilot request route"],
  [signaturePos>=0,"LINE signature verifier"],
  [routePos<signaturePos,"pilot route before LINE signature"],
]){
  if(!ok)throw new Error("v7.71 assertion failed: "+label);
}

console.log("✅ "+MARK+" ready");
console.log("✅ POST /pilot/request is handled before LINE webhook signature validation");
console.log("✅ pilot submissions are stored in KV pilotreq:v1:*");
console.log("✅ current Dashboard pilot form fields are accepted");
console.log("✅ GET /pilot/health added for production verification");
