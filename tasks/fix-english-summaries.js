/**
 * 修正版メンテナンススクリプト: 要約が英語の記事のみを日本語化する
 */

require('../lib/gas-bridge.js');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'yata.db');

async function fixEnglishArticles() {
  console.log("🔍 要約が英語の記事をスキャン中...");

  // 要約が英語（日本語を含まない）記事のみを抽出
  const rows = db.prepare("SELECT id, title, summary FROM collect WHERE summary NOT GLOB '*[ぁ-んァ-ヶ]*' AND summary != '' ORDER BY date DESC").all();
  
  const targets = rows;

  console.log(`📝 修正開始: 修正候補 ${targets.length} 件を処理します。`);

  const updateStmt = db.prepare("UPDATE collect SET summary = ? WHERE id = ?");
  let count = 0;

  for (const target of targets) {
    try {
      // 要約を翻訳（LLMによる見出し生成）
      const translatedSummary = LanguageApp.translate(target.summary, "en", "ja");
      
      if (translatedSummary && translatedSummary !== target.summary) {
        updateStmt.run(translatedSummary, target.id);
        count++;
        if (count % 10 === 0 || count === targets.length) {
            console.log(`✅ [${count}/${targets.length}] Updated: ${translatedSummary.substring(0, 40)}...`);
        }
      }
    } catch (e) {
      console.error(`❌ Error on ID ${target.id}:`, e.message);
    }
  }

  console.log(`✨ 完了: ${count} 件の記事を日本語化しました。`);
}

fixEnglishArticles().catch(console.error);
