/**
 * @file YATA-Config.js
 * @version 2.0.0
 * @description 【責務】システム全体の定数、しきい値、および Google プロパティ管理の集中制御。
 * 【最適化】🌟v2.0 起動時一度のみJSONロードを実行し、グローバルメモリへ完全キャッシュ（通信量ゼロ化）。
 */

const AppConfig = (function() {
  // 💡 GAS/Node.js のグローバルメモリ領域を活用した超高速中央キャッシュ
  const GLOBAL_KEY = "_YATA_GLOBAL_CONFIG_CACHE_";
  const _globalScope = (typeof globalThis !== 'undefined') ? globalThis : (typeof global !== 'undefined' ? global : this);

  function load() {
    // 🌟 [キャッシュ防壁] すでにメモリに読み込み済みなら、PropertiesServiceを一切叩かず即座に返却
    if (_globalScope[GLOBAL_KEY]) {
      return _globalScope[GLOBAL_KEY];
    }

    const props = PropertiesService.getScriptProperties();
    
    let tuning = {};
    const tuningStr = props.getProperty("YATA_TUNING_CONFIG");
    if (tuningStr) { try { tuning = JSON.parse(tuningStr); } catch(e) {} }

    let delivery = {};
    const deliveryStr = props.getProperty("YATA_DELIVERY_CONFIG");
    if (deliveryStr) { try { delivery = JSON.parse(deliveryStr); } catch(e) {} }

    const finalConfig = {
      SheetNames: {
        RSS_LIST: "RSS", TREND_DATA: "collect", PROMPT_CONFIG: "prompt", USERS: "Users",
        KEYWORDS: "Keywords", DIGEST_HISTORY: "DigestHistory", MACRO_TRENDS: "MacroTrends",
        SCRAPERS: "Scrapers", ACTION_LOGS: "ActionLogs", PRIORITY_DICTIONARY: "PriorityDictionary",
        KEYWORDS_DICTIONARY: "KeywordsDictionary"
      },
      CollectSheet: {
        Columns: { 
          URL: 3, ABSTRACT: 4, SUMMARY: 5, SOURCE: 6, VECTOR: 7, METHOD_VECTOR: 8,
          TLDR: 9, WHO: 10, WHAT: 11, WHEN: 12, WHERE: 13, WHY: 14, HOW: 15, RESULT: 16, KEYWORDS: 17, CLICK_COUNT: 18
        },
        DataRange: { START_ROW: 2, NUM_COLS_FOR_URL: 1 },
      },
      RssListSheet: { DataRange: { START_ROW: 2, START_COL: 1, NUM_COLS: 2 }, Columns: { NAME: 1, URL: 2 } },
      
      Llm: {
        PriorityOrder: tuning.LLM_PRIORITY_ORDER || (props.getProperty("EXECUTION_CONTEXT") === "PERSONAL" ? ["OPENAI", "AZURE", "GEMINI"] : ["AZURE", "OPENAI", "GEMINI"]),
        GeminiNano: tuning.GEMINI_MODEL_NANO || "gemini-2.5-flash-lite",
        GeminiMini: tuning.GEMINI_MODEL_MINI || "gemini-2.5-pro",
        MODEL_NAME: "gemini-2.5-flash-lite", 
        DELAY_MS: 1100,
        NO_ABSTRACT_TEXT: "抜粋なし",
        Context: props.getProperty("EXECUTION_CONTEXT") || "COMPANY",
        ModelNano: tuning.OPENAI_MODEL_NANO || props.getProperty("OPENAI_MODEL_NANO") || "gpt-5-nano",
        ModelMini: tuning.OPENAI_MODEL_MINI || props.getProperty("OPENAI_MODEL_MINI") || "gpt-5-mini",
        AzureBaseUrl: props.getProperty("AZURE_ENDPOINT_BASE") || "https://YOUR_RESOURCE_NAME.openai.azure.com/",
        AzureApiVersion: "2024-12-01-preview",
        AzureKey: props.getProperty("AZURE_API_KEY") || null,
        OpenAiKey: props.getProperty("OPENAI_API_KEY_PERSONAL") || null,
        GeminiKey: props.getProperty("GEMINI_API_KEY") || null,
        
        Params: {
          TopP: { NANO: 0.05, MINI: 0.15 },
          Temperature: { STRICT: 0.0, WRITING: 0.4, INSIGHT: 0.7 },
          MaxTokens: 20000,
          ReasoningEffort: { 
            NANO: tuning.SYSTEM_REASONING_NANO || "low", 
            MINI: tuning.SYSTEM_REASONING_MINI || "medium" 
          },
          Verbosity: { 
            NANO: tuning.SYSTEM_VERBOSITY_NANO || "low", 
            MINI: tuning.SYSTEM_VERBOSITY_MINI || "low" 
          },
          MaxCompletionTokens: { NANO: 4000, NANO_REVENGE: 8000, MINI: 8000 }
        },
        Embedding: {
          AzureEndpoint: props.getProperty("AZURE_EMBEDDING_ENDPOINT"),
          OpenAiModel: tuning.OPENAI_EMBEDDING_MODEL || props.getProperty("OPENAI_EMBEDDING_MODEL") || "text-embedding-3-small",
          Dimensions: parseInt(tuning.EMBEDDING_DIMENSIONS || props.getProperty("EMBEDDING_DIMENSIONS") || "256", 10)
        }
      },
      Digest: {
        days: parseInt(delivery.DIGEST_DAYS || props.getProperty("DIGEST_DAYS") || "7", 10),
        topN: parseInt(delivery.DIGEST_TOP_N || props.getProperty("DIGEST_TOP_N") || "20", 10),
        notifyChannel: (delivery.NOTIFY_CHANNEL_WEEKLY || props.getProperty("NOTIFY_CHANNEL_WEEKLY") || "email").toLowerCase(),
        mailTo: delivery.MAIL_TO || props.getProperty("MAIL_TO"),
        mailSubjectPrefix: delivery.MAIL_SUBJECT_PREFIX || props.getProperty("MAIL_SUBJECT_PREFIX"),
        mailSenderName: delivery.MAIL_SENDER_NAME || props.getProperty("MAIL_SENDER_NAME") || "YATA (AI Intelligence Bot)",
        sheetUrl: delivery.DIGEST_SHEET_URL || props.getProperty("DIGEST_SHEET_URL") || "(DIGEST_SHEET_URL 未設定)",
      },
      System: {
        DataSheetId: props.getProperty("DATA_SHEET_ID") || "ID未設定",
        ConfigSheetId: props.getProperty("CONFIG_SHEET_ID") || "ID未設定",
        Archive: {
          FOLDER_ID: props.getProperty("ARCHIVE_FOLDER_ID"), 
          JSON_FILENAME_PREFIX: "YATA_Archive_",
        },
        TimeLimit: { COLLECTION: 300000, SUMMARIZATION: 300000, REPORT_GENERATION: 280000, LOCK_TIMEOUT: 10000 },
        
        Limits: {
          RSS_CHECK_ROWS: 20000,
          MAINTENANCE_SCAN_LIMIT: 5000,     
          SUMMARIZE_SCAN_LIMIT: 300,        
          MAX_SUMMARIZE_TOTAL: 30,          
          HTTP_CONNECT_TIMEOUT: 10000,      
          HTTP_READ_TIMEOUT: 20000,         
          MAX_ITEMS_PER_FEED: parseInt(tuning.SYSTEM_LIMIT_ITEMS_FEED || "10", 10),
          MIN_ABSTRACT_LENGTH: {
            EN: parseInt(tuning.SYSTEM_MIN_ABSTRACT_LENGTH_EN || "400", 10),
            JA: parseInt(tuning.SYSTEM_MIN_ABSTRACT_LENGTH_JA || "200", 10)
          },
          RSS_DATE_WINDOW_DAYS: 3, RSS_CHUNK_SIZE: 5, RSS_INTER_CHUNK_DELAY: 1000,
          DATA_RETENTION_MONTHS: 3, BATCH_SIZE: 30, BATCH_FETCH_DAYS: 10, LINKS_PER_TREND: 3,
          BACKFILL_DELAY: 500,
          LLM_BATCH_SIZE: parseInt(tuning.SYSTEM_LIMIT_BATCH_SIZE || "5", 10),
          LLM_BATCH_DELAY: 2000, VECTOR_GEN_DAYS: 7, LIGHTEN_DAYS: 35,
          HISTORY_RETENTION_DAYS: parseInt(tuning.SYSTEM_LIMIT_RETENTION_DAYS || "120", 10),
          SAFE_MAX_DAYS: 14, VIZ_MAX_ITEMS: 500, SEARCH_MAX_RESULTS: 20, DAILY_DIGEST_SEARCH_LIMIT: 10,
          HISTORY_CONTEXT_MAX_CHARS: 5000, RSS_MAX_STRIKES: 3, TOOL_SEARCH_LIMIT: 5000,
          WEB_SUMMARY_MAX_CHARS: parseInt(tuning.SYSTEM_WEB_SUMMARY_MAX_CHARS || "1000", 10),
          WEB_SUMMARY_MIN_CHARS: parseInt(tuning.SYSTEM_WEB_SUMMARY_MIN_CHARS || "50", 10), 
          archiveSampleSize: 50, maxSubjectKeywords: 3, insertRowBuffer: 50
        },
        Thresholds: {
          SEMANTIC_SEARCH: parseFloat(tuning.SYSTEM_THRESHOLD_SEMANTIC || "0.32"),
          HISTORY_MATCH: parseFloat(tuning.SYSTEM_THRESHOLD_HISTORY || "0.85"),
          DUPLICATE_OMIT: parseFloat(tuning.SYSTEM_THRESHOLD_DUPLICATE || "0.85") 
        },
        HttpHeaders: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://www.google.com/',
          'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        },
        DateWindows: { DAILY_REPORT: 2, WEEKLY_REPORT: 7, DAILY_DIGEST_JOB: 1 },
        SearchScore: { KEYWORD_MAX: 40, KEYWORD_WEIGHT: 8, FRESHNESS_MAX: 40, FRESHNESS_DECAY: 7, ABSTRACT_BONUS: 20, ABSTRACT_DIVISOR: 100 },
        SignalDetection: {
          LOOKBACK_DAYS_MAINSTREAM: 7, LOOKBACK_DAYS_SIGNALS: 3,
          OUTLIER_THRESHOLD: parseFloat(tuning.SYSTEM_SIGNAL_OUTLIER || "0.72"),
          NUCLEATION_RADIUS: parseFloat(tuning.SYSTEM_SIGNAL_NUCLEUS || "0.80"),
          MIN_NUCLEI_SOURCES: parseInt(tuning.SYSTEM_SIGNAL_MIN_SOURCES || "2", 10),
          MAX_OUTLIERS_TO_PROCESS: 100, USE_METHOD_VECTOR: true, MIN_ARTICLES_FOR_ANALYSIS: 5
        },
        Budget: {
          CURRENT_COST_KEY: "YATA_SYSTEM_STATE",
          LAST_RESET_KEY: "YATA_SYSTEM_STATE", 
          EXCHANGE_RATE: parseFloat(tuning.SYSTEM_EXCHANGE_RATE || "155.0"),
          RatesPer1M: {
            EMBEDDING: { in: parseFloat(tuning.SYSTEM_RATE_EMBEDDING_IN || "0.020"), out: 0 },
            GEMINI: { in: parseFloat(tuning.SYSTEM_RATE_GEMINI_IN || "0.010"), out: parseFloat(tuning.SYSTEM_RATE_GEMINI_OUT || "0.040") },
            NANO: { in: parseFloat(tuning.SYSTEM_RATE_NANO_IN || "0.200"), out: parseFloat(tuning.SYSTEM_RATE_NANO_OUT || "1.250") },
            MINI: { in: parseFloat(tuning.SYSTEM_RATE_MINI_IN || "0.750"), out: parseFloat(tuning.SYSTEM_RATE_MINI_OUT || "4.500") }
          }
        }
      },
      UI: {
        WebDefaults: { SEARCH_DAYS: 30 },
        Colors: {
          PRIMARY: "#3498db", SECONDARY: "#2c3e50", ACCENT: "#e74c3c", TEXT_MAIN: "#333333", TEXT_SUB: "#555555",
          BG_BODY: "#f0f2f5", BG_CARD: "#ffffff", BORDER: "#e1e4e8", LINK: "#0066cc",
          BADGE_NEW_BG: "#e3f2fd", BADGE_NEW_TXT: "#1565c0", BADGE_UP_BG: "#e8f5e9", BADGE_UP_TXT: "#2e7d32",
          BADGE_WARN_BG: "#fff3e0", BADGE_WARN_TXT: "#ef6c00", BADGE_KEEP_BG: "#f5f5f5", BADGE_KEEP_TXT: "#616161",
          BUTTON_AI: "#8e44ad"
        }
      },
      Messages: { 
        get REPORT_HEADER_PREFIX() { return (typeof Repository !== 'undefined' ? Repository.getPromptConfig("MSG_REPORT_HEADER") : null) || "集計期間："; }, 
        get NO_RESULT() { return (typeof Repository !== 'undefined' ? Repository.getPromptConfig("MSG_NO_RESULT") : null) || "該当記事なし"; }, 
        get NO_SUMMARY() { return (typeof Repository !== 'undefined' ? Repository.getPromptConfig("MSG_NO_SUMMARY") : null) || "見出しが生成できませんでした。"; }, 
        get LINK_MORE_MD() { return (typeof Repository !== 'undefined' ? Repository.getPromptConfig("MSG_LINK_MORE") : null) || "その他の記事一覧は[こちらのスプレッドシート](${url})でご覧いただけます。"; }
      },
      UsersSheet: { Columns: { NAME: 1, EMAIL: 2, DAY: 3, KWS: 4, LABELS: 5, SEMANTIC: 6, HISTORY: 7, DAILY_KW_DIGEST: 8, PUBMED: 9, LAST_SENT: 10, PRIORITIES: 11, MONTHLY_PARTNER: 12 } },
      PubMed: {
        Endpoints: { Search: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi", Summary: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi", Fetch: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi", PmcBase: "https://www.ncbi.nlm.nih.gov/pmc/articles/" },
        Limits: { DEFAULT_MAX_COUNT: 5, SEARCH_WINDOW_DAYS: 7, SEARCH_END_OFFSET_DAYS: 0, ALLOWED_TYPES: ["Journal Article", "Clinical Trial", "Case Reports"] }
      },
      KeywordsSheet: { Columns: { QUERY: 1, FLAG: 2, DAY: 3, LABEL: 4 } },
      Logic: { TRUE_MARKERS: ["TRUE", "〇"], TAGS: { NEW: /\[新規\/?注目\]|\[新規\]/g, UP: /\[進展\]/g, WARN: /\[懸念\]/g, KEEP: /\[継続\]/g } }
    };

    _globalScope[GLOBAL_KEY] = finalConfig;
    return finalConfig;
  }
  
  return { 
    get: load,
    /** キャッシュ強制クリア用（管理画面の更新時などに使用） */
    clearCache: function() { _globalScope[GLOBAL_KEY] = null; }
  };
})();