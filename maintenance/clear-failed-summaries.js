const Database = require('better-sqlite3');
const path = require('path');
const dbPath = process.env.DB_PATH || path.join(__dirname, 'yata.db');
const db = new Database(dbPath);

console.log(`Using DB: ${dbPath}`);

const targetDate = '2026-03-24';
const result = db.prepare(`
    UPDATE collect 
    SET summary = NULL 
    WHERE date(date) >= ? 
    AND summary = title
`).run(targetDate);

console.log(`Cleared ${result.changes} failed summaries (title fallback).`);
db.close();
