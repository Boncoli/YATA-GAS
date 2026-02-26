#!/bin/bash

# --- 設定 ---
HOME_DIR="/home/boncoli"
YATA_DIR="$HOME_DIR/yata-local"
SD_BACKUP="/mnt/backup"
NAS_BACKUP="/mnt/nas"
LOG_FILE="$YATA_DIR/backup.log"

export PATH="/home/boncoli/.nvm/versions/node/v24.12.0/bin:$PATH"

echo "--- Backup Start: $(date) ---" >> "$LOG_FILE"

# --- 1. SDカードへのバックアップ (ホーム全体同期) ---
# 目的: SDカード内での冗長化（直近の復旧用）
# echo "Syncing to SD Card..." >> "$LOG_FILE"
# rsync -a --delete --exclude='node_modules' --exclude='.cache' --exclude='__pycache__' "$HOME_DIR/" "$SD_BACKUP/home_backup/"

# --- 2. NASへのバックアップ (完全クローン ＆ 履歴) ---
if [ -d "$NAS_BACKUP" ]; then
    echo "Saving to NAS..." >> "$LOG_FILE"

    # --- システム情報の保存 (復旧用パッケージリスト) ---
    dpkg --get-selections > "$HOME_DIR/package_list.txt"
    crontab -l > "$HOME_DIR/crontab_last.txt"

    # A. ホームディレクトリ全体の完全同期
    mkdir -p "$NAS_BACKUP/home_backup"
    # --no-links: ショートカットを無視（エラー回避の決定打）
    # --exclude: エラーの元になるシステムフォルダを全除外
    # --no-devices --no-specials: CIFS(NAS)でのmknodエラー回避
    rsync -a --delete --no-links --no-devices --no-specials \
      --exclude='node_modules' --exclude='.cache' --exclude='__pycache__' \
      --exclude='*.png' \
      --exclude='.nvm' --exclude='.npm' \
      --exclude='.pm2' --exclude='.vscode-server' --exclude='.local' \
      "$HOME_DIR/" "$NAS_BACKUP/home_backup/"

    # B. /etc のバックアップ (システム設定をtarで固める)
    echo "Archiving /etc to NAS..." >> "$LOG_FILE"
    sudo tar -czf "$NAS_BACKUP/etc_backup.tar.gz" /etc/

    # C. DBの履歴保存 (アーカイブ)
    # ここは変更なし。過去30日分のデータを別で確保します。
    mkdir -p "$NAS_BACKUP/yata_db_history"
    cp "$YATA_DIR/yata.db" "$NAS_BACKUP/yata_db_history/yata_$(date +%Y%m%d).db"
    find "$NAS_BACKUP/yata_db_history/" -name "yata_*.db" -mtime +30 -delete

else
    echo "Warning: NAS not mounted. Skipping NAS backup." >> "$LOG_FILE"
fi

# --- 3. ログのローテーション ---
echo "Rotating logs..." >> "$LOG_FILE"
LOG_LIST=("$YATA_DIR/logs/collect.log" "$YATA_DIR/logs/summarize.log" "$YATA_DIR/logs/yata.log" "$YATA_DIR/logs/dashboard.log")

for LOG in "${LOG_LIST[@]}"; do
    if [ -f "$LOG" ]; then
        tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
    fi
done

# --- 4. サーバーのリフレッシュ (完全再起動) ---
# 安全第一: 再起動前にメモリ上のデータをSDカードへ強制同期する
echo "Syncing RAM to SD before restart..." >> "$LOG_FILE"
/home/boncoli/yata-local/run-ram.sh --sync-only >> "$LOG_FILE" 2>&1

echo "Stopping yata-server..." >> "$LOG_FILE"
/home/boncoli/.nvm/versions/node/v24.12.0/bin/pm2 stop yata-server >> "$LOG_FILE" 2>&1

# 致命的なバグ対策：確実にプロセスが停止したか確認する
if pgrep -f "server.js" > /dev/null; then
    echo "CRITICAL ERROR: yata-server process is still running after stop command!" >> "$LOG_FILE"
    echo "ABORTING RAM DB CLEANUP TO PREVENT DATA LOSS." >> "$LOG_FILE"
    # プロセスが残っている場合、RAM上のDBを消すとデータが消滅するのでスキップして再起動だけ試みる
else
    # プロセスが完全に終了していること（＝ファイルが握られていないこと）を確認できた場合のみ削除
    echo "Server completely stopped. Cleaning up RAM DB..." >> "$LOG_FILE"
    rm -f /dev/shm/yata.db* >> "$LOG_FILE" 2>&1
fi

echo "Starting yata-server..." >> "$LOG_FILE"
/home/boncoli/.nvm/versions/node/v24.12.0/bin/pm2 start yata-server >> "$LOG_FILE" 2>&1

echo "--- Backup Completed: $(date) ---" >> "$LOG_FILE"
