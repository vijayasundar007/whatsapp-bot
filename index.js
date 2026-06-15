require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ---------------- SAVE MESSAGE ----------------
async function saveMessage(phone, role, content) {
  await supabase.from("conversations").insert([
    { phone, role, content }
  ]);
}

// ---------------- GET HISTORY ----------------
async function getHistory(phone) {
  const { data } = await supabase
    .from("conversations")
    .select("role, content")
    .eq("phone", phone)
    .order("created_at", { ascending: true })
    .limit(20);

  return data || [];
}

// ---------------- WHATSAPP IMAGE URL ----------------
async function getWhatsAppImageUrl(imageId) {
  const res = await axios.get(
    `https://graph.facebook.com/v19.0/${imageId}`,
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`
      }
    }
  );

  return res.data.url;
}

// ---------------- TEXT AI ----------------
async function getAIReply(text, phone) {
  const history = await getHistory(phone);

  const messages = [
    {
      role: "system",
      content:
        "You are a smart WhatsApp AI assistant. Be helpful, clear, and remember context."
    },
    ...history,
    {
      role: "user",
      content: text
    }
  ];

  const res = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: "openai/gpt-3.5-turbo",
      messages
    },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  return res.data.choices[0].message.content;
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
// ---------------- WEBHOOK ----------------
app.post("/webhook", async (req, res) => {
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];

    if (!msg) return res.sendStatus(200);

    const from = msg.from;

    // ================= IMAGE HANDLING =================
    if (msg.type === "image") {

    const imageId = msg.image.id;

    const imageUrl = await getWhatsAppImageUrl(imageId);

    // ✅ THIS MUST COME FIRST
    const imageBuffer = await downloadImage(imageUrl);

    // now this works
    const base64Image = imageBuffer.toString("base64");

    console.log("IMAGE SIZE:", imageBuffer.length);

    const aiRes = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
            model: "meta-llama/llama-3.2-11b-vision-instruct",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Describe this image clearly"
                        },
                        {
                            type: "text",
                            text: base64Image
                        }
                    ]
                }
            ]
        },
        {
            headers: {
                Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            }
        }
    );

    const aiReply = aiRes.data.choices[0].message.content;

    await axios.post(
        `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
        {
            messaging_product: "whatsapp",
            to: msg.from,
            text: { body: aiReply }
        },
        {
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`
            }
        }
    );

    return res.sendStatus(200);
}

    // ================= TEXT HANDLING =================
    if (!msg.text?.body) return res.sendStatus(200);

    const text = msg.text.body;

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

    console.log("REPLY SENT");

    res.sendStatus(200);
  } catch (err) {
    console.log("ERROR:", err.response?.data || err.message);
    res.sendStatus(200);
  }
});

// ---------------- SERVER ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});