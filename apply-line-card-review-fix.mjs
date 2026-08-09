import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const files = {
  index: path.join(root, 'src/index.js'),
  oauth: path.join(root, 'src/oauth.js'),
  multi: path.join(root, 'src/multi-expense.js'),
  batches: path.join(root, 'src/batches.js'),
};

for (const [name, file] of Object.entries(files)) {
  if (!fs.existsSync(file)) throw new Error(`ไม่พบ ${file} — ให้รันสคริปต์นี้ที่ root ของ deal-line-bot`);
}

function mustReplace(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`หา anchor ไม่เจอ: ${label}\nหยุดก่อนเพื่อไม่แก้ผิดเวอร์ชัน`);
  return text.replace(from, to);
}

function patchIndex() {
  let s = fs.readFileSync(files.index, 'utf8');
  s = mustReplace(
    s,
    '{ type: "text", text: "เชื่อม Google ก่อนใช้งาน 🔗", weight: "bold", size: "md", color: "#1F6E56" },',
    '{ type: "text", text: "เชื่อม Google ก่อนใช้งาน", weight: "bold", size: "md", color: "#1D1D1F" },',
    'connect card title'
  );
  s = mustReplace(
    s,
    '{ type: "button", style: "primary", color: "#1F6E56", height: "sm",\n          action: { type: "uri", label: "เชื่อม Google", uri: url } },',
    '{ type: "button", style: "primary", color: "#1D1D1F", height: "sm",\n          action: { type: "uri", label: "เชื่อม Google", uri: url } },',
    'connect card button'
  );
  fs.writeFileSync(files.index, s);
}

function patchOauth() {
  let s = fs.readFileSync(files.oauth, 'utf8');
  const start = s.indexOf('function connectedCard(');
  const end = s.indexOf('\nexport async function handleCallback', start);
  if (start < 0 || end < 0) throw new Error('หา connectedCard ไม่เจอ');
  let b = s.slice(start, end);
  b = mustReplace(b, 'color: setupUrl ? undefined : "#12674F"', 'color: setupUrl ? undefined : "#1D1D1F"', 'connected dashboard button');
  b = mustReplace(
    b,
    '{ type: "text", text: linkedExisting ? "✅ เชื่อมธุรกิจเดิมสำเร็จ" : "✅ เชื่อม Google สำเร็จ", weight: "bold", size: "md", color: "#12674F" },',
    '{ type: "text", text: linkedExisting ? "เชื่อมธุรกิจเดิมสำเร็จ" : "เชื่อม Google สำเร็จ", weight: "bold", size: "md", color: "#1D1D1F" },',
    'connected card heading'
  );
  b = mustReplace(b, 'color: r.ok ? "#12674F" : "#B0B7BD"', 'color: r.ok ? "#3A3A3C" : "#B0B7BD"', 'connected card checks');
  s = s.slice(0, start) + b + s.slice(end);
  fs.writeFileSync(files.oauth, s);
}

function patchMulti() {
  let s = fs.readFileSync(files.multi, 'utf8');

  // คำบน Flex ให้เข้าใจว่า primary บันทึกจริง ส่วนเว็บเป็นทางเลือกสำหรับตรวจ/แก้
  if (s.includes('label: "ยืนยันรายการถูกต้อง"')) s = s.replace('label: "ยืนยันรายการถูกต้อง"', 'label: "ยืนยันและบันทึก"');
  if (s.includes('label: "ตรวจและแก้ไข"')) s = s.replace('label: "ตรวจและแก้ไข"', 'label: "ตรวจ / แก้ไขก่อน"');
  s = s.replace('รับจ่ายได้หมด · DOCUMENT REVIEW', 'รับจ่ายแบบไม่จำกัด · DOCUMENT REVIEW');

  // BUG FIX: reviewPage() เป็น template literal ซ้อน JS string อีกชั้น
  // source เดิมมี backslash 1 ชั้น ทำให้ HTML ที่ generate ออกมาเหลือ quote ไม่ escaped
  // ส่งผลให้ทั้ง <script> syntax error และ reload() ไม่เคยทำงาน
  for (const variable of ['g.id', 'im.id']) {
    const oldEsc = "\\''+" + variable + "+'\\'";
    const fixedEsc = "\\\\\\''+" + variable + "+'\\\\\\'";
    if (s.includes(oldEsc)) s = s.split(oldEsc).join(fixedEsc);
  }

  const oldReload = "async function reload(){try{D=await api('/state');render()}catch(e){toast(e.message)}}";
  const newReload = `let LOAD_RETRY=0,LOAD_TIMER=null;\nasync function reload(){\n  try{\n    D=await api('/state');\n    LOAD_RETRY=0;clearTimeout(LOAD_TIMER);\n    render();\n  }catch(e){\n    q('#topStatus').textContent='โหลดข้อมูลไม่สำเร็จ';\n    q('#sumVat').textContent='กำลังลองใหม่อัตโนมัติ · หรือกด “โหลดข้อมูลใหม่”';\n    toast(e.message||'โหลดข้อมูลไม่สำเร็จ');\n    clearTimeout(LOAD_TIMER);\n    const wait=Math.min(15000,2000*Math.max(1,++LOAD_RETRY));\n    LOAD_TIMER=setTimeout(reload,wait);\n  }\n}`;
  s = mustReplace(s, oldReload, newReload, 'review reload handler');
  fs.writeFileSync(files.multi, s);
}


function patchBatches() {
  let s = fs.readFileSync(files.batches, 'utf8');

  // v7.9: ใบเบิกหลักที่สร้างแล้วห้ามเอากลับมารวมเป็นใบเบิกใหม่อีก
  // Frontend จะซ่อน checkbox และ backend ต้องกันซ้ำอีกชั้น
  const anchor = `  const requestedBatchIds = [...new Set((options.batchIds || []).map((id) => String(id || "").trim()).filter(Boolean))];`;
  const guarded = `${anchor}
  if (requestedBatchIds.length) {
    return {
      ok: false,
      reason: "already_batched_items_not_mergeable",
      message: "รายการที่รวมเป็นใบเบิกแล้ว ไม่สามารถนำไปรวมเป็นใบเบิกใหม่ซ้ำได้",
      blockedBatchIds: requestedBatchIds,
    };
  }`;
  s = mustReplace(s, anchor, guarded, 'prevent merging existing reimbursement batches');

  fs.writeFileSync(files.batches, s);
}

function syntaxCheck() {
  for (const file of Object.values(files)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });

  // Regression test สำคัญ: parse JavaScript ที่ reviewPage generate ออกมาจริง
  const temp = path.join(path.dirname(files.multi), `.tmp-review-check-${Date.now()}.mjs`);
  const generated = path.join(os.tmpdir(), `review-generated-${Date.now()}.js`);
  try {
    fs.writeFileSync(temp, fs.readFileSync(files.multi, 'utf8') + '\nexport { reviewPage };\n');
    return import(pathToFileURL(temp).href + `?v=${Date.now()}`).then(({ reviewPage }) => {
      const html = reviewPage('syntax-test-sid', 'syntax-test-token', { WORKER_URL: 'https://example.invalid' });
      const match = html.match(/<script>([\s\S]*?)<\/script>/);
      if (!match) throw new Error('หา generated review script ไม่เจอ');
      fs.writeFileSync(generated, match[1]);
      execFileSync(process.execPath, ['--check', generated], { stdio: 'inherit' });
    }).finally(() => {
      try { fs.unlinkSync(temp); } catch {}
      try { fs.unlinkSync(generated); } catch {}
    });
  } catch (e) {
    try { fs.unlinkSync(temp); } catch {}
    try { fs.unlinkSync(generated); } catch {}
    throw e;
  }
}

patchIndex();
patchOauth();
patchMulti();
patchBatches();
await syntaxCheck();
console.log('\n✅ LINE card + review + reimbursement duplicate lock applied');
console.log('Changed: src/index.js, src/oauth.js, src/multi-expense.js, src/batches.js');
