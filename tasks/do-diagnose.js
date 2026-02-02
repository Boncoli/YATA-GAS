// tasks/do-diagnose.js
// RSSフィードの応答速度とステータスを診断するタスク
// YATA.jsの diagnoseRssLatency() を呼び出します。

require('../lib/gas-bridge.js'); // GAS互換環境のロード
require('../lib/yata-loader.js'); // YATA.js本体のロード

console.log("=== RSS診断モードを開始します ===");

if (typeof diagnoseRssLatency === 'function') {
  try {
    diagnoseRssLatency();
  } catch (e) {
    console.error("❌ 診断中にエラーが発生しました:", e);
  }
} else {
  console.error("❌ 関数 'diagnoseRssLatency' が見つかりません。YATA.jsに含まれているか確認してください。");
}

console.log("=== 診断完了 ===");
