const dotenv = require('dotenv');
const crypto = require('crypto');
const Database = require('better-sqlite3');const fs = require('fs'); 
const path = require('path'); 
const nodemailer = require('nodemailer'); 

dotenv.config({ path: path.join(__dirname, '../.env'), override: true }); // .envの設定を優先上書き
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // SSL証明書エラー対策
process.env.NODE_NO_WARNINGS = '1'; // sync-fetchの内部ワーカーが毎度警告を出すのを抑制

const originalLog = console.log;
const originalWarn = console.warn;
const logFilter = (args) => {
  const msg = String(args[0] || "");
  return msg.includes("XMLパース失敗") || msg.includes("[RegexFallback]");
};
console.log = (...args) => { if (!logFilter(args)) originalLog(...args); };
console.warn = (...args) => { if (!logFilter(args)) originalWarn(...args); };

const dbPath = process.env.DB_PATH || path.join(__dirname, '../yata.db');
const db = global.YATA_DB || new Database(dbPath);
if (!global.YATA_DB) {
  global.YATA_DB = db; // グローバルに保持
  console.log(`✅ [GAS-Bridge] Database opened: ${dbPath}`);
  db.pragma('journal_mode = WAL');
} else {
  console.log(`✅ [GAS-Bridge] Shared database connection active.`);
}

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
    vector TEXT, 
    method_vector TEXT,
    tldr TEXT,
    who TEXT,
    what TEXT,
    "when" TEXT,
    "where" TEXT,
    why TEXT,
    how TEXT,
    result TEXT,
    keywords TEXT
  );
  CREATE TABLE IF NOT EXISTS log (timestamp TEXT, level TEXT, message TEXT);
  CREATE TABLE IF NOT EXISTS weather_forecast (date TEXT PRIMARY KEY, temp_min REAL, temp_max REAL, weather_main TEXT, weather_desc TEXT, pop REAL, humidity INTEGER, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS weather_hourly (datetime TEXT PRIMARY KEY, temp REAL, weather_main TEXT, weather_desc TEXT, pop REAL, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS history (date TEXT, keyword TEXT, summary TEXT, vector TEXT);
  CREATE TABLE IF NOT EXISTS api_usage_daily (date TEXT, model TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0, cost REAL DEFAULT 0, PRIMARY KEY (date, model));
`);

/**
 * [Bridge Hook] 詳細なAPI使用量をSQLiteに記録する (LlmService._trackCostから呼ばれる)
 */
global.recordDetailedApiUsage_ = (modelName, input, output, reasoning, cost) => {
  try {
    const today = new Date().toLocaleDateString('sv-SE');
    const stmt = db.prepare(`
      INSERT INTO api_usage_daily (date, model, input_tokens, output_tokens, reasoning_tokens, cost)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, model) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
        cost = cost + excluded.cost
    `);
    stmt.run(today, modelName, input, output, reasoning, cost);

    // 追加: 個別通信の詳細ログをRAMディスクに追記 (NASへ日次退避される)
    try {
      const timestamp = new Date().toISOString();
      const logEntry = JSON.stringify({ timestamp, model: modelName, input_tokens: input, output_tokens: output, reasoning_tokens: reasoning, cost }) + "\n";
      fs.appendFileSync('/dev/shm/api_usage.log', logEntry);
    } catch (fsErr) {
      // /dev/shm が使えない環境へのフォールバック
      try {
        const logDir = path.join(__dirname, '../logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(path.join(logDir, 'api_usage.log'), logEntry);
      } catch(e) {}
    }

  } catch (e) {
    console.error(`[Bridge Error] Failed to record API usage: ${e.message}`);
  }
};

// カラム追加のマイグレーション (既存DBへの対応)
const columnsToAdd = ['tldr', 'who', 'what', 'when', 'where', 'why', 'how', 'result', 'keywords'];
columnsToAdd.forEach(col => {
  try { db.exec(`ALTER TABLE collect ADD COLUMN ${col === 'when' || col === 'where' ? '"' + col + '"' : col} TEXT`); } catch(e) {}
});
try { db.exec('ALTER TABLE collect ADD COLUMN method_vector TEXT'); } catch(e) {}

const PROPS_FILE = './server-properties.json';
let cachedProps = {};
function loadProps() { try { if (fs.existsSync(PROPS_FILE)) { cachedProps = JSON.parse(fs.readFileSync(PROPS_FILE, 'utf8')); } } catch (e) {} return { ...process.env, ...cachedProps }; }
function saveProp(key, value) { if (process.env.DRY_RUN === "TRUE") return; cachedProps[key] = String(value); try { fs.writeFileSync(PROPS_FILE, JSON.stringify(cachedProps, null, 2)); } catch (e) {} }
function deleteProp(key) { delete cachedProps[key]; try { fs.writeFileSync(PROPS_FILE, JSON.stringify(cachedProps, null, 2)); } catch (e) {} }

global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (key) => loadProps()[key],
    getProperties: () => loadProps(),
    getKeys: () => Object.keys(loadProps()),
    setProperty: (key, value) => saveProp(key, value),
    setProperties: (props) => { for (let k in props) saveProp(k, props[k]); },
    deleteProperty: (key) => deleteProp(key),
    deleteAllProperties: () => { cachedProps = {}; try { if(fs.existsSync(PROPS_FILE)) fs.unlinkSync(PROPS_FILE); } catch(e){} }
  })
};

const { execSync } = require('child_process');

global.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {}, waitLock: () => {} }) };

global.UrlFetchApp = { 
  fetch: (url, options = {}) => {
    let curlCmd = `curl -s -L --compressed -w "%{http_code}" `;
    
    // Ignore SSL errors
    curlCmd += `-k `;
    
    // Network Resilience (Retry up to 3 times if transient error occurs)
    curlCmd += `--retry 3 --retry-delay 2 --connect-timeout 10 `;

    // Timeout set to 300 seconds (5 minutes) to allow complex LLM generations
    curlCmd += `--max-time 300 `;

    // Headers
    const headers = { ...options.headers };
    if (options.contentType) headers['Content-Type'] = options.contentType;
    else if (options.payload) headers['Content-Type'] = 'application/json';

    let logCurlCmd = curlCmd;

    for (const [key, value] of Object.entries(headers)) {
      // Escape single quotes in header values
      const escapedValue = String(value).replace(/'/g, "'\\''");
      curlCmd += `-H '${key}: ${escapedValue}' `;
      
      const logValue = (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'api-key') ? 'Bearer sk-[MASKED]' : escapedValue;
      logCurlCmd += `-H '${key}: ${logValue}' `;
    }

    // Method & Payload
    const method = (options.method || 'get').toUpperCase();
    if (method !== 'GET') {
      curlCmd += `-X ${method} `;
      logCurlCmd += `-X ${method} `;
    }
    if (options.payload) {
      // Escape single quotes in payload
      const escapedPayload = String(options.payload).replace(/'/g, "'\\''");
      curlCmd += `-d '${escapedPayload}' `;
      
      // パイロードが巨大な場合もあるため、ログ出力時は制限する（任意）
      logCurlCmd += `-d '${escapedPayload.substring(0, 1000)}${escapedPayload.length > 1000 ? '...[TRUNCATED]' : ''}' `;
    }

    curlCmd += `"${url}"`;
    logCurlCmd += `"${url}"`;

    if (process.env.DEBUG_CURL === 'true') {
      console.log(`[UrlFetchApp] 🛠️ Executing: ${logCurlCmd}`); // デバッグ用 (マスク済み)
    }

    try {
      // Execute curl synchronously
      const output = execSync(curlCmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 50 }); // 50MB buffer
      
      // curl appends the http_code at the very end due to -w "%{http_code}"
      const httpCodeStr = output.slice(-3);
      let responseCode = parseInt(httpCodeStr, 10);
      let contentText = output.slice(0, -3);

      if (isNaN(responseCode)) {
         responseCode = 500;
         contentText = output; // Fallback if format is unexpected
      }

      // デバッグ強化: 200 以外の場合はレスポンス内容をログ出力する
      if (responseCode !== 200 && responseCode !== 0) {
        console.error(`[UrlFetchApp] ❌ Fetch Error (${responseCode}): ${url}`);
        console.error(`📄 Response Body: ${contentText}`);
      }

      return { 
        getContentText: () => contentText, 
        getResponseCode: () => responseCode 
      };
    } catch (e) {
      console.error(`[UrlFetchApp] ❌ Fetch error (curl): ${e.message} (URL: ${url})`);
      return { getContentText: () => "", getResponseCode: () => 500 };
    }
  }, 
  fetchAll: (requests) => requests.map(req => global.UrlFetchApp.fetch(req.url || req, req)) 
};

const mockSheet = (name) => {
  const currentDay = ["日", "月", "火", "水", "木", "金", "土"][new Date().getDay()];
  const getTargetData = () => {
    const n = name.toLowerCase();
    if (n === "prompt" || n === "prompts") {
      try {
        const localPath = path.join(__dirname, '../prompts_local.json');
        const standardPath = path.join(__dirname, '../prompts.json');
        const jsonPath = fs.existsSync(localPath) ? localPath : standardPath;
        if (fs.existsSync(jsonPath)) return [["key", "value"], ...Object.entries(JSON.parse(fs.readFileSync(jsonPath, 'utf8')))];
      } catch (e) {}
    }
    if (n === "collect" || n === "trenddata" || n === "collect_data") {
      try { const rows = db.prepare('SELECT * FROM collect ORDER BY date DESC').all(); return [["date", "title", "url", "abstract", "summary", "source", "vector", "method_vector", "tldr", "who", "what", "when", "where", "why", "how", "result", "keywords"], ...rows.map(r => [new Date(r.date), r.title, r.url, r.abstract, r.summary, r.source, r.vector, r.method_vector, r.tldr, r.who, r.what, r.when, r.where, r.why, r.how, r.result, r.keywords])]; } catch (e) {}
    }
    if (n === "digesthistory" || n === "history") {
      try { const rows = db.prepare('SELECT * FROM history ORDER BY date ASC').all(); return [["Date", "Keyword", "Summary", "Vector"], ...rows.map(r => [new Date(r.date), r.keyword, r.summary, r.vector])]; } catch (e) {}
    }
    if (n === "rss" || n === "rss_list") {
      try { const rssPath = path.join(__dirname, "../rss-list.json"); if (fs.existsSync(rssPath)) { const list = JSON.parse(fs.readFileSync(rssPath, "utf8")); return [["Label", "URL"], ...list.filter(item => item.active).map(item => [item.label, item.url])]; } } catch (e) {}
    }
    if (n === "keywords") {
      try { const rssPath = path.join(__dirname, "../rss-list.json"); if (fs.existsSync(rssPath)) { const list = JSON.parse(fs.readFileSync(rssPath, "utf8")); return [["検索クエリ", "有効フラグ", "配信曜日", "ラベル"], ...list.map(item => [item.url, item.active ? "TRUE" : "FALSE", currentDay, item.label])]; } } catch (e) {}
    }
    if (n === "users") {
      return [
        ["名前", "メールアドレス", "配信曜日(空:毎日)", "キーワード(カンマ区切り)", "AI意味検索(TRUE/FALSE)", "日刊KWダイジェスト(TRUE/FALSE)"],
        [
          "Admin", 
          process.env.MAIL_TO || "", 
          "", 
          process.env.USER_KEYWORDS || "", 
          (process.env.USE_SEMANTIC === "TRUE"), 
          (process.env.DAILY_REPORT_ENABLED === "TRUE")
        ]
      ];
    }
    return [[]];
  };

  return {
    getLastRow: () => getTargetData().length,
    getMaxRows: () => getTargetData().length + 1000,
    insertRowsAfter: (afterPosition, howMany) => {},
    getLastColumn: () => 10,
    getDataRange: () => ({ getValues: () => getTargetData(), sort: () => {} }),
    deleteRows: (rowPosition, howMany) => {
      const n = name.toLowerCase();
      if (n === "collect" || n === "trenddata") {
        const data = getTargetData(); // ヘッダー込みの全データ
        const rowsToDelete = data.slice(rowPosition - 1, rowPosition - 1 + howMany);
        const ids = rowsToDelete.map(r => r[2]).filter(id => id); // C列(URL)をIDとして使用
        if (ids.length > 0) {
          const stmt = db.prepare(`DELETE FROM collect WHERE id = ?`);
          db.transaction((idList) => {
            for (const id of idList) stmt.run(id);
          })(ids);
          console.log(`[GAS-Bridge] 🗑️ deleteRows 実行: ${ids.length}件のデータを削除しました (${name})`);
        }
      }
    },
    getRange: (row, col, rows, cols) => ({
      getValues: () => {
        const n = name.toLowerCase();
        // Bridge Hook: 35日以上前の記事のベクトル軽量化を SQL で爆速実行 (maintenanceLightenOldArticles対応)
        if (n === "collect" && row === 2 && col === 1 && cols === 1) {
          try {
            const res = db.prepare("UPDATE collect SET vector = NULL, method_vector = NULL WHERE date < date('now', '-35 days') AND (vector IS NOT NULL OR method_vector IS NOT NULL)").run();
            if (res.changes > 0) console.log(`[GAS-Bridge] ⚡ 爆速軽量化実行: ${res.changes}件の古いベクトルを削除しました。`);
          } catch (e) { console.error("[GAS-Bridge] 軽量化フックエラー:", e.message); }
        }
        const d = getTargetData();
        const slice = d.slice(row - 1, row - 1 + (rows || 1));
        return cols ? slice.map(r => r.slice(col - 1, col - 1 + cols)) : slice;
      },
      getValue: () => (getTargetData()[row-1] ? getTargetData()[row-1][col-1] : ""),
      sort: () => {},
      clear: () => {}, // GAS compatibility
      clearContent: () => {}, // GAS compatibility
      deleteRows: () => {}, // GAS compatibility
      setValue: (val) => { // GAS compatibility (single cell update)
        const mockValues = [[val]];
        return this.setValues ? this.setValues(mockValues) : null;
      },
      setValues: (values) => {
        if (name === "collect") {
          // 単一列の更新をサポート (clearEnglishSummaries や maintenanceLightenOldArticles 対応)
          if (cols === 1 || (values.length > 0 && values[0].length === 1)) {
            const data = getTargetData();
            let columnName = "";
            if (col === 5) columnName = "summary";
            else if (col === 7) columnName = "vector";
            else if (col === 8) columnName = "method_vector";
            else if (col === 9) columnName = "tldr";
            
            if (columnName) {
              const stmt = db.prepare(`UPDATE collect SET ${columnName === 'when' || columnName === 'where' ? '"' + columnName + '"' : columnName} = ? WHERE id = ?`);
              db.transaction((rowsToUpdate) => {
                for (let i = 0; i < rowsToUpdate.length; i++) {
                  const originalRow = data[row - 1 + i];
                  if (!originalRow) continue;
                  // 💡 物理同期構造 (1.4.2): Index 2 = URL (ID)
                  const id = originalRow[2]; 
                  const newVal = rowsToUpdate[i][0] || "";
                  stmt.run(newVal, id);
                }
              })(values);
              return;
            }
          }

          // 全カラム更新 (17カラム対応)
          const stmt = db.prepare(`
            INSERT INTO collect (id, date, title, url, abstract, summary, source, vector, method_vector, tldr, who, what, "when", "where", why, how, result, keywords)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              date = excluded.date,
              title = excluded.title,
              url = excluded.url,
              abstract = excluded.abstract,
              summary = CASE WHEN excluded.summary != '' THEN excluded.summary ELSE collect.summary END,
              source = excluded.source,
              vector = CASE WHEN excluded.vector != '' THEN excluded.vector ELSE collect.vector END,
              method_vector = CASE WHEN excluded.method_vector != '' THEN excluded.method_vector ELSE collect.method_vector END,
              tldr = CASE WHEN excluded.tldr != '' THEN excluded.tldr ELSE collect.tldr END,
              who = CASE WHEN excluded.who != '' THEN excluded.who ELSE collect.who END,
              what = CASE WHEN excluded.what != '' THEN excluded.what ELSE collect.what END,
              "when" = CASE WHEN excluded."when" != '' THEN excluded."when" ELSE collect."when" END,
              "where" = CASE WHEN excluded."where" != '' THEN excluded."where" ELSE collect."where" END,
              why = CASE WHEN excluded.why != '' THEN excluded.why ELSE collect.why END,
              how = CASE WHEN excluded.how != '' THEN excluded.how ELSE collect.how END,
              result = CASE WHEN excluded.result != '' THEN excluded.result ELSE collect.result END,
              keywords = CASE WHEN excluded.keywords != '' THEN excluded.keywords ELSE collect.keywords END
          `);
          db.transaction((rows) => { 
            let successCount = 0;
            let skipCount = 0;
            
            // 💡 物理的防衛策: 
            // もし 1行目がヘッダー("date", "title"など)なら、それを元にインデックスを特定する
            let urlIdx = 2; // Default
            let titleIdx = 1;
            let dateIdx = 0;
            
            const firstRow = rows[0];
            if (firstRow && firstRow[0] === "date") {
              urlIdx = firstRow.indexOf("url");
              titleIdx = firstRow.indexOf("title");
              dateIdx = 0;
              console.log(`[GAS-Bridge] 🔎 Header detected. URL Index: ${urlIdx}`);
            }

            for (let i = 0; i < rows.length; i++) {
              const r = rows[i];
              if (r[0] === "date") continue; // ヘッダーは飛ばす

              // 🌟 [2026/03/28 物理ダンプ完全同期構造]
              const id = r[urlIdx]; 
              if (!id || String(id).length < 10 || !id.startsWith('http')) {
                // デバッグ用に最初の数件だけログ
                if (skipCount < 3) console.warn(`[GAS-Bridge] ⚠️ Invalid ID at index ${urlIdx}: ${id} (Row ${i})`);
                skipCount++;
                continue; 
              }

              const dateVal = (r[dateIdx] instanceof Date ? r[dateIdx].toISOString() : String(r[dateIdx]));

              // 💡 インデックスを YATA.js の AppConfig カラム定義と完全に一致させる
              // rows[i] の中身が 17列あることを前提とするが、足りない場合は空文字で埋める
              const info = stmt.run(
                id,         // PK
                dateVal,    // A: Date (0)
                r[titleIdx] || "", // B: Title (1)
                id,         // C: URL (2)
                r[3] || "", // D: Abstract (3)
                r[4] || "", // E: Summary (4)
                r[5] || "", // F: Source (5)
                r[6] || "", // G: Vector (6)
                r[7] || "", // H: Method Vector (7)
                r[8] || "", // I: TLDR (8)
                r[9] || "", // J: WHO (9)
                r[10] || "", // K: WHAT (10)
                r[11] || "", // L: WHEN (11)
                r[12] || "", // M: WHERE (12)
                r[13] || "", // N: WHY (13)
                r[14] || "", // O: HOW (14)
                r[15] || "", // P: RESULT (15)
                r[16] || ""  // Q: KEYWORDS (16)
              );
              if (info.changes > 0) successCount++;
            }
            if (skipCount > 0) console.log(`✅ [GAS-Bridge] setValues: ${successCount} rows updated, ${skipCount} rows skipped.`);
          })(values);

        }
      }
    }),
    appendRow: (row) => {
      const p = row.map(v => (v instanceof Date ? v.toISOString() : v ?? ""));
      const n = name.toLowerCase();
      if ((n === "history" || n === "digesthistory" || n === "log") && process.env.DRY_RUN === "TRUE") {
        console.log(`[DRY_RUN] ${n} シートへの保存をスキップしました`);
        return;
      }
      if (n === "collect") {
        const stmt = db.prepare(`
          INSERT INTO collect (id, date, title, url, abstract, summary, source, vector, method_vector, tldr, who, what, "when", "where", why, how, result, keywords)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `);
        // 💡 物理ダンプ完全同期構造: 0:Date, 1:Title, 2:URL(ID), 3:Abstract, 4:Summary, 5:Source...
        const id = p[2];
        stmt.run(
          id,      // PK
          p[0],    // Date (0)
          p[1],    // Title (1)
          id,      // URL (2)
          p[3],    // Abstract (3)
          p[4]||"",// Summary (4)
          p[5]||"",// Source (5)
          p[6]||"",// Vector (6)
          p[7]||"",// Method (7)
          p[8]||"",// TLDR (8)
          p[9]||"",// WHO (9)
          p[10]||"",// WHAT (10)
          p[11]||"",// WHEN (11)
          p[12]||"",// WHERE (12)
          p[13]||"",// WHY (13)
          p[14]||"",// HOW (14)
          p[15]||"",// RESULT (15)
          p[16]||"" // KEYWORDS (16)
        );
      }
      if (n === "history" || n === "digesthistory") db.prepare('INSERT INTO history (date, keyword, summary, vector) VALUES (?, ?, ?, ?)').run(p[0], p[1], p[2], p[3]);
      if (n === "log") db.prepare('INSERT INTO log VALUES (?, ?, ?)').run(p[0], p[1], p[2]);
    }
  };
};

global.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: (name) => mockSheet(name) }), openById: (id) => ({ getSheetByName: (name) => mockSheet(name) }), flush: () => {} };
global.XmlService = {
  parse: (xml) => { throw new Error("Local XML parsing not supported, triggering Regex Fallback"); }, // Bridge: Throw to trigger Regex Fallback
  getNamespace: () => ({})
};
global.Utilities = { 
  sleep: (ms) => { const start = Date.now(); while (Date.now() - start < ms); }, 
  formatDate: (date, tz, format) => { try { const d = (date instanceof Date) ? date : new Date(date); if (isNaN(d.getTime())) return ""; const pad = (n) => n.toString().padStart(2, '0'); const map = { 'yyyy': d.getFullYear(), 'MM': pad(d.getMonth()+1), 'M': d.getMonth()+1, 'dd': pad(d.getDate()), 'd': d.getDate(), 'HH': pad(d.getHours()), 'H': d.getHours(), 'mm': pad(d.getMinutes()), 'm': d.getMinutes(), 'ss': pad(d.getSeconds()), 's': d.getSeconds() }; return format.replace(/yyyy|MM|dd|HH|mm|ss|M|d|H|m|s/g, m => map[m]); } catch(e) { return ""; } }, 
  computeDigest: (alg, val) => Array.from(new Uint8Array(crypto.createHash('md5').update(val).digest())).map(b => (b > 127 ? b - 256 : b)), 
  DigestAlgorithm: { MD5: 'md5' },
  base64Encode: (data) => Buffer.from(data).toString('base64'),
  base64Decode: (data) => Buffer.from(data, 'base64').toString()
};
global.DriveApp = { 
  getFolderById: (id) => ({ createFile: (fileName, content) => { const archiveDir = path.join(__dirname, '../archive'); if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true }); fs.writeFileSync(path.join(archiveDir, fileName), content); return { getId: () => "local-file-id" }; } }),
  getFileById: (id) => ({ getBlob: () => ({ getDataAsString: () => {
    const localPath = path.join(__dirname, '../prompts_local.json');
    const standardPath = path.join(__dirname, '../prompts.json');
    const targetPath = fs.existsSync(localPath) ? localPath : standardPath;
    return fs.readFileSync(targetPath, 'utf8');
  } }) })
};
global.Logger = { log: (msg) => console.log(`[GAS-Log] ${msg}`) };
global.Session = { getScriptTimeZone: () => "Asia/Tokyo" };

const handleEmail = async (to, subject, body, options = {}) => {
  let finalSubject = subject || options.subject || "";
  const user = process.env.SMTP_USER; const pass = process.env.SMTP_PASS;
  if (user && pass) {
    try {
      const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
      await transporter.sendMail({ from: `YATA Local <${user}>`, to: to || options.recipient, subject: finalSubject, text: body, html: options.htmlBody });
      console.log("✅ [Email] Successfully sent.");
    } catch (e) { console.error(`❌ [Email] Failed to send: ${e.message}`); }
  } else { console.log(`📧 [Email] (Mock Mode) Subject: ${finalSubject}`); }
};

global.MailApp = { sendEmail: (to, subject, body, options) => { if (typeof to === 'object') handleEmail(to.to, to.subject, to.body, to); else handleEmail(to, subject, body, options); } };
global.GmailApp = { sendEmail: (to, subject, body, options) => { handleEmail(to, subject, body, options); } };
global.isLikelyEnglish = (text) => {
  if (!text) return false;
  const decoded = String(text).replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const jpChars = decoded.match(/[぀-ゟ゠-ヿ一-鿿]/g) || [];
  const jpRatio = jpChars.length / decoded.length;
  const hasLatin = /[a-zA-Z]/.test(decoded);
  // 日本語が10%未満、かつアルファベットが含まれる場合は「英語（要翻訳）」と判定
  return hasLatin && jpRatio < 0.1;
};

global.LanguageApp = {
  translate: (text, from, to) => {
    if (!text) return text;
    // 緩和された英語判定を使用
    if (!global.isLikelyEnglish(text)) return text;

    const key = process.env.OPENAI_API_KEY_PERSONAL;
    if (!key) {
      console.warn("⚠️ LanguageApp: OPENAI_API_KEY_PERSONAL is not set.");
      return text;
    }

    const url = "https://api.openai.com/v1/chat/completions";
    const model = process.env.OPENAI_MODEL_NANO || "gpt-5-nano";
    const isReasoning = /^(gpt-5|o1|o3|o4)/.test(model.toLowerCase());

    const payloadObj = {
      model: model,
      messages: [
        { role: "system", content: "あなたは優秀なニュース編集者です。与えられた英語のニュースタイトルや短い本文から、その内容を正確に把握し、日本の読者に最適で読みやすい「ニュース見出し（短い要約）」を日本語で生成してください。単なる直訳ではなく、可能な限り文脈を補完して、内容がひと目でわかる自然な日本語にすること。出力は日本語のみとしてください。" },
        { role: "user", content: text }
      ]
    };

    if (isReasoning) {
      payloadObj.max_completion_tokens = 1000;
      payloadObj.reasoning_effort = "low"; // 高速化設定
    } else {
      payloadObj.temperature = 0;
      payloadObj.max_tokens = 1000;
    }

    try {
      const res = global.UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        headers: { "Authorization": `Bearer ${key}` },
        payload: JSON.stringify(payloadObj)
      });
      if (res.getResponseCode() === 200) {
        const json = JSON.parse(res.getContentText());
        const translated = json.choices[0].message.content.trim();
        if (translated) return translated;
      } else {
        console.error(`❌ LanguageApp API Error: ${res.getResponseCode()} - ${res.getContentText()}`);
      }
    } catch (e) {
      console.error(`❌ LanguageApp Fetch Error: ${e.message}`);
    }
    return text;
  }
};

console.log("✅ GAS Bridge Loaded (History/Log Support Active)");
module.exports = {};
