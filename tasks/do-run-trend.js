// tasks/run-personalized-report.js
/**
 * YATA 正規フロー: パーソナライズ・レポート配信タスク (ローカル版)
 * 
 * 本家の sendPersonalizedReport() をそのまま実行します。
 * 設定は .env (USER_KEYWORDS, DAILY_REPORT_ENABLED 等) を参照します。
 */

const path = require('path');

// 1. 環境変数の読み込み (.env)
require('dotenv').config();

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

  if (process.env.DAILY_REPORT_ENABLED !== "TRUE") {
    console.warn("⚠️  DAILY_REPORT_ENABLED is not TRUE. Task will skip report generation.");
    return;
  }

  try {
    // lib/YATA.js の本家メイン関数をそのまま（引数なしで）呼び出し
    // ブリッジ側が DRY_RUN を参照して履歴保存をスキップします
    sendPersonalizedReport();

    console.log("\n✅ Personalized report task (Normal Flow) finished.");
    console.log("History in DB/Memory remains untouched (Handled by GAS Bridge).");

  } catch (e) {
    console.error("\n❌ Error during personalized report generation:", e);
  }

  console.log("--- YATA Personalized Report Task Finished ---");
}

main().catch(console.error);
