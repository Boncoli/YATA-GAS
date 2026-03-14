# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
