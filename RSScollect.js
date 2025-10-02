// =================================================================
// 📌 定数定義
// =================================================================
const RSS_LIST_SHEET_NAME = "RSS";
const TREND_DATA_SHEET_NAME = "collect";

// collectシートの列インデックス（1スタート）
const URL_COL = 3;      // C列: URL
const ABSTRACT_COL = 4; // D列: 抜粋
const SUMMARY_COL = 5;  // E列: 見出し（AI生成）
const SOURCE_COL = 6;   // F列: ソース（サイト名）

// LLM設定（Geminiはフォールバック用として維持）
const MODEL_NAME = "gemini-2.5-flash";
const DELAY_MS = 1500; // API制限回避のための遅延時間（1.5秒）

// ✨ 見出し生成に関するフィルタリング設定
const NO_ABSTRACT_TEXT = "抜粋なし";
const MIN_SUMMARY_LENGTH = 200; // ← 200文字未満は高速処理へ
const MISSING_ABSTRACT_TEXT = "記事が短すぎるか、抜粋がないため見出し生成をスキップしました。";
const SHORT_JA_SKIP_TEXT = "記事が短く、日本語のため見出し生成をスキップしました。";

// =================================================================
// 🔄 統合メインフロー（通知は呼びません）
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
// 📥 RSS収集・データ書き込み
// =================================================================
/**
 * RSSフィードを取得し、collectシートに追記（重複URLはスキップ）
 * 追記後はシート全体を A列（日付）で昇順に統一
 */
function collectRssFeeds() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rssListSheet = ss.getSheetByName(RSS_LIST_SHEET_NAME);
  const trendDataSheet = ss.getSheetByName(TREND_DATA_SHEET_NAME);

  if (!rssListSheet || !trendDataSheet) {
    Logger.log("エラー: シート名が正しくありません。'RSS'または'collect'のシート名を確認してください。");
    return;
  }

  const lastRow = rssListSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("RSSリストシートにデータがありません。");
    return;
  }

  const rssList = rssListSheet.getRange(2, 1, lastRow - 1, 2).getValues(); // [サイト名, RSS URL]
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
  const urls = sheet.getRange(2, URL_COL, lastRow - 1, 1).getValues().flat();
  return new Set(urls);
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
      // RSS 2.0
      const items = channel.getChildren("item");
      items.forEach(item => {
        const title = (item.getChild("title") && item.getChild("title").getText()) || "";
        const link  = (item.getChild("link") && item.getChild("link").getText()) || "";
        const pubDate = (item.getChild("pubDate") && item.getChild("pubDate").getText()) || "";
        const description = (item.getChild("description") && item.getChild("description").getText()) || "";

        if (link && !existingUrls.has(link) && title) {
          articles.push([
            pubDate ? new Date(pubDate) : new Date(), // A:日付
            title.trim(),                              // B:元タイトル
            link.trim(),                               // C:URL
            stripHtml(description) || NO_ABSTRACT_TEXT,// D:抜粋
            "",                                        // E: 見出し（AI生成）
            siteName                                   // F: ソース
          ]);
        }
      });
    } else {
      // Atom
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
          articles.push([
            pubDate ? new Date(pubDate) : new Date(),
            title.trim(),
            link.trim(),
            stripHtml(summary) || NO_ABSTRACT_TEXT,
            "",
            siteName
          ]);
        }
      });
    }
  } catch (e) {
    Logger.log("RSSの取得または解析エラー (" + siteName + "): " + e.toString());
  }
  return articles;
}

/** HTMLタグ除去 */
function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/** 追記後にシート全体を A列（日付）で昇順ソート */
function sortCollectByDateAsc() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(TREND_DATA_SHEET_NAME);
  const lastRow = sh.getLastRow();
  if (lastRow < 3) return; // データ行が1行以下なら処理不要
  const lastCol = sh.getLastColumn();
  // ヘッダー（1行目）を除く範囲を昇順ソート
  sh.getRange(2, 1, lastRow - 1, lastCol).sort({ column: 1, ascending: true });
}

// =================================================================
// 🧠 見出し生成（LLM） + 短文高速処理
// =================================================================
/** 日本語が含まれるかの簡易判定（含まれるなら false / 英語判定は true） */
function isLikelyEnglish(text) {
  return !(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(text));
}

/** 未見出し（E列空）の行に、見出し or 代替テキストを生成して入れる
 * 方針:
 *  - 抜粋なし or 短文（D列の長さ < MIN_SUMMARY_LENGTH）→ タイトル（B列）を E 列に記載
 *     ・タイトルが日本語: そのまま
 *     ・タイトルが英語: =GOOGLETRANSLATE(Bn,"auto","ja") を E 列に入れる
 *  - それ以外（十分長い）→ LLM でネットニュース風見出しを生成（既存どおり）
 */
function processSummarization() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TREND_DATA_SHEET_NAME);
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // B〜E（タイトル, URL, 抜粋, 見出し）をまとめて取得
  const range = sheet.getRange(2, 2, lastRow - 1, SUMMARY_COL - 2 + 1); // B..E
  const data = range.getValues();

  const updates = [];
  let apiCallCount = 0;

  data.forEach((row, index) => {
    const title = row[0];          // B: タイトル（RSSタイトル）
    const /* url = */ _url = row[1];  // C: URL（未使用）
    const abstractText = row[2];   // D: 抜粋
    const currentE = row[3];       // E: 見出し（AI or 代替）

    let outE = currentE;
    const rowNumber = index + 2; // データは2行目から

    if (!currentE || String(currentE).trim() === "") {
      // 「短文」判定（＝高品質要約の対象外）
      const isShort = (abstractText === NO_ABSTRACT_TEXT) ||
                      (String(abstractText || "").length < MIN_SUMMARY_LENGTH);

      if (isShort) {
        // === タイトルをそのまま（英語なら機械翻訳） ===
        if (title && String(title).trim() !== "") {
          if (isLikelyEnglish(String(title))) {
            outE = `=GOOGLETRANSLATE(B${rowNumber},"auto","ja")`;
            Logger.log(`E${rowNumber}: 短文→タイトル(英)を機械翻訳で代替`);
          } else {
            outE = String(title).trim();
            Logger.log(`E${rowNumber}: 短文→タイトル(日)を代替`);
          }
        } else {
          // タイトルが空などの例外時のみフォールバック（まれ）
          if (abstractText && abstractText !== NO_ABSTRACT_TEXT) {
            if (isLikelyEnglish(String(abstractText))) {
              outE = `=GOOGLETRANSLATE(D${rowNumber},"auto","ja")`;
              Logger.log(`E${rowNumber}: タイトル欠落→抜粋(英)の機械翻訳を代替`);
            } else {
              outE = String(abstractText).trim();
              Logger.log(`E${rowNumber}: タイトル欠落→抜粋(日)を代替`);
            }
          } else {
            outE = MISSING_ABSTRACT_TEXT; // 最終手段
            Logger.log(`E${rowNumber}: タイトル・抜粋ともに利用不可→固定文言`);
          }
        }

      } else {
        // === 通常：十分な長さ → LLMでネットニュース風見出しを生成 ===
        Logger.log(`E${rowNumber}: 見出し生成(通常)開始: ${String(title || "").substring(0, 30)}...`);
        // 要約素材は D（抜粋）優先。なければタイトルを渡す。
        const material = String(abstractText || title);
        outE = summarizeWithLLM(material); // Azure優先→Geminiへフォールバック
        apiCallCount++;
      }
    }

    updates.push([outE]);
  });

  if (updates.length > 0) {
    const outRange = sheet.getRange(2, SUMMARY_COL, updates.length, 1);
    outRange.setValues(updates);
    Logger.log(`LLMコール数: ${apiCallCount} 回。E列を更新しました（短文はタイトル基準、英語は機械翻訳）。`);
  }
}

// =================================================================
// 🧠 LLMディスパッチ & 各API呼び出し
// =================================================================
/** Azure設定があればAzure、無ければGeminiへ */
function summarizeWithLLM(articleText) {
  const props = PropertiesService.getScriptProperties();
  const azureUrl = props.getProperty("AZURE_ENDPOINT_URL");
  const azureKey = props.getProperty("OPENAI_API_KEY");
  if (azureUrl && azureKey) {
    return summarizeWithAzureOpenAI(articleText);
  }
  return summarizeWithGemini(articleText); // フォールバック
}

/** Azure OpenAI（Chat Completions）で「ネットニュース風見出し」を1行生成 */
function summarizeWithAzureOpenAI(articleText) {
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
  return executeAzureOpenAICall(SYSTEM, USER);
}

/** Azure OpenAI 呼び出し（Chat Completions） */
function executeAzureOpenAICall(systemPrompt, userPrompt) {
  const props = PropertiesService.getScriptProperties();
  const endpoint = props.getProperty("AZURE_ENDPOINT_URL");
  const apiKey   = props.getProperty("OPENAI_API_KEY");

  if (!endpoint || !apiKey) {
    Logger.log("Azure OpenAI のプロパティが未設定（AZURE_ENDPOINT_URL / OPENAI_API_KEY）");
    return "Azure設定不足のため見出しを生成できませんでした。";
  }

  const payload = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt }
    ],
    temperature: 0.2, // 少しだけ多様性
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
      Logger.log("Azure OpenAI API error: " + code + " - " + txt);
      headline = "API Error: " + code;
    } else {
      const json = JSON.parse(txt);
      // Chat Completions 形式
      if (json && json.choices && json.choices.length > 0 && json.choices[0].message && json.choices[0].message.content) {
        headline = String(json.choices[0].message.content).trim();
      } else {
        headline = "見出しが生成できませんでした。";
      }
    }
  } catch (e) {
    Logger.log("Azure OpenAI 呼び出しエラー: " + e.toString());
  }

  Utilities.sleep(DELAY_MS);
  return headline;
}

/** Gemini（フォールバック）で「ネットニュース風見出し」を1行生成 */
function summarizeWithGemini(articleText) {
  const API_KEY = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!API_KEY) {
    return "Gemini APIキー未設定のため見出しを生成できませんでした。";
  }
  const API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL_NAME + ":generateContent?key=" + API_KEY;
  const PROMPT = (
    "あなたはプロのニュース編集者です。臨床検査・バイオ要素技術の記事内容を、ネットニュースの見出しのように**1行**の日本語タイトルへ要約してください。\n" +
    "要件:\n" +
    "- 名詞止めを優先\n" +
    "- 専門用語は噛み砕いて簡潔に\n" +
    "- 誇張・断定は避け事実ベース\n" +
    "- 目安は全角20〜35字（オーバー可）\n" +
    "例：『AIが血液検査を高度化、迅速診断の精度向上』\n" +
    "記事: --- " + articleText + " ---"
  );

  return executeGeminiCall(API_ENDPOINT, PROMPT);
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
    Logger.log("Gemini API呼び出しエラー: " + e.toString());
  }
  Utilities.sleep(DELAY_MS);
  return headline;
}

// =================================================================
// 📣 通知（スタブ：いまは動かさない）
// =================================================================
/** 後日有効化用のスタブ：Teams通知（現状は何もしません） */
function postNewArticlesToTeams() {
  Logger.log("postNewArticlesToTeams(): 通知は未運用のため実行しません（スタブ）");
  // 実運用化する場合：Webhook 呼び出しと本文組立を実装し、mainAutomationFlow から呼び出してください。
}

/** 後日有効化用のスタブ：メール通知（現状は何もしません） */
function postNewArticlesByEmail() {
  Logger.log("postNewArticlesByEmail(): 通知は未運用のため実行しません（スタブ）");
  // 実運用化する場合：GmailApp.sendEmail でまとめ送信し、mainAutomationFlow から呼び出してください。
}
