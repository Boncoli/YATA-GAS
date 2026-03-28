const Database = require('better-sqlite3');
const db = new Database('/dev/shm/yata.db');

console.log("🔍 DB 健全性チェック (Sanity Check) 開始...");

const results = {
  invalidIds: db.prepare("SELECT count(*) as count FROM collect WHERE id NOT LIKE 'http%'").get().count,
  emptyTitles: db.prepare("SELECT count(*) as count FROM collect WHERE title = '' OR title IS NULL").get().count,
  emptySummaries: db.prepare("SELECT count(*) as count FROM collect WHERE summary = '' OR summary IS NULL").get().count,
  structureCheck: db.prepare("SELECT id, title, tldr FROM collect WHERE tldr != '' LIMIT 1").get()
};

console.log(`- 不正な ID (URL以外): ${results.invalidIds} 件`);
console.log(`- タイトル空欄: ${results.emptyTitles} 件`);
console.log(`- 要約空欄: ${results.emptySummaries} 件`);

if (results.structureCheck) {
  console.log("\n✅ 保存データのサンプル確認:");
  console.log(`  ID: ${results.structureCheck.id.substring(0, 50)}...`);
  console.log(`  Title: ${results.structureCheck.title.substring(0, 50)}...`);
  console.log(`  TLDR: ${results.structureCheck.tldr.substring(0, 50)}...`);
}

if (results.invalidIds === 0 && results.emptyTitles === 0) {
  console.log("\n✨ [合格] DB の整合性は完全に保たれています。");
} else {
  console.log("\n❌ [不合格] まだデータの不整合が残っています。再修正が必要です。");
  process.exit(1);
}
