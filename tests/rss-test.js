const Parser = require('rss-parser');
const parser = new Parser();

(async () => {
    console.log('--- RSS取得実験開始 ---');
    
    // テスト用のRSS URL（PubMedの最新論文など）
    const RSS_URL = 'https://rss.itmedia.co.jp/rss/2.0/itmedia_all.xml';

    try {
        const feed = await parser.parseURL(RSS_URL);
        console.log(`サイト名: ${feed.title}`);
        console.log('---------------------------');

        // 最新の5件を表示
        feed.items.slice(0, 5).forEach(item => {
            console.log(`タイトル: ${item.title}`);
            console.log(`URL: ${item.link}`);
            console.log(`公開日: ${item.pubDate}`);
            console.log('---');
        });

    } catch (error) {
        console.error('取得に失敗しました:', error);
    }
})();