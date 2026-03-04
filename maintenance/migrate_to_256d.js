require('../lib/gas-bridge.js');
const Database = require('better-sqlite3');
const db = new Database('/dev/shm/yata.db'); // メモリDBを直接操作

console.log("Starting vector dimension reduction (1536 -> 256)...");

try {
  // すべてのレコードを取得
  const rows = db.prepare("SELECT id, vector FROM collect WHERE vector IS NOT NULL AND vector != ''").all();
  let updateCount = 0;
  
  const stmt = db.prepare("UPDATE collect SET vector = ? WHERE id = ?");
  
  db.transaction(() => {
    for (const row of rows) {
      const vArray = row.vector.split(',').map(Number);
      
      // 1536次元なら先頭256個を取り出して再正規化（Matryoshka対応）
      if (vArray.length > 256) {
        const sliced = vArray.slice(0, 256);
        // L2ノルム(長さ)を計算
        let normSq = 0;
        for (let i = 0; i < 256; i++) {
          normSq += sliced[i] * sliced[i];
        }
        const norm = Math.sqrt(normSq);
        
        // 再正規化
        const normalized = sliced.map(x => x / norm);
        
        // 少数第6位で丸めて文字列化
        const newVecStr = normalized.map(x => Number(x.toFixed(6))).join(',');
        
        stmt.run(newVecStr, row.id);
        updateCount++;
      }
    }
  })();
  
  console.log(`✅ Success! Compressed ${updateCount} vectors from 1536d to 256d in /dev/shm/yata.db.`);
  
} catch (e) {
  console.error("❌ Migration failed:", e);
} finally {
  db.close();
}
