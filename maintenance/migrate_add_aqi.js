// maintenance/migrate_add_aqi.js
// weather_logテーブルにAQI(大気汚染)用のカラムを追加するマイグレーションスクリプト

const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const dbPath = process.env.DB_PATH || 'yata.db';
const db = new Database(dbPath);

console.log(`Migrating database: ${dbPath}`);

const columnsToAdd = [
  { name: 'aqi', type: 'INTEGER' },
  { name: 'co', type: 'REAL' },
  { name: 'no2', type: 'REAL' },
  { name: 'o3', type: 'REAL' },
  { name: 'pm2_5', type: 'REAL' },
  { name: 'pm10', type: 'REAL' }
];

try {
  // トランザクションで安全に実行
  const migrate = db.transaction(() => {
    // 現在のカラム一覧を取得
    const currentCols = db.pragma('table_info(weather_log)').map(c => c.name);

    for (const col of columnsToAdd) {
      if (!currentCols.includes(col.name)) {
        console.log(`Adding column: ${col.name}`);
        db.prepare(`ALTER TABLE weather_log ADD COLUMN ${col.name} ${col.type} DEFAULT 0`).run();
      } else {
        console.log(`Column ${col.name} already exists. Skipping.`);
      }
    }
  });

  migrate();
  console.log("✅ Migration completed successfully.");

} catch (e) {
  console.error("❌ Migration failed:", e);
} finally {
  db.close();
}
