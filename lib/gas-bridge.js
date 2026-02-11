const dotenv = require('dotenv');
const crypto = require('crypto');
const fetch = require('sync-fetch'); 
const Database = require('better-sqlite3');
const fs = require('fs'); 
const path = require('path'); 
const nodemailer = require('nodemailer'); // ★追加

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
const dbPath = process.env.DB_PATH || 'yata.db';
console.log(`[Bridge] Using Database: ${dbPath}`); 
const db = new Database(dbPath);
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
  CREATE TABLE IF NOT EXISTS weather_hourly (
    datetime TEXT PRIMARY KEY,
    temp REAL,
    weather_main TEXT,
    weather_desc TEXT,
    pop REAL,
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

function parseCSV(text) {
  const rows = [];
  let currentRow = [];
  let currentCell = '';
  let insideQuote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i+1];
    if (char === '"') {
      if (insideQuote && nextChar === '"') { currentCell += '"'; i++; }
      else { insideQuote = !insideQuote; }
    } 
    else if (char === ',' && !insideQuote) { currentRow.push(currentCell); currentCell = ''; } 
    else if ((char === '\r' || char === '\n') && !insideQuote) {
      if (char === '\r' && nextChar === '\n') i++; 
      currentRow.push(currentCell); rows.push(currentRow); currentRow = []; currentCell = '';
    } 
    else { currentCell += char; }
  }
  if (currentCell || currentRow.length > 0) { currentRow.push(currentCell); rows.push(currentRow); }
  return rows;
}

// --- 2. SpreadsheetApp (修正版) ---
const mockSheet = (name) => {
  let promptData = [["key", "value"], ["BATCH_SYSTEM", ""], ["BATCH_USER_TEMPLATE", ""], ["summary_only", "事実のみ要約"]];
  if (name === "prompt" || name === "PROMPTS" || name === "Prompt") {
    try {
      const jsonPath = path.join(__dirname, '../prompts.json');
      if (fs.existsSync(jsonPath)) {
        const localPrompts = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        promptData = [["key", "value"], ...Object.entries(localPrompts)];
      }
    } catch (e) {}
  }

  let feedData = [["label", "url", "category", "active"]];
  if (name === "RSS" || name === "feeds" || name === "RssList") {
    try {
      const jsonPath = path.join(__dirname, '../rss-list.json');
      if (fs.existsSync(jsonPath)) {
        const localList = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        feedData = [["label", "url", "category", "active"], ...localList.map(i => [i.label, i.url, i.category || "General", (i.active ? "TRUE" : "FALSE")])];
      }
    } catch (e) {}
  }

  let dbRows = [];
  if (name === "collect" || name === "TrendData" || name === "collect_data") { 
    try {
      const rows = db.prepare('SELECT * FROM collect ORDER BY date DESC').all();
      dbRows = [["date", "title", "url", "abstract", "summary", "source", "vector"], ...rows.map(r => [new Date(r.date), r.title, r.url, r.abstract, r.summary, r.source, r.vector])];
    } catch (e) {}
  }

  let historyRows = [];
  if (name === "DigestHistory" || name === "History") {
    try {
      const rows = db.prepare('SELECT * FROM history ORDER BY date ASC').all();
      historyRows = [["Date", "Keyword", "Summary", "Vector"], ...rows.map(r => [new Date(r.date), r.keyword, r.summary, r.vector])];
    } catch (e) {}
  }

  let userRows = [
    ["名前", "メールアドレス", "配信曜日(空:毎日)", "キーワード(カンマ区切り)", "AI意味検索(TRUE/FALSE)"],
    ["Admin", process.env.MAIL_TO || "admin@example.com", "", "", "FALSE"]
  ];

  let masterKeywords = [
    ["検索クエリ", "有効フラグ", "配信曜日", "ラベル"],
    [".", "TRUE", "日,月,火,水,木,金,土", "総合ニュース"] 
  ];

  const getTargetData = () => {
    if (name === "prompt" || name === "PROMPTS" || name === "Prompt") return promptData;
    if (name === "RSS" || name === "feeds") return feedData;
    if (name === "collect" || name === "TrendData" || name === "collect_data") return dbRows;
    if (name === "DigestHistory" || name === "History") return historyRows;
    if (name === "Users" || name === "USERS") return userRows;
    if (name === "Keywords" || name === "KEYWORDS") return masterKeywords;
    return [[]];
  };

  return {
    getLastRow: () => getTargetData().length,
    getLastColumn: () => 10,
    getDataRange: () => ({ getValues: () => getTargetData() }),
    getRange: (row, col, rows, cols) => ({
      getValues: () => {
        const d = getTargetData();
        const slice = d.slice(row - 1, row - 1 + (rows || 1));
        return cols ? slice.map(r => r.slice(col - 1, col - 1 + cols)) : slice;
      },
      getValue: () => (getTargetData()[row-1] ? getTargetData()[row-1][col-1] : ""),
      setValues: (values) => {
        if (name === "collect" || name === "TrendData" || name === "collect_data") {
          const stmt = db.prepare('INSERT INTO collect (id, date, title, url, abstract, summary, source, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET date=excluded.date, title=excluded.title, abstract=excluded.abstract, summary=CASE WHEN excluded.summary!="" THEN excluded.summary ELSE summary END, vector=CASE WHEN excluded.vector!="" THEN excluded.vector ELSE vector END');
          db.transaction((rows) => {
            for (const r of rows) {
              if (!r[1] || !r[2]) continue;
              stmt.run(r[2], (r[0] instanceof Date ? r[0].toISOString() : String(r[0])), r[1], r[2], r[3], r[4]||"", r[5], r[6]||"");
            }
          })(values);
        }
      },
      setValue: () => {}, sort: () => {}, clearContent: () => {}
    }),
    deleteRows: (start, num) => {
      if ((name === "DigestHistory" || name === "History") && start === 2) {
        db.prepare('DELETE FROM history WHERE rowid IN (SELECT rowid FROM history ORDER BY date ASC LIMIT ?)').run(num);
      }
    },
    appendRow: (row) => {
      if (name === 'log') db.prepare('INSERT INTO log VALUES (?, ?, ?)').run((row[0] instanceof Date ? row[0].toISOString() : row[0]), row[1], row[2]);
      if (name === "DigestHistory" || name === "History") db.prepare('INSERT INTO history VALUES (?, ?, ?, ?)').run((row[0] instanceof Date ? row[0].toISOString() : row[0]), row[1], row[2], row[3]);
      if (name === "collect" || name === "TrendData" || name === "collect_data") {
        db.prepare('INSERT INTO collect (id, date, title, url, abstract, summary, source, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').run(row[2], (row[0] instanceof Date ? row[0].toISOString() : row[0]), row[1], row[2], row[3]||"", row[4]||"", row[5]||"", row[6]||"");
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
        const map = { 'yyyy': d.getFullYear(), 'MM': pad(d.getMonth()+1), 'M': d.getMonth()+1, 'dd': pad(d.getDate()), 'd': d.getDate(), 'HH': pad(d.getHours()), 'H': d.getHours(), 'mm': pad(d.getMinutes()), 'm': d.getMinutes(), 'ss': pad(d.getSeconds()), 's': d.getSeconds() };
        return format.replace(/yyyy|MM|dd|HH|mm|ss|M|d|H|m|s/g, m => map[m]);
    } catch(e) { return ""; }
  },
  computeDigest: (alg, val) => Array.from(new Uint8Array(crypto.createHash('md5').update(val).digest())).map(b => (b > 127 ? b - 256 : b)),
  DigestAlgorithm: { MD5: 'md5' }
};

global.DriveApp = {
  getFolderById: (id) => ({
    createFile: (fileName, content) => {
      const archiveDir = path.join(__dirname, '../archive');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, fileName), content);
      return { getId: () => "local-file-id" };
    }
  })
};

global.Logger = { log: (msg) => console.log(`[GAS-Log] ${msg}`) };
global.Session = { getScriptTimeZone: () => "Asia/Tokyo" };

// --- メール送信サービス (実稼働基盤実装済み) ---
const handleEmail = async (to, subject, body, options = {}) => {
  let finalSubject = subject || options.subject || "";
  if (!finalSubject.includes("[YATA-")) {
    if (finalSubject.toLowerCase().includes("weekly") || finalSubject.includes("週刊") || finalSubject.includes("7日分")) finalSubject = `[YATA-WEEKLY] ${finalSubject}`;
    else finalSubject = `[YATA-DAILY] ${finalSubject}`;
  }

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (user && pass) {
    // 基盤実装: SMTP設定がある場合は実際に送信
    console.log(`\n📧 [Email] Sending real email to: ${to || options.recipient}`);
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass }
      });
      await transporter.sendMail({
        from: `YATA Local <${user}>`,
        to: to || options.recipient,
        subject: finalSubject,
        html: body || options.htmlBody || options.body
      });
      console.log("✅ [Email] Successfully sent.");
    } catch (e) {
      console.error(`❌ [Email] Failed to send: ${e.message}`);
    }
  } else {
    // 待機モード: SMTP未設定時はログ出力のみ（モック動作）
    console.log(`\n📧 [Email] (Mock Mode) To: ${to || options.recipient}`);
    console.log(`📧 [Email] (Mock Mode) Subject: ${finalSubject}`);
    console.log(`📧 [Email] (Mock Mode) Body Length: ${ (body || options.htmlBody || "").length } chars.`);
    console.log("ℹ️ [Email] To enable real sending, set SMTP_USER and SMTP_PASS in .env");
  }
};

global.MailApp = { sendEmail: (to, subject, body, options) => { if (typeof to === 'object') handleEmail(to.to, to.subject, to.body, to); else handleEmail(to, subject, body, options); } };
global.GmailApp = { sendEmail: (to, subject, body, options) => { handleEmail(to, subject, body, options); } };

global.LanguageApp = { 
  translate: (text) => { 
    const apiKey = process.env.OPENAI_API_KEY_PERSONAL;
    if (!apiKey || !text) return text;
    try {
      const res = fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` }, body: JSON.stringify({ model: process.env.OPENAI_MODEL_NANO || "gpt-4o-mini", messages: [{ role: "system", content: "Translate the following text into natural Japanese. Output only the translation." }, { role: "user", content: text }], temperature: 0.3 }) });
      return res.status === 200 ? res.json().choices[0].message.content.trim() : text;
    } catch (e) { return text; }
  } 
};

console.log("✅ GAS Bridge Loaded (Full Mock with NodeMailer Base)");
module.exports = {};
