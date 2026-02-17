// ~/yata-local/server.js
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { XMLParser } = require('fast-xml-parser');

// ★重要：YATAを読み込む前に、DBの場所を決定する
// ... (中略: 既存のDBパス決定ロジック)
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
// DB初期化
// ---------------------------------------------------------
const dbPath = process.env.DB_PATH;
const Database = require('better-sqlite3');
const db = new Database(dbPath);

// ... (中略: テーブル作成ロジック)
db.exec(`CREATE TABLE IF NOT EXISTS drive_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT,
    timestamp TEXT,
    latitude REAL,
    longitude REAL,
    altitude REAL,
    address TEXT,
    note TEXT,
    battery INTEGER
)`);

db.exec(`CREATE TABLE IF NOT EXISTS drive_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT,
    timestamp TEXT,
    note TEXT,
    path_data TEXT,      -- JSON形式の座標配列
    point_count INTEGER
)`);
// ... (中略: fuel_logs)

const app = express();
const cors = require('cors');
const PORT = 3001;

// アップロード設定
const upload = multer({ dest: '/tmp/yata-uploads/' });
const xmlParser = new XMLParser({ ignoreAttributes: false });

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'local_public')));

// 距離計算用
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------
// API定義
// ---------------------------------------------------------

// iPhoneからのGPXインポート API (1ドライブ1行方式)
app.post('/api/import-gpx', upload.single('gpx_file'), (req, res) => {
    const tempPath = req.file?.path;
    if (!tempPath) return res.status(400).json({ error: "No file uploaded" });

    try {
        console.log(`[API] Importing GPX to Track: ${req.file.originalname}`);
        const xmlData = fs.readFileSync(tempPath, 'utf8');
        const jsonObj = xmlParser.parse(xmlData);
        const trk = jsonObj.gpx?.trk;

        if (!trk) throw new Error("Invalid GPX structure");

        const segments = Array.isArray(trk.trkseg) ? trk.trkseg : [trk.trkseg];
        const note = `[iPhone Import] ${req.file.originalname}`;
        const allPoints = [];
        let lastPoint = null;
        let startTime = null;

        for (const seg of segments) {
            const points = Array.isArray(seg.trkpt) ? seg.trkpt : [seg.trkpt];
            for (const pt of points) {
                const lat = parseFloat(pt['@_lat']);
                const lon = parseFloat(pt['@_lon']);
                const ele = pt.ele ? parseFloat(pt.ele) : 0;
                const date = new Date(pt.time);
                if (!startTime) startTime = date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).replace(/\//g, '-');

                if (lastPoint) {
                    const dist = getDistance(lastPoint.lat, lastPoint.lon, lat, lon);
                    const timeDiff = (date - lastPoint.date) / 1000;
                    if (dist < 50 && timeDiff < 30) continue; 
                }

                allPoints.push([lat, lon, ele]);
                lastPoint = { lat, lon, date };
            }
        }

        if (allPoints.length > 0) {
            const insert = db.prepare(`
                INSERT INTO drive_tracks (action, timestamp, note, path_data, point_count)
                VALUES (?, ?, ?, ?, ?)
            `);
            insert.run('iphone-path', startTime, note, JSON.stringify(allPoints), allPoints.length);
        }

        fs.unlinkSync(tempPath);
        console.log(`[API] Track Import Success: ${allPoints.length} points. File deleted.`);
        res.json({ status: "success", points: allPoints.length });

    } catch (e) {
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// 0. CarPlay ログ API
app.post('/api/carplay-log', (req, res) => {
    try {
        const { action, timestamp, latitude, longitude, altitude, address, note, battery } = req.body;
        
        // --- 強化されたチャタリング防止ロジック ---
        const lastLog = db.prepare("SELECT id, action, timestamp FROM drive_logs ORDER BY timestamp DESC LIMIT 1").get();
        if (lastLog) {
            const parseDate = (ts) => {
                if (!ts) return new Date();
                // ISO形式 (Tが含まれる) ならそのまま、独自形式 (/) なら置換してパース
                return new Date(ts.includes('T') ? ts : ts.replace(/-/g, "/"));
            };

            const lastTime = parseDate(lastLog.timestamp);
            const currentTime = parseDate(timestamp);
            const diffMin = (currentTime - lastTime) / 1000 / 60;

            // 1. 同一アクションのチャタリング防止 (1分以内の全く同じアクションは無視)
            if (action === lastLog.action && diffMin < 1) {
                console.log(`[IoT] ⚠️ Chatter Ignored: ${action} (${diffMin.toFixed(2)}m ago)`);
                return res.json({ status: "ignored", message: "Chatter ignored" });
            }

            // 2. 自宅Wi-Fiの「隙間埋め」ロジック
            // OutHomeしてから10分以内にInHomeしたなら、そのOutHomeを削除して継続扱いにする
            if (lastLog.action === "OutHome" && action === "InHome" && diffMin < 10) {
                console.log(`[IoT] 🌁 Gap bridged: Deleting previous OutHome (ID: ${lastLog.id}) to keep connection continuous.`);
                db.prepare("DELETE FROM drive_logs WHERE id = ?").run(lastLog.id);
                return res.json({ status: "success", message: "Gap bridged, connection maintained" });
            }

            // 3. 「通過」判定 (In -> Out が3分以内なら「いなかったこと」にする)
            if (lastLog.action === "InHome" && action === "OutHome" && diffMin < 3) {
                console.log(`[IoT] 🚮 Pass-by detected (In->Out). Deleting previous In log (ID: ${lastLog.id})`);
                db.prepare("DELETE FROM drive_logs WHERE id = ?").run(lastLog.id);
                return res.json({ status: "ignored", message: "Pass-by detected, logs removed" });
            }

            // 4. アクションが切り替わる場合は、時間に関わらず受け入れる (特にCarPlay)
            if (action !== lastLog.action) {
                // パスして保存へ
            }
        }

        console.log(`[IoT] CarPlay ${action}: ${address || (latitude + ',' + longitude)} (Alt: ${altitude}m)`);

        // タイムスタンプのフォーマット統一 (YYYY/MM/DD HH:mm:ss)
        const formattedTs = timestamp ? timestamp.replace(/-/g, '/').replace('T', ' ').split('+')[0] : new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).replace(/\//g, '-');
        // ※toLocaleStringの結果が環境によって違う場合があるため、さらに正規化
        const finalTs = formattedTs.replace(/-/g, '/');

        const insert = db.prepare("INSERT INTO drive_logs (action, timestamp, latitude, longitude, altitude, address, note, battery) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        insert.run(action, finalTs, latitude, longitude, altitude, address, note, battery);
        
        res.json({ status: "success", message: "Logged successfully" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ status: "error", message: e.message });
    }
});

// 0.2 燃費ログ API
app.post('/api/fuel-log', (req, res) => {
    // ... (既存の登録処理)
});

// 0.2.1 燃費統計取得 API
app.get('/api/fuel-stats', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT 
                timestamp, 
                odometer, 
                amount, 
                price, 
                location, 
                note,
                (odometer - LAG(odometer) OVER (ORDER BY odometer ASC)) / amount as fuel_economy,
                amount * price as total_cost
            FROM fuel_logs 
            ORDER BY odometer ASC
        `).all();
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 0.1 ドライブログ履歴取得 API (LogsとTracksを両方返す)
app.get('/api/drive-history', (req, res) => {
    try {
        const logs = db.prepare("SELECT * FROM drive_logs ORDER BY timestamp ASC").all();
        const tracks = db.prepare("SELECT id, action, timestamp, note, path_data, point_count FROM drive_tracks ORDER BY timestamp ASC").all();
        
        // path_dataをパースして返す
        tracks.forEach(t => {
            t.path_data = JSON.parse(t.path_data);
        });

        res.json({ logs, tracks });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 0.3 ニュース取得 API
app.get('/api/news', (req, res) => {
    try {
        const rows = db.prepare("SELECT date, title, url, abstract, summary, source FROM collect ORDER BY date DESC LIMIT 100").all();
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
        console.log(`[Web] 🚀 AI要約リクエスト開始: ${url}`);
        
        // --- ユーザーの関心を記録 (クリックカウントアップ) ---
        try {
            db.prepare("UPDATE collect SET clicks = clicks + 1 WHERE url = ?").run(url);
        } catch (dbErr) {
            console.error(`[Web] ⚠️ クリック記録失敗: ${dbErr.message}`);
        }

        // YATA.jsの関数を呼び出し
        const summary = await global.getWebPageSummary(url);
        
        console.log(`[Web] ✅ AI要約完了 (${summary ? summary.length : 0}文字)`);
        if (!summary) return res.status(500).send("AI要約を生成できませんでした。");
        
        res.send(summary);
    } catch (e) {
        console.error(`[Web] ❌ AI要約エラー: ${e.message}`);
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

// 4. TODO 管理 API
app.get('/api/todo', (req, res) => {
    try {
        const todoPath = path.join(__dirname, 'TODO.md');
        const content = fs.readFileSync(todoPath, 'utf8');
        res.send(content);
    } catch (e) {
        res.status(500).send("TODO.md の読み込みに失敗しました。");
    }
});

app.post('/api/todo', (req, res) => {
    try {
        const { content } = req.body;
        const todoPath = path.join(__dirname, 'TODO.md');
        fs.writeFileSync(todoPath, content, 'utf8');
        console.log(`[Web] ✅ TODO.md updated!`);
        res.json({ status: "success" });
    } catch (e) {
        console.error(`[Web] ❌ TODO update error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// 5. システムステータス API
const { execSync } = require('child_process');
app.get('/api/system-status', (req, res) => {
    try {
        const status = {};
        
        // CPU温度
        try {
            const temp = execSync('vcgencmd measure_temp').toString().replace('temp=', '').replace("'C\n", "");
            status.cpuTemp = temp;
        } catch(e) { status.cpuTemp = "N/A"; }

        // メモリ使用率 (free -m)
        try {
            const mem = execSync('free -m').toString().split('\n')[1].split(/\s+/);
            status.memUsed = mem[2];
            status.memTotal = mem[1];
        } catch(e) { status.memUsed = "N/A"; }

        // ディスク使用率 (df -h)
        try {
            const disk = execSync('df -h /').toString().split('\n')[1].split(/\s+/);
            status.diskUsed = disk[2];
            status.diskTotal = disk[1];
            status.diskPercent = disk[4];
        } catch(e) { status.diskPercent = "N/A"; }

        // NAS空き容量
        try {
            const nas = execSync('df -h /mnt/nas').toString().split('\n')[1].split(/\s+/);
            status.nasAvail = nas[3];
        } catch(e) { status.nasAvail = "N/A"; }

        res.json(status);
    } catch (e) {
        res.status(500).json({ error: e.message });
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