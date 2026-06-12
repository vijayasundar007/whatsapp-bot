require("dotenv").config();
const express = require("express");
const axios = require("axios");

const { GoogleGenerativeAI } = require("@google/generative-ai");
const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
    model: "/gemini-2.5-flash"
});



app.use((req, res, next) => {
    console.log("🔥 REQUEST:", req.method, req.url);
    next();
});

app.get("/", (req, res) => {
    res.send("🤖 WhatsApp Bot is Running Successfully!");
});

const VERIFY_TOKEN = "my_verify_token";
const ACCESS_TOKEN = "EAAfCHL8qDZBEBRiZBcGJ50ywZCn3ty39cyOScfhj7vZB3KZCs4BESl9enUwZCdX2LIH1WBe2fEfpQnncnWbchvnwSFWAZAR36eisy0ZAbQOYrziyh9qvrwUgIceSeFTFFfKTQVxEhCd4QTZBR6IwPP6QTB7coRogctqLn5xFfqSQY0fj8hwfh6ZCS9R3mAN1ZAvHwZDZD";
const PHONE_NUMBER_ID = "1149930188205694";

// GET (Webhook verification)
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token === VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }

    res.sendStatus(403);
});

// POST (Messages come here)
app.post("/webhook", async (req, res) => {

    console.log("🔥 MESSAGE RECEIVED:", JSON.stringify(req.body, null, 2));

    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (msg) {
        const from = msg.from;
        const text = msg.text?.body;

        try {
    const result = await model.generateContent("hello");
    const response = await result.response;
    const reply = response.text();

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

} catch (err) {
     console.log("🔥 GEMINI FULL ERROR:", JSON.stringify(err, null, 2));

    
}
    }

    res.sendStatus(200);
});
// START SERVER
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Server running on port", PORT);
});