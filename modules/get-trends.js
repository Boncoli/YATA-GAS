require('../lib/gas-bridge.js');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'yata.db');

// テーブル作成
db.prepare(`
  CREATE TABLE IF NOT EXISTS trend_log (
    date TEXT PRIMARY KEY,
    rank1 TEXT,
    rank2 TEXT,
    rank3 TEXT,
    rank4 TEXT,
    rank5 TEXT
  )
`).run();

/**
 * Yahoo!リアルタイム検索から急上昇ワードを取得して保存する
 */
async function fetchTrends() {
  const url = 'https://search.yahoo.co.jp/realtime';
  
  try {
    const html = UrlFetchApp.fetch(url).getContentText();
    
    // 現在時刻
    const nowStr = new Date().toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(/-/g, '/');

    // 抽出ロジック修正版3:
    // 正規表現が安定しないため、indexOfによる単純探索に変更
    // ターゲット: <span>1</span> ... <article><h1>キーワード</h1></article>
    // 実際のHTMLでは >1</span> となっている
    
    const rankings = [];
    
    for (let i = 1; i <= 5; i++) {
      // 1. 順位の場所を探す
      const rankTag = `>${i}</span>`;
      const rankIndex = html.indexOf(rankTag);
      
      if (rankIndex === -1) {
        rankings.push(null);
        continue;
      }

      // 2. その後ろにある <h1> を探す
      const h1StartTag = "<h1>";
      const h1StartIndex = html.indexOf(h1StartTag, rankIndex);
      
      if (h1StartIndex === -1) {
        rankings.push(null);
        continue;
      }

      // 3. </h1> を探す
      const h1EndTag = "</h1>";
      const h1EndIndex = html.indexOf(h1EndTag, h1StartIndex);
      
      if (h1EndIndex === -1) {
        rankings.push(null);
        continue;
      }

      // 4. キーワード抽出
      // h1StartIndex + 4 (<h1>の長さ) から h1EndIndex まで
      const word = html.substring(h1StartIndex + h1StartTag.length, h1EndIndex).trim();
      
      // ゴミ除外（念のため）
      if (word === "急上昇ワード" || word === "") {
         rankings.push(null);
      } else {
         rankings.push(word);
      }
    }

    // ログ出力
    const logWords = rankings.filter(w => w).join(', ');
    
    if (logWords) {
      const stmt = db.prepare(`INSERT OR REPLACE INTO trend_log VALUES (?, ?, ?, ?, ?, ?)`);
      stmt.run(
        nowStr,
        rankings[0],
        rankings[1],
        rankings[2],
        rankings[3],
        rankings[4]
      );
      console.log(`[Success] Trends recorded: ${logWords}`);
    } else {
      console.warn("[Trends] No keywords found.");
    }

  } catch (e) {
    console.error("[Trends] Error:", e);
  }
}

// 単体実行用
if (require.main === module) {
  fetchTrends();
}

module.exports = fetchTrends;
