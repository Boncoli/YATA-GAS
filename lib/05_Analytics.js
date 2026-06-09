/**
 * @file YATA-Analytics.js
 * @description 【責務】収集されたデータに対する高度な推論、分析、および検索アルゴリズムの実行。
 * 【主要機能】予兆検知（EmergingSignalEngine）、ベクトル検索、キーワードクエリの AI 拡張。
 */

// #region 1. SIGNAL DETECTION & SEMANTIC SEARCH

/**
 * EmergingSignalEngine
 * 【責務】ベクトル空間上の「主流」から外れた核（シグナル）を検知しレポート化する。
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

    if (outliers.length < 2) return null;

    const nuclei = _detectNuclei(outliers, config);
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
    
    const colsToFetch = Math.max(AppConfig.get().CollectSheet.Columns.VECTOR, AppConfig.get().CollectSheet.Columns.METHOD_VECTOR || 0);

    // 🌟 【修正】まず日付列だけを取得して範囲を絞る（全件読み込み回避）
    const dateValues = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    let targetRowCount = 0;
    for (let i = 0; i < dateValues.length; i++) {
      if (new Date(dateValues[i][0]) < start) {
        targetRowCount = i;
        break;
      }
      targetRowCount = i + 1;
    }
    
    if (targetRowCount === 0) return [];

    // 🌟 【修正】必要な行数だけ、対象の列まで取得する
    const data = sh.getRange(2, 1, targetRowCount, colsToFetch).getValues();
    
    const articles = [];
    for (const r of data) {
      const date = new Date(r[0]);
      if (date >= start && date < end) {
        const vecStr = r[targetVectorColIdx];
        if (!vecStr || String(vecStr).includes("[Error]")) continue;
        const vec = parseVector_(vecStr);
        if (vec) {
          articles.push({
            date: date, title: r[1], url: r[2], abstractText: r[3], headline: r[4], source: r[5], vector: vec
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
    articles.forEach(a => { for (let i = 0; i < dim; i++) avg[i] += a.vector[i]; });
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
        nuclei.push({ articles: currentNucleus, sourceCount: sources.size });
        currentNucleus.forEach(a => { const idx = outliers.indexOf(a); if (idx !== -1) usedIndices.add(idx); });
      }
    }
    return nuclei;
  }

  function _generateReportWithLLM(nuclei) {
    const SYSTEM_PROMPT = getPromptConfig_("SIGNAL_DETECTION_SYSTEM");
    const USER_TEMPLATE = getPromptConfig_("SIGNAL_DETECTION_USER");
    if (!SYSTEM_PROMPT || !USER_TEMPLATE) return null;

    let fullMarkdown = "# [兆候]Emerging Signals Report\n\n既存のトレンドから乖離した「共通の手法・コンセプト」の兆しを検知しました。\n\n";
    nuclei.forEach((nucleus, index) => {
      const articleListText = nucleus.articles.map(a => {
        const context = getArticleContextForAnalysis_(a);
        return `- タイトル: ${a.title}\n  内容: ${context}\n  URL: ${a.url}`;
      }).join("\n\n");

      let userPrompt = USER_TEMPLATE.replace("${article_list}", articleListText).replace("${index}", index + 1);
      const analysis = LlmService.analyzeKeywordSearch(SYSTEM_PROMPT, userPrompt, { temperature: AppConfig.get().Llm.Params.Temperature.INSIGHT });
      const parsed = cleanAndParseJSON_(analysis);
      
      if (parsed && Array.isArray(parsed.signals)) {
        parsed.signals.forEach(sig => {
          fullMarkdown += `### ■ ${sig.name}\n- **合体した記事:**\n`;
          nucleus.articles.forEach(a => { fullMarkdown += `  - [${a.title}](${a.url})\n`; });
          fullMarkdown += `- **コンセプト:** ${sig.concept}\n- **将来の変化:** ${sig.workflow_change}\n\n---\n\n`;
        });
      } else {
        fullMarkdown += analysis + "\n\n---\n\n";
      }
    });

    return {
      markdown: fullMarkdown,
      html: _formatSignalHtml(fullMarkdown),
      nucleiCount: nuclei.length
    };
  }

  function _formatSignalHtml(markdown) {
    const baseHtml = markdownToHtml_(markdown);
    return `<div style="border-left: 10px solid ${AppConfig.get().UI.Colors.ACCENT}; background-color: #fafafa; padding: 20px;">${baseHtml}</div>`;
  }

  return { detect: detect };
})();


/**
 * performSemanticSearch_
 * 【責務】ベクトル類似度を用いて関連記事を抽出・ソートする。
 */
function performSemanticSearch_(queryKeyword, allArticles, topN = AppConfig.get().System.Limits.SEARCH_MAX_RESULTS, similarityThreshold = AppConfig.get().System.Thresholds.SEMANTIC_SEARCH) {
  const queryVector = LlmService.generateVector(queryKeyword);
  if (!queryVector) return [];

  const candidates = [];
  for (const article of allArticles) {
    const vec = article.parsedVector || (article.vectorStr ? parseVector_(article.vectorStr) : null);
    if (vec) {
      const similarity = calculateDotProduct_(queryVector, vec); 
      if (similarity >= similarityThreshold) {
        candidates.push({ ...article, similarity: similarity });
      }
    }
  }
  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, topN);
}

/**
 * expandKeywordQuery_
 * 【責務】日本語キーワードをAIで英語・略称のORクエリに拡張する。
 * 🌟【大改革】一度拡張した結果を KeywordsDictionary シートへ永続マスタ化し、再利用する（APIコスト完全遮断構造）。
 */
const _QueryExpansionCache = {}; // 実行セッション内の超高速ロード用Map（実質Dict）
let _isDictionaryLoaded_ = false; // 初期ロード完了フラグ

function expandKeywordQuery_(originalQuery) {
  if (!originalQuery) return "";
  
  // 🛡️ 防衛線：すでに組み立て済みの手動クエリはそのまま通す
  if (originalQuery.includes(" OR ") || originalQuery.includes(" AND ")) return originalQuery;

  const config = AppConfig.get();
  
  // =================================================================
  // 💾 【1段目の防壁：シート辞書からの一括初回ロード】
  // =================================================================
  if (!_isDictionaryLoaded_) {
    const dictSheet = Repository.getSheet(config.SheetNames.KEYWORDS_DICTIONARY);
    if (dictSheet) {
      const lastRow = dictSheet.getLastRow();
      if (lastRow >= 2) {
        // A列(元ワード) と B列(拡張クエリ) を一括でメモリに展開
        const dictData = dictSheet.getRange(2, 1, lastRow - 1, 2).getValues();
        dictData.forEach(row => {
          const key = String(row[0]).trim();
          const val = String(row[1]).trim();
          if (key && val) _QueryExpansionCache[key] = val;
        });
      }
    }
    _isDictionaryLoaded_ = true; // 次回以降、シート読み込み通信を完全ゼロ化
  }

  // =================================================================
  // 🎯 【2段目の防壁：メモリ/マスタに存在すれば即座に返却（API代 0円）】
  // =================================================================
  if (_QueryExpansionCache[originalQuery]) {
    return _QueryExpansionCache[originalQuery];
  }

  // =================================================================
  // 🤖 【最終手段：誰も知らない新着キーワードのみ、AI（LLM）を1回だけ叩く】
  // =================================================================
  const systemPrompt = "あなたは医療・IT専門のクエリ拡張器です。入力されたキーワードを、同義の英語、専門用語、一般的な略称、および日本語の表記揺れに展開し、'OR' で繋いだ単一の検索クエリ文字列のみを出力せよ。";
  const res = LlmService.analyzeKeywordSearch(systemPrompt, "キーワード: " + originalQuery, { model: "nano", temperature: 0.0, taskLabel: "マスタ新規クエリ拡張" });
  
  let expanded = (res && res.includes("OR")) ? res.replace(/`/g, "").trim() : originalQuery;
  if (!expanded.includes(originalQuery)) expanded = `${originalQuery} OR ${expanded}`;

  // 🌟 メモリにストック
  _QueryExpansionCache[originalQuery] = expanded;

  // 🌟 今後のために、新設されたシートマスタへピンポイントで自動追記（永続化）
  try {
    const dictSheet = Repository.getSheet(config.SheetNames.KEYWORDS_DICTIONARY);
    if (dictSheet) {
      // appendRowの代わりにLock + getRange().setValues()を使い競合を防ぐ
      const lock = LockService.getScriptLock();
      if (lock.tryLock(3000)) {
        const nextRow = dictSheet.getLastRow() + 1;
        dictSheet.getRange(nextRow, 1, 1, 2).setValues([[originalQuery, expanded]]);
        SpreadsheetApp.flush();
        lock.releaseLock();
        Logger.log(`💾 [辞書マスタ登録] 新しい単語「${originalQuery}」の拡張式をシートへ永続記憶しました。`);
      }
    }
  } catch (e) {
    Logger.log(`⚠️ 辞書シートへの追記に失敗（処理は継続されます）: ${e.message}`);
  }

  return expanded;
}

/**
 * getArticleContextForAnalysis_
 */
function getArticleContextForAnalysis_(article) {
  const headline = article.headline || "";
  if (!headline.trim().startsWith("{")) return headline;
  const parsed = cleanAndParseJSON_(headline);
  if (!parsed) return headline;

  const parts = [];
  if (parsed.what && parsed.what !== "Unknown") parts.push(`[WHAT] ${parsed.what}`);
  if (parsed.how && parsed.how !== "Unknown") parts.push(`[HOW] ${parsed.how}`);
  if (parsed.result && parsed.result !== "Unknown") parts.push(`[RESULT] ${parsed.result}`);
  if (parsed.who && parsed.who !== "Unknown") parts.push(`[WHO] ${parsed.who}`);
  
  const kw = Array.isArray(parsed.keywords) ? parsed.keywords.join(", ") : (parsed.keywords || "");
  if (kw) parts.push(`[KEYWORDS] ${kw}`);

  return parts.length > 0 ? parts.join(" ") : (parsed.tldr || headline);
}

/**
 * expandKeywordQueryPubMed_
 * 【責務】入力されたキーワードを PubMed (Entrez) 用の高度な検索クエリに拡張する。
 * MeSH用語の付与、TIABタグ、英語翻訳、および専門的な OR 展開を行う。
 * @param {string} originalQuery - オリジナルのキーワード
 * @returns {string} PubMed検索用に拡張されたクエリ
 */
function expandKeywordQueryPubMed_(originalQuery) {
  if (!originalQuery) return "";
  
  // 🌟 【防衛線1】AND や OR が含まれている場合は手動クエリとみなしてそのまま返す
  if (originalQuery.includes(" OR ") || originalQuery.includes(" AND ")) return originalQuery;
  
  // 🌟 【防衛線2】[majr] や [Mesh] など、何らかのPubMedタグ（角括弧）が入っている場合もそのまま返す
  if (originalQuery.includes("[")) return originalQuery;

  // 💡 ここから下は、防衛線をすり抜けた「純粋なキーワード（ファブリー病など）」だけが到達し、
  // 以前のコードの通りAI（LLM）による自動拡張が正しく走ります。

  // キャッシュがあれば返す
  if (typeof _QueryExpansionCache !== 'undefined' && _QueryExpansionCache["pubmed_" + originalQuery]) {
    return _QueryExpansionCache["pubmed_" + originalQuery];
  }

  const systemPrompt = "あなたは PubMed 専門のクエリビルダーです。入力されたキーワード（日本語または英語）を、PubMed (Entrez) でノイズを減らしつつ網羅的に検索するための高度な検索式に変換せよ。\n\n" +
    "【ルール】\n" +
    "1. 適切な MeSH 用語があれば [MeSH Terms] を付与して含める。\n" +
    "2. タイトルや抄録を対象とする場合は [Title/Abstract] または [TIAB] タグを付与する。\n" +
    "3. 英語の同義語や略称を OR で繋ぎ、検索漏れを防ぐ。\n" +
    "4. 入力が日本語の場合は、適切な英語の学術用語に翻訳して構成する。\n" +
    "5. 出力は PubMed の検索窓にそのまま貼り付け可能な検索式文字列のみ（解説不要）。\n" +
    "例：(\"Heart Diseases\"[MeSH Terms] OR \"Heart Disease\"[TIAB] OR \"Cardiovascular Diseases\"[TIAB])";

  const res = LlmService.analyzeKeywordSearch(systemPrompt, "キーワード: " + originalQuery, { model: "nano", temperature: 0.0, taskLabel: "PubMedクエリ拡張" });
  
  let expanded = (res && (res.includes("[") || res.includes("OR"))) ? res.replace(/`/g, "").trim() : originalQuery;
  
  // セーフティ：あまりに長すぎる、または不適切な応答（JSON等）が返ってきた場合はオリジナルを優先
  if (expanded.length > 500 || expanded.startsWith("{")) {
    expanded = originalQuery;
  }

  if (typeof _QueryExpansionCache !== 'undefined') {
    _QueryExpansionCache["pubmed_" + originalQuery] = expanded;
  }
  return expanded;
}

// #endregion
