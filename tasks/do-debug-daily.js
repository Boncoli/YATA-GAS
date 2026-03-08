// tasks/do-debug-daily.js
const path = require('path');

// 1. 環境変数の読み込み (.env)
require('dotenv').config();

// 2. GAS Bridge と YATA Loader の読み込み
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

async function main() {
  const days = process.env.DEBUG_REPORT_DAYS || "1";

  console.log("--- YATA Debug Daily Digest Task Start ---");
  console.log(`Target Period: Last ${days} day(s)`);
  console.log(`Recipient (MAIL_TO): ${process.env.MAIL_TO}`);
  console.log("---------------------------------------------");

  try {
    // lib/YATA.js 内の新設関数を呼び出し
    debugDailyDigest();

    console.log("\n✅ Daily digest debug task execution finished.");
    console.log("Check your email (MAIL_TO) or logs for the result.");

  } catch (e) {
    console.error("\n❌ Error during daily digest generation:", e);
  }

  console.log("--- YATA Debug Daily Digest Task Finished ---");
}

main().catch(console.error);
