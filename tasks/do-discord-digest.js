// tasks/do-discord-digest.js
const path = require('path');
const fs = require('fs');

// GAS Bridge と YATA Loader の読み込み
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

async function main() {
  console.log("--- Discord Daily Digest Start ---");

  // 1. 昨日の日付範囲を計算 (0:00:00 - 23:59:59)
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  
  const start = new Date(yesterday);
  start.setHours(0, 0, 0, 0);
  
  const end = new Date(yesterday);
  end.setHours(23, 59, 59, 999);

  console.log(`Target Period: ${start.toLocaleString()} - ${end.toLocaleString()}`);

  // 2. DBから記事を取得 (gas-bridge経由でSQLiteを参照)
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("collect");
  const allArticles = sheet.getDataRange().getValues();
  // ヘッダーを除去し、日付でフィルタリング
  const yesterdayArticles = allArticles.slice(1).filter(row => {
    const articleDate = row[0] instanceof Date ? row[0] : new Date(row[0]);
    return articleDate >= start && articleDate <= end;
  }).map(row => ({
    date: row[0],
    title: row[1],
    url: row[2],
    abstract: row[3],
    summary: row[4],
    source: row[5]
  }));

  if (yesterdayArticles.length === 0) {
    console.log("No articles found for yesterday. Skipping Discord post.");
    return;
  }

  console.log(`Found ${yesterdayArticles.length} articles.`);

  // 3. LLMでDiscord用サマリーを生成
  // BATCH_SYSTEMなどのプロンプトは gas-bridge 経由で prompts.json から読み込まれる
  const promptList = yesterdayArticles.map(a => `- ${a.title} (${a.url})\n  要約: ${a.summary || a.abstract}`).join("\n\n");
  
  const systemPrompt = getPromptConfig("DISCORD_DIGEST_SYSTEM");
  const userPrompt = getPromptConfig("DISCORD_DIGEST_USER").replace("{article_list}", promptList);

  if (!systemPrompt || !userPrompt) {
    console.error("Discord prompts not found in prompts.json");
    return;
  }

  console.log("Generating Discord summary via LLM...");
  // LlmService は yata-loader によってグローバル展開されている
  const summary = LlmService.analyzeKeywordSearch(systemPrompt, userPrompt, { 
    temperature: 0.0 // 正確性を重視
  });

  if (!summary) {
    console.error("Failed to generate summary.");
    return;
  }

  // 4. Discord Webhook に送信
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("DISCORD_WEBHOOK_URL not found in .env");
    return;
  }

  console.log("Sending to Discord...");
  const payload = JSON.stringify({
    content: `📢 **【YATA】昨日のバイオ・臨床検査ニュースハイライト**

${summary}`
  });

  const response = UrlFetchApp.fetch(webhookUrl, {
    method: "post",
    contentType: "application/json",
    payload: payload
  });

  if (response.getResponseCode() === 204 || response.getResponseCode() === 200) {
    console.log("✅ Successfully posted to Discord.");
  } else {
    console.error(`❌ Failed to post to Discord. Status: ${response.getResponseCode()}`);
  }

  console.log("--- Discord Daily Digest Finished ---");
}

function getPromptConfig(key) {
  // YATA.js 内の getPromptConfig と同等のロジック
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("prompt");
  const values = sheet.getDataRange().getValues();
  const map = new Map(values.map(r => [String(r[0]).trim(), r[1]]));
  return map.get(key) ? String(map.get(key)).trim() : null;
}

main().catch(console.error);
