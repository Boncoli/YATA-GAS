#!/bin/bash

# ================================================================================
# YATA Expert Console for Mac/Windows/Linux v5.1.5 (Dynamic IP Support)
# ================================================================================

# --- 設定 ---
SSH_USER="boncoli"
# 環境変数 YATA_HOST が設定されていればそれを使い、なければデフォルト(Tailscale IP)を使う
SSH_HOST="${YATA_HOST:-100.120.44.120}"
WORK_DIR="/home/boncoli/yata-local"
# -----------------------------------------------

# IPアドレスの選択/確認
if [ -z "$YATA_HOST" ]; then
    echo -e "\033[0;36m================================================================================\033[0m"
    echo -e "接続先のIPアドレスを選択してください (現在のデフォルト: ${SSH_HOST})"
    echo -e "  [1] Tailscale IP (100.120.44.120) - 外出先・Mac用"
    echo -e "  [2] Local IP     (192.168.x.x 等) - 自宅Wi-Fi・Windows用"
    echo -n "番号を入力 (そのままEnterでTailscale): "
    read -r IP_CHOICE
    if [ "$IP_CHOICE" = "2" ]; then
        echo -n "ローカルIPを入力してください (例: 192.168.1.150): "
        read -r LOCAL_IP
        if [ -n "$LOCAL_IP" ]; then
            SSH_HOST="$LOCAL_IP"
        fi
    fi
fi

# OS判別による open コマンドのラッパー関数
function open_url() {
    if command -v open > /dev/null 2>&1; then
        open "$1"
    elif command -v start > /dev/null 2>&1; then
        start "" "$1"
    elif command -v xdg-open > /dev/null 2>&1; then
        xdg-open "$1"
    elif command -v rundll32 > /dev/null 2>&1; then
        rundll32 url.dll,FileProtocolHandler "$1"
    else
        echo -e "${YELLOW}URLを手動で開いてください: $1${NC}"
    fi
}

# 色の定義
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# ステータス取得用スクリプト (Base64)
status_cmd="if [ -f /dev/shm/yata.db ]; then DB=/dev/shm/yata.db; MODE=\"RAM\"; else DB=/home/boncoli/yata-local/yata.db; MODE=\"SD\"; fi; TEMP=\$(vcgencmd measure_temp 2>/dev/null | cut -d= -f2 | tr -d '\n' || echo \"N/A\"); MEM=\$(free -h | awk 'NR==2{print \$3 \"/\" \$2}'); SD=\$(df -h / | awk 'NR==2{print \$5}'); SVR=\$(if ss -tuln | grep -q \":3001 \"; then echo \"ON\"; else echo \"OFF\"; fi); COUNT=\$(sqlite3 \"\$DB\" \"SELECT count(*) FROM collect;\" 2>/dev/null | numfmt --grouping 2>/dev/null || echo \"-\"); TODO=\$(sqlite3 \"\$DB\" \"SELECT count(*) FROM collect WHERE summary IS NULL OR length(summary)=0;\" 2>/dev/null | numfmt --grouping 2>/dev/null || echo \"-\"); DB_SIZE=\$(ls -lh \"\$DB\" 2>/dev/null | awk '{print \$5}'); echo \"[\$MODE] Temp: \$TEMP | Mem: \$MEM | SD: \$SD | Svr: \$SVR | DB: \$DB_SIZE | Total: \$COUNT | ToDo: \$TODO\""
STATUS_B64=$(echo -n "$status_cmd" | base64)

function get_yata_status() {
    ssh -q -o ConnectTimeout=3 "$SSH_USER@$SSH_HOST" "echo $STATUS_B64 | base64 -d | bash" 2>/dev/null
}

function invoke_remote() {
    local cmd=$1
    local interactive=$2
    if [ "$interactive" = "true" ]; then
        ssh -t "$SSH_USER@$SSH_HOST" "cd $WORK_DIR && $cmd"
    else
        ssh "$SSH_USER@$SSH_HOST" "cd $WORK_DIR && $cmd"
    fi
}

function pause() {
    echo -e "\n${CYAN}Press Enter to continue...${NC}"
    read -r
}

while true; do
    clear
    echo -e "${CYAN}================================================================================"
    echo -e "                    YATA Expert Console [v5.0.0 Flat for Mac]"
    echo -e "================================================================================${NC}"

    yata_status=$(get_yata_status)
    if [ -n "$yata_status" ]; then
        echo -e "${GREEN}$yata_status${NC}"
    else
        echo -e "${YELLOW}[Status] 接続待機中... (SSH Connection Failed)${NC}"
        sleep 2
        continue
    fi

    echo ""
    echo -e " ${YELLOW}[Daily Work]              [Maintenance]           [Development]${NC}"
    echo "  1. Collect (RSS収集)      4. Sync (RAM->SD)       7. VS Code (Remote)"
    echo "  2. Summarize (AI要約)     5. DB Vacuum (軽量化)   8. SSH & Start Gemini"
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

    echo -n "Enter Command Number: "
    read -r CHOICE

    case $CHOICE in
        1) invoke_remote "./run-ram.sh tasks/do-collect.js" ;;
        2) invoke_remote "./run-ram.sh tasks/do-summarize.js" ;;
        3) invoke_remote "./run-ram.sh tasks/yata-task.js" ;;
        4) invoke_remote "./run-ram.sh --sync-only" ;;
        5)
            echo -e "${CYAN}VACUUM実行中...${NC}"
            invoke_remote "sqlite3 /dev/shm/yata.db 'VACUUM;'; sqlite3 $WORK_DIR/yata.db 'VACUUM;'"
            echo -e "${GREEN}完了。${NC}"
            ;;
        6) invoke_remote "git fetch origin && git show origin/main:lib/YATA.js > lib/YATA.js && echo 'YATA.js Updated.'" ;;
        7) code --folder-uri "vscode-remote://ssh-remote+$SSH_USER@$SSH_HOST$WORK_DIR" ;;
        8) ssh -t "$SSH_USER@$SSH_HOST" "cd $WORK_DIR; bash --login" ;;
        9)
            (sleep 3 && open_url "http://$SSH_HOST:8082") &
            invoke_remote "taskset -c 0-2 ./local_llm/.venv/bin/python3 -m sqlite_web /dev/shm/yata.db -H 0.0.0.0 -p 8082 -x" "true"
            ;;
        10) open_url "http://$SSH_HOST:3001/portal.html" ;;
        11) open_url "http://$SSH_HOST:3000" ;;
        12) ssh -t "$SSH_USER@$SSH_HOST" "btop" ;;
        13)
            invoke_remote "python3 dashboard/dashboard.py --no-epd"
            scp "$SSH_USER@$SSH_HOST:/dev/shm/dashboard.png" "/tmp/yata_preview.png"
            open_url "/tmp/yata_preview.png"
            ;;
        14)
            invoke_remote "python3 dashboard/dashboard.py --mode weather --no-epd"
            scp "$SSH_USER@$SSH_HOST:/dev/shm/dashboard.png" "/tmp/yata_preview.png"
            open_url "/tmp/yata_preview.png"
            ;;
        15)
            invoke_remote "python3 dashboard/dashboard.py --mode env --no-epd"
            scp "$SSH_USER@$SSH_HOST:/dev/shm/dashboard.png" "/tmp/yata_preview.png"
            open_url "/tmp/yata_preview.png"
            ;;
        16) invoke_remote "python3 dashboard/dashboard.py" ;;
        17) invoke_remote "./maintenance/do-backup.sh" ;;
        18)
            echo -n "Full Backup? (y/n): "
            read -r CONFIRM
            if [ "$CONFIRM" = "y" ]; then invoke_remote "sudo image-backup /mnt/nas/rpi_complete_backup.img" "true"; fi
            ;;
        19) invoke_remote "sudo apt update && sudo apt upgrade -y && git pull" "true" ;;
        20)
            echo -n "Sync & Reboot? (y/n): "
            read -r CONFIRM
            if [ "$CONFIRM" = "y" ]; then invoke_remote "./run-ram.sh --sync-only && sudo reboot"; fi
            ;;
        21)
            echo -n "Sync & Poweroff? (y/n): "
            read -r CONFIRM
            if [ "$CONFIRM" = "y" ]; then invoke_remote "./run-ram.sh --sync-only && sudo poweroff"; fi
            ;;
        22) invoke_remote "echo '--- Task Log ---'; tail -n 15 /dev/shm/yata_task.log; echo ''; echo '--- System Log ---'; tail -n 15 /dev/shm/yata.log" "true" ;;
        0) exit 0 ;;
        *) continue ;;
    esac

    if [[ ! "$CHOICE" =~ ^(0|7|10|11|20|21)$ ]]; then
        echo -e "\n${CYAN}Task completed.${NC}"
        pause
    fi
done
