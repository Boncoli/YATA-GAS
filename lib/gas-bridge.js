const dotenv = require('dotenv');
const crypto = require('crypto');
const fetch = require('sync-fetch'); 
const Database = require('better-sqlite3');
const fs = require('fs'); // ★追加
const path = require('path'); // ★追加

dotenv.config({ path: path.join(__dirname, '../.env') });

// --- ログフィルター (特定の冗長なログを抑制) ---
const originalLog = console.log;
const originalWarn = console.warn;
const logFilter = (args) => {
  const msg = String(args[0] || "");
  return msg.includes("XMLパース失敗") || msg.includes("[RegexFallback]");
};
console.log = (...args) => { if (!logFilter(args)) originalLog(...args); };
console.warn = (...args) => { if (!logFilter(args)) originalWarn(...args); };

// --- 1. SQLite 初期化 ---
// DBパスを環境変数から取得。なければ従来の 'yata.db' (カレント) を使う
const dbPath = process.env.DB_PATH || 'yata.db';
console.log(`[Bridge] Using Database: ${dbPath}`); 
const db = new Database(dbPath);
// WALモードで同時アクセスに強くする
db.pragma('journal_mode = WAL');

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
  CREATE TABLE IF NOT EXISTS history (
    date TEXT,
    keyword TEXT,
    summary TEXT,
    vector TEXT
  );
`);

// --- プロパティ永続化 (server-properties.json) ---
const PROPS_FILE = './server-properties.json';
let cachedProps = {};

function loadProps() {
  try {
    if (fs.existsSync(PROPS_FILE)) {
      cachedProps = JSON.parse(fs.readFileSync(PROPS_FILE, 'utf8'));
    }
  } catch (e) { console.error("Props Load Error:", e); }
  return { ...process.env, ...cachedProps }; 
}

function saveProp(key, value) {
  cachedProps[key] = String(value);
  try {
    fs.writeFileSync(PROPS_FILE, JSON.stringify(cachedProps, null, 2));
  } catch (e) { console.error("Props Save Error:", e); }
}

global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (key) => {
      const p = loadProps();
      return p[key];
    },
    getProperties: () => loadProps(),
    setProperty: (key, value) => {
      saveProp(key, value);
    },
    setProperties: (props) => {
      for (let k in props) saveProp(k, props[k]);
    },
    deleteAllProperties: () => {
      cachedProps = {};
      try { if(fs.existsSync(PROPS_FILE)) fs.unlinkSync(PROPS_FILE); } catch(e){}
    }
  })
};

global.LockService = {
  getScriptLock: () => ({
    tryLock: (timeout) => true, 
    releaseLock: () => {},
    waitLock: (timeout) => {}
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

// ★★★ 改行入りCSVも正しく読めるパーサー関数 ★★★
function parseCSV(text) {
  const rows = [];
  let currentRow = [];
  let currentCell = '';
  let insideQuote = false;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i+1];
    
    if (char === '"') {
      if (insideQuote && nextChar === '"') {
        currentCell += '"';
        i++; 
      } else {
        insideQuote = !insideQuote;
      }
    } 
    else if (char === ',' && !insideQuote) {
      currentRow.push(currentCell);
      currentCell = '';
    } 
    else if ((char === '\r' || char === '\n') && !insideQuote) {
      if (char === '\r' && nextChar === '\n') i++; 
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
    } 
    else {
      currentCell += char;
    }
  }
  if (currentCell || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }
  return rows;
}

// --- 2. SpreadsheetApp (修正版) ---
const mockSheet = (name) => {
  
  // A. プロンプト
  let promptData = [
    ["key", "value"],
    ["BATCH_SYSTEM", process.env.BATCH_SYSTEM || ""],
    ["BATCH_USER_TEMPLATE", process.env.BATCH_USER_TEMPLATE || ""],
    ["summary_only", "事実のみを簡潔に日本語で要約してください。"]
  ];

  if ((name === "prompt" || name === "PROMPTS" || name === "Prompt") && process.env.PROMPTS_CSV_URL) {
    try {
      const csvText = fetch(process.env.PROMPTS_CSV_URL).text();
      const parsedRows = parseCSV(csvText);
      const cleanData = parsedRows.filter(row => row.length >= 2 && row[0].trim() !== "").map(row => {
        return [row[0].trim(), row[1].trim()];
      });
      if (cleanData.length > 0) {
        promptData = cleanData;
      }
    } catch (e) {
      console.error(`[Bridge] Prompt CSV Sync Error:`, e.message);
    }
  }

  // B. RSSリスト (ローカルJSON優先)
  let feedData = [["label", "url", "category", "active"]];
  if (name === "RSS" || name === "feeds") {
      try {
        const jsonPath = './rss-list.json';
        if (fs.existsSync(jsonPath)) {
            const localList = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            feedData = [["label", "url", "category", "active"]];
            localList.forEach(item => {
                if(item.active) {
                    feedData.push([item.label, item.url, item.category || "General", "TRUE"]);
                }
            });
        } else if (process.env.FEEDS_CSV_URL) {
             const csv = fetch(process.env.FEEDS_CSV_URL).text();
             feedData = csv.split(/\r?\n/).filter(line => line.trim() !== "").map((line, idx) => {
                const parts = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.replace(/^"(.*)"$/, '$1').trim());
                return idx === 0 ? ["label", "url", "category", "active"] : [parts[0], parts[1], "General", "TRUE"];
             });
        }
      } catch (e) { console.error(`[Bridge] Feed Sync error:`, e.message); }
  }

  // C. 収集データ
  let dbRows = [];
  if (name === "collect" || name === "TrendData" || name === "collect_data") { 
    try {
      const rows = db.prepare('SELECT * FROM collect ORDER BY date DESC').all();
      
      // ★★★ ここが一番重要！ 文字列を Dateオブジェクト に変換 ★★★
      dbRows = [
        ["date", "title", "url", "abstract", "summary", "source", "vector"], 
        ...rows.map(r => [
            new Date(r.date),  // <--- これがないと検索できません！
            r.title, 
            r.url, 
            r.abstract, 
            r.summary, 
            r.source, 
            r.vector
        ])
      ];
    } catch (e) { console.error(`[Bridge] DB Read Error:`, e.message); }
  }

  // D. DigestHistory (履歴)
  let historyRows = [];
  if (name === "DigestHistory" || name === "History") {
    try {
      const rows = db.prepare('SELECT * FROM history ORDER BY date ASC').all(); // 古い順
      historyRows = [
        ["Date", "Keyword", "Summary", "Vector"],
        ...rows.map(r => [
          new Date(r.date),
          r.keyword,
          r.summary,
          r.vector
        ])
      ];
    } catch (e) { console.error(`[Bridge] History DB Read Error:`, e.message); }
  }

  const getTargetData = () => {
    if (name === "prompt" || name === "PROMPTS" || name === "Prompt") return promptData;
    if (name === "RSS" || name === "feeds") return feedData;
    if (name === "collect" || name === "TrendData" || name === "collect_data") return dbRows;
    if (name === "DigestHistory" || name === "History") return historyRows;
    return [[]];
  };

  return {
    getLastRow: () => getTargetData().length,
    getLastColumn: () => 8, 
    getDataRange: () => ({ getValues: () => getTargetData() }),
    getRange: (row, col, rows, cols) => ({
      getValues: () => {
        const data = getTargetData();
        const slice = data.slice(row - 1, row - 1 + (rows || 1));
        if (cols) {
           return slice.map(r => r.slice(col - 1, col - 1 + cols));
        }
        return slice;
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
              summary = CASE WHEN excluded.summary IS NOT NULL AND excluded.summary != '' THEN excluded.summary ELSE summary END,
              source = excluded.source,
              vector = CASE WHEN excluded.vector IS NOT NULL AND excluded.vector != '' THEN excluded.vector ELSE vector END
          `);
          
          const insertMany = db.transaction((rows) => {
            for (const r of rows) {
              if (!r[1] || !r[2]) continue;
              const date = r[0]; const title = r[1]; const url = r[2];
              const abstract = r[3]; const summary = r[4]; const source = r[5];
              const vector = r[6] || ""; const id = url; 

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
      if (name === "DigestHistory" || name === "History") {
        try {
            // DigestHistoryは「古い順(ASC)」で並んでいる前提で、上から(start=2)削除される。
            // SQLiteで「最も古いN件」を削除する。
            // startパラメータは基本的に「2」(ヘッダーの次)が来るはず。
            if (start === 2) {
                const stmt = db.prepare(`
                    DELETE FROM history 
                    WHERE rowid IN (
                        SELECT rowid FROM history ORDER BY date ASC LIMIT ?
                    )
                `);
                const info = stmt.run(num);
                console.log(`[DB] Deleted ${info.changes} old history rows.`);
            } else {
                console.warn(`[Bridge] Complex deleteRows(${start}, ${num}) for history not fully supported. Only top-deletion (start=2) is implemented.`);
            }
        } catch (e) {
            console.error(`[DB] History Delete Error:`, e.message);
        }
      } else {
        console.log(`[Bridge] DeleteRows ignored: Persistent storage mode is active.`);
      }
    },
    appendRow: (row) => {
      if (name === 'log') {
        const p = row.map(v => (v instanceof Date ? v.toISOString() : v ?? ""));
        db.prepare(`INSERT INTO log VALUES (?, ?, ?)`).run(String(p[0]), p[1], p[2]);
      }
      if (name === "DigestHistory" || name === "History") {
          try {
              const p = row.map(v => {
                  if (v instanceof Date) return v.toISOString();
                  return v ?? "";
              });
              db.prepare(`INSERT INTO history (date, keyword, summary, vector) VALUES (?, ?, ?, ?)`).run(p[0], p[1], p[2], p[3]);
              console.log(`[DB] Appended history for: ${p[1]}`);
          } catch(e) { console.error(`[DB] History Append Error:`, e.message); }
      }
      if (name === "collect" || name === "TrendData" || name === "collect_data") {
        try {
            const date = row[0]; const title = row[1]; const url = row[2];
            const abstract = row[3] || ""; const summary = row[4] || "";
            const source = row[5] || ""; const vector = row[6] || "";
            const id = url;

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

global.LanguageApp = { 
  translate: (text, source, target) => { 
    if (!text) return "";
    
    // .envの設定を利用 (OPENAI_API_KEY_PERSONAL, OPENAI_MODEL_NANO)
    const apiKey = process.env.OPENAI_API_KEY_PERSONAL;
    const model = process.env.OPENAI_MODEL_NANO || "gpt-4o-mini";

    if (!apiKey) {
      return text;
    }

    try {
      const payload = {
        model: model,
        messages: [
          { role: "system", content: "Translate the following text into natural Japanese. Output only the translation." },
          { role: "user", content: text }
        ],
        temperature: 0.3
      };
      
      const res = fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload)
      });
      
      if (res.status !== 200) {
        const errText = res.text();
        console.warn(`[Bridge] Translation API Error: ${res.status} - ${errText}`);
        return text;
      }
      
      const json = res.json();
      const translated = json.choices[0].message.content.trim();
      return translated;
      
    } catch (e) {
      console.error(`[Bridge] Translate Error: ${e.message}`);
      return text;
    }
  } 
};

console.log("✅ GAS Bridge Loaded (Date Fix Applied)");

module.exports = {};