/**
 * maintenance/import-gpx.js
 * GPXファイルを解析し、YATAのdrive_logsテーブルにインポートするスクリプト。
 * 
 * 使い方: node maintenance/import-gpx.js "[ファイル名].gpx"
 */

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const Database = require('better-sqlite3');

// --- 設定 ---
const DB_PATH = process.env.DB_PATH || '/dev/shm/yata.db';
const MIN_DISTANCE_METERS = 50; // 最低50m移動したら記録 (間引き)
const MIN_INTERVAL_SECONDS = 30; // 最低30秒経過したら記録 (間引き)

if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ DBが見つかりません: ${DB_PATH}`);
    process.exit(1);
}

const db = new Database(DB_PATH);
const parser = new XMLParser({ ignoreAttributes: false });

// 緯度経度から距離(m)を計算する (ヒュベニの公式)
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // 地球の半径(m)
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function run() {
    const gpxFile = process.argv[2];
    if (!gpxFile) {
        console.log("Usage: node maintenance/import-gpx.js <path-to-gpx-file>");
        return;
    }

    console.log(`📖 ファイルを読み込み中: ${gpxFile}`);
    const xmlData = fs.readFileSync(gpxFile, 'utf8');
    const jsonObj = parser.parse(xmlData);

    // trk -> trkseg -> trkpt の階層を辿る
    const trk = jsonObj.gpx.trk;
    if (!trk) {
        console.error("❌ 有効なトラックデータ(trk)が見つかりません。");
        return;
    }

    // ファイル名からメモを作成
    const notePrefix = `[GPX Import] ${path.basename(gpxFile, '.gpx')}`;
    
    // trksegが配列か単一オブジェクトか対応
    const segments = Array.isArray(trk.trkseg) ? trk.trkseg : [trk.trkseg];
    
    let totalImported = 0;
    let lastPoint = null;

    const insert = db.prepare(`
        INSERT INTO drive_logs (action, timestamp, latitude, longitude, altitude, address, note, battery)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 重複チェック用
    const checkExists = db.prepare("SELECT id FROM drive_logs WHERE timestamp = ? AND action = 'iphone-path'");

    db.transaction(() => {
        for (const seg of segments) {
            const points = seg.trkpt;
            if (!points) continue;

            for (const pt of points) {
                const lat = parseFloat(pt['@_lat']);
                const lon = parseFloat(pt['@_lon']);
                const ele = pt.ele ? parseFloat(pt.ele) : 0;
                
                // ISO形式(UTC)を日本時間に変換 (既存のログ形式に合わせる)
                const date = new Date(pt.time);
                const timestamp = date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).replace(/\//g, '-');

                // 間引きロジック
                if (lastPoint) {
                    const dist = getDistance(lastPoint.lat, lastPoint.lon, lat, lon);
                    const timeDiff = (date - lastPoint.date) / 1000;

                    if (dist < MIN_DISTANCE_METERS && timeDiff < MIN_INTERVAL_SECONDS) {
                        continue; // 近すぎる かつ 時間が経ってない場合はスキップ
                    }
                }

                // 重複チェック
                if (checkExists.get(timestamp)) {
                    continue;
                }

                // インポート実行
                insert.run(
                    'iphone-path',
                    timestamp,
                    lat,
                    lon,
                    ele,
                    null, // 住所は後でバッチ取得する想定
                    notePrefix,
                    null  // バッテリー情報はGPXにないのでnull
                );

                totalImported++;
                lastPoint = { lat, lon, date };
            }
        }
    })();

    console.log(`✅ インポート完了!`);
    console.log(`📊 登録件数: ${totalImported} 件`);
    console.log(`💡 action='iphone-path' として登録されました。`);
}

run().catch(console.error);
