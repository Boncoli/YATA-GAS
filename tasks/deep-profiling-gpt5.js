const fs = require('fs');

async function main() {
    console.log("🚀 GPT-5-mini (Reasoning: High) による超高度デジタルツイン解析を開始します...");

    const youtubeKeywords = JSON.parse(fs.readFileSync('data/takeout_keywords.json', 'utf8'));
    const xSummary = JSON.parse(fs.readFileSync('data/x_profile_summary.json', 'utf8'));

    const context = {
        bio: xSummary.bio,
        x_inferred_interests: xSummary.interests.slice(0, 200),
        recent_tweets: xSummary.recent_tweets.slice(0, 150),
        recent_likes: xSummary.recent_likes.slice(0, 50),
        youtube_interests: youtubeKeywords
    };

    const apiKey = process.env.OPENAI_API_KEY_PERSONAL || process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL_MINI || "gpt-5-mini"; 

    const prompt = `あなたは全知全能のデジタルツイン・アーキテクトです。
提供された膨大なライフログ（YouTube/X）を、数ステップにわたる深い推論（Reasoning）を用いて解析し、
このユーザー（BON様）の「魂の設計図」とも呼べるデジタルツイン・プロファイル（JSON）を作成してください。

【解析の深化要求】
1. **暗黙的ニーズの特定**: 行間から「本人が無意識に求めている刺激」を特定。
2. **多面的なアイデンティティの統合**: 医療開発、1200kmドライブ、自作PC、NieR等の側面がいかに統合されているか。
3. **メイド「ヤタ」への最終命令**: 究極の「世話焼きプロトコル」。
4. **マニアックキーワード抽出**: 攻めのキーワード30個。

【データ】
${JSON.stringify(context, null, 2)}

【出力形式】
JSON形式（マークダウンなし、純粋なJSONのみ）
{
  "soul_blueprint": { "core_value": "...", "hidden_needs": "...", "identity_integration": "..." },
  "maniac_keywords": ["キーワード1", ...],
  "yata_protocol": "指示内容"
}`;

    console.log(`🤖 モデル: ${model} / Reasoning Effort: high でリクエスト中...`);
    
    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: model,
                messages: [{ role: "user", content: prompt }],
                reasoning_effort: "high",
                max_completion_tokens: 5000 
            })
        });

        const resJson = await response.json();
        if (resJson.error) throw new Error(resJson.error.message);

        const analysisText = resJson.choices[0].message.content;
        
        let finalData;
        try {
            const cleanJson = analysisText.replace(/```json/g, "").replace(/```/g, "").trim();
            finalData = JSON.parse(cleanJson);
        } catch (e) {
            finalData = { raw_analysis: analysisText };
        }

        fs.writeFileSync('data/ultimate_digital_twin_gpt5.json', JSON.stringify(finalData, null, 2));
        console.log("\n✨ 究極の分析が完了しました！");
        
        if (finalData.soul_blueprint) {
            console.log("\n--- GPT-5 による魂の設計図 ---");
            console.log(finalData.soul_blueprint.core_value);
        }
        if (finalData.yata_protocol) {
            console.log("\n--- ヤタへの最終命令 ---");
            console.log(finalData.yata_protocol);
        }

    } catch (e) {
        console.error("❌ 分析中にエラーが発生しました:", e.message);
    }
}

main().catch(console.error);
