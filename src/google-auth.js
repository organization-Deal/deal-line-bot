// Mints a Google OAuth access token from a service account, using Web Crypto (RS256).
// No external libraries — runs inside a Cloudflare Worker.

let _cache = { token: null, exp: 0 };

function b64url(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlFromString(str) {
  return b64url(new TextEncoder().encode(str));
}

function pemToArrayBuffer(pem) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// Returns a cached access token, refreshing when it's within 60s of expiry.
export async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_cache.token && _cache.exp - 60 > now) return _cache.token;

  const email = env.GOOGLE_SA_EMAIL;
  // Private key stored as a secret; newlines may be escaped as \n.
  const pem = (env.GOOGLE_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const scope = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive";

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const signingInput = b64urlFromString(JSON.stringify(header)) + "." + b64urlFromString(JSON.stringify(claim));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const jwt = signingInput + "." + b64url(sig);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error("Google token error: " + res.status + " " + (await res.text()));
  const json = await res.json();
  _cache = { token: json.access_token, exp: now + (json.expires_in || 3600) };
  return _cache.token;
}
