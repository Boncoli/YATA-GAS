/**
 * LLM 疎通・ルーティングテスト (GPT-5系対応確認)
 * Path: tasks/test-llm-routing.js
 */

require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

async function runTest() {
  console.log("=== LLM Routing Test (GPT-5 Compatibility Check) ===");
  
  try {
    // lib/YATA.js 内に定義された関数を呼び出す
    if (typeof testCurrentLlmModelRouting === 'function') {
      testCurrentLlmModelRouting();
      console.log("=== Test Finished Successfully ===");
    } else {
      console.error("Error: testCurrentLlmModelRouting function not found in YATA.js");
    }
  } catch (e) {
    console.error("Test Failed:");
    console.error(e);
  }
}

runTest();
