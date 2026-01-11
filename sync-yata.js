const { google } = require('googleapis');
const Parser = require('rss-parser');
const Database = require('better-sqlite3');
const keys = require('./credentials.json');

const SPREADSHEET_ID = '1sdbK9TSsbYwQpO00nip6Kzc5r4ZQnux2W_RcZ19BwOk';
const db = new Database('yata.db');
const parser = new Parser();
const auth = google.auth.fromJSON(keys);
auth.scopes = ['https://www.googleapis.com/auth/spreadsheets'];

// --- YATA.js 準拠: 正規化ロジック ---
function normalizeUrl(url) {
    if (!url) return "";
    let s = String(url).trim();
    try { s = decodeURIComponent(s); } catch (e) {}
    s = s.toLowerCase();
    s = s.split('?')[0].split('#')[0]; // クエリとアンカー削除
    s = s.replace(/\/$/, "");          // 末尾スラッシュ削除
    s = s.replace(/^https?:\/\/(www\.)?/, "//"); // プロトコルとwwwの揺らぎ排除
    return s;
}

function normalizeTitle(title) {
    if (!title) return "";
    return title.trim().toLowerCase();
}

async function syncYata() {
    console.log('--- YATA ハイブリッド同期開始 (GASロジック準拠版) ---');
    const gsapi = google.sheets({ version: 'v4', auth });

    try {
        // 1. シート情報とRSSリストの取得
        const spreadsheet = await gsapi.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const collectSheet = spreadsheet.data.sheets.find(s => s.properties.title === 'collect');
        const rssListRes = await gsapi.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'RSS!A2:B', 
        });

        const rows = rssListRes.data.values;
        if (!rows || rows.length === 0) return;

        // DBから既存の正規化URL/タイトルをロード (重複チェック用)
        const existingEntries = db.prepare('SELECT url, title FROM articles').all();
        const existingUrlSet = new Set(existingEntries.map(e => normalizeUrl(e.url)));
        const existingTitleSet = new Set(existingEntries.map(e => normalizeTitle(e.title)));

        let tempItems = [];
        const now = new Date();
        const cutoffTime = new Date(now.getTime() - (24 * 60 * 60 * 1000)); // 24時間窓

        // 2. 巡回とフィルタリング
        for (const row of rows) {
            const [siteName, siteUrl] = row;
            if (!siteUrl) continue;
            console.log(`巡回中: ${siteName}`);
            
            try {
                const feed = await parser.parseURL(siteUrl);
                for (const item of feed.items) {
                    const pubDate = new Date(item.pubDate);
                    if (!isNaN(pubDate.getTime()) && pubDate < cutoffTime) continue;

                    const normUrl = normalizeUrl(item.link);
                    const normTitle = normalizeTitle(item.title);

                    // 【重複排除】URL(正規化済) または タイトル(正規化済) が存在すればスキップ
                    if (existingUrlSet.has(normUrl) || existingTitleSet.has(normTitle)) continue;

                    // DBに保存
                    db.prepare('INSERT INTO articles (url, title, content_text, published_at) VALUES (?, ?, ?, ?)')
                      .run(item.link, item.title, item.contentSnippet, item.pubDate);
                    
                    // セットにも追加して今回の実行内での重複も防ぐ
                    existingUrlSet.add(normUrl);
                    existingTitleSet.add(normTitle);

                    tempItems.push({
                        dateObj: pubDate,
                        data: [
                            pubDate.toLocaleString('ja-JP'), 
                            item.title, 
                            item.link, 
                            item.contentSnippet || '', 
                            '', 
                            siteName
                        ]
                    });
                }
            } catch (e) { console.error(`  ⚠️ Error: ${siteName} - ${e.message}`); }
        }

        // 新着のみを降順ソート (prependの準備)
        tempItems.sort((a, b) => b.dateObj - a.dateObj);
        const finalValues = tempItems.map(item => item.data);

        // 3. 書き込みと「全体ソート」
        if (finalValues.length > 0) {
            // A. 新着を追記 (append)
            await gsapi.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: 'collect!A:F',
                valueInputOption: 'USER_ENTERED',
                resource: { values: finalValues }
            });

            // B. シート全体を最新順にソート (sortCollectByDateDesc 互換)
            await gsapi.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: {
                    requests: [{
                        sortRange: {
                            range: {
                                sheetId: collectSheet.properties.sheetId,
                                startRowIndex: 1, // ヘッダー飛ばし
                                startColumnIndex: 0,
                                endColumnIndex: 6
                            },
                            sortSpecs: [{ dimensionIndex: 0, sortOrder: 'DESCENDING' }]
                        }
                    }]
                }
            });
            console.log(`✅ ${finalValues.length}件追加し、全体を降順ソートしました。`);
        } else {
            console.log('新着なし。');
        }
    } catch (err) { console.error('同期エラー:', err.message); }
    process.exit(0);
}

syncYata();
