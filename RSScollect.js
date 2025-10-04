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
    MODEL_NAME: "gemini-2.5-flash-lite",
    DELAY_MS: 1100,
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
  if (!sheet) {
    Logger.log("エラー: collectシートが見つかりません。");
    return;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return; // ヘッダー行のみの場合

  // データ範囲をA列でソート
  sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).sort({ column: 1, ascending: true });
  Logger.log("collectシートをA列（日付）で昇順にソートしました。");
}

/**
 * RSSフィードを取得し、collectシートに追記（重複URLはスキップ）
 * 追記後はA列（日付）で昇順に統一
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
  if (!trendDataSheet) {
    Logger.log("エラー: collectシートが見つかりません。");
    return;
  }

  const lastRow = trendDataSheet.getLastRow();
  if (lastRow < 2) return;

  // B〜E（タイトル, URL, 抜粋, 見出し）をまとめて取得
  const range = trendDataSheet.getRange(2, 2, lastRow - 1, Config.CollectSheet.Columns.SUMMARY - 2 + 1); // B..E
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
          if (abstractText && abstractText !== Config.Llm.NO_ABSTRACT_TEXT) {
            if (isLikelyEnglish(String(abstractText))) {
              outE = `=GOOGLETRANSLATE(D${rowNumber},"auto","ja")`;
              Logger.log(`E${rowNumber}: タイトル欠落→抜粋(英)の機械翻訳を代替`);
            }
            else {
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
    const outRange = trendDataSheet.getRange(2, Config.CollectSheet.Columns.SUMMARY, updates.length, 1);
    outRange.setValues(updates);
    Logger.log(`LLMコール数: ${apiCallCount} 回。E列を更新しました（短文はタイトル基準、英語は機械翻訳）。`);
  }
}


/** LLMで「ネットニュース風見出し」を1行生成（Azure優先→OpenAI→Geminiへフォールバック） */
function summarizeWithLLM(articleText) {
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

  return callLlmWithFallback(SYSTEM, USER, "gpt-4.1-nano");
}

// =================================================================
// 🤖 LLM API Clients (LLM API呼び出しクライアント)
// =================================================================

/**
 * LLMを呼び出す汎用関数（Azure優先→OpenAI→Geminiへフォールバック）
 * @param {string} systemPrompt システムプロンプト
 * @param {string} userPrompt ユーザープロンプト
 * @param {string} [openAiModel="gpt-4.1-nano"] OpenAI APIで使用するモデル名
 * @returns {string} LLMからの応答テキスト、またはエラーメッセージ
 */
function callLlmWithFallback(systemPrompt, userPrompt, openAiModel = "gpt-4.1-nano") {
  const props = PropertiesService.getScriptProperties();
  const azureUrl = props.getProperty("AZURE_ENDPOINT_URL");
  const azureKey = props.getProperty("OPENAI_API_KEY"); // AzureのAPIキー
  const openAiKey = props.getProperty("OPENAI_API_KEY_PERSONAL"); // 個人のOpenAI APIキー
  const geminiApiKey = props.getProperty("GEMINI_API_KEY");

  // 1. Azure OpenAIを試行
  if (azureUrl && azureKey) {
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

    let headline = "API呼び出し失敗";
    try {
      const res = UrlFetchApp.fetch(azureUrl, options);
      const code = res.getResponseCode();
      const txt  = res.getContentText();
      if (code !== 200) {
        _logError("callLlmWithFallback (Azure)", new Error(`API Error: ${code} - ${txt}`), "Azure OpenAI APIエラーが発生しました。");
        headline = "API Error: " + code;
      } else {
        const json = JSON.parse(txt);
        if (json && json.choices && json.choices.length > 0 && json.choices[0].message && json.choices[0].message.content) {
          headline = String(json.choices[0].message.content).trim();
        } else {
          _logError("callLlmWithFallback (Azure)", new Error("No content in response"), "Azure OpenAIから見出しが生成できませんでした。");
          headline = "見出しが生成できませんでした。";
        }
      }
    } catch (e) {
      _logError("callLlmWithFallback (Azure)", e, "Azure OpenAI呼び出し中に例外が発生しました。");
    }
    Utilities.sleep(Config.Llm.DELAY_MS);

    if (headline && headline.indexOf("API Error") === -1 && headline.indexOf("見出しが生成できませんでした。") === -1 && headline.indexOf("API呼び出し失敗") === -1) {
      return headline;
    }
    Logger.log("Azure OpenAIでの呼び出しに失敗しました。OpenAI APIを試行します。");
  }

  // 2. OpenAI APIを試行
  if (openAiKey) {
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
    let headline = "API呼び出し失敗";
    try {
      const res = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", options);
      const code = res.getResponseCode();
      const txt  = res.getContentText();
      if (code !== 200) {
        headline = `API Error: ${code} - ${txt}`;
      } else {
        const json = JSON.parse(txt);
        if (json.choices && json.choices.length > 0 && json.choices[0].message && json.choices[0].message.content) {
          headline = String(json.choices[0].message.content).trim();
        } else {
          headline = "見出し生成に失敗しました";
        }
      }
    } catch (e) {
      headline = "OpenAI呼び出し例外: " + e.toString();
    }

    if (headline && headline.indexOf("API Error") === -1 && headline.indexOf("見出し生成に失敗しました") === -1 && headline.indexOf("API呼び出し失敗") === -1 && headline.indexOf("OpenAI呼び出し例外") === -1) {
      return headline;
    }
    Logger.log("OpenAI APIでの呼び出しに失敗しました。Gemini APIを試行します。");
  }

  // 3. Geminiを試行
  if (geminiApiKey) {
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
    let headline = "API呼び出し失敗";
    try {
      const response = UrlFetchApp.fetch(API_ENDPOINT, options);
      const json = JSON.parse(response.getContentText());
      let text = null;
      if (json && json.candidates && json.candidates.length > 0 && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts.length > 0) {
        text = json.candidates[0].content.parts[0].text;
      }
      headline = text ? String(text).trim() : (json && json.error ? ("API Error: " + json.error.message) : "見出しが生成できませんでした。");
    } catch (e) {
      _logError("callLlmWithFallback (Gemini)", e, "Gemini API呼び出し中に例外が発生しました。");
    }
    Utilities.sleep(Config.Llm.DELAY_MS);
    
    if (headline && headline.indexOf("API Error") === -1 && headline.indexOf("見出しが生成できませんでした。") === -1 && headline.indexOf("API呼び出し失敗") === -1) {
      return headline;
    }
    Logger.log("Gemini APIでの呼び出しに失敗しました。");
  }

  return "いずれのLLMでも見出しを生成できませんでした。";
}

// =================================================================
// 📣 Notification Handlers (通知)
// =================================================================
/*
 * TODO: 将来的に、日々の更新をTeamsやメールで通知する機能を実装予定。
 * 現在は週次ダイジェestの通知のみが有効です。
 */

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
    topN: parseInt(props.getProperty("DIGEST_TOP_N") || "10", 10),
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

  var allItems = getArticlesInDateWindow(start, end); // headline(E)がある行のみ抽出
  if (allItems.length === 0) {
    Logger.log("週間ダイジェスト：対象期間 " + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1)) + " に記事はありません。");
    return;
  }

  // テーマに関連するキーワードリスト
  const THEME_KEYWORDS = ["臨床検査", "バイオ", "遺伝子", "ゲノム", "DNA", "RNA", "タンパク質", "疾患", "医療", "診断", "治療", "創薬", "研究", "技術", "解析", "シーケンシング", "エピジェネティック", "細胞", "免疫", "微生物", "AI", "機械学習"];

  // 記事を関連性の有無でフィルタリング
  const relevantArticles = [];
  let nonRelevantArticles = [];

  allItems.forEach(article => {
    const textToSearch = `${article.title} ${article.abstractText} ${article.headline}`;
    const isRelevant = THEME_KEYWORDS.some(keyword => textToSearch.includes(keyword));
    if (isRelevant) {
      relevantArticles.push(article);
    } else {
      nonRelevantArticles.push(article);
    }
  });

  var headerLine = "集計期間：" + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1));
  var mdBody = "";
  var otherArticlesMd = "";

  // 週次レポートを生成 (関連性の高い記事のみを渡す)
  const { reportBody, otherArticles: llmOtherArticles } = generateWeeklyReportWithLLM(relevantArticles);
  mdBody = reportBody;

  // LLMが生成したその他の記事と、フィルタリングで除外された記事を結合
  const combinedOtherArticles = nonRelevantArticles.concat(llmOtherArticles);

  // その他の記事をMarkdown形式で整形
  if (combinedOtherArticles.length > 0) {
    otherArticlesMd = "\n\n---\n\n&#128218; その他の記事\n";
    combinedOtherArticles.forEach(article => {
      otherArticlesMd += `- [${article.title}](${article.url})\n`;
    });
  }

  var preview = "【週間RSSダイジェスト】\\n" + headerLine + "\\n\\n" + mdBody + otherArticlesMd;
  Logger.log(preview);

  // 送信（送信先が無ければスキップ）
  if (config.notifyChannel === "email" || config.notifyChannel === "both") {
    sendWeeklyDigestEmail(headerLine, mdBody, otherArticlesMd); // otherArticlesMd を追加
  }
  if (config.notifyChannel === "teams" || config.notifyChannel === "both") {
    sendWeeklyDigestTeams(headerLine, mdBody, otherArticlesMd); // otherArticlesMd を追加
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
  var sh = SpreadsheetApp.getActive().getSheetByName(Config.SheetNames.TREND_DATA);
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

/**
 * 複数記事の抜粋を元に、週次トレンドレポートを生成する
 * @param {Array<object>} articles 期間内の記事オブジェクトの配列
 * @returns {object} { reportBody: string, otherArticles: Array<{title: string, url: string}> }
 */
function generateWeeklyReportWithLLM(articles) {
  const systemPrompt = "あなたはプロのニュース編集者です。1週間の動向を、読者が1分で把握できる要旨にまとめます。";
  const userPrompt = `
あなたはプロのニュース編集者です。以下の今週の記事抜粋一覧から、臨床検査・バイオ要素技術に関する共通するテーマを見つけて3〜4つのトレンドに分け、それぞれ見出しと要点を整理してください。

**このレポートはメールで配信されるため、読者が素早く内容を把握できるよう、可読性を特に重視してください。**

条件:
- 全体で400〜500字程度にまとめること。
- 各トレンドは見出しと2行以内の説明で構成すること。
- **各トレンドの終わりには、区切りとして水平線（---）を挿入すること。**
- **トレンドの見出しは、太字（**見出し**）にして強調すること。**
- 誇張や断定は避け、事実に基づいた内容にすること。
- 最後に1文で全体のまとめを入れること。
- 各要点には、関連する記事のタイトルとURLをMarkdown形式のリンクとして埋め込むこと。例: [記事タイトル](記事URL)
- **重要**: 臨床検査・バイオ要素技術に無関係な記事は、レポート本文に含めないでください。

記事一覧:
${articles.map(a => `- ${a.abstractText}（${a.source}: ${a.url}）`).join("\\n")}
`;

  const reportText = callLlmWithFallback(systemPrompt, userPrompt, "gpt-4.1-mini");

  // LLMの出力からレポート本文とその他の記事を分離
  const { parsedReportBody, otherArticles } = _parseWeeklyReportOutput(reportText, articles);

  return { reportBody: parsedReportBody, otherArticles };
}

/**
 * LLMから返された週次レポートのテキストを解析し、レポート本文と「その他の記事」を分離する
 * @param {string} reportText LLMから返された週次レポートのテキスト
 * @param {Array<object>} originalArticles 週次レポート生成に使用した元の記事リスト
 * @returns {object} { parsedReportBody: string, otherArticles: Array<{title: string, url: string}> }
 */
function _parseWeeklyReportOutput(reportText, originalArticles) {
  let parsedReportBody = reportText;
  const includedUrls = new Set();
  const otherArticles = [];

  // Markdownリンクの正規表現: [テキスト](URL)
  const markdownLinkRegex = /\[([^\]]+?)\]\((https?:\/\/[^\s)]+?)\)/g;
  let match;

  // レポート本文からリンクを抽出し、含まれるURLを記録
  while ((match = markdownLinkRegex.exec(reportText)) !== null) {
    const url = match[2];
    includedUrls.add(url);
  }

  // 元の記事リストを走査し、レポート本文に含まれていない記事をotherArticlesに追加
  originalArticles.forEach(article => {
    if (!includedUrls.has(article.url)) {
      otherArticles.push({ title: article.title, url: article.url });
    }
  });

  // レポート本文からMarkdownリンクを削除（表示用）
  // ただし、LLMの出力が既に整形されていることを期待するため、ここでは削除せずそのまま使用する
  // 必要であれば、ここで `reportText.replace(markdownLinkRegex, '$1')` のような処理を入れる
  // 今回はLLMに「Markdown形式で埋め込んでください」と指示しているので、そのまま表示する方針

  return { parsedReportBody, otherArticles };
}

// =================================================================
// ✉️ 週次の送信（送信先未設定なら送らない）
// =================================================================
function convertMarkdownToHtml(mdBody) {
  let html = mdBody;

  // MarkdownリストをHTMLリストに変換
  // 各行を処理し、'- 'で始まる行をリストアイテムに変換
  const lines = html.split(/\n/);
  let inList = false;
  let processedLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('-')) {
      if (!inList) {
        processedLines.push('<ul>');
        inList = true;
      }
      processedLines.push(`<li>${line.trim().substring(1).trim()}</li>`);
    } else {
      if (inList) {
        processedLines.push('</ul>');
        inList = false;
      }
      if (line.trim() !== '') { // 空行は<p>タグで囲まない
        processedLines.push(`<p>${line}</p>`);
      } else {
        processedLines.push(line); // 空行はそのまま
      }
    }
  }
  if (inList) {
    processedLines.push('</ul>');
  }
  html = processedLines.join('\n');

  html = html
    .replace(/^--+$/gm, '<hr>') // '--' や '---' など、2つ以上のハイフンに対応
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')          // **太字**
    .replace(/^> (.*)$/gm, '<blockquote>$1</blockquote>')      // > 引用
    // 記事を読む → URL記事を読む</a>
    .replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g,
     '<a href="$2">$1</a>')


  return html;
}

function sendWeeklyDigestEmail(headerLine, mdBody, otherArticlesMd) { // otherArticlesMd を引数に追加
  const props = PropertiesService.getScriptProperties();
  const to = props.getProperty("MAIL_TO");
  if (!to) { Logger.log("MAIL_TO未設定のためメール送信せず。"); return; }

  const subjectPrefix = props.getProperty("MAIL_SUBJECT_PREFIX") || "【週間RSS】";
  const senderName = props.getProperty("MAIL_SENDER_NAME") || "RSS要約ボット";
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd");
    const fullMdBody = mdBody + otherArticlesMd; // otherArticles を結合

  const convertedHtmlContent = convertMarkdownToHtml(fullMdBody); // ここで定義

  // --- Markdown → HTML（必要最小限：太字/引用/リンク/改行） ---
  const htmlBody =
    `<p>${escapeHtml(headerLine)}</p>` +
    `<div>` +
      convertedHtmlContent + // convertedHtmlContent を使用
    `</div>`;

  // テキスト版（互換用）
  const textBody = `${headerLine}\n\n${fullMdBody.replace(/\*\*/g, "").replace(/^> /gm, "  ")}`;

  // subject変数を再定義し、強制的にスコープ内で認識させる
  const finalSubject = subjectPrefix + today;

  GmailApp.sendEmail(to, finalSubject, textBody, { name: senderName, htmlBody: htmlBody });
  Logger.log("メール送信完了: " + to);
}

function sendWeeklyDigestTeams(headerLine, mdBody, otherArticlesMd) { // otherArticlesMd を引数に追加
  var url = PropertiesService.getScriptProperties().getProperty("TEAMS_WEBHOOK_URL");
  if (!url) { Logger.log("TEAMS_WEBHOOK_URL未設定のためTeams送信せず。"); return; }

  const fullMdBody = mdBody + otherArticlesMd; // otherArticlesMd を結合

  // メール送信と同様に Markdown を HTML のサブセットに変換し、Teamsに渡す
  var htmlText = convertMarkdownToHtml(fullMdBody); // fullMdBody を使用

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

/** yyyy/MM/dd */
function fmtDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd");
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