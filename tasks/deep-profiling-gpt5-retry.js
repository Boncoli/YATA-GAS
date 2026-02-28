const fs = require('fs');

async function main() {
    const youtubeKeywords = JSON.parse(fs.readFileSync('data/takeout_keywords.json', 'utf8'));
    const xSummary = JSON.parse(fs.readFileSync('data/x_profile_summary.json', 'utf8'));
    
    const context = {
        bio: xSummary.bio,
        x_interests: xSummary.interests.slice(0, 50),
        recent_tweets: xSummary.recent_tweets.slice(0, 50),
        youtube: youtubeKeywords.slice(0, 30)
    };

    const apiKey = process.env.OPENAI_API_KEY_PERSONAL || process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL_MINI || "gpt-5-mini"; 

    console.log("🚀 Model: " + model + " / Reasoning Effort: medium で再試行中...");
    
    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: model,
                messages: [{ 
                    role: "user", 
                    content: "あなたは世界最高のAIプロファイラーです。以下のデータを解析し、デジタルツイン・プロファイルをJSON形式で出力してください。\n\n" + JSON.stringify(context)
                }],
                reasoning_effort: "medium",
                max_completion_tokens: 5000 
            })
        });

        const resJson = await response.json();
        if (resJson.choices && resJson.choices[0]) {
            const text = resJson.choices[0].message.content;
            console.log("✨ Success!");
            fs.writeFileSync('data/ultimate_digital_twin_gpt5.json', text);
            console.log(text.substring(0, 500));
        } else {
            console.log("❌ Error: " + JSON.stringify(resJson));
        }
    } catch (e) {
        console.error("❌ Catch: " + e.message);
    }
}
main();
