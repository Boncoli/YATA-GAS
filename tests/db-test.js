const Parser = require('rss-parser');
const Database = require('better-sqlite3');
const parser = new Parser();

// DBファイルの作成（yata.db という名前で保存されます）
const db = new Database('yata.db');

// テーブルの作成（設計書に基づいた正規化構造）
db.prepare(`
    CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE NOT NULL,
        title TEXT,
        content_text TEXT,
        published_at TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).run();

(async () => {
    console.log('--- DB保存実験開始 ---');
    const RSS_URL = 'https://rss.itmedia.co.jp/rss/2.0/itmedia_all.xml';

    try {
        const feed = await parser.parseURL(RSS_URL);
        
        // データを挿入するための準備
        const insert = db.prepare(`
            INSERT OR IGNORE INTO articles (url, title, content_text, published_at)
            VALUES (?, ?, ?, ?)
        `);

        // 取得した記事を一つずつDBへ保存
        let count = 0;
        for (const item of feed.items) {
            const result = insert.run(item.link, item.title, item.contentSnippet, item.pubDate);
            if (result.changes > 0) count++;
        }

        console.log(`${feed.items.length}件中、${count}件の新しい記事をDBに保存しました。`);

        // 保存された件数を確認
        const total = db.prepare('SELECT COUNT(*) as count FROM articles').get();
        console.log(`現在の総蓄積数: ${total.count}件`);

    } catch (error) {
        console.error('エラー:', error);
    } finally {
        db.close();
    }
})();