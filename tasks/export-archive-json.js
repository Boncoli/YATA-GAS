const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = process.env.DB_PATH || 'yata.db';
const db = new Database(dbPath);

const outputDir = path.join(__dirname, '../archive');
const outputFile = path.join(outputDir, 'collect_before_20260205_1700.json');

console.log(`Exporting collect_archive to ${outputFile}...`);

try {
  const rows = db.prepare('SELECT * FROM collect_archive').all();
  
  if (rows.length === 0) {
    console.log('No data found in collect_archive table.');
  } else {
    fs.writeFileSync(outputFile, JSON.stringify(rows, null, 2), 'utf8');
    console.log(`Successfully exported ${rows.length} articles to JSON.`);
  }
} catch (err) {
  console.error('Export error:', err.message);
} finally {
  db.close();
}
