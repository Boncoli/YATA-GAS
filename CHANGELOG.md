# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
