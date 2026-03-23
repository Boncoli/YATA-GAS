require("./gas-bridge.js");
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

/**
 * YATA Loader for Raspberry Pi (Perfect Match & Cached Edition)
 */

const yataPath = path.join(__dirname, 'YATA.js');
try {
  let yataCode = fs.readFileSync(yataPath, 'utf8');

  // 🌟 [強力パッチ] 聖域内の関数を物理的にリネームして退避
  yataCode = yataCode.replace(/function stripHtml_\(/g, "function _original_stripHtml_(");
  yataCode = yataCode.replace(/function performSemanticSearch_\(/g, "function _original_performSemanticSearch_(");
  yataCode = yataCode.replace(/function getArticlesInDateWindow_\(/g, "function _original_getArticlesInDateWindow_(");
  yataCode = yataCode.replace(/function isLikelyEnglish_\(/g, "function _original_isLikelyEnglish_(");

  // パッチ済みのコードを実行
  vm.runInThisContext(yataCode, { filename: yataPath });

  // --- パッチの実体定義 ---

  // 1. stripHtml_ (改行維持版)
  global.stripHtml_ = function(html) {
    if (!html) return "";
    let text = String(html);
    const noiseTags = ["script", "style", "nav", "footer", "header", "aside", "iframe", "canvas", "svg", "form", "button", "noscript"];
    noiseTags.forEach(tag => {
      const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
      text = text.replace(regex, ' ');
    });
    text = text.replace(/<!--[\s\S]*?-->/g, ' ');
    // ブロック要素の終了タグを改行に変換
    text = text.replace(/<\/p>|<\/div>|<\/h\d>|<br\s*\/?>/gi, '\n');
    text = text.replace(/<[^>]*>?/gm, ' ');
    text = text.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    // 行末の空白を削除し、3つ以上の連続改行を2つに制限
    return text.split('\n').map(line => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  // 2. performSemanticSearch_ (キャッシュ & AIキーワード連動)
  global.performSemanticSearch_ = function(query, articles, limit) {
    const props = PropertiesService.getScriptProperties();
    const cacheKey = `VEC_CACHE_${query}`;
    let queryVector = null;

    // 🌟 [キャッシュ発動] 保存済みのベクトルがあればそれを使う
    const cachedVecStr = props.getProperty(cacheKey);
    if (cachedVecStr) {
      console.log(`🧠 [Loader] Using cached vector for query: "${query}"`);
      queryVector = JSON.parse(cachedVecStr);
    }

    // A. オリジナルの検索を実行
    // 元の関数内で API を叩かせないために、あらかじめベクトルを用意して渡す方法もありますが、
    // ここでは「オリジナルの呼び出し」をフックして、必要なら API 結果をキャッシュに保存します。
    // (※ 聖域の performSemanticSearch_ は内部で LlmService.generateVector を呼ぶ仕様)
    
    // LlmService.generateVector を一時的にフックしてキャッシュを効かせる
    const originalGenerateVector = LlmService.generateVector;
    LlmService.generateVector = function(text) {
      if (text === query && queryVector) return queryVector;
      const vec = originalGenerateVector.apply(this, arguments);
      if (text === query && vec) {
        props.setProperty(cacheKey, JSON.stringify(vec));
        console.log(`💾 [Loader] Cached new vector for: "${query}"`);
      }
      return vec;
    };

    let results = _original_performSemanticSearch_.apply(this, arguments);
    
    // オリジナルを戻す
    LlmService.generateVector = originalGenerateVector;
    
    // B. 保存済みの JSON キーワードによる救済
    const savedKeywordMatches = articles.filter(art => {
      if (results.some(r => r.url === art.url)) return false;
      try {
        const summaryJson = JSON.parse(art.headline || "{}");
        const kws = summaryJson.keywords || [];
        return kws.some(k => k.toLowerCase().includes(query.toLowerCase()));
      } catch(e) { return false; }
    });

    if (savedKeywordMatches.length > 0) {
      console.log(`✨ [Loader] Boosted ${savedKeywordMatches.length} articles for "${query}" using distilled keywords.`);
      results = results.concat(savedKeywordMatches);
    }
    
    return results;
  };

  // 3. getArticlesInDateWindow_
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
        articles.push({
          date: row[0],
          title: row[1],
          url: row[2],
          headline: row[4],
          abstractText: row[3],
          parsedVector: (row[6] && typeof row[6] === 'string') ? parseVector_(row[6]) : null
        });
      }
    }
    console.log(`✅ [Loader] Found ${articles.length} articles in window.`);
    return articles;
  };

  // 4. isLikelyEnglish_
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

  console.log("✅ [Loader] YATA.js loaded with Cached Strong Patch.");
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
    
    if (config.System && config.System.Thresholds) {
      config.System.Thresholds.SEMANTIC_SEARCH = 0.25;
    }
    
    if (typeof LlmService !== 'undefined' && LlmService.generateDailyDigest) {
      const originalGenerateDailyDigest = LlmService.generateDailyDigest;
      LlmService.generateDailyDigest = function(systemPrompt, userPrompt, options) {
        const intensivePrompt = getPromptConfig_("INTENSIVE_DAILY_SYSTEM");
        console.log("📝 [Loader] Daily Digest: Swapping to Intensive Daily Analysis Prompt.");
        return originalGenerateDailyDigest.apply(this, [intensivePrompt, userPrompt, options]);
      };
    }

    if (typeof LlmService !== 'undefined' && LlmService.generateTrendSections) {
      const originalGenerateTrendSections = LlmService.generateTrendSections;
      LlmService.generateTrendSections = function(articlesGroupedByKeyword, linksPerTrend, hitKeywords, previousSummary, options) {
        if (process.env.WEEKLY_REPORT_FLAT_MODE === "true") {
          return originalGenerateTrendSections.apply(this, [articlesGroupedByKeyword, linksPerTrend, hitKeywords, null, options]);
        }
        return originalGenerateTrendSections.apply(this, arguments);
      };
    }

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
