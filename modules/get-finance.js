/**
 * YATA DASHBOARD - Market Data Collector (Stooq Fallback Edition)
 * Path: modules/get-finance.js
 */

require('../lib/gas-bridge.js');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'yata.db');

// --- 1. データベース初期化 & マイグレーション ---
db.prepare(`
  CREATE TABLE IF NOT EXISTS finance_log (
    date TEXT PRIMARY KEY,
    usd_jpy REAL,
    nikkei_225 REAL,
    ny_dow REAL,
    sysmex_6869 REAL
  )
`).run();

// 古いDB構造を使っている場合のためのカラム追加
try { db.prepare("ALTER TABLE finance_log ADD COLUMN ny_dow REAL").run(); } catch (e) {}
try { db.prepare("ALTER TABLE finance_log ADD COLUMN sysmex_6869 REAL").run(); } catch (e) {}

/**
 * メイン収集ロジック
 */
async function fetchFinance() {
  // ターゲット定義（YahooとStooqのコードをマッピング）
  const targets = [
    { 
      key: 'usd_jpy', 
      name: 'USD/JPY', 
      url: 'https://finance.yahoo.co.jp/quote/USDJPY=X', 
      code: 'USDJPY=X', 
      stooq: 'usdjpy' 
    },
    { 
      key: 'nikkei_225', 
      name: 'Nikkei 225', 
      url: 'https://finance.yahoo.co.jp/quote/998407.O', 
      code: '998407.O', 
      stooq: '^nkx' 
    },
    { 
      key: 'ny_dow', 
      name: 'NY Dow', 
      url: 'https://finance.yahoo.co.jp/quote/%5EDJI', 
      code: '^DJI', 
      stooq: '^dji' 
    },
    { 
      key: 'sysmex_6869', 
      name: 'Sysmex', 
      url: 'https://finance.yahoo.co.jp/quote/6869.T', 
      code: '6869.T', 
      stooq: '6869.jp' 
    }
  ];

  const results = {};
  
  // 保存用の時刻文字列 (YYYY/MM/DD HH:mm)
  const now = new Date();
  const nowStr = now.toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).replace(/-/g, '/');

  console.log(`[Finance] Starting collection at ${nowStr}`);

  for (const t of targets) {
    let price = null;

    try {
      // --- パターン1: Yahoo!ファイナンス (日本版) から取得 ---
      try {
        const response = UrlFetchApp.fetch(t.url, { muteHttpExceptions: true });
        const html = response.getContentText();

        // 抽出ロジックA: JSONデータ埋め込みを狙う
        const regexJson = new RegExp(`"code":"${t.code.replace('.', '\\.')}".*?"price":"([0-9,.]+)"`);
        const matchJson = html.match(regexJson);

        if (matchJson) {
          price = parseFloat(matchJson[1].replace(/,/g, ''));
        } else {
          // 抽出ロジックB: HTMLタグ (StyledNumber) を狙う
          const regexHtml = /class="_StyledNumber__value_[^"]+">([0-9,.]+)<\/span>/;
          const matchHtml = html.match(regexHtml);
          if (matchHtml) {
            price = parseFloat(matchHtml[1].replace(/,/g, ''));
          }
        }
      } catch (e) {
        console.warn(`[Finance] Yahoo fetch failed for ${t.name}: ${e.message}`);
      }

      // --- パターン2: 回避案 (Stooq) から取得 ---
      if (price === null && t.stooq) {
        console.log(`[Finance] ${t.name}: Falling back to Stooq...`);
        const stooqUrl = `https://stooq.com/q/?s=${t.stooq}`;
        const stooqResponse = UrlFetchApp.fetch(stooqUrl, { muteHttpExceptions: true });
        const stooqHtml = stooqResponse.getContentText();

        // Stooqの価格表示部分を狙う正規表現
        const stooqRegex = new RegExp(`id="aq_${t.stooq.replace('^', '')}_c[0-9]">([0-9,.]+)`);
        const stooqMatch = stooqHtml.match(stooqRegex);

        if (stooqMatch) {
          price = parseFloat(stooqMatch[1].replace(/,/g, ''));
          console.log(`[Finance] ${t.name}: Successfully recovered from Stooq (${price})`);
        }
      }

      if (price !== null) {
        results[t.key] = price;
      } else {
        console.warn(`[Finance] Could not fetch price for ${t.name} from any source.`);
        results[t.key] = null;
      }

      // サイトへの負荷軽減のため少し待機
      Utilities.sleep(1500);

    } catch (e) {
      console.error(`[Finance] Critical error for ${t.name}:`, e.message);
      results[t.key] = null;
    }
  }

  // --- データベースへの保存 ---
  // いずれかのデータが取得できていれば保存を実行
  if (Object.values(results).some(v => v !== null)) {
    try {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO finance_log (date, usd_jpy, nikkei_225, ny_dow, sysmex_6869) 
        VALUES (?, ?, ?, ?, ?)
      `);
      
      stmt.run(
        nowStr,
        results.usd_jpy,
        results.nikkei_225,
        results.ny_dow,
        results.sysmex_6869
      );
      
      console.log(`[Success] Recorded: USD=${results.usd_jpy}, N225=${results.nikkei_225}, Dow=${results.ny_dow}, Sysmex=${results.sysmex_6869}`);
    } catch (e) {
      console.error("[Finance] Database Error:", e.message);
    }
  } else {
    console.error("[Finance] Failed to record: No data fetched from any source.");
  }
}

// Node.js から直接実行された場合の処理
if (require.main === module) {
  fetchFinance().catch(err => {
    console.error("[Finance] Unhandled Promise Rejection:", err);
  });
}

module.exports = fetchFinance;