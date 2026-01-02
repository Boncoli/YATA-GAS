/**
 * @file YATA.js - AI-Driven News Intelligence Platform
 * @version 3.2.0
 * @date 2026-01-02
 * @description YATA (The Three-Legged Guide to the Web)
 *              RSS収集 → AI見出し生成 → パーソナライズド配信・トレンド分析・予兆検知
 *
 * =============================================================================
 * 【目次 / Table of Contents】
 * =============================================================================
 * 1. CONFIGURATION (AppConfig)  - システム全体の定数・設定管理
 * 2. ENTRY POINTS (Triggers)    - トリガーから実行されるメインジョブ
 * 3. WEB UI (doGet)             - 検索画面（Index.html）の表示制御
 * 4. REPORT SERVICES            - パーソナライズ配信、トレンド分析の核
 * 5. COLLECTION SERVICES        - RSS収集、シートメンテナンス
 * 6. AI/LLM SERVICE (LlmService) - 各種LLM APIとの通信・フォールバック
 * 7. UTILITIES                  - 日付、パース、URL正規化等の共通関数
 * 8. DEVELOPER TOOLS (Tests)    - ロジック検証用テストスイート
 * =============================================================================
 */

// AppConfig Singleton: Configuration cache and loader
/**
 * SECTION 1: CONFIGURATION
 * 【役割】スクリプトプロパティや固定設定を一括管理し、システム全体に提供する。
 * シングルトンパターンを採用し、実行ごとのプロパティ読み込み負荷を最小化。
 */
const AppConfig = (function() {
  let cache = null;
  function load() {
    if (cache) return cache;

    const props = PropertiesService.getScriptProperties();
    cache = {
      SheetNames: {
        RSS_LIST: "RSS",
        TREND_DATA: "collect",
        PROMPT_CONFIG: "prompt",
        USERS: "Users",
        DIGEST_HISTORY: "DigestHistory",
      },
      CollectSheet: {
        Columns: { URL: 3, ABSTRACT: 4, SUMMARY: 5, SOURCE: 6, VECTOR: 7 },
        DataRange: { START_ROW: 2, NUM_COLS_FOR_URL: 1 },
      },
      RssListSheet: {
        DataRange: { START_ROW: 2, START_COL: 1, NUM_COLS: 2 },
      },
      Llm: {
        MODEL_NAME: "gemini-2.5-flash-lite",
        DELAY_MS: 1100,
        MIN_SUMMARY_LENGTH: 100,
        NO_ABSTRACT_TEXT: "抜粋なし",
        MISSING_ABSTRACT_TEXT: "記事が短すぎるか、抜粋がないため見出し生成をスキップしました。",
        SHORT_JA_SKIP_TEXT: "記事が短く、日本語のため見出し生成をスキップしました。",
        // --- Dynamic settings from Script Properties ---
        Context: props.getProperty("EXECUTION_CONTEXT") || "COMPANY",
        ModelNano: props.getProperty("OPENAI_MODEL_NANO") || "gpt-4.1-nano",
        ModelMini: props.getProperty("OPENAI_MODEL_MINI") || "gpt-4.1-mini",
        AzureUrlNano: props.getProperty("AZURE_ENDPOINT_URL_NANO") || null,
        AzureUrlMini: props.getProperty("AZURE_ENDPOINT_URL_MINI") || null,
        AzureKey: props.getProperty("OPENAI_API_KEY") || null,
        OpenAiKey: props.getProperty("OPENAI_API_KEY_PERSONAL") || null,
        GeminiKey: props.getProperty("GEMINI_API_KEY") || null,
        // ★【追加】LLMパラメータ・翻訳設定
        Params: {
          Temperature: { DEFAULT: 0.2, CREATIVE: 0.3 },
          MaxTokens: 4096
        },
        Translation: {
          Source: "auto",
          Target: "ja"
        },
        // ★【追加】Embedding設定
        Embedding: {
          AzureEndpoint: props.getProperty("AZURE_EMBEDDING_ENDPOINT"), // Azure用エンドポイントURL
          OpenAiModel: props.getProperty("OPENAI_EMBEDDING_MODEL") || "text-embedding-3-small" // OpenAI用モデル名
        }
      },
      Digest: {
        days: parseInt(props.getProperty("DIGEST_DAYS") || "7", 10),
        topN: parseInt(props.getProperty("DIGEST_TOP_N") || "20", 10),
        notifyChannel: (props.getProperty("NOTIFY_CHANNEL_WEEKLY") || "email").toLowerCase(),
        mailTo: props.getProperty("MAIL_TO"),
        mailSubjectPrefix: props.getProperty("MAIL_SUBJECT_PREFIX"), // デフォルトはnull/undefined
        mailSenderName: props.getProperty("MAIL_SENDER_NAME") || "YATA (AI Intelligence Bot)",
        sheetUrl: props.getProperty("DIGEST_SHEET_URL") || "(DIGEST_SHEET_URL 未設定)",
      },
      // ★【追加】システム全体の設定値
      System: {
        TimeLimit: {
          SUMMARIZATION: 5 * 60 * 1000,      // 要約/ベクトル生成の制限時間 (5分)
          REPORT_GENERATION: 280 * 1000      // レポート生成の制限時間 (GAS制限考慮)
        },
        Limits: {
          RSS_CHECK_ROWS: 3000,              // 重複チェック時に遡る行数
          RSS_DATE_WINDOW_DAYS: 7,           // RSS記事の有効期限 (これより古い記事は取り込まない)
          RSS_CHUNK_SIZE: 12,                // RSS並列収集のチャンクサイズ
          RSS_INTER_CHUNK_DELAY: 1200,       // チャンク間の待機時間 (ms)
          DATA_RETENTION_MONTHS: 6,          // データの保持期間
          BATCH_SIZE: 30,                    // LLM一括処理時のバッチサイズ
          BATCH_FETCH_DAYS: 8,               // レポート生成時の一括取得日数
          LINKS_PER_TREND: 3,                // トレンドレポートに表示するリンク数
          BACKFILL_DELAY: 500                // バックフィル時の待機時間 (ms)
        },
        // ★【追加】標準HTTPヘッダー
        HttpHeaders: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://www.google.com/',
          'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        },
        DateWindows: {
          DAILY_REPORT: 2,       // 日刊レポート(sendPersonalizedReport)の対象期間
          WEEKLY_REPORT: 7,      // 週刊レポートの対象期間
          DAILY_DIGEST_JOB: 1    // dailyDigestJobの対象期間
        },
        SearchScore: {           // 記事の重要度判定ロジック用
          KEYWORD_MAX: 40,       // キーワード一致スコアの最大値
          KEYWORD_WEIGHT: 8,     // キーワード1つあたりの加点
          FRESHNESS_MAX: 40,     // 鮮度スコアの最大値
          FRESHNESS_DECAY: 7,    // 鮮度が減衰する日数定数 (exp(-days/7))
          ABSTRACT_BONUS: 20,    // 抜粋ありの場合の最大ボーナス点
          ABSTRACT_DIVISOR: 100  // 抜粋の文字数を割る数
        },
        // ★【追加】予兆（サイン）検知エンジンの設定
        SignalDetection: {
          LOOKBACK_DAYS_MAINSTREAM: 7, // 主流（重心）計算の対象期間
          LOOKBACK_DAYS_SIGNALS: 3,    // 予兆検知の対象期間（直近）
          OUTLIER_THRESHOLD: 0.70,     // これ以下の類似度なら「主流から外れている」と判定
          NUCLEATION_RADIUS: 0.88,     // これ以上の類似度なら「核形成（近い概念）」と判定
          MIN_NUCLEI_SOURCES: 2,       // 核を形成するのに必要な最低ソース数
          MAX_OUTLIERS_TO_PROCESS: 50  // 演算負荷軽減のため一度に処理するアウトライヤー上限
        }
      },
      // ★【追加】UIデザイン・メッセージ設定
      UI: {
        WebDefaults: {
            SEARCH_DAYS: 30   // Web検索時のデフォルト遡り期間
        },
        Colors: {
          PRIMARY: "#3498db",   // メインカラー(青)
          SECONDARY: "#2c3e50", // サブカラー(濃紺)
          ACCENT: "#e74c3c",    // アクセント(赤)
          TEXT_MAIN: "#333333",
          TEXT_SUB: "#555555",
          BG_BODY: "#f0f2f5",
          BG_CARD: "#ffffff",
          BORDER: "#e1e4e8",
          LINK: "#0066cc",
          // バッジ用
          BADGE_NEW_BG: "#e3f2fd", BADGE_NEW_TXT: "#1565c0",
          BADGE_UP_BG: "#e8f5e9",  BADGE_UP_TXT: "#2e7d32",
          BADGE_WARN_BG: "#fff3e0", BADGE_WARN_TXT: "#ef6c00",
          BADGE_KEEP_BG: "#f5f5f5", BADGE_KEEP_TXT: "#616161"
        }
      },
      Messages: {
        REPORT_HEADER_PREFIX: "集計期間：",
        NO_RESULT: "該当記事なし",
        NO_SUMMARY: "見出しが生成できませんでした。",
        LINK_MORE_MD: "その他の記事一覧は[こちらのスプレッドシート](${url})でご覧いただけます。"
      },
      // ★【追加】各シートの列定義とロジック定数
      UsersSheet: {
        Columns: { NAME: 1, EMAIL: 2, DAY: 3, KWS: 4, SEMANTIC: 5 }
      },
      KeywordsSheet: {
        Columns: { QUERY: 1, FLAG: 2, DAY: 3, LABEL: 4 }
      },
      RssListSheet: {
        DataRange: { START_ROW: 2, START_COL: 1, NUM_COLS: 2 },
        Columns: { NAME: 1, URL: 2 }
      },
      Logic: {
        TRUE_MARKERS: ["TRUE", "〇"],
        TAGS: {
          NEW: /\[新規\/?注目\]|\[新規\]/g,
          UP: /\[進展\]/g,
          WARN: /\[懸念\]/g,
          KEEP: /\[継続\]/g
        }
      }
    };
    return cache;
  }
  return { get: load };
})();

/* =============================================================================
 * SECTION 2: ENTRY POINTS (Triggers)
 * 【役割】Google Apps Scriptのトリガーから直接呼び出される関数。
 * システムの主要なワークフロー（収集、要約、ダイジェスト）を制御する。
 * =============================================================================
 */

/**
 * トリガーA: 収集専用 (Collection Job)
 * 頻度の目安: 1〜4時間ごと
 * 役割: RSSを巡回してシートに追記し、並び替えまで行います。AI要約はしません。
 */
function runCollectionJob() {
  Logger.log("--- 収集ジョブ開始 ---");
  collectRssFeeds();       // RSS巡回
  sortCollectByDateDesc(); // 日付順に並び替え
  Logger.log("--- 収集ジョブ完了 ---");
}

/**
 * トリガーB: AI要約専用 (Summarization Job)
 * 頻度の目安: 4〜6時間ごと
 * 役割: シートを見て「見出しがない記事」を見つけ、AIで生成します。
 */
function runSummarizationJob() {
  Logger.log("--- 要約ジョブ開始 ---");
  processSummarization();  // 未処理記事のAI要約
  Logger.log("--- 要約ジョブ完了 ---");
}

/**
 * トリガーC: 予兆（サイン）検知ジョブ (Emerging Signal Detection)
 * 頻度の目安: 1日1回（要約ジョブの完了後が望ましい）
 * 役割: 既存のトレンドから乖離した「核形成」を検知し、インテリジェンス・レポートを生成・送信します。
 */
function runEmergingSignalJob() {
  Logger.log("--- 予兆（サイン）検知ジョブ開始 ---");
  try {
    const report = EmergingSignalEngine.detect();
    if (report && report.html) {
      const config = AppConfig.get().Digest;
      const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd");
      const subject = `【YATA】Emerging Signals Report (${today})`;
      
      sendDigestEmail(null, report.html, null, 1, {
        isHtml: true,
        subjectOverride: subject,
        recipient: config.mailTo,
        // bcc: config.mailTo
      });
      Logger.log("予兆レポートの送信を完了しました。");
    } else {
      Logger.log("今回の実行では新たな「核形成（予兆）」は検知されませんでした。");
    }
  } catch (e) {
    _logError("runEmergingSignalJob", e, "予兆検知ジョブ中に致命的なエラーが発生しました。");
  }
  Logger.log("--- 予兆（サイン）検知ジョブ完了 ---");
}

/** dailyDigestJob: 日刊ダイジェスト生成 - 過去24時間の全記事（キーワードフィルタリングなし） */
/**
function dailyDigestJob() {
  Logger.log("--- 日刊ダイジェスト生成開始 (全記事対象) ---");
  
  // 期間設定: 1日 (24時間)
  const DAYS_WINDOW = AppConfig.get().System.DateWindows.DAILY_DIGEST_JOB; 

  // 設定と期間の取得
  const config = AppConfig.get().Digest; 
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
*/

/* =============================================================================
 * SECTION 3: WEB UI (Client Interface)
 * 【役割】Webブラウザからアクセスされた際の画面（Index.html）表示を制御する。
 * =============================================================================
 */

/**
 * doGet
 * ウェブアプリケーションの起点。Index.htmlを表示する。
 */
function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setSandboxMode(HtmlService.SandboxMode.IFRAME)
    .setTitle('YATA - AI Intelligence Platform');
}

/* =============================================================================
 * SECTION 4: REPORT SERVICES (Analysis & Dispatch)
 * 【役割】ユーザーへのパーソナライズ配信や、指定キーワードのトレンド分析など、
 * 蓄積されたデータから「価値あるレポート」を生成する中核機能。
 * =============================================================================
 */

/**
 * computeHeuristicScore
 * 【責務】記事のスコア計算（キーワード数 + 新鮮度 + 抜粋長）
 * 【用途】rankAndSelectArticles() で上位N件選抜に使用
 * @param {Object} article - 記事オブジェクト
 * @param {Map} articleKeywordMap - URL→キーワード配列
 * @returns {number} スコア（0-100）
 */
function computeHeuristicScore(article, articleKeywordMap) {
  const scores = AppConfig.get().System.SearchScore;
  const now = new Date();
  const daysOld = Math.max(0, Math.floor((now - article.date) / (1000 * 60 * 60 * 24)));
  const matchedKeywords = articleKeywordMap.get(article.url) || [];
  const keywordScore = Math.min(scores.KEYWORD_MAX, matchedKeywords.length * scores.KEYWORD_WEIGHT);
  const freshnessScore = scores.FRESHNESS_MAX * Math.exp(-daysOld / scores.FRESHNESS_DECAY);
  const hasAbstract = article.abstractText && article.abstractText !== AppConfig.get().Llm.NO_ABSTRACT_TEXT;
  const abstractBonus = hasAbstract ? Math.min(scores.ABSTRACT_BONUS, String(article.abstractText).length / scores.ABSTRACT_DIVISOR) : 0;
  const rawScore = keywordScore + freshnessScore + abstractBonus;
  return Math.max(0, Math.min(100, Math.round(rawScore)));
}

/** runTrendAnalysis: 単発トレンド分析実行 (Web/Manual共通)
 * 【役割】指定されたキーワードに基づき、過去の記事からトレンド分析レポートを生成する。
 * @param {string} targetKeyword - 分析対象キーワード (必須)
 * @param {Object} options - オプション
 * @param {number} [options.days] - 遡り日数 (デフォルトはConfig参照)
 * @param {boolean} [options.returnHtml] - trueの場合、HTML文字列を返す (Web UI用)
 * @param {string} [options.startDate] - 検索開始日 (yyyy-mm-dd)
 * @param {string} [options.endDate] - 検索終了日 (yyyy-mm-dd)
 * @returns {string|void} 生成されたHTML(returnHtml=true時) または void (メール送信)
 */
function runTrendAnalysis(targetKeyword, options = {}) {
  const config = AppConfig.get().Digest;
  const returnHtml = options.returnHtml || false;
  
  // 期間設定: 明示的な日付指定があれば優先、なければ daysWindow、それもなければデフォルト
  let start, end;
  if (options.startDate && options.endDate) {
    start = new Date(options.startDate);
    // endDateは「その日の終わり」まで含めるため 23:59:59 に設定
    end = new Date(options.endDate);
    end.setHours(23, 59, 59, 999);
    start.setHours(0, 0, 0, 0);
  } else {
    // 従来の相対日数指定
    const daysWindow = options.days || config.days;
    const window = getDateWindow(daysWindow);
    start = window.start;
    end = window.end;
  }
  
  const allArticles = getArticlesInDateWindow(start, end);
  
  // 表示用の期間文字列
  const dateRangeStr = `${fmtDate(start)} 〜 ${fmtDate(end)}`;

  if (allArticles.length === 0) {
    Logger.log("トレンド分析：対象期間に記事がありませんでした。");
    const noResultMsg = `<div>該当記事なし (期間: ${dateRangeStr})</div>`;
    return returnHtml ? noResultMsg : null;
  }

  // 分析対象の構築
  const keywordStr = String(targetKeyword || "").trim();
  if (!keywordStr) {
    Logger.log("エラー: キーワードが指定されていません。");
    return returnHtml ? "<div>エラー: キーワードが必要です</div>" : null;
  }
  
  const targetItems = [{ query: keywordStr, label: keywordStr }];
  
  // HTML生成時に期間を表示するための情報を渡す
  options.dateRangeStr = dateRangeStr;

  // ★共通エンジンでレポート生成
  const htmlContent = generateTrendReportHtml(allArticles, targetItems, start, end, options);

  if (returnHtml) return htmlContent || "<div>分析結果が得られませんでした。</div>";
  
  // メール送信 (Web以外からの呼び出し時)
  if (htmlContent && (config.notifyChannel === "email" || config.notifyChannel === "both")) {
    const headerLine = AppConfig.get().Messages.REPORT_HEADER_PREFIX + dateRangeStr;
    
    sendDigestEmail(headerLine, htmlContent, null, 7, {
      isHtml: true,
      subjectPrefix: config.mailSubjectPrefix || "【TrendAnalysis】"
    });
  }
}

/** executeWeeklyDigest: ウェブUI呼び出し - 指定キーワードのダイジェスト生成
 * 【役割】Web UIからのリクエストを受け取り、適切なオプションで分析を実行するラッパー。
 * @param {string} keyword - 検索キーワード
 * @param {Object} clientOptions - クライアントから渡された日付等のオプション
 * @returns {string} 分析結果のHTML文字列
 */
/** executeWeeklyDigest: ウェブUI呼び出し - 指定キーワードのダイジェスト生成 */
function executeWeeklyDigest(keyword, clientOptions = {}) {
  try {
    const trimmedKeyword = String(keyword || "").trim();
    Logger.log(`Web UIから入力されたキーワード: "${trimmedKeyword}"`);

    // runTrendAnalysis に委譲
    return runTrendAnalysis(trimmedKeyword, {
      days: AppConfig.get().UI.WebDefaults.SEARCH_DAYS,
      startDate: clientOptions.startDate,
      endDate: clientOptions.endDate,
      returnHtml: true,
      isHtmlOutput: true, 
      enableHistory: false, // Web検索では履歴を使わない
      
      // ★追加: クライアントからの指定があればそれを使う
      useSemantic: clientOptions.useSemantic, 
      
      promptKeys: {
        system: "WEB_ANALYSIS_SYSTEM", 
        user: "WEB_ANALYSIS_USER"
      }
    });
    
  } catch (e) {
    Logger.log(`エラーが発生しました: ${e.toString()}`);
    return `<h1>処理中にエラーが発生しました</h1><p>${e.toString()}</p>`;
  }
}

/**
 * SECTION: パーソナライズ配信 (AI分析レポート版)
 * 役割: ユーザーごとのキーワードに基づいて記事を抽出し、
 * 単なるリストではなく「LLMによる分析レポート」を生成して配信する。
 * トリガー: 毎日 朝8時（または設定されたスケジュール）
 */

/**
 * sendPersonalizedReport
 * 【責務】Usersシートを読み込み、ユーザーごとの購読条件に合わせてAIレポートを生成・送信する。
 */
/**
 * sendPersonalizedReport (セマンティック検索設定対応版)
 * UsersシートのE列(5列目)を見て、AI意味検索を使うかどうかをユーザーごとに切り替える
 */
/**
 * sendPersonalizedReport (日刊/週刊 自動切り替え版)
 * Usersシートの設定に基づき、対象期間(daysWindow)を動的に変更してレポートを送信する。
 * - 配信曜日が空欄(毎日)の場合: daysWindow = 2 (昨日〜今日)
 * - 配信曜日が指定されている場合: daysWindow = 7 (過去1週間)
 */
function sendPersonalizedReport() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = sheet.getSheetByName(AppConfig.get().SheetNames.USERS);
  const keywordsSheet = sheet.getSheetByName("Keywords");
  
  if (!usersSheet || !keywordsSheet) return;

  // 1. 日付・マスター設定取得
  const daysMap = ["日", "月", "火", "水", "木", "金", "土"];
  const today = new Date();
  const currentDayStr = daysMap[today.getDay()];
  
  const kwCols = AppConfig.get().KeywordsSheet.Columns;
  const trueMarkers = AppConfig.get().Logic.TRUE_MARKERS;
  const lastRowKw = keywordsSheet.getLastRow();
  const masterData = lastRowKw >= 2 ? keywordsSheet.getRange(2, 1, lastRowKw - 1, Object.keys(kwCols).length).getValues() : [];
  
  // 今日のデフォルト配信対象（総合版用）
  const todaysMasterItems = masterData.filter(row => {
    const flag = String(row[kwCols.FLAG - 1]).trim();
    const day  = String(row[kwCols.DAY - 1]).trim();
    return day === currentDayStr && trueMarkers.includes(flag.toUpperCase());
  }).map(row => ({ 
    query: String(row[kwCols.QUERY - 1]).trim(), 
    label: String(row[kwCols.LABEL - 1]).trim() || String(row[kwCols.QUERY - 1]).trim() 
  }));

  const todaysQueries = todaysMasterItems.map(item => item.query).filter(String);
  const todaysLabels  = todaysMasterItems.map(item => item.label);

  // ★【変更点1】ここで一括取得を実行（最大日数設定はConfig参照）
  Logger.log("ユーザーレポート生成: 記事データのバッチ取得を開始...");
  const MAX_LOOKBACK_DAYS = AppConfig.get().System.Limits.BATCH_FETCH_DAYS; 
  const allRecentArticles = fetchRecentArticlesBatch(MAX_LOOKBACK_DAYS);
  Logger.log(`バッチ取得完了: 直近 ${MAX_LOOKBACK_DAYS} 日間の記事数 = ${allRecentArticles.length} 件`);

  // 2. ユーザー取得
  const usrCols = AppConfig.get().UsersSheet.Columns;
  const lastRowUsr = usersSheet.getLastRow();
  const users = lastRowUsr >= 2 ? usersSheet.getRange(2, 1, lastRowUsr - 1, Object.keys(usrCols).length).getValues() : [];

  // 3. ユーザーごとのループ
  users.forEach(user => {
    const name = user[usrCols.NAME - 1];
    const email = user[usrCols.EMAIL - 1];
    const userDay = String(user[usrCols.DAY - 1]).trim();
    const userKeywordsRaw = String(user[usrCols.KWS - 1]).trim();
    
    // セマンティック検索フラグ
    const semanticFlag = String(user[usrCols.SEMANTIC - 1] || "").trim().toUpperCase();
    const useSemanticForUser = trueMarkers.includes(semanticFlag);

    if (!email) return;

    let targetQueries = [];
    let displayLabels = [];
    let isPersonalized = false;
    
    // ★追加: 期間設定用の変数 (デフォルトは週刊)
    let daysWindow = AppConfig.get().System.DateWindows.WEEKLY_REPORT;

    // --- 分岐ロジック ---
    if (userDay === "") {
      // ■ 日刊モード (毎日配信)
      // 対象期間: 昨日0:00 〜 今朝
      daysWindow = AppConfig.get().System.DateWindows.DAILY_REPORT; 
      
      if (userKeywordsRaw !== "") {
        // 個人設定キーワードあり
        targetQueries = userKeywordsRaw.split(',').map(k => k.trim());
        displayLabels = targetQueries;
        isPersonalized = true;
      } else {
        // キーワードなし → 今日の総合ニュース
        if (todaysQueries.length > 0) {
          targetQueries = todaysQueries;
          displayLabels = todaysLabels;
        } else {
          return; // 配信対象なし
        }
      }
    } else {
      // ■ 週刊モード (曜日指定あり)
      // 対象期間: 過去7日間
      daysWindow = 7;

      if (userDay === currentDayStr) {
        if (userKeywordsRaw !== "") {
          targetQueries = userKeywordsRaw.split(',').map(k => k.trim());
          displayLabels = targetQueries;
          isPersonalized = true;
        } else {
          return; // 週刊でキーワードなしは配信しない仕様
        }
      } else {
        return; // 指定曜日ではないのでスキップ
      }
    }

    // ★変更: daysWindow を使って期間を計算
    const { start, end } = getDateWindow(daysWindow);
    
    // ★【変更点2】getArticlesInDateWindow の代わりに、メモリ上の配列をフィルタリング
    // メモリから検索（高速）
    const targetArticles = allRecentArticles.filter(a => {
      return a.date >= start && a.date < end;
    });

    const targetItems = targetQueries.map((q, i) => ({ query: q, label: displayLabels[i] }));
    
    // レポート生成
    const reportHtml = generateTrendReportHtml(targetArticles, targetItems, start, end, {
      useSemantic: useSemanticForUser
    });

    if (!reportHtml) {
      Logger.log(`[Skip] ${name}様: 分析対象の記事なし (期間: ${daysWindow}日)`);
      return;
    }

    // 件名作成
    const labelSummary = displayLabels.slice(0, 3).join(', ') + (displayLabels.length > 3 ? '...' : '');
    const dateStr = Utilities.formatDate(today, Session.getScriptTimeZone(), 'MM/dd');
    let subjectPrefix = isPersonalized ? "【YATA】My AI Report: " : "【YATA】Daily Trend: ";
    
    if (useSemanticForUser) subjectPrefix += "[Semantic] ";

    const subject = `${subjectPrefix}${labelSummary} (${dateStr})`;
    
    try {
      // ★変更: 第4引数に daysWindow を渡す (これでメール件名の「日刊/週間」判定などが正しく機能する)
      sendDigestEmail(null, reportHtml, null, daysWindow, {
        recipient: email,
        isHtml: true,
        subjectOverride: subject,
        bcc: AppConfig.get().Digest.mailTo
      });
      Logger.log(`[Sent] ${name}様へAIレポート送信完了 (Semantic: ${useSemanticForUser}, Days: ${daysWindow})`);
    } catch (e) {
      _logError("sendPersonalizedReport.forEach", e, `${name}様への送信失敗`);
    }
  });
}

/** processSummarization: AI見出し生成（E列）＆ ベクトル生成（G列）
 * 【責務】シート内の「要約（見出し）」が空の記事を特定し、AI(LlmService)を使用して自動生成する。
 * さらに、生成された要約とタイトルを元にベクトル（Embedding）を生成し、G列に保存する。
 * 短い記事：タイトルまたはスプレッドシート数式(=GOOGLETRANSLATE)を使用。
 * 長い記事：LLM(ModelNano)を呼び出して要約を生成。
 * 【実行制限】GASの実行時間オーバーを避けるため、5分のタイムアウト制限を設けている。
 */
/** * processSummarization: AI見出し生成（E列）＆ ベクトル生成（G列）
 * 【改修版】短い記事（isShort）でもベクトルを生成するように修正。
 * また、変更範囲(min/maxModifiedIndex)の判定を全パターンで有効化。
 */
function processSummarization() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const trendDataSheet = ss.getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  if (!trendDataSheet) {
    Logger.log("エラー: collectシートが見つかりません。");
    return;
  }
  const lastRow = trendDataSheet.getLastRow();
  if (lastRow < 2) return;

  const startTime = new Date().getTime();
  const TIME_LIMIT_MS = AppConfig.get().System.TimeLimit.SUMMARIZATION;

  // ベクトル保存用の列インデックス (G列 = 6)
  const VECTOR_COL_INDEX = AppConfig.get().CollectSheet.Columns.VECTOR - 1; 

  // データ範囲を取得
  const maxCol = Math.max(trendDataSheet.getLastColumn(), VECTOR_COL_INDEX + 1);
  const dataRange = trendDataSheet.getRange(2, 1, lastRow - 1, maxCol);
  const values = dataRange.getValues();
  
  const articlesToSummarize = [];
  const summaryColIndex = AppConfig.get().CollectSheet.Columns.SUMMARY - 1; // E列 (4)

  let apiCallCount = 0;
  let vectorCount = 0;
  
  // ★変更: ループの前に移動（短い記事の更新も追跡するため）
  let minModifiedIndex = -1;
  let maxModifiedIndex = -1;

  // 1. 要約が必要な記事を特定 & 短い記事は即時処理
  values.forEach((row, index) => {
    const currentHeadline = row[summaryColIndex];
    const currentVector = row[VECTOR_COL_INDEX]; // 既存ベクトル確認

    // 「見出しが空」または「ベクトルが空（バックフィル的措置）」の場合に処理対象とする
    // ※今回は主に新規記事の見出し生成フローに合わせる
    if (!currentHeadline || String(currentHeadline).trim() === "") {
      const title = row[AppConfig.get().CollectSheet.Columns.URL - 2]; 
      const abstractText = row[AppConfig.get().CollectSheet.Columns.ABSTRACT - 1]; 
      
      const isShort = (abstractText === AppConfig.get().Llm.NO_ABSTRACT_TEXT) || (String(abstractText || "").length < AppConfig.get().Llm.MIN_SUMMARY_LENGTH);
      
      if (isShort) {
        // --- 短い記事の処理 ---
        let newHeadline = "";
        
        try {
          if (title && String(title).trim() !== "") {
            // LanguageApp.translate で翻訳済みのテキストを取得する (数式は使わない)
            if (isLikelyEnglish(String(title))) {
              newHeadline = LanguageApp.translate(String(title), AppConfig.get().Llm.Translation.Source, AppConfig.get().Llm.Translation.Target);
              Utilities.sleep(200); // APIレート制限への配慮
            } else {
              newHeadline = String(title).trim();
            }
          } else if (abstractText && abstractText !== AppConfig.get().Llm.NO_ABSTRACT_TEXT) {
            if (isLikelyEnglish(String(abstractText))) {
              newHeadline = LanguageApp.translate(String(abstractText), AppConfig.get().Llm.Translation.Source, AppConfig.get().Llm.Translation.Target);
              Utilities.sleep(200);
            } else {
              newHeadline = String(abstractText).trim();
            }
          } else {
            newHeadline = AppConfig.get().Llm.MISSING_ABSTRACT_TEXT;
          }
        } catch (e) {
          Logger.log(`翻訳APIエラー(Row ${index + 2}): ${e.message} - 原文を使用します`);
          newHeadline = String(title || abstractText || AppConfig.get().Llm.MISSING_ABSTRACT_TEXT).trim();
        }

        values[index][summaryColIndex] = newHeadline;

        // ★追加: 短い記事でもベクトルを生成する
        try {
          const textToEmbed = `Title: ${title}\nSummary: ${newHeadline}`;
          const vector = LlmService.generateVector(textToEmbed);
          if (vector) {
            // 列拡張
            while (values[index].length <= VECTOR_COL_INDEX) {
              values[index].push("");
            }
            values[index][VECTOR_COL_INDEX] = vector.join(',');
            vectorCount++;
          }
        } catch (e) {
          Logger.log(`ベクトル生成エラー(Short) (Row: ${sheetRowNumber}): ${e.toString()}`);
        }

        // 更新範囲を記録
        if (minModifiedIndex === -1 || index < minModifiedIndex) minModifiedIndex = index;
        if (index > maxModifiedIndex) maxModifiedIndex = index;

      } else {
        // --- 長い記事はAI要約リストへ ---
        articlesToSummarize.push({ originalRowIndex: index, title: title, abstractText: abstractText });
      }
    }
  });

  // 2. 長い記事のAI要約 & ベクトル生成の実行
  if (articlesToSummarize.length > 0) {
    Logger.log(`${articlesToSummarize.length} 件の記事に対してAIによる見出し生成を試行します。`);
    
    for (const article of articlesToSummarize) {
      // タイムアウトチェック
      if (new Date().getTime() - startTime > TIME_LIMIT_MS) {
        Logger.log(`タイムアウト回避のため、処理を中断しました（残り ${articlesToSummarize.length - apiCallCount} 件）。`);
        break; 
      }

      const articleText = `Title: ${article.title}\nAbstract: ${article.abstractText}`;
      const jsonString = LlmService.summarize(articleText);
      apiCallCount++;

      let newHeadline = null;
      const isSystemError = String(jsonString).includes("API Error") || String(jsonString).includes("いずれのLLMでも");

      if (jsonString && !isSystemError) {
        try {
          const parsedJson = cleanAndParseJSON(jsonString);
          if (parsedJson) {
             newHeadline = parsedJson.tldr || parsedJson.summary;
          }
          if (!newHeadline) newHeadline = String(jsonString).trim();
        } catch (e) {
          Logger.log(`JSONパース失敗 (Row: ${article.originalRowIndex + 2}): ${e.toString()}`);
          newHeadline = String(jsonString).trim();
        }
      } else {
        Logger.log(`見出し生成システムエラー (Row: ${article.originalRowIndex + 2}): ${jsonString}`);
      }

      if (newHeadline && String(newHeadline).trim() !== "" && !String(newHeadline).includes("API Error")) {
        values[article.originalRowIndex][summaryColIndex] = newHeadline;

        // ベクトル生成
        try {
          const textToEmbed = `Title: ${article.title}\nSummary: ${newHeadline}`;
          const vector = LlmService.generateVector(textToEmbed);
          
          if (vector) {
            while (values[article.originalRowIndex].length <= VECTOR_COL_INDEX) {
              values[article.originalRowIndex].push("");
            }
            values[article.originalRowIndex][VECTOR_COL_INDEX] = vector.join(',');
            vectorCount++;
          }
        } catch (e) {
          Logger.log(`ベクトル生成エラー (Row: ${article.originalRowIndex + 2}): ${e.toString()}`);
        }

        // 更新範囲を記録
        if (minModifiedIndex === -1 || article.originalRowIndex < minModifiedIndex) {
          minModifiedIndex = article.originalRowIndex;
        }
        if (article.originalRowIndex > maxModifiedIndex) {
          maxModifiedIndex = article.originalRowIndex;
        }

      } else {
        Logger.log(`スキップしました (Row: ${article.originalRowIndex + 2}): ${newHeadline}`);
      }
      
      Utilities.sleep(AppConfig.get().Llm.DELAY_MS);
    }
  }

  // 3. シートへの部分書き込み (最適化済み)
  if (minModifiedIndex !== -1 && maxModifiedIndex !== -1) {
    const startRow = minModifiedIndex + 2; 
    const numRows = maxModifiedIndex - minModifiedIndex + 1;
    
    const modifiedData = values.slice(minModifiedIndex, maxModifiedIndex + 1);

    // 列数正規化
    const maxColsInSlice = modifiedData.reduce((max, row) => Math.max(max, row.length), 0);
    const normalizedData = modifiedData.map(row => {
      while (row.length < maxColsInSlice) {
        row.push("");
      }
      return row;
    });

    const outputRange = trendDataSheet.getRange(startRow, 1, numRows, maxColsInSlice);
    outputRange.setValues(normalizedData);
    
    Logger.log(`処理完了: 要約生成(API) ${apiCallCount} 件 / ベクトル生成 ${vectorCount} 件。シートの一部(Row ${startRow}〜${startRow + numRows - 1})を更新しました。`);
  } else {
    Logger.log("更新対象の記事はありませんでした。");
  }
}

/** SECTION 2: 週刊ダイジェストプロセッサー - キーワード関連記事フィルタリング、記事選抜、LLM分析 */


/** _logKeywordHitCounts: キーワード別ヒット件数をログ出力 */
function _logKeywordHitCounts(hitKeywordsWithCount) {
  let hitLog = "【キーワード別ヒット件数】\n";
  hitKeywordsWithCount.forEach(item => {
    hitLog += `- ${item.keyword}: ${item.count}件\n`;
  });
  Logger.log(hitLog.trim());
}

/** _summarizeReport: 詳細レポートから要点サマリー（tl;dr）を生成 */
function _summarizeReport(reportText) {
  if (!reportText || reportText.trim() === "") return "";
  
  Logger.log("詳細レポートから要点サマリーの生成を開始します。");
  const model = AppConfig.get().Llm.ModelNano;
  
  const SYSTEM_PROMPT = getPromptConfig("DIGEST_SUMMARY_SYSTEM");
  if (!SYSTEM_PROMPT) {
      Logger.log("要点サマリーのプロンプト(DIGEST_SUMMARY_SYSTEM)が見つかりません。");
      return "";
  }
  
  const summary = LlmService.summarizeReport(SYSTEM_PROMPT, reportText);

  Logger.log(`要点サマリーを生成しました: ${summary}`);
  return summary;
}

/** _getLatestHistory: DigestHistoryシートからキーワードの最新要約を取得 */
function _getLatestHistory(keyword) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.DIGEST_HISTORY);
    if (!sheet) {
      Logger.log("DigestHistoryシートが見つかりません。履歴機能はスキップされます。");
      return null;
    }
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;

    const data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
    
    for (let i = data.length - 1; i >= 0; i--) {
      const historyKeyword = String(data[i][1]).trim();
      if (historyKeyword === keyword) {
        Logger.log(`履歴発見: キーワード「${keyword}」の前回要約を読み込みました。`);
        return String(data[i][2]);
      }
    }
    Logger.log(`履歴なし: キーワード「${keyword}」の前回要約は見つかりませんでした。`);
    return null;
  } catch (e) {
    _logError("_getLatestHistory", e, "ダイジェスト履歴の読み込み中にエラーが発生しました。");
    return null;
  }
}

/**
 * _writeHistory
 * 【責務】DigestHistoryシートに新しい要約を書き込む
 * @param {string} keyword - 保存するキーワード
 * @param {string} summary - 保存する要約テキスト
 */
function _writeHistory(keyword, summary) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.DIGEST_HISTORY);
    if (!sheet) {
      Logger.log("DigestHistoryシートが見つからないため、履歴を書き込めません。");
      return;
    }
    sheet.appendRow([new Date(), keyword, summary]);
    Logger.log(`履歴保存: キーワード「${keyword}」の要約をDigestHistoryシートに書き込みました。`);
  } catch (e) {
    _logError("_writeHistory", e, "ダイジェスト履歴の書き込み中にエラーが発生しました。");
  }
}

/** _generateAndSendDailyDigest: 日刊ダイジェスト生成・送信 - 全記事対象、バッチ処理対応 */
function _generateAndSendDailyDigest(allArticles, config, start, end, daysWindow) {
  const systemPromptTemplate = getPromptConfig("DAILY_DIGEST_SYSTEM");
  const userPromptTemplate = getPromptConfig("DAILY_DIGEST_USER");
  
  if (!systemPromptTemplate || !userPromptTemplate) {
    throw new Error("プロンプトシートにキー 'DAILY_DIGEST_SYSTEM' と 'DAILY_DIGEST_USER' の設定が必要です。");
  }

  let reportBody = "";
  const BATCH_SIZE = AppConfig.get().System.Limits.BATCH_SIZE; 

  if (allArticles.length <= BATCH_SIZE) {
    const articleListText = formatArticlesForLlm(allArticles);
    let userPrompt = userPromptTemplate.replace(/\$\{all_articles_in_date_window\}/g, articleListText);
    userPrompt = userPrompt.replace(/\$\{linksPerTopic\}/g, "3"); 
    
    reportBody = LlmService.generateDailyDigest(systemPromptTemplate, userPrompt);
  } 
  else {
    Logger.log(`記事数が多いため(${allArticles.length}件)、分割処理を実行します。`);
    
    const batchSummaries = [];
    for (let i = 0; i < allArticles.length; i += BATCH_SIZE) {
      const batch = allArticles.slice(i, i + BATCH_SIZE);
      const articleListText = formatArticlesForLlm(batch);
      
      const batchPrompt = `
以下の記事リストから、主要なトピックを3〜5個抽出し、箇条書きで要約してください。
【重要】後で統合するため、各トピックの末尾には、その根拠となった記事の「タイトル」と「URL」を必ず記載してください。

出力形式:
- トピック概要...
  - 根拠記事: [記事タイトル](URL)

【記事リスト】
${articleListText}
`;
      const batchResult = LlmService.generateDailyDigest(systemPromptTemplate, batchPrompt); 
      batchSummaries.push(batchResult);
      Utilities.sleep(1000); 
    }

    const finalPrompt = `
以下は、今日の大量のニュース記事をいくつかのブロックに分けて要約したものです（根拠記事のリンク付き）。
これらを統合し、重複を整理して、今日全体の「日刊ダイジェスト」を作成してください。

【重要指示】
1. 全体の流れがわかるように構成し、重要なトピックについては深掘りして解説してください。
2. 各トピックの最後には、必ず「関連記事リスト」として、中間要約に含まれていた記事リンク（[タイトル](URL)）を3つ程度記載してください。**URLを省略しないでください。**
3. 出力は以下のMarkdown形式で行ってください。

### **トピック名称**
解説文...
**関連記事:**
- [記事タイトル](URL)
- [記事タイトル](URL)

【中間要約リスト】
${batchSummaries.join("\n\n---\n\n")}
`;
    reportBody = LlmService.generateDailyDigest(systemPromptTemplate, finalPrompt);
  }

    const headerLine = AppConfig.get().Messages.REPORT_HEADER_PREFIX + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1));
    
    sendDigestEmail(headerLine, reportBody, null, daysWindow);
  }

/** formatArticlesForLlm: 記事リストを整形（AI見出し優先 > 抜粋 > タイトル） */
function formatArticlesForLlm(articles) {
  return articles.map(a => {
    const content = a.headline && a.headline.length > 10 ? a.headline : (a.abstractText || a.title);
    return `・タイトル: ${a.title}\n  内容: ${content}\n  URL: ${a.url}`;
  }).join('\n\n');
}

/** _handleNoArticlesFound: 対象記事なしの場合の通知処理（メール送信） */
function _handleNoArticlesFound(config, start, end, message, daysWindow = 7) { 
  Logger.log(`ダイジェスト：${message}`);

  const headerLine = AppConfig.get().Messages.REPORT_HEADER_PREFIX + fmtDate(start) + "〜" + fmtDate(new Date(end.getTime() - 1));
  
  const reportBody = daysWindow === 1 ? "本日のダイジェスト対象となる記事はありませんでした。" : "今週のダイジェスト対象となる記事はありませんでした。";
  
  if (config.notifyChannel === "email" || config.notifyChannel === "both") {
    sendDigestEmail(headerLine, reportBody, null, daysWindow);
  }
}

/** rankAndSelectArticles: ヒューリスティックスコアで記事をランク付け、キーワード毎に上位N件を配分 */
function rankAndSelectArticles(relevantArticles, config, articleKeywordMap, hitKeywordsWithCount) {
  
  const LIMIT_PER_KEYWORD = config.topN || 20;
  
  const selectedArticlesMap = new Map(); 

  const scoredArticles = relevantArticles.map(a => ({
    ...a,
    heuristicScore: computeHeuristicScore(a, articleKeywordMap)
  }));

  const keywords = hitKeywordsWithCount || [];
  
  keywords.forEach(kwItem => {
    const keyword = kwItem.keyword;

    const articlesForThisKeyword = scoredArticles.filter(a => {
      const kws = articleKeywordMap.get(a.url);
      return kws && kws.includes(keyword);
    });

    articlesForThisKeyword.sort((a, b) => b.heuristicScore - a.heuristicScore);

    const candidates = articlesForThisKeyword.slice(0, LIMIT_PER_KEYWORD);

    candidates.forEach(a => {
      if (!selectedArticlesMap.has(a.url)) {
        selectedArticlesMap.set(a.url, a);
      }
    });
  });

  const selectedArticles = Array.from(selectedArticlesMap.values());

  return { selectedTopN: selectedArticles };
}


/** calculateLevenshteinSimilarity: 文字列類似度を計算（0.0～1.0）レーベンシュタイン距離ベース */
function calculateLevenshteinSimilarity(s1, s2) {
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  const longerLength = longer.length;
  if (longerLength === 0) return 1.0;
  
  const costs = new Array();
  for (let i = 0; i <= longer.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= shorter.length; j++) {
      if (i == 0) costs[j] = j;
      else {
        if (j > 0) {
          let newValue = costs[j - 1];
          if (longer.charAt(i - 1) != shorter.charAt(j - 1)) newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
    }
    if (i > 0) costs[shorter.length] = lastValue;
  }
  
  return (longerLength - costs[shorter.length]) / longerLength;
}

/** * generateWeeklyReportWithLLM (オプション対応) 
 */
function generateWeeklyReportWithLLM(articles, hitKeywordsWithCount, articlesGroupedByKeyword, previousSummary = null, options = {}) {
  const LINKS_PER_TREND = AppConfig.get().System.Limits.LINKS_PER_TREND;
  const hitKeywords = hitKeywordsWithCount.map(item => item.keyword);
  const trends = LlmService.generateTrendSections(articlesGroupedByKeyword, LINKS_PER_TREND, hitKeywords, previousSummary, options);
  return { reportBody: trends };
}

/** getArticlesInDateWindow: 指定期間内の記事を collectSheet から抽出
 * フィルタ：日付範囲内、見出し存在・空でない・エラーでない
 */
function getArticlesInDateWindow(start, end) {
  const sh = SpreadsheetApp.getActive().getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const vals = sh.getRange(2, 1, lastRow - 1, AppConfig.get().CollectSheet.Columns.SOURCE).getValues();
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
 * sendDigestEmail
 * 【責務】ダイジェストメール送信（日刊・週刊・個別対応 汎用版）
 * 【仕様】
 *   - Markdown→HTML変換してリッチメール送信（options.isHtml=trueならスキップ）
 *   - プレフィックスを daysWindow で自動切り替え（「日刊RSS」 or 「週間RSS」）
 *   - 件名にキーワードを自動挿入
 *   - 個別送信（options.recipient）対応
 * 
 * @param {string} headerLine - ヘッダー（期間表示）。nullの場合はヘッダーなし。
 * @param {string} bodyContent - 本文（Markdown または HTML）
 * @param {Array|null} subjectKeywords - 件名に含めるキーワード配列 { keyword, count }（null可）
 * @param {number} daysWindow - 1=日刊, 7=週刊（メール件名用）
 * @param {Object} options - オプション設定
 * @param {string} [options.recipient] - 宛先アドレス（指定がなければ一斉送信）
 * @param {boolean} [options.isHtml] - trueの場合、bodyContentをHTMLとして扱う（Markdown変換しない）
 * @param {string} [options.subjectOverride] - 件名を完全に上書きする文字列
 * @param {string} [options.subjectPrefix] - 件名プレフィックスを上書きする文字列
 * @param {string} [options.bcc] - BCCアドレス
 * @returns {none}
 */
function sendDigestEmail(headerLine, bodyContent, subjectKeywords, daysWindow = 7, options = {}) {
  const digestConfig = AppConfig.get().Digest;
  
  const to = options.recipient || getRecipients();
  
  if (!to) { 
    Logger.log("配信先(recipient または Usersシート)が設定されていないためメール送信しません。"); 
    return; 
  } 
  
  let finalSubject;
  if (options.subjectOverride) {
    finalSubject = options.subjectOverride;
  } else {
    const prefixBase = daysWindow === 1 ? "日刊" : "週間";
    const subjectPrefix = options.subjectPrefix || digestConfig.mailSubjectPrefix || `【${prefixBase}TrendNEWS】`;
    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd");

    let keywordSubjectPart = "";
    if (subjectKeywords && subjectKeywords.length > 0) {
      const kwList = subjectKeywords.map(item => item.label || item.keyword).join(", ");
      keywordSubjectPart = ` [${kwList}]`;
    }
    
    finalSubject = subjectPrefix + keywordSubjectPart + " " + today;
  }
  
  const senderName = digestConfig.mailSenderName;
  const sheetUrl = digestConfig.sheetUrl;

  const footerMd = AppConfig.get().Messages.LINK_MORE_MD.replace("${url}", sheetUrl);
  let fullHtmlBody;
  
  if (options.isHtml) {
    const htmlHeader = headerLine ? headerLine.replace(/\n/g, '<br>') + "<br><br>" : "";
    const footerHtml = markdownToHtml(`\n---\n${footerMd}`);
    fullHtmlBody = `<div style="font-family: Meiryo, 'Hiragino Sans', 'MS PGothic', sans-serif; font-size: 14px; line-height: 1.7; color: #333;">${htmlHeader}${bodyContent}<br><br>${footerHtml}</div>`;
  } else {
    const fullMdBodyWithFooter = bodyContent + `\n\n---\n${footerMd}`;
    const htmlHeader = headerLine ? headerLine.replace(/\n/g, '<br>') : "";
    const htmlContent = markdownToHtml(fullMdBodyWithFooter);
    fullHtmlBody = `<div style="font-family: Meiryo, 'Hiragino Sans', 'MS PGothic', sans-serif; font-size: 14px; line-height: 1.7; color: #333;">${htmlHeader}<br><br>${htmlContent}</div>`;
  }
  
  const plainBody = options.isHtml ? stripHtml(fullHtmlBody) : (headerLine + "\n\n" + bodyContent);

  const advancedArgs = { 
    name: senderName, 
    htmlBody: fullHtmlBody 
  };
  
  if (options.bcc) {
    advancedArgs.bcc = options.bcc;
  }
  
  GmailApp.sendEmail(to, finalSubject, plainBody, advancedArgs);
  Logger.log(`メール送信完了: To:${to} / Subject:${finalSubject}`);
}


/* =============================================================================
 * SECTION 6: AI/LLM SERVICE (LlmService)
 * 【役割】複数のLLM（Azure, OpenAI, Gemini）との通信を抽象化するレイヤー。
 * 自動的なフォールバック（障害時の代替切り替え）と、共通のエラー処理を提供。
 * =============================================================================
 */
const LlmService = (function() {
  const llmConfig = AppConfig.get().Llm;

  // --- Private Methods ---

  /**
   * _httpFetch
   * 通信・エラーハンドリング・JSONパースを共通化するヘルパー
   */
  function _httpFetch(url, options, serviceName) {
    try {
      const res = UrlFetchApp.fetch(url, options);
      const code = res.getResponseCode();
      const txt = res.getContentText();
      
      if (code !== 200) {
        _logError(serviceName, new Error(`API Error: ${code} - ${txt}`), `${serviceName} APIエラーが発生しました。`);
        return null;
      }
      return cleanAndParseJSON(txt);
    } catch (e) {
      _logError(serviceName, e, `${serviceName} 通信中に例外が発生しました。`);
      return null;
    }
  }

  function _callAzureLlm(systemPrompt, userPrompt, azureUrl, azureKey, options = {}) {
    Logger.log("Azure OpenAIを試行中...");
    const params = AppConfig.get().Llm.Params;
    const payload = { 
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], 
      temperature: options.temperature ?? params.Temperature.DEFAULT, 
      max_completion_tokens: params.MaxTokens 
    };
    const fetchOptions = { method: "post", contentType: "application/json", headers: { "api-key": azureKey }, payload: JSON.stringify(payload), muteHttpExceptions: true };
    
    const json = _httpFetch(azureUrl, fetchOptions, "Azure OpenAI");
    if (json && json.choices && json.choices.length > 0 && json.choices[0].message && json.choices[0].message.content) {
      return String(json.choices[0].message.content).trim();
    }
    return null;
  }

  function _callOpenAiLlm(systemPrompt, userPrompt, openAiModel, openAiKey, options = {}) {
    Logger.log("OpenAI APIを試行中...");
    const params = AppConfig.get().Llm.Params;
    const payload = { 
      model: openAiModel, 
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], 
      max_tokens: params.MaxTokens, 
      temperature: options.temperature ?? undefined 
    };
    const fetchOptions = { method: "post", contentType: "application/json", headers: { "Authorization": `Bearer ${openAiKey}` }, payload: JSON.stringify(payload), muteHttpExceptions: true };
    
    const json = _httpFetch("https://api.openai.com/v1/chat/completions", fetchOptions, "OpenAI");
    if (json && json.choices && json.choices.length > 0 && json.choices[0].message && json.choices[0].message.content) {
      const content = String(json.choices[0].message.content).trim();
      return content !== "" ? content : null;
    }
    return null;
  }
  
  // ★【追加】Azure Embedding API 呼び出し
  function _callAzureEmbedding(text, endpoint, apiKey) {
    if (!endpoint || !apiKey) return null;
    Logger.log("Azure Embedding APIを試行中...");
    const payload = { input: text };
    const fetchOptions = {
      method: "post",
      contentType: "application/json",
      headers: { "api-key": apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    
    const json = _httpFetch(endpoint, fetchOptions, "Azure Embedding");
    if (json && json.data && json.data.length > 0 && json.data[0].embedding) {
      return json.data[0].embedding;
    }
    return null;
  }

  // ★【追加】OpenAI Embedding API 呼び出し
  function _callOpenAiEmbedding(text, model, apiKey) {
    if (!apiKey) return null;
    Logger.log("OpenAI Embedding APIを試行中...");
    const payload = { model: model, input: text };
    const fetchOptions = {
      method: "post",
      contentType: "application/json",
      headers: { "Authorization": `Bearer ${apiKey}` },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };
    
    const json = _httpFetch("https://api.openai.com/v1/embeddings", fetchOptions, "OpenAI Embedding");
    if (json && json.data && json.data.length > 0 && json.data[0].embedding) {
      return json.data[0].embedding;
    }
    return null;
  }

  function _callGeminiLlm(systemPrompt, userPrompt, geminiApiKey, options = {}) {
    Logger.log("Gemini APIを試行中...");
    const params = AppConfig.get().Llm.Params;
    const API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/" + llmConfig.MODEL_NAME + ":generateContent?key=" + geminiApiKey;
    const PROMPT = (systemPrompt || "") + "\n\n" + (userPrompt || "");
    const payload = { 
      contents: [{ parts: [{ text: PROMPT }] }], 
      generationConfig: { 
        temperature: options.temperature ?? params.Temperature.DEFAULT, 
        maxOutputTokens: params.MaxTokens 
      } 
    };
    const fetchOptions = { method: "post", contentType: "application/json", payload: JSON.stringify(payload), muteHttpExceptions: true };
    
    const json = _httpFetch(API_ENDPOINT, fetchOptions, "Gemini");
    let text = null;
    if (json && json.candidates && json.candidates.length > 0 && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts.length > 0) {
      text = json.candidates[0].content.parts[0].text;
    }
    const headline = text ? String(text).trim() : (json && json.error ? ("API Error: " + json.error.message) : AppConfig.get().Messages.NO_SUMMARY);
    Utilities.sleep(llmConfig.DELAY_MS);
    return headline;
  }

  function _callLlmWithFallback(systemPrompt, userPrompt, openAiModel, azureUrlOverride = null, options = {}) {
    const llmProps = llmConfig; // AppConfigから取得済みの設定を利用
    let model = openAiModel;
    if (openAiModel === "nano" || openAiModel === "mini") {
      model = openAiModel === "mini" ? llmProps.ModelMini : llmProps.ModelNano;
    }
    const azureUrl = azureUrlOverride || (model && model.includes("mini") ? llmProps.AzureUrlMini : llmProps.AzureUrlNano);
    const context = llmProps.Context;
    let result = null;

    if (context === 'PERSONAL') {
      if (llmProps.OpenAiKey) {
        result = _callOpenAiLlm(systemPrompt, userPrompt, model, llmProps.OpenAiKey, options);
        if (result !== null) return result;
        Logger.log("OpenAI API(個人)での呼び出しに失敗しました。Azure OpenAIを試行します。");
      }
      if (azureUrl && llmProps.AzureKey) {
        result = _callAzureLlm(systemPrompt, userPrompt, azureUrl, llmProps.AzureKey, options);
        if (result !== null) return result;
        Logger.log("Azure OpenAIでの呼び出しに失敗しました。Gemini APIを試行します。");
      }
    } else {
      if (azureUrl && llmProps.AzureKey) {
        result = _callAzureLlm(systemPrompt, userPrompt, azureUrl, llmProps.AzureKey, options);
        if (result !== null) return result;
        Logger.log("Azure OpenAIでの呼び出しに失敗しました。OpenAI API(個人)を試行します。");
      }
      if (llmProps.OpenAiKey) {
        result = _callOpenAiLlm(systemPrompt, userPrompt, model, llmProps.OpenAiKey, options);
        if (result !== null) return result;
        Logger.log("OpenAI API(個人)での呼び出しに失敗しました。Gemini APIを試行します。");
      }
    }

    if (llmProps.GeminiKey) {
      result = _callGeminiLlm(systemPrompt, userPrompt, llmProps.GeminiKey, options);
      if (result !== null) return result;
      Logger.log("Gemini APIでの呼び出しに失敗しました。");
    }
    return "いずれのLLMでも見出しを生成できませんでした。";
  }

  // --- Public Methods ---
  return {
    summarize: function(articleText) {
      const model = llmConfig.ModelNano;
      const SYSTEM = getPromptConfig("BATCH_SYSTEM");
      const USER_TEMPLATE = getPromptConfig("BATCH_USER_TEMPLATE");
      if (!SYSTEM || !USER_TEMPLATE) return "エラー: BATCHプロンプト設定が見つかりません。";
      const USER = USER_TEMPLATE + ["", "記事: ---", articleText, "---"].join("\n");
      return _callLlmWithFallback(SYSTEM, USER, model);
    },
    generateTrendSections: function(articlesGroupedByKeyword, linksPerTrend, hitKeywords, previousSummary = null, options = {}) {
      const model = llmConfig.ModelMini;
      const azureWeeklyUrl = llmConfig.AzureUrlMini;
      
      let SYSTEM, USER_TEMPLATE;

      if (options.promptKeys && options.promptKeys.system && options.promptKeys.user) {
        const customSystem = getPromptConfig(options.promptKeys.system);
        const customUser = getPromptConfig(options.promptKeys.user);

        if (customSystem && customUser) {
          SYSTEM = customSystem;
          USER_TEMPLATE = customUser;
          Logger.log(`カスタムプロンプトセットを使用: ${options.promptKeys.system} / ${options.promptKeys.user}`);
        } else {
          Logger.log(`警告: カスタムプロンプト(${options.promptKeys.system} or ${options.promptKeys.user})が見つからないため、デフォルトのトレンド分析プロンプトへフォールバックします。`);
        }
      }

      if (!SYSTEM || !USER_TEMPLATE) {
        SYSTEM = getPromptConfig("TREND_SYSTEM");
        const fallbackUserKey = previousSummary ? "TREND_USER_TEMPLATE_WITH_HISTORY" : "TREND_USER_TEMPLATE";
        USER_TEMPLATE = getPromptConfig(fallbackUserKey);
        Logger.log(`デフォルトプロンプトセットを使用: TREND_SYSTEM / ${fallbackUserKey}`);
      }

      if (!SYSTEM || !USER_TEMPLATE) {
        return "プロンプト設定エラー: デフォルトのプロンプト(TREND_SYSTEM, TREND_USER_TEMPLATE)さえも見つかりません。";
      }

      const allTrends = [];
      
      for (const keyword of hitKeywords) {
        const articles = articlesGroupedByKeyword[keyword];
        if (!articles || articles.length === 0) continue;

        const articleListForLlm = articles.map(a => {
          const summaryContent = a.headline && a.headline.length > 10 ? a.headline : (a.abstractText || a.title);
          return `- タイトル: ${a.title}\n  要点: ${summaryContent}\n  URL: ${a.url}`;
        }).join("\n\n");

        let userPrompt = USER_TEMPLATE;
        if (previousSummary && userPrompt.includes('{previous_summary}')) {
          userPrompt = userPrompt.replace('{previous_summary}', previousSummary);
        }

        if (userPrompt.includes('{article_list}')) {
          userPrompt = userPrompt.replace('{article_list}', articleListForLlm);
        } else {
          userPrompt += '\n' + articleListForLlm;
        }

        const txt = _callLlmWithFallback(SYSTEM, userPrompt, model, azureWeeklyUrl);
        if (txt && txt.trim()) {
          allTrends.push(txt.trim());
        }
      }
      return allTrends.join("\n\n---\n\n");
    },
    summarizeReport: function(systemPrompt, reportText) {
      const model = llmConfig.ModelNano;
      return _callLlmWithFallback(systemPrompt, reportText, model);
    },
    generateDailyDigest: function(systemPrompt, userPrompt) {
        const model = llmConfig.ModelMini;
        const azureDailyUrl = llmConfig.AzureUrlMini;
        return _callLlmWithFallback(systemPrompt, userPrompt, model, azureDailyUrl);
    },
    analyzeKeywordSearch: function(systemPrompt, contextText, options) {
        const model = llmConfig.ModelMini;
        const azureUrl = llmConfig.AzureUrlMini;
        return _callLlmWithFallback(systemPrompt, contextText, model, azureUrl, options);
    },
    // ★【追加】パブリックメソッド: generateVector
    generateVector: function(text) {
      // 既存の Context 設定 (COMPANY or PERSONAL) に従って優先順位を決定
      const context = llmConfig.Context;
      const embConfig = llmConfig.Embedding;
      
      let vector = null;

      if (context === 'PERSONAL') {
        // PERSONAL優先: OpenAI -> Azure
        if (llmConfig.OpenAiKey) {
          vector = _callOpenAiEmbedding(text, embConfig.OpenAiModel, llmConfig.OpenAiKey);
          if (vector) return vector;
        }
        if (embConfig.AzureEndpoint && llmConfig.AzureKey) {
          vector = _callAzureEmbedding(text, embConfig.AzureEndpoint, llmConfig.AzureKey);
          if (vector) return vector;
        }
      } else {
        // COMPANY優先 (デフォルト): Azure -> OpenAI
        if (embConfig.AzureEndpoint && llmConfig.AzureKey) {
          vector = _callAzureEmbedding(text, embConfig.AzureEndpoint, llmConfig.AzureKey);
          if (vector) return vector;
        }
        if (llmConfig.OpenAiKey) {
          vector = _callOpenAiEmbedding(text, embConfig.OpenAiModel, llmConfig.OpenAiKey);
          if (vector) return vector;
        }
      }
      
      Logger.log("エラー: いずれのサービスでもベクトルを生成できませんでした。");
      return null;
    }
  };
})();

/**
 * 【共通エンジン】キーワード分析・履歴保存プロセッサー (オプション対応)
 * options: { enableHistory: boolean, promptKeys: { system: string, user: string } }
 */
function processKeywordAnalysisWithHistory(keyword, articles, options = {}) {
  let previousSummary = null;
  if (options.enableHistory !== false) {
    previousSummary = _getLatestHistory(keyword);
  }

  const { reportBody } = generateWeeklyReportWithLLM(
    articles,
    [{ keyword: keyword, count: articles.length }],
    { [keyword]: articles },
    previousSummary,
    options
  );

  if (!reportBody || reportBody.trim() === "") return null;

  const tldrSummary = _summarizeReport(reportBody);

  if (options.enableHistory !== false && tldrSummary) {
    _writeHistory(keyword, tldrSummary);
  }

  return { reportBody, summary: tldrSummary };
}

/**
 * 【共通エンジン】トレンドレポートHTML生成 (ハイブリッド検索対応版)
 * フラグ(options.useSemantic)に応じて、ベクトル検索とキーワード検索を切り替える
 */
function generateTrendReportHtml(allArticles, targetItems, startDate, endDate, options = {}) {
  // 記事データがない場合（キーワード検索モードでは必須）
  if (!allArticles && !options.useSemantic) return null;
  
  let hasContent = false;
  let finalHtmlBody = ""; 
  
  const C = AppConfig.get().UI.Colors;

  // --- スタイル定義 (フル幅・カード型) ---
  const S = {
    WRAPPER: `background-color: ${C.BG_BODY}; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;`,
    CONTAINER: 'width: 100%; max-width: 1200px; margin: 0 auto;',
    HEADER_CARD: `background-color: ${C.PRIMARY}; padding: 20px; border-radius: 8px; margin-bottom: 20px; text-align: center; box-shadow: 0 2px 5px rgba(0,0,0,0.1);`,
    HEADER_TITLE: 'margin: 0; color: #ffffff; font-size: 22px; font-weight: bold; letter-spacing: 0.05em;',
    HEADER_SUB: 'margin: 5px 0 0 0; color: #eaf2f8; font-size: 13px;',
    KEYWORD_SECTION: 'margin-bottom: 40px;',
    KEYWORD_HEAD: `background-color: ${C.PRIMARY}; color: #fff; padding: 10px 20px; border-radius: 8px 8px 0 0; font-weight: bold; font-size: 18px; display: inline-block; box-shadow: 0 1px 3px rgba(0,0,0,0.1);`,
    KEYWORD_CONTENT: 'padding: 0;',
    FOOTER: `text-align: center; padding: 20px; font-size: 12px; color: ${C.TEXT_SUB};`
  };

  // ヘッダー生成（メール/Web分岐）
  if (!options.isHtmlOutput) {
    finalHtmlBody += `
      <div style="${S.WRAPPER}">
        <div style="${S.CONTAINER}">
          <div style="${S.HEADER_CARD}">
            <h3 style="${S.HEADER_TITLE}">&#129302; AI Trend Analysis</h3>
            <p style="${S.HEADER_SUB}">${AppConfig.get().Messages.REPORT_HEADER_PREFIX}${fmtDate(startDate)} 〜 ${fmtDate(endDate)}</p>
          </div>`;
  } else {
    // Web用スタイル (CSS)
    finalHtmlBody += `<style>.summary-section{background-color:${C.BG_CARD};padding:20px;border-radius:8px;margin-bottom:25px;box-shadow:0 2px 5px rgba(0,0,0,0.05)}.summary-title{margin-top:0;color:${C.SECONDARY};font-size:18px;font-weight:bold;border-bottom:2px solid ${C.BORDER};padding-bottom:10px;margin-bottom:15px}.section-header{border-left:5px solid ${C.PRIMARY};border-bottom:none;padding-left:10px;padding-bottom:0;color:${C.SECONDARY};margin-top:30px;margin-bottom:15px;font-size:20px}.tech-card{margin-bottom:20px;border:none;padding:20px;border-radius:8px;background-color:${C.BG_CARD};box-shadow:0 2px 8px rgba(0,0,0,0.08);border-left:5px solid ${C.PRIMARY}}.tech-title{margin:0 0 15px 0;color:${C.SECONDARY};font-size:17px;font-weight:bold;line-height:1.4}.tech-meta{font-size:15px;line-height:1.7;color:${C.TEXT_SUB}}.tech-link{margin-top:15px;text-align:right}.tech-link a{display:inline-block;padding:8px 16px;background-color:${C.BADGE_NEW_BG};color:${C.PRIMARY};text-decoration:none;border-radius:20px;font-size:13px;font-weight:bold}.tech-link a:hover{background-color:${C.BADGE_NEW_BG}}</style>`;
  }

  const procStartTime = new Date().getTime();
  const TIME_LIMIT_MS = AppConfig.get().System.TimeLimit.REPORT_GENERATION; 

  // ★デフォルト設定: useSemanticが指定されていない場合は false (キーワード一致) とする
  const useSemantic = (options.useSemantic === true);

  for (const item of targetItems) {
    if (new Date().getTime() - procStartTime > TIME_LIMIT_MS) {
      finalHtmlBody += `<p style="color:red; font-weight:bold; text-align:center;">⚠️ 時間制限のため、一部のトピック解析を中断しました。</p>`;
      break;
    }

    const query = item.query;
    const label = item.label || query;
    let matched = [];

    // ▼▼▼ 検索方式の分岐 ▼▼▼
    if (useSemantic) {
      // A. セマンティック検索 (ベクトル)
      // ※ performSemanticSearch は内部でシートからデータを取るので allArticles は使わない
      matched = performSemanticSearch(query, startDate, endDate, 20); 
    } else {
      // B. 従来型キーワード検索 (AND/OR/NOT対応)
      // 引数で渡された allArticles からフィルタリング
      matched = allArticles.filter(art => {
        const content = (art.title + " " + art.headline + " " + art.abstractText);
        return isTextMatchQuery(content, query);
      });
    }
    // ▲▲▲ 分岐ここまで ▲▲▲

    if (matched.length === 0) continue;

    const result = processKeywordAnalysisWithHistory(query, matched, options);
    
    if (result && result.reportBody) {
      hasContent = true;
      let contentBody = result.reportBody;
      if (query !== label) contentBody = contentBody.split(query).join(label);

      if (options.isHtmlOutput) {
        // Web用
        const cleanHtml = contentBody.replace(/```html/gi, "").replace(/```/g, "");
        const searchTypeLabel = useSemantic ? "🤖 AI意味検索" : "🔍 キーワード検索";
        
        finalHtmlBody += `<div style="margin-bottom: 15px; color: #666; font-size: 14px;">
          <div style="font-weight: bold;">${searchTypeLabel}ヒット: ${matched.length}件 (Concept: ${label})</div>
          <div style="font-size: 12px; margin-top: 4px;">📅 検索期間: ${options.dateRangeStr || fmtDate(startDate) + " 〜 " + fmtDate(endDate)}</div>
        </div>`;
        finalHtmlBody += cleanHtml;
      } else {
        // メール用 (カードデザイン)
        const markdownHtml = markdownToHtml(contentBody);
        finalHtmlBody += `
          <div style="${S.KEYWORD_SECTION}">
            <div style="${S.KEYWORD_HEAD}">&#128204; ${label} <span style="font-weight:normal; font-size:13px; margin-left:8px; opacity:0.9;">(${matched.length} posts)</span></div>
            <div style="${S.KEYWORD_CONTENT}">
              ${markdownHtml}
            </div>
          </div>`;
      }
    }
  }

  if (!hasContent) return null;

  if (!options.isHtmlOutput) {
    finalHtmlBody += `
          <div style="${S.FOOTER}">
            YATA - AI Intelligence Platform<br>
            <span style="opacity: 0.8;">Auto-Generated by AI Engine</span>
          </div>
        </div></div>`;
  }

  return finalHtmlBody;
}

/** SECTION 5: UTILITIES & HELPERS - Spreadsheet operations, settings, text conversion, date handling */

function getWeightedKeywords(sheetName = "Keywords") {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  
  const values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  
  return values.map(([keyword, activeFlag, daySpec, label]) => ({
    keyword: String(keyword).trim(),
    active: String(activeFlag).trim() !== "",
    day: String(daySpec).trim(),
    label: String(label).trim()
  })).filter(obj => obj.keyword);
}

/**
 * 【共通部品】テキストが検索クエリにマッチするか判定する (高機能版)
 * 対応: AND, OR, NOT, (), 全角スペース
 * 例: "(A OR B) AND C", "A B -C"
 * @param {string} text - 検索対象のテキスト
 * @param {string} query - 検索クエリ
 * @returns {boolean}
 */
function isTextMatchQuery(text, query) {
  if (!query) return false;
  if (!text) return false;

  const content = text.toLowerCase();
  
  let q = String(query)
    .replace(/　/g, " ") // 全角スペース -> 半角
    .trim();
    
  q = q.replace(/\(/g, " ( ").replace(/\)/g, " ) ");
  
  const tokens = q.split(/\s+/).filter(t => t.length > 0);
  
  // Level 1: Expression (Handles OR) - 最も結合度が低い
  function parseExpression(tokens) {
    let left = parseAndTerm(tokens);
    
    while (tokens.length > 0) {
      if (tokens[0].toUpperCase() === "OR") {
        tokens.shift();
        const right = parseAndTerm(tokens);
        left = left || right;
      } else {
        break;
      }
    }
    return left;
  }

  // Level 2: Term (Handles AND) - ORより結合度が高い
  function parseAndTerm(tokens) {
    let left = parseFactor(tokens);
    
    while (tokens.length > 0) {
      const next = tokens[0].toUpperCase();
      
      // OR や 閉じ括弧 が来たら、このAND項の連なりは終了
      if (next === "OR" || next === ")") {
        break; 
      }
      
      if (next === "AND") {
        tokens.shift();
      }
      
      // 明示的なANDがなくても、トークンが続く場合は暗黙のANDとして処理
      // (例: "A B" -> A AND B)
      const right = parseFactor(tokens);
      left = left && right;
    }
    return left;
  }

  // Level 3: Factor (Handles Words, NOT, Parentheses) - 最も結合度が高い
  function parseFactor(tokens) {
    if (tokens.length === 0) return false;
    
    const token = tokens.shift();
    
    if (token === "(") {
      const result = parseExpression(tokens); // 括弧内を再帰的に評価
      if (tokens.length > 0 && tokens[0] === ")") {
        tokens.shift();
      }
      return result;
    } else if (token.toUpperCase() === "NOT" || token.startsWith("-")) {
      let termToCheck;
      if (token === "-") { // "- A" (スペースあり)
         termToCheck = parseFactor(tokens);
      } else if (token.startsWith("-") && token.length > 1) { // "-A" (スペースなし)
         const word = token.substring(1);
         return !content.includes(word.toLowerCase());
      } else { // "NOT A"
         termToCheck = parseFactor(tokens);
      }
      return !termToCheck;
    } else {
      // 通常の単語マッチ
      return content.includes(token.toLowerCase());
    }
  }

  return parseExpression([...tokens]);
}

/**
 * getPromptConfig
 * 【責務】promptシートからプロンプトテンプレートを取得
 * @param {string} key - キー名（例:"WEB_ANALYSIS_SYSTEM", "DAILY_DIGEST_USER"）
 * @returns {string|null} プロンプト内容
 */
function getPromptConfig(key) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(AppConfig.get().SheetNames.PROMPT_CONFIG);
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
 * markdownToHtml (改良版: バッジ変換 & カード分割機能付き)
 * 【責務】Markdown → HTML 変換
 * 【改善】AIが出力した区切り（**1. トピック**など）を検知し、自動的にdivボックスを分割する
 */
function markdownToHtml(md) {
  if (!md) return "";
  
  const C = AppConfig.get().UI.Colors;

  // スタイル定義
  const S = {
    // 内部カード（白い箱）
    CARD: `background-color: ${C.BG_CARD}; padding: 20px; border-radius: 0 8px 8px 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); border: 1px solid ${C.BORDER};`,
    // カード内の見出し
    H3: `font-size: 18px; font-weight: bold; color: ${C.SECONDARY}; border-bottom: 2px solid ${C.PRIMARY}; padding-bottom: 5px; margin-top: 0; margin-bottom: 15px;`,
    STRONG: `font-weight: bold; color: ${C.ACCENT};`, // 強調色
    LINK: `color: ${C.LINK}; text-decoration: none; border-bottom: 1px dotted ${C.LINK};`,
    HR: `border: 0; border-top: 1px solid #eee; margin: 20px 0;`,
    // バッジ
    BADGE: 'display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; margin-left: 8px; vertical-align: middle;',
    B_NEW: `background-color: ${C.BADGE_NEW_BG}; color: ${C.BADGE_NEW_TXT}; border: 1px solid ${C.BADGE_NEW_BG};`,
    B_UP:  `background-color: ${C.BADGE_UP_BG}; color: ${C.BADGE_UP_TXT}; border: 1px solid ${C.BADGE_UP_BG};`,
    B_WARN:`background-color: ${C.BADGE_WARN_BG}; color: ${C.BADGE_WARN_TXT}; border: 1px solid ${C.BADGE_WARN_BG};`,
    B_KEEP:`background-color: ${C.BADGE_KEEP_BG}; color: ${C.BADGE_KEEP_TXT}; border: 1px solid ${C.BADGE_KEEP_BG};`
  };

  const L = AppConfig.get().Logic;

  // 1. 基本的なHTMLエスケープとMarkdown変換
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.*$)/gim, `<h3 style="${S.H3}">$1</h3>`)
    
    // バッジ変換
    .replace(L.TAGS.NEW, `<span style="${S.BADGE} ${S.B_NEW}">&#9889; 新規</span>`)
    .replace(L.TAGS.UP, `<span style="${S.BADGE} ${S.B_UP}">&#128200; 進展</span>`)
    .replace(L.TAGS.WARN, `<span style="${S.BADGE} ${S.B_WARN}">&#9888; 懸念</span>`)
    .replace(L.TAGS.KEEP, `<span style="${S.BADGE} ${S.B_KEEP}">&#10145; 継続</span>`)
    
    .replace(/\*\*(.*?)\*\*/g, `<strong style="${S.STRONG}">$1</strong>`)
    .replace(/\*\[([^\]]+)\]\(([^)]+)\)/g, `<a href="$2" target="_blank" style="${S.LINK}">$1</a>`)
    .replace(/^\s*---\s*$/gm, `<hr style="${S.HR}">`)
    .replace(/^- (.*$)/gim, `&bull; $1`)
    .replace(/\n/g, '<br>\n');

  // 2. ★追加: コンテンツの「カード分割」処理
  // 最初のカードを開始
  html = `<div style="${S.CARD}">` + html;
  
  // 区切りパターンを検出して、</div><div ...> を挿入する
  // パターンA: "**1. トピック**" のような番号付きトピック (strongタグ化されている)
  // パターンB: "**【注目の兆候...】**" のようなセクション区切り
  
  // 注意: replaceの文字列内で変数を展開するため、一旦プレースホルダーを使うか、慎重に置換する
  const splitTag = `</div><div style="${S.CARD}">`;
  
  // numbered topics (e.g. 1. Title)
  html = html.replace(/<strong style="[^"]+">[0-9]+\./g, match => splitTag + match);
  
  // specific sections (Early Signals, Next Actions)
  html = html.replace(/<strong style="[^"]+">【注目の兆候/g, match => splitTag + match);
  html = html.replace(/<strong style="[^"]+">【次のアクション/g, match => splitTag + match);
  
  // 最後のカードを閉じる
  html += `</div>`;

  return html;
}

/**
 * isLikelyEnglish
 * 【責務】テキストに日本語が含まれているか判定
 * @param {string} text - 判定対象テキスト
 * @returns {boolean} true=英語のみ, false=日本語含む
 */
function isLikelyEnglish(text) {
  return !(/[぀-ゟ゠-ヿ一-鿿]/.test(text));
}

/**
 * _logError
 * 【責務】エラーログを整形出力
 * @param {string} functionName - エラー発生関数名
 * @param {Error} error - エラーオブジェクト
 * @param {string} message - 補足メッセージ
 * @returns {none}
 */
function _logError(functionName, error, message = "") {
  Logger.log(`[ERROR] ${functionName}: ${message} ${error.toString()} Stack: ${error.stack}`);
}

/* =============================================================================

 * SECTION 5: COLLECTION SERVICES (Data Gathering & Maintenance)
 * 【役割】外部ソース（RSS）からデータを収集し、シート内のデータを整理・維持する。
 * 定期的なデータ蓄積と、古い記事のクリーンアップを担当。
 * =============================================================================
 */

/** 
 * collectRssFeeds
 * 【責務】RSSフィードを巡回し、新しい記事を抽出して collect シートに追加する。
 * 【改修】ドメイン分散型スケジューリングにより、同一ホストへの集中アクセスを回避しつつ並列取得。
 * 【仕様】
 * 1. RSSリストから巡回対象のURLを取得。
 * 2. URLのドメインごとにグループ化し、ラウンドロビン方式でリクエスト順序を決定。
 * 3. 12件ずつのチャンクに分割し、並列リクエストを送信。
 * 4. 新着記事のみを collect シートの末尾に追記。
 */
function collectRssFeeds() {
  const rssListSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.RSS_LIST);
  const collectSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  
  if (rssListSheet.getLastRow() < AppConfig.get().RssListSheet.DataRange.START_ROW) {
    Logger.log("RSSリストが空のため、収集をスキップします。");
    return;
  }

  // RSSリスト取得
  const numRows = rssListSheet.getLastRow() - AppConfig.get().RssListSheet.DataRange.START_ROW + 1;
  const rssDataRaw = rssListSheet.getRange(
    AppConfig.get().RssListSheet.DataRange.START_ROW, 
    AppConfig.get().RssListSheet.DataRange.START_COL, 
    rssListSheet.getLastRow() - 1, 
    AppConfig.get().RssListSheet.DataRange.NUM_COLS
  ).getValues();

  // 既存データの読み込み（重複チェック用）
  const existingUrlSet = new Set();
  const existingTitleSet = new Set();
  const lastRow = collectSheet.getLastRow();
  
  if (lastRow >= 2) { 
    const checkLimit = AppConfig.get().System.Limits.RSS_CHECK_ROWS; 
    const startRow = 2; 
    const numRowsToCheck = Math.min(lastRow - 1, checkLimit); 

    const existingData = collectSheet.getRange(startRow, 2, numRowsToCheck, 2).getValues();
    
    existingData.forEach(row => {
      const title = row[0];
      const url = row[1];   
      if (url) {
        // normalizeUrl内で小文字化・クエリ削除・プロトコル正規化が行われるため、これだけで十分
        existingUrlSet.add(normalizeUrl(url)); 
      }
      if (title) {
        const normTitle = decodeHtmlEntities(String(title)).trim().toLowerCase();
        existingTitleSet.add(normTitle);
      }
    });
    Logger.log(`既存データ読込完了: ${existingData.length}件 (チェック対象)`);
  }
  
  let totalNewCount = 0;
  const DATE_LIMIT_DAYS = AppConfig.get().System.Limits.RSS_DATE_WINDOW_DAYS; 
  const rssCols = AppConfig.get().RssListSheet.Columns;

  // --- ドメイン分散スケジューリング (Domain-Aware Scheduling) ---
  const requests = [];
  
  // 1. まず全リクエストオブジェクトを作成
  const rawRequests = [];
  const fetchOptions = {
    'muteHttpExceptions': true,
    'validateHttpsCertificates': false,
    'headers': AppConfig.get().System.HttpHeaders
  };

  for (const row of rssDataRaw) {
    const siteName = row[rssCols.NAME - 1];
    const rssUrl = row[rssCols.URL - 1];
    if (!rssUrl) continue;

    rawRequests.push({
      siteName: siteName,
      rssUrl: rssUrl,
      domain: _extractDomain(rssUrl),
      request: { url: rssUrl, ...fetchOptions }
    });
  }

  // 2. ドメインごとにグループ化してラウンドロビンで並べ替え
  // これにより、同じドメインのリクエストが連続しないようにする
  const scheduledRequests = _scheduleRequestsByDomain(rawRequests);
  
  // チャンク処理 (並列実行の安全化)
  // ドメイン分散が効いているため、チャンクサイズを少し上げても安全
  const CHUNK_SIZE = AppConfig.get().System.Limits.RSS_CHUNK_SIZE; 
  
  for (let i = 0; i < scheduledRequests.length; i += CHUNK_SIZE) {
    const chunkItems = scheduledRequests.slice(i, i + CHUNK_SIZE);
    
    // UrlFetchApp.fetchAll 用の配列を作成
    const chunkRequests = chunkItems.map(item => item.request);
    
    Logger.log(`Processing chunk: ${i + 1} to ${Math.min(i + CHUNK_SIZE, scheduledRequests.length)} / ${scheduledRequests.length}`);
    
    try {
      const responses = UrlFetchApp.fetchAll(chunkRequests);
      
      const chunkNewItems = [];

      responses.forEach((response, idx) => {
        const meta = chunkItems[idx];
        const responseCode = response.getResponseCode();
        
        if (responseCode !== 200) {
          console.warn(`RSS取得失敗 (${responseCode}): ${meta.siteName} (${meta.rssUrl})`);
          return;
        }

        const xml = response.getContentText();
        const items = parseRssXml(xml, meta.rssUrl); // パース処理
        
        if (!items || items.length === 0) return;

        items.forEach(item => {
          try {
            if (!item.link || !item.title) return;
            
            const normalizedLink = normalizeUrl(item.link);
            const cleanTitle = stripHtml(item.title).trim();
            const normTitleToCheck = decodeHtmlEntities(cleanTitle).toLowerCase();

            // 強化されたnormalizeUrlにより、ここでの split('?')[0] は不要
            const isUrlDup = existingUrlSet.has(normalizedLink);
            const isTitleDup = existingTitleSet.has(normTitleToCheck);

            if (isUrlDup || isTitleDup) return;
            if (!item.pubDate || !isRecentDate(item.pubDate, DATE_LIMIT_DAYS)) return;
            
            const rawDescription = stripHtml(item.description || AppConfig.get().Llm.NO_ABSTRACT_TEXT).trim();
            const cleanDescription = rawDescription.replace(/[\r\n]+/g, " ");
            
            chunkNewItems.push([
              new Date(),      // A列
              cleanTitle,      // B列
              item.link,       // C列
              cleanDescription,// D列
              "",              // E列
              meta.siteName    // F列
            ]);
            
            existingUrlSet.add(normalizedLink);
            existingTitleSet.add(normTitleToCheck);

          } catch (err) {
            console.error(`アイテム処理エラー: ${meta.siteName} - ${err.message}`);
          }
        });
      });

      // チャンクごとに書き込み
      if (chunkNewItems.length > 0) {
        const startRow = collectSheet.getLastRow() + 1;
        collectSheet.getRange(startRow, 1, chunkNewItems.length, chunkNewItems[0].length).setValues(chunkNewItems);
        totalNewCount += chunkNewItems.length;
        SpreadsheetApp.flush(); // 書き込み確定
      }
      
      // チャンク間のウェイト（Bot判定回避のための安全策）
      if (i + CHUNK_SIZE < scheduledRequests.length) {
        Utilities.sleep(AppConfig.get().System.Limits.RSS_INTER_CHUNK_DELAY); 
      }

    } catch (e) {
      Logger.log(`Chunk error: ${e.toString()}`);
    }
  }
  
  Logger.log(`合計 ${totalNewCount} 件の新しい記事を追加しました。`);
}

/**
 * _extractDomain
 * URLからドメイン名(ホスト名)を抽出する
 */
function _extractDomain(url) {
  try {
    // 簡易的な抽出: プロトコル除去して最初のスラッシュまで
    let domain = url.replace(/^https?:\/\//, '').split('/')[0];
    return domain.toLowerCase();
  } catch (e) {
    return "unknown";
  }
}

/**
 * _scheduleRequestsByDomain
 * 同じドメインのリクエストが連続しないように並び替える（ラウンドロビン方式）
 */
function _scheduleRequestsByDomain(items) {
  const domainMap = new Map();
  
  // 1. ドメインごとにグループ化
  items.forEach(item => {
    const d = item.domain;
    if (!domainMap.has(d)) {
      domainMap.set(d, []);
    }
    domainMap.get(d).push(item);
  });
  
  // 2. ラウンドロビンで取り出す
  const result = [];
  const groups = Array.from(domainMap.values());
  let maxLen = 0;
  
  // 最大のグループ長を知る
  groups.forEach(g => {
    if (g.length > maxLen) maxLen = g.length;
  });
  
  // 縦にスライスしていくイメージで取得
  for (let i = 0; i < maxLen; i++) {
    for (const group of groups) {
      if (i < group.length) {
        result.push(group[i]);
      }
    }
  }
  
  return result;
}

/**
 * getExistingUrls

 * 【責務】collectシートから既存のURLをSet形式で取得する（重複チェックの高速化のため）。
 * @param {Sheet} sheet - collectシート
 * @returns {Set} URLのSet
 */
function getExistingUrls(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return new Set();

  const CHECK_LIMIT = AppConfig.get().System.Limits.RSS_CHECK_ROWS;
  
  const startRow = Math.max(2, lastRow - CHECK_LIMIT + 1);
  const numRows = lastRow - startRow + 1;
  
  const urls = sheet.getRange(startRow, AppConfig.get().CollectSheet.Columns.URL, numRows, 1).getValues().flat();
  return new Set(urls);
}

/**
 * sortCollectByDateDesc
 * 【責務】collectシートを日付順（新しい順）に並び替える。
 */
function sortCollectByDateDesc() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  const lastRow = sheet.getLastRow();
  
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn())
         .sort({column: 1, ascending: false});
    Logger.log("collectシートを日付(最新順)で並び替えました。");
  }
}

/**
 * parseRssXml
 * 【責務】RSSのXML文字列をパースして記事オブジェクトの配列を返す。
 * 【対応フォーマット】RSS 2.0, Atom, RSS 1.0 (RDF)
 * @param {string} xml - RSSのXML文字列
 * @param {string} url - エラーログ用のURL
 * @returns {Array} 記事オブジェクトの配列
 */
function parseRssXml(xml, url) {
  try {
    // XMLサニタイズ処理
    let safeXml = xml
      .replace(/<atom:link/gi, '<link')
      .replace(/<\/atom:link>/gi, '</link>')
      .replace(/<[a-zA-Z0-9]+:/g, '<')
      .replace(/<\/[a-zA-Z0-9]+:/g, '</');

    let document;
    try {
      document = XmlService.parse(safeXml);
    } catch (e) {
      // 制御文字削除などで再試行
      safeXml = safeXml.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '');
      try {
        document = XmlService.parse(safeXml);
      } catch (e2) {
        console.warn(`パース失敗: ${url} / Error: ${e2.message}`);
        return [];
      }
    }

    const root = document.getRootElement();
    let items = [];
    
    const channel = root.getChild('channel');
    
    if (channel) {
      // RSS 2.0
      const children = channel.getChildren('item');
      items = children.map(item => {
        return {
          title: getChildText(item, 'title'),
          link: getChildText(item, 'link'),
          description: getChildText(item, 'description') || getChildText(item, 'encoded'),
          pubDate: getChildText(item, 'pubDate') || getChildText(item, 'date'),
          source: "RSS 2.0"
        };
      });
    } else if (root.getName() === 'feed' || root.getName() === 'RDF') {
      // Atom または RSS 1.0
      let entries = root.getChildren('entry');
      
      if (entries.length === 0) {
        const rss1Ns = XmlService.getNamespace('http://purl.org/rss/1.0/');
        entries = root.getChildren('item', rss1Ns);
        
        if (entries.length === 0) {
          entries = root.getChildren('item');
        }
      }
      
      items = entries.map(entry => {
        let link = getChildText(entry, 'link');
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
    console.error(`parseRssXml: エラーが発生しました。URL: ${url} Exception: ${e.toString()}`);
    return [];
  }
}

/**
 * getChildText
 * 【責務】XML要素から特定のタグのテキスト内容を安全に取得する。
 */
function getChildText(element, tagName) {
  if (!element) return '';
  const child = element.getChild(tagName);
  if (child) return child.getText();
  
  const allChildren = element.getChildren();
  for (const c of allChildren) {
    if (c.getName() === tagName) return c.getText();
  }
  return '';
}

/**
 * backfillVectors: ベクトル未付与の記事に対してEmbeddingを一括実行
 * 【役割】以前取り込んだ記事などで、見出しはあるがベクトル（G列）が空のものに対して、
 * ベクトルを生成して保存します。
 */
function backfillVectors() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const trendDataSheet = ss.getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  if (!trendDataSheet) {
    Logger.log("エラー: collectシートが見つかりません。");
    return;
  }
  const lastRow = trendDataSheet.getLastRow();
  if (lastRow < 2) return;

  const startTime = new Date().getTime();
  const TIME_LIMIT_MS = AppConfig.get().System.TimeLimit.SUMMARIZATION;
  const VECTOR_COL_INDEX = AppConfig.get().CollectSheet.Columns.VECTOR - 1; 

  const maxCol = Math.max(trendDataSheet.getLastColumn(), VECTOR_COL_INDEX + 1);
  const dataRange = trendDataSheet.getRange(2, 1, lastRow - 1, maxCol);
  const values = dataRange.getValues();
  
  let processedCount = 0;
  let minModifiedIndex = -1;
  let maxModifiedIndex = -1;

  for (let i = 0; i < values.length; i++) {
    // タイムアウトチェック
    if (new Date().getTime() - startTime > TIME_LIMIT_MS) {
      Logger.log(`時間制限のため中断します。処理件数: ${processedCount}`);
      break;
    }

    const row = values[i];
    const headline = row[AppConfig.get().CollectSheet.Columns.SUMMARY - 1]; // E列
    const currentVector = row[VECTOR_COL_INDEX]; // G列

    // 見出しがあり、かつベクトルが空の場合に処理
    if (headline && String(headline).trim() !== "" && (!currentVector || String(currentVector).trim() === "")) {
      const title = row[AppConfig.get().CollectSheet.Columns.URL - 2]; // B列 (タイトル)
      
      try {
        const textToEmbed = `Title: ${title}\nSummary: ${headline}`;
        const vector = LlmService.generateVector(textToEmbed);
        
        if (vector) {
          while (values[i].length <= VECTOR_COL_INDEX) {
            values[i].push("");
          }
          values[i][VECTOR_COL_INDEX] = vector.join(',');
          processedCount++;
          
          if (minModifiedIndex === -1 || i < minModifiedIndex) minModifiedIndex = i;
          if (i > maxModifiedIndex) maxModifiedIndex = i;
        }
      } catch (e) {
        Logger.log(`ベクトル生成エラー (Row: ${i + 2}): ${e.toString()}`);
      }
      
      Utilities.sleep(AppConfig.get().System.Limits.BACKFILL_DELAY); // 連続呼び出し緩和
    }
  }

  // シートへの書き戻し
  if (processedCount > 0 && minModifiedIndex !== -1) {
    const startRow = minModifiedIndex + 2;
    const numRows = maxModifiedIndex - minModifiedIndex + 1;
    const modifiedData = values.slice(minModifiedIndex, maxModifiedIndex + 1);
    
    // 列数正規化
    const maxColsInSlice = modifiedData.reduce((max, row) => Math.max(max, row.length), 0);
    const normalizedData = modifiedData.map(row => {
      while (row.length < maxColsInSlice) row.push("");
      return row;
    });

    const outputRange = trendDataSheet.getRange(startRow, 1, numRows, maxColsInSlice);
    outputRange.setValues(normalizedData);
    
    Logger.log(`バックフィル完了: ${processedCount} 件のベクトルを付与しました。`);
  } else {
    Logger.log("バックフィルが必要な記事（見出しあり・ベクトルなし）は見つかりませんでした。");
  }
}

/**
 * sanitizeXml
 * 【責務】XMLパースエラーの原因となるHTMLタグや特殊文字を除去する。
 */
function sanitizeXml(text) {
  let cleanText = text;
  cleanText = cleanText.replace(/<\/?sup[^>]*>/gi, "");
  cleanText = cleanText.replace(/<\/?sub[^>]*>/gi, "");
  cleanText = cleanText.replace(/<\/?font[^>]*>/gi, "");
  cleanText = cleanText.replace(/<\/?span[^>]*>/gi, "");
  cleanText = cleanText.replace(/<\/?div[^>]*>/gi, "");
  cleanText = cleanText.replace(/<br>/gi, "<br/>");
  cleanText = cleanText.replace(/<hr>/gi, "<hr/>");
  cleanText = cleanText.replace(/&nbsp;/g, " ");
  return cleanText;
}

/**
 * removeDuplicates
 * 【責務】URL正規化により collect シート内の重複記事を削除する。
 * 【仕様】上から順に走査し、正規化URLが重複している行を削除。
 */
function removeDuplicates() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  if (!sheet) {
    Logger.log("エラー: シートが見つかりません");
    return;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("データがありません");
    return;
  }

  const range = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
  const values = range.getValues();
  
  const uniqueNormalizedUrls = new Set();
  const uniqueRows = [];
  let duplicateCount = 0;

  values.forEach(row => {
    const url = row[AppConfig.get().CollectSheet.Columns.URL - 1]; // C列
    
    if (url) {
      const normalizedUrl = normalizeUrl(url); 
      
      if (!uniqueNormalizedUrls.has(normalizedUrl)) {
        uniqueNormalizedUrls.add(normalizedUrl);
        uniqueRows.push(row);
      } else {
        duplicateCount++;
      }
    } else {
      uniqueRows.push(row);
    }
  });

  if (duplicateCount > 0) {
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
 * getRecipients
 * 【責務】配信先メールアドレスリスト（カンマ区切り）を生成する。
 * 【仕様】管理者メールと、Usersシートの有効なユーザーを統合し重複排除。
 */
function getRecipients() {
  const adminMail = AppConfig.get().Digest.mailTo; 
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.USERS);
  
  const recipientSet = new Set();

  if (adminMail) {
    adminMail.split(',').forEach(email => {
      const trimmed = email.trim();
      if (trimmed) recipientSet.add(trimmed);
    });
  }

  if (sheet && sheet.getLastRow() >= 2) {
    const numRows = sheet.getLastRow() - 1;
    
    if (numRows > 0) {
      const data = sheet.getRange(2, 1, numRows, 3).getValues();
      
      data.forEach(row => {
        const email = String(row[1]).trim();
        const isActive = String(row[2]).trim() !== ""; 
        if (email && isActive) {
          recipientSet.add(email);
        }
      });
    }
  }

  const finalRecipients = Array.from(recipientSet).join(',');
  Logger.log(`配信先リスト生成: ${recipientSet.size} 件 (${finalRecipients})`);
  return finalRecipients;
}

/**
 * maintenanceDeleteOldArticles
 * 【責務】指定期間（デフォルト6ヶ月）より古い記事をcollectシートから一括削除する。
 */
function maintenanceDeleteOldArticles() {
  const KEEP_MONTHS = AppConfig.get().System.Limits.DATA_RETENTION_MONTHS;
  
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  const lastRow = sheet.getLastRow();
  
  if (lastRow < 2) return;

  const thresholdDate = new Date();
  thresholdDate.setMonth(thresholdDate.getMonth() - KEEP_MONTHS);
  
  const dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  
  let deleteStartRow = -1;
  
  for (let i = 0; i < dates.length; i++) {
    const rowDate = new Date(dates[i][0]);
    if (rowDate < thresholdDate) {
      deleteStartRow = i + 2;
      break;
    }
  }

  if (deleteStartRow !== -1) {
    const numRowsToDelete = lastRow - deleteStartRow + 1;
    sheet.deleteRows(deleteStartRow, numRowsToDelete);
    Logger.log(`メンテナンス: ${fmtDate(thresholdDate)} 以前の記事、計 ${numRowsToDelete} 件を削除しました。`);
  } else {
    Logger.log("メンテナンス: 削除対象の古い記事はありませんでした。");
  }
}

/**
 * sanitizeHtmlForWeb
 * 【責務】Web UI表示用に危険なHTMLタグを除去する (簡易XSS対策)。
 */
function sanitizeHtmlForWeb(html) {
  if (!html) return "";
  let clean = html;
  
  clean = clean.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
               .replace(/<iframe\b[^>]*>([\s\S]*?)<\/iframe>/gim, "")
               .replace(/<object\b[^>]*>([\s\S]*?)<\/object>/gim, "")
               .replace(/<embed\b[^>]*>([\s\S]*?)<\/embed>/gim, "")
               .replace(/<form\b[^>]*>([\s\S]*?)<\/form>/gim, ""); 

  clean = clean.replace(/\s+on[a-z]+\s*=\s*"[^"].*?"/gim, "")
               .replace(/\s+on[a-z]+\s*=\s*'[^'].*?'/gim, "")
               .replace(/\s+javascript:/gim, "");

  return clean;
}

/* =============================================================================
 * SECTION 7: UTILITIES (Shared Helpers)
 * 【役割】特定の業務ロジックに依存しない、汎用的な補助関数群。
 * 文字列操作、JSONパース、URL正規化、セキュリティクリーンアップなど。
 * =============================================================================
 */

/**
 * fetchRecentArticlesBatch
 * 【責務】TrendDataシートから、指定された日数分（maxDays）の記事を一括取得してメモリに展開する。
 * 日付ソートされている前提で、古い記事は読み込まずメモリを節約する。
 */
function fetchRecentArticlesBatch(maxDays) {
  const sheetName = AppConfig.get().SheetNames.TREND_DATA;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return [];
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // 1. 日付列（A列）のみを取得して、読み込むべき行数を計算する（軽量アクセス）
  // A列 = 1列目
  const dateValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  
  // 基準日（これより古い記事はいらない）
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxDays);
  // 時間を00:00:00にしてバッファを持たせる
  cutoffDate.setHours(0, 0, 0, 0);

  let rowsToFetch = 0;
  
  // 上から順に日付をチェック（新しい順に並んでいる前提）
  for (let i = 0; i < dateValues.length; i++) {
    const rowDate = new Date(dateValues[i][0]);
    if (rowDate < cutoffDate) {
      // 基準日より古い記事が現れたら、そこまでとする
      rowsToFetch = i; 
      break;
    }
    rowsToFetch = i + 1; // 最後まで新しい場合は全件
  }

  if (rowsToFetch === 0) return [];

  // 2. 必要な行・列だけをデータ本体として一括取得
  // 取得範囲: A列(1) 〜 G列(Vector: 7) まで
  const colsToFetch = AppConfig.get().CollectSheet.Columns.VECTOR; 
  const rawData = sheet.getRange(2, 1, rowsToFetch, colsToFetch).getValues();

  // 3. 使いやすいオブジェクト配列に変換
  // カラムインデックスの定義
  const C = AppConfig.get().CollectSheet.Columns;
  
  return rawData.map(r => ({
    date: new Date(r[0]),
    title: r[C.URL - 2],          // B列
    url: r[C.URL - 1],            // C列
    abstractText: r[C.ABSTRACT - 1], // D列
    headline: r[C.SUMMARY - 1],   // E列
    source: r[C.SOURCE - 1],      // F列
    vectorStr: r[C.VECTOR - 1]    // G列
  })).filter(a => {
    // 念のため破損データを除外
    return a.headline && String(a.headline).trim() !== "" && String(a.headline).indexOf("API Error") === -1;
  });
}

/**
 * fmtDate
 * 【責務】Date を "yyyy/MM/dd" 形式にフォーマット
 * @param {Date} d - Date オブジェクト
 * @returns {string} フォーマット済み日付文字列
 */
function fmtDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd");
}

/**
 * getDateWindow
 * 【責務】"N日前から今日まで"の日付範囲を計算
 * @param {number} days - 遡り日数
 * @returns {Object} { start: Date, end: Date }
 */
function getDateWindow(days) {
  const end = new Date();
  end.setHours(24, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(1, days));
  return { start, end };
}

/**
 * isRecentArticle
 * 【責務】記事の公開日が指定された日数以内であるかチェックする。
 */
function isRecentArticle(pubDate, daysLimit = 7) {
  if (!pubDate || !(pubDate instanceof Date)) return false;
  const now = new Date();
  const daysOld = Math.floor((now - pubDate) / (1000 * 60 * 60 * 24));
  return daysOld <= daysLimit;
}

/**
 * normalizeUrl
 * 【責務】URLを比較用に正規化する。
 * 【処理】末尾スラッシュの削除、プロトコルの揺らぎ吸収など。
 */
function normalizeUrl(url) {
  if (!url) return "";
  let s = String(url).trim();
  
  try { s = decodeURIComponent(s); } catch (e) {}
  
  // 0. 小文字化 (大文字小文字の揺らぎを吸収)
  s = s.toLowerCase();

  // 1. クエリパラメータとアンカーを削除 (比較用)
  s = s.split('?')[0].split('#')[0];
  
  // 2. 末尾スラッシュの削除
  s = s.replace(/\/$/, "");
  
  // 3. プロトコル(http/https)とwwwの揺らぎを排除
  s = s.replace(/^https?:\/\/(www\.)?/, "//");
  
  return s;
}

/**
 * isRecentDate
 * 【責務】日付文字列が指定された日数以内であるかチェックする。
 */
function isRecentDate(dateStr, daysLimit) {
  if (!dateStr) return false;
  
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return false;

  const now = new Date();
  const diffTime = now - date;
  const diffDays = diffTime / (1000 * 60 * 60 * 24);

  return diffDays <= daysLimit;
}

/**
 * stripHtml
 * 【責務】HTML タグを除去してテキスト抽出
 * @param {string} html - HTML テキスト
 * @returns {string} プレーンテキスト
 */
function stripHtml(html) {
  return html ? html.replace(/<[^>]*>?/gm, '') : '';
}

/**
 * decodeHtmlEntities
 * 【責務】HTML実体参照（&amp;等）を通常の文字に戻す。
 */
function decodeHtmlEntities(text) {
  if (!text) return "";
  return text.replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/&#039;/g, "'")
             .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
}

/**
 * calculateCosineSimilarity
 * 【責務】2つのベクトルのコサイン類似度を計算する。
 */
function calculateCosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return -1;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return (normA === 0 || normB === 0) ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * parseVector
 * 【責務】ベクトル文字列を数値配列にパースする。
 */
function parseVector(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string' && val.trim() !== "") {
    return val.split(',').map(Number);
  }
  return null;
}

/**
 * cleanAndParseJSON
 * 【責務】LLMのレスポンスからJSON部分を抽出し、パースする。
 * 【自己修復】標準的なパースに失敗した場合、正規表現で強引に内容を抽出する。
 */
function cleanAndParseJSON(text) {
  if (!text) return null;
  
  // 1. Markdownのコードブロック ```json や ``` を削除
  let cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  
  // 2. 文字列内の「本物の改行」をエスケープ文字（\n）に置換してパースしやすくする
  // ※JSON.parseは文字列中の生改行を許可しないため
  const preProcessed = cleaned.replace(/\n/g, "\\n");

  // 3. 標準的なパース試行
  const firstOpen = cleaned.indexOf('{');
  const lastClose = cleaned.lastIndexOf('}');
  
  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    let candidate = cleaned.substring(firstOpen, lastClose + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // 標準パース失敗時は下で正規表現による抽出へ
    }
  }

  // 4. 【自己修復ロジック】正規化して "tldr": "内容" の部分を直接抜き出す
  // JSONの形が崩れていても（閉じ引用符がなくても）内容を救出する
  try {
    // "tldr" または "summary" の後ろにあるダブルクォートで囲まれた（または囲まれかけの）中身を探す
    // 改行を考慮し、最短一致で探すが、末尾が崩れているケースも想定
    const regex = /"(?:tldr|summary)"\s*:\s*"([\s\S]*?)(?:"\s*\}|"$|(?=\s*\}))/i;
    const match = cleaned.match(regex);
    
    if (match && match[1]) {
      let recoveredText = match[1].trim();
      // もし末尾にゴミ（ } や " ）が残っていたら掃除
      recoveredText = recoveredText.replace(/"?\s*\}?\s*$/, "");
      Logger.log("JSON修復成功: " + recoveredText.substring(0, 30) + "...");
      return { "tldr": recoveredText };
    }
  } catch (err) {
    Logger.log("自己修復失敗: " + err.toString());
  }

  Logger.log("JSON Parse Error (Raw text): " + text);
  return null; 
}



/**
 * debugRssFeed
 * 【責務】RSSフィードの取得状態をログ出力し、診断するためのデバッグツール。
 */
function debugRssFeed() {
  const TEST_URL = "https://connect.medrxiv.org/medrxiv_xml.php?subject=All"; 
  
  Logger.log(`--- テスト開始: ${TEST_URL} ---`);
  
  try {
    const response = UrlFetchApp.fetch(TEST_URL, {muteHttpExceptions: true});
    const code = response.getResponseCode();
    Logger.log(`レスポンスコード: ${code}`);
    
    if (code !== 200) {
      Logger.log("【原因】: サーバーエラーです。URLが間違っているか、ブロックされています。");
      return;
    }
    
    let xml = response.getContentText();
    Logger.log(`取得データの先頭500文字:\n${xml.substring(0, 500)}`);
    
    xml = xml.replace(/<[a-zA-Z0-9]+:/g, '<').replace(/<\/[a-zA-Z0-9]+:/g, '</');
    
    const doc = XmlService.parse(xml);
    const root = doc.getRootElement();
    Logger.log(`ルート要素名: ${root.getName()}`);
    
    let items = root.getChildren('item');
    if (items.length === 0 && root.getChild('channel')) {
      items = root.getChild('channel').getChildren('item');
    }
    
    Logger.log(`検出された記事数: ${items.length} 件`);
    
    if (items.length > 0) {
      const item = items[0];
      const title = item.getChildText('title');
      const dateStr = item.getChildText('pubDate') || item.getChildText('date') || "見つかりません";
      const dateObj = new Date(dateStr);
      
      Logger.log(`\n【先頭の記事データ】`);
      Logger.log(`タイトル: ${title}`);
      Logger.log(`日付文字列: ${dateStr}`);
      Logger.log(`日付判定結果: ${dateObj.toString()}`);
      
      const now = new Date();
      const diffDays = (now - dateObj) / (1000 * 60 * 60 * 24);
      Logger.log(`現在との差: 約 ${Math.floor(diffDays)} 日前`);
      
      if (diffDays > 30) {
         Logger.log("【判定】: 記事が30日以上古いため、設定によりスキップされています。");
      } else {
         Logger.log("【判定】: 日付は期間内です。これで収集されない場合は「重複」とみなされている可能性があります。");
      }
    } else {
      Logger.log("【原因】: 記事データ(item)が1つも見つかりませんでした。FeedBurnerがまだデータを取得できていない可能性があります。");
    }
    
  } catch (e) {
    Logger.log(`【エラー】: 解析中にエラーが発生しました。\n${e.toString()}`);
  }
}

/**
 * searchAndAnalyzeKeyword
 * 【責務】Index.html からの呼び出し互換性のためのエイリアス。
 */
function searchAndAnalyzeKeyword(keyword, options) {
  return executeWeeklyDigest(keyword, options);
}

/**
 * performSemanticSearch * @param {string} queryKeyword 検索クエリ
 * @param {Date} startDate 開始日
 * @param {Date} endDate 終了日
 * @param {number} topN 上位何件取得するか
 * @returns {Array} 類似度順にソートされた記事リスト
 */
function performSemanticSearch(queryKeyword, startDate, endDate, topN = 20) {
  // 1. クエリをベクトル化
  const queryVector = LlmService.generateVector(queryKeyword);
  if (!queryVector) {
    Logger.log("クエリのベクトル化に失敗しました。");
    return [];
  }

  // 2. 期間内の記事範囲を特定して取得（高速化・省メモリ化）
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // 日付列だけを取得して範囲を計算 (A列)
  const dateValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  
  let startRowIndex = -1; // 読み込み開始行（0始まりのインデックス）
  let endRowIndex = -1;   // 読み込み終了行

  // 日付は降順（新しい順）前提
  // 上から順に走査: endDateより新しい記事はスキップ、startDateより古い記事が出たら終了
  for (let i = 0; i < dateValues.length; i++) {
    const rowDate = new Date(dateValues[i][0]);
    
    if (rowDate <= endDate) {
      if (startRowIndex === -1) startRowIndex = i; // 範囲開始
      
      if (rowDate < startDate) {
        // startDateを下回ったらそこまで（ただしこの行は含まない）
        endRowIndex = i; 
        break;
      }
    }
  }
  
  // 最後までstartDate以上だった場合
  if (startRowIndex !== -1 && endRowIndex === -1) {
    endRowIndex = dateValues.length;
  }

  if (startRowIndex === -1) {
    Logger.log("指定期間内の記事が見つかりませんでした。");
    return [];
  }

  // 必要な行数
  const numRows = endRowIndex - startRowIndex;
  if (numRows <= 0) return [];

  // データ本体を取得 (A列〜G列)
  // シート上の実際の行番号 = startRowIndex + 2
  const values = sheet.getRange(startRowIndex + 2, 1, numRows, AppConfig.get().CollectSheet.Columns.VECTOR).getValues();
  
  const candidates = [];

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    // 一応念のため日付チェック（ソートが完全でない場合の保険）
    const date = new Date(row[0]);
    
    if (date >= startDate && date <= endDate) {
      const vectorStr = row[AppConfig.get().CollectSheet.Columns.VECTOR - 1];
      const vector = parseVector(vectorStr);
      
      if (vector) {
        const similarity = calculateCosineSimilarity(queryVector, vector);
        candidates.push({
          date: date,
          title: row[1],
          url: row[2],
          abstractText: row[3],
          headline: row[4],
          source: row[5],
          similarity: similarity
        });
      }
    }
  }

  // 3. 類似度順にソート
  candidates.sort((a, b) => b.similarity - a.similarity);

  // 4. 上位N件を返す
  return candidates.slice(0, topN);
}

/* =============================================================================
 * SECTION 8: DEVELOPER TOOLS (Maintenance & Tests)
 * 【役割】開発者やシステム管理者が、ロジックの検証や疎通確認を行うためのツール群。
 * 通常の運用（トリガー実行）では使用されず、手動で実行して健全性を診断する。
 * =============================================================================
 */

/**
 * runAllTests
 * 全てのロジックテストを一括実行します。
 */
function runAllTests() {
  Logger.log("--- [YATA] ロジックテスト開始 ---");
  try {
    _test_AppConfig();
    _test_parseVector();
    _test_isTextMatchQuery();
    _test_computeHeuristicScore();
    _test_normalizeUrl();
    _test_EmergingSignalEngine();
    
    Logger.log("✅ 全てのロジックテストに合格しました。");
  } catch (e) {
    Logger.log("❌ テスト失敗: " + e.message);
    throw e;
  }
}

/**
 * _test_EmergingSignalEngine
 * 予兆検知エンジンの計算ロジック（重心・アウトライヤー・核形成）を検証。
 */
function _test_EmergingSignalEngine() {
  Logger.log("test_EmergingSignalEngine: 開始");

  // 1. ダミーデータの作成 (3次元ベクトルで簡略化)
  // 主流: [1.0, 1.0, 0.0] 付近
  const mainstream = [
    { vector: [0.9, 0.9, 0.1], source: "SourceA" },
    { vector: [0.95, 0.85, 0.0], source: "SourceB" },
    { vector: [0.85, 0.95, 0.0], source: "SourceC" }
  ];

  // アウトライヤー（孤独な点）: [0.0, 0.0, 1.0] 付近
  // ソースが異なる2つの点が近い座標にある（＝核形成）
  const nucleusPoint1 = { vector: [0.1, 0.1, 0.9], source: "SourceD" };
  const nucleusPoint2 = { vector: [0.12, 0.08, 0.92], source: "SourceE" };
  
  // 単なるノイズ: 全く別の場所 [-1.0, 0.0, 0.0]
  const noise = { vector: [-0.9, 0.1, 0.1], source: "SourceF" };

  const allArticles = [...mainstream, nucleusPoint1, nucleusPoint2, noise];

  // 2. 重心計算のテスト
  // Private関数のテストのため、EmergingSignalEngineオブジェクトから呼べるようにするか、
  // ロジックを直接検証する。ここではアルゴリズムの妥当性を確認。
  const dim = 3;
  const avg = new Array(dim).fill(0);
  allArticles.forEach(a => {
    for (let i = 0; i < dim; i++) avg[i] += a.vector[i];
  });
  for (let i = 0; i < dim; i++) avg[i] /= allArticles.length;
  
  Logger.log(`算出された重心: [${avg.map(v => v.toFixed(2)).join(", ")}]`);

  // 3. アウトライヤー抽出のテスト (重心から離れているか)
  const threshold = 0.70;
  const outliers = allArticles.filter(a => {
    const sim = calculateCosineSimilarity(avg, a.vector);
    return sim < threshold;
  });

  // nucleusPoint1, nucleusPoint2, noise がアウトライヤーになるはず
  if (outliers.length < 3) {
    throw new Error(`アウトライヤー抽出失敗: 期待値 3以上, 実際 ${outliers.length}`);
  }
  Logger.log(`抽出されたアウトライヤー数: ${outliers.length}`);

  // 4. 核形成検知のテスト
  const config = { NUCLEATION_RADIUS: 0.88, MIN_NUCLEI_SOURCES: 2 };
  const nuclei = [];
  const usedIndices = new Set();

  for (let i = 0; i < outliers.length; i++) {
    if (usedIndices.has(i)) continue;
    const currentNucleus = [outliers[i]];
    const sources = new Set([outliers[i].source]);
    for (let j = i + 1; j < outliers.length; j++) {
      const sim = calculateCosineSimilarity(outliers[i].vector, outliers[j].vector);
      if (sim >= config.NUCLEATION_RADIUS) {
        currentNucleus.push(outliers[j]);
        sources.add(outliers[j].source);
      }
    }
    if (sources.size >= config.MIN_NUCLEI_SOURCES) {
      nuclei.push({ articles: currentNucleus, sourceCount: sources.size });
    }
  }

  if (nuclei.length !== 1) {
    throw new Error(`核形成検知失敗: 期待値 1, 実際 ${nuclei.length}`);
  }
  
  if (nuclei[0].sourceCount !== 2) {
    throw new Error(`核のソース数不一致: 期待値 2, 実際 ${nuclei[0].sourceCount}`);
  }

  Logger.log("test_EmergingSignalEngine: OK (核形成を正しく検知しました)");
}


/**
 * _test_AppConfig: AppConfigが正しく構造化されているか確認
 */
function _test_AppConfig() {
  const config = AppConfig.get();
  if (!config.System || !config.System.Limits.BATCH_SIZE || !config.UI.Colors.PRIMARY) {
    throw new Error("AppConfigの構造が不正、または必須項目が不足しています。");
  }
  Logger.log("test_AppConfig: OK");
}

/**
 * _test_parseVector: ベクトル文字列のパース確認
 */
function _test_parseVector() {
  const input = "0.123,0.456,-0.789";
  const result = parseVector(input);
  if (!result || result.length !== 3 || result[0] !== 0.123 || result[2] !== -0.789) {
    throw new Error("parseVectorの出力が期待値と異なります。");
  }
  Logger.log("test_parseVector: OK");
}

/**
 * _test_isTextMatchQuery: キーワード検索ロジックの検証
 */
function _test_isTextMatchQuery() {
  const text = "Google Apps ScriptはクラウドベースのJavaScriptプラットフォームです。";
  
  // AND検索
  if (!isTextMatchQuery(text, "Google Script")) throw new Error("isTextMatchQuery: AND検索に失敗しました。");
  // OR検索
  if (!isTextMatchQuery(text, "Python OR Script")) throw new Error("isTextMatchQuery: OR検索に失敗しました。");
  // NOT検索
  if (isTextMatchQuery(text, "Google -Script")) throw new Error("isTextMatchQuery: NOT検索に失敗しました。");
  // 複雑な組み合わせ
  if (!isTextMatchQuery(text, "(Google OR Python) Script -Ruby")) throw new Error("isTextMatchQuery: 複雑な検索に失敗しました。");
  
  // ★優先順位の検証 (AND > OR)
  // "Google OR Python AND Ruby"
  // 新ロジック: Google OR (Python AND Ruby) -> True OR False -> True
  // 旧ロジック: (Google OR Python) AND Ruby -> True AND False -> False
  if (!isTextMatchQuery(text, "Google OR Python AND Ruby")) throw new Error("isTextMatchQuery: 優先順位(OR < AND)の検証に失敗しました。旧ロジックのままの可能性があります。");

  Logger.log("test_isTextMatchQuery: OK");
}

/**
 * _test_computeHeuristicScore: スコアリングロジックの検証
 */
function _test_computeHeuristicScore() {
  const dummyArticle = {
    date: new Date(),
    url: "https://example.com/test",
    abstractText: "これはテスト記事です。内容が十分にある場合のスコア計算を確認します。"
  };
  const dummyMap = new Map();
  dummyMap.set(dummyArticle.url, ["テスト", "確認"]);
  
  const score = computeHeuristicScore(dummyArticle, dummyMap);
  if (typeof score !== 'number' || score < 0 || score > 100) {
    throw new Error("computeHeuristicScoreのスコアが範囲外です: " + score);
  }
  Logger.log("test_computeHeuristicScore: OK (Score: " + score + ")");
}

/**
 * _test_normalizeUrl: URL正規化の検証
 */
function _test_normalizeUrl() {
  const url1 = "https://example.com/path?utm_source=test";
  const url2 = "http://www.example.com/path/";
  
  if (normalizeUrl(url1) !== "//example.com/path") throw new Error("normalizeUrl: パラメータの除去に失敗しました。");
  if (normalizeUrl(url2) !== "//example.com/path") throw new Error("normalizeUrl: プロトコル/www/末尾スラッシュの正規化に失敗しました。");
  
  Logger.log("test_normalizeUrl: OK");
}

/**
 * sendTestEmail
 * MAIL_TO に設定されたアドレスにテストメールを送信し、疎通を確認します。
 */
function sendTestEmail() {
  const mailTo = AppConfig.get().Digest.mailTo;
  if (!mailTo) {
    Logger.log("⚠️ MAIL_TO が設定されていないため、テストメールを送信できません。");
    return;
  }
  
  const subject = "【YATA】システム疎通確認メール";
  const body = [
    "YATAからのテストメールです。",
    "このメールが届いている場合、MailApp（GmailAPI）の送信権限と設定は正常です。",
    "",
    "--- 送信時設定 ---",
    "送信先: " + mailTo,
    "実行時刻: " + new Date().toLocaleString()
  ].join("\n");
  
  try {
    MailApp.sendEmail(mailTo, subject, body);
    Logger.log("✅ テストメールを送信しました: " + mailTo);
    Logger.log("受信ボックスを確認してください。");
  } catch (e) {
    Logger.log("❌ メール送信失敗: " + e.toString());
  }
}

/* =============================================================================
 * SECTION 9: EMERGING SIGNAL ENGINE (Nucleation Detection)
 * 【役割】設計方針書に基づき、既存の知識体系から離れた「予兆」を検知する。
 * 核形成（Nucleation）の概念をベクトル空間上の距離とソースの分散で判定。
 * =============================================================================
 */

const EmergingSignalEngine = (function() {
  
  /**
   * detect: メインロジック
   * @returns {Object|null} レポート内容 { html, markdown, nucleiCount }
   */
  function detect() {
    const config = AppConfig.get().System.SignalDetection;
    
    // 1. データの準備
    const mainstreamArticles = _getArticlesForDetection(config.LOOKBACK_DAYS_MAINSTREAM);
    const recentArticles = mainstreamArticles.filter(a => isRecentArticle(a.date, config.LOOKBACK_DAYS_SIGNALS));
    
    if (mainstreamArticles.length < 5) {
      Logger.log("分析に必要な記事数が不足しています。");
      return null;
    }

    // 2. 主流（Mainstream）の重心を算出
    // 簡易化のため、全記事の平均ベクトルを「重心」とする（本来はK-means等で複数重心を出すのが理想）
    const centroid = _calculateAverageVector(mainstreamArticles);
    if (!centroid) return null;

    // 3. 孤独な点（Outliers）を抽出
    const outliers = recentArticles.filter(a => {
      const similarity = calculateCosineSimilarity(centroid, a.vector);
      return similarity < config.OUTLIER_THRESHOLD;
    }).slice(0, config.MAX_OUTLIERS_TO_PROCESS);

    Logger.log(`主流記事数: ${mainstreamArticles.length} / アウトライヤー候補: ${outliers.length}`);

    if (outliers.length < 2) return null;

    // 4. 核形成（Nucleation）の判定
    const nuclei = _detectNuclei(outliers, config);
    Logger.log(`検知された核（Nuclei）の数: ${nuclei.length}`);

    if (nuclei.length === 0) return null;

    // 5. LLMによる定性分析とレポート生成
    return _generateReportWithLLM(nuclei);
  }

  // --- Internal Helpers ---

  function _getArticlesForDetection(days) {
    const { start, end } = getDateWindow(days);
    const sh = SpreadsheetApp.getActive().getSheetByName(AppConfig.get().SheetNames.TREND_DATA);
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return [];

    const data = sh.getRange(2, 1, lastRow - 1, AppConfig.get().CollectSheet.Columns.VECTOR).getValues();
    const articles = [];

    for (const r of data) {
      const date = new Date(r[0]);
      if (date >= start && date < end) {
        const vec = parseVector(r[AppConfig.get().CollectSheet.Columns.VECTOR - 1]);
        if (vec) {
          articles.push({
            date: date,
            title: r[1],
            url: r[2],
            abstractText: r[3],
            headline: r[4],
            source: r[5],
            vector: vec
          });
        }
      }
    }
    return articles;
  }

  function _calculateAverageVector(articles) {
    if (articles.length === 0) return null;
    const dim = articles[0].vector.length;
    const avg = new Array(dim).fill(0);
    
    articles.forEach(a => {
      for (let i = 0; i < dim; i++) avg[i] += a.vector[i];
    });
    
    for (let i = 0; i < dim; i++) avg[i] /= articles.length;
    return avg;
  }

  function _detectNuclei(outliers, config) {
    const nuclei = [];
    const usedIndices = new Set();

    for (let i = 0; i < outliers.length; i++) {
      if (usedIndices.has(i)) continue;
      
      const currentNucleus = [outliers[i]];
      const sources = new Set([outliers[i].source]);

      for (let j = i + 1; j < outliers.length; j++) {
        if (usedIndices.has(j)) continue;

        const sim = calculateCosineSimilarity(outliers[i].vector, outliers[j].vector);
        if (sim >= config.NUCLEATION_RADIUS) {
          currentNucleus.push(outliers[j]);
          sources.add(outliers[j].source);
        }
      }

      // 異なるソースから一定数以上の点が打たれていれば「核」とみなす
      if (sources.size >= config.MIN_NUCLEI_SOURCES) {
        nuclei.push({
          articles: currentNucleus,
          sourceCount: sources.size,
          averageSimilarity: _calculateInnerSimilarity(currentNucleus)
        });
        // 今回の核に使われた記事をマーク（重複検知回避）
        currentNucleus.forEach(a => {
          const idx = outliers.indexOf(a);
          if (idx !== -1) usedIndices.add(idx);
        });
      }
    }
    return nuclei;
  }

  function _calculateInnerSimilarity(articles) {
    if (articles.length < 2) return 1.0;
    let totalSim = 0;
    let count = 0;
    for (let i = 0; i < articles.length; i++) {
      for (let j = i + 1; j < articles.length; j++) {
        totalSim += calculateCosineSimilarity(articles[i].vector, articles[j].vector);
        count++;
      }
    }
    return totalSim / count;
  }

  function _generateReportWithLLM(nuclei) {
    const model = AppConfig.get().Llm.ModelMini;
    const SYSTEM_PROMPT = getPromptConfig("SIGNAL_DETECTION_SYSTEM");
    const USER_TEMPLATE = getPromptConfig("SIGNAL_DETECTION_USER");

    if (!SYSTEM_PROMPT || !USER_TEMPLATE) {
      Logger.log("エラー: 予兆検知用のプロンプト設定が不足しています（SIGNAL_DETECTION_SYSTEM/USER）。");
      return null;
    }

    let fullMarkdown = "# 🧪 Emerging Signals Report\n\n既存の主要トレンドから乖離しつつ、複数のソースで同期的に現れ始めた「予兆（サイン）」を検知しました。\n\n";

    nuclei.forEach((nucleus, index) => {
      const articleListText = nucleus.articles.map(a => 
        `- [${a.title}](${a.url}) (Source: ${a.source})`
      ).join("\n");

      let userPrompt = USER_TEMPLATE
        .replace("${article_list}", articleListText)
        .replace("${index}", index + 1);
      
      const analysis = LlmService.analyzeKeywordSearch(SYSTEM_PROMPT, userPrompt, { temperature: AppConfig.get().Llm.Params.Temperature.CREATIVE });
      fullMarkdown += analysis + "\n\n---\n\n";
    });

    return {
      markdown: fullMarkdown,
      html: _formatSignalHtml(fullMarkdown),
      nucleiCount: nuclei.length
    };
  }

  function _formatSignalHtml(markdown) {
    // 予兆レポート専用の特別な装飾を行う
    const baseHtml = markdownToHtml(markdown);
    const C = AppConfig.get().UI.Colors;
    
    // スタイル調整（予兆レポートらしく、少し先進的な色使いに）
    return `
      <div style="border-left: 10px solid ${C.ACCENT}; background-color: #fafafa; padding: 20px;">
        ${baseHtml}
      </div>
    `;
  }

  return {
    detect: detect
  };
})();

