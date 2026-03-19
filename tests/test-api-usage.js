// tests/test-api-usage.js
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

async function run() {
  console.log("=== API Usage Test Start ===");
  try {
    const prompt = "あなたはAIアシスタントです。1行で自己紹介してください。";
    console.log("Prompt:", prompt);
    
    // YATAのLlmServiceを使ってAIに投げる
    const response = LlmService.analyzeKeywordSearch("あなたはAIアシスタントです", prompt, {
      model: AppConfig.get().Llm.ModelNano, // gpt-5-nano を使用
      temperature: 0.7
    });

    console.log("Response:", response);
    console.log("=== API Usage Test Finished ===");
  } catch (e) {
    console.error("Error:", e);
  }
}

run();
