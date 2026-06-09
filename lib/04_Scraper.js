/**
 * @file YATA-Scraper.js
 * @description 【責務】外部リソース（Web/RSS/PDF）からの生データの抽出と構造化。
 * 【主要機能】RSSパース、全文スクレイピング（スワッピング）、PDFテキスト抽出、URLデコード、XML操作。
 */

const Scraper = (function() {
  /**
   * fetchFullContent_
   * 【責務】URLから全文（または指定文字数）のテキストをスクレイピングする。PDFにも対応。
   */
  function fetchFullContent_(url) {
    try {
      // 🌟 【追加】1. Google Alerts 等のリダイレクトURLを展開する (MassDeviceなど用)
      if (url.includes("google.com/url?")) {
        const match = url.match(/[?&]url=([^&]+)/);
        if (match) url = decodeURIComponent(match[1]);
      }
      
      // 🌟 【追加】2. Google News の暗号化URLをデコードする (日経バイオテクなど用)
      if (typeof decodeGoogleNewsUrl_ === 'function') {
        url = decodeGoogleNewsUrl_(url);
      }
      const options = {
        'muteHttpExceptions': true,
        'headers': AppConfig.get().System.HttpHeaders,
        // Configから通信猶予時間をロードして粘り強く待機
        'connectTimeout': AppConfig.get().System.Limits.HTTP_CONNECT_TIMEOUT || 5000,
        'readTimeout': AppConfig.get().System.Limits.HTTP_READ_TIMEOUT || 10000
      };
      const response = UrlFetchApp.fetch(url, options);
      if (response.getResponseCode() !== 200) return null;

      const contentType = response.getHeaders()['Content-Type'] || response.getHeaders()['content-type'] || "";
      const isPdf = contentType.includes("application/pdf") || url.toLowerCase().split('?')[0].endsWith(".pdf");

      let rawText = "";

      if (isPdf) {
        Logger.log(`📄 PDFを検知。OCR抽出を開始します: ${url}`);
        const blob = response.getBlob();
        const extractedText = typeof extractTextFromPdfBlob_ === 'function' ? extractTextFromPdfBlob_(blob) : "";
        
        if (extractedText && extractedText.length > 20) {
          rawText = extractedText;
          Logger.log(`✅ PDFからテキストの抽出に成功しました。`);
        } else {
          return "※PDFのテキスト抽出に失敗しました。タイトルから内容を推測してください。";
        }
      } else {
        let html = response.getContentText();
        html = html.replace(/<(nav|header|footer|aside|noscript|script|style)[^>]*>([\s\S]*?)<\/\1>/gi, " ");

        if (html.startsWith("%PDF")) {
          Logger.log(`📄 隠れPDFを検知。OCR抽出に切り替えます: ${url}`);
          const blob = response.getBlob();
          const extractedText = typeof extractTextFromPdfBlob_ === 'function' ? extractTextFromPdfBlob_(blob) : "";
          if (extractedText) rawText = extractedText;
          else return "※隠れPDFのテキスト抽出に失敗しました。タイトルから内容を推測してください。";
        } else {
          const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
          const bodyText = articleMatch ? articleMatch[1] : html;
          rawText = stripHtml_(bodyText);
        }
      }

      const maxChars = AppConfig.get().System.Limits.WEB_SUMMARY_MAX_CHARS || 500;
      return rawText.replace(/\s+/g, " ").trim().substring(0, maxChars);

    } catch (e) {
      Logger.log(`⚠️ スクレイピング/PDF抽出失敗 (${url}): ${e.toString()}`);
      return null;
    }
  }

  return {
    fetchFullContent: fetchFullContent_,

    /**
     * @description RSSリストを巡回し、ドメイン分散アクセスと並列通信を用いて効率的に記事を収集します。
     */
    collectRssFeeds: function() {
      const startTime = new Date().getTime();
      const TIME_LIMIT_MS = AppConfig.get().System.TimeLimit.COLLECTION;

      const rssListSheet = getSheet_(AppConfig.get().SheetNames.RSS_LIST);
      const collectSheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
      
      if (!rssListSheet || !collectSheet) return;

      if (rssListSheet.getLastRow() < AppConfig.get().RssListSheet.DataRange.START_ROW) {
        Logger.log("RSSリストが空のため、収集をスキップします。");
        return;
      }

      const props = PropertiesService.getScriptProperties();
      let systemState = {};
      try {
        systemState = JSON.parse(props.getProperty("YATA_SYSTEM_STATE") || "{}");
      } catch(e) {}
      let startIndex = parseInt(systemState.RSS_COLLECTION_NEXT_INDEX || "0", 10);

      const rssDataRaw = rssListSheet.getRange(
        AppConfig.get().RssListSheet.DataRange.START_ROW, 
        AppConfig.get().RssListSheet.DataRange.START_COL, 
        rssListSheet.getLastRow() - 1, 
        AppConfig.get().RssListSheet.DataRange.NUM_COLS
      ).getValues();

      if (startIndex >= rssDataRaw.length) startIndex = 0;
      Logger.log(`収集開始: 全${rssDataRaw.length}件中、${startIndex + 1}件目からスタートします。`);

      // 🎉 v2.0 共通データ層から既存の「URL・タイトルSet」をスマートにロード！
      const { urlSet: existingUrlSet, titleSet: existingTitleSet } = Repository.getExistingUrlSet(true);

      const rssCols = AppConfig.get().RssListSheet.Columns;
      const fetchOptions = {
        'muteHttpExceptions': true,
        'validateHttpsCertificates': false,
        'headers': AppConfig.get().System.HttpHeaders
      };

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

      let totalNewCount = 0;
      const CHUNK_SIZE = AppConfig.get().System.Limits.RSS_CHUNK_SIZE; 
      let isTimeUp = false;
      const allNewItems = []; 

      for (let i = 0; i < targetRequests.length; i += CHUNK_SIZE) {
        if (new Date().getTime() - startTime > TIME_LIMIT_MS) {
          Logger.log("⏳ タイムリミット到達。残りは次回実行します。");
          isTimeUp = true;
          break; 
        }

        const nextStartCandidate = startIndex + i + CHUNK_SIZE;
        systemState.RSS_COLLECTION_NEXT_INDEX = String(nextStartCandidate);
        props.setProperty("YATA_SYSTEM_STATE", JSON.stringify(systemState));

        const chunkItems = targetRequests.slice(i, i + CHUNK_SIZE);
        const chunkRequests = chunkItems.map(item => item.request);
        
        try {
          const responses = UrlFetchApp.fetchAll(chunkRequests);
          responses.forEach((response, idx) => {
            const meta = chunkItems[idx];
            const code = response.getResponseCode();
            if (code === 200) _resetRssStrike_(meta.rssUrl);
            else { _addRssStrike_(meta.rssUrl); return; }

            const items = parseRssXml_(response.getContentText(), meta.rssUrl);
            if (!items) return;

            items.forEach((item, index) => {
              const maxLimit = AppConfig.get().System.Limits.MAX_ITEMS_PER_FEED || 10;
              if (index >= maxLimit) return;
              try {
                if (!item.link || !item.title) return;
                const normalizedLink = normalizeUrl_(item.link);
                const cleanTitle = stripHtml_(item.title).trim();
                if (_isListingPageNoise_(cleanTitle, item.link)) return;
                const fingerprint = _normalizeTitleFingerprint_(cleanTitle);
                if (existingUrlSet.has(normalizedLink) || existingTitleSet.has(fingerprint)) return;
                const now = new Date();
                let abstractText = stripHtml_(item.description || AppConfig.get().Llm.NO_ABSTRACT_TEXT).trim().replace(/[\r\n]+/g, " ");
                if (item.categories && item.categories.length > 0) {
                  const uniqueTags = [...new Set(item.categories)].join(", ");
                  if (uniqueTags) abstractText += ` [Tags: ${uniqueTags}]`;
                }
                allNewItems.push([now, cleanTitle, item.link, abstractText, "", meta.siteName]);
                existingUrlSet.add(normalizedLink);
                existingTitleSet.add(fingerprint);
              } catch (e) {}
            });
          });
          if (i + CHUNK_SIZE < targetRequests.length) Utilities.sleep(AppConfig.get().System.Limits.RSS_INTER_CHUNK_DELAY); 
        } catch (e) { Logger.log(`⚠️ Chunk Error: ${e.toString()}`); }
      }

      if (allNewItems.length > 0) {
        // 🎉 v2.0 共通の流し込み窓口へ一括丸投げ！
        totalNewCount = Repository.insertNewArticlesBatch(allNewItems);
      }
      if (!isTimeUp) {
        systemState.RSS_COLLECTION_NEXT_INDEX = "0";
        props.setProperty("YATA_SYSTEM_STATE", JSON.stringify(systemState));
      }
      RssStrikeCache.saveAll();
      Logger.log(`今回追加件数: ${totalNewCount}`);
    },

    collectScrapedFeeds: collectScrapedFeeds,
    getWebPageSummary: getWebPageSummary,
    /**
     * 🌟 [v2.0 新設コア] testRegex
     * 保守・検証用：HTMLテキストに対して正規表現を適用し、抽出結果の配列を返す
     */
    testRegex: function(html, regexStr, urlGrp, titleGrp, baseUrl) {
      if (!regexStr) return [];
      let cleanPattern = regexStr.trim().replace(/^\/|\/[gimuy]*$/g, '').replace(/\(\?[is]+\)/g, '');
      const results = [];
      try {
        const re = new RegExp(cleanPattern, 'gis');
        let m;
        while ((m = re.exec(html)) !== null) {
          const url = m[urlGrp];
          const title = (m[titleGrp] || "").replace(/<[^>]*>?/gm, '').trim();
          if (url && title) {
            results.push({ title: title, url: url.startsWith("http") ? url : baseUrl + url });
          }
          if (results.length > 100) break;
        }
      } catch (e) { Logger.log("⚠️ Scraper.testRegex Error: " + e.message); }
      return results;
    },
  };
})();

// グローバルエイリアス
function fetchFullContent_(url) { return Scraper.fetchFullContent(url); }
function collectRssFeeds_() { return Scraper.collectRssFeeds(); }

/**
 * isValidHeadline_
 * 【責務】要約見出しが「SKIP」などの無効な文字列でないか、妥当性を判定する。
 */
function isValidHeadline_(text) {
  if (!text) return false;
  const t = String(text).trim().toUpperCase();
  if (t === "" || t === "NULL" || t === "UNDEFINED") return false;
  // 👇 完全に一致ではなく、"SKIP" から始まるものを全て弾くように変更
  if (t.startsWith("SKIP")) return false; 
  if (t.includes("ERROR:") || t.includes("解析失敗")) return false;
  return t.length > 5;
}

/**
 * looksLikeHtmlStrict_
 * 【責務】コンテンツが HTML であるか、タグの存在で厳密に判定する。
 */
function looksLikeHtmlStrict_(text, contentType) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml+xml")) return true;
  return t.includes("<html") || (t.includes("<body") && t.includes("</body"));
}

/**
 * decodeGoogleNewsUrl_
 * 【責務】Google News 経由の難読化された URL を元のソース URL にデコードする。
 */
function decodeGoogleNewsUrl_(url) {
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
 * PDFからテキストを抽出する（Google Drive APIの自動OCR変換を利用）
 */
function extractTextFromPdfBlob_(pdfBlob) {
  let tempFileId = null;
  try {
    // 1. ドキュメント形式を指定して保存することで、Googleが自動でOCR（テキスト化）してくれます
    const resource = {
      // 🌟 Utilities.getUuid() で一意のIDを生成
      title: "YATA_OCR_" + Utilities.getUuid(), 
      name: "YATA_OCR_" + Utilities.getUuid(),
      mimeType: "application/vnd.google-apps.document"
    };
    
    // Drive API v2/v3 どちらが有効化されていても動くようにフォールバック
    let tempDoc;
    if (typeof Drive.Files.create === 'function') {
       tempDoc = Drive.Files.create(resource, pdfBlob); // v3
    } else {
       tempDoc = Drive.Files.insert(resource, pdfBlob, { ocr: true, ocrLanguage: "ja" }); // v2
    }
    
    tempFileId = tempDoc.id;

    // 2. ドキュメントを開いてテキストだけを吸い出す
    const doc = DocumentApp.openById(tempFileId);
    const text = doc.getBody().getText();
    
    return text;
  } catch (e) {
    Logger.log("⚠️ PDF OCR解析エラー: " + e.message);
    return null;
  } finally {
    // 3. 💡 ここが超重要: 成功しても失敗しても必ず一時ファイルをゴミ箱に捨てる
    if (tempFileId) {
      try {
        DriveApp.getFileById(tempFileId).setTrashed(true);
        Logger.log("🗑️ 読み取り完了。一時ドキュメントをゴミ箱へ移動しました。");
      } catch (delErr) {
        Logger.log("⚠️ 一時ファイルの削除に失敗: " + delErr.message);
      }
    }
  }
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
    
    // 文字数が多すぎるとエラーになるので、先頭500文字程度にカット
    const maxChars = AppConfig.get().System.Limits.WEB_SUMMARY_MAX_CHARS || 500;
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

/**
 * @description Drive上のJSON設定に基づき、RSSフィードがないサイトからも能動的に記事を収集します。
 */
function collectScrapedFeeds() {
  const config = AppConfig.get();
  
  // 🌟 共通エンジンを使ってScrapersのJSONを取得！
  const scrapersData = fetchJsonFromDrive_("SCRAPERS_JSON_FILE_ID");
  
  if (!scrapersData || !Array.isArray(scrapersData) || scrapersData.length === 0) {
    Logger.log("[Scrapers] JSON設定ファイルが見つからないか、データが空のためスキップします。");
    return;
  }

  // 🎉 v2.0 共通データ層から既存の「URL専用Set」を一瞬でロード！
  const existingUrlSet = Repository.getExistingUrlSet(false);

  const allNewItems = [];
  // 🌟 安全装置：1サイトあたりの最大取得件数（デフォルト20件）を取得
  const maxItemsPerSite = config.System.Limits.MAX_ITEMS_PER_FEED || 20;

  // 2. JSONデータをもとに巡回ループ
  for (const item of scrapersData) {
    const label = item.label;
    const targetUrl = item.targetUrl;
    const baseUrl = item.baseUrl || "";
    const regexStr = item.regex;
    const urlGroup = item.urlGroup || 1;
    const titleGroup = item.titleGroup || 2;
    const active = item.active;

    // activeがfalse、または必須項目が欠けている場合はスキップ
    if (!active || active === "false" || !targetUrl || !regexStr) continue;

    try {
      Logger.log(`[Scraper] ${label} (${targetUrl}) を巡回中...`);
      const options = { 'muteHttpExceptions': true, 'headers': config.System.HttpHeaders };
      const response = UrlFetchApp.fetch(targetUrl, options);
      if (response.getResponseCode() !== 200) {
        Logger.log(`[Scraper Error] ${label}: サーバー応答エラー ${response.getResponseCode()}`);
        continue;
      }

      const html = response.getContentText();
      const regex = new RegExp(regexStr, 'gi');
      let match;
      let siteNewCount = 0;

      while ((match = regex.exec(html)) !== null) {
        // 🌟 防壁：取得件数が上限に達したらループを強制ブレイク
        if (siteNewCount >= maxItemsPerSite) {
          Logger.log(`[Scraper] ${label}: 取得上限（${maxItemsPerSite}件）に達したため抽出を打ち切ります。`);
          break;
        }

        const rawUrl = match[parseInt(urlGroup)];
        const rawTitle = (match[parseInt(titleGroup)] || "").replace(/<[^>]*>?/gm, '').trim();
        
        if (!rawUrl) continue;

        const fullUrl = rawUrl.startsWith("http") ? rawUrl : baseUrl + rawUrl;
        const normalizedUrl = normalizeUrl_(fullUrl);
        
        // 🌟 [防壁発動] プレスリリース一覧などのまとめページを入り口で即死させる
        if (_isListingPageNoise_(rawTitle, fullUrl)) continue;

        // 👇 URLやタイトルに "{{ " が含まれている場合は、テンプレートのゴミとみなしてスキップ
        const isTemplateGarbage = rawTitle.includes("{{") || rawUrl.includes("{{");
        
        // タイトルが一定以上の長さで、ゴミではなく、かつ未登録なら採用
        if (rawTitle.length > 5 && !isTemplateGarbage && !existingUrlSet.has(normalizedUrl)) {
          allNewItems.push([
            new Date(), 
            rawTitle.replace(/\s+/g, " "), // タイトルの空白を正規化
            fullUrl,
            config.Llm.NO_ABSTRACT_TEXT, 
            "", 
            label
          ]);
          existingUrlSet.add(normalizedUrl);
          siteNewCount++;
        }
      }
      if (siteNewCount > 0) Logger.log(`[Scraper] ${label}: ${siteNewCount} 件の新着記事を発見。`);
    } catch (e) {
      Logger.log(`❌ [Scraper Error] ${label}: ${e.message}`);
    }
  }

  // 3. 🎉 v2.0 共通の流し込み窓口へ一括丸投げ！
  if (allNewItems.length > 0) {
    Repository.insertNewArticlesBatch(allNewItems);
    Logger.log(`✅ [Scrapers Total] ${allNewItems.length} 件の新着記事を追加しました！`);
  }
}

/**
 * @namespace RssStrikeCache
 * @description RSS取得失敗時のエラー回数を管理。12時間経過でストライクが1つ回復する自律回復機構付き。
 */
const RssStrikeCache = {
  props: null,
  updates: {},
  DECAY_MS: 12 * 60 * 60 * 1000,

  init: function() {
    if (!this.props) this.props = PropertiesService.getScriptProperties().getProperties();
  },

  get: function(url) {
    this.init();
    const key = "RSS_STRIKE_" + Utilities.base64Encode(url).substring(0, 20);
    let raw = this.updates[key] !== undefined ? this.updates[key] : this.props[key];

    if (!raw) return 0;

    const parts = String(raw).split(',');
    let count = parseInt(parts[0] || "0", 10);
    const lastStrikeTime = parseInt(parts[1] || "0", 10);

    if (lastStrikeTime > 0) {
      const now = new Date().getTime();
      const elapsed = now - lastStrikeTime;
      
      if (elapsed > this.DECAY_MS) {
        const decayAmount = Math.floor(elapsed / this.DECAY_MS);
        count = Math.max(0, count - decayAmount);
      }
    }

    return count;
  },

  add: function(url) {
    const currentCount = this.get(url);
    const newCount = currentCount + 1;
    const now = new Date().getTime();
    const key = "RSS_STRIKE_" + Utilities.base64Encode(url).substring(0, 20);
    
    this.updates[key] = `${newCount},${now}`;
    Logger.log(`⚠️ RSS Strike ${newCount}: ${url}`);
  },

  reset: function(url) {
    this.init();
    const key = "RSS_STRIKE_" + Utilities.base64Encode(url).substring(0, 20);
    if (this.props[key] || this.updates[key]) {
      this.updates[key] = null;
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
    this.updates = {};
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
 * 🌟 [新設] 収集段階でPR TIMES等の「一覧ページ・まとめページ」を検知して弾くバウンサー
 * @param {string} title - 記事タイトル
 * @param {string} url - 記事URL
 * @returns {boolean} true: ノイズ（一覧ページ）, false: 正常な個別記事
 */
function _isListingPageNoise_(title, url) {
  const t = String(title).toLowerCase();
  const u = String(url).toLowerCase();
  
  // 1. タイトルによるまとめページ判定
  if (t.includes("プレスリリース一覧") || t.includes("ニュースリリース - pr times") || t.includes("に関するプレスリリース")) {
    return true;
  }
  
  // 2. PR TIMES特有の一覧系URLパターン判定（個別記事は /main/html/rd/p/ ）
  if (u.includes("prtimes.jp")) {
    if (u.includes("/topics/keywords/") || u.includes("/searchrl/") || !u.includes("/rd/p/")) {
      return true;
    }
  }
  
  return false;
}