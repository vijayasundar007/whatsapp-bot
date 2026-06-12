const axios = require("axios");

async function test() {
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=YOUR_API_KEY`,
      {
        contents: [
          {
            parts: [{ text: "Hello" }]
          }
        ]
      }
    );

    console.log(res.data);
  } catch (err) {
    console.log("ERROR:");
    console.log(err.response?.data || err.message);
  }
}

test();