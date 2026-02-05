const { google } = require('googleapis');
const fs = require('fs');
const keys = require('../credentials.json');

const SPREADSHEET_ID = '1sdbK9TSsbYwQpO00nip6Kzc5r4ZQnux2W_RcZ19BwOk';
const auth = google.auth.fromJSON(keys);
auth.scopes = ['https://www.googleapis.com/auth/spreadsheets'];

async function exportFeeds() {
    const gsapi = google.sheets({ version: 'v4', auth });
    console.log('Fetching feeds from Spreadsheet...');

    try {
        const res = await gsapi.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'RSS!A2:D', // ラベル, URL, カテゴリ, 有効フラグ を想定
        });

        const rows = res.data.values;
        if (!rows || rows.length === 0) {
            console.log('No feeds found in Spreadsheet.');
            return;
        }

        const feeds = rows.map(row => ({
            label: row[0] || 'No Name',
            url: row[1] || '',
            category: row[2] || 'General',
            active: row[3] !== 'FALSE' // デフォルトは TRUE
        })).filter(f => f.url);

        fs.writeFileSync('./rss-list.json', JSON.stringify(feeds, null, 2), 'utf8');
        console.log(`Successfully exported ${feeds.length} feeds to rss-list.json`);
        
    } catch (err) {
        console.error('Error fetching feeds:', err.message);
    }
}

exportFeeds();
