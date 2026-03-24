require('../lib/yata-loader.js');

/**
 * [Test Task] 真・汎用パイプラインの検証 (5W1H + result + keywords)
 */
async function testRichBatchSummarize() {
    // yata-loader.js が LlmService をグローバルに展開するのを待つ
    if (typeof LlmService === 'undefined') {
        console.log("⏳ LlmService のロードを待機中...");
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log("🚀 新次元構造化パイプラインのテストを開始します...");

    // テスト用の記事テキスト配列を作成
    const testArticleTexts = [
        "Title: トヨタ、新型EV向け次世代全固体電池の開発状況を公開\nAbstract: トヨタ自動車は2026年3月20日、次世代電気自動車（EV）への搭載を目指している全固体電池の開発が順調に進展していると発表した。エネルギー密度を従来比2倍に高め、充電時間を10分以下に短縮。2027年から2028年の実用化に向けて、製造プロセスの自動化ラインを報道陣に公開した。市場投入により、航続距離1200km以上の達成を目指す。",
        "Title: Apple、日本国内に新たなR&D拠点を開設\nAbstract: 米Appleは、横浜市内に人工知能（AI）と医療技術に特化した新たな研究開発拠点を設立した。日本国内の優秀なエンジニアを雇用し、次世代Apple Watchに搭載される血糖値測定センサーの小型化と、日本語に特化したLLMの軽量化を推進する。拠点は2026年4月より本格稼働を開始する予定。"
    ];

    console.log(`🤖 5.4-mini (Batch Mode) で ${testArticleTexts.length}件をリクエスト中...`);
    
    try {
        // yata-loader.js でパッチされた summarizeBatch を呼び出す
        // これにより prompts.json の最新プロンプトが使用される
        const results = LlmService.summarizeBatch(testArticleTexts);

        console.log("\n--- DB保存用データ (summaryカラムの中身) ---");
        results.forEach((jsonStr, i) => {
            console.log(`\n[記事 ${i+1}]`);
            try {
                const parsed = JSON.parse(jsonStr);
                console.log(JSON.stringify(parsed, null, 2));
            } catch (e) {
                console.log("Raw Output:", jsonStr);
            }
        });

        // コスト表示
        LlmService.logSessionTotal();

    } catch (e) {
        console.error("❌ テスト中にエラーが発生しました:", e.message);
    }
}

testRichBatchSummarize().catch(console.error);
