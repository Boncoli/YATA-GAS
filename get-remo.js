require('./gas-bridge.js');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'yata.db');

async function fetchRemo() {
  const url = "https://api.nature.global/1/devices";
  const options = { "headers": { 'Authorization': 'Bearer ' + process.env.REMO_ACCESS_TOKEN } };

  try {
    const res = JSON.parse(UrlFetchApp.fetch(url, options).getContentText());
    // 日本標準時(JST)でフォーマットする標準的な書き方
    const nowStr = new Date().toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(/-/g, '/'); // 2026-01-11 を 2026/01/11 に変換

    // リビング(remo3)と寝室のデータを抽出
    const living = res.find(d => d.name.includes("リビング"))?.newest_events || {};
    const bedroom = res.find(d => d.name.includes("寝室"))?.newest_events || {};

    const stmt = db.prepare(`INSERT OR REPLACE INTO remo_log VALUES (?,?,?,?,?,?)`);
    stmt.run(
      nowStr,
      living.te?.val || null,
      living.hu?.val || null,
      living.il?.val || null,
      living.mo?.val || null,
      bedroom.te?.val || null
    );
    console.log(`[Success] Remo recorded: Living ${living.te?.val}℃, Bedroom ${bedroom.te?.val}℃`);
  } catch (e) { console.error("Remo Error:", e); }
}
fetchRemo();