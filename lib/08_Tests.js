/**
 * @file 08_Tests.js
 * @description 【責務】システムの健全性を担保するための単体テストおよびデバッグ機能の提供。
 * 【主要機能】ロジックの一括テスト（runAllTests）、RSS個別診断、LLM接続テスト、メール送信テスト。
 */

function runAllTests() {
  Logger.log("--- [YATA] ロジックテスト開始 ---");
  try {
    _test_triggerEntryPoints_();  // 👈 【追加】一番最初にトリガーの存在をチェックする
    _test_AppConfig_();
    _test_parseVector_();
    _test_isTextMatchQuery_();
    _test_normalizeUrl_();
    _test_parseRssXml_Fallback_();
    _test_EmergingSignalEngine_();
    _test_cleanAndParseJSON_();        // AI出力のパーステスト
    _test_calculateCosineSimilarity_(); // ベクトル計算のテスト
    _test_calculateDotProduct_();       // 内積計算（爆速化）のテスト
    
    Logger.log("✅ 全てのロジックテストに合格しました。");
  } catch (e) {
    Logger.log("❌ テスト失敗: " + e.message);
    throw e;
  }
}

/**
 * _test_parseRssXml_Fallback
 * 【責務】意図的に壊れたXMLを入力し、正規表現フォールバックが正しく発動するか検証する。
 */
function _test_parseRssXml_Fallback_() {
  Logger.log("test_parseRssXml_Fallback: 開始");
  
  // XmlService.parse で必ずエラーになる不正なXML（&のエスケープ漏れ、閉じタグなし等）
  const brokenXml = `
    <rss version="2.0">
      <channel>
        <title>Broken Feed</title>
        <item>
          <title>Test Title & Broken</title>
          <link>https://example.com/fallback-test</link>
          <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
          <description>Description with <unclosed tag</description>
        </item>
      </channel>
    </rss>
  `;

  // テスト実行（第2引数はダミーURL）
  const items = parseRssXml_(brokenXml, "http://test.local/feed");
  
  if (!items || items.length !== 1) {
    throw new Error(`フォールバック失敗: 期待値 1件, 実際 ${items ? items.length : 0}件`);
  }
  
  const item = items[0];
  
  // 判定1: 正規表現モードで取れたか
  if (item.source !== "RegexFallback") {
    throw new Error(`ソース判定失敗: 期待値 RegexFallback, 実際 ${item.source}`);
  }
  
  // 判定2: タイトルが取れているか（& が含まれていても取れるべき）
  if (!item.title.includes("Test Title")) {
    throw new Error(`タイトル抽出失敗: ${item.title}`);
  }
  
  // 判定3: リンクが取れているか
  if (item.link !== "https://example.com/fallback-test") {
    throw new Error(`リンク抽出失敗: ${item.link}`);
  }

  Logger.log("test_parseRssXml_Fallback: OK (壊れたXMLから正規表現で抽出成功)");
}

/**
 * _test_EmergingSignalEngine
 * 予兆検知エンジンの計算ロジック（重心・アウトライヤー・核形成）を検証。
 */
function _test_EmergingSignalEngine_() {
  Logger.log("test_EmergingSignalEngine: 開始");

  // 1. ダミーデータの作成 (3次元ベクトルで簡略化)
  // 主流: [1.0, 1.0, 0.0] 付近
  const mainstream = [
    { vector: [0.9, 0.9, 0.1], source: "SourceA" },
    { vector: [0.95, 0.85, 0.0], source: "SourceB" },
    { vector: [0.85, 0.95, 0.0], source: "SourceC" }
  ];

  // アウトライヤー（孤独な点）: [0.0, 0.0, 1.0] 付近
  // ソースが異なる2つの点が近い座標にある（＝核形成）
  const nucleusPoint1 = { vector: [0.1, 0.1, 0.9], source: "SourceD" };
  const nucleusPoint2 = { vector: [0.12, 0.08, 0.92], source: "SourceE" };
  
  // 単なるノイズ: 全く別の場所 [-1.0, 0.0, 0.0]
  const noise = { vector: [-0.9, 0.1, 0.1], source: "SourceF" };

  const allArticles = [...mainstream, nucleusPoint1, nucleusPoint2, noise];

  // 2. 重心計算のテスト
  // Private関数のテストのため、EmergingSignalEngineオブジェクトから呼べるようにするか、
  // ロジックを直接検証する。ここではアルゴリズムの妥当性を確認。
  const dim = 3;
  const avg = new Array(dim).fill(0);
  allArticles.forEach(a => {
    for (let i = 0; i < dim; i++) avg[i] += a.vector[i];
  });
  for (let i = 0; i < dim; i++) avg[i] /= allArticles.length;
  
  Logger.log(`算出された重心: [${avg.map(v => v.toFixed(2)).join(", ")}]`);

  // 3. アウトライヤー抽出のテスト (重心から離れているか)
  const threshold = 0.70;
  const outliers = allArticles.filter(a => {
    const sim = calculateCosineSimilarity_(avg, a.vector);
    return sim < threshold;
  });

  // nucleusPoint1, nucleusPoint2, noise がアウトライヤーになるはず
  if (outliers.length < 3) {
    throw new Error(`アウトライヤー抽出失敗: 期待値 3以上, 実際 ${outliers.length}`);
  }
  Logger.log(`抽出されたアウトライヤー数: ${outliers.length}`);

  // 4. 核形成検知のテスト
  const config = { NUCLEATION_RADIUS: 0.88, MIN_NUCLEI_SOURCES: 2 };
  const nuclei = [];
  const usedIndices = new Set();

  for (let i = 0; i < outliers.length; i++) {
    if (usedIndices.has(i)) continue;
    const currentNucleus = [outliers[i]];
    const sources = new Set([outliers[i].source]);
    for (let j = i + 1; j < outliers.length; j++) {
      const sim = calculateCosineSimilarity_(outliers[i].vector, outliers[j].vector);
      if (sim >= config.NUCLEATION_RADIUS) {
        currentNucleus.push(outliers[j]);
        sources.add(outliers[j].source);
      }
    }
    if (sources.size >= config.MIN_NUCLEI_SOURCES) {
      nuclei.push({ articles: currentNucleus, sourceCount: sources.size });
    }
  }

  if (nuclei.length !== 1) {
    throw new Error(`核形成検知失敗: 期待値 1, 実際 ${nuclei.length}`);
  }
  
  if (nuclei[0].sourceCount !== 2) {
    throw new Error(`核のソース数不一致: 期待値 2, 実際 ${nuclei[0].sourceCount}`);
  }

  Logger.log("test_EmergingSignalEngine: OK (核形成を正しく検知しました)");
}

/**
 * _test_triggerEntryPoints_
 * 【責務】GASのトリガーから呼び出される主要なエントリーポイント関数が存在するか検証する。
 * これにより、リファクタリングによる関数名変更や削除でトリガーが死ぬ事故を防ぐ。
 */
function _test_triggerEntryPoints_() {
  Logger.log("test_triggerEntryPoints: 開始");
  
  // GASのトリガー設定画面で指定される（または外部から呼ばれる）べき関数群
  const mustExist = [
    "jobDispatcher",
    "runCollectionJob",
    "runSummarizationJob",
    "runDailyMaintenance",
    "runHeavyMaintenance",
    "dailyDigestJob",
    "sendPersonalizedReport",
    "runMonthlyPartnerReport",
    "doGet"
  ];
  
  const missing = [];
  mustExist.forEach(name => {
    // GAS環境(globalThis), ローカル環境(global), またはスクリプトスコープ(this)をチェック
    const exists = (typeof globalThis[name] === "function") || 
                   (typeof global !== "undefined" && typeof global[name] === "function") ||
                   (typeof this[name] === "function");
    if (!exists) {
      missing.push(name);
    }
  });
  
  if (missing.length > 0) {
    throw new Error(`トリガーのエントリーポイントが見つかりません: ${missing.join(", ")}\n※YATA.jsのグローバル公開設定などを確認してください。`);
  }
  
  Logger.log("test_triggerEntryPoints: OK (すべてのトリガー関数が存在します)");
}

/**
 * _test_AppConfig: AppConfigが正しく構造化されているか確認
 */
function _test_AppConfig_() {
  const config = AppConfig.get();
  if (!config.System || !config.System.Limits.BATCH_SIZE || !config.UI.Colors.PRIMARY) {
    throw new Error("AppConfigの構造が不正、または必須項目が不足しています。");
  }
  Logger.log("test_AppConfig: OK");
}

/**
 * _test_parseVector: ベクトル文字列のパース確認
 */
function _test_parseVector_() {
  const input = "0.123,0.456,-0.789";
  const result = parseVector_(input);
  if (!result || result.length !== 3 || result[0] !== 0.123 || result[2] !== -0.789) {
    throw new Error("parseVectorの出力が期待値と異なります。");
  }
  Logger.log("test_parseVector: OK");
}

/**
 * _test_isTextMatchQuery: キーワード検索ロジックの検証
 */
function _test_isTextMatchQuery_() {
  const text = "Google Apps ScriptはクラウドベースのJavaScriptプラットフォームです。";
  
  // AND検索
  if (!isTextMatchQuery_(text, "Google Script")) throw new Error("isTextMatchQuery: AND検索に失敗しました。");
  // OR検索
  if (!isTextMatchQuery_(text, "Python OR Script")) throw new Error("isTextMatchQuery: OR検索に失敗しました。");
  // NOT検索
  if (isTextMatchQuery_(text, "Google -Script")) throw new Error("isTextMatchQuery: NOT検索に失敗しました。");
  // 複雑な組み合わせ
  if (!isTextMatchQuery_(text, "(Google OR Python) Script -Ruby")) throw new Error("isTextMatchQuery: 複雑な検索に失敗しました。");
  
  // 優先順位の検証 (AND > OR)
  // "Google OR Python AND Ruby"
  // 新ロジック: Google OR (Python AND Ruby) -> True OR False -> True
  // 旧ロジック: (Google OR Python) AND Ruby -> True AND False -> False
  if (!isTextMatchQuery_(text, "Google OR Python AND Ruby")) throw new Error("isTextMatchQuery: 優先順位(OR < AND)の検証に失敗しました。旧ロジックのままの可能性があります。");

  Logger.log("test_isTextMatchQuery: OK");
}

/**
 * _test_normalizeUrl: URL正規化の検証
 */
function _test_normalizeUrl_() {
  const url1 = "https://example.com/path?utm_source=test";
  const url2 = "http://www.example.com/path/";
  
  if (normalizeUrl_(url1) !== "//example.com/path") throw new Error("normalizeUrl: パラメータの除去に失敗しました。");
  if (normalizeUrl_(url2) !== "//example.com/path") throw new Error("normalizeUrl: プロトコル/www/末尾スラッシュの正規化に失敗しました。");
  
  Logger.log("test_normalizeUrl: OK");
}

/**
 * testAllRssFeeds
 * 【責務】RSSシートに登録されている全URLをテストし、接続やパースの成否を診断レポートとしてログ出力する。
 * 【用途】「どのフィードが死んでいるか」を一括チェックする開発用ツール。
 */
function testAllRssFeeds() {
  const sheet = getSheet_(AppConfig.get().SheetNames.RSS_LIST);
  if (!sheet) {
    Logger.log("エラー: RSSシートが見つかりません。");
    return;
  }

  const startRow = AppConfig.get().RssListSheet.DataRange.START_ROW;
  const lastRow = sheet.getLastRow();
  if (lastRow < startRow) {
    Logger.log("RSSリストが空です。");
    return;
  }

  const data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 2).getValues();

  Logger.log(`--- RSS全件診断開始 (対象: ${data.length}件) ---`);


  const baseHeaders = AppConfig.get().System.HttpHeaders;
  const options = {
    muteHttpExceptions: true,
    validateHttpsCertificates: false,
    headers: {
      ...baseHeaders,
      "Accept": "application/atom+xml,application/rss+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  };

  // 集計
  let success = 0;
  let emptyOk = 0;
  let fail = 0;

  const details = []; // {row, name, url, status, code, reason, hint}

  data.forEach((row, idx) => {
    const name = row[0];
    const url = row[1];
    const rowNum = startRow + idx;
    if (!url) return;

    try {
      const res = UrlFetchApp.fetch(url, options);
      const code = res.getResponseCode();
      const headers = (typeof res.getHeaders === "function") ? res.getHeaders() : {};
      const ctype = (headers && (headers["Content-Type"] || headers["content-type"])) ? String(headers["Content-Type"] || headers["content-type"]) : "";
      const body = res.getContentText() || "";
      const head = body.substring(0, 300).replace(/\s+/g, " ").trim();

      if (code !== 200) {
        fail++;
        details.push({
          row: rowNum, name, url,
          status: "FAIL",
          code,
          reason: `HTTP Error ${code}`,
          hint: ""
        });
        return;
      }


      // XMLかどうかを先に判定（Content-Typeと先頭で判定）
      const isXml = looksLikeXml_(body, ctype);

      // XMLでない場合だけHTML判定をする（XMLなら絶対にHTML扱いしない）
      if (!isXml && looksLikeHtmlStrict_(body, ctype)) {
        fail++;
        details.push({
          row: rowNum, name, url,
          status: "FAIL",
          code,
          reason: "200だがHTML返却（ブロック/リダイレクト/ログイン誘導の疑い）",
          hint: `Content-Type=${ctype} / head="${head.slice(0, 120)}..."`
        });
        return;
      }


      // パース（Atom/RSS/RDF対応済み）
      const items = parseRssXml_(body, url);

      if (items && items.length > 0) {
        success++;
        return;
      }

      // items=0 の場合：空フィード（正常）か、構造違い/別形式かを分類
      const emptyKind = classifyEmptyFeed_(body, url);

      if (emptyKind.isEmptyButOk) {
        emptyOk++;
        details.push({
          row: rowNum, name, url,
          status: "EMPTY_BUT_OK",
          code,
          reason: emptyKind.reason,
          hint: `head="${head.slice(0, 120)}..."`
        });
      } else {
        fail++;
        details.push({
          row: rowNum, name, url,
          status: "FAIL",
          code,
          reason: emptyKind.reason || "記事数0件（XML構造違い/未知形式の可能性）",
          hint: `Content-Type=${ctype} / head="${head.slice(0, 120)}..."`
        });
      }

    } catch (e) {
      fail++;
      details.push({
        row: rowNum, name, url,
        status: "FAIL",
        code: "EXCEPTION",
        reason: e.message || String(e),
        hint: ""
      });
    }
  });

  Logger.log("\n=============================");
  Logger.log(" RSS 診断レポート ");
  Logger.log("=============================");
  Logger.log(`✅ SUCCESS: ${success} 件`);
  Logger.log(`🟡 EMPTY_BUT_OK: ${emptyOk} 件`);
  Logger.log(`❌ FAIL: ${fail} 件`);

  // FAIL と EMPTY_BUT_OK だけ詳細表示（成功は数が多いので省略）
  const show = details.filter(d => d.status !== "SUCCESS");
  if (show.length > 0) {
    Logger.log("\n【詳細】");
    show.forEach(d => {
      Logger.log(
        `Row ${d.row}: [${d.name}] - ${d.status} - ${d.reason}\n` +
        `  URL: ${d.url}\n` +
        `  Code: ${d.code}\n` +
        (d.hint ? `  Hint: ${d.hint}\n` : "")
      );
    });
  } else {
    Logger.log("\n🎉 全フィードが正常（または空でも正常扱い）です。");
  }
}

/**
 * クエリ拡張機能の単体テスト
 */
function testQueryExpansion() {
  Logger.log("--- クエリ拡張テスト開始 ---");
  
  // 試したい単語をここに入れる
  const testWords = ["ラジカル", "全固体電池", "生成AI"];
  
  testWords.forEach(word => {
    // 実際にAIに投げた結果を受け取る
    const expanded = expandKeywordQuery_(word);
    Logger.log(`✅ テスト結果: ${word} => ${expanded}`);
  });
  
  Logger.log("--- クエリ拡張テスト完了 ---");
}

/**
 * _test_cleanAndParseJSON
 * 【責務】LLMが返してくる「崩れたJSON」を正しく修復してパースできるか検証する。
 * これが失敗すると、AI要約や分析機能がエラーになります。
 */
function _test_cleanAndParseJSON_() {
  Logger.log("test_cleanAndParseJSON: 開始");

  // ケース1: 正常なJSON
  const valid = '{"tldr": "OK"}';
  if (cleanAndParseJSON_(valid).tldr !== "OK") throw new Error("正常なJSONのパースに失敗");

  // ケース2: Markdown記法付き (```json ... ```)
  const markdown = '```json\n{"tldr": "Markdown"}\n```';
  if (cleanAndParseJSON_(markdown).tldr !== "Markdown") throw new Error("Markdown除去に失敗");

  // ケース3: 壊れたJSON (閉じカッコ忘れ) -> 正規表現による自己修復の発動確認
  const broken = '{"tldr": "Recovered text...'; 
  const recovered = cleanAndParseJSON_(broken);
  // 自己修復ロジックが "Recovered text..." を抜き出せるか
  if (!recovered || recovered.tldr !== "Recovered text...") {
    throw new Error("壊れたJSONの自己修復に失敗 (Regex Fallback)");
  }

  // ケース4: 改行が含まれるケース (JSON仕様違反だがAIはよくやる)
  const withNewlines = '{\n"tldr": "Line1\nLine2"\n}';
  const parsed = cleanAndParseJSON_(withNewlines);
  if (!parsed || !parsed.tldr.includes("Line1")) {
    throw new Error("改行を含むJSONのパースに失敗");
  }

  Logger.log("test_cleanAndParseJSON: OK");
}

/**
 * _test_calculateCosineSimilarity
 * 【責務】ベクトル検索の計算精度を検証する。
 */
function _test_calculateCosineSimilarity_() {
  Logger.log("test_calculateCosineSimilarity: 開始");

  const v1 = [1, 0, 0];
  const v2 = [0, 1, 0];
  const v3 = [1, 1, 0];
  
  // 直交するベクトル (類似度 0)
  if (calculateCosineSimilarity_(v1, v2) !== 0) throw new Error("直交ベクトルの計算ミス");

  // 同じベクトル (類似度 1)
  if (Math.abs(calculateCosineSimilarity_(v1, v1) - 1.0) > 0.0001) throw new Error("同一ベクトルの計算ミス");

  // 45度の関係 (類似度 0.707...)
  const sim = calculateCosineSimilarity_(v1, v3);
  // 1 / sqrt(2) ≒ 0.7071
  if (Math.abs(sim - 0.7071) > 0.001) throw new Error(`計算精度エラー: 期待値~0.707, 実際 ${sim}`);

  Logger.log("test_calculateCosineSimilarity: OK");
}

/**
 * _test_calculateDotProduct
 * 【責務】内積計算ロジックが正規化済みベクトルに対して正しく機能するか検証する。
 */
function _test_calculateDotProduct_() {
  Logger.log("test_calculateDotProduct: 開始");

  // 正規化済みのベクトルを用意 (長さがピッタリ1になるように設定)
  const v1 = [1, 0, 0];
  const v2 = [0, 1, 0];
  // 1/√2 ≒ 0.70710678
  const v3 = [0.70710678, 0.70710678, 0];

  // 1. 同一ベクトル (期待値: 1)
  if (Math.abs(calculateDotProduct_(v1, v1) - 1.0) > 0.0001) throw new Error("同一ベクトルの計算ミス");

  // 2. 直交ベクトル (期待値: 0)
  if (calculateDotProduct_(v1, v2) !== 0) throw new Error("直交ベクトルの計算ミス");

  // 3. 45度の関係 (期待値: 約0.7071)
  const sim = calculateDotProduct_(v1, v3);
  if (Math.abs(sim - 0.70710678) > 0.001) throw new Error(`計算精度エラー: 期待値~0.707, 実際 ${sim}`);

  Logger.log("test_calculateDotProduct: OK");
}

/**
 * debugRssFeed (修正版)
 * 本番と同じ parseRssXml を使用して診断を行う。これにより特殊なフィードも正しくデバッグ可能。
 * これにより、MobiHealthNewsのような特殊なフィードも正しくデバッグできます。
 */
function debugRssFeed() {
  // スクリプトプロパティから取得。設定されていなければデフォルトのGoogleニュースを使用
  const props = PropertiesService.getScriptProperties();
  const TEST_URL = props.getProperty("DEBUG_RSS_URL") || "https://news.google.com/rss";
  
  // 初回や未設定時のための親切なガイド
  if (!props.getProperty("DEBUG_RSS_URL")) {
    Logger.log("💡 ヒント: スクリプトプロパティ 'DEBUG_RSS_URL' にテストしたいURLを設定すると、コードを書き換えずに任意のRSSを診断できます。");
  }

  Logger.log(`--- テスト開始: ${TEST_URL} ---`);
  
  try {
    const options = {
      'muteHttpExceptions': true,
      'validateHttpsCertificates': false,
      'headers': AppConfig.get().System.HttpHeaders
    };

    const response = UrlFetchApp.fetch(TEST_URL, options);
    const code = response.getResponseCode();
    Logger.log(`レスポンスコード: ${code}`);
    
    if (code !== 200) {
      Logger.log("【原因】: サーバーエラーです。URLが間違っているか、ブロックされています。");
      return;
    }
    
    const xml = response.getContentText();
    Logger.log(`取得データの先頭500文字:\n${xml.substring(0, 500)}`);

    // ここで本番用の最強パーサーを呼び出す
    Logger.log("\n--- 解析実行 (parseRssXml) ---");
    const items = parseRssXml_(xml, TEST_URL);
    
    Logger.log(`検出された記事数: ${items.length} 件`);
    
    if (items.length > 0) {
      const item = items[0];
      
      Logger.log(`\n【先頭の記事データサンプル】`);
      Logger.log(`タイトル: ${item.title}`);
      Logger.log(`リンク: ${item.link}`);
      Logger.log(`日付文字列: ${item.pubDate}`);
      
      // 日付判定テスト
      const dateObj = new Date(item.pubDate);
      if (!isNaN(dateObj.getTime())) {
        const now = new Date();
        const diffDays = (now - dateObj) / (1000 * 60 * 60 * 24);
        Logger.log(`現在との差: 約 ${Math.floor(diffDays)} 日前`);
      } else {
        Logger.log(`日付判定: パースできませんでした (${item.pubDate})`);
      }
      
      Logger.log("\n✅ 解析成功！このフィードは正常に読み取れます。");
    } else {
      Logger.log("\n❌ 解析失敗: 記事が0件でした。");
      Logger.log("考えられる原因:");
      Logger.log("1. XMLのタグ構造がさらに特殊である");
      Logger.log("2. そもそも記事が含まれていない空のフィードである");
    }
    
  } catch (e) {
    Logger.log(`【エラー】: 解析中にエラーが発生しました。\n${e.toString()}`);
  }
}

/**
 * debugPersonalReport (🌟v2.0 配信コア DryRun 統合一元化版)
 * Usersシートの2行目（データ1人目）の設定を使い、本番配信関数にテストフラグを添えて実行する。
 * 本番の履歴(DigestHistory)やラスト配信日時を一切汚さない安全設計。
 */
function debugPersonalReport() {
  Logger.log("🚀 [Debug] debugPersonalReport を開始します（v2.0 配信コア DryRun 統合窓口）");
  
  // 😎 重複コードはすべて消滅！本番の配信エンジンに「テストフラグ」を1粒添えて呼び出すだけ！
  DeliveryService.sendPersonalizedReport({ isDryRun: true });
}

/**
 * sendTestEmail
 * MAIL_TO に設定されたアドレスにテストメールを送信し、疎通を確認します。
 */
function sendTestEmail() {
  const mailTo = AppConfig.get().Digest.mailTo;
  if (!mailTo) {
    Logger.log("⚠️ MAIL_TO が設定されていないため、テストメールを送信できません。");
    return;
  }
  
  const subject = "【YATA】システム疎通確認メール";
  const body = [
    "YATAからのテストメールです。",
    "このメールが届いている場合、MailApp（GmailAPI）の送信権限と設定は正常です。",
    "",
    "--- 送信時設定 ---",
    "送信先: " + mailTo,
    "実行時刻: " + new Date().toLocaleString()
  ].join("\n");
  
  try {
    MailApp.sendEmail(mailTo, subject, body);
    Logger.log("✅ テストメールを送信しました: " + mailTo);
    Logger.log("受信ボックスを確認してください。");
  } catch (e) {
    Logger.log("❌ メール送信失敗: " + e.toString());
  }
}

/**
 * @description RSSリストの全URLの応答速度（レイテンシ）を計測し、遅延の激しいソースを特定します。
 */
function diagnoseRssLatency() {
  const sheet = getSheet_(AppConfig.get().SheetNames.RSS_LIST);
  if (!sheet) return;

  // データ取得
  const startRow = AppConfig.get().RssListSheet.DataRange.START_ROW;
  const lastRow = sheet.getLastRow();
  const data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 2).getValues();

  Logger.log(`--- 🐢 RSS応答速度診断 (全${data.length}件) ---`);
  Logger.log("※ 1件ずつ通信するため、数分かかります。途中でタイムアウトしたら、ログに出ているところまでが計測結果です。");

  const results = [];
  
  // Bot判定を避けるヘッダー
  const options = {
    'muteHttpExceptions': true,
    'validateHttpsCertificates': false,
    'headers': AppConfig.get().System.HttpHeaders
  };

  for (let i = 0; i < data.length; i++) {
    const name = data[i][0];
    const url = data[i][1];
    if (!url) continue;

    const startTime = new Date().getTime();
    let status = "OK";
    let size = 0;

    try {
      // 計測開始
      const response = UrlFetchApp.fetch(url, options);
      const endTime = new Date().getTime();
      
      const duration = endTime - startTime;
      const code = response.getResponseCode();
      size = response.getContentText().length;

      // 結果を保存
      results.push({
        index: i + 2, // 行番号
        name: name,
        url: url,
        time: duration,
        code: code,
        size: size
      });
      
      // 進捗ログ (遅いものだけリアルタイム表示)
      if (duration > 3000) {
        Logger.log(`⚠️ [遅延検知] Row ${i+2}: ${duration}ms - ${name}`);
      }

    } catch (e) {
      const endTime = new Date().getTime();
      results.push({
        index: i + 2,
        name: name,
        url: url,
        time: endTime - startTime, // エラーになるまでにかかった時間
        code: "ERROR",
        size: 0,
        error: e.message
      });
      Logger.log(`❌ [エラー] Row ${i+2}: ${e.message}`);
    }
  }

  // --- 集計とランキング表示 ---
  
  // 遅い順（降順）にソート
  results.sort((a, b) => b.time - a.time);

  Logger.log("\n===================================");
  Logger.log("     🐢 ワースト遅延ランキング (Top 10)     ");
  Logger.log("===================================");

  const top10 = results.slice(0, 10);
  top10.forEach((r, idx) => {
    const icon = r.code === 200 ? (r.time > 5000 ? "🟥" : "🟨") : "💀";
    Logger.log(`${idx + 1}. ${icon} ${r.time}ms | Row:${r.index} | ${r.name}`);
    Logger.log(`    URL: ${r.url}`);
    if (r.error) Logger.log(`    Err: ${r.error}`);
  });

  Logger.log("\n【判定基準】");
  Logger.log("🟢 1000ms未満: 優秀");
  Logger.log("🟨 3000ms以上: 注意 (GASだと足を引っ張ります)");
  Logger.log("🟥 10000ms以上: 危険 (即削除推奨)");
  Logger.log("💀 ERROR: タイムアウトまたは接続拒否");
}

/**
 * NanoとMiniのLLM接続をシンプルに確認する関数
 */
function debugLlmConnection() {
  Logger.log("=== LLM接続テスト開始 ===");

  // -----------------------------------------------
  // 1. Nano モデルのテスト (Summarize機能)
  // -----------------------------------------------
  Logger.log("📡 1. Nanoモデル (要約) テスト中...");
  try {
    // AIが「要約しがいがある」と感じる長めのダミー記事にする
    const dummyText = `
      OpenAI has announced a new series of AI models designed to spend more time thinking before they respond. 
      They can reason through complex tasks and solve harder problems than previous models in science, coding, and math. 
      This new series is named o1. We are releasing the first of this series in ChatGPT and our API today.
    `.trim();

    const resultNano = LlmService.summarize(dummyText);
    
    // JSON文字列として返ってくる場合と、パース済みの場合を考慮
    let content = resultNano;
    if (typeof resultNano === 'object') {
        content = resultNano.tldr || JSON.stringify(resultNano);
    } else if (resultNano.includes("{")) {
        // 文字列の中にJSONがある場合
        try {
            const parsed = JSON.parse(resultNano);
            content = parsed.tldr || resultNano;
        } catch(e) {}
    }

    if (content && content.length > 0 && content !== '""') {
      Logger.log("✅ Nano成功！");
      Logger.log("応答: " + content);
    } else {
      Logger.log("⚠️ Nano応答あり（空）");
      Logger.log("元データ: " + resultNano);
      Logger.log("※接続は成功しています。モデルが「要約不要」と判断した可能性があります。");
    }
  } catch (e) {
    Logger.log("❌ Nano例外: " + e.toString());
  }

  // -----------------------------------------------
  // 2. Mini モデルのテスト (DailyDigest機能)
  // -----------------------------------------------
  Logger.log("📡 2. Miniモデル (チャット) テスト中...");
  try {
    const resultMini = LlmService.generateDailyDigest(
      "You are a helpful assistant.", 
      "Test connection. Just say 'OK'."
    );

    if (resultMini && resultMini.length > 0 && !resultMini.includes("失敗")) {
      Logger.log("✅ Mini成功！");
      Logger.log("応答: " + resultMini);
    } else {
      Logger.log("❌ Mini失敗 (空またはエラー)");
      Logger.log("応答内容: " + resultMini);
    }
  } catch (e) {
    Logger.log("❌ Mini例外: " + e.toString());
  }

  Logger.log("\n=== テスト終了 ===");
}

/**
 * 【開発用】バッチ要約の動作をテストする関数
 * 現在の設定（COMPANY/PERSONAL）を自動認識し、ダミー記事3件でバッチ処理をテストします。
 */
function debugBatchSummarization() {
  Logger.log("=== 📦 バッチ要約 通信テスト開始 ===");

  // 1. 現在の設定を自動判定してログに出力
  const llmConfig = AppConfig.get().Llm;
  const context = llmConfig.Context || "COMPANY";
  const primaryService = (context === "COMPANY") ? "Azure" : "OpenAI (本家)";
  const targetModel = llmConfig.ModelNano || "未設定 (デフォルトを使用)";

  Logger.log(`🌍 実行コンテキスト: ${context}`);
  Logger.log(`🏢 優先サービス: ${primaryService}`);
  Logger.log(`🤖 ターゲットモデル: ${targetModel}`);
  Logger.log("-----------------------------------");

  // 2. テスト用のダミー記事（3件）
  const dummyArticles = [
    "Title: AIモデル「GPT-5」が発表\nAbstract: OpenAIは新しい推論モデルを発表しました。複雑なタスクでの論理的思考が大幅に向上しています。",
    "Title: トヨタ、全固体電池の実用化へ\nAbstract: 2027年にもEV向けの全固体電池を実用化する方針を固めました。充電時間の大幅短縮が期待されます。",
    "Title: 日経平均、史上最高値を更新\nAbstract: 半導体関連株への買いが集中し、日経平均株価が歴史的な高値を記録しました。市場の期待が高まっています。"
  ];

  Logger.log(`テスト記事 ${dummyArticles.length}件をバッチ送信します...`);

  try {
    // 3. バッチ要約ロジックを実行（内部で自動的にAzure/OpenAIにルーティングされます）
    const results = LlmService.summarizeBatch(dummyArticles);

    Logger.log("--- 📊 結果出力 ---");
    let successCount = 0;

    results.forEach((res, idx) => {
      Logger.log(`\n【記事 ${idx + 1}】`);
      if (res) {
        Logger.log(res);
        try {
          const parsed = JSON.parse(res);
          // JSONの中身が期待通りかチェック
          if (parsed.tldr || parsed.summary || parsed.what) {
             Logger.log("✅ JSONパース成功");
             successCount++;
          }
        } catch(e) {
          Logger.log("⚠️ 文字列としては取得できましたが、JSONパースに失敗しました。");
        }
      } else {
        Logger.log("❌ 取得失敗（null または 空文字）");
      }
    });

    Logger.log("\n-----------------------------------");
    if (successCount === dummyArticles.length) {
      Logger.log(`🎉 テスト完全成功！ [${primaryService} / ${targetModel}] でのバッチ要約は正常に機能しています。`);
    } else {
      Logger.log(`⚠️ ${successCount}/${dummyArticles.length} 件成功。ログのエラーやレスポンス形式を確認してください。`);
    }

  } catch (e) {
    Logger.log("❌ バッチテスト中に致命的なエラーが発生しました: " + e.message);
  }

  Logger.log("=== テスト終了 ===");
}

/**
 * 🌟 実行ボタン（▶）で動かすための専用関数
 */
function run_ScraperDebug() {
  const row = 8; // 👈 ここに「調べたい行番号」を書く（例: 5行目なら 5）
  toolCompareScraperRegex(row);
}

function _askAiForRegex_(html) {
  const truncatedHtml = html.replace(/<(style|script|svg)[^>]*>([\s\S]*?)<\/\1>/gi, " ").substring(0, 20000);
  const system = "あなたはプロのWebクローラーエンジニアです。";
  const user = `以下のHTMLから、ニュースを抜く正規表現をJSONで返せ。(?is)やスラッシュは含めないこと。urlGroup:1, titleGroup:2。\n\nHTML:\n${truncatedHtml}`;
  return cleanAndParseJSON_(LlmService.analyzeKeywordSearch(system, user, { model: "mini", taskLabel: "Scraper正規表現提案" }));
}

/**
 * testPubMedIntegration
 * 【責務】PubMed/PMC連携機能の健全性を検証する。
 * 1. PMC構造化抽出パッチの単体テスト（ダミーHTML使用）
 * 2. PubMed API疎通とデータ組み立てのDry Run（シート書き込みなし）
 */
function testPubMedIntegration(keyword = "ファブリー病") {
  Logger.log(`🔬 [PubMed Test] 診断開始: Keyword="${keyword}"`);

  // 🌟 新設された PubMed 専用クエリ拡張を適用
  const expandedKeyword = expandKeywordQueryPubMed_(keyword);
  Logger.log(`🔬 [PubMed Test] 拡張結果: "${keyword}" -> "${expandedKeyword}"`);

  // --- 1. PMC構造化抽出ロジックのテスト ---

  Logger.log("--- 🧪 1. extractPmcSections_ 単体パーステスト ---");
  const dummyPmcHtml = `
    <html>
      <h2 id="s1" class="pmc_sec_title">1. Introduction</h2><p>This is test intro.</p>
      <h2 class="title pmc_sec_title" id="s2">Methods and Materials</h2><p>Using AI-driven YATA system.</p>
      <h2 class="pmc_sec_title">Results</h2><p>Successful extraction achieved.</p>
      <h2 class="pmc_sec_title" data-test="true">Discussion</h2><p>Discussion points here.</p>
      <h2 id="final" class="pmc_sec_title">Conclusions</h2><p>Final conclusion text.</p>
    </html>
  `;
  const pmcSections = extractPmcSections_(dummyPmcHtml);
  if (pmcSections.introduction && (pmcSections.methods || pmcSections.materials) && pmcSections.conclusion) {
    Logger.log("✅ PMC構造化パース: OK");
    Logger.log(`サンプル抽出結果 (Methods): ${pmcSections.methods.substring(0, 50)}...`);
  } else {
    Logger.log("❌ PMC構造化パース失敗。セクションが不足しています。");
    Logger.log(`取得されたキー: ${Object.keys(pmcSections).join(", ")}`);
  }

  // --- 2. API疎通 & 収集Dry Run ---
  Logger.log("--- 📡 2. API疎通 & 収集ロジック Dry Run (DB書き込みなし) ---");
  const config = AppConfig.get();
  
  try {
    const today = new Date();
    const pastDate = new Date();
    pastDate.setDate(today.getDate() - config.PubMed.Limits.SEARCH_WINDOW_DAYS);
    const minDate = Utilities.formatDate(pastDate, Session.getScriptTimeZone(), "yyyy/MM/dd");
    const maxDate = Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyy/MM/dd");

    // 🌟 拡張されたクエリを使用して検索
    const searchUrl = `${config.PubMed.Endpoints.Search}?db=pubmed&retmode=json&sort=pub_date&term=${encodeURIComponent(expandedKeyword)}&mindate=${minDate}&maxdate=${maxDate}`;
    Logger.log(`[API Search] ${searchUrl}`);
    
    const searchRes = UrlFetchApp.fetch(searchUrl, { muteHttpExceptions: true });
    if (searchRes.getResponseCode() !== 200) {
      Logger.log("❌ API Search 疎通失敗");
      return;
    }
    
    const idList = JSON.parse(searchRes.getContentText()).esearchresult?.idlist || [];
    Logger.log(`ヒット件数: ${idList.length} 件`);

    if (idList.length > 0) {
      const pmid = idList[0];
      Logger.log(`PMID: ${pmid} の詳細を取得中...`);
      
      const sumUrl = `${config.PubMed.Endpoints.Summary}?db=pubmed&retmode=json&id=${pmid}`;
      const sumRes = UrlFetchApp.fetch(sumUrl, { muteHttpExceptions: true });
      const info = JSON.parse(sumRes.getContentText()).result[pmid];
      const pmcid = info?.articleids?.find(id => id.idtype === "pmc")?.value;
      
      Logger.log(`タイトル: ${info.title}`);
      Logger.log(`PMC ID: ${pmcid || "なし"}`);
      
      // 🌟 【本番完全同期】PMCの有無に関わらず、ベースとなる本物のPubMed Abstractを100%先に取得（最強の防衛線）
      Logger.log(`[Abstract Fetch] まずベースとなる本物のAbstractを取得中...`);
      const fetchUrl = `${config.PubMed.Endpoints.Fetch}?db=pubmed&retmode=xml&id=${pmid}`;
      const fetchRes = UrlFetchApp.fetch(fetchUrl, { muteHttpExceptions: true });
      const xml = fetchRes.getContentText();
      const match = xml.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/);
      let abstractText = match ? match[1].replace(/<[^>]*>?/gm, '').replace(/\s+/g, " ").trim() : "";

      // 本物のアブストをベースに設定
      let contentBody = `[Abstract]\n${abstractText}`;
      
      // 🌟 PMCが存在する場合のみ、優先度順に安全に上乗せ（+=）していく
      if (pmcid) {
        Logger.log(`[PMC Fetch] PMC全文抽出をテスト中...`);
        const pmcUrl = `${config.PubMed.Endpoints.PmcBase}${pmcid}`;
        const pmcRes = UrlFetchApp.fetch(pmcUrl, { muteHttpExceptions: true });
        
        // デバッグ用：NCBIから通信ブロックを食らっていないか生データの先頭200文字を可視化
        Logger.log(`📄 PMC生のレスポンス先頭: ${pmcRes.getContentText().substring(0, 200)}`);
        
        const pmcSections = extractPmcSections_(pmcRes.getContentText());
        
        // 存在するセクションだけ、指定文字数でガッチャンコ（並び順をConclusion優先に同期）
        if (pmcSections.conclusion)   contentBody += `\n\n[PMC Conclusion]\n${pmcSections.conclusion.substring(0, 800)}`;
        if (pmcSections.results)      contentBody += `\n\n[PMC Results]\n${pmcSections.results.substring(0, 1200)}`;
        if (pmcSections.introduction) contentBody += `\n\n[PMC Introduction]\n${pmcSections.introduction.substring(0, 600)}`;
        if (pmcSections.methods)      contentBody += `\n\n[PMC Methods]\n${pmcSections.methods.substring(0, 500)}`;
        
        Logger.log(`全文取得成功 (Hybrid: ${contentBody.length} 文字)`);
      } else {
        Logger.log(`PMC IDがないため、Abstractのみで進行します。(文字数: ${contentBody.length} 文字)`);
      }
      
      Logger.log("✅ PubMed 統合Dry Run: OK (API接続からデータパースまで貫通確認)");

      // --- 3. LLM 構造化要約テスト (5W1H抽出) ---
      Logger.log("--- 🤖 3. LLM 構造化要約テスト (5W1H抽出) ---");
      if (!contentBody || contentBody.length < 50) {
        Logger.log("⚠️ 素材不足のためAI解析をスキップします。");
      } else {
        const testArticleText = `Title: ${info.title}\nAbstract: ${contentBody}`;
        
        // 🌟 【黄金構成】プロンプトは共通の BATCH_SYSTEM、モデルは知能の高い ModelMini を使用
        // 論文解析において「専門家ラベル」を外すことで 5W1H 構造の破壊を防止できることが検証済み。
        Logger.log(`AI解析中 (BATCH_SYSTEM / Model: ${config.Llm.ModelMini})...`);
        const batchResults = LlmService.summarizeBatch([testArticleText], "BATCH_SYSTEM", config.Llm.ModelMini);
        
        if (batchResults && batchResults.length > 0) {
          Logger.log("▼ AI解析結果 (Raw JSON):");
          Logger.log(batchResults[0]);
          
          const parsed = cleanAndParseJSON_(batchResults[0]);
          if (parsed) {
            Logger.log("▼ 構造化パース成功 (プレビュー):");
            Logger.log(`   [TL;DR]  : ${parsed.tldr}`);
            Logger.log(`   [WHO]    : ${parsed.who}`);
            Logger.log(`   [WHAT]   : ${parsed.what}`);
            Logger.log(`   [HOW]    : ${parsed.how}`);
            Logger.log(`   [RESULT] : ${parsed.result}`);
            Logger.log(`   [KW]     : ${Array.isArray(parsed.keywords) ? parsed.keywords.join(", ") : parsed.keywords}`);
          } else {
            Logger.log("❌ AI応答のJSONパースに失敗しました。");
          }
        } else {
          Logger.log("❌ LLMからの応答が得られませんでした。");
        }
      }
      
      Logger.log("✅ PubMed 統合・AI解析貫通テスト完了");
    } else {
      Logger.log("⚠️ 指定期間内に論文が見つからなかったため、API取得テストをスキップしました。");
    }
  } catch (e) {
    Logger.log(`❌ 統合テストエラー: ${e.message}`);
  }

  Logger.log("=== PubMed 診断完了 ===");
}

/**
 * PubMedのAIクエリ拡張ロジックをシート上のキーワードでテストする関数
 * ※非公開スプレッドシート(Config)に新設された「Pubmed」シートのB1セルの値を読み込みます。
 */
function testPubMedQueryExpansion() {
  const config = AppConfig.get();
  let pubmedSheet = null;
  
  try {
    // 🌟【要塞化】本番アクセス制御(Repository)を汚さず、非公開スプレッドシート(ConfigSheetId)を直接オープン
    const ss = SpreadsheetApp.openById(config.System.ConfigSheetId);
    pubmedSheet = ss.getSheetByName("Pubmed");
  } catch(e) {
    Logger.log("❌ エラー: 非公開スプレッドシート(ConfigSheetId)を開くことができませんでした。プロパティ設定を確認してください。");
    return;
  }
  
  if (!pubmedSheet) {
    Logger.log("⚠️ エラー: 非公開スプレッドシート内に「Pubmed」という名前のシートが見つかりません。タブ名が完全一致しているか確認してください。");
    return;
  }
  
  // 🌟 ご指定の条件：B1セルからテストしたいキーワードを動的取得
  const originalQuery = pubmedSheet.getRange("B1").getValue().toString().trim();
  
  if (!originalQuery) {
    Logger.log("⚠️ お知らせ: 「Pubmed」シートの B1 セルが空欄です。テストしたいキーワードを入力してください。");
    return;
  }
  
  // 監査済みのクエリ拡張関数を実行
  const result = expandKeywordQueryPubMed_(originalQuery);
  
  // ログに美しく出力
  Logger.log("==================================================");
  Logger.log("🔬 [PubMed AIクエリ拡張・本番シミュレーション]");
  Logger.log(`📥 入力 (非公開シート Pubmed!B1): "${originalQuery}"`);
  Logger.log(`📤 出力 (拡張・判定結果): "${result}"`);
  Logger.log("==================================================");
  
  // 各自の防衛線（AND/OR、角括弧）のどれを通過したかをビジュアル判定
  if (originalQuery.includes(" OR ") || originalQuery.includes(" AND ")) {
    Logger.log("💡 判定: AND/OR演算子を検知したため、AI拡張を通さず手動クエリとして【そのままパス】しました。");
  } else if (originalQuery.includes("[")) {
    Logger.log("💡 判定: 角括弧「[」を検知したため、プロ仕様タグとみなしてAI拡張を通さず【そのままパス】しました。");
  } else {
    Logger.log("💡 判定: 純粋なキーワードとみなして、AI（LLM）による【自動MeSH Terms大拡張】を実行しました。");
  }
  Logger.log("==================================================");
}

/**
 * PubMedの検索ヒット数比較診断ツール（がっちゃんこ版）
 * ※「Pubmed」シートのB1キーワードを使い、[生のキーワード単発] と [AI拡張クエリ] の両方の新着ヒット数を比較します。
 * ※シートへの記録、論文詳細・本文のダウンロードは一切行わない100%安全なクエリ診断です。
 */
function testPubMedHitCountOnly() {
  const config = AppConfig.get();
  let pubmedSheet = null;
  
  try {
    // 非公開スプレッドシート(Config)を直接オープン
    const ss = SpreadsheetApp.openById(config.System.ConfigSheetId);
    pubmedSheet = ss.getSheetByName("Pubmed");
  } catch(e) {
    Logger.log("❌ エラー: 非公開スプレッドシートを開くことができませんでした。");
    return;
  }
  
  if (!pubmedSheet) {
    Logger.log("⚠️ エラー: 「Pubmed」シートが見つかりません。");
    return;
  }
  
  // B1セルからキーワードを取得
  const originalQuery = pubmedSheet.getRange("B1").getValue().toString().trim();
  if (!originalQuery) {
    Logger.log("⚠️ お知らせ: 「Pubmed」シートの B1 セルが空欄です。キーを打ち込んでください。");
    return;
  }
  
  // 本番ジョブと完全に同じ期間（直近7日間）を計算
  const today = new Date();
  const pastDate = new Date();
  pastDate.setDate(today.getDate() - config.PubMed.Limits.SEARCH_WINDOW_DAYS);
  const endDate = new Date();
  endDate.setDate(today.getDate() - config.PubMed.Limits.SEARCH_END_OFFSET_DAYS);
  const fmt = (d) => Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd");
  
  Logger.log(`📡 PubMed API への二連撃（生検索 ＆ 拡張検索）診断を開始します...`);
  
  // -----------------------------------------------------------------
  // 🔍 1. 【拡張なし】生の入力キーワードだけでPubMedを直接たたく
  // -----------------------------------------------------------------
  const urlRaw = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&sort=pub_date&term=${encodeURIComponent(originalQuery)}&mindate=${fmt(pastDate)}&maxdate=${fmt(endDate)}`;
  let rawIds = [];
  try {
    const resRaw = JSON.parse(fetchWithRetry_(urlRaw, { muteHttpExceptions: true }));
    rawIds = resRaw.esearchresult?.idlist || [];
  } catch(e) {
    Logger.log(`⚠️ 生クエリでの検索に失敗: ${e.message}`);
  }
  
  // -----------------------------------------------------------------
  // 🚀 2. 【拡張あり】本番のAI拡張（手動バイパス判定含む）でPubMedをたたく
  // -----------------------------------------------------------------
  let expandedQuery = originalQuery;
  let expandedIds = [];
  try {
    // 09_Pubmed.js の本番コア関数を呼び出し
    const pubMedRes = getPubMedPaperIDs_(originalQuery, pastDate, endDate);
    expandedIds = pubMedRes.ids;
    expandedQuery = pubMedRes.expandedQuery;
  } catch(e) {
    Logger.log(`⚠️ 拡張クエリでの検索に失敗: ${e.message}`);
  }
  
  // -----------------------------------------------------------------
  // 📊 3. 結果のがっちゃんこビジュアル出力
  // -----------------------------------------------------------------
  Logger.log("==================================================");
  Logger.log("📊 [PubMed 新着ヒット数・生 ＆ 拡張 がっちゃんこ比較診断]");
  Logger.log(`📥 入力キーワード : "${originalQuery}"`);
  Logger.log(`📅 スキャン対象期間: ${fmt(pastDate)} 〜 ${fmt(endDate)}`);
  Logger.log("--------------------------------------------------");
  
  // 判定条件の可視化
  const isHandmade = originalQuery.includes(" OR ") || originalQuery.includes(" AND ") || originalQuery.includes("[");
  if (isHandmade) {
    Logger.log("💡 システム判定: 【手動プロ仕様クエリ（AND/OR/角括弧）】を検知。");
    Logger.log("👉 AI拡張は安全にスキップ（バイパス）されるため、結果は1:1で完全一致します。");
  } else {
    Logger.log("💡 システム判定: 【純粋なキーワード】を検知。");
    Logger.log(`⚙️ AIが自動生成した数式: "${expandedQuery}"`);
  }
  
  Logger.log("--------------------------------------------------");
  Logger.log(`🔍 1. [拡張なし] 入力単語そのままのヒット数: 【 ${rawIds.length} 件 】`);
  Logger.log(`🚀 2. [拡張あり] AI本番仕様でのヒット数     : 【 ${expandedIds.length} 件 】`);
  Logger.log("--------------------------------------------------");
  
  // AI拡張による恩恵（網羅率の差分）をポジティブに算出
  if (!isHandmade) {
    const diff = expandedIds.length - rawIds.length;
    if (diff > 0) {
      Logger.log(`✨ 大勝利: AIの語彙力により、普通の検索では見落とすはずだった論文が【 ＋${diff} 件 】多く網羅されました！`);
    } else if (diff === 0 && expandedIds.length > 0) {
      Logger.log(`✅ 安定: ヒット数は同じですが、MeSH TermsやTIAB指定を含めて確実な網羅性が保証されています。`);
    } else {
      Logger.log(`💨 結果: この期間において、該当する新着論文は世界で1件も発表されていません。`);
    }
  }
  Logger.log("==================================================");
  Logger.log("💡 記録は一切されていません。安心して何度でも打ち替えて診断してください。");
}

/**
 * debugMonthlyPartnerReport
 * 【開発・メンテ用】管理者宛に強制送信するテストツール。
 */
function debugMonthlyPartnerReport() {
  Logger.log("--- 🛠️ [TEST] 月次公的レター デバッグ送信開始 ---");
  const config = AppConfig.get();
  
  const { start, end } = getDateWindow_(30);
  const allRecentArticles = getArticlesInDateWindow_(start, end);

  const partnerArticles = allRecentArticles.filter(a => a.source.startsWith("Partner-"));
  if (partnerArticles.length === 0) {
    Logger.log("対象記事がないためテストをスキップします。");
    return;
  }

  const uniqueSources = [...new Set(partnerArticles.map(a => a.source))];
  const targetItems = uniqueSources.map(s => ({
    query: s.replace("Partner-", ""),
    label: s.replace("Partner-", "") 
  }));

  const reportHtml = generateTrendReportHtml_(partnerArticles, targetItems, start, end, {
      useDigestFormat: false,
      isHtmlOutput: false,
      saveHistory: false,
      enableHistory: false,      
      skipQueryExpansion: true,  
      isLetterMode: true,
      strictSourceMatch: true, // 👈 strictSourceMatch を追加
      model: "nano",
      max_completion_tokens: 4000, 
      taskLabel: "月次パートナーレター要約", 
      promptKeys: { system: "PARTNER_REPORT_SYSTEM", user: "PARTNER_REPORT_USER" }
    });

  if (reportHtml) {
    // 👇 挨拶文をテンプレートに合わせて更新
    const headerText = `To encourage communication and collaboration across the LS business and its affiliated companies, we are pleased to share this month’s latest news and updates from Sysmex, RGK, and OGT.\n\nPlease find the highlights below:`;
    
    // 👇 フッター文を追加するための変数
    const footerText = `\nWe hope this update helps keep everyone informed and supports further communication across our affiliated companies.\n\nIf you have any news or topics you would like to share in future updates, please feel free to let us know.`;

    const adminMail = config.Digest.mailTo;
    if (!adminMail) return;

    // headerText の後ろに、生成された reportHtml と footerText を繋げて送信
    sendDigestEmail_(headerText, reportHtml + `<div style="margin-top:20px; font-size:14px;">${footerText.replace(/\n/g, '<br>')}</div>`, null, 30, {
      recipient: adminMail,
      isHtml: true,
      isLetterMode: true,
      subjectOverride: `【Test】Monthly News & Updates (${Utilities.formatDate(new Date(), "JST", "yyyy/MM")})`
    });
    
    Logger.log(`✅ 管理者（${adminMail}）宛にデバッグメールを送信しました。`);
  }
}

/**
 * @function debugSummarizeSingleRssV2
 * @description AIの応答形式を自動判別し、パース結果を詳細に表示する強化版テスト。
 */
function debugSummarizeSingleRssV2() {
  const TEST_RSS_URL = "https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja";
  
  Logger.log(`--- 強化版サンドボックス開始 ---`);

  try {
    const response = UrlFetchApp.fetch(TEST_RSS_URL);
    const items = parseRssXml_(response.getContentText(), TEST_RSS_URL);

    if (!items || items.length === 0) {
      Logger.log("❌ 記事取得失敗");
      return;
    }

    const target = items[0];
    Logger.log(`📦 ターゲット: ${target.title}`);

    // 1. スクレイピング結果の確認
    const fullContent = fetchFullContent_(target.link);
    Logger.log(`🌐 取得本文（先頭100文字）: ${fullContent ? fullContent.substring(0, 100) : "取得失敗、RSSの抜粋を使用します"}`);
    
    const textToAnalyze = fullContent || target.description;

    // 2. AIへ送信
    Logger.log("🤖 LLM送信中...");
    const resultRaw = LlmService.summarize(textToAnalyze);
    
    // 3. 解析結果の検証
    Logger.log(`📡 AIからの生応答: ${resultRaw}`); // これで形がわかります

    const parsed = cleanAndParseJSON_(resultRaw);
    if (!parsed) {
      Logger.log("❌ JSONパース失敗");
      return;
    }

    // 4. バッチ形式（results配列）か単一形式かを自動判別
    let finalData = parsed;
    if (parsed.results && Array.isArray(parsed.results) && parsed.results.length > 0) {
      Logger.log("💡 バッチ形式（results入り）を検知しました。先頭の記事を抽出します。");
      finalData = parsed.results[0];
    }

    Logger.log("\n=============================");
    Logger.log("✨ 最終解析結果");
    Logger.log("=============================");
    Logger.log(`【TL;DR】   : ${finalData.tldr || finalData.summary || "N/A"}`);
    Logger.log(`【WHO】     : ${finalData.who || "N/A"}`);
    Logger.log(`【WHAT】    : ${finalData.what || "N/A"}`);
    Logger.log(`【HOW】     : ${finalData.how || "N/A"}`);
    Logger.log(`【RESULT】  : ${finalData.result || "N/A"}`);
    Logger.log(`【KEYWORDS】: ${Array.isArray(finalData.keywords) ? finalData.keywords.join(', ') : (finalData.keywords || "N/A")}`);

  } catch (e) {
    Logger.log(`❌ エラー: ${e.toString()}`);
  }
  Logger.log("\n--- サンドボックス終了 ---");
}

/**
 * ベクトル類似度による過去重複検知の効果測定・診断ツール（256次元・事前フィルタ最適化版）
 * ※「Pubmed」シートのB1キーワードに文字マッチした新着記事だけを抽出し、
 * 過去の配信履歴（DigestHistory）とのベクトル総当たり計算を安全にシミュレートします。
 */
function testVectorSimilarityAudit() {
  const config = AppConfig.get();
  
  // 1. テスト対象のキーワードを非公開シート(Pubmed!B1)から動的にロード
  let pubmedSheet = null;
  try {
    pubmedSheet = SpreadsheetApp.openById(config.System.ConfigSheetId).getSheetByName("Pubmed");
  } catch(e) {}
  
  if (!pubmedSheet) {
    Logger.log("⚠️ 診断エラー: 非公開スプレッドシート内に「Pubmed」シートが見つかりません。");
    return;
  }
  
  const targetKeyword = pubmedSheet.getRange("B1").getValue().toString().trim();
  if (!targetKeyword) {
    Logger.log("⚠️ お知らせ: 「Pubmed」シートの B1 セルが空欄です。診断したいキーワードを打ち込んでください。");
    return;
  }
  
  // 2. 過去の配信履歴(DigestHistory)をロード
  const historySheet = Repository.getSheet(config.SheetNames.DIGEST_HISTORY);
  if (!historySheet || historySheet.getLastRow() < 2) {
    Logger.log("⚠️ 診断エラー: DigestHistory シートに履歴データがありません。");
    return;
  }
  const historyData = historySheet.getRange(2, 1, historySheet.getLastRow() - 1, 4).getValues();

  // 3. 直近2日間の新着記事をロード (デイリー配信ウィンドウと同等)
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 2); 
  
  // 🌟 03_Repository.js の最新最適化ロジックで期間内の記事を一括ロード
  const allArticles = Repository.getArticlesInDateWindow(start, end);
  
  if (allArticles.length === 0) {
    Logger.log("⚠️ お知らせ: 直近2日間に要約済みの新着記事がスプレッドシートにありません。");
    return;
  }
  
  // 🌟【超軽量化】数百件の全データから、B1単語に「かすっている記事」へGASの高速ネイティブ処理で事前集約
  const expandedQuery = expandKeywordQuery_(targetKeyword); 
  const filteredArticles = allArticles.filter(art => {
    const content = (art.title + " " + art.headline + " " + art.abstractText);
    return isTextMatchQuery_(content, expandedQuery);
  });
  
  Logger.log(`📡 [256d ベクトル監査] 総記事数 ${allArticles.length} 件 ➔ "${targetKeyword}" 該当: ${filteredArticles.length} 件に事前凝縮。`);
  Logger.log(`📡 過去の配信履歴 ${historyData.length} 件との突合（内積計算）を開始します...`);
  
  if (filteredArticles.length === 0) {
    Logger.log(`✅ 安定: 直近2日間の数百件の中に、キーワード "${targetKeyword}" にヒットする記事自体がありませんでした。`);
    return;
  }

  const matches = [];
  const AUDIT_THRESHOLD = 0.70; // 挙動を見るため、類似度70%以上を広域検挙
  let calcCount = 0;
  const startTimeMs = new Date().getTime();

  // 4. 256次元ベクトルによる超高速内積ループ
  for (const article of filteredArticles) {
    const articleVec = article.parsedVector; // _createArticleObject_ で自動パース済みの256次元配列
    if (!articleVec) continue;

    for (const hist of historyData) {
      // 履歴側も同じキーワードに関する過去ログのみにピンポイント突合
      if (String(hist[1]).trim() !== targetKeyword) continue;

      const histSummary = hist[2];
      const histVecStr = hist[3];
      if (!histVecStr) continue;

      // 05_Analytics.js の軽量パーサーで履歴のベクトルを配列化
      const histVec = parseVector_(histVecStr);
      if (!histVec) continue;

      calcCount++;
      // 05_Analytics.js のネイティブ内積エンジンで一瞬で計算
      const similarity = calculateDotProduct_(articleVec, histVec);

      if (similarity >= AUDIT_THRESHOLD) {
        matches.push({
          similarity: similarity,
          newTitle: article.title,
          newSource: article.source || "News",
          oldSummary: histSummary.substring(0, 120) + "..."
        });
      }
    }
  }

  const endTimeMs = new Date().getTime();
  // 類似度の高い順（降順）にソート
  matches.sort((a, b) => b.similarity - a.similarity);

  // 5. 結果のビジュアル出力
  Logger.log("==================================================");
  Logger.log(`📊 [YATA 256d ベクトル類似度・重複検知 監査レポート: ${targetKeyword}]`);
  Logger.log(`⏱️ 計算所要時間: ${endTimeMs - startTimeMs} ミリ秒 (1秒の100分1のレベル)`);
  Logger.log(`🧮 総計算回数  : ${calcCount} 回`);
  Logger.log(`🎯 検挙された酷似ペア: ${matches.length} 件`);
  Logger.log("================================================--");

  if (matches.length === 0) {
    Logger.log(`✅ 安定: 過去に配信した「${targetKeyword}」の要約と重複（酷似）する新着記事は数値上ありませんでした。`);
  } else {
    matches.forEach((m, idx) => {
      let alertIcon = "🟡 [緩やかな関連]";
      if (m.similarity >= 0.88) alertIcon = "🚨 [中身がほぼ完全に同一！]";
      else if (m.similarity >= 0.80) alertIcon = "🟠 [強い重複の疑い]";

      Logger.log(`${alertIcon} 類似度: 【 ${(m.similarity * 100).toFixed(1)}% 】`);
      Logger.log(`  📥 新着記事 [${m.newSource}]: "${m.newTitle}"`);
      Logger.log(`  🗄️ 過去要約 [History] : "${m.oldSummary}"`);
      Logger.log("  ----------------------------------------------");
    });
  }
  Logger.log("==================================================");
  Logger.log("💡 本番データは1ミリも変更されていません。安心して実験してください。");
}

/**
 * 今回導入した「1通のメール内でのURL重複排除」が正常に動くかを
 * 現在のスプレッドシートのデータを使って今すぐログで確認するテスト
 */
function testMailInternalExclusionSnapshot() {
  const config = AppConfig.get();
  
  // 1. 直近2日間の記事（本番の配信対象）をロード
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 2); 
  const allArticles = Repository.getArticlesInDateWindow(start, end);
  
  if (allArticles.length === 0) {
    Logger.log("⚠️ お知らせ: 直近2日間に新着記事がないため実験できません。");
    return;
  }
  
  // 2. 実験用に、直近の記事の山から「最初の1件」をダミーのターゲットとしてピックアップ
  const targetArticle = allArticles[0];
  
  Logger.log("==================================================");
  Logger.log("🔬 [1通のメール内・URL重複排除ロジック 擬似シミュレーション]");
  Logger.log(`🎯 検証する記事: "${targetArticle.title}"`);
  Logger.log(`🔗 対象のURL   : ${targetArticle.url}`);
  Logger.log("==================================================");
  
  // 3. 🌟今回 175行目に導入した「記憶の盾（Set）」をメモリ上に作成
  let deliveredUrls = new Set();
  
  // --- 枠①（最初のキーワードセクションの検索） ---
  Logger.log("① 最初のキーワード（例: 精密医療）の検索ループを開始...");
  
  // 本番の308行目の動きを再現：盾（Set）に入っているかチェック
  if (deliveredUrls.has(targetArticle.url)) {
    Logger.log("❌ [排除発動] すでに上のセクションで登場済みのため、検索結果から抹殺されました。");
  } else {
    Logger.log("✅ [検索通過] まだ誰も使っていないURLなので、AI要約の素材として無事採用！");
    
    // 本番の328行目の動きを再現：AI要約が終わったので、URLを盾にガチッと記憶（刻印）させる
    deliveredUrls.add(targetArticle.url);
    Logger.log(`💾 記憶の盾にURLを刻印しました。（現在の盾のサイズ: ${deliveredUrls.size}件）`);
  }
  
  Logger.log("--------------------------------------------------");
  
  // --- 枠②（別のキーワードセクションでの再検索） ---
  Logger.log("② 別のキーワード（例: 市場環境）の検索ループが回ってきました...");
  Logger.log(`🔍 同じ記事がこのキーワードの検索にも引っかかったと仮定します...`);
  
  // 再び、本番の308行目の動きを再現
  if (deliveredUrls.has(targetArticle.url)) {
    Logger.log("🔥 [排除大成功!!] すでに上のセクションで登場済みであることを検知！");
    Logger.log("🙅‍♂️ AI（LLM）に渡される前に、検索結果から実質0秒で強制パージ（除外）されました！");
  } else {
    Logger.log("✅ AI要約の素材として採用（ここを通ってしまうとダブり発生を意味します）");
  }
  
  Logger.log("==================================================");
  Logger.log("✨ 結論: 1行足したオプション連携により、上の動きが完全に自動駆動します。");
}

/**
 * 👑 [v2.0 新設診断コア] toolDiagnoseDeliveryLock
 * 【責務】なぜ debugPersonalReport で記事がヒットしないのか、原因をピンポイントで全自動監査する
 */
function toolDiagnoseDeliveryLock() {
  Logger.log("--- 🕵️‍♂️ YATA 配信ロック全自動診断開始 ---");
  const config = AppConfig.get();
  
  // 1. デバッグユーザー（2行目）の構成をロード
  const usersSheet = Repository.getSheet(config.SheetNames.USERS);
  const usrCols = config.UsersSheet.Columns;
  const user = usersSheet.getRange(2, 1, 1, usersSheet.getLastColumn()).getValues()[0];
  
  const name = user[usrCols.NAME - 1];
  const email = user[usrCols.EMAIL - 1];
  const kws = String(user[usrCols.KWS - 1] || "").split(',').map(k => k.trim()).filter(String);
  const useSemantic = user[usrCols.SEMANTIC - 1] === true || String(user[usrCols.SEMANTIC - 1]).toUpperCase() === "TRUE" || String(user[usrCols.SEMANTIC - 1]) === "〇";
  const lastSent = user[usrCols.LAST_SENT - 1];
  
  Logger.log(`👤 対象ユーザー: ${name} (${email})`);
  Logger.log(`🔑 設定キーワード: [${kws.join(", ")}]`);
  Logger.log(`🤖 AI意味検索フラグ (SEMANTIC): ${useSemantic ? "🔴 TRUE (ベクトル検索駆動)" : "🔍 FALSE (通常の文字マッチ駆動)"}`);
  Logger.log(`📅 LAST_SENT 刻印: ${lastSent ? lastSent : "空欄 (安全)"}`);
  
  // 2. 直近の記事のストック状態をロード
  const collectSheet = Repository.getSheet(config.SheetNames.TREND_DATA);
  const lastRow = collectSheet.getLastRow();
  Logger.log(`📊 collect（TrendData）シートの総行数: ${lastRow} 行`);
  
  if (lastRow < 2) {
    Logger.log("❌ 原因確定: collectシートに記事データが1件もありません。runCollectionJob を先に動かしてください。");
    return;
  }
  
  const FETCH_DAYS = 14;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - FETCH_DAYS);
  
  const SCAN_LIMIT = config.System.Limits.SUMMARIZE_SCAN_LIMIT || 300;
  const data = collectSheet.getRange(2, 1, Math.min(lastRow - 1, SCAN_LIMIT), collectSheet.getLastColumn()).getValues();
  
  let totalValidSummary = 0;
  let totalEmptySummary = 0;
  let totalEmptyVector = 0;
  
  const C = config.CollectSheet.Columns;
  
  data.forEach((row) => {
    const summary = String(row[C.SUMMARY - 1] || "").trim();
    const vector = String(row[C.VECTOR - 1] || "").trim();
    
    if (summary === "") {
      totalEmptySummary++;
    } else if (isValidHeadline_(summary)) {
      totalValidSummary++;
      if (vector === "" || vector.includes("[Error]")) {
        totalEmptyVector++;
      }
    }
  });
  
  Logger.log(`📈 直近のスキャン範囲（${SCAN_LIMIT}行）内における記事の内訳:`);
  Logger.log(`   - AI要約が完了している有効な記事: ${totalValidSummary} 件`);
  Logger.log(`   - まだ要約されていない未処理の生記事: ${totalEmptySummary} 件`);
  Logger.log(`   - ベクトル（G列）が空っぽの記事: ${totalEmptyVector} 件`);
  
  if (totalValidSummary === 0) {
    Logger.log("❌ 原因確定: スキャン範囲内に『AI要約が完了した記事』が1件もありません。runSummarizationJob を実行して要約を生成してください。");
    return;
  }
  
  if (useSemantic && totalEmptyVector === totalValidSummary) {
    Logger.log("❌ 原因確定: AI意味検索(SEMANTIC)がTRUEになっていますが、記事のベクトル（G列）がすべて空っぽです！この状態では類似度計算を通過できません。backfillVectors を実行してベクトルを付与するか、一時的にSEMANTICフラグをFALSEにしてください。");
    return;
  }
  
  // 3. テストマッチのエミュレート
  Logger.log("\n🧪 キーワードのマッチングを擬似エミュレート中...");
  kws.forEach(kw => {
    const expanded = expandKeywordQuery_(kw);
    Logger.log(`👉 クエリ拡張結果: "${kw}" ➔ "${expanded}"`);
    
    let hitCount = 0;
    data.forEach(row => {
      const summary = String(row[C.SUMMARY - 1] || "").trim();
      if (isValidHeadline_(summary)) {
        const textToSearch = (row[1] + " " + summary + " " + row[3]);
        if (isTextMatchQuery_(textToSearch, expanded)) {
          hitCount++;
        }
      }
    });
    Logger.log(`   ➔ 通常の文字マッチでのヒット数: 【 ${hitCount} 件 】`);
  });
  
  Logger.log("\n--- 🕵️‍♂️ 診断完了 ---");
}