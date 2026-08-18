import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const file = path.join(process.cwd(), "src", "index.js");
const MARK = "SUBSCRIPTION_USAGE_DETAIL_V7_84_20260818";

if (!fs.existsSync(file)) throw new Error("v7.84 missing src/index.js");

let src = fs.readFileSync(file, "utf8");

if (!src.includes(MARK)) {
  const snapshotAnchor = `async function getSubscriptionSnapshot(env, key, sheetId, token, { refreshUsage = false } = {}) {`;
  if (!src.includes(snapshotAnchor)) throw new Error("v7.84 subscription snapshot anchor missing");

  const helpers = `
// ${MARK}
function usageMonthV784(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const iso = raw.match(/(20\\d{2})[-\\/]?(\\d{2})/);
  if (iso) return \`\${iso[1]}-\${iso[2]}\`;
  const th = raw.match(/(25\\d{2})[-\\/]?(\\d{2})/);
  if (th) return \`\${Number(th[1]) - 543}-\${th[2]}\`;
  const d = new Date(raw);
  return Number.isFinite(d.getTime())
    ? \`\${d.getUTCFullYear()}-\${String(d.getUTCMonth()+1).padStart(2,"0")}\`
    : "";
}

function usageSourceV784(row = {}) {
  const docType = String(row.docType || "").trim();
  const sender = String(row.sender || "").trim();
  const sub = String(row.subCategory || "").trim();
  const payerId = String(row.payerId || "").trim();

  if (/ใบขอเบิกคู่ค้า|ตั้งเบิกคู่ค้า|คู่ค้า \\/ บริษัท|ช่าง \\/ Freelance/i.test(docType + " " + sub)) {
    return { key:"requisition", label:"ตั้งเบิก / ตั้งเบิกคู่ค้า" };
  }
  if (/บันทึกเอง/i.test(docType)) {
    return { key:"manual", label:"บันทึกรายจ่ายเอง" };
  }
  if (/gmail|email|อีเมล/i.test(sender + " " + docType)) {
    return { key:"email", label:"เอกสารจากอีเมล" };
  }
  if (/^U[0-9a-f]{32}$/i.test(payerId) || row.imageUrl) {
    return { key:"line", label:"LINE / ส่งเอกสารให้บอท" };
  }
  return { key:"other", label:"รายการอื่นในระบบ" };
}

function usageStampV784(row = {}) {
  return row.createdAt || row.recordedAt || row.submittedAt || row.dateISO || row.date || row.dateText || "";
}

async function buildSubscriptionUsageDetailV784(env, key, snapshot = {}) {
  const monthKey = String(snapshot?.usage?.monthKey || snapshot?.usage?.month || subscriptionMonthKey()).slice(0,7);
  const rootTenant = await getAccountRoot(env, key);
  const account = await ensureBusinessAccount(env, rootTenant).catch(() => ({ rootTenant, businesses:[key] }));
  const businessTenants = Array.from(new Set((account?.businesses || [key]).filter(Boolean)));

  const bucketOrder = ["line","manual","requisition","email","other"];
  const buckets = new Map([
    ["line",        { key:"line",        label:"LINE / ส่งเอกสารให้บอท", count:0 }],
    ["manual",      { key:"manual",      label:"บันทึกรายจ่ายเอง", count:0 }],
    ["requisition", { key:"requisition", label:"ตั้งเบิก / ตั้งเบิกคู่ค้า", count:0 }],
    ["email",       { key:"email",       label:"เอกสารจากอีเมล", count:0 }],
    ["other",       { key:"other",       label:"รายการอื่นในระบบ", count:0 }],
  ]);

  const activities = [];
  const businesses = [];

  const results = await Promise.all(businessTenants.map(async (tenant) => {
    try {
      const sheetId = (await env.KV.get(\`tenant:\${tenant}\`)) || (tenant === key ? env.DEFAULT_SHEET_ID : "");
      if (!sheetId) return { tenant, rows:[], name:"ธุรกิจ", unavailable:true };

      const token = await getUserToken(env, tenant).catch(() => null);
      if (!token) return { tenant, rows:[], name:"ธุรกิจ", unavailable:true };

      const [rows, settings] = await Promise.all([
        readExpenses(env, sheetId, token).catch(() => []),
        readSettings(env, sheetId, token).catch(() => ({})),
      ]);

      const name = settingValue(settings, "company_name") || (tenant === rootTenant ? "ธุรกิจหลัก" : "ธุรกิจ");
      const monthRows = (rows || []).filter((row) => usageMonthV784(usageStampV784(row)) === monthKey);
      return { tenant, rows:monthRows, name, unavailable:false };
    } catch {
      return { tenant, rows:[], name:"ธุรกิจ", unavailable:true };
    }
  }));

  for (const result of results) {
    const businessCounts = { line:0, manual:0, requisition:0, email:0, other:0 };
    for (const row of result.rows || []) {
      const source = usageSourceV784(row);
      const bucket = buckets.get(source.key) || buckets.get("other");
      bucket.count += 1;
      businessCounts[source.key] = Number(businessCounts[source.key] || 0) + 1;

      activities.push({
        id:String(row.id || ""),
        date:String(row.createdAt || row.dateISO || row.date || row.dateText || ""),
        source:source.key,
        sourceLabel:source.label,
        businessName:result.name,
        vendor:String(row.vendor || "ไม่ระบุผู้รับ"),
        description:String(row.note || row.docType || "").slice(0,160),
        amount:Number(row.amount || 0),
        status:String(row.batchStatus || row.status || ""),
      });
    }

    businesses.push({
      tenant:result.tenant,
      name:result.name,
      count:(result.rows || []).length,
      unavailable:result.unavailable === true,
      breakdown:businessCounts,
    });
  }

  activities.sort((a,b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));

  const knownTotal = bucketOrder.reduce((sum,keyName) => sum + Number(buckets.get(keyName)?.count || 0), 0);
  const quotaUsed = Number(snapshot?.usage?.documents || 0);
  const quotaLimit = snapshot?.documentLimit == null ? null : Number(snapshot.documentLimit || 0);
  const unclassifiedQuota = Math.max(0, quotaUsed - knownTotal);

  const breakdown = bucketOrder
    .map((keyName) => ({ ...buckets.get(keyName) }))
    .filter((row) => row.count > 0);

  if (unclassifiedQuota > 0) {
    breakdown.push({
      key:"unattributed",
      label:"รายการเดิม / ยังระบุช่องทางไม่ได้",
      count:unclassifiedQuota,
    });
  }

  const aiUsed = Number(snapshot?.aiUsage?.documents || 0);
  const aiLimit = Number(snapshot?.aiDocumentLimit || 0);

  return {
    monthKey,
    quota:{
      used:quotaUsed,
      limit:quotaLimit,
      remaining:quotaLimit == null ? null : Math.max(0,quotaLimit-quotaUsed),
    },
    ai:{
      used:aiUsed,
      limit:aiLimit,
      remaining:Math.max(0,aiLimit-aiUsed),
    },
    breakdown,
    businessBreakdown:businesses,
    recent:activities.slice(0,20),
    classifiedRows:knownTotal,
    unclassifiedQuota,
    countingRule:"สร้างรายการใหม่ 1 ครั้ง = 1 รายการ · อนุมัติ เปลี่ยนสถานะ แนบสลิป และ Export ไม่ใช้โควตารายการเพิ่ม",
  };
}

`;

  src = src.replace(snapshotAnchor, helpers + snapshotAnchor);

  const routeOld = `        if (url.pathname === "/api/subscription") {
          return cors(json(await getSubscriptionSnapshot(env, key, sheetId, token, { refreshUsage: true })));
        }`;

  const routeNew = `        if (url.pathname === "/api/subscription") {
          const snapshot = await getSubscriptionSnapshot(env, key, sheetId, token, { refreshUsage: true });
          const usageDetail = await buildSubscriptionUsageDetailV784(env, key, snapshot).catch((error) => {
            console.warn("subscription usage detail", error?.message || error);
            return {
              monthKey:String(snapshot?.usage?.monthKey || snapshot?.usage?.month || ""),
              quota:{
                used:Number(snapshot?.usage?.documents || 0),
                limit:snapshot?.documentLimit == null ? null : Number(snapshot.documentLimit || 0),
                remaining:snapshot?.documentLimit == null ? null : Math.max(0,Number(snapshot.documentLimit || 0)-Number(snapshot?.usage?.documents || 0)),
              },
              ai:{
                used:Number(snapshot?.aiUsage?.documents || 0),
                limit:Number(snapshot?.aiDocumentLimit || 0),
                remaining:Math.max(0,Number(snapshot?.aiDocumentLimit || 0)-Number(snapshot?.aiUsage?.documents || 0)),
              },
              breakdown:[],
              businessBreakdown:[],
              recent:[],
              countingRule:"สร้างรายการใหม่ 1 ครั้ง = 1 รายการ · อนุมัติ เปลี่ยนสถานะ แนบสลิป และ Export ไม่ใช้โควตารายการเพิ่ม",
              partial:true,
            };
          });
          return cors(json({ ...snapshot, usageDetail }));
        }`;

  if (!src.includes(routeOld)) throw new Error("v7.84 /api/subscription route anchor missing");
  src = src.replace(routeOld, routeNew);

  src += `\n// ${MARK}\n`;
}

fs.writeFileSync(file, src);
execFileSync(process.execPath, ["--check", file], { stdio:"inherit" });

if (!src.includes(MARK) || !src.includes("usageDetail") || !src.includes("buildSubscriptionUsageDetailV784")) {
  throw new Error("v7.84 backend audit failed");
}

console.log(`✅ ${MARK}`);
console.log("✅ /api/subscription now includes usageDetail");
console.log("✅ breakdown: LINE / manual / requisition / email / other");
console.log("✅ account-wide business breakdown + recent usage");
