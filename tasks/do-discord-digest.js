// tasks/do-discord-digest.js
const path = require('path');
const fs = require('fs');

// GAS Bridge と YATA Loader の読み込み
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

/**
 * ユーザーのクリック履歴から興味関心プロファイル(interests.json)を更新する
 */
async function updateInterestProfile() {
  const dbPath = process.env.DB_PATH || './yata.db';
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  
  const articles = db.prepare("SELECT title, summary FROM collect WHERE clicks > 0").all();
  if (articles.length === 0) return null;

  const articleText = articles.map(a => "Title: " + a.title + "\nSummary: " + a.summary).join("\n\n---\n\n");
  const prompt = "あなたはプロのパーソナル・アナリストです。ユーザーが詳細解析（クリック）した以下の記事リストを分析し、ユーザーの「深層的な関心事」を抽出して構造化されたJSON形式で出力してください。\n\n" +
    "【分析対象の記事リスト】\n" + articleText + "\n\n" +
    "【出力形式】\n" +
    "{\n" +
    "  \"last_updated\": \"" + new Date().toISOString() + "\",\n" +
    "  \"interests\": [{ \"topic\": \"トピック名\", \"weight\": 0.9, \"keywords\": [\"キーワード1\"], \"reason\": \"理由\" }],\n" +
    "  \"persona\": \"ユーザー像の要約\"\n" +
    "}";

  console.log(`[Interests] Analyzing ${articles.length} clicked articles via GPT-5 Mini...`);
  const apiKey = process.env.OPENAI_API_KEY_PERSONAL;
  
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5-mini",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" }
      })
    });
    const json = await response.json();
    const result = json.choices[0].message.content;
    fs.writeFileSync(path.join(__dirname, '../interests.json'), result);
    console.log("✅ Interest profile updated.");
    return JSON.parse(result);
  } catch (e) {
    console.error("❌ Interest update failed:", e.message);
    return null;
  }
}

async function main() {
  console.log("--- Discord Daily Digest Start ---");

  // 1. 関心プロファイルを更新
  const interestsData = await updateInterestProfile();

  // 2. 昨日の日付範囲を計算 (0:00:00 - 23:59:59)
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

  // --- ユーザーの興味プロファイルをプロンプトに追加 ---
  let interestProfile = "";
  if (interestsData) {
    interestProfile = `\n\n【ユーザーの興味関心プロファイル】\n${JSON.stringify(interestsData, null, 2)}\n\n上記プロファイルを考慮し、ユーザーが特に関心を持ちそうなニュースを優先的にピックアップし、その理由も織り交ぜて解説してください。`;
  }

  // 3. LLMでDiscord用サマリーを生成
  // BATCH_SYSTEMなどのプロンプトは gas-bridge 経由で prompts.json から読み込まれる
  const promptList = yesterdayArticles.map(a => `- ${a.title} (${a.url})\n  要約: ${a.summary || a.abstract}`).join("\n\n");
  
  const systemPrompt = getPromptConfig("DISCORD_DIGEST_SYSTEM");
  const userPrompt = getPromptConfig("DISCORD_DIGEST_USER").replace("{article_list}", promptList) + interestProfile;

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
    
    // history テーブルに保存 (週刊レポートのソースとして利用)
    try {
      const historySheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("history");
      // [Date, Keyword, Summary, Vector]
      historySheet.appendRow([new Date(), "DISCORD_DIGEST", summary, ""]);
      console.log("✅ Saved digest to history table.");
    } catch (e) {
      console.error("Failed to save to history:", e.message);
    }
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
