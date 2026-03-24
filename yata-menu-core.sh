#!/bin/bash
# ================================================================================
# YATA Shared Core Menu v5.3.0 (Low-Latency Edition)
# ================================================================================
WORK_DIR="/home/boncoli/yata-local"
SIGNAL_FILE="/dev/shm/yata-console.signal"
cd "$WORK_DIR"

# 信号ファイルの初期化
touch "$SIGNAL_FILE"
chmod 666 "$SIGNAL_FILE" 2>/dev/null

# 色の定義
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 命令送信関数
function emit_signal() {
    echo "$1" > "$SIGNAL_FILE"
    echo -e "$1" # 画面にも出す（レガシー互換）
}

while true; do
    clear
    echo -e "${CYAN}================================================================================"
    echo -e "                    YATA Expert Console [v5.3.0 Shared Core]"
    echo -e "================================================================================${NC}"

    # ステータス表示
    if [ -f /dev/shm/yata.db ]; then DB=/dev/shm/yata.db; MODE="RAM"; else DB=$WORK_DIR/yata.db; MODE="SD"; fi
    TEMP=$(vcgencmd measure_temp 2>/dev/null | cut -d= -f2 | tr -d '\n' || echo "N/A")
    MEM=$(free -h | awk 'NR==2{print $3 "/" $2}')
    SD=$(df -h / | awk 'NR==2{print $5}')
    SVR=$(if ss -tuln | grep -q ":3001 "; then echo "ON"; else echo "OFF"; fi)
    COUNT=$(sqlite3 "$DB" "SELECT count(*) FROM collect;" 2>/dev/null | numfmt --grouping 2>/dev/null || echo "-")
    TODO=$(sqlite3 "$DB" "SELECT count(*) FROM collect WHERE summary IS NULL OR length(summary)=0;" 2>/dev/null | numfmt --grouping 2>/dev/null || echo "-")
    DB_SIZE=$(ls -lh "$DB" 2>/dev/null | awk '{print $5}')
    echo -e "${GREEN}[$MODE] Temp: $TEMP | Mem: $MEM | SD: $SD | Svr: $SVR | DB: $DB_SIZE | Total: $COUNT | ToDo: $TODO${NC}"
    echo ""

    echo -e " ${YELLOW}[Daily Work]              [Maintenance]           [Development]${NC}"
    echo "  1. Collect (RSS収集)      4. Sync (RAM->SD)       7. VS Code (Remote)"
    echo "  2. Summarize (AI要約)     5. DB Vacuum (軽量化)   8. SSH Terminal"
    echo "  3. Full Task (全自動)     6. YATA.js Sync"
    echo ""
    echo -e " ${YELLOW}[Monitoring]              [Dashboard]             [Admin]${NC}"
    echo "  9. sqlite-web (CoreLim)   13. Preview (Normal)    17. Backup (NAS)"
    echo " 10. Web Portal (Port:3001) 14. Preview (Weather)   18. Full Image (NAS)"
    echo " 11. Grafana Dashboard      15. Preview (Env)       19. System Update"
    echo " 12. btop (System Monitor)  16. E-Ink Write (実機)  20. Reboot (Sync & Rbt)"
    echo "                            22. Show Logs           21. Poweroff (Sync & Off)"
    echo ""
    echo "                                                     0. Exit"
    echo -e "${CYAN}================================================================================${NC}"
    
    # 🌟 [改善] read -n 1 (1文字即反応) に変更。エンター不要で爆速。
    echo -n "Enter Command: "
    read -n 2 CHOICE_RAW  # 2文字まで（10番台以降対応のため。1文字なら即、2文字なら少し待つ）
    CHOICE=$(echo "$CHOICE_RAW" | tr -d '[:space:]')
    echo "" # 改行を入れて見栄えを整える

    case $CHOICE in
        1) ./run-ram.sh tasks/yata-task.js --collect-only ;;
        2) ./run-ram.sh tasks/yata-task.js --summarize-only ;;
        3) ./run-ram.sh tasks/yata-task.js ;;
        4) ./run-ram.sh --sync-only ;;
        5) 
            echo -e "${CYAN}VACUUM実行中...${NC}"
            sqlite3 /dev/shm/yata.db 'VACUUM;'; sqlite3 "$WORK_DIR/yata.db" 'VACUUM;' 
            echo -e "${GREEN}完了。${NC}"
            ;;
        6) git fetch origin && git show origin/main:lib/YATA.js > lib/YATA.js && echo 'YATA.js Updated.' ;;
        7) emit_signal "__VSCODE__" ;;
        8) emit_signal "__TERMINAL__" ;;
        9) 
            emit_signal "__OPEN_URL__:http://__HOST__:8082"
            taskset -c 0-2 ./local_llm/.venv/bin/python3 -m sqlite_web /dev/shm/yata.db -H 0.0.0.0 -p 8082
            ;;
        10) emit_signal "__OPEN_URL__:http://__HOST__:3001/portal.html" ;;
        11) emit_signal "__OPEN_URL__:http://__HOST__:3000" ;;
        12) btop ;;
        13) python3 dashboard/dashboard.py --no-epd; emit_signal "__PREVIEW__" ;;
        14) python3 dashboard/dashboard.py --mode weather --no-epd; emit_signal "__PREVIEW__" ;;
        15) python3 dashboard/dashboard.py --mode env --no-epd; emit_signal "__PREVIEW__" ;;
        16) python3 dashboard/dashboard.py ;;
        17) ./maintenance/do-backup.sh ;;
        18) 
            echo -n "Full Backup? (y/n): "
            read -n 1 CONFIRM
            if [ "$CONFIRM" = "y" ]; then sudo image-backup /mnt/nas/rpi_complete_backup.img; fi
            ;;
        19) sudo apt update && sudo apt upgrade -y && git pull ;;
        20) 
            echo -n "Sync & Reboot? (y/n): "
            read -n 1 CONFIRM
            if [ "$CONFIRM" = "y" ]; then ./run-ram.sh --sync-only && sudo reboot; fi
            ;;
        21) 
            echo -n "Sync & Poweroff? (y/n): "
            read -n 1 CONFIRM
            if [ "$CONFIRM" = "y" ]; then ./run-ram.sh --sync-only && sudo poweroff; fi
            ;;
        22) echo '--- Task Log ---'; tail -n 15 /dev/shm/yata_task.log; echo ''; echo '--- System Log ---'; tail -n 15 /dev/shm/yata.log ;;
        0) exit 0 ;;
    esac

    # 特殊コマンド以外は継続確認を入れる（画面が流れるのを防ぐ）
    if [[ ! "$CHOICE" =~ ^(0|7|8|9|10|11|12|20|21)$ ]]; then
        echo ""
        echo -n "Press any key to continue..."
        read -n 1
    fi
done
