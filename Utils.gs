// =================================================================
// 🛠️ Utilities (ユーティリティ関数)
// =================================================================

/**
 * HTMLタグを除去するユーティリティ関数
 * @param {string} html HTML文字列
 * @returns {string} HTMLタグを除去した文字列
 */
function stripHtml(html) {
  return html ? html.replace(/<[^>]*>?/gm, '') : '';
}

/** 日本語が含まれるかの簡易判定（含まれるなら false / 英語判定は true） */
function isLikelyEnglish(text) {
  return !(/[぀-ゟ゠-ヿ一-鿿]/.test(text));
}

/** 1行化＆最大長トリミング */
function oneLine(text, maxLen) {
  var s = String(text).replace(/\s+/g, " ").trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - 1)) + "…";
}

/** 比較用に正規化（空白・句読点・記号を除去し、全角半角も大まかに吸収） */
function normalizeForCompare(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[ \u3000\t\r\n]/g, "")                   // 空白・改行除去（全角含む）
    .replace(/[「」『』【】\[\]\(\)　（）…・、。,:;.!?\'"\-–—]/g, "") // 句読点・記号
    .replace(/｜/g, "|");                              // 全角縦棒を半角へ
}

/** yyyy/MM/dd */
function fmtDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd");
}

/** yyyy/MM/dd HH:mm */
function fmtDateTime(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd HH:mm");
}

/** HTMLエスケープ */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,">&gt;");
}

/** `score|tldr` をパース */
function parseOnePSVLine(line) {
  if (!line) return null;
  var sep = line.indexOf("|");
  if (sep <= 0) return null;
  var s = line.slice(0, sep).trim();
  var t = line.slice(sep + 1).trim();
  var sc = parseInt(s, 10);
  if (isNaN(sc)) return null;
  if (!t) return { score: sc, tldr: "" };
  // tldrに '|' が紛れた時は全角へ置換
  t = t.replace(/\|/g, "｜");
  return { score: sc, tldr: t };
}
