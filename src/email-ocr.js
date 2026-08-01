// OCR / classification for receipt, invoice and tax-invoice documents received by email.

import { CATEGORIES } from "./ocr.js";

const DOC_TYPES = [
  "ใบเสร็จรับเงิน",
  "ใบกำกับภาษี",
  "ใบเสร็จ/ใบกำกับภาษี",
  "ใบแจ้งหนี้",
  "ใบลดหนี้",
  "ใบเพิ่มหนี้",
  "หลักฐานการชำระเงิน",
  "ไม่ใช่เอกสารบัญชี",
];

const PROMPT = `You are an expert Thai corporate bookkeeper. Analyze the attached email document or email text.
Return ONLY one JSON object, no markdown.

Fields:
- isAccountingDocument: boolean
- docType: one of ${JSON.stringify(DOC_TYPES)}
- vendor: issuer / seller / service provider name
- taxId: seller tax ID if visible
- invoiceNo: document or invoice number
- date: document date in YYYY-MM-DD
- dueDate: due date in YYYY-MM-DD or ""
- servicePeriod: service/billing period in concise Thai or ""
- subtotal: amount before VAT, number
- vatAmount: VAT amount, number
- vatRate: percent number
- amount: grand total, number
- currency: THB, USD, EUR etc.
- category: one of ${JSON.stringify(CATEGORIES)}
- note: concise Thai description of purchase/service
- isSubscription: true if recurring software/service/subscription/hosting/API/monthly plan
- subscriptionName: product/plan name or ""
- flag: short Thai warning for human review or ""
- confidence: 0.0-1.0 overall confidence

Rules:
- Do not invent missing values.
- If it is only marketing/newsletter and not an invoice/receipt/tax document, set isAccountingDocument false and docType "ไม่ใช่เอกสารบัญชี".
- For foreign SaaS invoices, keep currency and total exactly as shown.
- If Thai VAT is shown, extract subtotal/VAT/total separately.
- All explanatory strings must be Thai.`;

function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function cleanDate(raw) {
  if (!raw) return "";
  const nums = String(raw).match(/\d+/g);
  if (!nums || nums.length < 3) return "";
  let y, m, d;
  if (nums[0].length === 4) [y, m, d] = nums.map(Number);
  else [d, m, y] = nums.map(Number);
  if (y > 2400) y -= 543;
  if (y < 100) y += 2000;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return "";
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function num(v) {
  return Number(String(v ?? "").replace(/[^0-9.-]/g, "")) || 0;
}

export async function analyzeEmailDocument(env, input = {}) {
  if (!env.GEMINI_KEY) throw new Error("GEMINI_KEY ยังไม่ได้ตั้ง");
  const model = env.GEMINI_MODEL || "gemini-flash-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`;

  const context = [
    input.sender ? `ผู้ส่งอีเมล: ${input.sender}` : "",
    input.subject ? `หัวข้อ: ${input.subject}` : "",
    input.filename ? `ชื่อไฟล์: ${input.filename}` : "",
    input.bodyText ? `ข้อความอีเมล:\n${String(input.bodyText).slice(0, 12000)}` : "",
  ].filter(Boolean).join("\n");

  const parts = [];
  if (input.base64 && input.mediaType) {
    parts.push({ inline_data: { mime_type: input.mediaType, data: input.base64 } });
  }
  parts.push({ text: `${PROMPT}\n\nบริบทอีเมล:\n${context}` });

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0, maxOutputTokens: 1300, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini email OCR ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const d = parseJson(text);
  if (!d) throw new Error("Gemini email OCR returned invalid JSON");

  const docType = DOC_TYPES.includes(d.docType) ? d.docType : (d.isAccountingDocument ? "ใบแจ้งหนี้" : "ไม่ใช่เอกสารบัญชี");
  return {
    isAccountingDocument: d.isAccountingDocument !== false && docType !== "ไม่ใช่เอกสารบัญชี",
    docType,
    vendor: String(d.vendor || "").trim(),
    taxId: String(d.taxId || "").trim(),
    invoiceNo: String(d.invoiceNo || "").trim(),
    date: cleanDate(d.date),
    dueDate: cleanDate(d.dueDate),
    servicePeriod: String(d.servicePeriod || "").trim(),
    subtotal: num(d.subtotal),
    vatAmount: num(d.vatAmount),
    vatRate: num(d.vatRate),
    amount: num(d.amount),
    currency: String(d.currency || "THB").trim().toUpperCase(),
    category: CATEGORIES.includes(d.category) ? d.category : "อื่น ๆ",
    note: String(d.note || input.subject || "").trim().slice(0, 220),
    isSubscription: d.isSubscription === true,
    subscriptionName: String(d.subscriptionName || "").trim(),
    flag: String(d.flag || "").trim().slice(0, 180),
    confidence: Math.max(0, Math.min(1, Number(d.confidence) || 0.5)),
  };
}
