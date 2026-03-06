require('dotenv').config();
const Database = require('better-sqlite3');
const https = require('https');

// DBを開く（環境変数があればそれを使用、なければRAMディスク）
const dbPath = process.env.DB_PATH || '/dev/shm/yata.db';
const db = new Database(dbPath);

// コマンドライン引数からテキストを取得
const rawText = process.argv[2];

if (!rawText) {
  console.error("エラー: テキストが指定されていません。");
  process.exit(1);
}

// 挨拶や極端に短い感嘆詞だけの場合は分析をスキップしてそのまま保存（コスト削減）
const skipAnalysisWords = ["おはよう", "おはようございます", "おやすみ", "はい", "うん", "あー", "えーと"];
const shouldSkipAnalysis = rawText.length <= 10 && skipAnalysisWords.some(w => rawText.includes(w));

function callGeminiApi(prompt) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`);
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 }
    });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`API Request failed: ${res.statusCode} ${data}`));
        }
      });
    });

    req.on('error', (e) => { reject(e); });
    req.write(payload);
    req.end();
  });
}

async function processMutter() {
  try {
    let analysisJson = "{}";

    if (!shouldSkipAnalysis) {
      console.log(`[AI分析中] "${rawText}"...`);
      
      const prompt = `
以下のテキストは、ユーザーが日常の中で発した「独り言」です。
この独り言から、ユーザーの現在の「感情(emotion)」「関心・思考の対象(interest)」「次に起こしそうな行動(next_action)」を推測し、JSON形式で出力してください。
JSONのみを出力し、マークダウン記法（\`\`\`json など）は絶対に含めないでください。

独り言: "${rawText}"

出力形式:
{
  "emotion": "疲労",
  "interest": "夕食の献立",
  "next_action": "休憩する、または食事の準備をする"
}
`;
      
      const jsonResponse = await callGeminiApi(prompt);
      let responseText = jsonResponse.candidates[0].content.parts[0].text.trim();
      
      // 不要なマークダウンを除去
      responseText = responseText.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
      
      // JSONとしてパースできるか確認
      JSON.parse(responseText);
      analysisJson = responseText;
      console.log(`[分析完了] ${analysisJson}`);
    } else {
      console.log(`[分析スキップ] 短い挨拶・感嘆詞のためAI分析をスキップします。`);
    }

    // DBへ保存
    const stmt = db.prepare(`INSERT INTO mutter_logs (raw_text, analysis_json) VALUES (?, ?)`);
    stmt.run(rawText, analysisJson);
    console.log("✅ DBへ保存完了");

  } catch (error) {
    console.error("❌ エラーが発生しました:", error.message);
    // エラー時でも生テキストだけは保存を試みる
    try {
      const stmt = db.prepare(`INSERT INTO mutter_logs (raw_text, analysis_json) VALUES (?, ?)`);
      stmt.run(rawText, JSON.stringify({ error: error.message }));
      console.log("⚠️ エラー情報を付与してDBへ保存しました");
    } catch(e) {
      console.error("DB保存にも失敗しました:", e);
    }
  } finally {
    db.close();
    process.exit(0);
  }
}

processMutter();
