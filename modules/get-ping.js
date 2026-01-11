require('../lib/gas-bridge.js');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const db = new Database(process.env.DB_PATH || 'yata.db');

// テーブル作成
db.prepare(`
  CREATE TABLE IF NOT EXISTS network_log (
    date TEXT PRIMARY KEY,
    target TEXT,
    avg_ms REAL,
    packet_loss_rate REAL
  )
`).run();

/**
 * Pingを実行してネットワーク品質を記録する
 */
async function runPing() {
  const target = '8.8.8.8'; // Google Public DNS
  
  // 現在時刻
  const nowStr = new Date().toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).replace(/-/g, '/');

  try {
    // Ping実行 (3回送信, タイムアウト2秒)
    // Linux/Mac用コマンド: ping -c 3 -W 2 8.8.8.8
    const cmd = `ping -c 3 -W 2 ${target}`;
    
    let stdout;
    try {
      stdout = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e) {
      // Ping失敗時（ネット断など）もエラーオブジェクトにstdoutが含まれる場合がある
      stdout = e.stdout || "";
      console.warn("[Ping] Command failed or packet loss occurred.");
    }

    // 解析ロジック (Linuxのping出力例)
    // --- 8.8.8.8 ping statistics ---
    // 3 packets transmitted, 3 received, 0% packet loss, time 2003ms
    // rtt min/avg/max/mdev = 10.123/12.456/15.789/2.123 ms

    // パケットロス率
    const lossMatch = stdout.match(/([0-9.]+)% packet loss/);
    const loss = lossMatch ? parseFloat(lossMatch[1]) : 100.0;

    // 平均応答時間 (avg)
    // rtt min/avg/max/mdev = ...
    const rttMatch = stdout.match(/rtt min\/avg\/max\/mdev = [0-9.]+\/([0-9.]+)\//);
    const avg = rttMatch ? parseFloat(rttMatch[1]) : null;

    // DB保存
    const stmt = db.prepare(`INSERT OR REPLACE INTO network_log VALUES (?, ?, ?, ?)`);
    stmt.run(
      nowStr,
      target,
      avg,
      loss
    );
    
    console.log(`[Success] Ping recorded: ${target}, Avg=${avg}ms, Loss=${loss}%`);

  } catch (e) {
    console.error("[Ping] Unexpected Error:", e);
  }
}

// 単体実行用
if (require.main === module) {
  runPing();
}

module.exports = runPing;
