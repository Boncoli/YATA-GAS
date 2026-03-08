// tasks/do-debug-report.js
const path = require('path');

// 1. 環境変数の読み込み (.env)
require('dotenv').config();

// 2. GAS Bridge と YATA Loader の読み込み
// これにより lib/YATA.js 内の関数がグローバルに展開されます
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

async function main() {
  const keyword = process.env.DEBUG_REPORT_KEYWORD || "がん";
  const days = process.env.DEBUG_REPORT_DAYS || "7";

  console.log("--- YATA Debug Personal Report Task Start ---");
  console.log(`Target Keyword: ${keyword}`);
  console.log(`Lookback Days: ${days}`);
  console.log(`Recipient (MAIL_TO): ${process.env.MAIL_TO}`);
  console.log("---------------------------------------------");

  try {
    // lib/YATA.js 内の関数を呼び出し
    // 内部で process.env.DEBUG_REPORT_KEYWORD 等を参照するように修正済み
    debugPersonalReport();

    console.log("\n✅ Debug report task execution finished.");
    console.log("Check your email (MAIL_TO) or logs for the result.");

  } catch (e) {
    console.error("\n❌ Error during debug report generation:", e);
  }

  console.log("--- YATA Debug Personal Report Task Finished ---");
}

main().catch(console.error);
