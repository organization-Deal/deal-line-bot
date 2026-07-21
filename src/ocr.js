// Reads a bill/slip image with Claude and returns structured fields.
// Uses the JSON-prefill trick to force clean JSON output.

const CATEGORIES = [
  "อาหาร & รับรอง",
  "เดินทาง & ขนส่ง",
  "ค่าน้ำ ค่าไฟ ค่าเน็ต",
  "วัสดุ & อุปกรณ์สำนักงาน",
  "การตลาด & โฆษณา",
  "ค่าบริการ & จ้างงาน",
  "อื่น ๆ",
];

const PROMPT = `คุณเป็นผู้ช่วยบัญชี อ่านรูปบิล/ใบเสร็จ/สลิปโอนเงินนี้ แล้วดึงข้อมูลออกมาเป็น JSON เท่านั้น
ฟิลด์:
- amount: ยอดเงินที่จ่าย (ตัวเลขล้วน ไม่มีคอมม่า ไม่มีสัญลักษณ์)
- vendor: ชื่อร้าน/ผู้รับเงิน (ถ้าไม่มีให้ใส่ "")
- date: วันที่ในรูปแบบ YYYY-MM-DD (ถ้าไม่เจอให้ใส่ "")
- category: เลือก 1 หมวดจาก ${JSON.stringify(CATEGORIES)}
- note: รายละเอียดสั้น ๆ ว่าจ่ายค่าอะไร
ตอบเป็น JSON วัตถุเดียวเท่านั้น ห้ามมีข้อความอื่น`;

export async function ocrReceipt(env, imageBase64, mediaType = "image/jpeg") {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.CLAUDE_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
            { type: "text", text: PROMPT },
          ],
        },
        { role: "assistant", content: "{" }, // prefill: forces JSON
      ],
    }),
  });

  if (!res.ok) throw new Error("Claude OCR error: " + res.status + " " + (await res.text()));
  const json = await res.json();
  const text = "{" + (json.content?.[0]?.text || "");

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // last resort: grab the first {...} block
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("OCR returned non-JSON: " + text);
    data = JSON.parse(m[0]);
  }

  return {
    amount: Number(String(data.amount).replace(/[^0-9.]/g, "")) || 0,
    vendor: data.vendor || "",
    date: data.date || new Date().toISOString().slice(0, 10),
    category: CATEGORIES.includes(data.category) ? data.category : "อื่น ๆ",
    note: data.note || "",
  };
}

export { CATEGORIES };
