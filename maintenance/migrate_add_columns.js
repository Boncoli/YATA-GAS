const Database = require('better-sqlite3');
const path = require('path');
const dbPath = process.env.DB_PATH || path.join(__dirname, '../yata.db');
const db = new Database(dbPath);

console.log(`[Migration] Target DB: ${dbPath}`);

const columnsToAdd = [
  'tldr', 'who', 'what', '"when"', '"where"', 'why', 'how', 'result', 'keywords'
];

columnsToAdd.forEach(col => {
  try {
    db.prepare(`ALTER TABLE collect ADD COLUMN ${col} TEXT`).run();
    console.log(`✅ Added column: ${col}`);
  } catch (e) {
    if (e.message.includes('duplicate column name')) {
      console.log(`⏩ Column ${col} already exists, skipping.`);
    } else {
      console.error(`❌ Failed to add column ${col}:`, e.message);
    }
  }
});

console.log('Migration completed.');
