// tasks/run-daily-report.js
/**
 * YATA 正規フロー: デイリー・ダイジェスト配信タスク (ローカル版)
 * 
 * 本家の dailyDigestJob() をそのまま実行します。
 * 全記事を対象とした重要トピックの要約レポートを生成します。
 */

const path = require('path');

// 1. 環境変数の読み込み (.env)
require('dotenv').config();

// 2. GAS Bridge と YATA Loader の読み込み
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

async function main() {
  console.log("--- YATA Daily Digest Job (Normal Flow) Start ---");
  console.log(`Daily Trigger Enabled: ${process.env.DAILY_REPORT_ENABLED === "TRUE" ? "YES" : "NO"}`);
  console.log(`Dry Run Mode: ${process.env.DRY_RUN === "TRUE" ? "ON" : "OFF"}`);
  console.log(`Recipient (MAIL_TO): ${process.env.MAIL_TO}`);
  console.log("--------------------------------------------------");

  if (process.env.DAILY_REPORT_ENABLED !== "TRUE") {
    console.warn("⚠️  DAILY_REPORT_ENABLED is not TRUE. Task will skip report generation.");
    return;
  }

  try {
    // lib/YATA.js の本家デイリー配信メイン関数をそのまま（引数なしで）呼び出し
    // ブリッジ側が DRY_RUN を参照して履歴保存をスキップします
    dailyDigestJob();

    console.log("\n✅ Daily digest job finished.");
    console.log("History in DB/Memory remains untouched (Handled by GAS Bridge).");

  } catch (e) {
    console.error("\n❌ Error during daily digest job:", e);
  }

  console.log("--- YATA Daily Digest Job Finished ---");
}

main().catch(console.error);
