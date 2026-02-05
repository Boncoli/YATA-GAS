const fs = require('fs');
const path = require('path');

const FEEDS_FILE = path.join(__dirname, '../rss-list.json');

function loadFeeds() {
    if (!fs.existsSync(FEEDS_FILE)) return [];
    return JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));
}

function saveFeeds(feeds) {
    fs.writeFileSync(FEEDS_FILE, JSON.stringify(feeds, null, 2), 'utf8');
}

const command = process.argv[2];
const args = process.argv.slice(3);

const feeds = loadFeeds();

switch (command) {
    case 'list':
        console.log('\n--- Current RSS Feeds ---');
        feeds.forEach((f, i) => {
            const status = f.active ? '[ON ]' : '[OFF]';
            console.log(`${i}: ${status} [${f.label}] ${f.url}`);
        });
        console.log(`Total: ${feeds.length} feeds\n`);
        break;

    case 'add':
        const [url, label, category] = args;
        if (!url) {
            console.log('Usage: node tasks/manage-feeds.js add <url> [label] [category]');
            return;
        }
        if (feeds.some(f => f.url === url)) {
            console.log('Error: URL already exists.');
            return;
        }
        feeds.push({
            label: label || url,
            url: url,
            category: category || 'General',
            active: true
        });
        saveFeeds(feeds);
        console.log(`Added: ${label || url}`);
        break;

    case 'remove':
        const target = args[0];
        if (target === undefined) {
            console.log('Usage: node tasks/manage-feeds.js remove <index>');
            return;
        }
        const index = parseInt(target);
        if (isNaN(index) || !feeds[index]) {
            console.log('Error: Invalid index.');
            return;
        }
        const removed = feeds.splice(index, 1);
        saveFeeds(feeds);
        console.log(`Removed: ${removed[0].label}`);
        break;

    case 'toggle':
        const tIndex = parseInt(args[0]);
        if (isNaN(tIndex) || !feeds[tIndex]) {
            console.log('Error: Invalid index.');
            return;
        }
        feeds[tIndex].active = !feeds[tIndex].active;
        saveFeeds(feeds);
        console.log(`Toggled: ${feeds[tIndex].label} is now ${feeds[tIndex].active ? 'ACTIVE' : 'INACTIVE'}`);
        break;

    default:
        console.log('\nUsage: node tasks/manage-feeds.js <command> [args]');
        console.log('Commands:');
        console.log('  list                 - Show all feeds');
        console.log('  add <url> [label]    - Add a new feed');
        console.log('  remove <index>       - Remove a feed by index');
        console.log('  toggle <index>       - Enable/Disable a feed');
        break;
}