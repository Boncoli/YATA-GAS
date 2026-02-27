// ~/yata-local/server.js
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const upload = multer({ dest: '/tmp/yata-uploads/' });
const { XMLParser } = require('fast-xml-parser');

// ★重要：YATAを読み込む前に、DBの場所を決定する
const RAM_DB = '/dev/shm/yata.db';
const REAL_DB = path.join(__dirname, 'yata.db');

if (fs.existsSync(RAM_DB)) {
    process.env.DB_PATH = RAM_DB;
    console.log(`👉 RAMディスク上のDB (${RAM_DB}) を使用します`);
} else {
    process.env.DB_PATH = REAL_DB;
    console.log(`👉 ディスク上のDB (${REAL_DB}) を使用します`);
}

// ---------------------------------------------------------
// DB初期化 (一本化)
// ---------------------------------------------------------
const dbPath = process.env.DB_PATH;
const Database = require('better-sqlite3');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// グローバルにDBを公開して gas-bridge 等が同じ接続を使うようにする
global.YATA_DB = db;

// ★ YATAの脳みそをロード (DB初期化後に行う)
require('./lib/gas-bridge.js'); 
require('./lib/yata-loader.js');

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

db.exec(`CREATE TABLE IF NOT EXISTS ai_chat_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT,           -- 'user' or 'ai'
    content TEXT,
    timestamp TEXT
)`);

// ... (中略: fuel_logs)
db.exec(`CREATE TABLE IF NOT EXISTS fuel_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT,
    odometer REAL,
    amount REAL,
    price REAL,
    location TEXT,
    note TEXT
)`);

// 1日1行の統合ヘルスケアテーブル
db.exec(`CREATE TABLE IF NOT EXISTS daily_health (
    date TEXT PRIMARY KEY,
    steps INTEGER DEFAULT 0,
    sleep_hours REAL DEFAULT 0,
    hrv REAL DEFAULT 0,
    resting_hr INTEGER DEFAULT 0,
    active_kcal INTEGER DEFAULT 0,
    sleep_note TEXT
)`);

const compression = require('compression');
const app = express();
const cors = require('cors');
const PORT = 3001;

// XMLパーサーの設定
const xmlParser = new XMLParser({ ignoreAttributes: false });

// データ圧縮 (Gzip) を有効化して高速化
app.use(compression());
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// キャッシュ設定の最適化
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    
    // API (/api/) 以外はブラウザにキャッシュさせる (一瞬で開くようにする)
    if (req.url.startsWith('/api/')) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    } else {
        // 調整中はキャッシュを無効化 (開発が終わったら 3600 に戻す)
        res.set('Cache-Control', 'public, max-age=0');
    }
    next();
});

// 静的ファイルのルート
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
                if (!startTime) {
                    startTime = date.toLocaleString('ja-JP', {
                        year: 'numeric', month: '2-digit', day: '2-digit',
                        hour: '2-digit', minute: '2-digit', second: '2-digit',
                        hour12: false, timeZone: 'Asia/Tokyo'
                    }).replace(/\//g, '-');
                }

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
            const info = insert.run('iphone-path', startTime, note, JSON.stringify(allPoints), allPoints.length);
            const newTrackId = info.lastInsertRowid;

            // 地図の再生成 (バックグラウンド、ID指定で高速化)
            const { exec } = require('child_process');
            exec(`python3 tasks/generate_visited_map.py --track-id ${newTrackId}`, (err) => {
                if (err) console.error("[API] Map generation failed:", err);
                else console.log(`[API] Travel Map updated for Track ID: ${newTrackId}`);
            });
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
        let { action, timestamp, latitude, longitude, altitude, address, note, battery } = req.body;
        
        // --- 強化されたチャタリング防止ロジック ---
        const lastLog = db.prepare("SELECT * FROM drive_logs ORDER BY timestamp DESC LIMIT 1").get();
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
            // OutHomeしてから3分以内にInHomeしたなら、そのOutHomeを削除して継続扱いにする (短縮: 10m -> 3m)
            // これにより、コンビニ等の短い外出もしっかり記録されるようになる。
            if (lastLog.action === "OutHome" && action === "InHome" && diffMin < 3) {
                console.log(`[IoT] 🌁 Gap bridged: Deleting previous OutHome (ID: ${lastLog.id}) to keep connection continuous.`);
                db.prepare("DELETE FROM drive_logs WHERE id = ?").run(lastLog.id);
                return res.json({ status: "success", message: "Gap bridged, connection maintained" });
            }

            // 3. マンション・エレベーター対策 (In -> Out が5分以内なら、その Out を無視する)
            // 以前は「InHomeを消してなかったことにする」ロジックだったが、それだと
            // 「エントランスでInHome -> エレベーターでOutHome -> 部屋でInHome」の時に
            // 最初の帰宅記録が消えてしまい、空白時間ができてしまう。
            // 
            // 改善案: 「一度帰宅したら、5分以内の切断はエレベーターや死角とみなして、切断ログ(OutHome)の方を捨てる」
            // これにより、InHome は残り続け、Timeline上は「ずっと家にいた」ことになる。
            if (lastLog.action === "InHome" && action === "OutHome" && diffMin < 5) {
                console.log(`[IoT] 🏢 Elevator/Blindspot detected: Ignoring OutHome (InHome was ${diffMin.toFixed(1)}m ago). Keeping InHome.`);
                return res.json({ status: "ignored", message: "Short disconnection ignored (Elevator logic)" });
            }

            // 4. InCar の位置情報継承ロジック (New!)
            // 車に乗った時、前回の降車位置から100m以内なら、前回の位置情報を引き継ぐ
            if (action === "InCar" && lastLog.latitude && lastLog.longitude) {
                const dist = getDistance(latitude, longitude, lastLog.latitude, lastLog.longitude);
                if (dist < 100) {
                    console.log(`[IoT] 📍 Location Inherited: InCar is close to last log (${dist.toFixed(1)}m). Using previous coordinates.`);
                    latitude = lastLog.latitude;
                    longitude = lastLog.longitude;
                    altitude = lastLog.altitude;
                    address = lastLog.address;
                    note = (note ? note + " " : "") + `[Inherited from ${lastLog.action}]`;
                }
            }
        }

        // --- 走行距離計算 & Discord通知 (OutCar時のみ) ---
        if (action === "OutCar" && lastLog) {
            // 直近の InCar を探す (24時間以内)
            // 時刻が重なる場合に備え、IDの降順も加える
            const lastInCar = db.prepare("SELECT * FROM drive_logs WHERE action = 'InCar' AND timestamp > datetime('now', '-24 hours', 'localtime') ORDER BY timestamp DESC, id DESC LIMIT 1").get();
            
            if (lastInCar && lastInCar.latitude && latitude) {
                try {
                    console.log(`[IoT] 🏎️ Calculating distance from ${lastInCar.address || 'Start'} to ${address || 'End'}...`);
                    // OSRM API (Demo Server) - lon,lat;lon,lat の順
                    const osrmUrl = `http://router.project-osrm.org/route/v1/driving/${lastInCar.longitude},${lastInCar.latitude};${longitude},${latitude}?overview=false`;
                    const res = global.UrlFetchApp.fetch(osrmUrl);
                    if (res.getResponseCode() === 200) {
                        const data = JSON.parse(res.getContentText());
                        if (data.routes && data.routes[0]) {
                            const distanceKm = (data.routes[0].distance / 1000).toFixed(1);
                            note = (note ? note + " " : "") + `[Distance: ${distanceKm}km]`;
                            
                            // Discord通知
                            const webhookUrl = process.env.DISCORD_WEBHOOK_URL_DRIVE;
                            if (webhookUrl) {
                                const message = `🚗 **ドライブ完了報告 (CX-80)**\n` +
                                                `📍 出発: ${lastInCar.address || '不明な地点'}\n` +
                                                `🏁 到着: ${address || '不明な地点'}\n` +
                                                `🛣️ 推定走行距離: **${distanceKm} km**\n` +
                                                `🔋 バッテリー: ${battery || '不明'}%\n` +
                                                `✨ お疲れ様でした！`;
                                
                                global.UrlFetchApp.fetch(webhookUrl, {
                                    method: "post",
                                    contentType: "application/json",
                                    payload: JSON.stringify({ content: message })
                                });
                            }
                        }
                    }
                } catch (err) {
                    console.error(`[IoT] ❌ Distance calculation failed: ${err.message}`);
                }
            }
        }

        // タイムスタンプのフォーマット統一 (YYYY/MM/DD HH:mm:ss)
        // 時刻が含まれていない場合（: がない場合）は現在時刻を補完する
        let finalTs;
        if (timestamp && timestamp.includes(':')) {
            finalTs = timestamp.replace(/-/g, '/').replace('T', ' ').split('+')[0];
        } else {
            const now = new Date();
            const dateStr = timestamp ? timestamp.replace(/-/g, '/') : now.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }).replace(/\//g, '/');
            const timeStr = now.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
            finalTs = `${dateStr} ${timeStr}`;
        }
        finalTs = finalTs.replace(/-/g, '/');

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
    try {
        const { odometer, amount, price, location, note, timestamp } = req.body;
        const finalTs = timestamp ? timestamp.replace(/-/g, '/') : new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).replace(/\//g, '/');

        // --- 1. 前回の走行距離を取得して燃費を計算 ---
        const lastLog = db.prepare("SELECT odometer FROM fuel_logs ORDER BY odometer DESC LIMIT 1").get();
        let fuelEconomy = null;
        let distance = null;
        if (lastLog && odometer > lastLog.odometer) {
            distance = odometer - lastLog.odometer;
            fuelEconomy = (distance / amount).toFixed(2);
        }

        // --- 2. DBへ保存 ---
        const insert = db.prepare("INSERT INTO fuel_logs (timestamp, odometer, amount, price, location, note) VALUES (?, ?, ?, ?, ?, ?)");
        insert.run(finalTs, odometer, amount, price, location, note);

        // --- 3. Discordへ通知 ---
        const webhookUrl = process.env.DISCORD_WEBHOOK_URL_DRIVE;
        if (webhookUrl) {
            let message = `⛽ **給油完了報告 (CX-80)**\n`;
            message += `📍 場所: ${location || '未設定'}\n`;
            message += `🛣️ 総走行距離: ${odometer.toLocaleString()} km\n`;
            if (distance) message += `🏁 今回の走行: ${distance.toLocaleString()} km\n`;
            message += `💧 給油量: ${amount} L (¥${price}/L)\n`;
            if (fuelEconomy) {
                message += `✨ **今回の燃費: ${fuelEconomy} km/L**\n`;
                if (fuelEconomy > 15) message += `🎊 かなりの低燃費です！ナイスドライブ！`;
            }
            
            global.UrlFetchApp.fetch(webhookUrl, {
                method: "post",
                contentType: "application/json",
                payload: JSON.stringify({ content: message })
            });
        }

        console.log(`[IoT] Fuel Log Added: ${fuelEconomy ? fuelEconomy + ' km/L' : 'First log'}`);
        res.json({ status: "success", fuel_economy: fuelEconomy });

    } catch (e) {
        console.error(`[IoT] Fuel Log Error: ${e.message}`);
        res.status(500).json({ status: "error", message: e.message });
    }
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

// 0.2.2 ヘルスケアログ API (iPhone ショートカットから受信)
app.get('/api/health-stats', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 30;
        const rows = db.prepare("SELECT * FROM daily_health ORDER BY date DESC LIMIT ?").all(limit);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/health-log', (req, res) => {
    try {
        let { date, type, value, note } = req.body;
        
        if (!date || !type || value === undefined) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        // 1. 日付の整形 (ISO形式等から YYYY-MM-DD を抽出)
        let formattedDate = date;
        if (date.includes('T')) formattedDate = date.split('T')[0];
        else if (date.includes('/')) formattedDate = date.replace(/\//g, '-').split(' ')[0];

        // 2. 特殊なデータ形式 (AutoSleep等) の処理
        let finalValue = value;
        let finalNote = note;
        if (typeof value === 'string' && value.trim().startsWith('{')) {
            try {
                const parsed = JSON.parse(value);
                finalNote = value;
                finalValue = parsed["睡眠"] || parsed["Sleep"] || 0;
            } catch (e) { finalNote = value; finalValue = 0; }
        } else if (typeof value === 'object' && value !== null) {
            finalNote = JSON.stringify(value);
            finalValue = value["睡眠"] || value["Sleep"] || 0;
        }

        // 3. 統合テーブル (daily_health) へ保存 (UPSERT方式)
        // 既存レコードがなければ作成、あれば該当する列だけを更新する
        const insertStmt = db.prepare(`
            INSERT INTO daily_health (date, steps, sleep_hours, hrv, resting_hr, active_kcal, sleep_note)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET
                steps = CASE WHEN ? = 'steps' THEN EXCLUDED.steps ELSE steps END,
                sleep_hours = CASE WHEN ? IN ('sleep', 'sleep_hours') THEN EXCLUDED.sleep_hours ELSE sleep_hours END,
                hrv = CASE WHEN ? = 'hrv' THEN EXCLUDED.hrv ELSE hrv END,
                resting_hr = CASE WHEN ? = 'resting_hr' THEN EXCLUDED.resting_hr ELSE resting_hr END,
                active_kcal = CASE WHEN ? = 'active_kcal' THEN EXCLUDED.active_kcal ELSE active_kcal END,
                sleep_note = CASE WHEN ? IN ('sleep', 'sleep_hours') THEN EXCLUDED.sleep_note ELSE sleep_note END
        `);

        // type に応じて値を振り分ける
        const stepsVal = (type === 'steps') ? Math.round(finalValue) : 0;
        const sleepVal = (type === 'sleep' || type === 'sleep_hours') ? parseFloat(finalValue) : 0;
        const hrvVal = (type === 'hrv') ? parseFloat(finalValue) : 0;
        const restingHrVal = (type === 'resting_hr') ? Math.round(finalValue) : 0;
        const activeKcalVal = (type === 'active_kcal') ? Math.round(finalValue) : 0;
        const sleepNoteVal = (type === 'sleep' || type === 'sleep_hours') ? finalNote : null;

        insertStmt.run(formattedDate, stepsVal, sleepVal, hrvVal, restingHrVal, activeKcalVal, sleepNoteVal, 
                        type, type, type, type, type, type);
        
        console.log(`[IoT] 🏃 Daily Health Unified: ${formattedDate} (${type} updated)`);
        res.json({ status: "success" });
    } catch (e) {
        console.error(`[IoT] Health Log Error: ${e.message}`);
        res.status(500).json({ status: "error", message: e.message });
    }
});

// 0.1 ドライブログ履歴取得 API (LogsとTracksを両方返す)
app.get('/api/drive-history', (req, res) => {
    try {
        const logs = db.prepare("SELECT * FROM drive_logs ORDER BY timestamp ASC").all();
        const tracksRaw = db.prepare("SELECT id, action, timestamp, note, path_data, point_count FROM drive_tracks ORDER BY timestamp ASC").all();
        
        const tracks = [];
        tracksRaw.forEach(t => {
            try {
                let data = JSON.parse(t.path_data);
                
                // データが多すぎる場合は間引く (ブラウザをクラッシュさせないため)
                // 1000点以上ある場合は、1/5 に。5000点以上は 1/10 に間引く。
                if (data.length > 5000) data = data.filter((_, i) => i % 10 === 0);
                else if (data.length > 1000) data = data.filter((_, i) => i % 5 === 0);
                
                t.path_data = data;
                tracks.push(t);
            } catch (parseErr) {
                console.warn(`[DB] ⚠️ Track ID ${t.id} のパースに失敗: ${parseErr.message}`);
            }
        });

        res.json({ logs, tracks });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 0.3 ニュース取得 API
app.get('/api/news', (req, res) => {
    try {
        // 直近100件を取得し、配列をランダムにシャッフルして返す (埋もれた記事を拾いやすくするため)
        const rows = db.prepare("SELECT date, title, url, abstract, summary, source FROM collect ORDER BY date DESC LIMIT 100").all();
        
        // Fisher-Yates シャッフル
        for (let i = rows.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rows[i], rows[j]] = [rows[j], rows[i]];
        }
        
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

// 4.1 RSSフィード管理 API
const FEEDS_FILE = path.join(__dirname, 'rss-list.json');
app.get('/api/feeds', (req, res) => {
    try {
        if (!fs.existsSync(FEEDS_FILE)) return res.json([]);
        const feeds = JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));
        res.json(feeds);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/feeds', (req, res) => {
    try {
        const { feeds } = req.body;
        if (!feeds) return res.status(400).json({ error: "Missing feeds data" });
        fs.writeFileSync(FEEDS_FILE, JSON.stringify(feeds, null, 2), 'utf8');
        console.log(`[Web] ✅ rss-list.json updated!`);
        res.json({ status: "success" });
    } catch (e) {
        console.error(`[Web] ❌ Feed update error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// 4.2 ペルソナ管理 API
const PERSONA_FILE = path.join(__dirname, 'persona.txt');
const PERSONA_TEMPLATE = path.join(__dirname, 'persona.txt.template');

app.get('/api/persona', (req, res) => {
    try {
        if (!fs.existsSync(PERSONA_FILE)) {
            // ファイルがない場合はテンプレートから復元を試みる
            if (fs.existsSync(PERSONA_TEMPLATE)) {
                fs.copyFileSync(PERSONA_TEMPLATE, PERSONA_FILE);
                console.log(`[Web] 🎭 persona.txt restored from template.`);
            } else {
                return res.send("");
            }
        }
        const content = fs.readFileSync(PERSONA_FILE, 'utf8');
        res.send(content);
    } catch (e) {
        res.status(500).send("persona.txt の読み込みに失敗しました。");
    }
});

app.post('/api/persona', (req, res) => {
    try {
        const { content } = req.body;
        if (content === undefined) return res.status(400).json({ error: "Missing content" });
        fs.writeFileSync(PERSONA_FILE, content, 'utf8');
        console.log(`[Web] ✅ persona.txt updated!`);
        res.json({ status: "success" });
    } catch (e) {
        console.error(`[Web] ❌ Persona update error: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// 5. システムステータス API
const { execSync } = require('child_process');
function getSystemStatus() {
    const status = {};
    try {
        status.cpuTemp = execSync('vcgencmd measure_temp').toString().replace('temp=', '').replace("'C\n", "");
    } catch(e) { status.cpuTemp = "N/A"; }
    try {
        const mem = execSync('free -m').toString().split('\n')[1].split(/\s+/);
        status.memUsed = mem[2];
        status.memTotal = mem[1];
    } catch(e) { status.memUsed = "N/A"; }
    return status;
}

app.get('/api/system-status', (req, res) => {
    try {
        const status = getSystemStatus();
        
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

        // --- 追加: 記事数、スポット、天気 ---
        try {
            const total = db.prepare("SELECT COUNT(*) as count FROM collect").get();
            const today = db.prepare("SELECT COUNT(*) as count FROM collect WHERE date >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-24 hours')").get();
            status.totalArticles = total.count;
            status.todayArticles = today.count;

            const lastLog = db.prepare("SELECT action, timestamp, note FROM drive_logs ORDER BY timestamp DESC LIMIT 1").get();
            if (lastLog) {
                const time = lastLog.timestamp.split(' ')[1].substring(0, 5); // "18:34"
                status.lastLog = `${time} ${lastLog.action}${lastLog.note ? ' (' + lastLog.note + ')' : ''}`;
            }

            const weather = db.prepare("SELECT temp, main_weather FROM weather_log ORDER BY datetime DESC LIMIT 1").get();
            if (weather) {
                status.weather = `${weather.main_weather} ${Math.round(weather.temp)}°C`;
            }
        } catch (dbErr) {
            console.error("[API] DB Status Error:", dbErr.message);
        }

        res.json(status);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 6. Gemini AI チャット API (履歴取得)
app.get('/api/chat-history', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const rows = db.prepare("SELECT * FROM ai_chat_log ORDER BY id DESC LIMIT ?").all(limit);
        res.json(rows.reverse()); // 古い順に並べ替え
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- トラックデータ取得 API ---
app.get('/api/tracks', (req, res) => {
    try {
        const tracks = db.prepare("SELECT id, action, timestamp, note, point_count FROM drive_tracks ORDER BY timestamp DESC").all();
        res.json(tracks);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/tracks/:id', (req, res) => {
    try {
        const track = db.prepare("SELECT * FROM drive_tracks WHERE id = ?").get(req.params.id);
        if (!track) return res.status(404).json({ error: "Track not found" });
        track.path_data = JSON.parse(track.path_data);
        res.json(track);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 6. Gemini AI チャット API
app.post('/api/chat', async (req, res) => {
    try {
        const { message, history: clientHistory } = req.body;
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) return res.status(500).json({ error: "Gemini API Key not found" });

        const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).replace(/\//g, '-');

        // 1. ユーザーメッセージをDBに保存
        if (message) {
            db.prepare("INSERT INTO ai_chat_log (role, content, timestamp) VALUES (?, ?, ?)").run('user', message, now);
        }

        // 2. DBから最新のコンテキストを取得 (直近15件)
        const dbHistory = db.prepare("SELECT role, content FROM ai_chat_log ORDER BY id DESC LIMIT 15").all().reverse();
        
        const sysStatus = getSystemStatus();
        const weather = db.prepare("SELECT temp, main_weather FROM weather_log ORDER BY datetime DESC LIMIT 1").get();
        const trend = db.prepare("SELECT rank1 FROM trend_log ORDER BY date DESC LIMIT 1").get();
        const lastLog = db.prepare("SELECT action, timestamp, note FROM drive_logs ORDER BY timestamp DESC LIMIT 1").get();

        // --- 記憶ファイル (~/.gemini/GEMINI.md) の読み込み ---
        const memoryPath = path.join(process.env.HOME || '/home/boncoli', '.gemini', 'GEMINI.md');
        let userProfile = "";
        try {
            if (fs.existsSync(memoryPath)) {
                userProfile = fs.readFileSync(memoryPath, 'utf8').substring(0, 5000); // 最大5000文字
            }
        } catch (e) {
            console.error("[Gemini] Profile read error:", e.message);
        }

        // キャラクター設定を外部ファイルから読み込む (再起動なしで変更可能にする)
        let personaConfig = "";
        try {
            personaConfig = fs.readFileSync(path.join(__dirname, 'persona.txt'), 'utf8');
        } catch (e) {
            personaConfig = "あなたは有能なアシスタントです。";
        }

        const systemPrompt = `【最優先：会話の掟】
- **短文（40文字以内）で1〜2文のみ**話してください。
- **箇条書き、解説、アドバイス、能書きは【絶対禁止】**です。
- 親身な「挨拶と共感」に留め、世話を焼く場合も「〜しましょうか？」の一言だけにしてください。

【現在の設定（Persona）】
${personaConfig}

[旦那メモ] ${userProfile}
[なう] ${lastLog ? lastLog.action : '静養中'} / CPU ${sysStatus.cpuTemp}°C / 天気: ${weather ? weather.main_weather + ' ' + Math.round(weather.temp) + '℃' : '不明'}
[トレンド] ${trend ? trend.rank1 : '特になし'}`;

        const openAiKey = process.env.OPENAI_API_KEY_PERSONAL;
        const modelName = process.env.OPENAI_MODEL_NANO || "gpt-5-nano";
        if (!openAiKey) return res.status(500).json({ error: "OpenAI API Key not found" });

        const isReasoning = /^(gpt-5|o1|o3|o4)/.test(modelName.toLowerCase());
        const payload = {
            model: modelName,
            messages: [
                { role: "system", content: systemPrompt },
                ...dbHistory.map(h => ({
                    role: h.role === 'user' ? 'user' : 'assistant',
                    content: h.content
                }))
            ]
        };

        if (isReasoning) {
            payload.max_completion_tokens = 500;
            payload.reasoning_effort = "low";
        } else {
            payload.max_tokens = 500;
            payload.temperature = 0.5;
        }

        let response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openAiKey}`
            },
            body: JSON.stringify(payload)
        });

        let data = await response.json();
        
        // --- Function Calling (save_memory) ---
        // OpenAIのFunction Calling形式に合わせる必要があるが、
        // 現状の server.js は Gemini形式のツール定義になっているため、
        // 一旦シンプルにテキスト応答のみを OpenAI化し、
        // 記憶保存が必要な場合は Geminiに戻すか、OpenAIの tools形式に書き換える必要がある。
        // ここでは「メイドの統一」を優先し、一旦テキスト応答を優先。
        // (将来的に OpenAI tools形式へ移行)

        if (data.choices && data.choices[0] && data.choices[0].message) {
            const aiResponse = data.choices[0].message.content;
            
            // AIの応答をDBに保存
            const aiNow = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).replace(/\//g, '-');
            db.prepare("INSERT INTO ai_chat_log (role, content, timestamp) VALUES (?, ?, ?)").run('ai', aiResponse, aiNow);

            res.json({ response: aiResponse });
        } else {
            console.error("[OpenAI] Invalid response:", JSON.stringify(data));
            res.status(500).json({ error: "AIからの応答が不正です。" });
        }
    } catch (e) {
        console.error("[Gemini] Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// サーバー起動
app.listen(PORT, '0.0.0.0', () => {
    const interfaces = require('os').networkInterfaces();
    let ip = 'localhost';
    for (const dev in interfaces) {
        interfaces[dev].forEach((details) => {
            if (details.family === 'IPv4' && !details.internal) {
                ip = details.address;
            }
        });
    }
    console.log(`=========================================`);
    console.log(`🚀 YATA Web Server running!`);
    console.log(`📡 URL: http://${ip}:${PORT}`);
    console.log(`📂 HTML root: ${path.join(__dirname, 'local_public')}`);
    console.log(`=========================================`);
});