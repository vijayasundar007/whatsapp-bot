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
const FormData = require("form-data");

console.log("SUPABASE_URL =", process.env.SUPABASE_URL);
console.log("SUPABASE_KEY =", process.env.SUPABASE_KEY ? "FOUND" : "MISSING");

// ─── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Conversations ─────────────────────────────────────────────────────────────
async function saveMessage(phone, role, content) {
  const { error } = await supabase.from("conversations").insert([{ phone, role, content }]);
  if (error) console.error("Supabase save error:", error);
}

async function getHistory(phone) {
  const { data, error } = await supabase
    .from("conversations")
    .select("role, content")
    .eq("phone", phone)
    .order("created_at", { ascending: true })
    .limit(30);                          // 🔼 increased from 20 → 30
  if (error) { console.error("History error:", error); return []; }
  return data || [];
}

// ── User Profile (permanent memory) ──────────────────────────────────────────
async function getUserProfile(phone) {
  const { data } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("phone", phone)
    .single();
  return data || {};
}

async function saveUserProfile(phone, updates) {
  const { error } = await supabase
    .from("user_profiles")
    .upsert({ phone, ...updates, updated_at: new Date().toISOString() });
  if (error) console.error("Profile save error:", error);
}

// ── Auto-summarize old history to keep context compact ────────────────────────
async function summarizeAndCompress(phone) {
  const { data: rows } = await supabase
    .from("conversations")
    .select("id, role, content")
    .eq("phone", phone)
    .order("created_at", { ascending: true });

  if (!rows || rows.length < 50) return; // only compress when history is large

  // Build summary prompt from all messages
  const convo = rows.map(r => `${r.role}: ${r.content}`).join("\n");
  const summaryPrompt = `Summarize this WhatsApp conversation history into bullet points.
Extract and keep:
- User's name (if mentioned)
- User's language preference
- Topics and questions they asked about
- Devices, products, or things they are interested in
- Any personal preferences or facts they shared

Conversation:
${convo}`;

  try {
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: MODEL,
        messages: [{ role: "user", content: summaryPrompt }]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    const summary = res.data.choices[0].message.content;

    // Save summary to user profile
    await saveUserProfile(phone, { summary });

    // Delete old messages, keep only last 15
    const toDelete = rows.slice(0, rows.length - 15).map(r => r.id);
    if (toDelete.length > 0) {
      await supabase.from("conversations").delete().in("id", toDelete);
    }

    console.log(`✅ Compressed history for ${phone}`);
  } catch (err) {
    console.error("Summarize error:", err.message);
  }
}

// ── Auto-extract user info from their message ─────────────────────────────────
async function learnFromMessage(phone, text) {
  const profile = await getUserProfile(phone);
  const updates = {};

  // Detect name
  const nameMatch = text.match(/(?:my name is|i am|call me|iam|myself)\s+([A-Za-z]+)/i);
  if (nameMatch && !profile.name) {
    updates.name = nameMatch[1];
    console.log(`👤 Learned name: ${nameMatch[1]}`);
  }

  // Detect language from keywords
  const langMap = {
    tamil: "Tamil", hindi: "Hindi", arabic: "Arabic",
    telugu: "Telugu", kannada: "Kannada", malayalam: "Malayalam",
    french: "French", spanish: "Spanish", german: "German"
  };
  for (const [key, lang] of Object.entries(langMap)) {
    if (text.toLowerCase().includes(`in ${key}`) || text.toLowerCase().includes(`speak ${key}`)) {
      updates.language = lang;
    }
  }

  // Detect topics of interest and save to preferences
  const interests = profile.preferences || {};
  const topicMatch = text.match(/i (?:love|like|enjoy|am interested in|use|own|have)(?: a| an| the)? (.+)/i);
  if (topicMatch) {
    const topic = topicMatch[1].trim();
    interests[topic] = true;
    updates.preferences = interests;
  }

  if (Object.keys(updates).length > 0) {
    await saveUserProfile(phone, updates);
  }
}

// ─── WhatsApp Helpers ─────────────────────────────────────────────────────────
async function getWhatsAppMediaUrl(mediaId) {
  const res = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
  });
  return res.data.url;
}

async function downloadMedia(url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
  });
  return Buffer.from(res.data);
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
    { messaging_product: "whatsapp", to, type: "image", image: { link: imageUrl, caption } },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

// ─── Pexels ───────────────────────────────────────────────────────────────────
async function searchPexelsImage(query) {
  try {
    const res = await axios.get(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1`,
      { headers: { Authorization: process.env.PEXELS_API_KEY } }
    );
    return res.data.photos?.[0]?.src?.large || null;
  } catch (err) { console.error("Pexels image error:", err.message); return null; }
}

async function searchPexelsVideo(query) {
  try {
    const res = await axios.get(
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`,
      { headers: { Authorization: process.env.PEXELS_API_KEY } }
    );
    const videos = res.data.videos;
    if (!videos?.length) return null;
    const video = videos[0];
    const sorted = (video.video_files || []).sort((a, b) => (b.width || 0) - (a.width || 0));
    const best = sorted[0];
    return { url: best?.link || null, width: best?.width || 0, height: best?.height || 0, duration: video.duration, pageUrl: video.url };
  } catch (err) { console.error("Pexels video error:", err.message); return null; }
}

// ─── YouTube ──────────────────────────────────────────────────────────────────
async function searchYouTube(query) {
  try {
    const res = await axios.get(`https://www.googleapis.com/youtube/v3/search`, {
      params: { key: process.env.YOUTUBE_API_KEY, q: query, part: "snippet", type: "video", maxResults: 1 }
    });
    const item = res.data.items?.[0];
    if (!item) return null;
    return { url: `https://www.youtube.com/watch?v=${item.id?.videoId}`, title: item.snippet?.title };
  } catch (err) { console.error("YouTube error:", err.message); return null; }
}

// ─── Weather ──────────────────────────────────────────────────────────────────
async function getWeather(city) {
  try {
    const res = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${process.env.OPENWEATHER_API_KEY}&units=metric`
    );
    const d = res.data;
    return (
      `🌦️ *Weather in ${d.name}, ${d.sys.country}*\n\n` +
      `🌡️ Temp: ${d.main.temp}°C (Feels like ${d.main.feels_like}°C)\n` +
      `💧 Humidity: ${d.main.humidity}%\n` +
      `💨 Wind: ${d.wind.speed} m/s\n` +
      `☁️ Condition: ${d.weather[0].description}\n` +
      `🌅 Sunrise: ${new Date(d.sys.sunrise * 1000).toLocaleTimeString()}\n` +
      `🌇 Sunset: ${new Date(d.sys.sunset * 1000).toLocaleTimeString()}`
    );
  } catch (err) {
    console.error("Weather error:", err.message);
    return `😔 Could not get weather for *${city}*. Check the city name and try again.`;
  }
}

// ─── Web Search ───────────────────────────────────────────────────────────────
async function webSearch(query) {
  try {
    const res = await axios.get(`https://www.googleapis.com/customsearch/v1`, {
      params: { key: process.env.GOOGLE_SEARCH_API_KEY, cx: process.env.GOOGLE_SEARCH_CX, q: query, num: 3 }
    });
    const items = res.data.items || [];
    if (!items.length) return `😔 No results found for *${query}*.`;
    let msg = `🔎 *Search results for: ${query}*\n\n`;
    items.forEach((item, i) => { msg += `*${i + 1}. ${item.title}*\n${item.snippet}\n🔗 ${item.link}\n\n`; });
    return msg.trim();
  } catch (err) {
    console.error("Web search error:", err.message);
    return `🔎 Search this on Google:\nhttps://www.google.com/search?q=${encodeURIComponent(query)}`;
  }
}

// ─── Voice Transcription ──────────────────────────────────────────────────────
async function transcribeAudio(audioBuffer) {
  try {
    const form = new FormData();
    form.append("file", audioBuffer, { filename: "audio.ogg", contentType: "audio/ogg" });
    form.append("model", "whisper-1");
    const res = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() }
    });
    return res.data.text || null;
  } catch (err) { console.error("Transcription error:", err.message); return null; }
}

// ─── Currency Converter ───────────────────────────────────────────────────────
async function convertCurrency(amount, from, to) {
  try {
    const res = await axios.get(`https://api.exchangerate-api.com/v4/latest/${from.toUpperCase()}`);
    const rate = res.data.rates[to.toUpperCase()];
    if (!rate) return `😔 Could not find exchange rate for ${from} → ${to}.`;
    const result = (amount * rate).toFixed(2);
    return `💱 *Currency Conversion*\n\n${amount} ${from.toUpperCase()} = *${result} ${to.toUpperCase()}*\n\n📅 Rate updated: ${res.data.date}`;
  } catch (err) { console.error("Currency error:", err.message); return `😔 Currency conversion failed.`; }
}

// ─── News ─────────────────────────────────────────────────────────────────────
async function getNews(topic = "world") {
  try {
    const res = await axios.get(`https://newsapi.org/v2/top-headlines`, {
      params: { apiKey: process.env.NEWS_API_KEY, q: topic === "world" ? undefined : topic, language: "en", pageSize: 4, country: topic === "world" ? "us" : undefined }
    });
    const articles = res.data.articles || [];
    if (!articles.length) return `😔 No news found for *${topic}*.`;
    let msg = `📰 *Latest News: ${topic.toUpperCase()}*\n\n`;
    articles.forEach((a, i) => { msg += `*${i + 1}. ${a.title}*\n${a.description || ""}\n🔗 ${a.url}\n\n`; });
    return msg.trim();
  } catch (err) { console.error("News error:", err.message); return `😔 Could not fetch news right now.`; }
}

// ─── Intent Detector ──────────────────────────────────────────────────────────
function detectIntent(text) {
  const t = text.trim();

  const imageP = [
    /(?:send|show|give|get)(?: me)?(?: an?)? (?:image|photo|picture|pic) (?:of|about) (.+)/i,
    /(?:image|photo|picture|pic) of (.+)/i,
    /(.+) (?:image|photo|picture|pic) please/i,
  ];
  for (const p of imageP) { const m = t.match(p); if (m) return { type: "IMAGE", topic: m[m.length - 1].trim() }; }

  const videoP = [
    /(?:send|show|give|get|find)(?: me)?(?: a| an| some)?(?: 4k| hd| full hd)? (?:video|clip|footage) (?:of|about|on) (.+)/i,
    /(?:send|show|give|get|find)(?: me)?(?: a| an)? (.+) (?:4k |hd |)?(?:video|clip|footage)/i,
    /i want(?: a| an)?(?: 4k| hd)? video (?:of|about|on) (.+)/i,
    /i want(?: a| an)?(?: 4k| hd)? (.+) video/i,
    /(.+) video please/i,
  ];
  for (const p of videoP) { const m = t.match(p); if (m) return { type: "VIDEO", topic: m[m.length - 1].trim() }; }

  const ytP = [
    /(?:find|search|show)(?: me)? (?:a |an )?youtube (?:video )?(?:of|about|on) (.+)/i,
    /youtube (.+)/i,
    /(.+) on youtube/i,
  ];
  for (const p of ytP) { const m = t.match(p); if (m) return { type: "YOUTUBE", topic: m[m.length - 1].trim() }; }

  const weatherP = [
    /(?:weather|temperature|climate)(?: in| at| for)? (.+)/i,
    /(?:what(?:'s| is) the weather)(?: in| at| for)? (.+)/i,
    /(.+) weather/i,
  ];
  for (const p of weatherP) { const m = t.match(p); if (m) return { type: "WEATHER", topic: m[m.length - 1].trim() }; }

  const newsP = [
    /(?:latest|today'?s?|recent|breaking)? ?news(?: on| about| for)? ?(.+)?/i,
    /what(?:'s| is) happening(?: in| with)? ?(.+)?/i,
  ];
  for (const p of newsP) { const m = t.match(p); if (m) return { type: "NEWS", topic: (m[1] || "world").trim() }; }

  const searchP = [
    /(?:search|google|look up|find info|find out)(?: about| for)? (.+)/i,
  ];
  for (const p of searchP) { const m = t.match(p); if (m) return { type: "SEARCH", topic: m[m.length - 1].trim() }; }

  const currP = [
    /(?:convert|how much is) (\d+(?:\.\d+)?) ?([a-z]{3}) (?:to|in) ([a-z]{3})/i,
    /(\d+(?:\.\d+)?) ?([a-z]{3}) to ([a-z]{3})/i,
  ];
  for (const p of currP) { const m = t.match(p); if (m) return { type: "CURRENCY", amount: parseFloat(m[1]), from: m[2], to: m[3] }; }

  return null;
}

// ─── AI Core with FULL MEMORY ─────────────────────────────────────────────────
const MODEL = "meta-llama/llama-3.2-11b-vision-instruct";

const SYSTEM_PROMPT = `You are a smart, helpful WhatsApp AI assistant — like Claude or ChatGPT.
You can do everything: answer questions, write code, translate, summarize, explain concepts, do math, tell jokes, write essays, poems, stories, and more.

CRITICAL MEMORY RULES:
- You have access to the user's LONG TERM MEMORY and full conversation history.
- ALWAYS read the history before replying. Use it to understand follow-up messages.
- If user sends a short follow-up like "under 20k", "best one", "which is cheapest", "compare first two", "tell me more", "what about the second one" — it ALWAYS relates to the PREVIOUS topic in history. NEVER ask "what do you mean?". Just connect it and answer.
- If you already know the user's name, greet them personally.
- Remember what topics, products, devices the user has discussed before.
- If user previously asked about mobiles → "under 20k" means filter that mobile list.
- If user previously asked about recipes → "without onion" means modify that recipe.

LANGUAGE RULES:
- Detect the user's language and ALWAYS reply in the SAME language.
- Tamil → Tamil. Hindi → Hindi. English → English. etc.

FORMAT RULES:
- Keep replies concise and friendly for WhatsApp chat.
- Use *bold* with asterisks for WhatsApp emphasis.
- Use bullet points only when listing steps or options.
- Do NOT use markdown headers (#, ##).

INTENT RULES (reply ONLY with these codes, nothing else):
If user asks for image/photo → IMAGE_REQUEST:<topic>
If user asks for video → VIDEO_REQUEST:<topic>
If user asks for youtube → YOUTUBE_REQUEST:<topic>
If user asks for weather → WEATHER_REQUEST:<city>
If user asks for news → NEWS_REQUEST:<topic>
If user asks to search/google → SEARCH_REQUEST:<query>
If user asks to convert currency → CURRENCY_REQUEST:<amount>:<from>:<to>`;

async function getAIReply(userMessage, phone) {
  try {
    const [history, profile] = await Promise.all([
      phone ? getHistory(phone) : Promise.resolve([]),
      phone ? getUserProfile(phone) : Promise.resolve({})
    ]);

    // Build long-term memory block
    let memoryBlock = "";
    if (profile.name)     memoryBlock += `\n👤 User's name: ${profile.name}`;
    if (profile.language) memoryBlock += `\n🌍 Always reply in: ${profile.language}`;
    if (profile.summary)  memoryBlock += `\n\n📌 LONG TERM MEMORY (past conversations summary):\n${profile.summary}`;
    if (profile.preferences && Object.keys(profile.preferences).length > 0) {
      memoryBlock += `\n💡 User interests/preferences: ${Object.keys(profile.preferences).join(", ")}`;
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT + (memoryBlock ? `\n\n---\nUSER PROFILE:${memoryBlock}` : "") },
      ...history,
      { role: "user", content: userMessage }
    ];

    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      { model: MODEL, messages },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://whatsapp-bot",
          "X-Title": "WhatsApp AI Bot"
        }
      }
    );

    return res.data.choices[0].message.content;
  } catch (err) {
    console.error("AI ERROR:", JSON.stringify(err.response?.data) || err.message);
    return "⚠️ AI is currently unavailable. Please try again shortly.";
  }
}

async function analyzeImageWithAI(base64Image, mimeType, userPrompt) {
  try {
    const prompt = userPrompt && userPrompt.toLowerCase() !== "yes"
      ? userPrompt
      : "Describe this image clearly. Mention objects, people, text, colours, and notable details.";
    const res = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
          ]}
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://whatsapp-bot",
          "X-Title": "WhatsApp AI Bot"
        }
      }
    );
    return res.data.choices[0].message.content;
  } catch (err) {
    console.error("Image AI ERROR:", JSON.stringify(err.response?.data) || err.message);
    return "⚠️ Could not analyse the image. Please try again.";
  }
}

// ─── AI Intent Parser ─────────────────────────────────────────────────────────
async function parseAIIntent(reply) {
  if (reply.startsWith("IMAGE_REQUEST:"))    return { type: "IMAGE",    topic: reply.replace("IMAGE_REQUEST:", "").trim() };
  if (reply.startsWith("VIDEO_REQUEST:"))    return { type: "VIDEO",    topic: reply.replace("VIDEO_REQUEST:", "").trim() };
  if (reply.startsWith("YOUTUBE_REQUEST:"))  return { type: "YOUTUBE",  topic: reply.replace("YOUTUBE_REQUEST:", "").trim() };
  if (reply.startsWith("WEATHER_REQUEST:"))  return { type: "WEATHER",  topic: reply.replace("WEATHER_REQUEST:", "").trim() };
  if (reply.startsWith("NEWS_REQUEST:"))     return { type: "NEWS",     topic: reply.replace("NEWS_REQUEST:", "").trim() };
  if (reply.startsWith("SEARCH_REQUEST:"))   return { type: "SEARCH",   topic: reply.replace("SEARCH_REQUEST:", "").trim() };
  if (reply.startsWith("CURRENCY_REQUEST:")) {
    const [amount, from, to] = reply.replace("CURRENCY_REQUEST:", "").trim().split(":");
    return { type: "CURRENCY", amount: parseFloat(amount), from, to };
  }
  return null;
}

// ─── Intent Handlers ──────────────────────────────────────────────────────────
async function handleSendImage(from, topic) {
  await sendText(from, `🔍 Searching for *${topic}* image...`);
  const url = await searchPexelsImage(topic);
  if (url) {
    await sendImage(from, url, `Here's a ${topic} image 🖼️`);
    await saveMessage(from, "user", `[Asked for image: ${topic}]`);
    await saveMessage(from, "assistant", `[Sent image: ${topic}]`);
  } else {
    await sendText(from, `😔 No image found for *${topic}*. Try another keyword!`);
  }
}

async function handleSendVideo(from, topic) {
  await sendText(from, `🎬 Searching for *${topic}* video...`);
  const video = await searchPexelsVideo(topic);
  if (video?.url) {
    const q = video.width >= 3840 ? "4K" : video.width >= 1920 ? "Full HD" : video.width >= 1280 ? "HD" : "SD";
    await sendText(from,
      `🎥 *${topic.toUpperCase()} VIDEO*\n\n📐 Quality: ${q} (${video.width}x${video.height})\n⏱ Duration: ${video.duration}s\n\n🔗 Download:\n${video.url}\n\n📄 Pexels:\n${video.pageUrl}`
    );
    await saveMessage(from, "user", `[Asked for video: ${topic}]`);
    await saveMessage(from, "assistant", `[Sent video: ${topic}]`);
  } else {
    await sendText(from, `😔 No video found for *${topic}*. Try another keyword!`);
  }
}

async function handleYouTube(from, topic) {
  await sendText(from, `▶️ Searching YouTube for *${topic}*...`);
  if (process.env.YOUTUBE_API_KEY) {
    const result = await searchYouTube(topic);
    if (result) { await sendText(from, `▶️ *${result.title}*\n\n🔗 ${result.url}`); return; }
  }
  await sendText(from, `🔗 Search on YouTube:\nhttps://www.youtube.com/results?search_query=${encodeURIComponent(topic)}`);
}

async function handleWeather(from, city) {
  const msg = await getWeather(city);
  await sendText(from, msg);
  await saveMessage(from, "user", `[Weather: ${city}]`);
  await saveMessage(from, "assistant", msg);
}

async function handleNews(from, topic) {
  await sendText(from, `📰 Fetching news about *${topic}*...`);
  const msg = await getNews(topic);
  await sendText(from, msg);
  await saveMessage(from, "user", `[News: ${topic}]`);
  await saveMessage(from, "assistant", msg);
}

async function handleSearch(from, query) {
  await sendText(from, `🔎 Searching for *${query}*...`);
  const msg = await webSearch(query);
  await sendText(from, msg);
  await saveMessage(from, "user", `[Search: ${query}]`);
  await saveMessage(from, "assistant", msg);
}

async function handleCurrency(from, amount, fromCurr, toCurr) {
  const msg = await convertCurrency(amount, fromCurr, toCurr);
  await sendText(from, msg);
  await saveMessage(from, "user", `[Currency: ${amount} ${fromCurr} to ${toCurr}]`);
  await saveMessage(from, "assistant", msg);
}

async function handleImageAnalysis(from, userPrompt) {
  const imageData = imageStore.get(from);
  userState.delete(from);
  imageStore.delete(from);
  if (!imageData) { await sendText(from, "⚠️ No image found. Please send it again."); return; }
  await sendText(from, "🔍 Analysing your image...");
  const base64Image = imageData.imageBuffer.toString("base64");
  const aiReply = await analyzeImageWithAI(base64Image, imageData.mimeType, userPrompt);
  await saveMessage(from, "user", `[Image sent] ${userPrompt}`);
  await saveMessage(from, "assistant", aiReply);
  await sendText(from, aiReply);
}

async function handleVoice(from, audioBuffer) {
  await sendText(from, "🎙️ Transcribing your voice message...");
  const transcript = await transcribeAudio(audioBuffer);
  if (!transcript) {
    await sendText(from, "😔 Could not transcribe the audio. Please type your message.");
    return;
  }
  await sendText(from, `📝 *You said:*\n${transcript}`);
  await saveMessage(from, "user", transcript);
  const reply = await getAIReply(transcript, from);
  await saveMessage(from, "assistant", reply);
  await sendText(from, reply);
}

// ─── Route Intent ─────────────────────────────────────────────────────────────
async function routeIntent(from, intent) {
  if (!intent) return false;
  if (intent.type === "IMAGE")    { await handleSendImage(from, intent.topic); return true; }
  if (intent.type === "VIDEO")    { await handleSendVideo(from, intent.topic); return true; }
  if (intent.type === "YOUTUBE")  { await handleYouTube(from, intent.topic);   return true; }
  if (intent.type === "WEATHER")  { await handleWeather(from, intent.topic);   return true; }
  if (intent.type === "NEWS")     { await handleNews(from, intent.topic);      return true; }
  if (intent.type === "SEARCH")   { await handleSearch(from, intent.topic);    return true; }
  if (intent.type === "CURRENCY") { await handleCurrency(from, intent.amount, intent.from, intent.to); return true; }
  return false;
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => { console.log("🔥", req.method, req.url); next(); });
app.get("/", (req, res) => res.send("🤖 WhatsApp AI Bot is Running!"));

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

    // ── IMAGE ─────────────────────────────────────────────────────────────────
    if (msg.type === "image") {
      const caption = msg.image?.caption || "";
      const mediaUrl = await getWhatsAppMediaUrl(msg.image.id);
      const imageBuffer = await downloadMedia(mediaUrl);
      imageStore.set(from, { imageBuffer, mimeType: "image/jpeg", caption });
      userState.set(from, "WAITING_IMAGE");
      if (caption) { await handleImageAnalysis(from, caption); }
      else { await sendText(from, "📸 Image received!\nReply *YES* to describe it, or ask a question about it."); }
      return res.sendStatus(200);
    }

    // ── AUDIO / VOICE ─────────────────────────────────────────────────────────
    if (msg.type === "audio") {
      if (process.env.OPENAI_API_KEY) {
        const mediaUrl = await getWhatsAppMediaUrl(msg.audio.id);
        const audioBuffer = await downloadMedia(mediaUrl);
        await handleVoice(from, audioBuffer);
      } else {
        await sendText(from, "🎙️ Voice messages not enabled yet. Please type your message!");
      }
      return res.sendStatus(200);
    }

    // ── VIDEO / DOCUMENT ──────────────────────────────────────────────────────
    if (["video", "document"].includes(msg.type)) {
      await sendText(from, `📎 I received your ${msg.type}. I can analyse *images*, transcribe *voice messages*, and answer *text* questions!`);
      return res.sendStatus(200);
    }

    // ── TEXT ──────────────────────────────────────────────────────────────────
    const text = msg.text?.body;
    if (!text) return res.sendStatus(200);

    // Pending image reply
    if (state === "WAITING_IMAGE") {
      await handleImageAnalysis(from, text);
      return res.sendStatus(200);
    }

    // 🧠 Learn from every message (non-blocking)
    learnFromMessage(from, text).catch(console.error);

    // Intent detection (pattern match first — faster & more reliable)
    const intent = detectIntent(text);
    if (await routeIntent(from, intent)) return res.sendStatus(200);

    // AI reply with full memory
    await saveMessage(from, "user", text);
    const reply = await getAIReply(text, from);
    await saveMessage(from, "assistant", reply);

    // Check if AI detected an intent
    const aiIntent = await parseAIIntent(reply);
    if (await routeIntent(from, aiIntent)) return res.sendStatus(200);

    await sendText(from, reply);

    // 🗜️ Auto compress old history (non-blocking)
    summarizeAndCompress(from).catch(console.error);

    return res.sendStatus(200);

  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
    res.sendStatus(200);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
(async () => {
  const { data, error } = await supabase.from("conversations").select("*").limit(1);
  console.log("SUPABASE TEST:", data);
  console.log("SUPABASE ERROR:", error);
})();
app.listen(PORT, () => console.log("🚀 Server running on port", PORT));