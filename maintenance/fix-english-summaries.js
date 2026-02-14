/**
 * メンテナンススクリプト: 英語のままの要約を日本語に翻訳する
 * Path: maintenance/fix-english-summaries.js
 */

require('../lib/gas-bridge.js');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'yata.db');

async function fixEnglishSummaries() {
  console.log("🔍 英語のままの要約をスキャン中...");

  // 日本語が含まれていない(英語のみと思われる)要約を取得
  // SQLiteの正規表現は標準では限定的なため、一度取得してからJS側で判定
  const rows = db.prepare("SELECT id, title, summary FROM collect WHERE summary IS NOT NULL AND summary != ''").all();
  
  const targets = rows.filter(row => {
    const text = row.summary;
    // 日本語（ひらがな、カタカナ、漢字）が含まれていないか判定
    return !(/[぀-ゟ゠-ヿ一-鿿]/.test(text));
  });

  console.log(`📝 修正対象: ${targets.length} 件見つかりました。`);

  if (targets.length === 0) return;

  const stmt = db.prepare("UPDATE collect SET summary = ? WHERE id = ?");
  let count = 0;

  for (const target of targets) {
    try {
      const original = target.summary;
      // lib/gas-bridge.js で実装した翻訳機能を使用
      const translated = LanguageApp.translate(original, "en", "ja");

      if (translated && translated !== original) {
        stmt.run(translated, target.id);
        count++;
        console.log(`✅ [${count}/${targets.length}] Translated: "${original.substring(0, 30)}..." -> "${translated.substring(0, 30)}..."`);
      }
      
      // APIレート制限を考慮して少し待機
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
      console.error(`❌ Failed to translate ID: ${target.id}`, e.message);
    }
  }

  console.log(`✨ メンテナンス完了: ${count} 件の要約を翻訳しました。`);
}

fixEnglishSummaries().catch(console.error);
