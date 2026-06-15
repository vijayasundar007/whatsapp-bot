require("dotenv").config();

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
              model: "google/gemini-2.0-flash-exp",
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
       if (msg?.type === "image") {

    const imageId = msg.image.id;
    console.log("IMAGE ID:", imageId);

    const imageUrl = await getWhatsAppImageUrl(imageId);
    console.log("IMAGE URL:", imageUrl);

    const imageBuffer = await downloadImage(imageUrl);
    console.log("IMAGE SIZE:", imageBuffer.length);

    console.log("📷 IMAGE MESSAGE RECEIVED");
    console.log("FULL MSG:", JSON.stringify(msg, null, 2));

    // 👇 TEMP RESPONSE (NO MORE STATIC TEXT)
    await axios.post(
        `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: "whatsapp",
            to: msg.from,
            text: {
                body: "📸 Image received. Now we will analyze it with AI next step."
            }
        },
        {
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`,
                "Content-Type": "application/json"
            }
        }
    );

    return res.sendStatus(200);
}

        // 🔴 ONLY PROCESS REAL MESSAGES
        if (!msg || !msg.from || !msg.text?.body) {
            return res.sendStatus(200);
        }

        const msgId = msg.id || msg.timestamp + msg.from;

        if (!global.processedMessages) {
            global.processedMessages = new Set();
        }

        if (global.processedMessages.has(msgId)) {
            return res.sendStatus(200);
        }

        global.processedMessages.add(msgId);

        const from = msg.from;
        const text = msg.text.body;
        await saveMessage(from, "user", text);
        const lowerText = text.toLowerCase();

if (
    lowerText.includes("image") ||
    lowerText.includes("photo") ||
    lowerText.includes("picture")
) {

    const imageUrl = await getImageUrl(text);

    if (imageUrl) {

        await axios.post(
            `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: "whatsapp",
                to: from,
                type: "image",
                image: {
                    link: imageUrl
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );

        return res.sendStatus(200);
    }
}

        const reply = await getAIReply(text, from);
       
        // Save AI reply to Supabase
await saveMessage(
  from,
  "assistant",
  reply
);

        if (!reply || reply.trim() === "") {
            return res.sendStatus(200);
        }

        await axios.post(
            `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: "whatsapp",
                to: from,
                text: { body: reply }
            },
            {
                headers: {
                    Authorization: `Bearer ${ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("✅ REPLY SENT");

        res.sendStatus(200);

    } catch (err) {
        console.log("🔥 WEBHOOK ERROR:", err.response?.data || err.message);
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
