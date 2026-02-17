const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// 環境設定
const dbPath = fs.existsSync('/dev/shm/yata.db') ? '/dev/shm/yata.db' : './yata.db';
const db = new Database(dbPath);

// 1. クリック済み記事の取得
const articles = db.prepare("SELECT title, summary FROM collect WHERE clicks > 0").all();

if (articles.length === 0) {
    console.log("クリックされた記事が見つかりませんでした。");
    process.exit(0);
}

// 記事リストを文字列化
const articleText = articles.map(a => "Title: " + a.title + "\nSummary: " + a.summary).join("\n\n---\n\n");

// 2. プロンプトの構築
const prompt = "あなたはプロのパーソナル・アナリストです。ユーザーが詳細解析（クリック）した以下の記事リストを分析し、ユーザーの「深層的な関心事」を抽出して構造化されたJSON形式で出力してください。\n\n" +
"【分析対象の記事リスト】\n" + articleText + "\n\n" +
"【抽出のガイドライン】\n" +
"1. 固有名詞、技術分野、ライフスタイル、地域性の4つの観点から多角的に分析してください。\n" +
"2. 各トピックに対して、関心の強さ（weight: 0.0〜1.0）を付与してください。\n" +
"3. そのトピックに関心があると判断した理由（reason）も簡潔に含めてください。\n" +
"4. 最終的に、このユーザーがどのような人物であるか（persona）を1文でまとめてください。\n\n" +
"【出力形式（厳守）】\n" +
"{\n" +
"  \"interests\": [\n" +
"    { \"topic\": \"トピック名\", \"weight\": 0.9, \"keywords\": [\"キーワード1\", \"キーワード2\"], \"reason\": \"理由\" }\n" +
"  ],\n" +
"  \"persona\": \"ユーザー像の要約\"\n" +
"}";

// 3. AI（OpenAI）へのリクエスト
const apiKey = process.env.OPENAI_API_KEY_PERSONAL;
const model = "gpt-5-mini"; // Miniに変更

async function analyze() {
    console.log("🚀 " + articles.length + "件の記事から関心を分析中... (" + model + ")");
    
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + apiKey,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: model,
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }
        })
    });

    const json = await response.json();
    if (json.error) {
        console.error("API Error:", json.error);
        return;
    }
    const result = json.choices[0].message.content;
    
    console.log("\n=== 抽出された関心プロファイル ===");
    console.log(result);
    
    fs.writeFileSync('interests_test.json', result);
    console.log("\n✅ 'interests_test.json' に保存しました。");
}

analyze().catch(console.error);
