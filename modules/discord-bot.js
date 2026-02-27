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
const MUTTER_CHANNEL_ID = "1476472298159603754"; // WebhookのIDから推測、あるいは起動後に確認

async function getAIResponse(userMessage) {
    const openAiKey = process.env.OPENAI_API_KEY_PERSONAL;
    const modelName = process.env.OPENAI_MODEL_NANO || "gpt-5-nano";
    
    // 1. ユーザーメッセージをDBに保存
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).replace(/\//g, '-');
    db.prepare("INSERT INTO ai_chat_log (role, content, timestamp) VALUES (?, ?, ?)").run('user', userMessage, now);

    // 2. 履歴とコンテキストの準備
    const dbHistory = db.prepare("SELECT role, content FROM ai_chat_log ORDER BY id DESC LIMIT 15").all().reverse();
    const memoryPath = path.join(process.env.HOME || '/home/boncoli', '.gemini', 'GEMINI.md');
    let userProfile = "";
    try { if (fs.existsSync(memoryPath)) userProfile = fs.readFileSync(memoryPath, 'utf8').substring(0, 3000); } catch (e) {}

    let personaConfig = "";
    try { personaConfig = fs.readFileSync(path.join(__dirname, '../persona.txt'), 'utf8'); } catch (e) { personaConfig = "有能なアシスタント"; }

    const systemPrompt = `【最優先：会話の掟】
- **短文（40文字以内）で1〜2文のみ**話してください。
- **箇条書き、解説、アドバイス、能書きは【絶対禁止】**です。
- 親身な「挨拶と共感」に留め、世話を焼く場合も「〜しましょうか？」の一言だけにしてください。

【現在の設定（Persona）】
${personaConfig}

[旦那メモ] ${userProfile}
(Discord経由での会話です)`;

    // 3. OpenAI API呼び出し
    const isReasoning = /^(gpt-5|o1|o3|o4)/.test(modelName.toLowerCase());
    const payload = {
        model: modelName,
        messages: [
            { role: "system", content: systemPrompt },
            ...dbHistory.map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content }))
        ]
    };

    if (isReasoning) {
        payload.max_completion_tokens = 150;
        payload.reasoning_effort = "medium";
    } else {
        payload.max_tokens = 150;
        payload.temperature = 0.5;
    }

    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openAiKey}` },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (data.choices?.[0]?.message?.content) {
            const aiResponse = data.choices[0].message.content.trim();
            db.prepare("INSERT INTO ai_chat_log (role, content, timestamp) VALUES (?, ?, ?)").run('ai', aiResponse, now);
            return aiResponse;
        }
    } catch (err) {
        console.error("[OpenAI] Chat error:", err.message);
    }
    return "はい、旦那様。良い夢を。";
}

client.on('ready', () => {
    console.log(`✅ Discord Bot [${client.user.tag}] Online!`);
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
