// Entry wrapper: keeps the existing Worker untouched and enhances every HTML page.
import worker from "./index.js";
import { enhanceMobileWebResponse } from "./mobile-web-ux.js";

export { MultiExpenseSession } from "./index.js";

const VERSION = "DEAL_LINE_BOT_v6.0_DASHBOARD_MEMORY_20260809";

async function wrappedFetch(request, env, ctx) {
  const url = new URL(request.url);
  const response = await worker.fetch(request, env, ctx);

  // Keep the normal health-check response, but expose the wrapper version for deploy verification.
  if (request.method === "GET" && url.pathname === "/") {
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/json")) {
      const base = await response.json().catch(() => ({}));
      return new Response(JSON.stringify({
        ...base,
        version: VERSION,
        baseVersion: base.version || "",
        mobileWebUx: true,
      }, null, 2), {
        status: response.status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
  }

  // The enhancer is a no-op for JSON, images, redirects, and other non-HTML responses.
  return enhanceMobileWebResponse(response, { liffId: env.LIFF_ID || "" });
}

export default {
  ...worker,
  fetch: wrappedFetch,
};
