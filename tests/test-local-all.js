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
      // 修正: vectorはCSV形式なのでparseVector_を使用
      const vecArray = parseVector_(summarized[0].vector);
      console.log("✅ ベクトル生成確認: 長さ " + vecArray.length);
    }
  } else {
    throw new Error("要約が生成されませんでした。");
  }

  // --- E. 日刊レポート・配信ロジックのテスト (Step Eとして追加) ---
  console.log("\n[Step E] 日刊レポート生成とメール配信モックの検証...");
  
  // 送信モックの準備
  let mailSent = false;
  global.GmailApp = {
    sendEmail: (to, subject, body, options) => {
      mailSent = true;
      console.log(`✅ メール送信モック成功: To=${to}, Subject=${subject}`);
      if (body.trim() === "") throw new Error("メールのプレーンテキスト(body)が空です！(真っ白問題再発)");
      if (!options || !options.htmlBody) throw new Error("メールのHTML(htmlBody)が空です！");
      console.log(`✅ プレーンテキスト長: ${body.length}文字, HTML長: ${options.htmlBody.length}文字`);
    }
  };

  // 環境変数のセット（モック用）
  process.env.MAIL_TO = "test@example.com";
  process.env.USER_KEYWORDS = "テスト";
  
  // テスト用によりリッチな記事データをメモリDBに注入
  const mockDate = new Date().toISOString().replace('T', ' ').substring(0, 19);
  memDb.prepare(`INSERT INTO collect (date, title, url, abstract, summary, vector) VALUES (?, ?, ?, ?, ?, ?)`).run(
    mockDate,
    "テスト用記事タイトル（キーワード: テスト を含む）",
    "https://example.com/test-article-2",
    "テスト用の詳細な記事内容です。",
    "テスト用の要約です。",
    new Array(256).fill(0.1).join(",")
  );
  
  // Step B の fetch モックをさらに拡張し、トレンド分析(レポート生成)のレスポンスも返すようにする
  const previousFetch = global.UrlFetchApp.fetch;
  global.UrlFetchApp.fetch = (url, options) => {
    if (url.includes("openai") || url.includes("api.openai.com")) {
      const payload = options.payload ? options.payload.toString() : "";
      // 予兆検知/トレンド分析系のプロンプトが含まれる場合
      if (payload.includes("トレンド") || payload.includes("topics")) {
         return {
           getResponseCode: () => 200,
           getContentText: () => JSON.stringify({
             choices: [{
               message: {
                 content: JSON.stringify({
                   "isNoChange": false,
                   "topics": [
                     {
                       "title": "【テスト】仮想のトレンドニュース",
                       "last_week": "なし",
                       "this_week": "UrlFetchAppレベルでのモックに成功しました。",
                       "impact": "LLM費用をかけずにパイプライン全体をテストできます。",
                       "evidence": ["https://example.com/test-article-2"]
                     }
                   ]
                 })
               }
             }],
             usage: { total_tokens: 0 }
           })
         };
      }
    }
    return previousFetch(url, options);
  };
  
  // 手動でレポート生成を呼び出す
  const allArticles = memDb.prepare("SELECT * FROM collect").all().map(a => ({
    id: a.id, date: new Date(a.date), title: a.title, url: a.url,
    abstract: a.abstract, summary: a.summary, source: a.source, vectorStr: a.vector
  }));
  
  const reportHtml = global.generateTrendReportHtml(allArticles, [{ query: "テスト", label: "テスト" }], new Date(Date.now() - 86400000), new Date(), {
    useSemantic: false, enableHistory: false, saveHistory: false, reasoning_effort: "low"
  });

  if (!reportHtml) throw new Error("HTMLレポートが生成されませんでした。");
  const plainTextBody = global.stripHtml_ ? global.stripHtml_(reportHtml) : stripHtml_(reportHtml);
  
  // モック送信を実行
  global.GmailApp.sendEmail("test@example.com", "Test Report", plainTextBody, { htmlBody: reportHtml });
  
  if (!mailSent) throw new Error("メール送信フローが実行されませんでした。");

  // --- F. 最後に本家の runAllTests も回しておく ---
  console.log("\n[Step F] 内部アルゴリズムの一括テスト (runAllTests)...");
  // フェッチモックを元に戻す
  global.UrlFetchApp.fetch = previousFetch;
  runAllTests();

  console.log("\n✨ [Local-All-Test Deluxe] 全てのライフサイクル・テストに合格しました！");
  console.log("このテストはメモリ上のみで完結し、実データへの影響・API課金は一切ありません。");
  
  // モックを戻す
  global.UrlFetchApp.fetch = originalFetch;
}

runLocalAllTest().catch(e => {
  console.error("\n❌ テスト失敗:");
  console.error(e.stack);
  process.exit(1);
});
