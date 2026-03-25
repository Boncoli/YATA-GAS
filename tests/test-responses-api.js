require('dotenv').config();
const apiKey = process.env.OPENAI_API_KEY;

async function test() {
  const payload = {
    model: "gpt-4o-mini",
    input: [
      { role: "user", content: "Say 'Hello' and nothing else." }
    ]
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  const jsonStr = await res.text();
  console.log("Status:", res.status);
  console.log("Raw Response:");
  console.log(jsonStr);
  
  try {
    const json = JSON.parse(jsonStr);
    console.log("\nKeys in response:", Object.keys(json));
    if (json.usage) {
      console.log("\nUsage object:", json.usage);
    } else {
      console.log("\n❌ NO USAGE OBJECT FOUND!");
    }
  } catch(e) {}
}

test();
