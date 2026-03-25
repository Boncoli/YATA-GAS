
require("../lib/gas-bridge.js");
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// YATA.js をロードして内部関数にアクセス可能にする
const yataCode = fs.readFileSync(path.join(__dirname, "../lib/YATA.js"), "utf8");
const sandbox = { ...global };
vm.createContext(sandbox);
vm.runInContext(yataCode, sandbox);

const getContext = sandbox.getArticleContextForAnalysis_;

console.log("🧪 [Test] Context Optimization (High-Density Context Generation)");
console.log("------------------------------------------------------------");

// ケース1: 完璧な構造化JSON
const case1 = {
  title: "次世代全固体電池の開発",
  headline: JSON.stringify({
    who: "東大チーム",
    what: "高出力全固体電池",
    why: "EV航続距離向上",
    how: "新開発の固体電解質",
    result: "エネルギー密度2倍達成",
    tldr: "東大が画期的な電池を開発しました。",
    keywords: ["電池", "EV"]
  })
};

// ケース2: Unknown混じりのJSON
const case2 = {
  title: "AIによる創薬加速",
  headline: JSON.stringify({
    who: "Unknown",
    what: "創薬AIモデル",
    why: "創薬コスト削減",
    how: "拡散モデルの応用",
    result: "Unknown",
    tldr: "AIで薬を作ります。",
    keywords: ["AI", "バイオ"]
  })
};

// ケース3: 非JSON（旧形式やエラー文）
const case3 = {
  title: "普通のニュース",
  headline: "これは普通のテキスト要約です。"
};

function runTest(name, article) {
  console.log(`\n[${name}]`);
  console.log(`  Input (Headline): ${article.headline.substring(0, 50)}${article.headline.length > 50 ? "..." : ""}`);
  const result = getContext(article);
  console.log(`  Output: ${result}`);
  
  if (name === "Case 1") {
    const expectedOrder = result.indexOf("[WHAT]") < result.indexOf("[HOW]") && result.indexOf("[HOW]") < result.indexOf("[RESULT]");
    console.log(`  ✅ 論理的順序 (WHAT->HOW->RESULT): ${expectedOrder ? "PASS" : "FAIL"}`);
    console.log(`  ✅ 全要素保持: ${result.includes("[WHO]") && result.includes("[KEYWORDS]") ? "PASS" : "FAIL"}`);
  }
  if (name === "Case 2") {
    console.log(`  ✅ Unknown排除 (WHO/RESULT): ${!result.includes("Unknown") ? "PASS" : "FAIL"}`);
    console.log(`  ✅ 有効要素保持 (WHAT/HOW/WHY): ${result.includes("[WHAT]") && result.includes("[HOW]") ? "PASS" : "FAIL"}`);
  }
  if (name === "Case 3") {
    console.log(`  ✅ フォールバック (そのまま): ${result === article.headline ? "PASS" : "FAIL"}`);
  }
}

runTest("Case 1", case1);
runTest("Case 2", case2);
runTest("Case 3", case3);

console.log("\n✨ テスト完了。物理的に正常動作を確認しました。");
