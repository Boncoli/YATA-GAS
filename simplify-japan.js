const fs = require('fs');

const INPUT_FILE = './local_public/data/japan.geojson';
const OUTPUT_FILE = './local_public/data/japan_light.geojson';

console.log(`[GeoJSON] Reading ${INPUT_FILE}...`);
const json = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));

// 1/5 に間引く
const SAMPLE_RATE = 5;

let totalPoints = 0;
let savedPoints = 0;

json.features.forEach(feature => {
    if (feature.geometry.type === 'MultiPolygon') {
        feature.geometry.coordinates = feature.geometry.coordinates.map(polygon => {
            return polygon.map(ring => {
                totalPoints += ring.length;
                const newRing = ring.filter((_, i) => i % SAMPLE_RATE === 0 || i === ring.length - 1);
                // 閉じたポリゴンにするため、最後と最初を合わせる
                if (newRing.length > 0) {
                    const first = newRing[0];
                    const last = newRing[newRing.length - 1];
                    if (first[0] !== last[0] || first[1] !== last[1]) {
                        newRing.push(first);
                    }
                }
                savedPoints += newRing.length;
                return newRing;
            });
        });
    } else if (feature.geometry.type === 'Polygon') {
        feature.geometry.coordinates = feature.geometry.coordinates.map(ring => {
            totalPoints += ring.length;
            const newRing = ring.filter((_, i) => i % SAMPLE_RATE === 0 || i === ring.length - 1);
            if (newRing.length > 0) {
                const first = newRing[0];
                const last = newRing[newRing.length - 1];
                if (first[0] !== last[0] || first[1] !== last[1]) {
                    newRing.push(first);
                }
            }
            savedPoints += newRing.length;
            return newRing;
        });
    }
});

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(json));
const originalSize = fs.statSync(INPUT_FILE).size / 1024 / 1024;
const newSize = fs.statSync(OUTPUT_FILE).size / 1024 / 1024;

console.log(`[GeoJSON] Done!`);
console.log(`Points:   ${totalPoints} -> ${savedPoints} (-${((totalPoints - savedPoints) / totalPoints * 100).toFixed(1)}%)`);
console.log(`Original: ${originalSize.toFixed(2)} MB`);
console.log(`Light:    ${newSize.toFixed(2)} MB`);
