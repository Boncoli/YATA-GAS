require('../lib/gas-bridge.js');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'yata.db');

// テーブル作成
db.prepare(`
  CREATE TABLE IF NOT EXISTS finance_log (
    date TEXT PRIMARY KEY,
    usd_jpy REAL,
    nikkei_225 REAL
  )
`).run();

// カラム追加マイグレーション (カラムが存在しない場合のみ追加したいが、SQLiteはIF NOT EXISTSがないのでtry-catchで逃げる)
try { db.prepare("ALTER TABLE finance_log ADD COLUMN ny_dow REAL").run(); } catch (e) {}
try { db.prepare("ALTER TABLE finance_log ADD COLUMN sysmex_6869 REAL").run(); } catch (e) {}

/**
 * Yahoo!ファイナンスから株価・為替を取得して保存する
 */
async function fetchFinance() {
  // ターゲット定義
  const targets = [
    { key: 'usd_jpy', url: 'https://finance.yahoo.co.jp/quote/USDJPY=X', name: 'USD/JPY', code: 'USDJPY=X' },
    { key: 'nikkei_225', url: 'https://finance.yahoo.co.jp/quote/998407.O', name: 'Nikkei 225', code: '998407.O' },
    { key: 'ny_dow', url: 'https://finance.yahoo.co.jp/quote/%5EDJI', name: 'NY Dow', code: '^DJI' },
    { key: 'sysmex_6869', url: 'https://finance.yahoo.co.jp/quote/6869.T', name: 'Sysmex', code: '6869.T' }
  ];

  const results = {};
  
  // 現在時刻 (YYYY/MM/DD HH:mm:ss)
  const nowStr = new Date().toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).replace(/-/g, '/');

  for (const t of targets) {
    try {
      const html = UrlFetchApp.fetch(t.url).getContentText();
      let price = null;

      // パターン1: JSON埋め込み (個別銘柄・為替など)
      // "code":"CODE","price":"1,234.56"
      const regexJson = new RegExp(`"code":"${t.code.replace('.','\\.')}".*?"price":"([0-9,.]+)"`);
      const matchJson = html.match(regexJson);

      if (matchJson) {
        price = parseFloat(matchJson[1].replace(/,/g, ''));
      } else {
        // パターン2: HTML Class (指数ページなど)
        // <span class="_StyledNumber__value_...">1,234.56</span>
        const regexHtml = /class="_StyledNumber__value_[^"]+">([0-9,.]+)<\/span>/;
        const matchHtml = html.match(regexHtml);
        if (matchHtml) {
          price = parseFloat(matchHtml[1].replace(/,/g, ''));
        }
      }
      
      if (price === null) {
         console.warn(`[Finance] ${t.name}: Price not found in HTML.`);
         results[t.key] = null;
         continue;
      }

      results[t.key] = price;
      
      // 少し待機（アクセス集中回避）
      Utilities.sleep(1000);

    } catch (e) {
      console.error(`[Finance] Error fetching ${t.name}:`, e.message);
      results[t.key] = null;
    }
  }

  // DB保存
  // 少なくとも1つデータがあれば保存
  if (Object.values(results).some(v => v !== null && v !== undefined)) {
    try {
      // カラムが増えたのでINSERT文も更新
      const stmt = db.prepare(`INSERT OR REPLACE INTO finance_log VALUES (?, ?, ?, ?, ?)`);
      stmt.run(
        nowStr,
        results.usd_jpy || null,
        results.nikkei_225 || null,
        results.ny_dow || null,
        results.sysmex_6869 || null
      );
      console.log(`[Success] Finance recorded: USD/JPY=${results.usd_jpy}, Nikkei=${results.nikkei_225}, Dow=${results.ny_dow}, Sysmex=${results.sysmex_6869}`);
    } catch (e) {
      console.error("[Finance] DB Error:", e);
    }
  }
}

// 単体実行用 ( node modules/get-finance.js で呼ばれた場合 )
if (require.main === module) {
  fetchFinance();
}

module.exports = fetchFinance;
