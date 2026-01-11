// do-summarize.js
require('../lib/gas-bridge.js');
require('../lib/YATA.js');

async function run() { // async関数で囲む
  console.log("=== AI要約のみ実行します ===");
  try {
    // ★ await を追加して処理の完了を待つ
    await runSummarizationJob(); 
    console.log("=== 要約完了 ===");
  } catch (e) {
    console.error("エラー:", e);
  }
}

run();