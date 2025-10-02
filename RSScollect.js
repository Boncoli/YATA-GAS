// =================================================================
// 📌 定数定義
// =================================================================
const RSS_LIST_SHEET_NAME = "RSS";
const TREND_DATA_SHEET_NAME = "collect";

// collectシートの列インデックス（1スタート）
const URL_COL = 3;      // C列: URL
const ABSTRACT_COL = 4; // D列: 抜粋
const SUMMARY_COL = 5;  // E列: AI要約

// LLM設定（Geminiはフォールバック用として維持）
const MODEL_NAME = "gemini-2.5-flash";
const DELAY_MS = 1200; // API制限回避のための遅延時間（1.2秒）

// ✨ AI要約のフィルタリング設定
const NO_ABSTRACT_TEXT = '抜粋なし';
const MIN_SUMMARY_LENGTH = 200; // ← 200文字未満の抜粋はGoogle翻訳関数で高速処理
const MISSING_ABSTRACT_TEXT = "記事が短すぎるか、抜粋がないためAI要約をスキップしました。";
const SHORT_JA_SKIP_TEXT = "記事が短く、日本語のため要約をスキップしました。";

// =================================================================
// 🔄 統合メインフロー
// =================================================================
/**
 * 収集と要約を順次実行する統合フロー（トリガー設定用）
 */
function mainAutomationFlow() {
  Logger.log("--- 自動化フロー開始 ---");
  // 1. RSS収集
  collectRssFeeds();
  // 2. フィルタリング＆要約/翻訳
  processSummarization();
  Logger.log("--- 自動化フロー完了 ---");
}

// =================================================================
// 📥 RSS収集・データ書き込み
// =================================================================
/**
 * RSSフィードを取得し、トレンドデータシートに書き込むメイン関数
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

  const rssList = rssListSheet.getRange(2, 1, lastRow - 1, 2).getValues();
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
    const startRow = trendDataSheet.getLastRow() === 0 ? 1 : trendDataSheet.getLastRow() + 1;
    trendDataSheet.getRange(startRow, 1, newData.length, newData[0].length).setValues(newData);
    Logger.log(`${newData.length} 件の新しい記事をシートに追記しました。`);
  } else {
    Logger.log("新しい記事は見つかりませんでした。");
  }
}

/**
 * トレンドデータシートから既存のURLリストを取得する（重複チェック用）
 */
function getExistingUrls(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();
  const urls = sheet.getRange(2, URL_COL, lastRow - 1, 1).getValues().flat();
  return new Set(urls);
}

/**
 * 指定されたRSS URLからフィードを取得し、記事データを解析する
 */
function fetchAndParseRss(rssUrl, siteName, existingUrls) {
  let articles = [];
  try {
    const xml = UrlFetchApp.fetch(rssUrl).getContentText();
    const document = XmlService.parse(xml);
    const root = document.getRootElement();

    // RSS2.0（<channel><item>）とAtom（<feed><entry>）の両対応
    const channel = root.getChild("channel");
    if (channel) {
      // RSS
      const items = channel.getChildren("item");
      items.forEach(item => {
        const title = (item.getChild("title") && item.getChild("title").getText()) || "";
        const link  = (item.getChild("link") && item.getChild("link").getText()) || "";
        const pubDate = (item.getChild("pubDate") && item.getChild("pubDate").getText()) || "";
        const description = (item.getChild("description") && item.getChild("description").getText()) || "";

        if (link && !existingUrls.has(link) && title) {
          articles.push([
            pubDate ? new Date(pubDate) : new Date(),
            title.trim(),
            link.trim(),
            stripHtml(description) || NO_ABSTRACT_TEXT,
            "",       // E列: AI要約（空欄）
            siteName  // F列: ソース
          ]);
        }
      });
    } else {
      // Atom
      const ATOM_NS = XmlService.getNamespace('http://www.w3.org/2005/Atom');
      const entries = root.getChildren('entry', ATOM_NS) || [];
      entries.forEach(entry => {
        const title = (entry.getChild('title', ATOM_NS) && entry.getChild('title', ATOM_NS).getText()) || "";
        const linkEl = (entry.getChildren('link', ATOM_NS) || []).find(el => {
          const relAttr = el.getAttribute('rel');
          return !relAttr || relAttr.getValue() === 'alternate';
        });
        const link = linkEl ? (linkEl.getAttribute('href') && linkEl.getAttribute('href').getValue()) : "";
        const pubDate = ((entry.getChild('updated', ATOM_NS) && entry.getChild('updated', ATOM_NS).getText())
                      || (entry.getChild('published', ATOM_NS) && entry.getChild('published', ATOM_NS).getText())
                      || "");
        const summary = ((entry.getChild('summary', ATOM_NS) && entry.getChild('summary', ATOM_NS).getText())
                      || (entry.getChild('content', ATOM_NS) && entry.getChild('content', ATOM_NS).getText())
                      || "");

        if (link && !existingUrls.has(link) && title) {
          articles.push([
            pubDate ? new Date(pubDate) : new Date(),
            title.trim(),
            link.trim(),
            stripHtml(summary) || NO_ABSTRACT_TEXT,
            "",       // E列: AI要約（空欄）
            siteName  // F列: ソース
          ]);
        }
      });
    }
  } catch (e) {
    Logger.log(`RSSの取得または解析エラー (${siteName}): ${e.toString()}`);
  }
  return articles;
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// =================================================================
// 🧠 LLMによるAI要約処理（高速翻訳統合版）
// =================================================================
/**
 * テキストに日本語の文字が含まれているかチェック
 * @returns {boolean} 日本語文字が含まれていれば false（Englishではない）
 */
function isLikelyEnglish(text) {
  // ひらがな、カタカナ、漢字のいずれかを含むかチェック
  return !(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(text));
}

/**
 * トレンドデータシートをスキャンし、未要約の記事を処理
 * ⭐ 短い記事はGoogle翻訳関数をE列に記入（コスト節約＆高速化）
 */
function processSummarization() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TREND_DATA_SHEET_NAME);
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const range = sheet.getRange(2, 2, lastRow - 1, SUMMARY_COL - 2 + 1); // B〜E
  const data = range.getValues();

  const summariesToUpdate = [];
  let apiCallCount = 0;

  data.forEach((row, index) => {
    const title = row[0];
    const abstractText = row[2];
    const currentSummary = row[3];
    let summaryResult = currentSummary;

    // E列（AI要約）が空欄のときだけ処理
    if (!currentSummary || currentSummary.toString().trim() === "") {
      const articleTextForSummary = abstractText || title;
      const rowNumber = index + 2; // データは2行目から

      if (abstractText === NO_ABSTRACT_TEXT) {
        // 1) 抜粋なし → スキップメッセージ
        summaryResult = MISSING_ABSTRACT_TEXT;
      } else if (articleTextForSummary.length < MIN_SUMMARY_LENGTH) {
        // 2) 短文
        if (isLikelyEnglish(articleTextForSummary)) {
          // 英語 → Google翻訳関数をE列に挿入
          Logger.log(`要約スキップ: 記事が短いが英語のためGoogle翻訳をE${rowNumber}に設定 - ${title?.substring(0, 30) || ''}...`);
          summaryResult = `=GOOGLETRANSLATE(D${rowNumber},"auto","ja")`;
        } else {
          // 日本語 → スキップメッセージ
          Logger.log(`要約スキップ: 記事が短く日本語のためスキップ - ${title?.substring(0, 30) || ''}...`);
          summaryResult = SHORT_JA_SKIP_TEXT;
        }
      } else {
        // 3) 通常のAI要約
        Logger.log(`要約処理（通常）開始: ${title?.substring(0, 30) || ''}...`);
        summaryResult = summarizeWithLLM(articleTextForSummary); // ← Azure/Gemini自動切替
        apiCallCount++;
      }
    }
    summariesToUpdate.push([summaryResult]);
  });

  if (summariesToUpdate.length > 0) {
    const summaryRange = sheet.getRange(2, SUMMARY_COL, summariesToUpdate.length, 1);
    // setValuesで関数（=GOOGLETRANSLATE...）もテキストとして一括書き込み
    summaryRange.setValues(summariesToUpdate);
    Logger.log(`APIコール数: ${apiCallCount} 回。要約結果をE列に更新しました。`);
  }
}

/**
 * LLMディスパッチャ（Azure設定があればAzure、無ければGemini）
 */
function summarizeWithLLM(articleText) {
  const props = PropertiesService.getScriptProperties();
  const azureUrl = props.getProperty("AZURE_ENDPOINT_URL");
  const azureKey = props.getProperty("OPENAI_API_KEY");
  if (azureUrl && azureKey) {
    return summarizeWithAzureOpenAI(articleText);
  }
  return summarizeWithGemini(articleText); // フォールバック
}

/**
 * Azure OpenAI（Chat Completions）で tl;dr を日本語1行で出力
 */
function summarizeWithAzureOpenAI(articleText) {
  const SYSTEM = "あなたは臨床検査・バイオ要素技術のニュースを要素技術開発者向けに要約するアシスタントです。常に日本語で、簡潔で具体的に出力します。";
  const USER = [
    "以下の記事の要点を、応用可能性と技術の新規性に焦点を当て、",
    "見出しのように **1段落の tl;dr（目安150〜200字）** で日本語要約してください",
    "",
    "記事: ---",
    articleText,
    "---"
  ].join("\n");
  return executeAzureOpenAICall(SYSTEM, USER);
}

/**
 * Azure OpenAI 呼び出し（Chat Completions）
 * - Script Properties:
 *     AZURE_ENDPOINT_URL : フルURL（/chat/completions?api-version=... まで）
 *     OPENAI_API_KEY     : Azure OpenAI の API キー
 */
function executeAzureOpenAICall(systemPrompt, userPrompt) {
  const props = PropertiesService.getScriptProperties();
  const endpoint = props.getProperty("AZURE_ENDPOINT_URL");
  const apiKey   = props.getProperty("OPENAI_API_KEY");

  if (!endpoint || !apiKey) {
    Logger.log("Azure OpenAI のプロパティが未設定です（AZURE_ENDPOINT_URL / OPENAI_API_KEY）。Gemini にフォールバックしてください。");
    return "Azure設定不足のため要約できませんでした。";
  }

  const payload = {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt }
    ],
    temperature: 0.1,    // 精度寄り
    max_tokens: 256
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: { "api-key": apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  let resultSummary = "API呼び出し失敗";
  try {
    const res = UrlFetchApp.fetch(endpoint, options);
    const code = res.getResponseCode();
    const txt  = res.getContentText();
    if (code !== 200) {
      Logger.log(`Azure OpenAI API error: ${code} - ${txt}`);
      resultSummary = `API Error: ${code}`;
    } else {
      const json = JSON.parse(txt);
      const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      if (content) {
        resultSummary = content.trim();
      } else {
        Logger.log("Azure OpenAI 応答に content が見つかりません。");
        resultSummary = "要約結果が見つかりませんでした。";
      }
    }
  } catch (e) {
    Logger.log("Azure OpenAI 呼び出しエラー: " + e.toString());
  }

  // レート制限のため小休止
  Utilities.sleep(DELAY_MS);
  return resultSummary;
}

// =================================================================
// 🤖 Gemini API（フォールバック用）
// =================================================================
/**
 * Gemini APIを呼び出し、テキストを要約する（通常プロンプト）
 */
function summarizeWithGemini(articleText) {
  const API_KEY = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${API_KEY}`;
  const PROMPT = `
以下の臨床検査技術やバイオ技術に関する記事の要点を、要素技術開発者の視点から、応用可能性と技術の新規性に焦点を当てて記事の見出しのように1行のtl;drとして端的に要約し、必ず日本語で出力してください。
記事: --- ${articleText} ---
`.trim();

  return executeGeminiCall(API_ENDPOINT, PROMPT);
}

/**
 * 共通のGemini API呼び出しを実行するヘルパー関数
 */
function executeGeminiCall(apiEndpoint, prompt) {
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 256
    }
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  let resultSummary = "API呼び出し失敗";
  try {
    const response = UrlFetchApp.fetch(apiEndpoint, options);
    const json = JSON.parse(response.getContentText());
    const summary = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (summary) {
      resultSummary = summary.trim();
    } else {
      const errorMessage = json.error ? `API Error: ${json.error.message}` : "要約結果が見つかりませんでした。";
      Logger.log(errorMessage);
      resultSummary = errorMessage;
    }
  } catch (e) {
    Logger.log("Gemini API呼び出しエラー: " + e.toString());
  }
  Utilities.sleep(DELAY_MS); // レート制御
  return resultSummary;
}

// =================================================================
// 📣 Teams通知処理
// =================================================================
/**
 * シートをスキャンし、新しい記事（AI要約完了後）をTeamsに通知するメイン関数
 */
function postNewArticlesToTeams() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TREND_DATA_SHEET_NAME);

  // 📝 Teams Webhook URLが未設定なら通知処理をスキップ
  const WEBHOOK_URL = PropertiesService.getScriptProperties().getProperty("TEAMS_WEBHOOK_URL");
  if (!WEBHOOK_URL) {
    Logger.log("Teams Webhook URLが未設定です。通知処理をスキップします。");
    return;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // F列（ソース）とG列（通知済みフラグ）までを取得範囲に含める
  // 1列目(A)から7列目(G)まで
  const data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  const postedRows = []; // 通知完了フラグを更新するための配列

  data.forEach((row, index) => {
    // データのインデックス(0スタート): 0:日付, 1:タイトル, 2:リンク, 3:抜粋, 4:AI要約, 5:ソース, 6:通知済みフラグ
    const summary = row[4];
    const isPosted = row[6]; // G列

    // AI要約が完了（空欄でない）、かつ未通知（空欄または"NO"）のみ対象
    if (summary && summary.toString().trim() !== "" && summary.toString().includes('API Error') === false && (!isPosted || isPosted.toString().toUpperCase() !== 'YES')) {
      // 🌟 通知メッセージの作成
      const title = row[1].toString().trim();
      const url = row[2].toString().trim();
      const source = row[5].toString().trim();
      const pubDate = Utilities.formatDate(new Date(row[0]), Session.getScriptTimeZone(), "yyyy/MM/dd");

      const messageBody = `
📅 ${pubDate}
📰 **${title}**

**【AI要約/翻訳】**
${summary.toString().trim()}

🔗 記事を読む
🌐 ${source}
`.trim();

      // Teamsにメッセージを送信
      const success = sendToTeams(WEBHOOK_URL, title, messageBody, source);
      if (success) {
        // 通知が成功：G列を'YES'に
        postedRows.push(['YES']);
        Logger.log(`Teams通知完了: ${title.substring(0, 30)}...`);
      } else {
        // 失敗：'FAIL'で次回の再試行対象
        postedRows.push(['FAIL']);
      }
    } else {
      // 未処理または既に処理済みの行：現在のG列の値を維持
      postedRows.push([isPosted]);
    }
  });

  // 通知済みフラグ（G列）を一括でシートに書き込む
  if (postedRows.length > 0) {
    const flagRange = sheet.getRange(2, 7, postedRows.length, 1);
    flagRange.setValues(postedRows);
    Logger.log(`Teams通知フラグ（G列）を更新しました。`);
  }
}

/**
 * Teams Incoming Webhookを使用してメッセージを投稿する
 * @param {string} url - Webhook URL
 * @param {string} title - カードのタイトル
 * @param {string} text - カードの本文
 * @param {string} source - ソース名
 * @returns {boolean} 成功/失敗
 */
function sendToTeams(url, title, text, source) {
  // MessageCard（軽量なJSON構造）
  const payload = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    "themeColor": "0072C6",
    "summary": `${source}からの新着記事`,
    "sections": [{
      "activityTitle": title,
      "text": text
    }]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    if (code === 200) {
      return true;
    } else {
      Logger.log(`Teams送信エラー: レスポンスコード ${code}, メッセージ: ${response.getContentText()}`);
      return false;
    }
  } catch (e) {
    Logger.log("Teams送信失敗（例外）: " + e.toString());
    return false;
  }
}
