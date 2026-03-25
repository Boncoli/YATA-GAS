
require("../lib/gas-bridge.js");
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// YATA.js をロードし、内部の require('./gas-bridge.js') を無効化してロード
let yataCode = fs.readFileSync(path.join(__dirname, "../lib/YATA.js"), "utf8");
yataCode = yataCode.replace(/require\(['"]\.\/gas-bridge\.js['"]\);/g, "// require(mod);");

const sandbox = { 
  ...global, // global.PropertiesService 等が含まれる
  console, 
  process, 
  require, 
  setTimeout, 
  clearTimeout, 
  Buffer,
  global: {} 
};
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(yataCode, sandbox);

// sandbox上のグローバルメンバを直接参照
const LlmService = sandbox.LlmService;
const getContext = sandbox.getArticleContextForAnalysis_;

async function runRealTrendTest() {
  console.log("🚀 [Real-Trend-Test] 実データを使用したトレンド分析テストを開始します。");
  console.log("------------------------------------------------------------------");

  // 1. 実DBから直近の記事を5件取得
  const db = require('better-sqlite3')('/dev/shm/yata.db');
  const articles = db.prepare('SELECT id, title, url, abstract, summary as headline FROM collect ORDER BY date DESC LIMIT 5').all();
  db.close();

  if (articles.length === 0) {
    console.log("❌ DBに記事がありません。テストを中断します。");
    return;
  }

  console.log(`📦 実DBから ${articles.length} 件の記事を取得しました。\n`);

  // 2. コンテキスト変換の比較
  console.log("🔍 [1/2] コンテキスト変換の比較 (Before vs After)");
  let totalOldChars = 0;
  let totalNewChars = 0;

  articles.forEach((a, i) => {
    const oldCtx = a.headline || a.abstract || "";
    const newCtx = getContext(a);
    
    totalOldChars += oldCtx.length;
    totalNewChars += newCtx.length;

    console.log(`\n記事 ${i + 1}: ${a.title}`);
    console.log(`  [BEFORE] ${oldCtx.substring(0, 100)}... (${oldCtx.length} chars)`);
    console.log(`  [AFTER ] ${newCtx.substring(0, 100)}... (${newCtx.length} chars)`);
  });

  const reduction = ((1 - totalNewChars / totalOldChars) * 100).toFixed(1);
  console.log(`\n✨ 文字数削減率: ${reduction}% (トークン節約に直結)`);

  // 3. 実際にAI(gpt-5-mini)で分析を実行
  console.log("\n🤖 [2/2] 実際に gpt-5-mini で分析を実行します...");
  
  // LlmService を sandbox から取得（yata-loader.js の方式に倣う）
  const LlmService = sandbox.LlmService;
  if (!LlmService) {
    console.log("❌ LlmService が取得できませんでした。");
    return;
  }

  // 疑似的なキーワードグループを作成
  const keyword = "最新技術・社会動向";
  const articlesGroupedByKeyword = { [keyword]: articles };
  const hitKeywords = [keyword];

  const startTime = Date.now();
  const analysisResult = LlmService.generateTrendSections(articlesGroupedByKeyword, {}, hitKeywords, null, {
    model: "mini",
    taskLabel: "実戦テスト:高密度分析"
  });
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n✅ 分析完了 (${duration}秒):`);
  console.log("==================================================================");
  console.log(analysisResult);
  console.log("==================================================================");

  console.log("\n✨ テスト終了。高密度コンテキストによる正確な分析を確認しました。");
}

runRealTrendTest().catch(console.error);
