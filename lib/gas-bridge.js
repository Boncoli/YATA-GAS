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
  CREATE TABLE IF NOT EXISTS collect (id TEXT PRIMARY KEY, date TEXT, title TEXT, url TEXT, abstract TEXT, summary TEXT, source TEXT, category TEXT, vector TEXT, method_vector TEXT);
  CREATE TABLE IF NOT EXISTS log (timestamp TEXT, level TEXT, message TEXT);
  CREATE TABLE IF NOT EXISTS weather_forecast (date TEXT PRIMARY KEY, temp_min REAL, temp_max REAL, weather_main TEXT, weather_desc TEXT, pop REAL, humidity INTEGER, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS weather_hourly (datetime TEXT PRIMARY KEY, temp REAL, weather_main TEXT, weather_desc TEXT, pop REAL, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS history (date TEXT, keyword TEXT, summary TEXT, vector TEXT);
`);
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

    // Timeout set to 60 seconds to prevent hanging
    curlCmd += `--max-time 60 `;

    // Headers
    const headers = { ...options.headers };
    if (options.contentType) headers['Content-Type'] = options.contentType;
    else if (options.payload) headers['Content-Type'] = 'application/json';

    for (const [key, value] of Object.entries(headers)) {
      // Escape single quotes in header values
      const escapedValue = String(value).replace(/'/g, "'\\''");
      curlCmd += `-H '${key}: ${escapedValue}' `;
    }

    // Method & Payload
    const method = (options.method || 'get').toUpperCase();
    if (method !== 'GET') {
      curlCmd += `-X ${method} `;
    }
    if (options.payload) {
      // Escape single quotes in payload
      const escapedPayload = String(options.payload).replace(/'/g, "'\\''");
      curlCmd += `-d '${escapedPayload}' `;
    }

    curlCmd += `"${url}"`;

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
      try { const jsonPath = path.join(__dirname, '../prompts.json'); if (fs.existsSync(jsonPath)) return [["key", "value"], ...Object.entries(JSON.parse(fs.readFileSync(jsonPath, 'utf8')))]; } catch (e) {}
    }
    if (n === "collect" || n === "trenddata" || n === "collect_data") {
      try { const rows = db.prepare('SELECT * FROM collect ORDER BY date DESC').all(); return [["date", "title", "url", "abstract", "summary", "source", "vector"], ...rows.map(r => [new Date(r.date), r.title, r.url, r.abstract, r.summary, r.source, r.vector])]; } catch (e) {}
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
            
            if (columnName) {
              const stmt = db.prepare(`UPDATE collect SET ${columnName} = ? WHERE id = ?`);
              db.transaction((rowsToUpdate) => {
                for (let i = 0; i < rowsToUpdate.length; i++) {
                  const originalRow = data[row - 1 + i];
                  if (!originalRow) continue;
                  const id = originalRow[2]; // url
                  const newVal = rowsToUpdate[i][0] || "";
                  stmt.run(newVal, id);
                }
              })(values);
              return;
            }
          }

          // 最もシンプルなINSERT/UPDATE文に修正
          const stmt = db.prepare(`
            INSERT INTO collect (id, date, title, url, abstract, summary, source, vector, method_vector)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              date = excluded.date,
              title = excluded.title,
              abstract = excluded.abstract,
              summary = CASE WHEN excluded.summary != '' THEN excluded.summary ELSE collect.summary END,
              source = excluded.source,
              vector = CASE WHEN excluded.vector != '' THEN excluded.vector ELSE collect.vector END,
              method_vector = CASE WHEN excluded.method_vector != '' THEN excluded.method_vector ELSE collect.method_vector END
          `);
          db.transaction((rows) => { 
            for (const r of rows) { 
              if (!r[1] || !r[2]) continue; 
              const dateVal = (r[0] instanceof Date ? r[0].toISOString() : String(r[0]));
              // 8番目の引数(vector)に r[6] (G列), 9番目の引数(method_vector)に r[7] (H列) を渡すように修正
              stmt.run(r[2], dateVal, r[1], r[2], r[3], r[4]||"", r[5]||"", r[6]||"", r[7]||""); 
            } 
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
        db.prepare('INSERT INTO collect (id, date, title, url, abstract, summary, source, vector, method_vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').run(p[2], p[0], p[1], p[2], p[3], p[4], p[5], "", "");
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
global.DriveApp = { getFolderById: (id) => ({ createFile: (fileName, content) => { const archiveDir = path.join(__dirname, '../archive'); if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true }); fs.writeFileSync(path.join(archiveDir, fileName), content); return { getId: () => "local-file-id" }; } }) };
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
