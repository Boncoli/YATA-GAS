const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || 'yata.db';
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// 17:00 JST = 08:00 UTC 以前をすべてアーカイブ
const threshold = '2026-02-05T08:00:00.000Z';

console.log(`Archiving all articles older than ${threshold} (17:00 JST)...`);

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collect_archive (
      id TEXT PRIMARY KEY, 
      date TEXT, 
      title TEXT, 
      url TEXT, 
      abstract TEXT, 
      summary TEXT, 
      source TEXT, 
      category TEXT, 
      vector TEXT
    );
  `);

  const transaction = db.transaction(() => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO collect_archive 
      SELECT * FROM collect WHERE date < ?
    `);
    const resultInsert = insert.run(threshold);
    console.log(`Moved ${resultInsert.changes} old articles to archive.`);

    const del = db.prepare(`
      DELETE FROM collect WHERE date < ?
    `);
    const resultDelete = del.run(threshold);
    console.log(`Deleted ${resultDelete.changes} old articles from main table.`);
  });

  transaction();
  console.log('Success: Main table now contains only new articles.');
  
  console.log('Vacuuming database...');
  db.exec('VACUUM');

} catch (err) {
  console.error('Error:', err.message);
} finally {
  db.close();
}
