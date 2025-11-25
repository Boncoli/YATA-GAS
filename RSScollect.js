/**
 * @file RSScollect.js
 * @description RSSフィードを収集し、AIで見出しと週次ダイジェストを生成するGoogle Apps Script
 * @version 2.6.1
 * @date 2025-11-25
 * 
 * ===== スクリプトプロパティの変更履歴 =====
 * 
 * 【2025-11-25】NANO/MINI機能ベース命名への統一
 * 
 * 旧プロパティキー（廃止）:
 *   - OPENAI_MODEL_DAILY   → 削除
 *   - OPENAI_MODEL_WEEKLY  → 削除
 *   - AZURE_ENDPOINT_URL_WEEKLY → 削除
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
 * フォールバック戦略（全関数共通）:
 *   Azure OpenAI → OpenAI Personal → Google Gemini
 * 
 */

// Core: 全体設定と定数

const Config = {
  SheetNames: {
    RSS_LIST: "RSS",
    TREND_DATA: "collect",
    PROMPT_CONFIG: "prompt",
    TRENDS: "Trends",
  },
  CollectSheet: {
    Columns: {
      URL: 3,
      ABSTRACT: 4,
      SUMMARY: 5, // E列
      SOURCE: 6,  // F列
    },
    DataRange: {
      START_ROW: 2,
      NUM_COLS_FOR_URL: 1,
    },
  },
  RssListSheet: {
    DataRange: {
      START_ROW: 2,
      START_COL: 1,
      NUM_COLS: 2,
    },
  },
  Llm: {
    MODEL_NAME: "gemini-2.5-flash-lite",
    DELAY_MS: 1100,
    MIN_SUMMARY_LENGTH: 100,
    NO_ABSTRACT_TEXT: "抜粋なし",
    MISSING_ABSTRACT_TEXT: "記事が短すぎるか、抜粋がないため見出し生成をスキップしました。",
    SHORT_JA_SKIP_TEXT: "記事が短く、日本語のため見出し生成をスキップしました。",
  },
};

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
  const config = _getDigestConfig(); 
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
  const config = _getDigestConfig();
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
  const trendDataSheet = ss.getSheetByName(Config.SheetNames.TREND_DATA);
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
    const currentHeadline = row[Config.CollectSheet.Columns.SUMMARY - 1];
    // 見出しが空の場合のみ処理
    if (!currentHeadline || String(currentHeadline).trim() === "") {
      const title = row[Config.CollectSheet.Columns.URL - 2]; // C列の左隣(B列)がタイトルと仮定
      const abstractText = row[Config.CollectSheet.Columns.ABSTRACT - 1];
      
      // 記事が短すぎる、または「抜粋なし」の場合はAIを使わず簡易処理
      const isShort = (abstractText === Config.Llm.NO_ABSTRACT_TEXT) || (String(abstractText || "").length < Config.Llm.MIN_SUMMARY_LENGTH);
      
      if (isShort) {
        let newHeadline;
        const sheetRowNumber = index + 2;
        if (title && String(title).trim() !== "") {
          // タイトルがあればそれを使う（英語なら翻訳）
          newHeadline = isLikelyEnglish(String(title)) ? `=GOOGLETRANSLATE(B${sheetRowNumber},"auto","ja")` : String(title).trim();
        } else if (abstractText && abstractText !== Config.Llm.NO_ABSTRACT_TEXT) {
          newHeadline = isLikelyEnglish(String(abstractText)) ? `=GOOGLETRANSLATE(D${sheetRowNumber},"auto","ja")` : String(abstractText).trim();
        } else {
          newHeadline = Config.Llm.MISSING_ABSTRACT_TEXT;
        }
        // 即座に配列を更新
        values[index][Config.CollectSheet.Columns.SUMMARY - 1] = newHeadline;
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
        values[article.originalRowIndex][Config.CollectSheet.Columns.SUMMARY - 1] = newHeadline;
      } else {
        Logger.log(`見出し生成結果が空またはエラーのためスキップ (Row: ${article.originalRowIndex + 2}): ${newHeadline}`);
      }
      
      Utilities.sleep(Config.Llm.DELAY_MS);
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
function _filterRelevantArticles(allItems, webUiKeyword = null) {
  let activeKeywords = [];
  if (webUiKeyword && String(webUiKeyword).trim() !== "") {
    activeKeywords = [String(webUiKeyword).trim()];
    Logger.log(`フィルタリング: Web UIのキーワード「${activeKeywords[0]}」を使用します。`);
  } else {
    activeKeywords = getWeightedKeywords().filter(kw => kw.active).map(kw => kw.keyword);
    Logger.log(`フィルタリング: シートから ${activeKeywords.length} 件のキーワードを使用します。`);
  }
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
  const { selectedTopN } = rankAndSelectArticles(relevantArticles, config, articleKeywordMap);
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
function _generateAndSendDailyDigest(allArticles, config, start, end, daysWindow) {
  const digestSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Config.SheetNames.TRENDS);

  // 1. プロンプト取得（DAILY_DIGEST_SYSTEM / DAILY_DIGEST_USER）
  const [systemPromptTemplate, userPromptTemplate] = getDailyDigestPrompts();


  // 2. 記事リストを整形（URL を含む Markdownリンク形式）
  const articleListText = allArticles.map(a =>
    `・${a.title} - 抜粋: ${a.abstractText}`
  ).join('\n');

  // 3. 実行プロンプト生成（シンプルな置換）
  const userPrompt = userPromptTemplate
    .replace(/\$\{all_articles_in_date_window\}/g, articleListText)

  // 4. LLM呼び出し（フォールバック順）
  Logger.log("LLMに日刊ダイジェストの生成を依頼中... (Azure > OpenAI > Gemini)");
  let reportBody = "(LLM生成失敗)";
  try {
    reportBody = callDailyDigestLlm(systemPromptTemplate, userPrompt);

    // Trendsシートへ書き込み
    const writeData = [
      new Date(),               // A: 記録日時
      "日刊ダイジェスト",       // B: 種別
      start,                    // C: 集計開始
      end,                      // D: 集計終了
      "Topics (All Articles)",  // E: 注記（キーワードではなくトピック分析）
      reportBody,               // F: 本文
      allArticles.length        // G: 記事数
    ];
    digestSheet.appendRow(writeData);
    SpreadsheetApp.flush();
  } catch (e) {
    Logger.log("LLM呼び出しエラー: " + e.message);
    reportBody = `## エラーが発生しました\n${e.message}`; // エラー時は本文としてそのまま送信
  }

  // 5. メール送信
  const headerLine = `集計期間：${fmtDate(start)}〜${fmtDate(new Date(end.getTime() - 1))} (全${allArticles.length}記事)`;
  const hitKeywordsWithCount = null; // キーワードベースではないため null
  sendWeeklyDigestEmail(headerLine, reportBody, hitKeywordsWithCount, daysWindow);
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
  const props = PropertiesService.getScriptProperties();

  // OpenAI（非Azure）用のモデル指定: 高次分析用 mini
  const openAiModelDaily = props.getProperty("OPENAI_MODEL_MINI") ?? "gpt-4.1-mini";

  // Azureのエンドポイント（Chat Completions デプロイメント URL）: 高次分析用
  const azureDailyUrl = props.getProperty("AZURE_ENDPOINT_URL_MINI") || null;

  // Azure/OpenAI/Gemini の鍵
  const azureKey = props.getProperty("OPENAI_API_KEY");           // Azure OpenAI の API key
  const openAiKey = props.getProperty("OPENAI_API_KEY_PERSONAL"); // OpenAI の API key
  const geminiKey = props.getProperty("GEMINI_API_KEY");          // Gemini の API key

  // 既存のフォールバックラッパーをそのまま利用
  //   第4引数に azureDailyUrl を渡すと、Azure が最優先に
  //   Azure失敗→OpenAI（openAiModelDaily）→Gemini の順で試行
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
  const promptSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Config.SheetNames.PROMPT_CONFIG);
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
function rankAndSelectArticles(relevantArticles, config, articleKeywordMap) {
  const topN = config.topN || 20;
  const scoredArticles = relevantArticles.map(a => ({ ...a, heuristicScore: computeHeuristicScore(a, articleKeywordMap) })).sort((a, b) => b.heuristicScore - a.heuristicScore);
  const picked = [];
  for (const item of scoredArticles) {
    picked.push(item);
    if (picked.length >= topN) break;
  }
  return { selectedTopN: picked };
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
  const sh = SpreadsheetApp.getActive().getSheetByName(Config.SheetNames.TREND_DATA);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const vals = sh.getRange(2, 1, lastRow - 1, Config.CollectSheet.Columns.SOURCE).getValues();
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
function sendWeeklyDigestEmail(headerLine, mdBody, hitKeywordsWithCount, daysWindow = 7) {
  const props = PropertiesService.getScriptProperties();
  const to = props.getProperty("MAIL_TO");
  if (!to) { Logger.log("MAIL_TO未設定のためメール送信せず。"); return; }
  
  // プレフィックスを動的に変更
  const prefixBase = daysWindow === 1 ? "日刊" : "週間";
  const subjectPrefix = props.getProperty("MAIL_SUBJECT_PREFIX") || `【${prefixBase}RSS】`;
  const senderName = props.getProperty("MAIL_SENDER_NAME") || "RSS要約ボット";
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd");
  const sheetUrl = props.getProperty("DIGEST_SHEET_URL") || "(DIGEST_SHEET_URL 未設定)";
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
  const finalSubject = subjectPrefix + today;
  const htmlHeader = headerLine.replace(/\n/g, '<br>');
  const htmlContent = markdownToHtml(fullMdBody);
  const fullHtmlBody = `<div style="font-family: Meiryo, 'Hiragino Sans', 'MS PGothic', sans-serif; font-size: 14px; line-height: 1.7; color: #333;">${htmlHeader}<br><br>${htmlContent}</div>`;
  GmailApp.sendEmail(to, finalSubject, textBody, { name: senderName, htmlBody: fullHtmlBody });
  Logger.log(`メール送信（${prefixBase}ダイジェスト）完了: ${to}`);
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
  const props = PropertiesService.getScriptProperties();
  const isEnabled = props.getProperty("TREND_DETECTION_ENABLED");
  if (String(isEnabled).toLowerCase() !== 'true') {
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
  const sh = SpreadsheetApp.getActive().getSheetByName(Config.SheetNames.TREND_DATA);
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
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Config.SheetNames.TRENDS);
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
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Config.SheetNames.TRENDS);
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
 * LLM呼び出しの統一フロー。Azure/OpenAI/Gemini のフォールバック処理。
 * モデル選択：
 *   - NANO (gpt-4.1-nano)  : 軽量処理（見出し生成、キーワード抽出）
 *   - MINI (gpt-4.1-mini)  : 高次分析（ダイジェスト生成、トレンド分析、キーワード分析）
 * ================================================================================
 */

/**
 * _callAzureLlm
 * 【責務】Azure OpenAI Chat Completions API 呼び出し
 * 【仕様】エラー時は null 返却→フォールバックへ
 * @param {string} systemPrompt - システムプロンプト
 * @param {string} userPrompt - ユーザープロンプト
 * @param {string} azureUrl - デプロイメント URL
 * @param {string} azureKey - API キー
 * @param {Object} options - { temperature, max_completion_tokens など }
 * @returns {string|null} 回答文字列またはnull
 */
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
/**
 * _callOpenAiLlm
 * 【責務】OpenAI Chat Completions API 呼び出し
 * 【仕様】エラー時は null 返却→フォールバックへ
 * @param {string} systemPrompt - システムプロンプト
 * @param {string} userPrompt - ユーザープロンプト
 * @param {string} openAiModel - モデル名（gpt-4.1-nano または gpt-4.1-mini）
 * @param {string} openAiKey - API キー
 * @param {Object} options - { temperature など }
 * @returns {string|null} 回答文字列またはnull
 */
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
/**
 * _callGeminiLlm
 * 【責務】Google Gemini API 呼び出し（フォールバック最後の砦）
 * 【仕様】エラー時は null 返却
 * @param {string} systemPrompt - システムプロンプト
 * @param {string} userPrompt - ユーザープロンプト
 * @param {string} geminiApiKey - API キー
 * @param {Object} options - { temperature など }
 * @returns {string|null} 回答文字列またはnull
 */
function _callGeminiLlm(systemPrompt, userPrompt, geminiApiKey, options = {}) {
  Logger.log("Gemini APIを試行中...");
  const API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/" + Config.Llm.MODEL_NAME + ":generateContent?key=" + geminiApiKey;
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
    Utilities.sleep(Config.Llm.DELAY_MS);
    return headline;
  } catch (e) {
    _logError("_callGeminiLlm", e, "Gemini API呼び出し中に例外が発生しました。");
    return null;
  }
}

/**
 * callLlmWithFallback
 * 【責務】LLM 呼び出しのフォールバック制御
 * 【戦略】Azure → OpenAI → Gemini の順で試行。全失敗時はエラーメッセージ返却
 * 【特徴】azureUrlOverride で動的にエンドポイント切り替え可能（NANO/MINI用途別）
 * @param {string} systemPrompt - システムプロンプト
 * @param {string} userPrompt - ユーザープロンプト
 * @param {string} openAiModel - デフォルトモデル（"gpt-4.1-nano" または "gpt-4.1-mini"）
 * @param {string} azureUrlOverride - Azure エンドポイント（null=デフォルト）
 * @param {Object} options - { temperature など }
 * @returns {string} 回答文字列またはエラーメッセージ
 */
function callLlmWithFallback(systemPrompt, userPrompt, openAiModel = "gpt-4.1-nano", azureUrlOverride = null, options = {}) {
  const props = PropertiesService.getScriptProperties();
  const azureUrl = azureUrlOverride || props.getProperty("AZURE_ENDPOINT_URL");
  const azureKey = props.getProperty("OPENAI_API_KEY");
  const openAiKey = props.getProperty("OPENAI_API_KEY_PERSONAL");
  const geminiApiKey = props.getProperty("GEMINI_API_KEY");
  let result = null;
  if (azureUrl && azureKey) {
    result = _callAzureLlm(systemPrompt, userPrompt, azureUrl, azureKey, options);
    if (result !== null) return result;
    Logger.log("Azure OpenAIでの呼び出しに失敗しました。OpenAI APIを試行します。");
  }
  if (openAiKey) {
    result = _callOpenAiLlm(systemPrompt, userPrompt, openAiModel, openAiKey, options);
    if (result !== null) return result;
    Logger.log("OpenAI APIでの呼び出しに失敗しました。Gemini APIを試行します。");
  }
  if (geminiApiKey) {
    result = _callGeminiLlm(systemPrompt, userPrompt, geminiApiKey, options);
    if (result !== null) return result;
    Logger.log("Gemini APIでの呼び出しに失敗しました。");
  }
  return "いずれのLLMでも見出しを生成できませんでした。";
}

/**
 * summarizeWithLLM
 * 【責務】記事テキストをLLMで要約（見出し生成）
 * 【モデル】NANO (gpt-4.1-nano) ← 軽量処理用
 * 【用途】processSummarization() から呼び出し
 * @param {string} articleText - "Title: xxx\nAbstract: yyy" 形式テキスト
 * @returns {string} JSON形式返却（tldr or summary キーを期待）
 */
function summarizeWithLLM(articleText) {
  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty("OPENAI_MODEL_NANO") || "gpt-4.1-nano";
  const SYSTEM = getPromptConfig("BATCH_SYSTEM");
  const USER_TEMPLATE = getPromptConfig("BATCH_USER_TEMPLATE");
  if (!SYSTEM || !USER_TEMPLATE) return "エラー: BATCHプロンプト設定が見つかりません。";
  const USER = USER_TEMPLATE + ["", "記事: ---", articleText, "---"].join("\n");
  return callLlmWithFallback(SYSTEM, USER, model);
}

/**
 * _llmMakeTrendSections
 * 【責務】キーワード毎にLLMでトレンドセクション生成
 * 【モデル】MINI (gpt-4.1-mini) ← 高次分析用
 * 【出力形式】Markdown（見出しH3 + 解説 + 記事リンク）
 * @param {Object} articlesGroupedByKeyword - { keyword: [記事配列] }
 * @param {number} linksPerTrend - 各トレンドの記事リンク数上限
 * @param {Array} hitKeywords - キーワード配列（処理対象）
 * @returns {string} Markdown本文
 */
function _llmMakeTrendSections(articlesGroupedByKeyword, linksPerTrend, hitKeywords) {
  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty("OPENAI_MODEL_MINI") || "gpt-4.1-mini";
  const azureWeeklyUrl = props.getProperty("AZURE_ENDPOINT_URL_MINI");
  const SYSTEM = getPromptConfig("TREND_SYSTEM");
  const USER_TEMPLATE = getPromptConfig("TREND_USER_TEMPLATE");
  if (!SYSTEM || !USER_TEMPLATE) {
    Logger.log("エラー: WEEKLYトレンドプロンプト設定が見つかりません。");
    return "今週のトレンドは生成できませんでした。";
  }
  const allTrends = [];
  for (const keyword of hitKeywords) {
    const articlesForKeyword = articlesGroupedByKeyword[keyword];
    if (!articlesForKeyword || articlesForKeyword.length === 0) continue;
    const keywordHeader = `キーワード「${keyword}」\n`;
    const articleListForLlm = articlesForKeyword.map(a => `- 見出し: ${a.headline}\n  要約: ${a.tldr}\n  URL: ${a.url}`).join("\n");
    const user = [USER_TEMPLATE, `キーワード: ${keyword}`, "", "各トレンドについて、以下の厳密なMarkdown形式で出力してください。", "", "1. 15〜25字程度のキャッチーなトレンド名称を太字で記述してください。", "2. 150〜200字程度で、なぜ今このトレンドが重要なのか、背景、具体的な進展、将来の展望などを、複数の記事から得られた情報を統合・要約して記述してください。**この解説文には、キーワードを自然に含めてください。** 箇条書きは使用しないでください。", `3. そのトレンドを最もよく表している記事を${linksPerTrend}つまで、\
・[記事の見出し](記事のURL)\
 の形式で記述してください。`, "", "前書きや後書きは一切不要です。", "", "【記事リスト】", articleListForLlm].join("\n");
    const txt = callLlmWithFallback(SYSTEM, user, model, azureWeeklyUrl);
    if (txt && txt.trim()) {
      allTrends.push(keywordHeader + txt.trim());
    } else if (articlesForKeyword.length > 0) {
      allTrends.push(`${keywordHeader}**${keyword}関連のトレンド**\nこのキーワードに関するトレンドは生成できませんでした。関連する記事をいくつか紹介します。\n${articlesForKeyword.slice(0, linksPerTrend).map(a => `・[${a.title}](${a.url})`).join("\n")}`);
    }
  }
  return allTrends.join("\n\n---\n\n");
}

/**
 * extractKeywordsWithLLM
 * 【責務】テキスト群からLLMで重要キーワード抽出
 * 【モデル】NANO (gpt-4.1-nano) ← 軽量処理用
 * 【用途】トレンド検出時に dailyKeywords を生成
 * @param {string} text - 改行区切りのテキスト群（記事タイトルなど）
 * @returns {Array} キーワード配列（空行除去済み）
 */
function extractKeywordsWithLLM(text) {
  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty("OPENAI_MODEL_NANO") || "gpt-4.1-nano";
  const SYSTEM = getPromptConfig("TREND_KEYWORD_SYSTEM") || "以下のテキスト群から、重要と思われる技術、製品、イベントなどのキーワード（名詞）を最大50個、重複を除いてリストアップしてください。各キーワードは改行で区切って、リスト形式でのみ出力してください。前書きや後書きは不要です。";
  const USER = text;
  const result = callLlmWithFallback(SYSTEM, USER, model);
  if (result && !result.includes("エラー")) {
    return result.split('\n').map(kw => kw.trim()).filter(kw => kw);
  }
  return null;
}

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
function getWeightedKeywords(sheetName = "Keywords") {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  return values.map(([keyword, activeFlag]) => ({
    keyword: String(keyword).trim(),
    active: String(activeFlag).trim() !== ""
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
  const sheet = ss.getSheetByName(Config.SheetNames.PROMPT_CONFIG);
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

/**
 * _getDigestConfig
 * 【責務】スクリプトプロパティからダイジェスト設定を一括取得
 * @param {none}
 * @returns {Object} { days, topN, notifyChannel, mailTo, mailSubjectPrefix, mailSenderName }
 */
function _getDigestConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    days: parseInt(props.getProperty("DIGEST_DAYS") || "7", 10),
    topN: parseInt(props.getProperty("DIGEST_TOP_N") || "20", 10),
    notifyChannel: (props.getProperty("NOTIFY_CHANNEL_WEEKLY") || "email").toLowerCase(),
    mailTo: props.getProperty("MAIL_TO"),
    mailSubjectPrefix: props.getProperty("MAIL_SUBJECT_PREFIX") || "【週間RSS】",
    mailSenderName: props.getProperty("MAIL_SENDER_NAME") || "RSS要約ボット",
  };
}

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
  const hasAbstract = article.abstractText && article.abstractText !== Config.Llm.NO_ABSTRACT_TEXT;
  const abstractBonus = hasAbstract ? Math.min(20, String(article.abstractText).length / 100) : 0;
  const rawScore = keywordScore + freshnessScore + abstractBonus;
  return Math.max(0, Math.min(100, Math.round(rawScore)));
}

/**
 * markdownToHtml
 * 【責務】Markdown → HTML 変換
 * 【対応】h3見出し、太字、リンク、区切り線、箇条書き
 * @param {string} md - Markdown テキスト
 * @returns {string} HTML テキスト
 */
function markdownToHtml(md) {
  if (!md) return "";
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color: #0066cc; text-decoration: none;">$1</a>')
    .replace(/^\s*---\s*$/gm, '<hr style="border: none; border-top: 1px solid #eee;">')
    .replace(/^- (.*$)/gim, '&bull; $1')
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
function collectRssFeeds() {
  const rssListSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Config.SheetNames.RSS_LIST);
  const collectSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Config.SheetNames.TREND_DATA);
  
  const rssData = rssListSheet.getRange(
    Config.RssListSheet.DataRange.START_ROW, 
    Config.RssListSheet.DataRange.START_COL, 
    rssListSheet.getLastRow() - 1, 
    Config.RssListSheet.DataRange.NUM_COLS
  ).getValues();

  // 既存URL取得（正規化してSetに格納）
  const existingUrlSet = new Set();
  const lastRow = collectSheet.getLastRow();
  
  // 【修正】直近 10,000件のURLをチェック対象とする (過去の重複を拾いやすくするため)
  if (lastRow >= Config.CollectSheet.DataRange.START_ROW) {
    const checkLimit = 10000; 
    const startRow = Math.max(2, lastRow - checkLimit + 1);
    const numRows = lastRow - startRow + 1;

    const existingData = collectSheet.getRange(
      startRow,
      Config.CollectSheet.Columns.URL, // C列
      numRows,
      1
    ).getValues();
    
    // 【最重要】シート上のURLも正規化してセットに登録する
    existingData.forEach(row => {
      if (row[0]) existingUrlSet.add(normalizeUrl(row[0])); 
    });
  }
  
  let totalNewCount = 0;
  const DATE_LIMIT_DAYS = 2; 

  for (const row of rssData) {
    const siteName = row[0];
    const rssUrl = row[1];

    if (!rssUrl) continue;

    const items = fetchAndParseRss(rssUrl);
    if (!items || !Array.isArray(items) || items.length === 0) {
      continue;
    }

    const feedNewItems = [];

    for (const item of items) {
      try {
        if (!item.link || !item.title) continue;
        
        // 1. 重複チェック（正規化URLで比較）を日付チェックより先に行う
        const normalizedLink = normalizeUrl(item.link);
        if (existingUrlSet.has(normalizedLink)) {
            continue; // 重複記事としてスキップ
        }

        // 2. 日付チェック
        if (!item.pubDate || !isRecentDate(item.pubDate, DATE_LIMIT_DAYS)) {
          // 日付情報がない、または2日より古いためスキップ
          continue; 
        }
        
        // HTML除去
        const cleanDescription = stripHtml(item.description || Config.Llm.NO_ABSTRACT_TEXT).trim();
        const cleanTitle = stripHtml(item.title).trim();

        // データ作成: A:日付, B:タイトル, C:URL, D:抜粋, E:空, F:ソース名
        const rowData = [
          new Date(),      // A列: 収集日時
          cleanTitle,      // B列: 元タイトル
          item.link,       // C列: URL (オリジナルをそのまま保存)
          cleanDescription,// D列: 抜粋
          "",              // E列: 要約用
          siteName         // F列: ソース名
        ];

        feedNewItems.push(rowData);
        
        // 重複防止用セットにも正規化URLを追加（同一実行内での重複も防ぐ）
        existingUrlSet.add(normalizedLink);

      } catch (err) {
        console.error(`アイテム処理エラー: ${siteName} - ${err.message}`);
      }
    }

    if (feedNewItems.length > 0) {
      const startRow = collectSheet.getLastRow() + 1;
      collectSheet.getRange(startRow, 1, feedNewItems.length, feedNewItems[0].length).setValues(feedNewItems);
      SpreadsheetApp.flush(); 
      
      totalNewCount += feedNewItems.length;
      Logger.log(`${siteName}: ${feedNewItems.length} 件追加 (過去${DATE_LIMIT_DAYS}日以内)`);
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
  const urls = sheet.getRange(startRow, Config.CollectSheet.Columns.URL, numRows, 1).getValues().flat();
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
      'validateHttpsCertificates': false
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
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Config.SheetNames.TREND_DATA);
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
 * searchAndAnalyzeKeyword
 * 【責務】Web UI から キーワード検索 → LLM 分析
 * 【検索】AND 条件（スペース区切り）
 * 【出力】トレンドセクション HTML（LLM生成）
 * @param {string} keyword - 検索キーワード
 * @returns {string} 分析結果 HTML
 */
function searchAndAnalyzeKeyword(keyword) {
  if (!keyword) return "キーワードが入力されていません。";

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Config.SheetNames.TREND_DATA);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return "データが存在しません。";

  // 1. キーワードをスペースで分割し、検索語句の配列を作成
  const searchTerms = keyword.toLowerCase().trim().split(/\s+/).filter(term => term.length > 0);
  if (searchTerms.length === 0) return "有効な検索キーワードが入力されていません。";

  // データの取得
  const range = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
  const values = range.getValues();

  // 2. キーワードでフィルタリング（AND条件）
  const relevantArticles = values.filter(row => {
    const title = String(row[1] || "").toLowerCase();
    const summary = String(row[Config.CollectSheet.Columns.SUMMARY - 1] || "").toLowerCase();

    // 全ての検索語句がタイトルまたは要約に含まれているかチェック（AND条件）
    return searchTerms.every(term => {
      return title.includes(term) || summary.includes(term);
    });
  });

  if (relevantArticles.length === 0) {
    return `<p>キーワード「<strong>${keyword}</strong>」に関連する記事は見つかりませんでした。</p>`;
  }

  // 3. AIに渡すテキストを作成（直近30件に絞る）
  const limit = 30;
  const targetArticles = relevantArticles.slice(0, limit); 
  
  let contextText = `【分析対象のキーワード】: ${keyword}\n\n【記事リスト】:\n`;
  targetArticles.forEach((row, i) => {
    const date = row[0]; 
    const title = row[1]; // B列（元の記事タイトル）
    const summary = row[Config.CollectSheet.Columns.SUMMARY - 1]; // E列（日本語見出し/要約）
    const url = row[Config.CollectSheet.Columns.URL - 1]; // C列（URL）

    // AIの出力テキストを日本語リンクにするため、タイトル部分に日本語見出しを使用
    contextText += `[${i+1}] 日付:${date} / タイトル:${summary} / URL:${url}\n---\n`;
  });

  // 4. プロンプトの作成（変更なし）
  const systemPrompt = `
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

  try {
    // LLM呼び出し
    const props = PropertiesService.getScriptProperties();
    // モデルは高次分析用 mini を指定
    const model = props.getProperty("OPENAI_MODEL_MINI") || "gpt-4.1-mini";
    // Azureのエンドポイント: 高次分析用を指定
    const azureUrl = props.getProperty("AZURE_ENDPOINT_URL_MINI");
    // 温度を指定
    const options = { temperature: 0.4 };

    let analysisResult = callLlmWithFallback(systemPrompt, contextText, model, azureUrl, options);

    // 不要なバッククォート削除
    analysisResult = analysisResult.replace(/^```html\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");

    // フォールバック全て失敗時のエラー処理
    if (analysisResult.includes("いずれのLLMでも")) {
        throw new Error("LLMによる分析に失敗しました。詳細はログを確認してください。");
    }
    
    return `
      <div style="margin-bottom: 15px;">
        <strong>🔍 分析対象:</strong> ${relevantArticles.length}件中、直近${targetArticles.length}件<br>
        <strong>🔑 キーワード:</strong> ${keyword} (AND検索)
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
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Config.SheetNames.TREND_DATA);
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
    const url = row[Config.CollectSheet.Columns.URL - 1]; // C列
    
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
 * normalizeUrl
 * 【責務】URL 正規化（重複判定用）
 * 【処理】
 *   1. URL デコード
 *   2. クエリパラメータ＆フラグメント削除
 *   3. プロトコル・www. 吸収
 * @param {string} url - 対象 URL
 * @returns {string} 正規化済み URL
 */
function normalizeUrl(url) {
  if (!url) return "";
  let s = String(url).trim();
  
  // 1. 【最重要】URLデコードを実行し、エンコーディングの違いを吸収する
  try {
    s = decodeURIComponent(s);
  } catch (e) {
    // デコードできなかった場合（既にデコードされている等）は、そのまま続行
  }
  
  // 2. クエリパラメータ (?) とフラグメント (#) を削除
  const queryIndex = s.indexOf('?');
  if (queryIndex > -1) {
    s = s.substring(0, queryIndex);
  }
  const hashIndex = s.indexOf('#');
  if (hashIndex > -1) {
    s = s.substring(0, hashIndex);
  }
  
  // 3. プロトコル削除 (http/httpsの揺れ吸収)
  s = s.replace(/^https?:\/\//, "//");
  
  // 4. www.削除
  s = s.replace(/\/\/www\./, "//");
  
  // 5. 末尾スラッシュ削除
  s = s.replace(/\/$/, "");
  
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
