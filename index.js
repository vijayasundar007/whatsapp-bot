require("dotenv").config();

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const express = require("express");
const axios = require("axios");


const app = express();
app.use(express.json());

/* =========================
   FREE AI FUNCTION (HUGGINGFACE)
========================= */
async function getAIReply(text) {
    try {
        const response = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                model: "openai/gpt-3.5-turbo",   // ✅ SAFE MODEL
                messages: [
                    { role: "user", content: text }
                ]
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
        const entry = req.body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;

        const msg = value?.messages?.[0];
        let processedMessages = new Set();

if (processedMessages.has(msg.id)) return;
processedMessages.add(msg.id);

        if (!msg) {
            return res.sendStatus(200);
        }

        const from = msg.from;   // 👈 RECEIVER (user who sent message)
        const text = msg.text?.body;

        console.log("FROM USER:", from);
        console.log("TEXT:", text);

        const reply = await getAIReply(text);
        if (!reply) reply = "Sorry, I didn't understand.";

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

        res.sendStatus(200);

    } catch (err) {
        console.log("WEBHOOK ERROR:", err.message);
        res.sendStatus(200);
    }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("🚀 Server running on port", PORT);
});