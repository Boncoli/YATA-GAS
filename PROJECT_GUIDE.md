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
│   ├── do-check-feeds.js     # [New] RSSフィードの詳細診断（接続、形式、空フィード判定）を実行。
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
    *   **重要**: 書き出し後、DB内の `collect_archive` テーブルは手動で削除 (`DROP`) し、`VACUUM` を実行しないとファイルサイズは削減されません。
    *   **実績**: 2026年2月11日、アーカイブ残存データの削除と VACUUM により 217MB -> 32MB への削減を確認。

### 定期メンテナンス (自動)
*   **頻度**: 毎月1日 04:00 (crontab設定済み)
*   **実行ファイル**: `tasks/maintenance-db.js`
*   **対象**: 各種ログテーブル (`weather_log`, `remo_log`, `finance_log` 等) を180日分保持してアーカイブ・削除。
*   **注意**: この自動処理には `collect` (ニュース記事) テーブルは含まれません。記事の整理は必要に応じて手動で行います。

### 設定データのローカル管理 (2026/02 移行)
システムの自律性を高めるため、外部（Google スプレッドシート等）に依存していた設定データをローカルの JSON ファイルへ移行しました。

*   **RSSフィード**: `rss-list.json` (プロジェクトルート)
*   **LLMプロンプト**: `prompts.json` (プロジェクトルート)
*   **優先順位**: `gas-bridge.js` は、これらの JSON ファイルが存在する場合、スプレッドシートよりも優先して読み込みます。
*   **管理**: フィードは `tasks/manage-feeds.js` で管理可能です。プロンプトは直接 JSON を編集するか、後述の同期コマンドでスプレッドシートから更新できます。

### 通知・レポート機能
*   **Discord 投稿 (アクティブ)**: `tasks/do-discord-digest.js` により、毎朝前日のハイライトを投稿します。同時に、投稿内容は `history` テーブルに `DISCORD_DIGEST` というキーワードで保存されます。
*   **メールレポート (アクティブ・総集編モード)**: `tasks/do-send-report.js` が毎週月曜朝に実行されます。
    *   **特徴**: 生の記事群ではなく、**「過去1週間のDiscord投稿内容」をソースとして**高品質な総集編を生成します。これにより、情報の漏れがなく、かつ文脈の深い要約が可能になっています。
    *   **現状**: 実際のメール送信基盤（SMTP）は実装済みですが、`.env` の設定がない場合はログ出力のみのモックとして動作します。
*   **件名タグ**: メール（ログ）の件名には `[YATA-DAILY]` や `[YATA-WEEKLY]` タグが自動付与されます。

---

## 4. データフロー

1.  **起動 (`run-ram.sh`)**: Disk DB -> RAM DB コピー。環境変数 `DB_PATH` 設定。
2.  **収集 (`do-collect`)**: RSSフェッチ -> 重複チェック -> RAM DBへ保存。
3.  **加工 (`do-summarize`)**: 未要約記事抽出 -> LLM要約・ベクトル化 -> RAM DB更新。
4.  **配信**: 
    - Discord: `do-discord-digest.js` が昨日のまとめを生成・投稿。**投稿内容は history テーブルにアーカイブ。**
    - メール: `do-send-report.js` が **history から過去1週間分を吸い出し**、週刊総集編を生成して送信。
5.  **終了 (`run-ram.sh`)**: RAM DB -> Disk DB 書き戻し。
6.  **表示 (`dashboard.py`)**: Disk DB を読み取り専用で参照して描画。

> [!NOTE]
> **2026/02/11 更新**:
> 設定データの完全ローカル管理、および「Discord履歴を元にした高品質な週刊総集編」のハイブリッド運用を開始しました。すべての自動タスクは RAM ディスク経由に統一されています。

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
> [!CAUTION]
> **重要: 手動DB操作の注意点**
> このプロジェクトは `run-ram.sh` によりDBをRAM上で運用しています。手動でDBを操作（アーカイブや削除など）する場合は、必ず以下の手順を守ってください。
> 1. `export DB_PATH=/dev/shm/yata.db` を設定してからスクリプトを実行。
> 2. 実行後、`cp /dev/shm/yata.db yata.db` でディスクに書き戻す。
> これを怠ると、バックグラウンドプロセスの終了時にメモリ上の古いデータでディスクが上書きされてしまいます。

```bash
# 古い記事をJSONに退避する場合のフロー例
export DB_PATH=/dev/shm/yata.db
node tasks/archive-old-articles.js  # RAM上のDBを整理
node tasks/export-archive-json.js   # JSONへ書き出し
cp /dev/shm/yata.db yata.db         # ディスクへ反映
sqlite3 yata.db "DROP TABLE collect_archive; VACUUM;" # 後始末
```

**設定データの同期 (スプレッドシート -> ローカル)**:
```bash
# プロンプトの同期 (prompts.json の更新)
node -e 'const f=require("sync-fetch"),fs=require("fs"); const csv=f(process.env.PROMPTS_CSV_URL).text(); const rows=csv.split(/\r?\n/).map(l=>l.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c=>c.replace(/^"(.*)"$/,"$1").trim())); const p={}; rows.forEach((r,i)=>{if(i>0 && r[0]) p[r[0].trim()]=r[1].trim();}); fs.writeFileSync("prompts.json", JSON.stringify(p,null,2)); console.log("prompts.json updated.");'
```

**RSSフィード管理**:
```bash
node tasks/manage-feeds.js list             # 一覧表示
node tasks/manage-feeds.js add "URL" "名前"  # フィード追加
node tasks/manage-feeds.js remove 0         # インデックス指定で削除
node tasks/manage-feeds.js toggle 0         # 有効/無効の切り替え
```

**RSS診断（詳細版）**:
```bash
node tasks/do-check-feeds.js
```

**ダッシュボード確認**:
```bash
cd dashboard && python3 dashboard.py
```

---
*Last Updated: 2026-02-11 by Gemini Agent*