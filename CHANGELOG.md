# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-03-17
### Changed
- **本家同期 (YATA.js v1.2.1)**: `origin/main` から最新ロジックを同期。コードの整形、インデント調整を適用。
- **Web UI 改善 (HTML生成ロジック)**: `generateTrendReportHtml` 内で `markdownToHtml` を適用するように変更。Markdown 形式の AI 出力が Web ポータルのカード表示で崩れる問題を解消。
- **メンテナンス機能追加**: GAS 用の履歴アーカイブ・シート初期化関数 `toolArchiveAndClearHistory` を実装。

### Added
- **専門分野特化プロンプト**: 臨床検査・バイオ技術分野に特化した厳格なファクト監査プロンプト `prompt_company.json` を導入（Private）。
- **プレゼン用資料**: Reveal.js を使用したアーキテクチャ解説スライド `presentation.html` を追加。
- **公開用プロンプト雛形**: OSS 版向けに、専門分野を除去した汎用的なプロンプト雛形 `prompt_template.json` を整備。

## [1.2.0] - 2026-03-16
### Changed
- **ログの可観測性向上**: 各LLM通信関数およびラッパー関数に `taskLabel` を追加。要約、Method抽出などのタスク内容がログで明確に区別できるように改善。
- **リベンジロジックの追加**: 並列要約処理 (`summarizeBatch`) にリベンジロジックを追加。節約トークンで並列実行し、文字数上限(`length`)で途切れた場合のみ、大盛りトークン(`NANO_REVENGE`)で直列再試行するよう最適化。
- **設定値のAppConfig完全集約**: コード内に散在していた以下のマジックナンバーを `AppConfig` に集約。
  - バッチサイズと待機時間 (`LLM_BATCH_SIZE`, `LLM_BATCH_DELAY`)
  - ベクトル生成・履歴保持などの各種期間設定
  - APIトークン上限 (`MaxCompletionTokens`)
  - 類似検索の閾値、ジョブタイムアウト、為替レート、検索ヒット上限(`SEARCH_MAX_RESULTS`)など
- **GAS Bridge の強化**: 新たに追加された `getMaxRows` および `insertRowsAfter` メソッドを `gas-bridge.js` 側で安全に吸収するように対応。

## [1.0.4] - 2026-03-15
### Fixed
- **XML解析フォールバックの修正**: 前回のアップデートで `XmlService.parse` がエラーを投げないように変更した結果、正規表現フォールバックが発動せず `getChildren` 等でクラッシュする問題を修正。正しくエラーを投げるように戻し、安全にフォールバックへ移行するよう改善。

## [1.0.3] - 2026-03-15
### Fixed
- **RSS収集のクラッシュ修正**: `lib/gas-bridge.js` に `clearContent` 等の GAS 互換メソッドが不足していたため、ニュース収集が 3/12 から停止していた問題を解決。
- **XML解析の安定化 (Buggy)**: `XmlService.parse` がエラーを投げず、安全に正規表現フォールバックへ移行するように試みた（※この変更によりバグが発生し 1.0.4 で修正）。
### Changed
- **APIコスト最適化**: 過去記事への手法ベクトル（Method Vector）付与タスク (`yata-backfill`) を停止・削除。API の連続的な課金を抑制。
- **ブリッジ堅牢化**: `deleteRows`, `clear`, `setValue` などのスタブを実装し、将来的な GAS メソッド不足による事故を防止。

## [1.0.2] - 2026-03-14
### Fixed
- `YATA.js`: `performSemanticSearch` において、指定されたキーワードとの類似度が低い記事（無関係な記事）がレポートに混入する問題を修正。デフォルトの足切り閾値 (`0.32`) を導入し、検索精度を大幅に向上。
- `dashboard.py`: 為替(USD/JPY)グラフにおいて、Y軸の反転処理を削除し、円安が上方向になるように表示を修正。

## [1.0.1] - 2026-03-11
### Fixed
- `processSummarization`: 要約エラー時に生成されたベクトルと保存先記事がズレる致命的なバグを修正。
- `getVisualizationData`: 不正なベクトルデータのパース時にエラーで停止する問題を修正（安全なスキップ化）。
- `filterArticlesByKeywords`: タイトルや本文がない記事の検索エラーを防止し、高度な検索判定（`isTextMatchQuery`）に対応。
- `getRecipients`: 配信先メールアドレス取得時の曜日（Day）条件を撤廃し、全有効ユーザーを確実に対象化。
- `LlmService`: プロンプトにJSONが含まれる場合、強制的に `response_format: { type: "json_object" }` を付与し出力の安定性を向上。
### Added (Local-only)
- `tests/test-local-all.js`: SDカード書き込みゼロ・通信コストゼロで全ロジックを検証できる統合テストを導入。
- `tasks/stealth-backfill.js`: 過去記事に「手法ベクトル」をコッソリ付与する、低負荷なバックフィルサービスを実装。
- `gas-bridge.js`: `curl` 通信にリトライ機能（3回）を追加し、ネットワーク不安定時の耐性を強化。
- `gas-bridge.js`: データベース接続を `global.YATA_DB` で共有可能にし、各種スクリプト間の連携を最適化。

## [1.0.0] - 2026-03-10
### Added
- JSON強制モード (Structured Outputs) を導入し、LLMの出力パース失敗を完全に根絶。
- 記事ソースのリンクを安全かつ視認性の高いバッジ形式 (`[[BADGE|1|URL]]`) でレンダリングする新機能を実装。
- 日報やトレンド分析において、トピックごとに独立した美しいカード形式のHTMLレンダリングを実装。
- 汎用的なシステムプロンプトの完全版 (`prompt_template.json`) をOSS用に同梱。

### Changed
- `processKeywordAnalysisWithHistory` において、保存不要(`saveHistory=false`)な場合にコンテキスト圧縮AIが呼び出される仕様を修正し、APIコストを最適化。
- `generateTrendReportHtml` などの内部関数をグローバルに公開し、外部タスクからの柔軟な呼び出しを可能に変更。

### Fixed
- 本家仕様とローカル要望の排他制御の競合を解消し、24時間限定のカード型トレンドレポートタスク (`do-daily-trend.js`) が独立して動作するように修正。
