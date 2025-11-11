/**
 * @file RSScollect.js
 * @description RSSフィードを収集し、AIで見出しと週次ダイジェストを生成するGoogle Apps Script
 * @version 2.6.0
 * @date 2025-11-10
 */

// =================================================================
// Core.gs: プロジェクト全体で利用する共通の定数やユーティリティ関数
// =================================================================

// 📌 Constants (定数定義)
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

// =================================================================
// Triggers (エントリポイント) - トリガーはここに集約しています
// =================================================================
/**
 * mainAutomationFlow
 * 日次トリガー用のエントリポイント。
 * - RSSの収集
 * - 見出し生成（AI or シート関数）
 * - トレンド検出の実行
 * これらを順に実行する軽量なワークフローです。
 * 呼び出し元: time-driven トリガー（daily）や手動実行
 */
function mainAutomationFlow() {
  Logger.log("--- 自動化フロー開始（収集→見出し生成のみ） ---");
  collectRssFeeds();
  processSummarization();
  detectAndRecordTrends();
  Logger.log("--- 自動化フロー完了 ---");
}

/**
 * weeklyDigestJob
 * 週次ダイジェストを生成・送信するエントリポイント。
 * 引数:
 *  - webUiKeyword: Web UI 経由で単発にキーワードを指定する場合に使用
 *  - returnHtmlOnly: true を指定すると HTML 本文のみを返す（テスト用）
 * 内部で記事抽出、フィルタリング、LLM 呼び出し、メール送信を行います。
 */
function weeklyDigestJob(webUiKeyword = null, returnHtmlOnly = false) {
  const config = _getDigestConfig();
  const { start, end } = getDateWindow(config.days);
  const allItems = getArticlesInDateWindow(start, end);
  if (allItems.length === 0) {
    Logger.log("週間ダイジェスト：対象期間に記事がありませんでした。");
    if (returnHtmlOnly) {
      const headerLine = "集計期間：" + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1));
      const htmlContent = markdownToHtml("今週のダイジェスト対象となる記事はありませんでした。");
      return `<div>${headerLine.replace(/\n/g, '<br>')}<br><br>${htmlContent}</div>`;
    }
    _handleNoArticlesFound(config, start, end, "対象期間に記事がありませんでした。");
    return;
  }
  Logger.log(`週間ダイジェスト：対象期間内に ${allItems.length} 件の記事が見つかりました。`);
  const { relevantArticles, hitKeywordsWithCount, articleKeywordMap } = _filterRelevantArticles(allItems, webUiKeyword);
  if (relevantArticles.length === 0) {
    Logger.log("週間ダイジェスト：キーワードに合致する記事がありませんでした。ダイジェストは作成されません。");
    if (returnHtmlOnly) {
      const headerLine = "集計期間：" + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1));
      const msgMd = `### 今週の注目キーワード\n- **${webUiKeyword || ''}** (0件)\n\n---\n\n該当記事がありませんでした。`;
      const htmlBody = markdownToHtml(msgMd);
      return `<div>${headerLine.replace(/\n/g, '<br>')}<br><br>${htmlBody}</div>`;
    }
    return;
  }
  Logger.log(`週間ダイジェスト：キーワードに合致する記事が ${relevantArticles.length} 件見つかりました。`);
  _logKeywordHitCounts(hitKeywordsWithCount);
  const result = _generateAndSendDigest(relevantArticles, hitKeywordsWithCount, articleKeywordMap, config, start, end, returnHtmlOnly);
  if (returnHtmlOnly) return result;
}

// =================================================================

/**
 * processSummarization
 * 日次処理内で未生成の見出し（E列）をチェックし、
 * - 抜粋が短い／ない場合はシートの翻訳関数（=GOOGLETRANSLATE）やフォールバック文を設定
 * - 抜粋が十分な場合は LLM に投げて見出し（JSON形式）を取得してE列に書き込む
 * 入力: `collect` シートの行データ
 * 副作用: シートの E列（見出し）を更新、LLM 呼び出し数はログ出力
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
  const dataRange = trendDataSheet.getRange(2, 1, lastRow - 1, trendDataSheet.getLastColumn());
  const values = dataRange.getValues();
  const articlesToSummarize = [];
  values.forEach((row, index) => {
    const currentHeadline = row[Config.CollectSheet.Columns.SUMMARY - 1];
    if (!currentHeadline || String(currentHeadline).trim() === "") {
      const title = row[Config.CollectSheet.Columns.URL - 2];
      const abstractText = row[Config.CollectSheet.Columns.ABSTRACT - 1];
      const isShort = (abstractText === Config.Llm.NO_ABSTRACT_TEXT) || (String(abstractText || "").length < Config.Llm.MIN_SUMMARY_LENGTH);
      if (isShort) {
        let newHeadline;
        const sheetRowNumber = index + 2;
        if (title && String(title).trim() !== "") {
          newHeadline = isLikelyEnglish(String(title)) ? `=GOOGLETRANSLATE(B${sheetRowNumber},"auto","ja")` : String(title).trim();
        } else if (abstractText && abstractText !== Config.Llm.NO_ABSTRACT_TEXT) {
          newHeadline = isLikelyEnglish(String(abstractText)) ? `=GOOGLETRANSLATE(D${sheetRowNumber},"auto","ja")` : String(abstractText).trim();
        } else {
          newHeadline = Config.Llm.MISSING_ABSTRACT_TEXT;
        }
        values[index][Config.CollectSheet.Columns.SUMMARY - 1] = newHeadline;
      } else {
        articlesToSummarize.push({ originalRowIndex: index, title: title, abstractText: abstractText });
      }
    }
  });
  let apiCallCount = 0;
  if (articlesToSummarize.length > 0) {
    Logger.log(`${articlesToSummarize.length} 件の記事に対してAIによる見出し生成を試行します。`);
    articlesToSummarize.forEach(article => {
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
    });
  }
  if (lastRow > 1) {
    dataRange.setValues(values);
    Logger.log(`LLMコール数: ${apiCallCount} 回。E列を更新しました。`);
  } else {
    Logger.log("見出し生成が必要な記事は見つかりませんでした。");
  }
}

// =================================================================
// WeeklyDigest.gs: 週次ダイジェストの作成と配信
// -----------------------------------------------------------------
// NOTE: `weeklyDigestJob` はファイル上部の "Triggers" セクションに
// 移動しました。週次トリガーのエントリポイントとしてそちらを参照
// してください。
// =================================================================

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

function _logKeywordHitCounts(hitKeywordsWithCount) {
  let hitLog = "【キーワード別ヒット件数】\n";
  hitKeywordsWithCount.forEach(item => {
    hitLog += `- ${item.keyword}: ${item.count}件\n`;
  });
  Logger.log(hitLog.trim());
}

function _generateAndSendDigest(relevantArticles, hitKeywordsWithCount, articleKeywordMap, config, start, end, returnHtmlOnly = false) {
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
    sendWeeklyDigestEmail(headerLine, reportBody, hitKeywordsWithCount);
  }
}

function _handleNoArticlesFound(config, start, end, message) {
  Logger.log(`週間ダイジェスト：${message}`);
  const headerLine = "集計期間：" + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1));
  const reportBody = "今週のダイジェスト対象となる記事はありませんでした。";
  if (config.notifyChannel === "email" || config.notifyChannel === "both") {
    sendWeeklyDigestEmail(headerLine, reportBody);
  }
}

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

function generateWeeklyReportWithLLM(articles, hitKeywordsWithCount, articlesGroupedByKeyword) {
  const LINKS_PER_TREND = 3;
  const hitKeywords = hitKeywordsWithCount.map(item => item.keyword);
  const trends = _llmMakeTrendSections(articlesGroupedByKeyword, LINKS_PER_TREND, hitKeywords);
  return { reportBody: trends };
}

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

function sendWeeklyDigestEmail(headerLine, mdBody, hitKeywordsWithCount) {
  const props = PropertiesService.getScriptProperties();
  const to = props.getProperty("MAIL_TO");
  if (!to) { Logger.log("MAIL_TO未設定のためメール送信せず。"); return; }
  const subjectPrefix = props.getProperty("MAIL_SUBJECT_PREFIX") || "【週間RSS】";
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
  Logger.log("メール送信（HTML形式）完了: " + to);
}

// =================================================================
// TrendDetector.gs: 記事のトレンド検出
// =================================================================

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

function getHistoricalTrendData(days = 7) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Config.SheetNames.TRENDS);
  if (!sheet || sheet.getLastRow() < 2) return new Map();
  const historicalData = new Map();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - days);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  for (const row of data) {
    const date = new Date(row[0]);
    date.setHours(0, 0, 0, 0);
    const keyword = row[1];
    const count = parseInt(row[2], 10);
    if (date >= startDate && date < today) {
      if (!historicalData.has(keyword)) {
        historicalData.set(keyword, { totalCount: 0, dates: new Set() });
      }
      const entry = historicalData.get(keyword);
      entry.totalCount += count;
      entry.dates.add(date.toDateString());
    }
  }
  return historicalData;
}

function calculateTrendScores(todayKeywords, historicalData) {
  const todayCounts = new Map();
  todayKeywords.forEach(kw => {
    todayCounts.set(kw, (todayCounts.get(kw) || 0) + 1);
  });
  const trends = [];
  for (const [keyword, count] of todayCounts.entries()) {
    const history = historicalData.get(keyword);
    let changeRate = "New";
    let isHot = false;
    if (history && history.dates.size > 0) {
      const avgCount = history.totalCount / history.dates.size;
      if (avgCount > 0) {
        changeRate = (count - avgCount) / avgCount;
      }
    }
    const isNewAndHot = changeRate === "New" && count >= 2;
    const isTrendingUp = typeof changeRate === 'number' && changeRate >= 2.0 && count >= 2;
    isHot = isNewAndHot || isTrendingUp;
    trends.push({
      keyword: keyword,
      count: count,
      changeRate: (typeof changeRate === 'number') ? `${Math.round(changeRate * 100)}%` : changeRate,
      relatedArticles: count,
      summary: "",
      isHot: isHot
    });
  }
  return trends;
}

function writeTrendsToSheet(trends) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Config.SheetNames.TRENDS);
  if (!sheet) {
    Logger.log("エラー: Trendsシートが見つかりません。");
    return;
  }
  // 各行は A: 日付, B: キーワード(英語), C: キーワード(日本語) [数式], D: 出現回数, E: 変化率, F: 関連記事数, G: 要約
  const rows = trends.map((t, i) => {
    const rowIndex = i + 2; // 挿入後のシート行番号（データは2行目から始まる）
    const formula = `=IF(B${rowIndex}="","",GOOGLETRANSLATE(B${rowIndex},"en","ja"))`;
    return [new Date(), t.keyword, formula, t.count, t.changeRate, t.relatedArticles, t.summary];
  });
  if (rows.length > 0) {
    sheet.insertRowsAfter(1, rows.length);
    sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
    Logger.log(`${rows.length} 件のトレンドをシートに書き込みました。`);
  }
}

// =================================================================
// LlmService.gs: LLM（大規模言語モデル）の呼び出し
// =================================================================

function _callAzureLlm(systemPrompt, userPrompt, azureUrl, azureKey) {
  Logger.log("Azure OpenAIを試行中...");
  const payload = { messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0.2, max_completion_tokens: 2048 };
  const options = { method: "post", contentType: "application/json", headers: { "api-key": azureKey }, payload: JSON.stringify(payload), muteHttpExceptions: true };
  try {
    const res = UrlFetchApp.fetch(azureUrl, options);
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

function _callOpenAiLlm(systemPrompt, userPrompt, openAiModel, openAiKey) {
  Logger.log("OpenAI APIを試行中...");
  const payload = { model: openAiModel, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], max_tokens: 2048 };
  const options = { method: "post", contentType: "application/json", headers: { "Authorization": `Bearer ${openAiKey}` }, payload: JSON.stringify(payload), muteHttpExceptions: true };
  try {
    const res = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", options);
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

function _callGeminiLlm(systemPrompt, userPrompt, geminiApiKey) {
  Logger.log("Gemini APIを試行中...");
  const API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/" + Config.Llm.MODEL_NAME + ":generateContent?key=" + geminiApiKey;
  const PROMPT = (systemPrompt || "") + "\n\n" + (userPrompt || "");
  const payload = { contents: [{ parts: [{ text: PROMPT }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 2048 } };
  const options = { method: "post", contentType: "application/json", payload: JSON.stringify(payload), muteHttpExceptions: true };
  try {
    const response = UrlFetchApp.fetch(API_ENDPOINT, options);
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

function callLlmWithFallback(systemPrompt, userPrompt, openAiModel = "gpt-4.1-nano", azureUrlOverride = null) {
  const props = PropertiesService.getScriptProperties();
  const azureUrl = azureUrlOverride || props.getProperty("AZURE_ENDPOINT_URL");
  const azureKey = props.getProperty("OPENAI_API_KEY");
  const openAiKey = props.getProperty("OPENAI_API_KEY_PERSONAL");
  const geminiApiKey = props.getProperty("GEMINI_API_KEY");
  let result = null;
  if (azureUrl && azureKey) {
    result = _callAzureLlm(systemPrompt, userPrompt, azureUrl, azureKey);
    if (result !== null) return result;
    Logger.log("Azure OpenAIでの呼び出しに失敗しました。OpenAI APIを試行します。");
  }
  if (openAiKey) {
    result = _callOpenAiLlm(systemPrompt, userPrompt, openAiModel, openAiKey);
    if (result !== null) return result;
    Logger.log("OpenAI APIでの呼び出しに失敗しました。Gemini APIを試行します。");
  }
  if (geminiApiKey) {
    result = _callGeminiLlm(systemPrompt, userPrompt, geminiApiKey);
    if (result !== null) return result;
    Logger.log("Gemini APIでの呼び出しに失敗しました。");
  }
  return "いずれのLLMでも見出しを生成できませんでした。";
}

function summarizeWithLLM(articleText) {
  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty("OPENAI_MODEL_DAILY") || "gpt-4.1-nano";
  const SYSTEM = getPromptConfig("BATCH_SYSTEM");
  const USER_TEMPLATE = getPromptConfig("BATCH_USER_TEMPLATE");
  if (!SYSTEM || !USER_TEMPLATE) return "エラー: BATCHプロンプト設定が見つかりません。";
  const USER = USER_TEMPLATE + ["", "記事: ---", articleText, "---"].join("\n");
  return callLlmWithFallback(SYSTEM, USER, model);
}

function _llmMakeTrendSections(articlesGroupedByKeyword, linksPerTrend, hitKeywords) {
  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty("OPENAI_MODEL_WEEKLY") || "gpt-4.1-mini";
  const azureWeeklyUrl = props.getProperty("AZURE_ENDPOINT_URL_WEEKLY");
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

function extractKeywordsWithLLM(text) {
  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty("OPENAI_MODEL_DAILY") || "gpt-4.1-nano";
  const SYSTEM = getPromptConfig("TREND_KEYWORD_SYSTEM") || "以下のテキスト群から、重要と思われる技術、製品、イベントなどのキーワード（名詞）を最大50個、重複を除いてリストアップしてください。各キーワードは改行で区切って、リスト形式でのみ出力してください。前書きや後書きは不要です。";
  const USER = text;
  const result = callLlmWithFallback(SYSTEM, USER, model);
  if (result && !result.includes("エラー")) {
    return result.split('\n').map(kw => kw.trim()).filter(kw => kw);
  }
  return null;
}

// =================================================================
// Utilities & Helpers (ユーティリティ) - 移動済み（ファイル末尾）
// -----------------------------------------------------------------
// 以下は以前ファイル先頭にあったユーティリティ群です。可視性向上のため
// ファイル末尾に移動しました。関数定義はホイスティングされるため、ロジック上
// の問題は発生しません（ただし `Config` はファイル先頭に残しています）。
// =================================================================

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

function stripHtml(html) {
  return html ? html.replace(/<[^>]*>?/gm, '') : '';
}

function isLikelyEnglish(text) {
  return !(/[぀-ゟ゠-ヿ一-鿿]/.test(text));
}

function fmtDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd");
}

function _logError(functionName, error, message = "") {
  Logger.log(`[ERROR] ${functionName}: ${message} ${error.toString()} Stack: ${error.stack}`);
}

function getDateWindow(days) {
  const end = new Date();
  end.setHours(24, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(1, days));
  return { start, end };
}


// =================================================================
// RssCollector.gs: RSSフィードの収集と解析
// =================================================================

/**
 * collectRssFeeds
 * RSSリスト (`RSS` シート) に登録されたフィードを巡回し、
 * 新着記事を `collect` シートに追記する処理。
 * 重複チェックや日付フィルタを行い、必要に応じて抜粋のHTML除去やソース名の付与を行う。
 * 副作用: `collect` シートの更新
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
    newData.sort((a, b) => a[0] - b[0]);
    const startRow = trendDataSheet.getLastRow() + 1;
    trendDataSheet.getRange(startRow, 1, newData.length, newData[0].length).setValues(newData);
    sortCollectByDateAsc();
    Logger.log(newData.length + " 件の新しい記事をシートに追記しました。");
  } else {
    Logger.log("新しい記事は見つかりませんでした。");
  }
}

function getExistingUrls(sheet) {
  if (sheet.getLastRow() < 2) return new Set();
  return new Set(sheet.getRange(2, Config.CollectSheet.Columns.URL, sheet.getLastRow() - 1, 1).getValues().flat());
}

function fetchAndParseRss(rssUrl, siteName, existingUrls) {
  let articles = [];
  try {
    const options = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/xml,application/rss+xml,application/xml;q=0.9,*/*;q=0.8' }, muteHttpExceptions: true };
    const response = UrlFetchApp.fetch(rssUrl, options);
    const code = response.getResponseCode();
    if (code !== 200) throw new Error(`HTTP Error Code: ${code}. Check if the URL is accessible or if the server blocks automated requests.`);
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

function parseRss2Feed(root, siteName, existingUrls) {
  const rssArticles = [];
  const channel = root.getChild("channel");
  if (channel) {
    const items = channel.getChildren("item");
    items.forEach(item => {
      const title = (item.getChild("title") && item.getChild("title").getText()) || "";
      const link = (item.getChild("link") && item.getChild("link").getText()) || "";
      const pubDateStr = (item.getChild("pubDate") && item.getChild("pubDate").getText()) || "";
      const description = (item.getChild("description") && item.getChild("description").getText()) || "";
      const articleDate = pubDateStr ? new Date(pubDateStr) : new Date(0);
      if (link && !existingUrls.has(link) && title && isRecentArticle(articleDate, 7)) {
        rssArticles.push([articleDate, title.trim(), link.trim(), stripHtml(description) || Config.Llm.NO_ABSTRACT_TEXT, "", siteName]);
      }
    });
  }
  return rssArticles;
}

function parseAtomFeed(root, siteName, existingUrls) {
  const atomArticles = [];
  const ATOM_NS = XmlService.getNamespace("http://www.w3.org/2005/Atom");
  const entries = root.getChildren("entry", ATOM_NS) || [];
  entries.forEach(entry => {
    const title = (entry.getChild("title", ATOM_NS) && entry.getChild("title", ATOM_NS).getText()) || "";
    let link = "";
    const linkElArr = entry.getChildren("link", ATOM_NS) || [];
    for (let i = 0; i < linkElArr.length; i++) {
      const relAttr = linkElArr[i].getAttribute("rel");
      if (!relAttr || relAttr.getValue() === "alternate") {
        const hrefAttr = linkElArr[i].getAttribute("href");
        if (hrefAttr) link = hrefAttr.getValue();
        break;
      }
    }
    const updatedEl = entry.getChild("updated", ATOM_NS);
    const publishedEl = entry.getChild("published", ATOM_NS);
    const pubDateStr = (updatedEl && updatedEl.getText()) || (publishedEl && publishedEl.getText()) || "";
    const summaryEl = entry.getChild("summary", ATOM_NS);
    const contentEl = entry.getChild("content", ATOM_NS);
    const summary = (summaryEl && summaryEl.getText()) || (contentEl && contentEl.getText()) || "";
    const articleDate = pubDateStr ? new Date(pubDateStr) : new Date(0);
    if (link && !existingUrls.has(link) && title && isRecentArticle(articleDate, 7)) {
      atomArticles.push([articleDate, title.trim(), link.trim(), stripHtml(summary) || Config.Llm.NO_ABSTRACT_TEXT, "", siteName]);
    }
  });
  return atomArticles;
}

function isRecentArticle(pubDate, daysLimit = 7) {
  if (!pubDate || !(pubDate instanceof Date)) return false;
  const now = new Date();
  const daysOld = Math.floor((now - pubDate) / (1000 * 60 * 60 * 24));
  return daysOld <= daysLimit;
}

function sortCollectByDateAsc() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(Config.SheetNames.TREND_DATA);
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).sort({ column: 1, ascending: false });
    Logger.log("collectシートを日付で降順にソートしました。");
  }
}

// =================================================================
// WebUI.gs: WebアプリケーションのUI関連
// =================================================================

function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate().setSandboxMode(HtmlService.SandboxMode.IFRAME).setTitle('RSSキーワード検索ツール');
}

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
