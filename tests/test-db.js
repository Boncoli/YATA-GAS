require('./YATA.js');

console.log("=== SQLite 書き込みテスト ===");

// 1. ログのテスト
const logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('log');
logSheet.appendRow([new Date().toISOString(), "INFO", "ラズパイからのデータベース書き込みテストです。"]);

// 2. データのテスト (YATAの標準的な記事保存形式)
const dataSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('data');
dataSheet.appendRow([
  "test-id-001",           // ID
  new Date().toISOString(), // 日付
  "Test Source",           // ソース名
  "SQLite連携成功",         // タイトル
  "https://example.com",   // URL
  "これはテスト保存です。",   // 要約
  "TestCategory",          // カテゴリ
  "Kobe-West-RPi5"         // キーワード
]);

console.log("書き込み処理が完了しました。");