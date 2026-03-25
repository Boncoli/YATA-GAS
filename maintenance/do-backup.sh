#!/bin/bash

# --- 設定 ---
HOME_DIR="/home/boncoli"
YATA_DIR="$HOME_DIR/yata-local"
SD_BACKUP="/mnt/backup"
NAS_BACKUP="/mnt/nas"
LOG_FILE="$YATA_DIR/backup.log"

export PATH="/home/boncoli/.nvm/versions/node/v24.12.0/bin:$PATH"

# Discord通知関数 (System Alerts用)
send_discord_alert() {
    local msg="$1"
    if [ -n "$DISCORD_WEBHOOK_URL_SYSTEM" ]; then
        curl -H "Content-Type: application/json" -X POST -d "{\"content\": \"$msg\"}" "$DISCORD_WEBHOOK_URL_SYSTEM" > /dev/null 2>&1
    fi
}

# .env から変数を読み込む (Webhook URL取得用)
if [ -f "$YATA_DIR/.env" ]; then
    export $(grep -v '^#' "$YATA_DIR/.env" | xargs)
fi

echo "--- Backup Start: $(date) ---" >> "$LOG_FILE"
send_discord_alert "🛠️ **システムバックアップ開始**"

# --- 1. RAMディスク上でのDB最適化 (SDカードへの同期を含む) ---
# 目的: 重複を削除し、VACUUMでDBを物理圧縮した上でSDカードへ書き戻す。
# これを最初に行うことで、後続のNAS転送時間を劇的に短縮する。
echo "Step 1: Cleaning and Vacuuming RAM DB before any sync..." >> "$LOG_FILE"
$YATA_DIR/run-ram.sh maintenance/clean-db-duplicates.js >> "$LOG_FILE" 2>&1

# --- 2. NASへのバックアップ (完全クローン ＆ 履歴) ---
if [ -d "$NAS_BACKUP" ]; then
    echo "Step 2: Saving Optimized data to NAS..." >> "$LOG_FILE"

    # --- システム情報の保存 (復旧用パッケージリスト) ---
    dpkg --get-selections > "$HOME_DIR/package_list.txt"
    crontab -l > "$HOME_DIR/crontab_last.txt"

    # A. ホームディレクトリ全体の完全同期 (この時点で yata.db は軽量化済み)
    echo "Syncing home directory to NAS (current)..." >> "$LOG_FILE"
    mkdir -p "$NAS_BACKUP/home_backup"
    rsync -a --delete --no-links --no-devices --no-specials \
      --exclude='**/node_modules' --exclude='.cache' --exclude='**/__pycache__' \
      --exclude='.venv' --exclude='local_llm/models' \
      --include='maid_*.png' --include='icon/*.png' \
      --exclude='*.png' \
      --exclude='.nvm' --exclude='.npm' \
      --exclude='.pm2' --exclude='.vscode-server' --exclude='.local' \
      "$HOME_DIR/" "$NAS_BACKUP/home_backup/"

    # B. DBの履歴保存 (アーカイブ)
    echo "Creating DB history snapshot on NAS..." >> "$LOG_FILE"
    mkdir -p "$NAS_BACKUP/yata_db_history"
    cp "$YATA_DIR/yata.db" "$NAS_BACKUP/yata_db_history/yata_$(date +%Y%m%d).db"
    find "$NAS_BACKUP/yata_db_history/" -name "yata_*.db" -mtime +30 -delete

    # C. /etc のバックアップ (システム設定)
    echo "Archiving /etc to NAS..." >> "$LOG_FILE"
    sudo tar -czf "$NAS_BACKUP/etc_backup.tar.gz" /etc/

    # D. ログの退避 (RAM -> NAS)
    echo "Archiving RAM logs to NAS..." >> "$LOG_FILE"
    NAS_LOG_DIR="$NAS_BACKUP/yata_logs"
    mkdir -p "$NAS_LOG_DIR"
    
    RAM_LOGS=("/dev/shm/collect.log" "/dev/shm/summarize.log" "/dev/shm/yata.log" "/dev/shm/yata_task.log" "/dev/shm/yata_dashboard.log" "/dev/shm/yata_mutter.log" "/dev/shm/api_usage.log")
    TODAY_STR=$(date +%Y%m%d)

    for RAM_LOG in "${RAM_LOGS[@]}"; do
        if [ -f "$RAM_LOG" ]; then
            BASENAME=$(basename "$RAM_LOG" .log)
            cp "$RAM_LOG" "$NAS_LOG_DIR/${BASENAME}_${TODAY_STR}.log"
            truncate -s 0 "$RAM_LOG"
        fi
    done
    find "$NAS_LOG_DIR/" -name "*.log" -mtime +30 -delete

else
    echo "Warning: NAS not mounted. Skipping NAS backup." >> "$LOG_FILE"
fi

# --- 3. サーバーのリフレッシュ (完全再起動) ---
echo "Step 3: Refreshing system processes..." >> "$LOG_FILE"
echo "Stopping all PM2 processes..." >> "$LOG_FILE"
/home/boncoli/.nvm/versions/node/v24.12.0/bin/pm2 stop all >> "$LOG_FILE" 2>&1

# 安全確認：プロセス停止
if pgrep -f "node" > /dev/null || pgrep -f "python3" > /dev/null; then
    echo "CRITICAL ERROR: Processes still running! Aborting RAM cleanup." >> "$LOG_FILE"
    send_discord_alert "🚨 **バックアップ警告**: プロセス停止に失敗。"
else
    echo "Cleaning up RAM DB garbage..." >> "$LOG_FILE"
    rm -f /dev/shm/yata.db* >> "$LOG_FILE" 2>&1
    rm -f /home/boncoli/yata-local/core.* >> "$LOG_FILE" 2>&1
fi

echo "Starting all PM2 processes..." >> "$LOG_FILE"
/home/boncoli/.nvm/versions/node/v24.12.0/bin/pm2 start all >> "$LOG_FILE" 2>&1
/home/boncoli/.nvm/versions/node/v24.12.0/bin/pm2 stop yata-voice-catcher >> "$LOG_FILE" 2>&1

echo "--- Backup Completed: $(date) ---" >> "$LOG_FILE"
send_discord_alert "✅ **システムバックアップ完了**: DB最適化(VACUUM)とリフレッシュを正常に終了しました。"
