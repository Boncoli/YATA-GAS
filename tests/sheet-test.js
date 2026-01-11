const { google } = require('googleapis');
const keys = require('./credentials.json');

// スプレッドシートIDをここに貼り付けてください
const SPREADSHEET_ID = '1sdbK9TSsbYwQpO00nip6Kzc5r4ZQnux2W_RcZ19BwOk'; 

// 1. 認証クライアントの作成 (JSONから直接生成する最も安全な方法)
const auth = google.auth.fromJSON(keys);
auth.scopes = ['https://www.googleapis.com/auth/spreadsheets'];

async function runTest() {
    console.log('--- スプレッドシート書き込みテスト開始 ---');
    
    try {
        const gsapi = google.sheets({ version: 'v4', auth });
        
        console.log('Google API 認証試行中...');

        // 2. スプレッドシートの末尾にデータを追記
        const response = await gsapi.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'collect!A:F', // シート名が違う場合は適宜修正
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[
                    new Date().toLocaleString('ja-JP'), 
                    'Raspberry Pi 5 Hybrid Test', 
                    'http://localhost', 
                    '認証方式を変更してテスト成功', 
                    '', 
                    'HomeServer'
                ]]
            }
        });

        console.log('✅ 成功！スプレッドシートが更新されました。');
        console.log('更新範囲:', response.data.updates.updatedRange);

    } catch (err) {
        console.error('❌ エラーが発生しました:');
        console.error('メッセージ:', err.message);
        
        if (err.message.includes('403')) {
            console.log('\n💡 ヒント: 共有設定を再確認してください。');
            console.log('宛先メールアドレス:', keys.client_email);
        }
        if (err.message.includes('404')) {
            console.log('\n💡 ヒント: スプレッドシートIDが正しいか、URLを確認してください。');
        }
    }
}

runTest();