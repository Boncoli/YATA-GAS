/**
 * 強化版メンテナンススクリプト: 英語記事を徹底的に日本語化する
 * Path: maintenance/fix-english-summaries.js
 */

require('../lib/gas-bridge.js');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'yata.db');

// HTMLエンティティを簡易的にデコードする関数
function decodeHtml(text) {
    if (!text) return "";
    return text.replace(/&quot;/g, '"')
               .replace(/&#039;/g, "'")
               .replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>');
}

async function fixEnglishArticles() {
  console.log("🔍 全記事をスキャンして英語記事を特定中...");

  // 全記事取得
  const rows = db.prepare("SELECT id, title, abstract, summary FROM collect").all();
  
  const targets = rows.filter(row => {
    // タイトルまたは要約のいずれかに日本語が含まれているかチェック
    const hasJapanese = (text) => /[぀-ゟ゠-ヿ一-鿿]/.test(text || "");
    
    // タイトルが英語、かつ（要約が空 または 要約が英語）のものをターゲットにする
    const titleIsEnglish = !hasJapanese(decodeHtml(row.title));
    const summaryIsEnglishOrEmpty = !row.summary || !hasJapanese(decodeHtml(row.summary));
    
    return titleIsEnglish || summaryIsEnglishOrEmpty;
  });

  console.log(`📝 修正候補: ${targets.length} 件見つかりました。`);

  const updateStmt = db.prepare("UPDATE collect SET title = ?, summary = ? WHERE id = ?");
  let count = 0;

  for (const target of targets) {
    try {
      let needsUpdate = false;
      let newTitle = target.title;
      let newSummary = target.summary;

      // 1. タイトルが英語なら翻訳
      if (!/[぀-ゟ゠-ヿ一-鿿]/.test(decodeHtml(target.title))) {
        const translatedTitle = LanguageApp.translate(decodeHtml(target.title), "en", "ja");
        if (translatedTitle && translatedTitle !== decodeHtml(target.title)) {
          newTitle = translatedTitle;
          needsUpdate = true;
        }
      }

      // 2. 要約が空、または英語なら翻訳（またはタイトルから生成）
      const cleanSummary = decodeHtml(target.summary);
      if (!cleanSummary || !/[぀-ゟ゠-ヿ一-鿿]/.test(cleanSummary)) {
        // 要約が空ならタイトルを翻訳したものを入れる、英語ならその要約を翻訳する
        const sourceText = cleanSummary || decodeHtml(target.title);
        const translatedSummary = LanguageApp.translate(sourceText, "en", "ja");
        
        if (translatedSummary && translatedSummary !== sourceText) {
          newSummary = translatedSummary;
          needsUpdate = true;
        }
      }

      if (needsUpdate) {
        updateStmt.run(newTitle, newSummary, target.id);
        count++;
        if (count % 10 === 0 || count === targets.length) {
            console.log(`✅ [${count}/${targets.length}] Updated: ${newTitle.substring(0, 30)}...`);
        }
      }
      
      // レート制限回避 (gpt-4.1-nanoは高速だが念のため)
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (e) {
      console.error(`❌ Error on ID ${target.id}:`, e.message);
    }
  }

  console.log(`✨ 完了: ${count} 件の記事を日本語化しました。`);
}

fixEnglishArticles().catch(console.error);
