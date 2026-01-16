const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * YATA Loader for Raspberry Pi
 * 
 * GitHubで管理されている `YATA.js` を直接編集せずに、
 * Node.js環境（ラズパイ）で実行できるようにするためのラッパーです。
 * 
 * 1. GAS環境を模倣して `YATA.js` をグローバルスコープでロードします。
 * 2. ラズパイ用に設定（タイムアウト時間など）をメモリ上でオーバーライドします。
 */

// 1. YATA.js の読み込みと展開
const yataPath = path.join(__dirname, 'YATA.js');
try {
  const yataCode = fs.readFileSync(yataPath, 'utf8');
  
  // vm.runInThisContext を使うことで、ファイル内の関数定義 (function x() {}) が
  // 現在の global スコープに展開されます（GASの挙動に近い）。
  vm.runInThisContext(yataCode, { filename: yataPath });
  
  console.log("✅ [Loader] YATA.js loaded into global scope.");
} catch (e) {
  console.error("❌ [Loader] Failed to load YATA.js:", e);
  process.exit(1);
}

// 2. 設定のオーバーライド (ラズパイ最適化)
if (typeof AppConfig !== 'undefined') {
  try {
    const config = AppConfig.get();

    // --- タイムアウト制限の緩和 ---
    // GASの6分制限を無視し、ラズパイでは長時間実行(60分)を許可する
    if (config.System && config.System.TimeLimit) {
      config.System.TimeLimit.SUMMARIZATION = 3600 * 1000;    // 60分
      config.System.TimeLimit.REPORT_GENERATION = 3600 * 1000; // 60分
      console.log("⚡ [Loader] TimeLimits extended for Raspberry Pi (60min).");
    }
    
    // 他に上書きしたい設定があればここに追記
    
  } catch (e) {
    console.warn("⚠️ [Loader] Failed to override AppConfig:", e);
  }
}

// Node.jsの作法として空のオブジェクトをエクスポートしておく
module.exports = {};
