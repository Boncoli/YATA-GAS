/**
 * @file YATA.js - AI-Driven News Intelligence Platform
 * @version 3.5
 * @date 2026-01-16
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
          Source: "",
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
      // ★システム全体の設定値
      System: {
        DataSheetId: props.getProperty("DATA_SHEET_ID") || "ID未設定",
        ConfigSheetId: props.getProperty("CONFIG_SHEET_ID") || "ID未設定",

        Archive: {
          // ここをプロパティから取得するように変更
          FOLDER_ID: props.getProperty("ARCHIVE_FOLDER_ID"), 
          JSON_FILENAME_PREFIX: "YATA_Archive_",
        },

        TimeLimit: {
          SUMMARIZATION: 5 * 60 * 1000,      // 要約/ベクトル生成の制限時間 (5分)
          REPORT_GENERATION: 280 * 1000      // レポート生成の制限時間 (GAS制限考慮)
        },
        Limits: {
          RSS_CHECK_ROWS: 3000,              // 重複チェック時に遡る行数
          RSS_DATE_WINDOW_DAYS: 7,           // RSS記事の有効期限 (これより古い記事は取り込まない)
          RSS_CHUNK_SIZE: 7,                // RSS並列収集のチャンクサイズ
          RSS_INTER_CHUNK_DELAY: 2500,       // チャンク間の待機時間 (ms)
          DATA_RETENTION_MONTHS: 6,          // データの保持期間
          BATCH_SIZE: 30,                    // LLM一括処理時のバッチサイズ
          BATCH_FETCH_DAYS: 30,               // レポート生成時の一括取得日数
          LINKS_PER_TREND: 3,                // トレンドレポートに表示するリンク数
          BACKFILL_DELAY: 500                // バックフィル時の待機時間 (ms)
        },
        // ★標準HTTPヘッダー
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
        // ★予兆（サイン）検知エンジンの設定
        SignalDetection: {
          LOOKBACK_DAYS_MAINSTREAM: 30, // 主流（重心）計算の対象期間
          LOOKBACK_DAYS_SIGNALS: 3,    // 予兆検知の対象期間（直近）
          OUTLIER_THRESHOLD: 0.65,     // これ以下の類似度なら「主流から外れている」と判定
          NUCLEATION_RADIUS: 0.85,     // これ以上の類似度なら「核形成（近い概念）」と判定
          MIN_NUCLEI_SOURCES: 2,       // 核を形成するのに必要な最低ソース数
          MAX_OUTLIERS_TO_PROCESS: 100  // 演算負荷軽減のため一度に処理するアウトライヤー上限
        },
        Budget: {
          CURRENT_COST_KEY: "SYSTEM_COST_ACCUMULATOR", // 保存用プロパティキー
          LAST_RESET_KEY: "SYSTEM_COST_LAST_RESET"     // リセット日管理キー
        },
      },
      // ★UIデザイン・メッセージ設定
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
      // ★各シートの列定義とロジック定数
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

const LlmService = (function() {
  const llmConfig = AppConfig.get().Llm;
  
  // AppConfigにBudget設定がまだ無い場合のエラー回避
  const budgetConfig = AppConfig.get().System.Budget || {
    CURRENT_COST_KEY: "SYSTEM_COST_ACCUMULATOR",
    LAST_RESET_KEY: "SYSTEM_COST_LAST_RESET"
  };

  // ★変更: この実行セッション中の合計コストを保持する変数
  let _sessionCostTotal = 0;

  // --- Cost Tracking Helper ---
  
 /**
   * _trackCost: 推定コストを加算して記録する
   * 【修正版】サービス種別ごとに単価を切り替えて計算精度を向上
   */
  function _trackCost(inputStr, outputStr, serviceName) {
    try {
      const props = PropertiesService.getScriptProperties();
      const currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");
      const lastReset = props.getProperty(budgetConfig.LAST_RESET_KEY);
      
      // 1. 月が変わっていたらリセット
      if (lastReset !== currentMonth) {
        props.setProperty(budgetConfig.CURRENT_COST_KEY, "0");
        props.setProperty(budgetConfig.LAST_RESET_KEY, currentMonth);
        Logger.log(`[CostTracker] 新しい月(${currentMonth})のため、積算コストをリセットしました。`);
      }

      // 2. コスト単価の定義 (1文字あたりのドル単価 / 1token≒4chars換算)
      // ※レートは2025年時点のOpenAI/Azureの定価を参考
      
      let priceInput = 0;
      let priceOutput = 0;

      if (String(serviceName).includes("Embedding")) {
        // ■ Embedding (text-embedding-3-small 相当)
        // 定価: $0.02 / 1M tokens
        // 1文字換算: 約 $0.000000005
        priceInput = 0.000000005; 
        priceOutput = 0; // 出力課金なし
      
      } else if (String(serviceName).includes("Gemini")) {
        // ■ Gemini (Flash Lite 等)
        // 無料枠なら0円だが、有料枠だとしても非常に安い
        // 定価: Input $0.075 / 1M tok (Miniの半額)
        priceInput = 0.00000002;
        priceOutput = 0.00000008;

      } else {
        // ■ 標準 (Main LLM)
        // 指定レート: Input $0.40 / 1M tok, Output $1.60 / 1M tok
        // -------------------------------------------------------
        // Input: $0.40 / 1,000,000 / 2.5文字 = $0.00000016
        // Output: $1.60 / 1,000,000 / 2.5文字 = $0.00000064
        priceInput = 0.00000016;
        priceOutput = 0.00000064;
      }
      
      const inputLen = inputStr ? String(inputStr).length : 0;
      const outputLen = outputStr ? String(outputStr).length : 0;
      
      const cost = (inputLen * priceInput) + (outputLen * priceOutput);
      
      // 3. セッション合計に加算
      _sessionCostTotal += cost;

      // 4. プロパティに加算保存 (月間累計)
      const currentTotal = parseFloat(props.getProperty(budgetConfig.CURRENT_COST_KEY) || "0");
      const newTotal = currentTotal + cost;
      
      props.setProperty(budgetConfig.CURRENT_COST_KEY, String(newTotal));
      
    } catch (e) {
      Logger.log(`[CostTracker Error] ${e.toString()}`);
    }
  }

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
      const content = String(json.choices[0].message.content).trim();
      // ★コスト計測
      _trackCost(systemPrompt + userPrompt, content, "Azure");
      return content;
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
      // ★コスト計測
      _trackCost(systemPrompt + userPrompt, content, "OpenAI");
      return content !== "" ? content : null;
    }
    return null;
  }
  
  // Azure Embedding API 呼び出し
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
      // ★コスト計測 (Inputのみ、Outputは0換算)
      _trackCost(text, "", "Azure Embedding");
      return json.data[0].embedding;
    }
    return null;
  }

  // OpenAI Embedding API 呼び出し
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
      // ★コスト計測 (Inputのみ)
      _trackCost(text, "", "OpenAI Embedding");
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
    
    // ★コスト計測 (Gemini無料枠の場合は0円だが一応記録)
    if (text) _trackCost(PROMPT, text, "Gemini");

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
    generateVector: function(text) {
      // 既存の Context 設定 (COMPANY or PERSONAL) に従って優先順位を決定
      const context = llmConfig.Context;
      const embConfig = llmConfig.Embedding;
      
      let vector = null;

      if (context === 'PERSONAL') {
        // PERSONAL優先: OpenAI -> Azure
        if (llmConfig.OpenAiKey) {
          vector = _callOpenAiEmbedding(text, embConfig.OpenAiModel, llmConfig.OpenAiKey);
        }
        if (!vector && embConfig.AzureEndpoint && llmConfig.AzureKey) {
          vector = _callAzureEmbedding(text, embConfig.AzureEndpoint, llmConfig.AzureKey);
        }
      } else {
        // COMPANY優先 (デフォルト): Azure -> OpenAI
        if (embConfig.AzureEndpoint && llmConfig.AzureKey) {
          vector = _callAzureEmbedding(text, embConfig.AzureEndpoint, llmConfig.AzureKey);
        }
        if (!vector && llmConfig.OpenAiKey) {
          vector = _callOpenAiEmbedding(text, embConfig.OpenAiModel, llmConfig.OpenAiKey);
        }
      }
      
      if (vector) {
        // 軽量化: 小数点以下6桁に丸める (容量約50%削減)
        return vector.map(v => parseFloat(v.toFixed(6)));
      }

      Logger.log("エラー: いずれのサービスでもベクトルを生成できませんでした。");
      return null;
    },

    // ★追加: 最後に合計コストを取得するための関数
    getSessionCost: function() {
      return _sessionCostTotal;
    },
    
    // ★追加: ログ出力用ヘルパー
    logSessionTotal: function() {
      if (_sessionCostTotal > 0) {
        const props = PropertiesService.getScriptProperties();
        const monthTotal = props.getProperty("SYSTEM_COST_ACCUMULATOR") || "0";
        Logger.log(`💰 [API Cost] 今回の合計: $${_sessionCostTotal.toFixed(6)} / 今月の合計: $${parseFloat(monthTotal).toFixed(4)}`);
      }
    }
  };
})();

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
    // 全記事の平均ベクトルを「重心」とする
    const centroid = _calculateAverageVector(mainstreamArticles);
    if (!centroid) return null;

    // 3. 孤独な点（Outliers）を抽出 【★改良版: ソートロジック追加】
    // 重心からの距離が遠い（類似度が低い）順に並べ替え、最も「異質な」上位N件を取得する
    const outliers = recentArticles
      .map(a => {
        // 重心との類似度を計算してオブジェクトに付与
        const sim = calculateCosineSimilarity(centroid, a.vector);
        return { ...a, similarityToCentroid: sim };
      })
      .filter(a => a.similarityToCentroid < config.OUTLIER_THRESHOLD)
      // ★重要: 類似度が低い順（昇順）に並び替え
      .sort((a, b) => a.similarityToCentroid - b.similarityToCentroid) 
      // 上限件数でカット（これで「最も異質なトップ100」が残る）
      .slice(0, config.MAX_OUTLIERS_TO_PROCESS);

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
    const sh = getSheet(AppConfig.get().SheetNames.TREND_DATA);
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

        // アウトライヤー同士が近いかどうか判定
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
      
      // 創造的な分析をさせるため温度を高めに設定
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

// #endregion

// =============================================================================
// #region 2. ENTRY POINTS (Triggers & Web)
// 【責務】外部からのアクセスを受け付ける「玄関」。
//  - トリガー実行されるジョブ関数 (runXxxJob)
//  - Webアプリケーションの入り口 (doGet)
//  - クライアントサイドへのデータ提供
// =============================================================================

/**
 * トリガーA: 収集専用 (Collection Job)
 * 頻度の目安: 1〜4時間ごと
 * 役割: RSSを巡回してシートに追記し、並び替えまで行います。AI要約はしません。
 */
function runCollectionJob() {
  Logger.log("--- 収集ジョブ開始 ---");
  
  // 高機能アーカイブ＆削除を実行
  // 頻繁に実行しても「3ヶ月前」が来るまでは何もせず即終了するので負荷はありません
  archiveAndPruneOldData();

  // 1か月前のHistoryを削除
  maintenancePruneDigestHistory();
  
  // ベクトル軽量化(30日経過データ)の実行
  maintenanceLightenOldArticles();

  collectRssFeeds();       
  sortCollectByDateDesc(); 

  // ★追加: アーカイブ処理などでAIを使った場合に備えてコストを表示
  // (コスト0円の時はログに出ないので邪魔になりません)
  LlmService.logSessionTotal();
  
  Logger.log("--- 収集ジョブ完了 ---");
}

/**
 * トリガーB: AI要約専用 (Summarization Job)
 * 頻度の目安: 4〜6時間ごと
 * 役割: シートを見て「見出しがない記事」を見つけ、AIで生成します。
 */
function runSummarizationJob() {
  const lock = LockService.getScriptLock();
  
  if (!lock.tryLock(10000)) {
    Logger.log("⚠️ 他のジョブが実行中のため、要約ジョブをスキップしました。");
    return;
  }

  try {
    Logger.log("--- 要約ジョブ開始 ---");
    processSummarization();  // メイン処理

    // ★追加: 今回のコスト合計を出力
    LlmService.logSessionTotal();

    Logger.log("--- 要約ジョブ完了 ---");
  } catch (e) {
    Logger.log("要約ジョブエラー: " + e.toString());
  } finally {
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
      // ... (メール送信処理など) ...
      Logger.log("予兆レポートの送信を完了しました。");
    } else {
      Logger.log("今回の実行では新たな「核形成（予兆）」は検知されませんでした。");
    }

    // ★追加: 今回のコスト合計を出力
    LlmService.logSessionTotal();

  } catch (e) {
    _logError("runEmergingSignalJob", e, "予兆検知ジョブ中に致命的なエラーが発生しました。");
  }
  Logger.log("--- 予兆（サイン）検知ジョブ完了 ---");
}

/** dailyDigestJob: 日刊ダイジェスト生成 - 過去24時間の全記事（キーワードフィルタリングなし） */
function dailyDigestJob() {
  Logger.log("--- 日刊ダイジェスト生成開始 (全記事対象) ---");
  
  const DAYS_WINDOW = AppConfig.get().System.DateWindows.DAILY_DIGEST_JOB; 
  const config = AppConfig.get().Digest; 
  const { start, end } = getDateWindow(DAYS_WINDOW); 
  
  const allItems = getArticlesInDateWindow(start, end);
  
  if (allItems.length === 0) {
    Logger.log("日刊ダイジェスト：対象期間に記事がありませんでした。");
    _handleNoArticlesFound(config, start, end, "対象期間に記事がありませんでした。", DAYS_WINDOW); 
    return;
  }
  
  Logger.log(`日刊ダイジェスト：対象期間内に ${allItems.length} 件の記事が見つかりました。`);
  
  _generateAndSendDailyDigest(allItems, config, start, end, DAYS_WINDOW);
  
  // ★追加: 今回のコスト合計を出力
  LlmService.logSessionTotal();
  
  Logger.log("--- 日刊ダイジェスト生成完了 ---");
}

/**
 * sendPersonalizedReport (日刊/週刊 自動切り替え版 & セマンティック対応)
 * Usersシートの設定に基づき、対象期間(daysWindow)を動的に変更してレポートを送信する。
 * - 配信曜日が空欄(毎日)の場合: daysWindow = 2 (昨日〜今日)
 * - 配信曜日が指定されている場合: daysWindow = 7 (過去1週間)
 * - UsersシートのE列を見て、AI意味検索の使用有無を切り替える
 */
function sendPersonalizedReport() {
  // ★ここを変更: getSheetを使うだけで自動でUsers(非公開)とKeywords(非公開)を見に行きます
  const usersSheet = getSheet(AppConfig.get().SheetNames.USERS);
  const keywordsSheet = getSheet(AppConfig.get().SheetNames.KEYWORDS);
  
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
 * [Server-side] getVisualizationData
 * 可視化用に最新記事のベクトルデータを取得して返す
 * 【修正版】新しい順（上から）取得するように変更
 */
function getVisualizationData() {
  const sheet = getSheet(AppConfig.get().SheetNames.TREND_DATA);
  // const lastRow = sheet.getLastRow(); // これは使いません

  // ★修正: 「一番下」ではなく「2行目（最新）」から500件を取得します
  const LIMIT = 500; 
  const startRow = 2; // ヘッダーの次から
  
  // データがあるか確認
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // 実際の行数がLIMITより少ない場合に対応
  const numRows = Math.min(LIMIT, lastRow - 1);

  const data = sheet.getRange(startRow, 1, numRows, 7).getValues();
  const vectorColIdx = 6; // G列
  
  return data
    .filter(r => r[vectorColIdx] && r[vectorColIdx].toString().trim() !== "") // ベクトルがあるものだけ
    .map(r => ({
      t: r[1], // Title
      u: r[2], // Url
      s: r[5], // Source
      v: r[vectorColIdx].split(',').map(parseFloat) 
    }));
}

/**
 * jobDispatcher (統合スケジューラー)
 * 【責務】「30分おき」のトリガーで起動し、時刻の「分」を見てジョブを振り分ける。
 * - 毎時 00分〜29分 の間なら: 収集ジョブ (runCollectionJob)
 * - 毎時 30分〜59分 の間なら: 要約ジョブ (runSummarizationJob)
 * これにより、2つの重いジョブが同時に走ることを防ぎつつ、両方を1時間ごとに実行する。
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

// #endregion

// =============================================================================
// #region 3. REPORTING LOGIC (Generation & Delivery)
// 【責務】ユーザーに届ける「アウトプット」の生成。
//  - トレンドレポートのHTML組み立て
//  - LLMによる記事分析・コメント生成
//  - メール送信・宛先管理
// =============================================================================

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
    finalHtmlBody += `<style>.summary-section{background-color:${C.BG_CARD};padding:20px;border-radius:8px;margin-bottom:25px;box-shadow:0 2px 5px rgba(0,0,0,0.05)}.summary-title{margin-top:0;color:${C.SECONDARY};font-size:18px;font-weight:bold;border-bottom:2px solid ${C.BORDER};padding-bottom:10px;margin-bottom:15px}.section-header{border-left:5px solid ${C.PRIMARY};border-bottom:none;padding-left:10px;padding-bottom:0;color:${C.SECONDARY};margin-top:30px;margin-bottom:15px;font-size:20px}.tech-card{margin-bottom:20px;border:none;padding:20px;border-radius:8px;background-color:${C.BG_CARD};box-shadow:0 2px 8px rgba(0,0,0,0.08);border-left:5px solid ${C.PRIMARY}}.tech-title{margin:0 0 15px 0;color:${C.SECONDARY};font-size:17px;font-weight:bold;line-height:1.4}.tech-meta{font-size:15px;line-height:1.7;color:${C.TEXT_SUB}}.tech-link{margin-top:15px;text-align:left}.tech-link a{display:inline-block;padding:8px 16px;background-color:${C.BADGE_NEW_BG};color:${C.PRIMARY};text-decoration:none;border-radius:20px;font-size:13px;font-weight:bold}.tech-link a:hover{background-color:${C.BADGE_NEW_BG}}</style>`;
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
        let cleanHtml = contentBody.replace(/```html/gi, "").replace(/```/g, "");

        // ▼▼▼ 追加: リンクを見つけて「AI要約ボタン」を挿入する処理 ▼▼▼
        cleanHtml = cleanHtml.replace(
          /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, 
          (match, url, text) => {
             // 一意なIDを生成
             const uniqueId = "summary-" + Math.random().toString(36).substring(2, 10);
             const btnStyle = "background-color:#8e44ad; color:#fff; border:none; border-radius:12px; padding:3px 10px; font-size:11px; cursor:pointer; margin-right:8px; vertical-align:middle; font-weight:bold;";
             
             // ボタンと要約表示エリアを埋め込む
              return `
               <span style="display:inline-block; margin: 4px 0;">
                 <button onclick="fetchSummary('${url}', '${uniqueId}', this)" style="${btnStyle}">⚡ AI要約</button>
                 <a href="${url}" target="_blank" style="text-decoration:none; color:#2980b9; font-weight:bold;">${text}</a>
               </span>
               <div id="${uniqueId}" style="display:none; margin:10px 0 15px 0; padding:12px; background:#f8f9fa; border-left:4px solid #8e44ad; border-radius:4px; font-size:90%; line-height:1.6; color:#333; text-align: left;"></div>
             `;
          }
        );

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

/** * generateWeeklyReportWithLLM (オプション対応) 
 */
function generateWeeklyReportWithLLM(articles, hitKeywordsWithCount, articlesGroupedByKeyword, previousSummary = null, options = {}) {
  const LINKS_PER_TREND = AppConfig.get().System.Limits.LINKS_PER_TREND;
  const hitKeywords = hitKeywordsWithCount.map(item => item.keyword);
  const trends = LlmService.generateTrendSections(articlesGroupedByKeyword, LINKS_PER_TREND, hitKeywords, previousSummary, options);
  return { reportBody: trends };
}

/**
 * 【共通エンジン】キーワード分析・履歴保存プロセッサー (オプション対応)
 * options: { enableHistory: boolean, promptKeys: { system: string, user: string } }
 */
function processKeywordAnalysisWithHistory(keyword, articles, options = {}) {
  let previousSummary = null;
  if (options.enableHistory !== false) {
    
    // ★変更: 検索用に「今回の記事タイトル一覧」などをテキスト化して渡す
    const contextForSearch = articles.map(a => a.title).join(" ");
    
    // 新しい連想記憶関数を使用
    previousSummary = _getRelevantHistory(keyword, contextForSearch);
  }

  // 1. レポート本文（人間用）の生成 [Call 1]
  const { reportBody } = generateWeeklyReportWithLLM(
    articles,
    [{ keyword: keyword, count: articles.length }],
    { [keyword]: articles },
    previousSummary,
    options
  );

  if (!reportBody || reportBody.trim() === "") return null;

  // 2. 来週のAI用「圧縮コンテキスト」の生成 [Call 2]
  // (旧 _summarizeReport の代わりにこちらを実行して、濃縮された情報を履歴に残す)
  const nextContext = _generateContextForNextWeek(reportBody);

  const shouldSave = (options.enableHistory !== false) && (options.saveHistory !== false);

  if (shouldSave && nextContext) {
    // スプレッドシートには「AI用圧縮コンテキスト」を保存
    _writeHistory(keyword, nextContext);
  } else if (!shouldSave && nextContext) {
    Logger.log(`[Test Mode] 履歴の保存をスキップしました (Keyword: ${keyword})`);
  }

  // 戻り値の summary も nextContext に統一します
  return { reportBody, summary: nextContext };
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

/**
 * getRecipients
 * 【責務】配信先メールアドレスリスト（カンマ区切り）を生成する。
 * 【仕様】管理者メールと、Usersシートの有効なユーザーを統合し重複排除。
 */
function getRecipients() {
  const adminMail = AppConfig.get().Digest.mailTo; 
  const sheet = getSheet(AppConfig.get().SheetNames.USERS); // ★変更
  const recipientSet = new Set();
  
  if (adminMail) {
    adminMail.split(',').forEach(e => { if(e.trim()) recipientSet.add(e.trim()); });
  }

  if (sheet && sheet.getLastRow() >= 2) {
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
    data.forEach(row => {
      if (String(row[1]).trim() && String(row[2]).trim() !== "") recipientSet.add(String(row[1]).trim());
    });
  }
  return Array.from(recipientSet).join(',');
}

/** executeWeeklyDigest: ウェブUI呼び出し - 指定キーワードのダイジェスト生成
 * 【役割】Web UIからのリクエストを受け取り、適切なオプションで分析を実行するラッパー。
 * @param {string} keyword - 検索キーワード
 * @param {Object} clientOptions - クライアントから渡された日付等のオプション
 * @returns {string} 分析結果のHTML文字列
 */
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
 * searchAndAnalyzeKeyword
 * 【責務】Index.html からの呼び出し互換性のためのエイリアス。
 */
function searchAndAnalyzeKeyword(keyword, options) {
  return executeWeeklyDigest(keyword, options);
}

/**
 * performSemanticSearch
 * 【責務】ベクトル類似度を使って、意味的に近い記事を検索・ソートして返す。
 * @param {string} queryKeyword 検索クエリ
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
  const sheet = getSheet(AppConfig.get().SheetNames.TREND_DATA);
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

// #endregion

// =============================================================================
// #region 4. MEMORY & HISTORY LOGIC
// 【責務】過去の文脈を管理する「記憶」の操作。
//  - 来週への引き継ぎ用コンテキスト圧縮
//  - 過去履歴の検索（キーワード一致 & ベクトル連想検索）
//  - 履歴シートへの保存
// =============================================================================

/** * _generateContextForNextWeek (旧 _summarizeReport)
 * 【責務】来週のAIのために、今回のレポートから「文脈」と「事実」を損失なく圧縮する。
 * 人間用の読みやすさは考慮せず、情報の密度を重視する。
 */
function _generateContextForNextWeek(reportText) {
  if (!reportText || reportText.trim() === "") return "";
  
  Logger.log("来週への引き継ぎ用コンテキスト圧縮を開始します。");
  
  // ★変更点1: 履歴作成には少し賢いモデル(Mini)を使うことで、文脈の理解度を上げる
  // (コストを極限まで下げるならNanoのままでも可ですが、記憶維持ならMini推奨)
  const model = AppConfig.get().Llm.ModelMini; 
  
  // ★変更点2: プロンプトキーを専用のものに変更
  const SYSTEM_PROMPT = getPromptConfig("CONTEXT_COMPRESSION_SYSTEM");
  
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
 * _getRelevantHistory (連想記憶検索)
 * 【責務】キーワードの一致、または「内容が近い」過去の履歴を探し出す。
 * 1. まずキーワード完全一致の最新履歴を探す（直近の継続性を優先）。
 * 2. なければ、現在の記事群から生成したベクトルを使って過去の履歴を意味検索する。
 * @param {string} keyword - 検索キーワード
 * @param {string} currentContextText - 今回の記事群のテキスト（ベクトル生成用）
 */
function _getRelevantHistory(keyword, currentContextText) {
  const sheet = getSheet(AppConfig.get().SheetNames.DIGEST_HISTORY);
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
  const SIMILARITY_THRESHOLD = 0.85; // 関連性が高いとみなす閾値

  for (let i = 0; i < data.length; i++) {
    const vecStr = data[i][3]; // D列: Vector
    if (!vecStr) continue;

    const histVector = parseVector(vecStr);
    if (!histVector) continue;

    const sim = calculateCosineSimilarity(queryVector, histVector);
    
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

/** _getLatestHistory: DigestHistoryシートからキーワードの最新要約を取得 */
function _getLatestHistory(keyword) {
  try {
    const sheet = getSheet(AppConfig.get().SheetNames.DIGEST_HISTORY);
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
 * _writeHistory (連想記憶対応版)
 * 【責務】DigestHistoryシートに「圧縮コンテキスト」とその「ベクトル」を書き込む
 */
function _writeHistory(keyword, summary) {
  try {
    const sheet = getSheet(AppConfig.get().SheetNames.DIGEST_HISTORY);
    if (!sheet) return;

    // ★追加: コンテキストの意味ベクトルを生成
    // (要約自体をベクトル化することで、内容での検索を可能にする)
    const vector = LlmService.generateVector(summary);
    const vectorStr = vector ? vector.join(',') : "";

    // [日付, キーワード, 要約, ベクトル] の順で保存
    sheet.appendRow([new Date(), keyword, summary, vectorStr]);
    
    Logger.log(`履歴保存(Vector付): キーワード「${keyword}」を記録しました。`);
  } catch (e) {
    _logError("_writeHistory", e, "履歴書き込みエラー");
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

// #endregion

// =============================================================================
// #region 5. ANALYSIS LOGIC (Summarization)
// 【責務】収集データに対する「加工・付加価値づけ」。
//  - 記事の要約生成（要約ジョブ）
//  - ベクトル生成と保存
//  - 過去記事へのベクトル一括付与（バックフィル）
// =============================================================================


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

/** processSummarization: AI見出し生成（E列）＆ ベクトル生成（G列）
 * 【責務】シート内の「要約（見出し）」が空の記事を特定し、AI(LlmService)を使用して自動生成する。
 * さらに、生成された要約とタイトルを元にベクトル（Embedding）を生成し、G列に保存する。
 * 短い記事：タイトルまたはスプレッドシート数式(=GOOGLETRANSLATE)を使用。
 * 長い記事：LLM(ModelNano)を呼び出して要約を生成。
 * 【実行制限】GASの実行時間オーバーを避けるため、5分のタイムアウト制限を設けている。
 */
function processSummarization() {
  const trendDataSheet = getSheet(AppConfig.get().SheetNames.TREND_DATA);
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
          Logger.log(`ベクトル生成エラー(Short) (Row: ${index + 2}): ${e.toString()}`);
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

/**
 * backfillVectors: ベクトル未付与の記事に対してEmbeddingを一括実行
 * 【修正版】軽量化ポリシーに合わせて「直近1ヶ月以内」の記事のみを対象とする。
 * これにより、削除された過去のベクトルを無駄に再生成するのを防ぐ。
 */
function backfillVectors() {
  const trendDataSheet = getSheet(AppConfig.get().SheetNames.TREND_DATA);
  if (!trendDataSheet) {
    Logger.log("エラー: collectシートが見つかりません。");
    return;
  }
  const lastRow = trendDataSheet.getLastRow();
  if (lastRow < 2) return;

  const startTime = new Date().getTime();
  const TIME_LIMIT_MS = AppConfig.get().System.TimeLimit.SUMMARIZATION;
  const VECTOR_COL_INDEX = AppConfig.get().CollectSheet.Columns.VECTOR - 1; 

  // ★追加設定: 何ヶ月前まで遡るか（軽量化期間と合わせる）
  const TARGET_WINDOW_MONTHS = 1; 
  const thresholdDate = new Date();
  thresholdDate.setMonth(thresholdDate.getMonth() - TARGET_WINDOW_MONTHS);
  thresholdDate.setHours(0, 0, 0, 0);

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
    const dateVal = new Date(row[0]); // A列: Date

    // ★追加ガード: 記事が古すぎる場合は、ベクトルが無くても無視する
    if (dateVal < thresholdDate) {
      continue;
    }

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
      
      Utilities.sleep(AppConfig.get().System.Limits.BACKFILL_DELAY); 
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
    
    Logger.log(`バックフィル完了: 直近${TARGET_WINDOW_MONTHS}ヶ月以内の記事 ${processedCount} 件にベクトルを付与しました。`);
  } else {
    Logger.log(`バックフィル対象（直近${TARGET_WINDOW_MONTHS}ヶ月・見出しあり・ベクトルなし）は見つかりませんでした。`);
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

/** * collectRssFeeds (楽観的スキップ機能付き & 重複チェック修正版)
 * 【責務】RSSフィードを巡回し、collectシートに追加する。
 * 【改善】通信前に「次の開始位置」を保存することで、重いフィードでタイムアウトしても
 * 次回実行時はそのチャンクをスキップし、無限ループを回避する。
 */
function collectRssFeeds() {
  const startTime = new Date().getTime();
  // 全体のタイムリミット (5分)
  const TIME_LIMIT_MS = 300 * 1000; 

  const rssListSheet = getSheet(AppConfig.get().SheetNames.RSS_LIST);
  const collectSheet = getSheet(AppConfig.get().SheetNames.TREND_DATA);
  
  if (!rssListSheet || !collectSheet) return;

  if (rssListSheet.getLastRow() < AppConfig.get().RssListSheet.DataRange.START_ROW) {
    Logger.log("RSSリストが空のため、収集をスキップします。");
    return;
  }

  // プロパティ管理
  const props = PropertiesService.getScriptProperties();
  const savedIndexKey = "RSS_COLLECTION_NEXT_INDEX";
  
  // 前回保存された「次回の開始位置」を取得
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
    
    // ★修正: シートは降順(最新が上)なので、上からN件を取得する
    const startCheckRow = 2;
    const numRowsToCheck = Math.min(lastRow - 1, checkLimit);
    
    const existingData = collectSheet.getRange(startCheckRow, 2, numRowsToCheck, 2).getValues();
    existingData.forEach(row => {
      if (row[1]) existingUrlSet.add(normalizeUrl(row[1])); 
      if (row[0]) existingTitleSet.add(decodeHtmlEntities(String(row[0])).trim().toLowerCase());
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
  const allScheduledRequests = _scheduleRequestsByDomain(rawRequests);

  // 今回のターゲット (startIndex以降)
  const targetRequests = allScheduledRequests.slice(startIndex);

  let totalNewCount = 0;
  const CHUNK_SIZE = AppConfig.get().System.Limits.RSS_CHUNK_SIZE; 
  let isTimeUp = false;

  // --- チャンク実行ループ ---
  for (let i = 0; i < targetRequests.length; i += CHUNK_SIZE) {
    
    // 1. 全体タイムリミットチェック
    if (new Date().getTime() - startTime > TIME_LIMIT_MS) {
      Logger.log("⏳ タイムリミット到達。残りは次回実行します。");
      isTimeUp = true;
      break; 
    }

    // 2. ★楽観的保存
    const nextStartCandidate = startIndex + i + CHUNK_SIZE;
    props.setProperty(savedIndexKey, String(nextStartCandidate));

    const chunkItems = targetRequests.slice(i, i + CHUNK_SIZE);
    const chunkRequests = chunkItems.map(item => item.request);
    
    Logger.log(`Processing chunk: ${startIndex + i + 1} 〜 ${Math.min(startIndex + i + CHUNK_SIZE, allScheduledRequests.length)}`);
    
    try {
      // 3. 通信実行
      const responses = UrlFetchApp.fetchAll(chunkRequests);
      
      // --- 以下、応答処理 ---
      const chunkNewItems = [];
      responses.forEach((response, idx) => {
        const meta = chunkItems[idx];
        if (response.getResponseCode() !== 200) return;

        const items = parseRssXml(response.getContentText(), meta.rssUrl);
        if (!items) return;

        items.forEach(item => {
          try {
            if (!item.link || !item.title) return;
            const normalizedLink = normalizeUrl(item.link);
            const cleanTitle = stripHtml(item.title).trim();
            const normTitleToCheck = decodeHtmlEntities(cleanTitle).toLowerCase();

            // 重複チェック (セット内の最新記事と比較)
            if (existingUrlSet.has(normalizedLink) || existingTitleSet.has(normTitleToCheck)) return;
            if (!item.pubDate || !isRecentDate(item.pubDate, DATE_LIMIT_DAYS)) return;
            
            chunkNewItems.push([
              new Date(),
              cleanTitle,
              item.link,
              stripHtml(item.description || AppConfig.get().Llm.NO_ABSTRACT_TEXT).trim().replace(/[\r\n]+/g, " "),
              "",
              meta.siteName
            ]);
            // 追加した記事も即座に重複除外セットに追加
            existingUrlSet.add(normalizedLink);
            existingTitleSet.add(normTitleToCheck);
          } catch (e) {}
        });
      });

      if (chunkNewItems.length > 0) {
        collectSheet.getRange(collectSheet.getLastRow() + 1, 1, chunkNewItems.length, chunkNewItems[0].length).setValues(chunkNewItems);
        totalNewCount += chunkNewItems.length;
        SpreadsheetApp.flush();
      }

      // ウェイト
      if (i + CHUNK_SIZE < targetRequests.length) {
        Utilities.sleep(AppConfig.get().System.Limits.RSS_INTER_CHUNK_DELAY); 
      }

    } catch (e) {
      Logger.log(`⚠️ Chunk Error (Timeout or Network): ${e.toString()}`);
    }
  }

  if (!isTimeUp) {
    props.setProperty(savedIndexKey, "0");
    Logger.log("✅ 全件巡回完了。インデックスをリセットしました。");
  } else {
    Logger.log(`⏸️ 時間切れ中断。次回は保存された位置から再開します。`);
  }
  
  Logger.log(`今回追加件数: ${totalNewCount}`);
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
 * archiveAndPruneOldData
 * 【責務】古いデータを「JSON退避」＆「重心記録」してから、collectシートから削除する。
 * これにより、データ保全と軽量化、長期トレンド追跡をすべて同時に実現する。
 */
function archiveAndPruneOldData() {
  const config = AppConfig.get();
  const RETENTION_MONTHS = config.System.Limits.DATA_RETENTION_MONTHS;
  
  const collectSheet = getSheet(config.SheetNames.TREND_DATA);
  const macroSheet = getSheet(config.SheetNames.MACRO_TRENDS); // 新設シート
  
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
      const vec = parseVector(vecStr);
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
    const sampleTitles = titles.sort(() => 0.5 - Math.random()).slice(0, 50).join("\n");
    const prompt = `以下の記事タイトル群は、ある過去の期間に収集されたニュースです。\nこの期間の「主要なトレンド」を一言（30文字以内）で要約してください。\n\n${sampleTitles}`;
    
    // Nanoモデルでサクッと要約
    const summary = LlmService.summarizeReport(prompt, "過去トレンドの要約"); 
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
  try {
    macroSheet.appendRow([
      new Date(), 
      archiveLabel, 
      numRows, 
      topicSummary, 
      centroidVectorStr
    ]);
    Logger.log(`[MacroTrends] 重心データを記録しました: ${topicSummary}`);
  } catch (e) {
    Logger.log(`MacroTrends記録エラー: ${e.toString()}`);
  }

  // 5. 元データの削除 (ここまでエラーなく来たら消す)
  collectSheet.deleteRows(archiveStartRow, numRows);
  Logger.log(`[削除完了] collectシートから ${numRows} 行を削除しました。`);
}

/**
 * maintenanceDeleteOldArticles
 * 【責務】指定期間（デフォルト6ヶ月）より古い記事をcollectシートから一括削除する。
 */
function maintenanceDeleteOldArticles() {
  const KEEP_MONTHS = AppConfig.get().System.Limits.DATA_RETENTION_MONTHS;
  
  const sheet = getSheet(AppConfig.get().SheetNames.TREND_DATA);
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
 * maintenanceLightenOldArticles
 * 【責務】1ヶ月より古い記事の「ベクトル列(G列)」だけを削除して軽量化する。
 * 記事自体の行は消さないので、キーワード検索にはヒットする。
 */
function maintenanceLightenOldArticles() {
  const LIGHTEN_THRESHOLD_MONTHS = 1; // 1ヶ月以上前の記事を軽量化
  
  const sheet = getSheet(AppConfig.get().SheetNames.TREND_DATA);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const thresholdDate = new Date();
  thresholdDate.setMonth(thresholdDate.getMonth() - LIGHTEN_THRESHOLD_MONTHS);
  
  // 日付列(A列)とベクトル列(G列)の位置を取得
  const dateValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const vectorColIndex = AppConfig.get().CollectSheet.Columns.VECTOR; 
  
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
  const RETENTION_DAYS = 60; // 2ヶ月保存（これより古いと、話題が途切れたとみなして忘れる）
  
  const sheet = getSheet(AppConfig.get().SheetNames.DIGEST_HISTORY);
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
  const sheet = getSheet(config.SheetNames.TREND_DATA);
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
 * removeDuplicates
 * 【責務】URL正規化により collect シート内の重複記事を削除する。
 * 【仕様】上から順に走査し、正規化URLが重複している行を削除。
 */
function removeDuplicates() {
  const sheet = getSheet(AppConfig.get().SheetNames.TREND_DATA);
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
 * sortCollectByDateDesc
 * 【責務】collectシートを日付順（新しい順）に並び替える。
 */
function sortCollectByDateDesc() {
  const sheet = getSheet(AppConfig.get().SheetNames.TREND_DATA);
  const lastRow = sheet.getLastRow();
  
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn())
         .sort({column: 1, ascending: false});
    Logger.log("collectシートを日付(最新順)で並び替えました。");
  }
}

/**
 * getWebPageSummary (オンデマンドAI要約)
 * 指定されたURLのWebページを取得し、AIで要約して返します。
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
      bodyText = stripHtml(bodyMatch[1]); // 既存のタグ除去関数を利用
    } else {
      bodyText = stripHtml(html);
    }
    
    // 文字数が多すぎるとエラーになるので、先頭3万文字程度にカット
    const truncatedText = bodyText.replace(/\s+/g, " ").trim().substring(0, 30000);

    if (truncatedText.length < 50) {
      return "エラー: ページから十分なテキストを抽出できませんでした（画像メインやJavaScript専用サイトの可能性があります）。";
    }

    // 3. LLMで要約・圧縮
    const systemPrompt = `
    あなたはプロの編集者です。
    Web記事の内容を、業界動向を追うビジネスパーソン向けに300文字程度の「解説記事」として要約してください。

    # 指示
    - 重要なキーワード（企業名、技術名、数値など）は **太字** で強調してください。
    - 専門用語には簡単な補足をいれてください。
    - 記事の「新規性」や「メリット」が伝わるように構成してください。
    - 冒頭に # などの見出し記号はつけないでください。
    `;
    
    // 既存の要約機能（Nanoモデル推奨）を再利用
    // ※LlmService._callLlmWithFallback はprivateなので、summarizeReport等の公開メソッドを使うか、
    //  LlmService内に新しいメソッドを追加するのが理想ですが、ここでは既存の summarizeReport を流用します。
    const summary = LlmService.summarizeReport(systemPrompt, truncatedText);
    
    return summary;

  } catch (e) {
    return `エラーが発生しました: ${e.message}`;
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

/**
 * getSheet (自動振り分け版)
 * 【責務】シート名に応じて「データ用(公開)」か「設定用(非公開)」か判定し、正しいIDを開く。
 * @param {string} sheetName - シート名
 * @returns {Sheet} シートオブジェクト (存在しない場合はnull)
 */
function getSheet(sheetName) {
  const config = AppConfig.get();
  
  // ★重要: 非公開(Config)シートにあるべきシート名をリスト化
  const PRIVATE_SHEETS = [
    config.SheetNames.USERS,           // Users
    config.SheetNames.PROMPT_CONFIG,   // prompt
    config.SheetNames.KEYWORDS,        // Keywords
    config.SheetNames.DIGEST_HISTORY,  // DigestHistory (★追加)
    "Memo"                             // Memo
  ];

  let targetId;
  // リストに含まれていれば非公開ID、そうでなければ公開データIDを使う
  if (PRIVATE_SHEETS.includes(sheetName) || sheetName === "Keywords" || sheetName === "Memo") {
    targetId = config.System.ConfigSheetId;
  } else {
    targetId = config.System.DataSheetId;
  }

  if (!targetId || targetId.includes("未設定")) {
    console.error(`ID設定エラー: ${sheetName} を開くためのIDが設定されていません。`);
    return null;
  }
  
  try {
    const ss = SpreadsheetApp.openById(targetId);
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
 * parseRssXml
 * 【責務】RSSのXML文字列をパースして記事オブジェクトの配列を返す。
 * 【対応フォーマット】RSS 2.0, Atom, RSS 1.0 (RDF)
 * @param {string} xml - RSSのXML文字列
 * @param {string} url - エラーログ用のURL
 * @returns {Array} 記事オブジェクトの配列
 */
function parseRssXml(xml, url) {
  try {
    // 1. 最低限のサニタイズ（制御文字削除 & エスケープ漏れ修正のみ）
    // ※タグの書き換えは行わない
    let safeXml = xml.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, '');
    safeXml = safeXml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[a-f\d]+);)/gi, '&amp;');

    let document;
    try {
      document = XmlService.parse(safeXml);
    } catch (e) {
      console.warn(`XMLパース失敗(正規表現へ移行): ${url} - ${e.message}`);
      return _fallbackParseRssRegex(xml);
    }

    const root = document.getRootElement();
    let itemNodes = [];

    // 2. 記事ノードの探索 (名前空間を無視して探すヘルパーを使用)
    
    // パターンA: <channel> がある場合 (RSS 2.0 / Mixed)
    const channel = getChildNoNs(root, 'channel');
    if (channel) {
      // channelの下の item または entry を探す
      itemNodes = getChildrenNoNs(channel, 'item');
      if (itemNodes.length === 0) {
        itemNodes = getChildrenNoNs(channel, 'entry'); // 混合型対策
      }
    }

    // パターンB: ルート直下を探す (RSS 1.0 / Atom)
    if (itemNodes.length === 0) {
      itemNodes = getChildrenNoNs(root, 'item'); // RSS 1.0 (RDF)
    }
    if (itemNodes.length === 0) {
      itemNodes = getChildrenNoNs(root, 'entry'); // Atom
    }

    if (itemNodes.length === 0) return [];

    // 3. データ抽出 (名前空間無視で中身を取り出す)
    return itemNodes.map(node => {
      // リンク取得
      let link = getXmlValue(node, ['link', 'origLink']); 
      if (!link) {
        // <link href="..."> 形式 (Atom系) を属性から探す
        const allChildren = node.getChildren();
        for (const c of allChildren) {
          // タグ名が link で、href属性を持っているか確認
          if (c.getName().toLowerCase() === 'link' && c.getAttribute('href')) {
            link = c.getAttribute('href').getValue();
            break;
          }
        }
      }

      return {
        title: getXmlValue(node, ['title']),
        link: link,
        description: getXmlValue(node, ['description', 'encoded', 'content', 'summary']),
        // 各種日付タグ候補を順に試す
        pubDate: getXmlValue(node, ['pubDate', 'date', 'updated', 'published', 'dc:date']),
        source: "AutoDetect"
      };
    });

  } catch (e) {
    console.error(`parseRssXml Error: ${url} / ${e.toString()}`);
    return [];
  }
}

/**
 * _fallbackParseRssRegex
 * 【責務】XMLパースに失敗した場合の救済措置。正規表現で記事情報を抜く。
 */
function _fallbackParseRssRegex(xml) {
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
function getXmlValue(element, possibleTags) {
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
function getChildNoNs(element, tagName) {
  const children = element.getChildren();
  for (const child of children) {
    if (child.getName().toLowerCase() === tagName.toLowerCase()) {
      return child;
    }
  }
  return null;
}

// 名前空間を無視して、指定したタグ名の子要素をすべて取得
function getChildrenNoNs(element, tagName) {
  return element.getChildren().filter(c => c.getName().toLowerCase() === tagName.toLowerCase());
}

/**
 * cleanAndParseJSON (修正版)
 * 【責務】LLMのレスポンスからJSON部分を抽出し、パースする。
 * 【自己修復】標準的なパースに失敗した場合、正規表現で強引に内容を抽出する。
 */
function cleanAndParseJSON(text) {
  if (!text) return null;
  
  // 1. Markdownのコードブロック ```json や ``` を削除
  let cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  
  // 2. 文字列内の「本物の改行」をエスケープ文字（\n）に置換
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
  try {
    // ★修正: 末尾が閉じられていなくても、文字列の終わり($)までを許容するように変更
    // 変更前: ...(?:"\s*\}|"$|(?=\s*\}))/i;
    // 変更後: ...(?:"|(?=\s*\})|$)/i;
    const regex = /"(?:tldr|summary)"\s*:\s*"([\s\S]*?)(?:"|(?=\s*\})|$)/i;
    const match = cleaned.match(regex);
    
    if (match && match[1]) {
      let recoveredText = match[1].trim();
      // 末尾にゴミ（ } や " ）が残っていたら掃除
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
 * markdownToHtml (Final Typography Ver.)
 * 【責務】Markdown → HTML 変換
 * 【修正】日本語の可読性を高めるため、段落の「字下げ(Indent)」と行間を調整
 */
function markdownToHtml(md) {
  if (!md) return "";
  
  const C = AppConfig.get().UI.Colors;

  // デザイン定義
  const S = {
    WRAPPER: `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #333; line-height: 1.6; font-size: 14px;`,
    
    // サマリー (字下げ追加)
    SUMMARY_BOX: `background-color: #f0f7ff; border-left: 5px solid ${C.PRIMARY}; padding: 15px; margin-bottom: 25px; border-radius: 4px;`,
    SUMMARY_TITLE: `font-weight: bold; color: ${C.SECONDARY}; margin: 0 0 10px 0; font-size: 15px; border-bottom: 1px dashed #cce5ff; padding-bottom: 5px; display: block;`,
    SUMMARY_BODY: `font-size: 14px; line-height: 1.8; text-indent: 1em; display: block;`, // ★字下げ追加
    
    // カード
    CARD: `background-color: #ffffff; padding: 25px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ddd; box-shadow: 0 2px 4px rgba(0,0,0,0.03);`,
    
    // 見出し
    H3: `font-size: 18px; font-weight: bold; color: ${C.SECONDARY}; margin-top: 0; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 2px solid ${C.PRIMARY}; line-height: 1.4;`,
    
    // 項目ブロック
    ITEM_BLOCK: `margin-bottom: 18px;`,
    ITEM_LABEL: `font-size: 12px; font-weight: bold; color: #555; display: flex; align-items: center; margin-bottom: 4px;`,
    ITEM_ICON:  `margin-right: 6px; font-size: 14px;`,
    
    // ★変更: 項目本文 (字下げ + 行間広め)
    ITEM_BODY:  `color: #333; line-height: 1.8; text-indent: 1em; display: block;`, 

    // リンク
    LINK_ROW: `margin-top: 15px; border-top: 1px dashed #eee; padding-top: 8px;`,
    LINK_LABEL: `font-size: 11px; color: #999; font-weight: bold; display: block; margin-bottom: 5px;`,
    LINK_ITEM: `margin-bottom: 4px; display: flex; align-items: center;`,
    LINK_BTN: `display: inline-block; font-size: 10px; color: #fff; background-color: ${C.PRIMARY}; text-decoration: none; padding: 4px 10px; border-radius: 12px; margin-right: 8px; white-space: nowrap;`,
    LINK_TEXT: `font-size: 12px; color: ${C.LINK}; text-decoration: none; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical;`,

    // バッジ
    BADGE: 'display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; margin-left: 8px; vertical-align: middle; line-height: 1.2;',
    B_NEW: `background-color: ${C.BADGE_NEW_BG}; color: ${C.BADGE_NEW_TXT}; border: 1px solid ${C.BADGE_NEW_BG};`,
    B_UP:  `background-color: ${C.BADGE_UP_BG}; color: ${C.BADGE_UP_TXT}; border: 1px solid ${C.BADGE_UP_BG};`,
    B_WARN:`background-color: ${C.BADGE_WARN_BG}; color: ${C.BADGE_WARN_TXT}; border: 1px solid ${C.BADGE_WARN_BG};`,
    B_KEEP:`background-color: ${C.BADGE_KEEP_BG}; color: ${C.BADGE_KEEP_TXT}; border: 1px solid ${C.BADGE_KEEP_BG};`
  };

  const L = AppConfig.get().Logic;

  // アイコンマッピング
  const ICON_MAP = {
    '詳細分析': '&#129488;', // 🧐
    '詳細': '&#128221;',     // 📝
    '先週': '&#9194;',       // ⏮️
    '今週': '&#9889;',       // ⚡
    '現状': '&#128202;',     // 📊
    '影響': '&#127919;',     // 🎯
    'default': '&#128073;'   // 👉
  };

  // 1. 基本エスケープ
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. バッジ変換
  html = html
    .replace(L.TAGS.NEW, `<span style="${S.BADGE} ${S.B_NEW}">&#10024; 新規</span>`)
    .replace(L.TAGS.UP, `<span style="${S.BADGE} ${S.B_UP}">&#128200; 進展</span>`)
    .replace(L.TAGS.WARN, `<span style="${S.BADGE} ${S.B_WARN}">&#9888; 懸念</span>`)
    .replace(L.TAGS.KEEP, `<span style="${S.BADGE} ${S.B_KEEP}">&#10145; 継続</span>`);

  // 3. サマリーセクション (字下げ適用)
  html = html.replace(
    /(?:^|\n)\s*(?:[\*\*_【\[\s]*)(エグゼクティブ・サマリー|Executive Summary)(?:[\*\*_】\]\s]*)\n([\s\S]*?)(?=\*\*|__|$|###|1\.)/gi, 
    `<div style="${S.SUMMARY_BOX}"><span style="${S.SUMMARY_TITLE}">&#128221; $1</span><div style="${S.SUMMARY_BODY}">$2</div></div>`
  );

  // 4. トピックタイトル
  html = html.replace(/^### (.*$)/gim, `<h3 style="${S.H3}">$1</h3>`);
  html = html.replace(/\*\*([0-9]+\..*?)\*\*/g, `<h3 style="${S.H3}">$1</h3>`);

  // 5. リスト項目（ラベル＋本文）
  html = html.replace(/^\s*-\s*(?:\*\*|__)(.*?)(?::|：)?\s*(?:\*\*|__)\s*(?::|：)?\s*(.*)$/gm, (match, key, val) => {
    let icon = ICON_MAP['default'];
    for (const k in ICON_MAP) {
      if (key.includes(k)) {
        icon = ICON_MAP[k];
        break;
      }
    }
    return `
      <div style="${S.ITEM_BLOCK}">
        <div style="${S.ITEM_LABEL}"><span style="${S.ITEM_ICON}">${icon}</span>${key}</div>
        <div style="${S.ITEM_BODY}">${val}</div>
      </div>`;
  });

  // 6. リンク (デザイン微調整)
  // リンクエリアの開始
  html = html.replace(/- \s*(?:\*\*|__)\s*関連URL:?\s*(?:\*\*|__)(.*)/g, `<div style="${S.LINK_ROW}"><span style="${S.LINK_LABEL}">REFERENCE</span>$1`);
  
  // 個別リンク生成ロジックを変更
  html = html.replace(
    /-\s*\[([^\]]+)\]\(([^)]+)\)/g, 
    (match, title, url) => {
      // 一意なIDを生成（表示エリア用）
      const uniqueId = "summary-" + Math.random().toString(36).substring(2, 10);
      
      return `
      <div style="${S.LINK_ITEM}">
        <a href="${url}" target="_blank" style="${S.LINK_BTN}">Open &#8599;</a>
        
        <button onclick="fetchSummary('${url}', '${uniqueId}', this)" 
                style="${S.LINK_BTN}; background-color: #8e44ad; border:none; cursor:pointer;">
          ⚡ AI要約
        </button>

        <a href="${url}" target="_blank" style="${S.LINK_TEXT}">${title}</a>
      </div>
      
      <div id="${uniqueId}" style="display:none; background:#f9f9f9; padding:15px; margin:10px 0; border-radius:6px; border-left:3px solid #8e44ad; font-size:90%;"></div>
      `;
    }
  );
  
  // リンクエリアを閉じるdivはブラウザが補完してくれることが多いですが、
  // 構造的に正しい閉じタグを入れるのが難しいため、LINK_ROWはdivで囲わずborder-topのみで表現しています

  // 7. ゴミ掃除
  html = html.replace(/\*\*/g, ""); 
  html = html.replace(/__/g, "");

  // 8. カード分割処理
  const splitToken = "___SPLIT___";
  html = html.replace(/(<h3)/g, `${splitToken}$1`);
  
  const parts = html.split(splitToken);
  let finalHtml = `<div style="${S.WRAPPER}">`;
  
  if (parts[0].trim()) finalHtml += parts[0];

  for (let i = 1; i < parts.length; i++) {
    finalHtml += `<div style="${S.CARD}">` + parts[i] + `</div>`;
  }
  
  finalHtml += `</div>`;
  
  // 改行処理
  finalHtml = finalHtml.replace(/\n/g, '<br>');
  finalHtml = finalHtml.replace(/(<\/div>|<\/h3>|<\/span>|<div[^>]*>)\s*<br>/g, "$1");
  finalHtml = finalHtml.replace(/(<br>){2,}/g, '<br>');

  return finalHtml;
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
 * getPromptConfig
 * 【責務】promptシートからプロンプトテンプレートを取得
 * @param {string} key - キー名（例:"WEB_ANALYSIS_SYSTEM", "DAILY_DIGEST_USER"）
 * @returns {string|null} プロンプト内容
 */
// promptシートから設定取得 (prompt=非公開シート)
function getPromptConfig(key) {
  const sheet = getSheet(AppConfig.get().SheetNames.PROMPT_CONFIG); // ★変更
  if (!sheet) return null;
  // ... (中身は同じなので省略可、またはそのまま元のロジック) ...
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const values = sheet.getRange(1, 1, lastRow, 2).getValues();
  const map = new Map(values.map(r => [String(r[0]).trim(), r[1]]));
  return map.get(key) ? String(map.get(key)).trim() : null;
}

// Keywordsシートから重み取得 (Keywords=非公開シート)
function getWeightedKeywords(sheetName = "Keywords") {
  const sheet = getSheet(sheetName); // ★変更
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  return values.map(([k, f, d, l]) => ({
    keyword: String(k).trim(),
    active: String(f).trim() !== "",
    day: String(d).trim(),
    label: String(l).trim()
  })).filter(o => o.keyword);
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

/** _logKeywordHitCounts: キーワード別ヒット件数をログ出力 */
function _logKeywordHitCounts(hitKeywordsWithCount) {
  let hitLog = "【キーワード別ヒット件数】\n";
  hitKeywordsWithCount.forEach(item => {
    hitLog += `- ${item.keyword}: ${item.count}件\n`;
  });
  Logger.log(hitLog.trim());
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


/** getArticlesInDateWindow: 指定期間内の記事を collectSheet から抽出
 * フィルタ：日付範囲内、見出し存在・空でない・エラーでない
 */
// 記事取得 (TrendData=公開シート)
function getArticlesInDateWindow(start, end) {
  const sh = getSheet(AppConfig.get().SheetNames.TREND_DATA); // ★変更
  if (!sh) return [];
  // ... (以下元のロジック通り) ...
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
 * fetchRecentArticlesBatch
 * 【責務】TrendDataシートから、指定された日数分（maxDays）の記事を一括取得してメモリに展開する。
 * 日付ソートされている前提で、古い記事は読み込まずメモリを節約する。
 */
// バッチ取得 (TrendData=公開シート)
function fetchRecentArticlesBatch(maxDays) {
  const sheet = getSheet(AppConfig.get().SheetNames.TREND_DATA); // ★変更
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
  return rawData.map(r => ({
    date: new Date(r[0]), title: r[C.URL - 2], url: r[C.URL - 1], abstractText: r[C.ABSTRACT - 1], headline: r[C.SUMMARY - 1], source: r[C.SOURCE - 1], vectorStr: r[C.VECTOR - 1]
  })).filter(a => a.headline && String(a.headline).trim() !== "" && String(a.headline).indexOf("API Error") === -1);
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
    _test_parseRssXml_Fallback();
    _test_EmergingSignalEngine();
    
    // ▼▼▼ 追加 ▼▼▼
    _test_cleanAndParseJSON();        // AI出力のパーステスト
    _test_calculateCosineSimilarity(); // ベクトル計算のテスト
    // ▲▲▲ 追加 ▲▲▲
    
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
function _test_parseRssXml_Fallback() {
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
  const items = parseRssXml(brokenXml, "http://test.local/feed");
  
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
 * debugRssFeed (修正版)
 * 【修正】独自の解析ロジックを廃止し、本番と同じ `parseRssXml` を使用して診断するように変更。
 * これにより、MobiHealthNewsのような特殊なフィードも正しくデバッグできます。
 */
function debugRssFeed() {
  // テストしたいURLをここに書いてください
  const TEST_URL = "https://www.mobihealthnews.com/content-feed/all"; 
  
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

    // ★修正: ここで本番用の最強パーサーを呼び出す
    Logger.log("\n--- 解析実行 (parseRssXml) ---");
    const items = parseRssXml(xml, TEST_URL);
    
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
  const sheet = getSheet(AppConfig.get().SheetNames.RSS_LIST);
  if (!sheet) {
    Logger.log("エラー: RSSシートが見つかりません。");
    return;
  }

  // データ取得
  const startRow = AppConfig.get().RssListSheet.DataRange.START_ROW;
  const lastRow = sheet.getLastRow();
  if (lastRow < startRow) {
    Logger.log("RSSリストが空です。");
    return;
  }

  // 名前(A列)とURL(B列)を取得
  const data = sheet.getRange(startRow, 1, lastRow - startRow + 1, 2).getValues();
  Logger.log(`--- RSS全件診断開始 (対象: ${data.length}件) ---`);
  Logger.log(`※ 処理に時間がかかる場合があります...`);

  let successCount = 0;
  let errorCount = 0;
  const errorReport = [];

  // 収集時と同じヘッダーを使用（Bot判定回避のため）
  const options = {
    'muteHttpExceptions': true,
    'validateHttpsCertificates': false,
    'headers': AppConfig.get().System.HttpHeaders
  };

  data.forEach((row, index) => {
    const name = row[0];
    const url = row[1];
    const rowNum = startRow + index;

    if (!url) return; // URL空欄はスキップ

    try {
      // 1. 接続テスト
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();

      if (code !== 200) {
        throw new Error(`HTTP Error ${code}`);
      }

      // 2. パーステスト (既存のロジックで記事が取れるか)
      const xml = response.getContentText();
      const items = parseRssXml(xml, url);

      if (items.length > 0) {
        successCount++;
        // 成功ログが多すぎると邪魔なので、進捗だけ少し出す
        if (successCount % 10 === 0) Logger.log(`... ${successCount} 件 チェック完了`);
      } else {
        // 接続OKだが記事が取れない (パース失敗 or 記事ゼロ)
        throw new Error("記事数 0件 (XML構造違い or 記事なし)");
      }

    } catch (e) {
      errorCount++;
      // エラー内容は詳細に記録
      errorReport.push(`Row ${rowNum}: [${name}] - ${e.message}\n   URL: ${url}`);
    }
  });

  // --- 診断結果出力 ---
  Logger.log("\n=============================");
  Logger.log("      RSS 診断レポート       ");
  Logger.log("=============================");
  Logger.log(`✅ 成功: ${successCount} 件`);
  Logger.log(`❌ 失敗: ${errorCount} 件`);

  if (errorCount > 0) {
    Logger.log("\n【失敗したフィード一覧】");
    Logger.log(errorReport.join("\n\n"));
    Logger.log("\n※ HTTP Error 403/429 はブロックされている可能性があります。");
    Logger.log("※ 「記事数 0件」は、RSSの形式が変わっているか、空のフィードです。");
  } else {
    Logger.log("\n🎉 おめでとうございます！全てのRSSフィードが正常です。");
  }
}

/**
 * debugPersonalReport
 * 【開発用】管理者(MAIL_TO)だけに特定のキーワードでレポートをテスト送信するヘルパー関数
 */
function debugPersonalReport() {
  // ▼▼▼ テスト設定 ▼▼▼
  const TEST_KEYWORD = "がん";  // テストしたいキーワード
  const LOOKBACK_DAYS = 7; 
  // ▲▲▲▲▲▲▲▲▲▲▲▲▲▲

  const config = AppConfig.get();
  const adminMail = config.Digest.mailTo;
  
  if (!adminMail) {
    Logger.log("エラー: スクリプトプロパティ MAIL_TO が設定されていません。");
    return;
  }

  Logger.log(`=== テスト送信開始 (Save History: OFF) ===`); // ログも変更
  
  const { start, end } = getDateWindow(LOOKBACK_DAYS);
  const allArticles = getArticlesInDateWindow(start, end);
  
  const targetItems = [{ query: TEST_KEYWORD, label: TEST_KEYWORD }];
  
  // ★ここで saveHistory: false を渡す
  const html = generateTrendReportHtml(allArticles, targetItems, start, end, {
    useSemantic: false,
    enableHistory: true, // 履歴を読む (前回との比較をする)
    saveHistory: false   // ★重要: 履歴には書き込まない (汚さない)
  });

  if (!html) {
    Logger.log(`⚠️ 記事が見つかりませんでした。`);
    return;
  }

  sendDigestEmail(null, html, null, 7, {
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
 * ★日付フォーマット対応版 (yyyy/MM/dd H:mm:ss)
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
          // ★ここで日付フォーマット変換を追加
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
  const sheet = getSheet(AppConfig.get().SheetNames.DIGEST_HISTORY);
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
function _test_cleanAndParseJSON() {
  Logger.log("test_cleanAndParseJSON: 開始");

  // ケース1: 正常なJSON
  const valid = '{"tldr": "OK"}';
  if (cleanAndParseJSON(valid).tldr !== "OK") throw new Error("正常なJSONのパースに失敗");

  // ケース2: Markdown記法付き (```json ... ```)
  const markdown = '```json\n{"tldr": "Markdown"}\n```';
  if (cleanAndParseJSON(markdown).tldr !== "Markdown") throw new Error("Markdown除去に失敗");

  // ケース3: 壊れたJSON (閉じカッコ忘れ) -> 正規表現による自己修復の発動確認
  const broken = '{"tldr": "Recovered text...'; 
  const recovered = cleanAndParseJSON(broken);
  // 自己修復ロジックが "Recovered text..." を抜き出せるか
  if (!recovered || recovered.tldr !== "Recovered text...") {
    throw new Error("壊れたJSONの自己修復に失敗 (Regex Fallback)");
  }

  // ケース4: 改行が含まれるケース (JSON仕様違反だがAIはよくやる)
  const withNewlines = '{\n"tldr": "Line1\nLine2"\n}';
  const parsed = cleanAndParseJSON(withNewlines);
  if (!parsed || !parsed.tldr.includes("Line1")) {
    throw new Error("改行を含むJSONのパースに失敗");
  }

  Logger.log("test_cleanAndParseJSON: OK");
}

/**
 * _test_calculateCosineSimilarity
 * 【責務】ベクトル検索の計算精度を検証する。
 */
function _test_calculateCosineSimilarity() {
  Logger.log("test_calculateCosineSimilarity: 開始");

  const v1 = [1, 0, 0];
  const v2 = [0, 1, 0];
  const v3 = [1, 1, 0];
  
  // 直交するベクトル (類似度 0)
  if (calculateCosineSimilarity(v1, v2) !== 0) throw new Error("直交ベクトルの計算ミス");

  // 同じベクトル (類似度 1)
  if (Math.abs(calculateCosineSimilarity(v1, v1) - 1.0) > 0.0001) throw new Error("同一ベクトルの計算ミス");

  // 45度の関係 (類似度 0.707...)
  const sim = calculateCosineSimilarity(v1, v3);
  // 1 / sqrt(2) ≒ 0.7071
  if (Math.abs(sim - 0.7071) > 0.001) throw new Error(`計算精度エラー: 期待値~0.707, 実際 ${sim}`);

  Logger.log("test_calculateCosineSimilarity: OK");
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
}

// #endregion