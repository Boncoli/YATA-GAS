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
        if (l) {
            if (l.action === 'InHome') {
                masterInfo = "ご在宅（お近くにおいでです！）";
            } else if (l.action === 'OutHome') {
                masterInfo = "お出かけ中（お帰りを待っています）";
            } else if (l.action === 'InCar') {
                masterInfo = "ドライブ中（安全運転を祈っています）";
            } else if (l.action === 'OutCar') {
                masterInfo = "目的地に到着（ご無事で何よりです）";
            } else {
                masterInfo = `${l.action}${l.address ? ' @ ' + l.address : ''}`;
            }
        }
        
        // 直前の自分の呟き (自己参照用)
        const m = db.prepare("SELECT content FROM ai_chat_log WHERE role = 'ai' ORDER BY id DESC LIMIT 1").get();
        if (m) lastMutter = m.content;
    } catch (e) {}

    // --- 2. データの網羅的収集とランダム選択 ---
    let subInfo = "";
    try {
        const w = db.prepare("SELECT temp, main_weather FROM weather_log ORDER BY datetime DESC LIMIT 1").get();
        const cpu = execSync('vcgencmd measure_temp').toString().replace(/[^\d.]/g, '');
        const n = db.prepare("SELECT title FROM collect ORDER BY date DESC LIMIT 5").all();
        const t = db.prepare("SELECT rank1, rank2, rank3 FROM trend_log ORDER BY date DESC LIMIT 1").get();
        
        const topics = [];
        if (w) topics.push(`[天気] ${w.main_weather} ${Math.round(w.temp)}℃`);
        topics.push(`[体調(CPU)] ${cpu}℃`);
        if (n.length > 0) topics.push(`[ニュース] ${n[Math.floor(Math.random()*n.length)].title}`);
        if (t) topics.push(`[トレンド] ${t.rank1}, ${t.rank2}`);

        // ネタをランダムに1つだけ選ぶ (情報の過多による混乱を防ぐ)
        // ただし、CPU温度が異常に高い(60度超)場合は強制的に体調を含める
        let selectedTopic = "";
        if (parseFloat(cpu) > 60) {
            selectedTopic = `[体調(CPU)] ${cpu}℃ (少し熱いです)`;
        } else {
            selectedTopic = topics[Math.floor(Math.random() * topics.length)];
        }

        subInfo = selectedTopic;
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
- あなたの設定（Persona）に基づいた、親しみやすく、かつ極めて端的な「LINEの一言」を呟いてください。
- **15文字以内厳守**: 余計な前置きや丁寧すぎる挨拶は省き、今の気分や状況を一言で。
- **例文の模倣禁止**: 決まりきった「温かくしてください」などのフレーズに頼らず、その時々の${subInfo}（ニュースや体調）に対して、あなたらしい瑞々しい一言を。
- 語尾は「〜ですわ」「〜ますわ」「〜かしら」等。
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

            // --- 4. Discord通知 (Bot自身が発言) ---
            const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
            const MUTTER_CHANNEL_ID = "1476471757601767475"; // 教えていただいたチャンネルID

            if (BOT_TOKEN) {
                const { Client, GatewayIntentBits } = require('discord.js');
                const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

                // 10秒経っても終わらなければ強制終了する安全装置
                const timer = setTimeout(() => {
                    console.error("[Discord] ❌ Timeout: Forcing exit.");
                    client.destroy();
                    process.exit(0);
                }, 10000);

                client.login(BOT_TOKEN).then(() => {
                    client.once('ready', async () => {
                        try {
                            const channel = await client.channels.fetch(MUTTER_CHANNEL_ID);
                            if (channel) {
                                await channel.send(thought);
                                console.log(`[Discord] Muttered via Bot to ${channel.name}`);
                            }
                        } catch (e) {
                            console.error("[Discord] ❌ Bot mutter failed:", e.message);
                        } finally {
                            clearTimeout(timer);
                            client.destroy();
                            setTimeout(() => process.exit(0), 500); // 接続を完全に切る猶予を少し置いて終了
                        }
                    });
                }).catch(e => {
                    console.error("[Discord] Login failed:", e.message);
                    process.exit(1);
                });
            } else {
                process.exit(0);
            }
        }
    } catch (e) { 
        console.error("Failed:", e.message);
        process.exit(1);
    }
}

generateThought();
