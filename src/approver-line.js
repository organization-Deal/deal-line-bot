// v7.26 — LINE Approver Directory + Direct Approval Notification
// - remembers members from webhook events
// - optionally refreshes all group members for Verified/Premium LINE OA
// - merges existing team_members from the workspace sheet
// - sends approval notifications to approver role tokens with their own Dashboard URL

import { push } from "./line.js";
import { readSettings } from "./sheets.js";
import { getUserToken } from "./oauth.js";
import { reimbursementWorkflowConfig } from "./workflow-config.js";

const VERSION = "LINE_WORKFLOW_NOTIFY_V7_33_FLEXIBLE_20260813";
const LINE_API = "https://api.line.me/v2/bot";
const MEMBER_PREFIX = "linemember:v1:";
const NOTIFY_PREFIX = "approvernotify:v1:";
const WORKFLOW_NOTIFY_PREFIX = "workflownotify:v2:";

function clean(value, max = 160) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function validUserId(value) {
  return /^U[0-9a-f]{32}$/i.test(String(value || "").trim());
}

function sourceTenant(source = {}) {
  return String(source.groupId || source.roomId || source.userId || "").trim();
}

function memberKey(tenant, userId) {
  return `${MEMBER_PREFIX}${tenant}:${userId}`;
}

function memberPrefix(tenant) {
  return `${MEMBER_PREFIX}${tenant}:`;
}

function accessPrefix(tenant) {
  return `daccess:${tenant}:`;
}

async function lineFetch(env, path) {
  const response = await fetch(`${LINE_API}${path}`, {
    headers: { Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}` },
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  return { response, data, text };
}

async function resolvedCompanyName(env, tenant, preferred = "") {
  const preferredName = clean(preferred || "", 120);
  const meaningfulPreferred = preferredName && !["บริษัทนี้", "บริษัทของคุณ", "บริษัท"].includes(preferredName);
  if (meaningfulPreferred) return preferredName;

  try {
    const sheetId = (await env.KV.get(`tenant:${tenant}`)) || env.DEFAULT_SHEET_ID || "";
    if (sheetId) {
      const token = await getUserToken(env, tenant).catch(() => null);
      const settings = await readSettings(env, sheetId, token).catch(() => ({}));
      const fromSettings = clean(
        settings.company_name ||
        settings.companyName ||
        settings.business_name ||
        settings.businessName ||
        "",
        120
      );
      if (fromSettings) return fromSettings;
    }
  } catch {}

  return preferredName || "บริษัทของคุณ";
}

async function rememberCompanyOnAccess(env, tenant, record, companyName) {
  const token = clean(record?.token || "", 120);
  if (!token || !companyName) return;
  const key = `daccess:${tenant}:${token}`;
  const current = await env.KV.get(key, "json").catch(() => null);
  if (!current || current.active === false || current.companyName === companyName) return;
  await env.KV.put(key, JSON.stringify({
    ...current,
    companyName,
    companyNameResolvedAt: new Date().toISOString(),
  }));
}

async function workspaceName(env, tenant) {
  tenant = clean(tenant, 100);
  if (!tenant) return "";

  try {
    if (/^C/i.test(tenant)) {
      const { response, data } = await lineFetch(env, `/group/${encodeURIComponent(tenant)}/summary`);
      if (response.ok) return clean(data.groupName || "", 120);
    }
    if (/^R/i.test(tenant)) return "ห้อง LINE";
    if (/^U/i.test(tenant)) {
      const { response, data } = await lineFetch(env, `/profile/${encodeURIComponent(tenant)}`);
      if (response.ok) return clean(data.displayName || "แชทส่วนตัว", 120);
      return "แชทส่วนตัว";
    }
  } catch {}
  return "";
}

async function profileFor(env, tenant, userId) {
  if (!validUserId(userId)) return null;

  let path = `/profile/${encodeURIComponent(userId)}`;
  if (/^C/i.test(tenant)) {
    path = `/group/${encodeURIComponent(tenant)}/member/${encodeURIComponent(userId)}`;
  } else if (/^R/i.test(tenant)) {
    path = `/room/${encodeURIComponent(tenant)}/member/${encodeURIComponent(userId)}`;
  }

  const { response, data } = await lineFetch(env, path);
  if (!response.ok) return null;
  return {
    userId,
    displayName: clean(data.displayName || "", 120),
    pictureUrl: clean(data.pictureUrl || "", 500),
  };
}

async function readMember(env, tenant, userId) {
  return await env.KV.get(memberKey(tenant, userId), "json").catch(() => null);
}

async function saveMember(env, tenant, userId, patch = {}) {
  if (!tenant || !validUserId(userId)) return null;
  const current = await readMember(env, tenant, userId);
  const now = new Date().toISOString();
  const next = {
    version: VERSION,
    tenant,
    userId,
    displayName: clean(patch.displayName ?? current?.displayName ?? "", 120),
    pictureUrl: clean(patch.pictureUrl ?? current?.pictureUrl ?? "", 500),
    active: patch.active !== undefined ? Boolean(patch.active) : current?.active !== false,
    source: clean(patch.source || current?.source || "webhook", 80),
    firstSeenAt: current?.firstSeenAt || now,
    lastSeenAt: patch.lastSeenAt || now,
    profileCheckedAt: patch.profileCheckedAt || current?.profileCheckedAt || "",
  };
  await env.KV.put(memberKey(tenant, userId), JSON.stringify(next), {
    expirationTtl: 86400 * 730,
  });
  return next;
}

async function touchMember(env, tenant, userId, { active = true, source = "webhook", forceProfile = false } = {}) {
  if (!validUserId(userId)) return null;
  const current = await readMember(env, tenant, userId);
  const nowMs = Date.now();
  const lastMs = Date.parse(current?.lastSeenAt || "");
  const profileMs = Date.parse(current?.profileCheckedAt || "");
  const profileStale = !Number.isFinite(profileMs) || nowMs - profileMs > 30 * 86400000;
  const seenStale = !Number.isFinite(lastMs) || nowMs - lastMs > 6 * 3600000;

  // Avoid a KV write on every chat message.
  if (current && current.active === active && !seenStale && !forceProfile && !profileStale) return current;

  let profile = null;
  if (active && (!current?.displayName || forceProfile || profileStale)) {
    profile = await profileFor(env, tenant, userId).catch(() => null);
  }

  return saveMember(env, tenant, userId, {
    active,
    source,
    displayName: profile?.displayName || current?.displayName || "",
    pictureUrl: profile?.pictureUrl || current?.pictureUrl || "",
    profileCheckedAt: profile ? new Date().toISOString() : current?.profileCheckedAt || "",
    lastSeenAt: new Date().toISOString(),
  });
}

export async function rememberLineEventMembers(env, event) {
  const source = event?.source || {};
  const tenant = sourceTenant(source);
  if (!tenant) return { ok: false, reason: "no_tenant" };

  const jobs = [];

  // Any user-originated webhook gives us a userId.
  if (validUserId(source.userId)) {
    jobs.push(touchMember(env, tenant, source.userId, {
      active: event.type !== "unfollow",
      source: `webhook:${event.type || "event"}`,
    }));
  }

  // When users join a group/room, LINE sends memberJoined with joined.members[].
  if (event?.type === "memberJoined") {
    for (const member of event.joined?.members || []) {
      if (!validUserId(member?.userId)) continue;
      jobs.push(touchMember(env, tenant, member.userId, {
        active: true,
        source: "webhook:memberJoined",
        forceProfile: true,
      }));
    }
  }

  if (event?.type === "memberLeft") {
    for (const member of event.left?.members || []) {
      if (!validUserId(member?.userId)) continue;
      jobs.push(touchMember(env, tenant, member.userId, {
        active: false,
        source: "webhook:memberLeft",
      }));
    }
  }

  if (!jobs.length) return { ok: true, remembered: 0 };
  const settled = await Promise.allSettled(jobs);
  return {
    ok: true,
    remembered: settled.filter((x) => x.status === "fulfilled" && x.value).length,
  };
}

async function cachedMembers(env, tenant) {
  const rows = [];
  let cursor;
  do {
    const page = await env.KV.list({
      prefix: memberPrefix(tenant),
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    const records = await Promise.all(
      (page.keys || []).map((entry) => env.KV.get(entry.name, "json").catch(() => null))
    );
    for (const rec of records) if (rec?.userId) rows.push(rec);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && rows.length < 5000);
  return rows;
}

function parseTeamMembers(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function seedFromTeamMembers(env, tenant, sheetId, token) {
  if (!sheetId) return 0;
  const settings = await readSettings(env, sheetId, token).catch(() => ({}));
  const team = parseTeamMembers(settings.team_members);
  let count = 0;
  for (const member of team) {
    const userId = clean(member?.lineUserId || member?.payerId || "", 80);
    if (!validUserId(userId)) continue;
    await saveMember(env, tenant, userId, {
      displayName: member?.name || member?.displayName || "",
      active: true,
      source: "sheet:team_members",
    });
    count += 1;
  }
  return count;
}

async function refreshAllMemberIds(env, tenant) {
  const isGroup = /^C/i.test(tenant);
  const isRoom = /^R/i.test(tenant);
  if (!isGroup && !isRoom) {
    return { supported: false, authorized: false, memberIds: [] };
  }

  const base = isGroup
    ? `/group/${encodeURIComponent(tenant)}/members/ids`
    : `/room/${encodeURIComponent(tenant)}/members/ids`;

  const ids = [];
  let start = "";
  let authorized = true;

  for (let page = 0; page < 10; page++) {
    const path = start ? `${base}?start=${encodeURIComponent(start)}` : base;
    const { response, data } = await lineFetch(env, path);

    if (response.status === 403) {
      authorized = false;
      break;
    }
    if (!response.ok) break;

    for (const id of data.memberIds || []) if (validUserId(id)) ids.push(id);
    start = String(data.next || "");
    if (!start) break;
  }

  return {
    supported: true,
    authorized,
    memberIds: [...new Set(ids)].slice(0, 1000),
  };
}

async function refreshProfiles(env, tenant, userIds = []) {
  let refreshed = 0;
  for (let i = 0; i < userIds.length; i += 10) {
    const chunk = userIds.slice(i, i + 10);
    const profiles = await Promise.all(
      chunk.map(async (userId) => {
        const profile = await profileFor(env, tenant, userId).catch(() => null);
        return { userId, profile };
      })
    );
    for (const { userId, profile } of profiles) {
      await saveMember(env, tenant, userId, {
        displayName: profile?.displayName || "",
        pictureUrl: profile?.pictureUrl || "",
        active: true,
        source: "line:member-list",
        profileCheckedAt: profile ? new Date().toISOString() : "",
      });
      refreshed += 1;
    }
  }
  return refreshed;
}

export async function listLineWorkspaceMembers(env, tenant, {
  sheetId = "",
  token = null,
  refresh = true,
} = {}) {
  tenant = clean(tenant, 100);
  if (!tenant) return { ok: false, reason: "missing_tenant", members: [] };

  await seedFromTeamMembers(env, tenant, sheetId, token).catch(() => 0);

  let fullList = { supported: false, authorized: false, memberIds: [] };
  if (refresh) {
    fullList = await refreshAllMemberIds(env, tenant).catch(() => ({
      supported: false, authorized: false, memberIds: [],
    }));
    if (fullList.memberIds.length) {
      await refreshProfiles(env, tenant, fullList.memberIds).catch(() => 0);
    }
  }

  const members = (await cachedMembers(env, tenant))
    .filter((row) => validUserId(row.userId))
    .sort((a, b) => {
      if (a.active !== b.active) return a.active === false ? 1 : -1;
      return String(a.displayName || a.userId).localeCompare(String(b.displayName || b.userId), "th");
    })
    .map((row) => ({
      userId: row.userId,
      displayName: row.displayName || `LINE ${String(row.userId).slice(-6)}`,
      pictureUrl: row.pictureUrl || "",
      active: row.active !== false,
      source: row.source || "",
      firstSeenAt: row.firstSeenAt || "",
      lastSeenAt: row.lastSeenAt || "",
    }));

  const resolvedWorkspaceName = await workspaceName(env, tenant).catch(() => "");

  return {
    ok: true,
    version: VERSION,
    workspaceName: resolvedWorkspaceName,
    workspaceType: /^C/i.test(tenant) ? "group" : /^R/i.test(tenant) ? "room" : "user",
    members,
    count: members.length,
    activeCount: members.filter((m) => m.active).length,
    fullGroupRefreshSupported: fullList.supported,
    fullGroupRefreshAuthorized: fullList.authorized,
    directoryMode: fullList.authorized ? "line-full-group" : "known-members",
    directPushNote:
      "การแจ้งส่วนตัวจะถึงผู้ใช้ได้ต่อเนื่องเมื่อผู้อนุมัติเพิ่ม LINE OA เป็นเพื่อน; กลุ่ม LINE ยังเป็น fallback หลัก",
  };
}

export async function bindApproverLine(env, tenant, accessToken, lineUserId) {
  accessToken = clean(accessToken, 120);
  lineUserId = clean(lineUserId, 80);
  if (!accessToken || !validUserId(lineUserId)) {
    return { ok: false, reason: "invalid_input" };
  }

  const key = `daccess:${tenant}:${accessToken}`;
  const rec = await env.KV.get(key, "json").catch(() => null);
  if (!rec || rec.active === false) return { ok: false, reason: "access_not_found" };
  if (!["approver", "accountant"].includes(String(rec.role || ""))) {
    return { ok: false, reason: "workflow_role_only" };
  }

  const member = await readMember(env, tenant, lineUserId);
  const next = {
    ...rec,
    lineUserId,
    lineDisplayName: member?.displayName || rec.name || "",
    lineLinkedAt: new Date().toISOString(),
  };
  await env.KV.put(key, JSON.stringify(next));
  return { ok: true, record: { ...next, token: accessToken } };
}

async function workflowAccessRows(env, tenant, role = "approver") {
  const wantedRole = ["approver", "accountant"].includes(String(role || "")) ? String(role) : "approver";
  const rows = [];
  let cursor;
  do {
    const page = await env.KV.list({
      prefix: accessPrefix(tenant),
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const entry of page.keys || []) {
      const rec = await env.KV.get(entry.name, "json").catch(() => null);
      if (!rec || rec.active === false || rec.role !== wantedRole || !validUserId(rec.lineUserId)) continue;
      rows.push({
        ...rec,
        token: entry.name.slice(accessPrefix(tenant).length),
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && rows.length < 1000);

  // One notification per LINE user. Prefer the newest access record.
  const byUser = new Map();
  for (const row of rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))) {
    if (!byUser.has(row.lineUserId)) byUser.set(row.lineUserId, row);
  }
  return [...byUser.values()];
}

async function approverAccessRows(env, tenant) {
  return workflowAccessRows(env, tenant, "approver");
}

function batchSummary(output = {}, kind = "") {
  const batches = Array.isArray(output.batches) ? output.batches : [];
  const itemCount = Number(output.itemCount || batches.reduce((n, b) => n + Number(b.itemCount || b.itemIds?.length || 0), 0));
  const total = Number(output.total || batches.reduce((n, b) => n + Number(b.total || b.amount || 0), 0));
  const people = Number(output.people || new Set(batches.map((b) => b.payerId || b.payerName).filter(Boolean)).size || 0);
  const runNo = clean(output.runNo || batches[0]?.runNo || "", 80);
  const docId = clean(output.docId || output.batchId || batches[0]?.docId || batches[0]?.id || "", 100);
  const eventKey = runNo || docId || batches.map((b) => b.id || b.docId).filter(Boolean).join("_") || `${Date.now()}`;
  return {
    kind,
    itemCount,
    total,
    people,
    runNo,
    docId,
    batchCount: batches.length || (docId ? 1 : 0),
    eventKey: clean(eventKey, 180),
  };
}

function money(value) {
  return Number(value || 0).toLocaleString("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function approverCard(name, summary, dashboardUrl, context = {}) {
  const subtitle = summary.runNo
    ? `รอบ ${summary.runNo}`
    : summary.docId
      ? `เลขที่ ${summary.docId}`
      : "มีเอกสารใหม่รอตรวจ";
  const companyName = clean(context.companyName || context.businessName || "", 100);
  const groupName = clean(context.lineGroupName || "", 100);

  return {
    type: "flex",
    altText: `มีใบเบิกรออนุมัติ ${summary.itemCount || ""} รายการ`,
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "20px",
        contents: [
          { type: "text", text: "รออนุมัติ", size: "xs", weight: "bold", color: "#D92D20" },
          { type: "text", text: `มีใบเบิกรอให้ ${clean(name || "ผู้อนุมัติ", 40)} ตรวจ`, size: "xl", weight: "bold", color: "#111111", wrap: true },
          { type: "text", text: subtitle, size: "sm", color: "#6E6E73", wrap: true },
          ...(companyName ? [{ type: "text", text: `บริษัท · ${companyName}`, size: "xs", color: "#6E6E73", wrap: true }] : []),
          ...(groupName ? [{ type: "text", text: `LINE กลุ่ม · ${groupName}`, size: "xs", color: "#6E6E73", wrap: true }] : []),
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#F5F5F7",
            cornerRadius: "14px",
            paddingAll: "14px",
            margin: "md",
            spacing: "xs",
            contents: [
              { type: "text", text: `${summary.people || 1} คน · ${summary.itemCount || 0} รายการ`, size: "sm", color: "#3A3A3C" },
              { type: "text", text: `รวม ฿${money(summary.total)}`, size: "lg", weight: "bold", color: "#111111" },
            ],
          },
          { type: "text", text: "ลิงก์นี้เป็นสิทธิ์ Approver ของคุณเอง", size: "xs", color: "#86868B", wrap: true, margin: "sm" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "14px",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#111111",
            height: "sm",
            action: { type: "uri", label: "ตรวจและอนุมัติ", uri: dashboardUrl },
          },
        ],
      },
      styles: {
        body: { backgroundColor: "#FFFFFF" },
        footer: { backgroundColor: "#FFFFFF" },
      },
    },
  };
}


function workflowTaskCard(name, role, summary, dashboardUrl, context = {}) {
  const companyName = clean(context.companyName || context.businessName || "", 100);
  const groupName = clean(context.lineGroupName || "", 100);
  const isApproval = role === "approver";
  const kicker = isApproval ? "รออนุมัติค่าใช้จ่าย" : "รอตรวจเอกสาร";
  const title = isApproval
    ? `มีรายการเบิกใหม่รอให้ ${clean(name || "ผู้อนุมัติ", 40)} อนุมัติ`
    : `มีรายการเบิกรอให้ ${clean(name || "ฝ่ายบัญชี", 40)} ตรวจเอกสาร`;
  const actionLabel = isApproval ? "เปิดหน้าอนุมัติ" : "เปิดหน้าตรวจเอกสาร";
  const roleNote = isApproval
    ? "ตรวจว่าเป็นค่าใช้จ่ายที่บริษัทอนุญาตให้เบิกได้หรือไม่"
    : "ตรวจหลักฐาน ใบเสร็จ ภาษี และความถูกต้องก่อนเข้าสู่ขั้นโอนเงิน";
  const payerText = Array.isArray(summary.payerNames) && summary.payerNames.length
    ? summary.payerNames.slice(0, 3).join(", ") + (summary.payerNames.length > 3 ? " …" : "")
    : clean(summary.payerName || "", 100);

  return {
    type: "flex",
    altText: `${kicker} · ${companyName || "บริษัท"}`,
    contents: {
      type: "bubble",
      size: "mega",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        paddingAll: "20px",
        contents: [
          { type: "text", text: kicker, size: "xs", weight: "bold", color: isApproval ? "#C2410C" : "#2563EB" },
          { type: "text", text: title, size: "xl", weight: "bold", color: "#111111", wrap: true },
          ...(companyName ? [{ type: "text", text: `บริษัท · ${companyName}`, size: "sm", color: "#3A3A3C", wrap: true, margin: "xs" }] : []),
          ...(groupName ? [{ type: "text", text: `LINE กลุ่ม · ${groupName}`, size: "xs", color: "#6E6E73", wrap: true }] : []),
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#F5F5F7",
            cornerRadius: "14px",
            paddingAll: "14px",
            margin: "md",
            spacing: "xs",
            contents: [
              ...(payerText ? [{ type: "text", text: `ผู้เบิก · ${payerText}`, size: "sm", color: "#3A3A3C", wrap: true }] : []),
              { type: "text", text: `${Number(summary.itemCount || 0)} รายการ`, size: "sm", color: "#3A3A3C" },
              { type: "text", text: `รวม ฿${money(summary.total)}`, size: "lg", weight: "bold", color: "#111111" },
            ],
          },
          { type: "text", text: roleNote, size: "xs", color: "#6E6E73", wrap: true, margin: "sm" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "14px",
        contents: [{
          type: "button",
          style: "primary",
          color: "#111111",
          height: "sm",
          action: { type: "uri", label: actionLabel, uri: dashboardUrl },
        }],
      },
      styles: { body: { backgroundColor: "#FFFFFF" }, footer: { backgroundColor: "#FFFFFF" } },
    },
  };
}

function personalDashboardUrl(env, tenant, accessToken) {
  const base = String(env.DASHBOARD_URL || "").replace(/\/$/, "");
  if (!base || !tenant || !accessToken) return "";
  const u = new URL(base);
  u.searchParams.set("tenant", tenant);
  u.searchParams.set("k", accessToken);
  u.searchParams.set("page", "batches");
  return u.toString();
}

async function lineApiRequest(env, path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.line.me${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  return {
    ok: response.ok,
    status: response.status,
    text: String(text || "").slice(0, 500),
    data,
    requestId: response.headers.get("x-line-request-id") || "",
  };
}

async function directLineProfileCheck(env, userId) {
  const out = await lineApiRequest(env, `/v2/bot/profile/${encodeURIComponent(userId)}`).catch((error) => ({
    ok: false,
    status: 0,
    text: String(error?.message || error || "network_error").slice(0, 300),
    data: {},
    requestId: "",
  }));
  if (out.ok) return { ...out, reason: "", displayName: clean(out.data?.displayName || "", 120) };
  let reason = "line_profile_check_failed";
  if (out.status === 400) reason = "line_user_invalid";
  else if (out.status === 401 || out.status === 403) reason = "line_auth_error";
  else if (out.status === 404) reason = "line_profile_unreachable";
  return { ...out, reason, displayName: "" };
}

async function pushLineDetailed(env, to, messages) {
  return lineApiRequest(env, "/v2/bot/message/push", {
    method: "POST",
    body: { to, messages: Array.isArray(messages) ? messages : [messages] },
  }).catch((error) => ({
    ok: false,
    status: 0,
    text: String(error?.message || error || "network_error").slice(0, 300),
    data: {},
    requestId: "",
  }));
}

async function validatePushMessages(env, messages) {
  return lineApiRequest(env, "/v2/bot/message/validate/push", {
    method: "POST",
    body: { messages: Array.isArray(messages) ? messages : [messages] },
  }).catch((error) => ({
    ok: false,
    status: 0,
    text: String(error?.message || error || "network_error").slice(0, 300),
    data: {},
    requestId: "",
  }));
}

function lineFailureReason(result = {}) {
  if (result.reason) return result.reason;
  if (result.status === 400) return "line_push_bad_request";
  if (result.status === 401 || result.status === 403) return "line_auth_error";
  if (result.status >= 500) return "line_platform_error";
  return "line_push_not_delivered";
}

export async function notifyApproverAssignment(env, tenant, record) {
  const role = String(record?.role || "");
  if (!["approver", "accountant"].includes(role) || !validUserId(record?.lineUserId) || !record?.token) {
    return { ok: false, skipped: true, reason: "workflow_line_not_linked" };
  }

  const url = personalDashboardUrl(env, tenant, record.token);
  if (!url) return { ok: false, skipped: true, reason: "dashboard_url_missing" };

  const companyName = await resolvedCompanyName(env, tenant, record.companyName || record.businessName || "");
  await rememberCompanyOnAccess(env, tenant, record, companyName).catch(() => {});
  const groupName = clean(record.lineGroupName || record.workspaceName || "", 120);
  const personName = clean(record.name || record.lineDisplayName || (role === "approver" ? "ผู้อนุมัติ" : "ฝ่ายบัญชี"), 80);
  const fallbackTarget = clean(record.lineGroupTenant || "", 120);
  const roleLabel = role === "approver" ? "ผู้อนุมัติค่าใช้จ่าย" : "บัญชี / ตรวจเอกสาร";
  const roleAction = role === "approver" ? "อนุมัติหรือไม่อนุมัติค่าใช้จ่าย" : "ตรวจเอกสาร ตีกลับ และดำเนินการบัญชี";

  const profile = await directLineProfileCheck(env, record.lineUserId);
  if (!profile.ok) {
    let fallbackGroupSent = false;
    if (/^(C|R)/i.test(fallbackTarget)) {
      const fallbackText = [
        `แจ้ง ${personName}`,
        `ระบบสร้างสิทธิ์ ${roleLabel} ของ ${companyName} แล้ว`,
        "แต่ LINE ส่วนตัวยังไม่พร้อมรับข้อความจาก OA นี้",
        "ให้เปิดแชทกับ LINE OA แล้วส่งคำว่า “เชื่อม” 1 ข้อความ จากนั้น Owner กด “ส่ง LINE ใหม่”",
      ].join("\n");
      fallbackGroupSent = (await pushLineDetailed(env, fallbackTarget, { type: "text", text: fallbackText })).ok;
    }
    return {
      ok: false, attempted: true, accepted: false, sent: false, fallbackGroupSent,
      lineUserId: record.lineUserId, companyName, lineGroupName: groupName,
      reason: profile.reason || "line_profile_unreachable", httpStatus: profile.status || 0,
      lineError: profile.data?.message || profile.text || "", lineRequestId: profile.requestId || "",
      profileReachable: false,
    };
  }

  const message = {
    type: "flex",
    altText: `สิทธิ์ ${roleLabel} · ${companyName}${groupName ? ` · ${groupName}` : ""}`,
    contents: {
      type: "bubble", size: "mega",
      body: {
        type: "box", layout: "vertical", paddingAll: "20px", spacing: "sm",
        contents: [
          { type: "text", text: "สิทธิ์ใหม่", size: "xs", weight: "bold", color: "#147A36" },
          { type: "text", text: `คุณได้รับสิทธิ์ ${roleLabel} แล้ว`, size: "xl", weight: "bold", color: "#111111", wrap: true },
          { type: "text", text: personName, size: "sm", color: "#6E6E73", wrap: true },
          {
            type: "box", layout: "vertical", backgroundColor: "#F5F5F7", cornerRadius: "14px", paddingAll: "14px", margin: "md", spacing: "xs",
            contents: [
              { type: "text", text: "บริษัทที่คุณได้รับสิทธิ์", size: "xs", color: "#86868B", wrap: true },
              { type: "text", text: companyName, size: "md", weight: "bold", color: "#111111", wrap: true },
              ...(groupName ? [{ type: "text", text: `LINE กลุ่ม · ${groupName}`, size: "sm", color: "#3A3A3C", wrap: true, margin: "sm" }] : []),
              { type: "text", text: `สิทธิ์ · ${roleLabel}`, size: "sm", color: "#3A3A3C", wrap: true },
            ],
          },
          { type: "text", text: `เมื่อมีงานถึงขั้นของคุณ ระบบจะส่ง LINE ส่วนตัวพร้อมปุ่มเปิด Dashboard`, size: "sm", color: "#6E6E73", wrap: true, margin: "md" },
          { type: "text", text: `สิทธิ์นี้ใช้สำหรับ ${roleAction}`, size: "xs", color: "#86868B", wrap: true },
        ],
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "14px",
        contents: [{ type: "button", style: "primary", color: "#111111", height: "sm", action: { type: "uri", label: role === "approver" ? "เปิดหน้าอนุมัติ" : "เปิด Dashboard บัญชี", uri: url } }],
      },
      styles: { body: { backgroundColor: "#FFFFFF" }, footer: { backgroundColor: "#FFFFFF" } },
    },
  };

  let delivery = await pushLineDetailed(env, record.lineUserId, message);
  let usedTextFallback = false;
  let validation = null;
  if (!delivery.ok && delivery.status === 400) {
    validation = await validatePushMessages(env, message);
    const plainText = [
      `คุณได้รับสิทธิ์ ${roleLabel} · ${companyName}`,
      groupName ? `กลุ่ม LINE: ${groupName}` : "",
      `ชื่อ: ${personName}`,
      "เปิด Dashboard:", url,
    ].filter(Boolean).join("\n");
    const textDelivery = await pushLineDetailed(env, record.lineUserId, { type: "text", text: plainText });
    if (textDelivery.ok) { delivery = textDelivery; usedTextFallback = true; }
  }

  const accepted = delivery.ok;
  let fallbackGroupSent = false;
  if (!accepted && /^(C|R)/i.test(fallbackTarget)) {
    const fallbackText = [
      `แจ้ง ${personName}`,
      `ระบบสร้างสิทธิ์ ${roleLabel} ของ ${companyName} แล้ว`,
      "แต่ส่งข้อความเข้า LINE ส่วนตัวไม่สำเร็จ",
      "ให้เปิดแชทกับ LINE OA แล้วส่งคำว่า “เชื่อม” 1 ข้อความ จากนั้น Owner กด “ส่ง LINE ใหม่”",
    ].join("\n");
    fallbackGroupSent = (await pushLineDetailed(env, fallbackTarget, { type: "text", text: fallbackText })).ok;
  }

  return {
    ok: accepted, attempted: true, accepted, sent: accepted, fallbackGroupSent,
    lineUserId: record.lineUserId, companyName, lineGroupName: groupName,
    role, reason: accepted ? "" : lineFailureReason(delivery), httpStatus: delivery.status || 0,
    lineError: delivery.data?.message || delivery.text || "", lineRequestId: delivery.requestId || "",
    profileReachable: true, usedTextFallback,
    messageValidationOk: validation ? validation.ok : true,
    messageValidationError: validation && !validation.ok ? (validation.data?.message || validation.text || "") : "",
  };
}

function workflowSummaryEventKey(summary = {}) {
  if (summary.eventKey) return clean(summary.eventKey, 180);
  const ids = Array.isArray(summary.itemIds) ? summary.itemIds.map(String).filter(Boolean).sort() : [];
  if (ids.length) return clean(`items:${ids.join("_")}`, 180);
  return clean(summary.docId || summary.runNo || `${Date.now()}`, 180);
}

export async function notifyWorkflowStage(env, tenant, {
  role = "approver",
  stage = "",
  eventKey = "",
  itemIds = [],
  itemCount = 0,
  total = 0,
  payerName = "",
  payerNames = [],
  docId = "",
  runNo = "",
} = {}) {
  try {
    const sheetId = (await env.KV.get(`tenant:${tenant}`)) || env.DEFAULT_SHEET_ID || "";
    if (sheetId) {
      const token = await getUserToken(env, tenant).catch(() => null);
      const settings = await readSettings(env, sheetId, token).catch(() => ({}));
      if (!reimbursementWorkflowConfig(settings).lineNotifyEnabled) {
        return { ok:true, skipped:true, reason:"line_workflow_notify_disabled", count:0 };
      }
    }
  } catch {}
  const wantedRole = role === "accountant" ? "accountant" : "approver";
  const recipients = await workflowAccessRows(env, tenant, wantedRole);
  if (!recipients.length) return { ok: true, skipped: true, reason: `no_linked_${wantedRole}`, count: 0 };

  const summary = {
    eventKey: eventKey || workflowSummaryEventKey({ itemIds, docId, runNo }),
    itemIds,
    itemCount: Number(itemCount || itemIds.length || 0),
    total: Number(total || 0),
    payerName: clean(payerName, 120),
    payerNames: (Array.isArray(payerNames) ? payerNames : []).map((x) => clean(x, 120)).filter(Boolean),
    docId: clean(docId, 100),
    runNo: clean(runNo, 100),
  };
  const stageKey = clean(stage || (wantedRole === "approver" ? "approval" : "review"), 40);
  const results = [];

  for (const recipient of recipients) {
    const dedupeKey = `${WORKFLOW_NOTIFY_PREFIX}${tenant}:${stageKey}:${summary.eventKey}:${recipient.lineUserId}`;
    if (await env.KV.get(dedupeKey)) {
      results.push({ userId: recipient.lineUserId, skipped: true, reason: "duplicate_notification" });
      continue;
    }
    const url = personalDashboardUrl(env, tenant, recipient.token);
    if (!url) { results.push({ userId: recipient.lineUserId, ok: false, reason: "dashboard_url_missing" }); continue; }
    const companyName = await resolvedCompanyName(env, tenant, recipient.companyName || recipient.businessName || "");
    await rememberCompanyOnAccess(env, tenant, recipient, companyName).catch(() => {});
    const accepted = await push(env, recipient.lineUserId, workflowTaskCard(
      recipient.name || recipient.lineDisplayName || (wantedRole === "approver" ? "ผู้อนุมัติ" : "ฝ่ายบัญชี"),
      wantedRole,
      summary,
      url,
      { ...recipient, companyName }
    )).catch(() => false);
    if (accepted) await env.KV.put(dedupeKey, "1", { expirationTtl: 86400 * 14 });
    results.push({ userId: recipient.lineUserId, name: recipient.name || "", accepted, ok: accepted });
  }

  return {
    ok: true,
    role: wantedRole,
    stage: stageKey,
    recipients: recipients.length,
    accepted: results.filter((r) => r.accepted).length,
    results,
  };
}

export async function notifyApproversForBatchOutput(env, tenant, output, { kind = "batch" } = {}) {
  if (!output?.ok) return { ok: true, skipped: true, reason: "batch_not_ok" };
  const summary = batchSummary(output, kind);
  if (!summary.itemCount && !summary.batchCount) return { ok: true, skipped: true, reason: "no_new_batch" };
  const batches = Array.isArray(output.batches) ? output.batches : [];
  const statuses = batches.map((b) => String(b.status || "")).filter(Boolean);
  const itemIds = [...new Set(batches.flatMap((b) => Array.isArray(b.itemIds) ? b.itemIds.map(String) : []))];
  const hasApproval = statuses.some((s) => s === "รออนุมัติค่าใช้จ่าย");
  const hasReview = statuses.some((s) => ["รอตรวจเอกสาร", "รออนุมัติ", "รวมรอบแล้ว"].includes(s));
  if (!hasApproval && !hasReview) return { ok:true, skipped:true, reason:"no_human_workflow_stage", count:0 };
  const role = hasApproval ? "approver" : "accountant";
  const stage = hasApproval ? "approval" : "review";
  return notifyWorkflowStage(env, tenant, {
    role,
    stage,
    eventKey: itemIds.length ? `items:${itemIds.sort().join("_")}` : summary.eventKey,
    itemIds,
    itemCount: summary.itemCount,
    total: summary.total,
    docId: summary.docId,
    runNo: summary.runNo,
    payerNames: [...new Set(batches.map((b) => b.payerName).filter(Boolean))],
  });
}

export { VERSION as LINE_APPROVER_NOTIFY_VERSION };
