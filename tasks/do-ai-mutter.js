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

    // --- 2. ランダムな付加情報 ---
    const subSourceTypes = ['weather', 'system', 'news', 'trend'];
    const selectedSub = subSourceTypes[Math.floor(Math.random() * subSourceTypes.length)];
    let subInfo = "";
    try {
        switch(selectedSub) {
            case 'weather':
                const w = db.prepare("SELECT temp, main_weather FROM weather_log ORDER BY datetime DESC LIMIT 1").get();
                subInfo = `外の様子: ${w ? w.main_weather + ' ' + Math.round(w.temp) + '℃' : '穏やか'}`;
                break;
            case 'system':
                const cpu = execSync('vcgencmd measure_temp').toString().replace(/[^\d.]/g, '');
                subInfo = `屋敷(ラズパイ)の状態: CPU ${cpu}℃ (私の火照り)`;
                break;
            case 'news':
                const n = db.prepare("SELECT title FROM collect ORDER BY date DESC LIMIT 10").all();
                subInfo = `届いた書信: ${n.length > 0 ? n[Math.floor(Math.random()*n.length)].title : '静かな海'}`;
                break;
            case 'trend':
                const t = db.prepare("SELECT rank1, rank2, rank3 FROM trend_log ORDER BY date DESC LIMIT 1").get();
                const tr = t ? [t.rank1, t.rank2, t.rank3][Math.floor(Math.random()*3)] : '特になし';
                subInfo = `世間の噂: ${tr}`;
                break;
        }
    } catch (e) { subInfo = "屋敷は平穏です"; }
    
    // --- 3. プロンプト構成 (自己参照含む) ---
    const promptBody = `あなたは正統派メイドです。現在の状況から、ふと漏れる40文字程度の短い独り言を呟いて。
[基本] 時刻:${nowTime}, 旦那様:${masterInfo}
[付加] ${subInfo}
[直前の自分の呟き] "${lastMutter || '（まだ何も呟いていません）'}"

[ルール] 
- 直前の自分の呟きを読み、それを踏まえた続きや、ふと思い直したこと、あるいは全く別の話題を、あなたのメイドとしての感性で選んでください。
- 本文のみ出力。上品な口調（〜ですわ、等）。時刻と旦那様を常に意識して。
- 絵文字を賑やかに。✨🌹`;

    const isReasoning = /^(gpt-5|o1|o3|o4)/.test(modelName.toLowerCase());
    const payload = {
        model: modelName,
        messages: [
            { role: "system", content: "あなたは控えめで献身的な正統派メイドです。自己との対話を楽しむ情緒を持っています。" },
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
