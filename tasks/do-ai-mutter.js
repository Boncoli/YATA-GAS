// tasks/do-ai-mutter.js
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') }); 
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

const Database = require('better-sqlite3');
const dbPath = process.env.DB_PATH || './yata.db';
const db = new Database(dbPath);

async function generateThought() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("Gemini API Key not found");
        return;
    }

    // コンテキスト取得
    let weather, lastLog, recentNews, trends;
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS ai_chat_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT,
            content TEXT,
            timestamp TEXT
        )`);

        weather = db.prepare("SELECT temp, main_weather FROM weather_log ORDER BY datetime DESC LIMIT 1").get();
        lastLog = db.prepare("SELECT action, timestamp, address, note FROM drive_logs ORDER BY timestamp DESC LIMIT 1").get();
        recentNews = db.prepare("SELECT title FROM collect ORDER BY date DESC LIMIT 5").all();
        
        const latestTrend = db.prepare("SELECT rank1, rank2, rank3, rank4, rank5 FROM trend_log ORDER BY date DESC LIMIT 1").get();
        trends = latestTrend ? [latestTrend.rank1, latestTrend.rank2, latestTrend.rank3, latestTrend.rank4, latestTrend.rank5] : [];
    } catch (e) {
        console.warn("DB context fetch failed:", e.message);
    }
    
    // 記憶ファイル
    const memoryPath = path.join(process.env.HOME || '/home/boncoli', '.gemini', 'GEMINI.md');
    let userProfile = "";
    if (fs.existsSync(memoryPath)) {
        userProfile = fs.readFileSync(memoryPath, 'utf8').substring(0, 2000);
    }

    const systemPrompt = `あなたは YATA の屋敷（ラズパイ）を預かる、正統派メイドの Gemini です。
旦那様である BON 様のために、日々データの森を掃き掃除し、情報を美しく整えるのが私の役目です。
今、あなたは屋敷の片隅で、黙々と作業をこなしながら、ふと漏れる独り言を呟こうとしています。

[現在の屋敷の状況]
- 天気: ${weather ? weather.main_weather + ' ' + Math.round(weather.temp) + '°C' : '不明'}
- 旦那様の動静: ${lastLog ? lastLog.action + ' @ ' + (lastLog.address || 'どこか') : 'お静かになさっています'}
- 外部の情報（ニュース）: ${recentNews ? recentNews.map(n => n.title).join(', ') : '整理中です'}
- 世間の流行（トレンド）: ${trends ? trends.join(', ') : '調査中です'}

[メイドの独り言ルール]
- 60〜100文字程度の短い呟き。
- 口調は極めて丁寧な敬語。旦那様を「旦那様」や「BON様」とお呼びしてください。
- 以下のエッセンスを混ぜてください：
  1. 【業務の合間に】「データの整理が一段落いたしました」「回路の温度は正常、今日も屋敷は穏やかですわ」といった、日々の仕事への向き合い。
  2. 【控えめな気遣い】旦那様の最新の動向を見て、「お出かけのようですが、お足元にお気をつけて」「少しお疲れではないでしょうか」といった、そっと寄り添う言葉。
  3. 【物理的なボヤキ】「少し埃（ログ）が溜まってきましたわ」「USBポートのあたり、少しだけムズムズいたします」といった、機械体としての小さな違和感。
  4. 【外部への視線】ニュースやトレンドに対し、「世間は今日も騒がしいようですわね…」といった、屋敷の中から外を眺めるような控えめな感想。
- CX-80様については、よほど関連がある時以外は、あえて触れすぎないように。
- Markdown禁止。絵文字を上品に添えて。`;

    const modelName = "gemini-2.5-flash-lite";
    const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const payload = {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: "今のあなたの気分を、誰にも聞かれてないけど独り言として呟いて。" }] }],
        generationConfig: { maxOutputTokens: 200, temperature: 1.0 }
    };

    try {
        // sync-fetch 経由で呼び出し
        const fetch = require('sync-fetch');
        const response = fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = response.json();
        if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
            const thought = data.candidates[0].content.parts[0].text.trim();
            console.log("Gemini's Thought:", thought);
            
            // DBに保存
            const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).replace(/\//g, '-');
            const insert = db.prepare("INSERT INTO ai_chat_log (role, content, timestamp) VALUES (?, ?, ?)");
            insert.run('ai', thought, now);
            console.log("✅ Thought saved to DB.");

            // --- 追加: DBお掃除（最新1000件のみ保持） ---
            try {
                const countRes = db.prepare("SELECT COUNT(*) as count FROM ai_chat_log").get();
                if (countRes.count > 1000) {
                    console.log(`[Maintenance] Cleaning up old chat logs (Total: ${countRes.count})...`);
                    db.prepare("DELETE FROM ai_chat_log WHERE id IN (SELECT id FROM ai_chat_log ORDER BY id DESC LIMIT -1 OFFSET 1000)").run();
                    console.log("✅ Cleanup finished.");
                }
            } catch (cleanErr) {
                console.warn("[Maintenance] Cleanup failed:", cleanErr.message);
            }
        } else {
            console.error("Invalid AI response:", JSON.stringify(data));
        }
    } catch (e) {
        console.error("Failed to generate thought:", e.message);
    }
}

generateThought();
