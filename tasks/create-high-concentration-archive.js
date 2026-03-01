const fs = require('fs');
const path = require('path');

const X_DIR = 'archive/takeout/x';
const YT_DIR = 'archive/takeout/youtube';
const OUTPUT_FILE = 'data/high_concentration_archive.json';

function parseXJs(filename) {
    const filePath = path.join(X_DIR, filename);
    if (!fs.existsSync(filePath)) return [];
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const jsonStart = content.indexOf('[');
        if (jsonStart === -1) return [];
        return JSON.parse(content.substring(jsonStart));
    } catch (e) {
        return [];
    }
}

async function main() {
    console.log("💎 完全版・高濃度アーカイブの生成を開始します...");
    const result = {
        meta: { 
            generated_at: new Date().toISOString(), 
            version: "2.0 (Complete Edition)" 
        },
        profile: { bio: "", screen_names: [] },
        x_tweets: [],
        x_likes: [],
        x_interests: [],
        x_searches: [],
        x_grok_chats: [],
        x_social: { following_count: 0, followers_count: 0, lists: [] },
        yt_watches: [],
        yt_searches: [],
        yt_subs: []
    };

    // 1. プロフィール・名前変更履歴
    console.log("📝 プロフィール情報を抽出中...");
    const profiles = parseXJs('profile.js');
    if (profiles[0]?.profile) result.profile.bio = profiles[0].profile.description?.bio || "";
    const nameChanges = parseXJs('screen-name-change.js');
    result.profile.screen_names = nameChanges.map(n => n.screenNameChange?.screenName).filter(n => n);

    // 2. 全ツイート (重複排除)
    console.log("🐥 全ツイートをスキャン中 (全パート統合・重複排除)...");
    const tweetMap = new Map();
    const tweetFiles = fs.readdirSync(X_DIR).filter(f => f.startsWith('tweets') && f.endsWith('.js'));
    
    tweetFiles.forEach(file => {
        const data = parseXJs(file);
        data.forEach(item => {
            const t = item.tweet;
            if (t && !tweetMap.has(t.id_str)) {
                tweetMap.set(t.id_str, {
                    d: t.created_at,
                    t: t.full_text,
                    r: t.retweet_count,
                    f: t.favorite_count
                });
            }
        });
    });
    result.x_tweets = Array.from(tweetMap.values()).sort((a, b) => new Date(b.d) - new Date(a.d));

    // 3. いいね
    console.log("❤️ いいねを抽出中...");
    const likes = parseXJs('like.js');
    result.x_likes = likes.map(l => ({ t: l.like.fullText })).filter(l => l.t);

    // 4. Grokとの対話
    console.log("🤖 Grokチャットを抽出中...");
    const grokData = parseXJs('grok-chat-item.js');
    result.x_grok_chats = grokData.map(g => ({
        d: g.grokChatItem?.createdAt,
        m: g.grokChatItem?.message,
        s: g.grokChatItem?.sender
    })).filter(g => g.m);

    // 5. 興味・検索
    console.log("🔍 興味・検索ワードを抽出中...");
    const p13n = parseXJs('personalization.js');
    if (p13n[0]?.p13nData?.interests?.interests) {
        result.x_interests = p13n[0].p13nData.interests.interests.filter(i => !i.isDisabled).map(i => i.name);
    }
    const searches = parseXJs('saved-search.js');
    result.x_searches = searches.map(s => s.savedSearch?.query).filter(q => q);

    // 6. ソーシャルグラフ (フォロー/フォロワー)
    console.log("👥 ソーシャル関係を統計中...");
    const following = parseXJs('following.js');
    const followers = parseXJs('follower.js');
    result.x_social.following_count = following.length;
    result.x_social.followers_count = followers.length;
    const lists = parseXJs('lists-subscribed.js');
    result.x_social.lists = lists.map(l => l.listsSubscribed?.urls).flat().filter(u => u);

    // 7. YouTube (視聴・検索・登録)
    console.log("📺 YouTubeデータを統合中...");
    const ytWatchPath = path.join(YT_DIR, 'watch-history.json');
    if (fs.existsSync(ytWatchPath)) {
        const ytWatch = JSON.parse(fs.readFileSync(ytWatchPath, 'utf8'));
        result.yt_watches = ytWatch.map(w => ({
            d: w.time,
            t: w.title.replace(' を視聴しました', ''),
            c: w.subtitles?.[0]?.name || ""
        }));
    }
    const ytSearchPath = path.join(YT_DIR, '検索履歴.json');
    if (fs.existsSync(ytSearchPath)) {
        const ytSearch = JSON.parse(fs.readFileSync(ytSearchPath, 'utf8'));
        result.yt_searches = ytSearch.map(s => {
            const m = s.title.match(/「 (.*) 」を検索しました/);
            return { d: s.time, q: m ? m[1] : "" };
        }).filter(s => s.q);
    }
    const ytSubPath = path.join(YT_DIR, '登録チャンネル.csv');
    if (fs.existsSync(ytSubPath)) {
        const content = fs.readFileSync(ytSubPath, 'utf8');
        result.yt_subs = content.split('\n').slice(1).map(line => {
            const parts = line.split(',');
            return parts[2] || ""; // チャンネル名
        }).filter(name => name);
    }

    // 最終書き出し
    console.log("💾 統合ファイルを書き出し中...");
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
    
    const stats = fs.statSync(OUTPUT_FILE);
    console.log(`\n✨ 【完全版】生成完了: ${OUTPUT_FILE}`);
    console.log(`📊 総容量: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`📈 有効ツイート数: ${result.x_tweets.length.toLocaleString()} 件 (重複排除済)`);
    console.log(`📈 Grokチャット数: ${result.x_grok_chats.length.toLocaleString()} 件`);
    console.log(`📈 YouTube視聴数: ${result.yt_watches.length.toLocaleString()} 件`);
}

main().catch(console.error);
