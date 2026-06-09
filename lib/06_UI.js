/**
 * @file YATA-UI.js
 * @version 2.0.0
 * @description 【責務】ユーザーインターフェース（Web）の提供と、人間が読みやすいレポートの出力生成。
 * 【主要機能】🌟v2.0 AIのJSON構文崩れを100%自動検知し、生のマークダウンからカードを強制救済デコードする防衛シールドを搭載。
 */

const DeliveryService = (function() {
  return {
    /** dailyDigestJob: 日刊ダイジェスト生成 - 過去24時間の全記事 */
    runDailyDigest: function() {
      Log.info("--- 日刊KW Digest開始 ---");
      const DAYS_WINDOW = AppConfig.get().System.DateWindows.DAILY_DIGEST_JOB;
      const { start, end } = Repository.getDateWindow(DAYS_WINDOW);

      const allItems = Repository.getArticlesInDateWindow(start, end);
      if (allItems.length === 0) return;

      const usersSheet = Repository.getSheet(AppConfig.get().SheetNames.USERS);
      const usrCols = AppConfig.get().UsersSheet.Columns;
      const users = usersSheet.getRange(2, 1, usersSheet.getLastRow()-1, Object.keys(usrCols).length).getValues();

      users.forEach(user => {
        const email = String(user[usrCols.EMAIL-1]).trim();
        const kwRaw = String(user[usrCols.KWS-1]).trim();
        const labelRaw = String(user[usrCols.LABELS - 1] || "").trim();
        const dailyFlag = user[usrCols.DAILY_KW_DIGEST-1];

        if (!email || dailyFlag !== true || !kwRaw) return;

        const keywords = kwRaw.split(',').map(k=>k.trim());
        const displayLabels = labelRaw !== "" ? labelRaw.split(',').map(l=>l.trim()) : keywords;
        const useSemantic = user[usrCols.SEMANTIC-1] === true;

        let filteredArticles = [];
        if (useSemantic) {
          const limit = AppConfig.get().System.Limits.DAILY_DIGEST_SEARCH_LIMIT;
          keywords.forEach(kw => { filteredArticles = filteredArticles.concat(performSemanticSearch_(kw, allItems, limit)); });
          const seen = new Set(); filteredArticles = filteredArticles.filter(a=>{ if (seen.has(a.url)) return false; seen.add(a.url); return true; });
        } else {
          filteredArticles = filterArticlesByKeywords_(allItems, keywords);
        }

        if (filteredArticles.length === 0) return;

        const systemPrompt = Repository.getPromptConfig("DAILY_DIGEST_SYSTEM");
        const userPromptTemplate = Repository.getPromptConfig("DAILY_DIGEST_USER");
        const articleListText = formatArticlesForLlm_(filteredArticles);
        let userPrompt = userPromptTemplate.replace(/\$\{all_articles_in_date_window\}/g, articleListText);
        
        let reportBody = LlmService.generateDailyDigest(systemPrompt, userPrompt);
        const parsed = cleanAndParseJSON_(reportBody);
        let finalMarkdown = `## 本日のハイライト（KW: ${displayLabels.join(", ")}）\n\n`; 

        if (parsed && Array.isArray(parsed.highlights)) {
          parsed.highlights.forEach((h, i) => {
            finalMarkdown += `### ・ ${h.title} (重要度: ${h.importance})\n`;
            finalMarkdown += `- **カテゴリ:** ${h.category}\n`;
            finalMarkdown += `- **解説:** ${h.description}\n`;
            if (h.links && Array.isArray(h.links) && h.links.length > 0) finalMarkdown += `- **関連URL:**\n  ${h.links.join("\n  ")}\n\n`;
            else finalMarkdown += "\n";
          });
          reportBody = finalMarkdown;
        }

        reportBody = markdownToHtml_(reportBody);
        
        // 🎉 v2.0 日刊ダイジェスト用の目次着せ替えスキンを適用
        reportBody = ReportTemplateEngine.injectDailyDigestToc(reportBody);
        
        sendDigestEmail_(null, reportBody, displayLabels.map(l => ({label:l})), 1, { recipient: email, isHtml: true });
      });
      Log.info("--- 日刊KW Digest完了 ---");
    },

    /** sendPersonalizedReport: 個人最適化配信バッチ（🌟v2.0 options.isDryRun テストモード完全統合版） */
    sendPersonalizedReport: function(options = {}) {
      let lock = null;
      if (!options.isDryRun) {
        lock = LockService.getScriptLock();
        if (!lock.tryLock(15000)) {
          Log.warn("[配信ジョブ] 同時起動を検知したため、重複実行をブロックしました。");
          return;
        }
      }

      const startTime = new Date().getTime();
      const TIME_LIMIT_MS = 220 * 1000;

      const usersSheet = Repository.getSheet(AppConfig.get().SheetNames.USERS);
      const keywordsSheet = Repository.getSheet(AppConfig.get().SheetNames.KEYWORDS);
      if (!usersSheet || !keywordsSheet) { if (lock) lock.releaseLock(); return; }

      const daysMap = ["日", "月", "火", "水", "木", "金", "土"];
      const now = new Date();
      const currentDayStr = daysMap[now.getDay()];
      
      const kwCols = AppConfig.get().KeywordsSheet.Columns;
      const trueMarkers = AppConfig.get().Logic.TRUE_MARKERS;
      const lastRowKw = keywordsSheet.getLastRow();
      const masterData = lastRowKw >= 2 ? keywordsSheet.getRange(2, 1, lastRowKw - 1, Object.keys(kwCols).length).getValues() : [];
      
      const todaysMasterItems = masterData.filter(row => {
        const flag = String(row[kwCols.FLAG - 1]).trim();
        const day  = String(row[kwCols.DAY - 1]).trim();
        return (day === currentDayStr || day === "") && trueMarkers.includes(flag.toUpperCase());
      }).map(row => ({
        query: String(row[kwCols.QUERY - 1]).trim(), 
        label: String(row[kwCols.LABEL - 1]).trim() || String(row[kwCols.QUERY - 1]).trim() 
      }));

      const todaysQueries = todaysMasterItems.map(item => item.query).filter(String);
      const todaysLabels  = todaysMasterItems.map(item => item.label);

      const FETCH_DAYS = Math.max(AppConfig.get().System.Limits.BATCH_FETCH_DAYS, AppConfig.get().System.Limits.SAFE_MAX_DAYS);
      const allRecentArticles = Repository.fetchRecentArticlesBatch(FETCH_DAYS);

      const usrCols = AppConfig.get().UsersSheet.Columns;
      const users = usersSheet.getLastRow() >= 2 ? usersSheet.getRange(2, 1, usersSheet.getLastRow() - 1, Object.keys(usrCols).length).getValues() : [];

      const props = PropertiesService.getScriptProperties();
      let systemState = {};
      try { systemState = JSON.parse(props.getProperty("YATA_SYSTEM_STATE") || "{}"); } catch(e) {}
      
      if (!options.isDryRun && systemState.TMP_TRIGGER_IDS) {
        try {
          const idsToDelete = JSON.parse(systemState.TMP_TRIGGER_IDS);
          const allTriggers = ScriptApp.getProjectTriggers();
          allTriggers.forEach(t => {
            if (idsToDelete.includes(t.getUniqueId())) {
              ScriptApp.deleteTrigger(t);
              Log.info(`🗑️ [先手掃除] 一時トリガーを自動消去しました (ID: ${t.getUniqueId()})`);
            }
          });
        } catch(e) {}
        systemState.TMP_TRIGGER_IDS = "[]";
      }

      let nextUserIndex = parseInt(systemState.USER_DELIVERY_NEXT_INDEX || "1", 10);
      if (nextUserIndex >= users.length) nextUserIndex = 1;

      // 配列の「0番目」がスプレッドシートの2行目（デバッグユーザー）に対応
      let startUserIdx = options.isDryRun ? 0 : nextUserIndex;
      let endUserIdx = options.isDryRun ? 1 : users.length;

      Log.info(`📧 [配信ジョブ] ユーザーインデックス ${startUserIdx} から配信を開始します。${options.isDryRun ? " (⚠️ DRY_RUN テストモード) " : ""}(総数: ${users.length - 1}名)`);

      for (let i = startUserIdx; i < endUserIdx; i++) {
        if (!options.isDryRun && (new Date().getTime() - startTime > TIME_LIMIT_MS)) {
          Log.info(`⏳ GAS制限時間を考慮し、配信を一時中断します。次の再開インデックス: ${i}`);
          const newTrigger = ScriptApp.newTrigger("sendPersonalizedReport").timeBased().after(5 * 60 * 1000).create();
          let tmpIds = [newTrigger.getUniqueId()];
          systemState.TMP_TRIGGER_IDS = JSON.stringify(tmpIds);
          systemState.USER_DELIVERY_NEXT_INDEX = String(i);
          props.setProperty("YATA_SYSTEM_STATE", JSON.stringify(systemState));
          if (lock) lock.releaseLock();
          return; 
        }

        const user = users[i];
        const name = user[usrCols.NAME - 1]; 
        const email = String(user[usrCols.EMAIL - 1]).trim();
        const userDay = String(user[usrCols.DAY - 1]).trim(); 
        const userKeywordsRaw = String(user[usrCols.KWS - 1]).trim();
        const userLabelsRaw = String(user[usrCols.LABELS - 1] || "").trim();
        const useSemantic = user[usrCols.SEMANTIC - 1] === true; 
        const useHistory = user[usrCols.HISTORY - 1] === true;       
        const useDigest = user[usrCols.DAILY_KW_DIGEST - 1] === true;
        const usePubMedOnly = user[usrCols.PUBMED - 1] === true || String(user[usrCols.PUBMED - 1]).toUpperCase() === "TRUE" || String(user[usrCols.PUBMED - 1]) === "〇";
        const lastSentStr = String(user[usrCols.LAST_SENT - 1] || "").trim();
        const userPrioritiesRaw = String(user[usrCols.PRIORITIES - 1] || "").trim();

        if ((user[usrCols.MONTHLY_PARTNER - 1] === true || String(user[usrCols.MONTHLY_PARTNER - 1]).toUpperCase() === "TRUE")) continue;
        if (!email) continue;

        let runThisUser = false; let defaultWindowDays = 0; 
        if (options.isDryRun) {
          runThisUser = true;
          defaultWindowDays = FETCH_DAYS; 
        } else {
          if (userDay === "") { runThisUser = true; defaultWindowDays = AppConfig.get().System.DateWindows.DAILY_REPORT; }
          else if (userDay === currentDayStr) { runThisUser = true; defaultWindowDays = AppConfig.get().System.DateWindows.WEEKLY_REPORT; }
        }
        if (!runThisUser) continue; 

        let targetQueries, displayLabels;
        if (userKeywordsRaw !== "") {
          targetQueries = userKeywordsRaw.split(',').map(k => k.trim());
          const tempLabels = userLabelsRaw !== "" ? userLabelsRaw.split(',').map(l => l.trim()) : [];
          displayLabels = targetQueries.map((q, idx) => tempLabels[idx] || q);
        } else if (todaysQueries.length > 0) {
          targetQueries = todaysQueries; displayLabels = todaysLabels;
        } else continue;

        let startDate = (lastSentStr && !isNaN(new Date(lastSentStr).getTime())) ? new Date(lastSentStr) : new Date(now.getTime() - (defaultWindowDays * 24 * 60 * 60 * 1000));
        const endDate = new Date(now);

        let targetArticles = [];
        if (options.isDryRun) {
          targetArticles = allRecentArticles;
        } else {
          targetArticles = allRecentArticles.filter(a => a.date >= startDate && a.date < endDate);
          if (usePubMedOnly) {
            targetArticles = targetArticles.filter(a => a.source === "PubMed");
          }
        }
        const targetItems = targetQueries.map((q, i) => ({ query: q, label: displayLabels[i] }));
        
        let deliveredUrls = new Set();
        const preparedRenderItems = [];
        const useSemanticSearchFlag = useSemantic;

        targetItems.forEach(item => {
          let query = item.query;
          let matched = [];

          if (!useSemanticSearchFlag && !options.skipQueryExpansion) { query = expandKeywordQuery_(query); }

          if (options.strictSourceMatch) {
            matched = targetArticles.filter(art => art.source === "Partner-" + item.query);
          } else if (useSemanticSearchFlag) {
            matched = performSemanticSearch_(query, targetArticles, AppConfig.get().System.Limits.SEARCH_MAX_RESULTS);
          } else {
            matched = targetArticles.filter(art => isTextMatchQuery_((art.title + " " + art.headline + " " + art.abstractText), query));
          }

          if (deliveredUrls.size > 0) {
            matched = matched.filter(art => !deliveredUrls.has(art.url));
          }
          if (matched.length === 0) return;

          if (userPrioritiesRaw) {
            matched = _sortArticlesByPriority_(matched, userPrioritiesRaw);
          }

          const duplicateThreshold = AppConfig.get().System.Thresholds.DUPLICATE_OMIT || 0.85; 
          matched = _omitSimilarArticles_(matched, duplicateThreshold);
          
          const maxArticlesForLlm = 10;
          if (matched.length > maxArticlesForLlm) {
            matched = matched.slice(0, maxArticlesForLlm);
          }

          if (matched.length > 0) {
            preparedRenderItems.push({
              query: query,
              label: item.label || query,
              articles: matched,
              useSemantic: useSemanticSearchFlag
            });
            matched.forEach(art => deliveredUrls.add(art.url));
          }
        });

        if (preparedRenderItems.length === 0) continue;

        Log.info(` ➔ 配信中: [${name}]様 (${email})${options.isDryRun ? " [⚠️ DRY_RUN シミュレーション]" : ""}`);
        
        options.userEmail = email;
        options.dateRangeStr = `${fmtDate_(startDate)} 〜 ${fmtDate_(endDate)}${options.isDryRun ? " (TEST)" : ""}`;
        options.saveHistory = options.isDryRun ? false : true;
        
        // 個別配信時に Digestフラグ（useDigest）の状態をオプションとして手渡す
        options.useDigestFormat = useDigest;

        // 🎉 【純粋関数コール】仕上がった純粋なデータだけをレンダラーにパス！
        const reportHtml = generateTrendReportHtml_(preparedRenderItems, startDate, endDate, options);

        if (!reportHtml) continue;

        const maxKw = AppConfig.get().System.Limits.MAX_SUBJECT_KEYWORDS || 3;
        const labelSummary = displayLabels.slice(0, maxKw).join(', ') + (displayLabels.length > maxKw ? '...' : '');
        
        let subject = "";
        if (options.isDryRun) {
          subject = `【TEST】${useDigest ? "Digest" : "Card"} Report: ${name}様設定シミュレーション`;
        } else {
          subject = `${userKeywordsRaw !== "" ? "【YATA】My AI Report: " : "【YATA】Daily Trend: "}${useSemantic ? "[Semantic] " : ""}${labelSummary} (${Utilities.formatDate(now, Session.getScriptTimeZone(), 'MM/dd')})`;
        }
        
        try {
          let finalRecipient = options.isDryRun ? AppConfig.get().Digest.mailTo : email;
          let finalBcc = options.isDryRun ? null : AppConfig.get().Digest.mailTo;

          sendDigestEmail_(null, reportHtml, null, defaultWindowDays, { recipient: finalRecipient, isHtml: true, subjectOverride: subject, bcc: finalBcc });
          
          if (!options.isDryRun) {
            usersSheet.getRange(i + 2, usrCols.LAST_SENT).setValue(endDate.toISOString());
          }
        } catch (e) { _logError_("sendPersonalizedReport", e, `${name}様への送信失敗`); }
      }

      if (!options.isDryRun) {
        Log.info("🎉 [配信ジョブ] 本日の全ユーザーへの配信が正常に完了しました。");
        systemState.USER_DELIVERY_NEXT_INDEX = "1";
        systemState.TMP_TRIGGER_IDS = "[]"; 
        props.setProperty("YATA_SYSTEM_STATE", JSON.stringify(systemState));
        if (lock) lock.releaseLock();
      }
    },

    /** runTrendAnalysis: 分析コア */
    runTrendAnalysis: function(targetKeyword, options = {}) {
      const config = AppConfig.get().Digest;
      const returnHtml = options.returnHtml || false;
      let start, end;
      if (options.startDate || options.endDate) {
        end = options.endDate ? new Date(options.endDate) : new Date();
        end.setHours(23, 59, 59, 999);
        start = options.startDate ? new Date(options.startDate) : new Date(end.getTime() - (30 * 24 * 60 * 60 * 1000));
        start.setHours(0, 0, 0, 0);
      } else {
        const window = Repository.getDateWindow(options.days || config.days);
        start = window.start; end = window.end;
      }
      const allArticles = Repository.getArticlesInDateWindow(start, end);
      const dateRangeStr = `${fmtDate_(start)} 〜 ${fmtDate_(end)}`;
      if (allArticles.length === 0) return returnHtml ? `<div>該当記事なし (期間: ${dateRangeStr})</div>` : null;

      const keywordStr = String(targetKeyword || "").trim();
      if (!keywordStr) return returnHtml ? "<div>エラー: キーワードが必要です</div>" : null;
      
      let query = keywordStr;
      if (!options.useSemantic && !options.skipQueryExpansion) { query = expandKeywordQuery_(query); }
      let matched = allArticles.filter(art => isTextMatchQuery_((art.title + " " + art.headline + " " + art.abstractText), query));
      
      const duplicateThreshold = AppConfig.get().System.Thresholds.DUPLICATE_OMIT || 0.85; 
      matched = _omitSimilarArticles_(matched, duplicateThreshold);

      if (matched.length === 0) return returnHtml ? `<div>該当記事なし (期間: ${dateRangeStr})</div>` : null;

      const singlePreparedItem = [{
        query: query,
        label: keywordStr,
        articles: matched,
        useSemantic: false
      }];

      options.dateRangeStr = dateRangeStr;
      const htmlContent = generateTrendReportHtml_(singlePreparedItem, start, end, options);

      if (returnHtml) return htmlContent || "<div>分析結果が得られませんでした。</div>";
      if (htmlContent && (config.notifyChannel === "email" || config.notifyChannel === "both")) {
        sendDigestEmail_(AppConfig.get().Messages.REPORT_HEADER_PREFIX + dateRangeStr, htmlContent, null, 7, { isHtml: true, subjectPrefix: config.mailSubjectPrefix || "【TrendAnalysis】" });
      }
    },

    /** runMonthlyPartnerReport: 月次レポート */
    runMonthlyPartnerReport: function() {
      Log.info("--- 月次公的レター配信開始 ---");
      const config = AppConfig.get();
      const usersSheet = Repository.getSheet(config.SheetNames.USERS);
      if (!usersSheet) return;

      const { start, end } = Repository.getDateWindow(30);
      const partnerArticles = Repository.getArticlesInDateWindow(start, end).filter(a => a.source.startsWith("Partner-"));
      if (partnerArticles.length === 0) return;

      const usrCols = config.UsersSheet.Columns;
      const users = usersSheet.getDataRange().getValues();
      users.forEach((user, index) => {
        if (index === 0) return; 
        if (!(user[usrCols.MONTHLY_PARTNER - 1] === true || String(user[usrCols.MONTHLY_PARTNER - 1]).toUpperCase() === "TRUE")) return;

        const email = String(user[usrCols.EMAIL - 1]).trim();
        const uniqueSources = [...new Set(partnerArticles.map(a => a.source))];
        
        const preparedItems = [];
        uniqueSources.forEach(s => {
          const q = s.replace("Partner-", "");
          const matched = partnerArticles.filter(art => art.source === "Partner-" + q);
          if (matched.length > 0) {
            preparedItems.push({ query: q, label: q, articles: matched, useSemantic: false });
          }
        });

        if (preparedItems.length === 0) return;

        const reportHtml = generateTrendReportHtml_(preparedItems, start, end, {
          useDigestFormat: false, isHtmlOutput: false, saveHistory: false, enableHistory: false,      
          skipQueryExpansion: true, isLetterMode: true, strictSourceMatch: true,
          model: "nano", max_completion_tokens: 4000, 
          taskLabel: "月次パートナーレター要約", promptKeys: { system: "PARTNER_REPORT_SYSTEM", user: "PARTNER_REPORT_USER" }
        });

        if (reportHtml) {
          const headerText = `Dear All,\n\nI hope this email finds you well.\nThe purpose of this email is to promote communication and collaboration among affiliated companies, we will share the latest news from Sysmex, Inostics, RGK, and OGT.`;
          sendDigestEmail_(headerText, reportHtml, null, 30, { recipient: email, isHtml: true, isLetterMode: true, subjectOverride: `【月次報告】関係会社動向まとめ (${Utilities.formatDate(new Date(), "JST", "yyyy/MM")})` });
        }
      });
      Log.info("--- 月次公的レター配信完了 ---");
    }
  };
})();

function runTrendAnalysis_(kw, opt) { return DeliveryService.runTrendAnalysis(kw, opt); }

/** Webアプリケーションの画面ルーティング（Index/Visualize/PubMed） */
function doGet(e) {
  const p = e.parameter.p;
  const action = e.parameter.action;

  if (action === 'click' || action === 'like') {
    const url = e.parameter.url;
    const email = e.parameter.email || "Unknown User";
    const kw = e.parameter.kw || "N/A";

    _logUserAction_(email, action, url, kw);

    if (action === 'click' && url) {
      const decodedUrl = decodeURIComponent(url);
      const htmlSafeUrl = decodedUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return HtmlService.createHtmlOutput(ReportTemplateEngine.getRedirectPageHtml(htmlSafeUrl)).setTitle('Redirecting...');
    }

    return HtmlService.createHtmlOutput(ReportTemplateEngine.getFeedbackPageHtml()).setTitle('Feedback Received');
  }
  
  if (p === 'viz') return HtmlService.createTemplateFromFile('Visualize').evaluate().setSandboxMode(HtmlService.SandboxMode.IFRAME).setTitle('YATA - 3D Vector Space');
  if (p === 'pubmed') return HtmlService.createTemplateFromFile('Pubmed').evaluate().setSandboxMode(HtmlService.SandboxMode.IFRAME).setTitle('YATA - PubMed Summary Tool');
  return HtmlService.createTemplateFromFile('Index').evaluate().setSandboxMode(HtmlService.SandboxMode.IFRAME).setTitle('YATA - AI Intelligence Platform');
}

function _logUserAction_(email, action, url, kw) {
  const lock = LockService.getScriptLock();
  try {
    if (lock.tryLock(3000)) {
      const sheet = getSheet_(AppConfig.get().SheetNames.ACTION_LOGS);
      if (!sheet) return;
      const newRow = [new Date(), email, action, url, kw];
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, newRow.length).setValues([newRow]);
    }
  } catch (e) { _logError_("_logUserAction_", e); }
  finally { lock.releaseLock(); }
}

function executeWeeklyDigest(keyword, clientOptions = {}) {
  try {
    return runTrendAnalysis_(String(keyword || "").trim(), {
      days: AppConfig.get().UI.WebDefaults.SEARCH_DAYS,
      startDate: clientOptions.startDate, endDate: clientOptions.endDate,
      returnHtml: true, isHtmlOutput: true, enableHistory: false, useSemantic: clientOptions.useSemantic, 
      promptKeys: { system: "WEB_ANALYSIS_SYSTEM", user: "WEB_ANALYSIS_USER" }
    });
  } catch (e) { return `<h1>処理中にエラーが発生しました</h1><p>${e.toString()}</p>`; }
}

function searchAndAnalyzeKeyword(keyword, options) { return executeWeeklyDigest(keyword, options); }

function getVisualizationData() {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  const LIMIT = AppConfig.get().System.Limits.VIZ_MAX_ITEMS;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const numRows = Math.min(LIMIT, lastRow - 1);
  const data = sheet.getRange(2, 1, numRows, 7).getValues();
  return data.map(r => {
    const vector = parseVector_(r[6]);
    return vector ? { t: r[1], u: r[2], s: r[5], v: vector } : null;
  }).filter(Boolean);
}

/**
 * @description 🌟🌟【v2.0 究極の純粋関数（Pure Function）】
 * データI/O、通信、クエリ拡張を1文字も行わず、確定済みのデータオブジェクトを爆速でHTMLに組み立てる！
 * @param {YataRenderItem[]} preparedRenderItems - ロジック層で事前抽出・間引きを完全に終えたデータの配列
 * @param {Date} startDate - レポート対象期間の開始日
 * @param {Date} endDate - レポート対象期間の終了日
 * @param {Object} [options] - 表示切り替えオプション
 * @returns {string|null} 生成されたHTMLレポート文字列、またはデータ空時にnull
 */
function generateTrendReportHtml_(preparedRenderItems, startDate, endDate, options = {}) {
  if (!preparedRenderItems || preparedRenderItems.length === 0) return null;
  
  let hasContent = false;
  let finalHtmlBody = ""; 

  // 1. 🎉 着せ替えエンジンから「ヘッダー・CSSスキン」をロード
  finalHtmlBody += ReportTemplateEngine.renderHeader(startDate, endDate, options);

  const procStartTime = new Date().getTime();
  const TIME_LIMIT_MS = AppConfig.get().System.TimeLimit.REPORT_GENERATION; 

  // 2. 本文ループ生成
  for (const item of preparedRenderItems) {
    if (new Date().getTime() - procStartTime > TIME_LIMIT_MS) {
      finalHtmlBody += `<p style="color:red; font-weight:bold; text-align:center;">⚠️ 時間制限のため、一部 of トピック解析を中断しました。</p>`;
      break;
    }

    const query = item.query;
    const label = item.label || query;
    const matched = item.articles;
    const useSemantic = item.useSemantic;

    let sectionBodyHtml = "";

    // 🌟🌟🌟【全盛期UI大復活：DIGEST_RANKING_SYSTEM による1通最大10件のコンパイラルート】
    if (options.useDigestFormat) {
       // 週刊横断サライズエンジン（processKeywordAnalysisWithHistory_）を安全に召喚
       // options.useDigestFormat が真であるため、自動的に DIGEST_RANKING_SYSTEM の知能へと切り替わります。
       const result = processKeywordAnalysisWithHistory_(query, matched, options);
       
       if (result && result.reportBody) {
         hasContent = true;
         
         // AIから出力された「厳選された最大10件」のJSON文字列をクレンジングしてパース
         const parsedJson = cleanAndParseJSON_(result.reportBody);
         if (parsedJson && Array.isArray(parsedJson.topics)) {
           parsedJson.topics.forEach(topic => {
             // トラッキングリンクバッジの調達
             const dummyTopic = { links: topic.links || [] };
             const linksBadgeString = ReportTemplateEngine.buildTrackingLinksBadge(dummyTopic, matched, query, options);
             
             // 👑 キャッチ画像と寸分狂わぬ「見出し」「概要」「影響」「単一ソース」の立体カードを直列レンダリング！
             sectionBodyHtml += ReportTemplateEngine.renderDigestCard(topic.title, topic.summary, topic.impact, linksBadgeString, options);
           });
         } else {
           // 🌟🌟🌟【AIハルシネーション自動救済防壁】🌟🌟🌟
           // AIがプロンプトの指示を無視して生のマークダウンテキストで応答してきた場合でも、
           // その中に「概要」や「影響」が完全に揃っているため、そのまま美しい立体カード群へ
           // 自動で直接デコードして流し込み、空メールを永久に防止します！
           Log.warn(`[UI防壁] AIがJSON形式をサボったため、生のマークダウンからカードを救済自動ビルドします。`);
           sectionBodyHtml += markdownToHtml_(result.reportBody);
         }
       }
       
       // 仕上がったカードの山を、キーワードヘッダー（■ 遺伝子（40件））で綺麗に包む
       if (sectionBodyHtml !== "") {
         finalHtmlBody += ReportTemplateEngine.renderSectionContainer(sectionBodyHtml, label, matched.length, useSemantic, options);
       }
    } 
    // 通常の週刊モード（横断トレンド要約）
    else {
       const result = processKeywordAnalysisWithHistory_(query, matched, options);
       if (result && result.reportBody) {
         hasContent = true;
         let contentBody = result.reportBody;
         if (query !== label) contentBody = contentBody.split(query).join(label);
         
         // マークダウンを一度HTMLカード群に変形させてからコンテナに流し込み
         let convertedHtml = markdownToHtml_(contentBody);
         finalHtmlBody += ReportTemplateEngine.renderSectionContainer(convertedHtml, label, matched.length, useSemantic, options);
       }
    }
  }

  if (!hasContent) return null;

  // 3. 着せ替えエンジンから「フッター」をロードして閉じる
  finalHtmlBody += ReportTemplateEngine.renderFooter(options);

  // 4. 👑👑 配信フラグを問わず、すべてのメール最上部に完璧な一括ジャンプ日本語目次（TOC）を再注入！
  finalHtmlBody = ReportTemplateEngine.injectTrendReportToc(finalHtmlBody, options);

  return finalHtmlBody;
}

function generateWeeklyReportWithLLM_(articles, hitKeywordsWithCount, articlesGroupedByKeyword, previousSummary = null, options = {}) {
  const trends = LlmService.generateTrendSections(articlesGroupedByKeyword, AppConfig.get().System.Limits.LINKS_PER_TREND, hitKeywordsWithCount.map(item => item.keyword), previousSummary, options);
  return { reportBody: trends };
}

/** processKeywordAnalysisWithHistory_ */
function processKeywordAnalysisWithHistory_(keyword, articles, options = {}) {
  if (options.useDigestFormat) {
    options.promptKeys = { system: "DIGEST_RANKING_SYSTEM", user: "DIGEST_RANKING_USER" };
    options.enableHistory = false;
  }

  let previousSummary = null;
  if (options.enableHistory !== false) {
    previousSummary = _getRelevantHistory_(keyword, articles.map(a => a.title).join(" ").substring(0, AppConfig.get().System.Limits.HISTORY_CONTEXT_MAX_CHARS || 5000));
  }

  const { reportBody } = generateWeeklyReportWithLLM_(articles, [{ keyword: keyword, count: articles.length }], { [keyword]: articles }, previousSummary, options);
  if (!reportBody || reportBody.trim() === "") return null;

  // =========================================================================
  // 🌟【★追加修正】Digest形式の時は、generateTrendReportHtml_ 側でJSONパースを行うため、
  // ここでのマークダウン変換をバイパスして、LLMからの生のJSON文字列をそのまま返す！
  // =========================================================================
  if (options.useDigestFormat) {
    return { reportBody: reportBody, summary: null };
  }

  const parsedJson = cleanAndParseJSON_(reportBody);
  let finalMarkdown = "";
  
  if (parsedJson) {
    if (Array.isArray(parsedJson.topics)) {
      const topicBlocks = [];
      
      if (parsedJson.landscape && !options.isLetterMode) {
        topicBlocks.push(`> **概況:** ${parsedJson.landscape}`);
      }
      
      parsedJson.topics.forEach(topic => {
        const linksBadgeString = ReportTemplateEngine.buildTrackingLinksBadge(topic, articles, keyword, options);
        const block = ReportTemplateEngine.renderSingleTopicBlock(topic, linksBadgeString, keyword, options);
        topicBlocks.push(block);
      });
      finalMarkdown = topicBlocks.join("\n\n");
    }
  }

  let isNoChangeFlag = parsedJson ? (parsedJson.isNoChange === true || String(parsedJson.isNoChange).toLowerCase() === "true") : false;
  let nextContext = null;
  
  if (options.enableHistory !== false && options.saveHistory !== false) {
    nextContext = isNoChangeFlag && previousSummary ? previousSummary : _generateContextForNextWeek_(finalMarkdown);
    if (nextContext) _writeHistory_(keyword, nextContext);
  }

  return isNoChangeFlag ? { reportBody: null, summary: nextContext } : { reportBody: finalMarkdown, summary: nextContext };
}

/** sendDigestEmail_: レポート配信用ラッパーメール関数 */
function sendDigestEmail_(headerLine, bodyContent, subjectKeywords, daysWindow = 7, options = {}) {
  const digestConfig = AppConfig.get().Digest;
  const to = options.recipient || getRecipients_();
  if (!to) { Log.warn("配信先が設定されていないためメール送信しません。"); return; } 
  
  let finalSubject = options.subjectOverride;
  if (!finalSubject) {
    const prefixBase = daysWindow === 1 ? "日刊" : "週間";
    const subjectPrefix = options.subjectPrefix || digestConfig.mailSubjectPrefix || `【${prefixBase}TrendNEWS】`;
    const kwList = (subjectKeywords && subjectKeywords.length > 0) ? ` [${subjectKeywords.map(item => item.label || item.keyword).join(", ")}]` : "";
    finalSubject = subjectPrefix + kwList + " " + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd");
  }
  
  const fullHtmlBody = ReportTemplateEngine.wrapFinalEmailOuterSkin(headerLine, bodyContent, options);
  const plainBody = options.isHtml ? stripHtml_(fullHtmlBody) : (headerLine + "\n\n" + bodyContent);

  const advancedArgs = { name: digestConfig.mailSenderName, htmlBody: fullHtmlBody };
  if (options.bcc) advancedArgs.bcc = options.bcc;
  
  GmailApp.sendEmail(to, finalSubject, plainBody, advancedArgs);
  Log.info(`メール送信完了: To:${to} / Subject:${finalSubject}`);
}

function getRecipients_() {
  const adminMail = AppConfig.get().Digest.mailTo;
  const sheet = getSheet_(AppConfig.get().SheetNames.USERS);
  const recipientSet = new Set();
  if (adminMail) adminMail.split(',').forEach(e => { if (e.trim()) recipientSet.add(e.trim()); });
  if (sheet && sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues().forEach(row => { if (String(row[1]).trim()) recipientSet.add(String(row[1]).trim()); });
  }
  return Array.from(recipientSet).join(',');
}

function formatArticlesForLlm_(articles) {
  return articles.map(a => `・タイトル: ${a.title}\n  内容: ${a.headline && a.headline.length > 10 ? a.headline : (a.abstractText || a.title)}\n  URL: ${a.url}`).join('\n\n');
}

function _omitSimilarArticles_(articles, threshold = 0.85) {
  if (!articles || articles.length <= 1) return articles;
  const uniqueArticles = [];
  for (const art of articles) {
    const vecA = art.parsedVector; 
    if (!vecA) { uniqueArticles.push(art); continue; }
    let isDuplicate = false;
    for (const kept of uniqueArticles) {
      const vecB = kept.parsedVector;
      if (vecB && calculateDotProduct_(vecA, vecB) >= threshold) { isDuplicate = true; break; }
    }
    if (!isDuplicate) uniqueArticles.push(art);
  }
  return uniqueArticles;
}


// =========================================================================
// 👑 Central View Engine: ReportTemplateEngine
// =========================================================================
const ReportTemplateEngine = (function() {
  const C = AppConfig.get().UI.Colors;
  
  const S = {
    WRAPPER: `background-color: ${C.BG_BODY}; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, Meiryo, sans-serif;`,
    CONTAINER: 'width: 100%; max-width: 1200px; margin: 0 auto;',
    HEADER_CARD: `background-color: ${C.PRIMARY}; padding: 20px; border-radius: 8px; margin-bottom: 20px; text-align: center; box-shadow: 0 2px 5px rgba(0,0,0,0.1);`,
    HEADER_TITLE: 'margin: 0; color: #ffffff; font-size: 22px; font-weight: bold; letter-spacing: 0.05em;',
    HEADER_SUB: 'margin: 5px 0 0 0; color: #eaf2f8; font-size: 13px;',
    CARD: `background:#ffffff; padding:20px; border:1px solid #e1e4e8; border-radius:8px; margin-bottom:15px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);`,
    H3: `font-size:16px; color:${C.SECONDARY}; margin:0 0 12px 0; font-weight:bold; line-height:1.4;`,
    ITEM: `margin-bottom:8px; font-size:14px; line-height:1.6; color:#333;`,
    FOOTER: `text-align: center; padding: 20px; font-size: 12px; color: ${C.TEXT_SUB};`
  };

  return {
    renderHeader: function(startDate, endDate, options) {
      if (options.isLetterMode) {
        return `<div style="padding: 20px; font-family: sans-serif; color: inherit;"><div style="${S.CONTAINER}">`;
      }
      if (!options.isHtmlOutput) {
        return `
          <div style="${S.WRAPPER}"><div style="${S.CONTAINER}">
            <div style="${S.HEADER_CARD}">
              <h3 style="${S.HEADER_TITLE}">&#129302; AI Trend Analysis</h3>
              <p style="${S.HEADER_SUB}">${AppConfig.get().Messages.REPORT_HEADER_PREFIX}${fmtDate_(startDate)} 〜 ${fmtDate_(endDate)}</p>
            </div>
            [[TOC_PLACEHOLDER]]`;
      }
      return `<style>.summary-section{background-color:${C.BG_CARD};padding:20px;border-radius:8px;margin-bottom:25px;box-shadow:0 2px 5px rgba(0,0,0,0.05)}.summary-title{margin-top:0;color:${C.SECONDARY};font-size:18px;font-weight:bold;border-bottom:2px solid ${C.BORDER};padding-bottom:10px;margin-bottom:15px}.section-header{border-left:5px solid ${C.PRIMARY};border-bottom:none;padding-left:10px;padding-bottom:0;color:${C.SECONDARY};margin-top:30px;margin-bottom:15px;font-size:20px}.tech-card{margin-bottom:20px;border:none;padding:20px;border-radius:8px;background-color:${C.BG_CARD};box-shadow:0 2px 8px rgba(0,0,0,0.08);border-left:5px solid ${C.PRIMARY}}.tech-title{margin:0 0 15px 0;color:${C.SECONDARY};font-size:17px;font-weight:bold;line-height:1.4}.tech-meta{font-size:15px;line-height:1.7;color:${C.TEXT_SUB}}.tech-link{margin-top:15px;text-align:left}.tech-link a{display:inline-block;padding:8px 16px;background-color:${C.BADGE_NEW_BG};color:${C.PRIMARY};text-decoration:none;border-radius:20px;font-size:13px;font-weight:bold}.tech-link a:hover{background-color:${C.BADGE_NEW_BG}}</style>`;
    },

    renderFooter: function(options) {
      if (options.isHtmlOutput) return "";
      return `<div style="${S.FOOTER}">YATA - AI Intelligence Platform<br><span style="opacity: 0.8;">Auto-Generated by AI Engine</span></div></div></div>`;
    },

    /** 🌟v2.0 復旧：1記事単体の全盛期立体美カードを完全出力（「概要」「影響」対応版） */
    renderDigestCard: function(title, summary, impact, linksBadgeString, options) {
      return `
        <div style="${S.CARD}">
          <h3 style="${S.H3}">${title}</h3>
          <div style="${S.ITEM}"><strong>概要:</strong> ${summary}</div>
          <div style="${S.ITEM}"><strong>影響:</strong> ${impact}</div>
          <div style="margin-top:12px; padding-top:8px; border-top:1px dashed #eee; font-size:12px; color:#666;">
            <span style="font-weight:bold; margin-right:6px;">SOURCES:</span> ${linksBadgeString}
          </div>
        </div>`;
    },

    /** 🌟v2.0 改良：キーワードの見出しブロック（data-section-kw属性付き） */
    renderSectionContainer: function(contentHtml, label, matchedCount, useSemantic, options) {
      const searchTypeLabel = useSemantic ? "🤖 AI意味検索" : "🔍 キーワード検索";
      return `
        <div style="margin-top:35px; margin-bottom:15px; border-left:5px solid ${C.PRIMARY}; padding-left:12px;">
          <h2 data-section-kw="${label}" style="margin:0; font-size:18px; color:${C.SECONDARY}; font-weight:bold; display:inline-block;">■ ${label}</h2>
          <span style="font-size:12px; color:#666; margin-left:10px;">(${matchedCount}件)</span>
        </div>
        ${contentHtml}`;
    },

    buildTrackingLinksBadge: function(topic, articles, keyword, options) {
      if (!topic.links) return "";
      let rawLinks = Array.isArray(topic.links) ? topic.links.flatMap(l => String(l).split(/,|\n/)) : String(topic.links).split(/,|\n/);
      const validLinks = rawLinks.map(url => url.replace(/[\s\(\)\[\]<>]/g, "").trim()).filter(url => url.startsWith("http"));
      if (validLinks.length === 0) return "";
      const userEmail = options.userEmail || "Unknown";
      const badgeStyle = `display:inline-block; background:#eaf2f8; color:#0066cc; text-decoration:none; padding:3px 8px; border-radius:4px; font-size:11px; border:1px solid #d4e6f1; font-weight:bold;`;

      return validLinks.map(url => {
        const getDomain = (u) => u.replace(/^https?:\/\/(www\.)?/, '').split('/')[0].toLowerCase();
        let matchedArticle = articles.find(a => getDomain(a.url) === getDomain(url));
        let sourceName = (matchedArticle && matchedArticle.source && matchedArticle.source !== "Unknown") ? matchedArticle.source : getDomain(url);
        let finalUrl = buildTrackingUrl_(url, userEmail, keyword);
        return `<a href="${finalUrl}" target="_blank" style="${badgeStyle}">[ ${sourceName} ]</a>`;
      }).join(" ");
    },

    renderSingleTopicBlock: function(topic, linksBadgeString, keyword, options) {
      let block = `### ${topic.title || keyword}\n`;
      if (topic.summary) block += `- **概要:** ${topic.summary}\n`;
      return block + `- **影響:** ${topic.impact || "なし"}\n- **SOURCES:** ${linksBadgeString}`;
    },

    /** 👑👑👑 [v2.0 究極のユニバーサル目次ジェネレータ]
     * キャプション画像通りの「日本語タイトルがずらりと並びジャンプするインテリジェンス目次」を完全再構築！
     */
    injectTrendReportToc: function(finalHtmlBody, options) {
      if (options.isHtmlOutput) {
        return finalHtmlBody.replace('[[TOC_PLACEHOLDER]]', '');
      }

      let tocHtml = `<div style="padding:15px; border-radius:8px; margin-bottom:20px; border:1px solid #3498db; border-left:4px solid #3498db; background-color:#fff;">\n<strong style="color:#3498db; font-size:16px;">&#128209; 本日のラインナップ（目次ジャンプ）</strong>\n`;
      let topicIndex = 0;
      let hasTopics = false;
      let lastKw = "";

      // 1. まずキーワードのセクション境界線（H2）を検挙して目次枠のグループを定義
      let processedBody = finalHtmlBody.replace(/<h2([^>]*?)data-section-kw="([^"]+)"([^>]*?)>(.*?)<\/h2>/g, (match, before, kw, after, text) => {
        hasTopics = true;
        if (kw !== lastKw) {
          if (lastKw !== "") tocHtml += `</ul>\n`;
          tocHtml += `<div style="font-weight: bold; color: ${C.PRIMARY}; margin-top: 12px; margin-bottom: 4px; font-size: 14px;">■ ${kw}</div>\n`;
          tocHtml += `<ul style="margin: 0; padding-left: 20px; list-style-type: disc;">\n`;
          lastKw = kw;
        }
        return match;
      });
      
      if (!hasTopics) return finalHtmlBody.replace('[[TOC_PLACEHOLDER]]', '');

      // 2. 本文内のすべてのカード見出し（H3）をユニバーサルスキャンして日本語目次リストを完全合体！
      let finalBody = processedBody.replace(/<h3([^>]*?)>([\s\S]*?)<\/h3>/g, (match, attrs, titleText) => {
        if (titleText.includes("AI Trend Analysis") || titleText.trim() === "") return match;

        const cleanTitle = titleText.replace(/<[^>]+>/g, '').trim();
        // 最上部のジャンプ用リストへ追記
        tocHtml += `<li style="margin-bottom: 5px; line-height: 1.4;"><a href="#topic-${topicIndex}" style="color:#3498db; text-decoration:none; font-size:13px; font-weight:bold;">・ ${cleanTitle}</a></li>\n`;

        // 本文の見出しにアンカーID（id="topic-X"）を刻印
        return `<h3 id="topic-${topicIndex++}"${attrs}>${titleText}</h3>`;
      });

      tocHtml += `</ul>\n`;
      tocHtml += `</div>\n`;

      return finalBody.replace('[[TOC_PLACEHOLDER]]', tocHtml);
    },

    injectDailyDigestToc: function(reportBody) {
      let tocHtml = `<div style="background:#f4f6f9; padding:15px; border-radius:8px; margin-bottom:20px; border-left:4px solid #3498db;">\n<strong style="color:#2c3e50; font-size:16px;">&#128209;本日のラインナップ</strong><ul style="margin-top:10px; padding-left:20px; padding-bottom:0;">\n`;
      let topicIndex = 0;
      let hasMatches = false;

      let processedBody = reportBody.replace(/<h3[^>]*>・\s*(.*?)(?=\s*\(重要度:)/g, (match, titleText) => {
        hasMatches = true;
        tocHtml += `<li style="margin-bottom:8px;"><a href="#topic-${topicIndex++}" style="color:#0066cc; text-decoration:none; font-size:14px; font-weight:bold;">・ ${titleText}</a></li>\n`;
        return match; 
      });
      tocHtml += `</ul></div>\n`;

      topicIndex = 0;
      let finalHtml = processedBody.replace(/<h3/g, () => `<h3 id="topic-${topicIndex++}"`);
      return hasMatches ? finalHtml.replace(/(<div[^>]*>)/, `$1\n${tocHtml}`) : finalHtml;
    },

    wrapFinalEmailOuterSkin: function(headerLine, bodyContent, options) {
      const footerMd = AppConfig.get().Messages.LINK_MORE_MD.replace("${url}", AppConfig.get().Digest.sheetUrl);
      const htmlHeader = headerLine ? headerLine.replace(/\n/g, '<br>') + "<br><br>" : "";

      if (options.isLetterMode) {
        return `<div style="font-family: sans-serif; font-size: 15px; line-height: 1.6; color: inherit;">${htmlHeader}${bodyContent}</div>`;
      }
      
      const fontStyle = "font-family: Meiryo, 'Hiragino Sans', 'MS PGothic', sans-serif; font-size: 14px; line-height: 1.7; color: #333;";
      if (options.isHtml) {
        return `<div style="${fontStyle}">${htmlHeader}${bodyContent}<br><br>${markdownToHtml_(`\n---\n${footerMd}`)}</div>`;
      }
      
      return `<div style="${fontStyle}">${htmlHeader}<br><br>${markdownToHtml_(bodyContent + `\n\n---\n${footerMd}`)}</div>`;
    },

    getRedirectPageHtml: function(htmlSafeUrl) {
      return `
        <!DOCTYPE html><html><head><base target="_top"><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, sans-serif; text-align: center; padding-top: 15vh; background: #f4f6f9; margin: 0; }
          .icon { font-size: 48px; margin-bottom: 15px; }
          .title { color: #2c3e50; margin-bottom: 30px; font-size: 18px; }
          .btn { display: inline-block; padding: 16px 40px; background-color: #3498db; color: white; text-decoration: none; border-radius: 30px; font-weight: bold; font-size: 18px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); transition: 0.2s; }
          .btn:active { transform: scale(0.95); }
          .note { margin-top: 25px; font-size: 12px; color: #95a5a6; }
        </style></head>
        <body><div class="icon">&#128279;</div><div class="title">アクセスを記録しました</div>
        <a href="${htmlSafeUrl}" class="btn">記事を読む</a><p class="note">※GASのセキュリティ仕様により、1クリックご協力をお願いしています。</p></body></html>`;
    },

    getFeedbackPageHtml: function() {
      return `
        <div style="font-family:sans-serif; text-align:center; padding:50px; color:#2c3e50;">
          <h2 style="color:#3498db;">&#128077; Thank You!</h2><p>フィードバックを記録しました。</p>
          <button onclick="window.close()" style="margin-top:20px; padding:10px 20px;">閉じる</button>
        </div>`;
    }
  };
})();