const fs = require('fs');
const path = require('path');

// 設定
const WATCH_HISTORY_PATH = 'history/watch-history.json';
const SEARCH_HISTORY_PATH = 'history/検索履歴.json';
const SUBS_PATH = 'history/登録チャンネル.csv';
const OUTPUT_PATH = 'data/takeout_keywords.json';

async function main() {
    console.log("📂 YouTube全データの深層解析を開始します (40万件オーバー)...");

    // 1. 視聴履歴の全件統計解析
    let topChannels = [];
    let recentTitles = [];
    if (fs.existsSync(WATCH_HISTORY_PATH)) {
        console.log("📊 視聴履歴をロード中... (時間がかかる場合があります)");
        const watchContent = fs.readFileSync(WATCH_HISTORY_PATH, 'utf8');
        const watchData = JSON.parse(watchContent);
        console.log(`📈 総視聴件数: ${watchData.length.toLocaleString()} 件`);

        // チャンネルごとの視聴回数を集計
        const channelCounts = {};
        watchData.forEach(item => {
            const name = item.subtitles?.[0]?.name;
            if (name) {
                channelCounts[name] = (channelCounts[name] || 0) + 1;
            }
        });

        // 視聴回数順にソートしてTOP 100を抽出
        topChannels = Object.entries(channelCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 100)
            .map(([name, count]) => `${name}(${count}回)`);

        // 直近のタイトル（最新の関心）
        recentTitles = watchData.slice(0, 500)
            .map(item => item.title.replace(' を視聴しました', ''))
            .filter(t => t && !t.includes('https://'));
        
        console.log("✅ 視聴統計の作成完了");
    }

    // 2. 検索履歴の全件抽出
    let searches = [];
    if (fs.existsSync(SEARCH_HISTORY_PATH)) {
        const searchContent = fs.readFileSync(SEARCH_HISTORY_PATH, 'utf8');
        const searchData = JSON.parse(searchContent);
        searches = searchData.map(item => {
            const match = item.title.match(/「 (.*) 」を検索しました/);
            return match ? match[1] : null;
        }).filter(s => s);
        console.log(`✅ 検索履歴: ${searches.length.toLocaleString()} 件取得`);
    }

    // 3. 分析用テキストの構成（AIが理解できるサイズに凝縮）
    const analysisText = `
### 視聴回数が多いチャンネル TOP 100 (長期的な関心)
${topChannels.join(', ')}

### 直近の視聴動画タイトル 500件の一部 (短期的な関心)
${recentTitles.slice(0, 100).join('\n')}

### 検索履歴の傾向 (全期間から抽出)
${Array.from(new Set(searches)).slice(0, 100).join(', ')}
    `;

    // 4. AIによる究極のキーワード抽出
    console.log("🤖 AIに深層分析を依頼中 (全履歴の傾向を反映)...");
    const apiKey = process.env.OPENAI_API_KEY_PERSONAL || process.env.OPENAI_API_KEY;
    const prompt = `あなたは超一流のプロファイラーです。
ユーザーの数年間にわたるYouTube活動データ（40万件の統計）をもとに、このユーザーの「揺るぎない関心事」と「現在のブーム」を融合させた、ニュース収集用のキーワードを30〜50個抽出してください。

【プロファイリングのヒント】
- 視聴回数が多いチャンネルは、その人の「基礎知識」や「職業」「深い趣味」を表します。
- 直近のタイトルや検索ワードは、その人の「今解決したい課題」や「最新の流行」を表します。
- これらを組み合わせて、専門性の高いキーワード（例：特定の技術名、型番、ゲームの深層用語）を優先してください。

【出力形式】
純粋なJSON配列のみ。
例: ["キーワード1", "キーワード2", ...]

【データ】
${analysisText}`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "gpt-4o-mini", 
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }
        })
    });

    const resJson = await response.json();
    let keywords = [];
    try {
        const parsed = JSON.parse(resJson.choices[0].message.content);
        keywords = Array.isArray(parsed) ? parsed : (parsed.keywords || parsed.interests || Object.values(parsed)[0]);
    } catch (e) { console.error(e); }

    if (keywords.length > 0) {
        fs.writeFileSync(OUTPUT_PATH, JSON.stringify(keywords, null, 2));
        console.log(`\n✨ 深層解析完了！ ${keywords.length}個のキーワードを抽出しました。`);
        console.log("抽出例:", keywords.slice(0, 10).join(', '), "...");
    }
}

main().catch(console.error);
