require("dotenv").config();

const userState = new Map();
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
console.log("SUPABASE_URL =", process.env.SUPABASE_URL);
console.log("SUPABASE_KEY =", process.env.SUPABASE_KEY ? "FOUND" : "MISSING");

// Supabase connection
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 👇 ADD HERE
async function saveMessage(phone, role, content) {
  const { error } = await supabase
    .from("conversations")
    .insert([
      {
        phone,
        role,
        content
      }
    ]);

  if (error) {
    console.error("Supabase save error:", error);
  }
}

// 👇 ADD HERE
async function getHistory(phone) {
  const { data, error } = await supabase
    .from("conversations")
    .select("role, content")
    .eq("phone", phone)
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    console.error("History error:", error);
    return [];
  }

  return data || [];
}
// 👇 ADD HERE
async function getWhatsAppImageUrl(imageId) {
    const response = await axios.get(
        `https://graph.facebook.com/v19.0/${imageId}`,
        {
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`
            }
        }
    );

    return response.data.url;
}




const app = express();
app.use(express.json());

/* =========================
   FREE AI FUNCTION (HUGGINGFACE)
========================= */
async function getAIReply(text, phone) {
    try {

        const history = await getHistory(phone);

       const messages = [
    {
        role: "system",
        content: `You are a smart WhatsApp AI assistant.
You help users with questions, coding, business, marketing, education, and general knowledge.
Remember previous messages from the conversation.
Reply clearly and naturally.
If you don't know something, say so honestly.`
    },
    ...history
];


        messages.push({
            role: "user",
            content: text
        });

        const response = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
              model: "meta-llama/llama-3.2-11b-vision-instruct",
                messages: messages
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        return response.data.choices[0].message.content;

    } catch (err) {
        console.log("AI ERROR:", err.response?.data || err.message);
        return "AI is currently unavailable.";
    }
}
/* =========================
   LOG MIDDLEWARE
========================= */
app.use((req, res, next) => {
    console.log("🔥 REQUEST:", req.method, req.url);
    next();
});

/* =========================
   HOME ROUTE
========================= */
app.get("/", (req, res) => {
    res.send("🤖 WhatsApp Bot is Running Successfully!");
});

/* =========================
   WHATSAPP CONFIG
========================= */
const VERIFY_TOKEN = "my_verify_token";

async function getImageUrl(query) {
    const response = await axios.get(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1`,
        {
            headers: {
                Authorization: process.env.PEXELS_API_KEY
            }
        }
    );

    return response.data.photos?.[0]?.src?.large;
}
async function downloadImage(url) {
    const response = await axios.get(url, {
        responseType: "arraybuffer",
        headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`
        }
    });

    return Buffer.from(response.data);
}



/* =========================
   WEBHOOK VERIFY
========================= */
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }

    res.sendStatus(403);
});

/* =========================
   MESSAGE HANDLER
========================= */
app.post("/webhook", async (req, res) => {
  try {

    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];

    if (!msg) return res.sendStatus(200);

    const from = msg.from;

    // ================= IMAGE HANDLER =================
    if (msg?.type === "image") {

      const imageId = msg.image.id;

      const imageUrl = await getWhatsAppImageUrl(imageId);
      const imageBuffer = await downloadImage(imageUrl);

      console.log("IMAGE SIZE:", imageBuffer.length);

      userState.set(from, "WAITING_IMAGE");

      await axios.post(
        `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          text: {
            body: "📸 Image received. Reply YES to analyze it."
          }
        },
        {
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`
          }
        }
      );

      return res.sendStatus(200);
    }

    // ================= TEXT HANDLER (ADD YOUR CODE HERE) =================

    const text = msg.text?.body;
    if (!text) return res.sendStatus(200);

    const lowerText = text.toLowerCase();

    // 🔥 STATE CHECK (ADD HERE)
    const state = userState.get(from);

    if (state === "WAITING_IMAGE") {

      if (lowerText === "yes") {

        userState.delete(from);

        const reply = "🔍 Analyzing image now... (next vision step)";

        await axios.post(
          `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
          {
            messaging_product: "whatsapp",
            to: from,
            text: { body: reply }
          },
          {
            headers: {
              Authorization: `Bearer ${ACCESS_TOKEN}`
            }
          }
        );

        return res.sendStatus(200);
      }
    }

    // ================= NORMAL AI =================

    await saveMessage(from, "user", text);

    const reply = await getAIReply(text, from);

    await saveMessage(from, "assistant", reply);

    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        text: { body: reply }
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`
        }
      }
    );

    return res.sendStatus(200);

  } catch (err) {
    console.log("ERROR:", err.message);
    res.sendStatus(200);
  }
});
/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;

// Supabase test
(async () => {
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .limit(1);

  console.log("SUPABASE TEST:", data);
  console.log("SUPABASE ERROR:", error);
})();

app.listen(PORT, () => {
    console.log("🚀 Server running on port", PORT);
});
