require('../lib/yata-loader.js');
console.log("=== OpenAI 設定確認 ===");
const config = AppConfig.get().Llm; // Llmセクションを取得

console.log("Context (PERSONALならOK):", AppConfig.get().Llm.Context);
console.log("OpenAiKey (個人用):", config.OpenAiKey ? "✅ 設定あり" : "❌ 未設定");
console.log("ModelNano (OpenAIモデル名):", config.ModelNano);