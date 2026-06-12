require("dotenv").config();
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
            "https://api-inference.huggingface.co/models/microsoft/DialoGPT-medium",
            {
                inputs: text
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.HF_API_KEY}`
                }
            }
        );

        return response.data.generated_text || "No response";
    } catch (err) {
        console.log("AI ERROR:", err.message);
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
const ACCESS_TOKEN = "YOUR_WHATSAPP_ACCESS_TOKEN";
const PHONE_NUMBER_ID = "YOUR_PHONE_NUMBER_ID";

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
    console.log("🔥 MESSAGE RECEIVED:", JSON.stringify(req.body, null, 2));

    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (msg) {
        const from = msg.from;
        const text = msg.text?.body;

        try {
            const reply = await getAIReply(text);

            await axios.post(
                `https://api-inference.huggingface.co/models/microsoft/DialoGPT-medium`,
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

        } catch (err) {
            console.log("🔥 BOT ERROR:", err.message);
        }
    }

    res.sendStatus(200);
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("🚀 Server running on port", PORT);
});