import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const stripeFile = path.join(root, "src", "stripe-billing.js");
const indexFile = path.join(root, "src", "index.js");
const adminFile = path.join(root, "src", "admin-ops.js");
const MARK = "BILLING_LIFECYCLE_ADMIN_V7_77_20260818";

for (const file of [stripeFile, indexFile, adminFile]) {
  if (!fs.existsSync(file)) throw new Error(`v7.77 missing ${file}`);
}

// ─────────────────────────────────────────────────────────────
// Stripe lifecycle: renewal date + billing event ledger
// Stripe 2025-03-31+ moved current_period_end to subscription items.
// ─────────────────────────────────────────────────────────────
let stripe = fs.readFileSync(stripeFile, "utf8");

if (!stripe.includes("const BILLING_EVENT_TTL")) {
  const anchor = 'const SUB_MAP_TTL = 60 * 60 * 24 * 365 * 3;';
  if (!stripe.includes(anchor)) throw new Error("v7.77 stripe TTL anchor missing");
  stripe = stripe.replace(anchor, `${anchor}
const BILLING_EVENT_TTL = 60 * 60 * 24 * 365 * 3; // ${MARK}`);
}

if (!stripe.includes("function billingEventKey")) {
  const anchor = 'function eventKey(id) { return `stripe:event:v1:${id}`; }';
  if (!stripe.includes(anchor)) throw new Error("v7.77 stripe key anchor missing");
  const helpers = `${anchor}

function billingEventKey(id) { return \`stripe:billing:event:v1:\${id}\`; }

function unixIso(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : "";
}

function subscriptionItemPeriodEnd(subscription = {}) {
  const items = Array.isArray(subscription?.items?.data) ? subscription.items.data : [];
  const ends = items.map((item) => Number(item?.current_period_end || 0)).filter((n) => Number.isFinite(n) && n > 0);
  return ends.length ? unixIso(Math.min(...ends)) : "";
}

async function loadSubscriptionPeriodEnd(env, subscriptionId, supplied = null) {
  const fromSupplied = subscriptionItemPeriodEnd(supplied || {});
  if (fromSupplied) return fromSupplied;
  if (!subscriptionId) return "";
  try {
    const subscription = await stripeApi(env, \`subscriptions/\${encodeURIComponent(subscriptionId)}\`);
    return subscriptionItemPeriodEnd(subscription);
  } catch (e) {
    console.warn("stripe period lookup", e?.message || e);
    return "";
  }
}

async function recordBillingEvent(env, event, data = {}) {
  if (!event?.id) return;
  const createdAt = unixIso(event.created) || new Date().toISOString();
  const record = {
    schema: "STRIPE_BILLING_EVENT_V1",
    eventId: String(event.id),
    eventType: String(event.type || ""),
    kind: String(data.kind || ""),
    tenant: String(data.tenant || ""),
    plan: String(data.plan || ""),
    cycle: data.cycle === "annual" ? "annual" : "monthly",
    customerId: String(data.customerId || ""),
    subscriptionId: String(data.subscriptionId || ""),
    invoiceId: String(data.invoiceId || ""),
    amountMinor: Number(data.amountMinor || 0),
    currency: String(data.currency || "thb").toLowerCase(),
    paymentStatus: String(data.paymentStatus || ""),
    paidAt: String(data.paidAt || ""),
    currentPeriodEnd: String(data.currentPeriodEnd || ""),
    createdAt,
  };
  await env.KV.put(billingEventKey(event.id), JSON.stringify(record), { expirationTtl: BILLING_EVENT_TTL });
}`;
  stripe = stripe.replace(anchor, helpers);
}

const oldActivateStripeLines = `    stripePriceId: priceId || "", stripeSubscriptionId: subscriptionId || "", stripeCustomerId: customerId || "",
    stripePaymentStatus: "paid", stripeLastPaidAt: extra.paidAt || now, stripeLastEventId: extra.eventId || "",`;
const newActivateStripeLines = `    stripePriceId: priceId || "", stripeSubscriptionId: subscriptionId || "", stripeCustomerId: customerId || "",
    stripePaymentStatus: "paid", stripeLastPaidAt: extra.paidAt || now, stripeLastEventId: extra.eventId || "",
    stripeCurrentPeriodEnd: extra.currentPeriodEnd || "",
    stripeCancelAtPeriodEnd: extra.cancelAtPeriodEnd === true,
    stripeLatestInvoiceId: extra.invoiceId || "",`;
if (!stripe.includes("stripeCurrentPeriodEnd: extra.currentPeriodEnd")) {
  if (!stripe.includes(oldActivateStripeLines)) throw new Error("v7.77 activatePaidPlan anchor missing");
  stripe = stripe.replace(oldActivateStripeLines, newActivateStripeLines);
}

const oldCheckoutActivate = `  await rememberSubscription(env, context.subscriptionId, context.tenant);
  if (["paid", "no_payment_required"].includes(String(session.payment_status || ""))) return activatePaidPlan(env, context, { eventId: event.id });`;
const newCheckoutActivate = `  await rememberSubscription(env, context.subscriptionId, context.tenant);
  const currentPeriodEnd = await loadSubscriptionPeriodEnd(env, context.subscriptionId);
  if (["paid", "no_payment_required"].includes(String(session.payment_status || ""))) {
    return activatePaidPlan(env, context, { eventId: event.id, currentPeriodEnd });
  }`;
if (!stripe.includes("const currentPeriodEnd = await loadSubscriptionPeriodEnd(env, context.subscriptionId);")) {
  if (!stripe.includes(oldCheckoutActivate)) throw new Error("v7.77 checkout period anchor missing");
  stripe = stripe.replace(oldCheckoutActivate, newCheckoutActivate);
}

const oldInvoicePaid = `async function handleInvoicePaid(env, event, invoice) {
  const context = await resolveSubscriptionContext(env, invoice);
  const paidSec = Number(invoice?.status_transitions?.paid_at || 0);
  return activatePaidPlan(env, context, { eventId: event.id, paidAt: paidSec ? new Date(paidSec * 1000).toISOString() : new Date().toISOString() });
}`;
const newInvoicePaid = `async function handleInvoicePaid(env, event, invoice) {
  const context = await resolveSubscriptionContext(env, invoice);
  const paidSec = Number(invoice?.status_transitions?.paid_at || 0);
  const paidAt = paidSec ? new Date(paidSec * 1000).toISOString() : new Date().toISOString();
  const currentPeriodEnd = await loadSubscriptionPeriodEnd(env, context.subscriptionId);
  const activated = await activatePaidPlan(env, context, {
    eventId: event.id,
    paidAt,
    currentPeriodEnd,
    invoiceId: String(invoice?.id || ""),
  });
  await recordBillingEvent(env, event, {
    kind: "payment_succeeded",
    ...context,
    invoiceId: String(invoice?.id || ""),
    amountMinor: Number(invoice?.amount_paid || 0),
    currency: String(invoice?.currency || "thb"),
    paymentStatus: "paid",
    paidAt,
    currentPeriodEnd,
  });
  return activated;
}`;
if (!stripe.includes('kind: "payment_succeeded"')) {
  if (!stripe.includes(oldInvoicePaid)) throw new Error("v7.77 invoice paid anchor missing");
  stripe = stripe.replace(oldInvoicePaid, newInvoicePaid);
}

const oldFailedTail = `  await rememberSubscription(env, context.subscriptionId, context.tenant);
  return true;
}

async function handleSubscriptionChanged`;
const newFailedTail = `  await rememberSubscription(env, context.subscriptionId, context.tenant);
  await recordBillingEvent(env, event, {
    kind: "payment_failed",
    ...context,
    invoiceId: String(invoice?.id || ""),
    amountMinor: Number(invoice?.amount_due || 0),
    currency: String(invoice?.currency || "thb"),
    paymentStatus: "past_due",
  });
  return true;
}

async function handleSubscriptionChanged`;
if (!stripe.includes('kind: "payment_failed"')) {
  if (!stripe.includes(oldFailedTail)) throw new Error("v7.77 invoice failed anchor missing");
  stripe = stripe.replace(oldFailedTail, newFailedTail);
}

const oldSubStatus = `  const stripeStatus = String(subscription?.status || (deleted ? "canceled" : ""));
  if (!deleted && ["active", "trialing"].includes(stripeStatus) && PLAN_NAMES[context.plan]) return activatePaidPlan(env, context, { eventId: event.id });`;
const newSubStatus = `  const stripeStatus = String(subscription?.status || (deleted ? "canceled" : ""));
  const currentPeriodEnd = await loadSubscriptionPeriodEnd(env, context.subscriptionId, subscription);
  const cancelAtPeriodEnd = subscription?.cancel_at_period_end === true;
  if (!deleted && ["active", "trialing"].includes(stripeStatus) && PLAN_NAMES[context.plan]) {
    return activatePaidPlan(env, context, { eventId: event.id, currentPeriodEnd, cancelAtPeriodEnd });
  }`;
if (!stripe.includes("const cancelAtPeriodEnd = subscription?.cancel_at_period_end === true;")) {
  if (!stripe.includes(oldSubStatus)) throw new Error("v7.77 subscription status anchor missing");
  stripe = stripe.replace(oldSubStatus, newSubStatus);
}

const oldCancelReturn = `      stripePaymentStatus: stripeStatus || "canceled", stripeEndedAt: new Date().toISOString(), stripeLastEventId: event.id,
    });
    return true;`;
const newCancelReturn = `      stripePaymentStatus: stripeStatus || "canceled", stripeEndedAt: new Date().toISOString(), stripeLastEventId: event.id,
      stripeCurrentPeriodEnd: currentPeriodEnd || "",
      stripeCancelAtPeriodEnd: cancelAtPeriodEnd,
    });
    await recordBillingEvent(env, event, {
      kind: "subscription_ended",
      ...context,
      paymentStatus: stripeStatus || "canceled",
      currentPeriodEnd,
    });
    return true;`;
if (!stripe.includes('kind: "subscription_ended"')) {
  if (!stripe.includes(oldCancelReturn)) throw new Error("v7.77 subscription cancel anchor missing");
  stripe = stripe.replace(oldCancelReturn, newCancelReturn);
}

const oldPendingPatch = `    stripePaymentStatus: stripeStatus || "pending", stripeLastEventId: event.id,
  });`;
const newPendingPatch = `    stripePaymentStatus: stripeStatus || "pending", stripeLastEventId: event.id,
    stripeCurrentPeriodEnd: currentPeriodEnd || "",
    stripeCancelAtPeriodEnd: cancelAtPeriodEnd,
  });`;
if (stripe.includes(oldPendingPatch)) {
  stripe = stripe.replace(oldPendingPatch, newPendingPatch);
} else if (!stripe.includes('stripePaymentStatus: stripeStatus || "pending", stripeLastEventId: event.id,\n    stripeCurrentPeriodEnd: currentPeriodEnd || ""')) {
  throw new Error("v7.77 pending subscription anchor missing");
}

fs.writeFileSync(stripeFile, stripe);
execFileSync(process.execPath, ["--check", stripeFile], { stdio: "inherit" });

// ─────────────────────────────────────────────────────────────
// Customer subscription snapshot: expose renewal & safe billing state
// ─────────────────────────────────────────────────────────────
let index = fs.readFileSync(indexFile, "utf8");
const snapshotAnchor = `    stripePaymentStatus: rec.stripePaymentStatus || "",
    canManageBilling: Boolean(rec.stripeCustomerId),
    catalog: SUBSCRIPTION_PLANS,`;
const snapshotReplacement = `    stripePaymentStatus: rec.stripePaymentStatus || "",
    stripeCurrentPeriodEnd: rec.stripeCurrentPeriodEnd || "",
    nextRenewalAt: rec.stripeCurrentPeriodEnd || "",
    stripeCancelAtPeriodEnd: rec.stripeCancelAtPeriodEnd === true,
    canManageBilling: Boolean(rec.stripeCustomerId),
    catalog: SUBSCRIPTION_PLANS,`;
if (!index.includes("nextRenewalAt: rec.stripeCurrentPeriodEnd")) {
  if (!index.includes(snapshotAnchor)) throw new Error("v7.77 subscription snapshot anchor missing");
  index = index.replace(snapshotAnchor, snapshotReplacement);
}
fs.writeFileSync(indexFile, index);
execFileSync(process.execPath, ["--check", indexFile], { stdio: "inherit" });

// ─────────────────────────────────────────────────────────────
// Owner Admin Billing API
// ─────────────────────────────────────────────────────────────
let admin = fs.readFileSync(adminFile, "utf8");

admin = admin
  .replace('starter:  { id: "starter",  name: "Lite",    monthly: 199,  annual: 1990,', 'starter:  { id: "starter",  name: "Lite",    monthly: 199,  annual: 2149,')
  .replace('pro:      { id: "pro",      name: "Pro",     monthly: 399,  annual: 3990,', 'pro:      { id: "pro",      name: "Pro",     monthly: 399,  annual: 4213,')
  .replace('business: { id: "business", name: "Business",monthly: 1290, annual: 12900,', 'business: { id: "business", name: "Business",monthly: 1290, annual: 13158,');

if (!admin.includes('reasons.push("ชำระเงินมีปัญหา")')) {
  const anchor = `  if (subscription.betaActive && subscription.daysRemaining <= 7) { if (attention === "ok") attention = "warning"; reasons.push(\`Trial เหลือ \${subscription.daysRemaining} วัน\`); }`;
  if (!admin.includes(anchor)) throw new Error("v7.77 admin attention anchor missing");
  admin = admin.replace(anchor, `${anchor}
  if (["past_due","unpaid","incomplete"].includes(String(subscription.stripePaymentStatus || ""))) {
    if (attention === "ok") attention = "warning";
    reasons.push("ชำระเงินมีปัญหา");
  }`);
}

if (!admin.includes("async function billingOverview")) {
  const anchor = "async function overview(env) {";
  if (!admin.includes(anchor)) throw new Error("v7.77 admin overview anchor missing");
  const billingFns = `async function listBillingEvents(env, limit = 120) {
  const keys = await listAllKeys(env, "stripe:billing:event:v1:", 5000);
  const rows = await mapLimit(keys, 12, async (key) => await kvJson(env, key.name, null));
  return rows.filter(Boolean)
    .sort((a,b) => String(b.paidAt || b.createdAt || "").localeCompare(String(a.paidAt || a.createdAt || "")))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 120)));
}

function monthlyRecurringValue(subscription = {}) {
  if (subscription.status !== "active") return 0;
  const cycle = subscription.cycle === "annual" ? "annual" : "monthly";
  const monthly = Number(subscription.priceMonthly || 0);
  const annual = Number(subscription.priceAnnual || 0);
  return cycle === "annual" ? annual / 12 : monthly;
}

async function billingOverview(env) {
  const customers = await listCustomers(env, { deep: false, refresh: false });
  const events = await listBillingEvents(env, 200);
  const active = customers.filter((row) => row.subscription.status === "active");
  const mrr = active.reduce((sum,row) => sum + monthlyRecurringValue(row.subscription), 0);
  const currentMonth = monthKey();
  const paidEvents = events.filter((row) => row.kind === "payment_succeeded");
  const revenueThisMonth = paidEvents
    .filter((row) => row.currency === "thb" && monthKey(row.paidAt || row.createdAt) === currentMonth)
    .reduce((sum,row) => sum + Number(row.amountMinor || 0) / 100, 0);
  const plans = { starter: 0, pro: 0, business: 0 };
  for (const row of active) {
    const plan = row.subscription.effectivePlan || row.subscription.plan;
    if (plans[plan] !== undefined) plans[plan] += 1;
  }
  const pastDue = customers.filter((row) => ["past_due","unpaid","incomplete"].includes(String(row.subscription.stripePaymentStatus || ""))).length;
  const canceled = customers.filter((row) => ["canceled","incomplete_expired"].includes(String(row.subscription.stripePaymentStatus || ""))).length;
  return {
    ok: true,
    generatedAt: nowIso(),
    metrics: {
      customers: customers.length,
      active: active.length,
      trial: customers.filter((row) => row.subscription.betaActive).length,
      free: customers.filter((row) => row.subscription.status === "free").length,
      pastDue,
      canceled,
      mrr: Math.round(mrr * 100) / 100,
      arr: Math.round(mrr * 12 * 100) / 100,
      revenueThisMonth: Math.round(revenueThisMonth * 100) / 100,
      plans,
    },
    rows: customers,
    recentPayments: events.slice(0, 100),
  };
}

${anchor}`;
  admin = admin.replace(anchor, billingFns);
}

if (!admin.includes('path === "/admin/ops/billing"')) {
  const anchor = `    if (request.method === "GET" && path === "/admin/ops/overview") return json(await overview(env), 200, env);`;
  if (!admin.includes(anchor)) throw new Error("v7.77 admin route anchor missing");
  admin = admin.replace(anchor, `${anchor}
    if (request.method === "GET" && path === "/admin/ops/billing") return json(await billingOverview(env), 200, env);`);
}

if (!admin.includes(MARK)) admin += `\n\n// ${MARK}\n`;
fs.writeFileSync(adminFile, admin);
execFileSync(process.execPath, ["--check", adminFile], { stdio: "inherit" });

for (const [name, text, needles] of [
  ["stripe", stripe, ["stripeCurrentPeriodEnd", 'kind: "payment_succeeded"', "subscriptionItemPeriodEnd"]],
  ["index", index, ["nextRenewalAt"]],
  ["admin", admin, ['path === "/admin/ops/billing"', "revenueThisMonth", "annual: 13158"]],
]) {
  for (const needle of needles) if (!text.includes(needle)) throw new Error(`v7.77 ${name} audit missing ${needle}`);
}

console.log(`✅ ${MARK} ready`);
console.log("✅ Renewal date stored from Stripe subscription item current_period_end");
console.log("✅ Billing payment/failure/cancel events stored in KV");
console.log("✅ Owner billing API /admin/ops/billing enabled");
console.log("✅ Admin annual prices synced: 2,149 / 4,213 / 13,158 THB");
