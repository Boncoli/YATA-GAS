require("./gas-bridge.js");
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/**
 * YATA Loader for Raspberry Pi
 * 
 * GitHubで管理されている `YATA.js` を直接編集せずに、
 * Node.js環境（ラズパイ）で実行できるようにするためのラッパーです。
 * 
 * 1. GAS環境を模倣して `YATA.js` をグローバルスコープでロードします。
 * 2. ラズパイ用に設定（タイムアウト時間など）をメモリ上でオーバーライドします。
 */

// 1. YATA.js の読み込みと展開
const yataPath = path.join(__dirname, 'YATA.js');
try {
  const yataCode = fs.readFileSync(yataPath, 'utf8');
  
  // vm.runInThisContext を使うことで、ファイル内の関数定義 (function x() {}) が
  // 現在の global スコープに展開されます（GASの挙動に近い）。
  vm.runInThisContext(yataCode, { filename: yataPath });
  
  // GAS本家の厳格な英語判定を、gas-bridge.jsで定義した緩和版で上書き(オーバーライド)する
  if (typeof global.isLikelyEnglish === 'function') {
    global.isLikelyEnglish_ = global.isLikelyEnglish;
    console.log("✅ [Loader] Overrode isLikelyEnglish_ with relaxed local version.");
  }

  // 🌟 HTMLタグ除去関数のオーバーライド (実体参照 &lt; 等にも対応する強力版)
  global.stripHtml_ = function(html) {
    if (!html) return "";
    let text = String(html).replace(/<[^>]*>?/gm, '');
    // &lt; などの実体参照をデコードして、再度タグ除去をかける
    if (text.includes('&')) {
      text = text.replace(/&nbsp;/g, ' ')
                 .replace(/&lt;/g, '<')
                 .replace(/&gt;/g, '>')
                 .replace(/&amp;/g, '&')
                 .replace(/&quot;/g, '"')
                 .replace(/&#39;/g, "'");
      text = text.replace(/<[^>]*>?/gm, '');
    }
    return text.trim();
  };
  console.log("✅ [Loader] Overrode stripHtml_ with robust local version.");

  console.log("✅ [Loader] YATA.js loaded into global scope.");
} catch (e) {
  console.error("❌ [Loader] Failed to load YATA.js:", e);
  process.exit(1);
}

// 2. 設定のオーバーライド (ラズパイ最適化)
if (typeof AppConfig !== 'undefined') {
  try {
    const config = AppConfig.get();

    // --- タイムアウト制限の緩和 ---
    // GASの6分制限を無視し、ラズパイでは長時間実行(10分)を許可する
    if (config.System && config.System.TimeLimit) {
      config.System.TimeLimit.SUMMARIZATION = 600 * 1000;    // 10分
      config.System.TimeLimit.REPORT_GENERATION = 600 * 1000; // 10分
      console.log("⚡ [Loader] TimeLimits extended for Raspberry Pi (10min).");
    }
    
    // --- データ保持期間の変更 (ローカルは大容量なので1年保持) ---
    if (config.System && config.System.Limits) {
      config.System.Limits.DATA_RETENTION_MONTHS = 12; 
      console.log("📦 [Loader] Retention extended to 12 months (Auto-archive enabled).");
    }

    // 🌟 LLM要約バッチ処理のオーバーライド (コスト節約: 5件パッキング)
    if (typeof LlmService !== 'undefined' && LlmService.summarizeBatch) {
      const originalSummarizeBatch = LlmService.summarizeBatch;

      LlmService.summarizeBatch = function(articleTexts) {
        // バッチサイズ設定 (miniなら5件がベスト)
        const BATCH_SIZE = 5;
        const results = new Array(articleTexts.length).fill(null);
        
        console.log(`🚀 [Batch Mode] ${articleTexts.length}件の記事を${BATCH_SIZE}件ずつのバッチで処理します。`);

        const BATCH_SYSTEM = getPromptConfig_("BATCH_SYSTEM");
        const BATCH_USER_TEMPLATE = getPromptConfig_("BATCH_USER_TEMPLATE");

        for (let i = 0; i < articleTexts.length; i += BATCH_SIZE) {
          const chunk = articleTexts.slice(i, i + BATCH_SIZE);
          
          // 各記事に一時的なIDを付与してパッキング
          const packedArticles = chunk.map((text, idx) => ({
            id: String(idx),
            content: text
          }));

          const userPrompt = BATCH_USER_TEMPLATE.replace("{articleText}", JSON.stringify(packedArticles, null, 2));

          try {
            // 🌟 [モデル修正] 蒸留・構造化は確実に nano (gpt-5.4-nano) で実行
            const model = process.env.OPENAI_MODEL_NANO || "gpt-5.4-nano";

            // YATA.js側の修正により、model引数が尊重されるようになりました
            const response = LlmService.analyzeKeywordSearch(BATCH_SYSTEM, userPrompt, {
              model: model,
              taskLabel: "BatchDistillation",
              max_completion_tokens: 2000 
            });

            const parsed = JSON.parse(response.replace(/```json/g, "").replace(/```/g, "").trim());
            
            if (parsed && parsed.results) {
              parsed.results.forEach(res => {
                const idx = parseInt(res.id, 10);
                if (!isNaN(idx) && idx < chunk.length) {
                  // 🌟 [真・汎用パイプライン]
                  // LLMから返ってきたリッチな構造化データ（5W1H等）を一切削らず、
                  // そのままJSON文字列としてDB（summaryカラム）に保管する。
                  const { id, ...structuredData } = res;
                  
                  // YATA.jsが期待する形式（JSON文字列）で保存
                  results[i + idx] = JSON.stringify(structuredData);
                }
              });
            }
          } catch (e) {
            console.error(`⚠️ [Batch Error] チャンク ${i} 〜 ${i + BATCH_SIZE} の処理に失敗しました。個別処理にフォールバックします。: ${e.message}`);
            // 失敗したチャンクは、オリジナルの（1件ずつ投げる）ロジックで再試行
            for (let j = 0; j < chunk.length; j++) {
              results[i + j] = originalSummarizeBatch([chunk[j]])[0];
            }
          }
        }
        return results;
      };
      console.log("⚡ [Loader] Optimized LlmService.summarizeBatch (5-article packing / nano) injected.");
    }

    // 🌟 RSSブラックリスト自動解除ロジックの注入 (クールダウン: 3日間)
    if (typeof RssStrikeCache !== 'undefined') {
      const COOL_DOWN_DAYS = 3;

      // getをオーバーライドして、期限切れなら0を返す
      RssStrikeCache.get = function(url) {
        this.init();
        const key = "RSS_STRIKE_" + Utilities.base64Encode(url).substring(0, 20);
        const rawValue = this.updates[key] !== undefined ? this.updates[key] : (this.props[key] || "0");
        
        if (!rawValue || rawValue === "0") return 0;

        // 値が "回数|YYYY-MM-DD" 形式かチェック
        if (String(rawValue).includes('|')) {
          const [countStr, dateStr] = String(rawValue).split('|');
          const count = parseInt(countStr, 10);
          const lastDate = new Date(dateStr);
          const now = new Date();
          
          // クールダウン期間を過ぎていたらリセット
          const diffDays = (now - lastDate) / (1000 * 60 * 60 * 24);
          if (diffDays >= COOL_DOWN_DAYS) {
            console.log(`♻️ [RSS Reset] Cool-down expired (${Math.floor(diffDays)} days): ${url}`);
            // 注意: ここで直接 reset() を呼ぶと無限ループになる可能性があるため、 updates を直接操作
            this.updates[key] = "0"; 
            return 0;
          }
          return count;
        }
        
        // 旧形式（数字のみ）の場合はそのままパース
        return parseInt(rawValue, 10);
      };

      // addをオーバーライドして、日付を刻印する
      RssStrikeCache.add = function(url) {
        const key = "RSS_STRIKE_" + Utilities.base64Encode(url).substring(0, 20);
        const currentCount = this.get(url);
        const todayStr = new Date().toLocaleDateString('sv-SE'); // JST YYYY-MM-DD
        
        this.updates[key] = `${currentCount + 1}|${todayStr}`;
        console.log(`⚠️ RSS Strike ${currentCount + 1} (Date: ${todayStr}): ${url}`);
      };
      
      console.log(`⚡ [Loader] RSS Blacklist auto-reset (${COOL_DOWN_DAYS} days) injected.`);
    }
    
    // 他に上書きしたい設定があればここに追記
    
  } catch (e) {
    console.warn("⚠️ [Loader] Failed to override AppConfig:", e);
  }
}

// Node.jsの作法として空のオブジェクトをエクスポートしておく
module.exports = {};
