# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
