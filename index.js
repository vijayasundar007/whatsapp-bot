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

// ─── Supabase ────────────────────────────────────────────────────────────────
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

// ─── WhatsApp Helpers ─────────────────────────────────────────────────────────
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
    { messaging_product: "whatsapp", to, text: { body } },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

// ✅ NEW: Send image by public URL
async function sendImage(to, imageUrl, caption = "") {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link: imageUrl, caption }
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

// ✅ NEW: Search Pexels for an image
async function searchPexelsImage(query) {
  try {
    const response = await axios.get(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1`,
      { headers: { Authorization: process.env.PEXELS_API_KEY } }
    );
    return response.data.photos?.[0]?.src?.large || null;
  } catch (err) {
    console.error("Pexels error:", err.message);
    return null;
  }
}

// ✅ NEW: Detect if user is asking for an image
function detectImageRequest(text) {
  const patterns = [
    /send (me )?(an? |a )?image of (.+)/i,
    /show (me )?(an? |a )?image of (.+)/i,
    /give (me )?(an? |a )?image of (.+)/i,
    /send (me )?(an? |a )?photo of (.+)/i,
    /show (me )?(an? |a )?photo of (.+)/i,
    /give (me )?(an? |a )?photo of (.+)/i,
    /send (me )?(an? |a )?picture of (.+)/i,
    /show (me )?(an? |a )?picture of (.+)/i,
    /give (me )?(an? |a )?picture of (.+)/i,
    /(.+) image please/i,
    /(.+) photo please/i,
    /(.+) picture please/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      // Return the captured topic (last capture group)
      return match[match.length - 1].trim();
    }
  }
  return null;
}

// ─── AI Core ─────────────────────────────────────────────────────────────────
const MODEL = "meta-llama/llama-3.2-11b-vision-instruct"; // change to "anthropic/claude-sonnet-4-5" if available

const SYSTEM_PROMPT = `You are a smart, helpful WhatsApp AI assistant.
- Keep replies concise and friendly (this is a chat app, not an essay).
- Use bullet points or numbered lists only when explaining steps.
- If the user sends an image, describe it clearly and answer questions about it.
- Do NOT assume the user's name unless they tell you.
- Do NOT continue previous topics unless the user brings them up.
- If the user asks you to send/show/give an image or photo, reply with exactly: IMAGE_REQUEST:<topic>
  Example: user says "send me a image of cat" → you reply: IMAGE_REQUEST:cat
  Example: user says "show me sunset photo" → you reply: IMAGE_REQUEST:sunset`;

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
    console.error("AI ERROR:", JSON.stringify(err.response?.data) || err.message);
    return "⚠️ AI is currently unavailable. Please try again shortly.";
  }
}

async function analyzeImageWithAI(base64Image, mimeType, userPrompt) {
  try {
    const prompt =
      userPrompt && userPrompt.toLowerCase() !== "yes"
        ? userPrompt
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
    console.error("Image AI ERROR:", JSON.stringify(err.response?.data) || err.message);
    return "⚠️ Could not analyse the image. Please try again.";
  }
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  console.log("🔥 REQUEST:", req.method, req.url);
  next();
});

app.get("/", (req, res) => res.send("🤖 WhatsApp Bot is Running!"));

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

    // ── IMAGE received ────────────────────────────────────────────────────────
    if (msg.type === "image") {
      const imageId = msg.image.id;
      const caption = msg.image?.caption || "";

      const mediaUrl = await getWhatsAppMediaUrl(imageId);
      const imageBuffer = await downloadMedia(mediaUrl);

      imageStore.set(from, { imageBuffer, mimeType: "image/jpeg", caption });
      userState.set(from, "WAITING_IMAGE");

      if (caption) {
        await handleImageAnalysis(from, caption);
      } else {
        await sendText(
          from,
          "📸 Image received!\n\nReply *YES* to describe it, or type your question (e.g. \"What is written here?\")."
        );
      }

      return res.sendStatus(200);
    }

    // ── VIDEO / DOCUMENT / AUDIO received ─────────────────────────────────────
    if (["video", "document", "audio"].includes(msg.type)) {
      await sendText(
        from,
        `📎 I received your ${msg.type}. Currently I can only analyse *images* and answer *text* questions. Send me an image or ask me anything!`
      );
      return res.sendStatus(200);
    }

    // ── TEXT received ─────────────────────────────────────────────────────────
    const text = msg.text?.body;
    if (!text) return res.sendStatus(200);

    const lowerText = text.trim().toLowerCase();

    // User replying to pending image
    if (state === "WAITING_IMAGE") {
      await handleImageAnalysis(from, text);
      return res.sendStatus(200);
    }

    // ✅ Check if user is asking for an image (pattern match first)
    const imageTopic = detectImageRequest(text);
    if (imageTopic) {
      await handleSendImage(from, imageTopic);
      return res.sendStatus(200);
    }

    // Normal text → AI
    await saveMessage(from, "user", text);
    const reply = await getAIReply(text, from);
    await saveMessage(from, "assistant", reply);

    // ✅ Check if AI wants to send an image (AI detected image request)
    if (reply.startsWith("IMAGE_REQUEST:")) {
      const topic = reply.replace("IMAGE_REQUEST:", "").trim();
      await handleSendImage(from, topic);
      return res.sendStatus(200);
    }

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

  await saveMessage(from, "user", `[User sent an image] ${userPrompt}`);
  await saveMessage(from, "assistant", aiReply);

  await sendText(from, aiReply);
}

// ✅ NEW: Send Image Helper
async function handleSendImage(from, topic) {
  await sendText(from, `🔍 Searching for a *${topic}* image...`);

  const imageUrl = await searchPexelsImage(topic);

  if (imageUrl) {
    await sendImage(from, imageUrl, `Here's a ${topic} image for you! 🖼️`);
    await saveMessage(from, "user", `[User asked for image of: ${topic}]`);
    await saveMessage(from, "assistant", `[Sent Pexels image of: ${topic}]`);
  } else {
    await sendText(from, `😔 Sorry, I couldn't find an image for *${topic}*. Try a different keyword!`);
  }
}

// ─── Start Server ─────────────────────────────────────────────────────────────
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
