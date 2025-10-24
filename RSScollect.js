/**
 * @file RSScollect.js
 * @description RSSフィードを収集し、AIで見出しと週次ダイジェストを生成するGoogle Apps Script
 * @version 2.5.0
 * @date 2025-10-22
 */

// =================================================================
// 📌【運用方針メモ 2025/10/24 改訂】
// =================================================================
// - **配信形式**: 週次ダイジェストはHTMLメール形式で配信。
// - **キーワード選定**: `Keywords`シートの有効フラグ（B列が空でない）に基づき、週次ダイジェストの記事を選定。
// - **記事選抜ロジック**: 週次ダイジェストの記事は、ソースの信頼性ではなく、「キーワードのマッチ数」「鮮度」「抜粋の有無」を組み合わせたスコアで選抜。
// - **コード構造**: `weeklyDigestJob`は責務ごとにプライベート関数に分割され、可読性とメンテナンス性を向上。
// - **AIモデル**: 日次・週次処理で `OPENAI_MODEL_DAILY` と `OPENAI_MODEL_WEEKLY` を使い分ける設定は維持。
// - **廃止機能**:
//   - Teams通知機能
//   - 記事ごとのAIスコアリング（`collect`シートのG列）
//   - 週次ダイジェストのハイライト、Top Picksセクション
// =================================================================


// =================================================================
// 📌 Constants (定数定義)
// =================================================================
const Config = {
  SheetNames: {
    RSS_LIST: "RSS",
    TREND_DATA: "collect",
    PROMPT_CONFIG: "prompt", // 👈 追加
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


// =================================================================
// 🔄 1. Main Triggers (トリガー実行関数)
// =================================================================

/**
 * 【日次実行】RSSフィードの収集とAIによる見出し生成を実行
 */
function mainAutomationFlow() {
  Logger.log("--- 自動化フロー開始（収集→見出し生成のみ） ---");
  collectRssFeeds();
  processSummarization();
  Logger.log("--- 自動化フロー完了 ---");
}

/**
 * 【週次実行】週次ダイジェストを作成し、設定に応じて配信
 */
function weeklyDigestJob() {
  const config = _getDigestConfig();
  const { start, end } = getDateWindow(config.days);
  const allItems = getArticlesInDateWindow(start, end);

  if (allItems.length === 0) {
    _handleNoArticlesFound(config, start, end, "対象期間に記事がありませんでした。");
    return;
  }
  Logger.log(`週間ダイジェスト：対象期間内に ${allItems.length} 件の記事が見つかりました。`);

  const { relevantArticles, hitKeywordsWithCount, articleKeywordMap } = _filterRelevantArticles(allItems);

  if (relevantArticles.length === 0) {
    Logger.log("週間ダイジェスト：キーワードに合致する記事がありませんでした。ダイジェストは作成されません。");
    return;
  }
  Logger.log(`週間ダイジェスト：キーワードに合致する記事が ${relevantArticles.length} 件見つかりました。`);

  _logKeywordHitCounts(hitKeywordsWithCount);

  _generateAndSendDigest(relevantArticles, hitKeywordsWithCount, articleKeywordMap, config, start, end);
}

/**
 * @private
 * キーワードに基づいて記事をフィルタリングし、関連情報を返す
 */
function _filterRelevantArticles(allItems) {
  const activeKeywords = getWeightedKeywords().filter(kw => kw.active).map(kw => kw.keyword);
  const relevantArticles = [];
  const keywordHitCounts = {};
  const articleKeywordMap = new Map();

  function parseKeywordCondition(keywordCell) {
    const lower = keywordCell.toLowerCase();
    if (lower.includes(' and ')) return { type: 'and', words: keywordCell.split(/ and /i).map(w => w.trim()) };
    if (lower.includes(' or ')) return { type: 'or', words: keywordCell.split(/ or /i).map(w => w.trim()) };
    return { type: 'single', words: [keywordCell.trim()] };
  }

  const keywordConditions = activeKeywords.map(k => ({ original: k, ...parseKeywordCondition(k) }));

  allItems.forEach(article => {
    const text = `${article.title} ${article.abstractText} ${article.headline}`;
    const hitKeywordsForArticle = new Set();

    keywordConditions.forEach(cond => {
      const isMatch = (cond.type === 'and' && cond.words.every(word => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text))) ||
                      (cond.type === 'or' && cond.words.some(word => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text))) ||
                      (cond.type === 'single' && new RegExp(cond.words[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text));
      
      if (isMatch) {
        hitKeywordsForArticle.add(cond.original);
      }
    });

    if (hitKeywordsForArticle.size > 0) {
      relevantArticles.push(article);
      articleKeywordMap.set(article.url, Array.from(hitKeywordsForArticle));
      hitKeywordsForArticle.forEach(keyword => {
        keywordHitCounts[keyword] = (keywordHitCounts[keyword] || 0) + 1;
      });
    }
  });

  const hitKeywordsWithCount = Object.entries(keywordHitCounts)
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count);

  return { relevantArticles, hitKeywordsWithCount, articleKeywordMap };
}

/**
 * @private
 * キーワードごとのヒット件数をログに出力する
 */
function _logKeywordHitCounts(hitKeywordsWithCount) {
  let hitLog = "【キーワード別ヒット件数】\n";
  hitKeywordsWithCount.forEach(item => {
    hitLog += `- ${item.keyword}: ${item.count}件\n`;
  });
  Logger.log(hitLog.trim());
}

/**
 * @private
 * ダイジェストを生成し、メールで送信する
 */
function _generateAndSendDigest(relevantArticles, hitKeywordsWithCount, articleKeywordMap, config, start, end) {
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
  if (config.notifyChannel === "email" || config.notifyChannel === "both") {
    sendWeeklyDigestEmail(headerLine, reportBody, hitKeywordsWithCount);
  }
}

/**
 * @private
 * 対象記事がなかった場合の通知処理
 */
function _handleNoArticlesFound(config, start, end, message) {
  Logger.log(`週間ダイジェスト：${message}`);
  const headerLine = "集計期間：" + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1));
  const reportBody = "今週のダイジェスト対象となる記事はありませんでした。";
  if (config.notifyChannel === "email" || config.notifyChannel === "both") {
    sendWeeklyDigestEmail(headerLine, reportBody);
  }
}


// =================================================================
// 📰 2. Daily Process (日次処理)
// =================================================================

/**
 * RSSフィード群を取得し、新しい記事をシートに追記する
 */
function collectRssFeeds() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rssListSheet = ss.getSheetByName(Config.SheetNames.RSS_LIST);
  const trendDataSheet = ss.getSheetByName(Config.SheetNames.TREND_DATA);

  if (!rssListSheet || !trendDataSheet) {
    Logger.log("エラー: シート名が正しくありません。'RSS'または'collect'のシート名を確認してください。");
    return;
  }

  const lastRow = rssListSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("RSSリストシートにデータがありません。");
    return;
  }

  const rssList = rssListSheet.getRange(Config.RssListSheet.DataRange.START_ROW, 1, lastRow - 1, Config.RssListSheet.DataRange.NUM_COLS).getValues();
  const existingUrls = getExistingUrls(trendDataSheet);

  let newData = [];
  rssList.forEach(row => {
    const siteName = row[0];
    const rssUrl = row[1];
    if (rssUrl) {
      const articles = fetchAndParseRss(rssUrl, siteName, existingUrls);
      newData = newData.concat(articles);
    }
  });

  if (newData.length > 0) {
    newData.sort((a, b) => a[0] - b[0]); // 日付で昇順ソート
    const startRow = trendDataSheet.getLastRow() + 1;
    trendDataSheet.getRange(startRow, 1, newData.length, newData[0].length).setValues(newData);
    sortCollectByDateAsc(); // シート全体を降順ソート
    Logger.log(newData.length + " 件の新しい記事をシートに追記しました。");
  } else {
    Logger.log("新しい記事は見つかりませんでした。");
  }
}

/**
 * E列（見出し）が空の記事に対して、AIまたは代替テキストで見出しを生成する
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

  // シートの全データを一度に読み込む
  const dataRange = trendDataSheet.getRange(2, 1, lastRow - 1, trendDataSheet.getLastColumn());
  const values = dataRange.getValues();

  const articlesToSummarize = [];
  const llmModel = PropertiesService.getScriptProperties().getProperty("OPENAI_MODEL_DAILY") || "gpt-4.1-nano";

  values.forEach((row, index) => {
    const originalRowIndex = index; // values配列の0-indexedインデックス
    const sheetRowNumber = index + 2; // スプレッドシートの行番号

    const title = row[Config.CollectSheet.Columns.URL - 2]; // B列 (0-indexedで1)
    const abstractText = row[Config.CollectSheet.Columns.ABSTRACT - 1]; // D列 (0-indexedで3)
    const currentHeadline = row[Config.CollectSheet.Columns.SUMMARY - 1]; // E列 (0-indexedで4)

    if (!currentHeadline || String(currentHeadline).trim() === "") {
      const isShort = (abstractText === Config.Llm.NO_ABSTRACT_TEXT) || (String(abstractText || "").length < Config.Llm.MIN_SUMMARY_LENGTH);

      if (isShort) {
        let newHeadline;
        if (title && String(title).trim() !== "") {
          newHeadline = isLikelyEnglish(String(title))
            ? `=GOOGLETRANSLATE(B${sheetRowNumber},"auto","ja")`
            : String(title).trim();
        } else if (abstractText && abstractText !== Config.Llm.NO_ABSTRACT_TEXT) {
          newHeadline = isLikelyEnglish(String(abstractText))
            ? `=GOOGLETRANSLATE(D${sheetRowNumber},"auto","ja")`
            : String(abstractText).trim();
        } else {
          newHeadline = Config.Llm.MISSING_ABSTRACT_TEXT;
        }
        values[originalRowIndex][Config.CollectSheet.Columns.SUMMARY - 1] = newHeadline;
      } else {
        // LLMでの見出し生成が必要な記事を収集
        articlesToSummarize.push({
          originalRowIndex: originalRowIndex,
          title: title,
          abstractText: abstractText
        });
      }
    }
  });

  let apiCallCount = 0;
  if (articlesToSummarize.length > 0) {
    Logger.log(`${articlesToSummarize.length} 件の記事に対してAIによる見出し生成を試行します。`);
    articlesToSummarize.forEach(article => {
      const articleText = `Title: ${article.title}\nAbstract: ${article.abstractText}`;
      const newHeadline = summarizeWithLLM(articleText);
      apiCallCount++;

      // APIエラーでない場合のみ書き込む
      if (newHeadline && !newHeadline.includes("エラー") && !newHeadline.includes("いずれのLLMでも")) {
        values[article.originalRowIndex][Config.CollectSheet.Columns.SUMMARY - 1] = newHeadline;
      } else {
        Logger.log(`見出し生成失敗 (Row: ${article.originalRowIndex + 2}): ${newHeadline}`);
      }
      Utilities.sleep(Config.Llm.DELAY_MS); // APIレート制限対策
    });
  }

  // 更新されたデータ配列をシートに一括書き込み
  if (articlesToSummarize.length > 0) { // AI処理が行われた場合のみ書き戻す
    const newDataRange = trendDataSheet.getRange(2, 1, lastRow - 1, Config.CollectSheet.Columns.SOURCE);
    newDataRange.setValues(values.map(row => row.slice(0, Config.CollectSheet.Columns.SOURCE)));
    Logger.log(`LLMコール数: ${apiCallCount} 回。E列を更新しました。`);
  } else {
    Logger.log("見出し生成が必要な記事は見つかりませんでした。");
  }
}


// =================================================================
// 🗓️ 3. Weekly Digest Process (週次ダイジェスト処理)
// =================================================================

/**
 * キーワードベースのヒューリスティックスコアで記事を選抜・整列し、上位記事リストを返す
 */
function rankAndSelectArticles(relevantArticles, config, articleKeywordMap) {
  const topN = config.topN || 20;

  // ① ヒューリスティックスコアを計算してソート
  const scoredArticles = relevantArticles
    .map(a => ({
      ...a,
      heuristicScore: computeHeuristicScore(a, articleKeywordMap)
    }))
    .sort((a, b) => b.heuristicScore - a.heuristicScore);

  // ② 上位N件を選抜（ソースの偏り抑制は行わない）
  const picked = [];
  // const perSourceCount = {}; // 不要になったため削除
  for (const item of scoredArticles) {
    // const src = item.source || "unknown"; // 不要になったため削除
    // perSourceCount[src] = (perSourceCount[src] || 0); // 不要になったため削除
    // if (perSourceCount[src] < perSourceCap) { // 制限を解除
      picked.push(item);
      // perSourceCount[src]++; // 不要になったため削除
    // }
    if (picked.length >= topN) break;
  }

  // ③ 上位記事を選抜して返す
  return { selectedTopN: picked };
}

/**
 * AIを使い、選抜された記事からダイジェストの本文(Markdown)を生成する
 */
function generateWeeklyReportWithLLM(articles, hitKeywordsWithCount, articlesGroupedByKeyword) {
  const LINKS_PER_TREND = 3;

  // アクティブなキーワードを取得
  const hitKeywords = hitKeywordsWithCount.map(item => item.keyword);

  // キーワードごとのトレンドセクションを生成
  const trends = _llmMakeTrendSections(articlesGroupedByKeyword, LINKS_PER_TREND, hitKeywords);

  // 生成されたトレンドレポート本文を返す
  return { reportBody: trends };
}




// =================================================================
// 🤖 4. LLM Clients & Sub-routines (AI関連)
// =================================================================

/**
 * LLMを呼び出す汎用関数（Azure優先→OpenAI→Geminiへフォールバック）
 */
/**
 * Azure OpenAI APIを呼び出すプライベート関数
 * @returns {string|null} 生成された見出し、またはエラー時はnull
 */
function _callAzureLlm(systemPrompt, userPrompt, azureUrl, azureKey) {
  Logger.log("Azure OpenAIを試行中...");
  const payload = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt }
    ],
    temperature: 0.2,
    max_completion_tokens: 2048
  };
  const options = {
    method: "post",
    contentType: "application/json",
    headers: { "api-key": azureKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch(azureUrl, options);
    const code = res.getResponseCode();
    const txt  = res.getContentText();
    if (code !== 200) {
      _logError("_callAzureLlm", new Error(`API Error: ${code} - ${txt}`), "Azure OpenAI APIエラーが発生しました。");
      return null;
    } else {
      const json = JSON.parse(txt);
      if (json && json.choices && json.choices.length > 0 && json.choices[0].message && json.choices[0].message.content) {
        return String(json.choices[0].message.content).trim();
      } else {
        _logError("_callAzureLlm", new Error("No content in response"), "Azure OpenAIから見出しが生成できませんでした。");
        return null;
      }
    }
  } catch (e) {
    _logError("_callAzureLlm", e, "Azure OpenAI呼び出し中に例外が発生しました。");
    return null;
  }
}

/**
 * OpenAI APIを呼び出すプライベート関数
 * @returns {string|null} 生成された見出し、またはエラー時はnull
 */
function _callOpenAiLlm(systemPrompt, userPrompt, openAiModel, openAiKey) {
  Logger.log("OpenAI APIを試行中...");
  const payload = {
    model: openAiModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    max_tokens: 2048
  };
  const options = {
    method: "post",
    contentType: "application/json",
    headers: { "Authorization": `Bearer ${openAiKey}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", options);
    const code = res.getResponseCode();
    const txt  = res.getContentText();
    if (code !== 200) {
      _logError("_callOpenAiLlm", new Error(`API Error: ${code} - ${txt}`), "OpenAI APIエラーが発生しました。");
      return null;
    } else {
      const json = JSON.parse(txt);
      if (json.choices && json.choices.length > 0 && json.choices[0].message && json.choices[0].message.content) {
        return String(json.choices[0].message.content).trim();
      } else {
        _logError("_callOpenAiLlm", new Error("No content in response"), "OpenAIから見出しが生成できませんでした。");
        return null;
      }
    }
  } catch (e) {
    _logError("_callOpenAiLlm", e, "OpenAI呼び出し中に例外が発生しました。");
    return null;
  }
}

/**
 * Gemini APIを呼び出すプライベート関数
 * @returns {string|null} 生成された見出し、またはエラー時はnull
 */
function _callGeminiLlm(systemPrompt, userPrompt, geminiApiKey) {
  Logger.log("Gemini APIを試行中...");
  const API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/" + Config.Llm.MODEL_NAME + ":generateContent?key=" + geminiApiKey;
  const PROMPT = (systemPrompt || "") + "\n\n" + (userPrompt || "");
  const payload = {
    contents: [{ parts: [{ text: PROMPT }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
  };
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(API_ENDPOINT, options);
    const json = JSON.parse(response.getContentText());
    let text = null;
    if (json && json.candidates && json.candidates.length > 0 && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts.length > 0) {
      text = json.candidates[0].content.parts[0].text;
    }
    const headline = text ? String(text).trim() : (json && json.error ? ("API Error: " + json.error.message) : "見出しが生成できませんでした。");
    Utilities.sleep(Config.Llm.DELAY_MS); // Gemini APIのレート制限対策
    return headline;
  } catch (e) {
    _logError("_callGeminiLlm", e, "Gemini API呼び出し中に例外が発生しました。");
    return null;
  }
}

/**
 * LLMを呼び出す汎用関数（Azure優先→OpenAI→Geminiへフォールバック）
 */
function callLlmWithFallback(systemPrompt, userPrompt, openAiModel = "gpt-4.1-nano", azureUrlOverride = null) {
  const props = PropertiesService.getScriptProperties();
  const azureUrl = azureUrlOverride || props.getProperty("AZURE_ENDPOINT_URL");
  const azureKey = props.getProperty("OPENAI_API_KEY");
  const openAiKey = props.getProperty("OPENAI_API_KEY_PERSONAL");
  const geminiApiKey = props.getProperty("GEMINI_API_KEY");

  let result = null;

  // 1. Azure OpenAI
  if (azureUrl && azureKey) {
    result = _callAzureLlm(systemPrompt, userPrompt, azureUrl, azureKey);
    if (result !== null) return result;
    Logger.log("Azure OpenAIでの呼び出しに失敗しました。OpenAI APIを試行します。");
  }

  // 2. OpenAI
  if (openAiKey) {
    result = _callOpenAiLlm(systemPrompt, userPrompt, openAiModel, openAiKey);
    if (result !== null) return result;
    Logger.log("OpenAI APIでの呼び出しに失敗しました。Gemini APIを試行します。");
  }

  // 3. Gemini
  if (geminiApiKey) {
    result = _callGeminiLlm(systemPrompt, userPrompt, geminiApiKey);
    if (result !== null) return result;
    Logger.log("Gemini APIでの呼び出しに失敗しました。");
  }

  return "いずれのLLMでも見出しを生成できませんでした。";
}

/**
 * 【日次用】記事の抜粋からネットニュース風の見出しを1行生成
 */
function summarizeWithLLM(articleText) {
  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty("OPENAI_MODEL_DAILY") || "gpt-4.1-nano";
  
  const SYSTEM = getPromptConfig("BATCH_SYSTEM");
  const USER_TEMPLATE = getPromptConfig("BATCH_USER_TEMPLATE");

  if (!SYSTEM || !USER_TEMPLATE) {
    return "エラー: BATCHプロンプト設定が見つかりません。";
  }
  
  // テンプレートに記事内容を挿入
  const USER = USER_TEMPLATE + [
    "",
    "記事: ---",
    articleText,
    "---"
  ].join("\n");

  return callLlmWithFallback(SYSTEM, USER, model);
}






/**
 * 【週次・サブルーチン】主要トレンドセクションを生成
 */
function _llmMakeTrendSections(articlesGroupedByKeyword, linksPerTrend, hitKeywords) {

  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty("OPENAI_MODEL_WEEKLY") || "gpt-4.1-mini";
  const azureWeeklyUrl = props.getProperty("AZURE_ENDPOINT_URL_WEEKLY")
  
  const SYSTEM = getPromptConfig("TREND_SYSTEM");
  const USER_TEMPLATE = getPromptConfig("TREND_USER_TEMPLATE");

  if (!SYSTEM || !USER_TEMPLATE) {
    Logger.log("エラー: WEEKLYトレンドプロンプト設定が見つかりません。");
    return "今週のトレンドは生成できませんでした。";
  }
  var system = SYSTEM; // 変数名をSYSTEMに変更

  const allTrends = [];

  // キーワードごとにトレンドを生成
  for (const keyword of hitKeywords) { // hitKeywords をループ
    const articlesForKeyword = articlesGroupedByKeyword[keyword];

    if (!articlesForKeyword || articlesForKeyword.length === 0) {
      continue; // そのキーワードに関連する記事がない場合はスキップ
    }

    const keywordHeader = `キーワード「${keyword}」\n`;

    var articleListForLlm = articlesForKeyword.map(function(a){
      return `- 見出し: ${a.headline}\n  要約: ${a.tldr}\n  URL: ${a.url}`;
    }).join("\n");

    var user = [
      USER_TEMPLATE, // ⬇️ 修正: テンプレートを使用
      `キーワード: ${keyword}`,
      "",
      "各トレンドについて、以下の厳密なMarkdown形式で出力してください。",
      "",
      "1. 15〜25字程度のキャッチーなトレンド名称を太字で記述してください。",
      "2. 150〜200字程度で、なぜ今このトレンドが重要なのか、背景、具体的な進展、将来の展望などを、複数の記事から得られた情報を統合・要約して記述してください。**この解説文には、キーワードを自然に含めてください。** 箇条書きは使用しないでください。",
      "3. そのトレンドを最もよく表している記事を${linksPerTrend}つまで、`・[記事の見出し](記事のURL)` の形式で記述してください。",
      "",
      "前書きや後書きは一切不要です。",
      "",
      "【記事リスト】",
      articleListForLlm
    ].join("\n");

    var txt = callLlmWithFallback(system, user, model, azureWeeklyUrl);
    if (txt && txt.trim()) {
      allTrends.push(keywordHeader + txt.trim());
    } else {
      // フォールバック処理（キーワードごとのフォールバック）
      if (articlesForKeyword.length > 0) {
        allTrends.push(
          keywordHeader +
          `**${keyword}関連のトレンド**\n` +
          `このキーワードに関するトレンドは生成できませんでした。関連する記事をいくつか紹介します。\n` +
          articlesForKeyword.slice(0, linksPerTrend).map(a => `・[${a.title}](${a.url})`).join("\n")
        );
      }
    }
  }
  return allTrends.join("\n\n---\n\n"); // 各トレンドを二重改行と区切り線で結合
}



// =================================================================
// ✉️ 5. Notification Handlers (通知関連)
// =================================================================

function sendWeeklyDigestEmail(headerLine, mdBody, hitKeywordsWithCount) {
  const props = PropertiesService.getScriptProperties();
  const to = props.getProperty("MAIL_TO");
  if (!to) { Logger.log("MAIL_TO未設定のためメール送信せず。"); return; }

  const subjectPrefix = props.getProperty("MAIL_SUBJECT_PREFIX") || "【週間RSS】";
  const senderName    = props.getProperty("MAIL_SENDER_NAME") || "RSS要約ボット";
  const today         = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd");
  const sheetUrl      = props.getProperty("DIGEST_SHEET_URL") || "(DIGEST_SHEET_URL 未設定)";

  // キーワード情報をメール本文に追加
  let keywordSection = "";
  if (hitKeywordsWithCount && hitKeywordsWithCount.length > 0) {
    keywordSection = "\n\n### 今週の注目キーワード\n";
    hitKeywordsWithCount.forEach(item => {
      keywordSection += `- **${item.keyword}** (${item.count}件)\n`;
    });
    keywordSection += "\n\n---\n\n"; // 区切り線と前後の改行を追加
  }

  const fullMdBody = keywordSection + mdBody + `\n\n---\nその他の記事一覧は[こちらのスプレッドシート](${sheetUrl})でご覧いただけます。`; // 順序を入れ替え
  const textBody = headerLine + "\n\n" + fullMdBody;
  const finalSubject = subjectPrefix + today;

  const htmlHeader = headerLine.replace(/\n/g, '<br>');
  const htmlContent = markdownToHtml(fullMdBody);
  const fullHtmlBody = `
    <div style="font-family: Meiryo, 'Hiragino Sans', 'MS PGothic', sans-serif; font-size: 14px; line-height: 1.7; color: #333;">
      ${htmlHeader}<br><br>
      ${htmlContent}
    </div>`;

  GmailApp.sendEmail(to, finalSubject, textBody, {
    name: senderName,
    htmlBody: fullHtmlBody
  });
  Logger.log("メール送信（HTML形式）完了: " + to);
}

// =================================================================
// 🛠️ 6. Utilities & Helpers (ユーティリティ)
// =================================================================

// 直近N日以内か判定する関数（例：7日間）
function isRecentArticle(pubDate, daysLimit = 7) {
  if (!pubDate || !(pubDate instanceof Date)) return false;
  const now = new Date();
  const daysOld = Math.floor((now - pubDate) / (1000 * 60 * 60 * 24));
  return daysOld <= daysLimit;
}

/**
 * 「Keywords」シートからキーワードと優先度（High/Low/空欄）を取得し、重み付きリストを返す
 */
function getWeightedKeywords(sheetName = "Keywords") {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  // 1行目はヘッダー（A:キーワード, B:有効フラグ）
  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues(); // 2列目まで読み込む
  return values.map(([keyword, activeFlag]) => {
    return {
      keyword: String(keyword).trim(),
      active: String(activeFlag).trim() !== "" // 空欄以外ならtrue
    };
  }).filter(obj => obj.keyword);
}

function getPromptConfig(key) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(Config.SheetNames.PROMPT_CONFIG);
  if (!sheet) {
    Logger.log(`エラー: promptシートが見つかりません。キー: ${key}`);
    return null;
  }
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  // A列とB列のデータを取得
  const values = sheet.getRange(1, 1, lastRow, 2).getValues();

  // マップに変換して検索
  const promptMap = new Map(values.map(row => [String(row[0]).trim(), row[1]]));

  const content = promptMap.get(key);

  if (!content) {
    Logger.log(`警告: promptシートにキー ${key} が見つかりませんでした。`);
    return null;
  }

  // 取得した内容を文字列としてトリムして返す
  return String(content).trim();
}

/**
 * 週次ダイジェストの設定をスクリプトプロパティから読み込む
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
 * ルールベースの重要度スコア（0-100）を計算
 * @param {object} article - 記事オブジェクト
 * @param {Map<string, string[]>} articleKeywordMap - 記事URLとマッチしたキーワードリストのマップ
 * @returns {number} 0から100のスコア
 */
function computeHeuristicScore(article, articleKeywordMap) {
  const now = new Date();
  const daysOld = Math.max(0, Math.floor((now - article.date) / (1000 * 60 * 60 * 24)));

  // 1. キーワードスコア (40点満点): マッチしたキーワードの数に基づいてスコアを算出
  const matchedKeywords = articleKeywordMap.get(article.url) || [];
  const keywordScore = Math.min(40, matchedKeywords.length * 8); // 1キーワードあたり8点、最大40点

  // 2. 鮮度スコア (40点満点): 記事の鮮度を指数関数的に評価
  const freshnessScore = 40 * Math.exp(-daysOld / 7);

  // 3. 抜粋ボーナス (20点満点): 抜粋の有無と長さに応じてボーナス
  const hasAbstract = article.abstractText && article.abstractText !== Config.Llm.NO_ABSTRACT_TEXT;
  const abstractBonus = hasAbstract ? Math.min(20, String(article.abstractText).length / 100) : 0;

  const rawScore = keywordScore + freshnessScore + abstractBonus;
  return Math.max(0, Math.min(100, Math.round(rawScore)));
}

/**
 * 指定された期間内の記事をシートから取得
 */
function getArticlesInDateWindow(start, end) {
  const sh = SpreadsheetApp.getActive().getSheetByName(Config.SheetNames.TREND_DATA);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  const vals = sh.getRange(2, 1, lastRow - 1, Config.CollectSheet.Columns.SOURCE).getValues(); // A..F
  const out = [];
  for (const r of vals) {
    const date = r[0];
    if ((date instanceof Date) && date >= start && date < end) {
      const headline = r[4]; // E列
      if (headline && String(headline).trim() !== "" && String(headline).indexOf("API Error") === -1) {
        out.push({
          date: date,
          title: r[1],
          url: r[2],
          abstractText: r[3],
          headline: String(headline).trim(),
          source: r[5] ? String(r[5]) : "",
          tldr: String(headline).trim(), // headlineをtldrにも設定
        });
      }
    }
  }
  out.sort((a, b) => a.date - b.date);
  return out;
}

/**
 * collectシートを日付の降順でソート
 */
function sortCollectByDateAsc() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Config.SheetNames.TREND_DATA);
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).sort({ column: 1, ascending: false });
    Logger.log("collectシートを日付で降順にソートしました。");
  }
}

/**
 * collectシートから既存記事のURLセットを取得
 */
function getExistingUrls(sheet) {
  if (sheet.getLastRow() < 2) return new Set();
  return new Set(sheet.getRange(2, Config.CollectSheet.Columns.URL, sheet.getLastRow() - 1, 1).getValues().flat());
}

/**
 * RSS/Atomフィードを取得・解析
 */
function fetchAndParseRss(rssUrl, siteName, existingUrls) {
  let articles = [];
  try {
      const options = {
      'headers': {
        // 現在のUser-Agentを維持
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/xml,application/rss+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      'muteHttpExceptions': true
    };

    const response = UrlFetchApp.fetch(rssUrl, options);
    const code = response.getResponseCode();

    if (code !== 200) {
      throw new Error(`HTTP Error Code: ${code}. Check if the URL is accessible or if the server blocks automated requests.`);
    }

    let preprocessedXml = response.getContentText();
    if (preprocessedXml.includes('atom:link') && !preprocessedXml.includes('xmlns:atom')) {
        preprocessedXml = preprocessedXml.replace(/<rss([^>]*)>/i, '<rss$1 xmlns:atom="http://www.w3.org/2005/Atom">');
    }
    
    const document = XmlService.parse(preprocessedXml);
    const root = document.getRootElement();

    if (root.getChild("channel")) {
      articles = parseRss2Feed(root, siteName, existingUrls);
    } else {
      articles = parseAtomFeed(root, siteName, existingUrls);
    }
  } catch (e) {
    _logError("fetchAndParseRss", e, `RSS/Atomフィードの取得またはパース中にエラーが発生しました。URL: ${rssUrl}`);
  }
  return articles;
}

/**
 * RSS 2.0フィードをパース
 */
function parseRss2Feed(root, siteName, existingUrls) {
  const rssArticles = [];
  const channel = root.getChild("channel");
  if (channel) {
    const items = channel.getChildren("item");
    items.forEach(item => {
      const title = (item.getChild("title") && item.getChild("title").getText()) || "";
      const link  = (item.getChild("link") && item.getChild("link").getText()) || "";
      const pubDateStr = (item.getChild("pubDate") && item.getChild("pubDate").getText()) || ""; // ⬅️ 日付文字列を取得
      const description = (item.getChild("description") && item.getChild("description").getText()) || "";

      // 🌟 修正点：pubDateStrをDateオブジェクトに変換
      const articleDate = pubDateStr ? new Date(pubDateStr) : new Date(0); // 無効な日付は過去（エポック）として扱う

      if (link && !existingUrls.has(link) && title && isRecentArticle(articleDate, 7)) { // ⬅️ 修正：articleDateを使って判定
        rssArticles.push([
          articleDate, // ⬅️ 修正：Dateオブジェクトを格納
          title.trim(),
          link.trim(),
          stripHtml(description) || Config.Llm.NO_ABSTRACT_TEXT,
          "",
          siteName
        ]);
      }
    });
  }
  return rssArticles;
}

/**
 * Atomフィードをパース
 */
function parseAtomFeed(root, siteName, existingUrls) {
  const atomArticles = [];
  const ATOM_NS = XmlService.getNamespace("http://www.w3.org/2005/Atom");
  const entries = root.getChildren("entry", ATOM_NS) || [];
  entries.forEach(entry => {
    const title = (entry.getChild("title", ATOM_NS) && entry.getChild("title", ATOM_NS).getText()) || "";
    let link = "";
    const linkElArr = entry.getChildren("link", ATOM_NS) || [];
    for (var i = 0; i < linkElArr.length; i++) {
      const relAttr = linkElArr[i].getAttribute("rel");
      if (!relAttr || relAttr.getValue() === "alternate") {
        const hrefAttr = linkElArr[i].getAttribute("href");
        if (hrefAttr) link = hrefAttr.getValue();
        break;
      }
    }
    const updatedEl = entry.getChild("updated", ATOM_NS);
    const publishedEl = entry.getChild("published", ATOM_NS);
    const pubDateStr = (updatedEl && updatedEl.getText()) || (publishedEl && publishedEl.getText()) || ""; // ⬅️ 日付文字列を取得
    const summaryEl = entry.getChild("summary", ATOM_NS);
    const contentEl = entry.getChild("content", ATOM_NS);
    const summary = (summaryEl && summaryEl.getText()) || (contentEl && contentEl.getText()) || "";

    // 🌟 修正点：pubDateStrをDateオブジェクトに変換
    const articleDate = pubDateStr ? new Date(pubDateStr) : new Date(0); // 無効な日付は過去（エポック）として扱う

    if (link && !existingUrls.has(link) && title && isRecentArticle(articleDate, 7)) { // ⬅️ 修正：articleDateを使って判定
      atomArticles.push([
        articleDate, // ⬅️ 修正：Dateオブジェクトを格納
        title.trim(),
        link.trim(),
        stripHtml(summary) || Config.Llm.NO_ABSTRACT_TEXT,
        "",
        siteName
      ]);
    }
  });
  return atomArticles;
}

/**
 * 簡易的なMarkdownをHTMLに変換
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
 * HTMLタグを除去
 */
function stripHtml(html) {
  return html ? html.replace(/<[^>]*>?/gm, '') : '';
}

/**
 * 英語らしき文字列か簡易判定
 */
function isLikelyEnglish(text) {
  return !(/[぀-ゟ゠-ヿ一-鿿]/.test(text));
}

/**
 * 日付をyyyy/MM/dd形式の文字列にフォーマット
 */
function fmtDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd");
}

/**
 * エラーをログに記録
 */
function _logError(functionName, error, message = "") {
  Logger.log(`[ERROR] ${functionName}: ${message} ${error.toString()} Stack: ${error.stack}`);
}

/**
 * 期間ウィンドウ（今日含む過去N日）を取得
 */
function getDateWindow(days) {
  const end = new Date();
  end.setHours(24, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(1, days));
  return { start, end };
}

