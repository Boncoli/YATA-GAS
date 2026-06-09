/**
 * @file YATA-Tools.js
 * @description 【責務】通常稼働時以外に使用する、保守・検証・復旧用ツールの集約。
 * 【主要機能】システムプロパティ初期化、一括バックフィル、スクレイパー診断、内部ロジックの一括テスト。
 */

/**
 * initializeSystemProperties
 * 【責務】YATAの動作に必要なすべてのスクリプトプロパティを初期化・診断する
 * 【最適化】プロパティの50個制限を回避するため、チューニング設定とシステム状態をJSONにグループ化
 */
function initializeSystemProperties() {
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperties();
  const toSet = {};
  
  // 1. YATA_ESSENTIALS (🌟インフラの物理的なIDとAPI鍵だけに絞り、プロパティ数を大削減)
  const essentialsMap = {
    "EXECUTION_CONTEXT": "PERSONAL",
    "DATA_SHEET_ID": "YOUR_SHEET_ID",
    "CONFIG_SHEET_ID": "YOUR_SHEET_ID",
    "ARCHIVE_FOLDER_ID": "YOUR_FOLDER_ID",
    "OPENAI_API_KEY_PERSONAL": "",
    "AZURE_API_KEY": "",
    "AZURE_ENDPOINT_BASE": "https://YOUR_RESOURCE.openai.azure.com/",
    "GEMINI_API_KEY": "",
    "AZURE_EMBEDDING_ENDPOINT": "",
    "PROMPT_JSON_FILE_ID": ""
  };

  // 2. YATA_TUNING_CONFIG (滅多に変えないチューニング設定：1つのJSONにまとめる)
  const tuningConfig = {
    SYSTEM_EXCHANGE_RATE: "158.0",
    SYSTEM_RATE_NANO_IN: "0.050",
    SYSTEM_RATE_NANO_OUT: "0.200",
    SYSTEM_RATE_MINI_IN: "0.40",
    SYSTEM_RATE_MINI_OUT: "1.600",
    SYSTEM_RATE_EMBEDDING_IN: "0.020",
    SYSTEM_RATE_GEMINI_IN: "0.010",
    SYSTEM_RATE_GEMINI_OUT: "0.040",
    SYSTEM_THRESHOLD_SEMANTIC: "0.32",
    SYSTEM_THRESHOLD_HISTORY: "0.85",
    SYSTEM_THRESHOLD_DUPLICATE: "0.85",
    SYSTEM_REASONING_NANO: "low",
    SYSTEM_REASONING_MINI: "medium",
    SYSTEM_VERBOSITY_NANO: "low",
    SYSTEM_VERBOSITY_MINI: "low",
    SYSTEM_SIGNAL_OUTLIER: "0.72",
    SYSTEM_SIGNAL_NUCLEUS: "0.80",
    SYSTEM_SIGNAL_MIN_SOURCES: "2",
    SYSTEM_LIMIT_ITEMS_FEED: "10",
    SYSTEM_LIMIT_BATCH_SIZE: "5",
    SYSTEM_LIMIT_RETENTION_DAYS: "120",
    SYSTEM_WEB_SUMMARY_MAX_CHARS: "1500",
    SYSTEM_WEB_SUMMARY_MIN_CHARS: "50",
    SYSTEM_MIN_ABSTRACT_LENGTH_EN: "250",
    SYSTEM_MIN_ABSTRACT_LENGTH_JA: "150",
    // 🌟 AIモデルの引っ越し先として受け皿を追記
    OPENAI_MODEL_NANO: "gpt-5-nano",
    OPENAI_MODEL_MINI: "gpt-5-mini",
    OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
    EMBEDDING_DIMENSIONS: "256",
    // 🌟 追加：新設プロパティの初期マージ用の受け皿を追記
    LLM_PRIORITY_ORDER: ["AZURE", "OPENAI", "GEMINI"],
    GEMINI_MODEL_NANO: "gemini-2.5-flash-lite",
    GEMINI_MODEL_MINI: "gemini-2.5-pro"
  };

  // 3. YATA_SYSTEM_STATE (システムが自動で読み書きする状態：1つのJSONにまとめる)
  const defaultSystemState = {
    LAST_DISPATCHED_JOB: "",
    RSS_COLLECTION_NEXT_INDEX: "0",
    SYSTEM_COST_ACCUMULATOR: "0",
    SYSTEM_COST_LAST_RESET: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM")
  };

  let addedCount = 0;
  let missingInfoCount = 0;

  Logger.log("--- 🛠️ YATA システム構成診断・初期化開始 (JSON最適化版) ---");
  
  // Essentialsの診断・作成
  Logger.log("\n[ 📂 Essentials & Infrastructure ]");
  for (const [key, value] of Object.entries(essentialsMap)) {
    if (!(key in current)) {
      toSet[key] = value;
      addedCount++;
      const status = (value === "" || value.includes("YOUR_")) ? "🆕 要設定" : "🆕 初期化";
      if (status.includes("要設定")) missingInfoCount++;
      
      // 🔒 セキュリティ対策: 実値（value）はログに出力せず、キー名とステータスのみ出力
      Logger.log(`[${status}] ${key}`);
    } else {
      const val = current[key];
      const status = (val === "" || val.includes("YOUR_")) ? "❌ 未設定" : "✅ 設定済";
      if (status.includes("❌")) missingInfoCount++;
      
      // 🔒 セキュリティ対策: 実値（val）はログに出力せず、キー名とステータスのみ出力
      Logger.log(`[${status}] ${key}`);
    }
  }

  // 🌟 配信関連の初期設定JSON
  const defaultDeliveryConfig = {
    MAIL_TO: "your-email@example.com",
    MAIL_SENDER_NAME: "YATA (AI Intelligence Bot)",
    MAIL_SUBJECT_PREFIX: "[YATA]",
    NOTIFY_CHANNEL_WEEKLY: "email",
    DIGEST_DAYS: "7",
    DIGEST_TOP_N: "20",
    DIGEST_SHEET_URL: ""
  };

  if (!current["YATA_DELIVERY_CONFIG"]) {
    toSet["YATA_DELIVERY_CONFIG"] = JSON.stringify(defaultDeliveryConfig);
    Logger.log("\n[ 📧 Delivery Config ] 🆕 JSONとして新規作成しました。");
    addedCount++;
  } else {
    // 🌟 [安全マージ構造] 人間が手動設定したメールアドレス等の変更を永久に保護
    try {
      const existingDelivery = JSON.parse(current["YATA_DELIVERY_CONFIG"]);
      let isDeliveryUpdated = false;
      
      for (const [key, value] of Object.entries(defaultDeliveryConfig)) {
        if (!(key in existingDelivery)) {
          existingDelivery[key] = value;
          isDeliveryUpdated = true;
          Logger.log(`   ➔ [🆕 キー自動追加] YATA_DELIVERY_CONFIG ➔ ${key}`);
        }
      }
      if (isDeliveryUpdated) {
        toSet["YATA_DELIVERY_CONFIG"] = JSON.stringify(existingDelivery);
        addedCount++;
      }
    } catch(e) {
      Logger.log("⚠️ YATA_DELIVERY_CONFIG のマージ処理でパースエラーが発生しました。");
    }
    Logger.log("[ ⚙️ Delivery Config ] ✅ 既存の配信設定を保護しました。");
  }

  // JSONプロパティの初期化 (まだ存在しなければ作る)
  if (!current["YATA_TUNING_CONFIG"]) {
    toSet["YATA_TUNING_CONFIG"] = JSON.stringify(tuningConfig);
    Logger.log("\n[ ⚙️ Tuning Config ] 🆕 JSONとして新規作成しました。");
    addedCount++;
  } else {
    // 🌟 [安全マージ構造] 既存の値を1ミリも上書き破壊せず、新設されたキー(モデル名など)だけを自動追記
    try {
      const existingTuning = JSON.parse(current["YATA_TUNING_CONFIG"]);
      let isTuningUpdated = false;
      
      for (const [key, value] of Object.entries(tuningConfig)) {
        if (!(key in existingTuning)) {
          existingTuning[key] = value;
          isTuningUpdated = true;
          Logger.log(`   ➔ [🆕 キー自動追加] YATA_TUNING_CONFIG ➔ ${key}: ${value}`);
        }
      }
      if (isTuningUpdated) {
        toSet["YATA_TUNING_CONFIG"] = JSON.stringify(existingTuning);
        addedCount++;
      }
    } catch(e) {
      Logger.log("⚠️ YATA_TUNING_CONFIG のマージ処理でパースエラーが発生しました。");
    }
    Logger.log("[ ⚙️ Tuning Config ] ✅ 既存のJSON設定の保護とマージが完了しました。");
  }

  if (!current["YATA_SYSTEM_STATE"]) {
    toSet["YATA_SYSTEM_STATE"] = JSON.stringify(defaultSystemState);
    Logger.log("[ 🤖 System State ] 🆕 JSONとして新規作成しました。");
    addedCount++;
  } else {
    Logger.log("[ 🤖 System State ] ✅ JSONとして設定済みです。");
  }

  // まとめてプロパティにセット
  if (addedCount > 0) {
    props.setProperties(toSet, false);
    Logger.log(`\n📝 ${addedCount} 個のプロパティ(JSON含む)を新規に作成しました。`);
  }

  // (スプレッドシートの自動構築ロジック等は長いのでここでは省略していますが、元のコードのままでOKです。
  // 必要であれば元の setupSheet ロジックをこの下に残してください)

  Logger.log("--- 診断終了 ---");
}


/**
 * backfillVectors (メモリ最適化版)
 * 【責務】ベクトル未付与の記事に対してEmbeddingを一括実行
 * 【最適化】日付列だけを先にスキャンし、対象期間（直近30日）のデータのみをメモリに展開する。
 */
function backfillVectors() {
  const trendDataSheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  if (!trendDataSheet) return;
  const lastRow = trendDataSheet.getLastRow();
  if (lastRow < 2) return;

  const TARGET_WINDOW_DAYS = AppConfig.get().System.Limits.VECTOR_GEN_DAYS; 
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - TARGET_WINDOW_DAYS);

  const VECTOR_COL_INDEX = AppConfig.get().CollectSheet.Columns.VECTOR - 1;
  const METHOD_VECTOR_COL_INDEX = AppConfig.get().CollectSheet.Columns.METHOD_VECTOR - 1;
  const SUMMARY_COL_INDEX = AppConfig.get().CollectSheet.Columns.SUMMARY - 1;
  const TITLE_COL_INDEX = AppConfig.get().CollectSheet.Columns.URL - 2;

  const dateValues = trendDataSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let targetRowCount = 0;
  for (let i = 0; i < dateValues.length; i++) {
    if (new Date(dateValues[i][0]) < thresholdDate) { targetRowCount = i; break; }
    targetRowCount = i + 1;
  }
  if (targetRowCount === 0) return;

  const maxCol = Math.max(trendDataSheet.getLastColumn(), VECTOR_COL_INDEX + 1, (METHOD_VECTOR_COL_INDEX + 1 || 0));
  const dataRange = trendDataSheet.getRange(2, 1, targetRowCount, maxCol);
  const values = dataRange.getValues();
  
  let processedCount = 0;
  let minIdx = -1; let maxIdx = -1;

  for (let i = 0; i < values.length; i++) {
    const headline = values[i][SUMMARY_COL_INDEX];
    if (headline && String(headline).trim() !== "") {
      let updated = false;
      const parsed = cleanAndParseJSON_(headline);
      if (!values[i][VECTOR_COL_INDEX]) {
        const kw = (parsed && parsed.keywords) ? (Array.isArray(parsed.keywords) ? parsed.keywords.join(' ') : parsed.keywords) : headline;
        const v = LlmService.generateVector(`Title: ${values[i][TITLE_COL_INDEX]}\nKeywords: ${kw}`);
        if (v) { values[i][VECTOR_COL_INDEX] = v.join(','); updated = true; }
      }
      if (METHOD_VECTOR_COL_INDEX > 0 && !values[i][METHOD_VECTOR_COL_INDEX]) {
        // 🌟 APIコスト削減: 既存のJSON(parsed)からHow/Whatを抽出して再利用（LLMの2回目コールを廃止）
        let mDesc = "Unknown";
        if (parsed) {
          const h = (parsed.how && parsed.how !== "Unknown") ? parsed.how : "";
          const w = (parsed.what && parsed.what !== "Unknown") ? parsed.what : "";
          const t = (parsed.tldr && parsed.tldr !== "Unknown") ? parsed.tldr : "";
          mDesc = h || w || t || values[i][TITLE_COL_INDEX] || "Unknown";
        } else {
          mDesc = values[i][TITLE_COL_INDEX] || "Unknown";
        }
        const mv = LlmService.generateVector(`Topic: ${values[i][TITLE_COL_INDEX]} / Method: ${mDesc}`);
        if (mv) { values[i][METHOD_VECTOR_COL_INDEX] = mv.join(','); updated = true; }
      }
      if (updated) {
        processedCount++;
        if (minIdx === -1 || i < minIdx) minIdx = i;
        maxIdx = i;
        Utilities.sleep(500);
      }
    }
  }

  if (processedCount > 0) {
    const outputRange = trendDataSheet.getRange(minIdx + 2, 1, maxIdx - minIdx + 1, maxCol);
    outputRange.setValues(values.slice(minIdx, maxIdx + 1));
  }
}

function toolBatchSetupScrapersSilent() {
  const config = AppConfig.get();
  const sheet = getSheet_(config.SheetNames.SCRAPERS);
  
  if (!sheet) {
    Logger.log("エラー: 'Scrapers' シートが見つかりません。");
    return;
  }

  const data = sheet.getDataRange().getValues();
  const targets = [];

  for (let i = 1; i < data.length; i++) {
    const [label, targetUrl, baseUrl, regexStr] = data[i];
    if (targetUrl && !regexStr) {
      targets.push({ 
        rowIndex: i + 1, 
        label: label || "No Name", 
        targetUrl: targetUrl, 
        baseUrl: baseUrl 
      });
    }
  }

  if (targets.length === 0) {
    Logger.log("✅ 未設定の行（URLあり、Regexなし）は見つかりませんでした。すべて設定済みです。");
    return;
  }

  Logger.log(`🚨 ${targets.length} 件の未設定サイトを検出しました。AI解析を開始します...`);

  for (const target of targets) {
    try {
      Logger.log(`⏳ 解析中: ${target.label} (${target.targetUrl})`);

      // 1. HTMLの取得
      const options = { 'muteHttpExceptions': true, 'headers': config.System.HttpHeaders };
      const fetchRes = UrlFetchApp.fetch(target.targetUrl, options);
      let html = fetchRes.getContentText();

      // 💥【修正箇所】ドット繋ぎによる構文エラーを回避するため、1行ずつ確実に処理します
      html = html.replace(/<(style|svg|header|footer|nav|form|aside)[^>]*>([\s\S]*?)<\/\1>/gi, "");
      html = html.replace(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/gi, "");
      html = html.replace(/<\!--[\s\S]*?-->/g, "");
      html = html.replace(/\s{2,}/g, " ");
      html = html.substring(0, 30000);

      // 2. AIに依頼
      const systemPrompt = "あなたはプロフェッショナルなWebクローラー・エンジニアです。";
      const userPrompt = `以下のHTML/JSONソースから、ニュース記事の一覧（URLとタイトル）を抽出するための設定を生成してください。\n\n` +
                         `【解析の極意】\n` +
                         `1. 静的な <a> タグだけでなく、<script> 内の JSON データ（__NEXT_DATA__ 等）に記事リストが隠れていないか徹底的に探してください。\n` +
                         `2. リンク先が .pdf で終わるものは、この業界では重要なニュースリリースです。逃さず抽出対象にしてください。\n` +
                         `3. 日本の企業サイトは 2025 や 2026 といった年号がパスやタイトルに含まれることが多いです。それを目印にしてください。\n\n` +
                         `【出力形式 (JSONのみ)】\n` +
                         `{\n` +
                         `  "regex": "JavaScript用正規表現 (URLを第1グループ、タイトルを第2グループにすること。JSON内の場合はエスケープに注意)",\n` +
                         `  "urlGroup": 1,\n` +
                         `  "titleGroup": 2,\n` +
                         `  "suggestedBaseUrl": "相対パス補完用のベースURL"\n` +
                         `}\n\n` +
                         `【条件】\n` +
                         `- ニュース見出しとリンク(<a>)を正確に抽出する正規表現を作成してください。\n` +
                         `- HTMLソース:\n${html}`;

      const aiResponse = LlmService.analyzeKeywordSearch(systemPrompt, userPrompt, { model: "mini", taskLabel: "Scraper正規表現自動生成" });

      // 3. レスポンスの解析 (JSON抽出)
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        Logger.log(`❌ 失敗: ${target.label} (AIからJSONが返されませんでした)`);
        continue;
      }

      const result = JSON.parse(jsonMatch[0]);

      // 4. シートへの書き戻し
      if (!target.baseUrl && result.suggestedBaseUrl) {
        sheet.getRange(target.rowIndex, 3).setValue(result.suggestedBaseUrl);
      }
      sheet.getRange(target.rowIndex, 4).setValue(result.regex);
      sheet.getRange(target.rowIndex, 5).setValue(result.urlGroup || 1);
      sheet.getRange(target.rowIndex, 6).setValue(result.titleGroup || 2);
      sheet.getRange(target.rowIndex, 7).setValue(true); // Active化

      Logger.log(`✨ 成功: ${target.label} の正規表現を自動設定しました！`);

    } catch (e) {
      Logger.log(`❌ エラー: ${target.label} - ${e.message}`);
    }
    
    // APIの制限対策で少し休む
    Utilities.sleep(2000);
  }

  Logger.log("🎉 すべての処理が完了しました！Scrapersシートを確認してください。");
}

/**
 * 【運用ツール】Scrapersシートの内容をJSONに変換し、Driveのマスターファイルを上書き更新する
 */
function toolExportScrapersToJson() {
  const sheet = getSheet_(AppConfig.get().SheetNames.SCRAPERS);
  if (!sheet) {
    Logger.log("Scrapersシートが見つかりません。");
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    Logger.log("エクスポートするデータがありません。");
    return;
  }

  const jsonArray = [];
  
  // 1行目はヘッダーなので2行目からループ
  for (let i = 1; i < data.length; i++) {
    const [label, targetUrl, baseUrl, regexStr, urlGroup, titleGroup, active] = data[i];
    
    // ラベルとURLがある行だけ保存
    if (label && targetUrl) {
      jsonArray.push({
        label: String(label),
        targetUrl: String(targetUrl),
        baseUrl: String(baseUrl || ""),
        regex: String(regexStr || ""),
        urlGroup: parseInt(urlGroup) || 1,
        titleGroup: parseInt(titleGroup) || 2,
        active: (active === true || String(active).toUpperCase() === "TRUE" || String(active) === "〇")
      });
    }
  }

  const fileId = PropertiesService.getScriptProperties().getProperty("SCRAPERS_JSON_FILE_ID");
  if (!fileId) {
    Logger.log("⚠️ エラー: SCRAPERS_JSON_FILE_ID が設定されていません。Driveに空のJSONファイルを作成し、IDを設定してください。");
    return;
  }

  try {
    const file = DriveApp.getFileById(fileId);
    file.setContent(JSON.stringify(jsonArray, null, 2));
    Logger.log(`✅ ${jsonArray.length} 件のスクレイパー設定をDriveのJSONファイルに上書き保存しました！`);
  } catch (e) {
    Logger.log(`❌ JSONファイルの更新に失敗しました: ${e.toString()}`);
  }
}

/**
 * toolExportArchivesToSheet
 * 【役割】Driveに保存された過去のJSONアーカイブをすべて読み込み、
 * 「Restored_Archive」という新しいシートにリスト化して復元する。
 * 日付フォーマット (yyyy/MM/dd H:mm:ss)
 */
function toolExportArchivesToSheet() {
  const config = AppConfig.get();
  const folderId = config.System.Archive.FOLDER_ID; 
  const targetSheetId = config.System.DataSheetId; 

  if (!folderId) {
    Logger.log("エラー: アーカイブフォルダIDが設定されていません。");
    return;
  }
  if (!targetSheetId) {
    Logger.log("エラー: データシートIDが設定されていません。");
    return;
  }

  const ss = SpreadsheetApp.openById(targetSheetId);
  let sheet = ss.getSheetByName("Restored_Archive");
  
  if (!sheet) {
    sheet = ss.insertSheet("Restored_Archive");
    sheet.appendRow(["Date", "Title", "URL", "Abstract", "Summary", "Source", "Vector"]);
    sheet.getRange(1, 1, 1, 7).setFontWeight("bold").setBackground("#ddd");
  } else {
    sheet.clear();
    sheet.appendRow(["Date", "Title", "URL", "Abstract", "Summary", "Source", "Vector"]);
    sheet.getRange(1, 1, 1, 7).setFontWeight("bold").setBackground("#ddd");
  }

  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles();
  
  let totalCount = 0;
  const timeZone = Session.getScriptTimeZone(); // タイムゾーン取得

  Logger.log("アーカイブの読み込みを開始します...");

  while (files.hasNext()) {
    const file = files.next();
    
    if (file.getMimeType() === MimeType.PLAIN_TEXT && file.getName().startsWith("YATA_Archive_")) {
      try {
        const jsonText = file.getBlob().getDataAsString();
        const data = JSON.parse(jsonText); 
        
        if (data && data.length > 0) {
          // ここで日付フォーマット変換を追加
          const formattedData = data.map(row => {
            // 1列目(row[0])が日付文字列の場合のみ変換
            if (row[0]) {
              const d = new Date(row[0]);
              // "2026/01/06 2:57:01" の形式に変換
              row[0] = Utilities.formatDate(d, timeZone, "yyyy/MM/dd H:mm:ss");
            }
            return row;
          });

          const startRow = sheet.getLastRow() + 1;
          const numRows = formattedData.length;
          const numCols = formattedData[0].length;
          
          sheet.getRange(startRow, 1, numRows, numCols).setValues(formattedData);
          
          totalCount += numRows;
          Logger.log(`[復元] ${file.getName()}: ${numRows} 件を追加しました。`);
        }
      } catch (e) {
        Logger.log(`[エラー] ${file.getName()} の読み込みに失敗: ${e.message}`);
      }
    }
  }

  Logger.log(`完了: 合計 ${totalCount} 件のデータを「Restored_Archive」シートに復元しました。`);
  Logger.log(`以下のスプレッドシートを確認してください:\n${ss.getUrl()}`);
}


/**
 * 過去記事の再構造化（5W1H JSON化）バックフィル [バッチ処理版]
 * E列がJSON形式でない記事を特定し、5件ずつまとめて再要約・構造化を行います。
 * @param {number} totalLimit 処理する総件数の上限 (デフォルト 50)
 * @param {number} batchSize 1回にまとめる件数 (デフォルト 5)
 */
function toolBackfillStructuredSummaries(totalLimit = 100, batchSize = 5) {
  const sheetName = AppConfig.get().SheetNames.TREND_DATA;
  
  // 🌟 SpreadsheetApp.getActiveSpreadsheet() をやめて、専用ヘルパーを使う
  const sh = getSheet_(sheetName);
  if (!sh) {
    Logger.log(`エラー: シート「${sheetName}」が見つかりません。`);
    return;
  }
  
  const data = sh.getDataRange().getValues();
  const C = AppConfig.get().CollectSheet.Columns;
  
  let totalCount = 0;
  let currentBatch = []; // { rowIdx, title, text }

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const currentHeadline = String(row[C.SUMMARY - 1] || "").trim();
    const abstractText = String(row[C.ABSTRACT - 1] || "").trim();
    const title = String(row[C.URL - 2] || "").trim();
    const tldrText = String(row[C.TLDR - 1] || "").trim(); // 🌟 I列 (TLDR) の値を取得

    // 🌟 新判定ロジック: I列(TLDR)が空っぽ、かつ、E列(SUMMARY)に何かが入っている記事を狙い撃ち
    if (tldrText === "" && currentHeadline !== "") {
      
      // 💡 もしD列(元記事)が空でも、E列の古い要約文を素材にして再要約できるようにしておく安全策
      const sourceText = abstractText.length > 50 ? abstractText : currentHeadline;

      currentBatch.push({
        rowIdx: i + 1,
        title: title,
        text: `Title: ${title}\nAbstract: ${sourceText}`
      });
    }

    // バッチが溜まった、または最後の場合に処理実行
    if (currentBatch.length >= batchSize || (i === data.length - 1 && currentBatch.length > 0)) {
      if (currentBatch.length === 0) continue;
      
      Logger.log(`[Backfill] ${currentBatch.length}件のバッチを処理中... (Total: ${totalCount})`);
      
      try {
        // 🌟 修正ポイント: 自前の連結をやめ、強力な専用バッチエンジンに任せる
        const articleTexts = currentBatch.map(item => item.text);
        
        // LlmService.summarizeBatch を使えば、文字数上限やJSONパース、リトライを自動でやってくれます
        const batchResults = LlmService.summarizeBatch(articleTexts);

        batchResults.forEach((jsonString, idx) => {
          // ⚠️ 削られていた外側のif文と、JSONパース処理を復活
          if (jsonString && !String(jsonString).includes("API Error")) {
            const parsedJson = cleanAndParseJSON_(jsonString);
            
            if (parsedJson) {
              const targetRow = currentBatch[idx].rowIdx;
              const targetTitle = currentBatch[idx].title;
              
              // 🌟 1. まず、E列(SUMMARY)にJSON文字列そのものを書き込む
              sh.getRange(targetRow, C.SUMMARY).setValue(JSON.stringify(parsedJson));

              // 🌟 2. 次に、I列(TLDR)〜Q列(KEYWORDS)までの9列分を配列化する
              const kwStr = Array.isArray(parsedJson.keywords) ? parsedJson.keywords.join(", ") : (parsedJson.keywords || "");
              const rowData = [[
                parsedJson.tldr || "",
                parsedJson.who || "",
                parsedJson.what || "",
                parsedJson.when || "",
                parsedJson.where || "",
                parsedJson.why || "",
                parsedJson.how || "",
                parsedJson.result || "",
                kwStr
              ]];
              
              // 🌟 3. 作った配列を「1行×9列」の範囲に一括で流し込む！
              sh.getRange(targetRow, C.TLDR, 1, 9).setValues(rowData);
              
              totalCount++;
              Logger.log(`  ✅ 更新: ${targetTitle}`);
            } else {
              Logger.log(`  ⚠️ パース失敗: ${currentBatch[idx].title}`);
            }
          } else {
             Logger.log(`  ❌ 生成エラー: ${currentBatch[idx].title}`);
          }
        });
      } catch (e) {
        Logger.log(`❌ バッチ処理エラー: ${e.message}`);
      }
      
      SpreadsheetApp.flush(); // スプレッドシートをリアルタイム更新

      currentBatch = []; // バッチをクリア
      Utilities.sleep(2000); // バッチ間ウェイト
    }

    if (totalCount >= totalLimit) break;
  }
  
  Logger.log(`🏁 バックフィル完了。総処理件数: ${totalCount}`);
}


/**
 * toolBackfillHistoryVectors
 * 【責務】DigestHistoryシートの既存データ（過去の要約）にベクトルを一括付与する。
 * これを実行すると、過去の履歴も「連想検索」の対象になります。
 */

function toolBackfillHistoryVectors() {
  const sheet = getSheet_(AppConfig.get().SheetNames.DIGEST_HISTORY);
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("履歴データがありません。");
    return;
  }

  // A列(Date)〜C列(Summary)を取得
  // D列(Vector)はこれから書き込むので、範囲外でもOK（なければ拡張される）
  const range = sheet.getRange(2, 1, lastRow - 1, 4); // D列まで確保
  const values = range.getValues();
  
  let updateCount = 0;
  
  // 処理開始
  Logger.log(`履歴のベクトル生成を開始します (対象: ${values.length}件)...`);

  for (let i = 0; i < values.length; i++) {
    const summary = String(values[i][2]).trim(); // C列: Summary
    const currentVector = values[i][3];          // D列: Vector
    
    // 要約があり、かつベクトルがまだ無い場合のみ処理
    if (summary && (!currentVector || String(currentVector) === "")) {
      try {
        // ベクトル生成
        const vector = LlmService.generateVector(summary);
        
        if (vector) {
          values[i][3] = vector.join(','); // D列にセット
          updateCount++;
        }
        
        // APIレート制限考慮 (1秒待機)
        Utilities.sleep(1000);
        
        if (updateCount % 5 === 0) {
          Logger.log(`... ${updateCount} 件 処理完了`);
        }

      } catch (e) {
        Logger.log(`Error at row ${i + 2}: ${e.message}`);
      }
    }
  }

  if (updateCount > 0) {
    // まとめて書き込み
    range.setValues(values);
    Logger.log(`完了: ${updateCount} 件の過去履歴にベクトルを付与しました。`);
  } else {
    Logger.log("全ての履歴に既にベクトルが付与されています。");
  }
}

/**
 * toolArchiveAndClearHistory
 * 【開発・メンテ用】現在のDigestHistoryをJSONとしてDriveに退避し、シートを初期化する。
 * 過去のノイズ（推測・ハルシネーション）が混ざった記憶を一掃し、クリーンな状態で再スタートするためのツール。
 */
function toolArchiveAndClearHistory() {
  const config = AppConfig.get();
  const sheet = getSheet_(config.SheetNames.DIGEST_HISTORY);
  
  if (!sheet) {
    Logger.log("エラー: DigestHistoryシートが見つかりません。");
    return;
  }
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("退避する履歴データがありません（すでに真っ白です）。");
    return;
  }
  
  // 1. データの取得
  const numRows = lastRow - 1;
  const dataRange = sheet.getRange(2, 1, numRows, sheet.getLastColumn());
  const rawData = dataRange.getValues();
  
  // 2. JSONファイルとしてDriveに保存
  const folderId = config.System.Archive.FOLDER_ID;
  const timeZone = Session.getScriptTimeZone();
  const timestamp = Utilities.formatDate(new Date(), timeZone, "yyyyMMdd_HHmmss");
  // 記事アーカイブと区別するためプレフィックスを変更
  const fileName = `YATA_HistoryArchive_${timestamp}.json`; 
  
  try {
    if (folderId && folderId.length > 10) {
      const jsonContent = JSON.stringify(rawData, null, 2);
      const folder = DriveApp.getFolderById(folderId);
      folder.createFile(fileName, jsonContent, MimeType.PLAIN_TEXT);
      Logger.log(`✅ [Drive退避完了] ${numRows}件の履歴を ${fileName} として保存しました。`);
    } else {
      Logger.log("⚠️ フォルダID未設定のため、Drive保存をスキップします。データ保護のため削除は行いません。");
      return;
    }
  } catch (e) {
    Logger.log(`❌ Drive保存エラー: ${e.toString()} (データ保護のため削除は中断します)`);
    return;
  }
  
  // 3. シートの初期化（削除）
  // ヘッダー（1行目）を残して全行削除する
  sheet.deleteRows(2, numRows);
  Logger.log(`🧹 [初期化完了] DigestHistoryシートから ${numRows} 件のデータを削除し、真っ白にしました。`);
}


/**
 * cleanupYataProperties
 * 【レスキュー用】不要な（デフォルト値で代用可能な）チューニングプロパティを一括削除する。
 * 【用途】スクリプトプロパティが50件を超えてUIが編集できなくなった際の「ダイエット」に使用する。
 */
function cleanupYataProperties() {
  const props = PropertiesService.getScriptProperties();
  const keysToDelete = [
    // 既存の削除リスト
    "SYSTEM_EXCHANGE_RATE", "SYSTEM_RATE_NANO_IN", "SYSTEM_RATE_NANO_OUT",
    "SYSTEM_RATE_MINI_IN", "SYSTEM_RATE_MINI_OUT", "SYSTEM_RATE_EMBEDDING_IN",
    "SYSTEM_RATE_GEMINI_IN", "SYSTEM_RATE_GEMINI_OUT",
    "SYSTEM_THRESHOLD_SEMANTIC", "SYSTEM_THRESHOLD_HISTORY",
    "SYSTEM_SIGNAL_OUTLIER", "SYSTEM_SIGNAL_NUCLEUS", "SYSTEM_SIGNAL_MIN_SOURCES",
    "SYSTEM_LIMIT_ITEMS_FEED", "SYSTEM_LIMIT_BATCH_SIZE", "SYSTEM_LIMIT_RETENTION_DAYS",
    "SYSTEM_WEB_SUMMARY_MAX_CHARS", "SYSTEM_MIN_ABSTRACT_LENGTH_EN", "SYSTEM_MIN_ABSTRACT_LENGTH_JA",
    "LAST_DISPATCHED_JOB", "RSS_COLLECTION_NEXT_INDEX", "SYSTEM_COST_ACCUMULATOR", "SYSTEM_COST_LAST_RESET",
    "SYSREM_THRESHOLD_HISTORY", "SYSREM_THRESHOLD_SEMANTIC", "SYSTEM_LIMIT_ITEM_FEED",
    "REASONING_MINI", "REASONING_NANO", "VERBOSITY_MINI", "VERBOSITY_NANO",

    // 🌟 [追加] 引っ越しが完了した古い個別プロパティをここで一網打尽にデリート
    "MAIL_TO", "MAIL_SENDER_NAME", "MAIL_SUBJECT_PREFIX", "NOTIFY_CHANNEL_WEEKLY", 
    "DIGEST_DAYS", "DIGEST_TOP_N", "DIGEST_SHEET_URL", "OPENAI_MODEL_NANO", 
    "OPENAI_MODEL_MINI", "OPENAI_EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS"
  ];

  let count = 0;
  Logger.log("--- 🧹 YATA プロパティ・ダイエット開始 ---");
  keysToDelete.forEach(key => {
    if (props.getProperty(key) !== null) {
      props.deleteProperty(key);
      count++;
      Logger.log(`[DELETE] ${key} を削除しました`);
    }
  });

  Logger.log(`\n✅ 完了: ${count} 個の項目を整理しました。これで設定画面が編集可能になるはずです。`);
}

/**
 * toolFixEnglishSummaries
 * 【開発・メンテ用】英語で出力されてしまった見出しを検知し、再度AI（Nano）で並列要約し直す。
 */
function toolFixEnglishSummaries() {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  if (!sheet) return;
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("データがありません。");
    return;
  }

  // 直近の5000件を対象とする（シート全体だと重いため）
  const SEARCH_LIMIT = AppConfig.get().System.Limits.TOOL_SEARCH_LIMIT || 5000;
  const numRows = Math.min(lastRow - 1, SEARCH_LIMIT);
  
  // 列インデックス
  const TITLE_COL = AppConfig.get().CollectSheet.Columns.URL - 2;
  const ABS_COL = AppConfig.get().CollectSheet.Columns.ABSTRACT - 1;
  const SUM_COL = AppConfig.get().CollectSheet.Columns.SUMMARY - 1;
  const VEC_COL = AppConfig.get().CollectSheet.Columns.VECTOR - 1;
  
  const maxCol = Math.max(sheet.getLastColumn(), VEC_COL + 1);
  const values = sheet.getRange(2, 1, numRows, maxCol).getValues();
  
  const targets = [];
  
  // 1. 英語の要約を検知
  for (let i = 0; i < values.length; i++) {
    const summary = String(values[i][SUM_COL] || "").trim();
    const title = values[i][TITLE_COL];
    const abstractText = values[i][ABS_COL];
    
    // 空でなく、エラーメッセージでもないものを対象
    if (summary && !summary.includes("API Error") && !summary.includes("[Error]")) {
      // isLikelyEnglish = 日本語が含まれていなければ true
      if (isLikelyEnglish_(summary)) {
        targets.push({
          rowIndex: i,
          title: title,
          abstractText: abstractText,
          oldSummary: summary
        });
      }
    }
  }

  if (targets.length === 0) {
    Logger.log("✅ 英語の要約は見つかりませんでした（すべて日本語または正常です）。");
    return;
  }

  Logger.log(`🚨 ${targets.length} 件の「英語の要約」を検出しました。並列再要約を開始します...`);

  // 2. 爆速バッチで再要約
  const BATCH_SIZE = AppConfig.get().System.Limits.LLM_BATCH_SIZE;
  let processedCount = 0;
  let minIdx = -1;
  let maxIdx = -1;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const chunk = targets.slice(i, i + BATCH_SIZE);
    const articleTexts = chunk.map(t => `Title: ${t.title}\nAbstract: ${t.abstractText}`);
    
    Logger.log(`[${i + 1} 〜 ${Math.min(i + BATCH_SIZE, targets.length)} / ${targets.length}] 再要約中...`);
    
    // 先ほど作った並列要約メソッドを再利用！
    const batchResults = LlmService.summarizeBatch(articleTexts);
    
    batchResults.forEach((jsonString, idx) => {
      const target = chunk[idx];
      let newHeadline = null;
      
      if (jsonString && !String(jsonString).includes("API Error")) {
        try {
          const parsedJson = cleanAndParseJSON_(jsonString);
          if (parsedJson) newHeadline = parsedJson.tldr || parsedJson.summary;
          if (!newHeadline) newHeadline = String(jsonString).trim();
        } catch (e) {
          newHeadline = String(jsonString).trim();
        }
      }

      if (newHeadline && !String(newHeadline).includes("API Error") && !String(newHeadline).includes("Safety")) {
        // シートデータ(配列)を更新
        values[target.rowIndex][SUM_COL] = newHeadline;
        
        // 要約（意味）が変わったので、検索にヒットするようにベクトルも作り直す
        const textToEmbed = `Title: ${target.title}\nSummary: ${newHeadline}`;
        const vector = LlmService.generateVector(textToEmbed);
        if (vector) {
          values[target.rowIndex][VEC_COL] = vector.join(',');
        }
        
        // 更新範囲を記録
        if (minIdx === -1 || target.rowIndex < minIdx) minIdx = target.rowIndex;
        if (target.rowIndex > maxIdx) maxIdx = target.rowIndex;
      }
    });

    processedCount += chunk.length;
    if (i + BATCH_SIZE < targets.length) {
      Utilities.sleep(AppConfig.get().System.Limits.LLM_BATCH_DELAY); // APIエラー回避の3秒待機
    }
  }

  // 3. シートへ一括書き戻し
  if (minIdx !== -1 && maxIdx !== -1) {
    const startRow = minIdx + 2;
    const rowCount = maxIdx - minIdx + 1;
    const modifiedSlice = values.slice(minIdx, maxIdx + 1);
    
    const maxColsInSlice = modifiedSlice.reduce((m, r) => Math.max(m, r.length), 0);
    const normalizedData = modifiedSlice.map(r => {
      while (r.length < maxColsInSlice) r.push("");
      return r;
    });

    sheet.getRange(startRow, 1, rowCount, maxColsInSlice).setValues(normalizedData);
    Logger.log(`🎉 修正完了: ${processedCount} 件の英語要約を日本語に修正し、ベクトルを更新しました。`);
  }
}

/**
 * toolFillMissingSummariesFullScan
 * 【全行スキャン版】5000行の壁を越えて、シートの末尾まで空欄を探しに行きます。
 */
function toolFillMissingSummariesFullScan() {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  if (!sheet) return;
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // 境界線を撤廃し、実際の最終行までを対象にします
  const numRows = lastRow - 1;
  
  const SUM_COL = AppConfig.get().CollectSheet.Columns.SUMMARY - 1; // E列(4)
  const TITLE_COL = AppConfig.get().CollectSheet.Columns.URL - 2;   // B列(1)
  const ABS_COL = AppConfig.get().CollectSheet.Columns.ABSTRACT - 1; // D列(3)
  
  // ⚡【高速化】A-E列(5列)だけに絞って全行読み込み
  const values = sheet.getRange(2, 1, numRows, 5).getValues();
  const targets = [];
  
  Logger.log(`全行スキャン開始: 1 〜 ${lastRow} 行を調査中...`);

  for (let i = 0; i < values.length; i++) {
    const summary = String(values[i][SUM_COL] || "").trim();
    if (summary === "") {
       targets.push({
          rowIndex: i,
          title: values[i][TITLE_COL],
          abstractText: values[i][ABS_COL]
       });
    }
  }

  if (targets.length === 0) {
    Logger.log("✅ シートの末尾まで調べましたが、空欄は見つかりませんでした！完璧です。");
    return;
  }

  // 1回の実行で処理する件数（AIの通信時間を考慮し100件程度が安定）
  const processTargets = targets.slice(0, 100); 
  Logger.log(`🚨 合計 ${targets.length} 件の空欄を発見。今回は先頭の ${processTargets.length} 件を処理します。`);

  const BATCH_SIZE = AppConfig.get().System.Limits.LLM_BATCH_SIZE || 5;
  let minIdx = -1; let maxIdx = -1;

  for (let i = 0; i < processTargets.length; i += BATCH_SIZE) {
    const chunk = processTargets.slice(i, i + BATCH_SIZE);
    const articleTexts = chunk.map(t => `Title: ${t.title || ""}\nAbstract: ${t.abstractText || ""}`);
    
    // AI要約実行
    const batchResults = LlmService.summarizeBatch(articleTexts);
    
    batchResults.forEach((jsonString, idx) => {
      const target = chunk[idx];
      let newHeadline = null;
      
      if (jsonString && !String(jsonString).includes("API Error")) {
        try {
          const parsedJson = cleanAndParseJSON_(jsonString);
          newHeadline = parsedJson ? (parsedJson.tldr || parsedJson.summary) : String(jsonString).trim();
        } catch (e) {
          newHeadline = String(jsonString).trim();
        }
      }

      if (newHeadline && !String(newHeadline).includes("API Error")) {
        values[target.rowIndex][SUM_COL] = newHeadline;
        if (minIdx === -1 || target.rowIndex < minIdx) minIdx = target.rowIndex;
        if (target.rowIndex > maxIdx) maxIdx = target.rowIndex;
      }
    });

    if (i + BATCH_SIZE < processTargets.length) {
      Utilities.sleep(AppConfig.get().System.Limits.LLM_BATCH_DELAY || 2000);
    }
  }

  // E列のみピンポイント更新
  if (minIdx !== -1) {
    const startRow = minIdx + 2;
    const rowCount = maxIdx - minIdx + 1;
    const modifiedData = values.slice(minIdx, maxIdx + 1).map(r => [r[SUM_COL]]);
    
    sheet.getRange(startRow, SUM_COL + 1, rowCount, 1).setValues(modifiedData);
    Logger.log(`🎉 穴埋め完了。残り ${Math.max(0, targets.length - processTargets.length)} 件です。`);
  }
}

/**
 * toolBatchDiagnoseScrapers
 * 全スクレイピングサイトを巡回し、現在の正規表現で「どんなタイトルが取れるか」を3件ずつ表示する。
 */
function toolBatchDiagnoseScrapers() {
  const config = AppConfig.get();
  const sheet = getSheet_(config.SheetNames.SCRAPERS);
  if (!sheet) return;

  const data = sheet.getDataRange().getValues();
  Logger.log("=== 🔍 スクレイパー一括タイトル診断開始 ===");

  for (let i = 1; i < data.length; i++) {
    const [label, targetUrl, baseUrl, regexStr, urlGrp, titleGrp, active] = data[i];
    
    // ActiveがTRUEの行だけ処理
    if (!active || active === false || !targetUrl || !regexStr) continue;

    try {
      const options = { 'muteHttpExceptions': true, 'headers': config.System.HttpHeaders };
      const response = UrlFetchApp.fetch(targetUrl, options);
      const html = response.getContentText();
      
      // 🎉 v2.0 共通スクレイパー層の検証エンジンをスマートに再利用！
      const results = Scraper.testRegex(html, regexStr, urlGrp, titleGrp, baseUrl);
      
      Logger.log(`\n【${label}】 (ヒット: ${results.length}件)`);
      
      if (results.length > 0) {
        // 先頭3件だけサンプルを表示
        results.slice(0, 3).forEach((item, idx) => {
          Logger.log(`  ${idx + 1}. ${item.title.substring(0, 50)}${item.title.length > 50 ? "..." : ""}`);
        });
      } else {
        Logger.log("  ⚠️ マッチする記事が見つかりません。");
      }
    } catch (e) {
      Logger.log(`  ❌ エラー: ${label} - ${e.message}`);
    }
    // サーバー負荷軽減のため少し待機
    Utilities.sleep(500);
  }
  Logger.log("\n=== 診断完了 ===");
}

/**
 * @description 指定した行の現在の正規表現と、AIの提案を比較診断します。
 */
function toolCompareScraperRegex(rowIndex) {
  const config = AppConfig.get();
  
  // rowIndex が渡されていない場合（手動実行時）のみ UI を呼び出す
  if (!rowIndex) {
    const ui = SpreadsheetApp.getUi(); 
    const response = ui.prompt("Scraper診断", "行番号を入力してください（例: 2）", ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    rowIndex = parseInt(response.getResponseText());
  }

  const sheet = getSheet_(config.SheetNames.SCRAPERS);
  const [label, targetUrl, baseUrl, currentRegex, urlGrp, titleGrp] = sheet.getRange(rowIndex, 1, 1, 6).getValues()[0];
  
  Logger.log(`--- 🔍 Scraper 比較診断: ${label} ---`);
  const html = UrlFetchApp.fetch(targetUrl, { 'muteHttpExceptions': true, 'headers': config.System.HttpHeaders }).getContentText();
  
  // 🎉 v2.0 共通スクレイパー層の検証エンジンをスマートに再利用！
  const currentHits = Scraper.testRegex(html, currentRegex, urlGrp, titleGrp, baseUrl);
  Logger.log("🤖 AIに解析させています...");
  const aiProposal = _askAiForRegex_(html);
  const aiHits = aiProposal ? Scraper.testRegex(html, aiProposal.regex, aiProposal.urlGroup, aiProposal.titleGroup, aiProposal.suggestedBaseUrl || baseUrl) : [];

  Logger.log(`\n=========================================\n【結果】 ${label}\nA. あなたの設定 : ${currentHits.length} 件\nB. AIの提案案   : ${aiHits.length} 件\n=========================================`);
  if (aiProposal) Logger.log(`💡 AIの正規表現: ${aiProposal.regex}`);
}

/**
 * 全てのRSSブラックリスト（ストライク履歴）を強制リセットする
 */
function resetAllRssStrikes() {
  const props = PropertiesService.getScriptProperties();
  const keys = props.getKeys();
  let count = 0;
  
  for (const key of keys) {
    if (key.startsWith("RSS_STRIKE_")) {
      props.deleteProperty(key);
      count++;
    }
  }
  Logger.log(`完了: ${count} 件のRSSブラックリストを解除しました。`);
}

/**
 * 【お掃除ツール】E列の英語要約だけを一括で空欄にする（超高速）
 */
function clearEnglishSummaries() {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  if (!sheet) return;
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // E列（SUMMARY）だけを取得
  const SUM_COL = AppConfig.get().CollectSheet.Columns.SUMMARY; 
  const range = sheet.getRange(2, SUM_COL, lastRow - 1, 1);
  const values = range.getValues();
  
  let clearCount = 0;
  
  // 配列上で英語チェック＆空欄化
  for (let i = 0; i < values.length; i++) {
    const text = String(values[i][0]).trim();
    // 空欄やエラー文字でなく、かつ日本語が含まれていない（＝英語）なら
    if (text && !text.includes("API Error") && isLikelyEnglish_(text)) {
      values[i][0] = ""; // 空欄で上書き
      clearCount++;
    }
  }
  
  // 一括でシートに書き戻す
  if (clearCount > 0) {
    range.setValues(values);
    Logger.log(`🧹 お掃除完了: ${clearCount} 件の英語要約を空欄にしました！`);
  } else {
    Logger.log("英語の要約は見つかりませんでした。");
  }
}

/**
 * 【単独実行用】クリックログの集計とDriveへの退避のみを行う
 */
function runActionLogArchive() {
  Logger.log("--- クリックログ集計・退避ジョブ 開始 ---");
  
  // 裏側の本体処理を呼び出す
  archiveActionLogsToDrive_();
  
  Logger.log("--- クリックログ集計・退避ジョブ 完了 ---");
}

/**
 * toolBackfillFullContents
 * 【役割】未要約記事の中で本文が不足しているものを抽出し、5分間の制限時間内でひたすらサーバーフレンドリーに本文補完（スクレイピング）を行います。
 * 【用途】大量流入時に、あらかじめD列（ABSTRACT）を最大1,500文字までリッチに肉厚化しておくためのメンテナンス用バックフィルツール。
 */
function toolBackfillFullContents() {
  const startTime = new Date().getTime();
  const TIME_LIMIT_MS = 270 * 1000; // 4.5分（GASの5分制限に対する安全弁）
  
  const config = AppConfig.get();
  const sheet = getSheet_(config.SheetNames.TREND_DATA);
  if (!sheet) return;
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  
  const C = config.CollectSheet.Columns;
  
  // 効率化のため、直近の1,000行をスキャン対象とする
  const SCAN_LIMIT = 1000;
  const numRows = Math.min(lastRow - 1, SCAN_LIMIT);
  
  // A列〜SUMMARY列までの範囲を一括ロード
  const range = sheet.getRange(2, 1, numRows, Math.max(C.SUMMARY, C.ABSTRACT));
  const values = range.getValues();
  
  const targets = [];
  
  Logger.log(`[補完ツール] 直近 ${numRows} 行の本文未取得チェックを開始します...`);
  
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const summary = String(row[C.SUMMARY - 1] || "").trim();
    let abstract = String(row[C.ABSTRACT - 1] || "").trim();
    const url = row[C.URL - 1];
    
    // まだ要約されていない新着記事のみを狙い撃ち（SKIPやJSONが入っているものは除外）
    if (summary === "") {
      const isEn = isLikelyEnglish_(abstract);
      const minLen = isEn ? config.System.Limits.MIN_ABSTRACT_LENGTH.EN : config.System.Limits.MIN_ABSTRACT_LENGTH.JA;
      
      // 抜粋がない、または各言語の基準文字数に達していないものを補完対象とする
      if (abstract === config.Llm.NO_ABSTRACT_TEXT || abstract.length < minLen) {
        targets.push({
          rowIndex: i + 2, // スプレッドシートの実際の行番号
          url: url,
          domain: _extractDomain_(url) // Helpersにあるドメイン抽出ロジック
        });
      }
    }
  }
  
  if (targets.length === 0) {
    Logger.log("✅ 本文の補完が必要な記事は見つかりませんでした！すべての新着がリッチ、または合格ラインをクリアしています。");
    return;
  }
  
  Logger.log(`🚨 ${targets.length} 件の本文不足記事を検出しました。サーバー負荷分散のための並び替えを開始します...`);
  
  // 🌟 【サーバーフレンドリーの極み】Helpersのラウンドロビンエンジンを使用し、同じドメインへの連続アクセスを自動で綺麗に分散！
  const scheduledTargets = _scheduleRequestsByDomain_(targets);
  
  let successCount = 0;
  let failCount = 0;
  
  for (const target of scheduledTargets) {
    // GASのタイムアウト監視（4.5分経過したら安全に離脱）
    if (new Date().getTime() - startTime > TIME_LIMIT_MS) {
      Logger.log("⏳ GASの5分制限が近づいたため、今回の自動補完を安全に中断します（残りは次回実行可能）。");
      break;
    }
    
    try {
      Logger.log(`🌐 本文取得中 (${successCount + failCount + 1}/${scheduledTargets.length}件目): ${target.url.substring(0, 45)}...`);
      
      // Scraperモジュールが誇る最強の全文クローラー（PDF自動OCR・Googleニュースデコード内包）をコール
      const fullContent = fetchFullContent_(target.url);
      
      if (fullContent && fullContent.length > 50 && fullContent !== config.Llm.NO_ABSTRACT_TEXT) {
        // 💡 タイムアウトで途中のデータが消えるのを防ぐため、成功した瞬間にシートへ即時ピンポイント書き戻し
        sheet.getRange(target.rowIndex, C.ABSTRACT).setValue(fullContent);
        successCount++;
        Logger.log(`   ▲ 補完成功！ D列(ABSTRACT)を ${fullContent.length} 文字に肉厚化しました。`);
      } else {
        failCount++;
        Logger.log(`   ▲ 取得失敗（拒絶、リダイレクトエラー、またはテキストが皆無）`);
      }
    } catch (e) {
      failCount++;
      Logger.log(`   ▲ 例外エラー発生によりスキップ: ${e.message}`);
    }
    
    // 🌟 サーバーフレンドリー精神: 次のサイトへフェッチしにいく前に最低 1.5 秒のインターバルを強制
    Utilities.sleep(1500);
  }
  
  Logger.log(`\n🏁 【補完ジョブ終了】合計 ${successCount} 件の記事に豊かな本文をバックフィルしました！（スキップ・拒絶: ${failCount} 件）`);
}

/**
 * @function diagnoseContentDuplicates
 * @description 直近の記事データを指定件数ロードし、スプレッドシートを汚さずに内容重複（酷似ペア）を総当たりでシミュレート診断します。
 * @param {number} limitCount - 診断対象とする直近の記事数（例: 100 や 500、1000など）
 * @param {number} targetThreshold - 検知しきい値（未指定なら現在の設定JSON値、または0.85）
 */
function diagnoseContentDuplicates(limitCount = 350, targetThreshold = null) {
  const config = AppConfig.get();
  const sheet = Repository.getSheet(config.SheetNames.TREND_DATA); // collectシート
  if (!sheet) {
    Logger.log("❌ エラー: collectシートが見つかりません。");
    return;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("⚠️ 診断対象の記事データがありません。");
    return;
  }

  // 1. 診断パラメータの確定
  const scanRows = Math.min(limitCount, lastRow - 1);
  const threshold = targetThreshold || config.System.Thresholds.DUPLICATE_OMIT || 0.85;

  Logger.log(`==================================================`);
  Logger.log(`🔬 [YATA 重複コンテンツ監査ツール] 診断開始`);
  Logger.log(`対象: 直近最上部から 【 ${scanRows} 件 】 の要約済み記事`);
  Logger.log(`基準しきい値: 【 ${(threshold * 100).toFixed(0)}% (類似度: ${threshold}) 】`);
  Logger.log(`==================================================\n`);

  // 2. 必要な範囲（日付、タイトル、ソース、ベクトル）を一括ロード
  const maxCol = config.CollectSheet.Columns.VECTOR; // G列
  const rawData = sheet.getRange(2, 1, scanRows, maxCol).getValues();
  
  // 扱いやすいように記事オブジェクト配列に集約（有効な要約があるもの限定）
  const C = config.CollectSheet.Columns;
  const articles = [];
  
  rawData.forEach((row, index) => {
    const summary = String(row[C.SUMMARY - 1] || "").trim();
    // SKIPやERROR、空欄を除外（本番の配信対象になり得る綺麗なデータのみ）
    if (summary !== "" && !summary.startsWith("SKIP") && !summary.startsWith("ERROR")) {
      const vec = row[C.VECTOR - 1] ? parseVector_(row[C.VECTOR - 1]) : null;
      if (vec) {
        articles.push({
          rowIdx: index + 2,
          title: String(row[C.URL - 2]).substring(0, 50) + "...",
          source: row[C.SOURCE - 1] || "Unknown",
          vector: vec
        });
      }
    }
  });

  Logger.log(`📊 準備完了: 配信対象となる有効なベクトル保有記事 【 ${articles.length} 件 】 で総当たり突合を開始...`);

  let duplicatePairCount = 0;
  let totalCalculations = 0;
  const startTimeMs = new Date().getTime();

  // 3. 総当たり（二重ループ）で内積計算
  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      totalCalculations++;
      
      // 05_Analytics.js の超高速内積エンジンをそのまま使用
      const similarity = calculateDotProduct_(articles[i].vector, articles[j].vector);

      // 設定したしきい値を超えたペアを検挙
      if (similarity >= threshold) {
        duplicatePairCount++;
        let alertIcon = "🚨 [中身がほぼ同一コピペ]";
        if (similarity < 0.90) alertIcon = "🟠 [メディア違い・同話題]";

        Logger.log(`${alertIcon} 類似度: 【 ${(similarity * 100).toFixed(1)}% 】(スコア: ${similarity.toFixed(4)})`);
        Logger.log(`  ① 行 ${articles[i].rowIdx} [${articles[i].source}]: "${articles[i].title}"`);
        Logger.log(`  ② 行 ${articles[j].rowIdx} [${articles[j].source}]: "${articles[j].title}"`);
        Logger.log(`  ----------------------------------------------`);
      }
    }
  }

  const endTimeMs = new Date().getTime();
  const elapsed = endTimeMs - startTimeMs;

  // 4. サマリーの出力
  Logger.log(`\n==================================================`);
  Logger.log(`📊 [診断完了サマリー]`);
  Logger.log(`⏱️ 総計算時間 : ${elapsed} ミリ秒`);
  Logger.log(`🧮 総計算回数 : ${totalCalculations} 回`);
  Logger.log(`🎯 検挙された重複ペア: 【 ${duplicatePairCount} 組 】`);
  
  if (articles.length > 0 && duplicatePairCount > 0) {
    const theoreticalOmitRate = (duplicatePairCount / articles.length) * 100;
    Logger.log(`✨ 考察: このしきい値（${threshold}）を導入すると、約 ${theoreticalOmitRate.toFixed(1)}% のノイズURLが自動間引き（Omit）され、LLMのパンクを強力に防止できます。`);
  } else {
    Logger.log(`✅ 非常にクリーンです。現在のデータ群に内容のダブりは検出されませんでした。`);
  }
  Logger.log(`==================================================`);
}

/**
 * 🌟 GASエディタの実行ボタン（▶）から1クリックで動かすための専用エントリーポイント
 */
function run_ContentDuplicateAudit() {
  // ここを「500」や「1000」に打ち替えるだけで自由にシミュレーション範囲を変更可能
  const checkLimit = 350; 
  // ここを「0.83」や「0.88」に打ち替えるとしきい値別の検挙率を実験可能（nullならシステム値か0.85）
  const testThreshold = 0.85; 
  
  diagnoseContentDuplicates(checkLimit, testThreshold);
}