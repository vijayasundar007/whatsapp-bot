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

// ─── Pexels Image Search ──────────────────────────────────────────────────────
async function searchPexelsImage(query) {
  try {
    const response = await axios.get(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1`,
      { headers: { Authorization: process.env.PEXELS_API_KEY } }
    );
    return response.data.photos?.[0]?.src?.large || null;
  } catch (err) {
    console.error("Pexels image error:", err.message);
    return null;
  }
}

// ─── Pexels Video Search ──────────────────────────────────────────────────────
async function searchPexelsVideo(query) {
  try {
    const response = await axios.get(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`,
      { headers: { Authorization: process.env.PEXELS_API_KEY } }
    );

    const videos = response.data.videos;
    if (!videos || videos.length === 0) return null;

    // Pick first video, prefer HD or FHD file
    const video = videos[0];
    const files = video.video_files || [];

    // Try to get best quality: 4K > FHD > HD > SD
    const sorted = files.sort((a, b) => (b.width || 0) - (a.width || 0));
    const best = sorted[0];

    return {
      url: best?.link || null,
      width: best?.width || 0,
      height: best?.height || 0,
      duration: video.duration,
      pageUrl: video.url  // Pexels page link as fallback
    };
  } catch (err) {
    console.error("Pexels video error:", err.message);
    return null;
  }
}

// ─── YouTube Search ───────────────────────────────────────────────────────────
async function searchYouTube(query) {
  try {
    const response = await axios.get(
      `https://www.googleapis.com/youtube/v3/search`,
      {
        params: {
          key: process.env.YOUTUBE_API_KEY,
          q: query,
          part: "snippet",
          type: "video",
          maxResults: 1,
          videoDuration: "any"
        }
      }
    );

    const item = response.data.items?.[0];
    if (!item) return null;

    const videoId = item.id?.videoId;
    const title = item.snippet?.title;
    return {
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title
    };
  } catch (err) {
    console.error("YouTube error:", err.message);
    return null;
  }
}

// ─── Intent Detector ──────────────────────────────────────────────────────────
function detectIntent(text) {
  const t = text.trim();

  // IMAGE intent
  const imagePatterns = [
    /(?:send|show|give|get)(?: me)?(?: an?)? (?:image|photo|picture|pic) (?:of|about) (.+)/i,
    /(.+) (?:image|photo|picture|pic) please/i,
    /(?:image|photo|picture|pic) of (.+)/i,
  ];
  for (const p of imagePatterns) {
    const m = t.match(p);
    if (m) return { type: "IMAGE", topic: m[m.length - 1].trim() };
  }

  // VIDEO intent — 4K / video / clip
  const videoPatterns = [
    /(?:send|show|give|get|find)(?: me)?(?: a| an| some)?(?: 4k| hd| full hd)? (?:video|clip|footage|reel) (?:of|about|on) (.+)/i,
    /(?:send|show|give|get|find)(?: me)?(?: a| an)? (.+) (?:4k |hd |)?(?:video|clip|footage)/i,
    /(.+) video please/i,
    /i want(?: a| an)?(?: 4k| hd)? video (?:of|about|on) (.+)/i,
    /i want(?: a| an)?(?: 4k| hd)? (.+) video/i,
    /(?:4k|hd) video (?:of|about|on) (.+)/i,
    /(.+) (?:4k|hd) video/i,
  ];
  for (const p of videoPatterns) {
    const m = t.match(p);
    if (m) return { type: "VIDEO", topic: m[m.length - 1].trim() };
  }

  // YOUTUBE intent
  const ytPatterns = [
    /(?:find|search|show)(?: me)? (?:a |an )?youtube (?:video )?(?:of|about|on) (.+)/i,
    /youtube (.+)/i,
    /(.+) on youtube/i,
  ];
  for (const p of ytPatterns) {
    const m = t.match(p);
    if (m) return { type: "YOUTUBE", topic: m[m.length - 1].trim() };
  }

  return null; // no special intent → normal AI
}

// ─── AI Core ──────────────────────────────────────────────────────────────────
const MODEL = "meta-llama/llama-3.2-11b-vision-instruct";

const SYSTEM_PROMPT = `You are a smart, helpful WhatsApp AI assistant.
- Keep replies concise and friendly.
- Use bullet points only when explaining steps.
- If the user sends an image, describe it clearly.
- Do NOT assume the user's name unless they tell you.
- IMPORTANT: If the user asks for an image, video, photo, or YouTube link — 
  do NOT describe or explain. Just reply with EXACTLY this format:
  IMAGE_REQUEST:<topic>
  VIDEO_REQUEST:<topic>
  YOUTUBE_REQUEST:<topic>
  Example: user says "send me cat video" → VIDEO_REQUEST:cat
  Example: user says "i want 4k nature video" → VIDEO_REQUEST:nature 4k
  Example: user says "send sunset image" → IMAGE_REQUEST:sunset`;

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
          "X-Title": "WhatsApp Bot"
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
        : "Describe this image clearly. Mention objects, people, text, colours, and notable details.";

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
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
            ]
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://whatsapp-bot",
          "X-Title": "WhatsApp Bot"
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (err) {
    console.error("Image AI ERROR:", JSON.stringify(err.response?.data) || err.message);
    return "⚠️ Could not analyse the image. Please try again.";
  }
}

// ─── Intent Handlers ──────────────────────────────────────────────────────────
async function handleSendImage(from, topic) {
  await sendText(from, `🔍 Searching for a *${topic}* image...`);
  const imageUrl = await searchPexelsImage(topic);
  if (imageUrl) {
    await sendImage(from, imageUrl, `Here's a ${topic} image 🖼️`);
    await saveMessage(from, "user", `[Asked for image: ${topic}]`);
    await saveMessage(from, "assistant", `[Sent image: ${topic}]`);
  } else {
    await sendText(from, `😔 Sorry, couldn't find an image for *${topic}*. Try a different word!`);
  }
}

async function handleSendVideo(from, topic) {
  await sendText(from, `🎬 Searching for a *${topic}* video...`);
  const video = await searchPexelsVideo(topic);

  if (video && video.url) {
    const quality = video.width >= 3840 ? "4K" : video.width >= 1920 ? "Full HD" : video.width >= 1280 ? "HD" : "SD";
    const msg =
      `🎥 *${topic.toUpperCase()} VIDEO*\n\n` +
      `📐 Quality: ${quality} (${video.width}x${video.height})\n` +
      `⏱ Duration: ${video.duration}s\n\n` +
      `🔗 Download link:\n${video.url}\n\n` +
      `📄 Pexels page:\n${video.pageUrl}`;
    await sendText(from, msg);
    await saveMessage(from, "user", `[Asked for video: ${topic}]`);
    await saveMessage(from, "assistant", `[Sent video link: ${topic}]`);
  } else {
    await sendText(from, `😔 Sorry, couldn't find a video for *${topic}*. Try a different keyword!`);
  }
}

async function handleYouTube(from, topic) {
  await sendText(from, `▶️ Searching YouTube for *${topic}*...`);

  if (!process.env.YOUTUBE_API_KEY) {
    // Fallback: just build a search URL
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(topic)}`;
    await sendText(from, `🔗 YouTube search results for *${topic}*:\n${searchUrl}`);
    return;
  }

  const result = await searchYouTube(topic);
  if (result) {
    await sendText(from, `▶️ *${result.title}*\n\n🔗 ${result.url}`);
    await saveMessage(from, "user", `[Asked for YouTube: ${topic}]`);
    await saveMessage(from, "assistant", `[Sent YouTube: ${result.url}]`);
  } else {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(topic)}`;
    await sendText(from, `🔗 Search this on YouTube:\n${searchUrl}`);
  }
}

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

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  console.log("🔥 REQUEST:", req.method, req.url);
  next();
});

app.get("/", (req, res) => res.send("🤖 WhatsApp Bot is Running!"));

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
        await sendText(from, "📸 Image received!\n\nReply *YES* to describe it, or type your question about it.");
      }
      return res.sendStatus(200);
    }

    // ── VIDEO / DOCUMENT / AUDIO received ─────────────────────────────────────
    if (["video", "document", "audio"].includes(msg.type)) {
      await sendText(from, `📎 I received your ${msg.type}. I can analyse *images* and answer *text* questions. Try sending an image or asking something!`);
      return res.sendStatus(200);
    }

    // ── TEXT received ─────────────────────────────────────────────────────────
    const text = msg.text?.body;
    if (!text) return res.sendStatus(200);

    // Replying to pending image
    if (state === "WAITING_IMAGE") {
      await handleImageAnalysis(from, text);
      return res.sendStatus(200);
    }

    // ── Intent Detection (BEFORE AI) ──────────────────────────────────────────
    const intent = detectIntent(text);

    if (intent?.type === "IMAGE") {
      await handleSendImage(from, intent.topic);
      return res.sendStatus(200);
    }

    if (intent?.type === "VIDEO") {
      await handleSendVideo(from, intent.topic);
      return res.sendStatus(200);
    }

    if (intent?.type === "YOUTUBE") {
      await handleYouTube(from, intent.topic);
      return res.sendStatus(200);
    }

    // ── Normal AI ─────────────────────────────────────────────────────────────
    await saveMessage(from, "user", text);
    const reply = await getAIReply(text, from);
    await saveMessage(from, "assistant", reply);

    // AI may still detect intent via system prompt
    if (reply.startsWith("IMAGE_REQUEST:")) {
      await handleSendImage(from, reply.replace("IMAGE_REQUEST:", "").trim());
    } else if (reply.startsWith("VIDEO_REQUEST:")) {
      await handleSendVideo(from, reply.replace("VIDEO_REQUEST:", "").trim());
    } else if (reply.startsWith("YOUTUBE_REQUEST:")) {
      await handleYouTube(from, reply.replace("YOUTUBE_REQUEST:", "").trim());
    } else {
      await sendText(from, reply);
    }

    return res.sendStatus(200);

  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
    res.sendStatus(200);
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  const { data, error } = await supabase.from("conversations").select("*").limit(1);
  console.log("SUPABASE TEST:", data);
  console.log("SUPABASE ERROR:", error);
})();

app.listen(PORT, () => console.log("🚀 Server running on port", PORT));
