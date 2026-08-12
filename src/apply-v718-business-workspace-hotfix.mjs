import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const indexFile = path.join(root, "src/index.js");
if (!fs.existsSync(indexFile)) {
  throw new Error("ไม่พบ src/index.js — ให้รันไฟล์นี้ที่ root ของ deal-line-bot");
}

let s = fs.readFileSync(indexFile, "utf8");

const MARKER = "BUSINESS_WORKSPACE_RELIABILITY_V7_18_20260811";
if (s.includes(MARKER)) {
  console.log("✅ v7.18 business workspace reliability already applied");
  process.exit(0);
}

function mustReplace(text, from, to, label) {
  if (!text.includes(from)) {
    throw new Error(`หา anchor ไม่เจอ: ${label}\nหยุดก่อนเพื่อไม่แก้ source ผิดเวอร์ชัน`);
  }
  return text.replace(from, to);
}

s = mustReplace(
  s,
  `function businessInviteKey(code) { return \`businessinvite:v1:\${String(code || "").toUpperCase()}\`; }

async function getAccountRoot(env, tenant) {`,
  `function businessInviteKey(code) { return \`businessinvite:v1:\${String(code || "").toUpperCase()}\`; }
// ${MARKER}
// แยก membership เป็น key รายธุรกิจ เพื่อให้การเพิ่มธุรกิจเป็น additive
// และไม่เสียสมาชิกใหม่จาก Cloudflare KV eventual consistency
function businessMemberPrefix(rootTenant) { return \`businessmember:v1:\${String(rootTenant || "")}:\`; }
function businessMemberKey(rootTenant, tenant) { return \`\${businessMemberPrefix(rootTenant)}\${String(tenant || "")}\`; }
function businessRecoveryKey(rootTenant) { return \`businessrecovery:v1:\${String(rootTenant || "")}\`; }

async function recoverLegacyBusinessMembers(env, rootTenant) {
  // ใช้ครั้งเดียวเพื่อกู้ business ที่เคยเชื่อมสำเร็จ แต่ account list ถูก stale read เขียนทับ
  const done = await env.KV.get(businessRecoveryKey(rootTenant));
  if (done === "1") return [];

  const found = [];
  let cursor = undefined;
  do {
    const listed = await env.KV.list({
      prefix: "accountroot:v1:",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const entry of listed.keys || []) {
      const tenant = String(entry.name || "").slice("accountroot:v1:".length);
      if (!tenant || tenant === rootTenant) continue;
      const mappedRoot = await env.KV.get(entry.name);
      if (mappedRoot === rootTenant) found.push(tenant);
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);

  const unique = [...new Set(found)];
  await Promise.all([
    ...unique.map((tenant) => env.KV.put(businessMemberKey(rootTenant, tenant), "1")),
    env.KV.put(businessRecoveryKey(rootTenant), "1"),
  ]);
  return unique;
}

async function getAccountRoot(env, tenant) {`,
  "business membership helpers"
);

s = mustReplace(
  s,
  `async function ensureBusinessAccount(env, tenant) {
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
}`,
  `async function ensureBusinessAccount(env, tenant) {
  const rootTenant = await getAccountRoot(env, tenant);
  let stored = await env.KV.get(businessAccountKey(rootTenant), "json").catch(() => null);
  const created = !stored || typeof stored !== "object";

  if (created) {
    stored = {
      schema: BUSINESS_ACCOUNT_SCHEMA,
      rootTenant,
      businesses: [rootTenant],
      createdAt: new Date().toISOString(),
    };
  }

  const storedList = Array.from(new Set([
    rootTenant,
    ...(Array.isArray(stored.businesses) ? stored.businesses : []),
  ].filter(Boolean)));

  // Membership index เป็น additive key ต่อธุรกิจ
  // ถ้า PoP นี้อ่าน businessaccount ตัวเก่า จะไม่สามารถเขียน list เก่าทับสมาชิกใหม่ได้อีก
  const indexed = await env.KV.list({ prefix: businessMemberPrefix(rootTenant), limit: 1000 });
  const indexedMembers = (indexed.keys || [])
    .map((entry) => String(entry.name || "").slice(businessMemberPrefix(rootTenant).length))
    .filter(Boolean);

  let list = Array.from(new Set([rootTenant, ...storedList, ...indexedMembers]));

  // กู้เคสเก่าที่ LINE เคยตอบ "เพิ่มธุรกิจสำเร็จ" แล้ว แต่ Dashboard polling
  // อ่าน KV stale และเขียน account list เก่าทับกลับไป
  if (list.length <= 1) {
    const recovered = await recoverLegacyBusinessMembers(env, rootTenant);
    if (recovered.length) list = Array.from(new Set([...list, ...recovered]));
  }

  const account = {
    ...stored,
    schema: BUSINESS_ACCOUNT_SCHEMA,
    rootTenant,
    businesses: list,
    updatedAt: new Date().toISOString(),
  };

  // สำคัญ: read path ห้าม rewrite businessaccount ถ้าไม่มีข้อมูลใหม่
  // เพราะ Cloudflare KV เป็น eventual consistency และ stale read อาจลบสมาชิกใหม่ได้
  const gainedMembers = list.some((businessTenant) => !storedList.includes(businessTenant));
  if (created || gainedMembers) {
    await env.KV.put(businessAccountKey(rootTenant), JSON.stringify(account));
  }

  await Promise.all([
    ...list.map((businessTenant) => env.KV.put(accountRootMapKey(businessTenant), rootTenant)),
    ...list.map((businessTenant) => env.KV.put(businessMemberKey(rootTenant, businessTenant), "1")),
  ]);

  return account;
}`,
  "safe ensureBusinessAccount"
);

s = mustReplace(
  s,
  `  if ((existingRoot && existingRoot !== rootTenant) || (existingSheet && currentTenant !== rootTenant)) {
    return { ok: false, reason: "already_linked", message: "กลุ่ม LINE นี้มีธุรกิจ/ข้อมูลเดิมอยู่แล้ว จึงไม่สามารถนำไปผูกทับกับบัญชีอื่นได้" };
  }`,
  `  if (existingRoot && existingRoot !== rootTenant) {
    return { ok: false, reason: "already_linked", message: "กลุ่ม LINE นี้ถูกผูกกับบัญชีอื่นอยู่แล้ว จึงไม่สามารถนำมาผูกทับได้" };
  }
  if (existingSheet && currentTenant !== rootTenant && existingRoot !== rootTenant) {
    return { ok: false, reason: "already_linked", message: "กลุ่ม LINE นี้มีข้อมูลธุรกิจเดิมอยู่แล้ว กรุณาใช้กลุ่มใหม่หรือเปิดจากบัญชีเดิม" };
  }
  // ถ้า existingRoot === rootTenant ให้ทำแบบ idempotent repair ได้
  // กรณี LINE เคยบอกว่าสำเร็จ แต่ account list ถูก KV stale overwrite`,
  "idempotent same-root relink"
);

s = mustReplace(
  s,
  `  await Promise.all([
    env.KV.put(accountRootMapKey(currentTenant), rootTenant),
    env.KV.put(businessAccountKey(rootTenant), JSON.stringify({ ...account, businesses: nextBusinesses, updatedAt: new Date().toISOString() })),
    env.KV.delete(businessInviteKey(code)),
  ]);`,
  `  await Promise.all([
    env.KV.put(accountRootMapKey(currentTenant), rootTenant),
    env.KV.put(businessMemberKey(rootTenant, rootTenant), "1"),
    env.KV.put(businessMemberKey(rootTenant, currentTenant), "1"),
    env.KV.put(businessAccountKey(rootTenant), JSON.stringify({ ...account, businesses: nextBusinesses, updatedAt: new Date().toISOString() })),
    env.KV.delete(businessInviteKey(code)),
  ]);`,
  "persist additive business membership"
);

fs.writeFileSync(indexFile, s);
console.log("✅ v7.18 Business Link Reliability applied");
console.log("Fix: stale KV read no longer overwrites newly linked businesses");
console.log("Fix: recovers previously orphaned same-account LINE groups");
