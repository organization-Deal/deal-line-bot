// DEAL LINE Finance Bot — v1.3
// ถ่ายบิลลง LINE → OCR → ยืนยัน → เขียนชีท (+เก็บรูป) → dashboard
//
// เปลี่ยนจาก v1.2:
//   • flag ตั้งค่าผูกกับ sheetId ด้วย (setup:{tenant}:{sheetId}) — ชีทเปลี่ยน flag เก่าใช้ไม่ได้ทันที
//   • อ่านตั้งค่าไม่ได้ = ให้ปุ่มเพิ่มข้อมูลบริษัทขึ้น ไม่เงียบ
//   • ล้าง flag ทั้งแบบเก่าและแบบผูก sheetId ตอนบันทึกตั้งค่า / migrate

import { verifySignature, getMessageContent, reply, push, textMsg, confirmCard, savedCard, moreCard } from "./line.js";
import { pilotPage, savePilotRequest, pilotHealth } from "./pilot-public.js"; // PUBLIC_PILOT_ROUTE_V7_71_20260817
import { ocrReceipt, EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "./ocr.js";
import { AI_DOCUMENT_LIMITS, getAiQuotaState, consumeAiDocument, readAiDocumentCache, writeAiDocumentCache, unwrapAiDocumentCache } from "./ai-quota.js";
import {
  appendExpense, readExpenses, getExpenseById, updateExpenseById,
  togglePaid, toggleNeedSlip, softDeleteById, listForSlip, normalizeDate,
  ensureHeaders, backfillIds, readSettings, writeSettings, ensureSettingsTab,
  addAttachment, removeAttachment, usedFileIds, ATTACH_TYPES, findDuplicateExpenses,
} from "./sheets.js";
import { uploadTenantImage, listUploadedImages } from "./drive.js";
import {
  ensureTenantDriveFolders, folderIdForCategory, tenantDriveFolderUrl, organizeTenantReferencedFiles,
} from "./drive-folders.js";
import { createExpenseDocuments } from "./documents.js";
import {
  handleIncomingEmail, getEmailInboxInfo, rotateEmailInbox, listEmailDocuments,
  listSubscriptions, approveEmailDocument, patchEmailDocument,
} from "./email.js";
import { ensureEmailInboxTab } from "./email-sheets.js";
import { buildConnectUrl, handleCallback, getUserToken, getGoogleConnectionStatus, createUserSheet } from "./oauth.js";
import {
  buildGmailConnectUrl, handleGmailCallback, getGmailStatus,
  syncGmailAccount, syncConnectedGmailAccounts, disconnectGmail,
} from "./gmail.js";
import {
  ensureBatchTab, getBatchDashboard, createReimbursementBatches,
  requestUrgentBatch, updateReimbursementBatchStatus,
  updateReimbursementBatchWorkflow, updateExpenseReviewWorkflow, uploadReimbursementPaymentSlip,
  runScheduledReimbursementBatches,
} from "./batches.js";
import {
  ensureReconciliationTab, getReconciliationDashboard,
  importReconciliationRows, confirmReconciliationMatches,
  unlinkReconciliationMatch, ignoreReconciliationRow,
} from "./reconciliation.js";
import {
  ensureIncomeTabs, getIncomeDashboard, createIncome, updateIncome, addIncomePayment, updateIncomePayment, createIncomeFromOcr,
  importIncomeReconciliationRows, confirmIncomeReconciliationMatches, ignoreIncomeReconciliationRow, unlinkIncomeReconciliation,
} from "./income.js";
import {
  createMemberOnboardingUrl, handleMemberOnboarding,
  getMemberProfile, memberProfileComplete, missingMemberFields,
  findMemberProfile,
} from "./member-profile.js";
import {
  MultiExpenseSession, touchMultiSession, addMultiImage,
  forceMultiSummary, cancelMultiSession, confirmMultiSession, setMultiGroupType, handleMultiHttp,
} from "./multi-expense.js";
import { classifyTransferByCompanyAccounts } from "./account-direction.js";
import {
  rememberLineEventMembers,
  listLineWorkspaceMembers,
  listLineWorkspacesForAccount,
  bindApproverLine,
  notifyApproverAssignment,
  notifyApproversForBatchOutput,
} from "./approver-line.js"; // LINE_APPROVER_NOTIFY_V7_26_20260811
import {
  ACCOUNTING_SUITE_VERSION, ensureAccountingSuiteTabs, getContacts, upsertContact, getContactStatement,
  getPayables, createPayable, updatePayable, addPayablePayment,
  getOpeningBalances, addOpeningBalance, getMigrationDashboard, importMigration,
  getPeriodDashboard, closePeriod, reopenPeriod, assertPeriodOpen,
  getTaxCenter, getAudit, getLedger, getTodayWork, searchAccounting, getBackup,
  writeAudit, postJournal, postExpenseJournal, postIncomeInvoiceJournal, postIncomePaymentJournal, postReimbursementPaymentJournal,
} from "./accounting-suite.js";
import { getCashPosition } from "./cash-position.js"; // AUTO_CASH_POSITION_V7_69_20260816

import { handleAdminOps } from "./admin-ops.js"; // ADMIN_OPS_ROUTE_V7_56_20260816

export { MultiExpenseSession } from "./multi-expense.js";

const VERSION = "DEAL_LINE_BOT_v7.36_TEAM_WORKFLOW_LINE_GROUP_ENDPOINT_20260813";

const PENDING_ACTS = new Set(["confirm", "confirm_force", "cancel"]);
const MSG_STALE = "การ์ดใบนี้เก่าแล้วครับ 🙏 เลื่อนลงไปใช้การ์ดใบล่าสุดของรายการนี้แทน";

/* ═══════════════════ token ประจำ tenant ═══════════════════ */

async function getDashToken(env, key, { create = true } = {}) {
  let t = await env.KV.get(`dtoken:${key}`);
  if (!t && create) {
    t = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    await env.KV.put(`dtoken:${key}`, t);
    console.log(`[token] ออกใหม่ให้ tenant=${key}`);
  }
  return t;
}

async function resetDashToken(env, key) {
  const t = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  await env.KV.put(`dtoken:${key}`, t);
  console.log(`[token] รีเซ็ต tenant=${key}`);
  return t;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const DASH_ROLES={owner:"เจ้าของ",accountant:"บัญชี",approver:"ผู้อนุมัติ",viewer:"ดูอย่างเดียว"};
async function resolveDashAccess(env,key,provided){
  const root=await getDashToken(env,key,{create:false});
  if(root&&safeEqual(String(provided||""),root))return {ok:true,role:"owner",name:"Workspace owner",root:true};
  if(!provided)return {ok:false};
  const rec=await env.KV.get(`daccess:${key}:${provided}`,"json").catch(()=>null);
  if(!rec||rec.active===false)return {ok:false};
  return {ok:true,role:["accountant","approver","viewer"].includes(rec.role)?rec.role:"viewer",name:rec.name||DASH_ROLES[rec.role]||"ผู้ใช้งาน",lineUserId:rec.lineUserId||"",root:false,token:provided};
}
function accessCan(access,path,method="GET"){
  if(access?.role==="owner")return true;
  const write=method!=="GET"&&method!=="HEAD";
  if(access?.role==="accountant"){
    if(path==="/api/subscription"&&!write)return true;
    if(path.startsWith("/api/subscription/")||path.startsWith("/api/businesses/invite")||path.startsWith("/api/accounting/access"))return false;
    return true;
  }
  if(access?.role==="approver"){
    if(!write)return ["/api/expenses","/api/batches","/api/settings","/api/workspace-links","/api/subscription","/api/businesses","/api/accounting/today","/api/accounting/whoami"].some(p=>path===p||path.startsWith(p+"/"));
    return ["/api/expense-workflow","/api/batch-workflow","/api/batch-status"].includes(path);
  }
  if(access?.role==="viewer")return !write&&!path.includes("/backup")&&!path.includes("/access");
  return false;
}
async function listDashAccess(env,key){
  const listed=await env.KV.list({prefix:`daccess:${key}:`});const rows=[];
  for(const k of listed.keys||[]){const rec=await env.KV.get(k.name,"json").catch(()=>null);if(rec)rows.push({...rec,token:k.name.split(":").at(-1)});}
  return rows.sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""),"th"));
}
async function createDashAccess(env,key,{
    name="",
    role="viewer",
    lineUserId="",
    lineGroupTenant="",
    lineGroupName="",
    companyName="",
  }={}){
  // APPROVER_ASSIGNMENT_CONFIRM_V7_26_3_20260812
  const r=["accountant","approver","viewer"].includes(role)?role:"viewer",token=crypto.randomUUID().replace(/-/g,"").slice(0,24);
  const rec={
    name:String(name||DASH_ROLES[r]).trim().slice(0,120),
    role:r,
    lineUserId:String(lineUserId||"").trim().slice(0,120),
    lineGroupTenant:["approver","accountant"].includes(r)?String(lineGroupTenant||"").trim().slice(0,120):"",
    lineGroupName:["approver","accountant"].includes(r)?String(lineGroupName||"").trim().slice(0,160):"",
    companyName:String(companyName||"").trim().slice(0,160),
    active:true,
    createdAt:new Date().toISOString()
  };
  await env.KV.put(`daccess:${key}:${token}`,JSON.stringify(rec));return {...rec,token};
}
async function revokeDashAccess(env,key,token){await env.KV.delete(`daccess:${key}:${token}`);return {ok:true};}

async function readDashAccessRecord(env,key,token){
  const cleanToken=String(token||"").trim();
  if(!cleanToken)return null;
  return await env.KV.get(`daccess:${key}:${cleanToken}`,"json").catch(()=>null);
}
async function patchDashAccessRecord(env,key,token,patch={}){
  const cleanToken=String(token||"").trim();
  const current=await readDashAccessRecord(env,key,cleanToken);
  if(!current)return null;
  const next={...current,...patch,updatedAt:new Date().toISOString()};
  await env.KV.put(`daccess:${key}:${cleanToken}`,JSON.stringify(next));
  return {...next,token:cleanToken};
}
function lineNotificationPatch(result={}){
  const sent=result?.sent===true||result?.accepted===true;
  return {
    lineNotificationStatus: sent ? "sent" : "failed",
    lineNotificationAt: new Date().toISOString(),
    lineNotificationReason: sent ? "" : String(result?.reason||"line_push_not_delivered").slice(0,180),
  };
}

/* ═══════════ เช็คว่าตั้งค่าข้อมูลบริษัทครบหรือยัง ═══════════ */

/**
 * คืน { warn } ถ้ายังไม่ครบ / คืน null ถ้าครบแล้ว
 * ใช้ KV flag `setup:{tenant}:{sheetId}` กันอ่านชีทซ้ำทุกครั้งที่บันทึกรายการ
 * ผูกกับ sheetId เพื่อกัน flag ค้างข้ามชีท — ล้างเมื่อบันทึกตั้งค่าใหม่ / migrate / เชื่อมใหม่
 */
function settingValue(s = {}, ...keys) {
  for (const key of keys) {
    const value = String(s[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function activePaymentChannels(s = {}) {
  const raw = s.payment_channels;
  let rows = [];
  if (Array.isArray(raw)) rows = raw;
  else if (raw) {
    try {
      const parsed = JSON.parse(raw);
      rows = Array.isArray(parsed) ? parsed : [];
    } catch {
      rows = [];
    }
  }
  return rows.filter((item) => {
    const value = String(item?.active ?? "true").trim().toLowerCase();
    return !["false", "0", "no", "off", "inactive", "ปิด"].includes(value);
  });
}

async function checkSetup(env, key, sheet) {
  const cacheKey = `companysetup:v3:${key}:${sheet.sheetId}`;
  try {
    const gmail = await getGmailStatus(env, key);
    const cached = await env.KV.get(cacheKey, "json").catch(() => null);
    if (cached?.documentsReady === true && cached?.financeReady === true) {
      if (gmail.connected === true) return null;
      const gmailMissing = gmail.reconnectRequired ? "เชื่อม Gmail ใหม่" : "Gmail เจ้าของธุรกิจ";
      return {
        warn: `ตั้งค่าบริษัทให้ครบก่อนใช้งาน — ยังขาด ${gmailMissing} กดปุ่มด้านล่างเพื่อดำเนินการต่อ`,
        missing: [gmailMissing],
      };
    }

    const s = await readSettings(env, sheet.sheetId, sheet.token);
    const documentMissing = [];
    if (!settingValue(s, "company_name")) documentMissing.push("ชื่อบริษัท");
    if (!settingValue(s, "tax_id")) documentMissing.push("เลขผู้เสียภาษี");
    if (!settingValue(s, "approver_name")) documentMissing.push("ชื่อผู้อนุมัติ");
    if (!settingValue(s, "logo_url", "company_logo_url", "logoUrl")) documentMissing.push("โลโก้บริษัท");
    if (!settingValue(s, "approver_sign_url", "approverSignUrl", "approver_signature_url", "signature_url")) documentMissing.push("ลายเซ็นผู้อนุมัติ");

    const documentsReady = documentMissing.length === 0;
    const financeReady = activePaymentChannels(s).length > 0;
    const missing = [...documentMissing];
    if (!financeReady) missing.push("ช่องทางการโอนเงิน");
    if (!gmail.connected) missing.push(gmail.reconnectRequired ? "เชื่อม Gmail ใหม่" : "Gmail เจ้าของธุรกิจ");

    await env.KV.put(cacheKey, JSON.stringify({ documentsReady, financeReady, checkedAt: Date.now() }));

    if (!missing.length) return null;
    return {
      warn: `ตั้งค่าบริษัทให้ครบก่อนใช้งาน — ยังขาด ${missing.join(" · ")} กดปุ่มด้านล่างเพื่อดำเนินการต่อ`,
      missing,
    };
  } catch (e) {
    console.warn("checkSetup", e.message);
    return { warn: "ตรวจสถานะการตั้งค่าบริษัทไม่ได้ — เปิด Dashboard เพื่อตรวจ Gmail ข้อมูลบริษัท และช่องทางการโอนเงิน" };
  }
}

function documentSettingsReady(s = {}) {
  return !!(
    settingValue(s, "company_name") &&
    settingValue(s, "tax_id") &&
    settingValue(s, "approver_name") &&
    settingValue(s, "logo_url", "company_logo_url", "logoUrl") &&
    settingValue(s, "approver_sign_url", "approverSignUrl", "approver_signature_url", "signature_url") &&
    activePaymentChannels(s).length > 0
  );
}



/* ══════════════ Multi-business account / workspace ══════════════ */
const BUSINESS_ACCOUNT_SCHEMA = "BUSINESS_ACCOUNT_V1_20260807";
function accountRootMapKey(tenant) { return `accountroot:v1:${tenant}`; }
function businessAccountKey(rootTenant) { return `businessaccount:v1:${rootTenant}`; }
function businessMetaKey(tenant) { return `businessmeta:v1:${tenant}`; }
function businessInviteKey(code) { return `businessinvite:v1:${String(code || "").toUpperCase()}`; }
const LINE_GROUP_ONBOARDING_MARKER = "LINE_GROUP_ONBOARDING_V7_35_20260813";
function lineWorkspaceInviteKey(code) { return `lineworkspaceinvite:v1:${String(code || "").toUpperCase()}`; }
function lineWorkspaceBusinessKey(tenant) { return `lineworkspacebusiness:v1:${String(tenant || "").trim()}`; }

async function getAccountRoot(env, tenant) {
  const key = String(tenant || "").trim();
  if (!key) return "";
  return (await env.KV.get(accountRootMapKey(key))) || key;
}

async function operationalTenantKey(env, tenant) {
  const raw = String(tenant || "").trim();
  if (!raw) return "";
  return String((await env.KV.get(lineWorkspaceBusinessKey(raw))) || raw).trim() || raw;
}

async function ensureBusinessAccount(env, tenant) {
  const rootTenant = await getAccountRoot(env, tenant);
  let account = await env.KV.get(businessAccountKey(rootTenant), "json").catch(() => null);
  if (!account || typeof account !== "object") {
    account = { schema: BUSINESS_ACCOUNT_SCHEMA, rootTenant, businesses: [rootTenant], createdAt: new Date().toISOString() };
  }
  const list = Array.from(new Set([rootTenant, ...(Array.isArray(account.businesses) ? account.businesses : [])].filter(Boolean)));
  account = { ...account, schema: BUSINESS_ACCOUNT_SCHEMA, rootTenant, businesses: list, updatedAt: new Date().toISOString() };
  await Promise.all([
    env.KV.put(businessAccountKey(rootTenant), JSON.stringify(account)),
    ...list.map((businessTenant) => env.KV.put(accountRootMapKey(businessTenant), rootTenant)),
  ]);
  return account;
}

async function readBusinessMeta(env, tenant) {
  return (await env.KV.get(businessMetaKey(tenant), "json").catch(() => null)) || {};
}

/* v7.27 — lightweight LINE group directory used by Dashboard approver picker.
   Keep this scoped to businesses that already belong to the same account. */
function lineWorkspaceSourceTypeV727(tenant = "") {
  const id = String(tenant || "").trim();
  if (/^C/i.test(id)) return "group";
  if (/^R/i.test(id)) return "room";
  if (/^U/i.test(id)) return "direct";
  return "workspace";
}

async function getLineGroupsOverview(env, currentTenant, { refresh = false } = {}) {
  // v7.35: account หนึ่งมีหลายธุรกิจ และธุรกิจหนึ่งมีหลาย LINE groups ได้
  // Registry v7.34 เก็บกลุ่มระดับ account; ตรงนี้ scope กลับมาเฉพาะธุรกิจปัจจุบัน
  const businessTenant = await operationalTenantKey(env, currentTenant);
  const data = await listLineWorkspacesForAccount(env, businessTenant, { refresh });
  const account = await ensureBusinessAccount(env, businessTenant);
  const businessSheetId = String((await env.KV.get(`tenant:${businessTenant}`)) || "").trim();
  const rows = [];
  for (const row of (data.rows || [])) {
    const groupTenant = String(row.tenant || row.groupId || "").trim();
    if (!groupTenant) continue;
    let mappedBusiness = String((await env.KV.get(lineWorkspaceBusinessKey(groupTenant))) || "").trim();
    if (!mappedBusiness && account.businesses.includes(groupTenant)) mappedBusiness = groupTenant;
    if (!mappedBusiness && businessSheetId && String(row.sheetId || "").trim() === businessSheetId) {
      mappedBusiness = businessTenant;
      await env.KV.put(lineWorkspaceBusinessKey(groupTenant), businessTenant).catch(() => {});
    }
    if (mappedBusiness !== businessTenant) continue;
    rows.push({ ...row, businessTenant });
  }
  return {
    ...data,
    currentTenant: businessTenant,
    businessTenant,
    rows,
    groupCount: rows.filter((row) => String(row.sourceType || "") === "group").length,
    onboardingVersion: LINE_GROUP_ONBOARDING_MARKER,
  };
}

async function saveBusinessMeta(env, tenant, patch = {}) {
  const current = await readBusinessMeta(env, tenant);
  const next = { ...current, ...patch, tenant, updatedAt: new Date().toISOString() };
  await env.KV.put(businessMetaKey(tenant), JSON.stringify(next));
  return next;
}

function randomBusinessInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function listBusinessWorkspaces(env, currentTenant) {
  const account = await ensureBusinessAccount(env, currentTenant);
  const rootTenant = account.rootTenant;
  const rootSheetId = (await env.KV.get(`tenant:${rootTenant}`)) || env.DEFAULT_SHEET_ID;
  const rootToken = rootSheetId ? await getUserToken(env, rootTenant) : null;
  const subscription = rootSheetId
    ? await getSubscriptionSnapshot(env, rootTenant, rootSheetId, rootToken, { refreshUsage: false })
    : null;
  const businessLimit = Number(subscription?.businessLimit || 1);
  const betaActive = subscription?.betaActive === true;
  const businesses = [];
  for (let i = 0; i < account.businesses.length; i++) {
    const tenant = account.businesses[i];
    const sheetId = await env.KV.get(`tenant:${tenant}`);
    if (!sheetId) continue;
    const token = await getUserToken(env, tenant);
    const settings = token ? await readSettings(env, sheetId, token).catch(() => ({})) : {};
    const meta = await readBusinessMeta(env, tenant);
    const name = settingValue(settings, "company_name") || String(meta.name || "").trim() || (i === 0 ? "ธุรกิจหลัก" : `ธุรกิจ ${i + 1}`);
    businesses.push({
      tenant,
      name,
      isRoot: tenant === rootTenant,
      isCurrent: tenant === currentTenant,
      locked: !betaActive && i >= businessLimit,
      sheetId,
      dashboardUrl: await dashUrl(env, tenant),
      createdAt: meta.createdAt || "",
    });
  }
  return {
    ok: true,
    rootTenant,
    currentTenant,
    businesses,
    businessCount: businesses.length,
    businessLimit,
    canAddBusiness: businesses.length < businessLimit,
    effectivePlan: subscription?.effectivePlan || "free",
    planName: subscription?.planName || "ฟรี",
    betaActive,
  };
}

// TEAM_AUTO_ONBOARDING_V7_40_20260814
function parseTeamMembersV740(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (!raw) return [];
  try { const x = JSON.parse(raw); return Array.isArray(x) ? x.filter(Boolean) : []; }
  catch { return []; }
}
function validLineUserV740(value) {
  return /^U[0-9a-f]{32}$/i.test(String(value || "").trim());
}
function memberRegistrationGroupCardV740(companyName = "บริษัทนี้") {
  return {
    type:"flex",
    altText:`ลงทะเบียนข้อมูลรับเงิน · ${companyName}`,
    contents:{
      type:"bubble",
      body:{type:"box",layout:"vertical",paddingAll:"20px",spacing:"sm",contents:[
        {type:"text",text:"เริ่มใช้งานครั้งแรก",size:"xs",weight:"bold",color:"#248A3D"},
        {type:"text",text:"ลงทะเบียนข้อมูลรับเงินก่อนเบิก",size:"xl",weight:"bold",color:"#111111",wrap:true},
        {type:"text",text:`สำหรับ ${companyName} · กรอกครั้งเดียว แล้วส่งบิล/ตั้งเบิกได้เลย`,size:"sm",color:"#6E6E73",wrap:true},
        {type:"box",layout:"vertical",backgroundColor:"#F5F5F7",cornerRadius:"14px",paddingAll:"12px",margin:"md",contents:[
          {type:"text",text:"ข้อมูลที่ใช้",size:"xs",weight:"bold",color:"#111111"},
          {type:"text",text:"ชื่อ–นามสกุล · ธนาคาร · เลขบัญชี · ชื่อบัญชี",size:"xs",color:"#6E6E73",wrap:true,margin:"xs"}
        ]}
      ]},
      footer:{type:"box",layout:"vertical",paddingAll:"14px",contents:[
        {type:"button",style:"primary",color:"#111111",action:{type:"postback",label:"ลงทะเบียนข้อมูลของฉัน",data:"act=member_register",displayText:"ลงทะเบียนข้อมูลของฉัน"}}
      ]}
    }
  };
}
function memberRegistrationPrivateCardV740(profileUrl, companyName = "บริษัทนี้") {
  return {
    type:"flex",
    altText:`ตั้งค่าบัญชีรับเงิน · ${companyName}`,
    contents:{
      type:"bubble",
      body:{type:"box",layout:"vertical",paddingAll:"20px",spacing:"sm",contents:[
        {type:"text",text:"ข้อมูลส่วนตัว",size:"xs",weight:"bold",color:"#248A3D"},
        {type:"text",text:"ตั้งค่าบัญชีรับเงินครั้งแรก",size:"xl",weight:"bold",color:"#111111",wrap:true},
        {type:"text",text:`ใช้สำหรับ ${companyName} · กรอกครั้งเดียว ระบบจะจำข้อมูลให้ทุกครั้งที่เบิก`,size:"sm",color:"#6E6E73",wrap:true},
        {type:"text",text:"ลิงก์นี้เป็นลิงก์ส่วนตัวของคุณและมีอายุจำกัด",size:"xs",color:"#9A4A00",wrap:true,margin:"md"}
      ]},
      footer:{type:"box",layout:"vertical",paddingAll:"14px",contents:[
        {type:"button",style:"primary",color:"#111111",action:{type:"uri",label:"กรอกข้อมูลรับเงิน",uri:profileUrl}}
      ]}
    }
  };
}
async function companyNameForV740(env, tenant) {
  try {
    const sheetId = String((await env.KV.get(`tenant:${tenant}`)) || env.DEFAULT_SHEET_ID || "").trim();
    if (!sheetId) return "บริษัทนี้";
    const token = await getUserToken(env, tenant).catch(() => null);
    if (!token) return "บริษัทนี้";
    const s = await readSettings(env, sheetId, token).catch(() => ({}));
    return settingValue(s, "company_name") || "บริษัทนี้";
  } catch { return "บริษัทนี้"; }
}
async function deliverMemberRegistrationV740(env, event, businessTenant, { pendingId = "" } = {}) {
  const userId = String(event?.source?.userId || "").trim();
  if (!validLineUserV740(userId)) return { ok:false, reason:"line_user_missing" };
  const companyName = await companyNameForV740(env, businessTenant);
  const profileUrl = await createMemberOnboardingUrl(env, {
    tenant: businessTenant,
    lineUserId: userId,
    displayName: "",
    pendingId,
  });
  const card = memberRegistrationPrivateCardV740(profileUrl, companyName);
  const inGroup = Boolean(event?.source?.groupId || event?.source?.roomId);
  if (!inGroup) return { ok:true, privateSent:false, replyCard:card, companyName };
  const sent = await push(env, userId, card).catch(() => false);
  return { ok:true, privateSent:sent, companyName };
}
async function teamDirectoryV740(env, businessTenant, { refresh = false } = {}) {
  const sheetId = String((await env.KV.get(`tenant:${businessTenant}`)) || env.DEFAULT_SHEET_ID || "").trim();
  const token = sheetId ? await getUserToken(env, businessTenant).catch(() => null) : null;
  const settings = sheetId && token ? await readSettings(env, sheetId, token).catch(() => ({})) : {};
  const saved = parseTeamMembersV740(settings.team_members);
  const savedByLine = new Map();
  saved.forEach((m, i) => {
    const id = String(m?.lineUserId || m?.payerId || "").trim();
    if (id) savedByLine.set(id, { ...m, savedIndex:i });
  });

  const groupData = await getLineGroupsOverview(env, businessTenant, { refresh:false });
  const merged = new Map();
  const groupSummaries = [];
  for (const group of groupData.rows || []) {
    const groupTenant = String(group.tenant || group.groupId || "").trim();
    if (!/^C|^R/i.test(groupTenant)) continue;
    const groupSheetId = String((await env.KV.get(`tenant:${groupTenant}`)) || sheetId || "").trim();
    const groupToken = (await getUserToken(env, groupTenant).catch(() => null)) || token;
    const out = await listLineWorkspaceMembers(env, groupTenant, {
      sheetId: groupSheetId,
      token: groupToken,
      refresh,
    }).catch(() => ({ ok:false, members:[], workspaceName:group.groupName || "", directoryMode:"known-members" }));
    groupSummaries.push({
      tenant:groupTenant,
      name:out.workspaceName || group.groupName || "กลุ่ม LINE",
      count:Number(out.activeCount || out.count || 0),
      directoryMode:out.directoryMode || "known-members",
    });
    for (const m of out.members || []) {
      if (m.active === false || !validLineUserV740(m.userId)) continue;
      const current = merged.get(m.userId) || {
        lineUserId:m.userId,
        displayName:m.displayName || "",
        pictureUrl:m.pictureUrl || "",
        groups:[],
        lastSeenAt:m.lastSeenAt || "",
      };
      current.displayName = current.displayName || m.displayName || "";
      current.pictureUrl = current.pictureUrl || m.pictureUrl || "";
      current.lastSeenAt = [current.lastSeenAt, m.lastSeenAt || ""].sort().at(-1) || "";
      if (!current.groups.some((g) => g.tenant === groupTenant)) current.groups.push({ tenant:groupTenant, name:out.workspaceName || group.groupName || "กลุ่ม LINE" });
      merged.set(m.userId,current);
    }
  }

  const rows = [];
  for (const item of merged.values()) {
    const profile = savedByLine.get(item.lineUserId) || null;
    rows.push({
      ...item,
      name:String(profile?.name || item.displayName || "สมาชิก LINE"),
      nickname:String(profile?.nickname || ""),
      role:String(profile?.role || "พนักงาน"),
      bank:String(profile?.bank || ""),
      accountNo:String(profile?.accountNo || ""),
      accountName:String(profile?.accountName || ""),
      savedIndex:Number.isInteger(profile?.savedIndex) ? profile.savedIndex : -1,
      registered:Boolean(profile),
      profileComplete:memberProfileComplete(profile || {}),
      missing:missingMemberFields(profile || {}),
    });
  }
  saved.forEach((profile, savedIndex) => {
    const id = String(profile?.lineUserId || profile?.payerId || "").trim();
    if (id && merged.has(id)) return;
    rows.push({
      lineUserId:id,
      displayName:String(profile?.name || ""),
      name:String(profile?.name || "สมาชิก"),
      nickname:String(profile?.nickname || ""),
      role:String(profile?.role || "พนักงาน"),
      bank:String(profile?.bank || ""),
      accountNo:String(profile?.accountNo || ""),
      accountName:String(profile?.accountName || ""),
      groups:[],
      lastSeenAt:"",
      savedIndex,
      registered:true,
      profileComplete:memberProfileComplete(profile || {}),
      missing:missingMemberFields(profile || {}),
    });
  });
  rows.sort((a,b) => Number(b.profileComplete)-Number(a.profileComplete) || String(a.name||a.displayName).localeCompare(String(b.name||b.displayName),"th"));
  return {
    ok:true,
    businessTenant,
    companyName:await companyNameForV740(env,businessTenant),
    rows,
    groups:groupSummaries,
    total:rows.length,
    ready:rows.filter((x)=>x.profileComplete).length,
    waiting:rows.filter((x)=>!x.profileComplete).length,
    refreshedAt:new Date().toISOString(),
    version:"TEAM_AUTO_ONBOARDING_V7_40_20260814",
  };
}

async function createLineWorkspaceInvite(env, currentTenant) {
  const businessTenant = await operationalTenantKey(env, currentTenant);
  const account = await ensureBusinessAccount(env, businessTenant);
  if (!account.businesses.includes(businessTenant)) {
    return { ok:false, reason:"business_not_in_account", message:"ไม่พบธุรกิจนี้ในบัญชีหลัก" };
  }
  const sheetId = String((await env.KV.get(`tenant:${businessTenant}`)) || "").trim();
  if (!sheetId) return { ok:false, reason:"business_not_connected", message:"ธุรกิจนี้ยังไม่ได้เชื่อม Google / Sheet" };
  const token = await getUserToken(env, businessTenant).catch(() => null);
  const settings = token ? await readSettings(env, sheetId, token).catch(() => ({})) : {};
  const meta = await readBusinessMeta(env, businessTenant).catch(() => ({}));
  const companyName = settingValue(settings, "company_name") || String(meta.name || "").trim() || "ธุรกิจนี้";
  const code = randomBusinessInviteCode();
  const now = Date.now();
  const expiresAt = new Date(now + 30 * 60 * 1000).toISOString();
  await env.KV.put(lineWorkspaceInviteKey(code), JSON.stringify({
    schema: "LINE_WORKSPACE_INVITE_V1",
    code,
    rootTenant: account.rootTenant,
    businessTenant,
    companyName,
    createdAt: new Date(now).toISOString(),
    expiresAt,
  }), { expirationTtl: 30 * 60 });
  return {
    ok:true,
    code,
    command:`เชื่อมกลุ่ม ${code}`,
    companyName,
    businessTenant,
    rootTenant: account.rootTenant,
    expiresAt,
    instruction:`เพิ่ม LINE OA เข้ากลุ่มที่ต้องการ แล้วพิมพ์ “เชื่อมกลุ่ม ${code}” ในกลุ่มนั้น`,
  };
}

async function linkLineWorkspaceFromInvite(env, event, codeRaw) {
  const rawTenant = tenantKey(event?.source || {});
  const sourceType = event?.source?.groupId ? "group" : event?.source?.roomId ? "room" : "";
  if (!sourceType || !/^[CR]/i.test(rawTenant)) {
    return { ok:false, reason:"group_required", message:"คำสั่งเชื่อมกลุ่มต้องส่งในกลุ่ม LINE ที่ต้องการเชื่อม" };
  }
  const code = String(codeRaw || "").trim().toUpperCase();
  const invite = await env.KV.get(lineWorkspaceInviteKey(code), "json").catch(() => null);
  if (!invite?.businessTenant) {
    return { ok:false, reason:"invalid_invite", message:"รหัสเชื่อมกลุ่มไม่ถูกต้องหรือหมดอายุแล้ว กรุณาสร้างรหัสใหม่จาก Dashboard" };
  }
  if (Date.parse(invite.expiresAt || "") <= Date.now()) {
    await env.KV.delete(lineWorkspaceInviteKey(code));
    return { ok:false, reason:"expired_invite", message:"รหัสเชื่อมกลุ่มหมดอายุแล้ว กรุณาสร้างรหัสใหม่จาก Dashboard" };
  }

  const businessTenant = await operationalTenantKey(env, invite.businessTenant);
  const rootTenant = await getAccountRoot(env, businessTenant);
  const account = await ensureBusinessAccount(env, businessTenant);
  if (!account.businesses.includes(businessTenant) || rootTenant !== invite.rootTenant) {
    return { ok:false, reason:"business_scope_changed", message:"โครงสร้างบัญชีธุรกิจเปลี่ยนแล้ว กรุณาสร้างรหัสใหม่จาก Dashboard" };
  }

  const businessSheetId = String((await env.KV.get(`tenant:${businessTenant}`)) || "").trim();
  const businessRefresh = String((await env.KV.get(`gtoken:${businessTenant}`)) || "").trim();
  if (!businessSheetId || !businessRefresh) {
    return { ok:false, reason:"business_google_missing", message:"ธุรกิจต้นทางยังไม่มีสิทธิ์ Google กรุณาเชื่อม Google ที่ธุรกิจหลักก่อน" };
  }

  const currentBusiness = String((await env.KV.get(lineWorkspaceBusinessKey(rawTenant))) || "").trim();
  if (currentBusiness && currentBusiness !== businessTenant) {
    return { ok:false, reason:"group_linked_other_business", message:"กลุ่ม LINE นี้ถูกเชื่อมกับธุรกิจอื่นอยู่แล้ว จึงไม่ย้ายอัตโนมัติเพื่อป้องกันข้อมูลปะปน" };
  }
  const existingSheetId = String((await env.KV.get(`tenant:${rawTenant}`)) || "").trim();
  if (existingSheetId && existingSheetId !== businessSheetId && !currentBusiness) {
    return { ok:false, reason:"group_has_other_data", message:"กลุ่มนี้มีข้อมูล/Sheet ของตัวเองอยู่แล้ว ถ้าต้องการย้ายข้อมูลเข้าบริษัทนี้ให้ดำเนินการผ่านเมนูย้ายธุรกิจเพื่อป้องกันข้อมูลหาย" };
  }

  const groupName = (await tenantTitle(env, event.source)) || (sourceType === "group" ? "กลุ่ม LINE" : "ห้อง LINE");
  const aliasRefresh = String((await env.KV.get(`gtoken:${rawTenant}`)) || "").trim();
  await Promise.all([
    env.KV.put(lineWorkspaceBusinessKey(rawTenant), businessTenant),
    env.KV.put(accountRootMapKey(rawTenant), rootTenant),
    env.KV.put(`tenant:${rawTenant}`, businessSheetId),
    aliasRefresh ? Promise.resolve() : env.KV.put(`gtoken:${rawTenant}`, businessRefresh),
    env.KV.delete(lineWorkspaceInviteKey(code)),
  ]);

  // v7.34 registry จะย้าย group record เข้าบัญชีที่ถูกต้องจาก accountroot + tenant mapping
  await listLineWorkspacesForAccount(env, businessTenant, { refresh:true }).catch((e) =>
    console.warn("refresh LINE workspace after link", rawTenant, e?.message || e)
  );

  // TEAM_AUTO_ONBOARDING_V7_40_20260814: หลังเชื่อมกลุ่มสำเร็จ เชิญทุกคนลงทะเบียนแบบ self-service
  await push(env, rawTenant, memberRegistrationGroupCardV740(String(invite.companyName || "บริษัทนี้")))
    .catch((e) => console.warn("team onboarding invite after LINE link", rawTenant, e?.message || e));

  return {
    ok:true,
    groupTenant:rawTenant,
    groupName,
    businessTenant,
    rootTenant,
    companyName:String(invite.companyName || "ธุรกิจนี้"),
    dashboardUrl:await dashUrl(env, businessTenant),
  };
}

async function createBusinessInvite(env, currentTenant) {
  const info = await listBusinessWorkspaces(env, currentTenant);
  if (!info.canAddBusiness) {
    return {
      ok: false,
      reason: "business_limit",
      message: info.businessLimit <= 1 ? "เพิ่มบริษัทได้ตั้งแต่แพ็กเกจ Business" : `แพ็กเกจนี้รองรับสูงสุด ${info.businessLimit} บริษัท`,
      ...info,
    };
  }
  const code = randomBusinessInviteCode();
  const now = Date.now();
  const expiresAt = new Date(now + 30 * 60 * 1000).toISOString();
  await env.KV.put(businessInviteKey(code), JSON.stringify({
    schema: BUSINESS_ACCOUNT_SCHEMA,
    code,
    rootTenant: info.rootTenant,
    createdByTenant: currentTenant,
    createdAt: new Date(now).toISOString(),
    expiresAt,
  }), { expirationTtl: 30 * 60 });
  return {
    ok: true,
    code,
    expiresAt,
    businessCount: info.businessCount,
    businessLimit: info.businessLimit,
    instruction: `เพิ่ม LINE OA เข้ากลุ่มของธุรกิจใหม่ แล้วพิมพ์ “เชื่อมธุรกิจ ${code}” ในกลุ่มนั้น`,
  };
}

async function linkBusinessFromInvite(env, event, currentTenant, codeRaw) {
  // v7.32: อนุญาตให้นำ "ธุรกิจเดิมที่เชื่อมอยู่แล้ว" เข้าบัญชีหลักได้โดยไม่ทับ Sheet/Drive เดิม
  // เดิมโค้ด reject ทันทีเมื่อ tenant:<groupId> มีค่า ทำให้กลุ่มที่เคยกด Dashboard/เชื่อม Google แล้ว
  // ไม่สามารถถูกเพิ่มเข้าบัญชีเดียวกัน และหน้าเลือก LINE ผู้อนุมัติจึงเห็นแค่กลุ่มเก่า
  const code = String(codeRaw || "").trim().toUpperCase();
  if (!event.source?.groupId) return { ok: false, reason: "group_required", message: "การเพิ่มธุรกิจต้องทำในกลุ่ม LINE ของธุรกิจใหม่" };
  const invite = await env.KV.get(businessInviteKey(code), "json").catch(() => null);
  if (!invite?.rootTenant) return { ok: false, reason: "invalid_invite", message: "รหัสเพิ่มธุรกิจไม่ถูกต้องหรือหมดอายุแล้ว กรุณาสร้างรหัสใหม่จาก Dashboard" };
  if (Date.parse(invite.expiresAt || "") <= Date.now()) {
    await env.KV.delete(businessInviteKey(code));
    return { ok: false, reason: "expired_invite", message: "รหัสเพิ่มธุรกิจหมดอายุแล้ว กรุณาสร้างรหัสใหม่จาก Dashboard" };
  }

  const rootTenant = await getAccountRoot(env, invite.rootTenant);
  const existingRootRaw = String((await env.KV.get(accountRootMapKey(currentTenant))) || "").trim();
  const existingRoot = existingRootRaw || currentTenant;
  let sheetId = String((await env.KV.get(`tenant:${currentTenant}`)) || "").trim();
  const hadExistingSheet = Boolean(sheetId);

  // ถ้าอยู่บัญชีปลายทางนี้แล้ว ให้ทำงานแบบ idempotent และซ่อม business list ให้ครบ
  if (existingRootRaw === rootTenant) {
    const account = await ensureBusinessAccount(env, rootTenant);
    const nextBusinesses = Array.from(new Set([...account.businesses, currentTenant]));
    await Promise.all([
      env.KV.put(businessAccountKey(rootTenant), JSON.stringify({ ...account, businesses: nextBusinesses, updatedAt: new Date().toISOString() })),
      env.KV.delete(businessInviteKey(code)),
    ]);
    await getDashToken(env, currentTenant);
    return {
      ok: true,
      alreadyLinked: true,
      rootTenant,
      tenant: currentTenant,
      businessCount: nextBusinesses.length,
      businessLimit: Number((await getSubscriptionSnapshot(env, rootTenant, (await env.KV.get(`tenant:${rootTenant}`)) || env.DEFAULT_SHEET_ID, await getUserToken(env, rootTenant), { refreshUsage: false })).businessLimit || 1),
      dashboardUrl: await dashUrl(env, currentTenant),
    };
  }

  // ป้องกันการดึงธุรกิจที่เป็นสมาชิกของ "บัญชีอื่น" มารวมข้ามเจ้าของ
  // แต่ถ้ากลุ่มนี้เป็นบัญชี standalone ของตัวเอง (root = ตัวเอง) ให้อนุญาต merge ได้
  if (existingRootRaw && existingRoot !== currentTenant && existingRoot !== rootTenant) {
    return { ok: false, reason: "already_linked_other_account", message: "ธุรกิจนี้อยู่ในบัญชีอื่นแล้ว จึงไม่สามารถย้ายเข้าบัญชีนี้อัตโนมัติได้" };
  }

  if (existingRoot === currentTenant) {
    const standaloneAccount = await env.KV.get(businessAccountKey(currentTenant), "json").catch(() => null);
    const standaloneBusinesses = Array.isArray(standaloneAccount?.businesses)
      ? standaloneAccount.businesses.filter(Boolean)
      : [currentTenant];
    const otherChildren = standaloneBusinesses.filter((tenant) => String(tenant) !== String(currentTenant));
    if (otherChildren.length) {
      return {
        ok: false,
        reason: "nested_account_merge_not_supported",
        message: "บัญชีของกลุ่มนี้มีหลายธุรกิจอยู่แล้ว จึงไม่รวมอัตโนมัติเพื่อป้องกันข้อมูลธุรกิจลูกหาย กรุณาแยกย้ายทีละธุรกิจ",
      };
    }
  }

  const rootSheetId = (await env.KV.get(`tenant:${rootTenant}`)) || env.DEFAULT_SHEET_ID;
  const rootToken = rootSheetId ? await getUserToken(env, rootTenant) : null;
  if (!rootToken) return { ok: false, reason: "google_required", message: "บัญชีหลักยังไม่มีสิทธิ์ Google Drive กรุณาเชื่อม Google ที่ธุรกิจหลักก่อน" };

  const subscription = await getSubscriptionSnapshot(env, rootTenant, rootSheetId, rootToken, { refreshUsage: false });
  const account = await ensureBusinessAccount(env, rootTenant);
  const limit = Number(subscription.businessLimit || 1);
  if (!account.businesses.includes(currentTenant) && account.businesses.length >= limit) {
    return { ok: false, reason: "business_limit", message: limit <= 1 ? "เพิ่มบริษัทได้ตั้งแต่แพ็กเกจ Business" : `สิทธิ์ปัจจุบันเพิ่มได้สูงสุด ${limit} บริษัท` };
  }

  const groupName = (await tenantTitle(env, event.source)) || `ธุรกิจ ${account.businesses.length + 1}`;

  if (!sheetId) {
    // กลุ่มใหม่จริง ๆ: ใช้ Google credential ของบัญชีหลักเพื่อสร้างพื้นที่ธุรกิจใหม่
    const rootRefresh = await env.KV.get(`gtoken:${rootTenant}`);
    if (!rootRefresh) return { ok: false, reason: "google_required", message: "ไม่พบสิทธิ์ Google ของบัญชีหลัก กรุณาเชื่อม Google ใหม่" };
    if (!(await env.KV.get(`gtoken:${currentTenant}`))) {
      await env.KV.put(`gtoken:${currentTenant}`, rootRefresh);
    }
    const token = await getUserToken(env, currentTenant);
    sheetId = (await createUserSheet(env, token, `รับจ่ายแบบไม่จำกัด · ${groupName}`)).sheetId;
    await env.KV.put(`tenant:${currentTenant}`, sheetId);
    await saveBusinessMeta(env, currentTenant, { name: groupName, createdAt: new Date().toISOString(), linkedFrom: rootTenant });
  } else {
    // ธุรกิจเดิม: เก็บ Sheet และ Google token เดิมทั้งหมด ห้ามเอาของบัญชีหลักมาทับ
    // แค่ย้าย ownership เชิง Workspace ให้มาอยู่ใต้ rootTenant เท่านั้น
    const existingMeta = await readBusinessMeta(env, currentTenant).catch(() => ({}));
    await saveBusinessMeta(env, currentTenant, {
      ...existingMeta,
      name: String(existingMeta.name || groupName).trim(),
      lineGroupName: groupName,
      linkedFrom: rootTenant,
      mergedIntoAccountAt: new Date().toISOString(),
      preservedExistingSheet: true,
    });
  }

  const nextBusinesses = Array.from(new Set([...account.businesses, currentTenant]));
  await Promise.all([
    env.KV.put(accountRootMapKey(currentTenant), rootTenant),
    env.KV.put(businessAccountKey(rootTenant), JSON.stringify({ ...account, businesses: nextBusinesses, updatedAt: new Date().toISOString() })),
    env.KV.delete(businessInviteKey(code)),
  ]);

  await getDashToken(env, currentTenant);
  return {
    ok: true,
    mergedExistingBusiness: hadExistingSheet,
    rootTenant,
    tenant: currentTenant,
    businessCount: nextBusinesses.length,
    businessLimit: limit,
    dashboardUrl: await dashUrl(env, currentTenant),
  };
}

/* ══════════════ Subscription / Beta access ══════════════ */
const SUBSCRIPTION_SCHEMA = "SUBSCRIPTION_V1_20260807";
const SUBSCRIPTION_PLANS = Object.freeze({
  free:     { id: "free",     name: "ฟรี",     monthly: 0,    annual: 0,     documentLimit: 20,   aiDocumentLimit: AI_DOCUMENT_LIMITS.free,     businessLimit: 1 },
  starter:  { id: "starter",  name: "Lite",    monthly: 199,  annual: 1990,  documentLimit: 200,  aiDocumentLimit: AI_DOCUMENT_LIMITS.starter,  businessLimit: 1 },
  pro:      { id: "pro",      name: "Pro",     monthly: 399,  annual: 3990,  documentLimit: 1000, aiDocumentLimit: AI_DOCUMENT_LIMITS.pro,      businessLimit: 1 },
  business: { id: "business", name: "Business",monthly: 1290, annual: 12900, documentLimit: 3000, aiDocumentLimit: AI_DOCUMENT_LIMITS.business, businessLimit: 2 },
});

function subscriptionMonthKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit",
    }).formatToParts(d);
    const year = parts.find((p) => p.type === "year")?.value || "";
    const month = parts.find((p) => p.type === "month")?.value || "";
    return year && month ? `${year}-${month}` : "";
  } catch {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
}

function subscriptionRecordKey(key) { return `subscription:v1:${key}`; }
function subscriptionUsageKey(key, monthKey = subscriptionMonthKey()) { return `subusage:v1:${key}:${monthKey}`; }
function subscriptionEnforcementEnabled(env) {
  return !["0", "false", "off", "no"].includes(String(env.SUBSCRIPTION_ENFORCEMENT ?? "1").trim().toLowerCase());
}

function configuredBetaEnd(env, startedAt = Date.now()) {
  // TRIAL_POLICY_30D_1000_V7_72_20260817: automatic Trial is exactly 30 days from the account's real start.
  const days = Math.max(1, Number(env.BETA_TRIAL_DAYS || 30));
  return new Date(Number(startedAt) + days * 86400000).toISOString();
}
function configuredTrialDocumentLimit(env) {
  // Trial quota only. Paid Business package remains unchanged.
  return Math.max(1, Number(env.BETA_TRIAL_DOCUMENT_LIMIT || 1000));
}

async function getSubscriptionRecord(env, key) {
  key = await getAccountRoot(env, key);
  await ensureBusinessAccount(env, key);
  const storageKey = subscriptionRecordKey(key);
  let rec = await env.KV.get(storageKey, "json").catch(() => null);
  const now = Date.now();
  if (!rec || typeof rec !== "object") {
    const startedAt = new Date(now).toISOString();
    rec = {
      schema: SUBSCRIPTION_SCHEMA,
      status: "beta",
      plan: "business",
      cycle: "monthly",
      createdAt: startedAt,
      trialStartedAt: startedAt,
      trialEndsAt: configuredBetaEnd(env, now),
      requestedPlan: "",
      requestedCycle: "",
      upgradeRequestedAt: "",
    };
    // ถ้าเปิดระบบหลังวัน Beta กลางสิ้นสุดแล้ว ให้เริ่ม Free โดยไม่แจก Beta รอบใหม่
    if (Date.parse(rec.trialEndsAt || "") <= now) {
      rec.status = "free";
      rec.plan = "free";
    }
    await env.KV.put(storageKey, JSON.stringify(rec));
    return rec;
  }

  // TRIAL_POLICY_30D_1000_V7_72_20260817: normalize every legacy Trial to the new 30-day policy.
  if (rec.status === "beta") {
    const startMs = Date.parse(rec.trialStartedAt || rec.createdAt || "");
    if (Number.isFinite(startMs)) {
      const expectedEnd = configuredBetaEnd(env, startMs);
      if (rec.trialEndsAt !== expectedEnd || rec.plan !== "business" || rec.trialMode !== "business_30d") {
        rec = {
          ...rec,
          plan: "business",
          trialEndsAt: expectedEnd,
          trialMode: "business_30d",
          trialPolicyVersion: "TRIAL_POLICY_30D_1000_V7_72_20260817",
          trialMigratedAt: new Date(now).toISOString(),
        };
        await env.KV.put(storageKey, JSON.stringify(rec));
      }
    }
  }

  // Beta จบแล้วและยังไม่ได้เปิดแพ็กเสียเงิน → กลับ Free อัตโนมัติ
  if (rec.status === "beta" && Number.isFinite(Date.parse(rec.trialEndsAt || "")) && Date.parse(rec.trialEndsAt) <= now) {
    rec = { ...rec, status: "free", plan: "free", betaEndedAt: new Date(now).toISOString() };
    await env.KV.put(storageKey, JSON.stringify(rec));
  }
  return rec;
}

async function saveSubscriptionRecord(env, key, patch = {}) {
  key = await getAccountRoot(env, key);
  const current = await getSubscriptionRecord(env, key);
  const next = { ...current, ...patch, schema: SUBSCRIPTION_SCHEMA, updatedAt: new Date().toISOString() };
  await env.KV.put(subscriptionRecordKey(key), JSON.stringify(next));
  return next;
}

function countCurrentMonthExpenses(rows = [], monthKey = subscriptionMonthKey()) {
  if (!monthKey) return 0;
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const stamp = row?.createdAt || row?.recordedAt || row?.submittedAt || row?.dateISO || row?.date || "";
    return subscriptionMonthKey(stamp) === monthKey;
  }).length;
}

async function getSubscriptionUsage(env, key, sheetId, token, { refresh = false } = {}) {
  const rootTenant = await getAccountRoot(env, key);
  const monthKey = subscriptionMonthKey();
  const cacheKey = subscriptionUsageKey(rootTenant, monthKey);
  if (!refresh) {
    const cached = await env.KV.get(cacheKey);
    if (cached !== null && cached !== undefined && cached !== "") {
      const value = Number(cached);
      if (Number.isFinite(value) && value >= 0) return { monthKey, documents: value };
    }
  }
  let documents = 0;
  try {
    const account = await ensureBusinessAccount(env, rootTenant);
    for (const businessTenant of account.businesses) {
      const businessSheetId = (await env.KV.get(`tenant:${businessTenant}`)) || (businessTenant === key ? sheetId : "");
      if (!businessSheetId) continue;
      const businessToken = businessTenant === key && token ? token : await getUserToken(env, businessTenant);
      const rows = await readExpenses(env, businessSheetId, businessToken);
      documents += countCurrentMonthExpenses(rows, monthKey);
    }
  } catch (e) {
    console.warn("subscription usage refresh", e?.message || e);
    const cached = Number(await env.KV.get(cacheKey));
    documents = Number.isFinite(cached) && cached >= 0 ? cached : 0;
  }
  await env.KV.put(cacheKey, String(documents), { expirationTtl: 60 * 60 * 24 * 120 });
  return { monthKey, documents };
}
async function syncSubscriptionUsageAfterSavedExpense(env, key, sheetId, token) {
  const rootTenant = await getAccountRoot(env, key);
  const monthKey = subscriptionMonthKey();
  const cacheKey = subscriptionUsageKey(rootTenant, monthKey);
  const cachedRaw = await env.KV.get(cacheKey);
  if (cachedRaw !== null && cachedRaw !== undefined && cachedRaw !== "") {
    const cached = Number(cachedRaw);
    if (Number.isFinite(cached) && cached >= 0) {
      const next = cached + 1;
      await env.KV.put(cacheKey, String(next), { expirationTtl: 60 * 60 * 24 * 120 });
      return next;
    }
  }
  // ยังไม่มี counter: อ่าน Sheet หลังบันทึกแล้วเพื่อ seed จำนวนจริง (ไม่ + ซ้ำ)
  return (await getSubscriptionUsage(env, key, sheetId, token, { refresh: true })).documents;
}

async function getSubscriptionSnapshot(env, key, sheetId, token, { refreshUsage = false } = {}) {
  const rec = await getSubscriptionRecord(env, key);
  const now = Date.now();
  const trialEndMs = Date.parse(rec.trialEndsAt || "");
  const betaActive = rec.status === "beta" && Number.isFinite(trialEndMs) && trialEndMs > now;
  const requestedPlan = SUBSCRIPTION_PLANS[rec.requestedPlan] ? rec.requestedPlan : "";
  const requestedCycle = rec.requestedCycle === "annual" ? "annual" : rec.requestedCycle === "monthly" ? "monthly" : "";
  const effectivePlan = betaActive ? "business" : (rec.status === "active" && SUBSCRIPTION_PLANS[rec.plan] ? rec.plan : "free");
  const plan = SUBSCRIPTION_PLANS[effectivePlan] || SUBSCRIPTION_PLANS.free;
  const usage = await getSubscriptionUsage(env, key, sheetId, token, { refresh: refreshUsage });
  const limit = betaActive ? configuredTrialDocumentLimit(env) : plan.documentLimit;
  const aiState = await getAiQuotaState(env, key);
  const aiLimit = Number(aiState.limit || (betaActive ? 100 : plan.aiDocumentLimit) || 0);
  const aiPercent = aiLimit ? Math.min(999, Math.round((Number(aiState.used || 0) / aiLimit) * 100)) : 0;
  const percent = limit ? Math.min(999, Math.round((usage.documents / limit) * 100)) : 0;
  let threshold = "ok";
  if (limit && percent >= 100) threshold = "limit";
  else if (limit && percent >= 90) threshold = "warning90";
  else if (limit && percent >= 80) threshold = "warning80";
  const enforcement = subscriptionEnforcementEnabled(env);
  const account = await ensureBusinessAccount(env, key);
  const businessLimit = Number(plan.businessLimit || 1);
  const businessCount = account.businesses.length;
  const businessIndex = Math.max(0, account.businesses.indexOf(key));
  const businessAccessAllowed = businessIndex < businessLimit;
  const documentBlocked = Boolean(enforcement && limit && usage.documents >= limit);
  const businessBlocked = Boolean(enforcement && !businessAccessAllowed);
  return {
    ok: true,
    schema: SUBSCRIPTION_SCHEMA,
    status: betaActive ? "beta" : (rec.status === "active" ? "active" : "free"),
    betaActive,
    trialStartedAt: rec.trialStartedAt || rec.createdAt || "",
    trialEndsAt: rec.trialEndsAt || "",
    daysRemaining: betaActive ? Math.max(1, Math.ceil((trialEndMs - now) / 86400000)) : 0,
    plan: betaActive ? "beta" : effectivePlan,
    effectivePlan,
    planName: betaActive ? "ทดลองใช้ Business ฟรี" : plan.name,
    cycle: rec.cycle === "annual" ? "annual" : "monthly",
    priceMonthly: plan.monthly,
    priceAnnual: plan.annual,
    documentLimit: limit,
    aiDocumentLimit: aiLimit,
    aiUsage: { month: aiState.month, documents: Number(aiState.used || 0), percent: aiPercent, remaining: Math.max(0, aiLimit - Number(aiState.used || 0)) },
    aiBlocked: Boolean(aiState.blocked),
    businessLimit,
    businessCount,
    canAddBusiness: businessCount < businessLimit,
    accountRootTenant: account.rootTenant,
    businessIndex,
    businessAccessAllowed,
    businessBlocked,
    usage: { month: usage.monthKey, documents: usage.documents, percent, threshold },
    blocked: Boolean(documentBlocked || businessBlocked),
    blockedReason: businessBlocked ? "business_limit" : documentBlocked ? "document_limit" : "",
    enforcement,
    requestedPlan,
    requestedPlanName: requestedPlan ? SUBSCRIPTION_PLANS[requestedPlan].name : "",
    requestedCycle,
    upgradeRequestedAt: rec.upgradeRequestedAt || "",
    catalog: SUBSCRIPTION_PLANS,
  };
}

async function requestSubscriptionUpgrade(env, key, sheetId, token, body = {}) {
  const plan = String(body.plan || "").trim().toLowerCase();
  const cycle = body.cycle === "annual" ? "annual" : "monthly";
  if (!SUBSCRIPTION_PLANS[plan]) return { ok: false, reason: "invalid_plan" };
  await saveSubscriptionRecord(env, key, {
    requestedPlan: plan,
    requestedCycle: cycle,
    upgradeRequestedAt: new Date().toISOString(),
  });
  return await getSubscriptionSnapshot(env, key, sheetId, token, { refreshUsage: true });
}

async function subscriptionQuotaMessage(env, key, snapshot) {
  const base = await dashUrl(env, key);
  const upgradeUrl = `${base}${base.includes("?") ? "&" : "?"}page=billing`;
  if (snapshot?.blockedReason === "business_limit") {
    return textMsg(`ธุรกิจนี้อยู่นอกสิทธิ์แพ็กเกจปัจจุบัน
แพ็กเกจปัจจุบันรองรับจำนวนบริษัทตามที่แสดงในหน้าแพ็กเกจ
ข้อมูลเดิมยังเปิดดูและจัดการได้ แต่การรับเอกสารใหม่ของธุรกิจนี้ถูกพักไว้

อัปเกรดแพ็กเกจ:
${upgradeUrl}`);
  }
  const used = Number(snapshot?.usage?.documents || 0);
  const limit = Number(snapshot?.documentLimit || 0);
  return textMsg(`โควตาเอกสารเดือนนี้ครบแล้ว (${used}/${limit})
รายการเดิมยังดู แก้ และดาวน์โหลดได้ตามปกติ
อัปเกรดแพ็กเกจเพื่อรับเอกสารใหม่ต่อ:
${upgradeUrl}`);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    // PUBLIC_PILOT_ROUTE_V7_71_20260817
    // Public website form: NEVER send this through LINE webhook signature validation.
    if (url.pathname === "/pilot" && request.method === "GET") {
      return pilotPage(env);
    }
    if (url.pathname === "/pilot/request" && request.method === "POST") {
      return savePilotRequest(env, request);
    }
    if (url.pathname === "/pilot/health" && request.method === "GET") {
      return cors(json(pilotHealth()));
    }

    // ADMIN_OPS_ROUTE_V7_56_20260816
    if (url.pathname.startsWith("/admin/ops/")) {
      return await handleAdminOps(request, env, url);
    }

    if (url.pathname === "/oauth/connect") {
      const key = url.searchParams.get("tenant");
      if (!key) return new Response("missing tenant", { status: 400 });
      return Response.redirect(buildConnectUrl(env, url.origin, key), 302);
    }
    if (url.pathname === "/oauth/callback") {
      return await handleCallback(env, url, url.origin);
    }

    if (url.pathname === "/gmail/connect") {
      const key = url.searchParams.get("tenant");
      if (!key) return new Response("missing tenant", { status: 400 });
      const expected = await getDashToken(env, key, { create: false });
      if (!expected || !safeEqual(url.searchParams.get("k") || "", expected)) {
        return new Response("invalid dashboard link", { status: 401 });
      }
      try {
        return Response.redirect(await buildGmailConnectUrl(env, url.origin, key), 302);
      } catch (e) {
        console.error("gmail connect", e);
        return new Response(String(e), { status: 500 });
      }
    }
    if (url.pathname === "/gmail/callback") {
      return await handleGmailCallback(env, url, url.origin);
    }

    if (url.pathname === "/member/onboard") {
      return handleMemberOnboarding(request, env, url);
    }

    if (url.pathname.startsWith("/multi/")) {
      return handleMultiHttp(request, env, url);
    }

    /* ══════════════ admin ══════════════ */

    if (url.pathname === "/admin/tenants") {
      if (!adminOk(env, url)) return json({ error: "unauthorized" }, 401);
      try {
        const list = await env.KV.list({ prefix: "tenant:" });
        const out = [];
        for (const k of list.keys) {
          const tenant = k.name.slice("tenant:".length);
          const sheetId = await env.KV.get(k.name);
          out.push({
            tenant, sheetId,
            connected: !!(await env.KV.get(`gtoken:${tenant}`)),
            hasDashToken: !!(await env.KV.get(`dtoken:${tenant}`)),
            setupDone: (await env.KV.get(`setup:${tenant}:${sheetId}`)) === "1",
            sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
          });
        }
        return json({ ok: true, count: out.length, tenants: out });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (url.pathname === "/admin/subscription" && request.method === "POST") {
      if (!adminOk(env, url)) return json({ error: "unauthorized" }, 401);
      const key = url.searchParams.get("tenant");
      if (!key) return json({ error: "missing tenant" }, 400);
      const sheetId = (await env.KV.get(`tenant:${key}`)) || env.DEFAULT_SHEET_ID;
      if (!sheetId) return json({ error: "no sheet for tenant" }, 404);
      try {
        const token = await getUserToken(env, key);

        const b = await request.json().catch(() => ({}));
        const plan = String(b.plan || "free").trim().toLowerCase();
        if (!SUBSCRIPTION_PLANS[plan]) return json({ error: "invalid plan" }, 400);
        const status = b.status === "active" ? "active" : b.status === "beta" ? "beta" : "free";
        const patch = {
          status,
          plan: status === "active" ? plan : status === "free" ? "free" : (plan === "free" ? "pro" : plan),
          cycle: b.cycle === "annual" ? "annual" : "monthly",
          activatedAt: status === "active" ? new Date().toISOString() : "",
        };
        if (b.clearRequest === true) Object.assign(patch, { requestedPlan: "", requestedCycle: "", upgradeRequestedAt: "" });
        await saveSubscriptionRecord(env, key, patch);
        return json(await getSubscriptionSnapshot(env, key, sheetId, token, { refreshUsage: true }));
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (url.pathname === "/admin/migrate") {
      if (!adminOk(env, url)) return json({ error: "unauthorized" }, 401);
      const key = url.searchParams.get("tenant");
      const override = url.searchParams.get("sheetId");
      const sheetId = override || (key && (await env.KV.get(`tenant:${key}`))) || env.DEFAULT_SHEET_ID;
      if (!sheetId) return json({ error: "no sheet — ใส่ ?sheetId= หรือ ?tenant= ที่ถูก" }, 404);
      try {
        const token = key ? await getUserToken(env, key) : null;
        const headers = await ensureHeaders(env, sheetId, token);
        const ids = await backfillIds(env, sheetId, token);
        const settings = await ensureSettingsTab(env, sheetId, token);
        const emailInbox = await ensureEmailInboxTab(env, sheetId, token);
        const batchTab = await ensureBatchTab(env, sheetId, token);
        const reconciliationTab = await ensureReconciliationTab(env, sheetId, token);
        const incomeTabs = await ensureIncomeTabs(env, sheetId, token);
        const accountingSuite = await ensureAccountingSuiteTabs(env, sheetId, token);
        return json({ ok: true, sheetId, usedOAuthToken: !!token, headers, ids, settings, emailInbox, batchTab, reconciliationTab, incomeTabs, accountingSuite });
      } catch (e) {
        console.error("migrate", e);
        return json({ error: String(e) }, 500);
      }
    }

    /* ══════════════ API ให้ dashboard ══════════════ */

    if (url.pathname.startsWith("/api/")) {
      const key = url.searchParams.get("tenant");
      if (!key) return cors(json({ error: "missing tenant" }, 400));

      const access = await resolveDashAccess(env,key,url.searchParams.get("k")||"");
      if (!access.ok) {
        return cors(json({error:"unauthorized",hint:'ลิงก์ไม่ถูกต้องหรือถูกยกเลิกแล้ว — พิมพ์ "แดชบอร์ด" ในกลุ่ม LINE เพื่อขอลิงก์ใหม่'},401));
      }

      // GOOGLE_STATUS_ROUTE_FIX_V7_51_1_20260815
      if(url.pathname==="/api/google-status"&&request.method==="GET"){
        try{
          return cors(json(await getGoogleConnectionStatus(env,key,{validate:false})));
        }catch(error){
          console.error("[google-status]",error);
          return cors(json({
            ok:false,connected:false,reconnectRequired:false,
            reason:"status_unavailable",message:"ตรวจสถานะ Google ไม่สำเร็จชั่วคราว"
          },503));
        }
      }
      if(!accessCan(access,url.pathname,request.method)){
        return cors(json({error:"forbidden",message:`สิทธิ์ ${DASH_ROLES[access.role]||access.role} ไม่สามารถทำรายการนี้ได้`},403));
      }

      const sheetId = (await env.KV.get(`tenant:${key}`)) || env.DEFAULT_SHEET_ID;
      if (!sheetId) return cors(json({ error: "no sheet for tenant" }, 404));

      try {
        // CONNECTION_STATUS_READONLY_V7_61_20260816
        // Read-only / KV / LINE / Gmail-management endpoints ต้องไม่แตะ Core Google token.
        const noCoreGoogleRequired=new Set([
          "/api/businesses",
          "/api/businesses/invite",
          "/api/gmail-status",
          "/api/gmail-disconnect",
          "/api/accounting/whoami",
          "/api/line-groups",
          "/api/line-workspaces/invite",
          "/api/line-groups/invite"
        ]);
        const needsCoreGoogle=!noCoreGoogleRequired.has(url.pathname);
        const token=needsCoreGoogle?await getUserToken(env,key):null;

        // token=null มี 2 ความหมายที่ต้องแยก:
        // A) refresh token ถูก revoke/expired จริง -> 401 และให้เชื่อมใหม่
        // B) Google/network ตอบพลาดชั่วคราว -> 503 ห้ามหลอกว่า OAuth หลุด
        if(needsCoreGoogle&&!token){
          const google=await getGoogleConnectionStatus(env,key,{validate:false});
          if(google.reconnectRequired===true){
            return cors(json({
              ok:false,
              error:"google_reconnect_required",
              message:"สิทธิ์ Google Sheet / Drive หมดอายุหรือถูกยกเลิก กรุณาเชื่อมใหม่ ข้อมูลเดิมยังอยู่",
              google,
            },401));
          }
          return cors(json({
            ok:false,
            error:"google_temporarily_unavailable",
            message:"Google ตอบกลับไม่สำเร็จชั่วคราว การเชื่อมต่อเดิมยังไม่ถูกยกเลิก กรุณาลองใหม่",
            google,
          },503));
        }

        if (url.pathname === "/api/subscription") {
          return cors(json(await getSubscriptionSnapshot(env, key, sheetId, token, { refreshUsage: true })));
        }

        if (url.pathname === "/api/subscription/request-upgrade" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await requestSubscriptionUpgrade(env, key, sheetId, token, b);
          return cors(json(out, out.ok ? 200 : 400));
        }


        if (url.pathname === "/api/line-groups") {
          if (access.role !== "owner") return cors(json({ ok:false, error:"owner_only" }, 403));
          // v7.36: ใช้ endpoint เดียวทั้งอ่านรายชื่อกลุ่ม (GET) และสร้างรหัสเชื่อมกลุ่ม (POST)
          // ทำให้ Dashboard ไม่พึ่ง endpoint ใหม่ที่ Worker เก่าบาง deployment ยังไม่รู้จัก
          if (request.method === "POST") {
            const out = await createLineWorkspaceInvite(env, key);
            return cors(json(out, out.ok ? 200 : 400));
          }
          return cors(json(await getLineGroupsOverview(env, key, {
            refresh: url.searchParams.get("refresh") === "1",
          })));
        }

        if ((url.pathname === "/api/line-workspaces/invite" || url.pathname === "/api/line-groups/invite") && request.method === "POST") {
          if (access.role !== "owner") return cors(json({ ok:false, error:"owner_only" }, 403));
          const out = await createLineWorkspaceInvite(env, key);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/businesses") {
          const info=await listBusinessWorkspaces(env,key);
          const google=await getGoogleConnectionStatus(env,key,{validate:false});
          if(access.role!=="owner"){
            const current=(info.businesses||[]).find(b=>b.isCurrent)||(info.businesses||[])[0];
            const base=(env.DASHBOARD_URL||"").replace(/\/$/,"");
            return cors(json({...info,google,businesses:current?[{...current,dashboardUrl:`${base}?tenant=${encodeURIComponent(key)}&k=${encodeURIComponent(url.searchParams.get("k")||"")}`}]:[],businessCount:1,businessLimit:1,canAddBusiness:false,restrictedByRole:true}));
          }
          return cors(json({...info,google}));
        }

        if (url.pathname === "/api/businesses/invite" && request.method === "POST") {
          const out = await createBusinessInvite(env, key);
          return cors(json(out, out.ok ? 200 : 402));
        }

        if (url.pathname === "/api/expenses") {
          const rows = await readExpenses(env, sheetId, token);
          // Dashboard projection: keep the accounting data intact in Sheets, but do not
          // ship heavy/duplicated fields (attachments array + batch internals) to the
          // browser when the dashboard only needs the expense/document view.
          if (url.searchParams.get("view") === "dashboard") {
            const dashboardFields = [
              "_row","dateText","date","dateISO","amount","vendor","category","note",
              "sender","imageUrl","img","status","createdAt","id","paid","needSlip",
              "type","subCategory","docType","payerName","payerId","vat","whtRate",
              "slipNo","transferor","claimPdfUrl","receiptPdfUrl","duplicateStatus","duplicateOf"
            ];
            return cors(json(rows.map((row) => {
              const out = {};
              for (const key of dashboardFields) out[key] = row[key] ?? "";
              return out;
            })));
          }
          return cors(json(rows));
        }

        /* รายรับ SME ไทย — ลูกหนี้, VAT, WHT และรับชำระบางส่วน */
        if (url.pathname === "/api/income") {
          const includeReconciliation = url.searchParams.get("reconciliation") !== "0";
          return cors(json(await getIncomeDashboard(env, sheetId, token, { includeReconciliation })));
        }

        if (url.pathname === "/api/income-create" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          await assertPeriodOpen(env, sheetId, b.issueDate || b.date || new Date(), token);
          const out = await createIncome(env, sheetId, b, token);
          if(out.ok){
            await postIncomeInvoiceJournal(env,sheetId,out.record,token,access.name||"Dashboard").catch(e=>console.warn("income journal",e.message));
            if(out.payment)await postIncomePaymentJournal(env,sheetId,out.payment,token,access.name||"Dashboard").catch(e=>console.warn("income payment journal",e.message));
            if(out.record?.customer&&!/ทั่วไป|ไม่ระบุ/.test(out.record.customer))await upsertContact(env,sheetId,{type:"ลูกค้า",name:out.record.customer,taxId:out.record.customerTaxId,branch:out.record.customerBranch,source:"Auto Income"},token,access.name||"Dashboard").catch(()=>{});
            await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"CREATE_INCOME",entityType:"income",entityId:out.record?.id||"",summary:`บันทึกรายรับ ${out.record?.customer||""} ${out.record?.grossAmount||0}`,after:out.record});
          }
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/income-update" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const before=(await getIncomeDashboard(env,sheetId,token,{includeReconciliation:false})).records?.find(r=>String(r.id)===String(b.id||b.incomeId));
          if(before)await assertPeriodOpen(env,sheetId,b.patch?.issueDate||before.issueDate,token);
          const out = await updateIncome(env, sheetId, b.id || b.incomeId, b.patch || b, token);
          if(out.ok)await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"UPDATE_INCOME",entityType:"income",entityId:out.record?.id||b.id||b.incomeId,summary:`แก้ไขรายรับ ${out.record?.customer||""}`,before,after:out.record});
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/income-payment" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const pay=b.payment||b;
          await assertPeriodOpen(env,sheetId,pay.receivedDate||new Date(),token);
          const out = await addIncomePayment(env, sheetId, b.id || b.incomeId, pay, token);
          if(out.ok){await postIncomePaymentJournal(env,sheetId,out.payment,token,access.name||"Dashboard").catch(e=>console.warn("income payment journal",e.message));await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"RECEIVE_INCOME",entityType:"income",entityId:out.record?.id||b.id||b.incomeId,summary:`รับชำระ ${out.payment?.cashAmount||0} + WHT ${out.payment?.whtAmount||0}`,after:out.payment});}
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/income-payment-update" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await updateIncomePayment(env, sheetId, b.paymentId || b.id, b.patch || b, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/income-reconciliation-import" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await importIncomeReconciliationRows(env, sheetId, b, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/income-reconciliation-confirm" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await confirmIncomeReconciliationMatches(env, sheetId, b, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/income-reconciliation-ignore" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await ignoreIncomeReconciliationRow(env, sheetId, b.reconciliationId || b.id, b.note || "", token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/income-reconciliation-unlink" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await unlinkIncomeReconciliation(env, sheetId, b.reconciliationId || b.id, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/income-upload" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          if (!b.base64) return cors(json({ ok:false, error:"no_file" }, 400));
          const link = await uploadTenantImage(env, key, b.base64, b.mediaType || "image/jpeg", b.name || `income-${Date.now()}`, token, { category:"originals" });
          return cors(json({ ok:true, url:link }));
        }

        // AUTO_CASH_POSITION_V7_69_20260816
        // Manual finance_balances is a baseline snapshot; real transactions after that
        // automatically move the effective balance by selected paymentChannelId.
        if (url.pathname === "/api/cash-position" && request.method === "GET") {
          return cors(json(await getCashPosition(env, key, sheetId, token)));
        }

        /* Accounting Suite v7 — migration / AP / close / tax / audit / ledger */
        if (url.pathname === "/api/accounting/bootstrap") {
          await ensureAccountingSuiteTabs(env, sheetId, token);
          return cors(json({ ok:true, version:ACCOUNTING_SUITE_VERSION }));
        }
        if (url.pathname === "/api/accounting/access") {
          if(access.role!=="owner")return cors(json({ok:false,error:"owner_only"},403));
          if(request.method==="POST"){
            const b=await request.json().catch(()=>({}));
            const rec=await createDashAccess(env,key,b);
            const base=(env.DASHBOARD_URL||"").replace(/\/$/,"");
            let record={...rec,url:`${base}?tenant=${encodeURIComponent(key)}&k=${rec.token}`};
            let lineNotification={attempted:false,sent:false,accepted:false};
            // WORKFLOW_LINE_NOTIFY_ROLE_FIX_V7_68_20260816
            if(["approver","accountant"].includes(rec.role)&&rec.lineUserId){
              lineNotification=await notifyApproverAssignment(env,key,record)
                .catch(e=>({ok:false,attempted:true,sent:false,accepted:false,reason:String(e?.message||e).slice(0,180)}));
              const saved=await patchDashAccessRecord(env,key,rec.token,lineNotificationPatch(lineNotification));
              if(saved)record={...saved,url:`${base}?tenant=${encodeURIComponent(key)}&k=${rec.token}`};
            }
            return cors(json({ok:true,record,lineNotification}));
          }
          const rows=await listDashAccess(env,key);const base=(env.DASHBOARD_URL||"").replace(/\/$/,"");return cors(json({ok:true,role:access.role,rows:rows.map(r=>({...r,url:`${base}?tenant=${encodeURIComponent(key)}&k=${r.token}`}))}));
        }
        if (url.pathname === "/api/accounting/access-revoke" && request.method === "POST") {
          if(access.role!=="owner")return cors(json({ok:false,error:"owner_only"},403));const b=await request.json().catch(()=>({}));return cors(json(await revokeDashAccess(env,key,b.token||"")));
        }

        if (url.pathname === "/api/accounting/access-notify" && request.method === "POST") {
          if(access.role!=="owner")return cors(json({ok:false,error:"owner_only"},403));
          const b=await request.json().catch(()=>({}));
          const accessToken=String(b.token||"").trim();
          const current=await readDashAccessRecord(env,key,accessToken);
          if(!current||current.active===false)return cors(json({ok:false,error:"access_not_found",message:"ไม่พบสิทธิ์ผู้ใช้งานนี้"},404));
          if(!["approver","accountant"].includes(current.role)||!current.lineUserId)return cors(json({
            ok:false,
            error:"workflow_line_not_linked",
            message:"สิทธิ์นี้ยังไม่ได้ผูก LINE สำหรับ Workflow กรุณาเลือกพนักงานจากกลุ่ม LINE ก่อน"
          },400));
          const base=(env.DASHBOARD_URL||"").replace(/\/$/,"");
          const record={...current,token:accessToken,url:`${base}?tenant=${encodeURIComponent(key)}&k=${accessToken}`};
          const lineNotification=await notifyApproverAssignment(env,key,record)
            .catch(e=>({ok:false,attempted:true,sent:false,accepted:false,reason:String(e?.message||e).slice(0,180)}));
          const saved=await patchDashAccessRecord(env,key,accessToken,lineNotificationPatch(lineNotification));
          return cors(json({
            ok:true,
            delivered:lineNotification?.sent===true||lineNotification?.accepted===true,
            fallbackGroupSent:lineNotification?.fallbackGroupSent===true,
            message:(lineNotification?.sent===true||lineNotification?.accepted===true)
              ?"ส่ง LINE ส่วนตัวสำเร็จ"
              :(lineNotification?.fallbackGroupSent===true
                ?"ส่งคำแนะนำเข้า LINE กลุ่มแล้ว ให้ผู้ใช้เปิดแชท LINE OA และพิมพ์ “เชื่อม” แล้วกดส่ง LINE ใหม่อีกครั้ง"
                :"ยังส่ง LINE ส่วนตัวไม่ได้ ให้ผู้ใช้เปิดแชท LINE OA และพิมพ์ “เชื่อม” 1 ครั้ง แล้วลองส่งใหม่"),
            lineNotification,
            record:saved?{...saved,url:record.url}:record,
          }));
        }

        // TEAM_AUTO_ONBOARDING_V7_40_20260814: ทีมจาก LINE + การเชิญลงทะเบียน
        if (url.pathname === "/api/team-directory") {
          if (access.role !== "owner") return cors(json({ok:false,error:"owner_only"},403));
          const out = await teamDirectoryV740(env, key, { refresh:url.searchParams.get("refresh")==="1" });
          return cors(json(out));
        }

        if (url.pathname === "/api/team-invite-group" && request.method === "POST") {
          if (access.role !== "owner") return cors(json({ok:false,error:"owner_only"},403));
          const b = await request.json().catch(()=>({}));
          const groups = await getLineGroupsOverview(env,key,{refresh:false});
          const requested = String(b.groupTenant || "").trim();
          const group = (groups.rows || []).find((x) => String(x.tenant || x.groupId || "") === requested)
            || (groups.rows || []).find((x) => /^C|^R/i.test(String(x.tenant || x.groupId || "")));
          if (!group) return cors(json({ok:false,error:"no_line_group",message:"ยังไม่มีกลุ่ม LINE ที่เชื่อมกับบริษัทนี้"},404));
          const groupTenant = String(group.tenant || group.groupId || "").trim();
          const companyName = await companyNameForV740(env,key);
          const sent = await push(env, groupTenant, memberRegistrationGroupCardV740(companyName)).catch(()=>false);
          return cors(json({ok:sent,sent,groupTenant,groupName:group.groupName||"",message:sent?"ส่งคำเชิญลงทะเบียนในกลุ่มแล้ว":"ส่งเข้า LINE ไม่สำเร็จ"},sent?200:400));
        }

        if (url.pathname === "/api/team-invite-user" && request.method === "POST") {
          if (access.role !== "owner") return cors(json({ok:false,error:"owner_only"},403));
          const b = await request.json().catch(()=>({}));
          const lineUserId = String(b.lineUserId || "").trim();
          if (!validLineUserV740(lineUserId)) return cors(json({ok:false,error:"invalid_line_user"},400));
          const directory = await teamDirectoryV740(env,key,{refresh:false});
          const known = (directory.rows || []).some((x)=>String(x.lineUserId||"")===lineUserId);
          if (!known) return cors(json({ok:false,error:"user_not_in_team",message:"ไม่พบสมาชิก LINE คนนี้ในบริษัท"},404));
          const profileUrl = await createMemberOnboardingUrl(env,{
            tenant:key,lineUserId,displayName:"",pendingId:""
          });
          const sent = await push(env,lineUserId,memberRegistrationPrivateCardV740(profileUrl,directory.companyName||"บริษัทนี้")).catch(()=>false);
          return cors(json({
            ok:sent,sent,
            message:sent?"ส่งลิงก์ลงทะเบียนส่วนตัวแล้ว":"ยังส่งส่วนตัวไม่ได้ ให้สมาชิกเพิ่ม LINE OA เป็นเพื่อนก่อน"
          },sent?200:400));
        }

        if (url.pathname === "/api/line-members") {
          if(access.role!=="owner")return cors(json({ok:false,error:"owner_only"},403));

          // APPROVER_GROUP_DIRECTORY_V7_26_2_20260812
          // Owner may use a LINE group inside the SAME account only as the member directory.
          // This never grants access to arbitrary groupIds from another customer/account.
          const requestedSourceTenant = String(url.searchParams.get("sourceTenant") || "").trim();
          let sourceTenant = key;

          if (requestedSourceTenant && requestedSourceTenant !== key) {
            const groups = await getLineGroupsOverview(env,key,{refresh:false});
            const allowed = (groups.rows || []).find((row) =>
              String(row.tenant || "") === requestedSourceTenant &&
              (String(row.sourceType || "") === "group" || String(row.groupId || "").startsWith("C"))
            );
            if (!allowed) {
              return cors(json({
                ok:false,
                error:"line_group_not_in_account",
                message:"กลุ่ม LINE นี้ไม่ได้อยู่ในบัญชี/Workspace ชุดนี้",
              },403));
            }
            sourceTenant = requestedSourceTenant;
          }

          const sourceSheetId = (await env.KV.get(`tenant:${sourceTenant}`)) || sheetId;
          const sourceToken = (await getUserToken(env,sourceTenant).catch(()=>null)) || token;

          const out = await listLineWorkspaceMembers(env,sourceTenant,{
            sheetId:sourceSheetId,
            token:sourceToken,
            refresh:url.searchParams.get("refresh")!=="0",
          });

          return cors(json({
            ...out,
            selectedSourceTenant:sourceTenant,
            approvalTenant:key,
          }));
        }

        if (url.pathname === "/api/accounting/access-line" && request.method === "POST") {
          if(access.role!=="owner")return cors(json({ok:false,error:"owner_only"},403));
          const b=await request.json().catch(()=>({}));
          const out=await bindApproverLine(env,key,b.token||"",b.lineUserId||"");
          if(out.ok){
            const base=(env.DASHBOARD_URL||"").replace(/\/$/,"");
            let record={...out.record,url:`${base}?tenant=${encodeURIComponent(key)}&k=${out.record.token}`};
            const lineNotification=await notifyApproverAssignment(env,key,record)
              .catch(e=>({ok:false,attempted:true,sent:false,accepted:false,reason:String(e?.message||e).slice(0,180)}));
            const saved=await patchDashAccessRecord(env,key,out.record.token,lineNotificationPatch(lineNotification));
            if(saved)record={...saved,url:`${base}?tenant=${encodeURIComponent(key)}&k=${out.record.token}`};
            return cors(json({ok:true,record,lineNotification}));
          }
          return cors(json(out,400));
        }

        if (url.pathname === "/api/accounting/whoami") return cors(json({ok:true,role:access.role,roleLabel:DASH_ROLES[access.role]||access.role,name:access.name||"",lineUserId:access.lineUserId||""}));
        if (url.pathname === "/api/accounting/search") return cors(json(await searchAccounting(env, sheetId, token, { q: url.searchParams.get("q") || "", limit: url.searchParams.get("limit") || 80 })));
        if (url.pathname === "/api/accounting/today") return cors(json(await getTodayWork(env, sheetId, token)));
        if (url.pathname === "/api/accounting/contacts") {
          if (request.method === "POST") {
            const b=await request.json().catch(()=>({}));
            const out=await upsertContact(env,sheetId,b,token,access.name||"Dashboard");
            return cors(json(out,out.ok?200:400));
          }
          return cors(json(await getContacts(env,sheetId,token)));
        }
        if (url.pathname === "/api/accounting/contact-statement") {
          return cors(json(await getContactStatement(env,sheetId,{contactId:url.searchParams.get("contactId")||"",name:url.searchParams.get("name")||"",taxId:url.searchParams.get("taxId")||""},token)));
        }
        if (url.pathname === "/api/accounting/payables") {
          if (request.method === "POST") {
            const b=await request.json().catch(()=>({}));
            const out=await createPayable(env,sheetId,b,token,access.name||"Dashboard");
            return cors(json(out,out.ok?200:400));
          }
          return cors(json(await getPayables(env,sheetId,token)));
        }
        if (url.pathname === "/api/accounting/payable-update" && request.method === "POST") {
          const b=await request.json().catch(()=>({}));
          const out=await updatePayable(env,sheetId,b.id||b.apId,b.patch||b,token,access.name||"Dashboard");
          return cors(json(out,out.ok?200:400));
        }
        if (url.pathname === "/api/accounting/payable-payment" && request.method === "POST") {
          const b=await request.json().catch(()=>({}));
          const out=await addPayablePayment(env,sheetId,b.id||b.apId,b.payment||b,token,access.name||"Dashboard");
          return cors(json(out,out.ok?200:400));
        }
        if (url.pathname === "/api/accounting/opening") {
          if (request.method === "POST") {
            const b=await request.json().catch(()=>({}));
            const out=await addOpeningBalance(env,sheetId,b,token,access.name||"Dashboard");
            return cors(json(out,out.ok?200:400));
          }
          return cors(json(await getOpeningBalances(env,sheetId,token)));
        }
        if (url.pathname === "/api/accounting/migration") {
          if (request.method === "POST") {
            const b=await request.json().catch(()=>({}));
            const out=await importMigration(env,sheetId,b,token,access.name||"Dashboard");
            return cors(json(out,out.ok?200:400));
          }
          return cors(json(await getMigrationDashboard(env,sheetId,token)));
        }
        if (url.pathname === "/api/accounting/period") {
          const period=url.searchParams.get("period")||"";
          return cors(json(await getPeriodDashboard(env,sheetId,period,token)));
        }
        if (url.pathname === "/api/accounting/period-close" && request.method === "POST") {
          const b=await request.json().catch(()=>({}));
          const out=await closePeriod(env,sheetId,b.period,b,token,access.name||"Dashboard");
          return cors(json(out,out.ok?200:409));
        }
        if (url.pathname === "/api/accounting/period-reopen" && request.method === "POST") {
          const b=await request.json().catch(()=>({}));
          const out=await reopenPeriod(env,sheetId,b.period,b.reason,token,access.name||"Dashboard");
          return cors(json(out,out.ok?200:400));
        }
        if (url.pathname === "/api/accounting/tax") {
          return cors(json(await getTaxCenter(env,sheetId,url.searchParams.get("period")||"",token)));
        }
        if (url.pathname === "/api/accounting/audit") {
          return cors(json(await getAudit(env,sheetId,token,{limit:url.searchParams.get("limit")||300})));
        }
        if (url.pathname === "/api/accounting/ledger") {
          return cors(json(await getLedger(env,sheetId,token,{from:url.searchParams.get("from")||"",to:url.searchParams.get("to")||""})));
        }
        if (url.pathname === "/api/accounting/journal" && request.method === "POST") {
          const b=await request.json().catch(()=>({}));
          const out=await postJournal(env,sheetId,{date:b.date||new Date(),reference:b.reference||"",description:b.description||"รายการปรับปรุง",sourceType:"manual",sourceId:b.sourceId||crypto.randomUUID(),actor:access.name||"Dashboard",lines:Array.isArray(b.lines)?b.lines:[]},token);
          if(out.ok&&!out.duplicate)await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"POST_JOURNAL",entityType:"journal",entityId:out.journalId||"",summary:`ลงรายการปรับปรุง ${b.reference||""} เดบิต/เครดิต ${out.debit||0}`,after:b});
          return cors(json(out,out.ok?200:400));
        }
        if (url.pathname === "/api/accounting/backup") {
          return cors(json(await getBackup(env,sheetId,token)));
        }

        // ลิงก์ทางลัดจาก Dashboard ไปยังพื้นที่เอกสารของบริษัทจริง
        if (url.pathname === "/api/workspace-links") {
          const settings = await readSettings(env, sheetId, token).catch(() => ({}));
          const folders = await ensureTenantDriveFolders(env, key, token, {
            companyName: settings.company_name || "พื้นที่บริษัท",
            sheetId,
          });
          const organizeKey = `driveorganized:${key}:${sheetId}:v2-monthly`;
          if ((await env.KV.get(organizeKey)) !== "1") {
            ctx.waitUntil((async () => {
              try {
                const [expenses, emailDocs] = await Promise.all([
                  readExpenses(env, sheetId, token),
                  listEmailDocuments(env, sheetId, token).catch(() => []),
                ]);
                const result = await organizeTenantReferencedFiles(
                  folders.accessToken, folders, expenses, emailDocs
                );
                await env.KV.put(organizeKey, "1");
                console.log(`[drive-organize] tenant=${key} total=${result.total} moved=${result.moved} failed=${result.failed}`);
              } catch (error) {
                console.warn(`[drive-organize] tenant=${key}`, error.message);
              }
            })());
          }
          return cors(json({
            ok: true,
            sheetId,
            sheetUrl: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/edit`,
            driveUrl: tenantDriveFolderUrl(folders),
            driveMode: token ? "oauth-project-folder" : "service-project-folder",
            folders: {
              company: folders.companyFolderId,
              claims: folders.claimsFolderId,
              replacements: folders.replacementsFolderId,
              originals: folders.originalsFolderId,
              payments: folders.paymentsFolderId,
              email: folders.emailFolderId,
            },
          }));
        }

        if (url.pathname === "/api/slip-items") {
          const onlyUnissued = url.searchParams.get("all") !== "1";
          return cors(json(await listForSlip(env, sheetId, token, { onlyUnissued })));
        }

        if (url.pathname === "/api/slip-toggle" && request.method === "POST") {
          const b = await request.json();
          let out;
          if (typeof b.value === "boolean") {
            const r = await updateExpenseById(env, sheetId, b.id, { needSlip: b.value }, token);
            out = r.ok ? { ok: true, needSlip: b.value } : r;
          } else {
            out = await toggleNeedSlip(env, sheetId, b.id, token);
          }
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/settings") {
          if (request.method === "POST") {
            const b = await request.json();
            const beforeSettings=await readSettings(env,sheetId,token).catch(()=>({}));
            const saved = await writeSettings(env, sheetId, b, token);
            if(String(saved?.company_name||"").trim()){
              await saveBusinessMeta(env,key,{name:String(saved.company_name).trim(),sheetId});
            }
            await ensureTenantDriveFolders(env, key, token, {
              companyName: b.company_name || saved.company_name || "พื้นที่บริษัท",
              sheetId,
            });
            await env.KV.delete(`setup:${key}`);              // ของเก่า
            await env.KV.delete(`setup:${key}:${sheetId}`);   // ให้เช็คใหม่รอบหน้า
            await env.KV.delete(`companysetup:v3:${key}:${sheetId}`);
            await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"UPDATE_SETTINGS",entityType:"settings",entityId:key,summary:`แก้ไขตั้งค่าบริษัท ${Object.keys(b||{}).join(", ")}`,before:beforeSettings,after:saved});
            return cors(json(saved));
          }
          return cors(json(await readSettings(env, sheetId, token)));
        }

        /* Gmail OAuth — เชื่อมโดยตรงสำหรับ Beta */
        if (url.pathname === "/api/gmail-status") {
          return cors(json(await getGmailStatus(env, key, { validate: false })));
        }

        if (url.pathname === "/api/gmail-sync" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await syncGmailAccount(env, key, {
            maxMessages: Math.max(1, Math.min(30, Number(b.maxMessages || 15))),
            notify: b.notify !== false,
          });
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/gmail-disconnect" && request.method === "POST") {
          return cors(json(await disconnectGmail(env, key)));
        }

        /* Email Inbox เดิมแบบ Forward — ยังเก็บไว้เป็น fallback */
        if (url.pathname === "/api/email-inbox-info") {
          if (request.method === "POST") {
            const b = await request.json().catch(() => ({}));
            const info = b.rotate ? await rotateEmailInbox(env, key) : await getEmailInboxInfo(env, key);
            await ensureEmailInboxTab(env, sheetId, token);
            return cors(json({ ok: true, ...info }));
          }
          const info = await getEmailInboxInfo(env, key);
          await ensureEmailInboxTab(env, sheetId, token);
          return cors(json({ ok: true, ...info }));
        }

        if (url.pathname === "/api/email-documents") {
          return cors(json(await listEmailDocuments(env, sheetId, token)));
        }

        if (url.pathname === "/api/subscriptions") {
          return cors(json(await listSubscriptions(env, sheetId, token)));
        }

        if (url.pathname === "/api/email-update" && request.method === "POST") {
          const b = await request.json();
          const out = await patchEmailDocument(env, sheetId, b.id, b.patch || {}, token);
          if(out.ok)await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"UPDATE_EMAIL_DOC",entityType:"email_document",entityId:b.id,summary:"แก้ไขเอกสารจากอีเมล",after:b.patch||{}});
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/email-ignore" && request.method === "POST") {
          const b = await request.json();
          const out = await patchEmailDocument(env, sheetId, b.id, { status: "ข้ามแล้ว" }, token);
          if(out.ok)await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"IGNORE_EMAIL_DOC",entityType:"email_document",entityId:b.id,summary:"ข้ามเอกสารจากอีเมล",after:{status:"ข้ามแล้ว"}});
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/email-approve" && request.method === "POST") {
          const quota = await getSubscriptionSnapshot(env, key, sheetId, token);
          if (quota.blocked) return cors(json({ ok: false, reason: "subscription_limit", subscription: quota }, 402));
          const b = await request.json();
          const out = await approveEmailDocument(env, sheetId, b.id, token, { force: b.force === true });
          if (out.ok) {await syncSubscriptionUsageAfterSavedExpense(env, key, sheetId, token).catch((e) => console.warn("subscription usage email", e?.message || e));await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"APPROVE_EMAIL_DOC",entityType:"email_document",entityId:b.id,summary:"อนุมัติเอกสารจากอีเมลเข้าสู่ระบบ",after:out});}
          return cors(json(out, out.ok ? 200 : (out.reason === "duplicate" ? 409 : 400)));
        }

        /* ใบเบิกหลัก — รวมหลายรายการย่อยของผู้เบิกเป็นไฟล์เดียว */
        if (url.pathname === "/api/batches") {
          return cors(json(await getBatchDashboard(env, sheetId, token)));
        }

        if (url.pathname === "/api/batch-close" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await createReimbursementBatches(env, key, sheetId, token, {
            type: b.type === "ด่วน" ? "ด่วน" : "ปกติ",
            payerKey: b.payerKey || "",
            expenseIds: Array.isArray(b.expenseIds) ? b.expenseIds : [],
            batchIds: Array.isArray(b.batchIds) ? b.batchIds : [],
            note: b.note || "สร้างหรือรวมใบเบิกด้วยตนเองจาก Dashboard",
          });
          if(out.ok){
            await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"CREATE_BATCH",entityType:"reimbursement_batch",entityId:out.batchId||out.id||"",summary:`สร้าง/รวมรอบเบิก ${b.type||"ปกติ"}`,after:out});
            ctx.waitUntil(notifyApproversForBatchOutput(env,key,out,{kind:b.type==="ด่วน"?"urgent-dashboard":"manual-dashboard"}).catch(e=>console.warn("approver batch notify",e?.message||e)));
          }
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/batch-urgent" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const ids = Array.isArray(b.expenseIds) ? b.expenseIds : [b.id].filter(Boolean);
          const out = await requestUrgentBatch(env, key, sheetId, token, ids);
          if(out.ok){
            await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"REQUEST_URGENT",entityType:"expense",entityId:ids.join(","),summary:`ขอเบิกด่วน ${ids.length} รายการ`,after:out});
            ctx.waitUntil(notifyApproversForBatchOutput(env,key,out,{kind:"urgent-dashboard"}).catch(e=>console.warn("approver urgent notify",e?.message||e)));
          }
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/batch-status" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await updateReimbursementBatchStatus(env, sheetId, b.batchId, b.status, token);
          if(out.ok)await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"BATCH_STATUS",entityType:"reimbursement_batch",entityId:b.batchId,summary:`เปลี่ยนสถานะรอบเบิกเป็น ${b.status}`,after:{status:b.status}});
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/batch-workflow" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const out = await updateReimbursementBatchWorkflow(env, sheetId, b.batchId, b.action, b.payload || {}, token, { tenant: key });
          if(out.ok)await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:`BATCH_${String(b.action||"WORKFLOW").toUpperCase()}`,entityType:"reimbursement_batch",entityId:b.batchId,summary:`ดำเนินการรอบเบิก: ${b.action||"workflow"}`,after:b.payload||{}});
          return cors(json(out, out.ok ? 200 : 400));
        }

        // รายการย่อยที่ยังไม่ได้รวมใบเบิก: ตรวจผ่าน/ตีกลับได้ทันที
        // ถ้ากดผ่าน ระบบจะสร้างใบเบิก 1 รายการเบื้องหลัง แล้วเข้าสู่รอโอน
        if (url.pathname === "/api/expense-workflow" && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const before=await getExpenseById(env,sheetId,b.expenseId,token);
          if(before)await assertPeriodOpen(env,sheetId,before.dateISO||before.dateText||new Date(),token);
          const out = await updateExpenseReviewWorkflow(env, key, sheetId, b.expenseId, b.action, b.payload || {}, token);
          if(out.ok)await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:`EXPENSE_${String(b.action||"WORKFLOW").toUpperCase()}`,entityType:"expense",entityId:b.expenseId,summary:`ดำเนินการรายจ่าย: ${b.action||"workflow"}`,before,after:out});
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/batch-payment-slip" && request.method === "POST") {
          const form = await request.formData();
          const batchId = String(form.get("batchId") || "");
          const paymentChannelId = String(form.get("paymentChannelId") || "");
          const file = form.get("file");
          const out = await uploadReimbursementPaymentSlip(env, sheetId, batchId, file, token, { paymentChannelId, tenant: key });
          if(out.ok){
            await postReimbursementPaymentJournal(env,sheetId,out.record||{id:batchId,batchId,total:out.total,paidAt:new Date().toISOString()},token,access.name||"Dashboard").catch(e=>console.warn("reimbursement payment journal",e.message));
            await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"UPLOAD_PAYMENT_SLIP",entityType:"reimbursement_batch",entityId:batchId,summary:"อัปโหลดหลักฐานโอนเงินคืน",after:{paymentChannelId}});
          }
          return cors(json(out, out.ok ? 200 : 400));
        }

        /* กระทบยอดธนาคาร — Statement ↔ ใบเบิกที่จ่ายแล้ว */
        if (url.pathname === "/api/reconciliation") {
          const channelId = String(url.searchParams.get("channelId") || "");
          return cors(json(await getReconciliationDashboard(env, sheetId, token, { channelId })));
        }

        if (url.pathname === "/api/reconciliation-import" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const out = await importReconciliationRows(env, sheetId, body, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/reconciliation-confirm" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const out = await confirmReconciliationMatches(env, sheetId, body, token);
          if(out.ok)await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"RECONCILE_CONFIRM",entityType:"reconciliation",entityId:"multiple",summary:`ยืนยันกระทบยอด ${Array.isArray(body.pairs)?body.pairs.length:1} รายการ`,after:body});
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/reconciliation-unlink" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const out = await unlinkReconciliationMatch(env, sheetId, body.reconciliationId || body.id, token);
          if(out.ok)await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"RECONCILE_UNLINK",entityType:"reconciliation",entityId:body.reconciliationId||body.id,summary:"ยกเลิกการจับคู่กระทบยอด",after:body});
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/reconciliation-ignore" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const out = await ignoreReconciliationRow(env, sheetId, body.reconciliationId || body.id, body.note || "", token);
          if(out.ok)await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"RECONCILE_IGNORE",entityType:"reconciliation",entityId:body.reconciliationId||body.id,summary:"ข้ามรายการกระทบยอด",after:body});
          return cors(json(out, out.ok ? 200 : 400));
        }

        // สร้าง/สร้างใหม่ ใบเบิก + ใบแทนของรายการเดียว
        // หน้าเอกสารเรียกอัตโนมัติเมื่อเปิดรายการเก่าที่ยังไม่มีไฟล์
        if (url.pathname === "/api/generate-docs" && request.method === "POST") {
          const b = await request.json();
          const rec = await getExpenseById(env, sheetId, b.id, token);
          if (!rec) return cors(json({ error: "not_found" }, 404));
          if (!b.force && rec.claimPdfUrl && rec.receiptPdfUrl) {
            return cors(json({ ok: true, skipped: true, record: rec }));
          }
          const setup = await checkSetup(env, key, { sheetId, token });
          if (setup) {
            return cors(json({
              error: "settings_incomplete",
              hint: setup.warn,
              missing: setup.missing || [],
            }, 400));
          }
          const settings = await readSettings(env, sheetId, token);
          if (!documentSettingsReady(settings)) {
            return cors(json({
              error: "settings_incomplete",
              hint: "ตั้งค่าข้อมูลบริษัท โลโก้ ลายเซ็น และช่องทางการโอนเงินให้ครบก่อนสร้างเอกสาร",
            }, 400));
          }
          const member = findMemberProfile(settings, {
            lineUserId: rec.payerId,
            name: rec.payerName || rec.sender,
          });
          const docRec = member ? {
            ...rec,
            payerName: member.name || rec.payerName,
            bankName: member.bank || "",
            bankAccountNo: member.accountNo || "",
            bankAccountName: member.accountName || member.name || "",
          } : rec;
          const docs = await createExpenseDocuments(env, docRec, settings, token, {
            tenant: key, companyName: settings.company_name || "พื้นที่บริษัท", sheetId,
          });
          const patch = {
            slipNo: docs.receiptNo,
            claimPdfUrl: docs.claimUrl,
            receiptPdfUrl: docs.receiptUrl,
          };
          await updateExpenseById(env, sheetId, rec.id, patch, token);
          await writeAudit(env,sheetId,token,{actor:access.name||"Dashboard",action:"GENERATE_DOCS",entityType:"expense",entityId:rec.id,summary:"สร้าง/สร้างใหม่ใบเบิกและใบแทน",before:{claimPdfUrl:rec.claimPdfUrl,receiptPdfUrl:rec.receiptPdfUrl},after:patch});
          return cors(json({ ok: true, record: { ...rec, ...patch } }));
        }

        if (url.pathname === "/api/orphans") {
          const folders = await ensureTenantDriveFolders(env, key, token, {
            companyName: (await readSettings(env, sheetId, token).catch(() => ({}))).company_name || "พื้นที่บริษัท",
            sheetId,
          });
          const [files, used] = await Promise.all([
            listUploadedImages(env, token, { folderId: folderIdForCategory(folders, "originals") }),
            usedFileIds(env, sheetId, token),
          ]);
          const unlinked = files.filter((f) => !used.has(f.fileId));
          const showAll = url.searchParams.get("all") === "1";
          return cors(json({
            total: files.length,
            linked: files.length - unlinked.length,
            types: ATTACH_TYPES,
            files: showAll ? files : unlinked,
          }));
        }
        // อัปโลโก้ / ลายเซ็นเข้า Drive และบันทึก URL ลง _settings ทันที
        // ไม่ต้องพึ่งให้ผู้ใช้กดปุ่มบันทึกซ้ำ และกันค่าถูกลบจากการบันทึกแบบ partial field
        if (url.pathname === "/api/upload-image" && request.method === "POST") {
          const b = await request.json();
          if (!b.base64) return cors(json({ error: "no image" }, 400));

          const kind = String(b.kind || "").trim().toLowerCase();
          const link = await uploadTenantImage(
            env, key, b.base64, b.mediaType || "image/png",
            b.name || `asset-${Date.now()}.png`, token,
            { category: "assets" }
          );
          if (!link) return cors(json({ error: "upload failed" }, 500));

          const m = String(link).match(/\/d\/([a-zA-Z0-9_-]{20,})/);
          const publicUrl = m ? `https://lh3.googleusercontent.com/d/${m[1]}` : link;
          const settingPatch = kind === "logo"
            ? { logo_url: publicUrl }
            : (["sign", "signature", "approver_sign"].includes(kind)
              ? { approver_sign_url: publicUrl }
              : {});
          const settings = Object.keys(settingPatch).length
            ? await writeSettings(env, sheetId, settingPatch, token)
            : await readSettings(env, sheetId, token);
          const savedField = kind === "logo" ? "logo_url" : "approver_sign_url";
          if (Object.keys(settingPatch).length && !String(settings[savedField] || "").trim()) {
            return cors(json({ error: "asset_setting_not_persisted", field: savedField }, 500));
          }

          return cors(json({
            ok: true,
            kind,
            url: settings[savedField] || publicUrl,
            saved: Object.keys(settingPatch).length > 0,
            persisted: true,
            settings,
          }));
        }
        if (url.pathname === "/api/attach" && request.method === "POST") {
          const b = await request.json();
          const out = await addAttachment(env, sheetId, b.id, b.type, b.url, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        if (url.pathname === "/api/detach" && request.method === "POST") {
          const b = await request.json();
          const out = await removeAttachment(env, sheetId, b.id, b.url, token);
          return cors(json(out, out.ok ? 200 : 400));
        }

        return cors(json({ error: "unknown endpoint" }, 404));
      } catch (e) {
        console.error(url.pathname, e);
        const quotaExceeded = e?.status === 429 || e?.isQuota || /Sheets 429|RESOURCE_EXHAUSTED|Quota exceeded/i.test(String(e?.message || e));
        if (quotaExceeded) {
          const res = json({
            error: "sheets_rate_limited",
            message: "Google Sheets ถูกเรียกถี่เกินไป ระบบหยุดยิงซ้ำแล้ว กรุณารอประมาณ 1 นาทีแล้วลองใหม่",
            retryAfterSeconds: Math.max(60, Number(e?.retryAfter || 0)),
          }, 429);
          res.headers.set("Retry-After", String(Math.max(60, Number(e?.retryAfter || 0))));
          return cors(res);
        }
        return cors(json({ error: String(e) }, 500));
      }
    }

    if (request.method === "GET") return json({ version: VERSION, ok: true });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const raw = await request.text();
    if (!(await verifySignature(env, raw, request.headers.get("x-line-signature"))))
      return new Response("bad signature", { status: 401 });

    let body;
    try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

    for (const event of body.events || []) {
      const rawKey = tenantKey(event.source);
      const key = await operationalTenantKey(env, rawKey);
      ctx.waitUntil(
        rememberLineEventMembers(env,event)
          .catch(e=>console.warn("remember LINE member",rawKey,e?.message||e))
      );
      const isImage = event.type === "message" && event.message?.type === "image";
      const postbackAct = event.type === "postback" ? new URLSearchParams(event.postback?.data || "").get("act") : "";
      const isConfirm = postbackAct === "confirm" || postbackAct === "confirm_force" || postbackAct === "multi_confirm";

      // TEAM_AUTO_ONBOARDING_V7_40_20260814: สมาชิกกดจากการ์ดในกลุ่ม หรือพิมพ์คำสั่งเอง
      const memberRegisterText = event.type === "message" && event.message?.type === "text"
        ? String(event.message.text || "").trim()
        : "";
      const memberRegisterRequested =
        postbackAct === "member_register" ||
        /^(ลงทะเบียนผู้เบิก|ลงทะเบียนข้อมูลของฉัน|ลงทะเบียนรับเงิน|ตั้งค่าบัญชีรับเงิน)$/i.test(memberRegisterText);

      if (memberRegisterRequested) {
        const delivery = await deliverMemberRegistrationV740(env, event, key);
        if (!delivery.ok) {
          await reply(env, event.replyToken, textMsg("ยังระบุตัวตน LINE ของคุณไม่ได้ กรุณาลองพิมพ์ “ลงทะเบียนผู้เบิก” อีกครั้ง"));
        } else if (delivery.replyCard) {
          await reply(env, event.replyToken, delivery.replyCard);
        } else if (delivery.privateSent) {
          await reply(env, event.replyToken, textMsg("ส่งลิงก์ลงทะเบียนไปที่แชทส่วนตัวของคุณแล้ว ✅"));
        } else {
          await reply(env, event.replyToken, textMsg("ยังส่งลิงก์ส่วนตัวไม่ได้ กรุณาเพิ่ม LINE OA นี้เป็นเพื่อน แล้วพิมพ์ “ลงทะเบียนผู้เบิก” ในแชทส่วนตัว"));
        }
        continue;
      }

      if (isImage) {
        // Session ต่อผู้ส่ง 1 คนในแต่ละบริษัท รองรับส่งรูปหลายใบพร้อมกันโดยไม่ตอบสแปมทุกภาพ
        const userId = event.source?.userId || key;
        const attachingExisting = event.source?.userId
          ? await env.KV.get(`attach:${event.source.userId}`)
          : null;
        if (attachingExisting) {
          await reply(env, event.replyToken, textMsg("รับรูปหลักฐานแล้วครับ กำลังแนบเข้ารายการ… ⏳"));
          ctx.waitUntil(runHeavyTask(
            () => handleImage(event, env, key, "push"),
            env, event, "แนบหลักฐาน", 30000
          ));
          continue;
        }
        let touched = { isNew: true };
        try {
          touched = await touchMultiSession(env, {
            tenant: key,
            userId,
            targetId: lineTarget(event.source),
            lineMessageId: event.message?.id || "",
          });
        } catch (e) {
          console.warn("multi touch", e.message);
        }
        if (touched.isNew) {
          await reply(env, event.replyToken, textMsg(
            `รับชุดเอกสารแล้วครับ ส่งรูปต่อได้เรื่อย ๆ ทั้งสลิป ใบเสร็จ และหลักฐานการใช้เงิน
ระบบจะจัดกลุ่มให้อัตโนมัติหลังรูปหยุดไหล ⏳`
          ));
        }
        ctx.waitUntil(runHeavyTask(
          () => handleImage(event, env, key, "push"),
          env, event, "อ่านรูปชุด", 40000
        ));
        continue;
      }

      if (isConfirm) {
        // ตอบรับทันที แล้วค่อย push การ์ดพร้อมใบเบิก/ใบแทนกลับมา
        await reply(env, event.replyToken, textMsg("รับรายการแล้วครับ กำลังบันทึกและสร้างเอกสารอัตโนมัติ… ⏳"));
        ctx.waitUntil(runHeavyTask(
          () => handlePostback(event, env, key, "push"),
          env, event, "สร้างเอกสาร", 25000
        ));
        continue;
      }

      ctx.waitUntil(handleEvent(event, env).catch((e) => reportEventError(env, event, e, "ประมวลผลรายการ")));
    }
    return new Response("ok");
  },

  async email(message, env, ctx) {
    return handleIncomingEmail(message, env, ctx);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.allSettled([
      syncConnectedGmailAccounts(env, {
        limit: Number(env.GMAIL_SYNC_BATCH || 5),
      }).catch(e => console.error("gmail scheduled sync", e)),
      runScheduledReimbursementBatches(env)
        .catch(e => console.error("reimbursement scheduled batch", e)),
    ]));
  },
};

/* ═════════════════════════ helper ═════════════════════════ */

function adminOk(env, url) {
  return !!env.ADMIN_KEY && url.searchParams.get("key") === env.ADMIN_KEY;
}

function tenantKey(source = {}) {
  return source.groupId || source.roomId || source.userId || "unknown";
}

function lineTarget(source = {}) {
  return source.groupId || source.roomId || source.userId || "";
}

async function sendEvent(env, event, messages, mode = "reply") {
  if (mode === "push") return push(env, lineTarget(event.source), messages);
  return reply(env, event.replyToken, messages);
}

function friendlyError(error, label = "ประมวลผล") {
  const raw = String(error?.message || error || "unknown error");
  if (/429|quota/i.test(raw)) return `${label}ไม่สำเร็จ: โควตา OCR หมดหรือ API ถูกจำกัด`;
  if (/GEMINI_KEY|CLAUDE_KEY|OCR/i.test(raw)) return `${label}ไม่สำเร็จ: ระบบอ่านบิลมีปัญหา`;
  if (/Drive|upload|Google/i.test(raw)) return `${label}ไม่สำเร็จ: Google Drive มีปัญหา`;
  if (/timeout/i.test(raw)) return `${label}นานเกิน 25 วินาที ระบบหยุดงานนี้เพื่อไม่ให้เงียบค้าง`;
  return `${label}ไม่สำเร็จ: ${raw.slice(0, 160)}`;
}

async function reportEventError(env, event, error, label) {
  console.error(`[${label}]`, error);
  const target = lineTarget(event.source);
  if (!target) return false;
  return push(env, target, textMsg(`งานหยุดกลางทาง ❌\n${friendlyError(error, label)}\nลองส่งใหม่อีกครั้ง หากยังขึ้นซ้ำให้เปิด Cloudflare Live Logs ดูข้อความ error`));
}

async function runHeavyTask(task, env, event, label, timeoutMs = 25000) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      }),
    ]);
  } catch (e) {
    await reportEventError(env, event, e, label);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function tenantTitle(env, source) {
  try {
    if (source.groupId) {
      const r = await fetch(`https://api.line.me/v2/bot/group/${source.groupId}/summary`, {
        headers: { Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}` } });
      if (r.ok) return (await r.json()).groupName || "";
    } else if (source.userId) {
      const r = await fetch(`https://api.line.me/v2/bot/profile/${source.userId}`, {
        headers: { Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}` } });
      if (r.ok) return (await r.json()).displayName || "";
    }
  } catch {}
  return "";
}

async function resolveSheet(env, source) {
  const rawKey = tenantKey(source);
  const key = await operationalTenantKey(env, rawKey);
  const userTok = await getUserToken(env, key);
  if (userTok) {
    let sheetId = await env.KV.get(`tenant:${key}`);
    if (!sheetId) {
      const title = `DEAL Finance · ${(await tenantTitle(env, source)) || key.slice(0, 8)}`;
      sheetId = (await createUserSheet(env, userTok, title)).sheetId;
      await env.KV.put(`tenant:${key}`, sheetId);
    }
    return { sheetId, token: userTok };
  }
  if (env.DEFAULT_SHEET_ID) return { sheetId: env.DEFAULT_SHEET_ID, token: null };
  return null;
}

async function getDisplayName(env, source) {
  try {
    const uid = source.userId; if (!uid) return "";
    const url = source.groupId
      ? `https://api.line.me/v2/bot/group/${source.groupId}/member/${uid}`
      : `https://api.line.me/v2/bot/profile/${uid}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}` } });
    if (!r.ok) return "";
    return (await r.json()).displayName || "";
  } catch { return ""; }
}

async function dashUrl(env, key, path = "") {
  key = await operationalTenantKey(env, key);
  if (!env.DASHBOARD_URL) return null;
  const base = env.DASHBOARD_URL.replace(/\/$/, "");
  const tok = await getDashToken(env, key);
  return `${base}${path}?tenant=${encodeURIComponent(key)}&k=${tok}`;
}

function monthOf(r) {
  if (r.dateISO && r.dateISO.length >= 7) return r.dateISO.slice(0, 7);
  const d = normalizeDate(r.dateText || r.date);
  return d ? d.iso.slice(0, 7) : "";
}

async function computeStats(env, sheet, rec, justAppended = null) {
  let all = [];
  try {
    all = await readExpenses(env, sheet.sheetId, sheet.token);
  } catch (e) {
    console.warn("stats read", e.message);
    return null;
  }
  if (justAppended && !all.some((r) => r.id === justAppended.id)) all = [...all, justAppended];

  const nowMonth = new Date().toISOString().slice(0, 7);
  let monthTotal = 0, categoryTotal = 0, unpaidTotal = 0;
  for (const r of all) {
    if (r.type === "รายรับ") continue;
    const amt = Number(r.amount) || 0;
    if (monthOf(r) === nowMonth) {
      monthTotal += amt;
      if (rec.category && r.category === rec.category) categoryTotal += amt;
    }
    if (!r.paid) unpaidTotal += amt;
  }
  return { monthTotal, categoryTotal: rec.category ? categoryTotal : undefined, unpaidTotal };
}

async function renderSaved(env, key, sheet, rec, justAppended = null) {
  const [stats, setup, dash, documentsPage] = await Promise.all([
    computeStats(env, sheet, rec, justAppended),
    checkSetup(env, key, sheet),
    dashUrl(env, key),
    dashUrl(env, key, "/receipt"),
  ]);
  const setupUrl = setup && dash
    ? `${dash}${dash.includes("?") ? "&" : "?"}setup=1`
    : null;

  return savedCard(rec, rec.imageUrl || null, dash, {
    id: rec.id,
    stats,
    claimUrl: rec.claimPdfUrl || null,
    receiptUrl: rec.receiptPdfUrl || null,
    batchClaimUrl: rec.batchClaimPdfUrl || null,
    documentsUrl: documentsPage,
    // มี setupUrl = ยังตั้งค่าไม่ครบ → แจ้งให้กรอก แต่รายการยังบันทึกตามปกติ
    setupUrl,
    setupWarn: setup ? setup.warn : null,
    docWarn: rec.documentError || null,
  });
}

function connectMsg(env, key) {
  const url = `${env.WORKER_URL}/oauth/connect?tenant=${encodeURIComponent(key)}`;
  return {
    type: "flex", altText: "เชื่อม Google เพื่อเริ่มใช้งาน",
    contents: { type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "text", text: "เชื่อม Google ก่อนใช้งาน 🔗", weight: "bold", size: "md", color: "#1F6E56" },
        { type: "text", text: "ใช้บัญชี Google เดิมได้เลย — ระบบจะค้นหาธุรกิจเดิมและเชื่อม Sheet/Drive ให้กลุ่มนี้อัตโนมัติ", size: "sm", color: "#8c8c8c", wrap: true },
      ] },
      footer: { type: "box", layout: "vertical", contents: [
        { type: "button", style: "primary", color: "#1F6E56", height: "sm",
          action: { type: "uri", label: "เชื่อม Google", uri: url } },
      ] },
    },
  };
}

function unlinkedLineGroupCard(env, rawKey) {
  const connectUrl = `${env.WORKER_URL}/oauth/connect?tenant=${encodeURIComponent(rawKey)}`;
  return {
    type: "flex",
    altText: "กลุ่ม LINE ใหม่นี้ยังไม่ได้ผูกกับบริษัท",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box", layout: "vertical", paddingAll: "20px", spacing: "sm",
        contents: [
          { type:"text", text:"กลุ่ม LINE ใหม่", size:"xs", weight:"bold", color:"#147A36" },
          { type:"text", text:"กลุ่มนี้จะใช้กับบริษัทไหน?", size:"xl", weight:"bold", color:"#111111", wrap:true },
          { type:"text", text:"ถ้าเป็นกลุ่มเพิ่มของบริษัทเดิม ไม่ต้องเชื่อม Google ใหม่ และไม่เพิ่มจำนวนธุรกิจ", size:"sm", color:"#6E6E73", wrap:true, margin:"sm" },
          { type:"box", layout:"vertical", backgroundColor:"#F5F5F7", cornerRadius:"14px", paddingAll:"14px", margin:"md", spacing:"xs", contents:[
            { type:"text", text:"บริษัทเดิม", size:"sm", weight:"bold", color:"#111111" },
            { type:"text", text:"เปิด Dashboard ของบริษัท > จัดการธุรกิจ > กลุ่ม LINE > เชื่อมกลุ่ม LINE แล้วคัดลอกคำสั่งมาวางในกลุ่มนี้", size:"xs", color:"#6E6E73", wrap:true },
          ]},
        ],
      },
      footer: {
        type:"box", layout:"vertical", paddingAll:"14px", spacing:"sm",
        contents:[
          { type:"button", style:"primary", color:"#111111", height:"sm", action:{ type:"message", label:"วิธีเชื่อมกับบริษัทเดิม", text:"วิธีเชื่อมกลุ่ม" } },
          { type:"button", style:"secondary", height:"sm", action:{ type:"uri", label:"ตั้งเป็นธุรกิจใหม่", uri:connectUrl } },
        ],
      },
      styles:{ body:{backgroundColor:"#FFFFFF"}, footer:{backgroundColor:"#FFFFFF"} },
    },
  };
}

async function dashboardMsg(env, key) {
  const url = await dashUrl(env, key);
  return {
    type: "flex",
    altText: "เปิดแดชบอร์ดบัญชี",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "20px",
        spacing: "md",
        contents: [
          {
            type: "box",
            layout: "baseline",
            spacing: "8px",
            contents: [
              { type: "text", text: "📊", size: "lg", flex: 0 },
              { type: "text", text: "สรุปบัญชีของคุณ", size: "xl", weight: "bold", color: "#111111", wrap: true, flex: 1 },
            ],
          },
          {
            type: "text",
            text: "ดูยอด ใช้จ่าย ออกใบแทน จับคู่หลักฐาน ตั้งค่าบริษัท — ครบในที่เดียว",
            size: "md",
            color: "#7A7A7A",
            wrap: true,
            margin: "xs",
          },
          {
            type: "text",
            text: 'ลิงก์นี้เป็นความลับ — ใครมีลิงก์ก็เปิดดูได้ ถ้าหลุดให้พิมพ์ “รีเซ็ตลิงก์”',
            size: "sm",
            color: "#B07A63",
            wrap: true,
            margin: "sm",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingTop: "0px",
        paddingBottom: "18px",
        paddingStart: "20px",
        paddingEnd: "20px",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#111111",
            height: "md",
            action: { type: "uri", label: "เปิดแดชบอร์ด", uri: url },
          },
        ],
      },
      styles: {
        body: { backgroundColor: "#FFFFFF" },
        footer: { backgroundColor: "#FFFFFF", separator: false },
      },
    },
  };
}

async function sha256Base64(base64) {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function duplicateMeta(check) {
  if (!check?.hasDuplicate) return { duplicateStatus: "", duplicateOf: "" };
  return {
    duplicateStatus: check.level === "high"
      ? "ยืนยันบันทึกซ้ำ — ความเสี่ยงสูง"
      : "ยืนยันบันทึกซ้ำ — ควรตรวจสอบ",
    duplicateOf: check.matches.map((m) => m.id).filter(Boolean).join(", "),
  };
}

function memberProfileCard(profileUrl, pendingId, displayName, missing = []) {
  const missingText = missing.length ? `ยังขาด: ${missing.join(" · ")}` : "กรอกข้อมูลบัญชีรับเงินให้ครบ";
  return {
    type: "flex",
    altText: "กรอกข้อมูลผู้เบิกครั้งแรก",
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box", layout: "vertical", paddingAll: "22px", contents: [
          { type: "text", text: "ตั้งค่าผู้เบิกครั้งแรก", size: "xs", color: "#6E6E73", weight: "bold" },
          { type: "text", text: displayName || "ข้อมูลผู้เบิก", size: "xl", color: "#111111", weight: "bold", wrap: true, margin: "sm" },
          { type: "text", text: "กรอกเพียงครั้งเดียวสำหรับบริษัทนี้ หลังจากนั้นตั้งเบิกได้ทันทีโดยไม่ต้องกรอกเลขบัญชีซ้ำ", size: "sm", color: "#6E6E73", wrap: true, margin: "md" },
          { type: "box", layout: "vertical", backgroundColor: "#F5F5F7", cornerRadius: "14px", paddingAll: "13px", margin: "lg", contents: [
            { type: "text", text: missingText, size: "xs", color: "#3A3A3C", wrap: true },
          ] },
        ],
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", paddingAll: "14px", contents: [
          { type: "button", style: "primary", color: "#111111", height: "sm", action: { type: "uri", label: "กรอกข้อมูลส่วนตัว", uri: profileUrl } },
          { type: "button", style: "secondary", height: "sm", action: { type: "postback", label: "บันทึกรายการต่อ", data: `act=confirm&id=${encodeURIComponent(pendingId)}` } },
        ],
      },
      styles: { body: { backgroundColor: "#FFFFFF" }, footer: { backgroundColor: "#FFFFFF" } },
    },
  };
}

/* ═════════════════════════ event handler ═════════════════════════ */

async function handleEvent(event, env) {
  const rawKey = tenantKey(event.source);
  const key = await operationalTenantKey(env, rawKey);
  console.log(`[event] type=${event.type} tenant=${key} rawTenant=${rawKey} user=${event.source?.userId || "-"}`);

  if (event.type === "join" || event.type === "follow") {
    const existingSheetId = await env.KV.get(`tenant:${key}`);
    const existingToken = await env.KV.get(`gtoken:${key}`);
    if (rawKey !== key && existingSheetId && existingToken) {
      return reply(env, event.replyToken, [
        textMsg("กลุ่มนี้เชื่อมกับบริษัทเดิมแล้ว ✅\nใช้ Sheet / Drive / Gmail / การตั้งค่าบริษัทชุดเดียวกัน และไม่ถูกนับเป็นธุรกิจเพิ่ม"),
        await dashboardMsg(env, key),
      ]);
    }
    if (existingSheetId && existingToken) {
      return reply(env, event.replyToken, [
        textMsg("พบธุรกิจที่เคยเชื่อมไว้แล้วครับ ✅\nกลุ่มนี้ใช้ข้อมูลบริษัท Sheet และ Drive เดิมได้เลย ไม่ต้องตั้งค่าใหม่"),
        await dashboardMsg(env, key),
      ]);
    }
    if (event.source?.groupId || event.source?.roomId) {
      return reply(env, event.replyToken, unlinkedLineGroupCard(env, rawKey));
    }
    return reply(env, event.replyToken, [
      textMsg("สวัสดีครับ ผมน้องช่วยบัญชีของ DEAL 📒\nกดเชื่อม Google เพื่อเริ่มใช้งาน"),
      connectMsg(env, key),
    ]);
  }

  if (event.type === "message" && event.message?.type === "image") return handleImage(event, env, key);
  if (event.type === "postback") return handlePostback(event, env, key);
  if (event.type === "message" && event.message?.type === "text") return handleText(event, env, key);
}

/* ───────────────────────── รูป ───────────────────────── */

async function handleImage(event, env, key, mode = "reply") {
  const respond = (messages) => sendEvent(env, event, messages, mode);
  const uid = event.source.userId;

  // ทำงานที่ไม่ขึ้นต่อกันพร้อมกัน เพื่อลดเวลาจากเดิมที่รอทีละขั้น
  const [sheet, content, sender, attachRaw, documentMode] = await Promise.all([
    resolveSheet(env, event.source),
    getMessageContent(env, event.message.id),
    getDisplayName(env, event.source),
    uid ? env.KV.get(`attach:${uid}`) : Promise.resolve(null),
    uid ? env.KV.get(`docmode:${key}:${uid}`) : Promise.resolve(null),
  ]);

  if (!sheet) return respond(connectMsg(env, key));
  console.log(`[image] tenant=${key} sheetId=${sheet.sheetId} oauth=${!!sheet.token}`);
  const settingsPromise = readSettings(env, sheet.sheetId, sheet.token).catch((e) => {
    console.warn(`[image] settings unavailable tenant=${key}:`, e?.message || e);
    return {};
  });

  const { base64, mediaType } = content;
  const drivePromise = uploadTenantImage(
    env, key, base64, mediaType, `bill-${Date.now()}.jpg`, sheet.token,
    { category: "originals" }
  );

  if (attachRaw) {
    const driveLink = await drivePromise;
    if (!driveLink) throw new Error("Drive upload failed");
    await env.KV.delete(`attach:${uid}`);
    let target;
    try { target = JSON.parse(attachRaw); }
    catch { target = { id: attachRaw, type: "attOther" }; }
    const out = await addAttachment(
      env, sheet.sheetId, target.id, target.type || "attOther", driveLink, sheet.token
    );
    if (!out.ok) return respond(textMsg(MSG_STALE));
    return respond(await renderSaved(env, key, sheet, out.record));
  }

  // ช่วง Beta รับเอกสารไม่จำกัด; หลัง Beta บังคับโควตาตามแพ็กเกจก่อนเรียก AI
  const subscription = await getSubscriptionSnapshot(env, key, sheet.sheetId, sheet.token);
  if (subscription.blocked) return respond(await subscriptionQuotaMessage(env, key, subscription));

  // อัป Drive และสร้างลายนิ้วมือทำพร้อมกัน ส่วน OCR แยกจับ error
  // เพื่อให้รูปไม่หายจากชุดแม้ AI อ่านไม่สำเร็จ — ผู้ใช้ยังจัดรูปเองได้
  const [driveLink, imageHash] = await Promise.all([
    drivePromise,
    sha256Base64(base64),
  ]);
  if (!driveLink) throw new Error("Drive upload failed");

  let record;
  let ocrFailed = false;
  let ocrError = "";
  const cachedAi = unwrapAiDocumentCache(await readAiDocumentCache(env, key, "line-receipt", imageHash));
  if (cachedAi) {
    record = cachedAi;
  } else {
    const aiQuota = await getAiQuotaState(env, key);
    if (aiQuota.blocked) {
      ocrFailed = true;
      ocrError = `AI_QUOTA_REACHED ${aiQuota.used}/${aiQuota.limit}`;
      record = {
        amount: 0,
        vendor: "",
        transferor: "",
        fromAccountNumber: "",
        toAccountNumber: "",
        fromBank: "",
        toBank: "",
        date: "",
        category: "อื่น ๆ",
        note: `ใช้จำนวนอ่านเอกสารอัตโนมัติครบ ${aiQuota.limit} ใบแล้ว — รูปยังถูกเก็บไว้และกรอกข้อมูลเองได้`,
        docType: "อื่น ๆ",
        role: "OTHER",
        taxId: "",
        invoiceNo: "",
        referenceNo: "",
        matchHint: "โควตาอ่านเอกสารอัตโนมัติครบแล้ว",
        type: "รายจ่าย",
        vat: false,
        vatRate: 0,
        whtRate: 0,
        flag: "โควตาอ่านเอกสารอัตโนมัติครบแล้ว กรุณากรอกข้อมูลเองหรือเพิ่มจำนวนอ่านเอกสาร",
        confidence: { amount: 0, vendor: 0, transferor: 0, date: 0, category: 0, note: 0 },
      };
    } else {
      try {
        record = await ocrReceipt(env, base64, mediaType);
        await consumeAiDocument(env, key, 1);
        await writeAiDocumentCache(env, key, "line-receipt", imageHash, record).catch(() => {});
      } catch (e) {
        ocrFailed = true;
        ocrError = String(e?.message || e).slice(0, 500);
        console.error(`[multi-ocr-failed] tenant=${key} messageId=${event.message.id || ""}`, e);
        record = {
          amount: 0,
          vendor: "",
          transferor: "",
          fromAccountNumber: "",
          toAccountNumber: "",
          fromBank: "",
          toBank: "",
          date: "",
          category: "อื่น ๆ",
          note: "AI อ่านรูปไม่สำเร็จ — กรุณาจัดรูปและกรอกข้อมูลเอง",
          docType: "อื่น ๆ",
          role: "OTHER",
          taxId: "",
          invoiceNo: "",
          referenceNo: "",
          matchHint: "AI อ่านไม่สำเร็จ",
          type: "รายจ่าย",
          vat: false,
          vatRate: 0,
          whtRate: 0,
          flag: "AI อ่านรูปไม่สำเร็จ กรุณาตรวจและจัดรูปด้วยตนเอง",
          confidence: { amount: 0, vendor: 0, transferor: 0, date: 0, category: 0, note: 0 },
        };
      }
    }
  }

  // Source of truth หลักสำหรับสลิป: เทียบผู้โอน/ผู้รับกับ Master บัญชีบริษัท
  // ถ้าปลายทางตรงบัญชีบริษัท => รายรับ, ต้นทางตรงบัญชีบริษัท => รายจ่าย
  // AI ใช้อ่านข้อมูล แต่ไม่ได้เป็นคนตัดสินทิศทางเพียงลำพัง
  try {
    const settings = await settingsPromise;
    const direction = classifyTransferByCompanyAccounts(record, settings);
    record.accountDirection = direction.direction || "unknown";
    record.accountDirectionType = direction.type || "";
    record.accountDirectionReason = direction.reason || "";
    record.accountDirectionConfidence = Number(direction.confidence || 0);
    record.matchedPaymentChannelId = direction.matchedPaymentChannelId || "";
    record.matchedPaymentChannelLabel = direction.matchedPaymentChannelLabel || "";
    record.sourceChannelId = direction.sourceChannelId || "";
    record.destinationChannelId = direction.destinationChannelId || "";
    if (direction.type === "รายรับ") {
      record.type = "รายรับ";
      if (!INCOME_CATEGORIES.includes(record.category)) record.category = "รายได้อื่น";
    } else if (direction.type === "รายจ่าย") {
      record.type = "รายจ่าย";
      if (!EXPENSE_CATEGORIES.includes(record.category)) record.category = "อื่น ๆ";
    } else if (direction.direction === "internal_transfer") {
      const prefix = "พบต้นทางและปลายทางเป็นบัญชีบริษัท — อาจเป็นโอนระหว่างบัญชี กรุณาตรวจประเภท";
      record.flag = record.flag ? `${prefix} · ${record.flag}`.slice(0, 180) : prefix;
    }
    console.log(`[direction] tenant=${key} dir=${direction.direction} type=${direction.type || "manual"} confidence=${direction.confidence || 0} channel=${direction.matchedPaymentChannelId || "-"}`);
  } catch (e) {
    console.warn(`[direction] classify failed tenant=${key}:`, e?.message || e);
  }

  // ผู้ใช้สามารถพิมพ์ “รายรับ” หรือ “รายจ่าย” ก่อนส่งรูป เพื่อบังคับทิศทางรายการ
  // มีประโยชน์กับสลิปธนาคารที่ภาพอย่างเดียวบอกไม่ได้ว่าบัญชีไหนเป็นของบริษัทนี้
  if (documentMode === "รายรับ") {
    if (record.accountDirection && record.accountDirection !== "incoming") {
      record.matchedPaymentChannelId = "";
      record.matchedPaymentChannelLabel = "";
    }
    record.type = "รายรับ";
    record.accountDirectionType = "รายรับ";
    record.accountDirectionReason = "ผู้ใช้เปิดโหมดรายรับใน LINE";
    if (!INCOME_CATEGORIES.includes(record.category)) record.category = "รายได้อื่น";
  } else if (documentMode === "รายจ่าย") {
    record.type = "รายจ่าย";
    record.accountDirectionType = "รายจ่าย";
    record.accountDirectionReason = "ผู้ใช้เปิดโหมดรายจ่ายใน LINE";
    if (!EXPENSE_CATEGORIES.includes(record.category)) record.category = "อื่น ๆ";
  }

  const item = {
    ...record,
    ocrFailed,
    ocrError,
    id: `img_${event.message.id || crypto.randomUUID().slice(0, 8)}`,
    lineMessageId: event.message.id || "",
    driveUrl: driveLink,
    imgUrl: (() => {
      const m = String(driveLink).match(/\/d\/([a-zA-Z0-9_-]{20,})/);
      return m ? `https://lh3.googleusercontent.com/d/${m[1]}` : driveLink;
    })(),
    imageHash,
    mediaType,
  };

  const out = await addMultiImage(env, {
    tenant: key,
    userId: uid || key,
    targetId: lineTarget(event.source),
    displayName: sender,
    sheetId: sheet.sheetId,
  }, item);
  console.log(`[multi-image] tenant=${key} groups=${out.counts?.groups || 0} images=${out.counts?.images || 0} unassigned=${out.counts?.unassigned || 0}`);
  // Durable Object จะ debounce แล้ว push การ์ดสรุปเพียงครั้งเดียวหลังรูปหยุดไหล
  return out;

}

/* ───────────────────────── postback ───────────────────────── */

async function handlePostback(event, env, key, mode = "reply") {
  const respond = (messages) => sendEvent(env, event, messages, mode);
  const p = new URLSearchParams(event.postback.data);
  const act = p.get("act");
  const id = p.get("id");
  const field = p.get("f");
  const uid = event.source.userId;

  if (PENDING_ACTS.has(act)) {
    const raw = await env.KV.get(`pending:${id}`);
    if (!raw) return respond(textMsg(MSG_STALE));
    const pending = JSON.parse(raw);

    if (act === "cancel") {
      await env.KV.delete(`pending:${id}`);
      return respond(textMsg("ยกเลิกแล้วครับ ไม่ได้บันทึกลงชีท\nรูปยังอยู่ใน Drive — จับเข้ารายการอื่นได้จากแดชบอร์ด"));
    }

    const token = await getUserToken(env, key);
    const sheet = { sheetId: pending.sheetId, token };

    // ผู้เบิกกรอกข้อมูลบัญชีครั้งเดียวต่อบริษัท จากนั้นระบบจำให้ทุกครั้ง
    let memberProfile = null;
    const isIncome = pending.record?.type === "รายรับ" || pending.record?.type === "income";
    if (!isIncome && uid) {
      const member = await getMemberProfile(
        env, key, pending.sheetId, token, uid, pending.sender || ""
      );
      memberProfile = member.profile;
      if (!memberProfileComplete(memberProfile)) {
        const profileUrl = await createMemberOnboardingUrl(env, {
          tenant: key,
          lineUserId: uid,
          displayName: pending.sender || "",
          pendingId: id,
        });
        const card = memberProfileCard(
          profileUrl, id, pending.sender || "ผู้เบิก", missingMemberFields(memberProfile)
        );

        // ส่งข้อมูลบัญชีเป็นการ์ดส่วนตัวเท่านั้น ไม่ปล่อยลิงก์ข้อมูลส่วนตัวลงในกลุ่ม
        if (event.source.groupId || event.source.roomId) {
          if (await push(env, uid, card)) {
            return respond(textMsg(`ส่งแบบฟอร์มส่วนตัวให้ ${pending.sender || "ผู้เบิก"} แล้วครับ กรอกครั้งเดียวแล้วกลับมากดบันทึกรายการต่อ`));
          }
          return respond(textMsg(`ยังส่งแบบฟอร์มส่วนตัวให้ ${pending.sender || "ผู้เบิก"} ไม่ได้ครับ
กรุณาเพิ่มบอทเป็นเพื่อน แล้วกลับมากด “บันทึก” อีกครั้ง`));
        }
        return respond(card);
      }
    }

    // รายรับไม่เข้ารอบเบิก — บันทึกเข้า master รายรับ + รับชำระโดยตรง
    if (isIncome) {
      try{await assertPeriodOpen(env,pending.sheetId,pending.record?.date||new Date(),token);}catch(e){return respond(textMsg(e.message||"งวดนี้ถูกปิดบัญชีแล้ว"));}
      const out = await createIncomeFromOcr(env, pending.sheetId, {
        ...pending.record,
        imageUrl: pending.driveLink || pending.record?.imageUrl || "",
      }, { driveLink: pending.driveLink || "" }, token);
      if (!out.ok) return respond(textMsg(out.message || "บันทึกรายรับไม่สำเร็จ กรุณาลองใหม่"));
      await postIncomeInvoiceJournal(env,pending.sheetId,out.record||{},token,pending.sender||"LINE").catch(e=>console.warn("line income journal",e.message));
      if(out.payment)await postIncomePaymentJournal(env,pending.sheetId,out.payment,token,pending.sender||"LINE").catch(e=>console.warn("line income payment journal",e.message));
      if(out.record?.customer&&!/ทั่วไป|ไม่ระบุ/.test(out.record.customer))await upsertContact(env,pending.sheetId,{type:"ลูกค้า",name:out.record.customer,taxId:out.record.customerTaxId,branch:out.record.customerBranch,source:"Auto LINE Income"},token,pending.sender||"LINE").catch(()=>{});
      await writeAudit(env,pending.sheetId,token,{actor:pending.sender||"LINE",action:"CREATE_INCOME",entityType:"income",entityId:out.record?.id||"",summary:`บันทึกรายรับจาก LINE ${out.record?.customer||""} ${out.record?.grossAmount||0}`,after:out.record,source:"LINE"});
      await env.KV.delete(`pending:${id}`);
      const r = out.record || {};
      return respond(textMsg(`บันทึกรายรับแล้ว ✅
${r.customer || pending.record?.transferor || "ลูกค้าทั่วไป"}
ยอด ฿${Number(r.grossAmount || pending.record?.amount || 0).toLocaleString("th-TH", { minimumFractionDigits:2, maximumFractionDigits:2 })}
สถานะ: ${r.status || "รับครบแล้ว"}
ดูรายละเอียดได้ที่เมนู “รายรับ” ใน Dashboard`));
    }

    // ตรวจซ้ำอีกรอบตอนกดบันทึก ป้องกันมีคนบันทึกรายการเดียวกันแทรกระหว่างรอตรวจ
    const duplicateCheck = await findDuplicateExpenses(
      env,
      pending.sheetId,
      { ...pending.record, imageHash: pending.imageHash || pending.record.imageHash },
      token
    );
    pending.duplicateCheck = duplicateCheck;

    if (duplicateCheck.hasDuplicate && act !== "confirm_force") {
      await env.KV.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: 3600 });
      return respond(confirmCard(id, pending.record, {
        driveLink: pending.driveLink,
        duplicateCheck,
      }));
    }

    const dupMeta = duplicateCheck.hasDuplicate ? duplicateMeta(duplicateCheck) : {
      duplicateStatus: "",
      duplicateOf: "",
    };

    // ทุกรายการที่เบิก ตั้งให้ออกใบแทนไว้ก่อน — บัญชีค่อยเอาออกในแดชบอร์ด
    const resolvedPayerName = memberProfile?.name || pending.sender || "";
    const toSave = {
      ...pending.record,
      needSlip: true,
      imageHash: pending.imageHash || pending.record.imageHash || "",
      payerName: resolvedPayerName,
      payerId: uid || "",
      bankName: memberProfile?.bank || "",
      bankAccountNo: memberProfile?.accountNo || "",
      bankAccountName: memberProfile?.accountName || resolvedPayerName,
      ...dupMeta,
    };

    try{await assertPeriodOpen(env,pending.sheetId,pending.record?.date||new Date(),token);}catch(e){return respond(textMsg(e.message||"งวดนี้ถูกปิดบัญชีแล้ว"));}

    const { id: rowId, row } = await appendExpense(
      env, pending.sheetId, toSave,
      { sender: pending.sender, driveLink: pending.driveLink, payerName: resolvedPayerName, payerId: uid || "" },
      token
    );
    // อัปเดต usage หลังบันทึกรายการสำเร็จ (1 รายการที่บันทึก = 1 เอกสารในโควตา)
    await syncSubscriptionUsageAfterSavedExpense(env, key, pending.sheetId, token)
      .catch((e) => console.warn("subscription usage line", e?.message || e));

    // กันกดซ้ำทันทีหลังบันทึกแถวสำเร็จ แม้ขั้นสร้าง PDF จะมีปัญหา
    await env.KV.delete(`pending:${id}`);

    const d = normalizeDate(pending.record.date);
    let rec = {
      ...toSave,
      id: rowId, _row: row,
      imageUrl: pending.driveLink,
      payerName: resolvedPayerName, sender: pending.sender,
      bankName: memberProfile?.bank || "",
      bankAccountNo: memberProfile?.accountNo || "",
      bankAccountName: memberProfile?.accountName || resolvedPayerName,
      dateText: d.text, dateISO: d.iso,
      status: "รอตรวจเอกสาร", paid: false,
      type: pending.record.type || "รายจ่าย",
      claimPdfUrl: "",
      receiptPdfUrl: "",
      imageHash: toSave.imageHash || "",
      duplicateStatus: toSave.duplicateStatus || "",
      duplicateOf: toSave.duplicateOf || "",
      payerId: uid || "",
      batchType: "ปกติ",
      batchStatus: "รอตรวจเอกสาร",
      batchNo: "",
      batchDocId: "",
      batchClaimPdfUrl: "",
    };
    await postExpenseJournal(env,pending.sheetId,rec,token,pending.sender||"LINE").catch(e=>console.warn("line expense journal",e.message));
    await writeAudit(env,pending.sheetId,token,{actor:pending.sender||"LINE",action:"CREATE_EXPENSE",entityType:"expense",entityId:rowId,summary:`บันทึกรายจ่ายจาก LINE ${rec.vendor||""} ${rec.amount||0}`,after:rec,source:"LINE"});

    // กดบันทึกครั้งเดียว → สร้างใบเบิก + ใบแทนเป็น PDF → อัป Drive → เขียนลิงก์ลงชีท
    try {
      const setup = await checkSetup(env, key, { sheetId: pending.sheetId, token });
      const settings = await readSettings(env, pending.sheetId, token);
      if (setup || !documentSettingsReady(settings)) {
        rec.documentError = setup?.warn || "บันทึกรายการแล้ว — ตั้งค่าข้อมูลบริษัท โลโก้ ลายเซ็น และช่องทางการโอนเงินให้ครบ จากนั้นระบบจะสร้างใบเบิกและใบแทนให้อัตโนมัติ";
      } else {
        const docs = await createExpenseDocuments(env, rec, settings, token, {
          tenant: key, companyName: settings.company_name || "พื้นที่บริษัท", sheetId: pending.sheetId,
        });
        const patch = {
          slipNo: docs.receiptNo,
          claimPdfUrl: docs.claimUrl,
          receiptPdfUrl: docs.receiptUrl,
        };
        await updateExpenseById(env, pending.sheetId, rowId, patch, token);
        rec = { ...rec, ...patch };
      }
    } catch (e) {
      console.error("auto documents", e);
      rec.documentError = "บันทึกรายการแล้ว แต่สร้างใบเบิก/ใบแทน PDF ไม่สำเร็จ กรุณาตรวจข้อมูลบริษัทหรือ Google Drive";
    }

    return respond(await renderSaved(env, key, sheet, rec, rec));
  }

  if (act === "multi_confirm") {
    const out = await confirmMultiSession(env, key, uid || key);
    if (out.ok) return out;

    if (out.code === "profile_required" && out.profileUrl) {
      return respond(textMsg(`${out.error || "กรอกข้อมูลผู้เบิกให้ครบก่อน"}

เปิดกรอกข้อมูล:
${out.profileUrl}`));
    }

    const reviewText = out.reviewUrl ? `

เปิดตรวจและแก้ไข:
${out.reviewUrl}` : "";
    return respond(textMsg(`ยังยืนยันรายการไม่ได้ครับ
${out.error || "กรุณาตรวจข้อมูลอีกครั้ง"}${reviewText}`));
  }

  if (act === "multi_set_type") {
    const groupId = p.get("g") || "";
    const targetType = p.get("t") || "";
    try {
      const out = await setMultiGroupType(env, key, uid || key, groupId, targetType);
      if (!out.ok) return respond(textMsg(out.error || "เปลี่ยนประเภทรายการไม่สำเร็จ"));
      return respond(textMsg(`เปลี่ยนเป็น${out.type}แล้วครับ ✅
การ์ดล่าสุดถูกอัปเดตให้แล้ว`));
    } catch (e) {
      return respond(textMsg("เปลี่ยนประเภทรายการไม่สำเร็จ: " + String(e.message || e).slice(0, 120)));
    }
  }

  if (act === "multi_cancel") {
    try {
      await cancelMultiSession(env, key, uid || key);
      return respond(textMsg("ยกเลิกชุดเอกสารแล้วครับ"));
    } catch (e) {
      return respond(textMsg("ยกเลิกชุดไม่สำเร็จ: " + String(e.message || e).slice(0, 120)));
    }
  }

  const sheet = await resolveSheet(env, event.source);
  if (!sheet) return respond(connectMsg(env, key));

  if (act === "batch_resubmit") {
    const rec = await getExpenseById(env, sheet.sheetId, id, sheet.token);
    if (!rec) return respond(textMsg(MSG_STALE));
    if (!rec.batchDocId) return respond(textMsg("รายการนี้ยังไม่ได้อยู่ในใบเบิกที่ถูกตีกลับ"));
    try {
      const out = await updateReimbursementBatchWorkflow(
        env, sheet.sheetId, rec.batchDocId, "resubmit", {}, sheet.token, { tenant: key }
      );
      if (!out.ok) return respond(textMsg(out.message || "ส่งกลับตรวจไม่สำเร็จ"));
      const updated = await getExpenseById(env, sheet.sheetId, id, sheet.token);
      return respond([
        textMsg(`ส่งใบเบิก ${rec.batchDocId} กลับให้ฝ่ายบัญชีตรวจแล้ว ✅`),
        updated ? await renderSaved(env, key, sheet, updated) : textMsg("ฝ่ายบัญชีได้รับรายการแล้ว"),
      ]);
    } catch (e) {
      return respond(textMsg(`ส่งกลับตรวจไม่สำเร็จ: ${String(e.message || e).slice(0, 160)}`));
    }
  }

  if (act === "urgent") {
    const rec = await getExpenseById(env, sheet.sheetId, id, sheet.token);
    if (!rec) return respond(textMsg(MSG_STALE));
    if (rec.batchDocId || ["รวมรอบแล้ว", "รอตรวจเอกสาร", "ต้องแก้ไข", "รอโอนเงิน", "รอหลักฐานการโอน", "จ่ายแล้ว"].includes(String(rec.batchStatus || ""))) {
      return respond(await renderSaved(env, key, sheet, rec));
    }
    await respond(textMsg("กำลังสร้างใบเบิกด่วนจากรายการนี้… ⏳"));
    try {
      const out = await requestUrgentBatch(env, key, sheet.sheetId, sheet.token, [id]);
      if (!out.ok || !out.batches?.length) {
        return push(env, lineTarget(event.source), textMsg("สร้างใบเบิกด่วนไม่สำเร็จ กรุณาเปิด Dashboard เพื่อตรวจรายการ"));
      }
      const batch = out.batches[0];
      await notifyApproversForBatchOutput(env,key,out,{kind:"urgent-line"})
        .catch(e=>console.warn("approver urgent LINE notify",e?.message||e));
      const updated = await getExpenseById(env, sheet.sheetId, id, sheet.token);
      const messages = [
        textMsg(`สร้างใบเบิกด่วนแล้ว ✅
เลขที่ ${batch.docId}
รวม ฿${Number(batch.total || 0).toLocaleString("th-TH", { minimumFractionDigits: 2 })}`),
      ];
      if (updated) messages.push(await renderSaved(env, key, sheet, updated));
      return push(env, lineTarget(event.source), messages);
    } catch (e) {
      console.error("urgent batch", e);
      return push(env, lineTarget(event.source), textMsg(`สร้างใบเบิกด่วนไม่สำเร็จ ❌
${String(e.message || e).slice(0, 180)}`));
    }
  }

  if (act === "paid") {
    const out = await togglePaid(env, sheet.sheetId, id, sheet.token);
    if (!out.ok) return respond(textMsg(MSG_STALE));
    return respond(await renderSaved(env, key, sheet, out.record));
  }

  if (act === "more") {
    const rec = await getExpenseById(env, sheet.sheetId, id, sheet.token);
    if (!rec) return respond(textMsg(MSG_STALE));
    return respond(moreCard(rec, { id, dashboardUrl: await dashUrl(env, key) }));
  }

  if (act === "back") {
    const rec = await getExpenseById(env, sheet.sheetId, id, sheet.token);
    if (!rec) return respond(textMsg(MSG_STALE));
    return respond(await renderSaved(env, key, sheet, rec));
  }

  if (act === "delete") {
    const out = await softDeleteById(env, sheet.sheetId, id, sheet.token);
    if (!out.ok) return respond(textMsg(MSG_STALE));
    return respond(textMsg("ลบรายการแล้วครับ 🗑️"));
  }

  if (act === "attach") {
    if (!uid) return respond(textMsg("ส่งรูปมาในแชทส่วนตัวนะครับ"));
    const type = p.get("t") || "attOther";
    await env.KV.put(`attach:${uid}`, JSON.stringify({ id, type }), { expirationTtl: 600 });
    return respond(textMsg("ส่งรูปหลักฐานมาได้เลยครับ 📸 (ภายใน 10 นาที)"));
  }

  if (act === "edit" || act === "fix") {
    if (!uid) return respond(textMsg("ทำรายการนี้ในแชทส่วนตัวนะครับ"));
    const isPending = !!(await env.KV.get(`pending:${id}`));
    const f = act === "fix" && field ? field : "amount";
    await env.KV.put(`edit:${uid}`,
      JSON.stringify({ id, field: f, scope: isPending ? "pending" : "sheet" }),
      { expirationTtl: 600 });
    return respond(textMsg(promptFor(f)));
  }
}

function promptFor(field) {
  switch (field) {
    case "amount":   return "พิมพ์ยอดเงินที่ถูกต้องมาได้เลย (เฉพาะตัวเลข)";
    case "date":     return "พิมพ์วันที่ที่ถูกต้อง เช่น 24/07/2569 หรือ 2026-07-24";
    case "vendor":     return "พิมพ์ชื่อร้าน/ผู้รับเงินที่ถูกต้อง";
    case "transferor": return "พิมพ์ชื่อผู้โอน/ชื่อบัญชีต้นทางที่ถูกต้อง";
    case "category": return "พิมพ์หมวดที่ถูกต้อง";
    case "note":     return "พิมพ์รายละเอียดที่ถูกต้อง";
    default:         return "พิมพ์ค่าที่ถูกต้องมาได้เลย";
  }
}

/* ───────────────────────── ข้อความ ───────────────────────── */

async function handleText(event, env, key) {
  const text = (event.message.text || "").trim();
  const uid = event.source.userId;

  const lineGroupInviteMatch = text.match(/^เชื่อมกลุ่ม\s+([A-Z0-9]{6,10})$/i);
  if (lineGroupInviteMatch) {
    try {
      const out = await linkLineWorkspaceFromInvite(env, event, lineGroupInviteMatch[1]);
      if (!out.ok) return reply(env, event.replyToken, textMsg(out.message || "เชื่อมกลุ่มไม่สำเร็จ"));
      return reply(env, event.replyToken, textMsg(
        `เชื่อมกลุ่มสำเร็จ ✅\nกลุ่ม “${out.groupName}” ใช้ข้อมูลของ ${out.companyName} แล้ว\n\n✓ ใช้ Sheet / Drive / Gmail / การตั้งค่าบริษัทชุดเดิม\n✓ ไม่ถูกนับเป็นธุรกิจเพิ่ม\n✓ ส่งเอกสารจากกลุ่มนี้เข้าบริษัทเดิมได้ทันที\n\nDashboard:\n${out.dashboardUrl || ""}`
      ));
    } catch (e) {
      console.error("link LINE group invite", e);
      return reply(env, event.replyToken, textMsg("เชื่อมกลุ่มไม่สำเร็จ กรุณาสร้างรหัสใหม่จาก Dashboard แล้วลองอีกครั้ง"));
    }
  }

  if (/^(วิธีเชื่อมกลุ่ม|เพิ่มกลุ่ม|เชื่อมกลุ่ม)$/i.test(text)) {
    return reply(env, event.replyToken, textMsg(
      "ถ้าเป็นกลุ่มเพิ่มของบริษัทเดิม ไม่ต้องเชื่อม Google ใหม่ครับ ✅\n\n1) เปิด Dashboard ของบริษัทเดิม\n2) ไปที่ จัดการธุรกิจ > กลุ่ม LINE\n3) กด + เชื่อมกลุ่ม LINE\n4) กดคัดลอกคำสั่ง แล้วนำมาวางในกลุ่มนี้\n\nรหัสมีอายุ 30 นาที และกลุ่มที่เพิ่มจะไม่ถูกนับเป็นธุรกิจใหม่"
    ));
  }

  const businessInviteMatch = text.match(/^เชื่อมธุรกิจ\s+([A-Z0-9]{6,10})$/i);
  if (businessInviteMatch) {
    try {
      const out = await linkBusinessFromInvite(env, event, key, businessInviteMatch[1]);
      if (!out.ok) return reply(env, event.replyToken, textMsg(out.message || "เพิ่มธุรกิจไม่สำเร็จ"));
      return reply(env, event.replyToken, textMsg(
        out.mergedExistingBusiness
          ? `รวมธุรกิจเดิมเข้าบัญชีสำเร็จ ✅\nข้อมูล Sheet / Drive / การตั้งค่าเดิมยังอยู่ครบ ไม่ได้ถูกทับ\nธุรกิจในบัญชีนี้ ${out.businessCount}/${out.businessLimit}\n\nเปิด Dashboard แล้วรีเฟรชหน้า “สิทธิ์เข้า Dashboard” จะเห็นกลุ่ม LINE นี้เพิ่มขึ้น\n${out.dashboardUrl || ""}`
          : `เพิ่มธุรกิจสำเร็จ ✅\nธุรกิจในบัญชีนี้ ${out.businessCount}/${out.businessLimit}\n\nขั้นต่อไป: เปิด Dashboard แล้วตั้งค่าข้อมูลบริษัท Gmail และช่องทางการเงินของธุรกิจนี้\n${out.dashboardUrl || ""}`
      ));
    } catch (e) {
      console.error("link business invite", e);
      return reply(env, event.replyToken, textMsg("เพิ่มธุรกิจไม่สำเร็จ กรุณาสร้างรหัสใหม่จาก Dashboard แล้วลองอีกครั้ง"));
    }
  }

  if (/^(รายรับ|รับเงิน|เงินเข้า)$/i.test(text)) {
    if (uid) await env.KV.put(`docmode:${key}:${uid}`, "รายรับ", { expirationTtl: 1800 });
    const base = await dashUrl(env, key);
    return reply(env, event.replyToken, textMsg(
      `โหมดรายรับเปิดแล้ว ✅
ส่งสลิปเงินเข้า ใบแจ้งหนี้ หรือเอกสารขายต่อได้เลย
ระบบจะจัดรายการชุดนี้เป็น “รายรับ” และไม่ถามข้อมูลบัญชีผู้เบิก` +
      (base ? `

เปิดหน้ารายรับ:
${base}&page=income` : "") +
      `

ถ้าจะกลับให้ AI แยกเอง พิมพ์ “อัตโนมัติ”`
    ));
  }

  if (/^(รายจ่าย|จ่ายเงิน|เงินออก)$/i.test(text)) {
    if (uid) await env.KV.put(`docmode:${key}:${uid}`, "รายจ่าย", { expirationTtl: 1800 });
    return reply(env, event.replyToken, textMsg(`โหมดรายจ่ายเปิดแล้ว ✅
ส่งบิล ใบเสร็จ หรือสลิปจ่ายต่อได้เลย
ถ้าจะกลับให้ AI แยกเอง พิมพ์ “อัตโนมัติ”`));
  }

  if (/^(อัตโนมัติ|auto|แยกอัตโนมัติ)$/i.test(text)) {
    if (uid) await env.KV.delete(`docmode:${key}:${uid}`);
    return reply(env, event.replyToken, textMsg(`กลับเป็นโหมดอัตโนมัติแล้ว ✅
ระบบจะพยายามแยกรายรับ/รายจ่ายจากเอกสาร และยังแก้ได้ในหน้าตรวจเอกสาร`));
  }

  const editRaw = uid ? await env.KV.get(`edit:${uid}`) : null;
  if (editRaw) {
    let state;
    try { state = JSON.parse(editRaw); }
    catch { state = { id: editRaw, field: "amount", scope: "pending" }; }
    const { id, field, scope } = state;

    let value = text;
    if (field === "amount") {
      value = Number(text.replace(/[^0-9.]/g, ""));
      if (!(value > 0)) {
        return reply(env, event.replyToken, textMsg("พิมพ์เป็นตัวเลขนะครับ เช่น 128 หรือ 128.50"));
      }
    }

    await env.KV.delete(`edit:${uid}`);

    if (scope === "pending") {
      const raw = await env.KV.get(`pending:${id}`);
      if (!raw) return reply(env, event.replyToken, textMsg(MSG_STALE));
      const pending = JSON.parse(raw);
      pending.record[field] = value;
      const token = await getUserToken(env, key);
      pending.duplicateCheck = await findDuplicateExpenses(
        env,
        pending.sheetId,
        { ...pending.record, imageHash: pending.imageHash || pending.record.imageHash },
        token
      );
      await env.KV.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: 3600 });
      return reply(env, event.replyToken,
        confirmCard(id, pending.record, {
          driveLink: pending.driveLink,
          duplicateCheck: pending.duplicateCheck,
        }));
    }

    const sheet = await resolveSheet(env, event.source);
    if (!sheet) return reply(env, event.replyToken, connectMsg(env, key));
    const upd = await updateExpenseById(env, sheet.sheetId, id, { [field]: value }, sheet.token);
    if (!upd.ok) return reply(env, event.replyToken, textMsg(MSG_STALE));
    const rec = await getExpenseById(env, sheet.sheetId, id, sheet.token);
    if (!rec) return reply(env, event.replyToken, textMsg(MSG_STALE));
    return reply(env, event.replyToken, await renderSaved(env, key, sheet, rec));
  }

  if (/^id$/i.test(text)) {
    return reply(env, event.replyToken, textMsg(`tenant key ของที่นี่คือ:\n${key}`));
  }

  if (/^(จัดบิล|จัดเอกสาร|จบชุด|ตรวจชุด)$/i.test(text)) {
    try {
      await forceMultiSummary(env, key, uid || key);
      return reply(env, event.replyToken, textMsg("ส่งการ์ดตรวจชุดเอกสารล่าสุดให้แล้วครับ"));
    } catch (e) {
      return reply(env, event.replyToken, textMsg("ยังไม่มีชุดเอกสารที่กำลังจัดอยู่ครับ"));
    }
  }

  if (/^(ยกเลิกชุด|ทิ้งชุด)$/i.test(text)) {
    try {
      await cancelMultiSession(env, key, uid || key);
      return reply(env, event.replyToken, textMsg("ยกเลิกชุดเอกสารแล้วครับ รูปยังอยู่ใน Google Drive"));
    } catch (e) {
      return reply(env, event.replyToken, textMsg("ยังไม่มีชุดเอกสารให้ยกเลิกครับ"));
    }
  }

  if (/^migrate$/i.test(text)) {
    const sheet = await resolveSheet(env, event.source);
    if (!sheet) return reply(env, event.replyToken, connectMsg(env, key));
    try {
      const h = await ensureHeaders(env, sheet.sheetId, sheet.token);
      const i = await backfillIds(env, sheet.sheetId, sheet.token);
      const s = await ensureSettingsTab(env, sheet.sheetId, sheet.token);
      const e = await ensureEmailInboxTab(env, sheet.sheetId, sheet.token);
      const b = await ensureBatchTab(env, sheet.sheetId, sheet.token);
      await env.KV.delete(`setup:${key}`);
      await env.KV.delete(`setup:${key}:${sheet.sheetId}`);
      await env.KV.delete(`companysetup:v3:${key}:${sheet.sheetId}`);
      return reply(env, event.replyToken, textMsg(
        `อัปเกรดชีทเรียบร้อย ✅\n` +
        `หัวคอลัมน์: ${h.changed ? `เพิ่ม ${h.added} ช่อง` : "ครบอยู่แล้ว"}\n` +
        `เติม id/วันที่: ${i.filled} ช่อง\n` +
        `แท็บ _settings: ${s.created ? "สร้างใหม่" : "มีอยู่แล้ว"}\n` +
        `แท็บ Email_Inbox: ${e.created ? "สร้างใหม่" : "มีอยู่แล้ว"}\n` +
        `แท็บ รอบเบิก: ${b.created ? "สร้างใหม่" : "มีอยู่แล้ว"}`
      ));
    } catch (e) {
      return reply(env, event.replyToken, textMsg("อัปเกรดไม่สำเร็จ 🙏\n" + String(e).slice(0, 300)));
    }
  }

  if (/^(อีเมล|email|อีเมลรับเอกสาร|รับเอกสาร)$/i.test(text)) {
    const base = await dashUrl(env, key);
    const url = base ? `${base}&page=email` : "";
    const status = await getGmailStatus(env, key);
    if (status.connected) {
      return reply(env, event.replyToken, textMsg(
        `เชื่อม Gmail แล้ว ✅\n${status.email || "บัญชี Google"}\n\n` +
        `ระบบจะค้นหาใบเสร็จ ใบกำกับภาษี และ Subscription อัตโนมัติ` +
        (url ? `\n\nเปิดกล่องเอกสาร:\n${url}` : "")
      ));
    }
    return reply(env, event.replyToken, textMsg(
      `เปิดหน้าเอกสารจากอีเมล แล้วกด “เชื่อมต่อ Gmail” ได้เลย` +
      (url ? `\n\n${url}` : "") +
      `\n\nรุ่น Beta ต้องใช้อีเมลที่ถูกเพิ่มเป็น Test user`
    ));
  }

  if (/^(ตั้งค่า|settings|ข้อมูลบริษัท)$/i.test(text)) {
    const url = await dashUrl(env, key, "/receipt");
    if (!url) return reply(env, event.replyToken, textMsg("ยังไม่ได้ตั้งค่าแดชบอร์ดครับ 🙏"));
    return reply(env, event.replyToken, textMsg("กรอกข้อมูลบริษัทได้ที่นี่ ⚙️\n" + url));
  }

  if (/^(รีเซ็ตลิงก์|รีเซ็ทลิงก์|reset ?link|revoke)$/i.test(text)) {
    await resetDashToken(env, key);
    const url = await dashUrl(env, key);
    if (!url) return reply(env, event.replyToken, textMsg("ออกลิงก์ใหม่แล้ว แต่ยังไม่ได้ตั้งค่าแดชบอร์ดครับ 🙏"));
    return reply(env, event.replyToken, textMsg(
      "ออกลิงก์ใหม่แล้ว ✅ ลิงก์เก่าทั้งหมดใช้ไม่ได้อีกต่อไป\n\nแดชบอร์ด:\n" + url
    ));
  }

  if (/^(หลักฐาน|จับคู่รูป|files)$/i.test(text)) {
    const url = await dashUrl(env, key, "/files");
    if (!url) return reply(env, event.replyToken, textMsg("ยังไม่ได้ตั้งค่าแดชบอร์ดครับ 🙏"));
    return reply(env, event.replyToken, textMsg("จับคู่รูปหลักฐานเข้ารายการได้ที่นี่ 📎\n" + url));
  }

  if (/^(ใบแทน|ใบรับรอง|receipt)$/i.test(text)) {
    const url = await dashUrl(env, key, "/receipt");
    if (!url) return reply(env, event.replyToken, textMsg("ยังไม่ได้ตั้งค่าแดชบอร์ดครับ 🙏"));
    return reply(env, event.replyToken, textMsg("ออกใบรับรองแทนใบเสร็จได้ที่นี่ 🧾\n" + url));
  }

  if (/^(รอบเบิก|เบิกเป็นรอบ|batch)$/i.test(text)) {
    const base = await dashUrl(env, key);
    const url = base ? `${base}&page=batches` : "";
    return reply(env, event.replyToken, textMsg(
      `เปิดหน้าใบเบิกได้ที่นี่
ระบบรวมรายการย่อยของผู้เบิกคนเดียวเป็นใบเบิกหลัก 1 ไฟล์อัตโนมัติทุกวันจันทร์ 11:00 น.` +
      (url ? `

${url}` : "")
    ));
  }

  if (/เชื่อม|connect/i.test(text)) {
    return reply(env, event.replyToken, connectMsg(env, key));
  }

  if (/สรุป|dashboard|แดชบอร์ด/i.test(text)) {
    if (!env.DASHBOARD_URL) return reply(env, event.replyToken, textMsg("ยังไม่ได้ตั้งค่าแดชบอร์ดครับ 🙏"));
    return reply(env, event.replyToken, await dashboardMsg(env, key));
  }

  if (/^(ช่วย|help|คำสั่ง)$/i.test(text)) {
    return reply(env, event.replyToken, textMsg(
      "ส่งรูปหลายใบต่อกันได้เลย ทั้งสลิป ใบเสร็จ และหลักฐาน ระบบจะจับคู่ให้เป็นหลายรายการอัตโนมัติ 📒\n\n" +
      "คำสั่งเสริม (ถ้าอยากใช้):\n" +
      "• จัดบิล — เรียกการ์ดตรวจชุดล่าสุดทันที\n" +
      "• ยกเลิกชุด — ทิ้งชุดที่กำลังจัด\n" +
      "• แดชบอร์ด — เปิดหน้ารวมทุกอย่าง\n" +
      "• ตั้งค่า — กรอกข้อมูลบริษัท\n" +
      "• อีเมล — เชื่อม Gmail และดูใบเสร็จ/ใบกำกับอัตโนมัติ\n" +
      "• ใบเบิก — ดูรายการย่อยที่รอรวมและใบเบิกหลัก\n" +
      "• รีเซ็ตลิงก์ — ยกเลิกลิงก์เก่าทั้งหมด\n" +
      "• เชื่อม — เชื่อม Google"
    ));
  }
}

/* ═════════════════════════ utils ═════════════════════════ */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json" } });
}
function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "*");
  return res;
}
