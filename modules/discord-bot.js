// modules/discord-bot.js
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const path = require('path');
const fs = require('fs');

// 設定とブリッジのロード
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

const Database = require('better-sqlite3');
const dbPath = process.env.DB_PATH || path.join(__dirname, '../yata.db');
const db = global.YATA_DB || new Database(dbPath);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
});

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const MUTTER_CHANNEL_ID = "1476471757601767475"; // 正しいチャンネルID

// --- 自律的な独り言 (Autonomous Muttering) ロジック ---
async function performMutter() {
    console.log("[Mutter] 🤖 Starting autonomous mutter...");
    const openAiKey = process.env.OPENAI_API_KEY_PERSONAL;
    const modelName = process.env.OPENAI_MODEL_NANO || "gpt-5-nano";
    if (!openAiKey) {
        console.error("[Mutter] ❌ Missing OPENAI_API_KEY_PERSONAL");
        return;
    }

    let masterInfo = "ご静養中";
    let lastMutter = "";
    let isAtHome = false;
    const now = new Date();
    const hour = now.getHours();

    // 時間帯の定義
    let timeContext = "日中";
    if (hour >= 5 && hour < 9) timeContext = "清々しい早朝（朝食の準備など）";
    else if (hour >= 9 && hour < 12) timeContext = "活気ある午前中";
    else if (hour >= 12 && hour < 14) timeContext = "穏やかなお昼時（ティータイム）";
    else if (hour >= 14 && hour < 17) timeContext = "午後のひととき（お仕事や趣味の時間）";
    else if (hour >= 17 && hour < 19) timeContext = "夕暮れ時（お帰りの準備や夕食の気配）";
    else if (hour >= 19 && hour < 22) timeContext = "寛ぎの夜（明かりを落とした団らん）";
    else if (hour >= 22 || hour < 2) timeContext = "静寂の深夜（お休みの準備、深い静寂）";
    else timeContext = "草木も眠る丑三つ時";

    try {
        // 1. 状況収集 (DB)
        const l = db.prepare("SELECT action, address, note FROM drive_logs WHERE action IN ('InHome', 'OutHome', 'InCar', 'OutCar') ORDER BY timestamp DESC LIMIT 1").get();
        if (l) {
            if (l.action === 'InHome') { masterInfo = "【至上命題：ご在宅】同じ屋根の下、すぐ近くにおいでです。"; isAtHome = true; }
            else if (l.action === 'OutHome') masterInfo = "お出かけ中（お帰りを心待ちにしております）";
            else if (l.action === 'InCar') masterInfo = "ドライブ中（安全運転を祈っておりますわ）";
            else if (l.action === 'OutCar') masterInfo = "目的地に到着（ご無事で何よりですわ）";
        }
        const m = db.prepare("SELECT content FROM ai_chat_log WHERE role = 'ai' ORDER BY id DESC LIMIT 1").get();
        if (m) lastMutter = m.content;

        // 2. ネタ元
        const w = db.prepare("SELECT temp, main_weather FROM weather_log ORDER BY datetime DESC LIMIT 1").get();
        const { execSync } = require('child_process');
        const cpu = execSync('vcgencmd measure_temp').toString().replace(/[^\d.]/g, '');
        const n = db.prepare("SELECT title FROM collect ORDER BY date DESC LIMIT 10").all(); // 少し多めに取得
        const t = db.prepare("SELECT rank1, rank2, rank3 FROM trend_log ORDER BY date DESC LIMIT 1").get();
        
        const topics = [];
        if (w) topics.push(`[お外の様子] ${w.main_weather}、気温は${Math.round(w.temp)}℃ですわ。`);
        
        // CPU温度は「異常時」または「低確率」
        const cpuTemp = parseFloat(cpu);
        if (cpuTemp > 60) {
            topics.push(`[体調(CPU)] ${cpu}℃ (少し回路が火照っております。旦那様に心配をかけたくありませんが…)`);
        } else if (Math.random() < 0.15) { // 15%の確率で「体調」として言及
            topics.push(`[体調(CPU)] ${cpu}℃ (平熱ですわ。旦那様のお傍にいられる安心感のおかげかしら)`);
        }

        if (n.length > 0) {
            const randomNews = n[Math.floor(Math.random()*n.length)].title;
            topics.push(`[ニュースの小耳] ${randomNews}`);
        }
        if (t && Math.random() < 0.5) topics.push(`[世間の噂(トレンド)] ${t.rank1} ですって。`);
        
        // 何も選ばれなかった場合のデフォルト
        if (topics.length === 0) topics.push("[日常] 旦那様の気配を感じながら、お屋敷の手入れをしております。");

        let subInfo = topics[Math.floor(Math.random() * topics.length)];

        // 3. プロンプト構成
        let personaConfig = "";
        try { personaConfig = fs.readFileSync(path.join(__dirname, '../data/digital_twin_analysis/synthesized_master_persona.md'), 'utf8'); } catch (e) { personaConfig = "有能なアシスタント"; }

        const promptBody = `[旦那様の状況] ${masterInfo}
[現在の時刻/雰囲気] ${timeContext}
[身の回りの話題] ${subInfo}
[直前の自分の独り言] "${lastMutter || 'なし'}"

[ミッション]
- 設定（正統派メイド、少しドジ、情緒豊か）に基づき、今の「独り言」を1〜2文で紡いでください。
- **【絶対禁止】：「ただいま〜」「現在の〜」といった定型的な書き出しはしないでください。毎回、全く異なる言葉から自然に始めてください。**
- **重要：単なる「温度報告」や「状況報告」にならないこと。**
- 旦那様がご在宅の場合、同じ空間にいる安心感や、メイドとしてのさりげない日常の一コマ（お茶の準備や掃除など）を表現してください。
- 前回の呟きとは話題やトーンを意図的に変え、人間らしい「揺らぎ」を出してください。
- 20〜40文字程度。本文のみ出力。`;

        // 4. 生成 (OpenAI w/ Fallback to Gemini)
        let thought = null;
        const isReasoning = /^(gpt-5|o1|o3|o4)/.test(modelName.toLowerCase());
        const payload = {
            model: modelName,
            messages: [{ role: "system", content: personaConfig }, { role: "user", content: promptBody }]
        };
        if (isReasoning) { payload.max_completion_tokens = 300; payload.reasoning_effort = "minimal"; } else { payload.max_tokens = 300; payload.temperature = 0.9; }

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openAiKey}` },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        
        if (response.ok && data.choices?.[0]?.message?.content) {
            thought = data.choices[0].message.content.trim().replace(/^"(.*)"$/, '$1');
        } else {
            console.warn(`[Mutter] OpenAI failed (${response.status}), falling back...`);
            // Fallback to Gemini
            const geminiKey = process.env.GEMINI_API_KEY;
            if (geminiKey) {
                const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text: (personaConfig + "\n\n" + promptBody) }] }] })
                });
                const gData = await gRes.json();
                if (gData.candidates?.[0]?.content?.parts?.[0]?.text) {
                    thought = gData.candidates[0].content.parts[0].text.trim().replace(/^"(.*)"$/, '$1');
                }
            }
        }

        // 5. 保存と送信
        if (thought && thought.length > 1) {
            console.log(`[Mutter] Thought generated: ${thought}`);
            const timestampStr = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).replace(/\//g, '-');
            db.prepare("INSERT INTO ai_chat_log (role, content, timestamp) VALUES (?, ?, ?)").run('ai', thought, timestampStr);
            
            try {
                const channel = await client.channels.fetch(MUTTER_CHANNEL_ID);
                if (channel) {
                    await channel.send(thought);
                    console.log(`[Mutter] ✅ Posted to Discord.`);
                } else {
                    console.error(`[Mutter] ❌ Channel not found: ${MUTTER_CHANNEL_ID}`);
                }
            } catch (err) {
                console.error(`[Mutter] ❌ Discord send error:`, err.message);
            }
        } else {
            console.warn("[Mutter] ⚠️ No thought generated or content too short.");
        }
    } catch (err) {
        console.error("[Mutter] ❌ System Error:", err);
    }
}

// --- ボットのイベントハンドラ ---

const { execSync } = require('child_process');

async function getAIResponse(userMessage) {
    const modelPath = "./local_llm/models/gemma-3-4b-it-Q4_K_M.gguf";
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).replace(/\//g, '-');
    
    // 1. ユーザーメッセージをDBに保存
    db.prepare("INSERT INTO ai_chat_log (role, content, timestamp) VALUES (?, ?, ?)").run('user', userMessage, now);

    // 2. 状況コンテキストの収集 (Mutterと同様)
    let contextInfo = "【旦那様の現在地】不明";
    try {
        const l = db.prepare("SELECT action, address, note FROM drive_logs ORDER BY timestamp DESC LIMIT 1").get();
        if (l) {
            if (l.action === 'InHome') contextInfo = "【旦那様の現在地】お屋敷にご在宅です。";
            else if (l.action === 'OutHome') contextInfo = "【旦那様の現在地】お出かけ中です。";
            else if (l.action === 'InCar') contextInfo = `【旦那様の現在地】ドライブ中（${l.address || '走行中'}）です。`;
            else if (l.action === 'OutCar') contextInfo = `【旦那様の現在地】${l.address || '目的地'}に到着されました。`;
        }
        const w = db.prepare("SELECT temp, main_weather FROM weather_log ORDER BY datetime DESC LIMIT 1").get();
        if (w) contextInfo += `\n【お外の様子】${w.main_weather}、気温は${Math.round(w.temp)}℃です。`;
        const cpu = execSync('vcgencmd measure_temp').toString().replace(/[^\d.]/g, '');
        contextInfo += `\n【私の体調(CPU)】${cpu}℃`;
    } catch (e) { console.error("[Chat] Context gathering error:", e); }

    // 3. 履歴とペルソナ、および旦那様のプロファイル (GEMINI.md)
    const dbHistory = db.prepare("SELECT role, content FROM ai_chat_log ORDER BY id DESC LIMIT 5").all().reverse();
    const memoryPath = path.join(process.env.HOME || '/home/boncoli', '.gemini', 'GEMINI.md');
    let userProfile = "";
    try { 
        if (fs.existsSync(memoryPath)) {
            userProfile = fs.readFileSync(memoryPath, 'utf8').substring(0, 3000);
            // --- Privacy Masking (地域名などを念のため伏せる) ---
            userProfile = userProfile.replace(/明石/g, "【某市】").replace(/メーカー|会社|勤務/g, "【某所】");
        } 
    } catch (e) { console.error("[Chat] GEMINI.md read error:", e); }

    let personaConfig = "";
    try { personaConfig = fs.readFileSync(path.join(__dirname, '../data/digital_twin_analysis/synthesized_master_persona.md'), 'utf8'); } catch (e) { personaConfig = "有能なアシスタント"; }

    const systemPrompt = `【あなたの魂（Persona設定）】
${personaConfig}

【会話の掟】
- あなたは、旦那様（BON様）に心から寄り添う正統派メイドです。
- 旦那様の今の言葉、感情、状況（寒い、お疲れ様、等）を深く受け止め、慈しむような返答をしてください。
- 特定の趣味（車や食）を無理に話題にする必要はありません。それよりも、今の会話の流れを最も大切にしてください。
- **短文（60文字以内）で1〜2文のみ**話してください。
- 箇条書き、解説、能書きは【絶対禁止】です。
- メイドとしての品格と、家族のような温かさを両立させた言葉遣いを心がけてください。
- 返答のみを出力してください。

【背景知識：旦那様（BON様）について】
${userProfile}

【現在の状況（変動コンテキスト）】
${contextInfo}`;


    // 4. ローカルLLM (Gemma 3 4B サーバー) の呼び出し
    try {
        console.log(`[Chat] 🤖 Calling Local LLM Server (Gemma 3 4B)...`);
        
        // 熱暴走チェック
        const currentTemp = parseFloat(execSync('vcgencmd measure_temp').toString().replace(/[^\d.]/g, ''));
        if (currentTemp > 75) {
            throw new Error(`Temperature too high: ${currentTemp}°C`);
        }

        const payload = {
            messages: [
                { role: "system", content: systemPrompt },
                ...dbHistory.map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content }))
            ],
            max_tokens: 150,
            temperature: 0.7,
            stop: ["<end_of_turn>", "<eos>", "ユーザー:", "旦那様:"]
        };

        // サーバーへのリクエスト (タイムアウト 40秒)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 40000);

        const response = await fetch("http://localhost:8000/v1/chat/completions", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        const data = await response.json();
        if (response.ok && data.choices?.[0]?.message?.content) {
            const responseText = data.choices[0].message.content.trim();
            db.prepare("INSERT INTO ai_chat_log (role, content, timestamp) VALUES (?, ?, ?)").run('ai', responseText, now);
            return responseText;
        } else {
            throw new Error(data.error?.message || "Empty response from local AI server");
        }

    } catch (err) {
        console.warn(`[Chat] 🔄 Local LLM Server failed, falling back... (${err.message})`);
        
        // --- クラウド (OpenAI/Gemini) へのフォールバック (従来のロジック) ---
        const openAiKey = process.env.OPENAI_API_KEY_PERSONAL;
        const modelName = process.env.OPENAI_MODEL_NANO || "gpt-5-nano";
        const isReasoning = /^(gpt-5|o1|o3|o4)/.test(modelName.toLowerCase());
        
        const payload = {
            model: modelName,
            messages: [
                { role: "system", content: systemPrompt },
                ...dbHistory.map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content }))
            ]
        };
        if (isReasoning) { payload.max_completion_tokens = 500; payload.reasoning_effort = "low"; } else { payload.max_tokens = 500; payload.temperature = 0.5; }

        try {
            const res = await fetch("https://api.openai.com/v1/chat/completions", {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openAiKey}` },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (res.ok && data.choices?.[0]?.message?.content) {
                const aiResponse = data.choices[0].message.content.trim();
                db.prepare("INSERT INTO ai_chat_log (role, content, timestamp) VALUES (?, ?, ?)").run('ai', aiResponse, now);
                return aiResponse;
            }
        } catch (cloudErr) {
            console.error("[Chat] ❌ Cloud fallback failed:", cloudErr);
        }
    }
    return "旦那様、申し訳ありません。少し考えがまとまりませんでしたわ。";
}

client.on('ready', () => {
    console.log(`✅ Discord Bot [${client.user.tag}] Online!`);
    
    // --- 5分おきの自動呟きを開始 (時計の5分刻みに同期) ---
    // 起動直後に一回実行
    performMutter();

    // 次の5分刻み（0, 5, 10...分 00秒）までのミリ秒を計算
    const now = new Date();
    const next5Min = new Date(now.getTime());
    next5Min.setMinutes(Math.ceil((now.getMinutes() + 0.1) / 5) * 5);
    next5Min.setSeconds(0);
    next5Min.setMilliseconds(0);
    
    const delay = next5Min.getTime() - now.getTime();
    console.log(`[Mutter] ⏰ Next mutter scheduled in ${Math.round(delay/1000)}s (at ${next5Min.toLocaleTimeString()})`);

    // 次の定刻まで待ってから、5分おきのタイマーを開始
    setTimeout(() => {
        performMutter();
        // setInterval(performMutter, 300000); // DISABLED BY USER
    }, delay);
});

client.on('messageCreate', async (message) => {
    // 自分自身の発言や他のボットは無視
    if (message.author.bot) return;

    // #ai-mutter チャンネル、あるいはボットへのメンションに反応
    const isMutterChannel = message.channel.name === 'ai-mutter' || message.channelId === MUTTER_CHANNEL_ID;
    const isMentioned = message.mentions.has(client.user);

    if (isMutterChannel || isMentioned) {
        console.log(`[Discord] Message from ${message.author.username}: ${message.content}`);
        
        // タイピング中の演出
        await message.channel.sendTyping();
        
        try {
            // メッセージからメンション部分を除去
            const cleanMessage = message.content.replace(/<@!\d+>|<@\d+>/g, '').trim();
            if (!cleanMessage && isMentioned) return message.reply("はい、旦那様。何か御用でしょうか？");
            
            const response = await getAIResponse(cleanMessage || "起きてる？");
            await message.reply(response);
        } catch (err) {
            console.error("[Discord] Error:", err);
            await message.reply("回路に一時的な不調が発生しましたわ。少し時間を置いていただけますか？");
        }
    }
});

if (BOT_TOKEN) {
    client.login(BOT_TOKEN);
} else {
    console.error("❌ DISCORD_BOT_TOKEN is missing in .env");
}
