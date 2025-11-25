/**
 * @file RSScollect.js
 * @description RSSフィードを収集し、AIで見出しと週次ダイジェストを生成するGoogle Apps Script
 * @version 2.6.0
 * @date 2025-11-10
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

// Triggers: スクリプトのエントリポイント（タイムトリガーなどから呼び出す）
/**
 * mainAutomationFlow
 * 日次トリガー用のエントリポイント。
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
 * 日刊ダイジェストを生成・送信するエントリポイント。
 * 対象期間: 過去24時間 (1日)。キーワードではなく、全記事を対象とする。
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
 * 週次ダイジェストを生成・送信するエントリポイント。
 * 引数:
 *  - webUiKeyword: Web UI 経由で単発にキーワードを指定する場合に使用
 *  - returnHtmlOnly: true を指定すると HTML 本文のみを返す（テスト用）
 * 内部で記事抽出、フィルタリング、LLM 呼び出し、メール送信を行います。
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
 * 日次処理内で未生成の見出し（E列）をチェックし、AIで見出しを生成する。
 * 【改善】5分経過したらタイムアウトを回避するために処理を中断し、そこまでの結果を保存する機能を追加
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

// Weekly digest: 週次ダイジェストの作成・送信ロジック

/**
 * _filterRelevantArticles
 * 指定したキーワードに合致する記事を抽出し、キーワード毎のヒット数を集計する。
 * 入力: 全記事配列、（オプション）単発キーワード
 * 出力: { relevantArticles, hitKeywordsWithCount, articleKeywordMap }
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
 * コンソールにキーワード別ヒット数を整形して出力するヘルパー。
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
 * 週次ダイジェストの本文を生成し、設定に応じてメール送信する。
 * returnHtmlOnly=true の場合は HTML を返す（WebUI 用/テスト用）。
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


/*******************************************************
 * _generateAndSendDailyDigest  （差し替え版）
 * 日刊ダイジェスト：全記事から LLM でトピック抽出＆要約し送信
 * Azure > OpenAI > Gemini のフォールバック順で実行
 *******************************************************/
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

/********************************************************
 * callDailyDigestLlm（新規追加）
 * 日刊ダイジェスト用：Azure > OpenAI > Gemini の順に試行
 * - モデル指定は OpenAI 用のみ（props: OPENAI_MODEL_DAILY）
 * - Azure はデプロイメントURLに紐づくモデルが使用されます
 ********************************************************/
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
 * プロンプト設定シートから、日刊ダイジェスト用のプロンプトを取得する。
 * DAILY_DIGEST_SYSTEM (A列) と DAILY_DIGEST_USER (A列) の2つのキーを参照します。
 * @returns {[string, string]} [システムプロンプト, ユーザープロンプト]
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
 * 対象記事が無い場合の通知処理（メール送信など）。
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
 * 記事をヒューリスティックでスコア付けし、上位 N 件を選抜する。
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
 * LLM を用いてトレンドセクションを生成するラッパー。
 */
function generateWeeklyReportWithLLM(articles, hitKeywordsWithCount, articlesGroupedByKeyword) {
  const LINKS_PER_TREND = 3;
  const hitKeywords = hitKeywordsWithCount.map(item => item.keyword);
  const trends = _llmMakeTrendSections(articlesGroupedByKeyword, LINKS_PER_TREND, hitKeywords);
  return { reportBody: trends };
}

/**
 * getArticlesInDateWindow
 * 指定した期間に該当する `collect` シート上の記事を取得する。
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
 * 週次ダイジェストを HTML メールで送信する。
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

// Trend detector: トレンド検出関連の関数群

/**
 * detectAndRecordTrends
 * 日次トレンド検出のエントリポイント。
 * - 過去1日分の記事タイトルを集め、LLMで重要キーワードを抽出
 * - 過去の `Trends` シートから履歴を取得し、変化率を計算
 * - 検出されたトレンドを `Trends` シートに記録
 * 副作用: `Trends` シートに行を追加
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
 * トレンド解析対象となる期間内（days）の記事タイトルを取得する。
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
 * `Trends` シートから過去 N 日分のキーワード一覧を取得し、
 * 本日のキーワードとの一致判定に用いる。
 * 過去のカウント集計は不要（変化率計算は不要）。
 * 返り値: Map<keyword, true> （キーワードの存在確認用）
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
 * 本日のキーワードと過去7日分のキーワード一覧を照合し、
 * 既出キーワードなら「ホット」フラグを立てる。
 * 新規キーワードまたは出現回数が少ないものは「通常」扱い。
 * 変化率表示: 🆕 New（新規）または ✓ 既出キーワード
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
 * 検出されたトレンド情報を `Trends` シートへ書き込む。
 * 本日のキーワードが既に存在する場合は出現回数を更新し、
 * 新規キーワードの場合は新規行を追加する。
 * 各行は A: 日付, B: キーワード(英語), C: キーワード(日本語) [数式], D: 出現回数, E: 変化率, F: 関連記事数, G: 要約
 * 書き込み後、D列（出現回数）を降順でソートして視覚的に傾向を把握しやすくする。
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
// LLM service: LLM 呼び出しラッパー

/**
 * _callAzureLlm
 * Azure OpenAI (Chat Completions) を呼び出す。失敗時は null を返す。
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
 * OpenAI Chat Completions API を呼び出す。
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
 * Google Generative Language (Gemini) を呼び出すラッパー。
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
 * Azure/OpenAI/Gemini の順で呼び出し、成功した結果を返す。全て失敗した場合はエラーメッセージを返す。
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
 * 記事テキストを LLM に投げて要約（JSON等）を取得する。
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
 * トレンドごとのセクションを LLM で生成する。
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
 * テキスト群を LLM に投げて重要キーワードを抽出する。
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
// Utilities: 補助関数群（ファイル下部にまとめています）

/**
 * getWeightedKeywords
 * Keywords シートから、有効フラグが立っているキーワードのリストを取得する。
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
 * prompt シートから LLM プロンプトテンプレートを取得する。
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
 * スクリプトプロパティから週次ダイジェスト設定を読み込む。
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
 * 記事のキーワードマッチ、新しさ、抜粋長に基づいてスコア（0-100）を計算する。
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
 * Markdown テキストを HTML に変換する。
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
 * HTML タグを除去してテキストのみを抽出する。
 */
function stripHtml(html) {
  return html ? html.replace(/<[^>]*>?/gm, '') : '';
}

/**
 * isLikelyEnglish
 * テキストに日本語文字（ひらがな、カタカナ、漢字）が含まれているかチェックする。
 */
function isLikelyEnglish(text) {
  return !(/[぀-ゟ゠-ヿ一-鿿]/.test(text));
}

/**
 * fmtDate
 * Date オブジェクトを "yyyy/MM/dd" 形式の文字列にフォーマットする。
 */
function fmtDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd");
}

/**
 * _logError
 * エラー情報をコンソールに整形して出力する。
 */
function _logError(functionName, error, message = "") {
  Logger.log(`[ERROR] ${functionName}: ${message} ${error.toString()} Stack: ${error.stack}`);
}

/**
 * getDateWindow
 * 指定日数前から現在までの日付範囲 { start, end } を計算する。
 */
function getDateWindow(days) {
  const end = new Date();
  end.setHours(24, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(1, days));
  return { start, end };
}

// RSS collector: RSSフィードの収集と解析
/**
 * collectRssFeeds
 * RSSリスト (`RSS` シート) に登録されたフィードを巡回し、
 * 新着記事を `collect` シートに追記する処理。
 * 重複チェックや日付フィルタを行い、必要に応じて抜粋のHTML除去やソース名の付与を行う。
 * 副作用: `collect` シートの更新
 * RSSフィードを収集し、B列にタイトル、F列にソース名を書き込む
 * 過去2日以内の記事のみを対象とする（日付フィルタ）
 * RSSフィードを収集し、サイトごとにこまめに保存する（タイムアウト対策版）
 * URLの正規化を行い、重複取得を防止する。
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
 * collect シートに既に存在する記事の URL を Set で取得する。
 * 【改善】全行ではなく直近の一定数（3000件）のみをチェックすることで高速化
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
 * 指定されたURLからRSS/Atomフィードを取得してパースする
 * エラー処理とサニタイズ機能を強化
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
 * 安全にXMLの子要素のテキストを取得するヘルパー関数
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
 * XMLパースエラーの原因になりやすいHTMLタグや特殊文字を除去・置換するヘルパー関数
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
 * 記事の公開日が指定日数以内かチェックする。
 */
function isRecentArticle(pubDate, daysLimit = 7) {
  if (!pubDate || !(pubDate instanceof Date)) return false;
  const now = new Date();
  const daysOld = Math.floor((now - pubDate) / (1000 * 60 * 60 * 24));
  return daysOld <= daysLimit;
}

/**
 * sortCollectByDateDesc
 * collect シートを日付(A列)で「降順(新しい順)」に並び替える
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

// Web UI: Web アプリケーション UI

/**
 * doGet
 * Web アプリのエントリポイント。HTML テンプレート (Index) を評価して返す。
 */
function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate().setSandboxMode(HtmlService.SandboxMode.IFRAME).setTitle('RSSキーワード検索ツール');
}

/**
 * executeWeeklyDigest
 * Web UI から指定されたキーワードで週次ダイジェストを生成し HTML を返す。
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
 * Web UIから呼び出される関数。
 * 指定されたキーワードで collect シートを検索し、高度なプロンプトで分析させる。
 * 【改善】キーワードをスペース区切りで AND 検索に対応
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
 * removeDuplicates
 * 【メンテナンス用】collectシート内の重複記事（同一URL）を削除して整理する。
 * URL（C列）が同じ場合、より上の行（古い方/要約済みの方）を残します。
 * 【修正】重複チェックに normalizeUrl を使用するように変更しました。
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
 * 【最終版】重複判定用にURLを正規化する
 * 1. URLデコードでエンコーディングの不一致を解消
 * 2. クエリパラメータとフラグメントを削除
 * 3. プロトコル、www.、末尾スラッシュの揺れを吸収
 */
// function normalizeUrl を確認/置き換え
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
 * 日付文字列を受け取り、指定日数以内かどうかを判定する
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
