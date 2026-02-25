#!/bin/bash

# --- 設定 ---
REAL_DB="/home/boncoli/yata-local/yata.db"
RAM_DB="/dev/shm/yata.db"
SCRIPT_DIR="/home/boncoli/yata-local"

# 引数解析
SYNC_BACK=true
SYNC_ONLY=false
if [[ "$1" == "--no-sync" ]]; then
    SYNC_BACK=false
    echo "[Wrapper] 🚀 Lazy Commit Mode: Sync back to SD will be skipped."
    shift
elif [[ "$1" == "--sync-only" ]]; then
    SYNC_ONLY=true
    echo "[Wrapper] 💾 Sync-Only Mode: Cleaning up and saving RAM DB to SD..."
    shift
fi

NODE_SCRIPT="$1"
shift

# ★ Dashboardなどは読み取り専用なので書き戻しをスキップする
READ_ONLY_MODE=false
if [[ "$NODE_SCRIPT" == *"dashboard"* ]]; then
    READ_ONLY_MODE=true
    SYNC_BACK=false
fi

# --- 1. RAMにDBがなければ, SDからコピーする ---
# 排他ロックを利用し、複数プロセスが同時にコピーを開始する競合(I/Oエラーの原因)を防止
exec 9>"/tmp/yata-ram-copy.lock"
flock 9

if [ ! -f "$RAM_DB" ]; then
    echo "[Wrapper] Copying DB to RAM..."
    if [ -f "$REAL_DB" ]; then
        cp "$REAL_DB" "$RAM_DB"
    else
        echo "[Wrapper] No existing DB found. Creating new on RAM."
        touch "$RAM_DB"
    fi
fi

# コピー用ロックの解放
flock -u 9
exec 9>&-

# ★ ここに追加！
# メモリ上のDBファイルとその関連ファイル（-wal, -shm）の権限を全開放する
chmod 666 "$RAM_DB" >/dev/null 2>&1
chmod 666 "$RAM_DB"-wal >/dev/null 2>&1
chmod 666 "$RAM_DB"-shm >/dev/null 2>&1

# --- 2. DBのパスを環境変数に入れてNodeを実行 (時刻ログ付き) ---
export DB_PATH="$RAM_DB"
export NODE_NO_WARNINGS=1
cd "$SCRIPT_DIR"

if [ "$SYNC_ONLY" = false ]; then
    echo "[Wrapper] Running $NODE_SCRIPT on RAM DB..."

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
        # ログありの処理
        eval "$CMD" | while read line; do
            echo "$(date '+%Y-%m-%d %H:%M:%S') $line"
        done | tee -a "$LOG_FILE"
    else
        # ログなしの処理
        eval "$CMD" | while read line; do
            echo "$(date '+%Y-%m-%d %H:%M:%S') $line"
        done
    fi
fi

# --- 2.5 重複データの削除 (お掃除機能) ---
if [ "$READ_ONLY_MODE" = false ]; then
    echo "[Wrapper] Cleaning up duplicates..."
    # [Nuclear Option] タイトル毎にランク付け(1.要約あり優先 2.新着優先)し、1位以外を全て削除
    sqlite3 "$DB_PATH" "DELETE FROM collect WHERE rowid IN (SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY title ORDER BY (CASE WHEN length(summary) > 5 THEN 1 ELSE 0 END) DESC, rowid DESC) as rn FROM collect) WHERE rn > 1);"
fi

# --- 3. 終わったらRAMからSDへ書き戻す (データの保存) ---
if [ "$SYNC_BACK" = true ]; then
    echo "[Wrapper] Syncing back to SD card..."
    # 排他ロックを利用し、複数プロセスが同時に書き戻す競合を防止
    exec 9>"/tmp/yata-sd-copy.lock"
    flock 9

    # WALとSHMも含めて同期するように改善
    cp "$RAM_DB" "$REAL_DB"
    [ -f "$RAM_DB-wal" ] && cp "$RAM_DB-wal" "${REAL_DB}-wal"
    [ -f "$RAM_DB-shm" ] && cp "$RAM_DB-shm" "${REAL_DB}-shm"
    
    # 書き戻したファイルの所有権を修正 (root実行対策)
    REAL_TARGET=$(readlink -f "$REAL_DB")
    chmod 666 "$REAL_TARGET" "${REAL_TARGET}-wal" "${REAL_TARGET}-shm" 2>/dev/null

    # ロック解放
    flock -u 9
    exec 9>&-
else
    if [ "$READ_ONLY_MODE" = true ]; then
        echo "[Wrapper] Read-only mode: Skipping sync back to SD card."
    else
        echo "[Wrapper] Lazy Commit: Changes remain on RAM. Sync back skipped."
    fi
fi
echo "[Wrapper] Done."