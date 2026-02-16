require('../lib/yata-loader.js');

console.log("=== AI要約疎通テスト ===");
try {
  const testText = "ラズベリーパイ5で動作するAIニュース収集システム『YATA』のテスト実行です。この文章が要約されれば成功です。";
  
  // YATA.js 内の LlmService をそのまま呼び出す
  console.log("AIに送信中...");
  const summary = LlmService.summarize(testText, "summary_only");
  
  console.log("\n--- 要約結果 ---");
  console.log(summary);
  console.log("---------------");
  
} catch (e) {
  console.error("エラーが発生しました:", e);
}