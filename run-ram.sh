#!/bin/bash

# --- 設定 ---
REAL_DB="/home/boncoli/yata-local/yata.db"
RAM_DB="/dev/shm/yata.db"
SCRIPT_DIR="/home/boncoli/yata-local"

# 引数解析
SYNC_BACK=true
SYNC_ONLY=false
NODE_SCRIPT=""
EXT_ARGS=()

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --no-sync)
            SYNC_BACK=false
            shift
            ;;
        --sync-only)
            SYNC_ONLY=true
            shift
            ;;
        -*)
            EXT_ARGS+=("$1")
            shift
            ;;
        *)
            if [ -z "$NODE_SCRIPT" ]; then
                NODE_SCRIPT="$1"
            else
                EXT_ARGS+=("$1")
            fi
            shift
            ;;
    esac
done

# ★ 安全装置：頻繁に実行される特定のスクリプトは、デフォルトで --no-sync 扱いにする
# これにより、指定し忘れによるSDカードの摩耗を防ぐ
if [[ "$NODE_SCRIPT" == *"do-ai-mutter"* ]] || [[ "$NODE_SCRIPT" == *"dashboard"* ]] || [[ "$NODE_SCRIPT" == *"do-health-check"* ]]; then
    if [ "$SYNC_BACK" = true ] && [ "$SYNC_ONLY" = false ]; then
        SYNC_BACK=false
        LAZY_REASON="[Auto-Protect]"
    fi
fi

if [ "$SYNC_BACK" = false ]; then
    echo "[Wrapper] 🚀 Lazy Commit Mode ${LAZY_REASON}: Sync back to SD will be skipped."
fi

if [ "$SYNC_ONLY" = true ]; then
    echo "[Wrapper] 💾 Sync-Only Mode: Cleaning up and saving RAM DB to SD..."
fi

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
      LOG_FILE="/dev/shm/collect.log"
    elif [[ "$NODE_SCRIPT" == *"do-summarize"* ]]; then
      LOG_FILE="/dev/shm/summarize.log"
    elif [[ "$NODE_SCRIPT" == *"yata-task"* ]]; then
      LOG_FILE="/dev/shm/yata.log"
    fi

    # 実行コマンドの判定
    if [[ "$NODE_SCRIPT" == *.py ]]; then
        # 末尾に "${EXT_ARGS[@]}" を追加
        CMD="python3 -u \"$SCRIPT_PATH\" ${EXT_ARGS[@]}"
    else
        # 末尾に "${EXT_ARGS[@]}" を追加
        CMD="/home/boncoli/.nvm/versions/node/v24.12.0/bin/node \"$SCRIPT_PATH\" ${EXT_ARGS[@]}"
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
    echo "[Wrapper] Cleaning up duplicates using maintenance/clean-db-duplicates.js..."
    # 💡 直接 SQL を叩くのは危険なため、ガードの効いた JS スクリプトを呼び出す
    /home/boncoli/.nvm/versions/node/v24.12.0/bin/node "$SCRIPT_DIR/maintenance/clean-db-duplicates.js" >> "$LOG_FILE" 2>&1
fi

# --- 3. 終わったらRAMからSDへ書き戻す (データの保存) ---
if [ "$SYNC_BACK" = true ]; then
    echo "[Wrapper] 🛡️ Performing safety check before syncing..."
    
    # 🌟 Row Count Guard (急激なデータ減少の検知)
    COUNT_RAM=$(sqlite3 "$RAM_DB" "SELECT count(*) FROM collect;" 2>/dev/null || echo 0)
    COUNT_SD=$(sqlite3 "$REAL_DB" "SELECT count(*) FROM collect;" 2>/dev/null || echo 0)
    
    # 閾値: もしSD側に100件以上データがあり、かつRAM側がSD側の 80% 以下に減っていたら「異常」とみなす
    # (大量削除メンテナンス時を除き、通常の使用で20%も一気に減ることはないため)
    if [ "$COUNT_SD" -gt 100 ]; then
        THRESHOLD=$(( COUNT_SD * 80 / 100 ))
        if [ "$COUNT_RAM" -lt "$THRESHOLD" ]; then
            echo "🚨 [CRITICAL ERROR] Data loss detected! (SD: $COUNT_SD -> RAM: $COUNT_RAM)"
            echo "🚨 Sync-back aborted to protect physical DB. Please check the logic."
            # システム警告通知 (もし設定があれば)
            if [ -n "$DISCORD_WEBHOOK_URL_SYSTEM" ]; then
                curl -H "Content-Type: application/json" -X POST -d "{\"content\": \"🚨 **YATA Data Loss Guard**: Sync aborted! ($COUNT_SD -> $COUNT_RAM)\"}" "$DISCORD_WEBHOOK_URL_SYSTEM" > /dev/null 2>&1
            fi
            exit 1
        fi
    fi

    echo "[Wrapper] Syncing back to SD card..."
    # 排他ロックを利用し、複数プロセスが同時に書き戻す競合を防止
    exec 9>"/tmp/yata-sd-copy.lock"
    flock 9

    # 書き戻しのため、一時的にSD上の実体ファイルの権限を開放する (物理ガードの解除)
    REAL_TARGET=$(readlink -f "$REAL_DB")
    chmod 666 "$REAL_TARGET" "${REAL_TARGET}-wal" "${REAL_TARGET}-shm" 2>/dev/null

    # WALとSHMも含めて同期するように改善 (存在しない場合はSD側も削除する)
    cp -f "$RAM_DB" "$REAL_DB"
    
    if [ -f "$RAM_DB-wal" ]; then
        cp -f "$RAM_DB-wal" "${REAL_DB}-wal"
    else
        rm -f "${REAL_DB}-wal"
    fi
    
    if [ -f "$RAM_DB-shm" ]; then
        cp -f "$RAM_DB-shm" "${REAL_DB}-shm"
    else
        rm -f "${REAL_DB}-shm"
    fi
    
    # 書き戻し完了後、SD上の実体ファイルを即座に Read-Only にしてロックする (物理ガードの施錠)
    chmod 444 "$REAL_TARGET" "${REAL_TARGET}-wal" "${REAL_TARGET}-shm" 2>/dev/null

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