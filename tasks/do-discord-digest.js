// tasks/do-discord-digest.js
const path = require('path');
const fs = require('fs');

// GAS Bridge と YATA Loader の読み込み
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

async function updateInterestProfile() {
  const dbPath = process.env.DB_PATH || './yata.db';
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  const articles = db.prepare("SELECT title, summary FROM collect WHERE clicks > 0 ORDER BY date DESC LIMIT 30").all();
  const model = process.env.OPENAI_MODEL_NANO || "gpt-5-nano";
  if (articles.length === 0) return null;

  const articleText = articles.map(a => "Title: " + a.title + "\nSummary: " + a.summary).join("\n\n---\n\n");
  const prompt = `あなたはプロのパーソナル・アナリストです。以下の記事リストを分析し、ユーザーの興味関心を抽出してJSONで出力してください。\n\n${articleText}`;
  const apiKey = process.env.OPENAI_API_KEY_PERSONAL;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model: model, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" }, reasoning_effort: "minimal" })
    });
    const json = await response.json();
    const result = json.choices[0].message.content;
    fs.writeFileSync(path.join(__dirname, '../interests.json'), result);
    return JSON.parse(result);
  } catch (e) { return null; }
}

function computeScore(article, interestsData) {
  if (!interestsData || !interestsData.interests) return 0;
  let score = 0;
  const text = (article.title + " " + (article.summary || "")).toLowerCase();
  interestsData.interests.forEach(interest => {
    if (interest && interest.keywords) {
      interest.keywords.forEach(kw => { if (text.includes(kw.toLowerCase())) score += (interest.weight || 0.5) * 10; });
    }
  });
  return score;
}

function computeTopicScore(article, interest) {
  let score = 0;
  if (!interest || !interest.keywords) return 0;
  const text = (article.title + " " + (article.summary || "")).toLowerCase();
  interest.keywords.forEach(kw => { if (text.includes(kw.toLowerCase())) score += (interest.weight || 0.5) * 10; });
  return score;
}

async function main() {
  console.log("--- Discord Daily Digest Start ---");
  const interestsData = await updateInterestProfile();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("collect");
  const candidates = sheet.getDataRange().getValues().slice(1).map(row => ({
    date: row[0] instanceof Date ? row[0] : new Date(row[0]),
    title: row[1], url: row[2], abstract: row[3], summary: row[4], source: row[5]
  })).filter(a => a.date >= dayAgo);

  if (candidates.length === 0) return;

  console.log(`[Screening] Total candidates: ${candidates.length}. Selecting balanced list...`);
  const TOTAL_TARGET_COUNT = 10;
  const selectedMap = new Map();
  const allocations = [];

  if (interestsData && interestsData.interests) {
    const totalWeight = interestsData.interests.reduce((sum, i) => sum + (i.weight || 0.1), 0);
    interestsData.interests.forEach(interest => {
      const targetCount = Math.max(1, Math.round(TOTAL_TARGET_COUNT * ((interest.weight || 0.1) / totalWeight)));
      allocations.push({ topic: interest.topic, count: targetCount });
      
      const topicArticles = candidates.map(a => ({ ...a, topicScore: computeTopicScore(a, interest) }))
        .filter(a => a.topicScore > 0).sort((a, b) => b.topicScore - a.topicScore).slice(0, 10);
      
      topicArticles.forEach(a => { if (selectedMap.size < 50) selectedMap.set(a.url, a); });
    });
  }

  // もし足らなければ全体スコアで補完
  if (selectedMap.size < 50) {
    const remaining = candidates.filter(a => !selectedMap.has(a.url))
      .map(a => ({ ...a, score: computeScore(a, interestsData) }))
      .sort((a, b) => b.score - a.score);
    for (const a of remaining) { if (selectedMap.size >= 50) break; selectedMap.set(a.url, a); }
  }

  const finalArticles = Array.from(selectedMap.values());
  console.log(`✅ Screening completed. Selected ${finalArticles.length} articles.`);

  const allocationPrompt = allocations.map(a => `- ${a.topic}: ${a.count}件`).join("\n");
  const promptList = finalArticles.map(a => `- 【タイトル】: ${a.title}\n  【要約】: ${a.summary || a.abstract}\n  【URL】: ${a.url}`).join("\n\n");
  
  const userPrompt = `あなたはニュース編集者です。以下の【記事リスト】から、ユーザーの興味に基づき **合計 10件** のニュースを選んでください。
必ず 10件 をリストアップし、以下の【配分目標】を参考にしてください。

【配分目標】
${allocationPrompt}

【出力形式】
### カテゴリ・トピック名
(絵文字) **記事タイトル**
- ニュースの要点・解説（1〜2行、80文字程度に凝縮）
[元記事](ここに【URL】を正確に転記)

※ 各記事の間は空行を入れてください。

【記事リスト】
${promptList}`;

  console.log(`[Digest] Generating Discord summary (Target: 10 items)...`);
  const summary = LlmService.analyzeKeywordSearch("あなたは優秀なニュースエディターです。", userPrompt, { 
    temperature: 0.0, reasoning_effort: "medium"
  });

  if (!summary) return;
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;

  const payload = JSON.stringify({ content: `📢 **【YATA】ニュース・ハイライト (${new Date().toLocaleDateString()})**\n\n${summary}` });
  const response = UrlFetchApp.fetch(webhookUrl, { method: "post", contentType: "application/json", payload: payload });
  if (response.getResponseCode() === 200 || response.getResponseCode() === 204) {
    console.log("✅ Successfully posted to Discord.");
  }
}

main().catch(console.error);
