/**
 * @file YATA.js - AI-Driven News Intelligence Platform
 * @version 1.2.5
 * @date 2026-03-26
 * @description YATA (The Three-Legged Guide to the Web)
 * RSS収集 → AI見出し・ベクトル化 → パーソナライズド配信・トレンド分析・予兆検知
 *
 * =============================================================================
 * 【目次 / Table of Contents】 (Region-based Organization)
 * =============================================================================
 * 1. CONFIGURATION & CORE ENGINE - 設定(AppConfig)、AI通信(LlmService)、予兆検知
 * 2. ENTRY POINTS (Triggers)     - 定期実行ジョブ、Web UI(doGet)、可視化データ
 * 3. REPORTING LOGIC             - レポート生成、検索ロジック、メール配信
 * 4. MEMORY & HISTORY LOGIC      - コンテキスト圧縮、過去履歴・連想記憶(Vector)管理
 * 5. ANALYSIS LOGIC              - 要約生成、ベクトル生成(Embedding)、バックフィル
 * 6. COLLECTION & INFRA LOGIC    - RSS収集、ドメイン分散、アーカイブ・削除メンテ
 * 7. UTILITIES (Helpers)         - 日付・URL・XML・文字列処理などの汎用関数
 * 8. DEVELOPER TOOLS (Tests)     - ロジック検証テスト、診断ツール
 * 9. EXPORTS (Global Scope)      - GASグローバルスコープへの関数公開
 * =============================================================================
 */

// 💡 Node.jsでのローカル実行用ブリッジ（純粋なGAS環境では無視されるため削除不要です）
if (typeof SpreadsheetApp === 'undefined' && typeof require !== 'undefined') {
  require('./gas-bridge.js');
}

// =============================================================================
// #region 1. CONFIGURATION & CORE ENGINE
// 【責務】システム全体の「脳」と「設定」。
//  - AppConfig: 定数・設定値の一元管理
//  - LlmService: AI(GPT/Gemini)との通信・コスト管理・ベクトル生成
//  - EmergingSignalEngine: 予兆検知などの高度な分析ロジック
// =============================================================================

/**
 * @namespace AppConfig
 * @description システム全体の設定値（シートID、APIパラメータ、動作制限など）を一元管理するシングルトンオブジェクト。
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
        KEYWORDS: "Keywords",
        DIGEST_HISTORY: "DigestHistory",
        MACRO_TRENDS: "MacroTrends",
      },
      CollectSheet: {
        // 🌟 C列(3)=URL, D列(4)=元記事, E列(5)=要約, F列(6)=ソース, G列(7)=Vector, H列(8)=Method
        // 🌟 I(9)=tldr, J(10)=who, K(11)=what, L(12)=when, M(13)=where, N(14)=why, O(15)=how, P(16)=result, Q(17)=keywords
        Columns: { 
          URL: 3, ABSTRACT: 4, SUMMARY: 5, SOURCE: 6, VECTOR: 7, METHOD_VECTOR: 8,
          TLDR: 9, WHO: 10, WHAT: 11, WHEN: 12, WHERE: 13, WHY: 14, HOW: 15, RESULT: 16, KEYWORDS: 17
        },
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
        Context: props.getProperty("EXECUTION_CONTEXT") || "COMPANY",     //"COMPANY"でAzureが優先、"PERSONAL"でOPEN AIが優先
        ModelNano: props.getProperty("OPENAI_MODEL_NANO") || "gpt-5-nano",
        ModelMini: props.getProperty("OPENAI_MODEL_MINI") || "gpt-5-mini",
        AzureBaseUrl: props.getProperty("AZURE_ENDPOINT_BASE") || "https://YOUR_RESOURCE_NAME.openai.azure.com/",
        AzureApiVersion: "2024-12-01-preview", // ここでバージョンを一括管理
        AzureKey: props.getProperty("AZURE_API_KEY") || null,
        OpenAiKey: (() => {
          const k = String(props.getProperty("OPENAI_API_KEY_PERSONAL") || "").trim();
          return (!k || k === "0" || k.toLowerCase() === "null") ? null : k;
        })(),
        GeminiKey: props.getProperty("GEMINI_API_KEY") || null,
        // LLMパラメータ・翻訳設定
        Params: {
          // 5.4系におけるゆらぎ制御 (temperatureの代替)
          TopP: {
            NANO: props.getProperty("TOP_P_NANO") !== null ? Number(props.getProperty("TOP_P_NANO")) : 0.05,
            MINI: props.getProperty("TOP_P_MINI") !== null ? Number(props.getProperty("TOP_P_MINI")) : 0.15
          },
          Temperature: {
            STRICT: 0.0,    // 【事実抽出・翻訳】絶対に嘘をつかせない (旧 DEFAULT: 0.2)
            WRITING: 0.4,   // 【レポート執筆】少し表現の幅を持たせ、読み物として成立させる
            INSIGHT: 0.7    // 【予兆検知・ブレスト】あえて「飛躍」した仮説を出させる (旧 CREATIVE: 0.3)
          },
          MaxTokens: 20000,

          // GPT-5 推論/出力量コントロール（モデル種別ごとの既定値）
          ReasoningEffort: {
            NANO: props.getProperty("REASONING_NANO") || "low", // ローカル: none/low, 会社: minimal
            MINI: props.getProperty("REASONING_MINI") || "medium"
          },
          Verbosity: {
            NANO: props.getProperty("VERBOSITY_NANO") || "low", // ローカル: 任意, 会社: low
            MINI: props.getProperty("VERBOSITY_MINI") || "high" // ローカル: 任意, 会社: high
          },
          // 用途別の出力上限（GASタイムアウト回避にも効く）
          MaxCompletionTokens: {
            NANO: 1200,          // 見出し/短要約用途
            NANO_REVENGE: 2500, // 上記がlengthなどで途切れたときのリベンジ(大盛り)用
            MINI: 8000         // 分析レポート用途
          }

        },

        Translation: {
          Source: "",
          Target: "ja"
        },
        // Embedding設定
        Embedding: {
          AzureEndpoint: props.getProperty("AZURE_EMBEDDING_ENDPOINT"),                         // Azure用エンドポイントURL
          OpenAiModel: props.getProperty("OPENAI_EMBEDDING_MODEL") || "text-embedding-3-small", // OpenAI用モデル名
          Dimensions: parseInt(props.getProperty("EMBEDDING_DIMENSIONS") || "256", 10)          // デフォルトを256次元に大幅圧縮（精度劣化は2%未満）
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
      // システム全体の設定値
      System: {
        DataSheetId: props.getProperty("DATA_SHEET_ID") || "ID未設定",
        ConfigSheetId: props.getProperty("CONFIG_SHEET_ID") || "ID未設定",

        Archive: {
          // ここをプロパティから取得するように変更
          FOLDER_ID: props.getProperty("ARCHIVE_FOLDER_ID"), 
          JSON_FILENAME_PREFIX: "YATA_Archive_",
        },

        TimeLimit: {
          COLLECTION: 5 * 60 * 1000,         // 収集ジョブの制限時間 (5分)
          SUMMARIZATION: 5 * 60 * 1000,      // 要約/ベクトル生成の制限時間 (5分)
          REPORT_GENERATION: 280 * 1000,     // レポート生成の制限時間 (GAS制限考慮)
          LOCK_TIMEOUT: 10000                // ＋追加: 多重起動防止のロック待機時間(ms)
        },
        Limits: {
          RSS_CHECK_ROWS: 20000,             // 重複チェック時に遡る行数
          MAX_ITEMS_PER_FEED: parseInt(props.getProperty("SYSTEM_LIMIT_ITEMS_FEED") || "10", 10),            // 1つのRSSから取得する最大記事数
          RSS_DATE_WINDOW_DAYS: 3,           // RSS記事の有効期限 (これより古い記事は取り込まない)
          RSS_CHUNK_SIZE: 5,                 // RSS並列収集のチャンクサイズ
          RSS_INTER_CHUNK_DELAY: 1000,       // チャンク間の待機時間 (ms)
          DATA_RETENTION_MONTHS: 3,          // データの保持期間
          BATCH_SIZE: 30,                    // LLM一括処理時のバッチサイズ
          BATCH_FETCH_DAYS: 30,              // レポート生成時の一括取得日数
          LINKS_PER_TREND: 3,                // トレンドレポートに表示するリンク数
          BACKFILL_DELAY: 500,               // バックフィル時の待機時間 (ms)
          LLM_BATCH_SIZE: parseInt(props.getProperty("SYSTEM_LIMIT_BATCH_SIZE") || "5", 10),                 // 並列要約のバッチサイズ (AzureのTPMに合わせて調整)
          LLM_BATCH_DELAY: 2000,             // 並列要約のバッチ間待機時間(ms)
          VECTOR_GEN_DAYS: 7,                // ベクトル生成・バックフィルの対象期間(日)
          LIGHTEN_DAYS: 35,                  // ベクトルを削除して軽量化する閾値(日)
          HISTORY_RETENTION_DAYS: parseInt(props.getProperty("SYSTEM_LIMIT_RETENTION_DAYS") || "120", 10),       // 過去の要約履歴を保持する日数(日)
          SAFE_MAX_DAYS: 14,                 // 個別レポートの最大遡及日数
          VIZ_MAX_ITEMS: 500,                // 可視化プロットの最大件数
          SEARCH_MAX_RESULTS: 20,            // トレンド分析時の類似検索ヒット上限
          DAILY_DIGEST_SEARCH_LIMIT: 10,     // 日刊ダイジェスト時のKWあたりヒット上限
          HISTORY_CONTEXT_MAX_CHARS: 5000,   // 連想記憶検索時のテキスト上限（トークン溢れ防止）
          RSS_MAX_STRIKES: 3,                // RSS巡回時のブラックリスト入りエラー回数
          TOOL_SEARCH_LIMIT: 5000,           // ツール(英語修正等)で遡る最大行数
          WEB_SUMMARY_MAX_CHARS: 30000,      // Webページ要約時の抽出文字数上限
          WEB_SUMMARY_MIN_CHARS: 50,         // Webページ要約時の最低文字数（少なすぎるとエラー）
          ARCHIVE_SAMPLE_SIZE: 50,           // アーカイブ時にトピック要約に使うタイトルのランダム抽出数
          MAX_SUBJECT_KEYWORDS: 3,           // メール件名に表示するキーワードの最大数
          INSERT_ROW_BUFFER: 50              // シート行拡張時の余裕バッファ行数
        },
        Thresholds: {                        // AIの「感覚」を調整する閾値
          SEMANTIC_SEARCH: parseFloat(props.getProperty("SYSTEM_THRESHOLD_SEMANTIC") || "0.32"),             // 類似記事と判定するコサイン類似度の下限
          HISTORY_MATCH: parseFloat(props.getProperty("SYSTEM_THRESHOLD_HISTORY") || "0.85")                // 過去の履歴と判定する下限
        },
        // 標準HTTPヘッダー
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
        // 予兆（サイン）検知エンジンの設定
        SignalDetection: {
          LOOKBACK_DAYS_MAINSTREAM: 7,  // 主流（重心）計算の対象期間
          LOOKBACK_DAYS_SIGNALS: 3,     // 予兆検知の対象期間（直近）
          OUTLIER_THRESHOLD: parseFloat(props.getProperty("SYSTEM_SIGNAL_OUTLIER") || "0.72"),      // これ以下の類似度なら「主流から外れている」と判定
          NUCLEATION_RADIUS: parseFloat(props.getProperty("SYSTEM_SIGNAL_NUCLEUS") || "0.80"),      // これ以上の類似度なら「核形成（近い概念）」と判定
          MIN_NUCLEI_SOURCES: parseInt(props.getProperty("SYSTEM_SIGNAL_MIN_SOURCES") || "2", 10),        // 核を形成するのに必要な最低ソース数
          MAX_OUTLIERS_TO_PROCESS: 100, // 演算負荷軽減のため一度に処理するアウトライヤー上限
          USE_METHOD_VECTOR: true,      // Topic(何)ではなくMethod(どうやって)で予兆検知する
          MIN_ARTICLES_FOR_ANALYSIS: 5  // 予兆検知に必要な最低記事数
        },
        Budget: {
          CURRENT_COST_KEY: "SYSTEM_COST_ACCUMULATOR",  // 保存用プロパティキー
          LAST_RESET_KEY: "SYSTEM_COST_LAST_RESET",     // リセット日管理キー
          EXCHANGE_RATE: parseFloat(props.getProperty("SYSTEM_EXCHANGE_RATE") || "155.0"),                         // コスト計算用の為替レート(円/ドル)
          // 1M (1,000,000) トークンあたりのドル単価を設定 (スクリプトプロパティで上書き可能)
          RatesPer1M: {
            EMBEDDING: { 
              in: parseFloat(props.getProperty("SYSTEM_RATE_EMBEDDING_IN") || "0.020"), 
              out: 0 
            },
            GEMINI: { 
              in: parseFloat(props.getProperty("SYSTEM_RATE_GEMINI_IN") || "0.010"), 
              out: parseFloat(props.getProperty("SYSTEM_RATE_GEMINI_OUT") || "0.040") 
            },
            NANO: { 
              in: parseFloat(props.getProperty("SYSTEM_RATE_NANO_IN") || "0.200"), 
              out: parseFloat(props.getProperty("SYSTEM_RATE_NANO_OUT") || "1.250") 
            },
            MINI: { 
              in: parseFloat(props.getProperty("SYSTEM_RATE_MINI_IN") || "0.750"), 
              out: parseFloat(props.getProperty("SYSTEM_RATE_MINI_OUT") || "4.500") 
            }
          }
        }
      },
      // UIデザイン・メッセージ設定
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
          BADGE_KEEP_BG: "#f5f5f5", BADGE_KEEP_TXT: "#616161",
          BUTTON_AI: "#8e44ad"  // AI要約ボタンのテーマカラー(紫)
        }
      },
      Messages: {
        REPORT_HEADER_PREFIX: "集計期間：",
        NO_RESULT: "該当記事なし",
        NO_SUMMARY: "見出しが生成できませんでした。",
        LINK_MORE_MD: "その他の記事一覧は[こちらのスプレッドシート](${url})でご覧いただけます。"
      },
      // 各シートの列定義とロジック定数
      UsersSheet: {
        Columns: { NAME: 1, EMAIL: 2, DAY: 3, KWS: 4, SEMANTIC: 5, DAILY_KW_DIGEST: 6 }
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

/**
 * @namespace LlmService
 * @description AI（LLM）との通信を抽象化するエンジン。コスト計算、並列要約、ベクトル生成、フォールバック制御を担当。
 */
const LlmService = (function() {
  const llmConfig = AppConfig.get().Llm;
  
  const budgetConfig = AppConfig.get().System.Budget || {
    CURRENT_COST_KEY: "SYSTEM_COST_ACCUMULATOR",
    LAST_RESET_KEY: "SYSTEM_COST_LAST_RESET"
  };

  let _sessionCostTotal = 0;
  let _executionStats = {};

  // --- Helper Methods ---
  //  nano/mini の既定パラメータを options にマージする（OpenAI用 max_tokens / max_completion_tokens も同期）
  function _mergeDefaultLlmOptions(targetModelType, options = {}) {
    const params = AppConfig.get().Llm.Params;
    const isNano = (targetModelType === "nano");

    const defaultMax =
      (isNano ? params.MaxCompletionTokens?.NANO : params.MaxCompletionTokens?.MINI)
      ?? params.MaxTokens;

    const defaults = {
      // 温度（ただし GPT-5系では送らない方針なので、後段で制御）
      temperature: options.temperature ?? (isNano ? params.Temperature.STRICT : params.Temperature.WRITING),

      // GPT-5系の推論/冗長性（使える場合だけ後段で送る）
      reasoning_effort: options.reasoning_effort ?? (isNano ? params.ReasoningEffort?.NANO : params.ReasoningEffort?.MINI),
      verbosity: options.verbosity ?? (isNano ? params.Verbosity?.NANO : params.Verbosity?.MINI),

      // Azure(Chat Completions)向け
      max_completion_tokens: options.max_completion_tokens ?? defaultMax,

      // OpenAI(Chat Completions)向け（モデルにより max_completion_tokens を使う方が安全な場合がある）
      max_tokens: options.max_tokens ?? defaultMax,
      max_completion_tokens_openai: options.max_completion_tokens_openai ?? defaultMax
    };

    return { ...defaults, ...options };
  }

  // Python SDKのようにURLを自動組み立てする関数
  function _buildAzureUrl(deploymentName) {
    let base = llmConfig.AzureBaseUrl;
    if (!base) return null;
    
    // 末尾のスラッシュを除去して正規化
    if (base.endsWith("/")) base = base.slice(0, -1);
    
    // 組み立て: https://{base}/openai/deployments/{deployment}/chat/completions?api-version={ver}
    return `${base}/openai/deployments/${deploymentName}/chat/completions?api-version=${llmConfig.AzureApiVersion}`;
  }

  function _recordUsage(label) {
    if (!_executionStats[label]) _executionStats[label] = 0;
    _executionStats[label]++;
  }
  

  /**
   * @memberof LlmService
   * @description LLMの使用料金を計算し、スクリプトプロパティに累積保存します。
   * @param {string|Object} inputOrUsage - 入力テキスト、または API から返された usage オブジェクト。
   * @param {string} outputStrOrService - 出力テキスト、またはサービス名。
   * @param {string} [serviceNameArg] - 使用したモデル名（例: "Azure:gpt-5-nano"）。
   */
  function _trackCost(inputOrUsage, outputStrOrService, serviceNameArg) {
    try {
      const props = PropertiesService.getScriptProperties();
      const currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");
      const lastReset = props.getProperty(budgetConfig.LAST_RESET_KEY);

      if (lastReset !== currentMonth) {
        props.setProperty(budgetConfig.CURRENT_COST_KEY, "0");
        props.setProperty(budgetConfig.LAST_RESET_KEY, currentMonth);
      }

      const rates = AppConfig.get().System.Budget.RatesPer1M;
      let rateInput = 0, rateOutput = 0;

      let inputTokens = 0;
      let outputTokens = 0;
      let reasoningTokens = 0;
      let serviceName = "";

      // 引数の判定（新形式: usageオブジェクト vs 旧形式: 文字列）
      if (typeof inputOrUsage === 'object' && inputOrUsage !== null && inputOrUsage.prompt_tokens !== undefined) {
        // --- 🌟 新形式 (API usage データを直接使用) ---
        inputTokens = inputOrUsage.prompt_tokens || 0;
        outputTokens = inputOrUsage.completion_tokens || 0;
        reasoningTokens = inputOrUsage.completion_tokens_details?.reasoning_tokens || 0;
        serviceName = outputStrOrService;
      } else {
        // --- 従来形式 (文字数による概算) ---
        inputTokens = String(inputOrUsage || "").length;
        outputTokens = String(outputStrOrService || "").length;
        serviceName = serviceNameArg || "Unknown";
      }

      const sName = String(serviceName).toLowerCase();

      // モデル名に応じて 1Mあたりの単価を取得
      if (sName.includes("embedding")) { rateInput = rates.EMBEDDING.in; rateOutput = rates.EMBEDDING.out; }
      else if (sName.includes("gemini")) { rateInput = rates.GEMINI.in; rateOutput = rates.GEMINI.out; }
      else if (sName.includes("nano")) { rateInput = rates.NANO.in; rateOutput = rates.NANO.out; }
      else { rateInput = rates.MINI.in; rateOutput = rates.MINI.out; }

      // コスト算出（思考トークンは出力トークンとして計上されるため、outputTokens に含まれている前提）
      const cost = ((inputTokens / 1000000) * rateInput) + ((outputTokens / 1000000) * rateOutput);
      _sessionCostTotal += cost;

      // 💡 重要: 使用回数をインクリメントしてサマリーに反映させる
      _recordUsage(serviceName);

      // 💡 ローカル環境（gas-bridge）の場合、詳細なトークン履歴を保存するためのフックを呼ぶ
      // (GAS環境では ScriptProperties の文字数制限があるため、ここではグローバル関数の存在チェックのみ)
      if (typeof recordDetailedApiUsage_ === 'function') {
        recordDetailedApiUsage_(serviceName, inputTokens, outputTokens, reasoningTokens, cost);
      }

    } catch (e) { Logger.log(`[CostTracker Error] ${e.toString()}`); }
  }
  function saveSessionCost() {
    if (_sessionCostTotal <= 0) return;
    try {
      const props = PropertiesService.getScriptProperties();
      const currentTotal = parseFloat(props.getProperty(budgetConfig.CURRENT_COST_KEY) || "0");
      props.setProperty(budgetConfig.CURRENT_COST_KEY, String(currentTotal + _sessionCostTotal));
      _sessionCostTotal = 0;
    } catch (e) {}
  }

  // HTTP通信の共通関数（デバッグ強化版）
  function _httpFetch(url, options, serviceName) {
    try {
      const res = UrlFetchApp.fetch(url, options);
      const code = res.getResponseCode();
      const content = res.getContentText(); // 中身を取得

      // 200以外ならエラー内容を詳細にログ出力
      if (code !== 200) {
        Logger.log(`⚠️ [API Error] ${serviceName} failed.`);
        Logger.log(`Status: ${code}`);
        Logger.log(`Response: ${content}`); // ここが重要！Azureの言い分が出る
        return null;
      }
      return cleanAndParseJSON_(content);

    } catch (e) {
      // 通信エラー（タイムアウトやDNSエラーなど）
      Logger.log(`❌ [Network Exception] ${serviceName}: ${e.toString()}`);
      
      // もしAzureのコンテンツフィルターに引っかかった場合、例外メッセージに含まれることがある
      if (e.toString().includes("content_filter")) {
        Logger.log("💡 ヒント: Azureのコンテンツフィルターに引っかかりました（暴力・性・自傷などの判定）。");
      }
      return null;
    }
  }

  // --- LLM Callers (URL自動生成版) ---

  // 1. Azure OpenAI (詳細デバッグ版)
  function _callAzureLlm(systemPrompt, userPrompt, deploymentName, azureKey, options = {}) {
    const taskName = options.taskLabel ? ` / Task: ${options.taskLabel}` : "";
    Logger.log(`📡 [LLM Start] Service: Azure / Model: ${deploymentName}${taskName}`);
    _recordUsage(`Azure(${deploymentName})`);
    
    const url = _buildAzureUrl(deploymentName);
    if (!url) {
      Logger.log("❌ Azure Base URL設定なし");
      return null;
    }

    const params = AppConfig.get().Llm.Params;

    // gpt-5系は temperature の任意値が弾かれるので、基本は送らない（=デフォルト1に任せる）
    const payload = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      max_completion_tokens: (options.max_completion_tokens ?? params.MaxTokens)
    };

    if (/json/i.test(systemPrompt) || /json/i.test(userPrompt)) {
      payload.response_format = { type: "json_object" };
    }

    // temperature は「1のときだけ」送る（送らない方が安全）
    if (options.temperature === 1) {
      payload.temperature = 1;
    }

    // GPT-5系の推論/冗長性（未対応なら別パラメータで400になるのでログで判別）
    if (options.reasoning_effort) payload.reasoning_effort = options.reasoning_effort;
    if (options.verbosity) payload.verbosity = options.verbosity;

    // （任意）デバッグ：本当に nano/mini で切り替わっているか見たい場合
    // Logger.log(`🧪 options: effort=${options.reasoning_effort}, verbosity=${options.verbosity}, maxTok=${payload.max_completion_tokens}, temp=${payload.temperature}`);

    const fetchOptions = {
      method: "post",
      contentType: "application/json",
      headers: { "api-key": azureKey, "Accept-Encoding": "gzip" },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    // --- APIレスポンスの詳細解析 ---

    // 1. 生のレスポンスを取得
    let response;
    try {
      response = UrlFetchApp.fetch(url, fetchOptions);
    } catch (e) {
      Logger.log(`❌ [Network Error] Azure通信失敗: ${e.toString()}`);
      return null;
    }

    const code = response.getResponseCode();
    const text = response.getContentText();

    // 2. HTTPステータスが200以外なら即エラーログ
    if (code !== 200) {
      Logger.log(`⚠️ [Azure HTTP Error] Code: ${code}`);
      Logger.log(`Response: ${text.substring(0, 500)}`); // 先頭500文字だけ表示
      return null;
    }

    // 3. JSONパース試行
    const json = cleanAndParseJSON_(text);
    if (!json) {
      Logger.log(`⚠️ [Azure JSON Error] JSONパース失敗。生データ: ${text.substring(0, 200)}...`);
      return null;
    }

    // 4. Azure固有のエラー（200 OKでもエラーが含まれる場合がある）
    if (json.error) {
      Logger.log(`⚠️ [Azure API Error] ${JSON.stringify(json.error)}`);
      return null;
    }

    // 5. 中身とフィルター理由の確認
    if (json.choices && json.choices.length > 0) {
      const choice = json.choices[0];
      const finishReason = choice.finish_reason;
      
      // ここが重要: 終了理由をログに出す
      Logger.log(`ℹ️ [Azure Info] finish_reason: ${finishReason}`);

      if (finishReason === 'content_filter') {
        Logger.log(`❌ [Azure Filter] コンテンツフィルターに引っかかりました（不適切判定）。`);
        Logger.log(`詳細: ${JSON.stringify(choice.content_filter_results || "詳細なし")}`);
        return null;
      }

      if (choice.message && choice.message.content) {
        const content = String(choice.message.content).trim();
        if (content.length > 0) {
          // 成功！
          // 💡 APIレスポンスに usage があればそれを直接渡し、なければ従来の文字数計算にフォールバック
          if (json.usage) {
            _trackCost(json.usage, `Azure:${deploymentName}`);
          } else {
            _trackCost(systemPrompt + userPrompt, content, `Azure:${deploymentName}`);
          }
          return content;
        } else {
          Logger.log("⚠️ [Azure Empty] 生成結果が空文字でした。");
        }
      } else {
        Logger.log("⚠️ [Azure Empty] messageフィールドが存在しません。");
      }
    } else {
      Logger.log(`⚠️ [Azure Format] choices配列が空、または不正です: ${text.substring(0, 200)}`);
    }

    return null;
  }

    function _callOpenAiResponses(systemPrompt, userPrompt, model, apiKey, options = {}) {
      const payload = {
        model: model,
        instructions: systemPrompt,
        input: [
          { role: "user", content: userPrompt }
        ],
        max_output_tokens: options.max_output_tokens || options.max_completion_tokens || 2500,
        reasoning: { effort: options.reasoning_effort || "low" }
      };

      const res = UrlFetchApp.fetch("https://api.openai.com/v1/responses", {
        method: "post",
        contentType: "application/json",
        headers: { "Authorization": `Bearer ${apiKey}` },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      const code = res.getResponseCode();
      const jsonStr = res.getContentText();

      if (code === 429) {
        Logger.log("⚠️ [Responses API] 429 Rate Limit. Sleeping for 1000ms...");
        Utilities.sleep(1000);
        return null;
      }

      let json;
      try {
        json = JSON.parse(jsonStr);
      } catch (e) {
        Logger.log(`❌ [Responses API Error] JSON parse failed: ${jsonStr.substring(0, 200)}`);
        return null;
      }

      if (code !== 200 || json.error) {
        Logger.log(`❌ [Responses API Error] Status: ${code}, Details: ${JSON.stringify(json.error || jsonStr)}`);
        return null;
      }

      let text = null;
      if (json.output && Array.isArray(json.output)) {
        for (const item of json.output) {
          if (item.content) {
            for (const c of item.content) {
              if ((c.type === "output_text" || !c.type) && c.text) {
                text = typeof c.text === "object" ? (c.text.value || JSON.stringify(c.text)) : c.text;
                break;
              }
            }
          }
          if (text) break;
        }
      }

      if (!text || String(text).trim().length < 5) {
        return null;
      }

      if (json.usage) {
        _trackCost(json.usage, `OpenAI:${model}`);
      }
      return String(text).trim();
    }

    function _callOpenAiLlm(systemPrompt, userPrompt, openAiModel, openAiKey, options = {}) {
      const taskName = options.taskLabel ? ` / Task: ${options.taskLabel}` : "";
      Logger.log(`📡 [LLM Start] Service: OpenAI / Model: ${openAiModel}${taskName}`);
      _recordUsage(`OpenAI(${openAiModel})`);

      const params = AppConfig.get().Llm.Params;

      const modelLower = String(openAiModel || "").toLowerCase();
      const isReasoningFamily = /^(gpt-5|o1|o3|o4)/.test(modelLower);

      const payload = {
        model: openAiModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      };

      if (/json/i.test(systemPrompt) || /json/i.test(userPrompt)) {
        payload.response_format = { type: "json_object" };
      }

      if (isReasoningFamily) {
        payload.max_completion_tokens = (options.max_completion_tokens_openai ?? options.max_tokens ?? params.MaxTokens);
      } else {
        payload.max_tokens = (options.max_tokens ?? params.MaxTokens);
      }

      if (!isReasoningFamily) {
        payload.temperature = (options.temperature ?? params.Temperature.WRITING);
      } else {
        if (options.reasoning_effort) payload.reasoning_effort = options.reasoning_effort;
        if (options.verbosity) payload.verbosity = options.verbosity;
      }

      const fetchOptions = {
        method: "post",
        contentType: "application/json",
        headers: { "Authorization": `Bearer ${openAiKey}`, "Accept-Encoding": "gzip" },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      };

      const json = _httpFetch("https://api.openai.com/v1/chat/completions", fetchOptions, "OpenAI");
      if (json && json.choices && json.choices[0] && json.choices[0].message) {
        const content = String(json.choices[0].message.content).trim();
        _trackCost(json.usage, `OpenAI:${openAiModel}`);
        return content;
      }
      return null;
    }

    function _callOpenAiEmbedding(textOrArray, model, apiKey) {
      if (!apiKey) return null;
      _recordUsage("OpenAI(Embedding)");
      const dimensions = AppConfig.get().Llm.Embedding.Dimensions || 256;
      const payload = { model: model, input: textOrArray, dimensions: dimensions };
      const fetchOptions = { method: "post", contentType: "application/json", headers: { "Authorization": `Bearer ${apiKey}`, "Accept-Encoding": "gzip" }, payload: JSON.stringify(payload), muteHttpExceptions: true };
      const json = _httpFetch("https://api.openai.com/v1/embeddings", fetchOptions, "OpenAI Embedding");
      if (!json || !json.data) return null;
      if (Array.isArray(textOrArray)) {
        return json.data.sort((a,b) => a.index - b.index).map(item => item.embedding);
      }
      return json.data[0].embedding;
    }

    function _callAzureEmbedding(textOrArray, endpoint, apiKey) {
      if (!endpoint || !apiKey) return null;
      _recordUsage("Azure(Embedding)");
      const dimensions = AppConfig.get().Llm.Embedding.Dimensions || 256;
      const payload = { input: textOrArray, dimensions: dimensions };
      const fetchOptions = { method: "post", contentType: "application/json", headers: { "api-key": apiKey, "Accept-Encoding": "gzip" }, payload: JSON.stringify(payload), muteHttpExceptions: true };
      const json = _httpFetch(endpoint, fetchOptions, "Azure Embedding");
      if (!json || !json.data) return null;
      if (Array.isArray(textOrArray)) {
        return json.data.sort((a,b) => a.index - b.index).map(item => item.embedding);
      }
      return json.data[0].embedding;
    }

    function _callGeminiLlm(systemPrompt, userPrompt, geminiApiKey, options = {}) {
      const taskName = options.taskLabel ? ` / Task: ${options.taskLabel}` : "";
      Logger.log(`📡 [LLM Start] Service: Gemini / Model: ${llmConfig.MODEL_NAME}${taskName}`);
      _recordUsage("Gemini");
      const params = AppConfig.get().Llm.Params;
      const API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/" + llmConfig.MODEL_NAME + ":generateContent?key=" + geminiApiKey;
      const PROMPT = (systemPrompt || "") + "\n\n" + (userPrompt || "");
      const payload = { 
        contents: [{ parts: [{ text: PROMPT }] }], 
        generationConfig: { 
          temperature: options.temperature ?? params.Temperature.WRITING, 
          maxOutputTokens: params.MaxTokens
        } 
      };

      if (/json/i.test(systemPrompt) || /json/i.test(userPrompt)) {
        payload.generationConfig.responseMimeType = "application/json";
      }

      const fetchOptions = { 
        method: "post", 
        contentType: "application/json", 
        headers: { "Accept-Encoding": "gzip" },
        payload: JSON.stringify(payload), 
        muteHttpExceptions: true 
      };
      const json = _httpFetch(API_ENDPOINT, fetchOptions, "Gemini");
      let text = null;
      if (json && json.candidates && json.candidates[0].content) text = json.candidates[0].content.parts[0].text;
      if (text) _trackCost(PROMPT, text, "Gemini");
      Utilities.sleep(llmConfig.DELAY_MS);
      return text ? String(text).trim() : AppConfig.get().Messages.NO_SUMMARY;
    }

    function _callLlmWithFallback(systemPrompt, userPrompt, targetModelType = "nano", options = {}) {
      const llmProps = llmConfig;
      const context = llmProps.Context; 
      const mergedOptions = _mergeDefaultLlmOptions(targetModelType, options);
      const deploymentName = (targetModelType === "mini") ? llmProps.ModelMini : llmProps.ModelNano;

      const tryAzure = () => {
        if (llmProps.AzureBaseUrl && llmProps.AzureKey) {
          return _callAzureLlm(systemPrompt, userPrompt, deploymentName, llmProps.AzureKey, mergedOptions);
        }
        return null;
      };

      const tryOpenAi = () => {
        if (llmProps.OpenAiKey) {
          const openAiModel = deploymentName;
          const isResponsesTarget = /^(gpt-5|o1|o3|o4)/.test(String(openAiModel).toLowerCase());
          if (isResponsesTarget) {
            return _callOpenAiResponses(systemPrompt, userPrompt, openAiModel, llmProps.OpenAiKey, mergedOptions);
          } else {
            return _callOpenAiLlm(systemPrompt, userPrompt, openAiModel, llmProps.OpenAiKey, mergedOptions);
          }
        }
        return null;
      };

      let result = null;
      if (context === 'PERSONAL') {
        result = tryOpenAi();
        if (!result) result = tryAzure();
      } else {
        result = tryAzure();
        if (!result) result = tryOpenAi();
      }

      if (!result && llmProps.GeminiKey) {
        return _callGeminiLlm(systemPrompt, userPrompt, llmProps.GeminiKey, mergedOptions);
      }

      return result || "いずれのLLMでも生成できませんでした。";
    }

  // --- Public Methods ---
  return {
    getModelInfo: function() {
      return { context: llmConfig.Context, nano: llmConfig.ModelNano, mini: llmConfig.ModelMini };
    },

    /**
     * @function summarizeBatch
     * @memberof LlmService
     * @description 複数記事を並列(バッチ)で要約・抽出します。パース＆件数チェックを含む厳格なリトライエンジン。
     * @param {string[]} articleTexts - 要約対象のテキスト配列。
     * @returns {string[]} 要約結果（JSON文字列）の配列。
     */
    summarizeBatch: function(articleTexts) {
      if (!articleTexts || articleTexts.length === 0) return [];
      
      const BATCH_SIZE = 5;
      const results = new Array(articleTexts.length).fill(null);
      const BATCH_SYSTEM = getPromptConfig_("BATCH_SYSTEM");
      const BATCH_USER_TEMPLATE = getPromptConfig_("BATCH_USER_TEMPLATE");
      const model = (llmConfig.ModelNano) ? llmConfig.ModelNano : "gpt-5-nano";
      
      for (let i = 0; i < articleTexts.length; i += BATCH_SIZE) {
        const chunk = articleTexts.slice(i, i + BATCH_SIZE);
        // 各記事にIDを振り、JSON配列としてパッキング
        const packedArticles = chunk.map((text, idx) => ({ id: String(idx), content: text }));
        const userPrompt = BATCH_USER_TEMPLATE.replace("{articleText}", JSON.stringify(packedArticles, null, 2));
        
        try {
          Logger.log(`🤖 [LlmService] Sending BatchDistillation request (${chunk.length} articles) to ${model}...`);
          
          let parsedResults = null;
          let successAttempt = 0;

          // 論理リトライ (最大3回) - パース＆件数チェックを内包
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const response = _callLlmWithFallback(BATCH_SYSTEM, userPrompt, "nano", { 
                taskLabel: `BatchDistillation-A${attempt}`, 
                max_completion_tokens: 4000,
                reasoning_effort: "low"
              });
              
              if (!response) throw new Error("Empty response");

              // 安全なパース処理
              const cleanResponse = response.replace(/```json/g, "").replace(/```/g, "").trim();
              const parsed = JSON.parse(cleanResponse);

              // 構造チェックの柔軟化
              if (parsed && parsed.results && Array.isArray(parsed.results)) {
                // 正常な複数件フォーマット
                if (parsed.results.length !== chunk.length) {
                  throw new Error(`Count mismatch: Expected ${chunk.length}, Got ${parsed.results.length}`);
                }
                parsedResults = parsed.results;
              } else if (parsed && chunk.length === 1) {
                // 1件のみの場合、単一オブジェクト形式でも受け入れる
                // IDがなければ補完する
                if (!parsed.id) parsed.id = "0";
                parsedResults = [parsed];
              } else {
                throw new Error("Invalid JSON structure (Missing 'results' array and not a single object)");
              }

              // すべての検証をパスしたらループを抜ける
              successAttempt = attempt;
              break;
            } catch (retryError) {
              Logger.log(`⚠️ [LlmService] Attempt ${attempt} failed: ${retryError.message}`);
              if (attempt === 3) throw new Error("All retries failed: " + retryError.message);
            }
          }
          
          // IDに基づいて元の順序を復元して格納
          Logger.log(`✅ [LlmService] Batch Success (Size: ${chunk.length}, Retries: ${successAttempt - 1})`);
          parsedResults.forEach(res => {
            const idx = parseInt(res.id, 10);
            if (!isNaN(idx) && idx >= 0 && idx < chunk.length) {
              results[i + idx] = JSON.stringify(res);
            }
          });

        } catch (e) {
          Logger.log(`🔄 [LlmService] BatchDistillation totally failed (${e.message}). Falling back to individual processing...`);
          // 失敗時は1記事ずつ個別に要約（最終安全策）
          for (let j = 0; j < chunk.length; j++) {
            if (!results[i + j]) {
              Logger.log(`   - Falling back for article ${i + j + 1}/${articleTexts.length}`);
              results[i + j] = LlmService.summarize(chunk[j], true);
            }
          }
        }
      }
      return results;
    },

    // 1. 単一記事の要約（バッチ処理が失敗したときのフォールバック等）
    summarize: function(articleText, isRevenge = false) {
      const options = { taskLabel: isRevenge ? "単一要約(リベンジ🔥)" : "単一要約(フォールバック)" };
      
      // 💡 AppConfigからリベンジ用のトークン数を取得して上書き
      if (isRevenge) {
        const revengeTokens = AppConfig.get().Llm.Params.MaxCompletionTokens.NANO_REVENGE || 2000;
        options.max_completion_tokens = revengeTokens;
        options.max_tokens = revengeTokens;
        options.max_completion_tokens_openai = revengeTokens;
      }

      return _callLlmWithFallback(
        getPromptConfig_("BATCH_SYSTEM"), 
        getPromptConfig_("BATCH_USER_TEMPLATE") + ["", "記事: ---", articleText, "---"].join("\n"), 
        "nano",
        options
      );
    },

    // 2. トレンド分析（記事群からレポートのセクションを作る）
    generateTrendSections: function(articlesGroupedByKeyword, linksPerTrend, hitKeywords, previousSummary = null, options = {}) {
      let SYSTEM = options.promptKeys?.system ? getPromptConfig_(options.promptKeys.system) : getPromptConfig_("TREND_SYSTEM");
      let USER_TEMPLATE = options.promptKeys?.user ? getPromptConfig_(options.promptKeys.user) : getPromptConfig_(previousSummary ? "TREND_USER_TEMPLATE_WITH_HISTORY" : "TREND_USER_TEMPLATE");
      if (!SYSTEM || !USER_TEMPLATE) return "プロンプト設定エラー";
      
      const allTrends = [];
      const execOptions = { temperature: options.temperature ?? AppConfig.get().Llm.Params.Temperature.WRITING };

      for (const keyword of hitKeywords) {
        const articles = articlesGroupedByKeyword[keyword];
        if (!articles || articles.length === 0) continue;
        // 🌟 [極限効率化] 構造化JSONから「Unknown」を排除し、論理的順序で再構成した高密度コンテキストを生成
        const articleListForLlm = articles.map(a => {
          const context = getArticleContextForAnalysis_(a);
          return `- タイトル: ${a.title}\n  要点: ${context}\n  URL: ${a.url}`;
        }).join("\n\n");
        let userPrompt = USER_TEMPLATE;
        if (previousSummary) userPrompt = userPrompt.replace('{previous_summary}', previousSummary);
        userPrompt = userPrompt.includes('{article_list}') ? userPrompt.replace('{article_list}', articleListForLlm) : userPrompt + '\n' + articleListForLlm;
        
        const mergedOptions = { ...execOptions, taskLabel: "トレンド分析(セクション生成)" };
        const txt = _callLlmWithFallback(SYSTEM, userPrompt, "mini", mergedOptions);
        if (txt && txt.trim()) allTrends.push(txt.trim());
      }
      return allTrends.join("\n\n---\n\n");
    },

    // 3. コンテキストの圧縮や、Webページの全体要約など
    summarizeReport: function(systemPrompt, reportText) {
      return _callLlmWithFallback(systemPrompt, reportText, "nano", { taskLabel: "長文/コンテキスト圧縮" });
    },

    // 4. 日刊ダイジェストの生成
    generateDailyDigest: function(systemPrompt, userPrompt) {
        return _callLlmWithFallback(systemPrompt, userPrompt, "mini", { taskLabel: "日刊ダイジェスト" });
    },

    // 5. 予兆検知などの高度な分析
    analyzeKeywordSearch: function(systemPrompt, contextText, options = {}) {
        // 既存の options を尊重しつつ、指定がなければ mini / デフォルトタスク名を適用
        return _callLlmWithFallback(systemPrompt, contextText, options.model || "mini", { ...options, taskLabel: options.taskLabel || "予兆検知/インサイト分析" });
    },

    // 6. Method Vector抽出
    extractMethodDescriptor: function(title, abstractText) {
        const systemPrompt = getPromptConfig_("METHOD_EXTRACTION_SYSTEM");
        const userPrompt = `Title: ${title}\nAbstract: ${abstractText}`;
        const descriptor = _callLlmWithFallback(systemPrompt, userPrompt, "nano", { temperature: 0.0,taskLabel: "Method(測定手法)抽出" });
        if (!descriptor || String(descriptor).trim() === "") return "Unknown";
        return String(descriptor).trim();
    },

    // 7. 記事Vector抽出

    /**
     * @description 指定されたテキストの埋め込みベクトル（Embedding）を生成します。
     * @param {string} text - ベクトル化するテキスト。
     * @returns {number[]|null} 256次元（既定）の数値配列。失敗時はnull。
     */
    generateVector: function(text) {
      const context = llmConfig.Context;
      const embConfig = llmConfig.Embedding;
      let vector = null;
      // Embeddingはロジック変更なし（そのまま）
      if (context === 'PERSONAL') {
        if (llmConfig.OpenAiKey) vector = _callOpenAiEmbedding(text, embConfig.OpenAiModel, llmConfig.OpenAiKey);
        if (!vector && embConfig.AzureEndpoint && llmConfig.AzureKey) vector = _callAzureEmbedding(text, embConfig.AzureEndpoint, llmConfig.AzureKey);
      } else {
        if (embConfig.AzureEndpoint && llmConfig.AzureKey) vector = _callAzureEmbedding(text, embConfig.AzureEndpoint, llmConfig.AzureKey);
        if (!vector && llmConfig.OpenAiKey) vector = _callOpenAiEmbedding(text, embConfig.OpenAiModel, llmConfig.OpenAiKey);
      }
      return vector ? vector.map(v => parseFloat(v.toFixed(6))) : null;
    },
    generateVectorBatch: function(texts) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const context = llmConfig.Context;
      const embConfig = llmConfig.Embedding;
      let vectors = null;
      
      if (context === 'PERSONAL') {
        if (llmConfig.OpenAiKey) vectors = _callOpenAiEmbedding(texts, embConfig.OpenAiModel, llmConfig.OpenAiKey);
        if (!vectors && embConfig.AzureEndpoint && llmConfig.AzureKey) vectors = _callAzureEmbedding(texts, embConfig.AzureEndpoint, llmConfig.AzureKey);
      } else {
        if (embConfig.AzureEndpoint && llmConfig.AzureKey) vectors = _callAzureEmbedding(texts, embConfig.AzureEndpoint, llmConfig.AzureKey);
        if (!vectors && llmConfig.OpenAiKey) vectors = _callOpenAiEmbedding(texts, embConfig.OpenAiModel, llmConfig.OpenAiKey);
      }
      
      if (!vectors || !Array.isArray(vectors)) return new Array(texts.length).fill(null);
      // 各ベクトルを丸めて返す
      return vectors.map(vec => vec ? vec.map(v => parseFloat(v.toFixed(6))) : null);
    },
    getSessionCost: function() { return _sessionCostTotal; },
    saveSessionCost: saveSessionCost,
    logSessionTotal: function() {
      const statsParts = [];
      for (const [key, count] of Object.entries(_executionStats)) statsParts.push(`${key}: ${count}回`);
      const statsStr = statsParts.length > 0 ? `📊 [Usage] ${statsParts.join(", ")}` : "";
      
      const props = PropertiesService.getScriptProperties();
      const monthTotal = parseFloat(props.getProperty("SYSTEM_COST_ACCUMULATOR") || "0");
      
      const EXCHANGE_RATE = AppConfig.get().System.Budget.EXCHANGE_RATE; 
      const sessionYen = _sessionCostTotal * EXCHANGE_RATE;
      const monthYen = monthTotal * EXCHANGE_RATE;

      // statsStrが空でも、コスト情報を常に出力するように変更
      const finalLog = statsStr 
        ? `${statsStr}\n💰 [API Cost] 今回: $${_sessionCostTotal.toFixed(6)} (約 ${sessionYen.toFixed(2)} 円) / 今月: $${monthTotal.toFixed(4)} (約 ${Math.round(monthYen)} 円)`
        : `💰 [API Cost] 今回: $0.000000 (0円) / 今月: $${monthTotal.toFixed(4)} (約 ${Math.round(monthYen)} 円)`;
      
      Logger.log(finalLog);
    }
  };
})();


/**
 * @description ベクトル空間上の「主流（重心）」から外れた記事群から、同期的に発生している新しいトレンドの芽（核）を検知します。
 * @returns {Object|null} 検知されたシグナルのレポート（Markdown/HTML）と統計情報。
 */
const EmergingSignalEngine = (function() {
  
  function detect() {
    const config = AppConfig.get().System.SignalDetection;
    const mainstreamArticles = _getArticlesForDetection(config.LOOKBACK_DAYS_MAINSTREAM);
    const recentArticles = mainstreamArticles.filter(a => isRecentArticle_(a.date, config.LOOKBACK_DAYS_SIGNALS));
    
    const minArticles = AppConfig.get().System.SignalDetection.MIN_ARTICLES_FOR_ANALYSIS || 5;
    if (mainstreamArticles.length < minArticles) {
      Logger.log("分析に必要な記事数が不足しています。");
      return null;
    }

    const centroid = _calculateAverageVector(mainstreamArticles);
    if (!centroid) return null;

    const outliers = recentArticles
      .map(a => {
        const sim = calculateCosineSimilarity_(centroid, a.vector);
        return { ...a, similarityToCentroid: sim };
      })
      .filter(a => a.similarityToCentroid < config.OUTLIER_THRESHOLD)
      .sort((a, b) => a.similarityToCentroid - b.similarityToCentroid) 
      .slice(0, config.MAX_OUTLIERS_TO_PROCESS);

    Logger.log(`主流記事数: ${mainstreamArticles.length} / アウトライヤー候補: ${outliers.length}`);

    if (outliers.length < 2) return null;

    const nuclei = _detectNuclei(outliers, config);
    Logger.log(`検知された核（Nuclei）の数: ${nuclei.length}`);

    if (nuclei.length === 0) return null;

    return _generateReportWithLLM(nuclei);
  }

  function _getArticlesForDetection(days) {
    const { start, end } = getDateWindow_(days);
    const sh = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return [];

    const config = AppConfig.get().System.SignalDetection;
    const useMethodVector = config.USE_METHOD_VECTOR;
    const targetVectorColIdx = (useMethodVector && AppConfig.get().CollectSheet.Columns.METHOD_VECTOR) 
                               ? AppConfig.get().CollectSheet.Columns.METHOD_VECTOR - 1 
                               : AppConfig.get().CollectSheet.Columns.VECTOR - 1;
    
    // METHOD_VECTOR列（8列目）まで確実に取得する
    const colsToFetch = Math.max(AppConfig.get().CollectSheet.Columns.VECTOR, AppConfig.get().CollectSheet.Columns.METHOD_VECTOR || 0);
    const data = sh.getRange(2, 1, lastRow - 1, colsToFetch).getValues();
    
    const articles = [];

    for (const r of data) {
      const date = new Date(r[0]);
      if (date >= start && date < end) {
        const vecStr = r[targetVectorColIdx];
        if (!vecStr || String(vecStr).includes("[Error]") || String(vecStr).includes("Unknown")) continue;
        
        const vec = parseVector_(vecStr);
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

        const sim = calculateCosineSimilarity_(outliers[i].vector, outliers[j].vector);
        if (sim >= config.NUCLEATION_RADIUS) {
          currentNucleus.push(outliers[j]);
          sources.add(outliers[j].source);
        }
      }

      if (sources.size >= config.MIN_NUCLEI_SOURCES) {
        nuclei.push({
          articles: currentNucleus,
          sourceCount: sources.size,
          averageSimilarity: _calculateInnerSimilarity(currentNucleus)
        });
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
        totalSim += calculateCosineSimilarity_(articles[i].vector, articles[j].vector);
        count++;
      }
    }
    return totalSim / count;
  }

  function _generateReportWithLLM(nuclei) {
    const model = AppConfig.get().Llm.ModelMini;
    const SYSTEM_PROMPT = getPromptConfig_("SIGNAL_DETECTION_SYSTEM");
    const USER_TEMPLATE = getPromptConfig_("SIGNAL_DETECTION_USER");

    if (!SYSTEM_PROMPT || !USER_TEMPLATE) {
      Logger.log("エラー: 予兆検知用のプロンプト設定が不足しています。");
      return null;
    }

    // 💡 絶対文字化けしないためのプレースホルダーを使用
    let fullMarkdown = "# [EMOJI_VIAL] Emerging Signals Report\n\n既存の主要トレンドから乖離しつつ、異なる記事間で「共通の手法・アプローチ」が使われ始めた予兆（サイン）を検知しました。\n\n";

    nuclei.forEach((nucleus, index) => {
      const articleListText = nucleus.articles.map(a => {
        const context = getArticleContextForAnalysis_(a);
        return `- タイトル: ${a.title}\n  内容: ${context}\n  URL: ${a.url}`;
      }).join("\n\n");

      let userPrompt = USER_TEMPLATE
        .replace("${article_list}", articleListText)
        .replace("{article_list}", articleListText)
        .replace("${index}", index + 1);
      
      const analysis = LlmService.analyzeKeywordSearch(
        SYSTEM_PROMPT, 
        userPrompt, 
        { temperature: AppConfig.get().Llm.Params.Temperature.INSIGHT }
      );
      
      const parsed = cleanAndParseJSON_(analysis);
      
      // 元のプロンプトのフォーマット (signals配列) に対応
      if (parsed && Array.isArray(parsed.signals)) {
        parsed.signals.forEach(sig => {
          fullMarkdown += `### [EMOJI_BULB] ${sig.name}\n`;
          
          // 💡 どの記事が合体してこの予兆になったのか、ここでリストアップする！
          fullMarkdown += `- **関連する情報源（合体した記事）:**\n`;
          nucleus.articles.forEach(a => {
              fullMarkdown += `  - [${a.title}](${a.url})\n`;
          });
          
          fullMarkdown += `- **既存技術との差分:** ${sig.difference}\n`;
          fullMarkdown += `- **共通Concept:** ${sig.concept}\n`;
          fullMarkdown += `- **将来の変化:** ${sig.workflow_change}\n\n---\n\n`;
        });
      } else {
        fullMarkdown += analysis + "\n\n---\n\n";
      }
    });

    let finalHtml = _formatSignalHtml(fullMarkdown);
    // 💡 最後にプレースホルダーを安全なHTMLエンティティに置換！これで文字化けは絶対に起きない！
    finalHtml = finalHtml.replace(/\[EMOJI_VIAL\]/g, '&#129514;').replace(/\[EMOJI_BULB\]/g, '&#128161;');

    return {
      markdown: fullMarkdown,
      html: finalHtml,
      nucleiCount: nuclei.length
    };
  }

  function _formatSignalHtml(markdown) {
    const baseHtml = markdownToHtml_(markdown);
    const C = AppConfig.get().UI.Colors;
    
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

// #endregion

// =============================================================================
// #region 2. ENTRY POINTS (Triggers & Web)
// 【責務】外部からのアクセスを受け付ける「玄関」。
//  - トリガー実行されるジョブ関数 (runXxxJob)
//  - Webアプリケーションの入り口 (doGet)
//  - クライアントサイドへのデータ提供
// =============================================================================

/**
 * @description RSSを巡回し、最新記事を収集してシートに保存します。AI要約は行いません。
 */
function runCollectionJob() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(AppConfig.get().System.TimeLimit.LOCK_TIMEOUT)) {
    Logger.log("⚠️ 他のジョブが実行中のため、収集ジョブをスキップしました。");
    return;
  }

  try {
    Logger.log("--- 収集ジョブ開始 ---");
    
    // 高機能アーカイブ＆削除を実行
    // 頻繁に実行しても「3ヶ月前」が来るまでは何もせず即終了するので負荷はありません
    // archiveAndPruneOldData();

    // 1か月前のHistoryを削除
    // maintenancePruneDigestHistory();
    
    // ベクトル軽量化(30日経過データ)の実行
    // maintenanceLightenOldArticles();

    collectRssFeeds_();       
    // sortCollectByDateDesc_(); 

    // アーカイブ処理などでAIを使った場合に備えてコストを表示 & 保存
    LlmService.logSessionTotal();
    LlmService.saveSessionCost(); // 一括保存
    
    Logger.log("--- 収集ジョブ完了 ---");
  } catch (e) {
    Logger.log("収集ジョブエラー: " + e.toString());
  } finally {
    lock.releaseLock();
  }
}

/**
 * @description 未要約の記事に対してAIによる見出し生成とベクトル化を一括実行します。
 */
function runSummarizationJob() {
  const lock = LockService.getScriptLock();
  
  if (!lock.tryLock(AppConfig.get().System.TimeLimit.LOCK_TIMEOUT)) {
    Logger.log("⚠️ 他のジョブが実行中のため、要約ジョブをスキップしました。");
    return;
  }

  try {
    Logger.log("--- 要約ジョブ開始 ---");
    processSummarization_();  // メイン処理

    // 今回のコスト合計を出力
    LlmService.logSessionTotal();

    Logger.log("--- 要約ジョブ完了 ---");
  } catch (e) {
    Logger.log("要約ジョブエラー: " + e.toString());
  } finally {
    LlmService.saveSessionCost(); // 一括保存
    lock.releaseLock();
  }
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
      // 【修正】管理者に予兆検知レポートを送信する
      const adminMail = AppConfig.get().Digest.mailTo;
      sendDigestEmail_(
        null, // ヘッダーはHTML内で組まれているため不要
        report.html,
        null,
        1,
        {
          recipient: adminMail, // 管理者のみに送信
          isHtml: true,
          subjectOverride: `【YATA\uD83D\uDEA8予兆検知】Emerging Signal Report (${fmtDate_(new Date())})`
        }
      );
      Logger.log("予兆レポートの送信を完了しました。");
    } else {
      Logger.log("今回の実行では新たな「核形成（予兆）」は検知されませんでした。");
    }

    // 今回のコスト合計を出力
    LlmService.logSessionTotal();
    LlmService.saveSessionCost(); // 一括保存

  } catch (e) {
    _logError_("runEmergingSignalJob", e, "予兆検知ジョブ中に致命的なエラーが発生しました。");
  }
  Logger.log("--- 予兆（サイン）検知ジョブ完了 ---");
}

/** dailyDigestJob: 日刊ダイジェスト生成 - 過去24時間の全記事（キーワードフィルタリングあり） */
function dailyDigestJob() {
  Logger.log("--- 日刊KW Digest開始 ---");

  const DAYS_WINDOW = AppConfig.get().System.DateWindows.DAILY_DIGEST_JOB;
  const { start, end } = getDateWindow_(DAYS_WINDOW);

  const allItems = getArticlesInDateWindow_(start, end);
  if (allItems.length === 0) return;

  const usersSheet = getSheet_(AppConfig.get().SheetNames.USERS);
  const usrCols = AppConfig.get().UsersSheet.Columns;

  const users = usersSheet.getRange(
    2, 1,
    usersSheet.getLastRow()-1,
    Object.keys(usrCols).length
  ).getValues();

  users.forEach(user => {
    const email = String(user[usrCols.EMAIL-1]).trim();
    const kwRaw = String(user[usrCols.KWS-1]).trim();
    const dailyFlag = user[usrCols.DAILY_KW_DIGEST-1];

    if (!email) return;
    if (dailyFlag !== true) return;
    if (!kwRaw) return;

    const keywords = kwRaw.split(',').map(k=>k.trim());
    const useSemantic = user[usrCols.SEMANTIC-1] === true;

    let filteredArticles = [];

    if (useSemantic) {
      const dailySearchLimit = AppConfig.get().System.Limits.DAILY_DIGEST_SEARCH_LIMIT;
      keywords.forEach(kw => {
        const semHits = performSemanticSearch_(kw, allItems, dailySearchLimit);
        filteredArticles = filteredArticles.concat(semHits);
      });
      const seen = new Set();
      filteredArticles = filteredArticles.filter(a=>{
        if (seen.has(a.url)) return false;
        seen.add(a.url);
        return true;
      });
    } else {
      filteredArticles = filterArticlesByKeywords_(allItems, keywords);
    }

    if (filteredArticles.length === 0) return;

    const systemPrompt = getPromptConfig_("DAILY_DIGEST_SYSTEM");
    const userPromptTemplate = getPromptConfig_("DAILY_DIGEST_USER");

    const articleListText = formatArticlesForLlm_(filteredArticles);
    let userPrompt = userPromptTemplate.replace(/\$\{all_articles_in_date_window\}/g, articleListText);
    
    // LLMからJSONを取得
    let reportBody = LlmService.generateDailyDigest(systemPrompt, userPrompt);

    // JSONをパースして絶対に崩れないMarkdownに組み立てる
    const parsed = cleanAndParseJSON_(reportBody);
    let finalMarkdown = `## 本日のハイライト（KW: ${keywords.join(", ")}）\n\n`;
    
    if (parsed && Array.isArray(parsed.highlights)) {
      parsed.highlights.forEach((h, i) => {
        // 各トピックを ### にすることで、カードが分割されるように変更
        finalMarkdown += `### ${i+1}. ${h.title} (重要度: ${h.importance})\n`;
        finalMarkdown += `- **カテゴリ:** ${h.category}\n`;
        finalMarkdown += `- **解説:** ${h.description}\n`;
        if (h.links && Array.isArray(h.links) && h.links.length > 0) {
          finalMarkdown += `- **関連URL:**\n  ${h.links.join("\n  ")}\n\n`;
        } else {
          finalMarkdown += "\n";
        }
      });
      reportBody = finalMarkdown;
    }

    reportBody = markdownToHtml_(reportBody);
    
    sendDigestEmail_(
      null, reportBody, keywords.map(k => ({label:k})), 1,
      { recipient: email, isHtml: true }
    );
  });

  Logger.log("--- 日刊KW Digest完了 ---");
}

/**
 * sendPersonalizedReport (ステートフル改良版)
 * Usersシートの設定に基づき、対象期間を動的に変更してレポートを送信する。
 * 【改良点】
 * 前回送信成功日時をプロパティに保存し、次回実行時に「前回〜今回」の差分を確実に埋める。
 * これにより、ジョブが失敗しても次回の実行で期間を自動延長してカバーする。
 */
function sendPersonalizedReport() {
  const usersSheet = getSheet_(AppConfig.get().SheetNames.USERS);
  const keywordsSheet = getSheet_(AppConfig.get().SheetNames.KEYWORDS);
  
  if (!usersSheet || !keywordsSheet) return;

  // プロパティサービス（記憶領域）の準備
  const props = PropertiesService.getScriptProperties();

  // 1. 日付・マスター設定取得
  const daysMap = ["日", "月", "火", "水", "木", "金", "土"];
  const now = new Date(); // 実行時点の「現在」
  const currentDayStr = daysMap[now.getDay()];
  
  const kwCols = AppConfig.get().KeywordsSheet.Columns;
  const trueMarkers = AppConfig.get().Logic.TRUE_MARKERS;
  const lastRowKw = keywordsSheet.getLastRow();
  const masterData = lastRowKw >= 2 ? keywordsSheet.getRange(2, 1, lastRowKw - 1, Object.keys(kwCols).length).getValues() : [];
  
  // 今日のデフォルト配信対象（キーワード指定なしユーザー用）
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

  // 【安全策】最大遡及日数の設定（久しぶりに実行した場合のガード）
  const SAFE_MAX_DAYS = AppConfig.get().System.Limits.SAFE_MAX_DAYS;

  // 一括取得：動的期間に対応するため、少し余裕を持って多めに取得しておく
  // Configの設定値か、SAFE_MAX_DAYSの大きい方を使う
  const FETCH_DAYS = Math.max(AppConfig.get().System.Limits.BATCH_FETCH_DAYS, SAFE_MAX_DAYS);
  Logger.log(`ユーザーレポート生成: 記事データのバッチ取得を開始 (過去${FETCH_DAYS}日分)...`);
  
  const allRecentArticles = fetchRecentArticlesBatch_(FETCH_DAYS);
  Logger.log(`バッチ取得完了: ${allRecentArticles.length} 件`);

  // 2. ユーザー取得
  const usrCols = AppConfig.get().UsersSheet.Columns;
  const lastRowUsr = usersSheet.getLastRow();
  const users = lastRowUsr >= 2 ? usersSheet.getRange(2, 1, lastRowUsr - 1, Object.keys(usrCols).length).getValues() : [];

  // 3. ユーザーごとのループ
  users.forEach(user => {
    
    const dailyKwFlag = user[usrCols.DAILY_KW_DIGEST-1];

    // daily KW Digestユーザーはpersonalreportをスキップ
    if (dailyKwFlag === true) {
      Logger.log("[Skip] Daily KW Digest user → personalreport停止");
      return;
    }

    const name = user[usrCols.NAME - 1];
    const email = String(user[usrCols.EMAIL - 1]).trim();
    const userDay = String(user[usrCols.DAY - 1]).trim();
    const userKeywordsRaw = String(user[usrCols.KWS - 1]).trim();
    const useSemanticForUser = user[usrCols.SEMANTIC - 1] === true;

    if (!email) return;

    // --- モード判定と対象期間の決定 ---
    let targetQueries = [];
    let displayLabels = [];
    let isPersonalized = false;
    let runThisUser = false;
    let defaultWindowDays = 0; // 初回実行時のデフォルト

    // 日刊か週刊かの判定
    if (userDay === "") {
      // ■ 日刊モード (毎日配信)
      runThisUser = true;
      defaultWindowDays = AppConfig.get().System.DateWindows.DAILY_REPORT; // 通常1〜2日
    } else {
      // ■ 週刊モード (曜日指定あり)
      if (userDay === currentDayStr) {
        runThisUser = true;
        defaultWindowDays = AppConfig.get().System.DateWindows.WEEKLY_REPORT; // 通常7日
      }
    }

    if (!runThisUser) return; // 今日は配信日ではない

    // キーワード設定
    if (userKeywordsRaw !== "") {
      targetQueries = userKeywordsRaw.split(',').map(k => k.trim());
      displayLabels = targetQueries;
      isPersonalized = true;
    } else {
      // キーワードなし → 今日の総合ニュース (日刊のみ)
      if (todaysQueries.length > 0) {
        targetQueries = todaysQueries;
        displayLabels = todaysLabels;
      } else {
        return; // 配信対象なし
      }
    }

    // 【改良】期間の計算ロジック (Stateful)
    // プロパティキー: ユーザーごとに「前回いつ送ったか」を保存
    // キー文字数制限などを考慮し、emailをハッシュ化しても良いが、ここでは簡易に置換
    const propKey = `LAST_REPORT_SENT_${email.replace(/[.@]/g, '_')}`;
    const lastSentStr = props.getProperty(propKey);

    let startDate;
    
    if (lastSentStr) {
      // 履歴がある場合: 前回の送信時刻を開始点にする
      startDate = new Date(lastSentStr);
      Logger.log(`${name}様: 前回の送信記録(${lastSentStr})から差分を抽出します。`);
    } else {
      // 履歴がない場合(初回): デフォルトの日数分戻る
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - defaultWindowDays);
      startDate.setHours(0, 0, 0, 0); // 初回は0時から
      Logger.log(`${name}様: 初回実行のため、デフォルト期間(${defaultWindowDays}日)を使用します。`);
    }

    // 終了日: 現在時刻
    const endDate = new Date(now);

    // 【安全策】期間が長すぎる場合（例: エラーで1ヶ月止まっていた）、14日前にキャップする
    const safetyLimitDate = new Date(now);
    safetyLimitDate.setDate(safetyLimitDate.getDate() - SAFE_MAX_DAYS);
    
    if (startDate < safetyLimitDate) {
      Logger.log(`警告: ${name}様の未送信期間が長すぎます。直近${SAFE_MAX_DAYS}日分のみに制限します。`);
      startDate = safetyLimitDate;
    }

    // 期間表示用日数（メール件名等の判定用）
    const effectiveDaysWindow = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));

    // メモリ上の記事配列をフィルタリング (日付範囲チェック)
    const targetArticles = allRecentArticles.filter(a => {
      // start <= articleDate < end
      return a.date >= startDate && a.date < endDate;
    });

    const targetItems = targetQueries.map((q, i) => ({ query: q, label: displayLabels[i] }));
    
    // レポート生成 (HTML)
    const reportHtml = generateTrendReportHtml_(targetArticles, targetItems, startDate, endDate, {
      useSemantic: useSemanticForUser,
      dateRangeStr: `${fmtDate_(startDate)} 〜 ${fmtDate_(endDate)}` // 期間明記
    });

    // 記事がない、または生成結果が空の場合はスキップ
    // ※ ただし「記事がない」こと自体が正しい結果である場合（毎日実行など）は
    //    日付だけ更新したいケースもあるが、今回は「送信成功＝更新」とする
    if (!reportHtml) {
      Logger.log(`[Skip] ${name}様: 対象期間(${effectiveDaysWindow}日)に該当記事なし`);
      // 記事がない場合も「チェックした」ことにして日付を進めるならここで setProperty する
      // 今回は「送信しなかった＝次回まとめて送る」思想で更新しない（ステイ）
      return;
    }

    // 件名作成
    const maxKw = AppConfig.get().System.Limits.MAX_SUBJECT_KEYWORDS || 3;
    const labelSummary = displayLabels.slice(0, maxKw).join(', ') + (displayLabels.length > maxKw ? '...' : '');
    const dateStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'MM/dd');
    let subjectPrefix = isPersonalized ? "【YATA】My AI Report: " : "【YATA】Daily Trend: ";
    if (useSemanticForUser) subjectPrefix += "[Semantic] ";

    // 期間が通常より長い場合は件名で通知
    if (effectiveDaysWindow > (defaultWindowDays + 2)) {
       subjectPrefix += `[合併号 ${effectiveDaysWindow}日分] `;
    }

    const subject = `${subjectPrefix}${labelSummary} (${dateStr})`;
    
    try {
      // メール送信
      sendDigestEmail_(null, reportHtml, null, effectiveDaysWindow, {
        recipient: email,
        isHtml: true,
        subjectOverride: subject,
        bcc: AppConfig.get().Digest.mailTo
      });
      
      // 【重要】送信成功時のみ、タイムスタンプを更新する
      // これにより、途中でエラーが出ても次回実行時にリトライされる
      props.setProperty(propKey, endDate.toISOString());

      Logger.log(`[Sent] ${name}様へ送信完了 (Days: ${effectiveDaysWindow}, Semantic: ${useSemanticForUser})`);
      
    } catch (e) {
      _logError_("sendPersonalizedReport.forEach", e, `${name}様への送信失敗`);
      // 送信失敗時はプロパティを更新しないため、次回再送される
    }
  });
}

/**
 * doGet: Webアプリケーションのルーティング制御
 */
function doGet(e) {
  // パラメータ ?p=viz があれば可視化画面を表示
  if (e.parameter.p === 'viz') {
    return HtmlService.createTemplateFromFile('Visualize').evaluate()
      .setSandboxMode(HtmlService.SandboxMode.IFRAME)
      .setTitle('YATA - 3D Vector Space');
  }

  // それ以外はいつもの検索画面
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setSandboxMode(HtmlService.SandboxMode.IFRAME)
    .setTitle('YATA - AI Intelligence Platform');
}

/**
 * @description ウェブUIからのキーワード検索リクエストを受け取り、トレンドレポートを生成してHTMLで返します。
 * @param {string} keyword - 検索キーワード。
 * @param {Object} [clientOptions={}] - UIから渡されるオプション（開始日、終了日、検索方式等）。
 * @returns {string} 分析結果のHTML文字列。
 */
function executeWeeklyDigest(keyword, clientOptions = {}) {
  try {
    const trimmedKeyword = String(keyword || "").trim();
    Logger.log(`Web UIから入力されたキーワード: "${trimmedKeyword}"`);

    // runTrendAnalysis に委譲
    return runTrendAnalysis_(trimmedKeyword, {
      days: AppConfig.get().UI.WebDefaults.SEARCH_DAYS,
      startDate: clientOptions.startDate,
      endDate: clientOptions.endDate,
      returnHtml: true,
      isHtmlOutput: true, 
      enableHistory: false, // Web検索では履歴を使わない
      
      // クライアントからの指定があればそれを使う
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
 * searchAndAnalyzeKeyword
 * 【責務】Index.html からの呼び出し互換性のためのエイリアス。
 */
function searchAndAnalyzeKeyword(keyword, options) {
  return executeWeeklyDigest(keyword, options);
}

/**
 * [Server-side] getVisualizationData
 * 可視化用に最新記事のベクトルデータを取得して返す
 * 【修正版】新しい順（上から）取得するように変更
 */
function getVisualizationData() {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  const LIMIT = AppConfig.get().System.Limits.VIZ_MAX_ITEMS;
  const startRow = 2;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const numRows = Math.min(LIMIT, lastRow - 1);
  const data = sheet.getRange(startRow, 1, numRows, 7).getValues();
  const vectorColIdx = 6; // G列

  return data
    .map(r => {
      const vector = parseVector_(r[vectorColIdx]);
      if (!vector) return null;
      return {
        t: r[1],
        u: r[2],
        s: r[5],
        v: vector
      };
    })
    .filter(Boolean);
}

/**
 * @description 毎時0分/30分のトリガーを判定し、収集ジョブと要約ジョブを交互に割り振るディスパッチャー。
 */
function jobDispatcher() {
  const now = new Date();
  const minute = now.getMinutes();

  Logger.log(`[Dispatcher] 現在時刻: ${now.toTimeString()} (分: ${minute})`);

  if (minute < 30) {
    // --- 前半: 収集タイム ---
    Logger.log("👉 前半(0-29分)なので「収集ジョブ」を実行します。");
    runCollectionJob();
  } else {
    // --- 後半: 要約タイム ---
    Logger.log("👉 後半(30-59分)なので「要約ジョブ」を実行します。");
    runSummarizationJob();
  }
}

/**
 * 毎晩自動実行する「日次メンテナンス」
 * 実行時間：約14秒（爆速！）
 */
function runDailyMaintenance() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(AppConfig.get().System.TimeLimit.LOCK_TIMEOUT)) {
    Logger.log("⚠️ 日次メンテナンス：ロック取得失敗(他のジョブが実行中の可能性があるため、メンテナンスをスキップします。");
    return;
  }

  try {
    Logger.log("--- 日次メンテナンス開始 ---");
    
    archiveAndPruneOldData();         // 1. アーカイブ
    maintenancePruneDigestHistory();   // 2. 要約履歴削除
    maintenanceLightenOldArticles();   // 3. ベクトル削除（軽量化）

    LlmService.logSessionTotal();
    LlmService.saveSessionCost();
    
    Logger.log("--- 日次メンテナンス完了 ---");
  } catch (e) {
    Logger.log("日次メンテナンスエラー: " + e.toString());
  } finally {
    lock.releaseLock();
  }
}

/**
 * 手動、または月1回程度で実行する「重メンテナンス」
 * 注意：データ量が多いとタイムアウトの可能性あり
 */
function runHeavyMaintenance() {
  // ここに removeDuplicates() だけを切り出す
  // 必要に応じて LockService も入れる
  Logger.log("--- 重複排除ジョブ開始 ---");
  removeDuplicates();
  Logger.log("--- 重複排除ジョブ完了 ---");
}

// #endregion

// =============================================================================
// #region 3. REPORTING LOGIC (Generation & Delivery)
// 【責務】ユーザーに届ける「アウトプット」の生成。
//  - トレンドレポートのHTML組み立て
//  - LLMによる記事分析・コメント生成
//  - メール送信・宛先管理
// =============================================================================

/**
 * @description 検索結果の記事群から、AIによるトレンド分析を含むHTMLレポートを生成します。
 * @param {Object[]} allArticles - 検索対象となる全記事オブジェクトの配列。
 * @param {Object[]} targetItems - 検索対象のクエリとラベルの配列。
 * @param {Date} startDate - 対象期間の開始日。
 * @param {Date} endDate - 対象期間の終了日。
 * @param {Object} [options={}] - useSemantic(ベクトル検索)、isHtmlOutput(Web用出力)等のフラグ。
 * @returns {string|null} 生成されたHTML文字列。該当記事がない場合はnull。
 */
function generateTrendReportHtml_(allArticles, targetItems, startDate, endDate, options = {}) {
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
            <p style="${S.HEADER_SUB}">${AppConfig.get().Messages.REPORT_HEADER_PREFIX}${fmtDate_(startDate)} 〜 ${fmtDate_(endDate)}</p>
          </div>`;
  } else {
    // Web用スタイル (CSS)
    finalHtmlBody += `<style>.summary-section{background-color:${C.BG_CARD};padding:20px;border-radius:8px;margin-bottom:25px;box-shadow:0 2px 5px rgba(0,0,0,0.05)}.summary-title{margin-top:0;color:${C.SECONDARY};font-size:18px;font-weight:bold;border-bottom:2px solid ${C.BORDER};padding-bottom:10px;margin-bottom:15px}.section-header{border-left:5px solid ${C.PRIMARY};border-bottom:none;padding-left:10px;padding-bottom:0;color:${C.SECONDARY};margin-top:30px;margin-bottom:15px;font-size:20px}.tech-card{margin-bottom:20px;border:none;padding:20px;border-radius:8px;background-color:${C.BG_CARD};box-shadow:0 2px 8px rgba(0,0,0,0.08);border-left:5px solid ${C.PRIMARY}}.tech-title{margin:0 0 15px 0;color:${C.SECONDARY};font-size:17px;font-weight:bold;line-height:1.4}.tech-meta{font-size:15px;line-height:1.7;color:${C.TEXT_SUB}}.tech-link{margin-top:15px;text-align:left}.tech-link a{display:inline-block;padding:8px 16px;background-color:${C.BADGE_NEW_BG};color:${C.PRIMARY};text-decoration:none;border-radius:20px;font-size:13px;font-weight:bold}.tech-link a:hover{background-color:${C.BADGE_NEW_BG}}</style>`;
  }

  const procStartTime = new Date().getTime();
  const TIME_LIMIT_MS = AppConfig.get().System.TimeLimit.REPORT_GENERATION; 

  // デフォルト設定: useSemanticが指定されていない場合は false (キーワード一致) とする
  const useSemantic = (options.useSemantic === true);

  for (const item of targetItems) {
    if (new Date().getTime() - procStartTime > TIME_LIMIT_MS) {
      finalHtmlBody += `<p style="color:red; font-weight:bold; text-align:center;">⚠️ 時間制限のため、一部のトピック解析を中断しました。</p>`;
      break;
    }

    let query = item.query; // 変更: const を let に
    const label = item.label || query;
    let matched = [];

    // 🌟 【追加】セマンティック検索じゃない場合のみ、AIでクエリを英語・略称に拡張
    if (!useSemantic) {
      query = expandKeywordQuery_(query);
    }

    // 検索方式の分岐 (セマンティック検索 or キーワード検索)
    if (useSemantic) {
      // A. セマンティック検索 (ベクトル)
      // ※ performSemanticSearch は内部でシートからデータを取るので allArticles は使わない
      const maxResults = AppConfig.get().System.Limits.SEARCH_MAX_RESULTS;
      matched = performSemanticSearch_(query, allArticles, maxResults);
    } else {
      // B. 従来型キーワード検索 (AND/OR/NOT対応)
      // 引数で渡された allArticles からフィルタリング
      matched = allArticles.filter(art => {
        const content = (art.title + " " + art.headline + " " + art.abstractText);
        return isTextMatchQuery_(content, query);
      });
    }

    if (matched.length === 0) continue;

    const result = processKeywordAnalysisWithHistory_(query, matched, options);
    
    if (result && result.reportBody) {
      hasContent = true;
      let contentBody = result.reportBody;
      if (query !== label) contentBody = contentBody.split(query).join(label);

      if (options.isHtmlOutput) {
        // Web用
        let htmlConverted = markdownToHtml_(contentBody);
        let cleanHtml = htmlConverted.replace(/```html/gi, "").replace(/```/g, "");

        // リンクを見つけて「AI要約ボタン」を挿入する処理
        cleanHtml = cleanHtml.replace(
          /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, 
          (match, url, text) => {
             // 一意なIDを生成
             const uniqueId = "summary-" + Math.random().toString(36).substring(2, 10);
             const btnColor = C.BUTTON_AI || "#8e44ad";
             const btnStyle = `background-color:${btnColor}; color:#fff; border:none; border-radius:12px; padding:3px 10px; font-size:11px; cursor:pointer; margin-right:8px; vertical-align:middle; font-weight:bold;`;
             
             // ボタンと要約表示エリアを埋め込む
              return `
               <span style="display:inline-block; margin: 4px 0;">
                 <button onclick="fetchSummary('${url}', '${uniqueId}', this)" style="${btnStyle}">⚡ AI要約</button>
                 <a href="${url}" target="_blank" style="text-decoration:none; color:#2980b9; font-weight:bold;">${text}</a>
               </span>
               <div id="${uniqueId}" style="display:none; margin:10px 0 15px 0; padding:12px; background:#f8f9fa; border-left:4px solid ${btnColor}; border-radius:4px; font-size:90%; line-height:1.6; color:#333; text-align: left;"></div>
             `;
          }
        );

        const searchTypeLabel = useSemantic ? "🤖 AI意味検索" : "🔍 キーワード検索";
        
        finalHtmlBody += `<div style="margin-bottom: 15px; color: #666; font-size: 14px;">
          <div style="font-weight: bold;">${searchTypeLabel}ヒット: ${matched.length}件 (Concept: ${label})</div>
          <div style="font-size: 12px; margin-top: 4px;">📅 検索期間: ${options.dateRangeStr || fmtDate_(startDate) + " 〜 " + fmtDate_(endDate)}</div>
        </div>`;
        finalHtmlBody += cleanHtml;
      } else {
        // メール用 (カードデザイン)
        const markdownHtml = markdownToHtml_(contentBody);
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

/** * generateWeeklyReportWithLLM (オプション対応) 
 */
function generateWeeklyReportWithLLM_(articles, hitKeywordsWithCount, articlesGroupedByKeyword, previousSummary = null, options = {}) {
  const LINKS_PER_TREND = AppConfig.get().System.Limits.LINKS_PER_TREND;
  const hitKeywords = hitKeywordsWithCount.map(item => item.keyword);
  const trends = LlmService.generateTrendSections(articlesGroupedByKeyword, LINKS_PER_TREND, hitKeywords, previousSummary, options);
  return { reportBody: trends };
}

/**
 * 【共通エンジン】キーワード分析プロセッサー（安全バッジ対応版）
 */
function processKeywordAnalysisWithHistory_(keyword, articles, options = {}) {
  let previousSummary = null;
  if (options.enableHistory !== false) {
    // 検索用コンテキストが長すぎるとEmbeddingでエラーになるため、先頭5000文字程度に制限
    const maxChars = AppConfig.get().System.Limits.HISTORY_CONTEXT_MAX_CHARS || 5000;
    const contextForSearch = articles.map(a => a.title).join(" ").substring(0, maxChars);
    previousSummary = _getRelevantHistory_(keyword, contextForSearch);
  }

  const { reportBody } = generateWeeklyReportWithLLM_(articles, [{ keyword: keyword, count: articles.length }], { [keyword]: articles }, previousSummary, options);
  if (!reportBody || reportBody.trim() === "") return null;

  const parsedJson = cleanAndParseJSON_(reportBody);
  let finalMarkdown = "";
  
  if (parsedJson) {
    const isNoChange = (parsedJson.isNoChange === true || String(parsedJson.isNoChange).toLowerCase() === "true");
    
    if (Array.isArray(parsedJson.topics)) {
      const topicBlocks = [];
      if (parsedJson.landscape) topicBlocks.push(`> **概況:** ${parsedJson.landscape}`);
      
      parsedJson.topics.forEach(topic => {
        // --- リンクを安全な暗号（プレースホルダー）に変換 ---
        let linksMd = "";
        if (topic.links) {
          const rawLinks = String(topic.links).replace(/\\n/g, "\n").split("\n");
          const validLinks = rawLinks.map(url => url.replace(/[\s\(\)\[\]<>]/g, "").trim()).filter(url => url.startsWith("http"));
          if (validLinks.length > 0) {
            linksMd = "\n- **SOURCES:** " + validLinks.map((url, idx) => `[[BADGE|${idx + 1}|${url}]]`).join(" ");
          }
        }

        let block = `### ${topic.title || keyword}\n`;
        
        // 💡 履歴ありモード（last_week / this_week がある場合）
        if (topic.last_week || topic.this_week) {
          const lastW = String(topic.last_week || "なし").trim();
          if (lastW !== "なし" && lastW !== "None" && lastW !== "") {
            block += `- **先週:** ${lastW}\n`;
          }
          block += `- **今週:** ${topic.this_week || "なし"}\n`;
        } 
        // 💡 Web検索・履歴なしモード（summary がある場合）
        else if (topic.summary) {
          block += `- **概要:** ${topic.summary}\n`;
        }

        // 共通の影響とリンクを出力
        block += `- **影響:** ${topic.impact || "なし"}${linksMd}`;
        topicBlocks.push(block);
      });
      finalMarkdown = topicBlocks.join("\n\n");
    }
  }

  let isNoChangeFlag = parsedJson ? (parsedJson.isNoChange === true || String(parsedJson.isNoChange).toLowerCase() === "true") : false;
  let nextContext = null;
  
  if (options.enableHistory !== false && options.saveHistory !== false) {
    nextContext = isNoChangeFlag && previousSummary ? previousSummary : _generateContextForNextWeek_(finalMarkdown);
    if (nextContext) _writeHistory_(keyword, nextContext);
  }

  if (isNoChangeFlag) return { reportBody: null, summary: nextContext };

  return { reportBody: finalMarkdown, summary: nextContext };
}

/**
 * @description ダイジェストメールを送信します。MarkdownからHTMLへの変換もここで行います。
 * @param {string|null} headerLine - メールの冒頭に表示する期間情報などのテキスト。
 * @param {string} bodyContent - レポート本文（Markdown形式）。
 * @param {Array|null} subjectKeywords - 件名に含めるキーワード情報。
 * @param {number} [daysWindow=7] - レポートの対象日数（件名のプレフィックス判定に使用）。
 * @param {Object} [options={}] - 宛先指定(recipient)、HTML直渡し(isHtml)等の設定。
 */
function sendDigestEmail_(headerLine, bodyContent, subjectKeywords, daysWindow = 7, options = {}) {
  const digestConfig = AppConfig.get().Digest;
  
  const to = options.recipient || getRecipients_();
  
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
    const footerHtml = markdownToHtml_(`\n---\n${footerMd}`);
    fullHtmlBody = `<div style="font-family: Meiryo, 'Hiragino Sans', 'MS PGothic', sans-serif; font-size: 14px; line-height: 1.7; color: #333;">${htmlHeader}${bodyContent}<br><br>${footerHtml}</div>`;
  } else {
    const fullMdBodyWithFooter = bodyContent + `\n\n---\n${footerMd}`;
    const htmlHeader = headerLine ? headerLine.replace(/\n/g, '<br>') : "";
    const htmlContent = markdownToHtml_(fullMdBodyWithFooter);
    fullHtmlBody = `<div style="font-family: Meiryo, 'Hiragino Sans', 'MS PGothic', sans-serif; font-size: 14px; line-height: 1.7; color: #333;">${htmlHeader}<br><br>${htmlContent}</div>`;
  }
  
  const plainBody = options.isHtml ? stripHtml_(fullHtmlBody) : (headerLine + "\n\n" + bodyContent);

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

/**
 * @description 配信先メールアドレスリスト（カンマ区切り）を生成します。
 * @returns {string} 配信先メールアドレスのカンマ区切り文字列。
 */
function getRecipients_() {
  const adminMail = AppConfig.get().Digest.mailTo;
  const sheet = getSheet_(AppConfig.get().SheetNames.USERS);
  const recipientSet = new Set();

  if (adminMail) {
    adminMail.split(',').forEach(e => {
      if (e.trim()) recipientSet.add(e.trim());
    });
  }

  if (sheet && sheet.getLastRow() >= 2) {
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
    data.forEach(row => {
      const email = String(row[1] || "").trim();
      if (email) recipientSet.add(email); // ← Day列条件を外す
    });
  }

  return Array.from(recipientSet).join(',');
}

// #endregion

// =============================================================================
// #region 4. MEMORY & HISTORY LOGIC
// 【責務】過去の文脈を管理する「記憶」の操作。
//  - 来週への引き継ぎ用コンテキスト圧縮
//  - 過去履歴の検索（キーワード一致 & ベクトル連想検索）
//  - 履歴シートへの保存
// =============================================================================

/**
 * @description 来週のAI分析のために、今回のレポート内容を損失なく高密度に圧縮します。
 * @param {string} reportText - 今回生成されたレポート本文。
 * @returns {string} 圧縮されたコンテキスト文字列。
 */
function _generateContextForNextWeek_(reportText) {
  if (!reportText || reportText.trim() === "") return "";
  
  Logger.log("来週への引き継ぎ用コンテキスト圧縮を開始します。");
  
  // 履歴作成には少し賢いモデル(Mini)を使うことで、文脈の理解度を上げる
  // (コストを極限まで下げるならNanoのままでも可ですが、記憶維持ならMini推奨)
  const model = AppConfig.get().Llm.ModelMini; 
  
  // プロンプトキーを専用のものに変更
  const SYSTEM_PROMPT = getPromptConfig_("CONTEXT_COMPRESSION_SYSTEM");
  
  if (!SYSTEM_PROMPT) {
      Logger.log("コンテキスト圧縮用プロンプト(CONTEXT_COMPRESSION_SYSTEM)が見つかりません。");
      return "";
  }
  
  // LlmServiceを使って圧縮を実行
  // (summarizeReportメソッドを流用しますが、中身はコンテキスト圧縮です)
  // ※LlmService側に直接 model を渡せるよう _callLlmWithFallback を使うか、
  //   LlmService.analyzeKeywordSearch などを流用して実装します。
  
  // 簡易実装として LlmService.analyzeKeywordSearch (Miniモデル使用) を流用する場合:
  const compressedText = LlmService.analyzeKeywordSearch(SYSTEM_PROMPT, reportText, {
    temperature: 0.0 // 事実重視なのでランダム性を排除
  });

  Logger.log(`コンテキスト圧縮完了: ${compressedText.length}文字`);
  return compressedText;
}

/**
 * @description キーワード一致またはベクトル類似度を用い、関連する過去の分析履歴を取得します。
 * @param {string} keyword - 検索キーワード。
 * @param {string} currentContextText - 比較対象となる現在の記事テキスト。
 * @returns {string|null} 過去のコンテキスト。見つからない場合はnull。
 */
function _getRelevantHistory_(keyword, currentContextText) {
  const sheet = getSheet_(AppConfig.get().SheetNames.DIGEST_HISTORY);
  if (!sheet || sheet.getLastRow() < 2) return null;

  // D列(Vector)まで取得
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues(); 
  
  // 1. 直近検索 (キーワード完全一致)
  // 下から上へ検索し、最新のものを探す
  for (let i = data.length - 1; i >= 0; i--) {
    if (String(data[i][1]).trim() === keyword) {
      Logger.log(`履歴発見(Keyword): 「${keyword}」の前回要約を採用。`);
      return String(data[i][2]);
    }
  }

  // 2. 連想検索 (Vector Search)
  // キーワードで見つからなかった場合、今回扱う内容に近い過去の事例を探す
  if (!currentContextText) return null;

  Logger.log(`履歴なし(Keyword): 連想記憶検索を開始します...`);
  const queryVector = LlmService.generateVector(currentContextText);
  if (!queryVector) return null;

  let bestSim = -1;
  let bestSummary = null;
  const SIMILARITY_THRESHOLD = AppConfig.get().System.Thresholds.HISTORY_MATCH; // 関連性が高いとみなす閾値

  for (let i = 0; i < data.length; i++) {
    const vecStr = data[i][3]; // D列: Vector
    if (!vecStr) continue;

    const histVector = parseVector_(vecStr);
    if (!histVector) continue;

    // 💡 爆速化: 現行の生成経路（または再正規化済み）のベクトル同士を前提に、計算コストの低い内積（Dot Product）を使用
    const sim = calculateDotProduct_(queryVector, histVector);
    
    // より似ているものがあれば更新
    if (sim > bestSim) {
      bestSim = sim;
      bestSummary = data[i][2]; // C列: Summary
    }
  }

  if (bestSim >= SIMILARITY_THRESHOLD) {
    Logger.log(`履歴発見(Vector): 類似度${bestSim.toFixed(3)}の過去コンテキストを採用しました。`);
    return bestSummary;
  }

  Logger.log("履歴なし: 関連する過去コンテキストは見つかりませんでした。");
  return null;
}

/**
 * _writeHistory (連想記憶対応版)
 * 【責務】DigestHistoryシートに「圧縮コンテキスト」とその「ベクトル」を書き込む
 */
function _writeHistory_(keyword, summary) {
  try {
    const sheet = getSheet_(AppConfig.get().SheetNames.DIGEST_HISTORY);
    if (!sheet) return;

    // コンテキストの意味ベクトルを生成
    // (要約自体をベクトル化することで、内容での検索を可能にする)
    const vector = LlmService.generateVector(summary);
    const vectorStr = vector ? vector.join(',') : "";

    // [日付, キーワード, 要約, ベクトル] の順で保存
    sheet.appendRow([new Date(), keyword, summary, vectorStr]);
    
    Logger.log(`履歴保存(Vector付): キーワード「${keyword}」を記録しました。`);
  } catch (e) {
    _logError_("_writeHistory", e, "履歴書き込みエラー");
  }
}

// #endregion

// =============================================================================
// #region 5. ANALYSIS LOGIC (Summarization)
// 【責務】収集データに対する「加工・付加価値づけ」。
//  - 記事の要約生成（要約ジョブ）
//  - ベクトル生成と保存
//  - 過去記事へのベクトル一括付与（バックフィル）
// =============================================================================


/**
 * @description 指定されたキーワードと期間に基づき、記事抽出・AI分析・レポート生成を一気通貫で実行します。
 * @param {string} targetKeyword - 検索キーワード。
 * @param {Object} options - days(遡り日数)、startDate/endDate、useSemantic(ベクトル検索)等のオプション。
 * @returns {string|void} returnHtml=true時はHTML文字列、それ以外はメール送信。
 */
function runTrendAnalysis_(targetKeyword, options = {}) {
  const config = AppConfig.get().Digest;
  const returnHtml = options.returnHtml || false;
  
  // 期間設定: 片方だけの指定も許容するロジック (Web UIでの入力漏れ対策)
  let start, end;
  
  if (options.startDate || options.endDate) {
    const today = new Date();
    
    // Endの日付決定 (指定がなければ今日)
    if (options.endDate) {
      end = new Date(options.endDate);
    } else {
      end = new Date(today);
    }
    // Endはその日の終わり(23:59:59)まで含める
    end.setHours(23, 59, 59, 999);

    // Startの日付決定 (指定がなければEndの30日前)
    if (options.startDate) {
      start = new Date(options.startDate);
    } else {
      start = new Date(end);
      start.setDate(start.getDate() - 30);
    }
    // Startはその日の始まり(00:00:00)から
    start.setHours(0, 0, 0, 0);

  } else {
    // 日付指定が全くない場合 (デフォルト挙動: Configの日数に従う)
    const daysWindow = options.days || config.days;
    const window = getDateWindow_(daysWindow);
    start = window.start;
    end = window.end;
  }
  
  const allArticles = getArticlesInDateWindow_(start, end);
  
  // 表示用の期間文字列
  const dateRangeStr = `${fmtDate_(start)} 〜 ${fmtDate_(end)}`;

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

  // 共通エンジンでレポート生成
  const htmlContent = generateTrendReportHtml_(allArticles, targetItems, start, end, options);

  if (returnHtml) return htmlContent || "<div>分析結果が得られませんでした。</div>";
  
  // メール送信 (Web以外からの呼び出し時)
  if (htmlContent && (config.notifyChannel === "email" || config.notifyChannel === "both")) {
    const headerLine = AppConfig.get().Messages.REPORT_HEADER_PREFIX + dateRangeStr;
    
    sendDigestEmail_(headerLine, htmlContent, null, 7, {
      isHtml: true,
      subjectPrefix: config.mailSubjectPrefix || "【TrendAnalysis】"
    });
  }
}

/**
 * processSummarization (大規模データ対応・素材ベース・完全版)
 */
function processSummarization_() {
  const trendDataSheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  if (!trendDataSheet) return;
  const lastRow = trendDataSheet.getLastRow();
  if (lastRow < 2) return;

  const startTime = new Date().getTime();
  const TIME_LIMIT_MS = AppConfig.get().System.TimeLimit.SUMMARIZATION;
  const VECTOR_GENERATION_WINDOW_DAYS = AppConfig.get().System.Limits.VECTOR_GEN_DAYS; 
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - VECTOR_GENERATION_WINDOW_DAYS);
  cutoffDate.setHours(0, 0, 0, 0);

  const VECTOR_COL_INDEX = AppConfig.get().CollectSheet.Columns.VECTOR - 1; 
  const SUMMARY_COL_INDEX = AppConfig.get().CollectSheet.Columns.SUMMARY - 1;
  const TITLE_COL_INDEX = AppConfig.get().CollectSheet.Columns.URL - 2;
  const ABSTRACT_COL_INDEX = AppConfig.get().CollectSheet.Columns.ABSTRACT - 1;
  const METHOD_VECTOR_COL_INDEX = AppConfig.get().CollectSheet.Columns.METHOD_VECTOR - 1;

  const dateValues = trendDataSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let targetRowCount = 0;
  for (let i = 0; i < dateValues.length; i++) {
    if (new Date(dateValues[i][0]) < cutoffDate) { targetRowCount = i; break; }
    targetRowCount = i + 1;
  }
  if (targetRowCount === 0) return;

  // 🌟 [重要] 読み込み範囲を Q列(17) まで確実に広げるように変更
  const maxCol = Math.max(trendDataSheet.getLastColumn(), AppConfig.get().CollectSheet.Columns.KEYWORDS);
  const dataRange = trendDataSheet.getRange(2, 1, targetRowCount, maxCol);
  const values = dataRange.getValues();

  const articlesToSummarize = []; 
  let minModifiedIndex = -1; let maxModifiedIndex = -1;

  for (let i = 0; i < values.length; i++) {
    if (new Date().getTime() - startTime > TIME_LIMIT_MS) break;
    const row = values[i];
    const hasNoHeadline = (!row[SUMMARY_COL_INDEX] || String(row[SUMMARY_COL_INDEX]).trim() === "");
    const hasHeadlineButNoVector = (!hasNoHeadline && (!row[VECTOR_COL_INDEX] || String(row[VECTOR_COL_INDEX]).trim() === ""));

    if (hasNoHeadline) {
      // 🌟 全記事バッチ投入 (isShort廃止)
      articlesToSummarize.push({ originalRowIndex: i, title: row[TITLE_COL_INDEX], abstractText: row[ABSTRACT_COL_INDEX] });
    } else if (hasHeadlineButNoVector) {
      _generateAndSetVector(values[i], row[TITLE_COL_INDEX], String(row[SUMMARY_COL_INDEX]), VECTOR_COL_INDEX);
      _markModified(i);
    }
  }

  Logger.log(`要約対象記事: ${articlesToSummarize.length} 件`);

  if (articlesToSummarize.length > 0) {
    const BATCH_SIZE = AppConfig.get().System.Limits.LLM_BATCH_SIZE;
    for (let i = 0; i < articlesToSummarize.length; i += BATCH_SIZE) {
      if (new Date().getTime() - startTime > TIME_LIMIT_MS) break;
      const chunk = articlesToSummarize.slice(i, i + BATCH_SIZE);
      const batchResults = LlmService.summarizeBatch(chunk.map(a => `Title: ${a.title}\nAbstract: ${a.abstractText}`));
      
      const textsToEmbed = []; const methodsToEmbed = []; const extractedMethods = []; const successfulIndices = [];

      batchResults.forEach((jsonString, idx) => {
        const article = chunk[idx];
        const parsedJson = cleanAndParseJSON_(jsonString);
        if (parsedJson) {
          values[article.originalRowIndex][SUMMARY_COL_INDEX] = JSON.stringify(parsedJson);

          // JSONの中身を各カラムに展開して格納
          const C = AppConfig.get().CollectSheet.Columns;
          values[article.originalRowIndex][C.TLDR - 1] = parsedJson.tldr || "";
          values[article.originalRowIndex][C.WHO - 1]  = parsedJson.who || "";
          values[article.originalRowIndex][C.WHAT - 1] = parsedJson.what || "";
          values[article.originalRowIndex][C.WHEN - 1] = parsedJson.when || "";
          values[article.originalRowIndex][C.WHERE - 1]= parsedJson.where || "";
          values[article.originalRowIndex][C.WHY - 1]  = parsedJson.why || "";
          values[article.originalRowIndex][C.HOW - 1]  = parsedJson.how || "";
          values[article.originalRowIndex][C.RESULT - 1]= parsedJson.result || "";
          
          // keywordsは配列なのでカンマ区切りの文字列に変換
          values[article.originalRowIndex][C.KEYWORDS - 1] = Array.isArray(parsedJson.keywords) ? parsedJson.keywords.join(", ") : (parsedJson.keywords || "");
          
          const kw = (parsedJson.keywords && Array.isArray(parsedJson.keywords)) ? parsedJson.keywords.join(' ') : "";
          textsToEmbed.push(`Title: ${article.title || ""}\nKeywords: ${kw}`);

          const mSource = `What: ${parsedJson.what || "Unknown"} How: ${parsedJson.how || "Unknown"}`;
          methodsToEmbed.push(mSource);
          extractedMethods.push(mSource); // 🌟 ペアリング用に保存

          successfulIndices.push(article.originalRowIndex);
          _markModified(article.originalRowIndex);
        }
      });
      
      if (textsToEmbed.length > 0) {
        const combinedVectors = LlmService.generateVectorBatch(textsToEmbed.concat(methodsToEmbed));
        const half = textsToEmbed.length;
        const vResults = combinedVectors.slice(0, half);
        const mVResults = combinedVectors.slice(half);

        vResults.forEach((vector, idx) => {
          const rowIdx = successfulIndices[idx];
          if (vector) values[rowIdx][VECTOR_COL_INDEX] = vector.join(',');
          // 🌟 分割した後半を H列 に保存
          if (METHOD_VECTOR_COL_INDEX > 0 && mVResults[idx]) {
            values[rowIdx][METHOD_VECTOR_COL_INDEX] = mVResults[idx].join(',');
          }
        });
      }
      Utilities.sleep(1000);
    }
  }

  if (minModifiedIndex !== -1) {
    const outputRange = trendDataSheet.getRange(minModifiedIndex + 2, 1, maxModifiedIndex - minModifiedIndex + 1, maxCol);
    outputRange.setValues(values.slice(minModifiedIndex, maxModifiedIndex + 1));
  }

  function _markModified(idx) {
    if (minModifiedIndex === -1 || idx < minModifiedIndex) minModifiedIndex = idx;
    if (idx > maxModifiedIndex) maxModifiedIndex = idx;
  }

  function _generateAndSetVector(rowArray, title, summary, vecColIdx) {
    const parsed = cleanAndParseJSON_(summary);
    const kw = (parsed && parsed.keywords) ? (Array.isArray(parsed.keywords) ? parsed.keywords.join(' ') : parsed.keywords) : summary;
    const v = LlmService.generateVector(`Title: ${title}\nKeywords: ${kw}`);
    if (v) rowArray[vecColIdx] = v.join(',');
    if (METHOD_VECTOR_COL_INDEX > 0) {
      // 🌟 APIコスト削減: 既存のJSON(parsed)からHow/Whatを抽出し、Method Vectorの材料として再利用（LLMの2回目コールを廃止）
      let mDesc = "Unknown";
      if (parsed) {
        const h = (parsed.how && parsed.how !== "Unknown") ? parsed.how : "";
        const w = (parsed.what && parsed.what !== "Unknown") ? parsed.what : "";
        const t = (parsed.tldr && parsed.tldr !== "Unknown") ? parsed.tldr : "";
        mDesc = h || w || t || title || "Unknown";
      } else {
        mDesc = title || "Unknown";
      }
      const mv = LlmService.generateVector(`Topic: ${title} / Method: ${mDesc}`);
      if (mv) rowArray[METHOD_VECTOR_COL_INDEX] = mv.join(',');
    }
  }
}

/**
 * backfillVectors (メモリ最適化版)
 * 【責務】ベクトル未付与の記事に対してEmbeddingを一括実行
 * 【最適化】日付列だけを先にスキャンし、対象期間（直近30日）のデータのみをメモリに展開する。
 */
function backfillVectors() {
  const trendDataSheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  if (!trendDataSheet) return;
  const lastRow = trendDataSheet.getLastRow();
  if (lastRow < 2) return;

  const TARGET_WINDOW_DAYS = AppConfig.get().System.Limits.VECTOR_GEN_DAYS; 
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - TARGET_WINDOW_DAYS);

  const VECTOR_COL_INDEX = AppConfig.get().CollectSheet.Columns.VECTOR - 1;
  const METHOD_VECTOR_COL_INDEX = AppConfig.get().CollectSheet.Columns.METHOD_VECTOR - 1;
  const SUMMARY_COL_INDEX = AppConfig.get().CollectSheet.Columns.SUMMARY - 1;
  const TITLE_COL_INDEX = AppConfig.get().CollectSheet.Columns.URL - 2;

  const dateValues = trendDataSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let targetRowCount = 0;
  for (let i = 0; i < dateValues.length; i++) {
    if (new Date(dateValues[i][0]) < thresholdDate) { targetRowCount = i; break; }
    targetRowCount = i + 1;
  }
  if (targetRowCount === 0) return;

  const maxCol = Math.max(trendDataSheet.getLastColumn(), VECTOR_COL_INDEX + 1, (METHOD_VECTOR_COL_INDEX + 1 || 0));
  const dataRange = trendDataSheet.getRange(2, 1, targetRowCount, maxCol);
  const values = dataRange.getValues();
  
  let processedCount = 0;
  let minIdx = -1; let maxIdx = -1;

  for (let i = 0; i < values.length; i++) {
    const headline = values[i][SUMMARY_COL_INDEX];
    if (headline && String(headline).trim() !== "") {
      let updated = false;
      const parsed = cleanAndParseJSON_(headline);
      if (!values[i][VECTOR_COL_INDEX]) {
        const kw = (parsed && parsed.keywords) ? (Array.isArray(parsed.keywords) ? parsed.keywords.join(' ') : parsed.keywords) : headline;
        const v = LlmService.generateVector(`Title: ${values[i][TITLE_COL_INDEX]}\nKeywords: ${kw}`);
        if (v) { values[i][VECTOR_COL_INDEX] = v.join(','); updated = true; }
      }
      if (METHOD_VECTOR_COL_INDEX > 0 && !values[i][METHOD_VECTOR_COL_INDEX]) {
        // 🌟 APIコスト削減: 既存のJSON(parsed)からHow/Whatを抽出して再利用（LLMの2回目コールを廃止）
        let mDesc = "Unknown";
        if (parsed) {
          const h = (parsed.how && parsed.how !== "Unknown") ? parsed.how : "";
          const w = (parsed.what && parsed.what !== "Unknown") ? parsed.what : "";
          const t = (parsed.tldr && parsed.tldr !== "Unknown") ? parsed.tldr : "";
          mDesc = h || w || t || values[i][TITLE_COL_INDEX] || "Unknown";
        } else {
          mDesc = values[i][TITLE_COL_INDEX] || "Unknown";
        }
        const mv = LlmService.generateVector(`Topic: ${values[i][TITLE_COL_INDEX]} / Method: ${mDesc}`);
        if (mv) { values[i][METHOD_VECTOR_COL_INDEX] = mv.join(','); updated = true; }
      }
      if (updated) {
        processedCount++;
        if (minIdx === -1 || i < minIdx) minIdx = i;
        maxIdx = i;
        Utilities.sleep(500);
      }
    }
  }

  if (processedCount > 0) {
    const outputRange = trendDataSheet.getRange(minIdx + 2, 1, maxIdx - minIdx + 1, maxCol);
    outputRange.setValues(values.slice(minIdx, maxIdx + 1));
  }
}

/**
 * @description ベクトル類似度（セマンティック検索）を用いて、クエリに関連する記事を抽出・ソートします。
 * @param {string} queryKeyword - 検索キーワード。
 * @param {Object[]} allArticles - 検索対象の記事リスト。
 * @param {number} [topN] - 取得する上位件数。
 * @param {number} [similarityThreshold] - 類似度の閾値(0.0-1.0)。
 * @returns {Object[]} 類似度(similarity)が付与され、降順ソートされた記事配列。
 */
function performSemanticSearch_(queryKeyword, allArticles, topN = AppConfig.get().System.Limits.SEARCH_MAX_RESULTS, similarityThreshold = AppConfig.get().System.Thresholds.SEMANTIC_SEARCH) {
  const queryVector = LlmService.generateVector(queryKeyword);
  if (!queryVector) {
    Logger.log("クエリのベクトル化に失敗しました。");
    return [];
  }

  const candidates = [];

  // シートではなく、既に取得済みの allArticles をループする (超高速)
  for (const article of allArticles) {
    // 【変更】毎回パースせず、生成済みの parsedVector を利用する
    if (article.parsedVector) {
      // 💡 爆速化: 現行の生成経路（または再正規化済み）のベクトル同士を前提に、計算コストの低い内積（Dot Product）を使用
      const similarity = calculateDotProduct_(queryVector, article.parsedVector); 
      if (similarity >= similarityThreshold) {
        candidates.push({ ...article, similarity: similarity });
      }
    } else if (article.vectorStr && typeof article.vectorStr === 'string' && article.vectorStr.trim() !== "") {
      // フォールバック: parsedVector が無い場合は従来通りパース
      const vector = parseVector_(article.vectorStr);
      if (vector) {
        // 💡 爆速化: 現行の生成経路（または再正規化済み）のベクトル同士を前提に、計算コストの低い内積（Dot Product）を使用
        const similarity = calculateDotProduct_(queryVector, vector); 
        if (similarity >= similarityThreshold) {
          candidates.push({ ...article, similarity: similarity });
        }
      }
    }
  }

  // 類似度順にソートして上位N件を返す
  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, topN);
}

/**
 * @description 指定されたURLのWebページからテキストを抽出し、AIで内容を要約して返します。
 * @param {string} url - 要約対象のウェブページURL。
 * @returns {string} 要約テキスト、またはエラーメッセージ。
 */
function getWebPageSummary(url) {
  try {
    // 1. Webページの取得
    // Bot判定を避けるため、収集時と同じヘッダーを使用
    const options = {
      'muteHttpExceptions': true,
      'headers': AppConfig.get().System.HttpHeaders
    };
    
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    
    if (code !== 200) {
      return `エラー: ページを取得できませんでした (Status: ${code})。サイトがアクセスをブロックしている可能性があります。`;
    }
    
    // 2. テキスト抽出 (簡易スクレイピング)
    const html = response.getContentText();
    // bodyタグの中身だけ大まかに取得
    let bodyText = "";
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
      bodyText = stripHtml_(bodyMatch[1]); // 既存のタグ除去関数を利用
    } else {
      bodyText = stripHtml_(html);
    }
    
    // 文字数が多すぎるとエラーになるので、先頭3万文字程度にカット
    const maxChars = AppConfig.get().System.Limits.WEB_SUMMARY_MAX_CHARS || 30000;
    const minChars = AppConfig.get().System.Limits.WEB_SUMMARY_MIN_CHARS || 50;

    const truncatedText = bodyText.replace(/\s+/g, " ").trim().substring(0, maxChars);
    if (truncatedText.length < minChars) {

      return "エラー: ページから十分なテキストを抽出できませんでした（画像メインやJavaScript専用サイトの可能性があります）。";
    }

    // 3. LLMで要約・圧縮
    const systemPrompt = getPromptConfig_("WEBPAGE_SUMMARY_SYSTEM");
    
    // 要約機能（Nanoモデル推奨）を使用してテキストを圧縮する
    const summary = LlmService.summarizeReport(systemPrompt, truncatedText);
    
    return summary;

  } catch (e) {
    return `エラーが発生しました: ${e.message}`;
  }
}

// #endregion

// =============================================================================
// #region 6. COLLECTION & INFRA LOGIC
// 【責務】データの「収集」と「データベース管理」。
//  - RSSフィードの巡回・パース
//  - 重複排除・ドメイン分散アクセス
//  - 古いデータのアーカイブ・削除（メンテナンス）
// =============================================================================

/**
 * @description RSSリストを巡回し、ドメイン分散アクセスと並列通信を用いて効率的に記事を収集します。
 * @details 重複記事の排除、ブラックリスト確認、タイムアウト時の再開インデックス管理を自動で行います。
 */
function collectRssFeeds_() {
  const startTime = new Date().getTime();
  // 全体のタイムリミット (5分)
  const TIME_LIMIT_MS = AppConfig.get().System.TimeLimit.COLLECTION;

  const rssListSheet = getSheet_(AppConfig.get().SheetNames.RSS_LIST);
  const collectSheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  
  if (!rssListSheet || !collectSheet) return;

  if (rssListSheet.getLastRow() < AppConfig.get().RssListSheet.DataRange.START_ROW) {
    Logger.log("RSSリストが空のため、収集をスキップします。");
    return;
  }

  // プロパティ管理
  const props = PropertiesService.getScriptProperties();
  const savedIndexKey = "RSS_COLLECTION_NEXT_INDEX";
  let startIndex = parseInt(props.getProperty(savedIndexKey) || "0", 10);

  // RSSデータの準備
  const rssDataRaw = rssListSheet.getRange(
    AppConfig.get().RssListSheet.DataRange.START_ROW, 
    AppConfig.get().RssListSheet.DataRange.START_COL, 
    rssListSheet.getLastRow() - 1, 
    AppConfig.get().RssListSheet.DataRange.NUM_COLS
  ).getValues();

  // インデックスが範囲外ならリセット
  if (startIndex >= rssDataRaw.length) {
    startIndex = 0;
  }
  
  Logger.log(`収集開始: 全${rssDataRaw.length}件中、${startIndex + 1}件目からスタートします。`);

  // 重複チェック用データの読み込み
  const existingUrlSet = new Set();
  const existingTitleSet = new Set();
  const lastRow = collectSheet.getLastRow();
  
  if (lastRow >= 2) { 
    const checkLimit = AppConfig.get().System.Limits.RSS_CHECK_ROWS; 
    const startCheckRow = 2;
    const numRowsToCheck = Math.min(lastRow - 1, checkLimit);
    
    const existingData = collectSheet.getRange(startCheckRow, 2, numRowsToCheck, 2).getValues();
    existingData.forEach(row => {
      if (row[1]) existingUrlSet.add(normalizeUrl_(row[1])); 
      if (row[0]) existingTitleSet.add(_normalizeTitleFingerprint_(String(row[0])));
    });
  }

  const DATE_LIMIT_DAYS = AppConfig.get().System.Limits.RSS_DATE_WINDOW_DAYS; 
  const rssCols = AppConfig.get().RssListSheet.Columns;
  const fetchOptions = {
    'muteHttpExceptions': true,
    'validateHttpsCertificates': false,
    'headers': AppConfig.get().System.HttpHeaders
  };

  // リクエスト作成とスケジューリング
  const rawRequests = [];
  let skippedCount = 0;
  for (const row of rssDataRaw) {
    const siteName = row[rssCols.NAME - 1];
    const rssUrl = row[rssCols.URL - 1];
    if (!rssUrl) continue;

    if (_isRssBlacklisted_(rssUrl)) {
      Logger.log(`🚫 Blacklisted (Skip): ${siteName}`);
      skippedCount++;
      continue;
    }

    rawRequests.push({
      siteName: siteName,
      rssUrl: rssUrl,
      domain: _extractDomain_(rssUrl),
      request: { url: rssUrl, ...fetchOptions }
    });
  }

  if (skippedCount > 0) Logger.log(`情報: ${skippedCount} 件のRSSをブラックリスト回避のためスキップしました。`);

  const allScheduledRequests = _scheduleRequestsByDomain_(rawRequests);
  const targetRequests = allScheduledRequests.slice(startIndex);

  // allNewItems 配列をループの外に準備（ここに全件貯める）
  let totalNewCount = 0;
  const CHUNK_SIZE = AppConfig.get().System.Limits.RSS_CHUNK_SIZE; 
  let isTimeUp = false;
  const allNewItems = []; 

  // --- チャンク実行ループ ---
  for (let i = 0; i < targetRequests.length; i += CHUNK_SIZE) {
    
    if (new Date().getTime() - startTime > TIME_LIMIT_MS) {
      Logger.log("⏳ タイムリミット到達。残りは次回実行します。");
      isTimeUp = true;
      break; 
    }

    const nextStartCandidate = startIndex + i + CHUNK_SIZE;
    props.setProperty(savedIndexKey, String(nextStartCandidate));

    const chunkItems = targetRequests.slice(i, i + CHUNK_SIZE);
    const chunkRequests = chunkItems.map(item => item.request);
    
    Logger.log(`Processing chunk: ${startIndex + i + 1} 〜 ${Math.min(startIndex + i + CHUNK_SIZE, allScheduledRequests.length)}`);
    
    try {
      // 通信実行
      const responses = UrlFetchApp.fetchAll(chunkRequests);
      
      responses.forEach((response, idx) => {
        const meta = chunkItems[idx];
        const code = response.getResponseCode();

        if (code === 200) {
          _resetRssStrike_(meta.rssUrl);
        } else {
          _addRssStrike_(meta.rssUrl);
          Logger.log(`❌ RSS Error (${code}): ${meta.siteName}`);
          return; 
        }

        const items = parseRssXml_(response.getContentText(), meta.rssUrl);
        if (!items) return;

        items.forEach((item, index) => {
          const maxLimit = AppConfig.get().System.Limits.MAX_ITEMS_PER_FEED || 10;
          if (index >= maxLimit) return;

          try {
            if (!item.link || !item.title) return;
            const normalizedLink = normalizeUrl_(item.link);
            const cleanTitle = stripHtml_(item.title).trim();
            const fingerprint = _normalizeTitleFingerprint_(cleanTitle);

            if (existingUrlSet.has(normalizedLink)) return;
            if (existingTitleSet.has(fingerprint)) return;
            // 🌟 修正：日付チェックを飛ばし、一律で「今」をセット
            const now = new Date();

            let abstractText = stripHtml_(item.description || AppConfig.get().Llm.NO_ABSTRACT_TEXT).trim().replace(/[\r\n]+/g, " ");
            if (item.categories && item.categories.length > 0) {
              const uniqueTags = [...new Set(item.categories)].join(", ");
              if (uniqueTags) abstractText += ` [Tags: ${uniqueTags}]`;
            }

            allNewItems.push([
              now,            // A: 日付
              cleanTitle,     // B: タイトル
              item.link,      // C: リンクURL
              abstractText,   // D: 元記事
              "",             // E: 要約(空)
              meta.siteName   // F: ソース
            ]);
            
            existingUrlSet.add(normalizedLink);
            existingTitleSet.add(fingerprint);
          } catch (e) {}
        });
      });

      // ウェイト
      if (i + CHUNK_SIZE < targetRequests.length) {
        Utilities.sleep(AppConfig.get().System.Limits.RSS_INTER_CHUNK_DELAY); 
      }

    } catch (e) {
      Logger.log(`⚠️ Chunk Error (Timeout or Network): ${e.toString()}`);
    }
  }

  // 🌟 ループを抜けた後に、シートの「一番下」へ追記し、全体をソートする方式に変更（GAS最適化）
  if (allNewItems.length > 0) {
    
    _withRetry_(() => {
      const lastRow = collectSheet.getLastRow();
      
      // 1. 一番下（最終行の次）の空きスペースに一括で書き込む（シフトが発生しないため超高速）
      collectSheet.getRange(lastRow + 1, 1, allNewItems.length, allNewItems[0].length).setValues(allNewItems);
      
      // 2. データ全体（2行目〜追記後の最終行まで）を日付列（A列 = 1列目）で降順（新しい順）に一括ソート
      const newLastRow = lastRow + allNewItems.length;
      collectSheet.getRange(2, 1, newLastRow - 1, collectSheet.getLastColumn())
                  .sort({column: 1, ascending: false});
      
      SpreadsheetApp.flush(); 
    });

    totalNewCount = allNewItems.length;
  }

  if (!isTimeUp) {
    props.setProperty(savedIndexKey, "0");
    Logger.log("✅ 全件巡回完了。インデックスをリセットしました。");
  } else {
    Logger.log(`⏸️ 時間切れ中断。次回は保存された位置から再開します。`);
  }
  
  RssStrikeCache.saveAll();
  Logger.log(`今回追加件数: ${totalNewCount}`);
}

/**
 * _scheduleRequestsByDomain
 * 同じドメインのリクエストが連続しないように並び替える（ラウンドロビン方式）
 */
function _scheduleRequestsByDomain_(items) {
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
 * _extractDomain
 * URLからドメイン名(ホスト名)を抽出する
 */
function _extractDomain_(url) {
  try {
    // 簡易的な抽出: プロトコル除去して最初のスラッシュまで
    let domain = url.replace(/^https?:\/\//, '').split('/')[0];
    return domain.toLowerCase();
  } catch (e) {
    return "unknown";
  }
}

/**
 * @description 指定期間より古いデータをDriveへ退避(JSON)し、重心ベクトルをMacroTrendsに記録して削除します。
 * @details 保持期間(RETENTION_MONTHS)を過ぎたデータを対象とし、月の初めにアーカイブを実行します。
 */
function archiveAndPruneOldData() {
  const config = AppConfig.get();
  const RETENTION_MONTHS = config.System.Limits.DATA_RETENTION_MONTHS;
  
  const collectSheet = getSheet_(config.SheetNames.TREND_DATA);
  const macroSheet = getSheet_(config.SheetNames.MACRO_TRENDS); // 新設シート
  
  if (!collectSheet || !macroSheet) {
    Logger.log("エラー: シートが見つかりません(collect または MacroTrends)");
    return;
  }

  const lastRow = collectSheet.getLastRow();
  if (lastRow < 2) return;

  // 閾値計算 (例: 今日が5月なら、2月以前のデータを対象にする)
  const thresholdDate = new Date();
  thresholdDate.setMonth(thresholdDate.getMonth() - RETENTION_MONTHS);
  // 月初に設定（アーカイブ単位を「月」にするため）
  thresholdDate.setDate(1); 
  thresholdDate.setHours(0,0,0,0);

  // 日付列(A)を取得
  const dateValues = collectSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  
  // 削除対象の範囲を特定（日付降順前提：閾値より「未来」の行数を数える）
  // つまり、下の方にある「閾値より過去」の行を探す
  let archiveStartRow = -1;
  
  for (let i = 0; i < dateValues.length; i++) {
    const rowDate = new Date(dateValues[i][0]);
    if (rowDate < thresholdDate) {
      archiveStartRow = i + 2;
      break;
    }
  }

  // 対象データがない場合は終了
  if (archiveStartRow === -1) {
    Logger.log("アーカイブ対象の古いデータはありません。");
    return;
  }

  const numRows = lastRow - archiveStartRow + 1;
  Logger.log(`アーカイブ開始: ${numRows} 件の記事を処理します...`);

  // 1. データ取得
  const range = collectSheet.getRange(archiveStartRow, 1, numRows, collectSheet.getLastColumn());
  const rawData = range.getValues(); // データ本体
  
  // 2. 重心(Centroid)計算 & 代表トピック抽出
  // ベクトルがある行だけ抽出
  const vectorColIdx = config.CollectSheet.Columns.VECTOR - 1;
  const titleColIdx = config.CollectSheet.Columns.URL - 2;
  
  const validVectors = [];
  const titles = [];

  rawData.forEach(row => {
    const vecStr = row[vectorColIdx];
    const title = row[titleColIdx];
    if (vecStr) {
      const vec = parseVector_(vecStr);
      if (vec) validVectors.push(vec);
    }
    if (title) titles.push(title);
  });

  let centroidVectorStr = "";
  let topicSummary = "データ不足により解析不能";

  if (validVectors.length > 0) {
    // 重心計算 (全ベクトルの平均)
    const dim = validVectors[0].length;
    const avg = new Array(dim).fill(0);
    validVectors.forEach(v => {
      for(let i=0; i<dim; i++) avg[i] += v[i];
    });
    for(let i=0; i<dim; i++) avg[i] /= validVectors.length;
    
    centroidVectorStr = avg.join(",");
    
    // AIによる「その期間のトピック要約」
    // タイトルをランダムに最大50個選んで要約させる
    const sampleSize = AppConfig.get().System.Limits.ARCHIVE_SAMPLE_SIZE || 50;
    const sampleTitles = titles.sort(() => 0.5 - Math.random()).slice(0, sampleSize).join("\n");
    
    // System PromptとUser Promptを正しく分離して渡す
    const systemPrompt = getPromptConfig_("ARCHIVE_TOPIC_SYSTEM");
    const userPrompt = `【過去の記事タイトル群】\n${sampleTitles}`;
    
    // Nanoモデルでサクッと要約
    const summary = LlmService.summarizeReport(systemPrompt, userPrompt); 
    if (summary) topicSummary = summary;
  }

  // 3. Google DriveへJSON保存
  const archiveLabel = Utilities.formatDate(new Date(rawData[0][0]), Session.getScriptTimeZone(), "yyyy-MM");
  const fileName = `${config.System.Archive.JSON_FILENAME_PREFIX}${archiveLabel}_${Date.now()}.json`;
  
  const jsonContent = JSON.stringify(rawData, null, 2);
  
  try {
    const folderId = config.System.Archive.FOLDER_ID;
    if (folderId && folderId.length > 10) {
      const folder = DriveApp.getFolderById(folderId);
      folder.createFile(fileName, jsonContent, MimeType.PLAIN_TEXT);
      Logger.log(`[Drive保存] ${fileName} を保存しました。`);
    } else {
      Logger.log("警告: フォルダID未設定のため、Drive保存はスキップされました（データは消えます）。");
    }
  } catch (e) {
    Logger.log(`Drive保存エラー: ${e.toString()}`);
    return; // 保存失敗時は削除しない（安全策）
  }

  // 4. MacroTrendsシートへ「重心」を記録
  // フォーマット: [アーカイブ日時, 対象年月, 記事数, トピック要約, 重心ベクトル]
  _withRetry_(() => {
    try {
      // マクロトレンドの記録
      macroSheet.appendRow([
        new Date(), 
        archiveLabel, 
        numRows, 
        topicSummary, 
        centroidVectorStr
      ]);
      
      // 元データの削除 (アーカイブ成功時のみ実行)
      collectSheet.deleteRows(archiveStartRow, numRows);
      
      // 変更を強制確定
      SpreadsheetApp.flush(); 
      
      Logger.log(`[成功] MacroTrends記録 ＆ ${numRows} 行の削除を完了しました。`);
    } catch (e) {
      // ここでのエラーは _withRetry_ がキャッチしてリトライを試みます
      throw new Error(`スプレッドシート操作失敗: ${e.toString()}`);
    }
  });

  Logger.log(`[アーカイブ完了] すべての工程が正常に終了しました。`);
}

/**
 * @description 35日以上経過した記事のベクトルデータのみを削除し、シートのセル容量を軽量化します。
 */
function maintenanceDeleteOldArticles() {
  const KEEP_MONTHS = AppConfig.get().System.Limits.DATA_RETENTION_MONTHS;
  
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
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
    Logger.log(`メンテナンス: ${fmtDate_(thresholdDate)} 以前の記事、計 ${numRowsToDelete} 件を削除しました。`);
  } else {
    Logger.log("メンテナンス: 削除対象の古い記事はありませんでした。");
  }
}

/**
 * maintenanceLightenOldArticles
 * 【責務】指定日数（35日）より古い記事の「ベクトル列(G列)」だけを削除して軽量化する。
 * 記事自体の行は消さないので、キーワード検索にはヒットする。
 */
function maintenanceLightenOldArticles() {
  const LIGHTEN_THRESHOLD_DAYS = AppConfig.get().System.Limits.LIGHTEN_DAYS; // 生成処理(30日)と被らないよう余裕を持たせる
  
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - LIGHTEN_THRESHOLD_DAYS);
  thresholdDate.setHours(0, 0, 0, 0); // 0時に揃える
  
  // 日付列(A列)とベクトル列(G列)の位置を取得
  const dateValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const vectorColIndex = AppConfig.get().CollectSheet.Columns.VECTOR; 
  const methodVectorColIndex = AppConfig.get().CollectSheet.Columns.METHOD_VECTOR;
  
  // 古い記事の範囲を特定
  let targetEndRow = -1;
  // 日付順(降順)で並んでいる前提なら、下の方にある古い記事を探す
  // ※YATAは降順ソートしているので、実際は「ある行以降すべて」が古い記事
  
  for (let i = 0; i < dateValues.length; i++) {
    const rowDate = new Date(dateValues[i][0]);
    if (rowDate < thresholdDate) {
      // これ以降はすべて古い記事
      const startRow = i + 2;
      const numRows = lastRow - startRow + 1;
      
      // G列(ベクトル)だけをクリア
      sheet.getRange(startRow, vectorColIndex, numRows, 1).clearContent();
      // Method Vector列もクリア
      if (methodVectorColIndex) {
        sheet.getRange(startRow, methodVectorColIndex, numRows, 1).clearContent();
      }
      
      Logger.log(`軽量化: 行${startRow}〜${lastRow} (${numRows}件) のベクトルデータを削除しました。`);
      return;
    }
  }
  Logger.log("軽量化対象の記事はありませんでした。");
}

/**
 * maintenancePruneDigestHistory
 * 【責務】DigestHistoryシートから、保存期間を過ぎた古い履歴を削除して軽量化する。
 * デフォルト設定: 60日（約2ヶ月）以上前の履歴は削除。
 */
function maintenancePruneDigestHistory() {
  const RETENTION_DAYS = AppConfig.get().System.Limits.HISTORY_RETENTION_DAYS; // 基本は4ヶ月保存（これより古いと、話題が途切れたとみなして忘れる）
  
  const sheet = getSheet_(AppConfig.get().SheetNames.DIGEST_HISTORY);
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // 削除基準日の計算
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - RETENTION_DAYS);

  // A列(Date)を取得
  const dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let deleteCount = 0;

  // 履歴は「古い順（上から）」並んでいる前提でチェック
  for (let i = 0; i < dates.length; i++) {
    const rowDate = new Date(dates[i][0]);
    if (rowDate < thresholdDate) {
      deleteCount++;
    } else {
      // 古くないデータに当たったら、それ以降は全て新しいので終了
      break; 
    }
  }

  if (deleteCount > 0) {
    // 上からまとめて削除
    sheet.deleteRows(2, deleteCount);
    Logger.log(`履歴メンテナンス: ${RETENTION_DAYS}日以上前の古いコンテキスト (${deleteCount}件) を削除しました。`);
  } else {
    Logger.log("履歴メンテナンス: 削除対象の古いデータはありませんでした。");
  }
}

/**
 * maintenanceRoundExistingVectors
 * 【責務】スプレッドシートに既に保存されているベクトル（G列）を走査し、
 * 小数点以下6桁を超えるデータを丸めて、シートの容量を削減します。
 */
function maintenanceRoundExistingVectors() {
  const config = AppConfig.get();
  const sheet = getSheet_(config.SheetNames.TREND_DATA);
  if (!sheet) {
    Logger.log("エラー: collectシートが見つかりません。");
    return;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const vectorColIndex = config.CollectSheet.Columns.VECTOR; // 通常は7 (G列)
  const range = sheet.getRange(2, vectorColIndex, lastRow - 1, 1);
  const values = range.getValues();
  
  let updateCount = 0;
  const newValues = values.map((row, index) => {
    const originalString = String(row[0] || "").trim();
    if (!originalString) return [originalString];

    // カンマで分割して数値配列にする
    const parts = originalString.split(',');
    let needsUpdate = false;

    const roundedParts = parts.map(p => {
      const val = parseFloat(p);
      if (isNaN(val)) return p;

      // 小数点以下の桁数を確認（簡易チェック）
      if (p.includes('.') && p.split('.')[1].length > 6) {
        needsUpdate = true;
        // 小数点6桁に丸める (generateVectorと同じロジック)
        return parseFloat(val.toFixed(6));
      }
      return val;
    });

    if (needsUpdate) {
      updateCount++;
      return [roundedParts.join(',')];
    }
    return [originalString];
  });

  if (updateCount > 0) {
    range.setValues(newValues);
    Logger.log(`メンテナンス完了: ${updateCount} 件のベクトルを小数点6桁に丸めました。`);
  } else {
    Logger.log("丸め処理が必要なベクトル（7桁以上のもの）はありませんでした。");
  }
}

/**
 * maintenanceSliceVectorsTo256d
 * 【責務】スプレッドシートに保存されている1536次元のベクトルを、先頭256次元にスライスして再正規化し、容量を削減します。
 * (Matryoshka Representation Learningを利用した手法)
 */
function maintenanceSliceVectorsTo256d() {
  const config = AppConfig.get();
  const sheet = getSheet_(config.SheetNames.TREND_DATA);
  if (!sheet) {
    Logger.log("エラー: collectシートが見つかりません。");
    return;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const vectorColIndex = config.CollectSheet.Columns.VECTOR; 
  const range = sheet.getRange(2, vectorColIndex, lastRow - 1, 1);
  const values = range.getValues();

  let updateCount = 0;

  const newValues = values.map((row) => {
    const originalString = String(row[0] || "").trim();
    if (!originalString || originalString.includes("[Error]") || originalString === "Unknown") return [originalString];

    const parts = originalString.split(',').map(Number);
    // Configから次元数を取得（変更があれば連動する）
    const targetDim = AppConfig.get().Llm.Embedding.Dimensions || 256;
    
    // targetDim次元より大きい場合のみスライス
    if (parts.length > targetDim) {
      const sliced = parts.slice(0, targetDim);
      
      // 再正規化(L2ノルムを1にする)
      let normSq = 0;
      for (let i = 0; i < targetDim; i++) {
        normSq += sliced[i] * sliced[i];
      }
      const norm = Math.sqrt(normSq);
      
      const normalized = sliced.map(x => x / norm);
      const newStr = normalized.map(x => Number(x.toFixed(6))).join(',');
      
      updateCount++;
      return [newStr];
    }
    return [originalString];
  });

  if (updateCount > 0) {
    range.setValues(newValues);
    Logger.log(`✨ メンテナンス完了: ${updateCount} 件のベクトルを1536次元から256次元にスライス＆再正規化し、シート容量を大幅に削減しました！`);
  } else {
    Logger.log("スライスが必要なベクトル（256次元を超えるもの）はありませんでした。");
  }
}

/**
 * @description URL正規化に基づき、collectシート内の重複記事を完全に排除します。
 */
function removeDuplicates() {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
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
      const normalizedUrl = normalizeUrl_(url); 
      
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
 * sortCollectByDateDesc
 * 【責務】collectシートを日付順（新しい順）に並び替える。
 */
function sortCollectByDateDesc_() {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  const lastRow = sheet.getLastRow();
  
  if (lastRow > 1) {
    // ソート処理をリトライで保護
    _withRetry_(() => {
      sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn())
           .sort({column: 1, ascending: false});
      SpreadsheetApp.flush(); // ソート結果を即座に反映
    });
    Logger.log("collectシートを最新順に並び替えました。");
  }
}

// #endregion

// =============================================================================
// #region 7. UTILITIES (Helpers)
// 【責務】特定の業務に依存しない「汎用ツール」。
//  - シート取得・日付操作・URL正規化
//  - 文字列処理（HTML/Markdown変換、JSONパース）
//  - 数学計算（コサイン類似度）
// =============================================================================

// グローバル空間にシートのキャッシュを保持（メモリ消費はごくわずかです）
const _SsCache = { config: null, data: null };

/**
 * getSheet (自動振り分け版・キャッシュ最適化)
 * 【責務】シート名に応じて「データ用(公開)」か「設定用(非公開)」か判定し、正しいIDを開く。
 * @param {string} sheetName - シート名
 * @returns {Sheet} シートオブジェクト (存在しない場合はnull)
 */
function getSheet_(sheetName) {
  const config = AppConfig.get();
  
  // 非公開(Config)シートにあるべきシート名をリスト化
  const PRIVATE_SHEETS = [
    config.SheetNames.USERS,
    config.SheetNames.PROMPT_CONFIG,
    config.SheetNames.KEYWORDS,
    config.SheetNames.DIGEST_HISTORY,
    "Memo"
  ];

  let targetId;
  let isConfig = false;

  if (PRIVATE_SHEETS.includes(sheetName) || sheetName === "Keywords" || sheetName === "Memo") {
    targetId = config.System.ConfigSheetId;
    isConfig = true;
  } else {
    targetId = config.System.DataSheetId;
  }

  if (!targetId || targetId.includes("未設定")) {
    console.error(`ID設定エラー: ${sheetName} を開くためのIDが設定されていません。`);
    return null;
  }
  
  try {
    // 【変更】SpreadsheetApp.openById を毎回呼ばず、キャッシュを利用する
    let ss;
    if (isConfig) {
      if (!_SsCache.config) _SsCache.config = SpreadsheetApp.openById(targetId);
      ss = _SsCache.config;
    } else {
      if (!_SsCache.data) _SsCache.data = SpreadsheetApp.openById(targetId);
      ss = _SsCache.data;
    }
    
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) console.warn(`警告: シート「${sheetName}」が見つかりません (ID: ...${targetId.slice(-4)})`);
    return sheet;
  } catch (e) {
    console.error(`シート取得エラー (${sheetName}): ${e.message}`);
    return null;
  }
}

/**
 * fmtDate
 * 【責務】Date を "yyyy/MM/dd" 形式にフォーマット
 * @param {Date} d - Date オブジェクト
 * @returns {string} フォーマット済み日付文字列
 */
function fmtDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd");
}

/**
 * getDateWindow
 * 【責務】"N日前から今日まで"の日付範囲を計算
 * @param {number} days - 遡り日数
 * @returns {Object} { start: Date, end: Date }
 */
function getDateWindow_(days) {
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
function isRecentArticle_(pubDate, daysLimit = 7) {
  if (!pubDate || !(pubDate instanceof Date)) return false;
  const now = new Date();
  const daysOld = Math.floor((now - pubDate) / (1000 * 60 * 60 * 24));
  return daysOld <= daysLimit;
}

/**
 * @description 重複チェック用にタイトルの「指紋（正規化文字列）」を作成します。
 * @details 全角半角の統一、記号・空白の排除を行い、微細な表記揺れがあっても重複として検知できるようにします。
 * @param {string} title - 元のタイトル文字列。
 * @returns {string} 指紋化された文字列。
 */
function _normalizeTitleFingerprint_(title) {
  if (!title) return "";
  let norm = title.trim();
  
  // 1. HTMLエンティティ解除 & 小文字化
  norm = decodeHtmlEntities_(norm).toLowerCase();

  // 2. 全角英数字→半角、全角スペース→半角 (GAS環境互換の簡易実装)
  norm = norm.replace(/[！-～]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
  
  // 3. 記号と空白をすべて削除
  // 英数字、ひらがな、カタカナ、漢字以外を削ぎ落とす
  norm = norm.replace(/[^\w\d\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/g, "");
  
  return norm;
}

/**
 * @description URLをトラッキングパラメータ等を除去して正規化します。Googleリダイレクトにも対応。
 * @param {string} url - 元のURL。
 * @returns {string} //domain/path 形式の正規化済みURL。
 */
function normalizeUrl_(url) {
  if (!url) return "";
  let s = String(url).trim();
  
  try { s = decodeURIComponent(s); } catch (e) {}
  
  // Googleアラート/ニュースのリダイレクト対応
  if (s.includes("google.com/url") || s.includes("google.co.jp/url")) {
    const match = s.match(/[?&](?:q|url)=([^&]+)/);
    if (match && match[1]) {
      s = match[1]; 
      try { s = decodeURIComponent(s); } catch (e) {}
    }
  }

  // 0. ドメイン部分のみを小文字化する (パスやクエリの大文字小文字を破壊しない)
  try {
    const match = s.match(/^(https?:\/\/)([^/]+)(\/.*)?$/i);
    if (match) {
      s = match[1].toLowerCase() + match[2].toLowerCase() + (match[3] || "");
    } else {
      s = s.toLowerCase(); // フォールバック
    }
  } catch (e) {
    s = s.toLowerCase();
  }

  // 1. 一般的なトラッキングパラメータのみを除去 (YouTubeの ?v= 等は残す)
  s = s.replace(/([?&])(?:utm_[^=]+|gclid|yclid|fbclid)=[^&]*/gi, "");
  // 余った ? や & を綺麗にする
  s = s.replace(/[?&]$/, "").replace(/\?&/, "?");
  
  // 2. ハッシュ(#)の削除
  s = s.split('#')[0];
  
  // 3. 末尾スラッシュの削除
  s = s.replace(/\/$/, "");
  
  // 4. プロトコルとwwwの排除
  s = s.replace(/^https?:\/\/(www\.)?/, "//");
  
  return s;
}

/**
 * isRecentDate
 * 【責務】日付文字列が指定された日数以内であるかチェックする。
 */
function isRecentDate_(dateStr, daysLimit) {
  if (!dateStr) return false;
  
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return false;

  const now = new Date();
  const diffTime = now - date;
  const diffDays = diffTime / (1000 * 60 * 60 * 24);

  return diffDays <= daysLimit;
}

/**
 * @description RSS/Atom等のXMLをパースして統一された記事オブジェクトの配列に変換します。
 * @param {string} xml - 取得したXML文字列。
 * @param {string} url - 取得元のRSS URL（エラー時のログ用）。
 * @returns {Object[]} 記事オブジェクト(title, link, pubDate等)の配列。
 */
function parseRssXml_(xml, url) {
  try {
    // 1. 最低限のサニタイズ
    let safeXml = xml.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '');
    safeXml = safeXml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[a-f\d]+);)/gi, '&amp;');

    let document;
    try {
      document = XmlService.parse(safeXml);
    } catch (e) {
      console.warn(`XMLパース失敗(正規表現へ移行): ${url} - ${e.message}`);
      return _fallbackParseRssRegex_(xml);
    }

    const root = document.getRootElement();
    let itemNodes = [];

    // 2. 記事ノードの探索
    const channel = getChildNoNs_(root, 'channel');
    if (channel) {
      itemNodes = getChildrenNoNs_(channel, 'item');
      if (itemNodes.length === 0) itemNodes = getChildrenNoNs_(channel, 'entry');
    }
    if (itemNodes.length === 0) itemNodes = getChildrenNoNs_(root, 'item');
    if (itemNodes.length === 0) itemNodes = getChildrenNoNs_(root, 'entry');

    if (itemNodes.length === 0) return [];

    // 3. データ抽出
    return itemNodes.map(node => {
      // リンク取得
      let link = getXmlValue_(node, ['link', 'origLink']); 
      if (!link) {
        const allChildren = node.getChildren();
        for (const c of allChildren) {
          if (c.getName().toLowerCase() === 'link' && c.getAttribute('href')) {
            link = c.getAttribute('href').getValue();
            break;
          }
        }
      }

      // カテゴリタグの収集
      const categories = [];
      const catNodes = getChildrenNoNs_(node, 'category');
      catNodes.forEach(c => {
        let txt = c.getText(); // RSS 2.0 (<category>Tag</category>)
        if (!txt) txt = c.getAttribute('term') ? c.getAttribute('term').getValue() : ""; // Atom (<category term="Tag"/>)
        if (txt) categories.push(txt.trim());
      });
      // Dublin Core (dc:subject) も探す
      const subjectNodes = getChildrenNoNs_(node, 'subject'); // namespace無視ヘルパー使用
      subjectNodes.forEach(s => {
        if(s.getText()) categories.push(s.getText().trim());
      });

      return {
        title: getXmlValue_(node, ['title']),
        link: link,
        description: getXmlValue_(node, ['description', 'encoded', 'content', 'summary']),
        pubDate: getXmlValue_(node, ['pubDate', 'date', 'updated', 'published', 'dc:date']),
        categories: categories, // ここに追加
        source: "AutoDetect"
      };
    });

  } catch (e) {
    console.error(`parseRssXml Error: ${url} / ${e.toString()}`);
    return [];
  }
}

/**
 * @description XmlServiceでのパースが失敗した際、正規表現を用いてXMLから記事情報を抽出する救済用パーサー。
 * @param {string} xml - 壊れた可能性のあるXML文字列。
 * @returns {Object[]} 抽出された記事オブジェクトの配列。
 */
function _fallbackParseRssRegex_(xml) {
  const items = [];
  const itemRegex = /<(?:item|entry)[\s\S]*?>(?:[\s\S]*?)<\/(?:item|entry)>/gi;
  const matches = xml.match(itemRegex);
  
  if (!matches) return [];

  matches.forEach(block => {
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    let title = titleMatch ? titleMatch[1] : "";
    title = title.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").trim();

    let link = "";
    const linkTagMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    if (linkTagMatch) {
      link = linkTagMatch[1].trim();
    } else {
      const linkHrefMatch = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (linkHrefMatch) link = linkHrefMatch[1].trim();
    }

    let pubDate = "";
    const dateMatch = block.match(/<(?:pubDate|updated|published|dc:date)[^>]*>([\s\S]*?)<\//i);
    if (dateMatch) pubDate = dateMatch[1].trim();
    
    let description = "";
    const descMatch = block.match(/<(?:description|content|summary)[^>]*>([\s\S]*?)<\//i);
    if (descMatch) {
      description = descMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").trim();
    }

    if (title && link) {
      items.push({
        title: title,
        link: link,
        description: description,
        pubDate: pubDate,
        source: "RegexFallback"
      });
    }
  });
  
  Logger.log(`[RegexFallback] 正規表現で ${items.length} 件の記事を救出しました。`);
  return items;
}

/**
 * getXmlValue
 * 【責務】名前空間(dc:やatom:など)を無視して、指定されたタグ名のいずれかに合致する要素のテキストを返す。
 * @param {Element} element - 親要素
 * @param {Array<string>} possibleTags - 探したいタグ名のリスト
 */
function getXmlValue_(element, possibleTags) {
  if (!element) return "";
  const children = element.getChildren();
  
  for (const tag of possibleTags) {
    // "dc:date" のような指定があった場合、"date" (ローカル名) として扱う
    const targetName = tag.includes(':') ? tag.split(':')[1] : tag;

    for (const child of children) {
      if (child.getName().toLowerCase() === targetName.toLowerCase()) {
        const text = child.getText();
        if (text) return text;
      }
    }
  }
  return "";
}

// 名前空間を無視して、指定したタグ名の子要素を1つ取得
function getChildNoNs_(element, tagName) {
  const children = element.getChildren();
  for (const child of children) {
    if (child.getName().toLowerCase() === tagName.toLowerCase()) {
      return child;
    }
  }
  return null;
}

// 名前空間を無視して、指定したタグ名の子要素をすべて取得
function getChildrenNoNs_(element, tagName) {
  return element.getChildren().filter(c => c.getName().toLowerCase() === tagName.toLowerCase());
}

/**
 * @description LLMが返したMarkdown形式や、途中で途切れた不完全なJSONを抽出し、可能な限りパース・修復します。
 * @param {string} text - LLMからの生の応答テキスト。
 * @returns {Object|null} 成功時はパース済みオブジェクト、修復不能な場合はnull。
 */
function cleanAndParseJSON_(text) {
  if (!text) return null;
  let cleaned = String(text).trim();

  // 1. Markdownのコードブロックを削除
  cleaned = cleaned.replace(/```json/gi, "").replace(/```/g, "").trim();

  // 2. 正常なJSONのパース試行 (AIが正しい形式で返せばここで100%成功する)
  const firstOpen = cleaned.indexOf('{');
  const lastClose = cleaned.lastIndexOf('}');

  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    let candidate = cleaned.substring(firstOpen, lastClose + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // 3. 【構文修復】AIが文字列内に未エスケープの「生の改行」を含めた場合の救済
      // 実際の改行をスペースに置換して再試行する
      try {
        let sanitized = candidate.replace(/\n/g, " ").replace(/\r/g, "");
        return JSON.parse(sanitized);
      } catch (e2) {
        // それでもダメなら最終手段へ
      }
    }
  }

  // 4. 【最終手段のフォールバック】
  try {
    const result = {};
    const tldrMatch = cleaned.match(/"(?:tldr|summary)"\s*:\s*"([\s\S]*?)(?:"|$)/);
    if (tldrMatch) result.tldr = tldrMatch[1].replace(/\n/g, " ");

    // 💡 正規表現を "(?:how|method)" に変更し、どちらが来ても救出できるようにする
    const methodMatch = cleaned.match(/"(?:how|method)"\s*:\s*"([\s\S]*?)(?:"|$)/);
    if (methodMatch) result.how = methodMatch[1].replace(/\n/g, " ");

    if (result.tldr || result.how || result.method) return result;
  } catch (err) {}

  Logger.log("JSON Parse Error (Raw text): " + text);
  return null;
}

/**
 * @description 2つの数値配列（ベクトル）のコサイン類似度を計算します。
 * @param {number[]} vecA - ベクトルA。
 * @param {number[]} vecB - ベクトルB。
 * @returns {number} 類似度（-1.0 〜 1.0）。
 */
function calculateCosineSimilarity_(vecA, vecB) {
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
 * @description 正規化済みの2つのベクトル間の内積（Dot Product）を計算します。
 * 長さが1のベクトル同士であれば、コサイン類似度と計算結果が完全一致しますが、
 * 平方根や割り算が不要なため計算コストが劇的に下がります。
 * ⚠️注意: 正規化されていないベクトル（平均ベクトル等）には使用しないでください。
 * @param {number[]} vecA - 正規化済みベクトルA
 * @param {number[]} vecB - 正規化済みベクトルB
 * @returns {number} 内積（類似度）
 */
function calculateDotProduct_(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return -1;
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
  }
  return dotProduct;
}

/**
 * parseVector
 * 【責務】ベクトル文字列を数値配列にパースする。
 */
function parseVector_(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string' && val.trim() !== "") {
    // エラー文字列が含まれている場合は即座に弾く
    if (val.includes("[Error]") || val.includes("Unknown")) return null;
    
    const arr = val.split(',').map(Number);
    // 配列の中に NaN が混ざっていたら失敗とみなす
    if (arr.some(isNaN)) return null;
    return arr;
  }
  return null;
}

/**
 * markdownToHtml（超安定・プレースホルダー置換版）
 */
function markdownToHtml_(md) {
  if (!md) return "";
  const C = AppConfig.get().UI.Colors;
  const S = {
    WRAPPER: `font-family:sans-serif; color:#333; line-height:1.6;`,
    CARD: `background:#fff; padding:20px; border:1px solid #ddd; border-radius:8px; margin-bottom:20px; box-shadow: 0 2px 4px rgba(0,0,0,0.02);`,
    H3: `font-size:17px; color:${C.SECONDARY}; border-bottom:2px solid ${C.PRIMARY}; padding-bottom:8px; margin:0 0 15px 0;`,
    ITEM: `margin-bottom:8px; font-size:14px;`,
    SOURCES_ROW: `margin-top:15px; padding-top:10px; border-top:1px dashed #eee; font-size:12px;`,
    BADGE: `display:inline-block; background:#eaf2f8; color:#0066cc; text-decoration:none; padding:3px 8px; border-radius:4px; font-size:11px; margin-right:6px; margin-bottom:4px; border:1px solid #d4e6f1; font-weight:bold;`
  };

  let html = md.replace(/```[\s\S]*?```/g, "").trim();
  
  // 1. セキュリティ対策（HTMLタグの無効化）
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 2. 太字の処理
  html = html.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');

  // 3. H3（カードの見出し）
  html = html.replace(/^###\s+(.*$)/gim, `<h3 style="${S.H3}">$1</h3>`);

  // 4. SOURCES行の特別処理 (デザインを切り離す)
  html = html.replace(/^\s*-\s*<strong>SOURCES:<\/strong>\s*(.*)$/gm, `<div style="${S.SOURCES_ROW}"><span style="color:#999; font-weight:bold; margin-right:8px;">SOURCES:</span> $1</div>`);

  // 5. 箇条書き（通常の - 項目: 内容）
  html = html.replace(/^\s*-\s*<strong>([^<]+):<\/strong>\s*(.*)$/gm, `<div style="${S.ITEM}"><strong>$1:</strong> $2</div>`);

  // 6. ここで暗号をリンクバッジに変換！ (エスケープ後なので安全)
  html = html.replace(/\[\[BADGE\|(\d+)\|([^\]]+)\]\]/g, (match, idx, url) => {
      return `<a href="${url}" target="_blank" style="${S.BADGE}">${idx}</a>`;
  });

  // 7. カード分割と組み立て
  const parts = html.split(/<h3/);
  let finalHtml = `<div style="${S.WRAPPER}">`;
  if (parts[0].trim()) finalHtml += parts[0].replace(/\n/g, "<br>");
  
  for (let i = 1; i < parts.length; i++) {
    finalHtml += `<div style="${S.CARD}"><h3` + parts[i].replace(/\n/g, "") + `</div>`;
  }
  finalHtml += `</div>`;

  return finalHtml;
}

/**
 * stripHtml
 * 【責務】HTML タグを除去してテキスト抽出（改行維持・実体参照デコード対応）
 * @param {string} html - HTML テキスト
 * @returns {string} プレーンテキスト
 */
function stripHtml_(html) {
  if (!html) return "";
  let text = String(html);
  // スクリプトやスタイルを削除
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
  // ブロック要素の終了タグを改行に変換
  text = text.replace(/<\/p>|<\/div>|<\/h\d>|<br\s*\/?>/gi, '\n');
  // 残りのタグを削除
  text = text.replace(/<[^>]*>?/gm, ' ');
  // 実体参照をデコード
  text = text.replace(/&nbsp;/g, ' ')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&amp;/g, '&')
             .replace(/&quot;/g, '"')
             .replace(/&apos;/g, "'")
             .replace(/&#39;/g, "'");
  // 連続するスペースを1つに整理し、改行を適切に処理
  return text.split('\n')
             .map(line => line.replace(/\s+/g, ' ').trim())
             .join('\n')
             .replace(/\n{3,}/g, '\n\n')
             .trim();
}

/**
 * decodeHtmlEntities
 * 【責務】HTML実体参照（&amp;等）を通常の文字に戻す。
 */
function decodeHtmlEntities_(text) {
  if (!text) return "";
  return text.replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/&#039;/g, "'")
             .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
}

/**
 * isLikelyEnglish
 * 【責務】テキストに日本語が含まれているか判定
 * @param {string} text - 判定対象テキスト
 * @returns {boolean} true=英語のみ, false=日本語含む
 */
function isLikelyEnglish_(text) {
  return !(/[぀-ゟ゠-ヿ一-鿿]/.test(text));
}

/**
 * グローバルキャッシュ（API呼び出しの節約・高速化のため）
 */
let _PromptCache = null;

/**
 * getPromptConfig (Google Drive JSON版・キャッシュ最適化)
 * 【責務】Drive上の prompts.json からプロンプトを取得する
 * @param {string} key - キー名（例:"WEB_ANALYSIS_SYSTEM", "BATCH_SYSTEM"）
 * @returns {string|null} プロンプト内容
 */
function getPromptConfig_(key) {
  // 1. メモリ上にキャッシュがあれば、即座にそれを返す（超高速）
  if (_PromptCache) {
    return _PromptCache[key] ? String(_PromptCache[key]).trim() : null;
  }

  // 2. スクリプトプロパティからJSONファイルのIDを取得
  const fileId = PropertiesService.getScriptProperties().getProperty("PROMPT_JSON_FILE_ID");
  
  if (!fileId) {
    Logger.log("⚠️ エラー: スクリプトプロパティ 'PROMPT_JSON_FILE_ID' が設定されていません。");
    return null;
  }

  try {
    // 3. DriveからJSONファイルを読み込み、パースしてキャッシュに保存
    const file = DriveApp.getFileById(fileId);
    const jsonText = file.getBlob().getDataAsString("UTF-8"); // UTF-8指定で文字化け防止
    _PromptCache = JSON.parse(jsonText);
    
    Logger.log("📂 Driveから prompts.json をロードしました。");
    
    // 4. 指定されたキーのプロンプトを返す
    return _PromptCache[key] ? String(_PromptCache[key]).trim() : null;
    
  } catch (e) {
    Logger.log(`❌ プロンプトJSONの読み込みエラー: ${e.toString()}`);
    return null;
  }
}

/**
 * getArticleContextForAnalysis_
 * 【責務】分析（miniモデル等）に最適な高密度テキストを生成する。
 * 構造化JSONからUnknown要素を排除し、論理的順序で再構成する。
 */
function getArticleContextForAnalysis_(article) {
  const headline = article.headline || "";
  if (!headline.trim().startsWith("{")) return headline; // JSONでなければそのまま

  const parsed = cleanAndParseJSON_(headline);
  if (!parsed) return headline;

  // 論理的優先順位: WHAT -> HOW -> RESULT -> WHO -> WHY -> WHEN -> WHERE -> TLDR -> KEYWORDS
  const parts = [];
  
  if (parsed.what && parsed.what !== "Unknown") parts.push(`[WHAT] ${parsed.what}`);
  if (parsed.how && parsed.how !== "Unknown") parts.push(`[HOW] ${parsed.how}`);
  if (parsed.result && parsed.result !== "Unknown") parts.push(`[RESULT] ${parsed.result}`);
  if (parsed.who && parsed.who !== "Unknown") parts.push(`[WHO] ${parsed.who}`);
  if (parsed.why && parsed.why !== "Unknown") parts.push(`[WHY] ${parsed.why}`);
  if (parsed.when && parsed.when !== "Unknown") parts.push(`[WHEN] ${parsed.when}`);
  if (parsed.where && parsed.where !== "Unknown") parts.push(`[WHERE] ${parsed.where}`);
  
  // 文脈補助として tldr と keywords も含める
  if (parsed.tldr) parts.push(`[TLDR] ${parsed.tldr}`);
  
  const kw = Array.isArray(parsed.keywords) ? parsed.keywords.join(", ") : (parsed.keywords || "");
  if (kw) parts.push(`[KEYWORDS] ${kw}`);

  return parts.length > 0 ? parts.join(" ") : (parsed.tldr || headline);
}

/**
 * @description 高度な検索クエリ（AND, OR, NOT, 括弧, 全角スペース）を解釈し、テキストが合致するか判定します。
 * @example "(AI OR 遺伝子) AND -投資" のような複雑な条件を判定可能。
 * @param {string} text - 検索対象の全文。
 * @param {string} query - 検索クエリ文字列。
 * @returns {boolean} マッチした場合はtrue。
 */
function isTextMatchQuery_(text, query) {
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
 * _logError
 * 【責務】エラーログを整形出力
 * @param {string} functionName - エラー発生関数名
 * @param {Error} error - エラーオブジェクト
 * @param {string} message - 補足メッセージ
 * @returns {none}
 */
function _logError_(functionName, error, message = "") {
  Logger.log(`[ERROR] ${functionName}: ${message} ${error.toString()} Stack: ${error.stack}`);
}

/** formatArticlesForLlm: 記事リストを整形（AI見出し優先 > 抜粋 > タイトル） */
function formatArticlesForLlm_(articles) {
  return articles.map(a => {
    const content = a.headline && a.headline.length > 10 ? a.headline : (a.abstractText || a.title);
    return `・タイトル: ${a.title}\n  内容: ${content}\n  URL: ${a.url}`;
  }).join('\n\n');
}

/**
 * 【責務】getArticlesInDateWindow: 指定期間内の記事を collectSheet から抽出
 * @description 指定した期間内の記事をcollectシートから抽出します。
 * @param {Date} start - 開始日時。
 * @param {Date} end - 終了日時。
 * @returns {Object[]} 整理済みの記事オブジェクト配列。
 */
function getArticlesInDateWindow_(start, end) {
  const sh = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  
  // 最適化: まず日付列だけを取得して範囲を特定する（シート全体の不要なデータ読み込みを回避）
  const dateValues = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  let startRowIndex = -1;
  let endRowIndex = -1;

  for (let i = 0; i < dateValues.length; i++) {
    const d = new Date(dateValues[i][0]);
    if (isNaN(d.getTime())) continue;
    if (d >= start && d < end) {
      if (startRowIndex === -1) startRowIndex = i;
    } else if (startRowIndex !== -1 && d < start) {
      endRowIndex = i;
      break;
    }
  }

  if (startRowIndex === -1) return []; // 期間内のデータなし
  if (endRowIndex === -1) endRowIndex = dateValues.length;

  const numRows = endRowIndex - startRowIndex;
  if (numRows <= 0) return [];

  // G列（ベクトル列）まで、特定した範囲だけを取得
  const cols = AppConfig.get().CollectSheet.Columns.VECTOR;
  const vals = sh.getRange(startRowIndex + 2, 1, numRows, cols).getValues();
  
  const out = [];
  for (const r of vals) {
    const date = r[0];
    if ((date instanceof Date) && date >= start && date < end) {
      const headline = r[4];
      const headlineStr = String(headline || "").trim();

      // 共通ヘルパーで正常な見出しのみを抽出
      if (isValidHeadline_(headlineStr)) {
        out.push(_createArticleObject_(r));
      }
    }
  }
  out.sort((a, b) => a.date - b.date);
  return out;
}

/**
 * fetchRecentArticlesBatch
 * 【責務】TrendDataシートから、指定された日数分（maxDays）の記事を一括取得してメモリに展開する。
 * 日付ソートされている前提で、古い記事は読み込まずメモリを節約する。
 */
// バッチ取得 (TrendData=公開シート)
function fetchRecentArticlesBatch_(maxDays) {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA); // 
  if (!sheet) return [];
  // ... (以下元のロジック通り) ...
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const dateValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxDays);
  cutoffDate.setHours(0, 0, 0, 0);
  let rowsToFetch = 0;
  for (let i = 0; i < dateValues.length; i++) {
    if (new Date(dateValues[i][0]) < cutoffDate) { rowsToFetch = i; break; }
    rowsToFetch = i + 1;
  }
  if (rowsToFetch === 0) return [];
  const colsToFetch = AppConfig.get().CollectSheet.Columns.VECTOR; 
  const rawData = sheet.getRange(2, 1, rowsToFetch, colsToFetch).getValues();
  const C = AppConfig.get().CollectSheet.Columns;
  return rawData.map(r => _createArticleObject_(r))
                .filter(a => isValidHeadline_(a.headline));
}

/**
 * @namespace RssStrikeCache
 * @description RSS取得失敗時の「ストライク（エラー回数）」を管理し、一時的なエラーと永続的な故障を判別するためのキャッシュ機構。
 */
const RssStrikeCache = {
  props: null,
  updates: {},
  init: function() {
    if (!this.props) this.props = PropertiesService.getScriptProperties().getProperties();
  },
  get: function(url) {
    this.init();
    const key = "RSS_STRIKE_" + Utilities.base64Encode(url).substring(0, 20);
    if (this.updates[key] !== undefined) return parseInt(this.updates[key] || "0", 10);
    return parseInt(this.props[key] || "0", 10);
  },
  add: function(url) {
    const key = "RSS_STRIKE_" + Utilities.base64Encode(url).substring(0, 20);
    this.updates[key] = String(this.get(url) + 1);
    Logger.log(`⚠️ RSS Strike ${this.updates[key]}: ${url}`);
  },
  reset: function(url) {
    this.init();
    const key = "RSS_STRIKE_" + Utilities.base64Encode(url).substring(0, 20);
    if (this.props[key] || this.updates[key]) {
      this.updates[key] = null; // nullは削除フラグ
    }
  },
  saveAll: function() {
    const keys = Object.keys(this.updates);
    if (keys.length === 0) return;
    const propsService = PropertiesService.getScriptProperties();
    const toSave = {};
    for (const key of keys) {
      if (this.updates[key] === null) propsService.deleteProperty(key);
      else toSave[key] = this.updates[key];
    }
    if (Object.keys(toSave).length > 0) propsService.setProperties(toSave);
    this.updates = {}; // リセット
  }
};

function _isRssBlacklisted_(url) {
  const maxStrikes = AppConfig.get().System.Limits.RSS_MAX_STRIKES || 3;
  return RssStrikeCache.get(url) >= maxStrikes;
}
function _addRssStrike_(url) {
  RssStrikeCache.add(url);
}
function _resetRssStrike_(url) {
  RssStrikeCache.reset(url);
}

/**
 * Keyword Observation Filter
 * 履歴比較を行わず、Keyword一致記事のみ抽出
 */
function filterArticlesByKeywords_(allArticles, keywords) {
  if (!keywords || keywords.length === 0) return [];

  // 🌟 【追加】ループに入る「前」に、全キーワードを英語・略称に一括拡張しておく
  const expandedKeywords = keywords.map(q => expandKeywordQuery_(q));

  return allArticles.filter(article => {
    const content = (
      String(article.title || "") + " " +
      String(article.headline || "") + " " +
      String(article.abstractText || "")
    );

    // 🌟 【変更】拡張済みのクエリを使って isTextMatchQuery_ で判定
    return expandedKeywords.some(query => isTextMatchQuery_(content, query));
  });
}

/**
 * isValidHeadline
 * 【責務】AIが生成した見出しが正常（エラーや空欄でない）か判定する共通ヘルパー
 */
function isValidHeadline_(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  if (s.indexOf("API Error") !== -1) return false;
  if (s.indexOf("[Error]") !== -1) return false;
  if (s.indexOf("Safety") !== -1) return false;
  return true;
}

/**
 * _createArticleObject
 * 【責務】シートの行データから統一された記事オブジェクトを生成する。
 */
function _createArticleObject_(row) {
  const C = AppConfig.get().CollectSheet.Columns;
  let dateObj = row[0];
  if (!(dateObj instanceof Date)) {
    dateObj = new Date(dateObj);
    if (isNaN(dateObj.getTime())) dateObj = new Date(); // フォールバック
  }
  const headlineStr = String(row[C.SUMMARY - 1] || "").trim();
  
  return {
    date: dateObj,
    title: row[C.URL - 2],
    url: row[C.URL - 1],
    abstractText: row[C.ABSTRACT - 1],
    headline: headlineStr,
    tldr: headlineStr, // 後方互換性のため付与
    source: row[C.SOURCE - 1] ? String(row[C.SOURCE - 1]) : "",
    vectorStr: row[C.VECTOR - 1],
    parsedVector: row[C.VECTOR - 1] ? parseVector_(row[C.VECTOR - 1]) : null
  };
}

// ---- ヘルパー：HTMLっぽい返却か判定 ----
function looksLikeHtmlStrict_(text, contentType) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  const ct = (contentType || "").toLowerCase();

  // Content-Typeが明確にHTML
  if (ct.includes("text/html")) return true;

  // 先頭がHTMLドキュメント
  if (t.startsWith("<!doctype html") || t.startsWith("<html")) return true;

  // <head>と<body>の両方があり、かつXML宣言がない場合はHTML寄り
  if (!t.startsWith("<?xml") && t.includes("<head") && t.includes("<body")) return true;

  // ※ "login" や "sign in" など “単語” では判定しない（RSS本文で普通に出るため）
  return false;
}

function looksLikeXml_(text, contentType) {
  const t = (text || "").trim().toLowerCase();
  const ct = (contentType || "").toLowerCase();

  // Content-Type優先（rss+xml / atom+xml / rdf+xml / xml）
  if (ct.includes("application/rss+xml")) return true;
  if (ct.includes("application/atom+xml")) return true;
  if (ct.includes("application/rdf+xml")) return true;
  if (ct.includes("xml")) return true;

  // 先頭判定（実データとしてXMLっぽい）
  return (
    t.startsWith("<?xml") ||
    t.startsWith("<rss") ||
    t.startsWith("<feed") ||
    t.startsWith("<rdf:rdf") ||
    t.startsWith("<rdf")
  );
}

// ---- ヘルパー：items=0 のとき、空フィードとして正常か分類 ----
function classifyEmptyFeed_(xml, url) {
  const t = (xml || "").trim();

  // Atom feed（Google Alerts/medRxivなど）：<feed> はあるが <entry> が無い＝新着なしの可能性
  const isAtom = t.startsWith("<feed") || t.includes('xmlns="http://www.w3.org/2005/Atom"');
  if (isAtom) {
    const hasEntry = /<entry[\s>]/i.test(t);
    if (!hasEntry) {
      // Google Alertsは空が普通に起こる
      if (String(url).includes("google.com/alerts/feeds") || String(url).includes("google.co.jp/alerts/feeds")) {
        return { isEmptyButOk: true, reason: "Atom feed（Google Alerts）：最近の結果なし/新着0件" };
      }
      // 一般のAtomでも「新着0件」はあり得るので、基本はOK扱い
      return { isEmptyButOk: true, reason: "Atom feed：新着0件の可能性（<entry>なし）" };
    }
  }

  // RSS feed：<rss>はあるが <item> が無い＝新着0件/形式差の可能性
  const isRss = /<rss[\s>]/i.test(t) || /<channel[\s>]/i.test(t);
  if (isRss) {
    const hasItem = /<item[\s>]/i.test(t);
    if (!hasItem) {
      return { isEmptyButOk: true, reason: "RSS feed：新着0件の可能性（<item>なし）" };
    }
  }

  // ここまで来ると「XMLっぽいがRSS/Atomとして判定不能」か「別形式」
  return { isEmptyButOk: false, reason: "XMLは取得できたがRSS/Atomとして記事抽出できず" };
}

/**
 * @description スプレッドシート操作などの不安定な処理を、指数バックオフでリトライ実行します。
 * @param {Function} func - 実行したい処理。
 * @param {number} [maxRetries=3] - 最大試行回数。
 */
function _withRetry_(func, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return func();
    } catch (e) {
      if (i === maxRetries - 1) throw e; 
      Logger.log(`⚠️ Spreadsheet busy. Retrying (${i + 1}/${maxRetries}): ${e.toString()}`);
      // 指数バックオフ：1秒, 2秒, 4秒... と待機を増やす
      Utilities.sleep(Math.pow(2, i) * 1000); 
      // 内部バッファを強制クリアして状態をリセット
      SpreadsheetApp.flush(); 
    }
  }
}

const _QueryExpansionCache = {}; // 拡張結果を一時記憶するキャッシュ

/**
 * @description 日本語キーワードをLLMで英語・略称のORクエリに拡張する
 */
function expandKeywordQuery_(originalQuery) {
  if (!originalQuery) return originalQuery;
  
  // すでにユーザーが自力で「AND」や「OR」を使っている複雑なクエリは、AIの介入をスキップ
  if (originalQuery.includes(" OR ") || originalQuery.includes(" AND ")) return originalQuery;
  
  // キャッシュにあれば一瞬で返す（同じ実行内でAPI通信を繰り返さないため）
  if (_QueryExpansionCache[originalQuery]) return _QueryExpansionCache[originalQuery];

  const systemPrompt = "あなたは医療・IT専門のクエリ拡張器です。入力されたキーワードを、同義の英語、専門用語、一般的な略称に展開し、それらを 'OR' で繋いだ単一の検索クエリ文字列のみを出力せよ。余計な解説やダブルクォーテーション(\")などの記号は一切不要。複数単語からなる英語は括弧で囲むこと。\n出力例: 乳がん OR (Breast cancer) OR TNBC";
  
  // 🌟 安定させるため、Nanoモデル＆Temperature 0.0 (ブレなし) を指定して爆速で展開
  const res = LlmService.analyzeKeywordSearch(
    systemPrompt, 
    "キーワード: " + originalQuery, 
    { model: "nano", temperature: 0.0, taskLabel: "クエリ拡張" }
  );
  
  // 拡張に失敗した場合は元のクエリをそのまま使う
  const expanded = (res && res.includes("OR")) ? res.replace(/`/g, "").trim() : originalQuery;
  
  // キャッシュに保存して返す
  _QueryExpansionCache[originalQuery] = expanded;
  Logger.log(`🔍 クエリ自動拡張: [${originalQuery}] -> [${expanded}]`);
  
  return expanded;
}

// #endregion

// =============================================================================
// #region 8. DEVELOPER TOOLS (Tests)
// 【責務】開発・保守のための「診断ツール」。
//  - ロジックテスト・疎通確認
//  - RSSフィード診断
//  - 手動メンテナンスツール
// =============================================================================

/**
 * @description 全てのロジックテスト（正規表現、計算、パース等）を一括実行し、ログに結果を出力します。
 */
function runAllTests() {
  Logger.log("--- [YATA] ロジックテスト開始 ---");
  try {
    _test_AppConfig_();
    _test_parseVector_();
    _test_isTextMatchQuery_();
    _test_normalizeUrl_();
    _test_parseRssXml_Fallback_();
    _test_EmergingSignalEngine_();
    _test_cleanAndParseJSON_();        // AI出力のパーステスト
    _test_calculateCosineSimilarity_(); // ベクトル計算のテスト
    _test_calculateDotProduct_();       // 内積計算（爆速化）のテスト
    
    Logger.log("✅ 全てのロジックテストに合格しました。");
  } catch (e) {
    Logger.log("❌ テスト失敗: " + e.message);
    throw e;
  }
}

/**
 * _test_parseRssXml_Fallback
 * 【責務】意図的に壊れたXMLを入力し、正規表現フォールバックが正しく発動するか検証する。
 */
function _test_parseRssXml_Fallback_() {
  Logger.log("test_parseRssXml_Fallback: 開始");
  
  // XmlService.parse で必ずエラーになる不正なXML（&のエスケープ漏れ、閉じタグなし等）
  const brokenXml = `
    <rss version="2.0">
      <channel>
        <title>Broken Feed</title>
        <item>
          <title>Test Title & Broken</title>
          <link>https://example.com/fallback-test</link>
          <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
          <description>Description with <unclosed tag</description>
        </item>
      </channel>
    </rss>
  `;

  // テスト実行（第2引数はダミーURL）
  const items = parseRssXml_(brokenXml, "http://test.local/feed");
  
  if (!items || items.length !== 1) {
    throw new Error(`フォールバック失敗: 期待値 1件, 実際 ${items ? items.length : 0}件`);
  }
  
  const item = items[0];
  
  // 判定1: 正規表現モードで取れたか
  if (item.source !== "RegexFallback") {
    throw new Error(`ソース判定失敗: 期待値 RegexFallback, 実際 ${item.source}`);
  }
  
  // 判定2: タイトルが取れているか（& が含まれていても取れるべき）
  if (!item.title.includes("Test Title")) {
    throw new Error(`タイトル抽出失敗: ${item.title}`);
  }
  
  // 判定3: リンクが取れているか
  if (item.link !== "https://example.com/fallback-test") {
    throw new Error(`リンク抽出失敗: ${item.link}`);
  }

  Logger.log("test_parseRssXml_Fallback: OK (壊れたXMLから正規表現で抽出成功)");
}

/**
 * _test_EmergingSignalEngine
 * 予兆検知エンジンの計算ロジック（重心・アウトライヤー・核形成）を検証。
 */
function _test_EmergingSignalEngine_() {
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
    const sim = calculateCosineSimilarity_(avg, a.vector);
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
      const sim = calculateCosineSimilarity_(outliers[i].vector, outliers[j].vector);
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
function _test_AppConfig_() {
  const config = AppConfig.get();
  if (!config.System || !config.System.Limits.BATCH_SIZE || !config.UI.Colors.PRIMARY) {
    throw new Error("AppConfigの構造が不正、または必須項目が不足しています。");
  }
  Logger.log("test_AppConfig: OK");
}

/**
 * _test_parseVector: ベクトル文字列のパース確認
 */
function _test_parseVector_() {
  const input = "0.123,0.456,-0.789";
  const result = parseVector_(input);
  if (!result || result.length !== 3 || result[0] !== 0.123 || result[2] !== -0.789) {
    throw new Error("parseVectorの出力が期待値と異なります。");
  }
  Logger.log("test_parseVector: OK");
}

/**
 * _test_isTextMatchQuery: キーワード検索ロジックの検証
 */
function _test_isTextMatchQuery_() {
  const text = "Google Apps ScriptはクラウドベースのJavaScriptプラットフォームです。";
  
  // AND検索
  if (!isTextMatchQuery_(text, "Google Script")) throw new Error("isTextMatchQuery: AND検索に失敗しました。");
  // OR検索
  if (!isTextMatchQuery_(text, "Python OR Script")) throw new Error("isTextMatchQuery: OR検索に失敗しました。");
  // NOT検索
  if (isTextMatchQuery_(text, "Google -Script")) throw new Error("isTextMatchQuery: NOT検索に失敗しました。");
  // 複雑な組み合わせ
  if (!isTextMatchQuery_(text, "(Google OR Python) Script -Ruby")) throw new Error("isTextMatchQuery: 複雑な検索に失敗しました。");
  
  // 優先順位の検証 (AND > OR)
  // "Google OR Python AND Ruby"
  // 新ロジック: Google OR (Python AND Ruby) -> True OR False -> True
  // 旧ロジック: (Google OR Python) AND Ruby -> True AND False -> False
  if (!isTextMatchQuery_(text, "Google OR Python AND Ruby")) throw new Error("isTextMatchQuery: 優先順位(OR < AND)の検証に失敗しました。旧ロジックのままの可能性があります。");

  Logger.log("test_isTextMatchQuery: OK");
}

/**
 * _test_normalizeUrl: URL正規化の検証
 */
function _test_normalizeUrl_() {
  const url1 = "https://example.com/path?utm_source=test";
  const url2 = "http://www.example.com/path/";
  
  if (normalizeUrl_(url1) !== "//example.com/path") throw new Error("normalizeUrl: パラメータの除去に失敗しました。");
  if (normalizeUrl_(url2) !== "//example.com/path") throw new Error("normalizeUrl: プロトコル/www/末尾スラッシュの正規化に失敗しました。");
  
  Logger.log("test_normalizeUrl: OK");
}

/**
 * debugRssFeed (修正版)
 * 本番と同じ parseRssXml を使用して診断を行う。これにより特殊なフィードも正しくデバッグ可能。
 * これにより、MobiHealthNewsのような特殊なフィードも正しくデバッグできます。
 */
function debugRssFeed() {
  // スクリプトプロパティから取得。設定されていなければデフォルトのGoogleニュースを使用
  const props = PropertiesService.getScriptProperties();
  const TEST_URL = props.getProperty("DEBUG_RSS_URL") || "https://news.google.com/rss";
  
  // 初回や未設定時のための親切なガイド
  if (!props.getProperty("DEBUG_RSS_URL")) {
    Logger.log("💡 ヒント: スクリプトプロパティ 'DEBUG_RSS_URL' にテストしたいURLを設定すると、コードを書き換えずに任意のRSSを診断できます。");
  }

  Logger.log(`--- テスト開始: ${TEST_URL} ---`);
  
  try {
    const options = {
      'muteHttpExceptions': true,
      'validateHttpsCertificates': false,
      'headers': AppConfig.get().System.HttpHeaders
    };

    const response = UrlFetchApp.fetch(TEST_URL, options);
    const code = response.getResponseCode();
    Logger.log(`レスポンスコード: ${code}`);
    
    if (code !== 200) {
      Logger.log("【原因】: サーバーエラーです。URLが間違っているか、ブロックされています。");
      return;
    }
    
    const xml = response.getContentText();
    Logger.log(`取得データの先頭500文字:\n${xml.substring(0, 500)}`);

    // ここで本番用の最強パーサーを呼び出す
    Logger.log("\n--- 解析実行 (parseRssXml) ---");
    const items = parseRssXml_(xml, TEST_URL);
    
    Logger.log(`検出された記事数: ${items.length} 件`);
    
    if (items.length > 0) {
      const item = items[0];
      
      Logger.log(`\n【先頭の記事データサンプル】`);
      Logger.log(`タイトル: ${item.title}`);
      Logger.log(`リンク: ${item.link}`);
      Logger.log(`日付文字列: ${item.pubDate}`);
      
      // 日付判定テスト
      const dateObj = new Date(item.pubDate);
      if (!isNaN(dateObj.getTime())) {
        const now = new Date();
        const diffDays = (now - dateObj) / (1000 * 60 * 60 * 24);
        Logger.log(`現在との差: 約 ${Math.floor(diffDays)} 日前`);
      } else {
        Logger.log(`日付判定: パースできませんでした (${item.pubDate})`);
      }
      
      Logger.log("\n✅ 解析成功！このフィードは正常に読み取れます。");
    } else {
      Logger.log("\n❌ 解析失敗: 記事が0件でした。");
      Logger.log("考えられる原因:");
      Logger.log("1. XMLのタグ構造がさらに特殊である");
      Logger.log("2. そもそも記事が含まれていない空のフィードである");
    }
    
  } catch (e) {
    Logger.log(`【エラー】: 解析中にエラーが発生しました。\n${e.toString()}`);
  }
}

/**
 * testAllRssFeeds
 * 【責務】RSSシートに登録されている全URLをテストし、接続やパースの成否を診断レポートとしてログ出力する。
 * 【用途】「どのフィードが死んでいるか」を一括チェックする開発用ツール。
 */
function testAllRssFeeds() {
  const sheet = getSheet_(AppConfig.get().SheetNames.RSS_LIST);
  if (!sheet) {
    Logger.log("エラー: RSSシートが見つかりません。");
    return;
  }

  const startRow = AppConfig.get().RssListSheet.DataRange.START_ROW;
  const lastRow = sheet.getLastRow();
  if (lastRow < startRow) {
    Logger.log("RSSリストが空です。");
    return;
  }

  const data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 2).getValues();

  Logger.log(`--- RSS全件診断開始 (対象: ${data.length}件) ---`);


  const baseHeaders = AppConfig.get().System.HttpHeaders;
  const options = {
    muteHttpExceptions: true,
    validateHttpsCertificates: false,
    headers: {
      ...baseHeaders,
      "Accept": "application/atom+xml,application/rss+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  };

  // 集計
  let success = 0;
  let emptyOk = 0;
  let fail = 0;

  const details = []; // {row, name, url, status, code, reason, hint}

  data.forEach((row, idx) => {
    const name = row[0];
    const url = row[1];
    const rowNum = startRow + idx;
    if (!url) return;

    try {
      const res = UrlFetchApp.fetch(url, options);
      const code = res.getResponseCode();
      const headers = (typeof res.getHeaders === "function") ? res.getHeaders() : {};
      const ctype = (headers && (headers["Content-Type"] || headers["content-type"])) ? String(headers["Content-Type"] || headers["content-type"]) : "";
      const body = res.getContentText() || "";
      const head = body.substring(0, 300).replace(/\s+/g, " ").trim();

      if (code !== 200) {
        fail++;
        details.push({
          row: rowNum, name, url,
          status: "FAIL",
          code,
          reason: `HTTP Error ${code}`,
          hint: ""
        });
        return;
      }


      // XMLかどうかを先に判定（Content-Typeと先頭で判定）
      const isXml = looksLikeXml_(body, ctype);

      // XMLでない場合だけHTML判定をする（XMLなら絶対にHTML扱いしない）
      if (!isXml && looksLikeHtmlStrict_(body, ctype)) {
        fail++;
        details.push({
          row: rowNum, name, url,
          status: "FAIL",
          code,
          reason: "200だがHTML返却（ブロック/リダイレクト/ログイン誘導の疑い）",
          hint: `Content-Type=${ctype} / head="${head.slice(0, 120)}..."`
        });
        return;
      }


      // パース（Atom/RSS/RDF対応済み）
      const items = parseRssXml_(body, url);

      if (items && items.length > 0) {
        success++;
        return;
      }

      // items=0 の場合：空フィード（正常）か、構造違い/別形式かを分類
      const emptyKind = classifyEmptyFeed_(body, url);

      if (emptyKind.isEmptyButOk) {
        emptyOk++;
        details.push({
          row: rowNum, name, url,
          status: "EMPTY_BUT_OK",
          code,
          reason: emptyKind.reason,
          hint: `head="${head.slice(0, 120)}..."`
        });
      } else {
        fail++;
        details.push({
          row: rowNum, name, url,
          status: "FAIL",
          code,
          reason: emptyKind.reason || "記事数0件（XML構造違い/未知形式の可能性）",
          hint: `Content-Type=${ctype} / head="${head.slice(0, 120)}..."`
        });
      }

    } catch (e) {
      fail++;
      details.push({
        row: rowNum, name, url,
        status: "FAIL",
        code: "EXCEPTION",
        reason: e.message || String(e),
        hint: ""
      });
    }
  });

  Logger.log("\n=============================");
  Logger.log(" RSS 診断レポート ");
  Logger.log("=============================");
  Logger.log(`✅ SUCCESS: ${success} 件`);
  Logger.log(`🟡 EMPTY_BUT_OK: ${emptyOk} 件`);
  Logger.log(`❌ FAIL: ${fail} 件`);

  // FAIL と EMPTY_BUT_OK だけ詳細表示（成功は数が多いので省略）
  const show = details.filter(d => d.status !== "SUCCESS");
  if (show.length > 0) {
    Logger.log("\n【詳細】");
    show.forEach(d => {
      Logger.log(
        `Row ${d.row}: [${d.name}] - ${d.status} - ${d.reason}\n` +
        `  URL: ${d.url}\n` +
        `  Code: ${d.code}\n` +
        (d.hint ? `  Hint: ${d.hint}\n` : "")
      );
    });
  } else {
    Logger.log("\n🎉 全フィードが正常（または空でも正常扱い）です。");
  }
}

/**
 * debugPersonalReport
 * 【開発用】管理者(MAIL_TO)だけに特定のキーワードでレポートをテスト送信するヘルパー関数
 */
function debugPersonalReport() {
  // テスト設定
  const TEST_KEYWORD = "AI";  // テストしたいキーワード
  const LOOKBACK_DAYS = 7; 

  const config = AppConfig.get();
  const adminMail = config.Digest.mailTo;
  
  if (!adminMail) {
    Logger.log("エラー: スクリプトプロパティ MAIL_TO が設定されていません。");
    return;
  }

  Logger.log(`=== テスト送信開始 (Save History: OFF) ===`); // ログも変更
  
  const { start, end } = getDateWindow_(LOOKBACK_DAYS);
  const allArticles = getArticlesInDateWindow_(start, end);
  
  const targetItems = [{ query: TEST_KEYWORD, label: TEST_KEYWORD }];
  
  // ここで saveHistory: false を渡す
  const html = generateTrendReportHtml_(allArticles, targetItems, start, end, {
    useSemantic: false,
    enableHistory: true, // 履歴を読む (前回との比較をする)
    saveHistory: false   // 履歴には書き込まない (汚さない)
  });

  if (!html) {
    Logger.log(`⚠️ 記事が見つかりませんでした。`);
    return;
  }

  sendDigestEmail_(null, html, null, 7, {
    recipient: adminMail,
    subjectOverride: `【デザイン確認】YATAレポート: ${TEST_KEYWORD}`,
    isHtml: true
  });

  Logger.log("✅ 送信完了（DigestHistoryは更新されていません）。");
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

/**
 * toolExportArchivesToSheet
 * 【役割】Driveに保存された過去のJSONアーカイブをすべて読み込み、
 * 「Restored_Archive」という新しいシートにリスト化して復元する。
 * 日付フォーマット (yyyy/MM/dd H:mm:ss)
 */
function toolExportArchivesToSheet() {
  const config = AppConfig.get();
  const folderId = config.System.Archive.FOLDER_ID; 
  const targetSheetId = config.System.DataSheetId; 

  if (!folderId) {
    Logger.log("エラー: アーカイブフォルダIDが設定されていません。");
    return;
  }
  if (!targetSheetId) {
    Logger.log("エラー: データシートIDが設定されていません。");
    return;
  }

  const ss = SpreadsheetApp.openById(targetSheetId);
  let sheet = ss.getSheetByName("Restored_Archive");
  
  if (!sheet) {
    sheet = ss.insertSheet("Restored_Archive");
    sheet.appendRow(["Date", "Title", "URL", "Abstract", "Summary", "Source", "Vector"]);
    sheet.getRange(1, 1, 1, 7).setFontWeight("bold").setBackground("#ddd");
  } else {
    sheet.clear();
    sheet.appendRow(["Date", "Title", "URL", "Abstract", "Summary", "Source", "Vector"]);
    sheet.getRange(1, 1, 1, 7).setFontWeight("bold").setBackground("#ddd");
  }

  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles();
  
  let totalCount = 0;
  const timeZone = Session.getScriptTimeZone(); // タイムゾーン取得

  Logger.log("アーカイブの読み込みを開始します...");

  while (files.hasNext()) {
    const file = files.next();
    
    if (file.getMimeType() === MimeType.PLAIN_TEXT && file.getName().startsWith("YATA_Archive_")) {
      try {
        const jsonText = file.getBlob().getDataAsString();
        const data = JSON.parse(jsonText); 
        
        if (data && data.length > 0) {
          // ここで日付フォーマット変換を追加
          const formattedData = data.map(row => {
            // 1列目(row[0])が日付文字列の場合のみ変換
            if (row[0]) {
              const d = new Date(row[0]);
              // "2026/01/06 2:57:01" の形式に変換
              row[0] = Utilities.formatDate(d, timeZone, "yyyy/MM/dd H:mm:ss");
            }
            return row;
          });

          const startRow = sheet.getLastRow() + 1;
          const numRows = formattedData.length;
          const numCols = formattedData[0].length;
          
          sheet.getRange(startRow, 1, numRows, numCols).setValues(formattedData);
          
          totalCount += numRows;
          Logger.log(`[復元] ${file.getName()}: ${numRows} 件を追加しました。`);
        }
      } catch (e) {
        Logger.log(`[エラー] ${file.getName()} の読み込みに失敗: ${e.message}`);
      }
    }
  }

  Logger.log(`完了: 合計 ${totalCount} 件のデータを「Restored_Archive」シートに復元しました。`);
  Logger.log(`以下のスプレッドシートを確認してください:\n${ss.getUrl()}`);
}

/**
 * toolBackfillHistoryVectors
 * 【責務】DigestHistoryシートの既存データ（過去の要約）にベクトルを一括付与する。
 * これを実行すると、過去の履歴も「連想検索」の対象になります。
 */

function toolBackfillHistoryVectors() {
  const sheet = getSheet_(AppConfig.get().SheetNames.DIGEST_HISTORY);
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("履歴データがありません。");
    return;
  }

  // A列(Date)〜C列(Summary)を取得
  // D列(Vector)はこれから書き込むので、範囲外でもOK（なければ拡張される）
  const range = sheet.getRange(2, 1, lastRow - 1, 4); // D列まで確保
  const values = range.getValues();
  
  let updateCount = 0;
  
  // 処理開始
  Logger.log(`履歴のベクトル生成を開始します (対象: ${values.length}件)...`);

  for (let i = 0; i < values.length; i++) {
    const summary = String(values[i][2]).trim(); // C列: Summary
    const currentVector = values[i][3];          // D列: Vector
    
    // 要約があり、かつベクトルがまだ無い場合のみ処理
    if (summary && (!currentVector || String(currentVector) === "")) {
      try {
        // ベクトル生成
        const vector = LlmService.generateVector(summary);
        
        if (vector) {
          values[i][3] = vector.join(','); // D列にセット
          updateCount++;
        }
        
        // APIレート制限考慮 (1秒待機)
        Utilities.sleep(1000);
        
        if (updateCount % 5 === 0) {
          Logger.log(`... ${updateCount} 件 処理完了`);
        }

      } catch (e) {
        Logger.log(`Error at row ${i + 2}: ${e.message}`);
      }
    }
  }

  if (updateCount > 0) {
    // まとめて書き込み
    range.setValues(values);
    Logger.log(`完了: ${updateCount} 件の過去履歴にベクトルを付与しました。`);
  } else {
    Logger.log("全ての履歴に既にベクトルが付与されています。");
  }
}

/**
 * _test_cleanAndParseJSON
 * 【責務】LLMが返してくる「崩れたJSON」を正しく修復してパースできるか検証する。
 * これが失敗すると、AI要約や分析機能がエラーになります。
 */
function _test_cleanAndParseJSON_() {
  Logger.log("test_cleanAndParseJSON: 開始");

  // ケース1: 正常なJSON
  const valid = '{"tldr": "OK"}';
  if (cleanAndParseJSON_(valid).tldr !== "OK") throw new Error("正常なJSONのパースに失敗");

  // ケース2: Markdown記法付き (```json ... ```)
  const markdown = '```json\n{"tldr": "Markdown"}\n```';
  if (cleanAndParseJSON_(markdown).tldr !== "Markdown") throw new Error("Markdown除去に失敗");

  // ケース3: 壊れたJSON (閉じカッコ忘れ) -> 正規表現による自己修復の発動確認
  const broken = '{"tldr": "Recovered text...'; 
  const recovered = cleanAndParseJSON_(broken);
  // 自己修復ロジックが "Recovered text..." を抜き出せるか
  if (!recovered || recovered.tldr !== "Recovered text...") {
    throw new Error("壊れたJSONの自己修復に失敗 (Regex Fallback)");
  }

  // ケース4: 改行が含まれるケース (JSON仕様違反だがAIはよくやる)
  const withNewlines = '{\n"tldr": "Line1\nLine2"\n}';
  const parsed = cleanAndParseJSON_(withNewlines);
  if (!parsed || !parsed.tldr.includes("Line1")) {
    throw new Error("改行を含むJSONのパースに失敗");
  }

  Logger.log("test_cleanAndParseJSON: OK");
}

/**
 * _test_calculateCosineSimilarity
 * 【責務】ベクトル検索の計算精度を検証する。
 */
function _test_calculateCosineSimilarity_() {
  Logger.log("test_calculateCosineSimilarity: 開始");

  const v1 = [1, 0, 0];
  const v2 = [0, 1, 0];
  const v3 = [1, 1, 0];
  
  // 直交するベクトル (類似度 0)
  if (calculateCosineSimilarity_(v1, v2) !== 0) throw new Error("直交ベクトルの計算ミス");

  // 同じベクトル (類似度 1)
  if (Math.abs(calculateCosineSimilarity_(v1, v1) - 1.0) > 0.0001) throw new Error("同一ベクトルの計算ミス");

  // 45度の関係 (類似度 0.707...)
  const sim = calculateCosineSimilarity_(v1, v3);
  // 1 / sqrt(2) ≒ 0.7071
  if (Math.abs(sim - 0.7071) > 0.001) throw new Error(`計算精度エラー: 期待値~0.707, 実際 ${sim}`);

  Logger.log("test_calculateCosineSimilarity: OK");
}

/**
 * _test_calculateDotProduct
 * 【責務】内積計算ロジックが正規化済みベクトルに対して正しく機能するか検証する。
 */
function _test_calculateDotProduct_() {
  Logger.log("test_calculateDotProduct: 開始");

  // 正規化済みのベクトルを用意 (長さがピッタリ1になるように設定)
  const v1 = [1, 0, 0];
  const v2 = [0, 1, 0];
  // 1/√2 ≒ 0.70710678
  const v3 = [0.70710678, 0.70710678, 0];

  // 1. 同一ベクトル (期待値: 1)
  if (Math.abs(calculateDotProduct_(v1, v1) - 1.0) > 0.0001) throw new Error("同一ベクトルの計算ミス");

  // 2. 直交ベクトル (期待値: 0)
  if (calculateDotProduct_(v1, v2) !== 0) throw new Error("直交ベクトルの計算ミス");

  // 3. 45度の関係 (期待値: 約0.7071)
  const sim = calculateDotProduct_(v1, v3);
  if (Math.abs(sim - 0.70710678) > 0.001) throw new Error(`計算精度エラー: 期待値~0.707, 実際 ${sim}`);

  Logger.log("test_calculateDotProduct: OK");
}

/**
 * @description RSSリストの全URLの応答速度（レイテンシ）を計測し、遅延の激しいソースを特定します。
 */
function diagnoseRssLatency() {
  const sheet = getSheet_(AppConfig.get().SheetNames.RSS_LIST);
  if (!sheet) return;

  // データ取得
  const startRow = AppConfig.get().RssListSheet.DataRange.START_ROW;
  const lastRow = sheet.getLastRow();
  const data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 2).getValues();

  Logger.log(`--- 🐢 RSS応答速度診断 (全${data.length}件) ---`);
  Logger.log("※ 1件ずつ通信するため、数分かかります。途中でタイムアウトしたら、ログに出ているところまでが計測結果です。");

  const results = [];
  
  // Bot判定を避けるヘッダー
  const options = {
    'muteHttpExceptions': true,
    'validateHttpsCertificates': false,
    'headers': AppConfig.get().System.HttpHeaders
  };

  for (let i = 0; i < data.length; i++) {
    const name = data[i][0];
    const url = data[i][1];
    if (!url) continue;

    const startTime = new Date().getTime();
    let status = "OK";
    let size = 0;

    try {
      // 計測開始
      const response = UrlFetchApp.fetch(url, options);
      const endTime = new Date().getTime();
      
      const duration = endTime - startTime;
      const code = response.getResponseCode();
      size = response.getContentText().length;

      // 結果を保存
      results.push({
        index: i + 2, // 行番号
        name: name,
        url: url,
        time: duration,
        code: code,
        size: size
      });
      
      // 進捗ログ (遅いものだけリアルタイム表示)
      if (duration > 3000) {
        Logger.log(`⚠️ [遅延検知] Row ${i+2}: ${duration}ms - ${name}`);
      }

    } catch (e) {
      const endTime = new Date().getTime();
      results.push({
        index: i + 2,
        name: name,
        url: url,
        time: endTime - startTime, // エラーになるまでにかかった時間
        code: "ERROR",
        size: 0,
        error: e.message
      });
      Logger.log(`❌ [エラー] Row ${i+2}: ${e.message}`);
    }
  }

  // --- 集計とランキング表示 ---
  
  // 遅い順（降順）にソート
  results.sort((a, b) => b.time - a.time);

  Logger.log("\n===================================");
  Logger.log("     🐢 ワースト遅延ランキング (Top 10)     ");
  Logger.log("===================================");

  const top10 = results.slice(0, 10);
  top10.forEach((r, idx) => {
    const icon = r.code === 200 ? (r.time > 5000 ? "🟥" : "🟨") : "💀";
    Logger.log(`${idx + 1}. ${icon} ${r.time}ms | Row:${r.index} | ${r.name}`);
    Logger.log(`    URL: ${r.url}`);
    if (r.error) Logger.log(`    Err: ${r.error}`);
  });

  Logger.log("\n【判定基準】");
  Logger.log("🟢 1000ms未満: 優秀");
  Logger.log("🟨 3000ms以上: 注意 (GASだと足を引っ張ります)");
  Logger.log("🟥 10000ms以上: 危険 (即削除推奨)");
  Logger.log("💀 ERROR: タイムアウトまたは接続拒否");
}

/**
 * NanoとMiniのLLM接続をシンプルに確認する関数
 */
function debugLlmConnection() {
  Logger.log("=== LLM接続テスト開始 ===");

  // -----------------------------------------------
  // 1. Nano モデルのテスト (Summarize機能)
  // -----------------------------------------------
  Logger.log("📡 1. Nanoモデル (要約) テスト中...");
  try {
    // AIが「要約しがいがある」と感じる長めのダミー記事にする
    const dummyText = `
      OpenAI has announced a new series of AI models designed to spend more time thinking before they respond. 
      They can reason through complex tasks and solve harder problems than previous models in science, coding, and math. 
      This new series is named o1. We are releasing the first of this series in ChatGPT and our API today.
    `.trim();

    const resultNano = LlmService.summarize(dummyText);
    
    // JSON文字列として返ってくる場合と、パース済みの場合を考慮
    let content = resultNano;
    if (typeof resultNano === 'object') {
        content = resultNano.tldr || JSON.stringify(resultNano);
    } else if (resultNano.includes("{")) {
        // 文字列の中にJSONがある場合
        try {
            const parsed = JSON.parse(resultNano);
            content = parsed.tldr || resultNano;
        } catch(e) {}
    }

    if (content && content.length > 0 && content !== '""') {
      Logger.log("✅ Nano成功！");
      Logger.log("応答: " + content);
    } else {
      Logger.log("⚠️ Nano応答あり（空）");
      Logger.log("元データ: " + resultNano);
      Logger.log("※接続は成功しています。モデルが「要約不要」と判断した可能性があります。");
    }
  } catch (e) {
    Logger.log("❌ Nano例外: " + e.toString());
  }

  // -----------------------------------------------
  // 2. Mini モデルのテスト (DailyDigest機能)
  // -----------------------------------------------
  Logger.log("📡 2. Miniモデル (チャット) テスト中...");
  try {
    const resultMini = LlmService.generateDailyDigest(
      "You are a helpful assistant.", 
      "Test connection. Just say 'OK'."
    );

    if (resultMini && resultMini.length > 0 && !resultMini.includes("失敗")) {
      Logger.log("✅ Mini成功！");
      Logger.log("応答: " + resultMini);
    } else {
      Logger.log("❌ Mini失敗 (空またはエラー)");
      Logger.log("応答内容: " + resultMini);
    }
  } catch (e) {
    Logger.log("❌ Mini例外: " + e.toString());
  }

  Logger.log("\n=== テスト終了 ===");
}

/**
 * 全てのRSSブラックリスト（ストライク履歴）を強制リセットする
 */
function resetAllRssStrikes() {
  const props = PropertiesService.getScriptProperties();
  const keys = props.getKeys();
  let count = 0;
  
  for (const key of keys) {
    if (key.startsWith("RSS_STRIKE_")) {
      props.deleteProperty(key);
      count++;
    }
  }
  Logger.log(`完了: ${count} 件のRSSブラックリストを解除しました。`);
}

/**
 * toolFixEnglishSummaries
 * 【開発・メンテ用】英語で出力されてしまった見出しを検知し、再度AI（Nano）で並列要約し直す。
 */
function toolFixEnglishSummaries() {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  if (!sheet) return;
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("データがありません。");
    return;
  }

  // 直近の5000件を対象とする（シート全体だと重いため）
  const SEARCH_LIMIT = AppConfig.get().System.Limits.TOOL_SEARCH_LIMIT || 5000;
  const numRows = Math.min(lastRow - 1, SEARCH_LIMIT);
  
  // 列インデックス
  const TITLE_COL = AppConfig.get().CollectSheet.Columns.URL - 2;
  const ABS_COL = AppConfig.get().CollectSheet.Columns.ABSTRACT - 1;
  const SUM_COL = AppConfig.get().CollectSheet.Columns.SUMMARY - 1;
  const VEC_COL = AppConfig.get().CollectSheet.Columns.VECTOR - 1;
  
  const maxCol = Math.max(sheet.getLastColumn(), VEC_COL + 1);
  const values = sheet.getRange(2, 1, numRows, maxCol).getValues();
  
  const targets = [];
  
  // 1. 英語の要約を検知
  for (let i = 0; i < values.length; i++) {
    const summary = String(values[i][SUM_COL] || "").trim();
    const title = values[i][TITLE_COL];
    const abstractText = values[i][ABS_COL];
    
    // 空でなく、エラーメッセージでもないものを対象
    if (summary && !summary.includes("API Error") && !summary.includes("[Error]")) {
      // isLikelyEnglish = 日本語が含まれていなければ true
      if (isLikelyEnglish_(summary)) {
        targets.push({
          rowIndex: i,
          title: title,
          abstractText: abstractText,
          oldSummary: summary
        });
      }
    }
  }

  if (targets.length === 0) {
    Logger.log("✅ 英語の要約は見つかりませんでした（すべて日本語または正常です）。");
    return;
  }

  Logger.log(`🚨 ${targets.length} 件の「英語の要約」を検出しました。並列再要約を開始します...`);

  // 2. 爆速バッチで再要約
  const BATCH_SIZE = AppConfig.get().System.Limits.LLM_BATCH_SIZE;
  let processedCount = 0;
  let minIdx = -1;
  let maxIdx = -1;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const chunk = targets.slice(i, i + BATCH_SIZE);
    const articleTexts = chunk.map(t => `Title: ${t.title}\nAbstract: ${t.abstractText}`);
    
    Logger.log(`[${i + 1} 〜 ${Math.min(i + BATCH_SIZE, targets.length)} / ${targets.length}] 再要約中...`);
    
    // 先ほど作った並列要約メソッドを再利用！
    const batchResults = LlmService.summarizeBatch(articleTexts);
    
    batchResults.forEach((jsonString, idx) => {
      const target = chunk[idx];
      let newHeadline = null;
      
      if (jsonString && !String(jsonString).includes("API Error")) {
        try {
          const parsedJson = cleanAndParseJSON_(jsonString);
          if (parsedJson) newHeadline = parsedJson.tldr || parsedJson.summary;
          if (!newHeadline) newHeadline = String(jsonString).trim();
        } catch (e) {
          newHeadline = String(jsonString).trim();
        }
      }

      if (newHeadline && !String(newHeadline).includes("API Error") && !String(newHeadline).includes("Safety")) {
        // シートデータ(配列)を更新
        values[target.rowIndex][SUM_COL] = newHeadline;
        
        // 要約（意味）が変わったので、検索にヒットするようにベクトルも作り直す
        const textToEmbed = `Title: ${target.title}\nSummary: ${newHeadline}`;
        const vector = LlmService.generateVector(textToEmbed);
        if (vector) {
          values[target.rowIndex][VEC_COL] = vector.join(',');
        }
        
        // 更新範囲を記録
        if (minIdx === -1 || target.rowIndex < minIdx) minIdx = target.rowIndex;
        if (target.rowIndex > maxIdx) maxIdx = target.rowIndex;
      }
    });

    processedCount += chunk.length;
    if (i + BATCH_SIZE < targets.length) {
      Utilities.sleep(AppConfig.get().System.Limits.LLM_BATCH_DELAY); // APIエラー回避の3秒待機
    }
  }

  // 3. シートへ一括書き戻し
  if (minIdx !== -1 && maxIdx !== -1) {
    const startRow = minIdx + 2;
    const rowCount = maxIdx - minIdx + 1;
    const modifiedSlice = values.slice(minIdx, maxIdx + 1);
    
    const maxColsInSlice = modifiedSlice.reduce((m, r) => Math.max(m, r.length), 0);
    const normalizedData = modifiedSlice.map(r => {
      while (r.length < maxColsInSlice) r.push("");
      return r;
    });

    sheet.getRange(startRow, 1, rowCount, maxColsInSlice).setValues(normalizedData);
    Logger.log(`🎉 修正完了: ${processedCount} 件の英語要約を日本語に修正し、ベクトルを更新しました。`);
  }
}

/**
 * 【お掃除ツール】E列の英語要約だけを一括で空欄にする（超高速）
 */
function clearEnglishSummaries() {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  if (!sheet) return;
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // E列（SUMMARY）だけを取得
  const SUM_COL = AppConfig.get().CollectSheet.Columns.SUMMARY; 
  const range = sheet.getRange(2, SUM_COL, lastRow - 1, 1);
  const values = range.getValues();
  
  let clearCount = 0;
  
  // 配列上で英語チェック＆空欄化
  for (let i = 0; i < values.length; i++) {
    const text = String(values[i][0]).trim();
    // 空欄やエラー文字でなく、かつ日本語が含まれていない（＝英語）なら
    if (text && !text.includes("API Error") && isLikelyEnglish_(text)) {
      values[i][0] = ""; // 空欄で上書き
      clearCount++;
    }
  }
  
  // 一括でシートに書き戻す
  if (clearCount > 0) {
    range.setValues(values);
    Logger.log(`🧹 お掃除完了: ${clearCount} 件の英語要約を空欄にしました！`);
  } else {
    Logger.log("英語の要約は見つかりませんでした。");
  }
}

/**
 * toolArchiveAndClearHistory
 * 【開発・メンテ用】現在のDigestHistoryをJSONとしてDriveに退避し、シートを初期化する。
 * 過去のノイズ（推測・ハルシネーション）が混ざった記憶を一掃し、クリーンな状態で再スタートするためのツール。
 */
function toolArchiveAndClearHistory() {
  const config = AppConfig.get();
  const sheet = getSheet_(config.SheetNames.DIGEST_HISTORY);
  
  if (!sheet) {
    Logger.log("エラー: DigestHistoryシートが見つかりません。");
    return;
  }
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("退避する履歴データがありません（すでに真っ白です）。");
    return;
  }
  
  // 1. データの取得
  const numRows = lastRow - 1;
  const dataRange = sheet.getRange(2, 1, numRows, sheet.getLastColumn());
  const rawData = dataRange.getValues();
  
  // 2. JSONファイルとしてDriveに保存
  const folderId = config.System.Archive.FOLDER_ID;
  const timeZone = Session.getScriptTimeZone();
  const timestamp = Utilities.formatDate(new Date(), timeZone, "yyyyMMdd_HHmmss");
  // 記事アーカイブと区別するためプレフィックスを変更
  const fileName = `YATA_HistoryArchive_${timestamp}.json`; 
  
  try {
    if (folderId && folderId.length > 10) {
      const jsonContent = JSON.stringify(rawData, null, 2);
      const folder = DriveApp.getFolderById(folderId);
      folder.createFile(fileName, jsonContent, MimeType.PLAIN_TEXT);
      Logger.log(`✅ [Drive退避完了] ${numRows}件の履歴を ${fileName} として保存しました。`);
    } else {
      Logger.log("⚠️ フォルダID未設定のため、Drive保存をスキップします。データ保護のため削除は行いません。");
      return;
    }
  } catch (e) {
    Logger.log(`❌ Drive保存エラー: ${e.toString()} (データ保護のため削除は中断します)`);
    return;
  }
  
  // 3. シートの初期化（削除）
  // ヘッダー（1行目）を残して全行削除する
  sheet.deleteRows(2, numRows);
  Logger.log(`🧹 [初期化完了] DigestHistoryシートから ${numRows} 件のデータを削除し、真っ白にしました。`);
}

/**
 * toolResetAllJsonErrors
 * 【全エラー一掃】E列にJSON形式（{ で始まるデータ）が残っている行をすべて特定し、
 * 強制的に空欄（""）にリセットします。
 */
function toolResetAllJsonErrors() {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  if (!sheet) return;
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const SUM_COL = AppConfig.get().CollectSheet.Columns.SUMMARY - 1; // E列
  
  // E列をスキャン
  const range = sheet.getRange(2, SUM_COL + 1, lastRow - 1, 1);
  const values = range.getValues();
  let count = 0;

  Logger.log(`スキャン開始: ${lastRow} 行のE列からJSONノイズを探索中...`);

  for (let i = 0; i < values.length; i++) {
    const val = String(values[i][0] || "").trim();
    
    // 判定：文字列が "{" で始まっている場合は、パース失敗データとみなしてリセット
    if (val.startsWith('{')) {
      values[i][0] = ""; 
      count++;
    }
  }

  if (count > 0) {
    range.setValues(values);
    Logger.log(`🧹 クリーニング完了: ${count} 件のJSON残骸（{"tldr": 等）を一掃しました。`);
  } else {
    Logger.log("✅ JSON形式のノイズは見つかりませんでした。");
  }
}

/**
 * toolFillMissingSummariesFullScan
 * 【全行スキャン版】5000行の壁を越えて、シートの末尾まで空欄を探しに行きます。
 */
function toolFillMissingSummariesFullScan() {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  if (!sheet) return;
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // 境界線を撤廃し、実際の最終行までを対象にします
  const numRows = lastRow - 1;
  
  const SUM_COL = AppConfig.get().CollectSheet.Columns.SUMMARY - 1; // E列(4)
  const TITLE_COL = AppConfig.get().CollectSheet.Columns.URL - 2;   // B列(1)
  const ABS_COL = AppConfig.get().CollectSheet.Columns.ABSTRACT - 1; // D列(3)
  
  // ⚡【高速化】A-E列(5列)だけに絞って全行読み込み
  const values = sheet.getRange(2, 1, numRows, 5).getValues();
  const targets = [];
  
  Logger.log(`全行スキャン開始: 1 〜 ${lastRow} 行を調査中...`);

  for (let i = 0; i < values.length; i++) {
    const summary = String(values[i][SUM_COL] || "").trim();
    if (summary === "") {
       targets.push({
          rowIndex: i,
          title: values[i][TITLE_COL],
          abstractText: values[i][ABS_COL]
       });
    }
  }

  if (targets.length === 0) {
    Logger.log("✅ シートの末尾まで調べましたが、空欄は見つかりませんでした！完璧です。");
    return;
  }

  // 1回の実行で処理する件数（AIの通信時間を考慮し100件程度が安定）
  const processTargets = targets.slice(0, 100); 
  Logger.log(`🚨 合計 ${targets.length} 件の空欄を発見。今回は先頭の ${processTargets.length} 件を処理します。`);

  const BATCH_SIZE = AppConfig.get().System.Limits.LLM_BATCH_SIZE || 5;
  let minIdx = -1; let maxIdx = -1;

  for (let i = 0; i < processTargets.length; i += BATCH_SIZE) {
    const chunk = processTargets.slice(i, i + BATCH_SIZE);
    const articleTexts = chunk.map(t => `Title: ${t.title || ""}\nAbstract: ${t.abstractText || ""}`);
    
    // AI要約実行
    const batchResults = LlmService.summarizeBatch(articleTexts);
    
    batchResults.forEach((jsonString, idx) => {
      const target = chunk[idx];
      let newHeadline = null;
      
      if (jsonString && !String(jsonString).includes("API Error")) {
        try {
          const parsedJson = cleanAndParseJSON_(jsonString);
          newHeadline = parsedJson ? (parsedJson.tldr || parsedJson.summary) : String(jsonString).trim();
        } catch (e) {
          newHeadline = String(jsonString).trim();
        }
      }

      if (newHeadline && !String(newHeadline).includes("API Error")) {
        values[target.rowIndex][SUM_COL] = newHeadline;
        if (minIdx === -1 || target.rowIndex < minIdx) minIdx = target.rowIndex;
        if (target.rowIndex > maxIdx) maxIdx = target.rowIndex;
      }
    });

    if (i + BATCH_SIZE < processTargets.length) {
      Utilities.sleep(AppConfig.get().System.Limits.LLM_BATCH_DELAY || 2000);
    }
  }

  // E列のみピンポイント更新
  if (minIdx !== -1) {
    const startRow = minIdx + 2;
    const rowCount = maxIdx - minIdx + 1;
    const modifiedData = values.slice(minIdx, maxIdx + 1).map(r => [r[SUM_COL]]);
    
    sheet.getRange(startRow, SUM_COL + 1, rowCount, 1).setValues(modifiedData);
    Logger.log(`🎉 穴埋め完了。残り ${Math.max(0, targets.length - processTargets.length)} 件です。`);
  }
}

/**
 * 【開発用】バッチ要約の動作をテストする関数
 * 現在の設定（COMPANY/PERSONAL）を自動認識し、ダミー記事3件でバッチ処理をテストします。
 */
function debugBatchSummarization() {
  Logger.log("=== 📦 バッチ要約 通信テスト開始 ===");

  // 1. 現在の設定を自動判定してログに出力
  const llmConfig = AppConfig.get().Llm;
  const context = llmConfig.Context || "COMPANY";
  const primaryService = (context === "COMPANY") ? "Azure" : "OpenAI (本家)";
  const targetModel = llmConfig.ModelNano || "未設定 (デフォルトを使用)";

  Logger.log(`🌍 実行コンテキスト: ${context}`);
  Logger.log(`🏢 優先サービス: ${primaryService}`);
  Logger.log(`🤖 ターゲットモデル: ${targetModel}`);
  Logger.log("-----------------------------------");

  // 2. テスト用のダミー記事（3件）
  const dummyArticles = [
    "Title: AIモデル「GPT-5」が発表\nAbstract: OpenAIは新しい推論モデルを発表しました。複雑なタスクでの論理的思考が大幅に向上しています。",
    "Title: トヨタ、全固体電池の実用化へ\nAbstract: 2027年にもEV向けの全固体電池を実用化する方針を固めました。充電時間の大幅短縮が期待されます。",
    "Title: 日経平均、史上最高値を更新\nAbstract: 半導体関連株への買いが集中し、日経平均株価が歴史的な高値を記録しました。市場の期待が高まっています。"
  ];

  Logger.log(`テスト記事 ${dummyArticles.length}件をバッチ送信します...`);

  try {
    // 3. バッチ要約ロジックを実行（内部で自動的にAzure/OpenAIにルーティングされます）
    const results = LlmService.summarizeBatch(dummyArticles);

    Logger.log("--- 📊 結果出力 ---");
    let successCount = 0;

    results.forEach((res, idx) => {
      Logger.log(`\n【記事 ${idx + 1}】`);
      if (res) {
        Logger.log(res);
        try {
          const parsed = JSON.parse(res);
          // JSONの中身が期待通りかチェック
          if (parsed.tldr || parsed.summary || parsed.what) {
             Logger.log("✅ JSONパース成功");
             successCount++;
          }
        } catch(e) {
          Logger.log("⚠️ 文字列としては取得できましたが、JSONパースに失敗しました。");
        }
      } else {
        Logger.log("❌ 取得失敗（null または 空文字）");
      }
    });

    Logger.log("\n-----------------------------------");
    if (successCount === dummyArticles.length) {
      Logger.log(`🎉 テスト完全成功！ [${primaryService} / ${targetModel}] でのバッチ要約は正常に機能しています。`);
    } else {
      Logger.log(`⚠️ ${successCount}/${dummyArticles.length} 件成功。ログのエラーやレスポンス形式を確認してください。`);
    }

  } catch (e) {
    Logger.log("❌ バッチテスト中に致命的なエラーが発生しました: " + e.message);
  }

  Logger.log("=== テスト終了 ===");
}

/**
 * cleanupYataProperties
 * 【レスキュー用】不要な（デフォルト値で代用可能な）チューニングプロパティを一括削除する。
 * 【用途】スクリプトプロパティが50件を超えてUIが編集できなくなった際の「ダイエット」に使用する。
 */
function cleanupYataProperties() {
  const props = PropertiesService.getScriptProperties();
  const keysToDelete = [
    "SYSTEM_EXCHANGE_RATE", "SYSTEM_RATE_NANO_IN", "SYSTEM_RATE_NANO_OUT",
    "SYSTEM_RATE_MINI_IN", "SYSTEM_RATE_MINI_OUT", "SYSTEM_RATE_EMBEDDING_IN",
    "SYSTEM_RATE_GEMINI_IN", "SYSTEM_RATE_GEMINI_OUT",
    "SYSTEM_THRESHOLD_SEMANTIC", "SYSTEM_THRESHOLD_HISTORY",
    "SYSTEM_SIGNAL_OUTLIER", "SYSTEM_SIGNAL_NUCLEUS", "SYSTEM_SIGNAL_MIN_SOURCES",
    "SYSTEM_LIMIT_ITEMS_FEED", "SYSTEM_LIMIT_BATCH_SIZE", "SYSTEM_LIMIT_RETENTION_DAYS"
  ];

  let count = 0;
  Logger.log("--- 🧹 YATA プロパティ・ダイエット開始 ---");
  keysToDelete.forEach(key => {
    if (props.getProperty(key) !== null) {
      props.deleteProperty(key);
      count++;
      Logger.log(`[DELETE] ${key} を削除しました`);
    }
  });

  Logger.log(`\n✅ 完了: ${count} 個の項目を整理しました。これで設定画面が編集可能になるはずです。`);
}

/**
 * 過去記事の再構造化（5W1H JSON化）バックフィル [バッチ処理版]
 * E列がJSON形式でない記事を特定し、5件ずつまとめて再要約・構造化を行います。
 * @param {number} totalLimit 処理する総件数の上限 (デフォルト 50)
 * @param {number} batchSize 1回にまとめる件数 (デフォルト 5)
 */
function toolBackfillStructuredSummaries(totalLimit = 100, batchSize = 5) {
  const sheetName = AppConfig.get().SheetNames.TREND_DATA;
  
  // 🌟 SpreadsheetApp.getActiveSpreadsheet() をやめて、専用ヘルパーを使う
  const sh = getSheet_(sheetName);
  if (!sh) {
    Logger.log(`エラー: シート「${sheetName}」が見つかりません。`);
    return;
  }
  
  const data = sh.getDataRange().getValues();
  const C = AppConfig.get().CollectSheet.Columns;
  
  let totalCount = 0;
  let currentBatch = []; // { rowIdx, title, text }

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const currentHeadline = String(row[C.SUMMARY - 1] || "").trim();
    const abstractText = String(row[C.ABSTRACT - 1] || "").trim();
    const title = String(row[C.URL - 2] || "").trim();
    const tldrText = String(row[C.TLDR - 1] || "").trim(); // 🌟 I列 (TLDR) の値を取得

    // 🌟 新判定ロジック: I列(TLDR)が空っぽ、かつ、E列(SUMMARY)に何かが入っている記事を狙い撃ち
    if (tldrText === "" && currentHeadline !== "") {
      
      // 💡 もしD列(元記事)が空でも、E列の古い要約文を素材にして再要約できるようにしておく安全策
      const sourceText = abstractText.length > 50 ? abstractText : currentHeadline;

      currentBatch.push({
        rowIdx: i + 1,
        title: title,
        text: `Title: ${title}\nAbstract: ${sourceText}`
      });
    }

    // バッチが溜まった、または最後の場合に処理実行
    if (currentBatch.length >= batchSize || (i === data.length - 1 && currentBatch.length > 0)) {
      if (currentBatch.length === 0) continue;
      
      Logger.log(`[Backfill] ${currentBatch.length}件のバッチを処理中... (Total: ${totalCount})`);
      
      try {
        // 🌟 修正ポイント: 自前の連結をやめ、強力な専用バッチエンジンに任せる
        const articleTexts = currentBatch.map(item => item.text);
        
        // 🌟 LlmService.summarizeBatch を使えば、文字数上限やJSONパース、リトライを自動でやってくれます
        const batchResults = LlmService.summarizeBatch(articleTexts);

        batchResults.forEach((jsonString, idx) => {
          if (jsonString && !String(jsonString).includes("API Error")) {
            const parsedJson = cleanAndParseJSON_(jsonString);
            
            if (parsedJson) {
              const targetRow = currentBatch[idx].rowIdx;
              const targetTitle = currentBatch[idx].title;
              
              // 各カラムに書き込み
              sh.getRange(targetRow, C.SUMMARY).setValue(JSON.stringify(parsedJson));
              sh.getRange(targetRow, C.TLDR).setValue(parsedJson.tldr || "");
              sh.getRange(targetRow, C.WHO).setValue(parsedJson.who || "");
              sh.getRange(targetRow, C.WHAT).setValue(parsedJson.what || "");
              sh.getRange(targetRow, C.WHEN).setValue(parsedJson.when || "");
              sh.getRange(targetRow, C.WHERE).setValue(parsedJson.where || "");
              sh.getRange(targetRow, C.WHY).setValue(parsedJson.why || "");
              sh.getRange(targetRow, C.HOW).setValue(parsedJson.how || "");
              sh.getRange(targetRow, C.RESULT).setValue(parsedJson.result || "");
              
              if (C.KEYWORDS) {
                const kwStr = Array.isArray(parsedJson.keywords) ? parsedJson.keywords.join(", ") : (parsedJson.keywords || "");
                sh.getRange(targetRow, C.KEYWORDS).setValue(kwStr);
              }
              totalCount++;
              Logger.log(`  ✅ 更新: ${targetTitle}`);
            } else {
              Logger.log(`  ⚠️ パース失敗: ${currentBatch[idx].title}`);
            }
          } else {
             Logger.log(`  ❌ 生成エラー: ${currentBatch[idx].title}`);
          }
        });
      } catch (e) {
        Logger.log(`❌ バッチ処理エラー: ${e.message}`);
      }
      
      SpreadsheetApp.flush(); // スプレッドシートをリアルタイム更新

      currentBatch = []; // バッチをクリア
      Utilities.sleep(2000); // バッチ間ウェイト
    }

    if (totalCount >= totalLimit) break;
  }
  
  Logger.log(`🏁 バックフィル完了。総処理件数: ${totalCount}`);
}

/**
 * initializeSystemProperties
 * 【責務】YATAの動作に必要なすべてのスクリプトプロパティを初期化・診断する
 * 【用途】新環境構築時に実行することで、必要な全設定項目をログにリストアップし、デフォルト値を設定する
 * 【進化】有効なシートIDが設定されている場合、不足しているシートの作成とヘッダーの書き込みを自動で行う
 */
function initializeSystemProperties() {
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperties();
  const toSet = {};
  
  // 1. 基本・インフラ設定 (ID、APIキー、エンドポイント等)
  const infraMap = {
    "EXECUTION_CONTEXT": "PERSONAL",    // "PERSONAL" (OpenAI優先) または "COMPANY" (Azure優先)
    "DATA_SHEET_ID": "YOUR_SHEET_ID",
    "CONFIG_SHEET_ID": "YOUR_SHEET_ID",
    "ARCHIVE_FOLDER_ID": "YOUR_FOLDER_ID",
    "OPENAI_API_KEY_PERSONAL": "",      // 空文字の場合は初期化時にログで警告
    "AZURE_API_KEY": "",
    "AZURE_ENDPOINT_BASE": "https://YOUR_RESOURCE.openai.azure.com/",
    "GEMINI_API_KEY": "",
    "OPENAI_MODEL_NANO": "gpt-5-nano",
    "OPENAI_MODEL_MINI": "gpt-5-mini",
    "AZURE_EMBEDDING_ENDPOINT": "",
    "OPENAI_EMBEDDING_MODEL": "text-embedding-3-small",
    "EMBEDDING_DIMENSIONS": "256",
    "PROMPT_JSON_FILE_ID": ""           // 外部プロンプト管理用
  };

  // 2. システム・チューニング (コスト、感度、制限等)
  const systemMap = {
    "SYSTEM_EXCHANGE_RATE": "155.0",
    "SYSTEM_RATE_NANO_IN": "0.200",
    "SYSTEM_RATE_NANO_OUT": "1.250",
    "SYSTEM_RATE_MINI_IN": "0.750",
    "SYSTEM_RATE_MINI_OUT": "4.500",
    "SYSTEM_RATE_EMBEDDING_IN": "0.020",
    "SYSTEM_RATE_GEMINI_IN": "0.010",
    "SYSTEM_RATE_GEMINI_OUT": "0.040",
    "SYSTEM_THRESHOLD_SEMANTIC": "0.32",
    "SYSTEM_THRESHOLD_HISTORY": "0.85",
    "SYSTEM_SIGNAL_OUTLIER": "0.72",
    "SYSTEM_SIGNAL_NUCLEUS": "0.80",
    "SYSTEM_SIGNAL_MIN_SOURCES": "2",
    "SYSTEM_LIMIT_ITEMS_FEED": "10",
    "SYSTEM_LIMIT_BATCH_SIZE": "5",
    "SYSTEM_LIMIT_RETENTION_DAYS": "120"
  };

  // 3. 通知・ダイジェスト設定
  const notifyMap = {
    "MAIL_TO": "your-email@example.com",
    "MAIL_SENDER_NAME": "YATA Intelligence Bot",
    "MAIL_SUBJECT_PREFIX": "[YATA]",
    "NOTIFY_CHANNEL_WEEKLY": "email",
    "DIGEST_DAYS": "7",
    "DIGEST_TOP_N": "20"
  };

  const allMap = {...infraMap, ...notifyMap};
  const tuningMap = systemMap; // チューニング系はログ出力のみにする
  
  let addedCount = 0;
  let missingInfoCount = 0;

  Logger.log("--- 🛠️ YATA システム構成診断・初期化開始 ---");
  
  // 1. 必須プロパティの診断・作成
  Logger.log("\n[ 📂 Essentials & Infrastructure ]");
  for (const [key, value] of Object.entries(allMap)) {
    if (!(key in current)) { // 厳密な存在チェック
      toSet[key] = value;
      addedCount++;
      const status = (value === "" || value.includes("YOUR_")) ? "🆕 要設定" : "🆕 初期化";
      if (status.includes("要設定")) missingInfoCount++;
      Logger.log(`[${status}] ${key} -> ${value || "(空)"}`);
    } else {
      const val = current[key];
      const status = (val === "" || val.includes("YOUR_")) ? "❌ 未設定(要入力)" : "✅ 設定済み";
      if (status.includes("❌")) missingInfoCount++;
      Logger.log(`[${status}] ${key}: ${val}`);
    }
  }

  // 2. チューニング用プロパティの案内 (作成はせず、ログに出すだけ)
  Logger.log("\n[ ⚙️ Optional Tuning (Overrides) ]");
  Logger.log("以下のキーをスクリプトプロパティに追加することで、デフォルト値を上書きできます。");
  for (const [key, value] of Object.entries(tuningMap)) {
    if (key in current) {
      Logger.log(`[TUNED] ${key}: ${current[key]} (カスタム設定中)`);
    } else {
      Logger.log(`[DEFAULT] ${key}: ${value} (追加すれば上書き可能)`);
    }
  }

  if (addedCount > 0) {
    props.setProperties(toSet, false);
    Logger.log(`\n📝 ${addedCount} 個の必須プロパティを新規に作成しました。`);
  }

  // --- 🌟 スプレッドシート自動構築ロジック (有効なIDがある場合に実行) ---
  const dataId = props.getProperty("DATA_SHEET_ID");
  const configId = props.getProperty("CONFIG_SHEET_ID");
  
  const isValidId = (id) => id && id !== "" && !id.includes("YOUR_") && id !== "YOUR_SHEET_ID";

  if (isValidId(dataId) || isValidId(configId)) {
    Logger.log("\n--- 📊 スプレッドシート構造の自動診断・構築 ---");
    
    const setupSheet = (ssId, sheetName, headers) => {
      if (!isValidId(ssId)) return;
      try {
        const ss = SpreadsheetApp.openById(ssId);
        let sheet = ss.getSheetByName(sheetName);
        if (!sheet) {
          sheet = ss.insertSheet(sheetName);
          Logger.log(`[CREATE] シート '${sheetName}' を新規作成しました。`);
        }
        if (sheet.getLastRow() === 0) {
          sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold").setBackground("#f3f3f3");
          Logger.log(`[HEADER] シート '${sheetName}' にヘッダーを書き込みました。`);
        } else {
          Logger.log(`[OK]     シート '${sheetName}' は既に存在し、データがあります。`);
        }
      } catch (e) {
        Logger.log(`[ERROR]  シート '${sheetName}' の構築に失敗: ${e.message}`);
      }
    };

    // 公開用データシートの構築
    setupSheet(dataId, "RSS", ["サイト名", "URL"]);
    setupSheet(dataId, "collect", ["日付", "サイト名", "タイトル", "URL", "サマリー", "ソース名", "Vector", "Method Vector", "tldr", "who", "what", "when", "where", "why", "how", "result", "keywords"]);
    setupSheet(dataId, "MacroTrends", ["年月", "中心座標(Vector)", "期間要約"]);

    // 非公開用設定シートの構築
    setupSheet(configId, "Users", ["Name", "Email", "Day", "Keywords", "Semantic", "Excluded Keywords"]);
    setupSheet(configId, "Keywords", ["Query", "Flag", "(空)", "Label"]);
    setupSheet(configId, "prompt", ["キー(Key)", "本文(Value)"]);
    setupSheet(configId, "DigestHistory", ["日付", "ユーザー名", "送信トピック", "送信タイトル群"]);
  } else {
    Logger.log("\n💡 アドバイス: DATA_SHEET_ID を設定してもう一度実行すると、スプレッドシートの構造を自動構築します。");
  }

  if (missingInfoCount > 0) {
    Logger.log(`\n🚨 重要: まだ ${missingInfoCount} 個の項目に有効な値が設定されていません。`);
    Logger.log("Google Apps Scriptの「プロジェクトの設定」から値を入力してください。");
  } else {
    Logger.log("\n✨ すべての主要プロパティが設定されています！");
  }
  
  Logger.log("--- 診断終了 ---");
}

// #endregion

// =============================================================================
// #region 9. EXPORTS (Global Scope)
// 【責務】GASのグローバルスコープへの「公開」。
// =============================================================================

if (typeof global !== 'undefined') {
  global.AppConfig = AppConfig;
  global.LlmService = LlmService;
  global.runCollectionJob = runCollectionJob;
  global.runSummarizationJob = runSummarizationJob;
  global.runEmergingSignalJob = runEmergingSignalJob;
  global.dailyDigestJob = dailyDigestJob;
  global.sendPersonalizedReport = sendPersonalizedReport;
  global.generateTrendReportHtml = generateTrendReportHtml_;
  global.fmtDate = fmtDate_;
  global.initializeSystemProperties = initializeSystemProperties;
  global.cleanupYataProperties = cleanupYataProperties;
  global.toolBackfillStructuredSummaries = toolBackfillStructuredSummaries;
}

// #endregion
