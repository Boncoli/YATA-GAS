#!/bin/bash
# ================================================================================
# YATA Shared Core Menu v5.2.0
# ================================================================================
WORK_DIR="/home/boncoli/yata-local"
cd "$WORK_DIR"

# 色の定義
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

while true; do
    clear
    echo -e "${CYAN}================================================================================"
    echo -e "                    YATA Expert Console [v5.2.0 Shared Core]"
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
    # パイプ経由でのバッファリング対策として、改行付きのプロンプトに変更
    echo "Enter Command Number: "
    read -r CHOICE

    case $CHOICE in
        1) ./run-ram.sh tasks/do-collect.js ;;
        2) ./run-ram.sh tasks/do-summarize.js ;;
        3) ./run-ram.sh tasks/yata-task.js ;;
        4) ./run-ram.sh --sync-only ;;
        5) 
            echo -e "${CYAN}VACUUM実行中...${NC}"
            sqlite3 /dev/shm/yata.db 'VACUUM;'; sqlite3 "$WORK_DIR/yata.db" 'VACUUM;' 
            echo -e "${GREEN}完了。${NC}"
            ;;
        6) invoke_remote "git fetch origin && git show origin/main:lib/YATA.js > lib/YATA.js && echo 'YATA.js Updated.'" ;;
        7) echo "__VSCODE__" ;;
        8) /bin/bash --login; exit ;;
        9) 
            echo "__OPEN_URL__:http://__HOST__:8082"
            taskset -c 0-2 ./local_llm/.venv/bin/python3 -m sqlite_web /dev/shm/yata.db -H 0.0.0.0 -p 8082
            ;;
        10) echo "__OPEN_URL__:http://__HOST__:3001/portal.html" ;;
        11) echo "__OPEN_URL__:http://__HOST__:3000" ;;
        12) btop ;;
        13) python3 dashboard/dashboard.py --no-epd; echo "__PREVIEW__" ;;
        14) python3 dashboard/dashboard.py --mode weather --no-epd; echo "__PREVIEW__" ;;
        15) python3 dashboard/dashboard.py --mode env --no-epd; echo "__PREVIEW__" ;;
        16) python3 dashboard/dashboard.py ;;
        17) ./maintenance/do-backup.sh ;;
        18) 
            echo "Full Backup? (y/n): "
            read -r CONFIRM
            if [ "$CONFIRM" = "y" ]; then sudo image-backup /mnt/nas/rpi_complete_backup.img; fi
            ;;
        19) sudo apt update && sudo apt upgrade -y && git pull ;;
        20) 
            echo "Sync & Reboot? (y/n): "
            read -r CONFIRM
            if [ "$CONFIRM" = "y" ]; then ./run-ram.sh --sync-only && sudo reboot; fi
            ;;
        21) 
            echo "Sync & Poweroff? (y/n): "
            read -r CONFIRM
            if [ "$CONFIRM" = "y" ]; then ./run-ram.sh --sync-only && sudo poweroff; fi
            ;;
        22) echo '--- Task Log ---'; tail -n 15 /dev/shm/yata_task.log; echo ''; echo '--- System Log ---'; tail -n 15 /dev/shm/yata.log ;;
        0) exit 0 ;;
    esac

    if [[ ! "$CHOICE" =~ ^(0|7|8|9|10|11|20|21)$ ]]; then
        echo ""
        echo "Press Enter to continue..."
        read -r
    fi
done
