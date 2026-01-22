
const bridge = require('../lib/gas-bridge.js');

// テスト用日時: 2024年1月5日 7時5分9秒 (1桁の数字が含まれる日時)
const testDate = new Date('2024-01-05T07:05:09');

const cases = [
    { format: 'HH:mm', expected: '07:05', desc: '2桁時:2桁分 (今回のバグ箇所)' },
    { format: 'H:mm', expected: '7:05', desc: '1桁時:2桁分' },
    { format: 'yyyy/MM/dd', expected: '2024/01/05', desc: '標準日付' },
    { format: 'yyyy-M-d', expected: '2024-1-5', desc: '1桁月日' },
    { format: 'yyyy/MM/dd H:mm:ss', expected: '2024/01/05 7:05:09', desc: '混合日時' },
    { format: 'MM/dd', expected: '01/05', desc: '月日のみ' },
    { format: 'HH', expected: '07', desc: '時のみ2桁' },
    { format: 'mm', expected: '05', desc: '分のみ2桁' }
];

console.log("=== Utilities.formatDate Test ===");
let passed = 0;
let failed = 0;

cases.forEach(c => {
    const result = global.Utilities.formatDate(testDate, 'JST', c.format);
    if (result === c.expected) {
        console.log(`✅ [PASS] ${c.desc}: ${c.format} -> ${result}`);
        passed++;
    } else {
        console.error(`❌ [FAIL] ${c.desc}: ${c.format} -> Expected '${c.expected}', but got '${result}'`);
        failed++;
    }
});

if (failed === 0) {
    console.log(`
All ${passed} tests passed!`);
} else {
    console.error(`
${failed} tests failed.`);
    process.exit(1);
}

