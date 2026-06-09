/**
 * @file 10_BehaviorIntelligence.js
 * @description 【責責】アーカイブされた行動ログと記事マトリクスの突合、およびユーザー関心の多角的プロファイリング分析。
 * 【主要機能】退避ログJSONの自動デコード、URLクレンジング突合、英日クエリ拡張名寄せ、関心度ランキングのUsersシート（PRIORITIES）への自動フィードバック。
 */

/**
 * @function analyzeUserBehaviorIntelligence
 * @description Drive上の過去の行動ログJSONと、現在の記事データを突合し、ユーザーごとの関心マトリクスを分析します。
 * 🌟【アップデート】英日名寄せエンジンを搭載し、上位関心キーワードをUsersシートへ自動書き戻し（学習フィードバック）します。
 */
function analyzeUserBehaviorIntelligence() {
  const config = AppConfig.get();
  
  // 1. 現在のスプレッドシート（collect）から記事データをロードしてインデックス化
  const collectSheet = Repository.getSheet(config.SheetNames.TREND_DATA);
  const lastRow = collectSheet.getLastRow();
  const articleMap = new Map(); // URL(正規化) ➔ 記事情報
  
  if (lastRow >= 2) {
    const SCAN_LIMIT = 3000;
    const rowsToFetch = Math.min(lastRow - 1, SCAN_LIMIT);
    const C = config.CollectSheet.Columns;
    const rawArticles = collectSheet.getRange(2, 1, rowsToFetch, C.KEYWORDS).getValues();
    
    rawArticles.forEach(row => {
      const url = row[C.URL - 1];
      const title = row[C.URL - 2];
      const keywords = row[C.KEYWORDS - 1] || "";
      
      if (url) {
        const normUrl = normalizeUrl_(url); // 表記揺れを完全パージ
        articleMap.set(normUrl, { title: title, keywords: keywords });
      }
    });
  }
  
  // 2. Driveのアーカイブフォルダから「ActionLogsの過去JSON」をスキャン
  const folderId = config.System.Archive.FOLDER_ID;
  if (!folderId) {
    Logger.log("❌ エラー: アーカイブフォルダIDが設定されていません。");
    return;
  }
  
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles();
  const userRawKeywords = {}; // Email ➔ { rawKw: count }
  
  Logger.log("📂 Driveから過去のユーザー行動ログ（JSON）を解析中...");
  
  while (files.hasNext()) {
    const file = files.next();
    if (file.getMimeType() === MimeType.PLAIN_TEXT && file.getName().startsWith("YATA_ActionLogArchive_")) {
      try {
        const jsonText = file.getBlob().getDataAsString("UTF-8");
        const logs = JSON.parse(jsonText);
        
        logs.forEach(log => {
          if (log.action !== 'click' || !log.email || !log.url) return;
          
          const email = log.email;
          const normUrl = normalizeUrl_(log.url);
          
          if (!userRawKeywords[email]) {
            userRawKeywords[email] = { clickCount: 0, rawMap: {} };
          }
          
          userRawKeywords[email].clickCount++;
          
          const matchedArticle = articleMap.get(normUrl);
          if (matchedArticle && matchedArticle.keywords) {
            const kwList = matchedArticle.keywords.split(',').map(k => k.trim()).filter(String);
            kwList.forEach(kw => {
              userRawKeywords[email].rawMap[kw] = (userRawKeywords[email].rawMap[kw] || 0) + 1;
            });
          }
        });
      } catch (e) {
        Logger.log(`⚠️ ファイル読み込みスキップ: ${file.getName()} - ${e.message}`);
      }
    }
  }
  
  // =================================================================
  // 🔥【データサイエンス・コア：アプローチ1による英日名寄せ ＆ 学習書き戻し】
  // =================================================================
  Logger.log("🧠 [名寄せエンジン] AIクエリ拡張を逆流させ、英日の表記揺れを統合中...");
  
  const finalUserProfiles = {}; // 集計後の綺麗データ
  
  for (const [email, rawProfile] of Object.entries(userRawKeywords)) {
    const mergedKeywords = {}; // 代表キーワード ➔ 合算カウント
    const processedKws = Object.entries(rawProfile.rawMap).sort((a,b) => b[1] - a[1]);
    
    for (const [kw, count] of processedKws) {
      // 🌟 既存の最強クエリ拡張エンジンを召喚 (例:「FDA承認」➔「FDA承認 OR FDA approval」)
      const expandedFormula = expandKeywordQuery_(kw); 
      let isMerged = false;
      
      // すでに登録済みの「代表キーワード」の拡張式と互換性があるかチェック
      for (const existingKw of Object.keys(mergedKeywords)) {
        // お互いの拡張式の中に、相手の単語が含まれているか（意味の包含関係を判定）
        if (isTextMatchQuery_(expandedFormula, existingKw) || isTextMatchQuery_(expandKeywordQuery_(existingKw), kw)) {
          // 被っていれば、よりカウントの多い「代表語」のバケットにカウントをガッチャンコ！
          mergedKeywords[existingKw] += count;
          isMerged = true;
          break;
        }
      }
      
      // 誰とも被らなければ、新しい「代表キーワード」として独立バケットを作成
      if (!isMerged) {
        mergedKeywords[kw] = count;
      }
    }
    
    finalUserProfiles[email] = {
      clickCount: rawProfile.clickCount,
      keywords: mergedKeywords
    };
  }

  // 3. 📊 分析結果のログ出力 と Usersシート（K列）への自動書き戻し
  const usersSheet = Repository.getSheet(config.SheetNames.USERS);
  const usrCols = config.UsersSheet.Columns;
  let userRowsData = [];
  if (usersSheet && usersSheet.getLastRow() >= 2) {
    userRowsData = usersSheet.getRange(2, 1, usersSheet.getLastRow() - 1, usersSheet.getLastColumn()).getValues();
  }

  Logger.log("\n==================================================");
  Logger.log("📊 [YATA データサイエンス部] ユーザー興味関心・多角分析レポート");
  Logger.log("==================================================");
  
  for (const [email, profile] of Object.entries(finalUserProfiles)) {
    Logger.log(`👤 閲覧者: 【 ${email} 】`);
    Logger.log(`📈 総クリックアクション数: ${profile.clickCount} 回`);
    
    // 🌟【改善点】上流で美しくTop 10件にスライスして確保！
    const sortedKeywords = Object.entries(profile.keywords)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
      
    if (sortedKeywords.length > 0) {
      Logger.log("🔥 関心のある統合キーワード (熱狂度順):");
      
      const topKeywordsForFeedback = [];
      
      sortedKeywords.forEach(([kw, count], idx) => {
        const density = ((count / profile.clickCount) * 100).toFixed(1);
        if (idx < 10) { 
          Logger.log(`   ${idx + 1}. [${kw}]: 累計合算 ${count}回 (関心濃度: ${density}%)`);
        }
        // 上位3つの優秀なキーワードを学習フィードバック対象としてストック
        if (idx < 3) {
          topKeywordsForFeedback.push(kw);
        }
      });
      
      // 🌟【全自動学習ループ：UsersシートのPRIORITIES（K列）への書き戻し】
      /* 💡 一時的に自動書き戻しを無効化（読み取り専用モード）
      if (email !== "Unknown" && usersSheet && userRowsData.length > 0) {
        const userRowIdx = userRowsData.findIndex(row => String(row[usrCols.EMAIL - 1]).toLowerCase().trim() === email.toLowerCase().trim());
        if (userRowIdx !== -1) {
          const targetRowNumber = userRowIdx + 2; // 実際のシートの行番号に補正
          const feedbackString = topKeywordsForFeedback.join(", ");
          
          // その人のK列（PRIORITIES）に、AIが選んだトップ3単語をガチッと自動上書き！
          usersSheet.getRange(targetRowNumber, usrCols.PRIORITIES).setValue(feedbackString);
          Logger.log(`✍️ [自律学習完了] 【${email}】様の優先キーワード(K列)を「${feedbackString}」に自動アップデートしました。`);
        }
      }
      */

    } else {
      Logger.log("🫙 蓄積データ不足、または突合した記事にキーワードが付与されていません。");
    }
    Logger.log("--------------------------------------------------");
  }
  Logger.log("==================================================");
} // ✨ 修正点：余分な「もう一つの }」を綺麗に消去！