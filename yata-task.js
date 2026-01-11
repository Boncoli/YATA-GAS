// yata-task.js
require('dotenv').config(); // 【追加】冒頭で.envを読み込む
require('./gas-bridge.js');
require('./YATA.js');

const { execSync } = require('child_process');

// 【追加】環境変数からnodeのパスを取得。なければデフォルトの 'node' を使用
const node = process.env.NODE_PATH || 'node';

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

  // 3. 天気ログ (外部ファイルとして実行)
  try {
    console.log("\n[3/4] Recording Weather...");
    // 【修正】フルパス直書きを ${node} に置き換え
    execSync(`${node} get-weather.js`, { stdio: 'inherit' });
  } catch (e) { console.error("Weather Log Error:", e); }

  // 4. 室温ログ (外部ファイルとして実行)
  try {
    console.log("\n[4/4] Recording Nature Remo...");
    // 【修正】フルパス直書きを ${node} に置き換え
    execSync(`${node} get-remo.js`, { stdio: 'inherit' });
  } catch (e) { console.error("Remo Log Error:", e); }

  console.log(`\n--- [${new Date().toLocaleString()}] All Tasks Finished ---`);
}

main();