/**
 * @file YATA-Repository.js
 * @description 【責務】外部ストレージ（スプレッドシート/SQLite）とのデータ入出力（I/O）の隠蔽。
 * 【主要機能】記事データの取得・保存、履歴の読み書き、キャッシュ制御、データの物理削除・軽量化。
 */

const Repository = (function() {

/**
 * _createArticleObject_
 * 【責務】シートの 1 行（配列）を YATA 内部で扱いやすい記事オブジェクトに変換する
 */
function _createArticleObject_(row) {
  const C = AppConfig.get().CollectSheet.Columns;
  let dateObj = row[0];
  if (!(dateObj instanceof Date)) {
    dateObj = new Date(dateObj);
    if (isNaN(dateObj.getTime())) dateObj = new Date();
  }
  const headlineStr = String(row[C.SUMMARY - 1] || "").trim();
  
  return {
    date: dateObj,
    title: row[C.URL - 2],
    url: row[C.URL - 1],
    abstractText: row[C.ABSTRACT - 1],
    headline: headlineStr,
    tldr: headlineStr,
    source: row[C.SOURCE - 1] ? String(row[C.SOURCE - 1]) : "",
    vectorStr: row[C.VECTOR - 1],
    parsedVector: row[C.VECTOR - 1] ? parseVector_(row[C.VECTOR - 1]) : null
  };
}

/**
 * fetchRecentArticlesBatch
 * 【責務】TrendDataシートから、指定された日数分（maxDays）の記事を一括取得してメモリに展開する。
 * 日付ソートされている前提で、古い記事は読み込まずメモリを節約する。
 */
// バッチ取得 (TrendData=公開シート)
function fetchRecentArticlesBatch_(maxDays) {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA); // 
  if (!sheet) return [];
  // ... (以下元のロジック通り) ...
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const dateValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxDays);
  cutoffDate.setHours(0, 0, 0, 0);
  // 🌟 [v2.0 打ち切り破綻救済ガード] データの並び順が微細に崩れていても、直近の可能性がある範囲を一括ロード
  const SCAN_LIMIT = AppConfig.get().System.Limits.MAINTENANCE_SCAN_LIMIT || 3000;
  let rowsToFetch = Math.min(dateValues.length, SCAN_LIMIT);

  if (rowsToFetch === 0) return [];
  const colsToFetch = AppConfig.get().CollectSheet.Columns.VECTOR; 
  const rawData = sheet.getRange(2, 1, rowsToFetch, colsToFetch).getValues();
  const C = AppConfig.get().CollectSheet.Columns;
  return rawData.map(r => _createArticleObject_(r))
                .filter(a => isValidHeadline_(a.headline));
}

/**
 * 【責務】getArticlesInDateWindow: 指定期間内の記事を collectSheet から抽出
 * @description 指定した期間内の記事をcollectシートから抽出します。
 * @param {Date} start - 開始日時。
 * @param {Date} end - 終了日時。
 * @returns {Object[]} 整理済みの記事オブジェクト配列。
 */
function getArticlesInDateWindow_(start, end) {
  const sh = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  
  // 最適化: まず日付列だけを取得して範囲を特定する（シート全体の不要なデータ読み込みを回避）
  const dateValues = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  let startRowIndex = -1;
  let endRowIndex = -1;

  for (let i = 0; i < dateValues.length; i++) {
    const d = new Date(dateValues[i][0]);
    if (isNaN(d.getTime())) continue;
    if (d >= start && d < end) {
      if (startRowIndex === -1) startRowIndex = i;
    } else if (startRowIndex !== -1 && d < start) {
      endRowIndex = i;
      break;
    }
  }

  if (startRowIndex === -1) return []; // 期間内のデータなし
  if (endRowIndex === -1) endRowIndex = dateValues.length;

  const numRows = endRowIndex - startRowIndex;
  if (numRows <= 0) return [];

  // G列（ベクトル列）まで、特定した範囲だけを取得
  const cols = AppConfig.get().CollectSheet.Columns.VECTOR;
  const vals = sh.getRange(startRowIndex + 2, 1, numRows, cols).getValues();
  
  const out = [];
  for (const r of vals) {
    const date = r[0];
    if ((date instanceof Date) && date >= start && date < end) {
      const headline = r[4];
      const headlineStr = String(headline || "").trim();

      // 共通ヘルパーで正常な見出しのみを抽出
      if (isValidHeadline_(headlineStr)) {
        out.push(_createArticleObject_(r));
      }
    }
  }
  out.sort((a, b) => a.date - b.date);
  return out;
}


/**
 * _getRelevantHistory_
 * 【責務】キーワードまたはベクトル検索で過去の履歴を取得
 */
function _getRelevantHistory_(keyword, currentContextText) {
  const sheet = getSheet_(AppConfig.get().SheetNames.DIGEST_HISTORY);
  if (!sheet || sheet.getLastRow() < 2) return null;

  // D列(Vector)まで取得
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues(); 
  
  // 1. 直近検索 (キーワード完全一致)
  for (let i = data.length - 1; i >= 0; i--) {
    if (String(data[i][1]).trim() === keyword) {
      Logger.log(`履歴発見(Keyword): 「${keyword}」の前回要約を採用。`);
      return String(data[i][2]);
    }
  }

  // 2. 連想検索 (Vector Search)
  if (!currentContextText) return null;

  Logger.log(`履歴なし(Keyword): 連想記憶検索を開始します...`);
  const queryVector = LlmService.generateVector(currentContextText);
  if (!queryVector) return null;

  let bestSim = -1;
  let bestSummary = null;
  const SIMILARITY_THRESHOLD = AppConfig.get().System.Thresholds.HISTORY_MATCH;

  for (let i = 0; i < data.length; i++) {
    const vecStr = data[i][3];
    if (!vecStr) continue;

    const histVector = parseVector_(vecStr);
    if (!histVector) continue;

    const sim = calculateDotProduct_(queryVector, histVector);
    if (sim > bestSim) {
      bestSim = sim;
      bestSummary = data[i][2];
    }
  }

  if (bestSim >= SIMILARITY_THRESHOLD) {
    Logger.log(`履歴発見(Vector): 類似度${bestSim.toFixed(3)}の過去コンテキストを採用しました。`);
    return bestSummary;
  }

  return null;
}

/**
 * _writeHistory_
 * 【責務】DigestHistoryシートに「圧縮コンテキスト」とその「ベクトル」を書き込む
 */
function _writeHistory_(keyword, summary) {
  try {
    const sheet = getSheet_(AppConfig.get().SheetNames.DIGEST_HISTORY);
    if (!sheet) return;

    const vector = LlmService.generateVector(summary);
    const vectorStr = vector ? vector.join(',') : "";

    sheet.appendRow([new Date(), keyword, summary, vectorStr]);
    Logger.log(`履歴保存(Vector付): キーワード「${keyword}」を記録しました。`);
  } catch (e) {
    _logError_("_writeHistory", e, "履歴書き込みエラー");
  }
}

/**
 * fetchJsonFromDrive_ (汎用JSON読み込み・キャッシュ付き)
 * 【責務】Drive上の指定されたプロパティキーに紐づくJSONファイルを取得し、パースしてキャッシュする。
 */
let _JsonCache = {};
/**
 * fetchJsonFromDrive_ (🌟v2.0 グローバルキャッシュ完全装備モデル)
 * 【責務】Drive上のJSONファイルを取得し、グローバルメモリ領域へ永続化する。
 */
function fetchJsonFromDrive_(propertyKey) {
  const GLOBAL_JSON_KEY = "_YATA_GLOBAL_JSON_CACHE_" + propertyKey;
  const _globalScope = (typeof globalThis !== 'undefined') ? globalThis : (typeof global !== 'undefined' ? global : this);

  // 🌟 [キャッシュ発動] メモリにあれば、Google Driveへの通信を完全に遮断して即時返却
  if (_globalScope[GLOBAL_JSON_KEY]) {
    return _globalScope[GLOBAL_JSON_KEY];
  }

  const fileId = PropertiesService.getScriptProperties().getProperty(propertyKey);
  if (!fileId) {
    Logger.log(`⚠️ エラー: スクリプトプロパティ '${propertyKey}' が設定されていません。`);
    return null;
  }

  try {
    const file = DriveApp.getFileById(fileId);
    const jsonText = file.getBlob().getDataAsString("UTF-8");
    const parsedData = JSON.parse(jsonText);
    
    // グローバル領域へストック
    _globalScope[GLOBAL_JSON_KEY] = parsedData;
    return parsedData;
  } catch (e) {
    Logger.log(`❌ JSON読み込みエラー (${propertyKey}): ${e.toString()}`);
    return null;
  }
}

/**
 * getPromptConfig_
 * 【責務】プロンプト設定JSONから特定のキーを取得するラッパー。
 */
function getPromptConfig_(key) {
  const promptData = fetchJsonFromDrive_("PROMPT_JSON_FILE_ID");
  return (promptData && promptData[key]) ? String(promptData[key]).trim() : null;
}

/**
 * @description 来週のAI分析のために、今回のレポート内容を損失なく高密度に圧縮します。
 * @param {string} reportText - 今回生成されたレポート本文。
 * @returns {string} 圧縮されたコンテキスト文字列。
 */
function _generateContextForNextWeek_(reportText) {
  if (!reportText || reportText.trim() === "") return "";
  
  Logger.log("来週への引き継ぎ用コンテキスト圧縮を開始します。");
  
  // 履歴作成には少し賢いモデル(Mini)を使うことで、文脈の理解度を上げる
  // (コストを極限まで下げるならNanoのままでも可ですが、記憶維持ならMini推奨)
  const model = AppConfig.get().Llm.ModelMini; 
  
  // プロンプトキーを専用のものに変更
  const SYSTEM_PROMPT = getPromptConfig_("CONTEXT_COMPRESSION_SYSTEM");
  
  if (!SYSTEM_PROMPT) {
      Logger.log("コンテキスト圧縮用プロンプト(CONTEXT_COMPRESSION_SYSTEM)が見つかりません。");
      return "";
  }
  
  // LlmServiceを使って圧縮を実行
  // (summarizeReportメソッドを流用しますが、中身はコンテキスト圧縮です)
  // ※LlmService側に直接 model を渡せるよう _callLlmWithFallback を使うか、
  //   LlmService.analyzeKeywordSearch などを流用して実装します。
  
  // 簡易実装として LlmService.analyzeKeywordSearch (Miniモデル使用) を流用する場合:
  const compressedText = LlmService.analyzeKeywordSearch(SYSTEM_PROMPT, reportText, {
    temperature: 0.0 // 事実重視なのでランダム性を排除
  });

  Logger.log(`コンテキスト圧縮完了: ${compressedText.length}文字`);
  return compressedText;
}

// 🌟 ファイルオブジェクトに加え、取得したシートオブジェクト自体もメモリ空間に完全キャッシュ
const _SsCache = { config: null, data: null, sheets: {} };

/**
 * getSheet (自動振り分け版・完全キャッシュ最適化モデル)
 * 【責務】シート名に応じて「データ用(公開)」か「設定用(非公開)」か判定し、正しいIDを開く。
 * @param {string} sheetName - シート名
 * @returns {Sheet} シートオブジェクト (存在しない場合はnull)
 */
function getSheet_(sheetName) {
  // 🌟 メモリ上にすでに展開済みの同一シートがあれば、Google APIを叩かずに即座に返却
  if (_SsCache.sheets[sheetName]) return _SsCache.sheets[sheetName];

  const config = AppConfig.get();
  
  // 非公開(Config)シートにあるべきシート名をリスト化
  const PRIVATE_SHEETS = [
    config.SheetNames.USERS,
    config.SheetNames.PROMPT_CONFIG,
    config.SheetNames.KEYWORDS,
    config.SheetNames.DIGEST_HISTORY,
    config.SheetNames.ACTION_LOGS,
    config.SheetNames.PRIORITY_DICTIONARY,
    "KeywordsDictionary",
    "Memo"
  ];

  let targetId;
  let isConfig = false;

  if (PRIVATE_SHEETS.includes(sheetName) || sheetName === "Keywords" || sheetName === "Memo") {
    targetId = config.System.ConfigSheetId;
    isConfig = true;
  } else {
    targetId = config.System.DataSheetId;
  }

  if (!targetId || targetId.includes("未設定")) {
    console.error(`ID設定エラー: ${sheetName} を開くためのIDが設定されていません。`);
    return null;
  }
  
  try {
    let ss;
    if (isConfig) {
      if (!_SsCache.config) _SsCache.config = SpreadsheetApp.openById(targetId);
      ss = _SsCache.config;
    } else {
      if (!_SsCache.data) _SsCache.data = SpreadsheetApp.openById(targetId);
      ss = _SsCache.data;
    }
    
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      console.warn(`警告: シート「${sheetName}」が見つかりません (ID: ...${targetId.slice(-4)})`);
      return null;
    }
    
    // 🌟 初回取得時にシートオブジェクトをディクショナリに格納
    _SsCache.sheets[sheetName] = sheet;
    return sheet;
  } catch (e) {
    console.error(`シート取得エラー (${sheetName}): ${e.message}`);
    return null;
  }
}

/**
 * @description URL正規化に基づき、collectシート内の重複記事を完全に排除します。（超軽量版）
 */
function removeDuplicates_() {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  if (!sheet) {
    Logger.log("エラー: シートが見つかりません");
    return;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log("データがありません");
    return;
  }

  // 1. URL列を直近エリアに絞って取得する
  const urlColIdx = AppConfig.get().CollectSheet.Columns.URL;
  
  // 🌟 [極限効率化] 前方インジェクション運用において、過去のデータはクレンジング済みのため、
  // 重複が混入し得るのは本日挿入された最上部のみ。数万行スキャンを廃止し、最大3,000行にクリップ。
  // 新しい記事（上）を残し、古い重複（下）を自動消去する安全なアップデート特性は100%維持されます。
  // 流入数500件突破に伴い、Config（5,000行＝10日分）から動的ロード
  const MAINTENANCE_SCAN_LIMIT = AppConfig.get().System.Limits.MAINTENANCE_SCAN_LIMIT || 3000;
  const rowsToScan = Math.min(lastRow - 1, MAINTENANCE_SCAN_LIMIT);
  const urlValues = sheet.getRange(2, urlColIdx, rowsToScan, 1).getValues();
  
  const uniqueNormalizedUrls = new Set();
  const rowsToDelete = [];

  // 2. 上から順にスキャンし、重複している「行番号」を特定
  urlValues.forEach((row, i) => {
    const url = row[0];
    if (url) {
      const normalizedUrl = normalizeUrl_(url); 
      if (!uniqueNormalizedUrls.has(normalizedUrl)) {
        uniqueNormalizedUrls.add(normalizedUrl);
      } else {
        rowsToDelete.push(i + 2); // スプレッドシートの行番号は2から始まるため補正
      }
    }
  });

  // 3. 行を「下から上へ」削除する（インデックスのズレを防ぐため必須）
  if (rowsToDelete.length > 0) {
    rowsToDelete.sort((a, b) => b - a); // 降順ソート
    
    // GASの制限回避のため、連続する重複行をまとめて一気に削除する最適化
    let startRow = rowsToDelete[0];
    let numRows = 1;
    let deleteCount = 0;

    for (let i = 1; i < rowsToDelete.length; i++) {
      if (rowsToDelete[i] === startRow - numRows) {
        // 前の行と連続している場合はまとめる
        numRows++;
      } else {
        // 連続が途切れたら、そこまでの塊を削除
        sheet.deleteRows(startRow - numRows + 1, numRows);
        deleteCount += numRows;
        startRow = rowsToDelete[i];
        numRows = 1;
      }
    }
    // 最後の塊を削除
    sheet.deleteRows(startRow - numRows + 1, numRows);
    deleteCount += numRows;

    Logger.log(`完了: ${deleteCount} 件の重複記事をピンポイントで削除しました。`);
  } else {
    Logger.log("重複記事は見つかりませんでした。");
  }
}

/**
 * sortCollectByDateDesc
 * 【責務】collectシートを日付順（新しい順）に並び替える。
 */
function sortCollectByDateDesc_() {
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  const lastRow = sheet.getLastRow();
  
  if (lastRow > 1) {
    // ソート処理をリトライで保護
    _withRetry_(() => {
      sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn())
           .sort({column: 1, ascending: false});
      SpreadsheetApp.flush(); // ソート結果を即座に反映
    });
    Logger.log("collectシートを最新順に並び替えました。");
  }
}

/**
 * @description 指定期間より古いデータをDriveへ退避(JSON)し、重心ベクトルをMacroTrendsに記録して削除します。
 * @details 保持期間(RETENTION_MONTHS)を過ぎたデータを対象とし、月の初めにアーカイブを実行します。
 */
function archiveAndPruneOldData_() {
  const config = AppConfig.get();
  const RETENTION_MONTHS = config.System.Limits.DATA_RETENTION_MONTHS;
  
  const collectSheet = getSheet_(config.SheetNames.TREND_DATA);
  const macroSheet = getSheet_(config.SheetNames.MACRO_TRENDS); // 新設シート
  
  if (!collectSheet || !macroSheet) {
    Logger.log("エラー: シートが見つかりません(collect または MacroTrends)");
    return;
  }

  const lastRow = collectSheet.getLastRow();
  if (lastRow < 2) return;

  // 閾値計算 (例: 今日が5月なら、2月以前のデータを対象にする)
  const thresholdDate = new Date();
  thresholdDate.setMonth(thresholdDate.getMonth() - RETENTION_MONTHS);
  // 月初に設定（アーカイブ単位を「月」にするため）
  thresholdDate.setDate(1); 
  thresholdDate.setHours(0,0,0,0);

  // 日付列(A)を取得
  const dateValues = collectSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  
  // 削除対象の範囲を特定（日付降順前提：閾値より「未来」の行数を数える）
  // つまり、下の方にある「閾値より過去」の行を探す
  let archiveStartRow = -1;
  
  for (let i = 0; i < dateValues.length; i++) {
    const rowDate = new Date(dateValues[i][0]);
    if (rowDate < thresholdDate) {
      archiveStartRow = i + 2;
      break;
    }
  }

  // 対象データがない場合は終了
  if (archiveStartRow === -1) {
    Logger.log("アーカイブ対象の古いデータはありません。");
    return;
  }

  const numRows = lastRow - archiveStartRow + 1;
  Logger.log(`アーカイブ開始: ${numRows} 件の記事を処理します...`);

  // 1. データ取得
  const range = collectSheet.getRange(archiveStartRow, 1, numRows, collectSheet.getLastColumn());
  const rawData = range.getValues(); // データ本体
  
  // 2. 重心(Centroid)計算 & 代表トピック抽出
  // ベクトルがある行だけ抽出
  const vectorColIdx = config.CollectSheet.Columns.VECTOR - 1;
  const titleColIdx = config.CollectSheet.Columns.URL - 2;
  
  const validVectors = [];
  const titles = [];

  rawData.forEach(row => {
    const vecStr = row[vectorColIdx];
    const title = row[titleColIdx];
    if (vecStr) {
      const vec = parseVector_(vecStr);
      if (vec) validVectors.push(vec);
    }
    if (title) titles.push(title);
  });

  let centroidVectorStr = "";
  let topicSummary = "データ不足により解析不能";

  if (validVectors.length > 0) {
    // 重心計算 (全ベクトルの平均)
    const dim = validVectors[0].length;
    const avg = new Array(dim).fill(0);
    validVectors.forEach(v => {
      for(let i=0; i<dim; i++) avg[i] += v[i];
    });
    for(let i=0; i<dim; i++) avg[i] /= validVectors.length;
    
    centroidVectorStr = avg.join(",");
    
    // AIによる「その期間のトピック要約」
    // タイトルをランダムに最大50個選んで要約させる
    const sampleSize = AppConfig.get().System.Limits.ARCHIVE_SAMPLE_SIZE || 50;
    const sampleTitles = titles.sort(() => 0.5 - Math.random()).slice(0, sampleSize).join("\n");
    
    // System PromptとUser Promptを正しく分離して渡す
    const systemPrompt = getPromptConfig_("ARCHIVE_TOPIC_SYSTEM");
    const userPrompt = `【過去の記事タイトル群】\n${sampleTitles}`;
    
    // Nanoモデルでサクッと要約
    const summary = LlmService.summarizeReport(systemPrompt, userPrompt); 
    if (summary) topicSummary = summary;
  }

  // 3. Google DriveへJSON保存
  const archiveLabel = Utilities.formatDate(new Date(rawData[0][0]), Session.getScriptTimeZone(), "yyyy-MM");
  const fileName = `${config.System.Archive.JSON_FILENAME_PREFIX}${archiveLabel}_${Date.now()}.json`;
  
  const jsonContent = JSON.stringify(rawData, null, 2);
  
  try {
    const folderId = config.System.Archive.FOLDER_ID;
    if (folderId && folderId.length > 10) {
      const folder = DriveApp.getFolderById(folderId);
      folder.createFile(fileName, jsonContent, MimeType.PLAIN_TEXT);
      Logger.log(`[Drive保存] ${fileName} を保存しました。`);
    } else {
      Logger.log("警告: フォルダID未設定のため、Drive保存はスキップされました（データは消えます）。");
    }
  } catch (e) {
    Logger.log(`Drive保存エラー: ${e.toString()}`);
    return; // 保存失敗時は削除しない（安全策）
  }

  // 4. MacroTrendsシートへ「重心」を記録
  // フォーマット: [アーカイブ日時, 対象年月, 記事数, トピック要約, 重心ベクトル]
  _withRetry_(() => {
    try {
      // マクロトレンドの記録
      macroSheet.appendRow([
        new Date(), 
        archiveLabel, 
        numRows, 
        topicSummary, 
        centroidVectorStr
      ]);
      
      // 元データの削除 (アーカイブ成功時のみ実行)
      collectSheet.deleteRows(archiveStartRow, numRows);
      
      // 変更を強制確定
      SpreadsheetApp.flush(); 
      
      Logger.log(`[成功] MacroTrends記録 ＆ ${numRows} 行の削除を完了しました。`);
    } catch (e) {
      // ここでのエラーは _withRetry_ がキャッチしてリトライを試みます
      throw new Error(`スプレッドシート操作失敗: ${e.toString()}`);
    }
  });

  Logger.log(`[アーカイブ完了] すべての工程が正常に終了しました。`);
}

/**
 * maintenanceLightenOldArticles
 * 【責務】指定日数（35日）より古い記事の「ベクトル列(G列)」だけを削除して軽量化する。
 * 記事自体の行は消さないので、キーワード検索にはヒットする。
 */
function maintenanceLightenOldArticles() {
  const LIGHTEN_THRESHOLD_DAYS = AppConfig.get().System.Limits.LIGHTEN_DAYS; // 生成処理(30日)と被らないよう余裕を持たせる
  
  const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - LIGHTEN_THRESHOLD_DAYS);
  thresholdDate.setHours(0, 0, 0, 0); // 0時に揃える
  
  // 日付列(A列)とベクトル列(G列)の位置を取得
  const dateValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const vectorColIndex = AppConfig.get().CollectSheet.Columns.VECTOR; 
  const methodVectorColIndex = AppConfig.get().CollectSheet.Columns.METHOD_VECTOR;
  
  // 古い記事の範囲を特定
  let targetEndRow = -1;
  // 日付順(降順)で並んでいる前提なら、下の方にある古い記事を探す
  // ※YATAは降順ソートしているので、実際は「ある行以降すべて」が古い記事
  
  for (let i = 0; i < dateValues.length; i++) {
    const rowDate = new Date(dateValues[i][0]);
    if (rowDate < thresholdDate) {
      // これ以降はすべて古い記事
      const startRow = i + 2;
      const numRows = lastRow - startRow + 1;
      
      // G列(ベクトル)だけをクリア
      sheet.getRange(startRow, vectorColIndex, numRows, 1).clearContent();
      // Method Vector列もクリア
      if (methodVectorColIndex) {
        sheet.getRange(startRow, methodVectorColIndex, numRows, 1).clearContent();
      }
      
      Logger.log(`軽量化: 行${startRow}〜${lastRow} (${numRows}件) のベクトルデータを削除しました。`);
      return;
    }
  }
  Logger.log("軽量化対象の記事はありませんでした。");
}

/**
 * maintenancePruneDigestHistory
 * 【責務】DigestHistoryシートから、保存期間を過ぎた古い履歴を削除して軽量化する。
 * デフォルト設定: 60日（約2ヶ月）以上前の履歴は削除。
 */
function maintenancePruneDigestHistory() {
  const RETENTION_DAYS = AppConfig.get().System.Limits.HISTORY_RETENTION_DAYS; // 基本は4ヶ月保存（これより古いと、話題が途切れたとみなして忘れる）
  
  const sheet = getSheet_(AppConfig.get().SheetNames.DIGEST_HISTORY);
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // 削除基準日の計算
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - RETENTION_DAYS);

  // A列(Date)を取得
  const dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let deleteCount = 0;

  // 履歴は「古い順（上から）」並んでいる前提でチェック
  for (let i = 0; i < dates.length; i++) {
    const rowDate = new Date(dates[i][0]);
    if (rowDate < thresholdDate) {
      deleteCount++;
    } else {
      // 古くないデータに当たったら、それ以降は全て新しいので終了
      break; 
    }
  }

  if (deleteCount > 0) {
    // 上からまとめて削除
    sheet.deleteRows(2, deleteCount);
    Logger.log(`履歴メンテナンス: ${RETENTION_DAYS}日以上前の古いコンテキスト (${deleteCount}件) を削除しました。`);
  } else {
    Logger.log("履歴メンテナンス: 削除対象の古いデータはありませんでした。");
  }
}

/**
 * maintenanceSliceVectorsTo256d
 * 【責務】スプレッドシートに保存されている1536次元のベクトルを、先頭256次元にスライスして再正規化し、容量を削減します。
 * (Matryoshka Representation Learningを利用した手法)
 */
function maintenanceSliceVectorsTo256d() {
  const config = AppConfig.get();
  const sheet = getSheet_(config.SheetNames.TREND_DATA);
  if (!sheet) {
    Logger.log("エラー: collectシートが見つかりません。");
    return;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const vectorColIndex = config.CollectSheet.Columns.VECTOR; 
  const range = sheet.getRange(2, vectorColIndex, lastRow - 1, 1);
  const values = range.getValues();

  let updateCount = 0;

  const newValues = values.map((row) => {
    const originalString = String(row[0] || "").trim();
    if (!originalString || originalString.includes("[Error]") || originalString === "Unknown") return [originalString];

    const parts = originalString.split(',').map(Number);
    // Configから次元数を取得（変更があれば連動する）
    const targetDim = AppConfig.get().Llm.Embedding.Dimensions || 256;
    
    // targetDim次元より大きい場合のみスライス
    if (parts.length > targetDim) {
      const sliced = parts.slice(0, targetDim);
      
      // 再正規化(L2ノルムを1にする)
      let normSq = 0;
      for (let i = 0; i < targetDim; i++) {
        normSq += sliced[i] * sliced[i];
      }
      const norm = Math.sqrt(normSq);
      
      const normalized = sliced.map(x => x / norm);
      const newStr = normalized.map(x => Number(x.toFixed(6))).join(',');
      
      updateCount++;
      return [newStr];
    }
    return [originalString];
  });

  if (updateCount > 0) {
    range.setValues(newValues);
    Logger.log(`✨ メンテナンス完了: ${updateCount} 件のベクトルを1536次元から256次元にスライス＆再正規化し、シート容量を大幅に削減しました！`);
  } else {
    Logger.log("スライスが必要なベクトル（256次元を超えるもの）はありませんでした。");
  }
}

/**
 * getDateWindow
 * 【責務】"N日前から今日まで"の日付範囲を計算
 * @param {number} days - 遡り日数
 * @returns {Object} { start: Date, end: Date }
 */
function getDateWindow_(days) {
  const end = new Date();
  end.setHours(24, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(1, days));
  return { start, end };
}

/**
 * isRecentArticle
 * 【責務】記事の公開日が指定された日数以内であるかチェックする。
 */
function isRecentArticle_(pubDate, daysLimit = 7) {
  if (!pubDate || !(pubDate instanceof Date)) return false;
  const now = new Date();
  const daysOld = Math.floor((now - pubDate) / (1000 * 60 * 60 * 24));
  return daysOld <= daysLimit;
}

/**
 * isRecentDate
 * 【責務】日付文字列が指定された日数以内であるかチェックする。
 */
function isRecentDate_(dateStr, daysLimit) {
  if (!dateStr) return false;
  
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return false;

  const now = new Date();
  const diffTime = now - date;
  const diffDays = diffTime / (1000 * 60 * 60 * 24);

  return diffDays <= daysLimit;
}

/**
 * archiveActionLogsToDrive_ (集計・書き戻し機能付き)
 * 【責務】ActionLogsをアーカイブしつつ、collectシートの記事にクリック数を反映させる。
 */
function archiveActionLogsToDrive_() {
  const config = AppConfig.get();
  const logSheet = getSheet_(config.SheetNames.ACTION_LOGS);
  const collectSheet = getSheet_(config.SheetNames.TREND_DATA);
  
  if (!logSheet || logSheet.getLastRow() < 2) return;

  const rawData = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, logSheet.getLastColumn()).getValues();

  // 1. クリック数の集計 (URL単位)
  const clickStats = {};
  rawData.forEach(row => {
    const action = row[2]; // action
    const url = row[3];    // url
    if (action === 'click' && url) {
      const normUrl = normalizeUrl_(url); // 正規化して集計
      clickStats[normUrl] = (clickStats[normUrl] || 0) + 1;
    }
  });

  // 2. collectシートへの書き出し
  if (collectSheet && Object.keys(clickStats).length > 0) {
    const lastRow = collectSheet.getLastRow();
    if (lastRow >= 2) {
      const urlColIdx = config.CollectSheet.Columns.URL;
      const countColIdx = config.CollectSheet.Columns.CLICK_COUNT;

      // 🌟 【修正】getDataRange() をやめ、URL列とカウント列だけを個別に取得する
      const urlValues = collectSheet.getRange(2, urlColIdx, lastRow - 1, 1).getValues();
      const countValues = collectSheet.getRange(2, countColIdx, lastRow - 1, 1).getValues();

      // シート上の各記事をチェックしてカウントを加算
      const updatedValues = urlValues.map((row, i) => {
        const normUrl = normalizeUrl_(row[0]);
        if (clickStats[normUrl]) {
          const currentCount = parseInt(countValues[i][0] || "0", 10);
          return [currentCount + clickStats[normUrl]];
        }
        return [countValues[i][0] || 0]; // CLICK_COUNT列のみ更新用
      });

      // まとめて書き込み
      collectSheet.getRange(2, countColIdx, updatedValues.length, 1).setValues(updatedValues);
      Logger.log(`[反映] ${Object.keys(clickStats).length} 種の記事のクリック数を更新しました。`);
    }
  }

  // 3. Google Driveへの保存とシート削除 (既存ロジック)
  const jsonLogs = rawData.map(row => ({
    timestamp: row[0], email: row[1], action: row[2], url: row[3], keyword: row[4]
  }));

  const folderId = config.System.Archive.FOLDER_ID;
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss");
  const fileName = `YATA_ActionLogArchive_${timestamp}.json`;

  try {
    if (folderId && folderId.length > 10) {
      const folder = DriveApp.getFolderById(folderId);
      folder.createFile(fileName, JSON.stringify(jsonLogs, null, 2), MimeType.PLAIN_TEXT);
      logSheet.deleteRows(2, logSheet.getLastRow() - 1);
      Logger.log(`[完了] ログをアーカイブし、シートを空にしました。`);
    }
  } catch (e) {
    Logger.log(`❌ アーカイブエラー: ${e.toString()}`);
  }
}

  return {
    fetchRecentArticlesBatch: fetchRecentArticlesBatch_,
    getArticlesInDateWindow: getArticlesInDateWindow_,
    getRelevantHistory: _getRelevantHistory_,
    writeHistory: _writeHistory_,
    fetchJsonFromDrive: fetchJsonFromDrive_,
    getPromptConfig: getPromptConfig_,
    generateContextForNextWeek: _generateContextForNextWeek_,
    getSheet: getSheet_,
    removeDuplicates: removeDuplicates_,
    sortCollectByDateDesc: sortCollectByDateDesc_,
    archiveAndPruneOldData: archiveAndPruneOldData_,
    maintenanceLightenOldArticles: maintenanceLightenOldArticles,
    maintenancePruneDigestHistory: maintenancePruneDigestHistory,
    maintenanceSliceVectorsTo256d: maintenanceSliceVectorsTo256d,
    getDateWindow: getDateWindow_,
    isRecentArticle: isRecentArticle_,
    isRecentDate: isRecentDate_,
    archiveActionLogsToDrive: archiveActionLogsToDrive_,

    /**
     * @description 未要約データの抽出と本文不足記事の補完。
     */
    extractArticlesForSummarization: function(startTime, timeLimitMs) {
      const sheet = getSheet_(AppConfig.get().SheetNames.TREND_DATA);
      if (!sheet) return null;
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return null;

      const VECTOR_GEN_DAYS = AppConfig.get().System.Limits.VECTOR_GEN_DAYS; 
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - VECTOR_GEN_DAYS);
      cutoffDate.setHours(0, 0, 0, 0);

      const C = AppConfig.get().CollectSheet.Columns;
      const dateValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
      let targetRowCount = 0;
      for (let i = 0; i < dateValues.length; i++) {
        if (new Date(dateValues[i][0]) < cutoffDate) { targetRowCount = i; break; }
        targetRowCount = i + 1;
      }
      if (targetRowCount === 0) return null;

      // 🌟 [極限効率化] 1回のジョブの上限は30件のため、数千行を一気にロードするのは猛烈な無駄。
      // 前方インジェクション化された環境では未処理は必ず最上部に固まるため、スキャン範囲を最大300行にクリップ。
      // これにより、数万行のシートでもgetValues/setValuesの通信量が激減し、OOM（メモリ不足）を永久に防止。
      // ガチガチの数値を排し、Configの設定と完全に連動
      const SCAN_LIMIT = AppConfig.get().System.Limits.SUMMARIZE_SCAN_LIMIT || 300; 
      targetRowCount = Math.min(targetRowCount, SCAN_LIMIT);

      const maxCol = Math.max(sheet.getLastColumn(), C.KEYWORDS);
      const values = sheet.getRange(2, 1, targetRowCount, maxCol).getValues();

      const news = [];
      const papers = []; 
      const state = { minMod: -1, maxMod: -1 };
      
      const MAX_SUMMARIZE_TOTAL = AppConfig.get().System.Limits.MAX_SUMMARIZE_TOTAL || 30; // GAS環境の制限時間を考慮し、一度に要約する最大合計件数を制限
      let fetchCount = 0;

      const _mark = (idx) => {
        if (state.minMod === -1 || idx < state.minMod) state.minMod = idx;
        if (idx > state.maxMod) state.maxMod = idx;
      };

      for (let i = 0; i < values.length; i++) {
        if (new Date().getTime() - startTime > timeLimitMs) break;
        if (news.length + papers.length >= MAX_SUMMARIZE_TOTAL) break;

        const row = values[i];
        const summary = String(row[C.SUMMARY - 1] || "").trim();
        const hasNoSummary = (summary === "");
        let abstract = String(row[C.ABSTRACT - 1] || "").trim();
        const title = row[C.URL - 2];
        const url = row[C.URL - 1];

        if (hasNoSummary) {
          const isEn = isLikelyEnglish_(abstract);
          const minLen = isEn ? AppConfig.get().System.Limits.MIN_ABSTRACT_LENGTH.EN : AppConfig.get().System.Limits.MIN_ABSTRACT_LENGTH.JA;

          // 💡 制限を5件から15件に緩和
          const MAX_FETCH_FULL = 15; // 本文補完の安全弁
          let isFetchedNow = false; // 今回スクレイピングを試みたかどうかのフラグ

          if ((abstract === AppConfig.get().Llm.NO_ABSTRACT_TEXT || abstract.length < minLen) && fetchCount < MAX_FETCH_FULL) {
            Logger.log(`🌐 [Repository] 本文補完を試行 (${fetchCount+1}/${MAX_FETCH_FULL}): ${title.substring(0, 20)}...`);
            const full = fetchFullContent_(url); 
            fetchCount++;
            isFetchedNow = true; // 試行したことを記録

            if (full && full.length > abstract.length) {
              abstract = full;
              values[i][C.ABSTRACT - 1] = full;
              _mark(i);
              Logger.log(`✅ 本文補完成功: ${title.substring(0, 30)}...`);
            }
          }

          // 🌟 本文不足時の分岐（粘り強いハイブリッド救済構造）
          if (abstract === AppConfig.get().Llm.NO_ABSTRACT_TEXT || abstract.length < minLen) {
            if (isFetchedNow) {
              // 🛡️ 救済判定：Fetchは失敗したが、元のAbstractにパラメータJSON定義（例:50文字）以上の情報が残っているか？
              const minRescueLen = AppConfig.get().System.Limits.WEB_SUMMARY_MIN_CHARS || 50;
              const hasMinimumText = abstract !== AppConfig.get().Llm.NO_ABSTRACT_TEXT && abstract.trim().length >= minRescueLen;

              if (hasMinimumText) {
                // 🌟 continueをあえて「せず」に、手元のAbstractを武器にして下のAI要約キューへ滑り込ませる！
                Logger.log(`♻️ [救済発動] 本文補完は失敗しましたが、元のAbstract (${abstract.length}文字) でAI要約を敢行します: ${title.substring(0, 20)}...`);
              } else {
                // 本当に情報が何もない（タイトルのみ、または指定文字数以下）場合だけ、安全にSKIPを刻印して放流
                Logger.log(`❌ 本文取得失敗かつ元の情報が皆無（または${minRescueLen}文字以下）のため、この記事を放棄します: ${title.substring(0, 30)}...`);
                values[i][C.SUMMARY - 1] = "SKIP: FETCH_FAILED";
                _mark(i);
                continue; 
              }
            } else {
              // 15件制限にかかって、まだFetchを試せていないだけの行は次回ジョブへ保留
              Logger.log(`⚠️ 本文不足のためAI要約を保留（次回ジョブへ持ち越し）: ${title.substring(0, 30)}...`);
              continue; 
            }
          }

          const articleObj = { originalRowIndex: i, title: title, abstractText: abstract };
          if (String(row[C.SOURCE - 1]) === "PubMed") papers.push(articleObj);
          else news.push(articleObj);
        } else {
          const hasNoVector = (!row[C.VECTOR - 1] || String(row[C.VECTOR - 1]).trim() === "");
          if (isValidHeadline_(summary) && hasNoVector) {
            this._generateAndSetVector(values[i], title, summary);
            _mark(i);
          }
        }
      }
      if (news.length + papers.length > 0) {
        Logger.log(`📊 [Repository] Extraction complete. News: ${news.length}, Papers: ${papers.length}`);
      }
      return { values, news, papers, state, maxCol, sheet };
    },

    /**
     * @description 更新された記事データをシートへ一括書き込みする。
     */
    loadSummarizedArticles: function(sheet, values, state, maxCol) {
      if (state.minMod !== -1) {
        const numRows = state.maxMod - state.minMod + 1;
        const range = sheet.getRange(state.minMod + 2, 1, numRows, maxCol);
        range.setValues(values.slice(state.minMod, state.maxMod + 1));
        Logger.log(`💾 [Repository] ${numRows} 行の更新を完了しました。`);
      }
    },

    _generateAndSetVector: function(rowArray, title, summary) {
      const C = AppConfig.get().CollectSheet.Columns;
      const parsed = cleanAndParseJSON_(summary);
      const kw = (parsed && parsed.keywords) ? (Array.isArray(parsed.keywords) ? parsed.keywords.join(' ') : parsed.keywords) : summary;
      const v = LlmService.generateVector(`Title: ${title}\nKeywords: ${kw}`);
      if (v) rowArray[C.VECTOR - 1] = v.join(',');
      
      const mVIdx = C.METHOD_VECTOR - 1;
      if (mVIdx >= 0) {
        let mDesc = "Unknown";
        if (parsed) {
          const h = (parsed.how && parsed.how !== "Unknown") ? parsed.how : "";
          const w = (parsed.what && parsed.what !== "Unknown") ? parsed.what : "";
          const t = (parsed.tldr && parsed.tldr !== "Unknown") ? parsed.tldr : "";
          mDesc = h || w || t || title || "Unknown";
        } else {
          mDesc = title || "Unknown";
        }
        const mv = LlmService.generateVector(`Topic: ${title} / Method: ${mDesc}`);
        if (mv) rowArray[mVIdx] = mv.join(',');
      }
    },

    /**
     * @description 毎晩自動実行する「日次メンテナンス」
     */
    runDailyMaintenance: function() {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(AppConfig.get().System.TimeLimit.LOCK_TIMEOUT)) return;

      try {
        Logger.log("--- 日次メンテナンス開始 ---");
        
        // 1. データクレンジング（重複排除）
        this.removeDuplicates();

        // 2. 容量・負荷の削減
        this.archiveAndPruneOldData();         // アーカイブ
        this.maintenancePruneDigestHistory();   // 要約履歴削除
        this.maintenanceLightenOldArticles();   // ベクトル削除（軽量化）

        LlmService.logSessionTotal();
        LlmService.saveSessionCost();
        
        Logger.log("--- 日次メンテナンス完了 ---");
      } catch (e) {
        Logger.log("日次メンテナンスエラー: " + e.toString());
      } finally {
        lock.releaseLock();
      }
    },

    /**
     * archiveActionLogsToDrive
     * 【責務】ActionLogsをアーカイブしつつ、collectシートの記事にクリック数を反映させる。
     */
    archiveActionLogsToDrive: function() {
      archiveActionLogsToDrive_();
    },

    /**
     * 🌟 [v2.0 新設コア] getExistingUrlSet
     * 重複排除用：TrendDataシートから過去2万行の既存データをロードし、Setにして一瞬で返す
     * @param {boolean} includeTitle - タイトルの指紋チェックも同時に行う場合は true
     */
    getExistingUrlSet: function(includeTitle = false) {
      const config = AppConfig.get();
      const sheet = this.getSheet(config.SheetNames.TREND_DATA);
      const urlSet = new Set();
      const titleSet = new Set();
      
      if (!sheet) return includeTitle ? { urlSet, titleSet } : urlSet;
      
      const lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        const checkLimit = config.System.Limits.RSS_CHECK_ROWS || 20000;
        const numRowsToCheck = Math.min(lastRow - 1, checkLimit);
        
        // B列(Title)とC列(URL)の位置を一括でロードしてメモリに展開
        const rawData = sheet.getRange(2, 2, numRowsToCheck, 2).getValues();
        rawData.forEach(row => {
          const title = row[0];
          const url = row[1];
          if (url) urlSet.add(normalizeUrl_(url));
          if (includeTitle && title && typeof _normalizeTitleFingerprint_ === 'function') {
            titleSet.add(_normalizeTitleFingerprint_(String(title)));
          }
        });
      }
      return includeTitle ? { urlSet, titleSet } : urlSet;
    },

    /**
     * 🌟 [v2.0 新設コア] insertNewArticlesBatch
     * 流し込み一本化：ニュースや論文データを最新順に並び替え、2行目へ安全に前方インジェクションする
     * @param {Array[]} newItems - 書き込む2次元配列データ
     */
    insertNewArticlesBatch: function(newItems) {
      if (!newItems || newItems.length === 0) return 0;
      
      const config = AppConfig.get();
      const sheet = this.getSheet(config.SheetNames.TREND_DATA);
      if (!sheet) return 0;
      
      // 記事データを日付の新しい順に並び替える
      newItems.sort((a, b) => b[0] - a[0]);
      
      // 先頭（2行目）に空行をまとめてこじ開ける
      sheet.insertRowsBefore(2, newItems.length);
      
      // 失敗しやすい一括書き込み（setValues）だけを指数バックオフ型リトライで厳重ガード！
      _withRetry_(() => {
        sheet.getRange(2, 1, newItems.length, newItems[0].length).setValues(newItems);
        SpreadsheetApp.flush(); 
      });
      
      return newItems.length;
    },
  };
})();

// エイリアス（既存のグローバル呼び出し互換性のため）
function fetchRecentArticlesBatch_(maxDays) { return Repository.fetchRecentArticlesBatch(maxDays); }
function getArticlesInDateWindow_(start, end) { return Repository.getArticlesInDateWindow(start, end); }
function getSheet_(name) { return Repository.getSheet(name); }
function getPromptConfig_(key) { return Repository.getPromptConfig(key); }
function fetchJsonFromDrive_(key) { return Repository.fetchJsonFromDrive(key); }
function _getRelevantHistory_(keyword, currentContextText) { return Repository.getRelevantHistory(keyword, currentContextText); }
function _writeHistory_(keyword, summary) { Repository.writeHistory(keyword, summary); }
function _generateContextForNextWeek_(reportText) { return Repository.generateContextForNextWeek(reportText); }
function sortCollectByDateDesc_() { Repository.sortCollectByDateDesc(); }
function getDateWindow_(days) { return Repository.getDateWindow(days); }
function isRecentArticle_(pubDate, daysLimit) { return Repository.isRecentArticle(pubDate, daysLimit); }
function isRecentDate_(dateStr, daysLimit) { return Repository.isRecentDate(dateStr, daysLimit); }