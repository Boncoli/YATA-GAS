// tasks/do-send-report.js
const path = require('path');

// GAS Bridge と YATA Loader の読み込み
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

async function main() {
  console.log("--- AI Report Debug Task Start ---");

  try {
    // 1. プロパティの強制設定 (未設定エラー回避)
    const props = PropertiesService.getScriptProperties();
    props.setProperty("CONFIG_SHEET_ID", "dummy-config-id");
    props.setProperty("DATA_SHEET_ID", "dummy-data-id");

    // 2. シート取得の確認
    const usersSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Users");
    const users = usersSheet.getDataRange().getValues();
    console.log(`[Debug] Found ${users.length} rows in Users sheet.`);

    const kwSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Keywords");
    const kws = kwSheet.getDataRange().getValues();
    console.log(`[Debug] Found ${kws.length} rows in Keywords sheet.`);

    console.log("\nExecuting sendPersonalizedReport()...");
    // YATA.js のグローバル関数
    sendPersonalizedReport();

  } catch (e) {
    console.error("Error during report generation/sending:", e);
  }

  console.log("\n--- AI Report Debug Task Finished ---");
}

main().catch(console.error);
