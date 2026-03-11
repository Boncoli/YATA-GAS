/**
 * tests/test-local-all.js
 * 
 * 【Local版 All Test】
 * - 物理DB(SDカード)への書き込みゼロ (:memory: DB使用)
 * - 外部API通信ゼロ (UrlFetchApp モック化)
 * - YATAの全ロジックチェーン (収集〜要約〜保存) の整合性を検証
 */

const Database = require('better-sqlite3');
const path = require('path');

// 1. 本物のDBを汚さないよう、メモリDBを先に作成してグローバルに置く
// gas-bridge.js がこれを見つけて優先的に使用するように設定
const memDb = new Database(':memory:');
global.YATA_DB = memDb;

// 2. ブリッジとローダーを読み込み
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

async function runLocalAllTest() {
  console.log("🚀 [Local-All-Test] 開始 (SDカードへの書き込みはありません)");

  // --- A. DB初期化チェック ---
  console.log("\n[Step A] データベース構造の検証...");
  const tables = memDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const tableNames = tables.map(t => t.name);
  if (tableNames.includes('collect') && tableNames.includes('log')) {
    console.log("✅ テーブル作成成功: " + tableNames.join(", "));
  } else {
    throw new Error("テーブルの作成に失敗しました。");
  }

  // --- B. API通信のモック化 (スタブ) ---
  console.log("\n[Step B] 外部通信のモック化...");
  const originalFetch = global.UrlFetchApp.fetch;
  global.UrlFetchApp.fetch = (url, options) => {
    // RSSフェッチの擬似レスポンス
    if (url.includes(".xml") || url.includes("rss")) {
      return {
        getResponseCode: () => 200,
        getContentText: () => `
          <rss version="2.0"><channel>
            <title>Test Feed</title>
            <item>
              <title>テスト記事1</title>
              <link>https://example.com/1</link>
              <description>これはテスト記事の内容です。</description>
              <pubDate>${new Date().toUTCString()}</pubDate>
            </item>
          </channel></rss>`
      };
    }
    // LLM (OpenAI/Gemini) の擬似レスポンス
    if (url.includes("openai") || url.includes("google") || url.includes("gemini")) {
      const payload = JSON.parse(options.payload);
      // Embedding (ベクトル生成) の場合
      if (url.includes("embeddings") || (payload.contents && url.includes("embedding"))) {
         return {
           getResponseCode: () => 200,
           getContentText: () => JSON.stringify({ data: [{ embedding: new Array(256).fill(0.1) }], embedding: { values: new Array(256).fill(0.1) } })
         };
      }
      // Chat (要約) の場合
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          choices: [{ message: { content: '{ "tldr": "擬似要約成功", "summary": "テスト成功ですわ" }' } }],
          candidates: [{ content: { parts: [{ text: '{ "tldr": "擬似要約成功", "summary": "テスト成功ですわ" }' }] } }]
        })
      };
    }
    return { getResponseCode: () => 404, getContentText: () => "Not Found" };
  };

  // --- C. 収集ロジックのテスト ---
  console.log("\n[Step C] 収集ロジック (runCollectionJob) のシミュレーション...");
  // テスト用にRSSリストを一時的に上書き
  const originalRss = global.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('rss_list');
  // runCollectionJob を実行
  runCollectionJob();
  
  const collectCount = memDb.prepare("SELECT COUNT(*) as count FROM collect").get().count;
  console.log(`✅ 収集完了: ${collectCount} 件の記事をメモリDBに保存しました。`);

  // --- D. 要約・ベクトル化ロジックのテスト (今回の修正箇所) ---
  console.log("\n[Step D] 要約・ベクトル化 (runSummarizationJob) の検証...");
  await runSummarizationJob();
  
  const summarized = memDb.prepare("SELECT title, summary, vector FROM collect WHERE summary IS NOT NULL").all();
  if (summarized.length > 0) {
    console.log(`✅ 要約完了: 「${summarized[0].title}」の要約「${summarized[0].summary}」を生成。`);
    if (summarized[0].vector) {
      // 修正: vectorはCSV形式なのでparseVectorを使用
      const vecArray = parseVector(summarized[0].vector);
      console.log("✅ ベクトル生成確認: 長さ " + vecArray.length);
    }
  } else {
    throw new Error("要約が生成されませんでした。");
  }

  // --- E. 最後に本家の runAllTests も回しておく ---
  console.log("\n[Step E] 内部アルゴリズムの一括テスト (runAllTests)...");
  runAllTests();

  console.log("\n✨ [Local-All-Test] 全てのテストに合格しました！");
  console.log("このテストはメモリ上のみで完結し、実データへの影響はありません。");
  
  // モックを戻す
  global.UrlFetchApp.fetch = originalFetch;
}

runLocalAllTest().catch(e => {
  console.error("\n❌ テスト失敗:");
  console.error(e.stack);
  process.exit(1);
});
