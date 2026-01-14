require('../lib/gas-bridge.js');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'yata.db');

async function fetchWeather() {
  // excludeからdailyを削除
  const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${process.env.LAT}&lon=${process.env.LON}&exclude=minutely,hourly&units=metric&lang=ja&appid=${process.env.OWM_API_KEY}`;
  
  try {
    const res = JSON.parse(UrlFetchApp.fetch(url).getContentText());
    const cur = res.current;
    
    const nowStr = new Date().toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).replace(/-/g, '/'); 

    const formatUnixTime = (unix) => Utilities.formatDate(new Date(unix * 1000), 'JST', 'HH:mm');
    const alertNames = res.alerts ? res.alerts.map(a => a.event).join(', ') : '';

    const stmt = db.prepare(`INSERT OR REPLACE INTO weather_log VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    stmt.run(
      nowStr,
      cur.weather[0].main,
      cur.weather[0].description,
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
    console.log(`[Success] Current weather recorded: ${nowStr}`);

    // --- Forecast処理 ---
    if (res.daily) {
      const forecastStmt = db.prepare(`INSERT OR REPLACE INTO weather_forecast VALUES (?,?,?,?,?,?,?,?)`);
      
      for (const day of res.daily) {
        // Unix Time -> YYYY/MM/DD
        // Utilities.formatDateを使うとJST変換が確実
        const dateStr = Utilities.formatDate(new Date(day.dt * 1000), 'JST', 'yyyy/MM/dd');
        
        forecastStmt.run(
          dateStr,
          day.temp.min,
          day.temp.max,
          day.weather[0].main,
          day.weather[0].description,
          day.pop, 
          day.humidity,
          nowStr // updated_at
        );
      }
      console.log(`[Success] Forecast updated for ${res.daily.length} days.`);
    }

  } catch (e) { console.error("Weather Error:", e); }
}

module.exports = fetchWeather;
