
const Database = require('better-sqlite3');
const path = require('path');

// DB接続
const dbPath = process.env.DB_PATH || path.join(__dirname, '../yata.db');
console.log(`Using Database: ${dbPath}`);
const db = new Database(dbPath);

// URL正規化関数 (YATA.jsと同等)
function normalizeUrl(url) {
  if (!url) return "";
  let s = String(url).trim();
  try { s = decodeURIComponent(s); } catch (e) {}
  s = s.toLowerCase();
  s = s.split('?')[0].split('#')[0];
  s = s.replace(/\/$/, "");
  s = s.replace(/^https?:\/\/(www\.)?/, "//");
  return s;
}

function cleanDuplicates() {
  try {
    // 1. 全データ取得
    const rows = db.prepare('SELECT id, url, date, title, vector FROM collect').all();
    console.log(`Total rows checked: ${rows.length}`);

    const uniqueMap = new Map(); // Key: normalizedUrl, Value: row
    const idsToDelete = [];

    rows.forEach(row => {
      const normUrl = normalizeUrl(row.url || row.id);
      
      if (!uniqueMap.has(normUrl)) {
        // 新出URLなら登録
        uniqueMap.set(normUrl, row);
      } else {
        // 重複発見！ どちらを残すか判定
        const existing = uniqueMap.get(normUrl);
        
        // 判定基準A: ベクトルがある方を優先
        const existingHasVector = existing.vector && existing.vector.length > 10;
        const currentHasVector = row.vector && row.vector.length > 10;

        if (!existingHasVector && currentHasVector) {
           // 新しい方がベクトルを持っているので、既存を捨てて乗り換え
           idsToDelete.push(existing.id);
           uniqueMap.set(normUrl, row);
        } else if (existingHasVector && !currentHasVector) {
           // 既存が優秀なので、新しい方を捨てる
           idsToDelete.push(row.id);
        } else {
           // 判定基準B: 両方あるorないなら、日付が新しい方を残す（あるいはIDが新しい方）
           // ここでは単純に「後から来た方を重複」として削除
           idsToDelete.push(row.id);
        }
      }
    });

    if (idsToDelete.length === 0) {
      console.log("✅ No duplicates found.");
      return;
    }

    console.log(`⚠️ Found ${idsToDelete.length} duplicate items. Deleting...`);

    // 削除実行
    const deleteStmt = db.prepare('DELETE FROM collect WHERE id = ?');
    const deleteMany = db.transaction((ids) => {
      for (const id of ids) deleteStmt.run(id);
    });

    deleteMany(idsToDelete);
    console.log(`🗑️ Deleted ${idsToDelete.length} rows successfully.`);
    
    // 結果確認
    const finalCount = db.prepare('SELECT count(*) as c FROM collect').get().c;
    console.log(`Final row count: ${finalCount}`);

  } catch (e) {
    console.error("Error during cleanup:", e);
  } finally {
    db.close();
  }
}

cleanDuplicates();
