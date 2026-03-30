# Changelog

## [1.4.4-local] - 2026-03-30
### Added
- **ADLM 専用スクレイパーの移植**: 本家 v1.4.4 より Clinical Laboratory News (ADLM) の直接収集ロジック (`collectAdlmFeed_`) を手術的に移植。ローカル環境での動作を確認済み。
- **サーバー群の完全復旧 & PM2永続化**: 再起動後に消失した PM2 プロセス（`yata-bot`, `yata-ai-server`）をガイドに基づき完全復旧。`pm2 save` により再起動時の自動起動を物理的に確定。
- **Windows 管理バッチの永続化対応**: シャットダウン・再起動時の SSH コマンドに `pm2 save` を組み込み、プロセスの消失を未然に防ぐ防壁を強化。

### Changed
- **GAS Bridge の一括更新対応**: v1.4.4 の高速バックフィルロジックに対応するため、`setValues` での複数列一括更新をサポート。1回の SQL 命令で 9 カラムを同時に書き換える SQLite 最適化を実装。

### Fixed
- **PM2 プロセス名の整合性修正**: `yata-llm` をガイド記載の正本名 `yata-ai-server` へ改名。

## [1.4.2.3] - 2026-03-29
### Fixed
- **OpenAI Responses API トークン記録の修正 (15/17問題)**: 
    - `/v1/responses` API が返す `usage` オブジェクトのキーが `prompt_tokens` ではなく `input_tokens` であることに対応。
    - 従来のキーが見つからない場合に `[object Object]` の文字数 (15) をカウントしてしまっていたフォールバック挙動を修正し、新旧両方のキー名（`input_tokens` / `output_tokens`）を正しくパース可能に。
    - `reasoning_tokens` も `output_tokens_details` から正確に抽出するよう拡張。

## [1.4.2.2] - 2026-03-28
### Added
- **Windows 管理バッチの近代化 (v4.6 Modern-Log)**:
    - ステータス表示部を大幅刷新。[RAM/SD]識別、本日新規数(+New)、要約待ち(Wait)、累計トークン(Tk)、最新天気・気温、AQI（空気質指数）を一画面に統合。
    - **鉄壁のエスケープ防壁**: Windows cmd.exe と SSH Bash 間の特殊記号衝突（||,シングルクォート等）を、SQLite `printf` 関数と `printf` フォーマットによる文字列構築に一本化することで完全に解消。
    - **集計ロジックの厳密化**: 本日記事カウントへの JST (+9h) 補正適用、および要約待ちカウントの参照先を `abstract` カラム（本文保持）へ修正し、実態に即した数値を表示。

## [1.4.2.1] - 2026-03-28
### Added
- **物理的データ減少ガード (Row Count Guard) の実装**:
    - `run-ram.sh` に同期直前の件数チェックを導入。SDカード側の件数に対し、RAM側の件数が 20% 以上減少している場合、同期（上書き）を強制停止し、Discord へ警告を送る「物理的ブレーキ」を確立。
- **動的インデックス特定 (Dynamic Header Search) の実装**:
    - `lib/gas-bridge.js` において、`setValues` 時に列番号（マジックナンバー）に依存せず、ヘッダー行から `url`, `title`, `date` 等のカラムを自動で探し出す「知能化」を適用。
    - 不正な ID (URL) が混入した際の書き込みスキップと詳細な警告ログ出力を追加。

### Fixed
- **大規模データ消失事故からの完全復旧**:
    - `lib/gas-bridge.js` のインデックス不整合と `run-ram.sh` の重複削除ロジックの連鎖により、2万件のデータが 500件まで削られた事故を、NAS の当日 15:28 バックアップから物理的に復元。
- **重複削除ロジックの安全化**:
    - `run-ram.sh` 内の未ガードな `sqlite3` 直接実行を廃止し、`maintenance/clean-db-duplicates.js`（Title空文字除外ガード付き）の呼び出しに一本化。

## [1.4.2] - 2026-03-28
### Fixed
- **物理的カラムマッピングの完全復旧**:
    - `YATA.js` が生成する配列構造 [0:Date, 1:Title, 2:URL, 3:Abstract, 4:Summary, 5:Source, 6:Vector...] に基づき、`gas-bridge.js` の全インデックス参照を物理的に 1:1 同期。
    - これにより、Title が ID カラムに混入し収集がスキップされていた致命的な不整合を根絶。
- **ダッシュボード表示の鮮度向上**:
    - ニュース表示クエリを `RANDOM()` から `date DESC` に変更。最新 3 件が確実に表示されるよう改善。

## [1.4.1] - 2026-03-28
### Fixed
- **stripHtml_ パッチの改修**: 改行をすべて半角スペースに置換して一行にまとめてしまうバグを修正。ブロック要素（p, div, h1-h6, br）の終了タグを改行に変換し、プレーンテキスト版メールの視認性を劇的に向上。
- **表示不具合の解消**: メールクライアントでレポートが「真っ白（一行に圧縮されすぎて見えない）」になる問題を解決。
- **管理コンソールの刷新 (v5.1.2)**: 階層メニューを廃止し、22個の全コマンドを1画面に集約。最短1アクションで実行可能に。
- **最強物理パッチ (Strong Patch System)**: `lib/yata-loader.js` を刷新。聖域の関数をリネーム退避させて独自ロジックを強制適用する「リネーム・インジェクション方式」を確立。GAS側の関数名変更（_付き）の影響を完全に遮断。
- **二刀流（ハイブリッド）検索**: セマンティック検索（256次元）に加え、AIが過去に蒸留した「キーワードJSON」をリアルタイムスキャンする救済ロジックを実装。文脈と論理の両面で記事を確実に拾い上げる。
- **ベクトル・キャッシュ**: 検索キーワードのベクトルを `server-properties.json` に永久保存する機能を実装。同一ワードでの再検索時の API コストをゼロ化し、速度を最大化. 
- **日刊レポートの高密度化**: R&D分析官視点の新プロンプトを適用。聖域の「日付順 break」バグを全件スキャンパッチで修正し、漏れのない読み物を生成。
- **リソース・物理保護**: レポート送信時のSD同期（Sync）を廃止し寿命を保護。sqlite-web起動時の3コア制限を自動化。

## [1.4.0] - 2026-03-28 (The Great Integration: 真・全統合版)
今回のアップデートは、ローカル環境 (Raspberry Pi) で先行していた高度な分析機能と、本家 (GAS/main) で導入された新しいデータ構造を完璧に融合させた「次世代の統合安定版」です。

### Added
- **1.4.0 構造化JSON (5W1H) の完全統合**: AI要約結果を個別のカラム（TL;DR, WHO, WHAT, HOW等）に保存する最新仕様を SQLite 側でも完全統合。
- **高密度コンテキスト・エンジン (Local Exclusive)**: ローカル独自の `getArticleContextForAnalysis_` を死守。分析時に JSON から「Unknown」を排除し、最高密度の文脈を LLM に供給することで分析精度を劇的に向上。
- **OpenAI Responses API (gpt-5-nano) の安定稼働**: 最新エンドポイントを用いた爆速・低コスト要約を実現。
- **環境診断・自動初期化プロトコル**: `initializeSystemProperties()` による設定不備の自動修復機能を統合。
- **過去記事の構造化バックフィルツール**: `toolBackfillStructuredSummaries` を追加。

## [1.3.3] - 2026-03-25
### Added
- **高密度コンテキスト・エンジン (High-Density Context Optimization)**:
    - 構造化抽出された 5W1H (who, what, how, result 等) の JSON から、`Unknown` 要素を排除し、論理的順序（WHAT→HOW→RESULT...）で再構成する高密度テキスト生成ロジック `getArticleContextForAnalysis_` を実装。
    - トレンド分析 (`generateTrendSections`) および予兆検知 (`EmergingSignalEngine`) に適用し、AI (miniモデル) への入力コンテキストを極限まで効率化。
    - 実データ検証により、文字数ベースで約 16〜30% のトークン削減と、分析精度の向上を物理的に証明。
- **実戦テストスイート**: 
    - `tests/test-context-optimization.js` (単体テスト) および `tests/test-real-trend-analysis.js` (実データによる AI 分析テスト) を追加。

### Changed
- **分析コンテキストの刷新**: 従来の「生の TL;DR (JSON形式)」から「素材ベースの高密度テキスト」へ移行。mini モデルの注意力を技術の核心（手法・成果）に集中させる設計へ進化。

### Fixed
- **物理的カラムマッピングの完全復旧**:
    - `YATA.js` が生成する配列構造 [0:Date, 1:Title, 2:URL, 3:Abstract, 4:Summary, 5:Source, 6:Vector...] に基づき、`gas-bridge.js` の全インデックス参照を物理的に 1:1 同期。
    - これにより、Title が ID カラムに混入し収集がスキップされていた致命的な不整合を根絶。
- **ダッシュボード表示の鮮度向上**:
    - ニュース表示クエリを `RANDOM()` から `date DESC` に変更。最新 3 件が確実に表示されるよう改善。

## [1.4.0] - 2026-03-28 (The Great Integration: 真・全統合版)
今回のアップデートは、ローカル環境 (Raspberry Pi) で先行していた高度な分析機能と、本家 (GAS/main) で導入された新しいデータ構造を完璧に融合させた「次世代の統合安定版」です。

### Added
- **1.4.0 構造化JSON (5W1H) の完全統合**: AI要約結果を個別のカラム（TL;DR, WHO, WHAT, HOW等）に保存する最新仕様を SQLite 側でも完全統合。
- **高密度コンテキスト・エンジン (Local Exclusive)**: ローカル独自の `getArticleContextForAnalysis_` を死守。分析時に JSON から「Unknown」を排除し、最高密度の文脈を LLM に供給することで分析精度を劇的に向上。
- **OpenAI Responses API (gpt-5-nano) の安定稼働**: 最新エンドポイントを用いた爆速・低コスト要約を実現。
- **環境診断・自動初期化プロトコル**: `initializeSystemProperties()` による設定不備の自動修復機能を統合。
- **過去記事の構造化バックフィルツール**: `toolBackfillStructuredSummaries` を追加。

### Fixed
- **Usage 記録の正常化**: API 通信ごとのモデル名と回数がログの最後に正確に表示されるよう修正。
- **健全性チェック・スクリプトの導入**: `tests/verify-db-integrity.js` を作成し、DB の物理的整合性検証をプロトコル化。
- **ベクトル計算の高速化**: 正規化済みベクトルを活かした内積 (Dot Product) 計算への置換。


## [1.3.3] - 2026-03-25
### Added
- **高密度コンテキスト・エンジン (High-Density Context Optimization)**:
    - 構造化抽出された 5W1H (who, what, how, result 等) の JSON から、`Unknown` 要素を排除し、論理的順序（WHAT→HOW→RESULT...）で再構成する高密度テキスト生成ロジック `getArticleContextForAnalysis_` を実装。
    - トレンド分析 (`generateTrendSections`) および予兆検知 (`EmergingSignalEngine`) に適用し、AI (miniモデル) への入力コンテキストを極限まで効率化。
    - 実データ検証により、文字数ベースで約 16〜30% のトークン削減と、分析精度の向上を物理的に証明。
- **実戦テストスイート**: 
    - `tests/test-context-optimization.js` (単体テスト) および `tests/test-real-trend-analysis.js` (実データによる AI 分析テスト) を追加。

### Changed
- **分析コンテキストの刷新**: 従来の「生の TL;DR (JSON形式)」から「素材ベースの高密度テキスト」へ移行。mini モデルの注意力を技術の核心（手法・成果）に集中させる設計へ進化。

## [1.3.2] - 2026-03-24
... [rest of file] ...All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-03-24
### Fixed
- **英語記事の要約が英語になる問題を根本修正**:
    - `BATCH_SYSTEM` プロンプトをはじめとする全要約プロンプトにおいて、「出力は必ず日本語（Japanese）で行うこと」という指示を【最重要】項目として明示的に追加。これにより OpenAI Responses API での多言語混在を解消。
- **要約フォールバック時の致命的バグ修正**:
    - `lib/YATA.js` の `summarizeBatch` 内において、バッチ処理失敗時の個別リトライ（フォールバック）で `this.summarize` という不正な呼び出しをしていた箇所を `LlmService.summarize` に修正。
- **OpenAI Responses API の安定化とパース防壁の構築**:
    - `lib/YATA.js` における `_callOpenAiResponses` の致命的バグ（システムプロンプトの指定ミスによる400エラー）を修正。新仕様に基づき `instructions` パラメータへ移行。
    - **鉄壁のパース処理**: `JSON.parse` 前の try-catch 保護、`output_text` の厳密な型チェック、短すぎる応答の除外、429 (Rate Limit) 時の自動スリープを実装。
    - 異常パラメータ `response_format` を廃止し、プロンプトベースでの JSON 抽出に回帰することで、API レスポンスの安定性を 100% 確保。
- **管理コンソールのマルチプラットフォーム完全対応**:
    - Windows 版ランチャー (`local_public/yata-launcher-windows.txt`) を刷新。不安定な PowerShell パイプを廃止し、Git Bash を活用したネイティブ `.sh` スクリプト方式へ転換。
    - `yata-menu-core.sh` におけるプロンプトのバッファリング問題を解消。改行付き `echo` への変更により、SSH 越しでもリアルタイムに入力を促すメッセージが表示されるよう改善。
- **セキュリティ & 運用性向上**:
    - `lib/gas-bridge.js` において、`curl` 実行ログ内の API キーを自動マスク (`sk-[MASKED]`) する防壁を実装。
    - 詳細なデバッグログを環境変数 `DEBUG_CURL=true` 時のみに制限し、通常の運用コンソールをクリーンに維持。

## [1.3.0] - 2026-03-23
### Added
- **ブランチ構造の純化と会社共有用セットの確立**:
    - `main` ブランチを会社共有用（GAS環境等）に必要な 6 ファイル（`lib/YATA.js`, `Index.html`, `Visualize.html`, `prompts.json`, `CHANGELOG.md`, `README.md`）に整理。不要なローカル用ファイル（`package.json`, `gas-bridge.js` 等）を物理的に排除し、視認性と安全性を向上。
    - `public` ブランチを OSS 公開用として再定義。機密情報を除いたサニタイズ済みの `prompts.json` とライセンスを含む配布用 6 ファイル構成へ集約。
    - 開発環境である `local-raspi` を「唯一の正本 (SSoT)」として物理的に分離・確立。
- **プロンプト命名の正常化とオーバーライド機構の導入**:
    - ファイル命名を実態に合わせ、`prompts.json`（標準/会社用・旧 `prompt_company.json`）と `prompts_local.json`（自分専用/ローカル用・旧 `prompts.json`）にリネーム・分離。
    - `lib/gas-bridge.js` を改修。ローカル環境では `prompts_local.json` を優先的に読み込み、なければ `prompts.json` を使用する「動的オーバーライド方式」を採用。
    - これにより、本家同期を維持しつつ、ローカル環境で自由にプロンプトをチューニングできる「安全なサンドボックス」を構築。
- **ドキュメントの品質向上**:
    - `PROJECT_GUIDE.md` におけるブランチ戦略と構成マトリックスを最新の状態に更新。
    - ドキュメント内の誤字（ハングル助詞「의」の混入等）を一括修正し、日本語としての純度を確保。

## [1.2.12] - 2026-03-21
### Added
- **究極のスクレイピング・エンジン (Ultimate Scraper Engine)**:
    - **物理的リダイレクト追跡**: Google News 等の複雑なリダイレクトを `curl` で物理的に最後まで追いかけ、真の記事 URL を 100% 特定する機能を実装。
    - **Python Trafilatura 連携**: 本文抽出の決定版ライブラリ `trafilatura` を Python ブリッジ経由で導入。広告やノイズを排除した純粋な本文のみを LLM に供給。
    - **RSS コンテンツ・フォールバック**: サイト側からのボット遮断時も、DB 内のタイトルと概要 (abstract) を自動的にソースとして使用し、解析を継続する堅牢なフェイルセーフを確立。
    - **バイナリ・デコーダー**: Google News URL の Base64 内部に含まれる URL をバイナリレベルでスキャンする独自ロジックを搭載。

## [1.2.11] - 2026-03-21


## [1.2.10] - 2026-03-21
### Added
- **API通信ごとの詳細コスト記録（SDカード非破壊アーキテクチャ）**:
    - `lib/gas-bridge.js` において、従来の1日累計に加え、通信ごとの詳細情報（タイムスタンプ、モデル名、入出力・推論トークン数、コスト）を `api_usage.log` にJSON Lines形式で記録する機能を実装。
    - SDカードの摩耗を防ぐため、記録先を RAM ディスク (`/dev/shm/api_usage.log`) に指定。
    - `maintenance/do-backup.sh` を改修し、毎朝4:35に RAM ディスクから NAS (`/mnt/nas/yata_logs/`) へ日別ファイルとして退避させ、過去30日分を安全に保管・ローテーションする仕組みに統合。これにより、特定時間帯における特定のモデル（nano等）の異常なトークン消費を追跡可能とした。

## [1.2.9] - 2026-03-20
### Added
- **5件バッチ要約「超節約モード」の導入**:
    - `lib/yata-loader.js` において、`LlmService.summarizeBatch` をオーバーライドする実行時パッチを実装。
    - 従来の「1記事1リクエスト」から「5記事1バッチ（1プロンプト）」へ移行し、入力トークンの約 60〜80% 削減を達成。
    - バッチ用プロンプトを `prompts.json` へ外出しし、設定の柔軟性を向上。
    - 失敗時に自動で「1件ずつモード」へ戻る堅牢なフォールバック機構を搭載。
- **検証用スクリプト**: `tasks/test-batch-summarize.js` を追加。

## [1.2.8] - 2026-03-19
### Added
- **究極の効率化 & ダッシュボード刷新**: 
    - プロンプト圧縮とSingle-Pass抽出（要約+手法）によりAPI通信回数を 33% 削減。
    - 電子ペーパーダッシュボードにLLM詳細統計（i/o/rトークン）、JST変換ニュース、詳細システムリソース表示を実装。
- **詳細トークン管理 (v1.2.7)**: 
    - APIから思考トークンを含む usage を正確に取得し、日次DB (`api_usage_daily`) に累積記録する機能を実装。

## [1.2.6] - 2026-03-19
### Fixed
- **HTML清掃 & コスト適正化**: 
    - DB内の `abstract` カラムに混入していた HTML タグ汚染(906件)を一括清掃。
    - `yata-loader.js` による強力な HTML ストリップ防壁を強化。
    - 要約プロンプトの自然化により、トークン爆増を制圧。

## [1.2.5] - 2026-03-19
### Fixed
- **ラッパースクリプトの引数消失バグ修正**: `run-ram.sh` のSDカード保護機能アップデート時（2月26日）に混入した潜在バグを修正。`--light` などの追加引数が Node.js に渡されず、5分毎のライトタスクが常にフルタスク（RSS全収集＋AI要約）として実行されていた致命的な不具合を解消。これによりRaspberry Piの負荷とAPIコストを劇的に削減。

### Changed
- **情報ポートフォリオの完成**: `rss-list.json` を大幅にアップデート。重複フィードを整理し、「ロイター（国際）」「BBC」「CNN」などのフラットな世界情勢と、「ナゾロジー」「sorae」「ねとらぼ」などの知的好奇心を刺激するエンタメ・科学ニュース枠を追加。YATAのAI要約エンジンに最適な「見出し＋スニペット」の形式で収集効率を最大化。

### Added
- **Gzip Compression Support (Bridge)**: `lib/gas-bridge.js` の `curl` コマンドに `--compressed` フラグを追加。本家 v1.2.5 から導入された `Accept-Encoding: gzip` レスポンスをローカル環境でも自動解凍・パース可能に。
- **isLikelyEnglish_ Override (Loader)**: 本家での関数名変更 (`isLikelyEnglish` -> `isLikelyEnglish_`) に対応。`lib/yata-loader.js` において、ローカルの緩和された判定ロジックを強制的に再注入し、システム全体の判定精度を維持。
