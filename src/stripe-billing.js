// Stripe Billing integration for Rubjaai subscriptions.
// Price IDs are public. Secret keys must stay in Cloudflare secrets.

export const STRIPE_PRICE_CATALOG = Object.freeze({
  starter: Object.freeze({
    monthly: "price_1U5Q0I17BfeEP7oRt3ZXR3FK",
    annual: "price_1U5Q0217BfeEP7oRNoStsvfz",
  }),
  pro: Object.freeze({
    monthly: "price_1U5Q2p17BfeEP7oRzobRCQRt",
    annual: "price_1U5Q3B17BfeEP7oRiVYztUXk",
  }),
  business: Object.freeze({
    monthly: "price_1U5Q3e17BfeEP7oRDM9w8E2z",
    annual: "price_1U5Q3w17BfeEP7oRsh9Xe8JJ",
  }),
});

const PLAN_NAMES = Object.freeze({ starter: "Lite", pro: "Pro", business: "Business" });
const EVENT_TTL = 60 * 60 * 24 * 90;
const CHECKOUT_TTL = 60 * 60 * 24 * 2;
const SUB_MAP_TTL = 60 * 60 * 24 * 365 * 3;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function requireSecret(env) {
  const value = String(env.STRIPE_SECRET_KEY || "").trim();
  if (!value) throw new Error("stripe_not_configured");
  return value;
}

function priceEnvKey(plan, cycle) {
  return `STRIPE_PRICE_${String(plan).toUpperCase()}_${cycle === "annual" ? "ANNUAL" : "MONTHLY"}`;
}

export function stripePriceId(env, plan, cycle = "monthly") {
  const cleanPlan = String(plan || "").trim().toLowerCase();
  const cleanCycle = cycle === "annual" ? "annual" : "monthly";
  const override = String(env?.[priceEnvKey(cleanPlan, cleanCycle)] || "").trim();
  return override || STRIPE_PRICE_CATALOG[cleanPlan]?.[cleanCycle] || "";
}

export function planForStripePrice(env, priceId) {
  const id = String(priceId || "").trim();
  if (!id) return null;
  for (const plan of Object.keys(STRIPE_PRICE_CATALOG)) {
    for (const cycle of ["monthly", "annual"]) {
      if (stripePriceId(env, plan, cycle) === id) return { plan, cycle, priceId: id };
    }
  }
  return null;
}

async function stripeApi(env, pathname, { method = "GET", form = null } = {}) {
  const secret = requireSecret(env);
  const headers = { authorization: `Bearer ${secret}` };
  const init = { method, headers };
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = form instanceof URLSearchParams ? form.toString() : String(form);
  }
  const res = await fetch(`https://api.stripe.com/v1/${String(pathname).replace(/^\/+/, "")}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(String(data?.error?.message || data?.error?.code || `stripe_http_${res.status}`));
    err.code = String(data?.error?.code || "stripe_error");
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function createStripeCheckoutSession(env, {
  rootTenant,
  plan,
  cycle = "monthly",
  successUrl,
  cancelUrl,
} = {}) {
  const cleanPlan = String(plan || "").trim().toLowerCase();
  const cleanCycle = cycle === "annual" ? "annual" : "monthly";
  const priceId = stripePriceId(env, cleanPlan, cleanCycle);
  if (!priceId || !PLAN_NAMES[cleanPlan]) throw new Error("invalid_paid_plan");
  if (!rootTenant) throw new Error("missing_tenant");

  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("line_items[0][price]", priceId);
  form.set("line_items[0][quantity]", "1");
  form.set("success_url", String(successUrl || ""));
  form.set("cancel_url", String(cancelUrl || ""));
  form.set("client_reference_id", String(rootTenant));
  form.set("locale", "th");
  form.set("billing_address_collection", "auto");
  form.set("tax_id_collection[enabled]", "true");
  form.set("metadata[tenant]", String(rootTenant));
  form.set("metadata[plan]", cleanPlan);
  form.set("metadata[cycle]", cleanCycle);
  form.set("subscription_data[metadata][tenant]", String(rootTenant));
  form.set("subscription_data[metadata][plan]", cleanPlan);
  form.set("subscription_data[metadata][cycle]", cleanCycle);

  const session = await stripeApi(env, "checkout/sessions", { method: "POST", form });
  if (!session?.id || !session?.url) throw new Error("stripe_checkout_missing_url");
  await env.KV.put(`stripe:checkout:v1:${session.id}`, JSON.stringify({
    rootTenant: String(rootTenant), plan: cleanPlan, cycle: cleanCycle, priceId,
    createdAt: new Date().toISOString(),
  }), { expirationTtl: CHECKOUT_TTL });
  return { id: session.id, url: session.url, plan: cleanPlan, cycle: cleanCycle, priceId };
}

export async function createStripePortalSession(env, { customerId, returnUrl } = {}) {
  if (!customerId) throw new Error("stripe_customer_missing");
  const form = new URLSearchParams();
  form.set("customer", String(customerId));
  form.set("return_url", String(returnUrl || ""));
  const session = await stripeApi(env, "billing_portal/sessions", { method: "POST", form });
  if (!session?.url) throw new Error("stripe_portal_missing_url");
  return { url: session.url };
}

function subscriptionKey(tenant) { return `subscription:v1:${tenant}`; }
function subscriptionMapKey(id) { return `stripe:sub:v1:${id}`; }
function eventKey(id) { return `stripe:event:v1:${id}`; }

async function patchSubscriptionRecord(env, tenant, patch = {}) {
  if (!tenant) return null;
  const key = subscriptionKey(tenant);
  const current = (await env.KV.get(key, "json").catch(() => null)) || {};
  const next = { ...current, ...patch, schema: current.schema || "SUBSCRIPTION_V1_20260807", updatedAt: new Date().toISOString() };
  await env.KV.put(key, JSON.stringify(next));
  return next;
}

async function rememberSubscription(env, subscriptionId, tenant) {
  if (!subscriptionId || !tenant) return;
  await env.KV.put(subscriptionMapKey(subscriptionId), String(tenant), { expirationTtl: SUB_MAP_TTL });
}

function extractSubscriptionId(obj = {}) {
  const direct = typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id;
  if (direct) return direct;
  const parent = obj.parent?.subscription_details?.subscription;
  if (typeof parent === "string") return parent;
  if (parent?.id) return parent.id;
  return "";
}

function extractPriceId(obj = {}) {
  const items = obj.items?.data || obj.lines?.data || [];
  const first = Array.isArray(items) ? items[0] : null;
  return String(first?.price?.id || first?.pricing?.price_details?.price || first?.parent?.subscription_item_details?.price || "");
}

async function resolveSubscriptionContext(env, obj = {}) {
  let tenant = String(obj?.metadata?.tenant || obj?.client_reference_id || "").trim();
  let plan = String(obj?.metadata?.plan || "").trim().toLowerCase();
  let cycle = obj?.metadata?.cycle === "annual" ? "annual" : (obj?.metadata?.cycle ? "monthly" : "");
  const subscriptionId = extractSubscriptionId(obj) || (String(obj?.object || "") === "subscription" ? String(obj.id || "") : "");
  const customerId = typeof obj.customer === "string" ? obj.customer : String(obj.customer?.id || "");
  let priceId = extractPriceId(obj);

  if (!tenant && subscriptionId) tenant = String(await env.KV.get(subscriptionMapKey(subscriptionId)) || "").trim();
  if ((!tenant || !plan || !cycle || !priceId) && subscriptionId) {
    try {
      const sub = await stripeApi(env, `subscriptions/${encodeURIComponent(subscriptionId)}`);
      tenant ||= String(sub?.metadata?.tenant || "").trim();
      plan ||= String(sub?.metadata?.plan || "").trim().toLowerCase();
      cycle ||= sub?.metadata?.cycle === "annual" ? "annual" : (sub?.metadata?.cycle ? "monthly" : "");
      priceId ||= extractPriceId(sub);
    } catch (e) { console.warn("stripe subscription lookup", e?.message || e); }
  }
  const mapped = planForStripePrice(env, priceId);
  if (mapped) { plan = mapped.plan; cycle = mapped.cycle; }
  return { tenant, plan, cycle: cycle || "monthly", priceId, subscriptionId, customerId };
}

async function activatePaidPlan(env, context, extra = {}) {
  const { tenant, plan, cycle, priceId, subscriptionId, customerId } = context || {};
  if (!tenant || !PLAN_NAMES[plan]) return false;
  const now = new Date().toISOString();
  await patchSubscriptionRecord(env, tenant, {
    status: "active", plan, cycle: cycle === "annual" ? "annual" : "monthly",
    activatedAt: extra.activatedAt || now,
    requestedPlan: "", requestedCycle: "", upgradeRequestedAt: "",
    stripePriceId: priceId || "", stripeSubscriptionId: subscriptionId || "", stripeCustomerId: customerId || "",
    stripePaymentStatus: "paid", stripeLastPaidAt: extra.paidAt || now, stripeLastEventId: extra.eventId || "",
  });
  await rememberSubscription(env, subscriptionId, tenant);
  return true;
}

function hex(bytes) { return [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
function timingSafeTextEqual(a, b) {
  const x = String(a || ""), y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0; for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function verifyStripeSignature(secret, rawBody, header) {
  const parts = String(header || "").split(",").map((x) => x.trim()).filter(Boolean);
  const timestamp = Number(parts.find((x) => x.startsWith("t="))?.slice(2) || 0);
  const signatures = parts.filter((x) => x.startsWith("v1=")).map((x) => x.slice(3));
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = hex(digest);
  return signatures.some((sig) => timingSafeTextEqual(sig, expected));
}

async function handleCheckoutCompleted(env, event, session) {
  const saved = (await env.KV.get(`stripe:checkout:v1:${session.id}`, "json").catch(() => null)) || {};
  const context = {
    tenant: String(saved.rootTenant || session?.metadata?.tenant || session?.client_reference_id || "").trim(),
    plan: String(saved.plan || session?.metadata?.plan || "").trim().toLowerCase(),
    cycle: (saved.cycle || session?.metadata?.cycle) === "annual" ? "annual" : "monthly",
    priceId: String(saved.priceId || ""),
    subscriptionId: typeof session.subscription === "string" ? session.subscription : String(session.subscription?.id || ""),
    customerId: typeof session.customer === "string" ? session.customer : String(session.customer?.id || ""),
  };
  await rememberSubscription(env, context.subscriptionId, context.tenant);
  if (["paid", "no_payment_required"].includes(String(session.payment_status || ""))) return activatePaidPlan(env, context, { eventId: event.id });
  if (context.tenant) await patchSubscriptionRecord(env, context.tenant, {
    stripeSubscriptionId: context.subscriptionId, stripeCustomerId: context.customerId,
    stripePriceId: context.priceId, stripePaymentStatus: String(session.payment_status || "pending"), stripeLastEventId: event.id,
  });
  return true;
}

async function handleInvoicePaid(env, event, invoice) {
  const context = await resolveSubscriptionContext(env, invoice);
  const paidSec = Number(invoice?.status_transitions?.paid_at || 0);
  return activatePaidPlan(env, context, { eventId: event.id, paidAt: paidSec ? new Date(paidSec * 1000).toISOString() : new Date().toISOString() });
}

async function handleInvoiceFailed(env, event, invoice) {
  const context = await resolveSubscriptionContext(env, invoice);
  if (!context.tenant) return false;
  await patchSubscriptionRecord(env, context.tenant, {
    stripeSubscriptionId: context.subscriptionId || "", stripeCustomerId: context.customerId || "", stripePriceId: context.priceId || "",
    stripePaymentStatus: "past_due", stripeLastPaymentFailedAt: new Date().toISOString(), stripeLastEventId: event.id,
  });
  await rememberSubscription(env, context.subscriptionId, context.tenant);
  return true;
}

async function handleSubscriptionChanged(env, event, subscription, deleted = false) {
  const context = await resolveSubscriptionContext(env, subscription);
  if (!context.tenant) return false;
  const stripeStatus = String(subscription?.status || (deleted ? "canceled" : ""));
  if (!deleted && ["active", "trialing"].includes(stripeStatus) && PLAN_NAMES[context.plan]) return activatePaidPlan(env, context, { eventId: event.id });
  if (deleted || ["canceled", "unpaid", "incomplete_expired"].includes(stripeStatus)) {
    await patchSubscriptionRecord(env, context.tenant, {
      status: "free", plan: "free", cycle: "monthly",
      stripeSubscriptionId: context.subscriptionId || "", stripeCustomerId: context.customerId || "", stripePriceId: context.priceId || "",
      stripePaymentStatus: stripeStatus || "canceled", stripeEndedAt: new Date().toISOString(), stripeLastEventId: event.id,
    });
    return true;
  }
  await patchSubscriptionRecord(env, context.tenant, {
    stripeSubscriptionId: context.subscriptionId || "", stripeCustomerId: context.customerId || "", stripePriceId: context.priceId || "",
    stripePaymentStatus: stripeStatus || "pending", stripeLastEventId: event.id,
  });
  return true;
}

export async function handleStripeWebhook(request, env) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const webhookSecret = String(env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) return json({ ok: false, error: "stripe_webhook_not_configured" }, 503);
  const raw = await request.text();
  if (!(await verifyStripeSignature(webhookSecret, raw, request.headers.get("stripe-signature") || ""))) return json({ ok: false, error: "invalid_stripe_signature" }, 400);
  let event; try { event = JSON.parse(raw); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
  if (!event?.id || !event?.type) return json({ ok: false, error: "invalid_event" }, 400);
  if (await env.KV.get(eventKey(event.id))) return json({ ok: true, duplicate: true });
  const obj = event?.data?.object || {};
  try {
    if (event.type === "checkout.session.completed") await handleCheckoutCompleted(env, event, obj);
    else if (event.type === "invoice.paid") await handleInvoicePaid(env, event, obj);
    else if (event.type === "invoice.payment_failed") await handleInvoiceFailed(env, event, obj);
    else if (event.type === "customer.subscription.updated") await handleSubscriptionChanged(env, event, obj, false);
    else if (event.type === "customer.subscription.deleted") await handleSubscriptionChanged(env, event, obj, true);
    await env.KV.put(eventKey(event.id), "1", { expirationTtl: EVENT_TTL });
    return json({ ok: true, received: event.type });
  } catch (e) {
    console.error("stripe webhook", event.type, e?.message || e);
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}

export function stripeBillingHealth(env) {
  return {
    ok: true,
    secretConfigured: Boolean(String(env.STRIPE_SECRET_KEY || "").trim()),
    webhookConfigured: Boolean(String(env.STRIPE_WEBHOOK_SECRET || "").trim()),
    prices: {
      starter: { monthly: stripePriceId(env, "starter", "monthly"), annual: stripePriceId(env, "starter", "annual") },
      pro: { monthly: stripePriceId(env, "pro", "monthly"), annual: stripePriceId(env, "pro", "annual") },
      business: { monthly: stripePriceId(env, "business", "monthly"), annual: stripePriceId(env, "business", "annual") },
    },
  };
}
