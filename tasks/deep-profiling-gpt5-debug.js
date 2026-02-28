const fs = require('fs');

async function main() {
    const youtubeKeywords = JSON.parse(fs.readFileSync('data/takeout_keywords.json', 'utf8'));
    const xSummary = JSON.parse(fs.readFileSync('data/x_profile_summary.json', 'utf8'));
    const context = {
        bio: xSummary.bio,
        x_inferred_interests: xSummary.interests.slice(0, 100),
        recent_tweets: xSummary.recent_tweets.slice(0, 100),
        youtube_interests: youtubeKeywords
    };
    const apiKey = process.env.OPENAI_API_KEY_PERSONAL || process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL_MINI || "gpt-5-mini"; 

    console.log(`🤖 モデル: ${model} / Reasoning Effort: high でリクエスト中... (JSON強制)`);
    
    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: model,
                messages: [{ role: "user", content: `以下のデータを元に、究極のデジタルツイン・プロファイルをJSON形式で出力してください。JSONのみを出力し、余計な解説は不要です。

${JSON.stringify(context)}` }],
                reasoning_effort: "high",
                max_completion_tokens: 5000 
            })
        });

        const resJson = await response.json();
        console.log("DEBUG: Response Status:", response.status);
        if (resJson.choices && resJson.choices[0]) {
            const text = resJson.choices[0].message.content;
            console.log("DEBUG: Content Length:", text.length);
            fs.writeFileSync('data/ultimate_digital_twin_gpt5.json', text);
            console.log("✨ 完了。");
        } else {
            console.log("DEBUG: Full Response:", JSON.stringify(resJson, null, 2));
        }
    } catch (e) {
        console.error("❌:", e.message);
    }
}
main();
