// do-weather.js
require('../lib/gas-bridge.js');
const fetchWeather = require('../modules/get-weather.js');

async function run() {
  console.log("=== 天気情報のみ取得します ===");
  try {
    await fetchWeather();
    console.log("=== 取得・記録完了 ===");
  } catch (e) {
    console.error("エラー:", e);
  }
}

run();