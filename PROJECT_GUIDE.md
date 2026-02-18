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
│   ├── YATA.js               # 【正本】メインロジック。要約、ベクトル化、トレンド分析。GAS版と共通。
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
├── run_weather_update.js     # [New] 天気情報の定期更新スクリプト。
├── run-ram.sh                # 【重要】実行ラッパー。DBをRAMにコピーしてNodeを実行し、書き戻す。
├── server.js                 # [New] 常駐型Webサーバー。iPhoneからのログ受信、検索API、地図表示を担当。
├── yata.db                   # SQLiteデータベース (永続化ファイル)。
└── server-properties.json    # GASの ScriptProperties 代替ファイル。
```

---

## 3. データ運用とメンテナンス (重要)

### データベース (SQLite)
*   **ファイル**: `yata.db` (メイン), `/dev/shm/yata.db` (実行時のRAMコピー)
*   **WALモード対応 (2026/02 強化)**: 
    *   高速書き込みを実現するため WAL (Write-Ahead Logging) を使用。
    *   `run-ram.sh` により、本体 (`.db`) だけでなく差分ログ (`.db-wal`) および共有メモリ (`.db-shm`) も同期対象とし、データの完全な整合性を確保。
*   **主要テーブル**:
    *   `collect`: ニュース記事、要約、ベクトルデータ。
    *   `drive_logs`: [New] iPhoneからのライフログ（位置、高度、バッテリー、メモ）。
    *   `weather_forecast`: 天気予報。
    *   `log`: システムログ。
    *   `fuel_logs`: [New] 愛車 (CX-80) の燃費・給油記録。

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
*   **頻度**: 毎月1日 04:02 (crontab設定済み)
*   **実行ファイル**: `tasks/maintenance-db.js`
*   **対象**: 各種ログテーブル (`weather_log`, `remo_log`, `finance_log` 等) を180日分保持してアーカイブ・削除。
*   **注意**: この自動処理には `collect` (ニュース記事) テーブルは含まれません。記事の整理は必要に応じて手動で行います。

### NASへの自動バックアップ (2026/02 強化)
SDカードの故障に備え、毎日 04:35 に NAS への包括的なバックアップを実施しています。
*   **スクリプト**: `maintenance/do-backup.sh`
*   **バックアップ対象**:
    *   **システム設定**: `/etc` フォルダ全体を `etc_backup.tar.gz` として圧縮保存（リンク保持のため）。
    *   **ホームディレクトリ**: `/home/boncoli` 以下を `rsync` 同期（`.git` 履歴を含む）。
    *   **データベース**: `yata.db` の日付付きスナップショット（過去30日分）。
    *   **復旧情報**: `package_list.txt` (インストール済パッケージ), `crontab_last.txt` (cron設定)。

#### 災害復旧 (Disaster Recovery) 手順
万が一 SD カードが全損した場合は、以下の手順で復旧を試みます。
1.  **OS基盤**: 新しい SD カードに Raspberry Pi OS をインストールし、最低限のネットワーク設定を完了させる。
2.  **パッケージ復元**: バックアップされた `package_list.txt` を参照し、必要なパッケージを再インストールする。
3.  **マウント復元**: `etc_backup.tar.gz` から `fstab` を確認し、NAS マウント (`/mnt/nas`) を再構築する。
4.  **データ連戻し**: NAS の `home_backup` からホームディレクトリの内容を `rsync` で書き戻す。
5.  **スケジュール復元**: `crontab crontab_last.txt` を実行して cron 設定を復元する。
6.  **サービス起動**: `pm2` 等の常駐プロセスを起動し、動作を確認する。

### 設定データのローカル管理 (2026/02 移行)
システムの自律性を高めるため、外部（Google スプレッドシート等）に依存していた設定データをローカルの JSON ファイルへ移行しました。

*   **RSSフィード**: `rss-list.json` (プロジェクトルート)
*   **LLMプロンプト**: `prompts.json` (プロジェクトルート)
*   **優先順位**: `gas-bridge.js` は、これらの JSON ファイルが存在する場合、スプレッドシートよりも優先して読み込みます。
*   **管理**: フィードは `tasks/manage-feeds.js` で管理可能です。プロンプトは直接 JSON を編集するか、後述の同期コマンドでスプレッドシートから更新できます。

### 通知・レポート機能
*   **Discord 投稿 (パーソナライズド・ハイライト)**: `tasks/do-discord-digest.js` により、毎朝 10:02 に前日のハイライトを投稿します。
*   **リアルタイム通知 (2026/02 強化)**: 
    - `OutCar` 時: 今回の推定走行距離を自動計算して Discord に投稿。
    - 給油時: 今回の区間燃費を即座に計算して Discord に報告。
*   **メールレポート (アクティブ・総集編モード)**: `tasks/do-send-report.js` が毎週月曜朝に実行されます。

---

## 4. AI コンシェルジュ & Portal (2026/02 導入)

プロジェクトの中枢に、対話型インターフェースが導入されました。

### AI アシスタント & Portal (2026/02 導入)

プロジェクトの中枢に、対話型インターフェースが導入されました。

*   **モデル**: `gemini-2.5-flash-lite` (軽量・高速・無料枠最大活用)。
*   **ポータル画面**: `local_public/portal.html` (スマホ対応)。
*   **チャットログ**: `ai_chat_log` テーブルに永続化。過去の会話や AI の独り言を保持します。
*   **Gemini の独り言 (2026/02/18 追加)**: 
    - `tasks/do-ai-mutter.js` により、周囲の状況（天気、行動ログ、ニュース）から AI が自律的に呟きを生成。
    - 生成された呟きはポータル上のチャット画面に自動で流れます。
*   **性格**: LINE風のフレンドリーで簡潔な口調。Markdown記号を使わず、絵文字を活用。

### Shared Memory (記憶の同期)
CLI（Gemini CLI）とポータルで、共通の「記憶」を共有する仕組みです。

1.  **記憶ファイル**: `/home/boncoli/.gemini/GEMINI.md`
2.  **ポータルからの自己更新**: チャットで「〜を覚えておいて」と頼むと、AI が Function Calling (`save_memory`) を使い、このファイルを自動更新。
3.  **NAS 同期**: 更新直後、`~/sync-gemini-memory.sh` が自動実行され、NAS (`DS220j`) と同期。これにより全筐体で記憶が共通化されます。

---

## 5. データフロー (2026/02 刷新)

1.  **起動 (`@reboot`)**: `run-ram.sh` により RAM へ DB 展開。
2.  **収集・要約**: 指定時間ごとに RSS 収集と AI 要約を実行。
3.  **常駐サーバー (`server.js`)**: iPhone からのログ（CarPlay / 給油）をリアルタイムに受信し、距離計算や Discord 通知を実行。
4.  **AI 連携**: ポータル画面を通じてユーザーと対話し、GEMINI.md を書き換えて自己進化。
5.  **終了・同期**: 定期的に RAM DB -> Disk DB へ書き戻し。

> [!NOTE]
> **2026/02/14 更新**:
> スケジュールを「ダッシュボード主役」に再編しました。ダッシュボードを10分刻み（00, 10, ...）に固定し、収集タスクを1分ずらすことで、表示の定時性とリソースの安定性を両立しています。

---

## 5. 開発時の重要ルール

*   **GAS互換性の維持**: `lib/YATA.js` はGASでも動くように書く。Node.js固有機能は `gas-bridge.js` に隠蔽する。
*   **非同期の禁止**: `gas-bridge.js` 内の DB/Fetch 処理は `sync-fetch` 等を使って**同期的**に実装する。`YATA.js` は `async/await` を想定していない。
*   **Git運用とブランチ戦略 (重要)**:
    *   `main`: 会社/リモート (`origin`) と共通の本家ブランチ。
    *   `local-raspi`: ラズパイ環境専用のブランチ。日々の開発・運用はこのブランチで行う。
    *   **lib/YATA.js の一元管理**: `lib/YATA.js` がプロジェクトの唯一の正本です。会社（GAS）への適用もこのファイルからコピーして行います。
    *   **同期手順**: 本家リモートから更新を取り込む際は、以下のコマンドを使用してください。
        `git fetch origin && git show origin/main:lib/YATA.js > lib/YATA.js`
    *   `yata.db` や `node_modules` はコミットしない。

## 6. プロセス管理 (PM2)

常駐サーバー（`server.js`）は、プロセスマネージャー **PM2** によって管理されています。これにより、ラズパイの再起動時やプロセスダウン時にも自動的に復旧します。

*   **サービス名**: `yata-server`
*   **実行コマンド実体**: `run-ram.sh server.js`
*   **主要操作**:
    ```bash
    pm2 status                # 稼働状況の確認
    pm2 restart yata-server   # ロジック更新後の再起動（反映）
    pm2 logs yata-server      # リアルタイムログの確認
    ```
*   **注意**: `lib/YATA.js` や `lib/gas-bridge.js` を修正した後は、必ず `pm2 restart` を行わないと、常駐サーバー側には反映されません。

---

## 7. コマンドリファレンス

**通常タスク実行 (RAMディスク使用・推奨)**:
```bash
./run-ram.sh tasks/yata-task.js   # 全タスク (収集+要約+メンテ)
./run-ram.sh tasks/do-collect.js  # 収集のみ
./run-ram.sh tasks/do-summarize.js # 要約のみ
```

**同期不備の解消**:
`run-ram.sh` は現在、SQLiteのWALファイルも同期します。これにより、常駐サーバーがDBを開きっぱなしでも最新データが確実にSDカードへ保存されます。

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



## 7. パーソナル・ライフログ (Mobile 連携)



2026年2月、個人の行動と知的好奇心を紐付ける「ライフログ・エンジン」が導入されました。



### 仕組み

*   **収集**: iPhoneの「ショートカット」アプリを使用。CarPlay接続/切断、自宅Wi-Fi接続/切断、写真撮影などをトリガーに、Tailscale経由で RasPi の `server.js` (Port 3001) へデータをPOSTします。

*   **蓄積**: 受信データは RAM ディスク上の `drive_logs` テーブルに即時保存され、5分おきに実行される `run-ram.sh` によりSDカードへ永続化されます。

*   **主なタグ (Action)**:

    *   `InCar` / `OutCar`: ドライブの開始と終了（CarPlay連携）。
        *   **最適化 (2026/02)**: `InCar` 時に前回の降車位置から100m以内であれば、GPS誤差を排除するため前回の位置情報を自動継承するロジックを搭載。これにより、滞在地点が地図上で一点に収束し、ログの美しさが向上。
        *   **自動レポート (2026/02)**: `OutCar` 受信時に `InCar` 地点からの最短道路距離を OSRM API で自動算出し、Discord へ走行報告を投稿する機能を搭載。
    *   `InHome` / `OutHome`: 帰宅と外出（Wi-Fi連携）。

        *   `photo`: 写真のメタデータ（位置、高度、ファイル名）。

        *   `spot`: 手動メモ付きの地点記録。

        *   `fuel`: [New] 燃費・給油記録（走行距離、給油量、単価、場所）。

    

    ### サーバー運用と自動起動 (PM2)

    常駐サーバー (`server.js`) は、プロセス管理ツール **PM2** によって管理されています。

    *   **自動復旧**: プロセスがクラッシュしても即座に再起動されます。

    *   **自動起動**: ラズパイの起動時に `systemd` を介して PM2 が立ち上がり、サーバーを自動実行します。

    *   **コマンド**:

        ```bash

        pm2 status          # 状態確認

        pm2 logs yata-server # ログ確認

        pm2 restart yata-server # 再起動

        ```

    

    ### 視覚化 (Visualization)

    *   **地図**: `http://[RasPi_IP]:3001/map.html` (走行軌跡、写真地点)

    *   **グラフ**: `http://[RasPi_IP]:3000` (Grafana)

        - 2026/02/11 再構築。SQLite プラグイン (`frser-sqlite-datasource`) を使用して `yata.db` を直接可視化。

        - 燃費推移、ガソリン代、走行距離の統計を表示。

    

    ---

    

    *Last Updated: 2026-02-11 by Gemini Agent*

    
