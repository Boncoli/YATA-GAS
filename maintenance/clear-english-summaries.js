const Database = require('better-sqlite3');
const path = require('path');
const dbPath = process.env.DB_PATH || path.join(__dirname, 'yata.db');
const db = new Database(dbPath);

console.log(`Using DB: ${dbPath}`);

const targetDate = '2026-03-24';
const result = db.prepare(`
    UPDATE collect 
    SET summary = NULL 
    WHERE date(date) >= ? 
    AND summary NOT GLOB '*[ぁ-んァ-ヶ亜-熙]*' 
    AND summary IS NOT NULL 
    AND length(summary) > 20
`).run(targetDate);

console.log(`Cleared ${result.changes} English summaries.`);
db.close();
