# YATA Project Guide (AI Context Document)

このドキュメントは、**YATA (Yet Another Trend Analyzer)** プロジェクトの全体像、アーキテクチャ、および開発・運用の「虎の巻」です。
AIエージェントや開発者は、作業を開始する前に**必ずこのファイルを読み込み、コンテキストを把握してください。**

---

## 1. プロジェクト概要

**YATA** は、元々Google Apps Script (GAS) で開発された「AI駆動型ニュース収集・分析プラットフォーム」を、**ローカルNode.js環境 (Raspberry Pi等)** に移植したプロジェクトです。

### コア・コンセプト
*   **GAS互換性**: メインロジック (`lib/YATA.js`) はGAS版とほぼ同一のコードベースを維持。
*   **GAS Bridge**: `lib/gas-bridge.js` がGASの標準サービス (`PropertiesService`, `UrlFetchApp`, `SpreadsheetApp`) を模倣し、SQLiteやローカルFSに処理を委譲。
*   **RAMディスク運用**: SDカード保護と高速化のため、実行時にDBをメモリ (`/dev/shm`) に展開して処理。
*   **ハイブリッド構成**: ロジックは Node.js、可視化（ダッシュボード）は Python。

---

## 2. ディレクトリ構造と主要ファイル

```text
/home/boncoli/yata-local/
├── lib/                      # コアライブラリ (最重要)
│   ├── YATA.js               # 【脳】メインロジック。要約、ベクトル化、トレンド分析。GAS版と共通。
│   ├── gas-bridge.js         # 【橋】GAS機能をNode.jsで再現し、SQLiteと接続する重要モジュール。
│   └── yata-loader.js        # YATA.jsをロードするラッパー。
├── tasks/                    # 実行タスク (Cron/手動実行用)
│   ├── yata-task.js          # 統合実行スクリプト (収集 -> 要約 -> 各種ログ取得)。
│   ├── do-collect.js         # RSS収集のみ実行。
│   ├── do-summarize.js       # AI要約のみ実行。
│   ├── archive-old-articles.js # [New] 古い記事をアーカイブテーブルへ移動・DBから削除。
│   └── export-archive-json.js  # [New] アーカイブテーブルをJSONに書き出し。
├── maintenance/              # メンテナンス用スクリプト
│   ├── clean-db-duplicates.js # DBの重複排除。
│   ├── migrate_add_aqi.js     # DBマイグレーション用。
│   └── do-backup.sh          # 定期バックアップ用シェルスクリプト。
├── modules/                  # 外部API連携モジュール (Node.jsネイティブ)
│   ├── get-weather.js        # OpenWeatherMap連携
│   ├── get-remo.js           # Nature Remo連携
│   └── ...
├── dashboard/                # Python製ダッシュボード (E-Ink/HDMI想定)
│   └── dashboard.py          # メイン表示ロジック。
├── archive/                  # [New] データバックアップ置き場
│   └── collect_before_20260205_1700.json # 過去データのJSONアーカイブ例。
├── run-ram.sh                # 【重要】実行ラッパー。DBをRAMにコピーしてNodeを実行し、書き戻す。
├── yata.db                   # SQLiteデータベース (永続化ファイル)。
└── server-properties.json    # GASの ScriptProperties 代替ファイル。
```

---

## 3. データ運用とメンテナンス (重要)

### データベース (SQLite)
*   **ファイル**: `yata.db` (メイン), `/dev/shm/yata.db` (実行時のRAMコピー)
*   **主要テーブル**:
    *   `collect`: ニュース記事、要約、ベクトルデータ。
    *   `weather_forecast`: 天気予報。
    *   `log`: システムログ。

### アーカイブ戦略 (2026/02 導入)
DBの肥大化を防ぐため、古い記事は定期的に JSON ファイルへエクスポートし、DB から削除する運用を行っています。

1.  **アーカイブ実施**:
    *   フィードの大幅入れ替え時や、DBサイズ削減時に実施。
    *   手順: `collect` テーブルから条件に合うデータを `collect_archive` へ移動 -> `collect` から削除。
2.  **JSONエクスポート**:
    *   `collect_archive` の内容を `archive/` フォルダへ JSON として書き出し。
    *   書き出し後、DB内の `collect_archive` テーブルは削除 (`DROP`) して軽量化。
    *   **現状**: 2026年2月5日 17:00 (JST) 以前のデータ 11,659 件は `archive/collect_before_20260205_1700.json` に退避済み。

---

## 4. データフロー

1.  **起動 (`run-ram.sh`)**: Disk DB -> RAM DB コピー。環境変数 `DB_PATH` 設定。
2.  **収集 (`do-collect`)**: RSSフェッチ -> 重複チェック -> RAM DBへ保存。
3.  **加工 (`do-summarize`)**: 未要約記事抽出 -> LLM要約・ベクトル化 -> RAM DB更新。
4.  **終了 (`run-ram.sh`)**: RAM DB -> Disk DB 書き戻し。
5.  **表示 (`dashboard.py`)**: Disk DB を読み取り専用で参照して描画。

---

## 5. 開発時の重要ルール

*   **GAS互換性の維持**: `lib/YATA.js` はGASでも動くように書く。Node.js固有機能は `gas-bridge.js` に隠蔽する。
*   **非同期の禁止**: `gas-bridge.js` 内の DB/Fetch 処理は `sync-fetch` 等を使って**同期的**に実装する。`YATA.js` は `async/await` を想定していない。
*   **Git運用とブランチ戦略 (重要)**:
    *   `main`: 会社/リモート (`origin`) と共通の本家ブランチ。
    *   `local-raspi`: ラズパイ環境専用のブランチ。日々の開発・運用はこのブランチで行う。
    *   **lib/YATA.js の編集禁止**: `lib/YATA.js` は本家と完全に一致させる必要があるため、**ローカルでの直接修正は厳禁**です。修正は本家側で行い、以下のコマンドで同期してください。
        `git fetch origin && git show origin/main:YATA.js > lib/YATA.js`
    *   `yata.db` や `node_modules` はコミットしない。

---

## 6. コマンドリファレンス

**通常タスク実行 (RAMディスク使用・推奨)**:
```bash
./run-ram.sh tasks/yata-task.js   # 全タスク (収集+要約+メンテ)
./run-ram.sh tasks/do-collect.js  # 収集のみ
./run-ram.sh tasks/do-summarize.js # 要約のみ
```

**アーカイブ・メンテナンス**:
```bash
# 古い記事をJSONに退避する場合のフロー例 (要スクリプト調整)
node tasks/archive-old-articles.js  # DB内でアーカイブテーブルへ移動
node tasks/export-archive-json.js   # JSONへ書き出し
sqlite3 yata.db "DROP TABLE collect_archive; VACUUM;" # 後始末
```

**ダッシュボード確認**:
```bash
cd dashboard && python3 dashboard.py
```

---
*Last Updated: 2026-02-05 by Gemini Agent*
