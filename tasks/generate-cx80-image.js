
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// nanobanana が期待する環境変数をセット
const API_KEY = process.env.GEMINI_API_KEY;
const OUTPUT_DIR = path.join(__dirname, '..', 'nanobanana-output');

async function generateImage() {
  if (!API_KEY) {
    console.error("[!] GEMINI_API_KEY not found in .env");
    return;
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log("[*] Initializing Gemini 2.5 Flash Image (Nano Banana)...");
  const genAI = new GoogleGenerativeAI(API_KEY);
  
  // nanobanana 拡張機能で定義されている最新モデル名
  const modelName = "gemini-2.5-flash-image";
  const model = genAI.getGenerativeModel({ model: modelName }); 

  const prompt = "A cinematic, cyberpunk-style wallpaper featuring a sleek Mazda CX-80 SUV driving along a scenic coastal road at sunset. The sky is a dramatic blend of orange, purple, and neon pink. The car has glowing emerald green accents (#00e676) and neon light reflections on its metallic body. In the background, a futuristic bridge (inspired by Akashi Kaikyo Bridge) with holographic neon lights spans across the sea. 8k, photorealistic details.";

  try {
    console.log("[*] Requesting Image Generation (Model: " + modelName + ")...");
    
    // 画像生成のリクエスト (APIの戻り値形式に注意)
    const result = await model.generateContent(prompt);
    const response = await result.response;
    
    console.log("[Success] API Response received.");
    
    const timestamp = new Date().getTime();
    const filename = `cx80_cyberpunk_${timestamp}.json`;
    fs.writeFileSync(path.join(OUTPUT_DIR, filename), JSON.stringify(response, null, 2));
    
    console.log(`[*] Response metadata saved to: ${filename}`);

  } catch (e) {
    console.error("[!] Generation failed: " + e.message);
    if (e.message.includes("not found")) {
      console.log("[?] Hint: The model '" + modelName + "' might be in limited preview or not available for your API key.");
    }
  }
}

generateImage();
