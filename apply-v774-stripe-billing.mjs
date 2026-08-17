import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const indexFile = path.join(root, "src", "index.js");
const stripeFile = path.join(root, "src", "stripe-billing.js");
const MARK = "STRIPE_BILLING_V7_74_20260817";
if (!fs.existsSync(indexFile) || !fs.existsSync(stripeFile)) throw new Error("v7.74 missing Stripe source files");

let s = fs.readFileSync(indexFile, "utf8");

if (!s.includes('from "./stripe-billing.js"')) {
  const anchor = 'import { AI_DOCUMENT_LIMITS, getAiQuotaState, consumeAiDocument, readAiDocumentCache, writeAiDocumentCache, unwrapAiDocumentCache } from "./ai-quota.js";';
  if (!s.includes(anchor)) throw new Error("v7.74 import anchor missing");
  s = s.replace(anchor, `${anchor}\nimport { createStripeCheckoutSession, createStripePortalSession, handleStripeWebhook, stripeBillingHealth } from "./stripe-billing.js"; // ${MARK}`);
}

// Stripe live annual prices supplied by the merchant on 2026-08-17.
s = s.replace('starter:  { id: "starter",  name: "Lite",    monthly: 199,  annual: 1990,', 'starter:  { id: "starter",  name: "Lite",    monthly: 199,  annual: 2149,');
s = s.replace('pro:      { id: "pro",      name: "Pro",     monthly: 399,  annual: 3990,', 'pro:      { id: "pro",      name: "Pro",     monthly: 399,  annual: 4213,');
s = s.replace('business: { id: "business", name: "Business",monthly: 1290, annual: 12900,', 'business: { id: "business", name: "Business",monthly: 1290, annual: 13158,');

const oldUpgrade = `async function requestSubscriptionUpgrade(env, key, sheetId, token, body = {}) {\n  const plan = String(body.plan || "").trim().toLowerCase();\n  const cycle = body.cycle === "annual" ? "annual" : "monthly";\n  if (!SUBSCRIPTION_PLANS[plan]) return { ok: false, reason: "invalid_plan" };\n  await saveSubscriptionRecord(env, key, {\n    requestedPlan: plan,\n    requestedCycle: cycle,\n    upgradeRequestedAt: new Date().toISOString(),\n  });\n  return await getSubscriptionSnapshot(env, key, sheetId, token, { refreshUsage: true });\n}`;

const newUpgrade = `async function requestSubscriptionUpgrade(env, key, sheetId, token, body = {}) {\n  // ${MARK}: Trial selection is saved without charging. Paid checkout starts after Trial/Free.\n  const plan = String(body.plan || "").trim().toLowerCase();\n  const cycle = body.cycle === "annual" ? "annual" : "monthly";\n  if (!SUBSCRIPTION_PLANS[plan]) return { ok: false, reason: "invalid_plan" };\n\n  await saveSubscriptionRecord(env, key, {\n    requestedPlan: plan,\n    requestedCycle: cycle,\n    upgradeRequestedAt: new Date().toISOString(),\n  });\n  const snapshot = await getSubscriptionSnapshot(env, key, sheetId, token, { refreshUsage: true });\n\n  // During the internal 30-day Trial we only remember the selected package.\n  // No card is collected and no automatic charge happens.\n  if (snapshot.betaActive) return { ...snapshot, checkoutRequired: false, selectedForAfterTrial: true };\n\n  const rec = await getSubscriptionRecord(env, key);\n  const base = await dashUrl(env, key);\n  const returnUrl = new URL(base);\n  returnUrl.searchParams.set("page", "billing");\n\n  // Existing Stripe customers must manage changes/cancellation in Stripe Portal,\n  // preventing accidental duplicate subscriptions.\n  if (rec.status === "active" && rec.stripeCustomerId) {\n    try {\n      const portal = await createStripePortalSession(env, { customerId: rec.stripeCustomerId, returnUrl: returnUrl.toString() });\n      return { ...snapshot, portalUrl: portal.url, manageExistingSubscription: true };\n    } catch (e) {\n      return { ok: false, reason: String(e?.message || e) === "stripe_not_configured" ? "stripe_not_configured" : "stripe_portal_failed", detail: String(e?.message || e) };\n    }\n  }\n\n  if (plan === "free") return { ...snapshot, checkoutRequired: false };\n\n  const rootTenant = await getAccountRoot(env, key);\n  const success = new URL(base);\n  success.searchParams.set("page", "billing");\n  success.searchParams.set("stripe", "success");\n  success.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");\n  const cancel = new URL(base);\n  cancel.searchParams.set("page", "billing");\n  cancel.searchParams.set("stripe", "cancel");\n\n  try {\n    const checkout = await createStripeCheckoutSession(env, {\n      rootTenant, plan, cycle, successUrl: success.toString(), cancelUrl: cancel.toString(),\n    });\n    return { ...snapshot, checkoutRequired: true, checkoutUrl: checkout.url, checkoutSessionId: checkout.id };\n  } catch (e) {\n    return { ok: false, reason: String(e?.message || e) === "stripe_not_configured" ? "stripe_not_configured" : "stripe_checkout_failed", detail: String(e?.message || e) };\n  }\n}`;

if (!s.includes(MARK) || s.includes(oldUpgrade)) {
  if (s.includes(oldUpgrade)) s = s.replace(oldUpgrade, newUpgrade);
  else if (!s.includes("selectedForAfterTrial")) throw new Error("v7.74 upgrade function anchor missing");
}

const pilotAnchor = `    if (url.pathname === "/pilot/health" && request.method === "GET") {\n      return cors(json(pilotHealth()));\n    }`;
const stripePublic = `${pilotAnchor}\n\n    // ${MARK} — Stripe webhook must be public and must run before Dashboard auth.\n    if (url.pathname === "/stripe/webhook") {\n      return await handleStripeWebhook(request, env);\n    }\n    if (url.pathname === "/stripe/health" && request.method === "GET") {\n      return cors(json(stripeBillingHealth(env)));\n    }`;
if (!s.includes('url.pathname === "/stripe/webhook"')) {
  if (!s.includes(pilotAnchor)) throw new Error("v7.74 public route anchor missing");
  s = s.replace(pilotAnchor, stripePublic);
}

const requestRoute = `        if (url.pathname === "/api/subscription/request-upgrade" && request.method === "POST") {\n          const b = await request.json().catch(() => ({}));\n          const out = await requestSubscriptionUpgrade(env, key, sheetId, token, b);\n          return cors(json(out, out.ok ? 200 : 400));\n        }`;
const portalRoute = `${requestRoute}\n\n        if (url.pathname === "/api/subscription/portal" && request.method === "POST") {\n          const rec = await getSubscriptionRecord(env, key);\n          if (!rec.stripeCustomerId) return cors(json({ ok: false, reason: "stripe_customer_missing" }, 400));\n          const base = await dashUrl(env, key);\n          const returnUrl = new URL(base);\n          returnUrl.searchParams.set("page", "billing");\n          try {\n            const portal = await createStripePortalSession(env, { customerId: rec.stripeCustomerId, returnUrl: returnUrl.toString() });\n            return cors(json({ ok: true, portalUrl: portal.url }));\n          } catch (e) {\n            return cors(json({ ok: false, reason: "stripe_portal_failed", detail: String(e?.message || e) }, 400));\n          }\n        }`;
if (!s.includes('url.pathname === "/api/subscription/portal"')) {
  if (!s.includes(requestRoute)) throw new Error("v7.74 subscription route anchor missing");
  s = s.replace(requestRoute, portalRoute);
}

// Expose safe billing status only; never expose Stripe secrets.
if (!s.includes("stripePaymentStatus: rec.stripePaymentStatus")) {
  const anchor = `    upgradeRequestedAt: rec.upgradeRequestedAt || "",\n    catalog: SUBSCRIPTION_PLANS,`;
  const replacement = `    upgradeRequestedAt: rec.upgradeRequestedAt || "",\n    stripePaymentStatus: rec.stripePaymentStatus || "",\n    canManageBilling: Boolean(rec.stripeCustomerId),\n    catalog: SUBSCRIPTION_PLANS,`;
  if (!s.includes(anchor)) throw new Error("v7.74 snapshot anchor missing");
  s = s.replace(anchor, replacement);
}

fs.writeFileSync(indexFile, s);
execFileSync(process.execPath, ["--check", stripeFile], { stdio: "inherit" });
execFileSync(process.execPath, ["--check", indexFile], { stdio: "inherit" });

const final = fs.readFileSync(indexFile, "utf8");
for (const needle of [MARK, 'url.pathname === "/stripe/webhook"', 'url.pathname === "/api/subscription/portal"', 'annual: 2149', 'annual: 4213', 'annual: 13158']) {
  if (!final.includes(needle)) throw new Error(`v7.74 audit missing ${needle}`);
}
console.log(`✅ ${MARK} ready`);
console.log("✅ Stripe Checkout + webhook + Customer Portal wiring enabled");
console.log("✅ Trial still has no automatic charge; paid checkout starts after Trial/Free");
console.log("✅ Existing paid customers are sent to Customer Portal to avoid duplicate subscriptions");
