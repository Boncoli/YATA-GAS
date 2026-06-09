/**
 * @file YATA.js - AI-Driven News Intelligence Platform
 * @version 2.0.0 (2026-06-09)
 * @description 【責務】システム全体のワークフロー制御（オーケストレーション）とジョブ実行。
 */
// 💡 Node.jsでのローカル実行用ブリッジ
if (typeof SpreadsheetApp === 'undefined' && typeof require !== 'undefined') {
  require('./gas-bridge.js');
}

/**
 * @description RSSを巡回し、最新記事を収集。AI要約は行いません。
 */
function runCollectionJob() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(AppConfig.get().System.TimeLimit.LOCK_TIMEOUT)) return;

  try {
    Logger.log("--- 収集ジョブ開始 ---");
    const startTime = new Date().getTime();
    const timeLimit = AppConfig.get().System.TimeLimit.COLLECTION;
    const props = PropertiesService.getScriptProperties();
    const runScrapersFirst = props.getProperty("PRIORITY_SCRAPERS") === "TRUE";

    if (runScrapersFirst) {
      Scraper.collectScrapedFeeds();
      if (new Date().getTime() - startTime < timeLimit) {
        Scraper.collectRssFeeds();
        props.setProperty("PRIORITY_SCRAPERS", "FALSE");
      }
    } else {
      Scraper.collectRssFeeds();
      if (new Date().getTime() - startTime < timeLimit) {
        Scraper.collectScrapedFeeds();
        props.setProperty("PRIORITY_SCRAPERS", "FALSE");
      } else {
        props.setProperty("PRIORITY_SCRAPERS", "TRUE");
      }
    }

    LlmService.logSessionTotal();
    LlmService.saveSessionCost();
    Logger.log("--- 収集ジョブ完了 ---");
  } catch (e) {
    Logger.log("収集ジョブエラー: " + e.toString());
  } finally {
    lock.releaseLock();
  }
}

/**
 * 🌟 [新設] スクレイピングサイト（Scrapers）だけを単独で巡回する実行用ジョブ
 */
function runScraperCollectionOnlyJob() {
  Scraper.collectScrapedFeeds();
}

/**
 * @description PubMedの深掘り収集ジョブ。
 */
function runPubMedJob() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(AppConfig.get().System.TimeLimit.LOCK_TIMEOUT)) return;

  try {
    Logger.log("--- 🔬 PubMed Deep Collection Job 開始 ---");
    const config = AppConfig.get();
    const usersSheet = Repository.getSheet(config.SheetNames.USERS);
    if (!usersSheet) return;

    const usrCols = config.UsersSheet.Columns;
    const users = usersSheet.getDataRange().getValues();
    const seenKeywords = new Set();
    
    for (let i = 1; i < users.length; i++) {
      const user = users[i];
      if (user[usrCols.PUBMED - 1] === true || String(user[usrCols.PUBMED - 1]).toUpperCase() === "TRUE") {
        const kws = String(user[usrCols.KWS - 1] || "").split(',').map(k => k.trim());
        kws.forEach(kw => {
          if (kw && !seenKeywords.has(kw)) {
            collectPubMedFeeds_(kw); 
            seenKeywords.add(kw);
          }
        });
      }
    }

    LlmService.logSessionTotal(); 
    Logger.log("--- 🔬 PubMed Deep Collection Job 完了 ---");
  } catch (e) {
    Logger.log("PubMedジョブエラー: " + e.toString());
  } finally {
    LlmService.saveSessionCost(); 
    lock.releaseLock();
  }
}

/**
 * @description 未要約記事のAI要約とベクトル化。
 */
function runSummarizationJob() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(AppConfig.get().System.TimeLimit.LOCK_TIMEOUT)) return;

  try {
    Logger.log("--- 要約ジョブ開始 ---");
    processSummarization_();  // ETL指揮
    LlmService.logSessionTotal();
    Logger.log("--- 要約ジョブ完了 ---");
  } catch (e) {
    Logger.log("要約ジョブエラー: " + e.toString());
  } finally {
    LlmService.saveSessionCost();
    lock.releaseLock();
  }
}

/**
 * @description 予兆（Emerging Signal）検知ジョブ。
 */
function runEmergingSignalJob() {
  Logger.log("--- 予兆（サイン）検知ジョブ開始 ---");
  try {
    const report = EmergingSignalEngine.detect();
    if (report && report.html) {
      sendDigestEmail_(null, report.html, null, 1, {
        recipient: AppConfig.get().Digest.mailTo,
        isHtml: true,
        subjectOverride: `【YATA 予兆検知】Emerging Signal Report (${fmtDate_(new Date())})`
      });
    }
    LlmService.logSessionTotal();
    LlmService.saveSessionCost();
  } catch (e) {
    _logError_("runEmergingSignalJob", e);
  }
  Logger.log("--- 予兆（サイン）検知ジョブ完了 ---");
}

/**
 * 配信・レポート系（DeliveryServiceへ委譲）
 */
function dailyDigestJob() { DeliveryService.runDailyDigest(); }
function sendPersonalizedReport() { DeliveryService.sendPersonalizedReport(); }
function runMonthlyPartnerReport() { DeliveryService.runMonthlyPartnerReport(); }

/**
 * @description 毎時トリガーの割り振り（ディスパッチャー）
 * 【最適化】JSON化された YATA_SYSTEM_STATE を読み書きするように変更
 */
function jobDispatcher() {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  const props = PropertiesService.getScriptProperties();
  
  // 🌟 JSONから状態を読み込む (ジョブ判定用)
  let systemState = {};
  try {
    systemState = JSON.parse(props.getProperty("YATA_SYSTEM_STATE") || "{}");
  } catch(e) {}

  const lastJob = systemState.LAST_DISPATCHED_JOB;

  if (lastJob !== "COLLECTION") {
    if (hour === 3 && (day === 3 || day === 6)) {
      runPubMedJob();
    } else {
      runCollectionJob();
    }
    
    // 🚨 【修正】ジョブ実行中に別の関数が書き換えた最新データを再取得する
    try { systemState = JSON.parse(props.getProperty("YATA_SYSTEM_STATE") || "{}"); } catch(e) {}
    
    systemState.LAST_DISPATCHED_JOB = "COLLECTION";
    props.setProperty("YATA_SYSTEM_STATE", JSON.stringify(systemState));
    
  } else {
    runSummarizationJob();
    
    // 🚨 【修正】ジョブ実行中に別の関数が書き換えた最新データを再取得する
    try { systemState = JSON.parse(props.getProperty("YATA_SYSTEM_STATE") || "{}"); } catch(e) {}
    
    systemState.LAST_DISPATCHED_JOB = "SUMMARIZATION";
    props.setProperty("YATA_SYSTEM_STATE", JSON.stringify(systemState));
  }
}

/**
 * メンテナンス系（Repositoryへ委譲）
 */
function runDailyMaintenance() { Repository.runDailyMaintenance(); }
function runHeavyMaintenance() {
  Logger.log("--- トラッキングログ集計・退避ジョブ開始 ---");
  Repository.archiveActionLogsToDrive();
  Logger.log("--- トラッキングログ集計・退避ジョブ完了 ---");
}

/**
 * processSummarization_ (ETLオーケストレーション)
 */
function processSummarization_() {
  const startTime = new Date().getTime();
  const TIME_LIMIT_MS = AppConfig.get().System.TimeLimit.SUMMARIZATION;

  const extractResult = Repository.extractArticlesForSummarization(startTime, TIME_LIMIT_MS);
  if (!extractResult) return;

  const { values, news, papers, state, maxCol, sheet } = extractResult;

  LlmService.processSummarizationBatch(news, false, values, state, startTime, TIME_LIMIT_MS);
  LlmService.processSummarizationBatch(papers, true, values, state, startTime, TIME_LIMIT_MS);

  Repository.loadSummarizedArticles(sheet, values, state, maxCol);
}

// グローバル公開（GASトリガー・UI用）
if (typeof global !== 'undefined') {
  global.runCollectionJob = runCollectionJob;
  global.runSummarizationJob = runSummarizationJob;
  global.runPubMedJob = runPubMedJob;
  global.runEmergingSignalJob = runEmergingSignalJob;
  global.dailyDigestJob = dailyDigestJob;
  global.sendPersonalizedReport = sendPersonalizedReport;
  global.runMonthlyPartnerReport = runMonthlyPartnerReport;
  global.jobDispatcher = jobDispatcher;
  global.runDailyMaintenance = runDailyMaintenance;
  global.runHeavyMaintenance = runHeavyMaintenance;
}
