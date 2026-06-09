/**
 * @file 09_PubMed-UI.js
 * @version 2.0.0
 * @description PubMed/PMC 取得・抽出エンジンの全ロジックを集約。
 * UI(手動)とJob(自動)の両方から呼び出されます。
 * 【最適化】🌟v2.0 yata-loader.js との連携不整合を解消（ローカルクラッシュバグを完全修正）。
 */

// =========================================================================
// 1. 自動収集ジョブ用 (YATA.js から呼ばれる)
// =========================================================================

/**
 * collectPubMedFeeds_ (Deep Dive 統合版)
 * 【責務】PubMed から詳細情報を取得し、PMC があれば全文を吸い上げて D 列を補填する。
 */
function collectPubMedFeeds_(keyword, maxCount = AppConfig.get().PubMed.Limits.DEFAULT_MAX_COUNT) {
  const config = AppConfig.get();
  const collectSheet = getSheet_(config.SheetNames.TREND_DATA);
  if (!collectSheet) return;

  const today = new Date();
  const pastDate = new Date();
  pastDate.setDate(today.getDate() - config.PubMed.Limits.SEARCH_WINDOW_DAYS);
  const endDate = new Date();
  endDate.setDate(today.getDate() - config.PubMed.Limits.SEARCH_END_OFFSET_DAYS);

  // 1. 検索実行（IDリストを取得）
  const pubMedRes = getPubMedPaperIDs_(keyword, pastDate, endDate); 
  const idList = pubMedRes.ids;

  // 🎉 v2.0 共通データ層から既存の「URL専用Set」を一瞬でロード！
  const existingUrlSet = Repository.getExistingUrlSet(false);

  const newItems = [];

  for (const pmid of idList) {
    if (newItems.length >= maxCount) break;
    const url = `https://pubmed.ncbi.nlm.nih.gov/${pmid}`;
    if (existingUrlSet.has(normalizeUrl_(url))) continue;

    // 2. 詳細情報の取得
    const info = getPaperInfo_("PubMed", pmid); 
    if (!info) continue;

    // 3. 論文種別（PubType）フィルタの適用
    if (!checkPubtype_(info.pubtype, config, "PubMed")) continue;

    // 4. PMC 全文スクレイピングと D 列（ABSTRACT）の補填
    let contentForDColumn = `【Journal: ${info.journal} / Author: ${info.author}】\n\n[Abstract]\n${info.abstract}`;

    if (info.pmcUrl) {
      Logger.log(`🔗 PMC 全文を補填中: ${pmid}`);
      try {
        const pmcHtml = fetchWithRetry_(info.pmcUrl, { muteHttpExceptions: true });
        const sections = extractPmcSections_(pmcHtml); 
        
        // 🌟 【お利口化】優先度順（結論 ➔ 結果 ➔ 背景 ➔ 手法）に並び替え、各セクションを個別に制限
        if (sections.conclusion)   contentForDColumn += `\n\n[PMC Conclusion]\n${sections.conclusion.substring(0, 800)}`;
        if (sections.results)      contentForDColumn += `\n\n[PMC Results]\n${sections.results.substring(0, 1200)}`;
        if (sections.introduction) contentForDColumn += `\n\n[PMC Introduction]\n${sections.introduction.substring(0, 600)}`;
        if (sections.methods)      contentForDColumn += `\n\n[PMC Methods]\n${sections.methods.substring(0, 500)}`;
        
      } catch (e) {
        Logger.log(`⚠️ PMC取得失敗: ${pmid} - ${e.message}`);
      }
    }

    // 5. 書き込み用配列へ格納 (E列=要約は空にして後続に任せる)
    newItems.push([
      new Date(), info.title, url, contentForDColumn, "", "PubMed"
    ]);
    
    Utilities.sleep(1000); 
  }

  // 6. まとめてシートへ追記（🎉 v2.0 共通の流し込み窓口へ丸投げ！）
  if (newItems.length > 0) {
    Repository.insertNewArticlesBatch(newItems);
    Logger.log(`✅ PubMed Deep Collection: ${newItems.length} 件を蓄積しました。`);
  }
}

// =========================================================================
// 2. 共通ヘルパー (UI と Job の両方から呼ばれる)
// =========================================================================



function getPubMedPaperIDs_(query, startDate, endDate) {
  const expandedQuery = expandKeywordQueryPubMed_(query);
  const fmt = (d) => Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd");
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&sort=pub_date&term=${encodeURIComponent(expandedQuery)}&mindate=${fmt(startDate)}&maxdate=${fmt(endDate)}`;
  const res = JSON.parse(fetchWithRetry_(url, { muteHttpExceptions: true }));
  return { ids: res.esearchresult?.idlist || [], expandedQuery: expandedQuery };
}

function searchArXivIDs_(query, maxResults) {
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;
  const xml = fetchWithRetry_(url, { muteHttpExceptions: true });
  const doc = XmlService.parse(xml);
  const atom = XmlService.getNamespace('http://www.w3.org/2005/Atom');
  return doc.getRootElement().getChildren('entry', atom).map(e => e.getChild('id', atom).getText().split('/').pop());
}

function getPaperInfo_(sourceFlag, id) {
  if (sourceFlag === "PubMed") {
    const config = AppConfig.get().PubMed.Endpoints;
    const sumUrl = `${config.Summary}?db=pubmed&retmode=json&id=${id}`;
    const summaryRes = JSON.parse(fetchWithRetry_(sumUrl, { muteHttpExceptions: true })).result[id];
    if (!summaryRes) return null;

    const fetchUrl = `${config.Fetch}?db=pubmed&retmode=xml&id=${id}`;
    const fetchXml = fetchWithRetry_(fetchUrl, { muteHttpExceptions: true });
    const match = fetchXml.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/);
    const abstract = match ? match[1].replace(/<[^>]*>?/gm, '').trim() : "";

    const pmcIdObj = summaryRes.articleids?.find(i => i.idtype === "pmc");
    return {
      id: id,
      title: summaryRes.title,
      abstract: abstract,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}`,
      doiUrl: summaryRes.elocationid ? `https://doi.org/${summaryRes.elocationid.replace("doi: ", "")}` : "",
      pmcUrl: pmcIdObj ? `${config.PmcBase}${pmcIdObj.value}` : "",
      pdfUrl: "",
      author: summaryRes.authors?.[0]?.name || "Unknown",
      journal: summaryRes.source || "Unknown",
      epubDate: summaryRes.pubdate || "",
      pubtype: summaryRes.pubtype || []
    };
  } else if (sourceFlag === "arXiv") {
    const url = `http://export.arxiv.org/api/query?id_list=${id}`;
    const xml = fetchWithRetry_(url, { muteHttpExceptions: true });
    const entry = XmlService.parse(xml).getRootElement().getChild('entry', XmlService.getNamespace('http://www.w3.org/2005/Atom'));
    if (!entry) return null;
    
    const atom = XmlService.getNamespace('http://www.w3.org/2005/Atom');
    const pdfLink = entry.getChildren('link', atom).find(l => l.getAttribute('title')?.getValue() === 'pdf');
    
    return {
      id: id,
      title: entry.getChild('title', atom).getText().trim(),
      abstract: entry.getChild('summary', atom).getText().trim(),
      url: entry.getChild('id', atom).getText(),
      doiUrl: "", pmcUrl: "",
      pdfUrl: pdfLink ? pdfLink.getAttribute('href').getValue() : "",
      author: entry.getChildren('author', atom).map(a => a.getChild('name', atom).getText()).join(", "),
      journal: "arXiv",
      epubDate: entry.getChild('published', atom).getText().split('T')[0],
      pubtype: []
    };
  }
  return null;
}

function extractPmcSections_(html) {
  const sections = {};
  const patterns = {
    introduction: /<h2[^>]*>(?:\d+\.\s*)?(Introduction|Background)<\/h2>(.*?)(?=<h2|$)/is,
    methods: /<h2[^>]*>(?:\d+\.\s*)?(Methods|Materials|Materials and Methods|Methods and Materials)<\/h2>(.*?)(?=<h2|$)/is,
    results: /<h2[^>]*>(?:\d+\.\s*)?(Results)<\/h2>(.*?)(?=<h2|$)/is,
    discussion: /<h2[^>]*>(?:\d+\.\s*)?(Discussion)<\/h2>(.*?)(?=<h2|$)/is,
    conclusion: /<h2[^>]*>(?:\d+\.\s*)?(Conclusion|Conclusions)<\/h2>(.*?)(?=<h2|$)/is
  };
  for (const [key, regex] of Object.entries(patterns)) {
    const match = html.match(regex);
    if (match) sections[key] = stripHtml_(match[2]).replace(/\s+/g, ' ').trim();
  }
  return sections;
}

function checkPubtype_(types, config, sourceFlag) {
  if (sourceFlag === "arXiv") return true; 
  if (!types || types.length === 0) return true; 
  const allowedTypes = config.PubMed.Limits.ALLOWED_TYPES;
  return types.some(t => allowedTypes.includes(t));
}

// =========================================================================
// 3. UI専用 (Pubmed.html から呼ばれる)
// =========================================================================

function setScriptStatus(message) {
  PropertiesService.getUserProperties().setProperty('scriptStatus', message);
}
function clearScriptStatus() {
  PropertiesService.getUserProperties().deleteProperty('scriptStatus');
}

function executeScript(inputType, searchWord, urlInput, startDate, endDate, maxPaperCount, email, language, sendEmailFlag, sourceFlag) {
  setScriptStatus("処理を開始しています...");
  let usedQuery = searchWord || urlInput;
  
  try {
    let summaryResults = [];

    if (inputType === "url") {
      setScriptStatus("URLコンテンツを解析中...");
      const summaryText = getWebPageSummary(urlInput); 
      summaryResults.push({
        source: "URL", id: urlInput, title: "URL要約: " + urlInput, url: urlInput, author: "N/A", journal: "Web Page", epubDate: fmtDate_(new Date()), 
        aiSummary: { tldr: summaryText, summary: { background: "Webページより抽出された要約です。" } }
      });
    } else {
      setScriptStatus(`${sourceFlag} から論文を検索中...`);
      const start = startDate ? new Date(startDate) : new Date(new Date().setDate(new Date().getDate() - 14));
      const end = endDate ? new Date(endDate) : new Date();
      
      let idList = [];
      if (sourceFlag === "PubMed") {
        const pubMedRes = getPubMedPaperIDs_(searchWord, start, end);
        idList = pubMedRes.ids;
        usedQuery = pubMedRes.expandedQuery;
      } else {
        idList = searchArXivIDs_(searchWord, maxPaperCount);
      }

      if (!idList || idList.length === 0) return { summaryResults: [], modelUsed: "N/A" };

      const targetIds = idList.slice(0, maxPaperCount);
      const articlesToSummarize = [];
      const paperInfos = [];

      for (let i = 0; i < targetIds.length; i++) {
        setScriptStatus(`${i+1}/${targetIds.length}件目の詳細を取得中...`);
        const info = getPaperInfo_(sourceFlag, targetIds[i]);
        if (info) {
          paperInfos.push(info);
          articlesToSummarize.push(`Title: ${info.title}\nAbstract: ${info.abstract}`);
        }
        Utilities.sleep(500);
      }

      if (articlesToSummarize.length > 0) {
        setScriptStatus(`AIによる要約を生成中...`);
        
        const batchResults = LlmService.executeStructuredQuery(articlesToSummarize, "PUBMED", { isUiSearch: true });
        
        batchResults.forEach((jsonStr, idx) => {
          const parsed = cleanAndParseJSON_(jsonStr) || {};
          const info = paperInfos[idx];
          if (parsed.title_ja) info.title = parsed.title_ja;
          
          summaryResults.push({
            source: sourceFlag, id: info.id, title: info.title, url: info.url, doiUrl: info.doiUrl, pmcUrl: info.pmcUrl, pdfUrl: info.pdfUrl, author: info.author, journal: info.journal, epubDate: info.epubDate,
            aiSummary: { tldr: parsed.tldr || "要約の生成に失敗しました。", keywords: parsed.keywords || [] }
          });
        });
      }
    }

    if (sendEmailFlag && email && summaryResults.length > 0) {
      setScriptStatus("メールを送信中...");
      let markdownBody = `## 「${searchWord || urlInput}」の論文要約結果\n\n`;
      summaryResults.forEach((r, idx) => {
        markdownBody += `### ${idx + 1}. ${r.title}\n- **著者:** ${r.author} (${r.journal})\n`;
        if (r.aiSummary && r.aiSummary.tldr) markdownBody += `- **TL;DR:** ${r.aiSummary.tldr}\n`;
        markdownBody += `- **URL:** ${r.url}\n\n`;
      });
      sendDigestEmail_(null, markdownBody, null, 1, { recipient: email, isHtml: false, subjectOverride: `【YATA 論文要約】${searchWord || urlInput}` });
    }

    return { summaryResults: summaryResults, modelUsed: AppConfig.get().Llm.ModelNano || "YATA AI Engine", expandedQuery: usedQuery };

  } catch (e) {
    Logger.log("PubMed UI Error: " + e.message); throw e;
  } finally {
    clearScriptStatus();
  }
}

// 🌟 [v2.0 修正：外部参照・Raspberry Pi用フックの完全エクスポート]
if (typeof global !== 'undefined') {
  global.collectPubMedFeeds_ = collectPubMedFeeds_;
  global.extractPmcSections_ = extractPmcSections_;
  global.getPubMedPaperIDs_ = getPubMedPaperIDs_;
  global.getPaperInfo_ = getPaperInfo_;
}