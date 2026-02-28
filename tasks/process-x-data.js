const fs = require('fs');
const path = require('path');

const X_DATA_DIR = 'archive/takeout/x';
const OUTPUT_PATH = 'data/x_profile_summary.json';

// Xの.jsファイルをJSONとして読み込むヘルパー
function loadXJson(filename) {
    const filePath = path.join(X_DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;

    console.log(`📖 ${filename} を読み込み中...`);
    let content = fs.readFileSync(filePath, 'utf8');
    // 冒頭の window.YTD.xxx.part0 = [ を削る
    // 汎用的に "[" の位置を探してそれ以降をパースする
    const jsonStart = content.indexOf('[');
    if (jsonStart === -1) return null;
    
    try {
        return JSON.parse(content.substring(jsonStart));
    } catch (e) {
        console.error(`❌ ${filename} のパースに失敗しました:`, e.message);
        return null;
    }
}

async function main() {
    const summary = {
        bio: "",
        interests: [],
        saved_searches: [],
        recent_tweets: [],
        recent_likes: []
    };

    // 1. プロフィール (Bio)
    const profileData = loadXJson('profile.js');
    if (profileData && profileData[0]?.profile) {
        summary.bio = profileData[0].profile.description?.bio || "";
        console.log(`✅ Bio取得: ${summary.bio.substring(0, 30)}...`);
    }

    // 2. X側が推測した興味関心
    const p13nData = loadXJson('personalization.js');
    if (p13nData && p13nData[0]?.p13nData?.interests?.interests) {
        // isDisabled: false のものだけ抽出
        summary.interests = p13nData[0].p13nData.interests.interests
            .filter(i => !i.isDisabled)
            .map(i => i.name);
        console.log(`✅ 推測興味関心: ${summary.interests.length}件取得`);
    }

    // 3. 保存した検索
    const searchData = loadXJson('saved-search.js');
    if (searchData) {
        summary.saved_searches = searchData.map(s => s.savedSearch?.query).filter(q => q);
        console.log(`✅ 保存した検索: ${summary.saved_searches.length}件取得`);
    }

    // 4. 最近のツイート (直近500件)
    const tweetData = loadXJson('tweets.js');
    if (tweetData) {
        // 逆時系列と仮定（通常はそうなっている）
        summary.recent_tweets = tweetData.slice(0, 500).map(t => {
            return t.tweet.full_text;
        });
        console.log(`✅ 最近のツイート: ${summary.recent_tweets.length}件取得`);
    }

    // 5. 最近のいいね (直近200件)
    const likeData = loadXJson('like.js');
    if (likeData) {
        summary.recent_likes = likeData.slice(0, 200).map(l => {
            return l.like.fullText;
        });
        console.log(`✅ 最近のいいね: ${summary.recent_likes.length}件取得`);
    }

    // 結果の保存
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(summary, null, 2));
    console.log(`
✨ Xデータの抽出が完了しました！ -> ${OUTPUT_PATH}`);
}

main().catch(console.error);
