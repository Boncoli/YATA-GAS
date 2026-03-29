@echo off
title YATA Management Console
:: 文字コードをShift-JISに固定
chcp 932 > nul

:: ▼▼ 設定 (無線LANの150固定) ▼▼
set SSH_USER=boncoli
set SSH_HOST=192.168.1.150
set WORK_DIR=~/yata-local
:: ▲▲ 設定 ▲▲

:MENU
cls
echo ========================================================
echo              YATA 管理パネル [v4.6 Modern-Log]
echo ========================================================

:: --- ステータス取得 (安全な連鎖方式でラベルを補完) ---
echo | set /p="[Status] "
ssh -o ConnectTimeout=3 %SSH_USER%@%SSH_HOST% "if [ -f /dev/shm/yata.db ]; then DB=/dev/shm/yata.db; T='RAM'; else DB=~/yata-local/yata.db; T='SD'; fi; echo -n \"[DB:$T] Temp:\"; vcgencmd measure_temp | cut -d= -f2 | tr -d '\n'; echo -n ' | Mem: '; free -h | awk 'NR==2{print $3}' | tr -d '\n'; echo -n ' | Total: '; sqlite3 \"$DB\" \"SELECT count(*) FROM collect\" | tr -d '\n'; echo -n ' (+'; sqlite3 \"$DB\" \"SELECT count(*) FROM collect WHERE date(date,'+9 hours')=date('now','localtime')\" | tr -d '\n'; echo -n ' / Wait:'; sqlite3 \"$DB\" \"SELECT count(*) FROM collect WHERE (summary IS NULL OR summary='') AND (abstract IS NOT NULL AND abstract != '')\" | tr -d '\n'; echo -n ') | Tk:'; sqlite3 \"$DB\" \"SELECT COALESCE(SUM(input_tokens+output_tokens)/1000,0) FROM api_usage_daily WHERE date=date('now','localtime')\" | tr -d '\n'; echo -n 'k(r:'; sqlite3 \"$DB\" \"SELECT COALESCE(SUM(reasoning_tokens)/1000,0) FROM api_usage_daily WHERE date=date('now','localtime')\" | tr -d '\n'; echo -n 'k) | '; sqlite3 \"$DB\" \"SELECT printf('%%s %%.0fC (AQI:%%s)', main_weather, temp, aqi) FROM weather_log ORDER BY datetime DESC LIMIT 1\"" || echo [接続不可]

echo.
echo --------------------------------------------------------
echo    ▼ 記事・RSS操作 (Daily Work)
echo      1. RSS収集のみ              2. AI要約のみ
echo      3. 全自動(YATA-Task)        4. Web UIを開く(Port:3001)
echo.
echo    ▼ モニタリング・可視化 (Dashboard)
echo      5. DBビューア(sqlite-web)   6. Grafanaパネル
echo      7. 画像生成・プレビュー     8. システム計器盤(btop)
echo      9. 実行ログ(RAM)を確認
echo.
echo    ▼ システム・バックアップ (Admin)
echo     10. 日次バックアップ(NAS)    11. NAS履歴確認
echo     12. SSH接続(自由入力)        13. 再起動 (Auto Sync)
echo     14. 停止 (Auto Sync)         15. システム・OS更新(Update)
echo     16. フルイメージ保存(NAS)
echo.
echo    ▼ メンテナンス (Expert)
echo     17. Cron停止 (自動運転OFF)   18. Cron開始 (自動運転ON)
echo     19. RAM DBをSDへ強制同期 (Manual Sync)
echo     20. YATA.js同期 (Remote -^> lib/YATA.js)
echo     21. ファイル転送 (Download)
echo.
echo      0. 終了
echo.
echo    [EnterのみでStatus更新]
echo ========================================================
set CHOICE=
set /p CHOICE="番号を選択してEnter: "

:: --- 分岐処理 ---
if "%CHOICE%"=="1"  goto COLLECT
if "%CHOICE%"=="2"  goto SUMMARIZE
if "%CHOICE%"=="3"  goto RUN_ALL
if "%CHOICE%"=="4"  goto OPEN_WEB
if "%CHOICE%"=="5"  goto VIEWER
if "%CHOICE%"=="6"  goto GRAFANA
if "%CHOICE%"=="7"  goto GEN_AND_VIEW
if "%CHOICE%"=="8"  goto HEALTH_CHECK
if "%CHOICE%"=="9"  goto LOG_VIEW
if "%CHOICE%"=="10" goto BACKUP
if "%CHOICE%"=="11" goto CHECK_NAS
if "%CHOICE%"=="12" goto SSH_CONSOLE
if "%CHOICE%"=="13" goto REBOOT_PI
if "%CHOICE%"=="14" goto SHUTDOWN_PI
if "%CHOICE%"=="15" goto UPDATE
if "%CHOICE%"=="16" goto FULL_IMAGE_BACKUP
if "%CHOICE%"=="17" goto STOP_CRON
if "%CHOICE%"=="18" goto START_CRON
if "%CHOICE%"=="19" goto MANUAL_SYNC
if "%CHOICE%"=="20" goto SYNC_MAIN_FROM_LOCAL
if "%CHOICE%"=="21" goto DOWNLOAD
if "%CHOICE%"=="0"  exit
goto MENU

:: --- 各セクションの実装 ---
:COLLECT
echo.
ssh %SSH_USER%@%SSH_HOST% "cd %WORK_DIR% && ./run-ram.sh --no-sync tasks/do-collect.js"
pause
goto MENU

:SUMMARIZE
echo.
ssh %SSH_USER%@%SSH_HOST% "cd %WORK_DIR% && ./run-ram.sh --no-sync tasks/do-summarize.js"
pause
goto MENU

:RUN_ALL
echo.
ssh %SSH_USER%@%SSH_HOST% "cd %WORK_DIR% && ./run-ram.sh --no-sync tasks/yata-task.js"
pause
goto MENU

:OPEN_WEB
echo.
echo Webサーバーの応答を待機してブラウザを開きます...
start http://%SSH_HOST%:3001
goto MENU

:VIEWER
echo.
echo Webサーバー(sqlite_web)を起動します。
echo ブラウザが開くまで数秒お待ちください...
start "" cmd /c "timeout /t 3 >nul && start http://%SSH_HOST%:8082"
ssh -t %SSH_USER%@%SSH_HOST% "python3 -m sqlite_web /dev/shm/yata.db -H 0.0.0.0 -p 8082"
goto MENU

:GRAFANA
echo.
start http://%SSH_HOST%:3000
goto MENU

:GEN_AND_VIEW
cls
echo ========================================================
echo               ダッシュボード表示モード選択
echo ========================================================
echo.
echo    1. 通常 (Default)    : 標準ダッシュボード
echo    2. 天気 (Weather)    : 詳細天気予報 + 3hグラフ
echo    3. 環境 (Env)        : 室温・外気・湿度の24hグラフ
echo.
echo    0. 戻る
echo.
echo ========================================================
set MODE_CHOICE=
set /p MODE_CHOICE="番号を選択: "
if "%MODE_CHOICE%"=="0" goto MENU
echo.
set UPDATE_EPD=n
set /p UPDATE_EPD="【実機反映】 ラズパイの画面も書き換えますか？ (y/n) [Def: n]: "
if /i "%UPDATE_EPD%"=="y" (
    set EPD_FLAG=
    echo [設定] 実機の画面を更新します。
) else (
    set EPD_FLAG=--no-epd
    echo [設定] 実機は更新せず、プレビューのみ生成します。
)
set BASE_CMD=python3 dashboard/dashboard.py
if "%MODE_CHOICE%"=="1" set ARGS=
if "%MODE_CHOICE%"=="2" set ARGS=--mode weather
if "%MODE_CHOICE%"=="3" set ARGS=--mode env
set DASH_CMD=%BASE_CMD% %ARGS% %EPD_FLAG%
echo.
echo [実行中] %DASH_CMD%
ssh %SSH_USER%@%SSH_HOST% "cd %WORK_DIR% && %DASH_CMD%"
echo.
echo ローカルの古いキャッシュを削除して転送中...
if exist "%TEMP%\preview.png" del "%TEMP%\preview.png"
scp %SSH_USER%@%SSH_HOST%:/dev/shm/dashboard.png "%TEMP%\preview.png"
if exist "%TEMP%\preview.png" (
    start "" "%TEMP%\preview.png"
) else (
    echo [エラー] 画像の転送に失敗しました。
)
pause
goto MENU

:HEALTH_CHECK
echo.
start "YATA Btop" cmd /k ssh -t %SSH_USER%@%SSH_HOST% "btop"
goto MENU

:LOG_VIEW
echo.
ssh -t %SSH_USER%@%SSH_HOST% "echo '=== [ 1. YATA Job Log (RAM) ] ==='; tail -n 40 /dev/shm/yata_task.log; echo ''; echo '=== [ 2. Dashboard Log (RAM) ] ==='; tail -n 10 /dev/shm/yata_dashboard.log"
pause
goto MENU

:BACKUP
echo.
echo 日次バックアップ(NAS同期)を実行中...
ssh %SSH_USER%@%SSH_HOST% "/home/boncoli/yata-local/maintenance/do-backup.sh"
pause
goto MENU

:CHECK_NAS
echo.
ssh %SSH_USER%@%SSH_HOST% "if [ -d /mnt/nas ]; then echo 'Checking NAS contents...'; ls -lh /mnt/nas/yata_db_history/ | tail -n 5; else echo '[Error] NAS is NOT mounted at /mnt/nas'; fi"
pause
goto MENU

:FULL_IMAGE_BACKUP
echo.
echo 【警告】システム全体のフルバックアップを開始します。
echo ※処理中はシステム負荷が高まります。
set /p CONFIRM="実行しますか？ (y/n): "
if /i not "%CONFIRM%"=="y" goto MENU
ssh -t %SSH_USER%@%SSH_HOST% "if mountpoint -q /mnt/nas; then sudo image-backup /mnt/nas/rpi_complete_backup.img; else echo '[Critical Error] NAS not mounted. Backup aborted to prevent data loss.'; fi"
pause
goto MENU

:STOP_CRON
echo.
echo Cronを停止しています...
ssh -t %SSH_USER%@%SSH_HOST% "sudo systemctl stop cron && systemctl status cron --no-pager"
echo.
echo [注意] 自動運転がOFFになりました。作業後に18番で再開してください。
pause
goto MENU

:START_CRON
echo.
echo Cronを開始しています...
ssh -t %SSH_USER%@%SSH_HOST% "sudo systemctl start cron && systemctl status cron --no-pager"
echo.
echo [OK] 自動運転が再開されました。
pause
goto MENU

:MANUAL_SYNC
echo.
echo ========================================================
echo [実行中] RAM DB -> SDカード 強制同期
echo ========================================================
ssh %SSH_USER%@%SSH_HOST% "cd %WORK_DIR% && ./run-ram.sh --sync-only"
echo.
echo [完了]
pause
goto MENU

:SSH_CONSOLE
echo.
echo SSHコンソールを別ウィンドウで起動します...
start "YATA SSH Console" cmd /c ssh -t %SSH_USER%@%SSH_HOST% "cd %WORK_DIR%; bash --login"
goto MENU

:REBOOT_PI
echo.
set /p CONFIRM="データを同期して再起動しますか？ (y/n): "
if /i not "%CONFIRM%"=="y" goto MENU
ssh %SSH_USER%@%SSH_HOST% "cd %WORK_DIR% && ./run-ram.sh --sync-only"
ssh %SSH_USER%@%SSH_HOST% "sudo reboot"
exit

:SHUTDOWN_PI
echo.
set /p CONFIRM="データを同期して停止しますか？ (y/n): "
if /i not "%CONFIRM%"=="y" goto MENU
ssh %SSH_USER%@%SSH_HOST% "cd %WORK_DIR% && ./run-ram.sh --sync-only"
ssh %SSH_USER%@%SSH_HOST% "sudo poweroff"
exit

:UPDATE
echo.
echo システム更新を開始します。入力待ちが発生する場合があります。
ssh -t %SSH_USER%@%SSH_HOST% "sudo apt update && sudo apt upgrade -y && cd ~/yata-local && git pull"
pause
goto MENU

:SYNC_MAIN_FROM_LOCAL
echo.
echo ========================================================
echo [調査中] 更新内容（差分）を確認しています... (Core 4 Files)
echo ========================================================

:: 1. 比較対象を lib/YATA.js, CHANGELOG.md, README.md, prompts.json の4つに限定
:: 2. HTMLのチェックと同期を完全に除外
ssh %SSH_USER%@%SSH_HOST% "cd %WORK_DIR% && git fetch origin > /dev/null 2>&1; D=0; git diff --quiet origin/local-raspi -- lib/YATA.js 2>/dev/null || { echo '--- [!] 差分あり: lib/YATA.js ---'; git diff origin/local-raspi -- lib/YATA.js 2>/dev/null; D=1; }; git diff --quiet origin/local-raspi -- CHANGELOG.md 2>/dev/null || { echo '--- [!] 差分あり: CHANGELOG.md ---'; git diff origin/local-raspi -- CHANGELOG.md 2>/dev/null; D=1; }; git diff --quiet origin/local-raspi -- README.md 2>/dev/null || { echo '--- [!] 差分あり: README.md ---'; git diff origin/local-raspi -- README.md 2>/dev/null; D=1; }; git diff --quiet origin/local-raspi -- prompts.json 2>/dev/null || { echo '--- [!] 差分あり: prompts.json ---'; git diff origin/local-raspi -- prompts.json 2>/dev/null; D=1; }; exit $D"

:: ERRORLEVEL 1 以上なら差分あり
if %ERRORLEVEL% EQU 0 (
    echo.
    echo [Skip] すべて最新の状態です。
    pause
    goto MENU
)

echo.
echo --------------------------------------------------------
echo 上記の差分が見つかりました。最新成果を同期(Sync)しますか？
echo --------------------------------------------------------
choice /c yn /n /m "同期する場合は [y]、キャンセルして戻る場合は [n] を押してください: "

if errorlevel 2 (
    echo.
    echo [Cancel] 同期を中止しました。メニューに戻ります。
    pause
    goto MENU
)

echo.
echo [実行中] 最新ロジック（4ファイル）を転写しています...
ssh %SSH_USER%@%SSH_HOST% "cd %WORK_DIR% && git checkout origin/local-raspi -- lib/YATA.js CHANGELOG.md README.md prompts.json && echo '[Success] Core 4 files updated!'"

echo.
echo [完了] 同期が終了しました。
pause
goto MENU

:DOWNLOAD
echo.
echo [File Download]
set /p R_PATH="ラズパイ側のフルパスを入力してください: "
if "%R_PATH%"=="" goto MENU
set L_PATH="%USERPROFILE%\Desktop\"
echo デスクトップへ転送中...
scp %SSH_USER%@%SSH_HOST%:"%R_PATH%" %L_PATH%
if %ERRORLEVEL% equ 0 (
    echo [OK]
) else (
    echo [Error]
)
pause
goto MENU