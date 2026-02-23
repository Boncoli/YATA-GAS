// maintenance/import-kml.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { XMLParser } = require('fast-xml-parser');
const AdmZip = require('adm-zip');

const dbPath = fs.existsSync('/dev/shm/yata.db') ? '/dev/shm/yata.db' : './yata.db';
console.log(`Using DB: ${dbPath}`);
const db = new Database(dbPath);

// --- ユーティリティ ---
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

function formatTimestamp(date) {
    const pad = (n) => (n < 10 ? '0' + n : n);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseDateFromFileName(fileName) {
    const match = fileName.match(/(\d{4})(\d{2})(\d{2})/);
    if (match) {
        return new Date(`${match[1]}-${match[2]}-${match[3]}T09:00:00`); 
    }
    return new Date();
}

function parseDateFromDescription(desc) {
    if (!desc) return null;
    // 例: 2017年5月4日 6:52 JST
    // 例: 2017/05/04 6:52
    const match = desc.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?.*?(\d{1,2}):(\d{1,2})/);
    if (match) {
        return new Date(match[1], match[2] - 1, match[3], match[4], match[5], 0);
    }
    return null;
}

// --- メイン処理 ---
function parseAndImport(kmlContent, defaultDate, sourceName) {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const kmlObj = parser.parse(kmlContent);
    
    // 日付ごとのトラックデータ保管場所
    // key: "YYYY-MM-DD", value: { points: [], startTime: Date, name: string }
    const dailyTracks = {};

    function addPoints(date, points, name) {
        const dateKey = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
        
        if (!dailyTracks[dateKey]) {
            dailyTracks[dateKey] = { points: [], startTime: date, name: name };
        }
        
        dailyTracks[dateKey].points.push(...points);
        
        if (date < dailyTracks[dateKey].startTime) {
            dailyTracks[dateKey].startTime = date;
        }
        // 名前がまだ汎用的なら更新
        if ((!dailyTracks[dateKey].name || dailyTracks[dateKey].name.includes('Track')) && name) {
            dailyTracks[dateKey].name = name;
        }
    }

    // 再帰探索
    function traverse(obj, depth = 0, currentDesc = null, currentName = null) {
        if (!obj) return;
        
        // descriptionとnameの継承 (Placemark直下のものを優先)
        const desc = obj.description || currentDesc;
        const name = obj.name || currentName;

        // LineString
        if (obj.LineString) {
            const lsList = Array.isArray(obj.LineString) ? obj.LineString : [obj.LineString];
            lsList.forEach((ls, idx) => {
                if (ls.coordinates) {
                    const raw = ls.coordinates.trim();
                    const pairs = raw.split(/\s+/);
                    const coords = [];
                    pairs.forEach(pair => {
                        const parts = pair.split(',');
                        if (parts.length >= 2) {
                            coords.push({
                                lat: parseFloat(parts[1]),
                                lon: parseFloat(parts[0]),
                                alt: parseFloat(parts[2] || 0),
                                time: null
                            });
                        }
                    });
                    
                    if (coords.length > 1) {
                        // descriptionから日付を探す -> なければファイル名の日付
                        let ts = parseDateFromDescription(desc) || defaultDate;
                        // 複数ある場合は少し時間をずらす
                        ts = new Date(ts.getTime() + idx * 60000);
                        
                        coords.forEach(p => p.time = ts);
                        addPoints(ts, coords, name);
                    }
                }
            });
        }
        
        // gx:Track
        if (obj['gx:Track']) {
            const trkList = Array.isArray(obj['gx:Track']) ? obj['gx:Track'] : [obj['gx:Track']];
            trkList.forEach(trk => {
                const coordList = Array.isArray(trk['gx:coord']) ? trk['gx:coord'] : [trk['gx:coord']];
                const whenList = Array.isArray(trk['when']) ? trk['when'] : [trk['when']];
                const coords = [];
                
                coordList.forEach((c, i) => {
                    const parts = c.split(' ');
                    if (parts.length >= 2) {
                        const t = whenList[i] ? new Date(whenList[i]) : defaultDate;
                        coords.push({
                            lat: parseFloat(parts[1]),
                            lon: parseFloat(parts[0]),
                            alt: parseFloat(parts[2] || 0),
                            time: t
                        });
                    }
                });

                if (coords.length > 1) {
                    addPoints(coords[0].time, coords, name);
                }
            });
        }

        // 子要素探索
        for (const key in obj) {
            if (typeof obj[key] === 'object') traverse(obj[key], depth + 1, desc, name);
        }
    }

    traverse(kmlObj.kml);

    // --- DB保存 ---
    const insertStmt = db.prepare("INSERT INTO drive_tracks (action, timestamp, note, path_data, point_count) VALUES (?, ?, ?, ?, ?)");
    let savedCount = 0;

    Object.keys(dailyTracks).sort().forEach(dateKey => {
        const data = dailyTracks[dateKey];
        
        // 時間順にソート
        data.points.sort((a, b) => a.time - b.time);

        // 間引き
        const simplified = [];
        if (data.points.length > 0) {
            simplified.push([data.points[0].lat, data.points[0].lon, data.points[0].alt]);
            let last = data.points[0];

            for (let i = 1; i < data.points.length; i++) {
                const curr = data.points[i];
                const dist = getDistance(last.lat, last.lon, curr.lat, curr.lon);
                if (dist > 30) {
                    simplified.push([curr.lat, curr.lon, curr.alt]);
                    last = curr;
                }
            }
        }

        if (simplified.length > 1) {
            const tsStr = formatTimestamp(data.startTime);
            const note = `[KML Import] ${data.name || sourceName}`; // 元のファイル名ではなく、フォルダ名などを採用
            
            insertStmt.run('kml-import', tsStr, note, JSON.stringify(simplified), simplified.length);
            console.log(`✅ Saved daily track: ${dateKey} - ${note} (${simplified.length} pts)`);
            savedCount++;
        }
    });

    return savedCount;
}

// --- メイン ---
const targetFile = process.argv[2];
if (!targetFile) process.exit(1);

const fileName = path.basename(targetFile);
const fileDate = parseDateFromFileName(fileName);

try {
    let content = "";
    if (targetFile.toLowerCase().endsWith('.kmz')) {
        const zip = new AdmZip(targetFile);
        const entries = zip.getEntries();
        const kmlEntry = entries.find(e => e.entryName.toLowerCase().endsWith('.kml'));
        if (!kmlEntry) throw new Error("No KML in KMZ");
        content = zip.readAsText(kmlEntry);
    } else {
        content = fs.readFileSync(targetFile, 'utf8');
    }
    
    const count = parseAndImport(content, fileDate, fileName);

    // 地図の更新 (Pythonスクリプト実行)
    if (count > 0) {
        console.log("🗺️ Updating visited map...");
        const { exec } = require('child_process');
        exec('python3 tasks/generate_visited_map.py', (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ Map update failed: ${error.message}`);
                return;
            }
            if (stderr) console.error(`⚠️ Map update stderr: ${stderr}`);
            console.log(`✅ Map updated: ${stdout.trim()}`);
        });
    }

} catch (e) {
    console.error(`Error: ${e.message}`);
}
