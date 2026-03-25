const Database = require('better-sqlite3');
const dbPath = '/dev/shm/yata.db';
const db = new Database(dbPath);
const rows = db.prepare("SELECT title, tldr, who, what, result FROM collect ORDER BY date DESC LIMIT 3").all();
console.log(JSON.stringify(rows, null, 2));
