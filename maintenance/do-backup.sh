#!/bin/bash

# --- 設定（変数にまとめると管理が楽です） ---
HOME_DIR="/home/boncoli"
YATA_DIR="$HOME_DIR/yata-local"
SD_BACKUP="/mnt/backup"
NAS_BACKUP="/mnt/nas"
LOG_FILE="$YATA_DIR/backup.log"

echo "--- Backup Start: $(date) ---" >> "$LOG_FILE"

# --- 1. SDカードへのバックアップ (ローカル保存) ---
# SSDの寿命対策 ＆ ネットワーク不要の確実なバックアップ
echo "Saving to SD Card..." >> "$LOG_FILE"
mkdir -p "$SD_BACKUP/yata_db_backup"
# 日付付きでDBを保存
cp "$YATA_DIR/yata.db" "$SD_BACKUP/yata_db_backup/yata_$(date +%Y%m%d).db"
# ホームディレクトリ全体を同期（これが以前3時に設定していた処理）
rsync -a --delete "$HOME_DIR/" "$SD_BACKUP/home_backup/"

# 30日より古いバックアップを削除（容量パンク防止）
find "$SD_BACKUP/yata_db_backup/" -name "yata_*.db" -mtime +30 -delete

# --- 2. NASへのバックアップ (外部保存) ---
if [ -d "$NAS_BACKUP" ]; then
    echo "Saving to NAS..." >> "$LOG_FILE"
    cp "$YATA_DIR/yata.db" "$NAS_BACKUP/yata_backup.db"
    mkdir -p "$NAS_BACKUP/yata_scripts_backup"
    rsync -a --exclude='*.db' --exclude='node_modules' --exclude='.git' "$YATA_DIR/" "$NAS_BACKUP/yata_scripts_backup/"
else
    echo "Warning: NAS not mounted. Skipping NAS backup." >> "$LOG_FILE"
fi

# --- 3. ログのローテーション (肥大化防止) ---
echo "Rotating logs..." >> "$LOG_FILE"
LOG_LIST=("$YATA_DIR/logs/collect.log" "$YATA_DIR/logs/summarize.log" "$YATA_DIR/logs/yata.log")

for LOG in "${LOG_LIST[@]}"; do
    if [ -f "$LOG" ]; then
        tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
    fi
done

echo "--- Backup Completed: $(date) ---" >> "$LOG_FILE"