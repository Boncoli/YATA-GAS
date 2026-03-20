// tasks/maintenance-db.js
// ローカルDB (SQLite) 専用のメンテナンススクリプト
// YATA.jsには依存せず、直接DBを操作して古いログデータをアーカイブ・削除します。

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// 設定
dotenv.config({ path: path.join(__dirname, '../.env') });
const DB_PATH = process.env.DB_PATH || 'yata.db';
const ARCHIVE_DIR = path.join(__dirname, '../archive');
const DEFAULT_RETENTION_DAYS = 180; // デフォルト6ヶ月

// コマンドライン引数解析 (--days 365 とか)
const args = process.argv.slice(2);
let retentionDays = DEFAULT_RETENTION_DAYS;
const daysArgIdx = args.indexOf('--days');
if (daysArgIdx !== -1 && args[daysArgIdx + 1]) {
    retentionDays = parseInt(args[daysArgIdx + 1], 10);
}

console.log(`=== DBメンテナンス開始 (保持期間: ${retentionDays}日) ===`);
console.log(`Database: ${DB_PATH}`);

if (!fs.existsSync(DB_PATH)) {
    console.error("❌ データベースファイルが見つかりません。");
    process.exit(1);
}

// アーカイブフォルダ作成
if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
// WALモード確認 (念のため)
db.pragma('journal_mode = WAL');

// 閾値日付の計算 (YYYY-MM-DD)
const thresholdDate = new Date();
thresholdDate.setDate(thresholdDate.getDate() - retentionDays);
const thresholdStr = thresholdDate.toLocaleDateString('sv-SE');
console.log(`削除対象: ${thresholdStr} 以前のデータ`);

// --- メンテナンス対象テーブル定義 ---
const targets = [
    { table: 'weather_forecast', dateCol: 'date', label: '天気予報' },
    { table: 'weather_hourly', dateCol: 'datetime', label: '時間毎天気' },
    { table: 'weather_log', dateCol: 'datetime', label: '現在の天気ログ' },
    { table: 'remo_log', dateCol: 'datetime', label: 'NatureRemoログ' },
    { table: 'finance_log', dateCol: 'date', label: '金融データログ' },
    { table: 'network_log', dateCol: 'date', label: 'ネットワークPingログ' },
    { table: 'trend_log', dateCol: 'date', label: 'トレンドログ' },
    { table: 'log', dateCol: 'timestamp', label: 'システムログ' },
    { table: 'history', dateCol: 'date', label: '検索履歴' },
    { table: 'ai_chat_log', dateCol: 'timestamp', label: 'AIチャット履歴' },
    { table: 'mutter_logs', dateCol: 'timestamp', label: '独り言ログ' }
];

let totalDeleted = 0;

try {
    targets.forEach(target => {
        processTable(target);
    });

    // 最後にVACUUMしてサイズ削減
    console.log("🧹 VACUUM実行中 (DBサイズ圧縮)...");
    db.exec('VACUUM');
    console.log("✅ VACUUM完了");

} catch (e) {
    console.error("❌ エラーが発生しました:", e);
} finally {
    db.close();
    console.log("=== メンテナンス終了 ===");
}

function processTable(target) {
    const { table, dateCol, label } = target;
    
    // テーブル存在確認
    const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    if (!tableExists) {
        console.log(`ℹ️ テーブル ${table} は存在しません。スキップします。`);
        return;
    }

    // 1. 古いデータを抽出
    // weather_hourlyなどは日時(YYYY-MM-DDTHH:mm:ss)かもしれないので、文字列比較でOKなISO形式前提
    const selectSql = `SELECT * FROM ${table} WHERE ${dateCol} < ?`;
    const rows = db.prepare(selectSql).all(thresholdStr);

    if (rows.length === 0) {
        console.log(`✅ [${label}] 古いデータはありません。`);
        return;
    }

    console.log(`📦 [${label}] ${rows.length} 件の古いデータをアーカイブします...`);

    // 2. アーカイブ保存
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${table}_until_${thresholdStr}_${timestamp}.json`;
    const filePath = path.join(ARCHIVE_DIR, filename);

    try {
        fs.writeFileSync(filePath, JSON.stringify(rows, null, 2));
        console.log(`   -> 保存完了: ${filename}`);
    } catch (e) {
        console.error(`   ❌ ファイル保存エラー: ${e.message}`);
        return; // 保存失敗したら削除しない
    }

    // 3. 削除実行
    const deleteSql = `DELETE FROM ${table} WHERE ${dateCol} < ?`;
    const info = db.prepare(deleteSql).run(thresholdStr);
    
    console.log(`🗑️ [${label}] ${info.changes} 件削除しました。`);
    totalDeleted += info.changes;
}
