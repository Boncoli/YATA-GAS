// tasks/do-send-report.js
const path = require('path');

// GAS Bridge と YATA Loader の読み込み
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

async function main() {
  console.log("--- AI Weekly Summary Task Start ---");

  try {
    // 1. 過去7日分のハイライト履歴を history テーブルから取得
    const now = new Date();
    const weekAgo = new Date(now);
    weekAgo.setDate(now.getDate() - 7);

    console.log(`Searching history from: ${weekAgo.toLocaleString()}`);

    const historySheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("history");
    const allHistory = historySheet.getDataRange().getValues();
    
    // ヘッダーを除去し、期間内の DISCORD_DIGEST を抽出
    const digestHistory = allHistory.slice(1).filter(row => {
      const date = row[0] instanceof Date ? row[0] : new Date(row[0]);
      return date >= weekAgo && row[1] === "DISCORD_DIGEST";
    }).map(row => {
      const date = row[0] instanceof Date ? row[0] : new Date(row[0]);
      return `【${date.toLocaleDateString('ja-JP')}のハイライト】\n${row[2]}`;
    }).join("\n\n---\n\n");

    if (!digestHistory) {
      console.log("No history found for the past week. Skipping weekly report.");
      return;
    }

    console.log("Found history records. Generating weekly summary via LLM...");

    // 2. LLM で週刊総集編を生成
    const systemPrompt = getPromptConfig("WEEKLY_SUMMARY_SYSTEM");
    const userPrompt = getPromptConfig("WEEKLY_SUMMARY_USER").replace("{digest_history}", digestHistory);

    if (!systemPrompt || !userPrompt) {
      console.error("Weekly summary prompts not found in prompts.json");
      return;
    }

    // LlmService を使用 (yata-loader によりグローバル展開済み)
    const weeklySummaryMd = LlmService.analyzeKeywordSearch(systemPrompt, userPrompt, { 
      temperature: 0.3 // 少し表現力を豊かに
    });

    if (!weeklySummaryMd) {
      console.error("Failed to generate weekly summary.");
      return;
    }

    // 3. 自分宛にメール送信
    const mailTo = process.env.MAIL_TO;
    if (!mailTo) {
      console.error("MAIL_TO not found in .env");
      return;
    }

    const subject = `【YATA-WEEKLY】今週のバイオ・臨床検査ニュース総集編 (${now.toLocaleDateString('ja-JP')})`;
    
    console.log(`Sending weekly report to: ${mailTo}`);
    
    // GmailApp は gas-bridge でフックされており、実際の設定があれば送信されます
    GmailApp.sendEmail(mailTo, subject, weeklySummaryMd);

    // 4. 非同期送信の完了を待つ (念のため)
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log("✅ Weekly report task completed.");

  } catch (e) {
    console.error("Error during weekly report generation:", e);
  }

  console.log("--- AI Weekly Summary Task Finished ---");
}

function getPromptConfig(key) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("prompt");
  const values = sheet.getDataRange().getValues();
  const map = new Map(values.map(r => [String(r[0]).trim(), r[1]]));
  return map.get(key) ? String(map.get(key)).trim() : null;
}

main().catch(console.error);
