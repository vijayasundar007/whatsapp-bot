require("dotenv").config();
const express = require("express");
const axios = require("axios");
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

const app = express();
app.use(express.json());

/* =========================
   FREE AI FUNCTION (HUGGINGFACE)
========================= */
async function getAIReply(text) {
    try {
        const response = await axios.post(
    {
        messaging_product: "whatsapp",
        to: from,
        text: { body: reply }
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
const ACCESS_TOKEN = "EAAfCHL8qDZBEBRlZClRJ7bAasZCDo8QHGuYIvEC4bvnZA8sD4KaZAiafTp7WrQzWSrn6aJb9QEQxTqiOADHjlDw21U6ogfdtsXxDbQpw5TJEvz8KfJLXglat0E6JqintujbYboUvrvRZARIZBpvZCZC2YTQZAVp8Kwbg70qnDiUmZA5lAOl4ZA8tE32cDWZAsyVBA2wZDZD";
const PHONE_NUMBER_ID = "1149930188205694";

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
        const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

        if (!msg) return res.sendStatus(200);

        const from = msg.from;
        const text = msg.text?.body;

        const reply = await getAIReply(text);

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
        console.log("🔥 BOT ERROR:", err.message);
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