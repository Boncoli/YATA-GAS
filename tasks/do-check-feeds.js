// tasks/do-check-feeds.js
// RSSフィードの完全診断（改良版）を実行するタスク
// YATA.jsの testAllRssFeeds() を呼び出します。

require('../lib/gas-bridge.js'); // GAS互換環境のロード
require('../lib/yata-loader.js'); // YATA.js本体のロード

console.log("=== RSS詳細診断モード（改良版）を開始します ===");

if (typeof testAllRssFeeds === 'function') {
  try {
    testAllRssFeeds();
  } catch (e) {
    console.error("❌ 診断中にエラーが発生しました:", e);
  }
} else {
  console.error("❌ 関数 'testAllRssFeeds' が見つかりません。最新のYATA.jsが同期されているか確認してください。");
}

console.log("=== 詳細診断完了 ===");
