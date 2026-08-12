// รายรับสำหรับ SME ไทย — invoice/ขายสด + VAT + WHT + รับชำระบางส่วน
// แยก master "รายรับ" ออกจาก ledger "รับชำระ" เพื่อรองรับลูกหนี้และการรับหลายงวด

import { getAccessToken } from "./google-auth.js";
import { normalizeDate, readSettings } from "./sheets.js";
import { findPaymentChannel, channelDisplay } from "./payment-channels.js";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
export const TAB_INCOME = "รายรับ";
export const TAB_RECEIPTS = "รับชำระ";
export const INCOME_VERSION = "INCOME_SME_TH_V1_20260808";

const INCOME_SCHEMA = [
  ["A","issueDate","วันที่ขาย/ออกเอกสาร"],
  ["B","dueDate","วันครบกำหนด"],
  ["C","id","income_id"],
  ["D","customer","ลูกค้า/ผู้จ่าย"],
  ["E","customerTaxId","เลขผู้เสียภาษีลูกค้า"],
  ["F","customerBranch","สาขาลูกค้า"],
  ["G","category","ประเภทรายได้"],
  ["H","description","รายละเอียด"],
  ["I","documentType","ประเภทเอกสารขาย"],
  ["J","invoiceNo","เลขใบแจ้งหนี้/วางบิล"],
  ["K","taxInvoiceNo","เลขใบกำกับภาษี"],
  ["L","receiptNo","เลขใบเสร็จรับเงิน"],
  ["M","priceMode","รูปแบบราคา"],
  ["N","subtotal","ฐานก่อน VAT"],
  ["O","vatRate","VAT %"],
  ["P","vatAmount","VAT"],
  ["Q","grossAmount","ยอดตามเอกสาร"],
  ["R","expectedWhtRate","คาดว่าลูกค้าหัก ณ ที่จ่าย %"],
  ["S","expectedWhtAmount","คาดว่าหัก ณ ที่จ่าย"],
  ["T","expectedCash","เงินที่คาดว่าจะเข้าบัญชี"],
  ["U","cashReceived","เงินสด/เงินโอนที่รับแล้ว"],
  ["V","whtCreditReceived","เครดิตหัก ณ ที่จ่ายที่ได้รับ"],
  ["W","settledAmount","ยอดตัดลูกหนี้แล้ว"],
  ["X","outstanding","ยอดค้างรับ"],
  ["Y","status","สถานะ"],
  ["Z","lastReceivedDate","รับเงินล่าสุด"],
  ["AA","paymentChannelId","ช่องทางรับเงินล่าสุด"],
  ["AB","referenceNo","เลขอ้างอิง"],
  ["AC","attachmentUrl","เอกสาร/หลักฐาน"],
  ["AD","note","หมายเหตุ"],
  ["AE","source","แหล่งที่มา"],
  ["AF","createdAt","สร้างเมื่อ"],
  ["AG","updatedAt","แก้ไขเมื่อ"],
  ["AH","reconciliationId","รหัสกระทบยอด"],
  ["AI","reconcileStatus","สถานะกระทบยอด"],
];


export const TAB_INCOME_RECON = "กระทบยอดรายรับ";

const INCOME_RECON_SCHEMA = [
  ["A","importedAt","นำเข้าเมื่อ"],
  ["B","id","income_reconciliation_id"],
  ["C","transactionDate","วันที่ธนาคาร"],
  ["D","amount","ยอดเงินเข้า"],
  ["E","description","รายละเอียดธนาคาร"],
  ["F","reference","เลขอ้างอิงธนาคาร"],
  ["G","paymentChannelId","รหัสช่องทางรับเงิน"],
  ["H","paymentChannelLabel","ช่องทางรับเงิน"],
  ["I","sourceFile","ไฟล์ Statement"],
  ["J","fingerprint","ลายนิ้วมือรายการ"],
  ["K","status","สถานะกระทบยอด"],
  ["L","paymentId","payment_id"],
  ["M","incomeId","income_id"],
  ["N","matchScore","คะแนนจับคู่"],
  ["O","matchedAt","กระทบยอดเมื่อ"],
  ["P","matchedBy","ผู้กระทบยอด"],
  ["Q","note","หมายเหตุ"],
  ["R","rawJson","ข้อมูลต้นฉบับ"],
  ["S","updatedAt","อัปเดตล่าสุด"],
];

const PAYMENT_SCHEMA = [
  ["A","paymentId","payment_id"],
  ["B","incomeId","income_id"],
  ["C","receivedDate","วันที่รับชำระ"],
  ["D","cashAmount","เงินเข้าจริง"],
  ["E","whtAmount","หัก ณ ที่จ่าย"],
  ["F","settledAmount","ยอดตัดลูกหนี้"],
  ["G","paymentChannelId","ช่องทางรับเงิน"],
  ["H","referenceNo","เลขอ้างอิง"],
  ["I","slipUrl","หลักฐานรับเงิน"],
  ["J","whtCertificateUrl","หนังสือรับรอง 50 ทวิ"],
  ["K","note","หมายเหตุ"],
  ["L","source","แหล่งที่มา"],
  ["M","createdAt","สร้างเมื่อ"],
  ["N","reconciliationId","รหัสกระทบยอด"],
  ["O","reconcileStatus","สถานะกระทบยอด"],
];

const INC_LAST = INCOME_SCHEMA[INCOME_SCHEMA.length - 1][0];
const PAY_LAST = PAYMENT_SCHEMA[PAYMENT_SCHEMA.length - 1][0];
const RECON_LAST = INCOME_RECON_SCHEMA[INCOME_RECON_SCHEMA.length - 1][0];
const INC_COL = Object.fromEntries(INCOME_SCHEMA.map(([col,key])=>[key,col]));
const PAY_COL = Object.fromEntries(PAYMENT_SCHEMA.map(([col,key])=>[key,col]));
const RECON_COL = Object.fromEntries(INCOME_RECON_SCHEMA.map(([col,key])=>[key,col]));

export const INCOME_CATEGORIES = [
  "ขายสินค้า",
  "ค่าบริการ",
  "ค่าสมาชิก / Subscription",
  "ค่าเช่า",
  "ค่าคอมมิชชั่น / ค่านายหน้า",
  "ค่าธรรมเนียม",
  "รายได้จากโครงการ",
  "ดอกเบี้ย / รายได้ทางการเงิน",
  "รายได้อื่น",
];

function id(prefix="INC") { return `${prefix}_${crypto.randomUUID().replace(/-/g,"").slice(0,10).toUpperCase()}`; }
function clean(v,max=250){ return String(v??"").trim().slice(0,max); }
function num(v){ const n=Number(String(v??"").replace(/,/g,"")); return Number.isFinite(n)?n:0; }
function round2(v){ return Math.round((Number(v)||0)*100)/100; }
function bool(v){ return v===true || ["1","true","yes","ใช่"].includes(String(v??"").trim().toLowerCase()); }
function iso(v){ return normalizeDate(v || new Date()).iso; }
async function auth(env, token){ return token || await getAccessToken(env); }
function rangeUrl(sheetId,tab,a1,suffix=""){ return `${SHEETS}/${sheetId}/values/${encodeURIComponent(`${tab}!${a1}`)}${suffix}`; }
async function call(token,url,options={}){
  const res=await fetch(url,{...options,headers:{Authorization:`Bearer ${token}`,"content-type":"application/json",...(options.headers||{})}});
  const text=await res.text();
  if(!res.ok) throw new Error(`Sheets ${res.status}: ${text.slice(0,350)}`);
  return text?JSON.parse(text):{};
}
async function meta(token,sheetId){ return call(token,`${SHEETS}/${sheetId}?fields=sheets.properties`); }

async function ensureTab(token,sheetId,title,schema){
  const m=await meta(token,sheetId);
  const exists=(m.sheets||[]).some(s=>s.properties?.title===title);
  if(!exists){
    await call(token,`${SHEETS}/${sheetId}:batchUpdate`,{method:"POST",body:JSON.stringify({requests:[{addSheet:{properties:{title,gridProperties:{frozenRowCount:1}}}}]})});
  }
  const last=schema[schema.length-1][0];
  const headers=schema.map(([, ,header])=>header);
  await call(token,rangeUrl(sheetId,title,`A1:${last}1`,"?valueInputOption=USER_ENTERED"),{method:"PUT",body:JSON.stringify({values:[headers]})});
  return {created:!exists,tab:title};
}

export async function ensureIncomeTabs(env,sheetId,token=null){
  const t=await auth(env,token);
  const [income,payments,reconciliation]=await Promise.all([
    ensureTab(t,sheetId,TAB_INCOME,INCOME_SCHEMA),
    ensureTab(t,sheetId,TAB_RECEIPTS,PAYMENT_SCHEMA),
    ensureTab(t,sheetId,TAB_INCOME_RECON,INCOME_RECON_SCHEMA),
  ]);
  return {version:INCOME_VERSION,income,payments,reconciliation};
}

function rowObject(values,rowNo,schema){
  const out={_row:rowNo};
  schema.forEach(([,key],i)=>out[key]=values?.[i]??"");
  ["subtotal","vatRate","vatAmount","grossAmount","expectedWhtRate","expectedWhtAmount","expectedCash","cashReceived","whtCreditReceived","settledAmount","outstanding","cashAmount","whtAmount","matchScore"].forEach(k=>{if(k in out)out[k]=num(out[k]);});
  return out;
}
async function listTab(env,sheetId,token,title,schema,last,{ensure=true}={}){
  const t=await auth(env,token);
  if(ensure) await ensureIncomeTabs(env,sheetId,t);
  const data=await call(t,rangeUrl(sheetId,title,`A2:${last}`));
  return (data.values||[]).map((v,i)=>rowObject(v,i+2,schema)).filter(r=>Object.values(r).some(v=>String(v??"").trim())).reverse();
}
export async function listIncome(env,sheetId,token=null){ return listTab(env,sheetId,token,TAB_INCOME,INCOME_SCHEMA,INC_LAST); }
export async function listIncomePayments(env,sheetId,token=null){ return listTab(env,sheetId,token,TAB_RECEIPTS,PAYMENT_SCHEMA,PAY_LAST); }
export async function listIncomeReconciliationRows(env,sheetId,token=null){ return listTab(env,sheetId,token,TAB_INCOME_RECON,INCOME_RECON_SCHEMA,RECON_LAST); }

function normalizeMatchText(value){
  return String(value||"").normalize("NFKC").toLowerCase().replace(/[^0-9a-zก-๙]/gi,"");
}
function dateGapDays(a,b){
  const ta=Date.parse(`${a||""}T00:00:00Z`),tb=Date.parse(`${b||""}T00:00:00Z`);
  if(!Number.isFinite(ta)||!Number.isFinite(tb))return 9999;
  return Math.abs(Math.round((ta-tb)/86400000));
}
async function sha256Hex(value){
  const bytes=new TextEncoder().encode(String(value));
  const digest=await crypto.subtle.digest("SHA-256",bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function updateReconRows(token,sheetId,changes=[]){
  const data=[];
  for(const change of changes){
    for(const [key,value] of Object.entries(change.patch||{})){
      const col=RECON_COL[key]; if(col)data.push({range:`${TAB_INCOME_RECON}!${col}${change.row._row}`,values:[[value??""]]});
    }
  }
  if(data.length)await call(token,`${SHEETS}/${sheetId}/values:batchUpdate`,{method:"POST",body:JSON.stringify({valueInputOption:"USER_ENTERED",data})});
}
async function updatePaymentRows(token,sheetId,changes=[]){
  const data=[];
  for(const change of changes){
    for(const [key,value] of Object.entries(change.patch||{})){
      const col=PAY_COL[key]; if(col)data.push({range:`${TAB_RECEIPTS}!${col}${change.row._row}`,values:[[value??""]]});
    }
  }
  if(data.length)await call(token,`${SHEETS}/${sheetId}/values:batchUpdate`,{method:"POST",body:JSON.stringify({valueInputOption:"USER_ENTERED",data})});
}

function incomeReconSuggestion(row,payments,incomeById,unavailablePaymentIds){
  if(["กระทบยอดแล้ว","ข้าม"].includes(String(row.status||"")))return null;
  const bankText=normalizeMatchText(`${row.description||""} ${row.reference||""}`),candidates=[];
  const eligible=[];
  for(const payment of payments){
    const pid=String(payment.paymentId||"");
    if(!pid||unavailablePaymentIds.has(pid)||Number(payment.cashAmount||0)<=0)continue;
    if(String(payment.paymentChannelId||"")&&String(row.paymentChannelId||"")&&String(payment.paymentChannelId)!==String(row.paymentChannelId))continue;
    const income=incomeById.get(String(payment.incomeId||""))||{};
    eligible.push({payment,income,pid,gap:dateGapDays(row.transactionDate,payment.receivedDate)});
    const amountDiff=Math.abs(Number(payment.cashAmount||0)-Number(row.amount||0));
    if(amountDiff>0.01)continue;
    let score=60;
    if(dateGapDays(row.transactionDate,payment.receivedDate)===0)score+=30; else if(dateGapDays(row.transactionDate,payment.receivedDate)===1)score+=22; else if(dateGapDays(row.transactionDate,payment.receivedDate)===2)score+=14; else if(dateGapDays(row.transactionDate,payment.receivedDate)<=5)score+=6;
    const ref=normalizeMatchText(payment.referenceNo||"");
    if(ref&&bankText.includes(ref))score+=24;
    const customer=normalizeMatchText(income.customer||"");
    if(customer.length>=4&&bankText.includes(customer.slice(0,Math.min(customer.length,14))))score+=8;
    const invoice=normalizeMatchText(income.invoiceNo||income.taxInvoiceNo||income.receiptNo||"");
    if(invoice&&bankText.includes(invoice))score+=16;
    candidates.push({paymentId:pid,paymentIds:[pid],incomeId:payment.incomeId,incomeIds:[payment.incomeId],receivedDate:payment.receivedDate,cashAmount:Number(payment.cashAmount||0),whtAmount:Number(payment.whtAmount||0),referenceNo:payment.referenceNo||"",customer:income.customer||"",invoiceNo:income.invoiceNo||income.taxInvoiceNo||income.receiptNo||"",count:1,score,gapDays:dateGapDays(row.transactionDate,payment.receivedDate)});
  }

  // SME มักโอนครั้งเดียวเพื่อปิดหลาย Invoice: เสนอชุดรับชำระของลูกค้าคนเดียวกันในวันใกล้กัน
  // จำกัด 8 รายการ/ลูกค้าและหา combination สูงสุด 4 ใบ เพื่อไม่ให้ Worker หนักเกินไป
  const grouped=new Map();
  for(const e of eligible.filter(e=>e.gap<=3)){
    const customerKey=normalizeMatchText(e.income.customer||"")||`__${e.pid}`;
    const arr=grouped.get(customerKey)||[];arr.push(e);grouped.set(customerKey,arr);
  }
  const target=Number(row.amount||0);
  for(const arr0 of grouped.values()){
    const arr=arr0.sort((a,b)=>a.gap-b.gap).slice(0,8);
    const n=arr.length;
    const walk=(startIdx,chosen,sum)=>{
      if(chosen.length>=2&&Math.abs(sum-target)<=0.01){
        const paymentsChosen=chosen.map(i=>arr[i]);
        const customer=paymentsChosen[0]?.income?.customer||"";
        const refs=paymentsChosen.map(x=>normalizeMatchText(x.payment.referenceNo||"")).filter(Boolean);
        const invoices=paymentsChosen.map(x=>x.income.invoiceNo||x.income.taxInvoiceNo||x.income.receiptNo||"").filter(Boolean);
        let score=72;
        const maxGap=Math.max(...paymentsChosen.map(x=>x.gap));
        if(maxGap===0)score+=18;else if(maxGap===1)score+=12;else score+=6;
        if(refs.some(ref=>ref&&bankText.includes(ref)))score+=14;
        const ckey=normalizeMatchText(customer);
        if(ckey.length>=4&&bankText.includes(ckey.slice(0,Math.min(ckey.length,14))))score+=8;
        candidates.push({paymentId:paymentsChosen.map(x=>x.pid).join(","),paymentIds:paymentsChosen.map(x=>x.pid),incomeId:paymentsChosen.map(x=>x.payment.incomeId).join(","),incomeIds:paymentsChosen.map(x=>x.payment.incomeId),receivedDate:paymentsChosen.map(x=>x.payment.receivedDate).sort().at(-1)||"",cashAmount:round2(sum),whtAmount:round2(paymentsChosen.reduce((t,x)=>t+Number(x.payment.whtAmount||0),0)),referenceNo:paymentsChosen.map(x=>x.payment.referenceNo).filter(Boolean).join(" / "),customer,invoiceNo:invoices.join(" + "),count:paymentsChosen.length,score,gapDays:maxGap,grouped:true});
        return;
      }
      if(chosen.length>=4||sum>target+0.01)return;
      for(let i=startIdx;i<n;i++)walk(i+1,[...chosen,i],sum+Number(arr[i].payment.cashAmount||0));
    };
    walk(0,[],0);
  }

  candidates.sort((a,b)=>b.score-a.score||a.gapDays-b.gapDays||a.count-b.count||String(a.paymentId).localeCompare(String(b.paymentId)));
  const dedup=[],seen=new Set();
  for(const c of candidates){const key=(c.paymentIds||[c.paymentId]).slice().sort().join(",");if(seen.has(key))continue;seen.add(key);dedup.push(c);if(dedup.length>=8)break;}
  const best=dedup[0]||null,second=dedup[1]||null;
  const autoSuggested=!!best&&best.score>=84&&(!second||best.score-second.score>=8);
  return {best,candidates:dedup,autoSuggested};
}

function splitIds(value){return String(value||"").split(",").map(x=>x.trim()).filter(Boolean);}
function decorateIncomeRecon(rows,payments,incomes){
  const incomeById=new Map(incomes.map(r=>[String(r.id||""),r]));
  const paymentById=new Map(payments.map(r=>[String(r.paymentId||""),r]));
  const unavailable=new Set([
    ...rows.filter(r=>String(r.status||"")==="กระทบยอดแล้ว").flatMap(r=>splitIds(r.paymentId)),
    ...payments.filter(p=>String(p.reconcileStatus||"")==="กระทบยอดแล้ว").map(p=>String(p.paymentId||"")),
  ].filter(Boolean));
  return rows.map(row=>{
    const linkedPayments=splitIds(row.paymentId).map(id=>paymentById.get(id)).filter(Boolean).map(linked=>{
      const inc=incomeById.get(String(linked.incomeId||""));
      return {paymentId:linked.paymentId,incomeId:linked.incomeId,receivedDate:linked.receivedDate,cashAmount:Number(linked.cashAmount||0),whtAmount:Number(linked.whtAmount||0),referenceNo:linked.referenceNo||"",customer:inc?.customer||"",invoiceNo:inc?.invoiceNo||inc?.taxInvoiceNo||inc?.receiptNo||""};
    });
    const suggestion=incomeReconSuggestion(row,payments,incomeById,unavailable);
    let displayStatus=String(row.status||"").trim();
    if(!displayStatus||displayStatus==="ยังไม่จับคู่"){
      if(suggestion?.autoSuggested){displayStatus="แนะนำอัตโนมัติ";for(const pid of suggestion.best?.paymentIds||[])unavailable.add(String(pid));}
      else if(suggestion?.best)displayStatus="ต้องตรวจ";
      else displayStatus="ไม่พบคู่";
    }
    return {...row,displayStatus,linkedPayments,linkedPayment:linkedPayments[0]||null,suggestion};
  });
}

export async function importIncomeReconciliationRows(env,sheetId,payload={},token=null){
  const t=await auth(env,token);await ensureIncomeTabs(env,sheetId,t);
  const settings=await readSettings(env,sheetId,t);
  const channel=findPaymentChannel(settings,payload.paymentChannelId||payload.channelId,{activeOnly:true});
  if(!channel)return {ok:false,reason:"payment_channel_required",message:"กรุณาเลือกช่องทางรับเงินก่อนนำเข้า Statement"};
  const existing=await listTab(env,sheetId,t,TAB_INCOME_RECON,INCOME_RECON_SCHEMA,RECON_LAST,{ensure:false});
  const fingerprints=new Set(existing.map(r=>String(r.fingerprint||"")).filter(Boolean));
  const rows=Array.isArray(payload.rows)?payload.rows.slice(0,5000):[],sourceFile=clean(payload.fileName||"statement",180),now=new Date().toISOString();
  const values=[];let skippedInvalid=0,skippedOutgoing=0,skippedDuplicate=0;
  for(const input of rows){
    const transactionDate=input.transactionDate?iso(input.transactionDate):"";
    const amount=Math.abs(num(input.amount??input.credit??input.deposit));
    const direction=clean(input.direction||"เงินเข้า",30);
    if(!transactionDate||!(amount>0)){skippedInvalid++;continue;}
    if(/เงินออก|debit|withdraw|จ่ายออก/i.test(direction)){skippedOutgoing++;continue;}
    const description=clean(input.description||input.detail||input.memo,300),reference=clean(input.reference||input.ref,180);
    const identity=[transactionDate,amount.toFixed(2),normalizeMatchText(description),normalizeMatchText(reference),channel.id];
    if(!normalizeMatchText(reference))identity.push(normalizeMatchText(sourceFile),String(input.raw?.row||""));
    const fingerprint=await sha256Hex(identity.join("|"));
    if(fingerprints.has(fingerprint)){skippedDuplicate++;continue;}
    fingerprints.add(fingerprint);
    const rec={importedAt:now,id:id("IR"),transactionDate,amount,description,reference,paymentChannelId:channel.id,paymentChannelLabel:channelDisplay(channel),sourceFile,fingerprint,status:"ยังไม่จับคู่",paymentId:"",incomeId:"",matchScore:"",matchedAt:"",matchedBy:"",note:"",rawJson:JSON.stringify(input.raw&&typeof input.raw==="object"?input.raw:input),updatedAt:now};
    values.push(INCOME_RECON_SCHEMA.map(([,key])=>rec[key]??""));
  }
  if(values.length)await call(t,rangeUrl(sheetId,TAB_INCOME_RECON,`A:${RECON_LAST}`,":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"),{method:"POST",body:JSON.stringify({values})});
  return {ok:true,imported:values.length,skippedInvalid,skippedOutgoing,skippedDuplicate,paymentChannelId:channel.id,paymentChannelLabel:channelDisplay(channel),sourceFile};
}

export async function confirmIncomeReconciliationMatches(env,sheetId,payload={},token=null){
  const t=await auth(env,token);await ensureIncomeTabs(env,sheetId,t);
  const pairs=Array.isArray(payload.pairs)?payload.pairs.slice(0,500):[payload];
  const [rows,payments,incomes]=await Promise.all([
    listTab(env,sheetId,t,TAB_INCOME_RECON,INCOME_RECON_SCHEMA,RECON_LAST,{ensure:false}),
    listTab(env,sheetId,t,TAB_RECEIPTS,PAYMENT_SCHEMA,PAY_LAST,{ensure:false}),
    listTab(env,sheetId,t,TAB_INCOME,INCOME_SCHEMA,INC_LAST,{ensure:false}),
  ]);
  const decorated=decorateIncomeRecon(rows,payments,incomes),rowById=new Map(decorated.map(r=>[String(r.id||""),r])),paymentById=new Map(payments.map(p=>[String(p.paymentId||""),p]));
  const usedRows=new Set(),usedPayments=new Set(),valid=[],errors=[];
  for(const pair of pairs){
    const rid=String(pair.reconciliationId||pair.id||"");
    const paymentIds=Array.isArray(pair.paymentIds)?pair.paymentIds.map(String).filter(Boolean):splitIds(pair.paymentId||"");
    const row=rowById.get(rid),selected=paymentIds.map(pid=>paymentById.get(pid)).filter(Boolean);
    if(!row||!paymentIds.length||selected.length!==paymentIds.length){errors.push({reconciliationId:rid,paymentIds,reason:"not_found"});continue;}
    if(usedRows.has(rid)||paymentIds.some(pid=>usedPayments.has(pid))){errors.push({reconciliationId:rid,paymentIds,reason:"duplicate_pair"});continue;}
    if(String(row.status||"")==="กระทบยอดแล้ว"||selected.some(p=>String(p.reconcileStatus||"")==="กระทบยอดแล้ว")){errors.push({reconciliationId:rid,paymentIds,reason:"already_reconciled"});continue;}
    if(selected.some(p=>String(row.paymentChannelId||"")&&String(p.paymentChannelId||"")&&String(row.paymentChannelId)!==String(p.paymentChannelId))){errors.push({reconciliationId:rid,paymentIds,reason:"payment_channel_mismatch"});continue;}
    const sumCash=round2(selected.reduce((sum,p)=>sum+Number(p.cashAmount||0),0));
    const diff=Math.abs(Number(row.amount||0)-sumCash);
    if(payload.force!==true&&diff>0.01){errors.push({reconciliationId:rid,paymentIds,reason:"amount_mismatch",amountDiff:diff});continue;}
    usedRows.add(rid);for(const pid of paymentIds)usedPayments.add(pid);
    valid.push({row,payments:selected,paymentIds,score:Number(pair.score||100),note:clean(pair.note,250),sumCash});
  }
  if(!valid.length)return {ok:false,reason:"no_valid_matches",errors};
  const now=new Date().toISOString(),matchedBy=clean(payload.matchedBy||"Dashboard",120)||"Dashboard";
  await updatePaymentRows(t,sheetId,valid.flatMap(({row,payments})=>payments.map(payment=>({row:payment,patch:{reconciliationId:row.id,reconcileStatus:"กระทบยอดแล้ว",paymentChannelId:payment.paymentChannelId||row.paymentChannelId||""}}))));
  try{
    await updateReconRows(t,sheetId,valid.map(({row,payments,paymentIds,score,note})=>({row,patch:{status:"กระทบยอดแล้ว",paymentId:paymentIds.join(","),incomeId:[...new Set(payments.map(p=>String(p.incomeId||"")).filter(Boolean))].join(","),matchScore:score,matchedAt:now,matchedBy,note,updatedAt:now}})));
  }catch(error){
    await updatePaymentRows(t,sheetId,valid.flatMap(({payments})=>payments.map(payment=>({row:payment,patch:{reconciliationId:"",reconcileStatus:""}})))).catch(()=>{});
    throw error;
  }
  return {ok:true,confirmed:valid.length,paymentsConfirmed:valid.reduce((n,v)=>n+v.paymentIds.length,0),errors};
}

export async function ignoreIncomeReconciliationRow(env,sheetId,reconciliationId,note="",token=null){
  const t=await auth(env,token);const rows=await listTab(env,sheetId,t,TAB_INCOME_RECON,INCOME_RECON_SCHEMA,RECON_LAST,{ensure:true});
  const row=rows.find(r=>String(r.id||"")===String(reconciliationId||""));
  if(!row)return {ok:false,reason:"not_found",message:"ไม่พบรายการเงินเข้า"};
  if(String(row.status||"")==="กระทบยอดแล้ว")return {ok:false,reason:"already_reconciled",message:"รายการนี้กระทบยอดแล้ว กรุณายกเลิกการจับคู่ก่อน"};
  await updateReconRows(t,sheetId,[{row,patch:{status:"ข้าม",note:clean(note,250),updatedAt:new Date().toISOString()}}]);
  return {ok:true};
}

export async function unlinkIncomeReconciliation(env,sheetId,reconciliationId,token=null){
  const t=await auth(env,token);const [rows,payments]=await Promise.all([
    listTab(env,sheetId,t,TAB_INCOME_RECON,INCOME_RECON_SCHEMA,RECON_LAST,{ensure:true}),
    listTab(env,sheetId,t,TAB_RECEIPTS,PAYMENT_SCHEMA,PAY_LAST,{ensure:false}),
  ]);
  const row=rows.find(r=>String(r.id||"")===String(reconciliationId||""));
  if(!row)return {ok:false,reason:"not_found",message:"ไม่พบรายการเงินเข้า"};
  const linked=splitIds(row.paymentId).map(pid=>payments.find(p=>String(p.paymentId||"")===pid)).filter(Boolean);
  if(linked.length)await updatePaymentRows(t,sheetId,linked.map(payment=>({row:payment,patch:{reconciliationId:"",reconcileStatus:""}})));
  await updateReconRows(t,sheetId,[{row,patch:{status:"ยังไม่จับคู่",paymentId:"",incomeId:"",matchScore:"",matchedAt:"",matchedBy:"",note:"",updatedAt:new Date().toISOString()}}]);
  return {ok:true};
}


function calcAmounts(input={}){
  const mode=clean(input.priceMode||"no_vat",30);
  const rate=Math.max(0,num(input.vatRate||0));
  const entered=Math.max(0,num(input.amount ?? input.grossAmount ?? input.subtotal));
  let subtotal=0,vatAmount=0,grossAmount=0;
  if(mode==="exclusive" && rate>0){ subtotal=entered; vatAmount=entered*rate/100; grossAmount=subtotal+vatAmount; }
  else if(mode==="inclusive" && rate>0){ grossAmount=entered; subtotal=grossAmount/(1+rate/100); vatAmount=grossAmount-subtotal; }
  else { subtotal=entered; grossAmount=entered; vatAmount=0; }
  subtotal=round2(subtotal); vatAmount=round2(vatAmount); grossAmount=round2(grossAmount);
  const whtRate=Math.max(0,num(input.expectedWhtRate ?? input.whtRate));
  const expectedWhtAmount=round2(whtRate>0?subtotal*whtRate/100:0);
  const expectedCash=round2(Math.max(0,grossAmount-expectedWhtAmount));
  return {priceMode:rate>0?mode:"no_vat",subtotal,vatRate:rate,vatAmount,grossAmount,expectedWhtRate:whtRate,expectedWhtAmount,expectedCash};
}

function statusOf(gross,settled,current=""){
  if(current==="ยกเลิก") return "ยกเลิก";
  if(!(gross>0)) return "รอตรวจ";
  if(settled<=0.009) return "รอรับเงิน";
  if(settled+0.009<gross) return "รับบางส่วน";
  return "รับครบแล้ว";
}
function incomeValues(data){ return INCOME_SCHEMA.map(([,key])=>data[key]??""); }
function paymentValues(data){ return PAYMENT_SCHEMA.map(([,key])=>data[key]??""); }

export async function createIncome(env,sheetId,payload={},token=null){
  const t=await auth(env,token); await ensureIncomeTabs(env,sheetId,t);
  const amounts=calcAmounts(payload);
  if(!(amounts.grossAmount>0)) return {ok:false,reason:"amount_required",message:"กรุณาระบุยอดรายรับ"};
  const initial=payload.initialPayment&&typeof payload.initialPayment==="object"?payload.initialPayment:null;
  if(initial){
    const initialSettled=round2(Math.max(0,num(initial.cashAmount))+Math.max(0,num(initial.whtAmount)));
    if(initialSettled>amounts.grossAmount+0.01)return {ok:false,reason:"overpayment",message:"ยอดรับชำระเริ่มต้นมากกว่ายอดตามเอกสาร กรุณาตรวจเงินเข้าจริงและยอดหัก ณ ที่จ่าย"};
  }
  const refs={invoiceNo:clean(payload.invoiceNo,80),taxInvoiceNo:clean(payload.taxInvoiceNo,80),receiptNo:clean(payload.receiptNo,80)};
  if(Object.values(refs).some(Boolean)){
    const existing=await listTab(env,sheetId,t,TAB_INCOME,INCOME_SCHEMA,INC_LAST,{ensure:false});
    const duplicate=existing.find(r=>r.status!=="ยกเลิก"&&Object.entries(refs).some(([key,value])=>value&&String(r[key]||"").trim()===value));
    if(duplicate)return {ok:false,reason:"duplicate_document",message:`เลขเอกสารนี้ถูกบันทึกแล้วในรายการ ${duplicate.id}`};
  }
  const now=new Date().toISOString();
  const rec={
    issueDate:iso(payload.issueDate||payload.date), dueDate:payload.dueDate?iso(payload.dueDate):"",
    id:id("INC"), customer:clean(payload.customer||payload.payer||"ลูกค้าทั่วไป",180),
    customerTaxId:clean(payload.customerTaxId,30).replace(/\D/g,""), customerBranch:clean(payload.customerBranch||"สำนักงานใหญ่",80),
    category:INCOME_CATEGORIES.includes(payload.category)?payload.category:"รายได้อื่น", description:clean(payload.description||payload.note,300),
    documentType:clean(payload.documentType||"รายรับทั่วไป",80), invoiceNo:clean(payload.invoiceNo,80), taxInvoiceNo:clean(payload.taxInvoiceNo,80), receiptNo:clean(payload.receiptNo,80),
    ...amounts, cashReceived:0,whtCreditReceived:0,settledAmount:0,outstanding:amounts.grossAmount,status:"รอรับเงิน",
    lastReceivedDate:"",paymentChannelId:"",referenceNo:clean(payload.referenceNo,120),attachmentUrl:clean(payload.attachmentUrl,1000),note:clean(payload.note,500),
    source:clean(payload.source||"Dashboard",60),createdAt:now,updatedAt:now,reconciliationId:"",reconcileStatus:"",
  };
  await call(t,rangeUrl(sheetId,TAB_INCOME,`A:${INC_LAST}`,":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"),{method:"POST",body:JSON.stringify({values:[incomeValues(rec)]})});
  let payment=null;
  if(initial && (num(initial.cashAmount)>0 || num(initial.whtAmount)>0)) payment=await addIncomePayment(env,sheetId,rec.id,initial,t);
  return {ok:true,record:payment?.record||rec,payment:payment?.payment||null,version:INCOME_VERSION};
}

async function findIncomeRow(env,sheetId,incomeId,token){
  const rows=await listIncome(env,sheetId,token);
  return rows.find(r=>String(r.id)===String(incomeId))||null;
}
async function updateIncomeRow(token,sheetId,row,patch){
  const data=[];
  for(const [key,value] of Object.entries(patch)){ const col=INC_COL[key]; if(col)data.push({range:`${TAB_INCOME}!${col}${row._row}`,values:[[value??""]]}); }
  if(data.length) await call(token,`${SHEETS}/${sheetId}/values:batchUpdate`,{method:"POST",body:JSON.stringify({valueInputOption:"USER_ENTERED",data})});
}

export async function updateIncome(env,sheetId,incomeId,patch={},token=null){
  const t=await auth(env,token); const row=await findIncomeRow(env,sheetId,incomeId,t);
  if(!row)return {ok:false,reason:"not_found",message:"ไม่พบรายการรายรับ"};
  const editable={customer:180,customerTaxId:30,customerBranch:80,category:80,description:300,documentType:80,invoiceNo:80,taxInvoiceNo:80,receiptNo:80,dueDate:20,referenceNo:120,attachmentUrl:1000,note:500};
  const out={updatedAt:new Date().toISOString()};
  Object.entries(editable).forEach(([k,m])=>{if(k in patch)out[k]=k==="dueDate"?(patch[k]?iso(patch[k]):""):clean(patch[k],m);});
  if(patch.status==="ยกเลิก"){
    if(num(row.settledAmount)>0.009)return {ok:false,reason:"has_payment",message:"รายการนี้มีการรับชำระแล้ว จึงไม่ควรยกเลิกตรง ๆ กรุณาปรับปรุงด้วยเอกสารลดหนี้/คืนเงินตามขั้นตอนบัญชี"};
    out.status="ยกเลิก";
  }
  await updateIncomeRow(t,sheetId,row,out);
  return {ok:true,record:{...row,...out}};
}

export async function addIncomePayment(env,sheetId,incomeId,payload={},token=null){
  const t=await auth(env,token); await ensureIncomeTabs(env,sheetId,t);
  const row=await findIncomeRow(env,sheetId,incomeId,t);
  if(!row)return {ok:false,reason:"not_found",message:"ไม่พบรายการรายรับ"};
  if(row.status==="ยกเลิก")return {ok:false,reason:"cancelled",message:"รายการนี้ถูกยกเลิกแล้ว"};
  const cash=round2(Math.max(0,num(payload.cashAmount??payload.amount)));
  const wht=round2(Math.max(0,num(payload.whtAmount)));
  if(!(cash>0||wht>0))return {ok:false,reason:"payment_required",message:"กรุณาระบุเงินเข้าจริงหรือยอดหัก ณ ที่จ่าย"};
  const settled=round2(cash+wht),now=new Date().toISOString();
  const outstandingBefore=Math.max(0,num(row.outstanding));
  if(settled>outstandingBefore+0.01){
    return {ok:false,reason:"overpayment",message:`ยอดตัดลูกหนี้ ${settled.toFixed(2)} บาท มากกว่ายอดค้าง ${outstandingBefore.toFixed(2)} บาท กรุณาแยกเงินเกินเป็นเงินรับล่วงหน้า/รายการใหม่`};
  }
  const p={paymentId:id("PAY"),incomeId:row.id,receivedDate:iso(payload.receivedDate||new Date()),cashAmount:cash,whtAmount:wht,settledAmount:settled,
    paymentChannelId:clean(payload.paymentChannelId,100),referenceNo:clean(payload.referenceNo,120),slipUrl:clean(payload.slipUrl,1000),whtCertificateUrl:clean(payload.whtCertificateUrl,1000),
    note:clean(payload.note,300),source:clean(payload.source||"Dashboard",60),createdAt:now,reconciliationId:clean(payload.reconciliationId,120),reconcileStatus:clean(payload.reconcileStatus,80)};
  await call(t,rangeUrl(sheetId,TAB_RECEIPTS,`A:${PAY_LAST}`,":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS"),{method:"POST",body:JSON.stringify({values:[paymentValues(p)]})});
  const cashReceived=round2(num(row.cashReceived)+cash),whtCreditReceived=round2(num(row.whtCreditReceived)+wht),settledAmount=round2(cashReceived+whtCreditReceived),outstanding=round2(Math.max(0,num(row.grossAmount)-settledAmount));
  const patch={cashReceived,whtCreditReceived,settledAmount,outstanding,status:statusOf(num(row.grossAmount),settledAmount,row.status),lastReceivedDate:p.receivedDate,
    paymentChannelId:p.paymentChannelId||row.paymentChannelId||"",updatedAt:now};
  await updateIncomeRow(t,sheetId,row,patch);
  return {ok:true,payment:p,record:{...row,...patch},version:INCOME_VERSION};
}


export async function updateIncomePayment(env,sheetId,paymentId,patch={},token=null){
  const t=await auth(env,token);
  const rows=await listIncomePayments(env,sheetId,t);
  const row=rows.find(r=>String(r.paymentId)===String(paymentId));
  if(!row)return {ok:false,reason:"not_found",message:"ไม่พบรายการรับชำระ"};
  const allowed={slipUrl:1000,whtCertificateUrl:1000,note:300,referenceNo:120};
  const data=[],out={};
  for(const [key,max] of Object.entries(allowed)){
    if(!(key in patch))continue;
    const value=clean(patch[key],max); out[key]=value;
    data.push({range:`${TAB_RECEIPTS}!${PAY_COL[key]}${row._row}`,values:[[value]]});
  }
  if(data.length)await call(t,`${SHEETS}/${sheetId}/values:batchUpdate`,{method:"POST",body:JSON.stringify({valueInputOption:"USER_ENTERED",data})});
  return {ok:true,payment:{...row,...out}};
}

export async function getIncomeDashboard(env,sheetId,token=null){
  const t=await auth(env,token);
  await ensureIncomeTabs(env,sheetId,t);
  const [records,payments,reconRows]=await Promise.all([
    listTab(env,sheetId,t,TAB_INCOME,INCOME_SCHEMA,INC_LAST,{ensure:false}),
    listTab(env,sheetId,t,TAB_RECEIPTS,PAYMENT_SCHEMA,PAY_LAST,{ensure:false}),
    listTab(env,sheetId,t,TAB_INCOME_RECON,INCOME_RECON_SCHEMA,RECON_LAST,{ensure:false}),
  ]);
  const active=records.filter(r=>r.status!=="ยกเลิก");
  const total=(rows,key)=>round2(rows.reduce((s,r)=>s+num(r[key]),0));
  const today=new Date().toISOString().slice(0,10);
  const overdue=active.filter(r=>r.outstanding>0.009 && r.dueDate && r.dueDate<today);
  const reconciliation=decorateIncomeRecon(reconRows,payments,records);
  const reconCount=(status)=>reconciliation.filter(r=>r.displayStatus===status).length;
  const unreconciledPayments=payments.filter(p=>Number(p.cashAmount||0)>0&&String(p.reconcileStatus||"")!=="กระทบยอดแล้ว");
  return {ok:true,version:INCOME_VERSION,categories:INCOME_CATEGORIES,records,payments,reconciliation,reconciliationSummary:{
    statementRows:reconciliation.length,suggested:reconCount("แนะนำอัตโนมัติ"),review:reconCount("ต้องตรวจ"),unmatched:reconCount("ไม่พบคู่"),reconciled:reconCount("กระทบยอดแล้ว"),ignored:reconCount("ข้าม"),unreconciledPayments:unreconciledPayments.length,unreconciledCash:total(unreconciledPayments,"cashAmount")
  },summary:{
    gross:total(active,"grossAmount"),cashReceived:total(active,"cashReceived"),whtCredit:total(active,"whtCreditReceived"),outstanding:total(active,"outstanding"),vatSales:total(active,"vatAmount"),
    count:active.length,waiting:active.filter(r=>["รอรับเงิน","รับบางส่วน"].includes(r.status)).length,paid:active.filter(r=>r.status==="รับครบแล้ว").length,overdue:overdue.length,overdueAmount:total(overdue,"outstanding")
  }};
}

export async function createIncomeFromOcr(env,sheetId,record={},meta={},token=null){
  const amount=Math.max(0,num(record.amount));
  const vatRate=record.vat===true?num(record.vatRate):0;
  const priceMode=record.vat===true&&vatRate>0?"inclusive":"no_vat";
  const expectedWhtRate=Math.max(0,num(record.whtRate));
  const docType=clean(record.docType||"หลักฐานรับเงิน",80);
  const hasPaymentEvidence=record.hasPaymentEvidence===true || /สลิป|payment|transfer|หลักฐานรับเงิน/i.test(docType);
  const cashFromSlip=Math.max(0,num(record.paymentAmount||record.payAmount||(hasPaymentEvidence?amount:0)));
  let actualWht=0;
  if(hasPaymentEvidence && expectedWhtRate>0 && amount>cashFromSlip){
    const base=priceMode==="inclusive"&&vatRate>0?amount/(1+vatRate/100):amount;
    const expected=round2(base*expectedWhtRate/100);
    const difference=round2(amount-cashFromSlip);
    // อนุมาน WHT เฉพาะเมื่อส่วนต่างใกล้กับยอดตามอัตราที่ OCR อ่านได้เท่านั้น
    if(Math.abs(difference-expected)<=Math.max(1,expected*0.02)) actualWht=difference;
  }
  const customer=record.transferor||record.vendor||meta.customer||"ลูกค้าทั่วไป";
  const payload={
    issueDate:record.date||new Date(),dueDate:"",customer,category:INCOME_CATEGORIES.includes(record.category)?record.category:"รายได้อื่น",
    description:record.note||"รายรับจาก LINE",documentType:docType,amount,
    priceMode,vatRate,expectedWhtRate,
    referenceNo:record.referenceNo||"",attachmentUrl:meta.driveLink||record.imageUrl||"",source:"LINE_AI",
  };
  if(hasPaymentEvidence && (cashFromSlip>0 || actualWht>0)){
    payload.initialPayment={cashAmount:cashFromSlip,whtAmount:actualWht,receivedDate:record.date||new Date(),paymentChannelId:meta.paymentChannelId||"",referenceNo:record.referenceNo||"",slipUrl:meta.driveLink||record.imageUrl||"",source:"LINE_AI"};
  }
  return createIncome(env,sheetId,payload,token);
}
