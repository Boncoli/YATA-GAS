const dotenv = require('dotenv');
const crypto = require('crypto');
const fetch = require('sync-fetch'); 
const Database = require('better-sqlite3');

dotenv.config();

// --- 1. SQLite 初期化 ---
// DBパスを環境変数から取得。なければ従来の 'yata.db' (カレント) を使う
const dbPath = process.env.DB_PATH || 'yata.db';
console.log(`[Bridge] Using Database: ${dbPath}`); // 確認用ログ
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS collect (
    id TEXT PRIMARY KEY, 
    date TEXT, 
    title TEXT, 
    url TEXT, 
    abstract TEXT, 
    summary TEXT, 
    source TEXT, 
    category TEXT,
    vector TEXT
  );
  CREATE TABLE IF NOT EXISTS log (timestamp TEXT, level TEXT, message TEXT);
  CREATE TABLE IF NOT EXISTS weather_forecast (
    date TEXT PRIMARY KEY,
    temp_min REAL,
    temp_max REAL,
    weather_main TEXT,
    weather_desc TEXT,
    pop REAL,
    humidity INTEGER,
    updated_at TEXT
  );
`);

global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (key) => process.env[key],
    getProperties: () => process.env
  })
};

global.UrlFetchApp = {
  fetch: (url, options = {}) => {
    const headers = { ...options.headers };
    if (options.contentType) headers['Content-Type'] = options.contentType;
    else if (options.payload) headers['Content-Type'] = 'application/json';
    try {
        const res = fetch(url, { method: (options.method || 'get').toUpperCase(), headers: headers, body: options.payload || null });
        return { getContentText: () => res.text(), getResponseCode: () => res.status };
    } catch (e) {
        console.error(`Fetch Error: ${url}`, e.message);
        return { getContentText: () => "", getResponseCode: () => 500 };
    }
  },
  fetchAll: (requests) => requests.map(req => global.UrlFetchApp.fetch(req.url || req, req))
};

// ★★★ 追加: 改行入りCSVも正しく読めるパーサー関数 ★★★
function parseCSV(text) {
  const rows = [];
  let currentRow = [];
  let currentCell = '';
  let insideQuote = false;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i+1];
    
    // クォートの処理 ("" はエスケープされた " とみなす)
    if (char === '"') {
      if (insideQuote && nextChar === '"') {
        currentCell += '"';
        i++; 
      } else {
        insideQuote = !insideQuote;
      }
    } 
    // カンマの処理 (クォート外なら区切り)
    else if (char === ',' && !insideQuote) {
      currentRow.push(currentCell);
      currentCell = '';
    } 
    // 改行の処理 (クォート外なら行末)
    else if ((char === '\r' || char === '\n') && !insideQuote) {
      if (char === '\r' && nextChar === '\n') i++; // CRLF対応
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
    } 
    // 普通の文字
    else {
      currentCell += char;
    }
  }
  // 最後の残りを追加
  if (currentCell || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }
  return rows;
}

// --- 2. SpreadsheetApp (修正版) ---
const mockSheet = (name) => {
  
  // A. プロンプト (CSV同期対応)
  let promptData = [
    ["key", "value"],
    ["BATCH_SYSTEM", process.env.BATCH_SYSTEM || ""],
    ["BATCH_USER_TEMPLATE", process.env.BATCH_USER_TEMPLATE || ""],
    ["summary_only", "事実のみを簡潔に日本語で要約してください。"]
  ];

  if ((name === "prompt" || name === "PROMPTS" || name === "Prompt") && process.env.PROMPTS_CSV_URL) {
    try {
      const csvText = fetch(process.env.PROMPTS_CSV_URL).text();
      // ★自作パーサーで解析 (改行入りセルもOK)
      const parsedRows = parseCSV(csvText);
      
      // 空行やヘッダーらしきものを除去しつつ整形
      const cleanData = parsedRows.filter(row => row.length >= 2 && row[0].trim() !== "").map(row => {
        // キーと値の前後の空白を除去し、先頭2列だけ取得
        return [row[0].trim(), row[1].trim()];
      });

      if (cleanData.length > 0) {
        promptData = cleanData;
        // console.log(`[Bridge] プロンプト ${cleanData.length} 件を読み込みました。`);
        
        // デバッグ: 確認用
        // const target = promptData.find(r => r[0] === 'BATCH_SYSTEM');
        // if(target) console.log("[Bridge] ✅ BATCH_SYSTEM is Ready.");
      }
    } catch (e) {
      console.error(`[Bridge] Prompt CSV Sync Error:`, e.message);
    }
  }

  // B. RSSリスト
  let feedData = [["label", "url", "category", "active"]];
  if ((name === "RSS" || name === "feeds") && process.env.FEEDS_CSV_URL) {
    try {
      const csv = fetch(process.env.FEEDS_CSV_URL).text();
      // RSSリストは改行入りセルがない前提で簡易パース (高速化のため)
      feedData = csv.split(/\r?\n/).filter(line => line.trim() !== "").map((line, idx) => {
        const parts = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.replace(/^"(.*)"$/, '$1').trim());
        return idx === 0 ? ["label", "url", "category", "active"] : [parts[0], parts[1], "General", "TRUE"];
      });
    } catch (e) { console.error(`[Bridge] Feed CSV Sync error:`, e.message); }
  }

  // C. 収集データ
  let dbRows = [];
  if (name === "collect" || name === "TrendData" || name === "collect_data") { 
    try {
      const rows = db.prepare('SELECT * FROM collect ORDER BY date DESC').all();
      dbRows = [
        ["date", "title", "url", "abstract", "summary", "source", "vector"], 
        ...rows.map(r => [r.date, r.title, r.url, r.abstract, r.summary, r.source, r.vector])
      ];
    } catch (e) { console.error(`[Bridge] DB Read Error:`, e.message); }
  }

  const getTargetData = () => {
    if (name === "prompt" || name === "PROMPTS" || name === "Prompt") return promptData;
    if (name === "RSS" || name === "feeds") return feedData;
    if (name === "collect" || name === "TrendData" || name === "collect_data") return dbRows;
    return [[]];
  };

  return {
    getLastRow: () => getTargetData().length,
    getLastColumn: () => 8, 
    getDataRange: () => ({ getValues: () => getTargetData() }),
    getRange: (row, col, rows, cols) => ({
      getValues: () => {
        const data = getTargetData().slice(row - 1, row - 1 + (rows || 1));
        // ★Fix: 指定された列範囲だけを切り出す (Gasは1-based index)
        if (cols) {
           return data.map(r => r.slice(col - 1, col - 1 + cols));
        }
        return data; // cols未指定なら行全体(あるいは開始列以降?) GAS仕様的にはcols必須だが、安全策
      },
      getValue: () => {
        const d = getTargetData();
        return (d[row-1] ? d[row-1][col-1] : "");
      },
      setValues: (values) => {
        if (name === "collect" || name === "TrendData" || name === "collect_data") {
          
          const stmt = db.prepare(`
            INSERT INTO collect (id, date, title, url, abstract, summary, source, vector) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              date = excluded.date,
              title = excluded.title,
              abstract = excluded.abstract,
              -- ★ここが重要！ 新しいsummaryが空なら、古いsummaryを維持する。空じゃなければ更新する。
              summary = CASE WHEN excluded.summary IS NOT NULL AND excluded.summary != '' THEN excluded.summary ELSE summary END,
              source = excluded.source,
              vector = CASE WHEN excluded.vector IS NOT NULL AND excluded.vector != '' THEN excluded.vector ELSE vector END
          `);
          
          const insertMany = db.transaction((rows) => {
            for (const r of rows) {
              if (!r[1] || !r[2]) continue;
              const date = r[0];
              const title = r[1];
              const url = r[2];
              const abstract = r[3];
              const summary = r[4];
              const source = r[5];
              const vector = r[6] || ""; 
              const id = url; 

              const params = [id, date, title, url, abstract, summary, source, vector].map(v => {
                if (v instanceof Date) return v.toISOString();
                if (v === null || v === undefined) return "";
                return String(v);
              });
              stmt.run(...params);
            }
          });
          try {
            insertMany(values);
            console.log(`[DB] Inserted/Updated ${values.length} rows.`);
          } catch (err) {
            console.error("[DB] Insert Error:", err.message);
          }
        }
      },
      setValue: () => {},
      sort: (spec) => {},
      clearContent: () => {}
    }),
    deleteRows: (start, num) => {
      // らずぱい環境では全データを永続保持するため、あえて削除を実行しません。
      console.log(`[Bridge] DeleteRows ignored: Persistent storage mode is active.`);
    },
    appendRow: (row) => {
      if (name === 'log') {
        const p = row.map(v => (v instanceof Date ? v.toISOString() : v ?? ""));
        db.prepare(`INSERT INTO log VALUES (?, ?, ?)`).run(String(p[0]), p[1], p[2]);
      }
      if (name === "collect" || name === "TrendData" || name === "collect_data") {
        try {
            // appendRow receives [date, title, url, abstract, summary, source, vector]
            // Note: input row might be shorter than 7 columns.
            const date = row[0];
            const title = row[1];
            const url = row[2];
            const abstract = row[3] || "";
            const summary = row[4] || "";
            const source = row[5] || "";
            const vector = row[6] || "";
            const id = url; // ID is URL

            if (id) {
                const stmt = db.prepare(`
                    INSERT INTO collect (id, date, title, url, abstract, summary, source, vector)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO NOTHING
                `);
                
                const params = [id, date, title, url, abstract, summary, source, vector].map(v => {
                    if (v instanceof Date) return v.toISOString();
                    if (v === null || v === undefined) return "";
                    return String(v);
                });
                
                const info = stmt.run(...params);
                if (info.changes > 0) {
                    console.log(`[DB] Appended new article: ${title}`);
                }
            }
        } catch (e) {
            console.error(`[DB] Append Error:`, e.message);
        }
      }
    }
  };
};

global.SpreadsheetApp = {
  getActiveSpreadsheet: () => ({ getSheetByName: (name) => mockSheet(name) }),
  openById: (id) => ({ getSheetByName: (name) => mockSheet(name) }),
  flush: () => {}
};

global.XmlService = { parse: () => { throw new Error("Bridge: Switch to regex fallback"); }, getNamespace: () => ({}) };

global.Utilities = {
  sleep: (ms) => { const start = Date.now(); while (Date.now() - start < ms); },
  formatDate: (date, tz, format) => {
    try {
        const d = (date instanceof Date) ? date : new Date(date);
        if (isNaN(d.getTime())) return ""; 
        const pad = (n) => n.toString().padStart(2, '0');
        return format.replace(/yyyy|MM|dd|H|mm|ss/g, m => ({'yyyy':d.getFullYear(),'MM':pad(d.getMonth()+1),'dd':pad(d.getDate()),'H':d.getHours(),'mm':pad(d.getMinutes()),'ss':pad(d.getSeconds())}[m]));
    } catch(e) { return ""; }
  },
  computeDigest: (alg, val) => Array.from(new Uint8Array(crypto.createHash('md5').update(val).digest())).map(b => (b > 127 ? b - 256 : b)),
  DigestAlgorithm: { MD5: 'md5' }
};

global.Logger = { log: (msg) => console.log(`[GAS-Log] ${msg}`) };
global.Session = { getScriptTimeZone: () => "Asia/Tokyo" };

global.LanguageApp = { translate: (text, source, target) => { return text; } };

console.log("✅ GAS Bridge Loaded (CSV Parser Fixed)");

module.exports = {};