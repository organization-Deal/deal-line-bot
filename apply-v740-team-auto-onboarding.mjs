import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const indexFile = path.join(root, "src/index.js");
const memberFile = path.join(root, "src/member-profile.js");
const multiFile = path.join(root, "src/multi-expense.js");
const MARK = "TEAM_AUTO_ONBOARDING_V7_40_20260814";

function mustFile(file){
  if(!fs.existsSync(file)) throw new Error(`ไม่พบ ${path.relative(root,file)}`);
}
function replaceOnce(text, from, to, label){
  if(text.includes(to)) return text;
  if(!text.includes(from)) throw new Error(`หา anchor ไม่เจอ: ${label}`);
  return text.replace(from,to);
}

[indexFile,memberFile,multiFile].forEach(mustFile);

// ---------- 1) member-profile: หลังลงทะเบียนสำเร็จ ส่งการ์ดส่วนตัวกลับไป LINE ----------
let member = fs.readFileSync(memberFile,"utf8");
member = replaceOnce(
  member,
  'import { readSettings, writeSettings } from "./sheets.js";',
  'import { readSettings, writeSettings } from "./sheets.js";\nimport { push } from "./line.js";',
  "member profile LINE push import"
);

const successAnchor = `function successPage(name) {
  return pageShell(\`<div class="card success"><div class="check">✓</div><h1>บันทึกข้อมูลแล้ว</h1><p>ข้อมูลผู้เบิกของ \${esc(name || "คุณ")} พร้อมใช้งานแล้ว<br>กลับไป LINE แล้วกด “บันทึกรายการต่อ” ได้เลย</p><button class="btn" onclick="window.close();setTimeout(()=>history.back(),250)">กลับไป LINE</button></div>\`, "บันทึกสำเร็จ");
}`;
const successReplacement = `function memberOnboardingDoneCard(hasPending = false) {
  return {
    type: "flex",
    altText: hasPending ? "ข้อมูลรับเงินพร้อมแล้ว · ดำเนินการเบิกต่อ" : "ลงทะเบียนข้อมูลรับเงินเรียบร้อยแล้ว",
    contents: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", paddingAll: "20px", spacing: "sm",
        contents: [
          { type:"text", text:"ลงทะเบียนสำเร็จ", size:"xs", weight:"bold", color:"#248A3D" },
          { type:"text", text:"ข้อมูลรับเงินพร้อมใช้งานแล้ว", size:"xl", weight:"bold", color:"#111111", wrap:true },
          { type:"text", text: hasPending ? "รายการที่ส่งไว้ยังอยู่ครบ กดด้านล่างเพื่อยืนยันเบิกต่อได้เลย" : "ครั้งต่อไปส่งบิลและตั้งเบิกได้ทันที ไม่ต้องกรอกบัญชีซ้ำ", size:"sm", color:"#6E6E73", wrap:true }
        ]
      },
      footer: {
        type:"box", layout:"vertical", paddingAll:"14px",
        contents: hasPending
          ? [{ type:"button", style:"primary", color:"#111111", action:{ type:"postback", label:"ดำเนินการเบิกต่อ", data:"act=multi_confirm" } }]
          : [{ type:"button", style:"secondary", action:{ type:"message", label:"ดูวิธีเบิก", text:"วิธีใช้งาน" } }]
      }
    }
  };
}

function successPage(name) {
  return pageShell(\`<div class="card success"><div class="check">✓</div><h1>บันทึกข้อมูลแล้ว</h1><p>ข้อมูลผู้เบิกของ \${esc(name || "คุณ")} พร้อมใช้งานแล้ว<br>กลับไป LINE ได้เลย ระบบส่งการ์ดดำเนินการต่อให้แล้ว</p><button class="btn" onclick="window.close();setTimeout(()=>history.back(),250)">กลับไป LINE</button></div>\`, "บันทึกสำเร็จ");
}`;
member = replaceOnce(member, successAnchor, successReplacement, "member onboarding success card");

const deleteAnchor = `  await env.KV.delete(\`member-onboard:\${sessionToken}\`);

  return new Response(successPage(profile.name), {`;
const deleteReplacement = `  if (session.lineUserId) {
    await push(env, session.lineUserId, memberOnboardingDoneCard(Boolean(session.pendingId)))
      .catch((e) => console.warn("member onboarding completion push", e?.message || e));
  }

  await env.KV.delete(\`member-onboard:\${sessionToken}\`);

  return new Response(successPage(profile.name), {`;
member = replaceOnce(member, deleteAnchor, deleteReplacement, "member onboarding completion push");

fs.writeFileSync(memberFile, member);

// ---------- 2) multi-expense: จำ pending session เพื่อกลับมาเบิกต่อหลังกรอกข้อมูล ----------
let multi = fs.readFileSync(multiFile,"utf8");
multi = replaceOnce(
  multi,
  'tenant: s.tenant, lineUserId: s.userId, displayName: s.displayName || "", pendingId: "",',
  'tenant: s.tenant, lineUserId: s.userId, displayName: s.displayName || "", pendingId: s.sid || "",',
  "multi pending onboarding session"
);
fs.writeFileSync(multiFile,multi);

// ---------- 3) index.js: auto team directory + invite cards + self registration ----------
let index = fs.readFileSync(indexFile,"utf8");

const helperAnchor = `async function createLineWorkspaceInvite(env, currentTenant) {`;
const helperBlock = `// ${MARK}
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
    altText:\`ลงทะเบียนข้อมูลรับเงิน · \${companyName}\`,
    contents:{
      type:"bubble",
      body:{type:"box",layout:"vertical",paddingAll:"20px",spacing:"sm",contents:[
        {type:"text",text:"เริ่มใช้งานครั้งแรก",size:"xs",weight:"bold",color:"#248A3D"},
        {type:"text",text:"ลงทะเบียนข้อมูลรับเงินก่อนเบิก",size:"xl",weight:"bold",color:"#111111",wrap:true},
        {type:"text",text:\`สำหรับ \${companyName} · กรอกครั้งเดียว แล้วส่งบิล/ตั้งเบิกได้เลย\`,size:"sm",color:"#6E6E73",wrap:true},
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
    altText:\`ตั้งค่าบัญชีรับเงิน · \${companyName}\`,
    contents:{
      type:"bubble",
      body:{type:"box",layout:"vertical",paddingAll:"20px",spacing:"sm",contents:[
        {type:"text",text:"ข้อมูลส่วนตัว",size:"xs",weight:"bold",color:"#248A3D"},
        {type:"text",text:"ตั้งค่าบัญชีรับเงินครั้งแรก",size:"xl",weight:"bold",color:"#111111",wrap:true},
        {type:"text",text:\`ใช้สำหรับ \${companyName} · กรอกครั้งเดียว ระบบจะจำข้อมูลให้ทุกครั้งที่เบิก\`,size:"sm",color:"#6E6E73",wrap:true},
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
    const sheetId = String((await env.KV.get(\`tenant:\${tenant}\`)) || env.DEFAULT_SHEET_ID || "").trim();
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
  const sheetId = String((await env.KV.get(\`tenant:\${businessTenant}\`)) || env.DEFAULT_SHEET_ID || "").trim();
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
    const groupSheetId = String((await env.KV.get(\`tenant:\${groupTenant}\`)) || sheetId || "").trim();
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
    version:"${MARK}",
  };
}

${helperAnchor}`;
index = replaceOnce(index, helperAnchor, helperBlock, "v740 helper functions");

// หลังเชื่อมกลุ่มสำเร็จ ส่งการ์ดเชิญลงทะเบียนในกลุ่มทันที
const linkAnchor = `  await listLineWorkspacesForAccount(env, businessTenant, { refresh:true }).catch((e) =>
    console.warn("refresh LINE workspace after link", rawTenant, e?.message || e)
  );

  return {`;
const linkReplacement = `  await listLineWorkspacesForAccount(env, businessTenant, { refresh:true }).catch((e) =>
    console.warn("refresh LINE workspace after link", rawTenant, e?.message || e)
  );

  // ${MARK}: หลังเชื่อมกลุ่มสำเร็จ เชิญทุกคนลงทะเบียนแบบ self-service
  await push(env, rawTenant, memberRegistrationGroupCardV740(String(invite.companyName || "บริษัทนี้")))
    .catch((e) => console.warn("team onboarding invite after LINE link", rawTenant, e?.message || e));

  return {`;
index = replaceOnce(index, linkAnchor, linkReplacement, "group link onboarding invite");

// event: ผู้ใช้กดลงทะเบียน/พิมพ์คำสั่ง
const eventAnchor = `      const isConfirm = postbackAct === "confirm" || postbackAct === "confirm_force" || postbackAct === "multi_confirm";

      if (isImage) {`;
const eventReplacement = `      const isConfirm = postbackAct === "confirm" || postbackAct === "confirm_force" || postbackAct === "multi_confirm";

      // ${MARK}: สมาชิกกดจากการ์ดในกลุ่ม หรือพิมพ์คำสั่งเอง
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

      if (isImage) {`;
index = replaceOnce(index, eventAnchor, eventReplacement, "member registration event");

// API endpoints before /api/line-members
const apiAnchor = `        if (url.pathname === "/api/line-members") {`;
const apiBlock = `        // ${MARK}: ทีมจาก LINE + การเชิญลงทะเบียน
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

${apiAnchor}`;
index = replaceOnce(index, apiAnchor, apiBlock, "team directory APIs");

fs.writeFileSync(indexFile,index);

// Syntax checks
for (const file of [indexFile,memberFile,multiFile]) {
  execFileSync(process.execPath, ["--check", file], { stdio:"inherit" });
}
console.log(`✅ ${MARK} ready`);
