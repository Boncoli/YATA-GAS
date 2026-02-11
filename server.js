// ~/yata-local/server.js
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

// ★重要：YATAを読み込む前に、DBの場所を決定する
// (gas-bridge.js が process.env.DB_PATH を参照するため)
if (fs.existsSync('/dev/shm/yata.db')) {
    process.env.DB_PATH = '/dev/shm/yata.db';
    console.log("👉 RAMディスク上のDB (/dev/shm/yata.db) を使用します");
} else {
    process.env.DB_PATH = './yata.db';
    console.log("👉 ディスク上のDB (./yata.db) を使用します");
}

// ★ YATAの脳みそをロード
require('./lib/gas-bridge.js'); 
require('./lib/yata-loader.js');

// ---------------------------------------------------------
// DB初期化 (CarPlayログ用テーブル)
// ---------------------------------------------------------
const dbPath = process.env.DB_PATH;
const Database = require('better-sqlite3');
const db = new Database(dbPath);

db.exec(`CREATE TABLE IF NOT EXISTS drive_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT,        -- 'connect' or 'disconnect'
    timestamp TEXT,
    latitude REAL,
    longitude REAL,
    altitude REAL,      -- 高度を追加
    address TEXT,
    note TEXT,
    battery INTEGER     -- iPhoneのバッテリー残量
)`);

const app = express();
const PORT = 3001; // Grafanaと被らないように3001に変更

// POSTパラメータを受け取れるようにする
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ★ HTMLファイル置き場を指定 (ラズパイ専用の local_public フォルダ)
app.use(express.static(path.join(__dirname, 'local_public')));

// ---------------------------------------------------------
// API定義
// ---------------------------------------------------------

// 0. CarPlay ログ API
app.post('/api/carplay-log', (req, res) => {
    try {
        const { action, timestamp, latitude, longitude, altitude, address, note, battery } = req.body;
        console.log(`[IoT] CarPlay ${action}: ${address || (latitude + ',' + longitude)} (Alt: ${altitude}m)`);

        const insert = db.prepare("INSERT INTO drive_logs (action, timestamp, latitude, longitude, altitude, address, note, battery) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        insert.run(action, timestamp, latitude, longitude, altitude, address, note, battery);
        
        res.json({ status: "success", message: "Logged successfully" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ status: "error", message: e.message });
    }
});

// 0.1 ドライブログ履歴取得 API
app.get('/api/drive-history', (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM drive_logs ORDER BY timestamp ASC").all();
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 1. 検索 API
app.post('/api/search', async (req, res) => {
    try {
        const { keyword, options } = req.body;
        console.log(`[Web] 検索リクエスト: "${keyword}"`);

        // YATA.js の検索関数を呼び出し
        const resultHtml = global.searchAndAnalyzeKeyword(keyword, options);
        res.send(resultHtml);
    } catch (e) {
        console.error(e);
        res.status(500).send(`サーバーエラー: ${e.message}`);
    }
});

// 2. AI要約 API
app.post('/api/summary', async (req, res) => {
    try {
        const { url } = req.body;
        console.log(`[Web] 要約リクエスト: ${url}`);
        
        const summary = global.getWebPageSummary(url);
        res.send(summary);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 3. 3D可視化データ API
app.get('/api/viz-data', (req, res) => {
    try {
        const data = global.getVisualizationData();
        res.json(data);
    } catch (e) {
        res.status(500).json({error: e.message});
    }
});

// サーバー起動
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 YATA Web Server running!`);
    console.log(`📡 URL: http://192.168.1.151:${PORT}`);
    console.log(`📂 HTML root: ${path.join(__dirname, 'local_public')}`);
    console.log(`=========================================`);
});