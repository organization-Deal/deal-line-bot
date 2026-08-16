import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root=process.cwd();
const indexFile=path.join(root,"src","index.js");
const multiFile=path.join(root,"src","multi-expense.js");
const MARK="MULTI_IMAGE_NO_SILENT_LOSS_V7_70_20260816";

if(!fs.existsSync(indexFile))throw new Error("ไม่พบ src/index.js");
if(!fs.existsSync(multiFile))throw new Error("ไม่พบ src/multi-expense.js");

let index=fs.readFileSync(indexFile,"utf8");
let multi=fs.readFileSync(multiFile,"utf8");

if(multi.includes(MARK)){
  console.log("✅ "+MARK+" already applied");
  process.exit(0);
}

/* 1) Pass LINE message id into the Durable Object BEFORE OCR starts. */
const touchAnchor=`          touched = await touchMultiSession(env, {
            tenant: key,
            userId,
            targetId: lineTarget(event.source),`;

if(!index.includes(touchAnchor))throw new Error("v7.70: touchMultiSession anchor changed");

index=index.replace(
  touchAnchor,
  `          touched = await touchMultiSession(env, {
            tenant: key,
            userId,
            targetId: lineTarget(event.source),
            lineMessageId: event.message?.id || "",`
);

/* 2) Session must remember pending LINE images separately from processed OCR items. */
const sessionAnchor=`    receivedCount: 0,
    inflight: 0,
    failedCount: 0,
    lastTouchAt: "",
    lastSummarySeq: 0,`;

if(!multi.includes(sessionAnchor))throw new Error("v7.70: emptySession counters changed");

multi=multi.replace(
  sessionAnchor,
  `    receivedCount: 0,
    inflight: 0,
    failedCount: 0,
    pendingImages: {},
    processingFailures: [],
    lastTouchAt: "",
    lastSummarySeq: 0,
    lastFailureSummaryCount: 0,`
);

/* 3) /touch: dedupe LINE webhook retries and store each image as pending. */
const touchCounters=`      s.receivedCount = Number(s.receivedCount || 0) + 1;
      s.inflight = Number(s.inflight || 0) + 1;
      s.lastTouchAt = nowIso();`;

if(!multi.includes(touchCounters))throw new Error("v7.70: /touch counter block changed");

multi=multi.replace(
  touchCounters,
  `      // ${MARK}
      s.pendingImages = s.pendingImages && typeof s.pendingImages === "object" ? s.pendingImages : {};
      s.processingFailures = Array.isArray(s.processingFailures) ? s.processingFailures : [];
      const lineMessageId = String(b.lineMessageId || "").trim();
      const pendingId = lineMessageId || \`legacy_\${Date.now()}_\${uid()}\`;
      const alreadyProcessed = Object.values(s.items || {}).some((x) =>
        lineMessageId && String(x?.lineMessageId || "") === lineMessageId
      );
      const alreadyPending = !!s.pendingImages[pendingId];

      if (!alreadyProcessed && !alreadyPending) {
        s.receivedCount = Number(s.receivedCount || 0) + 1;
        s.pendingImages[pendingId] = {
          lineMessageId: pendingId,
          touchedAt: nowIso(),
        };
      }

      s.inflight = Object.keys(s.pendingImages).length;
      s.lastTouchAt = nowIso();`
);

/* 4) /image: remove pending marker, and recover a previous timeout if the image completes late. */
const imageCounters=`      s.items[item.id] = item;
      s.inflight = Math.max(0, Number(s.inflight || 0) - 1);
      if (item.ocrFailed) s.failedCount = Number(s.failedCount || 0) + 1;`;

if(!multi.includes(imageCounters))throw new Error("v7.70: /image counter block changed");

multi=multi.replace(
  imageCounters,
  `      s.pendingImages = s.pendingImages && typeof s.pendingImages === "object" ? s.pendingImages : {};
      s.processingFailures = Array.isArray(s.processingFailures) ? s.processingFailures : [];

      const lineMessageId = String(item.lineMessageId || "").trim();
      if (lineMessageId && s.pendingImages[lineMessageId]) {
        delete s.pendingImages[lineMessageId];
      } else if (!lineMessageId) {
        const oldestPending = Object.keys(s.pendingImages)[0];
        if (oldestPending) delete s.pendingImages[oldestPending];
      }

      // If this image finished after the 15s timeout, remove its temporary hard-failure state.
      if (lineMessageId) {
        s.processingFailures = s.processingFailures.filter(
          (x) => String(x?.lineMessageId || "") !== lineMessageId
        );
      }

      s.items[item.id] = item;
      s.inflight = Object.keys(s.pendingImages).length;
      if (item.ocrFailed) s.failedCount = Number(s.failedCount || 0) + 1;`
);

/* 5) Public state exposes what LINE received vs what actually finished processing. */
const publicCounts=`    counts: {
      images: items.filter((x) => !x.ignored).length,
      groups: groups.length,
      ready: groups.filter((g) => g.ready).length,
      warnings: groups.filter((g) => g.warning).length,
      unassigned: unassigned.length,
      inflight: Number(s.inflight || 0),
      failed: Number(s.failedCount || 0),
    },`;

if(!multi.includes(publicCounts))throw new Error("v7.70: publicState counts changed");

multi=multi.replace(
  publicCounts,
  `    counts: {
      images: items.filter((x) => !x.ignored).length,
      received: Math.max(
        Number(s.receivedCount || 0),
        items.length + Object.keys(s.pendingImages || {}).length + (Array.isArray(s.processingFailures) ? s.processingFailures.length : 0)
      ),
      groups: groups.length,
      ready: groups.filter((g) => g.ready).length,
      warnings: groups.filter((g) => g.warning).length,
      unassigned: unassigned.length,
      inflight: Number(s.inflight || 0),
      failed: items.filter((x) => x.ocrFailed).length + (Array.isArray(s.processingFailures) ? s.processingFailures.length : 0),
      processingFailed: Array.isArray(s.processingFailures) ? s.processingFailures.length : 0,
    },`
);

/* 6) Summary card: a missing image becomes visible instead of disappearing. */
const needsAnchor=`  const needs = v.counts.unassigned + v.counts.warnings;
  const total = v.groups.reduce((sum, g) => sum + Number(g.amount || 0), 0);`;

if(!multi.includes(needsAnchor))throw new Error("v7.70: summary needs block changed");

multi=multi.replace(
  needsAnchor,
  `  const needs = v.counts.unassigned + v.counts.warnings + v.counts.processingFailed;
  const imageSummaryText = v.counts.received > v.counts.images
    ? \`\${v.counts.groups} รายการ · รับ \${v.counts.received} รูป · อ่านแล้ว \${v.counts.images}\`
    : \`\${v.counts.groups} รายการ · \${v.counts.images} เอกสาร\`;
  const total = v.groups.reduce((sum, g) => sum + Number(g.amount || 0), 0);`
);

const cardImageText=`            { type: "text", text: \`\${v.counts.groups} รายการ · \${v.counts.images} เอกสาร\`, size: "xs", color: "#6E6E73", margin: "xs" },`;

if(!multi.includes(cardImageText))throw new Error("v7.70: summary image count text changed");

multi=multi.replace(
  cardImageText,
  `            { type: "text", text: imageSummaryText, size: "xs", color: "#6E6E73", margin: "xs" },`
);

const vatAnchor=`  if (vatTotal > 0.005) {`;
if(!multi.includes(vatAnchor))throw new Error("v7.70: VAT summary anchor changed");

multi=multi.replace(
  vatAnchor,
  `  if (v.counts.processingFailed > 0) {
    rows.push({
      type: "box",
      layout: "vertical",
      margin: "lg",
      backgroundColor: "#FFF1F0",
      cornerRadius: "14px",
      paddingAll: "12px",
      contents: [{
        type: "text",
        text: \`⚠️ รับรูปมา \${v.counts.received} รูป แต่อ่านสำเร็จ \${v.counts.images} รูป · มี \${v.counts.processingFailed} รูปประมวลผลไม่สำเร็จ กรุณาส่งรูปที่หายไปใหม่ก่อนยืนยัน\`,
        size: "xs",
        color: "#B42318",
        weight: "bold",
        wrap: true,
      }],
    });
  }

  if (vatTotal > 0.005) {`
);

/* 7) Commit refuses to silently save an incomplete incoming image set. */
const commitAnchor=`    refreshAll(s);
    const view = publicState(s);
    if (!s.groups.length) return json({ error: "ยังไม่มีรายการให้บันทึก" }, 400);`;

if(!multi.includes(commitAnchor))throw new Error("v7.70: commit start changed");

multi=multi.replace(
  commitAnchor,
  `    refreshAll(s);
    const view = publicState(s);
    if (view.counts.processingFailed > 0) {
      return json({
        error: \`มี \${view.counts.processingFailed} รูปที่ระบบรับแล้วแต่ประมวลผลไม่สำเร็จ กรุณาส่งรูปที่หายไปใหม่ก่อนยืนยัน\`,
        code: "image_processing_failed",
        received: view.counts.received,
        processed: view.counts.images,
        failed: view.counts.processingFailed,
      }, 409);
    }
    if (!s.groups.length) return json({ error: "ยังไม่มีรายการให้บันทึก" }, 400);`
);

/* 8) Alarm converts expired pending message ids into explicit hard failures. */
const alarmBlock=`    if (Number(s.inflight || 0) > 0) {
      const age = Date.now() - Date.parse(s.lastTouchAt || s.updatedAt || 0);
      if (age < 15000) {
        await this.ctx.storage.setAlarm(Date.now() + 3500);
        return;
      }
      // งาน OCR บางภาพล้ม/หมดเวลา: ไม่ให้ทั้งชุดค้างตลอด
      s.failedCount = Number(s.failedCount || 0) + Number(s.inflight || 0);
      s.inflight = 0;
      await this.save(s);
    }
    if (s.seq === s.lastSummarySeq || !Object.keys(s.items).length) return;
    await this.pushSummary(s);`;

if(!multi.includes(alarmBlock))throw new Error("v7.70: alarm block changed");

multi=multi.replace(
  alarmBlock,
  `    s.pendingImages = s.pendingImages && typeof s.pendingImages === "object" ? s.pendingImages : {};
    s.processingFailures = Array.isArray(s.processingFailures) ? s.processingFailures : [];

    const pendingEntries = Object.entries(s.pendingImages);
    if (pendingEntries.length) {
      const now = Date.now();
      const expired = pendingEntries.filter(([, meta]) =>
        now - Date.parse(meta?.touchedAt || s.lastTouchAt || s.updatedAt || 0) >= 15000
      );

      if (!expired.length) {
        await this.ctx.storage.setAlarm(Date.now() + 3500);
        return;
      }

      for (const [pendingId, meta] of expired) {
        delete s.pendingImages[pendingId];
        if (!s.processingFailures.some((x) => String(x?.lineMessageId || "") === pendingId)) {
          s.processingFailures.push({
            lineMessageId: pendingId,
            failedAt: nowIso(),
            reason: "processing_timeout",
          });
        }
      }

      s.failedCount = Number(s.failedCount || 0) + expired.length;
      s.inflight = Object.keys(s.pendingImages).length;
      await this.save(s);

      if (s.inflight > 0) {
        await this.ctx.storage.setAlarm(Date.now() + 3500);
      }
    } else if (Number(s.inflight || 0) > 0) {
      // Compatibility for a session created before v7.70.
      const age = Date.now() - Date.parse(s.lastTouchAt || s.updatedAt || 0);
      if (age < 15000) {
        await this.ctx.storage.setAlarm(Date.now() + 3500);
        return;
      }
      const lost = Number(s.inflight || 0);
      for (let i = 0; i < lost; i++) {
        s.processingFailures.push({
          lineMessageId: \`legacy_timeout_\${Date.now()}_\${i}\`,
          failedAt: nowIso(),
          reason: "processing_timeout",
        });
      }
      s.failedCount = Number(s.failedCount || 0) + lost;
      s.inflight = 0;
      await this.save(s);
    }

    const processingFailed = s.processingFailures.length;
    const itemChanged = s.seq !== s.lastSummarySeq;
    const failureChanged = processingFailed !== Number(s.lastFailureSummaryCount || 0);
    if (!itemChanged && !failureChanged) return;
    if (!Object.keys(s.items).length && processingFailed === 0) return;
    await this.pushSummary(s);`
);

/* 9) Remember which failure count has already been shown. */
const summarySaved=`      s.lastSummarySeq = s.seq;
      await this.save(s);`;

if(!multi.includes(summarySaved))throw new Error("v7.70: pushSummary save block changed");

multi=multi.replace(
  summarySaved,
  `      s.lastSummarySeq = s.seq;
      s.lastFailureSummaryCount = Number(publicState(s).counts.processingFailed || 0);
      await this.save(s);`
);

/* 10) Review page also shows and blocks a hard missing image. */
const reviewNeeds=`  const needs=Number(D.counts.warnings||0)+Number(D.counts.unassigned||0);`;
if(!multi.includes(reviewNeeds))throw new Error("v7.70: review needs changed");

multi=multi.replace(
  reviewNeeds,
  `  const processingFailed=Number(D.counts.processingFailed||0);
  const needs=Number(D.counts.warnings||0)+Number(D.counts.unassigned||0)+processingFailed;`
);

const reviewCount=`  q('#sumCount').textContent=D.counts.groups+' รายการ · '+(D.counts.unassigned?'ยังไม่จัด '+D.counts.unassigned+' รูป':'จัดรูปครบแล้ว');`;
if(!multi.includes(reviewCount))throw new Error("v7.70: review sumCount changed");

multi=multi.replace(
  reviewCount,
  `  q('#sumCount').textContent=D.counts.groups+' รายการ · '+(processingFailed
    ?('รับ '+Number(D.counts.received||0)+' รูป · อ่านแล้ว '+Number(D.counts.images||0)+' · ล้มเหลว '+processingFailed)
    :(D.counts.unassigned?'ยังไม่จัด '+D.counts.unassigned+' รูป':'จัดรูปครบแล้ว'));`
);

const reviewImage=`  q('#imagePill').textContent=Number(D.counts.images||0)+' เอกสาร';`;
if(!multi.includes(reviewImage))throw new Error("v7.70: review image pill changed");

multi=multi.replace(
  reviewImage,
  `  q('#imagePill').textContent=processingFailed
    ?('รับ '+Number(D.counts.received||0)+' · อ่าน '+Number(D.counts.images||0))
    :(Number(D.counts.images||0)+' เอกสาร');`
);

const reviewStatus=`  q('#topStatus').textContent=needs?'มี '+needs+' จุดที่ต้องตรวจ':'พร้อมบันทึก';`;
if(!multi.includes(reviewStatus))throw new Error("v7.70: review topStatus changed");

multi=multi.replace(
  reviewStatus,
  `  q('#topStatus').textContent=processingFailed
    ?('มี '+processingFailed+' รูปที่ต้องส่งใหม่')
    :(needs?'มี '+needs+' จุดที่ต้องตรวจ':'พร้อมบันทึก');`
);

const reviewDisable=`  q('#saveBtn').disabled=D.status==='saving'||D.status==='saving_docs'||!D.counts.groups;`;
if(!multi.includes(reviewDisable))throw new Error("v7.70: review save disable changed");

multi=multi.replace(
  reviewDisable,
  `  q('#saveBtn').disabled=D.status==='saving'||D.status==='saving_docs'||!D.counts.groups||processingFailed>0;`
);

fs.writeFileSync(indexFile,index);
fs.writeFileSync(multiFile,multi);

execFileSync(process.execPath,["--check",indexFile],{stdio:"inherit"});
execFileSync(process.execPath,["--check",multiFile],{stdio:"inherit"});

const out=fs.readFileSync(multiFile,"utf8");
for(const [ok,label] of [
  [out.includes(MARK),"marker"],
  [out.includes("pendingImages"),"pending image tracking"],
  [out.includes("processingFailures"),"hard failure tracking"],
  [out.includes("image_processing_failed"),"commit guard"],
  [out.includes("รับรูปมา"),"LINE failure warning"],
  [out.includes("lastFailureSummaryCount"),"failure summary dedupe"],
]){
  if(!ok)throw new Error("v7.70 assertion failed: "+label);
}

console.log("✅ "+MARK+" ready");
console.log("✅ every LINE image is tracked by messageId before OCR starts");
console.log("✅ webhook retries do not inflate the received-image count");
console.log("✅ image processing timeout is visible instead of silently disappearing");
console.log("✅ summary shows received / processed / failed image counts");
console.log("✅ incomplete image sets cannot be confirmed silently");
console.log("✅ late image completion clears its temporary timeout failure");
console.log("✅ review page disables Save until missing images are resent");
