const fs = require('fs');

async function main() {
    console.log("🚀 GPTによる全人格的デジタルツイン分析を開始します...");

    // 1. 各種データのロード
    const youtubeKeywords = JSON.parse(fs.readFileSync('data/takeout_keywords.json', 'utf8'));
    const xSummary = JSON.parse(fs.readFileSync('data/x_profile_summary.json', 'utf8'));
    const currentInterests = JSON.parse(fs.readFileSync('interests.json', 'utf8'));

    // 分析用コンテキストの構築
    const context = {
        bio: xSummary.bio,
        x_inferred_interests: xSummary.interests.slice(0, 150), // 150件に絞り込み
        recent_tweets: xSummary.recent_tweets.slice(0, 100),    // 直近100件
        recent_likes: xSummary.recent_likes.slice(0, 50),       // 直近50件
        youtube_interests: youtubeKeywords,
        current_persona: currentInterests.persona
    };

    const apiKey = process.env.OPENAI_API_KEY_PERSONAL || process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error("❌ OpenAI APIキーが見つかりません。.envを確認してください。");
        return;
    }

    const prompt = `あなたは世界最高峰のプロファイラーであり、デジタルツイン構築の専門家です。
提供された「YouTubeの長期的視聴データ」と「X（旧Twitter）のリアルタイムな発言・いいね・属性データ」を高度に融合させ、このユーザー（BON様）の【真の姿】を解き明かしてください。

【分析の観点】
1. **潜在的なコア・バリュー**: 技術、生活、表現、それぞれの領域で、ユーザーが「何を最も大切にしているか」を抽出してください。
2. **短期・長期のハイブリッド興味**: YouTubeの「知的好奇心」とXの「感情的反応」が交差するポイント（例：ただの車好きではなく、CX-80で1200km走る情熱）を特定してください。
3. **デジタルツインとしての性格・口調**: ユーザー本人の思考パターンを模した、ニュース配信における「理想的なパーソナリティ」を定義してください。
4. **攻めたキーワード抽出**: 既存のinterests.jsonを圧倒するような、具体的でマニアック、かつ「今の気分」に突き刺さるキーワードを30個程度抽出してください。

【提供データ】
${JSON.stringify(context, null, 2)}

【出力形式】
純粋なJSONのみ。以下の構造で出力してください。
{
  "deep_profile": { "core": "...", "lifestyle": "...", "personality": "..." },
  "ultimate_keywords": ["ワード1", "ワード2", ...],
  "message_to_yata": "メイドのヤタさんが、この旦那様をより深く理解し、世話を焼くためのアドバイス"
}`;

    console.log("🤖 GPT-4o に深層分析を依頼中...");
    
    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "gpt-4o", // 現在利用可能な最高峰モデルを使用
                messages: [{ role: "user", content: prompt }],
                response_format: { type: "json_object" },
                temperature: 0.7
            })
        });

        const resJson = await response.json();
        const analysis = JSON.parse(resJson.choices[0].message.content);

        fs.writeFileSync('data/ultimate_digital_twin.json', JSON.stringify(analysis, null, 2));
        console.log("\n✨ 分析完了！ data/ultimate_digital_twin.json に保存しました。");
        
        // 結果のダイジェストを表示
        console.log("\n--- GPTの深層プロファイル抜粋 ---");
        console.log(`核心: ${analysis.deep_profile.core.substring(0, 150)}...`);
        console.log(`ヤタさんへの助言: ${analysis.message_to_yata}`);
    } catch (e) {
        console.error("❌ 分析中にエラーが発生しました:", e.message);
    }
}

main().catch(console.error);
