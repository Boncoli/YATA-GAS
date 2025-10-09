/**
 * @file RSScollect.js
 * @description RSSフィードを収集し、AIで見出しと週次ダイジェストを生成するGoogle Apps Script
 * @version 2.1.0
 * @date 2025-10-08
 */

// =================================================================
// 📌【運用方針メモ 2025/10/08 改訂】
// =================================================================
// - **配信形式**: 週次ダイジェストはHTMLメールを正とし、Teams通知は運用停止。
// - **ロジック維持**: Markdown生成ロジックやTeams関連関数は、将来的な再利用を想定しコード内に残す。
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
  },
  CollectSheet: {
    Columns: {
      URL: 3,
      ABSTRACT: 4,
      SUMMARY: 5,
      SOURCE: 6,
      AI_SCORE: 7,
      AI_TLDR: 8,
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
    return;
  }

  // 関連性フィルタ（専門キーワード）
  const THEME_KEYWORDS = [
    "臨床検査","体外診断","IVD","検査室","診断","スクリーニング","バイオマーカー",
    "ゲノム","遺伝子","DNA","RNA","転写","タンパク質","プロテオーム","メタボローム",
    "シーケンシング","NGS","PCR","デジタルPCR","マイクロ流体","バイオセンサー",
    "AI","機械学習","深層学習","画像診断","自動化","ワークフロー",
    "規制","薬事","PMDA","FDA","承認","CE","品質管理","精度管理",
    "免疫","細胞","遺伝子治療","細胞治療","ゲノム編集","CRISPR",
    "biomarker","sequencing","genomics","proteomics","metabolomics",
    "diagnostic","in vitro diagnostic","assay","clinical lab","IVD",
    "machine learning","deep learning","automation"
  ];

  const relevantArticles = [];
  allItems.forEach(article => {
    const text = `${article.title} ${article.abstractText} ${article.headline}`;
    if (THEME_KEYWORDS.some(k => text.includes(k))) {
      relevantArticles.push(article);
    }
  });

  // AI評価と最終選抜
  const { selectedTopN, aiScoredItems } = rankAndSelectArticles(relevantArticles, config);

  // AIスコア/TL;DRをスプレッドシートに書き戻し
  try {
    writeBackAiResults(aiScoredItems);
  } catch (e) {
    _logError("weeklyDigestJob/writeBack", e, "AIスコア/TL;DRの書き戻しに失敗");
  }

  // 週次レポート本文を生成
  const { reportBody } = generateWeeklyReportWithLLM(selectedTopN);

  // メール配信
  const headerLine = "集計期間：" + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1));
  if (config.notifyChannel === "email" || config.notifyChannel === "both") {
    sendWeeklyDigestEmail(headerLine, reportBody);
  }

  // 2025/10/08 Teams通知は運用停止（ユーザー要望によりコメントアウト）
  // const nonRelevantArticles = allItems.filter(item => !relevantArticles.includes(item));
  // const otherArticles = rankAndSelectArticles(relevantArticles, config).others;
  // const combinedOtherArticles = nonRelevantArticles.concat(otherArticles).concat(llmOtherArticles);
  // if (config.notifyChannel === "teams" || config.notifyChannel === "both") {
  //   sendWeeklyDigestTeams(headerLine, reportBody, combinedOtherArticles);
  // }
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
    Logger.log(`${articlesToSummarize.length} 件の記事に対してLLMで見出し生成を試行します。`);
    const generatedHeadlines = _getDailyHeadlinesInBatch(articlesToSummarize);
    apiCallCount = Math.ceil(articlesToSummarize.length / 5); // BATCH_SIZE=5を仮定

    generatedHeadlines.forEach((headline, originalRowIndex) => {
      values[originalRowIndex][Config.CollectSheet.Columns.SUMMARY - 1] = headline;
    });
  }

  // 更新されたデータ配列をシートに一括書き込み
  if (articlesToSummarize.length > 0 || values.some(row => row[Config.CollectSheet.Columns.SUMMARY - 1] !== '')) { // 何らかの更新があった場合
    dataRange.setValues(values);
    Logger.log(`LLMコール数: ${apiCallCount} 回。E列を更新しました。`);
  } else {
    Logger.log("見出し生成が必要な記事は見つかりませんでした。");
  }
}


// =================================================================
// 🗓️ 3. Weekly Digest Process (週次ダイジェスト処理)
// =================================================================

/**
 * ヒューリスティックとAIバッチスコアで記事を選抜・整列し、上位記事リストを返す
 */
function rankAndSelectArticles(relevantArticles, config) {
  const w_h = 0.4; // ルールベーススコアの重み
  const w_ai = 0.6; // AIスコアの重み
  const topN = config.topN || 20;
  const aiCandidates = Math.min(config.aiCandidates || 50, relevantArticles.length);
  const perSourceCap = 3; // 1ソースあたりの最大採用数

  // ① ヒューリスティックで仮スコアリング
  const withHeu = relevantArticles
    .map(a => ({
      ...a,
      heuristicScore: computeHeuristicScore(a),
      aiScore: (typeof a.aiScore === 'number' && isFinite(a.aiScore)) ? a.aiScore : null,
      tldr: a.tldr || ""
    }))
    .sort((a, b) => b.heuristicScore - a.heuristicScore);

  // ② AIバッチ評価 (useAiRankがYの場合)
  let aiScoredItems = [];
  if (config.useAiRank) {
    const articlesToScore = withHeu.slice(0, aiCandidates).filter(a => a.aiScore === null);
    Logger.log(`[AI Batch] Candidates: ${aiCandidates}, To Score Now: ${articlesToScore.length}`);

    if (articlesToScore.length > 0) {
      const batchResults = getAiScoresAndTldrsInBatch(articlesToScore);
      withHeu.forEach(article => {
        if (batchResults.has(article.url)) {
          const result = batchResults.get(article.url);
          article.aiScore = result.score;
          article.tldr = result.tldr;
        }
      });
    }
    aiScoredItems = withHeu.slice(0, aiCandidates);
  }

  // ③ 複合スコアを計算
  withHeu.forEach(item => {
    item.finalScore = Math.round(w_h * item.heuristicScore + w_ai * (item.aiScore !== null ? item.aiScore : item.heuristicScore));
  });

  // ④ 最終ソート
  withHeu.sort((a, b) => b.finalScore - a.finalScore);

  // ⑤ ソースの偏りを抑制しつつ上位N件を選抜
  const picked = [];
  const perSourceCount = {};
  for (const item of withHeu) {
    const src = item.source || "unknown";
    perSourceCount[src] = (perSourceCount[src] || 0);
    if (perSourceCount[src] < perSourceCap) {
      picked.push(item);
      perSourceCount[src]++;
    }
    if (picked.length >= topN) break;
  }

  return { selectedTopN: picked, aiScoredItems: aiScoredItems };
}

/**
 * AIを使い、選抜された記事からダイジェストの本文(Markdown)を生成する
 */
function generateWeeklyReportWithLLM(articles) {
  const NUM_TRENDS = 3;
  const LINKS_PER_TREND = 3;
  const TOP_PICKS_N = Math.min(5, articles.length);
  const TLDR_MIN = 50;
  const TLDR_MAX = 100;

  const highlights = _llmMakeHighlights(articles);
  const trends = _llmMakeTrendSections(articles, NUM_TRENDS, LINKS_PER_TREND);
  const topPicksMd = _composeTopPicksSection(articles, TOP_PICKS_N, TLDR_MIN, TLDR_MAX);

  const body = [
    "### 今週のハイライト",
    highlights.join("\n"),
    "\n---\n",
    trends,
    "\n---\n",
    "**Top Picks（要点付き）**\n" + topPicksMd
  ].join("\n");

  // Teams通知停止中のため、otherArticlesの処理は現在未使用。将来的な復活を想定し、コードは残す。
  // const parsed = _parseWeeklyReportOutput(body, articles);
  // return { reportBody: body, otherArticles: parsed.otherArticles };
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
      if (a.tldr) {
        values[rowIndex][Config.CollectSheet.Columns.AI_TLDR - 1] = a.tldr;
        updatedCount++;
      }
    }
  });

  if (updatedCount > 0) {
    // 更新されたデータ配列をシートに一括書き込み
    dataRange.setValues(values);
    Logger.log(`${updatedCount} 件のAIスコア/TL;DRをシートに書き戻しました。`);
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
    max_completion_tokens: 1024
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
    max_tokens: 1024
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
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
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
  const SYSTEM = "あなたはプロのニュース編集者です。臨床検査・バイオ要素技術の専門性を保ちつつ、一般読者にも伝わる日本語の見出しを作るアシスタントです。常に簡潔・具体・キャッチーに出力します。";
  const USER = [
    "以下の記事内容を、ネットニュースの見出しのように、キャッチーで簡潔な日本語タイトルとして**1行**で作成してください。",
    "要件:",
    " - 語尾は名詞止めを優先（例：〜が加速、〜の実用化）",
    " - 専門用語は噛み砕く（難語は短く）",
    " - 誇張や断定は避け事実ベースで",
    " - 目安は全角20〜35字（オーバー可）",
    "例：『AIが血液検査を高度化、迅速診断の精度向上』",
    "",
    "記事: ---",
    articleText,
    "---"
  ].join("\n");

  return callLlmWithFallback(SYSTEM, USER, model);
}

/**
 * 【日次・バッチ用】複数記事の見出しをAIで一括生成
 */
function _getDailyHeadlinesInBatch(articlesToSummarize) {
  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty("OPENAI_MODEL_DAILY") || "gpt-4.1-nano";

  if (!articlesToSummarize || articlesToSummarize.length === 0) return new Map();

  const BATCH_SIZE = 5; // 一度にLLMに送る記事の数
  const results = new Map(); // { originalRowIndex: headline }

  for (let i = 0; i < articlesToSummarize.length; i += BATCH_SIZE) {
    const batch = articlesToSummarize.slice(i, i + BATCH_SIZE);
    const articlesForPrompt = batch.map(a => ({
      originalRowIndex: a.originalRowIndex,
      title: a.title,
      abstractText: a.abstractText
    }));

    const systemPrompt = "あなたはプロのニュース編集者です。臨床検査・バイオ要素技術の専門性を保ちつつ、一般読者にも伝わる日本語の見出しを作るアシスタントです。常に簡潔・具体・キャッチーに出力します。";
    const userPrompt = [
      "以下のJSON形式の記事リストについて、それぞれネットニュースの見出しのように、キャッチーで簡潔な日本語タイトルとして**1行**で作成してください。",
      "要件:",
      " - 語尾は名詞止めを優先（例：〜が加速、〜の実用化）",
      " - 専門用語は噛み砕く（難語は短く）",
      " - 誇張や断定は避け事実ベースで",
      " - 目安は全角20〜35字（オーバー可）",
      " - 各オブジェクトには `originalRowIndex` と `headline` の2つのキーのみを含めてください。",
      " - 厳密に以下のJSONフォーマットの配列として出力し、それ以外のテキストは一切含めないでください。",
      "",
      "【出力フォーマット】",
      "[",
      "  { \"originalRowIndex\": 2, \"headline\": \"見出し1...\" },\n  { \"originalRowIndex\": 5, \"headline\": \"見出し2...\" }\n]",
      "",
      "【評価対象記事リスト】",
      JSON.stringify(articlesForPrompt, null, 2)
    ].join("\n");

    const rawResponse = callLlmWithFallback(systemPrompt, userPrompt, model);

        try {
          let jsonString = null;
          const jsonMatch = rawResponse.match(/```json\n([\s\S]*?)\n```/);
    
          if (jsonMatch && jsonMatch[1]) {
            jsonString = jsonMatch[1];
          } else {
            const trimmedResponse = rawResponse.trim();
            if (trimmedResponse.startsWith('[')) {
              // JSON配列が途中で途切れている場合、強制的に閉じる
              if (!trimmedResponse.endsWith(']')) {
                jsonString = trimmedResponse + ']';
                _logError("_getDailyHeadlinesInBatch", new Error("Incomplete JSON array, forced close"), "AIからのレスポンスのJSON配列が不完全だったため、強制的に閉じました。Response: " + rawResponse);
              } else {
                jsonString = trimmedResponse;
              }
            } else if (trimmedResponse.startsWith('{') && trimmedResponse.endsWith('}')) {
              // 単一のJSONオブジェクトの場合
              jsonString = trimmedResponse;
            }
          }
    
          if (jsonString) {
            const parsed = JSON.parse(jsonString);
            if (Array.isArray(parsed)) {
              parsed.forEach(item => {
                if (typeof item.originalRowIndex === 'number' && typeof item.headline === 'string') {
                  results.set(item.originalRowIndex, item.headline);
                }
              });
            }
          } else {
            _logError("_getDailyHeadlinesInBatch", new Error("No valid JSON found in response"), "AIからのレスポンスに有効なJSONが見つかりませんでした。Response: " + rawResponse);
          }
        } catch (e) {
          _logError("_getDailyHeadlinesInBatch", e, "AIからのJSONレスポンスの解析に失敗しました。Response: " + rawResponse);
        }
        Utilities.sleep(Config.Llm.DELAY_MS); // APIレート制限対策  }
  return results;
}

/**
 * 【週次・バッチ用】複数記事の重要度とTL;DRをAIで一括生成
 */
function getAiScoresAndTldrsInBatch(articles) {
  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty("OPENAI_MODEL_WEEKLY") || "gpt-4.1-mini";

  if (!articles || articles.length === 0) return new Map();

  const BATCH_SIZE = 30; // 一度にLLMに送る記事の数
  const results = new Map();

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    const articlesForPrompt = batch.map(a => ({ url: a.url, headline: a.headline, abstractText: a.abstractText }));

    const systemPrompt = "あなたは臨床検査・バイオ技術の専門ニュースエディターです。";
    const userPrompt = [
      "以下のJSON形式の記事リストについて、臨床検査・医療・バイオ要素技術の観点での重要度を0〜100の数値で評価し、",
      "日本語で90〜120字程度のTL;DR（名詞止め優先、誇張なし、事実ベース）を生成してください。",
      "",
      "厳密に以下のJSONフォーマットの配列として出力し、それ以外のテキストは一切含めないでください。",
      "各オブジェクトには `url`, `score`, `tldr` の3つのキーのみを含めてください。",
      "",
      "【出力フォーマット】",
      "[",
      "  { \"url\": \"記事URL1\", \"score\": 85, \"tldr\": \"要約1...\" },\n  { \"url\": \"記事URL2\", \"score\": 70, \"tldr\": \"要約2...\" }\n]",
      "",
      "【評価対象記事リスト】",
      JSON.stringify(articlesForPrompt, null, 2)
    ].join("\n");

    const rawResponse = callLlmWithFallback(systemPrompt, userPrompt, model);

    try {
      let jsonString = null;
      const jsonMatch = rawResponse.match(/```json\n([\s\S]*?)\n```/);

      if (jsonMatch && jsonMatch[1]) {
        jsonString = jsonMatch[1];
      } else {
        const trimmedResponse = rawResponse.trim();
        if (trimmedResponse.startsWith('[')) {
          if (!trimmedResponse.endsWith(']')) {
            jsonString = trimmedResponse + ']';
            _logError("getAiScoresAndTldrsInBatch", new Error("Incomplete JSON array, forced close"), "AIからのレスポンスのJSON配列が不完全だったため、強制的に閉じました。Response: " + rawResponse);
          } else {
            jsonString = trimmedResponse;
          }
        } else if (trimmedResponse.startsWith('{') && trimmedResponse.endsWith('}')) {
          jsonString = trimmedResponse;
        }
      }

      if (jsonString) {
        const parsed = JSON.parse(jsonString);
        if (Array.isArray(parsed)) {
          parsed.forEach(item => {
            if (item.url && typeof item.score === 'number' && typeof item.tldr === 'string') {
              results.set(item.url, { score: item.score, tldr: item.tldr });
            }
          });
        }
      } else {
        _logError("getAiScoresAndTldrsInBatch", new Error("No valid JSON found in response"), "AIからのレスポンスに有効なJSONが見つかりませんでした。Response: " + rawResponse);
      }
    } catch (e) {
      _logError("getAiScoresAndTldrsInBatch", e, "AIからのJSONレスポンスの解析に失敗しました。Response: " + rawResponse);
    }
    Utilities.sleep(Config.Llm.DELAY_MS); // APIレート制限対策
  }
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
function _llmMakeTrendSections(articles, numTrends, linksPerTrend) {
  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty("OPENAI_MODEL_WEEKLY") || "gpt-4.1-mini";
  var system = "あなたは週次ダイジェスト編集者。見出し群から主要トレンドを短く構造化する。";
  var list = articles.map(function(a){ return "- " + a.headline + "（" + (a.source||"") + ": " + a.url + "）"; }).join("\n");
  var user = [
    "以下の記事見出しから、主要トレンドを " + numTrends + " 群に分類してください。",
    "各群は次の順序で出力：",
    "1) **太字見出し**（15〜20字、名詞止め）",
    "2) 要点（日本語120〜180字、事実ベース、名詞止め、箇条書き禁止）",
    "3) 代表記事リンクのみ（" + linksPerTrend + "本、各行 '・[記事タイトル' のMarkdown、本文要約は禁止）",
    "各群の区切りに必ず '---' を入れること。それ以外の装飾・前書き・後書きは禁止。",
    list
  ].join("\n");

  var txt = callLlmWithFallback(system, user, model);
  // フォールバック：簡易に見出しだけ3群
  if (!txt || !txt.trim()) {
    var fallback = [];
    for (var i=0;i<numTrends;i++){
      var idx = i % Math.max(1, articles.length);
      fallback.push("**トレンド" + (i+1) + "**\n" +
                    articles[idx].headline + "\n" +
                    "・[" + articles[idx].title + "](" + articles[idx].url + ")\n---");
    }
    return fallback.join("\n");
  }
  return txt.trim();
}

/**
 * 【週次・サブルーチン】Top Picksセクションを生成
 */
function _composeTopPicksSection(articles, topN, TLDR_MIN, TLDR_MAX) {
  const picks = articles.slice(0, Math.min(topN, articles.length));
  const lines = picks.map((p, k) => {
    const num = (k + 1) + ". ";
    const head = (p.headline || p.title || "").trim();
    const link = p.url ? ` | [記事](${p.url})` : "";
    const tldr = (p.tldr && String(p.tldr).trim()) ? `*TL;DR:* ${String(p.tldr).trim()}` : "";
    return num + head + link + "\n" + tldr;
  });

  return lines.join("\n"); // 項目間の改行を1つに修正
}


// =================================================================
// ✉️ 5. Notification Handlers (通知関連)
// =================================================================

/**
 * 週次ダイジェストをHTMLメールで送信
 */
function sendWeeklyDigestEmail(headerLine, mdBody) {
  const props = PropertiesService.getScriptProperties();
  const to = props.getProperty("MAIL_TO");
  if (!to) { Logger.log("MAIL_TO未設定のためメール送信せず。"); return; }

  const subjectPrefix = props.getProperty("MAIL_SUBJECT_PREFIX") || "【週間RSS】";
  const senderName    = props.getProperty("MAIL_SENDER_NAME") || "RSS要約ボット";
  const today         = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd");
  const sheetUrl      = props.getProperty("DIGEST_SHEET_URL") || "(DIGEST_SHEET_URL 未設定)";

  const fullMdBody = mdBody + `\n\n---\nその他の記事一覧は[こちらのスプレッドシート](${sheetUrl})でご覧いただけます。`;
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

/**
 * （未使用）週次ダイジェストをTeamsにアダプティブカードで送信
 */
function sendWeeklyDigestTeams(headerLine, mdBody, combinedOtherArticles) {
  const props = PropertiesService.getScriptProperties();
  const webhookUrl = props.getProperty("TEAMS_WEBHOOK_URL");
  if (!webhookUrl) {
    Logger.log("TeamsのWebhook URLが設定されていません。");
    return;
  }

  const payload = createAdaptiveCardJSON(mdBody, combinedOtherArticles);
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch(webhookUrl, options);
    const responseCode = res.getResponseCode();
    if (responseCode >= 200 && responseCode < 300) {
      Logger.log("Teams送信完了");
    } else {
      const errorText = res.getContentText();
      _logError("sendWeeklyDigestTeams", new Error(errorText), `Teams送信失敗。ステータスコード: ${responseCode}`);
    }
  } catch (e) {
    _logError("sendWeeklyDigestTeams", e, "Teams送信中に例外が発生しました。");
  }
}

/**
 * （未使用）Teams用のアダプティブカードJSONを生成
 */
function createAdaptiveCardJSON(reportBody, otherArticles) {
  const cardTitle = `今週の臨床検査・バイオ技術トレンド Weekly Digest (${fmtDate(new Date())}週)`;
  const sections = reportBody.split('\n---\n').map(s => s.trim()).filter(Boolean);
  const cardBody = [];

  cardBody.push({ type: "TextBlock", text: cardTitle, weight: "Bolder", size: "Large", wrap: true });

  sections.forEach((sec, idx) => {
    if (idx > 0) cardBody.push({ type: "TextBlock", text: " ", separator: true });

    const isTopPicks = /^\*\*.*Top Picks.*\*\*$/m.test(sec);
    if (isTopPicks) {
      const lines = sec.split('\n').filter(l => l.trim() !== '');
      const heading = lines[0].replace(/\*\*/g, '');
      const itemsMd = lines.slice(1).join('\n');

      cardBody.push({ type: "TextBlock", text: `**${heading}**`, weight: "Bolder", size: "Medium", wrap: true });
      cardBody.push({
        type: "Container",
        items: [
          { type: "ActionSet", actions: [{ type: "Action.ToggleVisibility", title: "🔎 Top Picks を表示／非表示", targetElements: ["topPicksContainer"] }] },
          { type: "Container", id: "topPicksContainer", isVisible: false, items: [{ type: "TextBlock", text: itemsMd, wrap: true }] }
        ]
      });
    } else {
      cardBody.push({ type: "TextBlock", text: sec, wrap: true });
    }
  });

  if (otherArticles && otherArticles.length > 0) {
    cardBody.push({ type: "TextBlock", text: " ", separator: true });
    const otherMd = otherArticles.map(a => `- ${a.title}`).join('\n');
    cardBody.push({
      type: "Container",
      items: [
        { type: "ActionSet", actions: [{ type: "Action.ToggleVisibility", title: `📚 その他の注目記事 (${otherArticles.length}件) を表示／非表示`, targetElements: ["otherArticlesContainer"] }] },
        { type: "Container", id: "otherArticlesContainer", isVisible: false, items: [{ type: "TextBlock", text: otherMd, wrap: true }] }
      ]
    });
  }

  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.2",
        body: cardBody,
        msteams: { width: "full" }
      }
    }]
  };
}


// =================================================================
// 🛠️ 6. Utilities & Helpers (ユーティリティ)
// =================================================================

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
 * ルールベースの重要度スコア（0-100）を計算
 */
function computeHeuristicScore(article) {
  const now = new Date();
  const daysOld = Math.max(0, Math.floor((now - article.date) / (1000 * 60 * 60 * 24)));

  const SOURCE_WEIGHTS = {
    "Nature NEWS": 1.0, "Nature: 臨床診療と研究": 1.0, "GEN(Genetic Engineering and Biotechnology News)": 0.9,
    "BioWorld (AI分野)": 0.9, "BioWorld (遺伝子治療)": 0.9, "BioWorld (細胞治療)": 0.9, "Medical Xpress": 0.7,
    "Medscape Medical News": 0.8, "bioRxiv (Genomics)": 0.6, "bioRxiv(Molecular Biology)": 0.6,
    "bioRxiv(Bioengineering)": 0.6, "bioRxiv(Cancer Biology)": 0.6, "BioPharma Dive": 0.8, "Fierce Biotech": 0.8,
    "Labiotech.eu": 0.7, "MobiHealthNews": 0.6, "Clinical Lab Products": 0.7, "CBnews(医療)": 0.7,
    "CBnews(薬事)": 0.7, "Health & Medicine News": 0.6, "UMIN 臨床試験登録情報 (CTR)": 0.8
  };

  const KEYWORD_WEIGHTS = {
    "臨床検査": 10, "診断": 8, "検査薬": 8, "体外診断": 8, "AI": 7, "機械学習": 7, "ゲノム": 7, "遺伝子": 6,
    "RNA": 5, "タンパク質": 5, "シーケンシング": 6, "治療": 5, "創薬": 6, "バイオ": 5, "免疫": 5, "細胞": 5,
    "プレシジョン": 4, "リアルワールド": 4, "規制": 4, "薬事": 4
  };

  const txt = `${article.title || ""} ${article.abstractText || ""} ${article.headline || ""}`;
  let keywordScore = 0;
  Object.keys(KEYWORD_WEIGHTS).forEach(k => {
    if (txt.includes(k)) keywordScore += KEYWORD_WEIGHTS[k];
  });

  const sourceWeight = SOURCE_WEIGHTS[article.source] || 0.6;
  const freshness = Math.exp(-daysOld / 7);
  const hasAbstract = article.abstractText && article.abstractText !== Config.Llm.NO_ABSTRACT_TEXT;
  const abstractBonus = hasAbstract ? Math.min(10, String(article.abstractText).length / 200) : 0;

  const raw = (keywordScore) + (sourceWeight * 30) + (freshness * 40) + abstractBonus;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * 指定された期間内の記事をシートから取得
 */
function getArticlesInDateWindow(start, end) {
  const sh = SpreadsheetApp.getActive().getSheetByName(Config.SheetNames.TREND_DATA);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const lastCol = sh.getLastColumn();

  const vals = sh.getRange(2, 1, lastRow - 1, Math.min(lastCol, 8)).getValues(); // A..H
  const out = [];
  for (const r of vals) {
    const date = r[0];
    if ((date instanceof Date) && date >= start && date < end) {
      const headline = r[4];
      if (headline && String(headline).trim() !== "" && String(headline).indexOf("API Error") === -1) {
        out.push({
          date: date,
          title: r[1],
          url: r[2],
          abstractText: r[3],
          headline: String(headline).trim(),
          source: r[5] ? String(r[5]) : "",
          aiScore: (typeof r[6] === 'number' && isFinite(r[6])) ? r[6] : null,
          tldr: r[7] ? String(r[7]) : ""
        });
      }
    }
  }
  out.sort((a, b) => a.date - b.date);
  return out;
}

/**
 * （未使用）LLMの出力からレポート本文と「その他の記事」を分離
 */
function _parseWeeklyReportOutput(reportText, originalArticles) {
  const includedUrls = new Set();
  (reportText.match(/[\[\]\(]([^\]\)]+?)[\(](https?:\/\/[^\s\)]+?)[\)]/g) || []).forEach(link => {
    const url = link.match(/\((.*?)\)/)[1];
    includedUrls.add(url);
  });

  return originalArticles.filter(article => !includedUrls.has(article.url));
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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
      const pubDate = (item.getChild("pubDate") && item.getChild("pubDate").getText()) || "";
      const description = (item.getChild("description") && item.getChild("description").getText()) || "";

      if (link && !existingUrls.has(link) && title) {
        rssArticles.push([
          pubDate ? new Date(pubDate) : new Date(),
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
    const pubDate = (updatedEl && updatedEl.getText()) || (publishedEl && publishedEl.getText()) || "";
    const summaryEl = entry.getChild("summary", ATOM_NS);
    const contentEl = entry.getChild("content", ATOM_NS);
    const summary = (summaryEl && summaryEl.getText()) || (contentEl && contentEl.getText()) || "";

    if (link && !existingUrls.has(link) && title) {
      atomArticles.push([
        pubDate ? new Date(pubDate) : new Date(),
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