// yata-task.js
require('dotenv').config(); // 【追加】冒頭で.envを読み込む
require('../lib/gas-bridge.js');
require('../lib/YATA.js');

// Import external task modules
const fetchWeather = require('../modules/get-weather.js');
const fetchRemo = require('../modules/get-remo.js');

async function main() {
  console.log(`\n--- [${new Date().toLocaleString()}] YATA Total Task Start ---`);

  // 1. RSS収集
  try {
    console.log("\n[1/4] Starting RSS Collection...");
    await runCollectionJob(); 
  } catch (e) { console.error("Collection Error:", e); }

  // 2. AI要約
  try {
    console.log("\n[2/4] Starting AI Summarization...");
    await runSummarizationJob();
  } catch (e) { console.error("Summarization Error:", e); }

  // 3. 天気ログ (関数呼び出し)
  try {
    console.log("\n[3/4] Recording Weather...");
    await fetchWeather();
  } catch (e) { console.error("Weather Log Error:", e); }

  // 4. 室温ログ (関数呼び出し)
  try {
    console.log("\n[4/4] Recording Nature Remo...");
    await fetchRemo();
  } catch (e) { console.error("Remo Log Error:", e); }

  console.log(`\n--- [${new Date().toLocaleString()}] All Tasks Finished ---`);
}

main();