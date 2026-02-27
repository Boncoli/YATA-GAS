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
  
  // YouTubeキーワードの読み込み
  let youtubeKeywords = [];
  const takeoutPath = path.join(__dirname, '../data/takeout_keywords.json');
  if (fs.existsSync(takeoutPath)) {
    try {
      youtubeKeywords = JSON.parse(fs.readFileSync(takeoutPath, 'utf8'));
    } catch (e) { console.error("Failed to read takeout_keywords.json:", e); }
  }

  if (articles.length === 0 && youtubeKeywords.length === 0) return null;

  const articleText = articles.length > 0 
    ? articles.map(a => "Title: " + a.title + "\nSummary: " + a.summary).join("\n\n---\n\n")
    : "（最近のクリック記事はありません）";

  const prompt = `あなたはプロのパーソナル・アナリストです。
以下の「ユーザーが実際にクリックした記事リスト」と「YouTubeの活動履歴から抽出されたキーワード」を総合的に分析し、ユーザーの現在の興味関心を抽出して構造化されたJSON形式で出力してください。

【実際にクリックした記事】
${articleText}

【YouTube活動からのキーワード】
${youtubeKeywords.join(', ')}

【抽出のガイドライン】
1. YouTubeキーワードは長期的な嗜好やライフスタイル、クリック記事は短期的な関心事を示しています。これらを融合させてください。
2. 各トピックに対して、関心の強さ（weight: 0.1〜1.0）を付与してください。
3. YATA（ニュース収集ツール）でスコアリングに使用するため、各トピックに関連する「具体的なキーワード（keywords）」を5〜10個程度含めてください。
4. 最終的に、このユーザーがどのような人物であるか（persona）を1文でまとめてください。

【出力形式（厳守）】
{
  "interests": [
    { "topic": "トピック名", "weight": 0.9, "keywords": ["キーワード1", "キーワード2", ...], "reason": "理由" }
  ],
  "persona": "ユーザー像の要約"
}`;

  const apiKey = process.env.OPENAI_API_KEY_PERSONAL || process.env.OPENAI_API_KEY;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ 
        model: model, 
        messages: [{ role: "user", content: prompt }], 
        response_format: { type: "json_object" } 
      })
    });
    const json = await response.json();
    if (json.error) throw new Error(json.error.message);
    const result = json.choices[0].message.content;
    fs.writeFileSync(path.join(__dirname, '../interests.json'), result);
    console.log("✅ Interest profile updated with YouTube data.");
    return JSON.parse(result);
  } catch (e) { 
    console.error("Failed to update interest profile:", e);
    // 既存の interests.json があればそれを返す
    const existingPath = path.join(__dirname, '../interests.json');
    if (fs.existsSync(existingPath)) return JSON.parse(fs.readFileSync(existingPath, 'utf8'));
    return null; 
  }
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
  
  const userPrompt = `あなたは技術監査官、および専門ニュースエディターです。
提供された記事リストから重要なトピックを抽出し、新聞記事のような淡白で客観的な日本語で報告書を作成してください。

【編集方針】
1. 感情的な形容詞、主観的な推測、および過度な装飾は一切排除してください。
2. 専門用語は正確に維持し、事実関係を簡潔に記述すること。
3. 語尾は「だ・である」調、または体言止めとし、情報の密度を最大化してください。

【配分目標】
${allocationPrompt}

【出力形式】
### カテゴリ・トピック名
(絵文字) **記事タイトル**
- 事実に基づいた要旨（客観的事実、数値、具体的な成果を中心に2行程度で記述）
[元記事]({URL})

※ 各記事の間は空行を入れ、視認性を確保してください。

【記事リスト】
${promptList}`;

  console.log(`[Digest] Generating Discord summary (Target: 10 items)...`);
  // モデル名が gpt-5-mini 等の誤表記の場合に備え、環境変数をチェック
  const model = (process.env.OPENAI_MODEL_NANO === 'gpt-5-mini') ? 'gpt-4o-mini' : (process.env.OPENAI_MODEL_NANO || 'gpt-4o-mini');
  
  const summary = LlmService.analyzeKeywordSearch("あなたは客観的なニュースエディターです。", userPrompt, { 
    temperature: 0.0, reasoning_effort: "medium"
  });

  if (!summary) {
    console.error("❌ Failed to generate summary: LlmService returned empty.");
    return;
  }
  
  console.log(`[Digest] Summary generated (${summary.length} chars). Posting to Discord...`);

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL_DIGEST || process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("❌ Discord Webhook URL is not set.");
    return;
  }

  // Discordの2000文字制限に対応
  const MAX_LENGTH = 1900; // 余裕を持って
  const chunks = [];
  let currentPos = 0;
  while (currentPos < summary.length) {
    chunks.push(summary.substring(currentPos, currentPos + MAX_LENGTH));
    currentPos += MAX_LENGTH;
  }

  chunks.forEach((chunk, index) => {
    const prefix = index === 0 ? `📢 **【YATA】ニュース・ハイライト (${new Date().toLocaleDateString()})**\n\n` : `(続き - ${index + 1})\n\n`;
    const payload = JSON.stringify({ content: prefix + chunk });
    const response = UrlFetchApp.fetch(webhookUrl, { method: "post", contentType: "application/json", payload: payload });
    
    if (response.getResponseCode() === 200 || response.getResponseCode() === 204) {
      console.log(`✅ Successfully posted chunk ${index + 1}/${chunks.length} to Discord.`);
    } else {
      console.error(`❌ Failed to post chunk ${index + 1}. Status: ${response.getResponseCode()}, Response: ${response.getContentText()}`);
    }
  });
}

main().catch(console.error);
