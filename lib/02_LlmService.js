/**
 * @file YATA-LlmService.js
 * @description 【責務】LLM（AI）との通信、プロンプトの組み立て、および API コストの最適化。
 * 【主要機能】総合構造化窓口（executeStructuredQuery）、ベクトル生成、トークン計測、各モデルへの配送。
 */

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
  let _isMonthResetChecked = false;

  // 使用回数をメモリに安全に記録する内部ヘルパー
  function _recordUsage(serviceName) {
    if (!serviceName) return;
    _executionStats[serviceName] = (_executionStats[serviceName] || 0) + 1;
  }

  // nano/mini の既定パラメータを options にマージする
  function _mergeDefaultLlmOptions(targetModelType, options = {}) {
    const params = AppConfig.get().Llm.Params;
    const isNano = (targetModelType === "nano");

    const defaultMax =
      (isNano ? params.MaxCompletionTokens?.NANO : params.MaxCompletionTokens?.MINI)
      ?? params.MaxTokens;

    const defaults = {
      temperature: options.temperature ?? (isNano ? params.Temperature.STRICT : params.Temperature.WRITING),
      reasoning_effort: options.reasoning_effort ?? (isNano ? params.ReasoningEffort?.NANO : params.ReasoningEffort?.MINI),
      verbosity: options.verbosity ?? (isNano ? params.Verbosity?.NANO : params.Verbosity?.MINI),
      max_completion_tokens: options.max_completion_tokens ?? defaultMax,
      max_tokens: options.max_tokens ?? defaultMax,
      max_completion_tokens_openai: options.max_completion_tokens_openai ?? defaultMax
    };

    return { ...defaults, ...options };
  }

  // Azure用のURL自動組み立て
  function _buildAzureUrl(deploymentName) {
    let base = llmConfig.AzureBaseUrl;
    if (!base) return null;
    if (base.endsWith("/")) base = base.slice(0, -1);
    return `${base}/openai/deployments/${deploymentName}/chat/completions?api-version=${llmConfig.AzureApiVersion}`;
  }

  // コスト計算＆ログ記録
  function _trackCost(inputOrUsage, outputStrOrService, serviceNameArg) {
    try {
      const props = PropertiesService.getScriptProperties();
      const currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");

      if (!_isMonthResetChecked) {
        let systemState = {};
        try { systemState = JSON.parse(props.getProperty("YATA_SYSTEM_STATE") || "{}"); } catch(e) {}
        const lastReset = systemState.SYSTEM_COST_LAST_RESET;

        if (lastReset !== currentMonth) {
          systemState.SYSTEM_COST_ACCUMULATOR = "0";
          systemState.SYSTEM_COST_LAST_RESET = currentMonth;
          props.setProperty("YATA_SYSTEM_STATE", JSON.stringify(systemState));
        }
        _isMonthResetChecked = true;
      }

      const rates = AppConfig.get().System.Budget.RatesPer1M;
      let rateInput = 0, rateOutput = 0;
      let inputTokens = 0, outputTokens = 0, reasoningTokens = 0, serviceName = "";

      if (typeof inputOrUsage === 'object' && inputOrUsage !== null) {
        inputTokens = inputOrUsage.prompt_tokens ?? inputOrUsage.input_tokens ?? 0;
        outputTokens = inputOrUsage.completion_tokens ?? inputOrUsage.output_tokens ?? 0;
        reasoningTokens = inputOrUsage.completion_tokens_details?.reasoning_tokens ?? inputOrUsage.output_tokens_details?.reasoning_tokens ?? 0;
        serviceName = outputStrOrService;
      } else {
        inputTokens = String(inputOrUsage || "").length;
        outputTokens = String(outputStrOrService || "").length;
        serviceName = serviceNameArg || "Unknown";
      }

      const sName = String(serviceName).toLowerCase();
      if (sName.includes("embedding")) { rateInput = rates.EMBEDDING.in; rateOutput = rates.EMBEDDING.out; }
      else if (sName.includes("gemini")) { rateInput = rates.GEMINI.in; rateOutput = rates.GEMINI.out; }
      else if (sName.includes("nano")) { rateInput = rates.NANO.in; rateOutput = rates.NANO.out; }
      else { rateInput = rates.MINI.in; rateOutput = rates.MINI.out; }

      const cost = ((inputTokens / 1000000) * rateInput) + ((outputTokens / 1000000) * rateOutput);
      _sessionCostTotal += cost;

      serviceName = serviceNameArg || (typeof outputStrOrService === "string" ? outputStrOrService : "Unknown");
      _recordUsage(serviceName);

      if (typeof recordDetailedApiUsage_ === 'function') {
        recordDetailedApiUsage_(serviceName, inputTokens, outputTokens, reasoningTokens, cost);
      }
    } catch (e) { Logger.log(`[CostTracker Error] ${e.toString()}`); }
  }

  // 通信共通ラッパー
  function _httpFetch(url, options, serviceName) {
    try {
      const res = UrlFetchApp.fetch(url, options);
      const code = res.getResponseCode();
      const content = res.getContentText();
      if (code !== 200) {
        Logger.log(`⚠️ [API Error] ${serviceName} failed. Status: ${code}, Response: ${content}`);
        return null;
      }
      return JSON.parse(content);
    } catch (e) {
      Logger.log(`❌ [Network Exception] ${serviceName}: ${e.toString()}`);
      return null;
    }
  }

  // --- 各LLMプロバイダの個別通信処理 ---
  function _callAzureLlm(systemPrompt, userPrompt, deploymentName, azureKey, options = {}) {
    const taskName = options.taskLabel ? ` / Task: ${options.taskLabel}` : "";
    Logger.log(`📡 [LLM Start] Service: Azure / Model: ${deploymentName}${taskName}`);
    _recordUsage(`Azure(${deploymentName})`);
    
    const url = _buildAzureUrl(deploymentName);
    if (!url) return null;

    const payload = {
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      max_completion_tokens: options.max_completion_tokens
    };
    if (/json/i.test(systemPrompt) || /json/i.test(userPrompt)) payload.response_format = { type: "json_object" };
    if (options.temperature === 1) payload.temperature = 1;
    if (options.reasoning_effort) payload.reasoning_effort = options.reasoning_effort;
    if (options.verbosity) payload.verbosity = options.verbosity;

    try {
      const response = UrlFetchApp.fetch(url, { method: "post", contentType: "application/json", headers: { "api-key": azureKey, "Accept-Encoding": "gzip" }, payload: JSON.stringify(payload), muteHttpExceptions: true });
      const code = response.getResponseCode();
      const text = response.getContentText();

      if (code !== 200) {
        Logger.log(`⚠️ [Azure HTTP Error] Code: ${code}, Response: ${text.substring(0, 500)}`);
        return null;
      }
      const json = JSON.parse(text);
      if (!json || json.error) return null;

      if (json.choices && json.choices.length > 0) {
        const choice = json.choices[0];
        if (choice.finish_reason === 'content_filter') return null;
        if (choice.message && choice.message.content) {
          const content = String(choice.message.content).trim();
          if (json.usage) _trackCost(json.usage, `Azure:${deploymentName}`);
          else _trackCost(systemPrompt + userPrompt, content, `Azure:${deploymentName}`);
          return content;
        }
      }
    } catch (e) { Logger.log(`❌ [Network Error] Azure通信失敗: ${e.toString()}`); }
    return null;
  }

  function _callOpenAiResponses(systemPrompt, userPrompt, model, apiKey, options = {}) {
    const payload = {
      model: model,
      instructions: systemPrompt,
      input: [{ role: "user", content: userPrompt }],
      max_output_tokens: options.max_output_tokens || options.max_completion_tokens || 8000,
      reasoning: { effort: options.reasoning_effort || "low" }
    };
    try {
      const res = UrlFetchApp.fetch("https://api.openai.com/v1/responses", { method: "post", contentType: "application/json", headers: { "Authorization": `Bearer ${apiKey}` }, payload: JSON.stringify(payload), muteHttpExceptions: true });
      const code = res.getResponseCode();
      const jsonStr = res.getContentText();
      if (code === 429) { Utilities.sleep(1000); return null; }
      const json = JSON.parse(jsonStr);
      if (code !== 200 || json.error) return null;

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
      if (text && json.usage) _trackCost(json.usage, `OpenAI:${model}`);
      return text ? String(text).trim() : null;
    } catch(e) { return null; }
  }

  function _callOpenAiLlm(systemPrompt, userPrompt, openAiModel, openAiKey, options = {}) {
    const taskName = options.taskLabel ? ` / Task: ${options.taskLabel}` : "";
    Logger.log(`📡 [LLM Start] Service: OpenAI / Model: ${openAiModel}${taskName}`);
    _recordUsage(`OpenAI(${openAiModel})`);

    const modelLower = String(openAiModel || "").toLowerCase();
    const isReasoningFamily = /^(gpt-5|o1|o3|o4)/.test(modelLower);
    const payload = { model: openAiModel, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] };

    if (/json/i.test(systemPrompt) || /json/i.test(userPrompt)) payload.response_format = { type: "json_object" };
    if (isReasoningFamily) payload.max_completion_tokens = options.max_completion_tokens_openai;
    else { payload.max_tokens = options.max_tokens; payload.temperature = options.temperature; }
    if (isReasoningFamily) {
      if (options.reasoning_effort) payload.reasoning_effort = options.reasoning_effort;
      if (options.verbosity) payload.verbosity = options.verbosity;
    }

    const json = _httpFetch("https://api.openai.com/v1/chat/completions", { method: "post", contentType: "application/json", headers: { "Authorization": `Bearer ${openAiKey}`, "Accept-Encoding": "gzip" }, payload: JSON.stringify(payload), muteHttpExceptions: true }, "OpenAI");
    if (json && json.choices && json.choices[0] && json.choices[0].message) {
      const content = String(json.choices[0].message.content).trim();
      _trackCost(json.usage, `OpenAI:${openAiModel}`);
      return content;
    }
    return null;
  }

  function _callGeminiLlm(systemPrompt, userPrompt, geminiApiKey, options = {}, modelOverride = null) {
    const targetModel = modelOverride || llmConfig.MODEL_NAME;
    const taskName = options.taskLabel ? ` / Task: ${options.taskLabel}` : "";
    Logger.log(`📡 [LLM Start] Service: Gemini / Model: ${targetModel}${taskName}`);
    _recordUsage("Gemini");
    
    const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${geminiApiKey}`;
    const PROMPT = (systemPrompt || "") + "\n\n" + (userPrompt || "");
    const payload = { contents: [{ parts: [{ text: PROMPT }] }], generationConfig: { temperature: options.temperature, maxOutputTokens: AppConfig.get().Llm.Params.MaxTokens } };

    if (/json/i.test(systemPrompt) || /json/i.test(userPrompt)) payload.generationConfig.responseMimeType = "application/json";

    const json = _httpFetch(API_ENDPOINT, { method: "post", contentType: "application/json", headers: { "Accept-Encoding": "gzip" }, payload: JSON.stringify(payload), muteHttpExceptions: true }, "Gemini");
    let text = null;
    if (json && json.candidates && json.candidates[0].content) text = json.candidates[0].content.parts[0].text;
    if (text) _trackCost(PROMPT, text, "Gemini");
    Utilities.sleep(llmConfig.DELAY_MS);
    return text ? String(text).trim() : AppConfig.get().Messages.NO_SUMMARY;
  }

  function _callLlmWithFallback(systemPrompt, userPrompt, targetModelType = "nano", options = {}) {
    const llmProps = llmConfig;
    const mergedOptions = _mergeDefaultLlmOptions(targetModelType, options);
    const openAiModel = (targetModelType === "mini") ? llmProps.ModelMini : llmProps.ModelNano;
    const geminiModel = (targetModelType === "mini") ? llmProps.GeminiMini : llmProps.GeminiNano;

    const callProviders = {
      "AZURE": () => (llmProps.AzureBaseUrl && llmProps.AzureKey) ? _callAzureLlm(systemPrompt, userPrompt, openAiModel, llmProps.AzureKey, mergedOptions) : null,
      "OPENAI": () => {
        if (!llmProps.OpenAiKey) return null;
        return /^(gpt-5|o1|o3|o4)/.test(String(openAiModel).toLowerCase())
          ? _callOpenAiResponses(systemPrompt, userPrompt, openAiModel, llmProps.OpenAiKey, mergedOptions)
          : _callOpenAiLlm(systemPrompt, userPrompt, openAiModel, llmProps.OpenAiKey, mergedOptions);
      },
      "GEMINI": () => llmProps.GeminiKey ? _callGeminiLlm(systemPrompt, userPrompt, llmProps.GeminiKey, mergedOptions, geminiModel) : null
    };

    for (const provider of llmProps.PriorityOrder) {
      const callFn = callProviders[String(provider).toUpperCase().trim()];
      if (callFn) {
        const result = callFn();
        if (result && !result.includes("いずれのLLMでも生成できませんでした") && !result.includes("見出しが生成できませんでした")) {
          return result;
        }
      }
    }
    return "いずれのLLMでも生成できませんでした。";
  }

  function _callOpenAiEmbedding(textOrArray, model, apiKey) {
    if (!apiKey) return null;
    _recordUsage("OpenAI(Embedding)");
    const dimensions = AppConfig.get().Llm.Embedding.Dimensions || 256;
    const payload = { model: model, input: textOrArray, dimensions: dimensions };
    const json = _httpFetch("https://api.openai.com/v1/embeddings", { method: "post", contentType: "application/json", headers: { "Authorization": `Bearer ${apiKey}`, "Accept-Encoding": "gzip" }, payload: JSON.stringify(payload), muteHttpExceptions: true }, "OpenAI Embedding");
    if (!json || !json.data) return null;
    return Array.isArray(textOrArray) ? json.data.sort((a,b) => a.index - b.index).map(item => item.embedding) : json.data[0].embedding;
  }

  function _callAzureEmbedding(textOrArray, endpoint, apiKey) {
    if (!endpoint || !apiKey) return null;
    _recordUsage("Azure(Embedding)");
    const dimensions = AppConfig.get().Llm.Embedding.Dimensions || 256;
    const payload = { input: textOrArray, dimensions: dimensions };
    const json = _httpFetch(endpoint, { method: "post", contentType: "application/json", headers: { "api-key": apiKey, "Accept-Encoding": "gzip" }, payload: JSON.stringify(payload), muteHttpExceptions: true }, "Azure Embedding");
    if (!json || !json.data) return null;
    return Array.isArray(textOrArray) ? json.data.sort((a,b) => a.index - b.index).map(item => item.embedding) : json.data[0].embedding;
  }

  /**
   * saveSessionCost
   * 【責務】今回の実行セッションで蓄積されたAIコストを YATA_SYSTEM_STATE に安全に加算・永続化する。
   */
  function saveSessionCost() {
    try {
      if (_sessionCostTotal === 0) return;
      const props = PropertiesService.getScriptProperties();
      let systemState = {};
      try { systemState = JSON.parse(props.getProperty("YATA_SYSTEM_STATE") || "{}"); } catch(e) {}
      
      const currentTotal = parseFloat(systemState.SYSTEM_COST_ACCUMULATOR || "0");
      systemState.SYSTEM_COST_ACCUMULATOR = String(currentTotal + _sessionCostTotal);
      
      props.setProperty("YATA_SYSTEM_STATE", JSON.stringify(systemState));
      _sessionCostTotal = 0; // 重複加算を防ぐため、保存完了後はセッションコストをゼロリセット
      Logger.log("💰 [LlmService] セッションの累積コストを永続化ステートへ保存しました。");
    } catch (e) {
      Logger.log(`❌ [saveSessionCost Error] ${e.toString()}`);
    }
  }

  // --- 公開メソッド（Public Methods） ---
  return {
    getModelInfo: function() {
      return { context: llmConfig.Context, nano: llmConfig.ModelNano, mini: llmConfig.ModelMini };
    },

    /**
     * 🌟 [v2.0 核心修正版] executeStructuredQuery（AI構造化通信の総合窓口）
     * ニュース要約、PubMed論文解析など、すべての構造化AI要求をここで安全に一元処理する
     * @param {string[]} articleTexts - 解析対象となる記事テキスト（Markdownや生テキスト）の配列
     * @param {"NEWS"|"PUBMED"} purposeFlag - 通信の目的識別子
     * @param {YataLlmOptions} [options] - パラメータ制御用オプション
     * @returns {string[]} 解析結果（JSON文字列またはエラー文字列）の配列
     */
    executeStructuredQuery: function(articleTexts, purposeFlag, options = {}) {
      if (!articleTexts || articleTexts.length === 0) return [];
      
      const BATCH_SIZE = 5;
      const results = new Array(articleTexts.length).fill(null);
      
      // 1. 【フラグ分岐】目的フラグに基づいてベースのプロンプトを決定
      let promptKey = options.promptKey;
      if (!promptKey) {
        // 💡【夜間バッチデータ欠損ガード】手動UI画面(options.isUiSearch)の時だけPUBMED_UI_SYSTEMを使い、
        // 毎晩の自動要約ジョブの時は、論文であっても5W1Hデータを維持するために BATCH_SYSTEM を強制適用する
        promptKey = (purposeFlag === "PUBMED" && options.isUiSearch) ? "PUBMED_UI_SYSTEM" : "BATCH_SYSTEM";
      }
      let systemPrompt = getPromptConfig_(promptKey);
      
      // 2. 💡【プロンプトクレンジング】NEWSの時だけ日付ルールを合体（PubMed時の混線を完全遮断）
      if (purposeFlag === "NEWS") {
        const todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy年MM月dd日");
        systemPrompt += `\n\n【システム情報】本日の現在日付は ${todayStr} である。is_oldの「現在から見て1年以上前か」は、必ずこの日付を厳格な基準として数学的に判定せよ。`;
      }

      const BATCH_USER_TEMPLATE = getPromptConfig_("BATCH_USER_TEMPLATE");
      
      // モデル・ターゲット種別の決定 (UI検索のPUBMED時のみMiniモデル、自動バッチ時は速さ重視のNano)
      const modelOverride = options.modelOverride || ((purposeFlag === "PUBMED" && options.isUiSearch) ? AppConfig.get().Llm.ModelMini : null);
      const targetModelType = modelOverride ? (modelOverride.includes("mini") ? "mini" : "nano") : "nano";
      const model = modelOverride || (llmConfig.ModelNano ? llmConfig.ModelNano : "gpt-5-nano");
      
      // 3. 📦【5件分割バッチループ】心臓部の処理をここに完全集約
      for (let i = 0; i < articleTexts.length; i += BATCH_SIZE) {
        const chunk = articleTexts.slice(i, i + BATCH_SIZE);
        const packedArticles = chunk.map((text, idx) => ({ id: String(idx), text_to_analyze: text }));
        const userPrompt = BATCH_USER_TEMPLATE.replace("{articleText}", JSON.stringify(packedArticles, null, 2));
        
        try {
          Logger.log(`🤖 [LlmService v2.0] Sending ${purposeFlag} Structured Request (${chunk.length} articles) to ${model}...`);
          let parsedResults = null;
          let successAttempt = 0;

          // 3回論理リトライエンジン
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const maxTokens = targetModelType === "mini" 
                ? (AppConfig.get().Llm.Params.MaxCompletionTokens?.MINI || 8000) 
                : 4000;

              const response = _callLlmWithFallback(systemPrompt, userPrompt, targetModelType, { 
                taskLabel: `${purposeFlag}-Batch-A${attempt}`, 
                max_completion_tokens: maxTokens,
                reasoning_effort: (targetModelType === "mini" ? "medium" : "low")
              });
              
              if (!response) throw new Error("Empty response");

              const cleanResponse = response.replace(/```json/g, "").replace(/```/g, "").trim();
              const parsed = JSON.parse(cleanResponse);

              if (parsed && parsed.results && Array.isArray(parsed.results)) {
                if (parsed.results.length !== chunk.length) throw new Error(`Count mismatch: Expected ${chunk.length}, Got ${parsed.results.length}`);
                parsedResults = parsed.results;
              } else if (parsed && chunk.length === 1) {
                if (!parsed.id) parsed.id = "0";
                parsedResults = [parsed];
              } else {
                throw new Error("Invalid JSON structure");
              }

              successAttempt = attempt;
              break;
            } catch (retryError) {
              Logger.log(`⚠️ [LlmService v2.0] Attempt ${attempt} failed: ${retryError.message}`);
              if (attempt === 3) throw new Error("All retries failed: " + retryError.message);
            }
          }
          
          // 成果物の格納
          parsedResults.forEach(res => {
            const idx = parseInt(res.id, 10);
            if (!isNaN(idx) && idx >= 0 && idx < chunk.length) {
              results[i + idx] = JSON.stringify(res);
            }
          });

          // 💡【AIのID書き換えシールド】
          // 展開が終わったあと、この塊の中に1件でもnull（反映漏れ）があれば、AIがIDを捏造したとみなして強制的にエラーを投げ、フォールバックへ落とす
          for (let j = 0; j < chunk.length; j++) {
            if (results[i + j] === null) {
              throw new Error(`AI generated invalid index or ID mismatch at batch chunk ${j}`);
            }
          }

        } catch (e) {
          // 💡【無限ループ緊急ブレーキ】
          // すでに1件ずつの個別処理中（options.isFallbackが真）であれば、これ以上再帰をせずにエラー刻印でその場を安全に離脱する
          if (options.isFallback) {
            Logger.log(`❌ [LlmService v2.0 Emergency Brake] Single article analysis completely failed. Avoiding Infinite Loop.`);
            chunk.forEach((_, idx) => {
              if (!results[i + idx]) results[i + idx] = "ERROR: AI応答修復不能";
            });
            continue;
          }

          Logger.log(`🔄 [LlmService v2.0] ${purposeFlag} Batch failed (${e.message}). Falling back to individual...`);
          // 最終安全策：再帰呼び出しによる1件ずつの個別構造化処理 (isFallbackフラグを確実に手渡す)
          for (let j = 0; j < chunk.length; j++) {
            if (!results[i + j]) {
              Logger.log(`   - Fallback for article ${i + j + 1}/${articleTexts.length}`);
              const singleRes = LlmService.executeStructuredQuery([chunk[j]], purposeFlag, { ...options, isFallback: true });
              results[i + j] = singleRes[0];
            }
          }
        }
      }
      return results;
    },

    /**
     * @function summarizeBatch
     * @description [後方互換用ラッパー] 過去の呼び出しを新設された executeStructuredQuery 窓口へ安全に流す
     */
    summarizeBatch: function(articleTexts, promptKey = "BATCH_SYSTEM", modelOverride = null) {
      const purposeFlag = (promptKey === "PUBMED_UI_SYSTEM") ? "PUBMED" : "NEWS";
      return this.executeStructuredQuery(articleTexts, purposeFlag, { promptKey: promptKey, modelOverride: modelOverride });
    },

    /**
     * @function summarize
     * @description [後方互換用ラッパー] 単一要約も共通窓口の1件配列に綺麗に一本化
     */
    summarize: function(articleText, isRevenge = false) {
      const result = this.executeStructuredQuery([articleText], "NEWS");
      return result[0] || AppConfig.get().Messages.NO_SUMMARY;
    },

    /**
     * @function processSummarizationBatch
     * @description ETL処理の後段を担うコアロジック
     */
    processSummarizationBatch: function(targetArticles, isPaper, values, state, startTime, TIME_LIMIT_MS) {
      if (targetArticles.length === 0) return;
      
      const purposeFlag = isPaper ? "PUBMED" : "NEWS";
      const LIMIT = isPaper ? (AppConfig.get().PubMed?.Limits?.SUMMARY_MAX_CHARS || 2500) : (AppConfig.get().System.Limits.WEB_SUMMARY_MAX_CHARS || 500);
      const BATCH_SIZE = AppConfig.get().System.Limits.LLM_BATCH_SIZE;

      const SUMMARY_COL_INDEX = AppConfig.get().CollectSheet.Columns.SUMMARY - 1;
      const VECTOR_COL_INDEX = AppConfig.get().CollectSheet.Columns.VECTOR - 1;
      const METHOD_VECTOR_COL_INDEX = AppConfig.get().CollectSheet.Columns.METHOD_VECTOR - 1;

      const _mark = (idx) => {
        if (state.minMod === -1 || idx < state.minMod) state.minMod = idx;
        if (idx > state.maxMod) state.maxMod = idx;
      };

      for (let i = 0; i < targetArticles.length; i += BATCH_SIZE) {
        if (new Date().getTime() - startTime > TIME_LIMIT_MS) break;
        const chunk = targetArticles.slice(i, i + BATCH_SIZE);
        
        // 新窓口をコールして一括構造化
        const batchResults = LlmService.executeStructuredQuery(chunk.map(a => 
          `Title: ${a.title}\nContent: ${String(a.abstractText).substring(0, LIMIT)}`
        ), purposeFlag);
        
        const textsToEmbed = []; const methodsToEmbed = []; const successfulIndices = [];

        batchResults.forEach((jsonString, idx) => {
          const article = chunk[idx];
          const parsedJson = cleanAndParseJSON_(jsonString);
          if (parsedJson) {
            values[article.originalRowIndex][SUMMARY_COL_INDEX] = JSON.stringify(parsedJson);
            const C = AppConfig.get().CollectSheet.Columns;
            
            if (parsedJson.is_old === true || String(parsedJson.is_old).toLowerCase() === "true") {
              values[article.originalRowIndex][SUMMARY_COL_INDEX] = "SKIP: OLD_ARCHIVE";
              _mark(article.originalRowIndex); 
              return; 
            }

            values[article.originalRowIndex][C.TLDR - 1] = parsedJson.tldr || "";
            values[article.originalRowIndex][C.WHO - 1]  = parsedJson.who || "";
            values[article.originalRowIndex][C.WHAT - 1] = parsedJson.what || "";
            values[article.originalRowIndex][C.WHEN - 1] = parsedJson.when || "";
            values[article.originalRowIndex][C.WHERE - 1]= parsedJson.where || "";
            values[article.originalRowIndex][C.WHY - 1]  = parsedJson.why || "";
            values[article.originalRowIndex][C.HOW - 1]  = parsedJson.how || "";
            values[article.originalRowIndex][C.RESULT - 1]= parsedJson.result || "";
            values[article.originalRowIndex][C.KEYWORDS - 1] = Array.isArray(parsedJson.keywords) ? parsedJson.keywords.join(", ") : (parsedJson.keywords || "");
            
            const kw = (parsedJson.keywords && Array.isArray(parsedJson.keywords)) ? parsedJson.keywords.join(' ') : "";
            textsToEmbed.push(`Title: ${article.title || ""}\nKeywords: ${kw}`);
            methodsToEmbed.push(`What: ${parsedJson.what || "Unknown"} How: ${parsedJson.how || "Unknown"}`); 
            successfulIndices.push(article.originalRowIndex);
            _mark(article.originalRowIndex);
          } else {
            values[article.originalRowIndex][SUMMARY_COL_INDEX] = "ERROR: 解析失敗";
            _mark(article.originalRowIndex);
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
            if (METHOD_VECTOR_COL_INDEX >= 0 && mVResults[idx]) {
              values[rowIdx][METHOD_VECTOR_COL_INDEX] = mVResults[idx].join(',');
            }
          });
        }
        Utilities.sleep(1000);
      }
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
        const articleListForLlm = articles.map(a => {
          const context = getArticleContextForAnalysis_(a);
          return `- タイトル: ${a.title}\n  要点: ${context}\n  URL: ${a.url}`;
        }).join("\n\n");
        let userPrompt = USER_TEMPLATE;
        if (previousSummary) userPrompt = userPrompt.replace('{previous_summary}', previousSummary);
        userPrompt = userPrompt.includes('{article_list}') ? userPrompt.replace('{article_list}', articleListForLlm) : userPrompt + '\n' + articleListForLlm;
        
        const txt = _callLlmWithFallback(SYSTEM, userPrompt, options.model || "mini", { ...options, ...execOptions, taskLabel: options.taskLabel || "トレンド分析" });
        if (txt && txt.trim()) allTrends.push(txt.trim());
      }
      return allTrends.join("\n\n---\n\n");
    },

    summarizeReport: function(systemPrompt, reportText) { return _callLlmWithFallback(systemPrompt, reportText, "nano", { taskLabel: "長文/コンテキスト圧縮" }); },
    generateDailyDigest: function(systemPrompt, userPrompt) { return _callLlmWithFallback(systemPrompt, userPrompt, "mini", { taskLabel: "日刊ダイジェスト" }); },
    analyzeKeywordSearch: function(systemPrompt, contextText, options = {}) { return _callLlmWithFallback(systemPrompt, contextText, options.model || "mini", { ...options, taskLabel: options.taskLabel || "予兆検知/インサイト分析" }); },
    
    extractMethodDescriptor: function(title, abstractText) {
        const systemPrompt = getPromptConfig_("METHOD_EXTRACTION_SYSTEM");
        const descriptor = _callLlmWithFallback(systemPrompt, `Title: ${title}\nAbstract: ${abstractText}`, "nano", { temperature: 0.0, taskLabel: "Method抽出" });
        return (descriptor && String(descriptor).trim() !== "") ? String(descriptor).trim() : "Unknown";
    },

    // ベクトル生成（単体）
    generateVector: function(text) {
      const embConfig = llmConfig.Embedding;
      let vector = null;
      if (llmConfig.Context === 'PERSONAL') {
        if (llmConfig.OpenAiKey) vector = _callOpenAiEmbedding(text, embConfig.OpenAiModel, llmConfig.OpenAiKey);
        if (!vector && embConfig.AzureEndpoint && llmConfig.AzureKey) vector = _callAzureEmbedding(text, embConfig.AzureEndpoint, llmConfig.AzureKey);
      } else {
        if (embConfig.AzureEndpoint && llmConfig.AzureKey) vector = _callAzureEmbedding(text, embConfig.AzureEndpoint, llmConfig.AzureKey);
        if (!vector && llmConfig.OpenAiKey) vector = _callOpenAiEmbedding(text, embConfig.OpenAiModel, llmConfig.OpenAiKey);
      }
      return vector ? vector.map(v => parseFloat(v.toFixed(6))) : null;
    },

    // ベクトル生成（バッチ一括）
    generateVectorBatch: function(texts) {
      if (!Array.isArray(texts) || texts.length === 0) return [];
      const embConfig = llmConfig.Embedding;
      let vectors = null;
      
      if (llmConfig.Context === 'PERSONAL') {
        if (llmConfig.OpenAiKey) vectors = _callOpenAiEmbedding(texts, embConfig.OpenAiModel, llmConfig.OpenAiKey);
        if (!vectors && embConfig.AzureEndpoint && llmConfig.AzureKey) vectors = _callAzureEmbedding(texts, embConfig.AzureEndpoint, llmConfig.AzureKey);
      } else {
        if (embConfig.AzureEndpoint && llmConfig.AzureKey) vectors = _callAzureEmbedding(texts, embConfig.AzureEndpoint, llmConfig.AzureKey);
        if (!vectors && llmConfig.OpenAiKey) vectors = _callOpenAiEmbedding(texts, embConfig.OpenAiModel, llmConfig.OpenAiKey);
      }
      return (!vectors || !Array.isArray(vectors)) ? new Array(texts.length).fill(null) : vectors.map(vec => vec ? vec.map(v => parseFloat(v.toFixed(6))) : null);
    },

    getSessionCost: function() { return _sessionCostTotal; },
    saveSessionCost: saveSessionCost,
    logSessionTotal: function() {
      const statsParts = [];
      for (const [key, count] of Object.entries(_executionStats)) statsParts.push(`${key}: ${count}回`);
      const statsStr = statsParts.length > 0 ? `📊 [Usage] ${statsParts.join(", ")}` : "";
      
      const props = PropertiesService.getScriptProperties();
      let systemState = {};
      try { systemState = JSON.parse(props.getProperty("YATA_SYSTEM_STATE") || "{}"); } catch(e) {}
      
      const monthTotal = parseFloat(systemState.SYSTEM_COST_ACCUMULATOR || "0");
      const EXCHANGE_RATE = AppConfig.get().System.Budget.EXCHANGE_RATE; 
      const sessionYen = _sessionCostTotal * EXCHANGE_RATE;
      const monthYen = monthTotal * EXCHANGE_RATE;

      const finalLog = statsStr 
        ? `${statsStr}\n💰 [API Cost] 今回: $${_sessionCostTotal.toFixed(6)} (約 ${sessionYen.toFixed(2)} 円) / 今月: $${monthTotal.toFixed(4)} (約 ${Math.round(monthYen)} 円)`
        : `💰 [API Cost] 今回: $0.000000 (0円) / 今月: $${monthTotal.toFixed(4)} (約 ${Math.round(monthYen)} 円)`;
      
      Logger.log(finalLog);
    }
  };
})();