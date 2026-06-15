require("dotenv").config();
const processed = new Set();
const imageStore = new Map();
const userState = new Map();

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

console.log("SUPABASE_URL =", process.env.SUPABASE_URL);
console.log("SUPABASE_KEY =", process.env.SUPABASE_KEY ? "FOUND" : "MISSING");

// ─── Supabase ───────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function saveMessage(phone, role, content) {
  const { error } = await supabase
    .from("conversations")
    .insert([{ phone, role, content }]);
  if (error) console.error("Supabase save error:", error);
}

async function getHistory(phone) {
  const { data, error } = await supabase
    .from("conversations")
    .select("role, content")
    .eq("phone", phone)
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) { console.error("History error:", error); return []; }
  return data || [];
}

// ─── WhatsApp Helpers ────────────────────────────────────────────────────────
async function getWhatsAppMediaUrl(mediaId) {
  const response = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
  return response.data.url;
}

async function downloadMedia(url) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
  });
  return Buffer.from(response.data);
}

async function sendText(to, body) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body }
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

// ─── AI Core (Claude via OpenRouter) ─────────────────────────────────────────
const MODEL = "meta-llama/llama-3.2-11b-vision-instruct"; // Claude via OpenRouter

const SYSTEM_PROMPT = `You are a smart, helpful WhatsApp AI assistant powered by Claude.
- Keep replies concise and friendly (this is a chat, not an essay).
- Use bullet points or numbered lists when explaining steps.
- If the user sends an image, describe it clearly and answer any questions about it.
- Do NOT assume the user's name unless they tell you.
- Do NOT continue previous topics unless the user brings them up.`;

async function getAIReply(userMessage, phone) {
  try {
    const history = await getHistory(phone);

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: userMessage }
    ];

    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      { model: MODEL, messages },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://whatsapp-bot",
          "X-Title": "WhatsApp Claude Bot"
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (err) {
    console.error("AI ERROR:", err.response?.data || err.message);
    return "⚠️ AI is currently unavailable. Please try again shortly.";
  }
}

async function analyzeImageWithAI(base64Image, mimeType, userPrompt) {
  try {
    const prompt = userPrompt && userPrompt.toLowerCase() !== "yes"
      ? userPrompt   // user typed a specific question about the image
      : "Describe this image clearly and accurately. Mention objects, people, text, colours, and any other notable details.";

    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:${mimeType};base64,${base64Image}` }
              }
            ]
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://whatsapp-bot",
          "X-Title": "WhatsApp Claude Bot"
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (err) {
    console.error("Image AI ERROR:", err.response?.data || err.message);
    return "⚠️ Could not analyse the image. Please try again.";
  }
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  console.log("🔥 REQUEST:", req.method, req.url);
  next();
});

app.get("/", (req, res) => res.send("🤖 WhatsApp Bot (Claude) is Running!"));

// Webhook verify
const VERIFY_TOKEN = "my_verify_token";
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ─── Main Webhook ─────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    // Deduplication
    if (processed.has(msg.id)) return res.sendStatus(200);
    processed.add(msg.id);

    const from = msg.from;
    const state = userState.get(from);

    // ── IMAGE received ──────────────────────────────────────────────────────
    if (msg.type === "image") {
      const imageId = msg.image.id;
      const caption = msg.image?.caption || "";        // caption typed with image

      const mediaUrl = await getWhatsAppMediaUrl(imageId);
      const imageBuffer = await downloadMedia(mediaUrl);

      imageStore.set(from, {
        imageBuffer,
        mimeType: "image/jpeg",
        caption
      });
      userState.set(from, "WAITING_IMAGE");

      // If user already wrote a caption/question with the image, analyse immediately
      if (caption) {
        await handleImageAnalysis(from, caption);
      } else {
        await sendText(from,
          "📸 Image received!\n\nReply *YES* to describe the image, or type your question about it (e.g. \"What is written here?\")."
        );
      }

      return res.sendStatus(200);
    }

    // ── VIDEO / DOCUMENT / AUDIO received ───────────────────────────────────
    if (["video", "document", "audio"].includes(msg.type)) {
      await sendText(from,
        `📎 I received your ${msg.type}. Currently I can only analyse *images* and answer *text* questions. Send me an image or ask me anything!`
      );
      return res.sendStatus(200);
    }

    // ── TEXT received ────────────────────────────────────────────────────────
    const text = msg.text?.body;
    if (!text) return res.sendStatus(200);

    const lowerText = text.trim().toLowerCase();

    // User is replying to a pending image
    if (state === "WAITING_IMAGE") {
      await handleImageAnalysis(from, text);
      return res.sendStatus(200);
    }

    // Normal text → Claude
    await saveMessage(from, "user", text);
    const reply = await getAIReply(text, from);
    await saveMessage(from, "assistant", reply);
    await sendText(from, reply);

    return res.sendStatus(200);

  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
    res.sendStatus(200);
  }
});

// ─── Image Analysis Helper ────────────────────────────────────────────────────
async function handleImageAnalysis(from, userPrompt) {
  const imageData = imageStore.get(from);
  userState.delete(from);
  imageStore.delete(from);

  if (!imageData) {
    await sendText(from, "⚠️ No image found. Please send the image again.");
    return;
  }

  await sendText(from, "🔍 Analysing your image, please wait...");

  const base64Image = imageData.imageBuffer.toString("base64");
  const aiReply = await analyzeImageWithAI(base64Image, imageData.mimeType, userPrompt);

  // Save to history so the conversation is continuous
  await saveMessage(from, "user", `[User sent an image] ${userPrompt}`);
  await saveMessage(from, "assistant", aiReply);

  await sendText(from, aiReply);
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .limit(1);
  console.log("SUPABASE TEST:", data);
  console.log("SUPABASE ERROR:", error);
})();

app.listen(PORT, () => console.log("🚀 Server running on port", PORT));