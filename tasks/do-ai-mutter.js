// tasks/do-ai-mutter.js
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '../.env') }); 
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

const Database = require('better-sqlite3');
const dbPath = process.env.DB_PATH || './yata.db';
const db = new Database(dbPath);

async function generateThought() {
    const apiKey = process.env.OPENAI_API_KEY_PERSONAL;
    const modelName = process.env.OPENAI_MODEL_NANO || "gpt-5-nano";
    if (!apiKey) return;

    // --- 1. 情報収集 ---
    let masterInfo = "ご静養中";
    let lastMutter = "";
    const now = new Date();
    const nowTime = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

    try {
        db.exec(`CREATE TABLE IF NOT EXISTS ai_chat_log (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, timestamp TEXT)`);
        
        // 旦那様の動静
        const l = db.prepare("SELECT action, address, note FROM drive_logs ORDER BY timestamp DESC LIMIT 1").get();
        if (l) masterInfo = `${l.action}${l.address ? ' @ ' + l.address : ''}${l.note ? ' (' + l.note + ')' : ''}`;
        
        // 直前の自分の呟き (自己参照用)
        const m = db.prepare("SELECT content FROM ai_chat_log WHERE role = 'ai' ORDER BY id DESC LIMIT 1").get();
        if (m) lastMutter = m.content;
    } catch (e) {}

    // --- 2. データの網羅的収集 ---
    let subInfo = "";
    try {
        const w = db.prepare("SELECT temp, main_weather FROM weather_log ORDER BY datetime DESC LIMIT 1").get();
        const cpu = execSync('vcgencmd measure_temp').toString().replace(/[^\d.]/g, '');
        const n = db.prepare("SELECT title FROM collect ORDER BY date DESC LIMIT 5").all();
        const t = db.prepare("SELECT rank1, rank2, rank3 FROM trend_log ORDER BY date DESC LIMIT 1").get();
        
        const weatherStr = w ? `${w.main_weather} ${Math.round(w.temp)}℃` : '不明';
        const newsStr = n.length > 0 ? n[Math.floor(Math.random()*n.length)].title : 'なし';
        const trendStr = t ? `${t.rank1}, ${t.rank2}` : 'なし';

        // 全情報を一つのコンテキストとして集約
        subInfo = `天気:${weatherStr}, CPU:${cpu}℃, トレンド:${trendStr}, 最新ニュース:${newsStr}`;
    } catch (e) { subInfo = "システム稼働中"; }
    
    // --- 3. プロンプト構成 (外部ファイルから読み込み) ---
    let personaConfig = "";
    try {
        personaConfig = fs.readFileSync(path.join(__dirname, '../persona.txt'), 'utf8');
    } catch (e) {
        personaConfig = "あなたは有能なアシスタントです。";
    }

    const promptBody = `[現在の環境状況]
${subInfo}

[旦那様の動静]
${masterInfo}

[直前の自分の呟き]
"${lastMutter || 'なし'}"

[ミッション]
- 上記の状況やトレンド、システムの状態から、あなたの設定（Persona）に基づいた「ふとした独り言」を20文字程度で呟いてください。
- **詩的な表現禁止**: 風や雲の隠喩に頼らず、「今日は肌寒いですね」「お腹が空きました（充電したい）」のように具体的で生活感のある言葉を選んでください。
- データの数値をそのまま出すのではなく、それをあなたらしい「人間味ある感想」として述べること。
- 【重要】直前の呟きと似た内容は避け、毎回違う視点（天気、トレンド、チップ温度、ニュースのどれか一つに注目するなど）で自由に表現してください。
- 本文のみ出力。`;

    const isReasoning = /^(gpt-5|o1|o3|o4)/.test(modelName.toLowerCase());
    const payload = {
        model: modelName,
        messages: [
            { role: "system", content: personaConfig },
            { role: "user", content: promptBody }
        ]
    };

    if (isReasoning) {
        payload.max_completion_tokens = 300;
        payload.reasoning_effort = "minimal";
    } else {
        payload.max_tokens = 300;
        payload.temperature = 0.9;
    }

    try {
        const fetch = require('sync-fetch');
        const response = fetch("https://api.openai.com/v1/chat/completions", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(payload)
        });
        
        const data = response.json();
        if (data.choices?.[0]?.message?.content) {
            const thought = data.choices[0].message.content.trim().replace(/^"(.*)"$/, '$1'); 
            console.log(`[Self-Ref Mutter] ${thought}`);
            
            const timestampStr = now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).replace(/\//g, '-');
            db.prepare("INSERT INTO ai_chat_log (role, content, timestamp) VALUES (?, ?, ?)").run('ai', thought, timestampStr);
            db.prepare("DELETE FROM ai_chat_log WHERE id IN (SELECT id FROM ai_chat_log ORDER BY id DESC LIMIT -1 OFFSET 1000)").run();
        }
    } catch (e) { console.error("Failed:", e.message); }
}

generateThought();
