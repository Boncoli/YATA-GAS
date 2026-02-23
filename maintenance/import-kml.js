/**
 * maintenance/import-kml.js
 * KML/KMZファイルを解析し、YATAのdrive_logsテーブルにインポートするスクリプト。
 * 
 * 使い方: 
 *   node maintenance/import-kml.js "[ファイル名].kml"
 *   node maintenance/import-kml.js "[ファイル名].kmz"
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { XMLParser } = require('fast-xml-parser');
const Database = require('better-sqlite3');

// --- 設定 ---
const DB_PATH = process.env.DB_PATH || '/dev/shm/yata.db';
const TMP_DIR = '/tmp/yata-kml-import';
const MIN_DISTANCE_METERS = 50; // 最低50m移動したら記録 (間引き)
const MIN_INTERVAL_SECONDS = 30; // 最低30秒経過したら記録 (間引き)

if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ DBが見つかりません: ${DB_PATH}`);
    process.exit(1);
}

const db = new Database(DB_PATH);
const parser = new XMLParser({ 
    ignoreAttributes: false,
    attributeNamePrefix: "@_"
});

// 緯度経度から距離(m)を計算する (ヒュベニの公式)
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function formatDate(date) {
    return date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).replace(/\//g, '-');
}

// 日本語の説明文から日時を抽出する関数
function parseDateFromDescription(desc, defaultTime) {
    if (!desc) return defaultTime;
    // 例: 2024年2月9日金曜日 9:09 JST
    const match = desc.match(/(\d{4})年(\d{1,2})月(\d{1,2})日.*?\s(\d{1,2}):(\d{1,2})\sJST/);
    if (match) {
        const [_, y, m, d, hh, mm] = match;
        return new Date(y, m - 1, d, hh, mm, 0);
    }
    return defaultTime;
}

async function run() {
    const inputFile = process.argv[2];
    if (!inputFile) {
        console.log("Usage: node maintenance/import-kml.js <path-to-kml-or-kmz-file>");
        return;
    }

    let kmlPath = inputFile;
    const isKmz = inputFile.toLowerCase().endsWith('.kmz');

    if (isKmz) {
        console.log(`📦 KMZファイルを解凍中: ${inputFile}`);
        if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
        try {
            execSync(`unzip -o "${inputFile}" -d "${TMP_DIR}"`);
            kmlPath = path.join(TMP_DIR, 'doc.kml');
            if (!fs.existsSync(kmlPath)) {
                const files = fs.readdirSync(TMP_DIR);
                const foundKml = files.find(f => f.endsWith('.kml'));
                if (foundKml) {
                    kmlPath = path.join(TMP_DIR, foundKml);
                } else {
                    throw new Error("KMZ内にかKMLファイルが見つかりません。");
                }
            }
        } catch (e) {
            console.error(`❌ 解凍失敗: ${e.message}`);
            return;
        }
    }

    console.log(`📖 KMLを読み込み中: ${kmlPath}`);
    const xmlData = fs.readFileSync(kmlPath, 'utf8');
    const jsonObj = parser.parse(xmlData);

    function findPlacemarks(obj) {
        let placemarks = [];
        if (!obj) return placemarks;
        if (Array.isArray(obj)) {
            obj.forEach(item => {
                placemarks = placemarks.concat(findPlacemarks(item));
            });
        } else if (typeof obj === 'object') {
            if (obj.Placemark) {
                const p = Array.isArray(obj.Placemark) ? obj.Placemark : [obj.Placemark];
                placemarks = placemarks.concat(p);
            }
            for (const key in obj) {
                if (key !== 'Placemark') {
                    placemarks = placemarks.concat(findPlacemarks(obj[key]));
                }
            }
        }
        return placemarks;
    }

    const placemarks = findPlacemarks(jsonObj.kml);
    if (placemarks.length === 0) {
        console.error("❌ Placemarkが見つかりませんでした。");
        return;
    }

    const fileName = path.basename(inputFile);
    const notePrefix = `[KML Import] ${fileName}`;
    let totalImportedPoints = 0;
    let totalTracks = 0;
    
    const stats = fs.statSync(inputFile);
    let fileMtime = stats.mtime;

    // テーブルがなければ作成
    db.exec(`CREATE TABLE IF NOT EXISTS drive_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT,
        timestamp TEXT,
        note TEXT,
        path_data TEXT,
        point_count INTEGER
    )`);

    const insertTrack = db.prepare(`
        INSERT INTO drive_tracks (action, timestamp, note, path_data, point_count)
        VALUES (?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
        for (const pm of placemarks) {
            const name = pm.name || "Unnamed Path";
            const desc = pm.description || "";
            let rawPoints = [];

            // 1. LineString (軌跡)
            if (pm.LineString && pm.LineString.coordinates) {
                const coordsStr = pm.LineString.coordinates.trim();
                const coordPairs = coordsStr.split(/\s+/);
                coordPairs.forEach(pair => {
                    const [lon, lat, alt] = pair.split(',').map(Number);
                    if (!isNaN(lat) && !isNaN(lon)) {
                        rawPoints.push({ lat, lon, alt: alt || 0 });
                    }
                });
            }
            // 2. Point (地点)
            else if (pm.Point && pm.Point.coordinates) {
                const [lon, lat, alt] = pm.Point.coordinates.trim().split(',').map(Number);
                if (!isNaN(lat) && !isNaN(lon)) {
                    rawPoints.push({ lat, lon, alt: alt || 0 });
                }
            }
            // 3. gx:Track
            else if (pm['gx:Track']) {
                const track = pm['gx:Track'];
                const coords = Array.isArray(track['gx:coord']) ? track['gx:coord'] : [track['gx:coord']];
                const times = Array.isArray(track['when']) ? track['when'] : [track['when']];
                coords.forEach((c, i) => {
                    const [lon, lat, alt] = c.split(' ').map(Number);
                    if (!isNaN(lat) && !isNaN(lon)) {
                        rawPoints.push({ lat, lon, alt: alt || 0, time: times[i] ? new Date(times[i]) : null });
                    }
                });
            }

            if (rawPoints.length === 0) continue;

            // 時刻の決定
            const baseTime = parseDateFromDescription(desc, fileMtime);
            
            // 間引きと整形
            let lastPoint = null;
            let finalPath = [];

            rawPoints.forEach((pt, idx) => {
                const currentTime = pt.time || new Date(baseTime.getTime() + idx * 1000);
                
                if (lastPoint) {
                    const dist = getDistance(lastPoint.lat, lastPoint.lon, pt.lat, pt.lon);
                    const timeDiff = (currentTime - lastPoint.time) / 1000;
                    if (dist < MIN_DISTANCE_METERS && timeDiff < MIN_INTERVAL_SECONDS) return;
                }

                // [lat, lon, alt] 形式で格納
                finalPath.push([pt.lat, pt.lon, pt.alt]);
                lastPoint = { ...pt, time: currentTime };
            });

            if (finalPath.length > 0) {
                const trackTimestamp = formatDate(lastPoint ? lastPoint.time : baseTime);
                const trackNote = `${notePrefix}: ${name}`;

                insertTrack.run(
                    'iphone-path',
                    trackTimestamp,
                    trackNote,
                    JSON.stringify(finalPath),
                    finalPath.length
                );
                
                totalImportedPoints += finalPath.length;
                totalTracks++;
                console.log(`✅ Track saved: ${name} (${finalPath.length} points)`);
            }
        }
    })();

    // 後片付け
    if (isKmz && fs.existsSync(TMP_DIR)) {
        try { execSync(`rm -rf "${TMP_DIR}"`); } catch (e) {}
    }

    console.log(`✅ インポート完了!`);
    console.log(`📊 登録Track数: ${totalTracks} 件`);
    console.log(`📊 総ポイント数: ${totalImportedPoints} 件`);
}

run().catch(console.error);
