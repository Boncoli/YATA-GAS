// yata-tasks.js
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') }); 
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

// 各モジュールの読み込み
const fetchWeather = require('../modules/get-weather.js');
const fetchRemo = require('../modules/get-remo.js');
const fetchFinance = require('../modules/get-finance.js');
const fetchTrends = require('../modules/get-trends.js');
const runPing = require('../modules/get-ping.js');

// Discord通知関数
function sendDiscord(message) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    const payload = JSON.stringify({ content: message });
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: payload
    });
  } catch (e) {
    console.error("Discord Error:", e.message);
  }
}

async function main() {
  const startTime = new Date();
  
  // --- 引数のチェック ---
  const isLightMode = process.argv.includes('--light');
  
  console.log(`\n--- [${startTime.toLocaleString()}] YATA Task Start (${isLightMode ? 'LIGHT' : 'FULL'}) ---`);

  let errors = [];

  // 1. RSS収集 & 2. AI要約 (FULLモードの時のみ実行)
  if (!isLightMode) {
    try {
      console.log("\n[1/7] Starting RSS Collection...");
      await runCollectionJob(); 
    } catch (e) { 
      console.error("Collection Error:", e);
      errors.push(`RSS: ${e.message}`);
    }

    try {
      console.log("\n[2/7] Starting AI Summarization...");
      await runSummarizationJob();
    } catch (e) { 
      console.error("Summarization Error:", e);
      errors.push(`AI: ${e.message}`);
    }
  } else {
    console.log("\n[Skip] RSS & AI (Light Mode)");
  }

  // --- 3.〜7. 数値データ収集 (常に実行) ---
  try {
    console.log(`\n[${isLightMode ? '1/5' : '3/7'}] Recording Weather...`);
    await fetchWeather();
  } catch (e) { errors.push(`Weather: ${e.message}`); }

  try {
    console.log(`\n[${isLightMode ? '2/5' : '4/7'}] Recording Nature Remo...`);
    await fetchRemo();
  } catch (e) { errors.push(`Remo: ${e.message}`); }

  try {
    console.log(`\n[${isLightMode ? '3/5' : '5/7'}] Recording Finance Data...`);
    await fetchFinance();
  } catch (e) { errors.push(`Finance: ${e.message}`); }

  try {
    console.log(`\n[${isLightMode ? '4/5' : '6/7'}] Recording Trend Data...`);
    await fetchTrends();
  } catch (e) { errors.push(`Trend: ${e.message}`); }

  try {
    console.log(`\n[${isLightMode ? '5/5' : '7/7'}] Recording Network Ping...`);
    await runPing();
  } catch (e) { errors.push(`Ping: ${e.message}`); }

  // --- 8. Geminiの独り言 (New!) ---
  try {
    console.log("\n[*] Gemini is muttering something...");
    // 外部スクリプトとして実行 (メモリDBのロック競合を避けるため、同期的に実行したいが、
    // ここは単純に require で呼び出すか、別プロセスにするか検討)
    // 今回は最も確実な execSync (run-ram.sh経由) で実行する
    const { execSync } = require('child_process');
    // --no-sync を付けて実行することで、このタスク自体の sync と干渉しないようにする
    execSync('bash run-ram.sh --no-sync tasks/do-ai-mutter.js', { stdio: 'inherit' });
  } catch (e) {
    console.error("Muttering Error:", e.message);
  }

  const endTime = new Date();
  const duration = ((endTime - startTime) / 1000).toFixed(1);
  const timeStr = endTime.toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' });

  // 通知制御
  if (errors.length > 0) {
    const errorMsg = errors.map(e => `・${e}`).join("\n");
    sendDiscord(`⚠ [YATA] エラー発生(${timeStr})\n${errorMsg}`);
  }
  
  console.log(`\n--- [${endTime.toLocaleString()}] Finished (${duration}s) ---`);
}

main();