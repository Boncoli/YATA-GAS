require('./gas-bridge.js');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'yata.db');

async function fetchWeather() {
  const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${process.env.LAT}&lon=${process.env.LON}&exclude=minutely,hourly,daily&units=metric&lang=ja&appid=${process.env.OWM_API_KEY}`;
  
  try {
    const res = JSON.parse(UrlFetchApp.fetch(url).getContentText());
    const cur = res.current;
    // 日本標準時(JST)でフォーマットする標準的な書き方
    const nowStr = new Date().toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(/-/g, '/'); // 2026-01-11 を 2026/01/11 に変換

    // 時刻変換用ヘルパー
    const formatUnixTime = (unix) => Utilities.formatDate(new Date(unix * 1000), 'JST', 'HH:mm');

    // 警報名の抽出
    const alertNames = res.alerts ? res.alerts.map(a => a.event).join(', ') : '';

    const stmt = db.prepare(`INSERT OR REPLACE INTO weather_log VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    stmt.run(
      nowStr,
      cur.weather[0].main,        // Rain, Clouds等
      cur.weather[0].description, // 曇りがち等
      cur.temp,
      cur.feels_like,
      cur.pressure,
      cur.humidity,
      cur.dew_point,
      cur.uvi,
      cur.clouds,
      cur.visibility,
      cur.wind_speed,
      cur.wind_deg,
      cur.wind_gust || 0,
      cur.rain ? cur.rain['1h'] : 0,
      cur.snow ? cur.snow['1h'] : 0,
      formatUnixTime(cur.sunrise),
      formatUnixTime(cur.sunset),
      res.alerts ? res.alerts.length : 0,
      alertNames
    );
    console.log(`[Success] Weather all-in recorded: ${nowStr}`);
  } catch (e) { console.error("Weather Error:", e); }
}
fetchWeather();