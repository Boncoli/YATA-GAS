const fs = require('fs');

async function main() {
    const youtubeKeywords = JSON.parse(fs.readFileSync('data/takeout_keywords.json', 'utf8'));
    const xSummary = JSON.parse(fs.readFileSync('data/x_profile_summary.json', 'utf8'));
    const context = {
        bio: xSummary.bio,
        x_interests: xSummary.interests.slice(0, 150),
        recent_tweets: xSummary.recent_tweets.slice(0, 150),
        recent_likes: xSummary.recent_likes.slice(0, 100),
        youtube: youtubeKeywords.slice(0, 100)
    };
    const apiKey = process.env.OPENAI_API_KEY_PERSONAL || process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL_MINI || "gpt-5-mini"; 

    console.log("🚀 Running Ultra-High Profiling with " + model + "...");
    
    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + apiKey,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: model,
                messages: [{ 
                    role: "user", 
                    content: "あなたは全知全能のプロファイラーです。BON様のライフログを『High Reasoning』で深層解析し、最高レベルの解像度でJSON形式のプロファイルを作成してください。医療開発、1200kmドライブ、NieR、低気圧への脆弱性の統合的考察を含めてください。\n\nData: " + JSON.stringify(context)
                }],
                reasoning_effort: "high",
                verbosity: "high",
                max_completion_tokens: 32000 
            })
        });

        const resJson = await response.json();
        if (resJson.choices && resJson.choices[0]) {
            const text = resJson.choices[0].message.content;
            console.log("✨ Analysis Successful.");
            fs.writeFileSync('data/ultimate_digital_twin_gpt5_max.json', text);
            console.log(text.substring(0, 500));
        } else {
            console.log("❌ Error Response: " + JSON.stringify(resJson));
        }
    } catch (e) {
        console.error("❌ Fatal Error: " + e.message);
    }
}
main();
