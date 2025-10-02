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
    MODEL_NAME: "gemini-2.5-flash",
    DELAY_MS: 1200,
    MIN_SUMMARY_LENGTH: 200,
    NO_ABSTRACT_TEXT: "抜粋なし",
    MISSING_ABSTRACT_TEXT: "記事が短すぎるか、抜粋がないため見出し生成をスキップしました。",
    SHORT_JA_SKIP_TEXT: "記事が短く、日本語のため見出し生成をスキップしました。",
  },
  Digest: {
    DEFAULT_USE_AI_RANK: "N",
    DEFAULT_USE_AI_TLDR: "N",
    DEFAULT_AI_CANDIDATES: 50,
  },
};

/**
 * エラーをログに記録するヘルパー関数
 * @param {string} functionName エラーが発生した関数名
 * @param {Error} error エラーオブジェクト
 * @param {string} message 追加のメッセージ
 */
function _logError(functionName, error, message = "") {
  Logger.log(`[ERROR] ${functionName}: ${message} ${error.toString()} Stack: ${error.stack}`);
}

// =================================================================
// 🔄 Core Automation (統合メインフロー)
// =================================================================
/**
 * 収集 → 見出し生成（通知は行わない）
 */
function mainAutomationFlow() {
  Logger.log("--- 自動化フロー開始（収集→見出し生成のみ） ---");
  collectRssFeeds();
  processSummarization();
  Logger.log("--- 自動化フロー完了 ---");
}

// =================================================================
// 📥 RSS Feed Processing (RSS収集・データ書き込み)
// =================================================================

/**
 * collectシートをA列（日付）で昇順にソートする
 */
function sortCollectByDateAsc() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(Config.SheetNames.TREND_DATA);

  if (!rssListSheet || !trendDataSheet) {
    Logger.log("エラー: シート名が正しくありません。'RSS'または'collect'のシート名を確認してください。");
    return;
  }

  const lastRow = rssListSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("RSSリストシートにデータがありません。");
    return;
  }

  const rssList = rssListSheet.getRange(Config.RssListSheet.DataRange.START_ROW, Config.RssListSheet.DataRange.START_COL, lastRow - (Config.RssListSheet.DataRange.START_ROW - 1), Config.RssListSheet.DataRange.NUM_COLS).getValues(); // [サイト名, RSS URL]
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
    // ① 今回の新着ブロックを昇順（古い→新しい）で整える
    newData.sort((a, b) => a[0] - b[0]); // A列=Date

    // ② 下に追記
    const startRow = trendDataSheet.getLastRow() === 0 ? 1 : trendDataSheet.getLastRow() + 1;
    trendDataSheet.getRange(startRow, 1, newData.length, newData[0].length).setValues(newData);

    // ③ シート全体をA列で昇順に統一
    sortCollectByDateAsc();

    Logger.log(newData.length + " 件の新しい記事をシートに追記しました（昇順で統一）。");
  } else {
    Logger.log("新しい記事は見つかりませんでした。");
  }
}

/** 重複除外用に既存URLセットを取得 */
function getExistingUrls(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();
  const urls = sheet.getRange(Config.CollectSheet.DataRange.START_ROW, Config.CollectSheet.Columns.URL, lastRow - (Config.CollectSheet.DataRange.START_ROW - 1), Config.CollectSheet.DataRange.NUM_COLS_FOR_URL).getValues().flat();
  return new Set(urls);
}

/** RSS 2.0 のパース */
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
          pubDate ? new Date(pubDate) : new Date(), // A:日付
          title.trim(),                              // B:元タイトル
          link.trim(),                               // C:URL
          stripHtml(description) || Config.Llm.NO_ABSTRACT_TEXT,// D:抜粋
          "",                                        // E: 見出し（AI生成）
          siteName                                   // F: ソース
        ]);
      }
    });
  }
  return rssArticles;
}

/** Atom のパース */
function parseAtomFeed(root, siteName, existingUrls) {
  const atomArticles = [];
  const ATOM_NS = XmlService.getNamespace("http://www.w3.org/2005/Atom");
  const entries = root.getChildren("entry", ATOM_NS) || [];
  entries.forEach(entry => {
    const title = (entry.getChild("title", ATOM_NS) && entry.getChild("title", ATOM_NS).getText()) || "";
    const linkElArr = entry.getChildren("link", ATOM_NS) || [];
    let link = "";
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
        pubDate ? new Date(pubDate) : new Date(), // A
        title.trim(),                              // B
        link.trim(),                               // C
        stripHtml(summary) || Config.Llm.NO_ABSTRACT_TEXT,    // D
        "",                                        // E
        siteName                                   // F
      ]);
    }
  });
  return atomArticles;
}

/** RSS/Atom両対応で記事抽出（siteName は F列に記録） */
function fetchAndParseRss(rssUrl, siteName, existingUrls) {
  let articles = [];
  try {
    const xml = UrlFetchApp.fetch(rssUrl).getContentText();
    const document = XmlService.parse(xml);
    const root = document.getRootElement();

    const channel = root.getChild("channel");
    if (channel) {
      articles = parseRss2Feed(root, siteName, existingUrls);
    } else {
      articles = parseAtomFeed(root, siteName, existingUrls);
    }
  } catch (e) {
    _logError("fetchAndParseRss", e, `RSS/Atomフィードの取得またはパース中にエラーが発生しました。URL: ${rssUrl}`);
  }
  return articles;
}

// =================================================================
// 🧠 LLM Headline Generation (見出し生成)
// =================================================================

/**
 * 未見出し（E列空）の行に、見出し or 代替テキストを生成して入れる
 * 方針:
 *  - 抜粋なし or 短文（D列の長さ < MIN_SUMMARY_LENGTH）→ タイトル（B列）を E 列に記載
 *     ・タイトルが日本語: そのまま
 *     ・タイトルが英語: =GOOGLETRANSLATE(Bn,"auto","ja") を E 列に入れる
 *     ・タイトルが空でDが有る場合はDを同様の方針で代替
 *  - それ以外（十分長い）→ LLM でネットニュース風見出しを生成
 */
function processSummarization() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const trendDataSheet = ss.getSheetByName(Config.SheetNames.TREND_DATA);
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // B〜E（タイトル, URL, 抜粋, 見出し）をまとめて取得
  const range = sheet.getRange(2, 2, lastRow - 1, Config.CollectSheet.Columns.SUMMARY - 2 + 1); // B..E
  const data = range.getValues();

  const updates = [];
  let apiCallCount = 0;

  data.forEach((row, index) => {
    const title = row[0];        // B
    const abstractText = row[2]; // D
    const currentE = row[3];     // E
    let outE = currentE;
    const rowNumber = index + 2; // データは2行目から

    if (!currentE || String(currentE).trim() === "") {
      const isShort = (abstractText === Config.Llm.NO_ABSTRACT_TEXT) || (String(abstractText || "").length < Config.Llm.MIN_SUMMARY_LENGTH);

      if (isShort) {
        // タイトルをそのまま（英語なら機械翻訳）
        if (title && String(title).trim() !== "") {
          if (isLikelyEnglish(String(title))) {
            outE = `=GOOGLETRANSLATE(B${rowNumber},"auto","ja")`;
            Logger.log(`E${rowNumber}: 短文→タイトル(英)を機械翻訳で代替`);
          } else {
            outE = String(title).trim();
            Logger.log(`E${rowNumber}: 短文→タイトル(日)を代替`);
          }
        } else {
          // タイトルが空：Dで代替
          if (abstractText && abstractText !== NO_ABSTRACT_TEXT) {
            if (isLikelyEnglish(String(abstractText))) {
              outE = `=GOOGLETRANSLATE(D${rowNumber},"auto","ja")`;
              Logger.log(`E${rowNumber}: タイトル欠落→抜粋(英)の機械翻訳を代替`);
            } else {
              outE = String(abstractText).trim();
              Logger.log(`E${rowNumber}: タイトル欠落→抜粋(日)を代替`);
            }
          } else {
            outE = Config.Llm.MISSING_ABSTRACT_TEXT; // 最終手段
            Logger.log(`E${rowNumber}: タイトル・抜粋ともに利用不可→固定文言`);
          }
        }
      } else {
        // 通常：十分な長さ → LLMでネットニュース風見出しを生成
        Logger.log(`E${rowNumber}: 見出し生成(通常)開始: ${String(title || "").substring(0, 30)}...`);
        const material = String(abstractText || title);
        outE = summarizeWithLLM(material); // Azure優先→Geminiへフォールバック
        apiCallCount++;
      }
    }

    updates.push([outE]);
  });

  if (updates.length > 0) {
    const outRange = sheet.getRange(2, Config.CollectSheet.Columns.SUMMARY, updates.length, 1);
    outRange.setValues(updates);
    Logger.log(`LLMコール数: ${apiCallCount} 回。E列を更新しました（短文はタイトル基準、英語は機械翻訳）。`);
  }
}


/** LLMで「ネットニュース風見出し」を1行生成（Azure優先→OpenAI→Geminiへフォールバック） */
function summarizeWithLLM(articleText) {
  const props = PropertiesService.getScriptProperties();
  const azureUrl = props.getProperty("AZURE_ENDPOINT_URL");
  const azureKey = props.getProperty("OPENAI_API_KEY"); // AzureのAPIキー

  // 1. Azure OpenAIを試行
  if (azureUrl && azureKey) {
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
    ].join("\\n");
    const result = executeAzureOpenAICall(SYSTEM, USER);
    if (result && result.indexOf("API Error") === -1 && result.indexOf("見出しが生成できませんでした。") === -1) {
      return result;
    }
    Logger.log("Azure OpenAIでの見出し生成に失敗しました。OpenAI APIを試行します。");
  }

  const openAiKey = props.getProperty("OPENAI_API_KEY_PERSONAL"); // 個人のOpenAI APIキー

  // 2. OpenAI APIを試行
  if (openAiKey) {
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
      "-"
    ].join("\\n");
    const result = executeOpenAICall(SYSTEM, USER);
    if (result && result.indexOf("API Error") === -1 && result.indexOf("見出しが生成できませんでした。") === -1) {
      return result;
    }
    Logger.log("OpenAI APIでの見出し生成に失敗しました。Gemini APIを試行します。");
  }

  // 3. Geminiを試行（フォールバック）
  const geminiApiKey = props.getProperty("GEMINI_API_KEY");
  if (!geminiApiKey) {
    return "Gemini APIキーが未設定のため見出しを生成できませんでした。";
  }
  const API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/" + Config.Llm.MODEL_NAME + ":generateContent?key=" + geminiApiKey;
  const PROMPT =
    "あなたはプロのニュース編集者です。臨床検査・バイオ要素技術の記事内容を、ネットニュースの見出しのように**1行**の日本語タイトルへ要約してください。\\n" +
    "要件:\\n" +
    "- 名詞止めを優先\\n" +
    "- 専門用語は噛み砕いて簡潔に\\n" +
    "- 誇張・断定は避け事実ベース\\n" +
    "- 目安は全角20〜35字（オーバー可）\\n" +
    "例：『AIが血液検査を高度化、迅速診断の精度向上』\\n" +
    "記事: --- " + articleText + " ---";

  return executeGeminiCall(API_ENDPOINT, PROMPT);
}



// =================================================================
// 🤖 LLM API Clients (LLM API呼び出しクライアント)
// =================================================================
/** Azure OpenAI 呼び出し（Chat Completions） */
function executeAzureOpenAICall(systemPrompt, userPrompt) {
  const props = PropertiesService.getScriptProperties();
  const endpoint = props.getProperty("AZURE_ENDPOINT_URL");
  const apiKey   = props.getProperty("OPENAI_API_KEY");

  if (!endpoint || !apiKey) {
    Logger.log("Azure OpenAI のプロパティが未設定（AZURE_ENDPOINT_URL / OPENAI_API_KEY）");
    return "Azure OpenAI APIキーまたはエンドポイントが未設定のため見出しを生成できませんでした。";
  }

  const payload = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt }
    ],
    temperature: 0.2,
    max_tokens: 128
  };
  const options = {
    method: "post",
    contentType: "application/json",
    headers: { "api-key": apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  let headline = "API呼び出し失敗";
  try {
    const res = UrlFetchApp.fetch(endpoint, options);
    const code = res.getResponseCode();
    const txt  = res.getContentText();
    if (code !== 200) {
      _logError("executeAzureOpenAICall", new Error(`API Error: ${code} - ${txt}`), "Azure OpenAI APIエラーが発生しました。");
      headline = "API Error: " + code;
    } else {
      const json = JSON.parse(txt);
      if (json && json.choices && json.choices.length > 0 && json.choices[0].message && json.choices[0].message.content) {
        headline = String(json.choices[0].message.content).trim();
      } else {
        _logError("executeAzureOpenAICall", new Error("No content in response"), "Azure OpenAIから見出しが生成できませんでした。");
        headline = "見出しが生成できませんでした。";
      }
    }
  } catch (e) {
    _logError("executeAzureOpenAICall", e, "Azure OpenAI呼び出し中に例外が発生しました。");
  }

  Utilities.sleep(Config.Llm.DELAY_MS);
  return headline;
}

/** OpenAI API（Chat Completions）呼び出し */
function executeOpenAICall(systemPrompt, userPrompt) {
  const props = PropertiesService.getScriptProperties();
  const apiKey   = props.getProperty("OPENAI_API_KEY_PERSONAL"); // 新しいプロパティ

  if (!apiKey) {
    Logger.log("OpenAI API のプロパティが未設定（OPENAI_API_KEY_PERSONAL）");
    return "OpenAI APIキーが未設定のため見出しを生成できませんでした。";
  }

  const payload = {
    model: "GPT-5-mini", // または "gpt-4o" など、利用したいモデル
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt }
    ],
    temperature: 0.2,
    max_tokens: 128
  };
  const options = {
    method: "post",
    contentType: "application/json",
    headers: { "Authorization": `Bearer ${apiKey}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  let headline = "API呼び出し失敗";
  try {
    const res = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", options);
    const code = res.getResponseCode();
    const txt  = res.getContentText();
    if (code !== 200) {
      _logError("executeOpenAICall", new Error(`API Error: ${code} - ${txt}`), "OpenAI APIエラーが発生しました。");
      headline = "API Error: " + code;
    } else {
      const json = JSON.parse(txt);
      if (json && json.choices && json.choices.length > 0 && json.choices[0].message && json.choices[0].message.content) {
        headline = String(json.choices[0].message.content).trim();
      } else {
        _logError("executeOpenAICall", new Error("No content in response"), "OpenAIから見出しが生成できませんでした。他のLLMを試します。");
        headline = "見出しが生成できませんでした。";
      }
    }
  } catch (e) {
    _logError("executeOpenAICall", e, "OpenAI API呼び出し中に例外が発生しました。他のLLMを試します。");
  }

  Utilities.sleep(Config.Llm.DELAY_MS);
  return headline;
}

/** Gemini API 呼び出し */
function executeGeminiCall(apiEndpoint, prompt) {
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 128 }
  };
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  let headline = "API呼び出し失敗";
  try {
    const response = UrlFetchApp.fetch(apiEndpoint, options);
    const json = JSON.parse(response.getContentText());
    let text = null;
    if (json && json.candidates && json.candidates.length > 0 && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts.length > 0) {
      text = json.candidates[0].content.parts[0].text;
    }
    headline = text ? String(text).trim() : (json && json.error ? ("API Error: " + json.error.message) : "見出しが生成できませんでした。");
  } catch (e) {
    _logError("executeGeminiCall", e, "Gemini API呼び出し中に例外が発生しました。");
  }
  Utilities.sleep(Config.Llm.DELAY_MS);
  return headline;
}

// =================================================================
// 📣 Notification Handlers (通知)
// =================================================================
/** 後日有効化用のスタブ：Teams通知（現状は何もしません） */
function postNewArticlesToTeams() {
  Logger.log("postNewArticlesToTeams(): 通知は未運用のため実行しません（スタブ）");
}
/** 後日有効化用のスタブ：メール通知（現状は何もしません） */
function postNewArticlesByEmail() {
  Logger.log("postNewArticlesByEmail(): 通知は未運用のため実行しません（スタブ）");
}

// =====================================================================
// 🗓️ Weekly Digest Core (週間ダイジェスト)
// =====================================================================
/**
 * 週次ダイジェストの設定をスクリプトプロパティから読み込み、オブジェクトとして返す。
 * @returns {object} ダイジェスト設定オブジェクト
 */
function _getDigestConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    days: parseInt(props.getProperty("DIGEST_DAYS") || "7", 10),
    topN: parseInt(props.getProperty("DIGEST_TOP_N") || "20", 10),
    useAiRank: (props.getProperty("DIGEST_USE_AI_RANK") || Config.Digest.DEFAULT_USE_AI_RANK).toUpperCase() === "Y",
    useAiTldr: (props.getProperty("DIGEST_USE_AI_TLDR") || Config.Digest.DEFAULT_USE_AI_TLDR).toUpperCase() === "Y",
    aiCandidates: parseInt(props.getProperty("DIGEST_AI_CANDIDATES") || String(Config.Digest.DEFAULT_AI_CANDIDATES), 10),
    notifyChannel: (props.getProperty("NOTIFY_CHANNEL_WEEKLY") || "none").toLowerCase(),
    teamsWebhookUrl: props.getProperty("TEAMS_WEBHOOK_URL"),
    mailTo: props.getProperty("MAIL_TO"),
    mailSubjectPrefix: props.getProperty("MAIL_SUBJECT_PREFIX") || "【週間RSS】",
    mailSenderName: props.getProperty("MAIL_SENDER_NAME") || "RSS要約ボット",
  };
}

/**
 * 週次バッチ入口：過去 N 日のダイジェストを作成し、設定に応じて配信。
 * 送信先が未設定なら送信せず、ログにプレビューを出力（安全運用）
 *
 * Script Properties（任意）:
 *  - DIGEST_DAYS          : 集計日数（既定 7）
 *  - DIGEST_TOP_N         : 上位件数（既定 20）
 *  - DIGEST_USE_AI_RANK   : 'Y'でAI重み付け、'N'でオフ（既定 'N'）
 *  - DIGEST_USE_AI_TLDR   : 'Y'でAI 1行要約、'N'でオフ（既定 'N'）
 *  - DIGEST_AI_CANDIDATES : AIに渡す最大候補数（既定 50）
 *  - NOTIFY_CHANNEL_WEEKLY: 'teams' | 'email' | 'both' | 'none'（既定 'none'）
 *  - TEAMS_WEBHOOK_URL    : Teams送信時に使用
 *  - MAIL_TO              : メール送信時に使用（カンマ区切り可）
 *  - MAIL_SUBJECT_PREFIX  : 既定 '【週間RSS】'
 *  - MAIL_SENDER_NAME     : 既定 'RSS要約ボット'
 */
function weeklyDigestJob() {
  const config = _getDigestConfig();

  var win = getDateWindow(config.days);
  var start = win.start;
  var end = win.end;

  var items = getArticlesInDateWindow(start, end); // headline(E)がある行のみ抽出
  if (items.length === 0) {
    Logger.log("週間ダイジェスト：対象期間 " + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1)) + " に記事はありません。");
    return;
  }

  var capped = items.slice(0, Math.min(items.length, 120));
  var ranked;
  if (config.useAiRank || config.useAiTldr) {
    ranked = aiRankAndSummarize(capped, { useAiRank: config.useAiRank, useAiTldr: config.useAiTldr }, config);
  } else {
    // デフォルト：ヒューリだけ
    ranked = capped.map(function (it) {
      return {
        date: it.date, title: it.title, url: it.url, abstractText: it.abstractText,
        headline: it.headline, source: it.source,
        score: heuristicScore(it), tldr: heuristicTldr(it)
      };
    });
  }

  // 並び替え（score降順）→ TOP N
  ranked.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
  var digest = ranked.slice(0, config.topN);

// 本文（Markdown）を生成：見出し＋1行要約＋リンク
  var headerLine = "集計期間：" + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1)) + "（" + digest.length + "件）";
  var mdParts = [];
  for (var i = 0; i < digest.length; i++) {
    var it = digest[i];
    var tl = (it.tldr && String(it.tldr).trim()) || heuristicTldr(it);
    var normalizedH = normalizeForCompare(it.headline);
    var normalizedT = normalizeForCompare(tl);
    var includeTldr = tl && normalizedH !== normalizedT;
    var line = "**" + (i + 1) + ". " + it.headline + "**\n";
    if (includeTldr) line += "> " + oneLine(tl, 120) + "\n";
    line += "[" + "記事を読む" + "](" + it.url + ")"
      + "　｜　" + fmtDateTime(it.date)
      + (it.source ? "　｜　" + it.source : "");
    mdParts.push(line);
  }
  var mdBody = mdParts.join("\n\n");
  var preview = "【週間RSSダイジェスト】\n" + headerLine + "\n\n" + mdBody;
  Logger.log(preview);

  // 送信（送信先が無ければスキップ）
  if (config.notifyChannel === "email" || config.notifyChannel === "both") {
    sendWeeklyDigestEmail(headerLine, mdBody);
  }
  if (config.notifyChannel === "teams" || config.notifyChannel === "both") {
    sendWeeklyDigestTeams(headerLine, mdBody);
  }
}

/** 期間ウィンドウ（今日含む過去 N 日） */
function getDateWindow(days) {
  var end = new Date(); end.setHours(24, 0, 0, 0); // 明日0:00
  var start = new Date(end); start.setDate(start.getDate() - Math.max(1, days)); // N日前の0:00
  return { start: start, end: end };
}

/** A〜F列から、期間内＆見出し（E）がある記事だけ抽出（collectを読み取り） */
function getArticlesInDateWindow(start, end) {
  var sh = SpreadsheetApp.getActive().getSheetByName(TREND_DATA_SHEET_NAME);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = sh.getLastColumn();
  var vals = sh.getRange(2, 1, lastRow - 1, Math.min(lastCol, 6)).getValues(); // A..F

  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    var date = r[0];
    var title = r[1];
    var url = r[2];
    var abstractText = r[3];
    var headline = r[4];
    var source = r[5];

    var inRange = (date instanceof Date) && date >= start && date < end;
    var hasHeadline = headline && String(headline).trim() !== "" && String(headline).indexOf("API Error") === -1;
    if (inRange && hasHeadline && url) {
      out.push({
        date: date,
        title: title,
        url: url,
        abstractText: abstractText,
        headline: String(headline).trim(),
        source: source ? String(source) : ""
      });
    }
  }
  // 古い→新しいで整列（見やすさ用。最終的にはscoreで並べ替え）
  out.sort(function (a, b) { return a.date - b.date; });
  return out;
}

/** ヒューリスティックなスコア（新しさ＋抜粋長） */
function heuristicScore(it) {
  var now = Date.now();
  var ageDays = Math.max(0, (now - it.date.getTime()) / (1000 * 60 * 60 * 24));
  var recency = Math.max(0, 100 - ageDays * 10); // 1日ごとに -10 点
  var length = Math.min(100, (String(it.abstractText || "").length / 600) * 100);
  return Math.round(0.7 * recency + 0.3 * length);
}

/** 1行要約（ヒューリ）：D（抜粋）→B（タイトル）を優先し、見出しと被る場合は抑制/代替 */
function heuristicTldr(it) {
  // まずは D（抜粋）を優先、無ければ B（タイトル）
  var base = String(it.abstractText || it.title || "").trim();
  var tl = base ? oneLine(base, 120) : "";

  // 見出しと実質同一なら、代替 or 非表示
  if (tl) {
    var h = normalizeForCompare(String(it.headline || ""));
    var t = normalizeForCompare(tl);
    if (h && h === t) {
      // 代替候補：タイトル（B）と抜粋（D）のどちらか片方が違えばそちらを試す
      var alt = (base === it.abstractText && it.title) ? String(it.title).trim()
               : (base === it.title && it.abstractText) ? String(it.abstractText).trim()
               : "";
      if (alt) {
        var alt1 = oneLine(alt, 120);
        var a = normalizeForCompare(alt1);
        if (a && a !== h) tl = alt1;  // 代替成功
        else tl = "";                 // 代替も同一なら非表示
      } else {
        tl = ""; // 非表示（引用行を出さない）
      }
    }
  }
  return tl;
}




// ------------------------------
// 🤖 AIで重み付け＆1行要約（将来ONにする場合のみ使用）
//   - デフォルトは Script Properties が 'N' のため、本ルートは呼ばれません
// ------------------------------
function aiRankAndSummarize(items, opts, config) {
  var useRank = !!opts.useAiRank;
  var useTldr = !!opts.useAiTldr;

  // 両方OFFなら即ヒューリ（待機やAPI呼び出し無し）
  if (!useRank && !useTldr) {
    return items.map(function (it) {
      return {
        date: it.date, title: it.title, url: it.url, abstractText: it.abstractText,
        headline: it.headline, source: it.source,
        score: heuristicScore(it), tldr: heuristicTldr(it)
      };
    });
  }

  // AIに渡す最大候補数（巨大入力による不安定化を避ける）
  var aiMax = Math.max(5, config.aiCandidates);

  // まずヒューリスティックで粗選別（上位 aiMax 件だけAIにかける）
  var prelim = items
    .map(function (it) { return { it: it, sc: heuristicScore(it) }; })
    .sort(function (a, b) { return b.sc - a.sc; })
    .slice(0, Math.min(items.length, aiMax))
    .map(function (x) { return x.it; });

  var out = [];
  var processedUrls = new Set();

  // AI処理対象の記事を処理
  for (var i = 0; i < prelim.length; i++) {
    var it = prelim[i];
    out.push(getScoreAndTldrPSV(it, useRank, useTldr));
    processedUrls.add(it.url);
    Utilities.sleep(Config.Llm.DELAY_MS); // レート制御
  }

  // AI処理対象外の記事をヒューリスティックで処理
  for (var m = 0; m < items.length; m++) {
    var it2 = items[m];
    if (processedUrls.has(it2.url)) continue;
    out.push({
      date: it2.date, title: it2.title, url: it2.url, abstractText: it2.abstractText,
      headline: it2.headline, source: it2.source,
      score: heuristicScore(it2), tldr: heuristicTldr(it2)
    });
  }
  return out;
}

/** 1件に対して score|tldr を返す（PSV 1行）。失敗時はヒューリにフォールバック */
function getScoreAndTldrPSV(it, useRank, useTldr) {
  var score0 = heuristicScore(it);
  var tldr0  = heuristicTldr(it);

  if (!useRank && !useTldr) {
    return {
      date: it.date, title: it.title, url: it.url, abstractText: it.abstractText,
      headline: it.headline, source: it.source,
      score: score0, tldr: tldr0
    };
  }

  var SYSTEM = "あなたは編集デスクです。日本語で簡潔・正確に応答します。";
  var USER = [
    "以下の1件について、日本語60〜120字の1行要約(tldr)と、重要度score(0〜100整数)を返してください。",
    "評価観点：臨床検査・バイオの新規性、実用性、波及効果、話題性。誇張は禁止、事実ベース。",
    "出力は **1行のみ**、形式は `score|tldr`。tldr にパイプ(|)と改行は含めない。前後に説明文・コードブロック・引用は一切出力しない。",
    "input:",
    JSON.stringify({
      headline: it.headline,
      abstract: oneLine(String(it.abstractText || ""), 500),
      source: it.source || "",
      date: fmtDate(it.date),
      url: it.url
    })
  ].join("\n");

  var text = callLLM_TextItemPSV(SYSTEM, USER);
  var parsed = parseOnePSVLine(text); // {score, tldr} or null

  var score = useRank ? (parsed && typeof parsed.score === "number" ? parsed.score : score0) : score0;
  var tldr  = useTldr ? (parsed && parsed.tldr ? oneLine(parsed.tldr, 120) : tldr0) : tldr0;

  return {
    date: it.date, title: it.title, url: it.url, abstractText: it.abstractText,
    headline: it.headline, source: it.source,
    score: score, tldr: tldr
  };
}

/** LLM（Azure優先→Gemini）でテキスト（PSV 期待）を1件取得 */
function callLLM_TextItemPSV(systemPrompt, userPrompt) {
  var props = PropertiesService.getScriptProperties();
  var azureUrl = props.getProperty("AZURE_ENDPOINT_URL");
  var azureKey = props.getProperty("OPENAI_API_KEY");
  var out = "";
  if (azureUrl && azureKey) {
    out = callAzureChatForText(systemPrompt, userPrompt);
  } else {
    out = callGeminiForText(systemPrompt, userPrompt);
  }
  // コードフェンス等が来た場合に備えて除去
  out = String(out || "").trim();
  var fenced = out.match(/```[\s\S]*?```/);
  if (fenced && fenced[0]) {
    var inner = fenced[0].replace(/```[\w-]*\s*|\s*```/g, "").trim();
    if (inner) out = inner;
  }
  // 1行化
  out = out.replace(/\r?\n/g, " ").trim();
  return out;
}


/** Azure（通常テキスト） */
function callAzureChatForText(systemPrompt, userPrompt) {
  var props = PropertiesService.getScriptProperties();
  var endpoint = props.getProperty("AZURE_ENDPOINT_URL");
  var apiKey   = props.getProperty("OPENAI_API_KEY");
  if (!endpoint || !apiKey) return "";

  var payload = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt }
    ],
    temperature: 0.1,
    max_tokens: 1200
  };
  var options = {
    method: "post",
    contentType: "application/json",
    headers: { "api-key": apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  try {
    var res = UrlFetchApp.fetch(endpoint, options);
    if (res.getResponseCode() !== 200) {
      Logger.log("Azure PSV応答エラー: " + res.getResponseCode() + " - " + res.getContentText());
      return "";
    }
    var obj = JSON.parse(res.getContentText());
    var txt = (obj && obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content) ? obj.choices[0].message.content : "";
    return txt || "";
  } catch (e) {
    Logger.log("Azure PSV呼び出し例外: " + e.toString() + "\nStack: " + e.stack);
    return "";
  }
}

/** Gemini（通常テキスト） */
function callGeminiForText(systemPrompt, userPrompt) {
  var apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) return "";
  var model = Config.Llm.MODEL_NAME;
  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + apiKey;

  var prompt = (systemPrompt || "") + "\n\n" + (userPrompt || "");
  var payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1200 }
  };
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  try {
    var res = UrlFetchApp.fetch(url, options);
    if (res.getResponseCode() !== 200) {
      Logger.log("Gemini PSV応答エラー: " + res.getResponseCode() + " - " + res.getContentText());
      return "";
    }
    var jobj = JSON.parse(res.getContentText());
    var txt = (jobj && jobj.candidates && jobj.candidates[0] && jobj.candidates[0].content && jobj.candidates[0].content.parts && jobj.candidates[0].content.parts[0] && jobj.candidates[0].content.parts[0].text)
      ? jobj.candidates[0].content.parts[0].text
      : "";
    return txt || "";
  } catch (e) {
    Logger.log("Gemini PSV呼び出し例外: " + e.toString() + "\nStack: " + e.stack);
    return "";
  }
}

/** ```json ... ``` を含め、文字列中の最初のJSONを抽出し復元パース（堅牢版） */
function safeParseJSON(text) {
  if (!text) return null;
  var fenced = text.match(/```json\s*([\s\S]*?)```/i);
  var raw = fenced ? fenced[1] : text;
  var start = raw.indexOf("{");
  var end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    var candidate = raw.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch (e1) {}
  }
  if (start >= 0) {
    var depth = 0;
    for (var i = start; i < raw.length; i++) {
      var ch = raw.charAt(i);
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          var cand2 = raw.slice(start, i + 1);
          try { return JSON.parse(cand2); } catch (e2) { break; }
        }
      }
    }
  }
  try { return JSON.parse(raw); } catch (e3) {
    var head = String(raw).slice(0, 200).replace(/\s+/g, " ");
    _logError("safeParseJSON", e3, `JSONパース失敗。先頭200字: ${head}`);
    return null;
  }
}

// =================================================================
// ✉️ 週次の送信（送信先未設定なら送らない）
// =================================================================
function convertMarkdownToHtml(mdBody) {
  return mdBody
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')          // **太字**
    .replace(/^> (.*)$/gm, '<blockquote>$1</blockquote>')      // > 引用
    // 記事を読む → URL記事を読む</a>
    .replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g,
     '<a href="$2">$1</a>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

function sendWeeklyDigestEmail(headerLine, mdBody) {
  const props = PropertiesService.getScriptProperties();
  const to = props.getProperty("MAIL_TO");
  if (!to) { Logger.log("MAIL_TO未設定のためメール送信せず。"); return; }

  const subjectPrefix = props.getProperty("MAIL_SUBJECT_PREFIX") || "【週間RSS】";
  const senderName = props.getProperty("MAIL_SENDER_NAME") || "RSS要約ボット";
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd");
  const subject = subjectPrefix + today;

  // --- Markdown → HTML（必要最小限：太字/引用/リンク/改行） ---
  const htmlBody =
    `<p>${escapeHtml(headerLine)}</p>` +
    `<div>` +
      convertMarkdownToHtml(mdBody) +
    `</div>`;

  // テキスト版（互換用）
  const textBody = `${headerLine}\n\n${mdBody.replace(/\*\*/g, "").replace(/^> /gm, "  ")}`;

  GmailApp.sendEmail(to, subject, textBody, { name: senderName, htmlBody: htmlBody });
  Logger.log("メール送信完了: " + to);
}

function sendWeeklyDigestTeams(headerLine, mdBody) {
  var url = PropertiesService.getScriptProperties().getProperty("TEAMS_WEBHOOK_URL");
  if (!url) { Logger.log("TEAMS_WEBHOOK_URL未設定のためTeams送信せず。"); return; }

  // メール送信と同様に Markdown を HTML のサブセットに変換し、Teamsに渡す
  var htmlText = convertMarkdownToHtml(mdBody);

  var payload = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    "themeColor": "0072C6",
    "summary": "週間RSSダイジェスト",
    "sections": [{
      "activityTitle": "週間RSSダイジェスト",
      // htmlText を渡す
      "text": "**" + headerLine + "**<br><br>" + htmlText
    }]
  };

  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  try {
    var res = UrlFetchApp.fetch(url, options);
    var ok = res.getResponseCode() === 200;
    if (!ok) {
      _logError("sendWeeklyDigestTeams", new Error(res.getContentText()), "Teams送信失敗。");
    }
    Logger.log(ok ? "Teams送信完了" : "Teams送信失敗。");
  } catch (e) {
    _logError("sendWeeklyDigestTeams", e, "Teams送信中に例外が発生しました。");
  }
}

// =================================================================
// 🛠️ Utilities (ユーティリティ関数)
// =================================================================

/**
 * HTMLタグを除去するユーティリティ関数
 * @param {string} html HTML文字列
 * @returns {string} HTMLタグを除去した文字列
 */
function stripHtml(html) {
  return html ? html.replace(/<[^>]*>?/gm, '') : '';
}

/** 日本語が含まれるかの簡易判定（含まれるなら false / 英語判定は true） */
function isLikelyEnglish(text) {
  return !(/[぀-ゟ゠-ヿ一-鿿]/.test(text));
}

/** 1行化＆最大長トリミング */
function oneLine(text, maxLen) {
  var s = String(text).replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - 1)) + "…";
}

/** 比較用に正規化（空白・句読点・記号を除去し、全角半角も大まかに吸収） */
function normalizeForCompare(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[ \u3000\t\r\n]/g, "")                   // 空白・改行除去（全角含む）
    .replace(/[「」『』【】\[\]\(\)（）…・、。,:;.!?\'"\-–—]/g, "") // 句読点・記号
    .replace(/｜/g, "|");                              // 全角縦棒を半角へ
}

/** yyyy/MM/dd */
function fmtDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd");
}

/** yyyy/MM/dd HH:mm */
function fmtDateTime(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd HH:mm");
}

/** HTMLエスケープ */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;");
}

/** `score|tldr` をパース */
function parseOnePSVLine(line) {
  if (!line) return null;
  var sep = line.indexOf("|");
  if (sep <= 0) return null;
  var s = line.slice(0, sep).trim();
  var t = line.slice(sep + 1).trim();
  var sc = parseInt(s, 10);
  if (isNaN(sc)) return null;
  if (!t) return { score: sc, tldr: "" };
  // tldrに '|' が紛れた時は全角へ置換
  t = t.replace(/\|/g, "｜");
  return { score: sc, tldr: t };
}