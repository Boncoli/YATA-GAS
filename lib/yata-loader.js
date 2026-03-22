require("./gas-bridge.js");
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

/**
 * YATA Loader for Raspberry Pi (Perfect Match Edition)
 */

const yataPath = path.join(__dirname, 'YATA.js');
try {
  let yataCode = fs.readFileSync(yataPath, 'utf8');

  // 🌟 [強力パッチ] 聖域内の関数を物理的にリネームして退避
  // 関数名の定義部分をリネームすることで、パッチ版(global.xxx)を最優先させます。
  yataCode = yataCode.replace(/function stripHtml_\(/g, "function _original_stripHtml_(");
  yataCode = yataCode.replace(/function performSemanticSearch_\(/g, "function _original_performSemanticSearch_(");
  yataCode = yataCode.replace(/function getArticlesInDateWindow_\(/g, "function _original_getArticlesInDateWindow_(");
  yataCode = yataCode.replace(/function isLikelyEnglish_\(/g, "function _original_isLikelyEnglish_(");

  // パッチ済みのコードを実行
  vm.runInThisContext(yataCode, { filename: yataPath });

  // --- パッチの実体定義 (globalに登録することで聖域内からの呼び出しを上書き) ---

  // 1. stripHtml_ (タグ除去の強化版)
  global.stripHtml_ = function(html) {
    if (!html) return "";
    let text = String(html);
    const noiseTags = ["script", "style", "nav", "footer", "header", "aside", "iframe", "canvas", "svg", "form", "button", "noscript"];
    noiseTags.forEach(tag => {
      const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
      text = text.replace(regex, ' ');
    });
    text = text.replace(/<!--[\s\S]*?-->/g, ' ');
    text = text.replace(/<[^>]*>?/gm, ' ');
    text = text.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return text.replace(/\s+/g, ' ').trim();
  };

  // 2. performSemanticSearch_ (ハイブリッド検索版)
  global.performSemanticSearch_ = function(query, articles, limit) {
    // まずオリジナル（聖域内）の検索を実行
    let results = _original_performSemanticSearch_.apply(this, arguments);
    if (results.length === 0) {
      console.log(`⚠️ [Loader] Semantic search returned 0 results for "${query}". Falling back to keyword search.`);
      if (typeof filterArticlesByKeywords_ === 'function') {
        results = filterArticlesByKeywords_(articles, [query]);
      }
    }
    return results;
  };

  // 3. getArticlesInDateWindow_ (全件スキャン版)
  global.getArticlesInDateWindow_ = function(start, end) {
    console.log(`🔍 [Loader] Filtering articles between ${start.toISOString()} and ${end.toISOString()}...`);
    const sh = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
    if (!sh) return [];
    const allData = sh.getDataRange().getValues();
    const articles = [];
    for (let i = 1; i < allData.length; i++) {
      const row = allData[i];
      const d = new Date(row[0]);
      if (isNaN(d.getTime())) continue;
      if (d >= start && d <= end) {
        articles.push({ date: row[0], title: row[1], url: row[2], headline: row[4], abstractText: row[3] });
      }
    }
    console.log(`✅ [Loader] Found ${articles.length} articles in window.`);
    return articles;
  };

  // 4. isLikelyEnglish_ (緩和された英語判定版)
  global.isLikelyEnglish_ = function(text) {
    if (!text) return false;
    const decoded = String(text).replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const jpChars = decoded.match(/[぀-ゟ゠-ヿ一-鿿]/g) || [];
    const jpRatio = jpChars.length / decoded.length;
    return /[a-zA-Z]/.test(decoded) && jpRatio < 0.1;
  };

  // 🌟 Google News URL の真・デコード関数
  global.decodeGoogleNewsUrl_ = function(url) {
    if (!url.includes("news.google.com/")) return url;
    try {
      const encodedPart = url.split("articles/")[1] || url.split("?")[0];
      const b64 = encodedPart.split("?")[0].replace(/-/g, '+').replace(/_/g, '/');
      const buffer = Buffer.from(b64, 'base64');
      const decoded = buffer.toString('binary');
      const matches = decoded.match(/https?:\/\/[a-zA-Z0-9.\/?=&_%:+\-~]+/g);
      if (matches) return matches.find(m => !m.includes("google.com") && m.length > 25) || matches[0];
    } catch (e) {}
    return url;
  };

  // 🌟 getWebPageSummary のオーバーライド
  global.getWebPageSummary = function(url, articleTitle = "") {
    try {
      let targetUrl = global.decodeGoogleNewsUrl_(url);
      const venvPython = "/home/boncoli/yata-local/local_llm/.venv/bin/python3";
      const pythonCmd = `${venvPython} -c "import trafilatura; download = trafilatura.fetch_url('${targetUrl}'); print(trafilatura.extract(download, include_comments=False, include_tables=False) or '')"`;
      let bodyText = "";
      try { bodyText = execSync(pythonCmd, { encoding: 'utf-8', timeout: 30000 }).trim(); } catch (e) {}
      const minChars = AppConfig.get().System.Limits.WEB_SUMMARY_MIN_CHARS || 50;
      if (!bodyText || bodyText.length < minChars) {
        const db = global.YATA_DB;
        const row = db.prepare("SELECT title, abstract FROM collect WHERE url = ? OR id = ?").get(url, url);
        if (row && row.abstract) bodyText = `[RSS Content Fallback]\nTitle: ${row.title}\nSummary: ${row.abstract}`;
      }
      if (!bodyText || bodyText.length < minChars) return "エラー: ページ解析失敗";
      const systemPrompt = getPromptConfig_("WEBPAGE_SUMMARY_SYSTEM");
      return LlmService.summarizeReport(systemPrompt, bodyText.substring(0, 30000));
    } catch (e) { return `エラー: ${e.message}`; }
  };

  console.log("✅ [Loader] YATA.js loaded with Strong Patch System (Synced with _ names).");
} catch (e) {
  console.error("❌ [Loader] Failed to load YATA.js:", e);
  process.exit(1);
}

// 2. 設定のオーバーライド
if (typeof AppConfig !== 'undefined') {
  try {
    const config = AppConfig.get();
    config.System.TimeLimit.SUMMARIZATION = 600 * 1000;
    config.System.TimeLimit.REPORT_GENERATION = 600 * 1000;
    config.System.Limits.DATA_RETENTION_MONTHS = 12; 
    
    // 🌟 セマンティック検索の閾値を緩和 (256次元圧縮に最適化)
    if (config.System && config.System.Thresholds) {
      config.System.Thresholds.SEMANTIC_SEARCH = 0.25;
      console.log(`📡 [Loader] Semantic Search Threshold set to: ${config.System.Thresholds.SEMANTIC_SEARCH}`);
    }
    
    // 🌟 日刊モード (Daily Digest) のプロンプトを R&D分析官仕様に強化
    if (typeof LlmService !== 'undefined' && LlmService.generateDailyDigest) {
      const originalGenerateDailyDigest = LlmService.generateDailyDigest;
      LlmService.generateDailyDigest = function(systemPrompt, userPrompt, options) {
        const intensivePrompt = getPromptConfig_("INTENSIVE_DAILY_SYSTEM");
        console.log("📝 [Loader] Daily Digest: Swapping to Intensive Daily Analysis Prompt.");
        return originalGenerateDailyDigest.apply(this, [intensivePrompt, userPrompt, options]);
      };
    }

    // 🌟 週報生成のカスタマイズ (Flat Mode 対応)
    if (typeof LlmService !== 'undefined' && LlmService.generateTrendSections) {
      const originalGenerateTrendSections = LlmService.generateTrendSections;
      LlmService.generateTrendSections = function(articlesGroupedByKeyword, linksPerTrend, hitKeywords, previousSummary, options) {
        if (process.env.WEEKLY_REPORT_FLAT_MODE === "true") {
          console.log("📝 [Loader] Weekly Report: Flat Mode enabled.");
          return originalGenerateTrendSections.apply(this, [articlesGroupedByKeyword, linksPerTrend, hitKeywords, null, options]);
        }
        return originalGenerateTrendSections.apply(this, arguments);
      };
    }

    // 🌟 バッチ要約
    if (typeof LlmService !== 'undefined' && LlmService.summarizeBatch) {
      const originalSummarizeBatch = LlmService.summarizeBatch;
      LlmService.summarizeBatch = function(articleTexts) {
        const BATCH_SIZE = 5;
        const results = new Array(articleTexts.length).fill(null);
        const BATCH_SYSTEM = getPromptConfig_("BATCH_SYSTEM");
        const BATCH_USER_TEMPLATE = getPromptConfig_("BATCH_USER_TEMPLATE");
        for (let i = 0; i < articleTexts.length; i += BATCH_SIZE) {
          const chunk = articleTexts.slice(i, i + BATCH_SIZE);
          const packedArticles = chunk.map((text, idx) => ({ id: String(idx), content: text }));
          const userPrompt = BATCH_USER_TEMPLATE.replace("{articleText}", JSON.stringify(packedArticles, null, 2));
          try {
            const model = process.env.OPENAI_MODEL_NANO || "gpt-5.4-nano";
            const response = LlmService.analyzeKeywordSearch(BATCH_SYSTEM, userPrompt, { model: model, taskLabel: "BatchDistillation", max_completion_tokens: 2000 });
            const parsed = JSON.parse(response.replace(/```json/g, "").replace(/```/g, "").trim());
            if (parsed && parsed.results) {
              parsed.results.forEach(res => {
                const idx = parseInt(res.id, 10);
                if (!isNaN(idx) && idx < chunk.length) results[i + idx] = JSON.stringify(res);
              });
            }
          } catch (e) {
            for (let j = 0; j < chunk.length; j++) results[i + j] = originalSummarizeBatch([chunk[j]])[0];
          }
        }
        return results;
      };
    }
  } catch (e) {}
}

module.exports = {};
