# YATA Project Guide (AI Context Document)

このドキュメントは、**YATA (Yet Another Trend Analyzer)** プロジェクトの全体像、アーキテクチャ、および開発時の注意点をまとめたものです。
AIエージェントは、作業を開始する前に**必ずこのファイルを読み込み、コンテキストを把握してください。**

---

## 1. プロジェクト概要

**YATA** は、元々Google Apps Script (GAS) で開発された「AI駆動型ニュース収集・分析プラットフォーム」を、**ローカルNode.js環境 (Raspberry Pi等)** に移植したプロジェクトです。

### コア・コンセプト
*   **GAS互換性**: メインロジック (`lib/YATA.js`) はGAS版とほぼ同一のコードベースを維持しています。
*   **GAS Bridge**: `lib/gas-bridge.js` がGASの標準サービス (`PropertiesService`, `UrlFetchApp`, `SpreadsheetApp` 等) を模倣し、ローカルのSQLiteやファイルシステムに処理を委譲します。
*   **RAMディスク運用**: SDカードの寿命延命と高速化のため、実行時にDBをメモリ (`/dev/shm`) に展開して処理します。
*   **ハイブリッド構成**: ロジックは Node.js、可視化（ダッシュボード）は Python で実装されています。

---

## 2. ディレクトリ構造と主要ファイル

```text
/home/boncoli/yata-local/
├── lib/                      # コアライブラリ (最重要)
│   ├── YATA.js               # 【脳】メインロジック。要約、ベクトル化、トレンド分析など。GAS版と共通。
│   ├── gas-bridge.js         # 【橋】GASの機能をNode.jsで再現し、SQLiteと接続する重要モジュール。
│   └── yata-loader.js        # YATA.jsをNode.js環境でロードするためのラッパー。
├── tasks/                    # 実行タスク (Cron/手動実行用)
│   ├── yata-task.js          # 統合実行スクリプト (収集 -> 要約 -> 各種ログ取得)。
│   ├── do-collect.js         # RSS収集のみ実行。
│   └── do-summarize.js       # AI要約のみ実行。
├── modules/                  # 外部API連携モジュール (Node.jsネイティブ)
│   ├── get-weather.js        # OpenWeatherMap連携
│   ├── get-remo.js           # Nature Remo連携
│   ├── get-finance.js        # 株価・為替取得
│   └── ...
├── dashboard/                # Python製ダッシュボード (E-Ink/HDMI想定)
│   ├── dashboard.py          # メイン表示ロジック (Pillow + Matplotlib)。
│   └── stock_grid.py         # 株価チャート生成ロジック。
├── run-ram.sh                # 【重要】実行ラッパー。DBをRAMにコピーしてNodeを実行し、書き戻す。
├── yata.db                   # SQLiteデータベース (永続化ファイル)。
└── server-properties.json    # GASの ScriptProperties を代替する設定ファイル。
```

---

## 3. データフローとアーキテクチャ

### データベース (SQLite)
`yata.db` が中心的なデータストアです。
*   **collect**: ニュース記事、要約、ベクトルデータを格納。
    *   重要: `date` カラムは `gas-bridge.js` によって読み出し時に `Date` オブジェクトに変換されます。
*   **weather_forecast**: 天気予報データ。
*   **log**: システムログ。

### 処理の流れ
1.  **起動 (`run-ram.sh`)**:
    *   `yata.db` (Disk) を `/dev/shm/yata.db` (RAM) にコピー。
    *   環境変数 `DB_PATH` をRAM側のパスに設定。
2.  **収集 (`do-collect` / `runCollectionJob`)**:
    *   RSSをフェッチ -> 重複チェック -> `collect` テーブルに INSERT。
3.  **加工 (`do-summarize` / `runSummarizationJob`)**:
    *   未要約の記事を抽出 -> LLM (Gemini/OpenAI) APIへ送信 -> 要約とベクトル生成 -> `collect` テーブルを UPDATE。
4.  **終了 (`run-ram.sh`)**:
    *   RAM上のDBをディスクに書き戻し (`cp`)。
5.  **表示 (`dashboard.py`)**:
    *   PythonスクリプトがDBを**読み取り専用**で参照し、画像を生成・表示。

---

## 4. 開発・修正時の重要ルール

### A. `lib/YATA.js` の修正
*   **GAS互換性を壊さない**: `require` や `process.env` などのNode.js固有機能は、原則として `gas-bridge.js` 側に隠蔽するか、`if (typeof require !== 'undefined')` ブロック内で記述してください。
*   **日付型**: GASではスプレッドシートから読み込むと `Date` 型になります。Bridge側でもこれを再現しているため、ロジック内で「日付文字列」ではなく「Dateオブジェクト」として扱ってください。

### B. `lib/gas-bridge.js` の仕様
*   **同期処理**: `sync-fetch` と `better-sqlite3` を使用して、GASの同期的な挙動 (`await` なしでのHTTPリクエストやDB操作) を再現しています。安易に `async/await` を導入すると、呼び出し元の `YATA.js` が壊れます。
*   **モック機能**: `LanguageApp.translate` は実装されていません（入力をそのまま返す）。`XmlService` は正規表現フォールバック (`_fallbackParseRssRegex`) に委譲されます。

### C. 設定管理
*   GASの `Project Settings > Script Properties` は、ローカルでは `server-properties.json` (自動生成/更新) および `.env` ファイルで管理されます。
*   新しいAPIキーなどは `.env` に追加し、Bridge経由で読み込みます。

---

## 5. コマンドリファレンス

**通常実行 (RAMディスク使用・安全)**:
```bash
./run-ram.sh yata-task.js   # 全タスク実行
./run-ram.sh do-collect.js  # 収集のみ
```

**ダッシュボード生成**:
```bash
cd dashboard
python3 dashboard.py
```

**Git運用**:
*   `yata.db` (バイナリ) や `node_modules` は `.gitignore` されています。
*   変更を加えた際は、必ず関連するテスト (`tests/` 配下) または動作確認を行ってください。

---

## 6. 将来の拡張に向けたメモ
*   **ベクトル検索**: 現在は `YATA.js` 内でコサイン類似度計算を行っていますが、データ量が増えた場合、SQLiteの拡張モジュール (`sqlite-vss` 等) への移行を検討する余地があります。
*   **Web UI**: 現在の `doGet` はGAS特有のエントリーポイントです。将来的にExpress.js等でWebサーバー化する場合、このルーティングロジックを再利用可能です。

---
*Created: 2026-01-16 by Gemini Agent*