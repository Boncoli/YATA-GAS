const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || '/dev/shm/yata.db';
const db = new Database(dbPath);

console.log(`Cleaning HTML tags from DB: ${dbPath}`);

// 1. タグ除去関数
function stripHtml(html) {
  if (!html) return "";
  // <tag> 除去
  let text = html.replace(/<[^>]*>?/gm, '');
  // &nbsp; などの実体参照を簡易置換
  text = text.replace(/&nbsp;/g, ' ')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&amp;/g, '&')
             .replace(/&quot;/g, '"')
             .replace(/&#39;/g, "'");
  // 再度タグ除去（デコードされたタグ用）
  text = text.replace(/<[^>]*>?/gm, '');
  return text.trim();
}

const rows = db.prepare("SELECT id, abstract, summary FROM collect WHERE abstract LIKE '%<p>%' OR abstract LIKE '%<span%' OR abstract LIKE '%&lt;%'").all();

console.log(`Target rows found: ${rows.length}`);

const updateStmt = db.prepare("UPDATE collect SET abstract = ? WHERE id = ?");

db.transaction((data) => {
  for (const row of data) {
    const cleaned = stripHtml(row.abstract);
    updateStmt.run(cleaned, row.id);
  }
})(rows);

console.log("✅ Cleanup completed.");
db.close();
