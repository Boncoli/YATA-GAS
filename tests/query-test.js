const Database = require('better-sqlite3');
const db = new Database('yata.db');

const keyword = 'Mac'; // ここを「楽天」などに変えてもOK
console.log(`--- キーワード「${keyword}」での検索結果 ---`);

// SQL 文でタイトルを検索
const rows = db.prepare('SELECT title, url FROM articles WHERE title LIKE ?').all(`%${keyword}%`);

rows.forEach(row => {
    console.log(`・${row.title}`);
});

console.log(`\n合計: ${rows.length} 件見つかりました。`);
db.close();