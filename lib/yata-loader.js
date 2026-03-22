require("./gas-bridge.js");
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

/**
 * YATA Loader for Raspberry Pi
 */

// 1. YATA.js の読み込みと展開
const yataPath = path.join(__dirname, 'YATA.js');
try {
  const yataCode = fs.readFileSync(yataPath, 'utf8');
  vm.runInThisContext(yataCode, { filename: yataPath });
  
  if (typeof global.isLikelyEnglish === 'function') {
    global.isLikelyEnglish_ = global.isLikelyEnglish;
  }

  // 🌟 [究極版] HTMLタグ除去
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

  // 🌟 Google News URL の真・デコード関数 (究極版：文字列スキャン方式)
  global.decodeGoogleNewsUrl_ = function(url) {
    if (!url.includes("news.google.com/")) return url;
    try {
      const encodedPart = url.split("articles/")[1] || url.split("?")[0];
      if (!encodedPart) return url;
      
      const b64 = encodedPart.split("?")[0].replace(/-/g, '+').replace(/_/g, '/');
      const buffer = Buffer.from(b64, 'base64');
      const decoded = buffer.toString('binary');
      
      // 究極の正規表現：バイナリの中から http で始まる有効そうな URL を探す
      const matches = decoded.match(/https?:\/\/[a-zA-Z0-9.\/?=&_%:+\-~]+/g);
      if (matches) {
        // 最も「ニュースサイトっぽい」ドメインを持つものを選択
        const realUrl = matches.find(m => !m.includes("google.com") && m.length > 25) || matches[0];
        console.log(`🔗 [Decoded URL] ${realUrl}`);
        return realUrl;
      }
    } catch (e) {
      console.warn(`⚠️ [Decode Failed] ${e.message}`);
    }
    return url;
  };

  // 🌟 getWebPageSummary のオーバーライド (Title-Fallback + Ultra Scraper)
  global.getWebPageSummary = function(url, articleTitle = "") {
    try {
      let targetUrl = global.decodeGoogleNewsUrl_(url);
      console.log(`🚀 [Insight] Processing: ${targetUrl}`);

      // 1. Google ニュースドメインが残っている場合は力尽くで追跡
      if (targetUrl.includes("news.google.com")) {
        try {
          const finalUrl = execSync(`curl -L -s -o /dev/null -w "%{url_effective}" -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" --max-time 10 "${targetUrl}"`, { encoding: 'utf-8' }).trim();
          if (finalUrl && !finalUrl.includes("google.com/")) targetUrl = finalUrl;
        } catch (e) {}
      }

      const venvPython = "/home/boncoli/yata-local/local_llm/.venv/bin/python3";
      const pythonCmd = `${venvPython} -c "import trafilatura; download = trafilatura.fetch_url('${targetUrl}'); print(trafilatura.extract(download, include_comments=False, include_tables=False) or '')"`;

      let bodyText = "";
      try {
        bodyText = execSync(pythonCmd, { encoding: 'utf-8', timeout: 30000 }).trim();
      } catch (pyErr) {}

      const minChars = AppConfig.get().System.Limits.WEB_SUMMARY_MIN_CHARS || 50;

      // 2. 本文抽出に失敗した場合の「救済措置」
      if (!bodyText || bodyText.length < minChars) {
        // 最後の手段：RSSに含まれている「タイトル」と「概要」をソースにする
        // YATA.js 本体の getWebPageSummary は URL しか受け取らないため、
        // DBから該当記事の abstract を逆引きする
        const db = global.YATA_DB;
        const row = db.prepare("SELECT title, abstract FROM collect WHERE url = ? OR id = ?").get(url, url);
        
        if (row && row.abstract) {
          bodyText = `[RSS Content Fallback]\nTitle: ${row.title}\nSummary: ${row.abstract}`;
          console.log("ℹ️ [Insight] Using RSS Content Fallback (Scraping failed).");
        }
      }

      if (!bodyText || bodyText.length < minChars) {
        return "エラー: ページ解析に失敗しました。サイトがボットを遮断しているか、構造が特殊です。";
      }

      console.log(`✅ [Insight] Source ready (${bodyText.length} chars). Analyzing...`);
      const systemPrompt = getPromptConfig_("WEBPAGE_SUMMARY_SYSTEM");
      return LlmService.summarizeReport(systemPrompt, bodyText.substring(0, 30000));

    } catch (e) {
      return `エラー: ${e.message}`;
    }
  };

  console.log("✅ [Loader] YATA.js loaded with Title-Fallback & Ultra Scraper.");
} catch (e) {
  console.error("❌ [Loader] Failed to load YATA.js:", e);
  process.exit(1);
}

// 2. 設定のオーバーライド (維持)
if (typeof AppConfig !== 'undefined') {
  try {
    const config = AppConfig.get();
    if (config.System && config.System.TimeLimit) {
      config.System.TimeLimit.SUMMARIZATION = 600 * 1000;
      config.System.TimeLimit.REPORT_GENERATION = 600 * 1000;
    }
    if (config.System && config.System.Limits) {
      config.System.Limits.DATA_RETENTION_MONTHS = 12; 
    }
    if (config.Llm) {
      config.Llm.MIN_SUMMARY_LENGTH = 0;
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

    // 🌟 週報生成のカスタマイズ (Flat Mode 対応)
    if (typeof LlmService !== 'undefined' && LlmService.generateTrendSections) {
      const originalGenerateTrendSections = LlmService.generateTrendSections;
      LlmService.generateTrendSections = function(articlesGroupedByKeyword, linksPerTrend, hitKeywords, previousSummary, options) {
        // .env で FLAT_MODE が有効なら、過去のサマリを無視して「今週の全部盛り」を作る
        if (process.env.WEEKLY_REPORT_FLAT_MODE === "true") {
          console.log("📝 [Loader] Weekly Report: Flat Mode enabled (Ignoring history for richer summary).");
          // previousSummary を null に書き換えて元関数を呼ぶことで、TREND_USER_TEMPLATE が使われる
          return originalGenerateTrendSections.apply(this, [articlesGroupedByKeyword, linksPerTrend, hitKeywords, null, options]);
        }
        return originalGenerateTrendSections.apply(this, arguments);
      };
    }
  } catch (e) {}
}

module.exports = {};
