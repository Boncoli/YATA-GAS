/**
 * tasks/do-health-check.js
 * YATAシステム総合診断スクリプト
 * 
 * 実行方法: bash run-ram.sh --no-sync do-health-check.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// GAS Bridge & Loader (DBパス等の環境変数取得のため)
try {
    require('../lib/gas-bridge.js');
    require('../lib/yata-loader.js');
} catch (e) {
    // スタンドアロン実行時用
    require('dotenv').config();
}

const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    cyan: "\x1b[36m"
};

function getCpuTemp() {
    try {
        const tempRaw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
        return (parseInt(tempRaw) / 1000).toFixed(1) + "°C";
    } catch (e) { return "N/A"; }
}

function checkProcess(name) {
    try {
        const stdout = execSync(`ps aux | grep "${name}" | grep -v "grep" | grep -v "health-check"`).toString();
        return stdout.length > 0 ? `${colors.green}RUNNING${colors.reset}` : `${colors.red}STOPPED${colors.reset}`;
    } catch (e) { return `${colors.red}STOPPED${colors.reset}`; }
}

function checkRamDisk() {
    try {
        const stdout = execSync('df -h /dev/shm | tail -n 1').toString().split(/\s+/);
        const usedPercent = stdout[4];
        const available = stdout[3];
        let color = colors.green;
        if (parseInt(usedPercent) > 80) color = colors.yellow;
        if (parseInt(usedPercent) > 95) color = colors.red;
        return `${color}${usedPercent}${colors.reset} (Avail: ${available})`;
    } catch (e) { return "N/A"; }
}

async function checkDatabase() {
    const dbPath = process.env.DB_PATH || './yata.db';
    if (!fs.existsSync(dbPath)) return { status: `${colors.red}NOT FOUND (${dbPath})${colors.reset}` };
    
    try {
        // コマンドラインの sqlite3 を使用
        const count = execSync(`sqlite3 ${dbPath} "SELECT COUNT(*) FROM collect"`).toString().trim();
        const lastDate = execSync(`sqlite3 ${dbPath} "SELECT date FROM collect ORDER BY date DESC LIMIT 1"`).toString().trim();
        
        const lastTime = lastDate ? new Date(lastDate) : null;
        const diffMin = lastTime ? Math.floor((new Date() - lastTime) / 60000) : null;
        
        let timeStr = lastTime ? lastTime.toLocaleString('ja-JP') : "None";
        if (diffMin !== null && diffMin > 180) timeStr = `${colors.yellow}${timeStr} (${diffMin} min ago)${colors.reset}`;
        else if (diffMin !== null) timeStr = `${colors.green}${timeStr} (${diffMin} min ago)${colors.reset}`;

        return {
            status: `${colors.green}OK${colors.reset}`,
            count: parseInt(count).toLocaleString(),
            lastUpdate: timeStr
        };
    } catch (e) {
        return { status: `${colors.red}ERROR: ${e.message}${colors.reset}` };
    }
}

function checkRecentErrors() {
    const logFiles = ['logs/yata.log', 'logs/task.log'];
    let errorCount = 0;
    const recentErrors = [];

    logFiles.forEach(file => {
        if (!fs.existsSync(file)) return;
        try {
            // 過去1時間以内のErrorを検索
            const stdout = execSync(`grep -iE "error|failed|exception" ${file} | tail -n 5`).toString().trim();
            if (stdout) {
                const lines = stdout.split('\n');
                errorCount += lines.length;
                lines.forEach(l => recentErrors.push(`[${path.basename(file)}] ${l}`));
            }
        } catch (e) { /* No errors found or grep failed */ }
    });

    return { count: errorCount, samples: recentErrors };
}

async function run() {
    console.log(`\n${colors.bright}${colors.cyan}==========================================${colors.reset}`);
    console.log(`${colors.bright} 🛡️  YATA System Health Report (${new Date().toLocaleString('ja-JP')})${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}==========================================${colors.reset}`);

    // Processes
    console.log(`\n[Processes]`);
    console.log(`  ● Server (Node.js):    ${checkProcess('server.js')}`);
    console.log(`  ● Dashboard (Python):  ${checkProcess('dashboard.py')}`);
    console.log(`  ● RAM Wrapper:         ${checkProcess('run-ram.sh')}`);

    // Resources
    console.log(`\n[Resources]`);
    console.log(`  📊 RAM Disk Usage:     ${checkRamDisk()}`);
    console.log(`  🌡️ CPU Temperature:    ${getCpuTemp()}`);

    // Database
    const dbInfo = await checkDatabase();
    console.log(`\n[Database]`);
    console.log(`  📦 Status:             ${dbInfo.status}`);
    if (dbInfo.count) {
        console.log(`  📝 Article Count:      ${dbInfo.count}`);
        console.log(`  🕒 Last Collection:   ${dbInfo.lastUpdate}`);
    }

    // Logs
    const logInfo = checkRecentErrors();
    console.log(`\n[Recent Log Alerts (Last 1h)]`);
    if (logInfo.count === 0) {
        console.log(`  ✅ ${colors.green}No critical errors detected.${colors.reset}`);
    } else {
        console.log(`  ❌ ${colors.red}Detected ${logInfo.count} error-like patterns:${colors.reset}`);
        logInfo.samples.slice(-3).forEach(line => console.log(`     - ${line.substring(0, 80)}...`));
    }

    console.log(`\n${colors.bright}${colors.cyan}==========================================${colors.reset}`);
    
    const overallStatus = (logInfo.count === 0 && !checkProcess('server.js').includes('STOPPED')) 
        ? `${colors.green}ALL SYSTEMS NOMINAL${colors.reset}` 
        : `${colors.yellow}CHECK REQUIRED${colors.reset}`;
    
    console.log(` ✨ Status: ${overallStatus}`);
    console.log(`${colors.bright}${colors.cyan}==========================================${colors.reset}\n`);
}

run();
