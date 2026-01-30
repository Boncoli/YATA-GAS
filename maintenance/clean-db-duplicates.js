
const Database = require('better-sqlite3');
const path = require('path');

// DB接続
const dbPath = process.env.DB_PATH || path.join(__dirname, '../yata.db');
console.log(`Using Database: ${dbPath}`);
const db = new Database(dbPath);

function cleanDuplicatesFast() {
  try {
    console.log("Starting FAST cleanup via SQL...");

    // 1. URL重複の削除 (正規化URLベース)
    // URLの http/https, www有無, 末尾スラッシュ を無視してグルーピング
    // 日付が新しい方を残す (MAX(rowid))
    // ※SQLiteで正規表現置換は標準でできないため、簡易的な正規化(RTRIM, LOWER)で対応
    //   より厳密な正規化はNode側でやる必要があるが、速度優先で今回は「完全一致」に近いレベルの重複を消す
    
    // 【SQL戦略】
    // タイトルの「空白除去」「小文字化」を行った結果が同じなら重複とみなす
    // 優先順位: 1.要約(summary)があるもの 2.日付(date)が新しいもの
    
    const sql = `
      DELETE FROM collect 
      WHERE rowid NOT IN (
        SELECT rowid FROM (
          SELECT 
            rowid,
            ROW_NUMBER() OVER (
              PARTITION BY 
                -- タイトルの正規化: 小文字化して、前後の空白を除去
                LOWER(TRIM(title)) 
              ORDER BY 
                -- 優先順位1: 要約が長い（中身がある）方を優先
                (CASE WHEN length(summary) > 10 THEN 1 ELSE 0 END) DESC,
                -- 優先順位2: 日付が新しい方を優先
                date DESC,
                rowid DESC
            ) as rn
          FROM collect
          WHERE title IS NOT NULL AND title != ''
        ) 
        WHERE rn = 1
      );
    `;

    console.log("Executing SQL for Title Duplicates...");
    const result = db.prepare(sql).run();
    console.log(`🗑️ Deleted ${result.changes} duplicate rows (Title based).`);

    // URLベースの重複削除（run-ram.shには入っていないのでここでやる）
    // URLも小文字化・TRIMして比較
    const sqlUrl = `
      DELETE FROM collect 
      WHERE rowid NOT IN (
        SELECT rowid FROM (
          SELECT 
            rowid,
            ROW_NUMBER() OVER (
              PARTITION BY LOWER(TRIM(url)) 
              ORDER BY (CASE WHEN length(summary) > 10 THEN 1 ELSE 0 END) DESC, date DESC
            ) as rn
          FROM collect
        ) 
        WHERE rn = 1
      );
    `;
    
    console.log("Executing SQL for URL Duplicates...");
    const resultUrl = db.prepare(sqlUrl).run();
    console.log(`🗑️ Deleted ${resultUrl.changes} duplicate rows (URL based).`);

    // 仕上げ: VACUUM
    console.log("Vacuuming database...");
    db.exec('VACUUM');
    console.log("✅ Done.");

  } catch (e) {
    console.error("Error:", e);
  } finally {
    db.close();
  }
}

cleanDuplicatesFast();
