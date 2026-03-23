
/**
 * E2E Pipeline Test for Daily Trend
 * LLMのAPI呼び出しをモック化し、ロジック全体（DB抽出〜HTML生成〜メールプレーンテキスト生成）をテストします。
 */

const path = require('path');
const fs = require('fs');

// 1. 本番の環境変数を読み込むが、送信先は上書き
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true });
process.env.MAIL_TO = "test@example.com";
process.env.USER_KEYWORDS = "自作PC, AMD";

// 2. モックの設定
// (A) メールの送信をファイル出力にリダイレクト
global.GmailApp = {
  sendEmail: (to, subject, body, options) => {
    console.log(`\n📨 [Mock] メール送信を検知: To=${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   PlainText Length: ${body.length} chars`);
    console.log(`   HTML Length: ${options.htmlBody.length} chars`);
    
    // 出力結果を保存して後で確認できるようにする
    const output = {
      subject,
      body,
      htmlBody: options.htmlBody
    };
    fs.writeFileSync('test_e2e_output.json', JSON.stringify(output, null, 2));
    console.log(`   👉 結果を test_e2e_output.json に保存しました。`);
  }
};

// 3. YATA本体をローダー経由で読み込む
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

// 4. 強力な最下層モックの設定 (Loader読み込み後に上書き)
// (A) メールの送信をファイル出力にリダイレクト
global.GmailApp.sendEmail = (to, subject, body, options) => {
  console.log(`\n📨 [Mock] メール送信を検知: To=${to}`);
  console.log(`   Subject: ${subject}`);
  console.log(`   PlainText Length: ${body.length} chars`);
  console.log(`   HTML Length: ${options.htmlBody ? options.htmlBody.length : 0} chars`);
  
  const output = { subject, body, htmlBody: options.htmlBody };
  fs.writeFileSync('test_e2e_output.json', JSON.stringify(output, null, 2));
  console.log(`   👉 結果を test_e2e_output.json に保存しました。`);
};

// (B) LLM等の外部通信 (UrlFetchApp) を遮断してダミーレスポンスを返す
const originalFetch = global.UrlFetchApp.fetch;
global.UrlFetchApp.fetch = function(url, options) {
  if (url.includes("openai.azure.com") || url.includes("api.openai.com")) {
    console.log(`\n🧠 [Mock] LLM API通信を遮断しました: ${url}`);
    
    // YATAが期待する OpenAI/Azure 形式のダミーレスポンス
    const dummyLlmResponse = {
      choices: [{
        message: {
          content: JSON.stringify({
            "isNoChange": false,
            "topics": [
              {
                "title": "【完全モック】ローカルテスト環境での成功",
                "last_week": "なし",
                "this_week": "APIリクエストを一番底の層（UrlFetchApp）で遮断し、モックデータを返却しています。",
                "impact": "これにより、APIコストを一切かけずに、DB抽出からHTML/プレーンテキスト生成、メール送信までの全ロジックの貫通テストが可能になります。",
                "evidence": ["https://example.com/mock-test"]
              }
            ]
          })
        }
      }],
      usage: { total_tokens: 0 }
    };
    
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify(dummyLlmResponse)
    };
  }
  // その他の通信（Webhook等）はオリジナルを通すか、必要ならブロック
  return originalFetch(url, options);
};

async function testPipeline() {
  console.log("🚀 E2E Pipeline Test Start...");

  const keywords = (process.env.USER_KEYWORDS || "").split(',').map(k => k.trim());
  const mailTo = process.env.MAIL_TO;

  const Database = require('better-sqlite3');
  const dbPath = process.env.DB_PATH || path.join(__dirname, '../yata.db');
  const db = new Database(dbPath);

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayStr = yesterday.toISOString().replace('T', ' ').substring(0, 19);

  let allTargetArticles = [];
  const keywordConditions = keywords.map(k => `title LIKE '%${k}%' OR summary LIKE '%${k}%' OR abstract LIKE '%${k}%'`).join(" OR ");
  
  const articles = db.prepare(`SELECT * FROM collect WHERE date >= ? AND (${keywordConditions}) LIMIT 5`).all(yesterdayStr);
  
  articles.forEach(a => {
    allTargetArticles.push({
      id: a.id,
      date: new Date(a.date),
      title: a.title,
      url: a.url,
      abstract: a.abstract,
      summary: a.summary,
      source: a.source,
      vectorStr: a.vector
    });
  });

  if (allTargetArticles.length === 0) {
    console.log("❌ DBから記事が取得できませんでした（テスト続行不可）");
    return;
  }

  console.log(`✅ DBから記事を取得: ${allTargetArticles.length}件`);

  const targetItems = keywords.map(kw => ({ query: kw, label: kw }));

  console.log("⚙️ HTMLレポートの生成を開始します...");
  const reportHtml = global.generateTrendReportHtml(allTargetArticles, targetItems, yesterday, now, {
    useSemantic: false, // キャッシュテストは省く
    enableHistory: false, 
    saveHistory: false,
    dateRangeStr: `${global.fmtDate(yesterday)} 〜 ${global.fmtDate(now)}`,
    reasoning_effort: "low"
  });

  if (reportHtml) {
    console.log("✅ HTMLレポートの生成に成功");
    
    // 🔥 ここが真っ白問題の肝！stripHtml_ が正しく動くかテスト
    const plainTextBody = global.stripHtml_ ? global.stripHtml_(reportHtml) : stripHtml_(reportHtml);
    
    console.log(`✅ PlainTextへの変換に成功 (長さ: ${plainTextBody.length})`);
    
    // Mockの sendEmail を発火させる
    const subject = `【TEST】 ${keywords.join(", ")} (${global.fmtDate(now)})`;
    global.GmailApp.sendEmail(mailTo, subject, plainTextBody, { htmlBody: reportHtml });
    
  } else {
    console.log("❌ レポート生成が空を返しました。");
  }
}

testPipeline().catch(console.error);
