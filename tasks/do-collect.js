// do-collect.js
require('../lib/gas-bridge.js');
require('../lib/YATA.js');

async function run() {
  console.log("=== RSS収集のみ実行します ===");
  try {
    // ★ await を追加
    await runCollectionJob(); 
    console.log("=== 収集完了 ===");
  } catch (e) {
    console.error("エラー:", e);
  }
}

run();