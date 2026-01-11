// yata-task.js
require('dotenv').config(); // 【追加】冒頭で.envを読み込む
require('../lib/gas-bridge.js');
require('../lib/YATA.js');

// Import external task modules
const fetchWeather = require('../modules/get-weather.js');
const fetchRemo = require('../modules/get-remo.js');
const fetchFinance = require('../modules/get-finance.js');
const fetchTrends = require('../modules/get-trends.js');
const runPing = require('../modules/get-ping.js');

async function main() {
  console.log(`\n--- [${new Date().toLocaleString()}] YATA Total Task Start ---`);

  // 1. RSS収集
  try {
    console.log("\n[1/7] Starting RSS Collection...");
    await runCollectionJob(); 
  } catch (e) { console.error("Collection Error:", e); }

  // 2. AI要約
  try {
    console.log("\n[2/7] Starting AI Summarization...");
    await runSummarizationJob();
  } catch (e) { console.error("Summarization Error:", e); }

  // 3. 天気ログ (関数呼び出し)
  try {
    console.log("\n[3/7] Recording Weather...");
    await fetchWeather();
  } catch (e) { console.error("Weather Log Error:", e); }

  // 4. 室温ログ (関数呼び出し)
  try {
    console.log("\n[4/7] Recording Nature Remo...");
    await fetchRemo();
  } catch (e) { console.error("Remo Log Error:", e); }

  // 5. 金融ログ
  try {
    console.log("\n[5/7] Recording Finance Data...");
    await fetchFinance();
  } catch (e) { console.error("Finance Log Error:", e); }

  // 6. トレンドログ
  try {
    console.log("\n[6/7] Recording Trend Data...");
    await fetchTrends();
  } catch (e) { console.error("Trend Log Error:", e); }

  // 7. ネットワークPingログ
  try {
    console.log("\n[7/7] Recording Network Ping...");
    await runPing();
  } catch (e) { console.error("Ping Log Error:", e); }

  console.log(`\n--- [${new Date().toLocaleString()}] All Tasks Finished ---`);
}

main();