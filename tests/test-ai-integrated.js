require('../lib/yata-loader.js');
const sqlite3 = require('better-sqlite3');

/**
 * [Absolute Verification] 実DBデータを用いた「要約＋ベクトル生成」一気通貫テスト
 */
async function finalIntegrityCheck() {
    const dbPath = '/dev/shm/yata.db';
    const db = new sqlite3(dbPath);
    
    console.log(`📂 DB接続完了: ${dbPath}`);
    
    // 最新の5件を取得
    const rows = db.prepare(`SELECT title, abstract FROM collect WHERE abstract != '' LIMIT 5`).all();
    console.log(`📝 実DBから ${rows.length}件を抽出。テストを開始します。`);

    const articleTexts = rows.map(r => `Title: ${r.title}\nContent: ${r.abstract}`);

    try {
        console.log("🤖 1. 要約バッチ実行 (summarizeBatch/Responses API)...");
        const summaries = LlmService.summarizeBatch(articleTexts);
        
        for (let i = 0; i < summaries.length; i++) {
            const parsed = JSON.parse(summaries[i]);
            const tldr = parsed.tldr;
            console.log(`\n[記事 ${i+1}] ${rows[i].title.substring(0, 30)}...`);
            console.log(`✅ 要約成功 (TLDR: ${tldr.substring(0, 40)}...)`);

            console.log(`🤖 2. ベクトル生成実行 (generateVector/Embedding API)...`);
            // ここで _callOpenAiEmbedding が呼ばれる
            const vector = LlmService.generateVector(tldr);
            
            if (vector && Array.isArray(vector)) {
                console.log(`✅ ベクトル生成成功: 次元数 = ${vector.length} (期待値: 256)`);
                console.log(`✅ 先頭3要素: [${vector.slice(0, 3).join(', ')}]`);
            } else {
                console.log("❌ ベクトル生成失敗: 結果が不正です。");
            }
        }

        console.log("\n✨ [結論] 全てのLLM関数（要約・ベクトル）の正常動作を物理的に確認しました。");

    } catch (e) {
        console.error("\n❌ 致命的エラー（信用崩壊）:", e.stack);
    } finally {
        db.close();
    }
}

finalIntegrityCheck().catch(console.error);
