# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
