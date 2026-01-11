#!/bin/bash

# --- 設定 ---
REAL_DB="/home/boncoli/yata-local/yata.db"
RAM_DB="/dev/shm/yata.db"
SCRIPT_DIR="/home/boncoli/yata-local"
NODE_SCRIPT="$1"

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

# 実行コマンド (共通部分)
CMD="/home/boncoli/.nvm/versions/node/v24.12.0/bin/node \"$SCRIPT_PATH\""

if [ -n "$LOG_FILE" ]; then
    # ログファイルあり: 画面出力 + ファイル追記 (tee -a)
    eval "$CMD" | while read line; do
        echo "$(date '+%Y-%m-%d %H:%M:%S') $line"
    done | tee -a "$LOG_FILE"
else
    # ログファイルなし: 画面出力のみ
    eval "$CMD" | while read line; do
        echo "$(date '+%Y-%m-%d %H:%M:%S') $line"
    done
fi

# --- 2.5 重複データの削除 (お掃除機能) ---
echo "[Wrapper] Cleaning up duplicates..."
# [Nuclear Option] タイトル毎にランク付け(1.要約あり優先 2.新着優先)し、1位以外を全て削除
sqlite3 "$DB_PATH" "DELETE FROM collect WHERE rowid IN (SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY title ORDER BY (CASE WHEN length(summary) > 5 THEN 1 ELSE 0 END) DESC, rowid DESC) as rn FROM collect) WHERE rn > 1);"

# --- 3. 終わったらRAMからSDへ書き戻す (データの保存) ---
echo "[Wrapper] Syncing back to SD card..."
cp "$RAM_DB" "$REAL_DB"
echo "[Wrapper] Done."