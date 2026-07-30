// src/ocr.js — v2.3 (Claude + guard สลิป)
// อ่านบิล/ใบเสร็จ/สลิปโอนเงิน ด้วย Claude แล้วคืนเป็น field
//
// เปลี่ยนจาก v2.2:
//   • prompt เข้มขึ้นเรื่องชื่อ: เบลอ/ถูกปิด (นาย x*** y) → ห้ามเดาเติม ปล่อยว่างดีกว่า
//   • GUARD สลิปโอนเงิน: ชื่อผู้รับในสลิปอ่านยากทุกใบ → กด confidence.vendor
//     เพดาน 0.5 เสมอ ให้การ์ดไฮไลต์ส้มบังคับคนเช็ค ไม่ปล่อยชื่อมั่วลงชีทเงียบ ๆ
//
// โมเดลเริ่มต้น = haiku-4-5 (ถูกสุด) จะขยับเป็น sonnet ตั้งที่ env.CLAUDE_MODEL

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
- Transfer slips: the DESTINATION account holder ("ผู้รับเงิน" / "บัญชีปลายทาง").
  NEVER the sender ("ผู้โอน" / "จาก"). This is the most common mistake — check carefully.
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

async function askClaude(env, imageBase64, mediaType) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.CLAUDE_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
            { type: "text", text: PROMPT },
          ],
        },
        { role: "assistant", content: "{" },   // prefill: บังคับให้ออกมาเป็น JSON
      ],
    }),
  });

  if (!res.ok) throw new Error("Claude OCR error: " + res.status + " " + (await res.text()));
  const json = await res.json();

  // log ไว้ดูต้นทุนจริงใน `wrangler tail`
  const u = json.usage || {};
  console.log(`[ocr] in=${u.input_tokens} out=${u.output_tokens} model=${json.model}`);

  return "{" + (json.content?.[0]?.text || "");
}

/** ทำความสะอาดวันที่ — เผื่อโมเดลยังคืน พ.ศ. มา */
function cleanDate(raw) {
  const today = () => new Date().toISOString().slice(0, 10);
  if (!raw) return today();

  const nums = String(raw).match(/\d+/g);
  if (!nums || nums.length < 3) return today();

  let y, m, d;
  if (nums[0].length === 4) [y, m, d] = nums.map(Number);
  else [d, m, y] = nums.map(Number);

  if (y > 2400) y -= 543;                        // พ.ศ. หลุดมา
  if (y < 100) y += y > 50 ? 1900 : 2000;

  const nowY = new Date().getFullYear();
  if (y < nowY - 5 || y > nowY + 1) return today();   // ปีเพี้ยนไปไกล = อ่านผิด

  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(m || 1)}-${p(d || 1)}`;
}

function clamp01(v, fallback = 0.8) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export async function ocrReceipt(env, imageBase64, mediaType = "image/jpeg") {
  let text = await askClaude(env, imageBase64, mediaType);
  let data = parseJson(text);

  if (!data) {
    console.warn("OCR: JSON เพี้ยน ลองใหม่");
    text = await askClaude(env, imageBase64, mediaType);
    data = parseJson(text);
  }
  if (!data) throw new Error("OCR returned non-JSON: " + text.slice(0, 300));

  const amount = Number(String(data.amount).replace(/[^0-9.]/g, "")) || 0;
  const vendor = (data.vendor || "").trim();
  const c = data.confidence || {};

  const docType = DOC_TYPES.includes(data.docType) ? data.docType : "";
  const isSlip = docType === "สลิปโอนเงิน";

  // ยอดเป็น 0 = อ่านไม่ออกแน่ ๆ บังคับให้ต่ำเพื่อให้การ์ดไฮไลต์
  const amountConf = amount > 0 ? clamp01(c.amount, 0.9) : 0.2;

  // ชื่อผู้รับในสลิปอ่านยากทุกใบ → กดเพดานไว้ 0.5 บังคับให้คนเช็คเสมอ
  let vendorConf = vendor ? clamp01(c.vendor, 0.8) : 0.2;
  if (isSlip && vendor) vendorConf = Math.min(vendorConf, 0.5);

  // flag ยาวเกินจะล้นการ์ด ตัดที่ 90
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

    // → card.js โชว์ในกล่องฟ้า 💡
    flag,

    // → card.js ใช้ตัวนี้ไฮไลต์ช่องสีส้ม (ต่ำกว่า 0.75 = แตะแก้ได้)
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
