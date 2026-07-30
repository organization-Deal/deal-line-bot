// src/ocr.js — v3.0 (Gemini)
// อ่านบิล/ใบเสร็จ/สลิปโอนเงิน แล้วคืนเป็น field เหมือน v2.x เป๊ะ
//
// เครื่องยนต์ OCR = Gemini 2.0 Flash (ถูกสุด + อ่านไทยแม่นพอ ๆ กับ Sonnet)
//   • อ่าน key จาก env.GEMINI_KEY (ต้องเป็น key ของ project ที่เปิด billing/มีโควตา)
//   • โมเดลตั้งทับได้ที่ env.GEMINI_MODEL (ดีฟอลต์ gemini-2.0-flash)
//   • responseMimeType บังคับ JSON ล้วน + temperature 0 ให้ผลนิ่ง
//   • GUARD สลิปโอนเงิน: กด confidence.vendor เพดาน 0.5 ไฮไลต์ส้มบังคับคนเช็ค
//   • prompt เข้มเรื่องชื่อ: เบลอ/ถูกปิด → ห้ามเดาเติม ปล่อยว่างดีกว่า

const CATEGORIES = [
  "อาหาร & รับรอง",
  "เดินทาง & ขนส่ง",
  "ค่าน้ำ ค่าไฟ ค่าเน็ต",
  "วัสดุ & อุปกรณ์สำนักงาน",
  "การตลาด & โฆษณา",
  "ค่าบริการ & จ้างงาน",
  "อื่น ๆ",
];

const DOC_TYPES = [
  "ใบกำกับภาษี",
  "ใบเสร็จรับเงิน",
  "สลิปโอนเงิน",
  "บิลเงินสด",
  "ใบแจ้งหนี้",
  "อื่น ๆ",
];

const PROMPT = `You are an accountant who has processed thousands of Thai financial documents.
Extract data from this image as JSON only.

## AMOUNT — most important
- Take the FINAL total actually paid.
- Receipts/tax invoices: use "รวมทั้งสิ้น" / "ยอดสุทธิ" / "จำนวนเงินรวม" (after VAT).
- NEVER take: pre-VAT subtotal, per-item price, "เงินสดรับ" (cash tendered), "เงินทอน" (change), "ส่วนลด" (discount).
- Transfer slips: use "จำนวนเงิน". Not "ยอดคงเหลือ" (balance), exclude fees.
- Digits only, no commas or symbols.

## VENDOR
- Receipts: the shop/company that issued it (usually at the top).
- Transfer slips: the DESTINATION account holder — the person the money went TO,
  labelled "ไปยัง" / "ผู้รับเงิน" / "บัญชีปลายทาง".
  NEVER the sender, labelled "จาก" / "ผู้โอน". The sender is the person who paid;
  the vendor is who they paid. Getting this backwards is the most common mistake.
- PromptPay with only a phone number: use the display name shown next to it, else "".
- Copy Thai names EXACTLY, character by character, only what you can clearly see.
- If any part of the name is blurry, masked (e.g. "นาย x*** y"), or you are not
  certain of a character, DO NOT invent or complete it. Return only the readable part,
  or "" if unreadable, and score vendor confidence low. A guessed name is worse than a blank.

## DATE
- Return YYYY-MM-DD in the Gregorian calendar (ค.ศ.).
- Thai documents usually print the Buddhist year (2568, 2569). Subtract 543.
  Example: 24/07/2569 → 2026-07-24
- Two-digit years like 68/69 are also Buddhist → 2568/2569 → subtract 543.
- Thai date order is DAY/MONTH/YEAR, never MONTH/DAY/YEAR.
- If genuinely absent, return "".

## CATEGORY — read the whole photo, not only the document
If the photo shows surroundings beyond the paper, use them:
  cinema seats / dark room with a bright screen → likely personal, not a business expense
  restaurant table, food, menu                 → อาหาร & รับรอง
  fuel pump, car dashboard, taxi meter         → เดินทาง & ขนส่ง
  office desk, stationery, printer             → วัสดุ & อุปกรณ์สำนักงาน
A clean screenshot with no surroundings gives no signal — judge from the text only.

## FIELDS
- amount   : number
- vendor   : string (keep Thai text as printed)
- date     : "YYYY-MM-DD" Gregorian
- category : pick exactly one from ${JSON.stringify(CATEGORIES)}
- docType  : pick exactly one from ${JSON.stringify(DOC_TYPES)}
- type     : "รายจ่าย" (expense) or "รายรับ" (income — money received, or a receipt we issued to a customer)
- note     : short Thai summary of what was paid for, max 60 chars, don't repeat the amount
- vat      : true if VAT/ภาษีมูลค่าเพิ่ม appears as a separate line, or a 13-digit tax ID is present
- vatRate  : percent number (usually 7). If vat is false, use 0
- whtRate  : withholding tax percent if stated on the document, else 0
- flag     : ONE short Thai sentence (max 70 chars) warning the bookkeeper, or "" if nothing is odd.
             Raise it only for something a human should actually look at:
               • the photo suggests a personal purchase, not a business one
               • the image is a photo of a screen showing an older slip (possible re-submission)
               • the document is partly cut off, blurry, or a key figure is unreadable
               • the amount looks unusually large for this kind of vendor
             Do NOT flag ordinary expenses. Most receipts should return "".
- confidence : object scoring 0.0–1.0 per field
    { "amount":?, "vendor":?, "date":?, "category":?, "note":? }

## CONFIDENCE — be honest, this drives human review
- 1.0 = crisp and unambiguous, no chance of error
- 0.8 = readable but slightly blurry, or a plausible alternative exists
- 0.5 = inferred from context, not directly visible
- 0.3 = guessed, or image blurry/cropped/skewed
- Thai personal names are easy to misread — if any character is uncertain, score vendor at 0.6 or below.
- category and note are interpretations — rarely 1.0, normally 0.6–0.9
- When unsure, score LOW. A low score highlights the field in orange for the
  user to tap and correct, which is far better than a confident wrong value.

Respond with a single JSON object. No other text. No code fences.
Note: all string VALUES stay in Thai.`;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

async function askGemini(env, imageBase64, mediaType) {
  if (!env.GEMINI_KEY) throw new Error("GEMINI_KEY ยังไม่ได้ตั้ง (npx wrangler secret put GEMINI_KEY)");

  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: mediaType, data: imageBase64 } },
            { text: PROMPT },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,               // ผลนิ่ง ไม่เดาต่างกันทุกครั้ง
        maxOutputTokens: 1000,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    // 429 = โควตาหมด/ key อยู่ผิด project ที่ไม่มีโควตา
    if (res.status === 429) {
      throw new Error("Gemini 429 — โควตาหมดหรือ key อยู่ผิด project (ต้องเป็น project ที่เปิด billing). " + body.slice(0, 200));
    }
    throw new Error("Gemini OCR error: " + res.status + " " + body.slice(0, 300));
  }
  const json = await res.json();

  const u = json.usageMetadata || {};
  console.log(`[ocr] in=${u.promptTokenCount} out=${u.candidatesTokenCount} model=${model}`);

  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini: empty response " + JSON.stringify(json).slice(0, 300));
  return text;
}

function cleanDate(raw) {
  const today = () => new Date().toISOString().slice(0, 10);
  if (!raw) return today();

  const nums = String(raw).match(/\d+/g);
  if (!nums || nums.length < 3) return today();

  let y, m, d;
  if (nums[0].length === 4) [y, m, d] = nums.map(Number);
  else [d, m, y] = nums.map(Number);

  if (y > 2400) y -= 543;
  if (y < 100) y += y > 50 ? 1900 : 2000;

  const nowY = new Date().getFullYear();
  if (y < nowY - 5 || y > nowY + 1) return today();

  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(m || 1)}-${p(d || 1)}`;
}

function clamp01(v, fallback = 0.8) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export async function ocrReceipt(env, imageBase64, mediaType = "image/jpeg") {
  let text = await askGemini(env, imageBase64, mediaType);
  let data = parseJson(text);

  if (!data) {
    console.warn("OCR: JSON เพี้ยน ลองใหม่");
    text = await askGemini(env, imageBase64, mediaType);
    data = parseJson(text);
  }
  if (!data) throw new Error("OCR returned non-JSON: " + text.slice(0, 300));

  const amount = Number(String(data.amount).replace(/[^0-9.]/g, "")) || 0;
  const vendor = (data.vendor || "").trim();
  const c = data.confidence || {};

  const docType = DOC_TYPES.includes(data.docType) ? data.docType : "";
  const isSlip = docType === "สลิปโอนเงิน";

  const amountConf = amount > 0 ? clamp01(c.amount, 0.9) : 0.2;

  let vendorConf = vendor ? clamp01(c.vendor, 0.8) : 0.2;
  if (isSlip && vendor) vendorConf = Math.min(vendorConf, 0.5);

  const flag = String(data.flag || "").trim().slice(0, 90);

  return {
    amount,
    vendor,
    date:     cleanDate(data.date),
    category: CATEGORIES.includes(data.category) ? data.category : "อื่น ๆ",
    note:     (data.note || "").trim(),

    docType,
    type:     data.type === "รายรับ" ? "รายรับ" : "รายจ่าย",
    vat:      data.vat === true,
    vatRate:  Number(data.vatRate) || 0,
    whtRate:  Number(data.whtRate) || 0,

    flag,

    confidence: {
      amount:   amountConf,
      vendor:   vendorConf,
      date:     data.date ? clamp01(c.date, 0.8) : 0.3,
      category: clamp01(c.category, 0.7),
      note:     clamp01(c.note, 0.7),
    },
  };
}

export { CATEGORIES, DOC_TYPES };
