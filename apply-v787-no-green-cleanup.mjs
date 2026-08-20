import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const srcRoot = path.join(root,'src');
const MARK = 'RUBJAI_NAVY_CLEANUP_V787_20260820';
const NAVY = '#11162E';
const NAVY_HOVER = '#20294F';
const NAVY_SOFT = '#F0F2F8';
const NAVY_LINE = '#D9DEEA';
const FORBIDDEN = ['#30D158','#248A3D','#18794E','#147A36','#39705A','#34C759','#DFF3E4','#EDF8EF','#EDF8F0','#EAF7EF','#E9F7EE','#F0F8F2','#BAD6C0','#4F46E5','#4338CA','#0071E3','#3B82F6','#8B5CF6'];
if(!fs.existsSync(srcRoot)) throw new Error('v7.87 missing src/');

const files=[]; const exts=new Set(['.js','.mjs','.css','.html']);
(function walk(dir){ for(const ent of fs.readdirSync(dir,{withFileTypes:true})){ const full=path.join(dir,ent.name); if(ent.isDirectory()) walk(full); else if(exts.has(path.extname(ent.name).toLowerCase())) files.push(full); } })(srcRoot);

function replaceHexToken(text, from, to){ const escaped=from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); return text.replace(new RegExp(`${escaped}(?![0-9A-Fa-f])`, 'gi'), to); }
function recolor(text){
  const map = new Map([
    ['#30D158',NAVY],['#248A3D',NAVY],['#18794E',NAVY],['#147A36',NAVY],['#39705A',NAVY],['#34C759',NAVY],
    ['#DFF3E4',NAVY_SOFT],['#EDF8EF',NAVY_SOFT],['#EDF8F0',NAVY_SOFT],['#EAF7EF',NAVY_SOFT],['#E9F7EE',NAVY_SOFT],['#F0F8F2',NAVY_SOFT],['#BAD6C0',NAVY_LINE],
    ['#4F46E5',NAVY],['#4338CA',NAVY_HOVER],['#3730A3','#080B1A'],['#6366F1',NAVY],['#5B5FEF',NAVY],['#5850EC',NAVY],['#5D5FEF',NAVY],['#6C63FF',NAVY],['#5548E8',NAVY],['#7C3AED',NAVY],['#6D28D9',NAVY],['#8B5CF6',NAVY],['#0071E3',NAVY],['#3B82F6',NAVY],['#2563EB',NAVY],['#4B46C4',NAVY],['#EEF2FF',NAVY_SOFT],['#EDE9FE',NAVY_SOFT],['#F0F7FF',NAVY_SOFT],['#EAF1FF',NAVY_SOFT],['#DBEAFE',NAVY_SOFT],['#C7D2FE',NAVY_LINE],['#A5B4FC','#B8C0D1'],
    ['#101828',NAVY],['#1D1D1F',NAVY],['#111827',NAVY],['#111111',NAVY],['#1C1F24',NAVY],['#171719',NAVY],['#000000','#080B1A'],['#344054','#39405A'],['#3A3A3C','#39405A'],['#6E6E73','#667085'],['#86868B','#98A2B3'],['#AEAEB2','#98A2B3'],['#D2D2D7','#D9DEE8'],['#E5E5EA','#E4E7EC']
  ]);
  for(const [from,to] of map) text = replaceHexToken(text,from,to);
  text = text
    .replace(/rgba?\(\s*48\s*,\s*209\s*,\s*88\b/gi, m=>m.replace(/48\s*,\s*209\s*,\s*88/i,'17,22,46'))
    .replace(/rgba?\(\s*36\s*,\s*138\s*,\s*61\b/gi, m=>m.replace(/36\s*,\s*138\s*,\s*61/i,'17,22,46'))
    .replace(/rgba?\(\s*79\s*,\s*70\s*,\s*229\b/gi, m=>m.replace(/79\s*,\s*70\s*,\s*229/i,'17,22,46'))
    .replace(/rgba?\(\s*67\s*,\s*56\s*,\s*202\b/gi, m=>m.replace(/67\s*,\s*56\s*,\s*202/i,'32,41,79'));

  // card palette constants
  text = text.replace(/green\s*:\s*['\"]#[0-9A-Fa-f]{6}['\"]/g, "green: '#11162E'")
             .replace(/tintGreen\s*:\s*['\"]#[0-9A-Fa-f]{6}['\"]/g, "tintGreen: '#F0F2F8'")
             .replace(/blue\s*:\s*['\"]#[0-9A-Fa-f]{6}['\"]/g, "blue: '#11162E'")
             .replace(/tintBlue\s*:\s*['\"]#[0-9A-Fa-f]{6}['\"]/g, "tintBlue: '#F0F2F8'");
  text = text.replace(/C\.green\b/g, '"#11162E"').replace(/C\.tintGreen\b/g, '"#F0F2F8"').replace(/C\.blue\b/g, '"#11162E"').replace(/C\.tintBlue\b/g, '"#F0F2F8"');

  // connected / success copy colors in json-like objects
  text = text.replace(/(backgroundColor\s*:\s*)['\"]#F0F8F2['\"]/gi, '$1"#F0F2F8"')
             .replace(/(color\s*:\s*)['\"]#248A3D['\"]/gi, '$1"#11162E"');
  return text;
}

let changed=[];
for(const file of files){
  let src=fs.readFileSync(file,'utf8'); const before=src; src=recolor(src);
  if(src!==before){fs.writeFileSync(file,src);changed.push(path.relative(root,file));}
}

const mobile = path.join(srcRoot,'mobile-web-ux.js');
if(fs.existsSync(mobile)){
  let src = fs.readFileSync(mobile,'utf8');
  if(!src.includes('RUBJAI_NOGREEN_WEB_LOCK_V787')){
    const css = `
/* RUBJAI_NOGREEN_WEB_LOCK_V787 */
:root{--green:#11162E!important;--green2:#F0F2F8!important;--success:#11162E!important;}
.ai-badge,.ai-chip,.ai-pill,.ai-tag,[data-ai-badge],[data-ai-chip],[data-ai="true"]{background:#F0F2F8!important;color:#11162E!important;border-color:#D9DEEA!important}
.ok,.status-ok,.connected,.badge.ok,.chip.ok,.pill.ok{background:#F0F2F8!important;color:#11162E!important;border-color:#D9DEEA!important}
.ok .dot,.status-ok .dot,.connected .dot,.chip.ok:before{background:#11162E!important;box-shadow:0 0 0 3px rgba(17,22,46,.09)!important}
button[type="submit"],input[type="submit"],.primary,.btn-primary,.deal-auto-line-button{background:#11162E!important;border-color:#11162E!important;color:#fff!important}
button[type="submit"]:hover,.primary:hover,.btn-primary:hover{background:#20294F!important;border-color:#20294F!important}
#dealMobileBusy .deal-spinner{border-color:#E4E7EC!important;border-top-color:#11162E!important;border-right-color:#D9DEEA!important}
#dealMobileBusy .deal-progress i{background:#11162E!important}
`;
    const p = /(<style id=["']rubjai-ci-web-theme-v785["']>[\s\S]*?)(<\/style>)/;
    if(p.test(src)) src = src.replace(p, `$1\n${css}\n$2`);
    else src += `\nconst RUBJAI_NOGREEN_WEB_LOCK_V787 = String.raw\`${css}\`;\n`;
    fs.writeFileSync(mobile,src);
    if(!changed.includes('src/mobile-web-ux.js')) changed.push('src/mobile-web-ux.js');
  }
}

for(const file of files.filter(f=>['.js','.mjs'].includes(path.extname(f).toLowerCase()))) execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
let remaining=[];
for(const file of files){ const src=fs.readFileSync(file,'utf8'); for(const hex of FORBIDDEN){ if(src.toUpperCase().includes(hex.toUpperCase())) remaining.push(`${path.relative(root,file)}:${hex}`); } }
if(remaining.length) throw new Error(`v7.87 audit failed -> ${remaining.slice(0,35).join(', ')}`);
console.log(`✅ ${MARK}`); console.log(`✅ Runtime src files recolored: ${changed.length}`); console.log('✅ No green / purple / blue brand accents remain in LINE runtime');
