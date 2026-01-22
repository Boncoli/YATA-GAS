#!/bin/bash

# --- 設定 ---
REAL_DB="/home/boncoli/yata-local/yata.db"
RAM_DB="/dev/shm/yata.db"
SCRIPT_DIR="/home/boncoli/yata-local"
NODE_SCRIPT="$1"
shift

# ★ Dashboardなどは読み取り専用なので書き戻しをスキップする
READ_ONLY_MODE=false
if [[ "$NODE_SCRIPT" == *"dashboard"* ]]; then
    READ_ONLY_MODE=true
fi

# --- 1. RAMにDBがなければ、SDからコピーする ---
if [ ! -f "$RAM_DB" ]; then
    echo "[Wrapper] Copying DB to RAM..."
    if [ -f "$REAL_DB" ]; then
        cp "$REAL_DB" "$RAM_DB"
    else
        echo "[Wrapper] No existing DB found. Creating new on RAM."
        touch "$RAM_DB"
    fi
fi

# ★ ここに追加！
# メモリ上のDBファイルとその関連ファイル（-wal, -shm）の権限を全開放する
chmod 666 "$RAM_DB" >/dev/null 2>&1
chmod 666 "$RAM_DB"-wal >/dev/null 2>&1
chmod 666 "$RAM_DB"-shm >/dev/null 2>&1

# --- 2. DBのパスを環境変数に入れてNodeを実行 (時刻ログ付き) ---
echo "[Wrapper] Running $NODE_SCRIPT on RAM DB..."
export DB_PATH="$RAM_DB"

cd "$SCRIPT_DIR"

# スクリプトのパス解決 (ルートになければ tasks/ を探す)
if [ -f "$NODE_SCRIPT" ]; then
  SCRIPT_PATH="$NODE_SCRIPT"
elif [ -f "tasks/$NODE_SCRIPT" ]; then
  SCRIPT_PATH="tasks/$NODE_SCRIPT"
else
  SCRIPT_PATH="$NODE_SCRIPT" # フォールバック
fi

# ログファイルの決定 (logs/ フォルダ配下にする)
LOG_FILE=""
if [[ "$NODE_SCRIPT" == *"do-collect"* ]]; then
  LOG_FILE="logs/collect.log"
elif [[ "$NODE_SCRIPT" == *"do-summarize"* ]]; then
  LOG_FILE="logs/summarize.log"
elif [[ "$NODE_SCRIPT" == *"yata-task"* ]]; then
  LOG_FILE="logs/yata.log"
fi

# 実行コマンドの判定
if [[ "$NODE_SCRIPT" == *.py ]]; then
    # 末尾に "$@" を追加（クォーテーションで囲むのがコツ）
    CMD="python3 -u \"$SCRIPT_PATH\" \"\$@\""
else
    # 末尾に "$@" を追加
    CMD="/home/boncoli/.nvm/versions/node/v24.12.0/bin/node \"$SCRIPT_PATH\" \"\$@\""
fi

if [ -n "$LOG_FILE" ]; then
    # ログありの処理（さきほどのスニペット通り）
    eval "$CMD" | while read line; do
        echo "$(date '+%Y-%m-%d %H:%M:%S') $line"
    done | tee -a "$LOG_FILE"
else
    # ログなしの処理（ここも eval "$CMD" を使う）
    eval "$CMD" | while read line; do
        echo "$(date '+%Y-%m-%d %H:%M:%S') $line"
    done
fi

# --- 2.5 重複データの削除 (お掃除機能) ---
if [ "$READ_ONLY_MODE" = false ]; then
    echo "[Wrapper] Cleaning up duplicates..."
    # [Nuclear Option] タイトル毎にランク付け(1.要約あり優先 2.新着優先)し、1位以外を全て削除
    sqlite3 "$DB_PATH" "DELETE FROM collect WHERE rowid IN (SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY title ORDER BY (CASE WHEN length(summary) > 5 THEN 1 ELSE 0 END) DESC, rowid DESC) as rn FROM collect) WHERE rn > 1);"
fi

# --- 3. 終わったらRAMからSDへ書き戻す (データの保存) ---
if [ "$READ_ONLY_MODE" = false ]; then
    echo "[Wrapper] Syncing back to SD card..."
    cp "$RAM_DB" "$REAL_DB"
else
    echo "[Wrapper] Read-only mode: Skipping sync back to SD card."
fi
echo "[Wrapper] Done."