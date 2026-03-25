const Database = require('better-sqlite3');
const path = require('path');
const dbPath = process.env.DB_PATH || '/dev/shm/yata.db';

console.log(`[Test Setup] Opening DB at: ${dbPath}`);
const db = new Database(dbPath);

try {
  // 1. 最新の3件のIDを取得
  const ids = db.prepare("SELECT id, title FROM collect ORDER BY date DESC LIMIT 3").all();
  console.log("Target articles to reset:");
  ids.forEach(r => console.log(` - ${r.title.substring(0, 30)}...`));

  // 2. 該当する3件のサマリーやベクトル、新構造化カラムを空文字にリセット
  const stmt = db.prepare(`
    UPDATE collect 
    SET summary = '', vector = '', method_vector = '', tldr = '', who = '', what = '', "when" = '', "where" = '', why = '', how = '', result = '', keywords = '' 
    WHERE id = ?
  `);
  
  db.transaction((idList) => {
    for (const item of idList) {
      stmt.run(item.id);
    }
  })(ids);

  console.log("✅ Successfully cleared summary fields for the latest 3 articles.");
} catch (e) {
  console.error("❌ Error during database update:", e);
} finally {
  db.close();
}