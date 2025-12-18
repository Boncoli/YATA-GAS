/**
 * @file RSScollect.js
 * @description RSSフィードを収集し、AIで見出しと週次ダイジェストを生成するGoogle Apps Script
 * @version 2.7.0
 * @date 2025-12-06
 * 
 * ===== スクリプトプロパティの変更履歴 =====
 * 
 * 【2025-12-06】実行コンテキストの導入
 *   - EXECUTION_CONTEXT : LLM呼び出し優先順位を制御 ('COMPANY' or 'PERSONAL')
 *     - 'COMPANY' (デフォルト): Azure OpenAI → OpenAI Personal → Google Gemini
 *     - 'PERSONAL'            : OpenAI Personal → Azure OpenAI → Google Gemini
 * 
 * 【2025-11-25】NANO/MINI機能ベース命名への統一
 * 
 * 新プロパティキー（推奨）:
 *   - OPENAI_MODEL_NANO          : 軽量処理用モデル（見出し生成、キーワード抽出）
 *     デフォルト: "gpt-4.1-nano"
 *     使用関数: summarizeWithLLM(), extractKeywordsWithLLM()
 * 
 *   - OPENAI_MODEL_MINI          : 高次分析用モデル（日刊・週刊ダイジェスト、検索分析）
 *     デフォルト: "gpt-4.1-mini"
 *     使用関数: callDailyDigestLlm(), _llmMakeTrendSections(), searchAndAnalyzeKeyword()
 * 
 *   - AZURE_ENDPOINT_URL_NANO    : Azure OpenAI 軽量処理用エンドポイント
 *     使用関数: summarizeWithLLM(), extractKeywordsWithLLM()
 * 
 *   - AZURE_ENDPOINT_URL_MINI    : Azure OpenAI 高次分析用エンドポイント
 *     使用関数: callDailyDigestLlm(), _llmMakeTrendSections(), searchAndAnalyzeKeyword()
 * 
 * 旧プロパティキー（廃止）:
 *   - OPENAI_MODEL_DAILY, OPENAI_MODEL_WEEKLY, AZURE_ENDPOINT_URL_WEEKLY
 * 
 */

// Core: 全体設定と定数
const AppConfig = (function() {
  let cache = null;
  // この関数は設定値を一度だけ読み込み、キャッシュする
  function load() {
    if (cache) return cache;

    const props = PropertiesService.getScriptProperties();
    cache = {
      SheetNames: {
        RSS_LIST: "RSS",
        TREND_DATA: "collect",
        PROMPT_CONFIG: "prompt",
        TRENDS: "Trends",
        USERS: "Users",
      },
      CollectSheet: {
        Columns: { URL: 3, ABSTRACT: 4, SUMMARY: 5, SOURCE: 6 },
        DataRange: { START_ROW: 2, NUM_COLS_FOR_URL: 1 },
      },
      RssListSheet: {
        DataRange: { START_ROW: 2, START_COL: 1, NUM_COLS: 2 },
      },
      Llm: {
        MODEL_NAME: "gemini-2.5-flash-lite",
        DELAY_MS: 1100,
        MIN_SUMMARY_LENGTH: 100,
        NO_ABSTRACT_TEXT: "抜粋なし",
        MISSING_ABSTRACT_TEXT: "記事が短すぎるか、抜粋がないため見出し生成をスキップしました。",
        SHORT_JA_SKIP_TEXT: "記事が短く、日本語のため見出し生成をスキップしました。",
        // --- Dynamic settings from Script Properties ---
        Context: props.getProperty("EXECUTION_CONTEXT") || "COMPANY",
        ModelNano: props.getProperty("OPENAI_MODEL_NANO") || "gpt-4.1-nano",
        ModelMini: props.getProperty("OPENAI_MODEL_MINI") || "gpt-4.1-mini",
        AzureUrlNano: props.getProperty("AZURE_ENDPOINT_URL_NANO") || null,
        AzureUrlMini: props.getProperty("AZURE_ENDPOINT_URL_MINI") || null,
        AzureKey: props.getProperty("OPENAI_API_KEY") || null,
        OpenAiKey: props.getProperty("OPENAI_API_KEY_PERSONAL") || null,
        GeminiKey: props.getProperty("GEMINI_API_KEY") || null,
      },
      Digest: {
        days: parseInt(props.getProperty("DIGEST_DAYS") || "7", 10),
        topN: parseInt(props.getProperty("DIGEST_TOP_N") || "20", 10),
        notifyChannel: (props.getProperty("NOTIFY_CHANNEL_WEEKLY") || "email").toLowerCase(),
        mailTo: props.getProperty("MAIL_TO"),
        mailSubjectPrefix: props.getProperty("MAIL_SUBJECT_PREFIX"), // デフォルトはnull/undefined
        mailSenderName: props.getProperty("MAIL_SENDER_NAME") || "RSS要約ボット",
        sheetUrl: props.getProperty("DIGEST_SHEET_URL") || "(DIGEST_SHEET_URL 未設定)",
      },
      Trend: {
        detectionEnabled: (props.getProperty("TREND_DETECTION_ENABLED") || 'false').toLowerCase() === 'true',
      }
    };
    return cache;
  }
  return { get: load };
})();

/**
 * ================================================================================
 * SECTION 1: TRIGGER ENTRY POINTS
 * ================================================================================
 * タイムトリガーからの呼び出しエントリポイント。
 * 各関数は独立した処理フローを実行：
 *   - mainAutomationFlow    : 日次自動化（RSS収集→見出し生成→トレンド検出）
 *   - dailyDigestJob        : 日刊ダイジェスト生成・送信
 *   - weeklyDigestJob       : 週刊ダイジェスト生成・送信（キーワードベース）
 * ================================================================================
 */

/**
 * mainAutomationFlow
 * 【責務】日次自動化フロー：RSS収集 → 見出し生成 → トレンド検出
 * 【実行サイクル】毎日 1:00 AM (タイムトリガー設定)
 * 【副作用】collectシート・Trendsシート更新、LLMAPI呼び出し
 */
function mainAutomationFlow() {
  Logger.log("--- 自動化フロー開始 ---");
  
  // 1. RSS収集
  collectRssFeeds();
  
  // 2. AI見出し生成
  processSummarization();
  
  // 3. 日付順に並び替え (追加: 最新の記事を上に)
  sortCollectByDateDesc();

  // 4. トレンド検出
  detectAndRecordTrends();
  
  Logger.log("--- 自動化フロー完了 ---");
}

/**
 * dailyDigestJob
 * 【責務】日刊ダイジェスト生成・送信：過去24時間の全記事をLLMで要約
 * 【実行サイクル】毎日 8:00 AM (タイムトリガー設定)
 * 【特徴】キーワードフィルタリング不要、期間内の全記事を対象
 * 【処理流程】
 *   1. 過去24時間の記事を取得
 *   2. LLM（Azure→OpenAI→Gemini）でトピック抽出・要約生成
 *   3. Trendsシートに記録
 *   4. メール送信
 * @param {none}
 * @returns {none}
 */
function dailyDigestJob() {
  Logger.log("--- 日刊ダイジェスト生成開始 (全記事対象) ---");
  
  // 期間設定: 1日 (24時間)
  const DAYS_WINDOW = 1; 

  // 設定と期間の取得
  const config = AppConfig.get().Digest; 
  const { start, end } = getDateWindow(DAYS_WINDOW); 
  
  // 1. 対象記事の抽出（要約済みの全記事）
  // ※ここではキーワードフィルタリングを行いません。
  const allItems = getArticlesInDateWindow(start, end);
  
  if (allItems.length === 0) {
    Logger.log("日刊ダイジェスト：対象期間に記事がありませんでした。");
    _handleNoArticlesFound(config, start, end, "対象期間に記事がありませんでした。", DAYS_WINDOW); 
    return;
  }
  
  Logger.log(`日刊ダイジェスト：対象期間内に ${allItems.length} 件の記事が見つかりました。`);
  
  // 2. LLMによるトピック抽出・要約生成とメール送信
  // 新しい日刊専用関数を呼び出す
  _generateAndSendDailyDigest(allItems, config, start, end, DAYS_WINDOW);
  
  Logger.log("--- 日刊ダイジェスト生成完了 ---");
}

/**
 * weeklyDigestJob
 * 【責務】週刊ダイジェスト生成・送信：過去7日のキーワード関連記事をLLMで分析
 * 【実行サイクル】毎週 月曜 9:00 AM (タイムトリガー設定)
 * 【特徴】Keywords シートのキーワードでフィルタリング、トレンドセクション生成
 * 【処理流程】
 *   1. 過去7日の記事を取得
 *   2. Keywordsシートのキーワード でフィルタリング
 *   3. 上位N件をスコア付けで選抜
 *   4. LLMでトレンドセクション生成（キーワード毎）
 *   5. メール送信
 * 【引数】
 *   - webUiKeyword   : Web UI から単発入力されたキーワード（優先度高）
 *   - returnHtmlOnly : true→HTML返却のみ（メール送信せず）
 * @param {string} webUiKeyword - （オプション）Web UI キーワード入力
 * @param {boolean} returnHtmlOnly - （オプション）HTML返却のみフラグ
 * @returns {string} HTML本文（returnHtmlOnly=true の場合）
 */
// function weeklyDigestJob を置き換え
function weeklyDigestJob(webUiKeyword = null, returnHtmlOnly = false) {
  // ★追加: トリガー実行時は webUiKeyword にオブジェクトが入ってしまうため、文字列でない場合は無効化する
  if (typeof webUiKeyword !== 'string') {
    webUiKeyword = null;
  }

  const config = AppConfig.get().Digest;
  const DAYS_WINDOW = config.days; // 7日間

  // 実行期間を計算
  const { start, end } = getDateWindow(DAYS_WINDOW);
  const allItems = getArticlesInDateWindow(start, end);

  if (allItems.length === 0) {
    Logger.log("週刊ダイジェスト：対象期間に記事がありませんでした。");
    // daysWindowを渡す
    _handleNoArticlesFound(config, start, end, "対象期間に記事がありませんでした。", DAYS_WINDOW); 
    return;
  }
  
  Logger.log(`週刊ダイジェスト：対象期間内に ${allItems.length} 件の記事が見つかりました。`);

  // キーワードによる記事の分類 (中略)
  const { relevantArticles, hitKeywordsWithCount, articleKeywordMap } = _filterRelevantArticles(allItems, webUiKeyword);

  if (relevantArticles.length === 0) {
    Logger.log("週刊ダイジェスト：キーワードに合致する記事がありませんでした。");
    // daysWindowを渡す
    _handleNoArticlesFound(config, start, end, "キーワードに合致する記事がありませんでした。", DAYS_WINDOW);
    return;
  }
  
  Logger.log(`週刊ダイジェスト：キーワードに合致する記事が ${relevantArticles.length} 件見つかりました。`);
  _logKeywordHitCounts(hitKeywordsWithCount);

  // LLMによる要約生成とメール送信
  // daysWindowを渡す
  const result = _generateAndSendDigest(relevantArticles, hitKeywordsWithCount, articleKeywordMap, config, start, end, returnHtmlOnly, DAYS_WINDOW); 
  
  if (returnHtmlOnly) return result;
}

/**
 * processSummarization
 * 【責務】未生成の見出し（E列）をAIで生成：短記事は簡易処理、長記事はLLM処理
 * 【実行タイミング】mainAutomationFlow から呼び出し（日次 1:00 AM）
 * 【タイムアウト対策】5分経過で処理中断→進捗保存し、残りは次回実行に委譲
 * 【処理流程】
 *   1. 全行をスキャンして見出し未生成の記事を特定
 *   2. 短記事（抜粋<100字 or 「抜粋なし」）：タイトルまたはGOOGLETRANSLATE数式で代用
 *   3. 長記事：LLM呼び出し（NANO モデル）で見出し生成
 *   4. 5分上限チェックで強制終了→進捗をシートに保存
 * 【副作用】collectシートのE列（SUMMARY）を更新、LLM API呼び出し（複数回）
 * @param {none}
 * @returns {none}
 */
function processSummarization() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const trendDataSheet = ss.getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  if (!trendDataSheet) {
    Logger.log("エラー: collectシートが見つかりません。");
    return;
  }
  const lastRow = trendDataSheet.getLastRow();
  if (lastRow < 2) return;

  // --- 改善点: 実行開始時刻を記録 ---
  const startTime = new Date().getTime();
  const TIME_LIMIT_MS = 5 * 60 * 1000; // 5分（GASの制限6分に対し余裕を持たせる）

  const dataRange = trendDataSheet.getRange(2, 1, lastRow - 1, trendDataSheet.getLastColumn());
  const values = dataRange.getValues();
  const articlesToSummarize = [];

  // 1. まず全行をスキャンして、要約が必要な記事を特定する（ここは高速なのでそのまま）
  values.forEach((row, index) => {
    const currentHeadline = row[AppConfig.get().CollectSheet.Columns.SUMMARY - 1];
    // 見出しが空の場合のみ処理
    if (!currentHeadline || String(currentHeadline).trim() === "") {
      const title = row[AppConfig.get().CollectSheet.Columns.URL - 2]; // C列の左隣(B列)がタイトルと仮定
      const abstractText = row[AppConfig.get().CollectSheet.Columns.ABSTRACT - 1];
      
      // 記事が短すぎる、または「抜粋なし」の場合はAIを使わず簡易処理
      const isShort = (abstractText === AppConfig.get().Llm.NO_ABSTRACT_TEXT) || (String(abstractText || "").length < AppConfig.get().Llm.MIN_SUMMARY_LENGTH);
      
      if (isShort) {
        let newHeadline;
        const sheetRowNumber = index + 2;
        if (title && String(title).trim() !== "") {
          // タイトルがあればそれを使う（英語なら翻訳）
          newHeadline = isLikelyEnglish(String(title)) ? `=GOOGLETRANSLATE(B${sheetRowNumber},"auto","ja")` : String(title).trim();
        } else if (abstractText && abstractText !== AppConfig.get().Llm.NO_ABSTRACT_TEXT) {
          newHeadline = isLikelyEnglish(String(abstractText)) ? `=GOOGLETRANSLATE(D${sheetRowNumber},"auto","ja")` : String(abstractText).trim();
        } else {
          newHeadline = AppConfig.get().Llm.MISSING_ABSTRACT_TEXT;
        }
        // 即座に配列を更新
        values[index][AppConfig.get().CollectSheet.Columns.SUMMARY - 1] = newHeadline;
      } else {
        // AI要約対象としてリストに追加
        articlesToSummarize.push({ originalRowIndex: index, title: title, abstractText: abstractText });
      }
    }
  });

  let apiCallCount = 0;

  // 2. AI要約の実行（ここが一番重いので制限時間をチェックする）
  if (articlesToSummarize.length > 0) {
    Logger.log(`${articlesToSummarize.length} 件の記事に対してAIによる見出し生成を試行します。`);
    
    // forEachではなく for...of を使用して break できるように変更
    for (const article of articlesToSummarize) {
      
      // --- 改善点: 制限時間をチェック ---
      if (new Date().getTime() - startTime > TIME_LIMIT_MS) {
        Logger.log(`タイムアウト回避のため、処理を中断しました（残り ${articlesToSummarize.length - apiCallCount} 件）。残りは次回実行されます。`);
        break; // ループを抜けて保存処理へ移行
      }

      const articleText = `Title: ${article.title}\nAbstract: ${article.abstractText}`;
      const jsonString = summarizeWithLLM(articleText);
      apiCallCount++;

      let newHeadline = null;
      if (jsonString && !jsonString.includes("エラー") && !jsonString.includes("いずれのLLMでも")) {
        try {
          const parsedJson = JSON.parse(jsonString);
          newHeadline = parsedJson.tldr || parsedJson.summary;
          if (!newHeadline) newHeadline = String(jsonString).trim();
        } catch (e) {
          Logger.log(`JSONパース失敗 (Row: ${article.originalRowIndex + 2}): ${e.toString()}`);
          newHeadline = String(jsonString).trim();
        }
      } else {
        Logger.log(`見出し生成失敗 (Row: ${article.originalRowIndex + 2}): ${jsonString}`);
      }

      if (newHeadline && String(newHeadline).trim() !== "" && String(newHeadline).indexOf("エラー") === -1) {
        values[article.originalRowIndex][AppConfig.get().CollectSheet.Columns.SUMMARY - 1] = newHeadline;
      } else {
        Logger.log(`見出し生成結果が空またはエラーのためスキップ (Row: ${article.originalRowIndex + 2}): ${newHeadline}`);
      }
      
      Utilities.sleep(AppConfig.get().Llm.DELAY_MS);
    }
  }

  // 3. 結果をシートに書き戻す（途中終了した場合も、そこまでの進捗は保存される）
  if (lastRow > 1) {
    dataRange.setValues(values);
    Logger.log(`LLMコール数: ${apiCallCount} 回。E列を更新しました。`);
  } else {
    Logger.log("見出し生成が必要な記事は見つかりませんでした。");
  }
}

/**
 * ================================================================================
 * SECTION 2: WEEKLY DIGEST PROCESSORS
 * ================================================================================
 * 週刊ダイジェスト生成・送信の関数群。
 * キーワードベースのフィルタリング、記事選抜、LLM分析の統合フロー。
 * ================================================================================
 */

/**
 * _filterRelevantArticles
 * 【責務】キーワード照合で関連記事をフィルタリング・ヒット数集計
 * 【機能】
 *   - キーワード AND/OR 論理演算をサポート（例："Python AND AI" → 両キーワード含む記事のみ抽出）
 *   - 記事（タイトル+抜粋+見出し）とキーワードを正規表現でマッチング
 *   - キーワード毎のヒット数を集計→後続の優先度判定に利用
 * 【入力】
 *   - allItems : 全記事配列 ({ date, title, url, abstractText, headline, source })
 *   - webUiKeyword : Web UI から入力されたキーワード（優先度高）
 * 【出力】
 *   - { relevantArticles, hitKeywordsWithCount, articleKeywordMap }
 *   - hitKeywordsWithCount : キーワード毎の記事数（ソート済み）
 *   - articleKeywordMap : URL→キーワード配列の Map（スコア計算用）
 */
/**
 * _filterRelevantArticles (修正版: 曜日フィルタリング実装)
 * 【責務】キーワード照合で関連記事をフィルタリング
 * 【変更】自動実行時は、本日の曜日にマッチするキーワードだけを採用する
 */
function _filterRelevantArticles(allItems, webUiKeyword = null) {
  let activeKeywords = [];
  
  if (webUiKeyword && String(webUiKeyword).trim() !== "") {
    // 1. Web UIからの手動実行時 -> 曜日は無視してそのキーワードで実行
    activeKeywords = [String(webUiKeyword).trim()];
    Logger.log(`フィルタリング(手動): キーワード「${activeKeywords[0]}」を使用します。`);
  } else {
    // 2. 自動実行時 -> 「本日の曜日」に一致するキーワードのみ抽出
    const allConfigured = getWeightedKeywords();
    
    // 今日の曜日を取得 (例: "月", "火"...)
    const dayMap = ["日", "月", "火", "水", "木", "金", "土"];
    const todayDay = dayMap[new Date().getDay()];
    
    activeKeywords = allConfigured
      .filter(kw => {
        if (!kw.active) return false; // 無効なものは除外
        
        // 曜日指定チェック
        const targetDay = kw.day;
        // 空欄または「毎日」なら、どの曜日でも実行
        if (!targetDay || targetDay === "毎日") return true;
        
        // 指定された文字が含まれていれば実行 (例: "月,木" なら月曜と木曜にヒット)
        return targetDay.includes(todayDay);
      })
      .map(kw => kw.keyword);

    if (activeKeywords.length === 0) {
      Logger.log(`本日は配信設定されているキーワードがありません。（曜日: ${todayDay}）`);
      // 記事ゼロ扱いで終了させるために空の結果を返す
      return { relevantArticles: [], hitKeywordsWithCount: [], articleKeywordMap: new Map() };
    }

    Logger.log(`フィルタリング(自動): 本日(${todayDay}曜日)の対象キーワード ${activeKeywords.length} 件を使用します。`);
  }

  // --- 以下、既存の処理と同じ ---
  const relevantArticles = [];
  const keywordHitCounts = {};
  const articleKeywordMap = new Map();
  const parseKeywordCondition = (keywordCell) => {
    const lower = keywordCell.toLowerCase();
    if (lower.includes(' and ')) return { type: 'and', words: keywordCell.split(/ and /i).map(w => w.trim()) };
    if (lower.includes(' or ')) return { type: 'or', words: keywordCell.split(/ or /i).map(w => w.trim()) };
    return { type: 'single', words: [keywordCell.trim()] };
  };
  const keywordConditions = activeKeywords.map(k => ({ original: k, ...parseKeywordCondition(k) }));
  
  allItems.forEach(article => {
    const text = `${article.title} ${article.abstractText} ${article.headline}`;
    const hitKeywordsForArticle = new Set();
    keywordConditions.forEach(cond => {
      const isMatch = (cond.type === 'and' && cond.words.every(word => new RegExp(word.replace(/[.*+?^${}()|[\\]/g, '\\$&'), 'i').test(text))) ||
                      (cond.type === 'or' && cond.words.some(word => new RegExp(word.replace(/[.*+?^${}()|[\\]/g, '\\$&'), 'i').test(text))) ||
                      (cond.type === 'single' && new RegExp(cond.words[0].replace(/[.*+?^${}()|[\\]/g, '\\$&'), 'i').test(text));
      if (isMatch) hitKeywordsForArticle.add(cond.original);
    });
    if (hitKeywordsForArticle.size > 0) {
      relevantArticles.push(article);
      articleKeywordMap.set(article.url, Array.from(hitKeywordsForArticle));
      hitKeywordsForArticle.forEach(keyword => {
        keywordHitCounts[keyword] = (keywordHitCounts[keyword] || 0) + 1;
      });
    }
  });
  const hitKeywordsWithCount = Object.entries(keywordHitCounts).map(([keyword, count]) => ({ keyword, count })).sort((a, b) => b.count - a.count);
  return { relevantArticles, hitKeywordsWithCount, articleKeywordMap };
}

/**
 * _logKeywordHitCounts
 * 【責務】コンソール出力：キーワード別ヒット件数の整形ログ
 * @param {Array} hitKeywordsWithCount - { keyword, count } 配列
 * @returns {none} (ログ出力のみ)
 */
function _logKeywordHitCounts(hitKeywordsWithCount) {
  let hitLog = "【キーワード別ヒット件数】\n";
  hitKeywordsWithCount.forEach(item => {
    hitLog += `- ${item.keyword}: ${item.count}件\n`;
  });
  Logger.log(hitLog.trim());
}

/**
 * _generateAndSendDigest
 * 【責務】週刊ダイジェスト本文生成・メール送信
 * 【処理流程】
 *   1. relevantArticles をヒューリスティックスコアで選抜（上位N件）
 *   2. キーワード毎に記事をグループ化
 *   3. LLM でトレンドセクション生成
 *   4. Markdown→HTML変換、メール送信
 * 【引数】
 *   - relevantArticles : キーワード関連記事配列
 *   - hitKeywordsWithCount : キーワード毎ヒット数配列
 *   - articleKeywordMap : URL→キーワード配列の Map
 *   - config : digest設定 { days, topN, notifyChannel, ... }
 *   - start, end : 集計期間
 *   - returnHtmlOnly : true→HTML返却のみ（メール送信しない）
 *   - daysWindow : 集計期間（日数）：日刊=1, 週刊=7
 * @param {Array} relevantArticles - フィルタリング済み記事配列
 * @param {Array} hitKeywordsWithCount - キーワード毎ヒット数（ソート済み）
 * @param {Map} articleKeywordMap - URL→キーワード配列
 * @param {Object} config - ダイジェスト設定
 * @param {Date} start - 集計開始日時
 * @param {Date} end - 集計終了日時
 * @param {boolean} returnHtmlOnly - HTML返却のみフラグ
 * @param {number} daysWindow - 期間（1=日刊, 7=週刊）
 * @returns {string} HTML本文（returnHtmlOnly=true の場合）
 */
function _generateAndSendDigest(relevantArticles, hitKeywordsWithCount, articleKeywordMap, config, start, end, returnHtmlOnly = false, daysWindow = 7) {
  const { selectedTopN } = rankAndSelectArticles(relevantArticles, config, articleKeywordMap, hitKeywordsWithCount);
  Logger.log(`週間ダイジェスト：選抜された記事は ${selectedTopN.length} 件です。`);
  const articlesGroupedByKeyword = {};
  hitKeywordsWithCount.forEach(kwItem => {
    articlesGroupedByKeyword[kwItem.keyword] = selectedTopN.filter(article => {
      const keywords = articleKeywordMap.get(article.url);
      return keywords && keywords.includes(kwItem.keyword);
    });
  });
  const { reportBody } = generateWeeklyReportWithLLM(selectedTopN, hitKeywordsWithCount, articlesGroupedByKeyword);
  const headerLine = "集計期間：" + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1));
  let keywordSection = "";
  if (hitKeywordsWithCount && hitKeywordsWithCount.length > 0) {
    keywordSection = "\n\n### 今週の注目キーワード\n";
    hitKeywordsWithCount.forEach(item => {
      keywordSection += `- **${item.keyword}** (${item.count}件)\n`;
    });
    keywordSection += "\n\n---\n\n";
  }
  const fullMdBody = keywordSection + reportBody;
  const htmlHeader = headerLine.replace(/\n/g, '<br>');
  const htmlContent = markdownToHtml(fullMdBody);
  const fullHtmlBody = `<div style="font-family: Meiryo, 'Hiragino Sans', 'MS PGothic', sans-serif; font-size: 14px; line-height: 1.7; color: #333;">${htmlHeader}<br><br>${htmlContent}</div>`;
  if (returnHtmlOnly) return fullHtmlBody;
  if (config.notifyChannel === "email" || config.notifyChannel === "both") {
    sendWeeklyDigestEmail(headerLine, reportBody, hitKeywordsWithCount, daysWindow); 
  }
}


/**
 * _generateAndSendDailyDigest
 * 【責務】日刊ダイジェスト生成・メール送信（全記事対象、キーワード不要）
 * 【処理流程】
 *   1. 全記事を文字列化
 *   2. LLM でトピック抽出・要約生成（MINI モデル）
 *   3. 結果を Trendsシート に記録
 *   4. メール送信
 * 【LLM戦略】Azure > OpenAI > Gemini フォールバック
 * 【引数】
 *   - allArticles : 全記事配列（フィルタリングなし）
 *   - config : digest設定
 *   - start, end : 集計期間
 *   - daysWindow : 1（日刊固定）
 * @param {Array} allArticles - 全記事配列
 * @param {Object} config - ダイジェスト設定
 * @param {Date} start - 集計開始日時
 * @param {Date} end - 集計終了日時
 * @param {number} daysWindow - 1（日刊）
 * @returns {none}
 */
/**
 * _generateAndSendDailyDigest (改良版: バッチ処理対応)
 * 記事数が多い場合、分割して中間要約を作成し、最後に統合する
 */
/**
 * _generateAndSendDailyDigest (改良版: URL保持・バッチ処理強化)
 * 記事数が多い場合、分割して中間要約を作成し、最後に統合する
 * ★修正点: 中間要約と最終統合プロンプトで「記事URL」を維持するよう指示を追加
 */
function _generateAndSendDailyDigest(allArticles, config, start, end, daysWindow) {
  const digestSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.TRENDS);
  const [systemPromptTemplate, userPromptTemplate] = getDailyDigestPrompts();

  let reportBody = "";
  const BATCH_SIZE = 30; 

  if (allArticles.length <= BATCH_SIZE) {
    // --- 通常処理（記事数が少ない場合） ---
    const articleListText = formatArticlesForLlm(allArticles);
    // ユーザープロンプト内のプレースホルダーを置換
    // (linksPerTopic はプロンプト内で使われている前提で、もし変数がなければ数値を直接埋め込む形でも可)
    let userPrompt = userPromptTemplate.replace(/\$\{all_articles_in_date_window\}/g, articleListText);
    userPrompt = userPrompt.replace(/\$\{linksPerTopic\}/g, "3"); 
    
    reportBody = callDailyDigestLlm(systemPromptTemplate, userPrompt);
  } 
  else {
    // --- 分割処理（記事数が多い場合） ---
    Logger.log(`記事数が多いため(${allArticles.length}件)、分割処理を実行します。`);
    
    const batchSummaries = [];
    for (let i = 0; i < allArticles.length; i += BATCH_SIZE) {
      const batch = allArticles.slice(i, i + BATCH_SIZE);
      const articleListText = formatArticlesForLlm(batch);
      
      // ★修正: 中間要約でもURLリストを出力させる
      const batchPrompt = `
以下の記事リストから、主要なトピックを3〜5個抽出し、箇条書きで要約してください。
【重要】後で統合するため、各トピックの末尾には、その根拠となった記事の「タイトル」と「URL」を必ず記載してください。

出力形式:
- トピック概要...
  - 根拠記事: [記事タイトル](URL)

【記事リスト】
${articleListText}
`;
      const batchResult = callDailyDigestLlm(systemPromptTemplate, batchPrompt); 
      batchSummaries.push(batchResult);
      Utilities.sleep(1000); 
    }

    // ★修正: 最終統合時にURLリストを再構築させる
    const finalPrompt = `
以下は、今日の大量のニュース記事をいくつかのブロックに分けて要約したものです（根拠記事のリンク付き）。
これらを統合し、重複を整理して、今日全体の「日刊ダイジェスト」を作成してください。

【重要指示】
1. 全体の流れがわかるように構成し、重要なトピックについては深掘りして解説してください。
2. 各トピックの最後には、必ず「関連記事リスト」として、中間要約に含まれていた記事リンク（[タイトル](URL)）を3つ程度記載してください。**URLを省略しないでください。**
3. 出力は以下のMarkdown形式で行ってください。

### **トピック名称**
解説文...
**関連記事:**
- [記事タイトル](URL)
- [記事タイトル](URL)

【中間要約リスト】
${batchSummaries.join("\n\n---\n\n")}
`;
    reportBody = callDailyDigestLlm(systemPromptTemplate, finalPrompt);
  }

  // 結果の保存とメール送信（既存コードと同じ）
  try {
    const writeData = [
      new Date(), "日刊ダイジェスト", start, end, 
      "Topics (All Articles)", reportBody, allArticles.length
    ];
    digestSheet.appendRow(writeData);
  } catch(e) { /* エラー処理 */ }

  const headerLine = `集計期間：${fmtDate(start)}〜${fmtDate(new Date(end.getTime() - 1))} (全${allArticles.length}記事)`;
  sendWeeklyDigestEmail(headerLine, reportBody, null, daysWindow);
}

/**
 * ヘルパー関数: 記事リストの整形 (AI見出し優先)
 */
function formatArticlesForLlm(articles) {
  return articles.map(a => {
    // AI見出し(headline)があれば優先、なければ抜粋、なければタイトル
    const content = a.headline && a.headline.length > 10 ? a.headline : (a.abstractText || a.title);
    return `・タイトル: ${a.title}\n  内容: ${content}\n  URL: ${a.url}`;
  }).join('\n\n');
}

/**
 * callDailyDigestLlm
 * 【責務】日刊ダイジェスト専用 LLM 呼び出し（フォールバック付き）
 * 【モデル】MINI (gpt-4.1-mini) ← 高次分析用
 * 【LLM戦略】Azure > OpenAI > Gemini
 * 【用途】日刊・週刊の高度な分析・まとめ生成
 * @param {string} systemPrompt - システムプロンプト（指示）
 * @param {string} userPrompt - ユーザープロンプト（入力データ）
 * @returns {string} LLMからの回答（エラーメッセージ含む）
 */
function callDailyDigestLlm(systemPrompt, userPrompt) {
  const llmConfig = AppConfig.get().Llm;

  const openAiModelDaily = llmConfig.ModelMini;
  const azureDailyUrl = llmConfig.AzureUrlMini;

  // 既存のフォールバックラッパーをそのまま利用
  const result = callLlmWithFallback(systemPrompt, userPrompt, openAiModelDaily, azureDailyUrl);

  // 返却は文字列（エラー文言含む）
  return result;
}

/**
 * getDailyDigestPrompts
 * 【責務】promptシートから日刊ダイジェスト用プロンプト取得
 * 【キー】'DAILY_DIGEST_SYSTEM', 'DAILY_DIGEST_USER'
 * @param {none}
 * @returns {Array} [systemPrompt, userPrompt]
 * @throws プロンプト設定が不完全な場合
 */
function getDailyDigestPrompts() {
  const promptSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.PROMPT_CONFIG);
  if (!promptSheet) throw new Error("promptシートが見つかりません。");

  // A列: キー, B列: プロンプト内容
  const data = promptSheet.getDataRange().getValues();
  const prompts = {};
  
  // 2行目から最終行までを走査し、キーとB列の内容をマップに格納
  for (let i = 1; i < data.length; i++) {
    const key = data[i][0];
    const promptContent = data[i][1]; // ★ B列を参照
    if (key && promptContent) {
      // String(promptContent).trim() で確実に文字列として格納
      prompts[key.trim()] = String(promptContent).trim();
    }
  }

  // 新しいキーでプロンプトを取得
  const systemKey = 'DAILY_DIGEST_SYSTEM';
  const userKey = 'DAILY_DIGEST_USER';
  
  const systemPrompt = prompts[systemKey];
  const userPrompt = prompts[userKey];

  if (!systemPrompt || !userPrompt) {
      Logger.log(`警告: 日刊ダイジェストのプロンプト設定が不完全です。不足キー: ${!systemPrompt ? systemKey : ''} ${!userPrompt ? userKey : ''}`);
      throw new Error("プロンプトシートにキー 'DAILY_DIGEST_SYSTEM' と 'DAILY_DIGEST_USER' の両方の設定を追加してください。");
  }
  
  return [systemPrompt, userPrompt];
}

/**
 * _handleNoArticlesFound
 * 【責務】対象記事がない場合の通知処理（メール送信）
 * 【用途】日刊・週刊の両方で、記事なしエラー時に呼び出し
 * @param {Object} config - digest設定
 * @param {Date} start - 集計開始日時
 * @param {Date} end - 集計終了日時
 * @param {string} message - ログメッセージ
 * @param {number} daysWindow - 1=日刊, 7=週刊（メッセージ切り替え用）
 * @returns {none}
 */
function _handleNoArticlesFound(config, start, end, message, daysWindow = 7) { 
  Logger.log(`ダイジェスト：${message}`);

  const headerLine = "集計期間：" + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1));
  
  // メッセージを日刊/週刊で切り替え
  const reportBody = daysWindow === 1 ? "本日のダイジェスト対象となる記事はありませんでした。" : "今週のダイジェスト対象となる記事はありませんでした。";
  
  if (config.notifyChannel === "email" || config.notifyChannel === "both") {
    // daysWindowを渡す
    sendWeeklyDigestEmail(headerLine, reportBody, null, daysWindow);
  }
}

/**
 * rankAndSelectArticles
 * 【責務】記事をスコア付けして上位N件を選抜
 * 【スコア計算】キーワードマッチ度 + 新鮮度 + 抜粋長
 * @param {Array} relevantArticles - 候補記事配列
 * @param {Object} config - topN設定を含む config
 * @param {Map} articleKeywordMap - URL→キーワード配列の Map
 * @returns {Object} { selectedTopN: 選抜記事配列 }
 */
/**
 * rankAndSelectArticles (シンプル版: 各キーワードにTOP Nを割り当て)
 * 【責務】キーワードごとに設定値(TOP N)ぶんの記事枠を確保する
 * 【特徴】全体の上限リミットを撤廃。キーワード数 × N件 が最大となる。
 */
function rankAndSelectArticles(relevantArticles, config, articleKeywordMap, hitKeywordsWithCount) {
  
  // ★設定値 (DIGEST_TOP_N) を「キーワードごとの上限」として使う
  // 設定がない場合はデフォルト20件
  const LIMIT_PER_KEYWORD = config.topN || 20;
  
  const selectedArticlesMap = new Map(); 

  // 1. まず全記事のスコアを計算しておく
  const scoredArticles = relevantArticles.map(a => ({
    ...a,
    heuristicScore: computeHeuristicScore(a, articleKeywordMap)
  }));

  // 2. キーワードごとにループして、それぞれ上位 N 件を確保
  const keywords = hitKeywordsWithCount || [];
  
  keywords.forEach(kwItem => {
    const keyword = kwItem.keyword;

    // このキーワードに関連する記事だけを抽出
    const articlesForThisKeyword = scoredArticles.filter(a => {
      const kws = articleKeywordMap.get(a.url);
      return kws && kws.includes(keyword);
    });

    // スコア順に並び替え
    articlesForThisKeyword.sort((a, b) => b.heuristicScore - a.heuristicScore);

    // ★各キーワードの上位 N 件を取得
    const candidates = articlesForThisKeyword.slice(0, LIMIT_PER_KEYWORD);

    // 選抜リストに追加（URLで重複排除しながら統合）
    candidates.forEach(a => {
      if (!selectedArticlesMap.has(a.url)) {
        selectedArticlesMap.set(a.url, a);
      }
    });
  });

  // 3. 全体リミットによる足切りは行わず、統合した結果をそのまま返す
  const selectedArticles = Array.from(selectedArticlesMap.values());

  return { selectedTopN: selectedArticles };
}

/**
 * calculateLevenshteinSimilarity
 * 【責務】2つの文字列の類似度(0.0〜1.0)を計算 (レーベンシュタイン距離ベース)
 */
function calculateLevenshteinSimilarity(s1, s2) {
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  const longerLength = longer.length;
  if (longerLength === 0) return 1.0;
  
  // 編集距離計算
  const costs = new Array();
  for (let i = 0; i <= longer.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= shorter.length; j++) {
      if (i == 0) costs[j] = j;
      else {
        if (j > 0) {
          let newValue = costs[j - 1];
          if (longer.charAt(i - 1) != shorter.charAt(j - 1)) newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
    }
    if (i > 0) costs[shorter.length] = lastValue;
  }
  
  return (longerLength - costs[shorter.length]) / longerLength;
}

/**
 * generateWeeklyReportWithLLM
 * 【責務】LLM でトレンドセクション生成（キーワード毎）
 * 【処理】_llmMakeTrendSections ラッパー
 * @param {Array} articles - 選抜記事配列
 * @param {Array} hitKeywordsWithCount - キーワード毎ヒット数
 * @param {Object} articlesGroupedByKeyword - キーワード→記事配列 の Object
 * @returns {Object} { reportBody: Markdown本文 }
 */
function generateWeeklyReportWithLLM(articles, hitKeywordsWithCount, articlesGroupedByKeyword) {
  const LINKS_PER_TREND = 3;
  const hitKeywords = hitKeywordsWithCount.map(item => item.keyword);
  const trends = _llmMakeTrendSections(articlesGroupedByKeyword, LINKS_PER_TREND, hitKeywords);
  return { reportBody: trends };
}

/**
 * getArticlesInDateWindow
 * 【責務】collect シートから指定期間内の記事を抽出
 * 【フィルタ】
 *   - 日付が範囲内
 *   - E列（見出し）が存在＆空でない＆エラーでない
 * @param {Date} start - 開始日時（含む）
 * @param {Date} end - 終了日時（含まない）
 * @returns {Array} 記事配列 ({ date, title, url, abstractText, headline, source })
 */
function getArticlesInDateWindow(start, end) {
  const sh = SpreadsheetApp.getActive().getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const vals = sh.getRange(2, 1, lastRow - 1, AppConfig.get().CollectSheet.Columns.SOURCE).getValues();
  const out = [];
  for (const r of vals) {
    const date = r[0];
    if ((date instanceof Date) && date >= start && date < end) {
      const headline = r[4];
      if (headline && String(headline).trim() !== "" && String(headline).indexOf("API Error") === -1) {
        out.push({ date: date, title: r[1], url: r[2], abstractText: r[3], headline: String(headline).trim(), source: r[5] ? String(r[5]) : "", tldr: String(headline).trim() });
      }
    }
  }
  out.sort((a, b) => a.date - b.date);
  return out;
}

/**
 * sendWeeklyDigestEmail
 * 【責務】ダイジェストメール送信（日刊・週刊両対応）
 * 【仕様】
 *   - Markdown→HTML変換してリッチメール送信
 *   - プレフィックスを daysWindow で自動切り替え（「日刊RSS」 or 「週間RSS」）
 *   - キーワード注記セクション含む
 * @param {string} headerLine - ヘッダー（期間表示）
 * @param {string} mdBody - Markdown本文
 * @param {Array} hitKeywordsWithCount - キーワード毎ヒット数（null可）
 * @param {number} daysWindow - 1=日刊, 7=週刊（メール件名・本文用）
 * @returns {none}
 */
/**
 * sendWeeklyDigestEmail (修正版: 件名にキーワードを追加)
 */
function sendWeeklyDigestEmail(headerLine, mdBody, hitKeywordsWithCount, daysWindow = 7) {
  const digestConfig = AppConfig.get().Digest;
  
  const to = getRecipients(); 
  
  if (!to) { 
    Logger.log("配信先(MAIL_TO または Usersシート)が設定されていないためメール送信しません。"); 
    return; 
  }
  
  // プレフィックスを動的に変更
  const prefixBase = daysWindow === 1 ? "日刊" : "週間";
  const subjectPrefix = digestConfig.mailSubjectPrefix || `【${prefixBase}TrendNEWS】`;
  const senderName = digestConfig.mailSenderName;
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd");
  const sheetUrl = digestConfig.sheetUrl;

  // ★追加: ヒットしたキーワードを件名用の文字列にする
  let keywordSubjectPart = "";
  if (hitKeywordsWithCount && hitKeywordsWithCount.length > 0) {
    // 複数のキーワードがある場合は「,」で区切る（例: "AI, Python"）
    const kwList = hitKeywordsWithCount.map(item => item.keyword).join(", ");
    // 件名用に整形（例: " [AI, Python]"）
    keywordSubjectPart = ` [${kwList}]`;
  }

  // ★変更: 件名にキーワードを含める
  // 例: 【週間RSS】 [AI, Python] 2025/12/18
  const finalSubject = subjectPrefix + keywordSubjectPart + " " + today;

  let keywordSection = "";
  if (hitKeywordsWithCount && hitKeywordsWithCount.length > 0) {
    keywordSection = "\n\n### 今週の注目キーワード\n";
    hitKeywordsWithCount.forEach(item => {
      keywordSection += `- **${item.keyword}** (${item.count}件)\n`;
    });
    keywordSection += "\n\n---\n\n";
  }
  
  const fullMdBody = keywordSection + mdBody + `\n\n---\nその他の記事一覧は[こちらのスプレッドシート](${sheetUrl})でご覧いただけます。`;
  const textBody = headerLine + "\n\n" + fullMdBody;
  
  const htmlHeader = headerLine.replace(/\n/g, '<br>');
  const htmlContent = markdownToHtml(fullMdBody);
  const fullHtmlBody = `<div style="font-family: Meiryo, 'Hiragino Sans', 'MS PGothic', sans-serif; font-size: 14px; line-height: 1.7; color: #333;">${htmlHeader}<br><br>${htmlContent}</div>`;
  
  GmailApp.sendEmail(to, finalSubject, textBody, { name: senderName, htmlBody: fullHtmlBody });
  Logger.log(`メール送信（${prefixBase}ダイジェスト）完了: ${to} / 件名: ${finalSubject}`);
}

/**
 * ================================================================================
 * SECTION 3: TREND DETECTION
 * ================================================================================
 * トレンド検出・分析の関数群。
 * 日次の重要キーワード抽出、過去データとの比較、変化率計算、結果記録。
 * ================================================================================
 */

/**
 * detectAndRecordTrends
 * 【責務】日次トレンド検出・記録のエントリポイント
 * 【処理流程】
 *   1. 過去1日分の記事タイトル を取得
 *   2. LLM (NANO) でキーワード抽出
 *   3. 過去7日分の Trendsシート から履歴を取得
 *   4. 出現回数＆新規/既出判定でスコア計算
 *   5. Trendsシート に書き込み
 * 【制御】TREND_DETECTION_ENABLED=true でのみ実行
 * 【副作用】Trendsシート更新、LLM API呼び出し（1回）
 * @param {none}
 * @returns {none}
 */
function detectAndRecordTrends() {
  const trendConfig = AppConfig.get().Trend;
  if (!trendConfig.detectionEnabled) {
    Logger.log("トレンド検出機能は無効化されています。スキップします。");
    return;
  }
  Logger.log("--- トレンド検出処理開始 ---");
  const articles = getArticlesForTrendAnalysis(1);
  if (articles.length === 0) {
    Logger.log("トレンド分析の対象となる記事がありませんでした。");
    return;
  }
  const titles = articles.map(a => a.title).join("\n");
  const keywords = extractKeywordsWithLLM(titles);
  if (!keywords || keywords.length === 0) {
    Logger.log("LLMによるキーワード抽出に失敗したか、キーワードが見つかりませんでした。");
    return;
  }
  Logger.log(`LLMにより ${keywords.length} 個のキーワードが抽出されました。`);
  const historicalData = getHistoricalTrendData();
  const trends = calculateTrendScores(keywords, historicalData);
  if (trends.length === 0) {
    Logger.log("トレンドキーワードが見つかりませんでした。");
    return;
  }
  Logger.log(`${trends.length} 件のキーワードを検出し、スコアを計算しました。`);
  writeTrendsToSheet(trends);
  Logger.log("--- トレンド検出処理完了 ---");
}
/**
 * getArticlesForTrendAnalysis
 * 【責務】トレンド分析対象期間の記事タイトルを取得
 * @param {number} days - 日数（通常 1）
 * @returns {Array} { date, title } 配列
 */
function getArticlesForTrendAnalysis(days) {
  const { start, end } = getDateWindow(days);
  const sh = SpreadsheetApp.getActive().getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const vals = sh.getRange(2, 1, lastRow - 1, 2).getValues();
  const out = [];
  for (const r of vals) {
    const date = r[0];
    if ((date instanceof Date) && date >= start && date < end) {
      out.push({ date: date, title: r[1] });
    }
  }
  return out;
}
/**
 * getHistoricalTrendData
 * 【責務】Trendsシートから過去N日のキーワード履歴を取得
 * 【用途】本日のキーワードが既出か新規かを判定するため
 * @param {number} days - 遡り日数（デフォルト 7）
 * @returns {Map} キーワード→true の Map（存在確認用）
 */
function getHistoricalTrendData(days = 7) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.TRENDS);
  if (!sheet || sheet.getLastRow() < 2) return new Map();
  
  const historicalKeywords = new Map();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - days);
  
  // B列（キーワード）のみを取得
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  for (const row of data) {
    const date = new Date(row[0]);
    date.setHours(0, 0, 0, 0);
    const keyword = String(row[1]).trim();
    
    if (date >= startDate && date < today && keyword) {
      historicalKeywords.set(keyword, true);  // キーワードの存在を記録
    }
  }
  
  return historicalKeywords;
}
/**
 * calculateTrendScores
 * 【責務】本日キーワードのスコア計算＆ホット判定
 * 【判定ロジック】
 *   - 新規キーワード：🆕 New
 *   - 既出キーワード：✓ 既出
 *   - ホット判定：出現回数 ≥ 2 ならホット
 * @param {Array} todayKeywords - 本日抽出キーワード配列
 * @param {Map} historicalKeywords - 過去キーワード Map
 * @returns {Array} トレンド配列 ({ keyword, count, changeRate, relatedArticles, summary, isHot })
 */
function calculateTrendScores(todayKeywords, historicalKeywords) {
  const todayCounts = new Map();
  todayKeywords.forEach(kw => {
    todayCounts.set(kw, (todayCounts.get(kw) || 0) + 1);
  });
  
  const trends = [];
  for (const [keyword, count] of todayCounts.entries()) {
    let changeRateDisplay = "🆕 New";
    let isHot = false;
    
    // 過去7日分のキーワード一覧にこのキーワードが存在するかチェック
    const isRecurring = historicalKeywords.has(keyword);
    
    if (isRecurring) {
      changeRateDisplay = "✓ 既出";
      // 既出かつ出現回数が2回以上ならホット
      isHot = count >= 2;
    } else {
      // 新規キーワード
      changeRateDisplay = "🆕 New";
      // 新規で出現回数が2回以上ならホット
      isHot = count >= 2;
    }
    
    trends.push({
      keyword: keyword,
      count: count,
      changeRate: changeRateDisplay,  // 既出/新規の区別
      relatedArticles: count,
      summary: "",
      isHot: isHot
    });
  }
  return trends;
}

/**
 * writeTrendsToSheet
 * 【責務】トレンド情報を Trendsシート に書き込み
 * 【仕様】
 *   - A: 日付, B: キーワード, C: 日本語訳（GOOGLETRANSLATE数式）
 *   - D: 出現回数, E: 変化率（新規/既出）, F: 関連記事数, G: 要約
 *   - 既存キーワード（本日同日付）：出現回数を加算
 *   - 新規キーワード：新規行追加
 *   - 最後にD列（出現回数）で降順ソート
 * @param {Array} trends - トレンド配列
 * @returns {none}
 */
function writeTrendsToSheet(trends) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.TRENDS);
  if (!sheet) {
    Logger.log("エラー: Trendsシートが見つかりません。");
    return;
  }
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTimeMs = today.getTime();
  
  const lastRow = sheet.getLastRow();
  
  // 本日の日付で既に存在するキーワード行を取得
  const todayData = new Map();
  if (lastRow >= 2) {
    const existingData = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (let i = 0; i < existingData.length; i++) {
      let date = existingData[i][0];
      // Date オブジェクトではなく、シリアル値の場合はそのまま使用
      if (!(date instanceof Date)) {
        date = new Date(date);
      }
      date.setHours(0, 0, 0, 0);
      const keyword = String(existingData[i][1]).trim();
      
      if (date.getTime() === todayTimeMs) {
        todayData.set(keyword, i + 2); // シート行番号（1-indexed）
      }
    }
  }
  
  // 新規キーワードと既存キーワードを分類
  const newKeywords = [];
  const updateKeywords = [];
  for (const trend of trends) {
    if (todayData.has(trend.keyword)) {
      updateKeywords.push({ trend, rowIndex: todayData.get(trend.keyword) });
    } else {
      newKeywords.push(trend);
    }
  }
  
  // 既存キーワードの出現回数を更新
  for (const { trend, rowIndex } of updateKeywords) {
    const currentCount = sheet.getRange(rowIndex, 4).getValue();
    const newCount = currentCount + trend.count;
    sheet.getRange(rowIndex, 4).setValue(newCount);  // D列（出現回数）を加算
    sheet.getRange(rowIndex, 5).setValue(trend.changeRate);  // E列（変化率）を更新
  }
  
  // 新規キーワードを追加
  if (newKeywords.length > 0) {
    const newRows = newKeywords.map((t, i) => {
      const rowIndex = lastRow + i + 1;
      const formula = `=IF(B${rowIndex}="","",GOOGLETRANSLATE(B${rowIndex},"en","ja"))`;
      return [new Date(), t.keyword, formula, t.count, t.changeRate, t.relatedArticles, t.summary];
    });
    sheet.insertRowsAfter(lastRow, newRows.length);
    sheet.getRange(lastRow + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
  }
  
  // D列（出現回数）を降順でソートして、頻出度が高い順に表示する
  const finalLastRow = sheet.getLastRow();
  if (finalLastRow > 2) {
    sheet.getRange(2, 1, finalLastRow - 1, sheet.getLastColumn()).sort({ column: 4, ascending: false });
  }
  
  // 処理完了ログ（サマリーのみ）
  Logger.log(`トレンド追記完了: 新規${newKeywords.length}件、更新${updateKeywords.length}件`);
}

/**
 * ================================================================================
 * SECTION 4: LLM SERVICE LAYER
 * ================================================================================
 * LLM呼び出しに関する全てのロジックを集約したサービスモジュール。
 * 外部からはこのサービスを通じて、目的別の抽象化されたメソッドを呼び出す。
 * (例: LlmService.summarize(text))
 */
const LlmService = (function() {
  const llmConfig = AppConfig.get().Llm;

  // --- Private Methods ---

  function _callAzureLlm(systemPrompt, userPrompt, azureUrl, azureKey, options = {}) {
    Logger.log("Azure OpenAIを試行中...");
    const payload = { messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: options.temperature ?? 0.2, max_completion_tokens: 2048 };
    const fetchOptions = { method: "post", contentType: "application/json", headers: { "api-key": azureKey }, payload: JSON.stringify(payload), muteHttpExceptions: true };
    try {
      const res = UrlFetchApp.fetch(azureUrl, fetchOptions);
      const code = res.getResponseCode();
      const txt = res.getContentText();
      if (code !== 200) {
        _logError("_callAzureLlm", new Error(`API Error: ${code} - ${txt}`), "Azure OpenAI APIエラーが発生しました。");
        return null;
      }
      const json = JSON.parse(txt);
      if (json && json.choices && json.choices.length > 0 && json.choices[0].message && json.choices[0].message.content) {
        return String(json.choices[0].message.content).trim();
      }
      _logError("_callAzureLlm", new Error("No content in response"), "Azure OpenAIから見出しが生成できませんでした。");
      return null;
    } catch (e) {
      _logError("_callAzureLlm", e, "Azure OpenAI呼び出し中に例外が発生しました。");
      return null;
    }
  }

  function _callOpenAiLlm(systemPrompt, userPrompt, openAiModel, openAiKey, options = {}) {
    Logger.log("OpenAI APIを試行中...");
    const payload = { model: openAiModel, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], max_tokens: 2048, temperature: options.temperature ?? undefined };
    const fetchOptions = { method: "post", contentType: "application/json", headers: { "Authorization": `Bearer ${openAiKey}` }, payload: JSON.stringify(payload), muteHttpExceptions: true };
    try {
      const res = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", fetchOptions);
      const code = res.getResponseCode();
      const txt = res.getContentText();
      if (code !== 200) {
        _logError("_callOpenAiLlm", new Error(`API Error: ${code} - ${txt}`), "OpenAI APIエラーが発生しました。");
        return null;
      }
      const json = JSON.parse(txt);
      if (json.choices && json.choices.length > 0 && json.choices[0].message && json.choices[0].message.content) {
        return String(json.choices[0].message.content).trim();
      }
      _logError("_callOpenAiLlm", new Error("No content in response"), "OpenAIから見出しが生成できませんでした。");
      return null;
    } catch (e) {
      _logError("_callOpenAiLlm", e, "OpenAI呼び出し中に例外が発生しました。");
      return null;
    }
  }
  
  function _callGeminiLlm(systemPrompt, userPrompt, geminiApiKey, options = {}) {
    Logger.log("Gemini APIを試行中...");
    const API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/" + llmConfig.MODEL_NAME + ":generateContent?key=" + geminiApiKey;
    const PROMPT = (systemPrompt || "") + "\n\n" + (userPrompt || "");
    const payload = { contents: [{ parts: [{ text: PROMPT }] }], generationConfig: { temperature: options.temperature ?? 0.2, maxOutputTokens: 2048 } };
    const fetchOptions = { method: "post", contentType: "application/json", payload: JSON.stringify(payload), muteHttpExceptions: true };
    try {
      const response = UrlFetchApp.fetch(API_ENDPOINT, fetchOptions);
      const json = JSON.parse(response.getContentText());
      let text = null;
      if (json && json.candidates && json.candidates.length > 0 && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts.length > 0) {
        text = json.candidates[0].content.parts[0].text;
      }
      const headline = text ? String(text).trim() : (json && json.error ? ("API Error: " + json.error.message) : "見出しが生成できませんでした。");
      Utilities.sleep(llmConfig.DELAY_MS);
      return headline;
    } catch (e) {
      _logError("_callGeminiLlm", e, "Gemini API呼び出し中に例外が発生しました。");
      return null;
    }
  }

  function _callLlmWithFallback(systemPrompt, userPrompt, openAiModel, azureUrlOverride = null, options = {}) {
    const llmProps = llmConfig; // AppConfigから取得済みの設定を利用
    let model = openAiModel;
    if (openAiModel === "nano" || openAiModel === "mini") {
      model = openAiModel === "mini" ? llmProps.ModelMini : llmProps.ModelNano;
    }
    const azureUrl = azureUrlOverride || (model && model.includes("mini") ? llmProps.AzureUrlMini : llmProps.AzureUrlNano);
    const context = llmProps.Context;
    let result = null;

    if (context === 'PERSONAL') {
      if (llmProps.OpenAiKey) {
        result = _callOpenAiLlm(systemPrompt, userPrompt, model, llmProps.OpenAiKey, options);
        if (result !== null) return result;
        Logger.log("OpenAI API(個人)での呼び出しに失敗しました。Azure OpenAIを試行します。");
      }
      if (azureUrl && llmProps.AzureKey) {
        result = _callAzureLlm(systemPrompt, userPrompt, azureUrl, llmProps.AzureKey, options);
        if (result !== null) return result;
        Logger.log("Azure OpenAIでの呼び出しに失敗しました。Gemini APIを試行します。");
      }
    } else {
      if (azureUrl && llmProps.AzureKey) {
        result = _callAzureLlm(systemPrompt, userPrompt, azureUrl, llmProps.AzureKey, options);
        if (result !== null) return result;
        Logger.log("Azure OpenAIでの呼び出しに失敗しました。OpenAI API(個人)を試行します。");
      }
      if (llmProps.OpenAiKey) {
        result = _callOpenAiLlm(systemPrompt, userPrompt, model, llmProps.OpenAiKey, options);
        if (result !== null) return result;
        Logger.log("OpenAI API(個人)での呼び出しに失敗しました。Gemini APIを試行します。");
      }
    }

    if (llmProps.GeminiKey) {
      result = _callGeminiLlm(systemPrompt, userPrompt, llmProps.GeminiKey, options);
      if (result !== null) return result;
      Logger.log("Gemini APIでの呼び出しに失敗しました。");
    }
    return "いずれのLLMでも見出しを生成できませんでした。";
  }

  // --- Public Methods ---
  return {
    /**
     * 記事テキストをLLMで要約（見出し生成）
     */
    summarize: function(articleText) {
      const model = llmConfig.ModelNano;
      const SYSTEM = getPromptConfig("BATCH_SYSTEM");
      const USER_TEMPLATE = getPromptConfig("BATCH_USER_TEMPLATE");
      if (!SYSTEM || !USER_TEMPLATE) return "エラー: BATCHプロンプト設定が見つかりません。";
      const USER = USER_TEMPLATE + ["", "記事: ---", articleText, "---"].join("\n");
      return _callLlmWithFallback(SYSTEM, USER, model);
    },

    /**
     * テキスト群からLLMで重要キーワード抽出
     */
    extractKeywords: function(text) {
      const model = llmConfig.ModelNano;
      const SYSTEM = getPromptConfig("TREND_KEYWORD_SYSTEM") || "以下のテキスト群から、重要と思われる技術、製品、イベントなどのキーワード（名詞）を最大50個、重複を除いてリストアップしてください。各キーワードは改行で区切って、リスト形式でのみ出力してください。前書きや後書きは不要です。";
      const USER = text;
      const result = _callLlmWithFallback(SYSTEM, USER, model);
      if (result && !result.includes("エラー")) {
        return result.split('\n').map(kw => kw.trim()).filter(kw => kw);
      }
      return null;
    },

// LlmService 内の generateTrendSections を更新

    /**
     * generateTrendSections (改良版)
     * 【改良点】抜粋(Abstract)の代わりにAI見出し(Headline)を使用し、トークンを節約
     */
    generateTrendSections: function(articlesGroupedByKeyword, linksPerTrend, hitKeywords) {
      const model = llmConfig.ModelMini;
      const azureWeeklyUrl = llmConfig.AzureUrlMini;
      const SYSTEM = getPromptConfig("TREND_SYSTEM");
      const USER_TEMPLATE = getPromptConfig("TREND_USER_TEMPLATE");
      
      if (!SYSTEM || !USER_TEMPLATE) {
        return "プロンプト設定エラー";
      }

      const allTrends = [];
      
      for (const keyword of hitKeywords) {
        const articles = articlesGroupedByKeyword[keyword];
        if (!articles || articles.length === 0) continue;

        // ★ここが変更点: 入力データを圧縮
        // 記事の「要約」として、D列(Abstract)ではなくE列(Headline/tldr)を優先使用する
        // これによりトークン消費量を大幅に削減
        const articleListForLlm = articles.map(a => {
          // AI見出しがあればそれを、なければ抜粋、それもなければタイトルを使用
          const summaryContent = a.headline && a.headline.length > 10 ? a.headline : (a.abstractText || a.title);
          return `- タイトル: ${a.title}\n  要点: ${summaryContent}\n  URL: ${a.url}`;
        }).join("\n\n");

        const keywordHeader = `キーワード「${keyword}」\n`;
        
        // 記事数が多すぎる場合(例: 40件超)は、分割処理のロジックを入れるか、
        // 上記 rankAndSelectArticles で既に絞られている前提でそのまま送る。
        
        const user = [
          USER_TEMPLATE,
          `対象キーワード: ${keyword}`,
          "",
          "【分析対象記事リスト】",
          articleListForLlm
        ].join("\n");

        const txt = _callLlmWithFallback(SYSTEM, user, model, azureWeeklyUrl);
        
        if (txt && txt.trim()) {
          allTrends.push(keywordHeader + txt.trim());
        }
      }
      return allTrends.join("\n\n---\n\n");
    },
    
    /**
     * 日刊ダイジェスト専用 LLM 呼び出し
     */
    generateDailyDigest: function(systemPrompt, userPrompt) {
        const model = llmConfig.ModelMini;
        const azureDailyUrl = llmConfig.AzureUrlMini;
        return _callLlmWithFallback(systemPrompt, userPrompt, model, azureDailyUrl);
    },
    
    /**
     * WebUIからのキーワード分析
     */
    analyzeKeywordSearch: function(systemPrompt, contextText, options) {
        const model = llmConfig.ModelMini;
        const azureUrl = llmConfig.AzureUrlMini;
        return _callLlmWithFallback(systemPrompt, contextText, model, azureUrl, options);
    }
  };
})();

/**
 * summarizeWithLLM (ラッパー関数)
 * 【責務】記事テキストをLLMで要約（見出し生成）
 */
function summarizeWithLLM(articleText) {
  return LlmService.summarize(articleText);
}

/**
 * _llmMakeTrendSections (ラッパー関数)
 * 【責務】キーワード毎にLLMでトレンドセクション生成
 */
function _llmMakeTrendSections(articlesGroupedByKeyword, linksPerTrend, hitKeywords) {
  return LlmService.generateTrendSections(articlesGroupedByKeyword, linksPerTrend, hitKeywords);
}

/**
 * extractKeywordsWithLLM (ラッパー関数)
 * 【責務】テキスト群からLLMで重要キーワード抽出
 */
function extractKeywordsWithLLM(text) {
  return LlmService.extractKeywords(text);
}

/**
 * callDailyDigestLlm (ラッパー関数)
 * 【責務】日刊ダイジェスト専用 LLM 呼び出し
 */
function callDailyDigestLlm(systemPrompt, userPrompt) {
  return LlmService.generateDailyDigest(systemPrompt, userPrompt);
}

// callLlmWithFallback は LlmService の内部関数になったため、グローバルスコープからは削除されました


/**
 * ================================================================================
 * SECTION 5: UTILITIES & HELPERS
 * ================================================================================
 * 補助関数群：スプレッドシート操作、設定取得、テキスト変換、日付操作など。
 * ================================================================================
 */

/**
 * getWeightedKeywords
 * 【責務】Keywordsシートから有効キーワードを取得
 * @param {string} sheetName - シート名（デフォルト "Keywords"）
 * @returns {Array} { keyword, active } 配列
 */
/**
 * getWeightedKeywords (修正版: 曜日列対応)
 * 【責務】Keywordsシートから有効キーワードと配信曜日を取得
 * 【変更】C列(曜日)も読み込むように拡張
 */
function getWeightedKeywords(sheetName = "Keywords") {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  
  // ★変更: 3列目(C列)まで取得
  const values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  
  return values.map(([keyword, activeFlag, daySpec]) => ({
    keyword: String(keyword).trim(),
    active: String(activeFlag).trim() !== "",
    day: String(daySpec).trim() // ★追加: 曜日指定（例: "月", "水"）
  })).filter(obj => obj.keyword);
}

/**
 * getPromptConfig
 * 【責務】promptシートからプロンプトテンプレートを取得
 * @param {string} key - キー名（例："BATCH_SYSTEM", "DAILY_DIGEST_USER"）
 * @returns {string|null} プロンプト内容
 */
function getPromptConfig(key) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(AppConfig.get().SheetNames.PROMPT_CONFIG);
  if (!sheet) {
    Logger.log(`エラー: promptシートが見つかりません。キー: ${key}`);
    return null;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const values = sheet.getRange(1, 1, lastRow, 2).getValues();
  const promptMap = new Map(values.map(row => [String(row[0]).trim(), row[1]]));
  const content = promptMap.get(key);
  if (!content) {
    Logger.log(`警告: promptシートにキー ${key} が見つかりませんでした。`);
    return null;
  }
  return String(content).trim();
}

// _getDigestConfig は AppConfig に統合されたため削除されました

/**
 * computeHeuristicScore
 * 【責務】記事のスコア計算（キーワード数 + 新鮮度 + 抜粋長）
 * 【用途】rankAndSelectArticles() で上位N件選抜に使用
 * @param {Object} article - 記事オブジェクト
 * @param {Map} articleKeywordMap - URL→キーワード配列
 * @returns {number} スコア（0-100）
 */
function computeHeuristicScore(article, articleKeywordMap) {
  const now = new Date();
  const daysOld = Math.max(0, Math.floor((now - article.date) / (1000 * 60 * 60 * 24)));
  const matchedKeywords = articleKeywordMap.get(article.url) || [];
  const keywordScore = Math.min(40, matchedKeywords.length * 8);
  const freshnessScore = 40 * Math.exp(-daysOld / 7);
  const hasAbstract = article.abstractText && article.abstractText !== AppConfig.get().Llm.NO_ABSTRACT_TEXT;
  const abstractBonus = hasAbstract ? Math.min(20, String(article.abstractText).length / 100) : 0;
  const rawScore = keywordScore + freshnessScore + abstractBonus;
  return Math.max(0, Math.min(100, Math.round(rawScore)));
}

/**
 * markdownToHtml (改良版: メール向けリッチデザイン)
 * 【責務】Markdown → HTML 変換 (インラインCSS付き)
 * 【改善】メールでの可読性を高めるため、見出しや太字にスタイルを適用
 */
function markdownToHtml(md) {
  if (!md) return "";
  
  // スタイル定義
  const S = {
    H3: 'font-size: 18px; font-weight: bold; color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 5px; margin-top: 20px; margin-bottom: 10px;',
    STRONG: 'font-weight: bold; color: #e74c3c;', // 太字を少し赤みのある色で強調（お好みで変更可）
    LINK: 'color: #0066cc; text-decoration: none; border-bottom: 1px dotted #0066cc;',
    HR: 'border: 0; border-top: 1px solid #eee; margin: 20px 0;',
    UL: 'padding-left: 20px; margin: 10px 0;',
    LI: 'margin-bottom: 5px;'
  };

  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    
    // 見出し (###) -> H3 with style
    .replace(/^### (.*$)/gim, `<h3 style="${S.H3}">$1</h3>`)
    
    // 太字 (**) -> strong with style
    .replace(/\*\*(.*?)\*\*/g, `<strong style="${S.STRONG}">$1</strong>`)
    
    // リンク [text](url) -> a with style
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `<a href="$2" target="_blank" style="${S.LINK}">$1</a>`)
    
    // 水平線 (---)
    .replace(/^\s*---\s*$/gm, `<hr style="${S.HR}">`)
    
    // リスト ( - 箇条書き)
    // ※単純置換だと<ul>で囲めないため、簡易的に全行を変換しつつ、改行で表現
    .replace(/^- (.*$)/gim, `&bull; $1`)
    
    // 改行 -> <br>
    .replace(/\n/g, '<br>\n');

  return html;
}

/**
 * stripHtml
 * 【責務】HTML タグを除去してテキスト抽出
 * @param {string} html - HTML テキスト
 * @returns {string} プレーンテキスト
 */
function stripHtml(html) {
  return html ? html.replace(/<[^>]*>?/gm, '') : '';
}

/**
 * isLikelyEnglish
 * 【責務】テキストに日本語が含まれているか判定
 * @param {string} text - 判定対象テキスト
 * @returns {boolean} true=英語のみ, false=日本語含む
 */
function isLikelyEnglish(text) {
  return !(/[぀-ゟ゠-ヿ一-鿿]/.test(text));
}

/**
 * fmtDate
 * 【責務】Date を "yyyy/MM/dd" 形式にフォーマット
 * @param {Date} d - Date オブジェクト
 * @returns {string} フォーマット済み日付文字列
 */
function fmtDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd");
}

/**
 * _logError
 * 【責務】エラーログを整形出力
 * @param {string} functionName - エラー発生関数名
 * @param {Error} error - エラーオブジェクト
 * @param {string} message - 補足メッセージ
 * @returns {none}
 */
function _logError(functionName, error, message = "") {
  Logger.log(`[ERROR] ${functionName}: ${message} ${error.toString()} Stack: ${error.stack}`);
}

/**
 * getDateWindow
 * 【責務】"N日前から今日まで"の日付範囲を計算
 * @param {number} days - 遡り日数
 * @returns {Object} { start: Date, end: Date }
 */
function getDateWindow(days) {
  const end = new Date();
  end.setHours(24, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(1, days));
  return { start, end };
}

/**
 * ================================================================================
 * SECTION 6: RSS COLLECTOR
 * ================================================================================
 * RSSフィード取得・パース・記事抽出の関数群。
 * 重複排除、日付フィルタ、HTML除去を実装。
 * ================================================================================
 */

/**
 * collectRssFeeds
 * 【責務】RSSフィード巡回→記事抽出→collectシートへ追記
 * 【処理】
 *   1. RSSシートのフィード URL をすべて巡回
 *   2. 過去2日以内の記事を抽出
 *   3. URL 正規化で重複判定
 *   4. HTML 除去、ソース名付与
 *   5. collectシートへ追記
 * 【タイムアウト対策】フィード毎に SpreadsheetApp.flush() で中間保存
 * 【副作用】collectシートの更新、ネットワークリクエスト（複数回）
 * @param {none}
 * @returns {none}
 */
/**
 * collectRssFeeds (修正版: 降順ソート対応)
 * 【修正点】
 * 1. 既存データ読み込みを「末尾から」ではなく「先頭(2行目)から」に変更
 * (日付降順ソートされているため、最新データは上にある)
 * 2. HTMLデコードやURLパラメータ対応などの強化版ロジックは維持
 */
function collectRssFeeds() {
  const rssListSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.RSS_LIST);
  const collectSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  
  const rssData = rssListSheet.getRange(
    AppConfig.get().RssListSheet.DataRange.START_ROW, 
    AppConfig.get().RssListSheet.DataRange.START_COL, 
    rssListSheet.getLastRow() - 1, 
    AppConfig.get().RssListSheet.DataRange.NUM_COLS
  ).getValues();

  // 重複チェック用Set
  const existingUrlSet = new Set();
  const existingTitleSet = new Set();
  
  const lastRow = collectSheet.getLastRow();
  
  // --- 既存データの読み込み ---
  if (lastRow >= 2) { 
    const checkLimit = 3000; 
    
    // ★修正箇所: 降順ソート(最新が上)なので、常に2行目から読み込む
    const startRow = 2; 
    // 読み込む行数は、データ残数と上限の小さい方
    const numRows = Math.min(lastRow - 1, checkLimit);

    // B列(Title) と C列(URL) を取得
    const existingData = collectSheet.getRange(startRow, 2, numRows, 2).getValues();
    
    existingData.forEach(row => {
      const title = row[0]; // B列
      const url = row[1];   // C列
      
      if (url) {
        existingUrlSet.add(normalizeUrl(url)); 
        existingUrlSet.add(normalizeUrl(url).split('?')[0]); 
      }
      if (title) {
        const normTitle = decodeHtmlEntities(String(title)).trim().toLowerCase();
        existingTitleSet.add(normTitle);
      }
    });
    Logger.log(`既存データ読込完了: ${existingData.length}件 (StartRow:${startRow} / 最新記事からチェック)`);
    if (existingData.length > 0) {
      Logger.log(`[最新データサンプル] Title: "${existingData[0][0]}"`);
    }
  }
  
  let totalNewCount = 0;
  const DATE_LIMIT_DAYS = 2; 

  for (const row of rssData) {
    const siteName = row[0];
    const rssUrl = row[1];

    if (!rssUrl) continue;

    const items = fetchAndParseRss(rssUrl);
    if (!items || !Array.isArray(items) || items.length === 0) continue;

    const feedNewItems = [];

    for (const item of items) {
      try {
        if (!item.link || !item.title) continue;
        
        // 正規化
        const normalizedLink = normalizeUrl(item.link);
        const cleanTitle = stripHtml(item.title).trim();
        const normTitleToCheck = decodeHtmlEntities(cleanTitle).toLowerCase(); // 比較用

        // 1. 重複チェック
        // URL正規化一致(パラメータ有無両方) または タイトル正規化一致 で重複とみなす
        const isUrlDup = existingUrlSet.has(normalizedLink) || existingUrlSet.has(normalizedLink.split('?')[0]);
        const isTitleDup = existingTitleSet.has(normTitleToCheck);

        if (isUrlDup || isTitleDup) {
            continue; 
        }

        // 2. 日付チェック
        if (!item.pubDate || !isRecentDate(item.pubDate, DATE_LIMIT_DAYS)) {
          continue; 
        }
        
        // HTML除去
        const cleanDescription = stripHtml(item.description || AppConfig.get().Llm.NO_ABSTRACT_TEXT).trim();

        const rowData = [
          new Date(),      // A列
          cleanTitle,      // B列
          item.link,       // C列
          cleanDescription,// D列
          "",              // E列
          siteName         // F列
        ];

        feedNewItems.push(rowData);
        
        // 同一実行内での重複防止のためSetに追加
        existingUrlSet.add(normalizedLink);
        existingUrlSet.add(normalizedLink.split('?')[0]);
        existingTitleSet.add(normTitleToCheck);

      } catch (err) {
        console.error(`アイテム処理エラー: ${siteName} - ${err.message}`);
      }
    }

    if (feedNewItems.length > 0) {
      const startRow = collectSheet.getLastRow() + 1;
      collectSheet.getRange(startRow, 1, feedNewItems.length, feedNewItems[0].length).setValues(feedNewItems);
      SpreadsheetApp.flush(); 
      
      totalNewCount += feedNewItems.length;
      Logger.log(`${siteName}: ${feedNewItems.length} 件追加`);
    }
  }
  Logger.log(`合計 ${totalNewCount} 件の新しい記事を追加しました。`);
}

/**
 * getExistingUrls
 * 【責務】collectシート既存URL を Set で取得（高速化版）
 * 【最適化】直近3000件のみをチェック（古い記事の再送は稀のため）
 * @param {Sheet} sheet - collectシート
 * @returns {Set} URL の Set（重複排除済み）
 */
function getExistingUrls(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();

  // 直近N件のみチェック（RSSの性質上、数ヶ月以上前の記事が再送されることは稀なため）
  const CHECK_LIMIT = 3000;
  
  // データ開始位置を計算（最終行から遡って最大3000件、ただし2行目より前には行かない）
  const startRow = Math.max(2, lastRow - CHECK_LIMIT + 1);
  const numRows = lastRow - startRow + 1;
  
  // 対象範囲のURLのみを取得してフラット化
  const urls = sheet.getRange(startRow, AppConfig.get().CollectSheet.Columns.URL, numRows, 1).getValues().flat();
  return new Set(urls);
}

/**
 * fetchAndParseRss
 * 【責務】RSSフィード取得 → XML パース → 記事抽出
 * 【対応フォーマット】RSS 2.0, Atom, RSS 1.0 (RDF)
 * 【エラーハンドル】パース失敗時は強力なサニタイズで再試行
 * @param {string} url - RSSフィード URL
 * @returns {Array} 記事配列 ({ title, link, description, pubDate })
 */
function fetchAndParseRss(url) {
  try {
    const options = {
      'muteHttpExceptions': true,
      'validateHttpsCertificates': false,
      // ★追加: User-Agentを一般的なブラウザに偽装する
      'headers': {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    };
    
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    
    if (responseCode !== 200) {
      console.warn(`RSS取得失敗 (${responseCode}): ${url}`);
      return [];
    }

    let xml = response.getContentText();

    // 【修正点1】XMLサニタイズ処理の強化
    // "atom:link" などのプレフィックスが未定義でエラーになるのを防ぐため、単純なタグに置換または削除
    xml = xml
      // atom:link を link に置換
      .replace(/<atom:link/gi, '<link')
      .replace(/<\/atom:link>/gi, '</link>')
      // dc:creator などの一般的なプレフィックスも念の為削除 (汎用対応)
      .replace(/<[a-zA-Z0-9]+:/g, '<')
      .replace(/<\/[a-zA-Z0-9]+:/g, '</');

    // XMLパース試行
    let document;
    try {
      document = XmlService.parse(xml);
    } catch (e) {
      // 制御文字などを除去して再試行
      console.warn(`標準パース失敗。強力なサニタイズで再試行します: ${url} / Error: ${e.message}`);
      // 無効な制御文字を削除
      xml = xml.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '');
      document = XmlService.parse(xml);
    }

    const root = document.getRootElement();
    let items = [];
    
    // RSS 2.0 (<channel><item>) か Atom (<entry>) かを判定して処理
    const channel = root.getChild('channel');
    
    if (channel) {
      // RSS 2.0
      const children = channel.getChildren('item');
      items = children.map(item => {
        return {
          title: getChildText(item, 'title'),
          link: getChildText(item, 'link'),
          description: getChildText(item, 'description') || getChildText(item, 'encoded'), // content:encoded対応
          pubDate: getChildText(item, 'pubDate') || getChildText(item, 'date'),
          source: "RSS 2.0"
        };
      });
    } else if (root.getName() === 'feed' || root.getName() === 'RDF') {
      // Atom または RSS 1.0 (RDF)
      // RDFの場合は item はルート直下にあることが多いが、ここでは簡略化のため getChildren で探索
      let entries = root.getChildren('entry');
      if (entries.length === 0) entries = root.getChildren('item');
      
      items = entries.map(entry => {
        let link = getChildText(entry, 'link');
        // Atomの場合、linkは属性hrefに入っている場合がある
        if (!link) {
          const linkNode = entry.getChild('link');
          if (linkNode) {
            link = linkNode.getAttribute('href') ? linkNode.getAttribute('href').getValue() : '';
          }
        }
        
        return {
          title: getChildText(entry, 'title'),
          link: link,
          description: getChildText(entry, 'summary') || getChildText(entry, 'content') || getChildText(entry, 'description'),
          pubDate: getChildText(entry, 'published') || getChildText(entry, 'updated') || getChildText(entry, 'date'),
          source: "Atom/RDF"
        };
      });
    }

    return items;

  } catch (e) {
    // エラー時はログを出力して空配列を返す（nullは返さない）
    console.error(`fetchAndParseRss: エラーが発生しました。URL: ${url} Exception: ${e.toString()}`);
    return []; // 【修正点2】エラー時は必ず空配列を返す
  }
}

/**
 * getChildText
 * 【責務】XML 要素から安全に子要素テキストを取得
 * @param {Element} element - XML 要素
 * @param {string} tagName - 子要素タグ名
 * @returns {string} テキスト（見つからない場合は空文字列）
 */
function getChildText(element, tagName) {
  if (!element) return '';
  // 名前空間を無視してタグ名だけで探すための簡易実装
  // XmlServiceでは名前空間指定が必要だが、上記サニタイズでプレフィックスを消しているためこれで動作する可能性が高い
  const child = element.getChild(tagName);
  if (child) return child.getText();
  
  // 名前空間付きで見つからない場合、全ての子要素から名前だけ一致するものを探す
  const allChildren = element.getChildren();
  for (const c of allChildren) {
    if (c.getName() === tagName) return c.getText();
  }
  return '';
}

/**
 * sanitizeXml
 * 【責務】XML パースエラー原因の HTML タグ・制御文字を除去
 * 【処理】<sup>, <sub>, <font>, <br>, &nbsp; など
 * @param {string} text - 入力テキスト
 * @returns {string} クリーニング済みテキスト
 */
function sanitizeXml(text) {
  let cleanText = text;

  // 1. 今回のエラー原因である <sup>, <sub> タグを削除（中身は残す）
  // 例: <sup>123</sup> -> 123
  cleanText = cleanText.replace(/<\/?sup[^>]*>/gi, "");
  cleanText = cleanText.replace(/<\/?sub[^>]*>/gi, "");

  // 2. その他、RSSによく混入するがXMLでエラーになりやすいタグを削除
  // <font>, <span>, <div>, <style>, <script> など
  cleanText = cleanText.replace(/<\/?font[^>]*>/gi, "");
  cleanText = cleanText.replace(/<\/?span[^>]*>/gi, "");
  cleanText = cleanText.replace(/<\/?div[^>]*>/gi, "");
  
  // 3. <br> や <img> が閉じられていない場合への対応 ( <br> -> <br/> )
  // ※ 単純な置換だと副作用があるため、頻出パターンのみ対応
  cleanText = cleanText.replace(/<br>/gi, "<br/>");
  cleanText = cleanText.replace(/<hr>/gi, "<hr/>");

  // 4. XMLで未定義の実体参照エラー（&nbsp;など）を回避
  // &amp; 以外の & はそのままにするとエラーになることがあるが、まずは &nbsp; だけ潰す
  cleanText = cleanText.replace(/&nbsp;/g, " ");

  // 5. 制御文字の削除 (たまに含まれていてエラーになる)
  // cleanText = cleanText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

  return cleanText;
}

/**
 * isRecentArticle
 * 【責務】記事の公開日が指定日数以内かチェック
 * @param {Date} pubDate - 公開日
 * @param {number} daysLimit - 日数上限（デフォルト 7）
 * @returns {boolean} true=期間内, false=期限外
 */
function isRecentArticle(pubDate, daysLimit = 7) {
  if (!pubDate || !(pubDate instanceof Date)) return false;
  const now = new Date();
  const daysOld = Math.floor((now - pubDate) / (1000 * 60 * 60 * 24));
  return daysOld <= daysLimit;
}

/**
 * sortCollectByDateDesc
 * 【責務】collectシートを日付(A列)で降順（新しい順）にソート
 * @param {none}
 * @returns {none}
 */
function sortCollectByDateDesc() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  const lastRow = sheet.getLastRow();
  
  if (lastRow > 1) {
    // 2行目から最終行までを、1列目(A列)を基準に降順(false)でソート
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn())
         .sort({ column: 1, ascending: false });
    Logger.log("collectシートを日付(最新順)で並び替えました。");
  }
}

/**
 * ================================================================================
 * SECTION 7: WEB UI
 * ================================================================================
 * Web アプリケーション UI のエントリポイント。
 * Google Apps Script の doGet で展開し、Index.html を評価して返す。
 * ================================================================================
 */

/**
 * doGet
 * 【責務】Web UI のエントリポイント
 * @param {none}
 * @returns {HtmlOutput} Index.html を評価した結果
 */
function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate().setSandboxMode(HtmlService.SandboxMode.IFRAME).setTitle('RSSキーワード検索ツール');
}

/**
 * executeWeeklyDigest
 * 【責務】Web UI から呼び出し：キーワード指定で週刊ダイジェスト生成
 * @param {string} keyword - キーワード入力
 * @returns {string} HTML 本文（またはエラーメッセージ）
 */
function executeWeeklyDigest(keyword) {
  try {
    const trimmedKeyword = String(keyword || "").trim();
    Logger.log(`Web UIから入力されたキーワード: "${trimmedKeyword}"`);
    const htmlContent = weeklyDigestJob(trimmedKeyword, true);
    return htmlContent || "<div>該当記事がありませんでした。</div>";
  } catch (e) {
    Logger.log(`エラーが発生しました: ${e.toString()}`);
    return `<h1>処理中にエラーが発生しました</h1><p>${e.toString()}</p>`;
  }
}

/**
 * searchAndAnalyzeKeyword (修正版: OR検索対応)
 * 【責務】Web UI から キーワード検索 → LLM 分析
 * 【検索】AND/OR 条件対応
 * - "A or B" -> A または B (OR)
 * - "A and B" -> A かつ B (AND)
 * - "A B"     -> A かつ B (AND / デフォルト)
 * 【出力】トレンドセクション HTML（LLM生成）
 * @param {string} keyword - 検索キーワード
 * @returns {string} 分析結果 HTML
 */
function searchAndAnalyzeKeyword(keyword) {
  if (!keyword) return "キーワードが入力されていません。";

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return "データが存在しません。";

  // --- 1. キーワード解析ロジック (AND/OR対応) ---
  const lowerKey = keyword.toLowerCase().trim();
  let searchTerms = [];
  let searchMode = 'AND'; // デフォルト

  if (lowerKey.includes(' or ')) {
    // " or " が含まれる場合は OR検索
    searchMode = 'OR';
    searchTerms = keyword.split(/ or /i).map(t => t.trim()).filter(t => t.length > 0);
  } else if (lowerKey.includes(' and ')) {
    // " and " が含まれる場合は AND検索 (明示的)
    searchMode = 'AND';
    searchTerms = keyword.split(/ and /i).map(t => t.trim()).filter(t => t.length > 0);
  } else {
    // それ以外はスペース区切りの AND検索
    searchMode = 'AND';
    searchTerms = keyword.split(/\s+/).map(t => t.trim()).filter(t => t.length > 0);
  }

  if (searchTerms.length === 0) return "有効な検索キーワードが入力されていません。";

  // データの取得
  const range = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
  const values = range.getValues();

  // --- 2. フィルタリング実行 ---
  const relevantArticles = values.filter(row => {
    const title = String(row[1] || "").toLowerCase();
    // E列(要約)があれば使う、なければタイトルを使う
    const summaryVal = row[AppConfig.get().CollectSheet.Columns.SUMMARY - 1];
    const summary = String((summaryVal && summaryVal !== "") ? summaryVal : row[1]).toLowerCase();

    // 検索語句チェック
    if (searchMode === 'OR') {
      // OR: どれか1つでもヒットすればOK
      return searchTerms.some(term => {
        const t = term.toLowerCase();
        return title.includes(t) || summary.includes(t);
      });
    } else {
      // AND: すべてヒットする必要あり
      return searchTerms.every(term => {
        const t = term.toLowerCase();
        return title.includes(t) || summary.includes(t);
      });
    }
  });

  if (relevantArticles.length === 0) {
    return `<p>キーワード「<strong>${keyword}</strong>」に関連する記事は見つかりませんでした。</p>`;
  }

  // 3. AIに渡すテキストを作成（直近30件に絞る）
  const limit = AppConfig.get().Digest.topN || 30;
  const targetArticles = relevantArticles.slice(0, limit);
  
  let contextText = `【分析対象のキーワード】: ${keyword}\n\n【記事リスト】:\n`;
  targetArticles.forEach((row, i) => {
    const date = row[0]; 
    const url = row[AppConfig.get().CollectSheet.Columns.URL - 1]; // C列
    // E列(要約)があれば使う、なければタイトル
    const summaryVal = row[AppConfig.get().CollectSheet.Columns.SUMMARY - 1];
    const displayTitle = (summaryVal && summaryVal !== "") ? summaryVal : row[1];

    contextText += `[${i+1}] 日付:${fmtDate(new Date(date))} / タイトル:${displayTitle} / URL:${url}\n---\n`;
  });

// --- 4. プロンプトの取得 (★ここを修正) ---
  
  // まずシートから取得を試みる
  let systemPrompt = getPromptConfig("WEB_ANALYSIS_SYSTEM");
  
  // もしシートに設定がなければ、コード内のデフォルト値(フォールバック)を使う
  if (!systemPrompt) {
    Logger.log("警告: promptシートに 'WEB_ANALYSIS_SYSTEM' が見つかりません。デフォルトのプロンプトを使用します。");
    systemPrompt = `
      あなたは、臨床検査・バイオ技術分野の専門アナリストです。
      提供されたキーワードと、そのキーワードに関連する記事群を基に、業界の重要な動向を抽出し、分類し、**客観的な事実**と**価値あるインサイト**をもって読者に分かりやすく解説する役割を担います。

      【指示】
      以下のキーワードに関連する記事リストを分析し、主要な技術・市場トレンドを**記事群のテーマに応じて最低1つ、最大2つ**に分類してください。
      記事が少ない場合（3記事以下など）は、1つにまとめてください。

      出力は**HTML形式**のみで行ってください（Markdownは使用しないでください）。
      以下のフォーマットに従ってください：

      <div class="trend-section">
        <h3>【トレンド名】（15〜25文字のキャッチーな名称）</h3>
        <p>
          （解説文: 150〜200文字程度。なぜ今重要か、具体的な進展、社会への価値、今後の見通しを統合して記述。キーワードを自然に含めること。）
        </p>
        <ul>
          <li><a href="記事URL" target="_blank">記事タイトル1</a></li>
          <li><a href="記事URL" target="_blank">記事タイトル2</a></li>
        </ul>
      </div>

      ※ これをトレンドの数だけ繰り返してください。
      ※ 前置きや挨拶は不要です。HTMLタグから始めてください。
      `;
  }
  
  try {
    const llmConfig = AppConfig.get().Llm;
    const model = llmConfig.ModelMini;
    const azureUrl = llmConfig.AzureUrlMini;
    const options = { temperature: 0.4 };

    let analysisResult = LlmService.analyzeKeywordSearch(systemPrompt, contextText, options);

    analysisResult = analysisResult.replace(/^```html\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");

    if (analysisResult.includes("いずれのLLMでも")) {
        throw new Error("LLMによる分析に失敗しました。詳細はログを確認してください。");
    }
    
    return `
      <div style="margin-bottom: 15px;">
        <strong>🔍 分析対象:</strong> ${relevantArticles.length}件中、直近${targetArticles.length}件<br>
        <strong>🔑 キーワード:</strong> ${keyword} (${searchMode}検索)
      </div>
      <hr>
      ${analysisResult}
    `;
  } catch (e) {
    Logger.log(`searchAndAnalyzeKeywordでエラー: ${e.stack}`);
    return `分析中にエラーが発生しました: ${e.message}`;
  }
}

/**
 * ================================================================================
 * SECTION 8: MAINTENANCE UTILITIES
 * ================================================================================
 * メンテナンス用補助関数群：重複削除、URL 正規化、日付判定など。
 * ================================================================================
 */

/**
 * removeDuplicates
 * 【責務】collectシート内の重複記事を削除
 * 【判定】URL 正規化で重複チェック（上部の行を優先）
 * @param {none}
 * @returns {none}
 */
function removeDuplicates() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  if (!sheet) {
    Logger.log("エラー: シートが見つかりません");
    return;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("データがありません");
    return;
  }

  // 全データを取得
  const range = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
  const values = range.getValues();
  
  // ★正規化されたURLを格納するSetに変更★
  const uniqueNormalizedUrls = new Set();
  const uniqueRows = [];
  let duplicateCount = 0;

  // 上から順に走査し、初めて出てくるURLの行だけを残す
  values.forEach(row => {
    const url = row[AppConfig.get().CollectSheet.Columns.URL - 1]; // C列
    
    if (url) {
      // 正規化されたURLでチェック
      const normalizedUrl = normalizeUrl(url); 
      
      if (!uniqueNormalizedUrls.has(normalizedUrl)) {
        uniqueNormalizedUrls.add(normalizedUrl);
        uniqueRows.push(row);
      } else {
        // 既に存在する正規化URLなら重複としてカウント（スキップ）
        duplicateCount++;
      }
    } else {
      // URLが空の行はそのまま残す（稀なケースだが安全のため）
      uniqueRows.push(row);
    }
  });

  if (duplicateCount > 0) {
    // 一旦データをクリアして、ユニークなデータだけ書き戻す
    range.clearContent();
    if (uniqueRows.length > 0) {
      sheet.getRange(2, 1, uniqueRows.length, sheet.getLastColumn()).setValues(uniqueRows);
    }
    Logger.log(`完了: ${duplicateCount} 件の重複記事を削除しました。`);
  } else {
    Logger.log("重複記事は見つかりませんでした。");
  }
}
/**
 * normalizeUrl (修正版)
 * 【責務】URL 正規化
 * 【修正】クエリパラメータ(?)の削除処理を緩和。
 * RSS記事のユニークIDがパラメータに含まれるケース（例: ?id=123）があるため、
 * これを削除すると別記事が同一URLとみなされる副作用があるが、
 * 今回は「重複登録」が問題なので、あえて「パラメータ付き」を維持して比較精度を上げる。
 */
function normalizeUrl(url) {
  if (!url) return "";
  let s = String(url).trim();
  
  // 1. デコード
  try { s = decodeURIComponent(s); } catch (e) {}
  
  // 2. 末尾のスラッシュを削除
  s = s.replace(/\/$/, "");

  // 3. プロトコル(http/https)とwwwの揺らぎを吸収
  s = s.replace(/^https?:\/\/(www\.)?/, "//");

  // ★変更: クエリパラメータ(?...) は削除しない！
  // 理由: ?id=xxx で記事を区別するサイトで誤判定の原因になるため。
  // ただし、utm_source などの分析タグが邪魔な場合は、別途除去ロジックが必要だが、
  // 「重複して追加される（＝一致しない）」問題の解決には、情報を残すほうが安全。
  
  return s;
}

/**
 * isRecentDate
 * 【責務】日付文字列が指定日数以内かチェック
 * @param {string} dateStr - 日付文字列
 * @param {number} daysLimit - 日数上限
 * @returns {boolean} true=期間内, false=期限外
 */
function isRecentDate(dateStr, daysLimit) {
  if (!dateStr) return false; // 日付情報がない場合は弾く
  
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return false; // パースできない場合も弾く

  const now = new Date();
  const diffTime = now - date;
  const diffDays = diffTime / (1000 * 60 * 60 * 24);

  return diffDays <= daysLimit;
}

/**
 * decodeHtmlEntities
 * 【責務】HTML実体参照（&amp;, &#39; 等）を通常の文字に戻す
 * 【用途】タイトル比較時の正規化
 */
function decodeHtmlEntities(text) {
  if (!text) return "";
  return text.replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/&#039;/g, "'")
             .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
}

/**
 * getRecipients
 * 【責務】配信先メールアドレスリストの生成
 * 【仕様】
 * 1. スクリプトプロパティ `MAIL_TO` (管理者) を取得
 * 2. `Users` シートから「有効(C列!=空)」なアドレスを取得
 * 3. 重複を除去してカンマ区切り文字列で返す
 */
function getRecipients() {
  const adminMail = AppConfig.get().Digest.mailTo; // プロパティの管理者アドレス
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.USERS);
  
  // 重複排除用のSet
  const recipientSet = new Set();

  // 1. 管理者アドレスを追加
  if (adminMail) {
    // カンマ区切りで複数指定されている場合にも対応
    adminMail.split(',').forEach(email => {
      const trimmed = email.trim();
      if (trimmed) recipientSet.add(trimmed);
    });
  }

  // 2. シートからユーザーを追加
  if (sheet && sheet.getLastRow() >= 2) {
    // A列:名前, B列:Email, C列:有効フラグ
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
    
    data.forEach(row => {
      const email = String(row[1]).trim();
      const isActive = String(row[2]).trim() !== ""; // C列に何か文字があれば有効
      
      if (email && isActive) {
        recipientSet.add(email);
      }
    });
  }

  // Setを配列に戻してカンマ区切りにする
  const finalRecipients = Array.from(recipientSet).join(',');
  
  Logger.log(`配信先リスト生成: ${recipientSet.size} 件 (${finalRecipients})`);
  return finalRecipients;
}

