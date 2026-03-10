// tasks/run-personalized-report.js
/**
 * YATA 正規フロー: パーソナライズ・レポート配信タスク (ローカル版)
 * 
 * 本家の sendPersonalizedReport() をそのまま実行します。
 * 設定は .env (USER_KEYWORDS, DAILY_REPORT_ENABLED 等) を参照します。
 */

const path = require('path');

// 1. 環境変数の読み込み (.env)
require('dotenv').config({ override: true });

// 2. GAS Bridge と YATA Loader の読み込み
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

async function main() {
  console.log("--- YATA Personalized Report Task (Normal Flow) Start ---");
  console.log(`User Keywords: ${process.env.USER_KEYWORDS || "(None)"}`);
  console.log(`Semantic Search: ${process.env.USE_SEMANTIC === "TRUE" ? "ON" : "OFF"}`);
  console.log(`Daily Trigger: ${process.env.DAILY_REPORT_ENABLED === "TRUE" ? "ENABLED" : "DISABLED"}`);
  console.log(`Recipient (MAIL_TO): ${process.env.MAIL_TO}`);
  console.log("---------------------------------------------------------");

  // process.env.DAILY_REPORT_ENABLED の事前チェックは外す（強制実行するため）

  try {
    // 【重要】本家 YATA の仕様では、「日刊KWダイジェスト」が ON (TRUE) のユーザーには
    // トレンドレポートを送信しない（重複防止のための排他制御）。
    // ローカルで意図的にこのトレンドレポートを実行するため、
    // ブリッジ (gas-bridge.js) に渡る環境変数を一時的に FALSE に上書きし、スキップ判定を回避する。
    process.env.DAILY_REPORT_ENABLED = "FALSE";

    // lib/YATA.js の本家メイン関数をそのまま呼び出し
    // 日数は YATA.js 内部のステートフルロジック（PropertiesService）により自動的に
    // 「前回実行時からの差分（毎日実行なら約24時間）」が計算されます。
    sendPersonalizedReport();

    console.log("\n✅ Personalized report task (Normal Flow) finished.");
    console.log("History in DB/Memory remains untouched (Handled by GAS Bridge).");

  } catch (e) {
    console.error("\n❌ Error during personalized report generation:", e);
  }

  console.log("--- YATA Personalized Report Task Finished ---");
}

main().catch(console.error);
