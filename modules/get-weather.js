require('../lib/gas-bridge.js');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'yata.db');

async function fetchWeather() {
  // excludeからdailyを削除, hourlyも含めるためにminutelyのみ除外
  const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${process.env.LAT}&lon=${process.env.LON}&exclude=minutely&units=metric&lang=ja&appid=${process.env.OWM_API_KEY}`;
  
  // ★追加: 大気汚染API (Air Pollution)
  const aqiUrl = `http://api.openweathermap.org/data/2.5/air_pollution?lat=${process.env.LAT}&lon=${process.env.LON}&appid=${process.env.OWM_API_KEY}`;

  try {
    const res = JSON.parse(UrlFetchApp.fetch(url).getContentText());
    
    // ★追加: AQI取得
    let aqiData = { main: { aqi: 0 }, components: { co: 0, no2: 0, o3: 0, pm2_5: 0, pm10: 0 } };
    try {
      const aqiRes = JSON.parse(UrlFetchApp.fetch(aqiUrl).getContentText());
      if (aqiRes.list && aqiRes.list.length > 0) {
        aqiData = aqiRes.list[0];
      }
    } catch (e) {
      console.warn("AQI Fetch Warning:", e.message);
    }

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

    // ▼ 注意報の重複排除ロジック
    // 同じ名前の注意報は Set で1つにまとめ、違う種類の注意報はそのまま残ります
    const uniqueAlerts = res.alerts ? [...new Set(res.alerts.map(a => a.event))] : [];
    const alertNames = uniqueAlerts.join(', '); // 例: "強風注意報, 雷注意報"
    const alertCount = uniqueAlerts.length;    // 重複を除いた種類数

    // weather_logテーブルへの保存（26カラム）
    // aqi, co, no2, o3, pm2_5, pm10 を追加
    const stmt = db.prepare(`INSERT OR REPLACE INTO weather_log VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
      alertCount, 
      alertNames,
      // ★AQI関連
      aqiData.main.aqi,
      aqiData.components.co,
      aqiData.components.no2,
      aqiData.components.o3,
      aqiData.components.pm2_5,
      aqiData.components.pm10
    );
    console.log(`[Success] Current weather recorded: ${nowStr} (AQI: ${aqiData.main.aqi})`);

    // --- Forecast処理 (Daily) ---
    if (res.daily) {
      const forecastStmt = db.prepare(`INSERT OR REPLACE INTO weather_forecast VALUES (?,?,?,?,?,?,?,?)`);
      
      for (const day of res.daily) {
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

    // --- Hourly処理 ---
    if (res.hourly) {
      const hourlyStmt = db.prepare(`INSERT OR REPLACE INTO weather_hourly VALUES (?,?,?,?,?,?)`);
      let hourlyCount = 0;
      for (const h of res.hourly) {
        const dtStr = Utilities.formatDate(new Date(h.dt * 1000), 'JST', 'yyyy/MM/dd HH:mm');
        
        hourlyStmt.run(
          dtStr,
          h.temp,
          h.weather[0].main,
          h.weather[0].description,
          h.pop,
          nowStr // updated_at
        );
        hourlyCount++;
      }
      console.log(`[Success] Hourly forecast updated (${hourlyCount} points).`);
    }

  } catch (e) { console.error("Weather Error:", e); }
}

module.exports = fetchWeather;