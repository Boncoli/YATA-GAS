/**
 * tasks/stealth-backfill.js
 * 
 * 【ステルス型・手法ベクトルバックフィル】
 * - 過去30日分の未付与記事に対し、手法ベクトル(method_vector)を「コッソリ」付与
 * - CPU温度・メインタスク競合を監視し、低負荷な隙間時間のみ動作
 */

const fs = require('fs');
const path = require('path');

// 1. 環境設定
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('../lib/gas-bridge.js');
require('../lib/yata-loader.js');

const BATCH_SIZE = 10;      // 1回あたりの処理件数 (APIコスト・負荷を考慮)
const INTERVAL_MS = 60000;   // 実行間隔 (1分)
const TEMP_LIMIT = 70;      // CPU温度制限 (℃)

/**
 * CPU温度を取得 (Raspberry Pi専用)
 */
function getCpuTemp() {
  try {
    const tempStr = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    return parseFloat(tempStr) / 1000;
  } catch (e) {
    return 0; // 取得できない場合は0（制限なし）
  }
}

/**
 * メインタスクが実行中かチェック (ロックファイルの存在確認)
 */
function isMainTaskRunning() {
  const lockFile = '/dev/shm/yata-task.lock'; // run-ram.sh 等で作成される想定のロックファイル
  return fs.existsSync(lockFile);
}

async function stealthBackfill() {
  while (true) {
    try {
      // --- 安全チェック ---
      const temp = getCpuTemp();
      if (temp > TEMP_LIMIT) {
        console.log(`[Stealth] 🌡️ CPU温度が高い(${temp.toFixed(1)}℃)ため待機します...`);
        await new Promise(r => setTimeout(r, INTERVAL_MS * 5)); // 5分待機
        continue;
      }

      if (isMainTaskRunning()) {
        console.log("[Stealth] 🔒 メインタスク実行中のため待機します...");
        await new Promise(r => setTimeout(r, INTERVAL_MS * 2));
        continue;
      }

      // --- 対象記事の抽出 ---
      // 直近30日間で method_vector が未付与の記事を古い順に BATCH_SIZE 件取得
      // (古い順にやることで、過去データの「穴」を確実に埋めていく)
      const articles = global.YATA_DB.prepare(`
        SELECT id, title, abstract, summary 
        FROM collect 
        WHERE date >= date('now', '-30 days') 
          AND (method_vector IS NULL OR method_vector = '')
        ORDER BY date ASC 
        LIMIT ?
      `).all(BATCH_SIZE);

      if (articles.length === 0) {
        console.log("[Stealth] ✨ 全てのバックフィルが完了しました。タスクを終了します。");
        process.exit(0);
      }

      console.log(`[Stealth] 🚀 ${articles.length} 件の手法ベクトルを生成中...`);

      // --- ベクトル生成 ---
      const texts = articles.map(a => `Title: ${a.title}\nContent: ${a.summary || a.abstract || ""}`);
      
      // YATA.js の LlmService.generateVectorBatch を利用
      // (内部で OpenAI/Gemini の Embedding API が呼ばれます)
      const results = LlmService.generateVectorBatch(texts);

      if (results && results.length > 0) {
        // --- DB更新 (トランザクションで高速化) ---
        const update = global.YATA_DB.prepare("UPDATE collect SET method_vector = ? WHERE id = ?");
        const transaction = global.YATA_DB.transaction((items) => {
          for (const item of items) {
            // ベクトル配列をCSV文字列に変換して保存
            const vectorStr = item.vector.map(v => v.toFixed(6)).join(",");
            update.run(vectorStr, item.id);
          }
        });

        const updateItems = articles.map((a, i) => ({ id: a.id, vector: results[i] })).filter(x => x.vector);
        transaction(updateItems);
        
        console.log(`[Stealth] ✅ ${updateItems.length} 件を更新しました。 (残り ${articles.length - updateItems.length} 件スキップ)`);
      } else {
        console.warn("[Stealth] ⚠️ ベクトル生成に失敗しました。");
      }

    } catch (e) {
      console.error("[Stealth] ❌ エラー発生:", e.message);
    }

    // 次の実行まで待機
    console.log(`[Stealth] 💤 ${INTERVAL_MS / 1000}秒間スリープします...`);
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
}

console.log("=== YATA Stealth Backfill Service Start ===");
console.log(`Config: Batch=${BATCH_SIZE}, Interval=${INTERVAL_MS/1000}s, TempLimit=${TEMP_LIMIT}℃`);
stealthBackfill();
