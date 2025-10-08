// ================================================================
// 【運用方針メモ 2025/10/08 Maeda】
// Teams通知は管理権限や仕様変更の影響が大きいため、今後はHTMLメール配信のみで運用予定。
// weeklyDigestJob() の Teams送信分岐は後日コメントアウトまたは削除予定。
// NOTIFY_CHANNEL_WEEKLY は "email" に設定済み。
// Adaptive Card関連のコードは将来的な再利用のため残しておく。
// ================================================================


/**
 * 【運用メモ｜Markdown統一】
 * - 目的：配信はTeamsメイン。メールは確認用。本文はMarkdownで統一。
 * - 生成：generateWeeklyReportWithLLM() は ハイライト／トレンド／Top Picks を Markdown で構築。
 * - Teams：createAdaptiveCardJSON() は MarkdownをTextBlockに流す。Top Picksは折りたたみ。
 * - メール：sendWeeklyDigestEmail() はテキスト（Markdownのまま）で送信。HTML生成は廃止。
 * - 主要件数：
 *   - DIGEST_TOP_N …… 週次分析・トレンド抽出の母集団（推奨 30〜40）
 *   - DIGEST_TOP_PICKS …… 巻末のTop Picks件数（推奨 5）
 * - AIコスト節約：
 *   - getArticlesInDateWindow() でG/H列（AI_SCORE/AI_TLDR）を読み、rankAndSelectArticles()で既存スコアは再採点スキップ。
 */

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
  sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).sort({ column: 1, ascending: false });
  Logger.log("collectシートをA列（日付）で降順にソートしました。");
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

    Logger.log(newData.length + " 件の新しい記事をシートに追記しました。");
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
    // 【修正箇所】User-Agentを設定するためのオプションを追加 (HTTP 403対策)
    const options = {
      'headers': {
        // 一般的なブラウザのUser-Agentを設定することで、サーバー側の自動アクセスブロックを回避
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      'muteHttpExceptions': true // エラーコードでも例外を投げず、コードで判定できるようにする
    };

    const response = UrlFetchApp.fetch(rssUrl, options);
    const code = response.getResponseCode();

    if (code !== 200) {
      // 200以外のレスポンスコード（例: 403, 500）の場合はエラーとしてログに記録し、スキップ
      throw new Error(`HTTP Error Code: ${code}. Check if the URL is accessible or if the server blocks automated requests.`);
    }

    const xml = response.getContentText();
    
    // 【MobiHealthNewsのXMLエラー対策 - XMLのプリプロセス】
    let preprocessedXml = xml;
    // RSS 2.0フィードでAtom要素（例: atom:link）が使われているが名前空間が定義されていない場合に修正
    if (preprocessedXml.includes('atom:link') && !preprocessedXml.includes('xmlns:atom')) {
        // <rss ...>を<rss ... xmlns:atom="http://www.w3.org/2005/Atom">に置換
        // 正規表現で、<rss>タグの属性の有無にかかわらず対応
        preprocessedXml = preprocessedXml.replace(/<rss([^>]*)>/i, '<rss$1 xmlns:atom="http://www.w3.org/2005/Atom">');
        Logger.log(`URL: ${rssUrl} にてAtom名前空間のプリプロセスを実行しました。`);
    }
    
    const document = XmlService.parse(preprocessedXml); // 修正されたXMLをパース
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
function callLlmWithFallback(systemPrompt, userPrompt, openAiModel = "gpt-4.1-nano", azureUrlOverride = null) {
  const props = PropertiesService.getScriptProperties();
  const azureUrl = azureUrlOverride || props.getProperty("AZURE_ENDPOINT_URL");
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
    // Utilities.sleep(Config.Llm.DELAY_MS);

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
  const { start, end } = getDateWindow(config.days);
  const allItems = getArticlesInDateWindow(start, end);
  if (allItems.length === 0) {
    Logger.log("週間ダイジェスト：対象期間に記事なし");
    return;
  }

  // 関連性フィルタ（日本語＋英語代表語）
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
  let nonRelevantArticles = [];
  allItems.forEach(article => {
    const text = `${article.title} ${article.abstractText} ${article.headline}`;
    const isRelevant = THEME_KEYWORDS.some(k => text.includes(k));
    if (isRelevant) relevantArticles.push(article);
    else nonRelevantArticles.push(article);
  });

  // ★ 選抜（AI採点済みも返す）
  const { selectedTopN, others, aiScoredItems } = rankAndSelectArticles(relevantArticles, config);

  // （任意）AIスコア/TL;DRの書き戻し（G/H列）
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(Config.SheetNames.TREND_DATA);
    const lastRow = sh.getLastRow();
    if (lastRow >= 2) {
      const range = sh.getRange(2, 1, lastRow - 1, Math.min(sh.getLastColumn(), 8)).getValues(); // A..H
      const urlToRow = new Map();
      for (let i = 0; i < range.length; i++) {
        const url = range[i][2]; // C列
        urlToRow.set(url, i + 2);
      }
      (aiScoredItems || selectedTopN).forEach(a => {
        const r = urlToRow.get(a.url);
        if (r) {
          sh.getRange(r, Config.CollectSheet.Columns.AI_SCORE).setValue(a.aiScore);
          if (config.useAiTldr) sh.getRange(r, Config.CollectSheet.Columns.AI_TLDR).setValue(a.tldr);
        }
      });
    }
  } catch (e) {
    _logError("weeklyDigestJob/writeBack", e, "AIスコア/TL;DRの書き戻しに失敗");
  }

  // 週次レポート生成（上位Nのみを渡す）
  const { reportBody, otherArticles: llmOtherArticles } = generateWeeklyReportWithLLM(selectedTopN);

  // その他記事（関連性低＋上位落ち＋LLM未掲載）
  const combinedOtherArticles = nonRelevantArticles.concat(others).concat(llmOtherArticles);

  // 送信
  const headerLine = "集計期間：" + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1));
  if (config.notifyChannel === "email" || config.notifyChannel === "both") {
    sendWeeklyDigestEmail(headerLine, reportBody);
  }
  if (config.notifyChannel === "teams" || config.notifyChannel === "both") {
    sendWeeklyDigestTeams(headerLine, reportBody, combinedOtherArticles);
  }
}



/** 期間ウィンドウ（今日含む過去 N 日） */
function getDateWindow(days) {
  var end = new Date(); end.setHours(24, 0, 0, 0); // 明日0:00
  var start = new Date(end); start.setDate(start.getDate() - Math.max(1, days)); // N日前の0:00
  return { start: start, end: end };
}

/**
 * A〜H列から、期間内＆見出し（E）がある記事だけ抽出（collectを読み取り）
 * A:日付, B:タイトル, C:URL, D:抜粋, E:見出し, F:ソース, G:AI_SCORE, H:AI_TLDR
 */
function getArticlesInDateWindow(start, end) {
  var sh = SpreadsheetApp.getActive().getSheetByName(Config.SheetNames.TREND_DATA);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = sh.getLastColumn();

  // ★ 8列（A..H）まで読み込む
  var vals = sh.getRange(2, 1, lastRow - 1, Math.min(lastCol, 8)).getValues(); // A..H
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    var date = r[0];
    var title = r[1];
    var url = r[2];
    var abstractText = r[3];
    var headline = r[4];
    var source = r[5];
    var aiScoreCell = r[6]; // G
    var tldrCell    = r[7]; // H

    var inRange = (date instanceof Date) && date >= start && date < end;
    var hasHeadline = headline && String(headline).trim() !== "" && String(headline).indexOf("API Error") === -1;
    if (inRange && hasHeadline && url) {
      // 既存スコアの読み取り（数値のみ採用）
      var aiScore = null;
      if (typeof aiScoreCell === 'number' && isFinite(aiScoreCell)) {
        aiScore = aiScoreCell;
      } else if (aiScoreCell && !isNaN(parseFloat(aiScoreCell))) {
        aiScore = parseFloat(aiScoreCell);
      }

      var tldr = tldrCell ? String(tldrCell) : "";

      out.push({
        date: date,
        title: title,
        url: url,
        abstractText: abstractText,
        headline: String(headline).trim(),
        source: source ? String(source) : "",
        aiScore: aiScore, // ★ 既存AIスコアを載せる
        tldr: tldr        // ★ 既存TL;DRも載せる（Top Picksで活用）
      });
    }
  }
  // 古い→新しいで整列（見やすさ用。最終的にはscoreで並べ替え）
  out.sort(function (a, b) { return a.date - b.date; });
  return out;
}

/**
 * 【運用メモ（標準版テンプレート）】
 * 構成：
 *  1) 今週のハイライト（3行、名詞止め、各45〜60字）
 *  2) 主要トレンド（3〜4群）：太字見出し(15〜20字) + 要点(120〜180字) + 代表リンク2〜4本
 *  3) Top Picks（5〜8本）：見出し + TL;DR(90〜120字) + URL
 *  4) その他：シートURLで案内（メール）／折りたたみ（Teams）
 *
 * 調整ポイント：
 *  - TopN件数：スクリプトプロパティ DIGEST_TOP_N（推奨 30〜40）
 *  - AI候補件数：DIGEST_AI_CANDIDATES（推奨 60〜80）
 *  - Top Picks件数：const TOP_PICKS_N で調整（推奨 6〜8）
 *  - TL;DR長さ：TLDR_MIN/MAX を調整（標準 90〜120字）
 *  - トレンド群数・リンク本数：NUM_TRENDS/LINKS_PER_TREND を調整
 *  - 途切れ対策：本関数は LLM 呼び出しを分割（ハイライト／トレンドのみ）し、TopPicksは既存TL;DRを優先使用
 *
 * 注意：
 *  - 引数 articles には rankAndSelectArticles() の selectedTopN（スコア順）を渡す前提
 *  - 返り値 otherArticles は、本文に含まれなかったURL推定（既存パーサ）で算出
 */
function generateWeeklyReportWithLLM(articles) {
  // === 標準版のパラメータ（必要に応じて調整） =========================
  var NUM_TRENDS = 3;          // 主要トレンドの群数（3〜4推奨）
  var LINKS_PER_TREND = 3;     // 各群に入れる代表リンク数（2〜4推奨）
  var TOP_PICKS_N = Math.min(5, articles.length); // Top Picks 件数（5〜8推奨）
  var TLDR_MIN = 50;           // Top Picks のTL;DR最小文字数
  var TLDR_MAX = 100;          // Top Picks のTL;DR最大文字数
  // ====================================================================

  // 1) ハイライト（3行）
  var highlights = _llmMakeHighlights(articles);

  // 2) 主要トレンド（群見出し＋要点＋リンクのみ）
  var trends = _llmMakeTrendSections(articles, NUM_TRENDS, LINKS_PER_TREND);

  // 3) Top Picks（TL;DRは既存を優先。ない場合のみ必要数だけ生成）
  var topPicksMd = _composeTopPicksSection(articles, TOP_PICKS_N, TLDR_MIN, TLDR_MAX);

  // 本文の組み立て（'---' 区切りはTeams/メール整形の目印）
  var body = [
    "### 今週のハイライト",
    highlights.join("\n"),
    "\n---\n",
    trends,
    "\n---\n",
    "**Top Picks（要点付き）**\n" + topPicksMd
  ].join("\n");

  // 既存のリンク解析で「本文に入らなかった記事」を抽出（任意表示）
  var parsed = _parseWeeklyReportOutput(body, articles);
  return { reportBody: body, otherArticles: parsed.otherArticles };
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

function sendWeeklyDigestEmail(headerLine, mdBody) {
  const props = PropertiesService.getScriptProperties();
  const to = props.getProperty("MAIL_TO");
  if (!to) { Logger.log("MAIL_TO未設定のためメール送信せず。"); return; }

  const subjectPrefix = props.getProperty("MAIL_SUBJECT_PREFIX") || "【週間RSS】";
  const senderName    = props.getProperty("MAIL_SENDER_NAME") || "RSS要約ボット";
  const today         = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd");
  const sheetUrl      = props.getProperty("DIGEST_SHEET_URL") || "(DIGEST_SHEET_URL 未設定)";

  // 巻末案内をMarkdownで追記（HTML化はしない）
  const fullMdBody = mdBody + "\n---\nその他の記事一覧は下記スプレッドシートでご覧いただけます。\n→ " + sheetUrl;

  // テキスト（Markdownのまま）送信
  const textBody = headerLine + "\n\n" + fullMdBody;
  const finalSubject = subjectPrefix + today;

  GmailApp.sendEmail(to, finalSubject, textBody, { name: senderName });
  Logger.log("メール送信（テキスト・Markdown）完了: " + to);
}

// =================================================================
// ✉️ 週次の送信（Teams）
// =================================================================

/**
 * 週次ダイジェストをTeamsにアダプティブカードで送信する
 * @param {string} reportBody レポート本文
 * @param {Array<Object>} otherArticles その他の記事
 */
function sendWeeklyDigestTeams(headerLine, mdBody, combinedOtherArticles) { // 引数名を変更
  const props = PropertiesService.getScriptProperties();
  const webhookUrl = props.getProperty("TEAMS_WEBHOOK_URL");
  if (!webhookUrl) {
    Logger.log("TeamsのWebhook URLが設定されていません。");
    return;
  }

  // ステップ1で追加した関数を呼び出し、アダプティブカードのペイロードを生成
  const payload = createAdaptiveCardJSON(mdBody, combinedOtherArticles);

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
  };

  try {
    // UrlFetchAppは200番台以外を例外として扱うため、明示的にfalseにする
    options.muteHttpExceptions = true;
    const res = UrlFetchApp.fetch(webhookUrl, options);
    
    // TeamsのWebhookは成功時に "1" というテキストを返すことがあるため、レスポンスコードで判定
    const responseCode = res.getResponseCode();
    if (responseCode >= 200 && responseCode < 300) {
      Logger.log("Teams送信完了");
    } else {
      const errorText = res.getContentText();
      _logError("sendWeeklyDigestTeams", new Error(errorText), `Teams送信失敗。ステータスコード: ${responseCode}`);
      Logger.log(`Teams送信失敗。ステータスコード: ${responseCode}, エラー: ${errorText}`);
    }
  } catch (e) {
    _logError("sendWeeklyDigestTeams", e, "Teams送信中に例外が発生しました。");
  }
}

/**
 * 週次レポートの内容からTeams用のアダプティブカードJSONを生成する
 * @param {string} reportBody - LLMが生成したレポート本文（ハイライトとトレンドを含む）
 * @param {Array<Object>} otherArticles - 「その他の記事」の配列
 * @returns {Object} Teams Webhook用のペイロードオブジェクト
 */
function createAdaptiveCardJSON(reportBody, otherArticles) {
  const cardTitle = `今週の臨床検査・バイオ技術トレンド Weekly Digest (${fmtDate(new Date())}週)`;

  // Markdownの区切り：本文は '\n---\n' で分割する前提
  const sections = reportBody.split('\n---\n').map(s => s.trim()).filter(Boolean);
  const cardBody = [];

  // 1) タイトル
  cardBody.push({
    type: "TextBlock",
    text: cardTitle,
    weight: "Bolder",
    size: "Large",
    wrap: true
  });

  // 2) セクションを順に配置
  sections.forEach((sec, idx) => {
    if (idx > 0) cardBody.push({ type: "TextBlock", text: " ", separator: true });

    // Top Picks セクションかどうか（先頭行が **Top Picks…** か）
    const isTopPicks = /^\*\*.*Top Picks.*\*\*/m.test(sec);
    if (isTopPicks) {
      const lines = sec.split('\n').filter(l => l.trim() !== '');
      const heading = lines[0].replace(/\*\*/g, '');
      const itemsMd = lines.slice(1).join('\n');

      // 見出しは表、内容は折りたたみ
      cardBody.push({ type: "TextBlock", text: `**${heading}**`, weight: "Bolder", size: "Medium", wrap: true });
      cardBody.push({
        type: "Container",
        items: [
          { type: "ActionSet",
            actions: [{ type: "Action.ToggleVisibility",
                        title: "🔎 Top Picks を表示／非表示",
                        targetElements: ["topPicksContainer"] }] },
          { type: "Container", id: "topPicksContainer", isVisible: false,
            items: [{ type: "TextBlock", text: itemsMd, wrap: true }] }
        ]
      });
    } else {
      // ハイライト／トレンドはMarkdownのまま表示
      cardBody.push({ type: "TextBlock", text: sec, wrap: true });
    }
  });

  // 3) その他の記事（折りたたみ）
  if (otherArticles && otherArticles.length > 0) {
    cardBody.push({ type: "TextBlock", text: " ", separator: true });
    const otherMd = otherArticles.map(a => `- ${a.title}`).join('\n');
    cardBody.push({
      type: "Container",
      items: [
        { type: "ActionSet",
          actions: [{ type: "Action.ToggleVisibility",
                      title: `📚 その他の注目記事 (${otherArticles.length}件) を表示／非表示`,
                      targetElements: ["otherArticlesContainer"] }] },
        { type: "Container", id: "otherArticlesContainer", isVisible: false,
          items: [{ type: "TextBlock", text: otherMd, wrap: true }] }
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
// 🛠️ 重みづけ関連
// =================================================================

/**
 * ルールベースの重要度スコア（0-100）
 * 要素: キーワードヒット、ソース優先度、鮮度、抜粋の有無 等
 * @param {Object} article - { date, title, abstractText, headline, source }
 * @returns {number} 0〜100 の整数
 */
function computeHeuristicScore(article) {
  const now = new Date();
  const daysOld = Math.max(0, Math.floor((now - article.date) / (1000 * 60 * 60 * 24)));

  // ソース優先度（必要に応じて調整）
  const SOURCE_WEIGHTS = {
    "Nature NEWS": 1.0,
    "Nature: 臨床診療と研究": 1.0,
    "GEN(Genetic Engineering and Biotechnology News)": 0.9,
    "BioWorld (AI分野)": 0.9,
    "BioWorld (遺伝子治療)": 0.9,
    "BioWorld (細胞治療)": 0.9,
    "Medical Xpress": 0.7,
    "Medscape Medical News": 0.8,
    "bioRxiv (Genomics)": 0.6,
    "bioRxiv(Molecular Biology)": 0.6,
    "bioRxiv(Bioengineering)": 0.6,
    "bioRxiv(Cancer Biology)": 0.6,
    "BioPharma Dive": 0.8,
    "Fierce Biotech": 0.8,
    "Labiotech.eu": 0.7,
    "MobiHealthNews": 0.6,
    "Clinical Lab Products": 0.7,
    "CBnews(医療)": 0.7,
    "CBnews(薬事)": 0.7,
    "Health & Medicine News": 0.6,
    "UMIN 臨床試験登録情報 (CTR)": 0.8
  };

  // キーワード重み（重要語を強める）
  const KEYWORD_WEIGHTS = {
    "臨床検査": 10, "診断": 8, "検査薬": 8, "体外診断": 8,
    "AI": 7, "機械学習": 7, "ゲノム": 7, "遺伝子": 6,
    "RNA": 5, "タンパク質": 5, "シーケンシング": 6,
    "治療": 5, "創薬": 6, "バイオ": 5, "免疫": 5, "細胞": 5,
    "プレシジョン": 4, "リアルワールド": 4, "規制": 4, "薬事": 4
  };

  const txt = `${article.title || ""} ${article.abstractText || ""} ${article.headline || ""}`;
  let keywordScore = 0;
  Object.keys(KEYWORD_WEIGHTS).forEach(k => {
    if (txt.includes(k)) keywordScore += KEYWORD_WEIGHTS[k];
  });

  const sourceWeight = SOURCE_WEIGHTS[article.source] || 0.6;

  // 鮮度（ハーフライフ=7日）：新しいほど高く
  const freshness = Math.exp(-daysOld / 7); // 1(今日)→~0.37(7日)

  // 抜粋の有無（ある程度長ければ加点）
  const hasAbstract = article.abstractText && article.abstractText !== Config.Llm.NO_ABSTRACT_TEXT;
  const abstractBonus = hasAbstract ? Math.min(10, String(article.abstractText).length / 200) : 0;

  // 合成：係数は初期値（調整可）
  const raw = (keywordScore) + (sourceWeight * 30) + (freshness * 40) + abstractBonus;

  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * 記事の重要度(0-100)とTL;DR(150-200字)をAIで生成
 * 戻り値: { score: number, tldr: string }
 */
function aiScoreOneArticle(article) {
  const systemPrompt = "あなたは臨床検査・バイオ技術の専門ニュースエディターです。";
  const userPrompt = [
    "以下の記事について、臨床検査・医療・バイオ要素技術の観点での重要度を 0〜100 で評価し、",
    "次行に150〜200字の日本語TL;DR（名詞止め優先、誇張なし、事実ベース）を出力してください。",
    "",
    "厳密な出力フォーマット以外は一切書かないでください。",
    "【出力フォーマット】",
    "（1行目）数値のみ（0〜100）",
    "（2行目）TL;DR本文のみ（改行・箇条書き・装飾なし）",
    "",
    `タイトル: ${article.title}`,
    `抜粋: ${article.abstractText || ""}`,
    `見出し: ${article.headline || ""}`,
    `ソース: ${article.source || ""}`
  ].join("\n");

  const txt = callLlmWithFallback(systemPrompt, userPrompt, "gpt-4.1-nano");
  const parsed = parseOnePSVLine(txt); // 1行目=score, 2行目=tldr を想定
  if (parsed) return parsed;
  return { score: 50, tldr: "" }; // フォールバック
}

/**
 * ヒューリスティック＋AIスコアで選抜・整列して TopN を返す
 * 既存 aiScore がある記事は AIコールをスキップ（コスト節約）
 */
function rankAndSelectArticles(relevantArticles, config) {
  const w_h = 0.4;                // ルールベース重み
  const w_ai = 0.6;               // AI重み
  const topN = config.topN || 20; // 最終採用数
  const aiCandidates = Math.min(config.aiCandidates || 50, relevantArticles.length);
  const perSourceCap = 3;         // 1ソース最大採用数（偏り抑制）

  // ① ヒューリスティック計算＋既存aiScore/tldrを保持
  const withHeu = relevantArticles
    .map(function (a) {
      const h = computeHeuristicScore(a);
      return {
        date: a.date, title: a.title, url: a.url,
        abstractText: a.abstractText, headline: a.headline, source: a.source,
        heuristicScore: h,
        aiScore: (typeof a.aiScore === 'number' && isFinite(a.aiScore)) ? a.aiScore : null, // ★既存スコア
        tldr: a.tldr || "" // ★既存TL;DR（Top Picksで使う）
      };
    })
    .sort(function (a, b) { return b.heuristicScore - a.heuristicScore; });

  // ② AIスコアリング対象の抽出（上位 aiCandidates のうち aiScore==null のものだけ）
  let aiScoredItems = [];
  if (config.useAiRank || config.useAiTldr) {
    var maxIdx = Math.min(aiCandidates, withHeu.length);
    var aiTargets = []; // 再採点が必要なものだけ
    for (var i = 0; i < maxIdx; i++) {
      if (withHeu[i].aiScore === null) aiTargets.push(i);
    }

    // ログ（節約状況の可視化）
    Logger.log("[AI Rank] candidates(top): " + maxIdx +
               ", already_scored: " + (maxIdx - aiTargets.length) +
               ", to_score_now: " + aiTargets.length);

    // ★ 必要なものだけ AI コール
    for (var t = 0; t < aiTargets.length; t++) {
      var idx = aiTargets[t];
      var s = aiScoreOneArticle(withHeu[idx]); // { score, tldr }（TL;DRはここではランキングに使わない）
      withHeu[idx].aiScore = s.score;
      // （コスト節約のため、ここでは tldr を使わない。Top Picks 段で必要分だけ生成）
      Utilities.sleep((Config && Config.Llm && Config.Llm.DELAY_MS) ? Config.Llm.DELAY_MS : 1000);
    }

    // aiScoredItems = 上位ブロック（既存＋新規スコア付与済み）
    aiScoredItems = withHeu.slice(0, maxIdx);
  } else {
    // AIランク未使用：ヒューリスティックをそのまま採用
    for (var k = 0; k < withHeu.length; k++) {
      if (withHeu[k].aiScore === null) withHeu[k].aiScore = withHeu[k].heuristicScore;
    }
  }

  // ③ 複合スコア（既存aiScoreを尊重して合成）
  for (var m = 0; m < withHeu.length; m++) {
    // aiScore がまだ null（対象外）ならヒューリスティックで代替
    if (withHeu[m].aiScore === null) withHeu[m].aiScore = withHeu[m].heuristicScore;
    withHeu[m].finalScore = Math.round(w_h * withHeu[m].heuristicScore + w_ai * withHeu[m].aiScore);
  }

  // ④ 最終ソート
  withHeu.sort(function (a, b) { return b.finalScore - a.finalScore; });

  // ⑤ ソース偏り抑制（greedy）
  var picked = [];
  var perSourceCount = {};
  for (var n = 0; n < withHeu.length; n++) {
    var item = withHeu[n];
    var src  = item.source || "unknown";
    perSourceCount[src] = (perSourceCount[src] || 0);
    if (perSourceCount[src] >= perSourceCap) continue;
    picked.push(item);
    perSourceCount[src]++;
    if (picked.length >= topN) break;
  }

  // ⑥ その他
  var pickedUrls = {};
  for (var p = 0; p < picked.length; p++) pickedUrls[picked[p].url] = true;
  var others = [];
  for (var q = 0; q < withHeu.length; q++) if (!pickedUrls[withHeu[q].url]) others.push(withHeu[q]);

  return { selectedTopN: picked, others: others, aiScoredItems: aiScoredItems };
}

/**
 * ハイライト3行を LLM で生成（入力は見出し＋ソース＋URLのみ）
 * 出力：'- ' で始まる3行のみ。名詞止め・45〜60字を厳守。
 */
function _llmMakeHighlights(articles) {
  var system = "あなたは週次ダイジェスト編集者。斜め読みで動向を掴める3つの要旨を作成する。";
  var list = articles.map(function(a){ return "- " + a.headline + "（" + (a.source||"") + ": " + a.url + "）"; }).join("\n");
  var user = [
    "以下の記事見出しリストから、今週のハイライトを3点だけ、日本語で45〜60字の箇条書きにしてください。",
    "誇張なし、事実ベース、名詞止め優先。出力は '- ' で始まる3行のみ。他の文字や説明を一切書かないこと。",
    list
  ].join("\n");

  var txt = callLlmWithFallback(system, user, "gpt-4.1-nano");
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
 * 主要トレンド（3〜4群）：太字見出し + 要点(120〜180字) + リンク(2〜4本)
 * 記事は見出し＋URLのみ渡し、本文は群の要点で要約する（トークン節約）
 */
function _llmMakeTrendSections(articles, numTrends, linksPerTrend) {
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

  var txt = callLlmWithFallback(system, user, "gpt-4.1-nano");
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
 * Top Picks セクションを組み立てる（番号 + 見出しリンク + TL;DR）
 * 既存 a.tldr を優先使用。無ければ必要数のみ LLM で TL;DR を生成。
 */
function _composeTopPicksSection(articles, topN, TLDR_MIN, TLDR_MAX) {
  var picks = articles.slice(0, Math.min(topN, articles.length));
  var lines = [];
  var needTldr = [];

  // 1) 既存TL;DR確認
  for (var i=0; i<picks.length; i++) {
    if (!picks[i].tldr || !String(picks[i].tldr).trim()) {
      needTldr.push(picks[i]);
    }
  }

  // 2) 不足分だけTL;DR生成（レート制御）
  for (var j=0;j<needTldr.length;j++){
    var a = needTldr[j];
    var sys = "あなたは臨床検査・バイオ技術の専門ニュースエディターです。";
    var usr = [
      "以下の記事について、日本語で " + TLDR_MIN + "〜" + TLDR_MAX + "字のTL;DRを作成してください。",
      "名詞止め優先、誇張なし、事実ベース。出力は1行のみ、装飾・改行なし。",
      "タイトル: " + a.title,
      "見出し: " + (a.headline||""),
      "抜粋: " + (a.abstractText||""),
      "ソース: " + (a.source||"")
    ].join("\n");
    var out = callLlmWithFallback(sys, usr, "gpt-4.1-nano");
    if (out) {
      out = out.replace(/\r?\n/g, "｜").trim();
      a.tldr = out;
    }
    Utilities.sleep((Config && Config.Llm && Config.Llm.DELAY_MS) ? Config.Llm.DELAY_MS : 1000);
  }

  // 3) Markdown整形
  for (var k=0; k<picks.length; k++) {
    var p = picks[k];
    var num = (k+1) + ". ";
    var head = (p.headline || p.title || "").trim();
    var link = p.url ? " | 記事" : "";
    var tldr = (p.tldr && String(p.tldr).trim()) ? String(p.tldr).trim() : "";
    lines.push(num + head + " " + link + "\n" + (tldr ? "*TL;DR:* " + tldr : ""));
  }
  return lines.join("\n");
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

/** `score|tldr` をパース */
function parseOnePSVLine(line) {
  if (!line) return null;
  var sep = line.indexOf("\n");
  if (sep <= 0) return null;
  var s = line.slice(0, sep).trim();
  var t = line.slice(sep + 1).trim();
  var sc = parseInt(s, 10);
  if (isNaN(sc)) return null;
  if (!t) return { score: sc, tldr: "" };
  // 改行が紛れた場合は全角縦棒へ置換（メール/Teams崩れ防止）
  t = t.replace(/\n/g, "｜");
  return { score: sc, tldr: t };
}

// =================================================================
// 🛠️ デバッグ用
// =================================================================

function debugTopPicksLink() {
  const cfg = _getDigestConfig();
  const { start, end } = getDateWindow(cfg.days || 7);
  // TopNだけ拾ってTop Picksを作る
  const arts = getArticlesInDateWindow(start, end).slice(0, cfg.topN || 30);
  const md = _composeTopPicksSection(arts, 5, 90, 120);
  Logger.log("--- Top Picks Markdown ---\n" + md);
}

