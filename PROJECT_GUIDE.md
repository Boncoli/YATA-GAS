# YATA Local Operation Guide (Raspberry Pi Edition)

このファイルは、Google Apps Script (GAS) 上で動作する YATA をラズパイ等のローカル環境で動作させるための構成と運用方法をまとめたものです。

## 📂 フォルダ構成と役割

```text
/home/boncoli/yata-local/
├── run-ram.sh           # 【重要】実行用エントリーポイント。RAMディスク同期とログ出力を担当
├── package.json         # Node.js 依存関係管理
├── .env                 # 環境変数（APIキー、DBパス、各設定値）
├── yata.db              # SQLite データベース本体（SDカード保存用）
│
├── lib/                 # コア・ライブラリ
│   ├── YATA.js          # システム本体（会社/GAS環境と共通のロジック）
│   └── gas-bridge.js    # GASの機能をNode.js/SQLiteで模倣する心臓部
│
├── tasks/               # 実行用ジョブ（エントリーポイント）
│   ├── yata-task.js     # 全自動タスク（収集・要約・環境ログを一本化）
│   ├── do-collect.js    # RSS収集のみを個別実行
│   └── do-summarize.js  # AI要約のみを個別実行
│
├── modules/             # 各種機能モジュール
│   ├── get-weather.js   # OpenWeatherMap API から天気を取得・記録
│   ├── get-remo.js      # Nature Remo API から室温等を取得・記録
│   └── sync-yata.js     # GAS/Spreadsheet とのデータ同期（オプション）
│
├── maintenance/         # 管理・メンテナンス
│   ├── do-backup.sh     # NASへのバックアップとログのローテーション
│   ├── check-api.js     # API接続診断
│   └── check-config.js  # 設定値の整合性チェック
│
└── logs/                # 実行ログ格納用
    ├── yata.log         # 全自動タスクの統合ログ
    ├── collect.log      # 収集個別ログ
    └── summarize.log    # 要約個別ログ
```

## 🛠 運用の仕組み

### 1. RAMディスク (RAM-DB) 運用
SDカードの摩耗を防ぐため、`run-ram.sh` が実行時に `yata.db` を `/dev/shm/` (RAM) にコピーして処理を行い、終了時に SDカードへ書き戻します。

### 2. GAS Bridge (gas-bridge.js)
GAS特有の `SpreadsheetApp` や `UrlFetchApp` を SQLite と `sync-fetch` で再現しています。
- **データ永続化:** 会社のGAS環境では古い記事を削除しますが、ラズパイ環境では `deleteRows` を無効化しており、全データを永久保存します。

### 3. 自動実行 (Cron)
現在は 30分おきに `yata-task.js` が自動実行されるように設定されています。

## 🚀 主要なコマンド

### 全タスク実行（通常運用）
```bash
./run-ram.sh yata-task.js
```

### ログの確認
```bash
tail -f logs/yata.log
```

### NASへのバックアップ（手動）
```bash
./maintenance/do-backup.sh
```

---
**YATA Local Project** - *Bridging the gap between Cloud Intelligence and Local Resilience.*
