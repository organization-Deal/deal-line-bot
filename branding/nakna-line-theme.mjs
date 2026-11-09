/* Nakna Accounting Flex output theme. No access tokens, IDs, URLs or action payloads are changed. */
export const RELEASE='NAKNA-ACCOUNTING-LINE-1.1.0';
export const PALETTE=Object.freeze({primary:'#04878A',heading:'#153C45',text:'#20373E',muted:'#5C7178',soft:'#E8F5F5',line:'#CCDADD',white:'#FFFFFF'});
const dark=new Set(['#11162E','#20294F','#080B1A','#101828','#1D1D1F','#111827','#111111','#1C1F24','#171719','#39405A']);
const accents=new Set(['#4F46E5','#4338CA','#3730A3','#6366F1','#5B5FEF','#0071E3','#2563EB']);
const soft=new Set(['#F0F2F8','#EEF2FF','#EDE9FE']);
const muted=new Set(['#667085','#98A2B3','#8C8C8C','#86868B','#6E6E73']);
function nodeTheme(value){
  if(Array.isArray(value))return value.map(nodeTheme);
  if(!value||typeof value!=='object')return value;
  const n={};
  for(const [key,val] of Object.entries(value)){
    // Critical: preserve actions verbatim, including signed dashboard links and postback data.
    n[key]=key==='action'?structuredClone(val):nodeTheme(val);
  }
  if(typeof n.color==='string'){
    const c=n.color.toUpperCase();
    if(dark.has(c))n.color=PALETTE.heading;
    else if(accents.has(c))n.color=PALETTE.primary;
    else if(muted.has(c))n.color=PALETTE.muted;
  }
  if(n.type==='button'){
    const label=String(n.action?.label||'');
    const destructive=/ลบ|ไม่อนุมัติ|ปฏิเสธ|ยกเลิก/i.test(label);
    if(n.style==='primary')n.color=destructive?'#B43E40':PALETTE.primary;
    if(n.style==='link'&&!destructive)n.color=PALETTE.primary;
  }
  for(const key of ['backgroundColor','borderColor','separatorColor']){
    if(typeof n[key]!=='string')continue;
    const c=n[key].toUpperCase();
    if(soft.has(c)||dark.has(c)||accents.has(c))n[key]=key==='backgroundColor'?PALETTE.soft:PALETTE.line;
  }
  if(n.type==='text'){
    if(n.text==='📊 สรุปบัญชีของคุณ'||n.text==='สรุปบัญชีของคุณ')n.text='สรุปบัญชีของคุณ';
    // Never rewrite company/user labels; product identification is provided by a separate header.
  }
  if(n.type==='bubble'&&!n.header){
    n.header={type:'box',layout:'vertical',paddingAll:'16px',backgroundColor:PALETTE.soft,contents:[{type:'text',text:'นากนะ บัญชี',color:PALETTE.primary,weight:'bold',size:'sm',wrap:true}]};
  }
  return n;
}
export function naknaAccountingMessages(input){
  const arr=Array.isArray(input)?input:[input];
  return arr.map(message=>{
    if(!message||message.type!=='flex')return message;
    const result={...message,contents:nodeTheme(message.contents)};
    if(!String(result.altText||'').startsWith('นากนะ บัญชี'))result.altText=Array.from('นากนะ บัญชี · '+(result.altText||'แจ้งเตือน')).slice(0,400).join('');
    return result;
  });
}
