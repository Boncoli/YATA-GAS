/**
 * maintenance/migrate_to_tracks.js
 * drive_logs内のバラバラなiphone-pathデータを、drive_tracksテーブルへ1行ずつ集約する移行スクリプト
 */
const Database = require('better-sqlite3');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || '/dev/shm/yata.db';
const db = new Database(DB_PATH);

console.log(`🚀 移行開始: ${DB_PATH}`);

// 1. 新テーブル作成
db.exec(`CREATE TABLE IF NOT EXISTS drive_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT,
    timestamp TEXT,
    note TEXT,
    path_data TEXT,      -- JSON形式の座標配列
    point_count INTEGER
)`);

// 2. 既存の iphone-path データを note ごとに取得
const groups = db.prepare("SELECT note, MIN(timestamp) as start_time FROM drive_logs WHERE action = 'iphone-path' GROUP BY note").all();

db.transaction(() => {
    for (const group of groups) {
        console.log(`📦 集約中: ${group.note}`);
        
        // そのグループに属する全ポイントを取得
        const points = db.prepare("SELECT latitude, longitude, altitude FROM drive_logs WHERE action = 'iphone-path' AND note = ? ORDER BY timestamp ASC").all(group.note);
        
        if (points.length === 0) continue;

        // [lat, lon, alt] の配列に変換
        const pathData = points.map(p => [p.latitude, p.longitude, p.altitude]);

        // 新テーブルへ挿入
        const insert = db.prepare(`
            INSERT INTO drive_tracks (action, timestamp, note, path_data, point_count)
            VALUES (?, ?, ?, ?, ?)
        `);
        insert.run('iphone-path', group.start_time, group.note, JSON.stringify(pathData), pathData.length);

        console.log(`✅ ${pathData.length} 地点を1行にまとめました。`);
    }

    // 3. 元のバラバラなデータを削除
    const deleteOld = db.prepare("DELETE FROM drive_logs WHERE action = 'iphone-path'");
    const result = deleteOld.run();
    console.log(`🧹 古いデータ ${result.changes} 件を削除しました。`);
})();

console.log("✨ 移行完了！");
