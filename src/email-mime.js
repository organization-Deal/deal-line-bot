// Minimal MIME parser for Cloudflare Email Workers.
// Handles nested multipart messages, base64 / quoted-printable, UTF-8 headers,
// text/plain, text/html and PDF/image attachments.

function splitHeaderBody(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  if (!m) return [raw, ""];
  const i = m.index;
  return [raw.slice(0, i), raw.slice(i + m[0].length)];
}

function unfoldHeaders(text) {
  return text.replace(/\r?\n[ \t]+/g, " ");
}

function decodeMimeWord(value = "") {
  return String(value).replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, enc, data) => {
    try {
      let bytes;
      if (enc.toUpperCase() === "B") {
        const bin = atob(data.replace(/\s/g, ""));
        bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      } else {
        const q = data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        bytes = Uint8Array.from(q, c => c.charCodeAt(0));
      }
      const cs = /tis-620|windows-874/i.test(charset) ? "windows-874" : /iso-8859-1/i.test(charset) ? "windows-1252" : "utf-8";
      return new TextDecoder(cs).decode(bytes);
    } catch {
      return data;
    }
  });
}

function parseHeaders(text) {
  const out = {};
  for (const line of unfoldHeaders(text).split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = decodeMimeWord(line.slice(i + 1).trim());
    out[k] = out[k] ? `${out[k]}, ${v}` : v;
  }
  return out;
}

function parseHeaderValue(value = "") {
  const parts = String(value).split(";");
  const type = (parts.shift() || "").trim().toLowerCase();
  const params = {};
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i < 0) continue;
    const k = p.slice(0, i).trim().toLowerCase();
    let v = p.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
    params[k] = decodeMimeWord(v);
  }
  // RFC 2231 filename*=utf-8''...
  for (const k of Object.keys(params)) {
    if (!k.endsWith("*")) continue;
    const plain = k.slice(0, -1);
    const v = params[k];
    const m = v.match(/^[^']*'[^']*'(.*)$/);
    try { params[plain] = decodeURIComponent(m ? m[1] : v); } catch { params[plain] = m ? m[1] : v; }
  }
  return { type, params };
}

function base64Bytes(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(clean);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function qpBytes(text) {
  const soft = String(text).replace(/=\r?\n/g, "");
  const arr = [];
  for (let i = 0; i < soft.length; i++) {
    if (soft[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      arr.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      arr.push(soft.charCodeAt(i) & 255);
    }
  }
  return new Uint8Array(arr);
}

function decodePartBody(body, transferEncoding) {
  const enc = String(transferEncoding || "").toLowerCase();
  if (enc === "base64") return base64Bytes(body);
  if (enc === "quoted-printable") return qpBytes(body);
  return new TextEncoder().encode(body);
}

function decodeText(bytes, charset = "utf-8") {
  try {
    const cs = /tis-620|windows-874/i.test(charset) ? "windows-874" : /iso-8859-1/i.test(charset) ? "windows-1252" : "utf-8";
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function splitMultipart(body, boundary) {
  if (!boundary) return [];
  const mark = `--${boundary}`;
  const out = [];
  for (const chunk of body.split(mark).slice(1)) {
    if (chunk.startsWith("--")) break;
    const clean = chunk.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    if (clean.trim()) out.push(clean);
  }
  return out;
}

function stripHtml(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function parseEmail(rawInput) {
  let raw;
  if (typeof rawInput === "string") raw = rawInput;
  else {
    const buf = rawInput instanceof ArrayBuffer ? rawInput : await new Response(rawInput).arrayBuffer();
    raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }

  const [topHeaderText, topBody] = splitHeaderBody(raw);
  const topHeaders = parseHeaders(topHeaderText);
  const result = {
    subject: topHeaders.subject || "",
    messageId: topHeaders["message-id"] || "",
    date: topHeaders.date || "",
    from: topHeaders.from || "",
    to: topHeaders.to || "",
    text: "",
    html: "",
    attachments: [],
    headers: topHeaders,
  };

  function walk(partRaw, inherited = {}) {
    const [headerText, body] = splitHeaderBody(partRaw);
    const headers = Object.keys(parseHeaders(headerText)).length ? parseHeaders(headerText) : inherited;
    const ct = parseHeaderValue(headers["content-type"] || "text/plain; charset=utf-8");
    const disp = parseHeaderValue(headers["content-disposition"] || "");

    if (ct.type.startsWith("multipart/")) {
      for (const child of splitMultipart(body, ct.params.boundary)) walk(child, {});
      return;
    }

    const bytes = decodePartBody(body, headers["content-transfer-encoding"]);
    const filename = disp.params.filename || ct.params.name || "";
    const isAttachment = !!filename || disp.type === "attachment" || (!ct.type.startsWith("text/") && ct.type !== "message/rfc822");

    if (isAttachment) {
      result.attachments.push({
        filename: filename || `attachment-${result.attachments.length + 1}`,
        mimeType: ct.type || "application/octet-stream",
        content: bytes,
        contentId: (headers["content-id"] || "").replace(/[<>]/g, ""),
        disposition: disp.type || "attachment",
      });
      return;
    }

    const text = decodeText(bytes, ct.params.charset || "utf-8");
    if (ct.type === "text/html") result.html += (result.html ? "\n" : "") + text;
    else if (ct.type.startsWith("text/")) result.text += (result.text ? "\n" : "") + text;
  }

  const topCt = parseHeaderValue(topHeaders["content-type"] || "text/plain; charset=utf-8");
  if (topCt.type.startsWith("multipart/")) {
    for (const child of splitMultipart(topBody, topCt.params.boundary)) walk(child, {});
  } else {
    walk(raw, topHeaders);
  }

  if (!result.text && result.html) result.text = stripHtml(result.html);
  result.text = result.text.trim();
  return result;
}

export function bytesToBase64(bytes) {
  let out = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    out += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(out);
}
