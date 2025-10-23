/**
 * @file RSScollect.js
 * @description RSSフィードを収集し、AIで見出しと週次ダイジェストを生成するGoogle Apps Script
 * @version 2.5.0
 * @date 2025-10-22
 */

// =================================================================
// 📌【運用方針メモ 2025/10/22 改訂】
// =================================================================
// - **配信形式**: 週次ダイジェストはHTMLメールを正とし、Teams通知は運用停止。
// - **キーワード選定**: Keywordsシートの「有効」フラグ（Y/N）に基づき、Weeklyダイジェストの記事を選定。
// - **リファクタリング**: 未使用のTeams通知関連関数および_parseWeeklyReportOutput関数を削除。Keywordsシートの優先度による重み付けを廃止。CollectシートのG列(AIスコア)とH列(AI TL;DR)を削除。rankAndSelectArticles関数における1ソースあたりの最大採用数制限を解除。
// - **AIモデル**: 日次・週次で `OPENAI_MODEL_DAILY` と `OPENAI_MODEL_WEEKLY` を使い分ける。
// - **AI評価**: 週次ダイジェストのスコア・要約評価は、効率的なバッチ処理を基本とする。
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
  Digest: {
    DEFAULT_USE_AI_RANK: "N",
    DEFAULT_AI_CANDIDATES: 50,
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
    Logger.log("週間ダイジェスト：対象期間に記事なし");
    const headerLine = "集計期間：" + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1));
    const reportBody = "今週のダイジェスト対象となる記事はありませんでした。";
    if (config.notifyChannel === "email" || config.notifyChannel === "both") {
      sendWeeklyDigestEmail(headerLine, reportBody);
    }
    return;
  }
  Logger.log(`週間ダイジェスト：対象期間内に ${allItems.length} 件の記事が見つかりました。`);

  // Keywordsシートから有効なキーワードを取得
  const activeKeywords = getWeightedKeywords().filter(kw => kw.active).map(kw => kw.keyword);

  const relevantArticles = [];
  const keywordHitCounts = {};
  const articleKeywordMap = new Map(); // 各記事がヒットしたキーワードを記録

  // activeKeywords を正規表現オブジェクトの配列に変換

  function parseKeywordCondition(keywordCell) {
    // "A and B" → {type: "and", words: ["A", "B"]}
    // "A or B" → {type: "or", words: ["A", "B"]}
    // "A" → {type: "single", words: ["A"]}
    const lower = keywordCell.toLowerCase();
    if (lower.includes(' and ')) {
      return { type: 'and', words: keywordCell.split(/ and /i).map(w => w.trim()) };
    } else if (lower.includes(' or ')) {
      return { type: 'or', words: keywordCell.split(/ or /i).map(w => w.trim()) };
    } else {
      return { type: 'single', words: [keywordCell.trim()] };
    }
  }

  const keywordConditions = activeKeywords.map(k => ({
    original: k,
    ...parseKeywordCondition(k)
  }));

  allItems.forEach(article => {
    const text = `${article.title} ${article.abstractText} ${article.headline}`;
    let articleHasHitKeyword = false;
    const hitKeywordsForArticle = [];
    keywordConditions.forEach(cond => {
      if (cond.type === 'and') {
        // すべての単語が含まれているか
        if (cond.words.every(word => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text))) {
          articleHasHitKeyword = true;
          hitKeywordsForArticle.push(cond.original);
          keywordHitCounts[cond.original] = (keywordHitCounts[cond.original] || 0) + 1;
        }
      } else if (cond.type === 'or') {
        // いずれかの単語が含まれているか
        if (cond.words.some(word => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text))) {
          articleHasHitKeyword = true;
          hitKeywordsForArticle.push(cond.original);
          keywordHitCounts[cond.original] = (keywordHitCounts[cond.original] || 0) + 1;
        }
      } else {
        // 単独キーワード
        if (new RegExp(cond.words[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)) {
          articleHasHitKeyword = true;
          hitKeywordsForArticle.push(cond.original);
          keywordHitCounts[cond.original] = (keywordHitCounts[cond.original] || 0) + 1;
        }
      }
    });
    if (articleHasHitKeyword) {
      relevantArticles.push(article);
      articleKeywordMap.set(article.url, hitKeywordsForArticle);
    }
  });

  // keywordHitCounts を配列に変換し、件数が多い順にソート
  const hitKeywordsWithCount = Object.entries(keywordHitCounts)
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count);

  // relevantArticlesが空の場合のガード節を修正（メール送信を削除）
  if (relevantArticles.length === 0) {
    Logger.log("週間ダイジェスト：キーワードに合致する記事がありませんでした。ダイジェストは作成されません。");
    return; // メール送信を削除
  }
  Logger.log(`週間ダイジェスト：キーワードに合致する記事が ${relevantArticles.length} 件見つかりました。`);

  let hitLog = "【キーワード別ヒット件数】\n";
  hitKeywordsWithCount.forEach(item => {
    hitLog += `- ${item.keyword}: ${item.count}件\n`;
  });
  Logger.log(hitLog.trim());

  // キーワードスコアに基づき記事を選抜
  const { selectedTopN } = rankAndSelectArticles(relevantArticles, config);
  Logger.log(`週間ダイジェスト：選抜された記事は ${selectedTopN.length} 件です。`);

  // キーワードごとの記事グループを作成 (selectedTopN の記事のみを対象とする)
  const articlesGroupedByKeyword = {};
  hitKeywordsWithCount.forEach(kwItem => {
    articlesGroupedByKeyword[kwItem.keyword] = selectedTopN.filter(article => { // relevantArticles -> selectedTopN に変更
      const keywords = articleKeywordMap.get(article.url);
      return keywords && keywords.includes(kwItem.keyword);
    });
  });

  // 週次レポート本文を生成
  // generateWeeklyReportWithLLM の呼び出しを変更
  const { reportBody } = generateWeeklyReportWithLLM(selectedTopN, hitKeywordsWithCount, articlesGroupedByKeyword);

  // メール配信
  const headerLine = "集計期間：" + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1));
  if (config.notifyChannel === "email" || config.notifyChannel === "both") {
    sendWeeklyDigestEmail(headerLine, reportBody, hitKeywordsWithCount);
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
    Logger.log(`${articlesToSummarize.length} 件の記事に対してAIによるTL;DR生成を試行します。`);
    // 各記事に対して個別にgetAiTldrsInBatchを呼び出す
    articlesToSummarize.forEach(article => {
      const singleArticleForLlm = {
        url: values[article.originalRowIndex][Config.CollectSheet.Columns.URL - 1], // C列のURLを渡す
        headline: article.title,
        abstractText: article.abstractText
      };
      const aiResultMap = getAiTldrsInBatch([singleArticleForLlm]); // 1記事のみ処理
      apiCallCount++; // 1記事につき1コール

      if (aiResultMap.size > 0) {
        const result = aiResultMap.values().next().value; // 最初の結果を取得
        if (result && result.tldr) {
          // E列(見出し)にAI生成のTL;DRを設定
          values[article.originalRowIndex][Config.CollectSheet.Columns.SUMMARY - 1] = result.tldr; // E列
        }
      }
    });
  }

  // 更新されたデータ配列をシートに一括書き込み
  if (articlesToSummarize.length > 0 || values.some(row => row[Config.CollectSheet.Columns.SUMMARY - 1] !== '')) { // 何らかの更新があった場合
    // 読み込み範囲をConfig.CollectSheet.Columns.SOURCEまでとする
    const newDataRange = trendDataSheet.getRange(2, 1, lastRow - 1, Config.CollectSheet.Columns.SOURCE);
    newDataRange.setValues(values.map(row => row.slice(0, Config.CollectSheet.Columns.SOURCE))); // 必要な列のみを書き戻す
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
function rankAndSelectArticles(relevantArticles, config) {
  const topN = config.topN || 20;
  // const perSourceCap = 3; // 1ソースあたりの最大採用数 - ユーザーの要望により削除

  // ① ヒューリスティックスコアを計算してソート
  const scoredArticles = relevantArticles
    .map(a => ({
      ...a,
      heuristicScore: computeHeuristicScore(a)
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

  // ③ AIスコアの書き戻しは不要になったため、空の配列を返す
  const aiScoredItems = [];

  return { selectedTopN: picked, aiScoredItems: aiScoredItems };
}

/**
 * AIを使い、選抜された記事からダイジェストの本文(Markdown)を生成する
 */
function generateWeeklyReportWithLLM(articles, hitKeywordsWithCount, articlesGroupedByKeyword) {
  const NUM_TRENDS = 3;
  const LINKS_PER_TREND = 3;
  // const TOP_PICKS_N = Math.min(5, articles.length); // 廃止
  // const TLDR_MIN = 50; // 廃止
  // const TLDR_MAX = 100; // 廃止

  // ハイライトの生成と出力は廃止
  // const highlights = _llmMakeHighlights(articles);

  // アクティブなキーワードを取得 (ここでは hitKeywordsWithCount を利用)
  const hitKeywords = hitKeywordsWithCount.map(item => item.keyword);

  // _llmMakeTrendSections の呼び出しを変更
  // const trends = _llmMakeTrendSections(articles, NUM_TRENDS, LINKS_PER_TREND, hitKeywords); // 変更前
  const trends = _llmMakeTrendSections(articlesGroupedByKeyword, LINKS_PER_TREND, hitKeywords); // 変更後 (numTrends は不要になる)

  // const topPicksMd = _composeTopPicksSection(articles, TOP_PICKS_N, TLDR_MIN, TLDR_MAX); // 廃止

  const body = [
    // ハイライトセクションを削除
    // "### 今週のハイライト",
    // highlights.join("\\n"),
    // "\\n---\n",
    trends // トレンドセクションのみ
    // "\\n---\n", // 廃止
    // "**Top Picks（要点付き）**\n" + topPicksMd // 廃止
  ].join("\n"); // join の引数も調整

  return { reportBody: body };
}

/**
 * AIスコアとTL;DRをスプレッドシートのG列・H列に書き戻す
 */
function writeBackAiResults(aiScoredItems) {
  if (!aiScoredItems || aiScoredItems.length === 0) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(Config.SheetNames.TREND_DATA);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  // シートの全データを一度に読み込む
  const dataRange = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn());
  const values = dataRange.getValues();

  const urlToRowIndex = new Map(); // URLをキーに、values配列のインデックスをマップ
  for (let i = 0; i < values.length; i++) {
    urlToRowIndex.set(values[i][Config.CollectSheet.Columns.URL - 1], i); // C列(URL)は0-indexedで2
  }

  let updatedCount = 0;
  aiScoredItems.forEach(a => {
    const rowIndex = urlToRowIndex.get(a.url);
    if (rowIndex !== undefined) {
      if (a.aiScore !== null) {
        values[rowIndex][Config.CollectSheet.Columns.AI_SCORE - 1] = a.aiScore;
        updatedCount++;
      }
    }
  });

  if (updatedCount > 0) {
    // 更新されたデータ配列をシートに一括書き込み
    dataRange.setValues(values);
    Logger.log(`${updatedCount} 件のAIスコアをシートに書き戻しました。`);
  }
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
  
  const SYSTEM = getPromptConfig("DAILY_SYSTEM");
  const USER_TEMPLATE = getPromptConfig("DAILY_USER");

  if (!SYSTEM || !USER_TEMPLATE) {
    return "エラー: DAILYプロンプト設定が見つかりません。";
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
 * 【日次・バッチ用】複数記事のTL;DRをAIで一括生成
 */
function getAiTldrsInBatch(articles) {
  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty("OPENAI_MODEL_DAILY") || "gpt-4.1-nano"; // Dailyモデルを使用

  if (!articles || articles.length === 0) return new Map();

  const results = new Map();

  // テンプレートをシートから取得 (ループの外で一度だけ取得する)
  const systemPrompt = getPromptConfig("BATCH_SYSTEM") || "あなたは臨床検査・バイオ技術の専門ニュースエディターです。"; // 👈 これをループの外に残す
  const userTemplate = getPromptConfig("BATCH_USER_TEMPLATE") || "以下の記事について、日本語で90〜120字程度のTL;DR（名詞止め優先、誇張なし、事実ベース）を生成してください。";

  articles.forEach(article => {
    // ⬇️ 削除: ここにあった systemPrompt の再定義を削除しました。
    
    // ユーザープロンプトを構築
    const userPrompt = [
      userTemplate, // シートから取得したユーザープロンプトの本文
      "結果は以下のJSON形式で出力してください。`tldr` のキーのみを含めてください。",
      "**重要:** 出力は必ず完全なJSON形式で終了してください。途中で途切れたり、JSONの後に余計なテキストを含めたりしないでください。",
      "",
      "【出力フォーマット】",
      `{ "tldr": "要約..." }`,
      "",
      "【評価対象記事】",
      `Headline: ${article.headline}\nAbstract: ${article.abstractText}`
    ].join("\n");

    const rawResponse = callLlmWithFallback(systemPrompt, userPrompt, model); // 👈 外側で定義した systemPrompt を使用
    Utilities.sleep(Config.Llm.DELAY_MS); // APIレート制限対策

    try {
      let jsonString = null;
      const codeBlockMatch = rawResponse.match(/```json\n([\s\S]*?)\n```/);
      if (codeBlockMatch && codeBlockMatch[1]) {
        jsonString = codeBlockMatch[1];
      } else {
        const trimmedResponse = rawResponse.trim();
        if (trimmedResponse.startsWith('{') && trimmedResponse.endsWith('}')) {
          jsonString = trimmedResponse;
        }
      }

      if (jsonString) {
        const parsed = JSON.parse(jsonString);
        if (typeof parsed.tldr === 'string') {
          results.set(article.url, { tldr: parsed.tldr }); // 元のarticle.urlをキーにする
        } else {
          _logError("getAiTldrsInBatch", new Error("Parsed JSON does not match expected structure"), "AIからのレスポンスのJSON構造が期待と異なりました。Response: " + rawResponse);
        }
      }
       else {
        _logError("getAiTldrsInBatch", new Error("No valid JSON found in response"), "AIからのレスポンスに有効なJSONが見つかりませんでした。Response: " + rawResponse);
      }
    } catch (e) {
      _logError("getAiTldrsInBatch", e, "AIからのJSONレスポンスの解析に失敗しました。Response: " + rawResponse + " Error: " + e.message);
    }
  });
  return results;
}

/**
 * 【週次・サブルーチン】ハイライト3行を生成
 */
function _llmMakeHighlights(articles) {
  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty("OPENAI_MODEL_WEEKLY") || "gpt-4.1-mini";
  var system = "あなたは週次ダイジェスト編集者。斜め読みで動向を掴める3つの要旨を作成する。";
  var list = articles.map(function(a){ return "- " + a.headline + "（" + (a.source||"") + ": " + a.url + "）"; }).join("\n");
  var user = [
    "以下の記事見出しリストから、今週のハイライトを3点だけ、日本語で45〜60字の箇条書きにしてください。",
    "誇張なし、事実ベース、名詞止め優先。出力は '- ' で始まる3行のみ。他の文字や説明を一切書かないこと。",
    list
  ].join("\n");

  var txt = callLlmWithFallback(system, user, model);
  // 最低限のフォールバック（LLM途切れ時は上位3見出しをそのまま採用）
  if (!txt || !txt.trim()) {
    return articles.slice(0,3).map(function(a){ return "- " + a.headline; });
  }
  // 不要行を削除して3行に丸める
  var lines = txt.split(/\r?\n/).filter(function(l){ return /^\s*-\s+/.test(l); }).slice(0,3);
  if (lines.length < 3) {
    while(lines.length < 3 && lines.length < articles.length) {
      lines.push("- " + articles[lines.length].headline);
    }
  }
  return lines;
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

/**
 * 【週次・サブルーチン】Top Picksセクションを生成
 */
function _composeTopPicksSection(articles, topN, TLDR_MIN, TLDR_MAX) {
  const picks = articles.slice(0, Math.min(topN, articles.length));
  
  // 箇条書き（- ）、記事ごとに水平線（---）で区切る
  const lines = picks.map((p, k) => {
    // リンクを []() 形式で作成
    const link = p.url ? ` [記事](${p.url})` : ""; 
    
    // TL;DRの内容を取得（太字強調なし）
    let tldrContent = '';
    if (p.tldr && String(p.tldr).trim()) {
      tldrContent = `${String(p.tldr).trim()}`; 
    }

    // 箇条書きリストとして整形（要約とリンクのみ）
    return `- ${tldrContent}${link}`;
  });

  // 記事間を水平線（---）で区切る
  return lines.join("\n\n---\n\n"); 
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
    useAiRank: (props.getProperty("DIGEST_USE_AI_RANK") || Config.Digest.DEFAULT_USE_AI_RANK).toUpperCase() === "Y",
    aiCandidates: parseInt(props.getProperty("DIGEST_AI_CANDIDATES") || String(Config.Digest.DEFAULT_AI_CANDIDATES), 10),
    notifyChannel: (props.getProperty("NOTIFY_CHANNEL_WEEKLY") || "email").toLowerCase(),
    teamsWebhookUrl: props.getProperty("TEAMS_WEBHOOK_URL"),
    mailTo: props.getProperty("MAIL_TO"),
    mailSubjectPrefix: props.getProperty("MAIL_SUBJECT_PREFIX") || "【週間RSS】",
    mailSenderName: props.getProperty("MAIL_SENDER_NAME") || "RSS要約ボット",
  };
}

/**
 * ルールベースの重要度スコア（0-100）を計算（キーワード重みは「Keywords」シートから取得）
 */
function computeHeuristicScore(article) {
  const now = new Date();
  const daysOld = Math.max(0, Math.floor((now - article.date) / (1000 * 60 * 60 * 24)));
  // キーワードによる加点は廃止。有効なキーワードにマッチした記事はピックアップ段階で選定済み。

  const SOURCE_WEIGHTS = {
    "Nature: 臨床診療と研究": 1.0,
    "Nature NEWS": 1.0,
    "BioWorld (Omics分野)": 0.9,
    "GEN(Genetic Engineering and Biotechnology News)": 0.9,
    "BioWorld (AI分野)": 0.9,
    "BioWorld (遺伝子治療)": 0.9,
    "BioWorld (細胞治療)": 0.9,
    "UMIN 臨床試験登録情報 (CTR)": 0.8,
    "BioPharma Dive": 0.8,
    "Fierce Biotech": 0.8,
    "Labiotech.eu": 0.7,
    "Medical Daily": 0.7,
    "Medical Xpress": 0.7,
    "CBnews(医療)": 0.7,
    "CBnews(薬事)": 0.7,
    "bioRxiv(Bioengineering)": 0.6,
    "bioRxiv(Cancer Biology)": 0.6,
    "bioRxiv(Molecular Biology)": 0.6,
    "bioRxiv (Genomics)": 0.6,
    "Health & Medicine News": 0.6,
    "Medscape Medical News": 0.7,
    "MobiHealthNews": 0.6,
    "Clinical Lab Products": 0.7
  };

  const sourceWeight = SOURCE_WEIGHTS[article.source] || 0.6; // 未定義は0.6（補助的扱い）
  const freshness = Math.exp(-daysOld / 7);
  const hasAbstract = article.abstractText && article.abstractText !== Config.Llm.NO_ABSTRACT_TEXT;
  const abstractBonus = hasAbstract ? Math.min(10, String(article.abstractText).length / 200) : 0;
  const raw = (sourceWeight * 30) + (freshness * 40) + abstractBonus;
  return Math.max(0, Math.min(100, Math.round(raw)));
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


// =================================================================
// 🛠️ 7. Debug (デバッグ用)
// =================================================================

function debugTopPicksLink() {
  const cfg = _getDigestConfig();
  const { start, end } = getDateWindow(cfg.days || 7);
  const arts = getArticlesInDateWindow(start, end).slice(0, cfg.topN || 30);
  const md = _composeTopPicksSection(arts, 5, 90, 120);
  Logger.log("--- Top Picks Markdown ---\n" + md);
}