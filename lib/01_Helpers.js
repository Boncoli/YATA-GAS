/**
 * @file YATA-Helpers.js
 * @description 【責務】ビジネスロジックに依存しない、純粋な汎用ユーティリティ群の提供。
 * 【主要機能】日付フォーマット、HTML実体参照デコード、文字列正規化、JSON修復、数学計算（ベクトル演算等）。
 */

/**
 * @typedef {Object} YataArticle
 * @property {Date} date - 記事の取得/公開日時
 * @property {string} title - 記事のタイトル（日本語または英語）
 * @property {string} url - 記事のソースURL（これが一意のIDとして機能する）
 * @property {string} abstractText - 記事本文、抄録、または要約テキスト
 * @property {string} headline - AI要約結果のJSON文字列、または "SKIP: OLD_ARCHIVE" などのステータス
 * @property {string} [tldr] - AIが生成した要約（ファクトのみの1行要約）
 * @property {string} source - 記事の情報源・コレクター名（例: "PubMed", "AutoDetect" など）
 * @property {string} [vectorStr] - カンマ区切りの埋め込みベクトル文字列（1536d または 256d）
 * @property {number[]} [parsedVector] - パース済みの数値ベクトル配列
 * @property {number} [originalRowIndex] - スプレッドシート内の元の行インデックス
 * @property {number} [priorityScore] - 優先度ソートで計算されたスコア
 */

/**
 * @typedef {Object} YataRenderItem
 * @property {string} query - 検索クエリまたは拡張キーワード
 * @property {string} label - ユーザー向けに表示される検索キーワードのラベル
 * @property {YataArticle[]} articles - このキーワードにマッチし、重複排除された記事の配列
 * @property {boolean} useSemantic - セマンティック検索（ベクトル類似度）を使用したかどうかのフラグ
 */

/**
 * @typedef {Object} YataLlmOptions
 * @property {number} [temperature] - 生成パラメータ（ランダム性）
 * @property {string} [reasoning_effort] - 推論の熱量（"low" / "medium" / "high"）
 * @property {string} [verbosity] - 推論の冗長性
 * @property {number} [max_completion_tokens] - 最大出力トークン数
 * @property {number} [max_tokens] - 最大トークン数
 * @property {string} [taskLabel] - ロギング用のタスク識別ラベル
 * @property {boolean} [isFallback] - 個別1件処理への再帰フォールバック中であるかどうかの緊急ブレーキフラグ
 * @property {boolean} [isUiSearch] - 手動UI検索経由であるかどうかのフラグ
 * @property {string} [promptKey] - 使用するプロンプトのキー
 * @property {string} [modelOverride] - 使用するLLMモデルの強制上書き名
 */

/**
 * decodeHtmlEntities
 * 【責務】HTML実体参照（&amp;等）を通常の文字に戻す。
 */
function decodeHtmlEntities_(text) {
  if (!text) return "";
  return text.replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/&#039;/g, "'")
             .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
}

/**
 * fmtDate
 * 【責務】Date を "yyyy/MM/dd" 形式にフォーマット
 * @param {Date} d - Date オブジェクト
 * @returns {string} フォーマット済み日付文字列
 */
function fmtDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd");
}

/**
 * @description URLをトラッキングパラメータ等を除去して正規化します。Googleリダイレクトにも対応。
 * @param {string} url - 元のURL。
 * @returns {string} //domain/path 形式の正規化済みURL。
 */
function normalizeUrl_(url) {
  if (!url) return "";
  let s = String(url).trim();

  // 🌟 [最強の防衛線] もしURLがGoogleニュースの難読化URLなら、この時点で生のURLに完全復号する
  if (s.includes("news.google.com/") && typeof decodeGoogleNewsUrl_ === 'function') {
    s = decodeGoogleNewsUrl_(s);
  }
  
  try { s = decodeURIComponent(s); } catch (e) {}
  
  // Googleアラート/ニュースのリダイレクト対応
  if (s.includes("google.com/url") || s.includes("google.co.jp/url")) {
    const match = s.match(/[?&](?:q|url)=([^&]+)/);
    if (match && match[1]) {
      s = match[1]; 
      try { s = decodeURIComponent(s); } catch (e) {}
    }
  }

  // 0. ドメイン部分のみを小文字化する (パスやクエリの大文字小文字を破壊しない)
  try {
    const match = s.match(/^(https?:\/\/)([^/]+)(\/.*)?$/i);
    if (match) {
      s = match[1].toLowerCase() + match[2].toLowerCase() + (match[3] || "");
    } else {
      s = s.toLowerCase(); // フォールバック
    }
  } catch (e) {
    s = s.toLowerCase();
  }

  // 1. 一般的なトラッキングパラメータのみを除去 (YouTubeの ?v= 等は残す)
  s = s.replace(/([?&])(?:utm_[^=]+|gclid|yclid|fbclid)=[^&]*/gi, "");
  // 余った ? や & を綺麗にする
  s = s.replace(/[?&]$/, "").replace(/\?&/, "?");
  
  // 2. ハッシュ(#)の削除
  s = s.split('#')[0];
  
  // 3. 末尾スラッシュの削除
  s = s.replace(/\/$/, "");
  
  // 4. プロトコルとwwwの排除
  s = s.replace(/^https?:\/\/(www\.)?/, "//");
  
  return s;
}

/**
 * @description LLMが返したMarkdown形式や、途中で途切れた不完全なJSONを抽出し、可能な限りパース・修復します。
 * @param {string} text - LLMからの生の応答テキスト。
 * @returns {Object|null} 成功時はパース済みオブジェクト、修復不能な場合はnull。
 */
function cleanAndParseJSON_(text) {
  if (!text) return null;
  let cleaned = String(text).trim();

  // 1. Markdownのコードブロックを削除
  cleaned = cleaned.replace(/```json/gi, "").replace(/```/g, "").trim();

  // 2. 正常なJSONのパース試行 (AIが正しい形式で返せばここで100%成功する)
  const firstOpen = cleaned.indexOf('{');
  const lastClose = cleaned.lastIndexOf('}');

  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    let candidate = cleaned.substring(firstOpen, lastClose + 1);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      // 3. 【構文修復】AIが文字列内に未エスケープの「生の改行」を含めた場合の救済
      // 実際の改行をスペースに置換して再試行する
      try {
        let sanitized = candidate.replace(/\n/g, " ").replace(/\r/g, "");
        return JSON.parse(sanitized);
      } catch (e2) {
        // それでもダメなら最終手段へ
      }
    }
  }

  // 4. 【最終手段のフォールバック】
  try {
    const result = {};
    const tldrMatch = cleaned.match(/"(?:tldr|summary)"\s*:\s*"([\s\S]*?)(?:"|$)/);
    if (tldrMatch) result.tldr = tldrMatch[1].replace(/\n/g, " ");

    const methodMatch = cleaned.match(/"(?:how|method)"\s*:\s*"([\s\S]*?)(?:"|$)/);
    if (methodMatch) result.how = methodMatch[1].replace(/\n/g, " ");

    // 🌟 【追加】is_old フラグも救出する
    const isOldMatch = cleaned.match(/"is_old"\s*:\s*(true|false)/i);
    if (isOldMatch) result.is_old = (isOldMatch[1].toLowerCase() === "true");

    if (result.tldr || result.how || result.method || result.is_old !== undefined) return result;
  } catch (err) {}

  Logger.log("JSON Parse Error (Raw text): " + text);
  return null;
}

/**
 * markdownToHtml（超安定・プレースホルダー置換版）
 */
function markdownToHtml_(md) {
  if (!md) return "";
  const C = AppConfig.get().UI.Colors;
  const S = {
    WRAPPER: `font-family:sans-serif; color:#333; line-height:1.6;`,
    CARD: `background:#fff; padding:20px; border:1px solid #ddd; border-radius:8px; margin-bottom:20px; box-shadow: 0 2px 4px rgba(0,0,0,0.02);`,
    H3: `font-size:17px; color:${C.SECONDARY}; border-bottom:2px solid ${C.PRIMARY}; padding-bottom:8px; margin:0 0 15px 0;`,
    ITEM: `margin-bottom:8px; font-size:14px;`,
    SOURCES_ROW: `margin-top:15px; padding-top:10px; border-top:1px dashed #eee; font-size:12px;`,
    BADGE: `display:inline-block; background:#eaf2f8; color:#0066cc; text-decoration:none; padding:3px 8px; border-radius:4px; font-size:11px; margin-right:6px; margin-bottom:4px; border:1px solid #d4e6f1; font-weight:bold;`
  };

  let html = md.replace(/```[\s\S]*?```/g, "").trim();
  
  // 1. セキュリティ対策（HTMLタグの無効化）
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 2. 太字の処理
  html = html.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');

  // 3. H3（カードの見出し）
  html = html.replace(/^###\s+(.*$)/gim, `<h3 style="${S.H3}">$1</h3>`);

  // 4. SOURCES行の特別処理 (デザインを切り離す)
  html = html.replace(/^\s*-\s*<strong>SOURCES:<\/strong>\s*(.*)$/gm, `<div style="${S.SOURCES_ROW}"><span style="color:#999; font-weight:bold; margin-right:8px;">SOURCES:</span> $1</div>`);

  // 5. 箇条書き（通常の - 項目: 内容）
  html = html.replace(/^\s*-\s*<strong>([^<]+):<\/strong>\s*(.*)$/gm, `<div style="${S.ITEM}"><strong>$1:</strong> $2</div>`);

  // 6. ここで暗号をリンクバッジに変換！ (エスケープ後なので安全)
  html = html.replace(/\[\[BADGE\|([^\|]+)\|([^\]]+)\]\]/g, (match, label, url) => {
      // 🌟 絵文字や特殊記号を完全に排除し、安全な括弧表記 [ ソース名 ] に変更
      return `<a href="${url}" target="_blank" style="${S.BADGE}">[ ${label} ]</a>`;
  });

  // 7. カード分割と組み立て
  const parts = html.split(/<h3/);
  let finalHtml = `<div style="${S.WRAPPER}">`;
  if (parts[0].trim()) finalHtml += parts[0].replace(/\n/g, "<br>");
  
  for (let i = 1; i < parts.length; i++) {
    finalHtml += `<div style="${S.CARD}"><h3` + parts[i].replace(/\n/g, "") + `</div>`;
  }
  finalHtml += `</div>`;

  return finalHtml;
}

/**
 * stripHtml
 * 【責務】HTML タグを除去してテキスト抽出（改行維持・実体参照デコード対応）
 * @param {string} html - HTML テキスト
 * @returns {string} プレーンテキスト
 */
function stripHtml_(html) {
  if (!html) return "";
  let text = String(html);
  // スクリプトやスタイルを削除
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
  // ブロック要素の終了タグを改行に変換
  text = text.replace(/<\/p>|<\/div>|<\/h\d>|<br\s*\/?>/gi, '\n');
  // 残りのタグを削除
  text = text.replace(/<[^>]*>?/gm, ' ');
  // 実体参照をデコード
  text = text.replace(/&nbsp;/g, ' ')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&amp;/g, '&')
             .replace(/&quot;/g, '"')
             .replace(/&apos;/g, "'")
             .replace(/&#39;/g, "'");
  // 連続するスペースを1つに整理し、改行を適切に処理
  return text.split('\n')
             .map(line => line.replace(/\s+/g, ' ').trim())
             .join('\n')
             .replace(/\n{3,}/g, '\n\n')
             .trim();
}

/**
 * isLikelyEnglish
 * 【責務】テキストに日本語が含まれているか判定
 * @param {string} text - 判定対象テキスト
 * @returns {boolean} true=英語のみ, false=日本語含む
 */
function isLikelyEnglish_(text) {
  return !(/[぀-ゟ゠-ヿ一-鿿]/.test(text));
}

/**
 * @description 高度な検索クエリ（AND, OR, NOT, 括弧, 全角スペース, "フレーズ検索"）を解釈し、テキストが合致するか判定します。
 * @param {string} text - 検索対象の全文。
 * @param {string} query - 検索クエリ文字列。
 * @returns {boolean} マッチした場合はtrue。
 */
function isTextMatchQuery_(text, query) {
  if (!query) return false;
  if (!text) return false;

  const content = text.toLowerCase();
  
  let q = String(query)
    .replace(/　/g, " ") // 全角スペース -> 半角
    .trim();
    
  q = q.replace(/\(/g, " ( ").replace(/\)/g, " ) ");
  
  // 🌟 【修正点1】"" で囲まれた部分はスペースで分割せずに1つのまとまりとして抽出する
  const tokens = q.match(/("[^"]+"|[^"\s]+)/g) || [];
  
  // Level 1: Expression (Handles OR)
  function parseExpression(tokens) {
    let left = parseAndTerm(tokens);
    while (tokens.length > 0) {
      if (tokens[0].toUpperCase() === "OR") {
        tokens.shift();
        const right = parseAndTerm(tokens);
        left = left || right;
      } else {
        break;
      }
    }
    return left;
  }

  // Level 2: Term (Handles AND)
  function parseAndTerm(tokens) {
    let left = parseFactor(tokens);
    while (tokens.length > 0) {
      const next = tokens[0].toUpperCase();
      if (next === "OR" || next === ")") break; 
      
      if (next === "AND") tokens.shift();
      
      const right = parseFactor(tokens);
      left = left && right;
    }
    return left;
  }

  // Level 3: Factor (Handles Words, NOT, Parentheses, Phrases)
  function parseFactor(tokens) {
    if (tokens.length === 0) return false;
    
    let token = tokens.shift();
    
    if (token === "(") {
      const result = parseExpression(tokens);
      if (tokens.length > 0 && tokens[0] === ")") tokens.shift();
      return result;
    } else if (token.toUpperCase() === "NOT" || token.startsWith("-")) {
      let termToCheck;
      if (token === "-") {
         termToCheck = parseFactor(tokens);
      } else if (token.startsWith("-") && token.length > 1) {
         const word = token.substring(1);
         return !content.includes(word.toLowerCase());
      } else {
         termToCheck = parseFactor(tokens);
      }
      return !termToCheck;
    } else {
      // 🌟 【修正点2】"" で囲まれていた場合、両端の " を外してフレーズとして検索する
      if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
         token = token.slice(1, -1);
      }
      // 通常の単語・フレーズマッチ
      return content.includes(token.toLowerCase());
    }
  }

  return parseExpression([...tokens]);
}

/**
 * _logError
 * 【責務】エラーログを整形出力
 * @param {string} functionName - エラー発生関数名
 * @param {Error} error - エラーオブジェクト
 * @param {string} message - 補足メッセージ
 * @returns {none}
 */
function _logError_(functionName, error, message = "") {
  Logger.log(`[ERROR] ${functionName}: ${message} ${error.toString()} Stack: ${error.stack}`);
}

/**
 * @description スプレッドシート操作などの不安定な処理を、指数バックオフでリトライ実行します。
 * @param {Function} func - 実行したい処理。
 * @param {number} [maxRetries=3] - 最大試行回数。
 */
function _withRetry_(func, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return func();
    } catch (e) {
      if (i === maxRetries - 1) throw e; 
      Logger.log(`⚠️ Spreadsheet busy. Retrying (${i + 1}/${maxRetries}): ${e.toString()}`);
      // 指数バックオフ：1秒, 2秒, 4秒... と待機を増やす
      Utilities.sleep(Math.pow(2, i) * 1000); 
      // 内部バッファを強制クリアして状態をリセット
      SpreadsheetApp.flush(); 
    }
  }
}

/**
 * _scheduleRequestsByDomain
 * 同じドメインのリクエストが連続しないように並び替える（ラウンドロビン方式）
 */
function _scheduleRequestsByDomain_(items) {
  const domainMap = new Map();
  
  // 1. ドメインごとにグループ化
  items.forEach(item => {
    const d = item.domain;
    if (!domainMap.has(d)) {
      domainMap.set(d, []);
    }
    domainMap.get(d).push(item);
  });
  
  // 2. ラウンドロビンで取り出す
  const result = [];
  const groups = Array.from(domainMap.values());
  let maxLen = 0;
  
  // 最大のグループ長を知る
  groups.forEach(g => {
    if (g.length > maxLen) maxLen = g.length;
  });
  
  // 縦にスライスしていくイメージで取得
  for (let i = 0; i < maxLen; i++) {
    for (const group of groups) {
      if (i < group.length) {
        result.push(group[i]);
      }
    }
  }
  
  return result;
}

/**
 * _extractDomain
 * URLからドメイン名(ホスト名)を抽出する
 */
function _extractDomain_(url) {
  try {
    // 簡易的な抽出: プロトコル除去して最初のスラッシュまで
    let domain = url.replace(/^https?:\/\//, '').split('/')[0];
    return domain.toLowerCase();
  } catch (e) {
    return "unknown";
  }
}

/**
 * Keyword Observation Filter
 * 履歴比較を行わず、Keyword一致記事のみ抽出
 */
function filterArticlesByKeywords_(allArticles, keywords) {
  if (!keywords || keywords.length === 0) return [];

  // 🌟 【追加】ループに入る「前」に、全キーワードを英語・略称に一括拡張しておく
  const expandedKeywords = keywords.map(q => expandKeywordQuery_(q));

  return allArticles.filter(article => {
    const content = (
      String(article.title || "") + " " +
      String(article.headline || "") + " " +
      String(article.abstractText || "")
    );

    // 🌟 【変更】拡張済みのクエリを使って isTextMatchQuery_ で判定
    return expandedKeywords.some(query => isTextMatchQuery_(content, query));
  });
}

/**
 * _sortArticlesByPriority_ (フラグ制御・辞書シート・ログ出力対応版)
 */
function _sortArticlesByPriority_(articles, priorityKwsStr) {
  if (!priorityKwsStr || priorityKwsStr === "false") return articles;

  let dictionary = [];
  const pKwsStrLower = String(priorityKwsStr).toLowerCase();
  let dictType = "";

  // 1. 共通辞書を読み込む
  if (pKwsStrLower === "true" || pKwsStrLower === "〇") {
    dictType = "共通辞書(PriorityDictionary)";
    const dictSheet = getSheet_(AppConfig.get().SheetNames.PRIORITY_DICTIONARY);
    if (dictSheet) {
      const lastRow = dictSheet.getLastRow();
      if (lastRow > 1) {
        const data = dictSheet.getRange(2, 1, lastRow - 1, 2).getValues();
        dictionary = data.map(row => {
          const kwd = String(row[0]).trim();
          const score = parseFloat(row[1]);
          if (!kwd || isNaN(score)) return null;
          return {
            pattern: kwd.replace(/\s*\/\s*/g, " OR "),
            score: score
          };
        }).filter(Boolean);
      }
    }
  } 
  // 2. 個別辞書を作る
  else {
    dictType = "個別辞書(UsersシートK列)";
    const pKws = String(priorityKwsStr).split(',').map(k => k.trim()).filter(String);
    // 👇 スラッシュを「 OR 」に変換する処理を追加！
    dictionary = pKws.map(k => ({ pattern: k.replace(/\s*\/\s*/g, " OR "), score: 5.0 }));
  }

  if (dictionary.length === 0) return articles;

  // 3. 各記事をスコアリング
  const sortedArticles = articles.map(article => {
    let totalScore = 0;
    const content = String(article.title) + " " + String(article.abstractText) + " " + String(article.headline);
    
    dictionary.forEach(item => {
      if (isTextMatchQuery_(content, item.pattern)) {
        totalScore += item.score;
      }
    });
    
    return { ...article, priorityScore: totalScore };
  })
  .sort((a, b) => {
     if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore; 
     return b.date - a.date;
  });

  // 🌟 4. デバッグ用ログ出力（めちゃくちゃ役立ちます）
  const scoredCount = sortedArticles.filter(a => a.priorityScore > 0).length;
  Logger.log(`🎯 [優先度ソート] 方式: ${dictType} / 対象: ${articles.length}件中、${scoredCount}件にスコア加算`);
  
  if (scoredCount > 0) {
    // 上位3件をサンプルとしてログに出す
    sortedArticles.slice(0, 3).forEach((a, i) => {
      if (a.priorityScore > 0) {
        Logger.log(`   👑 ${i + 1}位 (${a.priorityScore}点): ${a.title.substring(0, 40)}...`);
      }
    });
  }

  return sortedArticles;
}

/**
 * 🌟 公的なレター形式（プレーンテキスト寄り）への変換
 */
function markdownToLetterStyle_(md) {
  if (!md) return "";
  
  let text = md.trim();
  
  // 太字を標準テキストに（公的レターでは強調を使いすぎない）
  text = text.replace(/\*\*([\s\S]+?)\*\*/g, '$1');
  
  // H3（見出し）を「■ 見出し」形式に変換
  text = text.replace(/^###\s+(.*$)/gim, '\n■ $1\n');
  
  // 箇条書き（- ）を「・ 」に統一
  text = text.replace(/^\s*-\s*/gm, '・ ');
  
  // 特殊バッジ [[BADGE|...]] をシンプルな [URL] 表記に変換
  text = text.replace(/\[\[BADGE\|([^\|]+)\|([^\]]+)\]\]/g, ' [$2]');

  // 🌟 追加: 標準的な Markdown リンク [テキスト](URL) を HTMLハイパーリンク に変換
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2">$1</a>');

  // HTMLの改行に変換しつつ、段落間を広げる
  return text.replace(/\n/g, '<br>');
}

/**
 * 🌟 [v2.0 新設コア] buildTrackingUrl_
 * 【責務】クリックトラッキング用の WebApp 配信URLを安全に組み立てる
 */
function buildTrackingUrl_(url, email, keyword) {
  if (!url) return "";
  const webAppUrl = PropertiesService.getScriptProperties().getProperty("WEBAPP_URL");
  if (webAppUrl && webAppUrl.includes("exec")) {
    return `${webAppUrl}?action=click&email=${encodeURIComponent(email || "Unknown")}&url=${encodeURIComponent(url)}&kw=${encodeURIComponent(keyword || "N/A")}`;
  }
  return url;
}

/**
 * 👑 [v2.0 新設コア] LogManager (中央統合ロガー)
 * @namespace Log
 * @description システム全体のイベント、警告、およびエラーを一元的につかみ、Discordや管理シートへ自動自動仕分けする。
 */
const Log = {
  info: function(msg) {
    Logger.log(`ℹ️ [INFO] ${msg}`);
  },
  
  warn: function(msg) {
    Logger.log(`⚠️ [WARN] ${msg}`);
    this._writeToLogSheet("WARN", msg);
  },
  
  error: function(funcName, err, customMsg = "") {
    const fullErrStr = `${customMsg} | Exception: ${err.toString()} | Stack: ${err.stack}`;
    Logger.log(`❌ [ERROR] in ${funcName}: ${fullErrStr}`);
    this._writeToLogSheet("ERROR", `[${funcName}] ${fullErrStr}`);
    
    // Discordウェブフック等が環境変数にあれば、ここに非同期通知の拡張フックを被せる
  },

  _writeToLogSheet: function(level, message) {
    try {
      const sheet = getSheet_(AppConfig.get().SheetNames.ACTION_LOGS);
      if (sheet) {
        // システムの限界を防ぐため、10行以内でサクッとシートへ追記
        const lock = LockService.getScriptLock();
        if (lock.tryLock(2000)) {
          sheet.appendRow([new Date(), "SYSTEM_LOGGER", level, "N/A", message.substring(0, 1000)]);
          lock.releaseLock();
        }
      }
    } catch(e) {
      Logger.log(`⚠️ ロガー自身がシート書き込みに失敗: ${e.toString()}`);
    }
  }
};

/** 既存の _logError_ も統合ロガーへ安全に架橋 */
function _logError_(functionName, error, message = "") {
  Log.error(functionName, error, message);
}

/**
 * calculateCosineSimilarity_
 * 【責務】二つのベクトルのコサイン類似度を計算する。
 */
function calculateCosineSimilarity_(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return -1;
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return (normA === 0 || normB === 0) ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * calculateDotProduct_
 * 【責務】二つのベクトルの内積を計算する。
 */
function calculateDotProduct_(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return -1;
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) dotProduct += vecA[i] * vecB[i];
  return dotProduct;
}

/**
 * parseVector_
 * 【責務】カンマ区切りの文字列または配列を数値ベクトルに変換・パースする。
 */
function parseVector_(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string' && val.trim() !== "" && !val.includes("[Error]")) {
    const arr = val.split(',').map(Number);
    return arr.some(isNaN) ? null : arr;
  }
  return null;
}

/**
 * fetchWithRetry_
 * 【責務】指数バックオフを用いて UrlFetchApp.fetch を安全にリトライ実行する。
 * @param {string} url - 取得対象のURL
 * @param {Object} options - UrlFetchAppのオプション
 * @param {number} [retries=3] - 最大試行回数
 * @returns {string} 取得したテキストコンテンツ
 */
function fetchWithRetry_(url, options, retries = 3) {
  let attempt = 0;
  let delay = 600;
  while (attempt < retries) {
    try {
      const res = UrlFetchApp.fetch(url, options);
      if (res.getResponseCode() === 200) return res.getContentText();
      throw new Error(`HTTP ${res.getResponseCode()}`);
    } catch (e) {
      attempt++;
      if (attempt >= retries) throw e;
      Utilities.sleep(delay);
      delay *= 2;
    }
  }
}