#!/bin/bash

# 1. データベースのバックアップ
#    もしNASがマウントされていれば実行
if [ -d "/mnt/nas" ]; then
    # DBを別名で保存
    cp /home/boncoli/yata-local/yata.db /mnt/nas/yata_backup.db
    
    # 2. スクリプトの差分バックアップ (DBとnode_modulesは除外)
    #    バックアップ先フォルダを作成
    mkdir -p /mnt/nas/yata_scripts_backup
    
    rsync -a --exclude='*.db' --exclude='node_modules' --exclude='.git' /home/boncoli/yata-local/ /mnt/nas/yata_scripts_backup/
    
    echo "$(date) Backup completed." >> /home/boncoli/yata-local/backup.log
fi

# --- ログのローテーション (肥大化防止) ---
# 最新の2000行だけ残して上書き保存
tail -n 2000 /home/boncoli/yata-local/logs/collect.log > /home/boncoli/yata-local/logs/collect.log.tmp && mv /home/boncoli/yata-local/logs/collect.log.tmp /home/boncoli/yata-local/logs/collect.log

tail -n 2000 /home/boncoli/yata-local/logs/summarize.log > /home/boncoli/yata-local/logs/summarize.log.tmp && mv /home/boncoli/yata-local/logs/summarize.log.tmp /home/boncoli/yata-local/logs/summarize.log

tail -n 2000 /home/boncoli/yata-local/logs/yata.log > /home/boncoli/yata-local/logs/yata.log.tmp && mv /home/boncoli/yata-local/logs/yata.log.tmp /home/boncoli/yata-local/logs/yata.log