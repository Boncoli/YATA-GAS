const fs = require('fs');
const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');

const targetFile = '20170504_サイコロドライブ.kmz';

if (!fs.existsSync(targetFile)) {
    console.error(`File not found: ${targetFile}`);
    process.exit(1);
}

try {
    const zip = new AdmZip(targetFile);
    const kmlEntry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.kml'));
    
    if (!kmlEntry) {
        console.error("No KML found inside KMZ");
        process.exit(1);
    }

    console.log(`Analyzing KML: ${kmlEntry.entryName}`);
    const kmlContent = zip.readAsText(kmlEntry);
    
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const kmlObj = parser.parse(kmlContent);

    function inspect(obj, depth = 0) {
        if (!obj || depth > 5) return;
        const indent = "  ".repeat(depth);

        if (obj.Placemark) {
            const pms = Array.isArray(obj.Placemark) ? obj.Placemark : [obj.Placemark];
            console.log(`${indent}Found ${pms.length} Placemarks`);
            
            // 最初の数個だけ詳細を表示
            pms.slice(0, 3).forEach((pm, i) => {
                const name = pm.name || "(no name)";
                const hasLine = !!pm.LineString;
                const hasTrack = !!pm['gx:Track'];
                const hasTime = !!pm.TimeStamp || (pm['gx:Track'] && pm['gx:Track'].when);
                console.log(`${indent}  [${i}] Name: ${name}, LineString: ${hasLine}, gx:Track: ${hasTrack}, Time: ${hasTime}`);
                if (hasTrack && pm['gx:Track'].when) {
                    const times = Array.isArray(pm['gx:Track'].when) ? pm['gx:Track'].when : [pm['gx:Track'].when];
                    console.log(`${indent}      Range: ${times[0]} ~ ${times[times.length-1]}`);
                }
            });
        }

        if (obj.Folder) {
            const folders = Array.isArray(obj.Folder) ? obj.Folder : [obj.Folder];
            folders.forEach(f => {
                console.log(`${indent}Folder: ${f.name || "(no name)"}`);
                inspect(f, depth + 1);
            });
        }
        
        if (obj.Document) {
            console.log(`${indent}Document: ${obj.Document.name || ""}`);
            inspect(obj.Document, depth + 1);
        }
    }

    inspect(kmlObj.kml);

} catch (e) {
    console.error(e);
}
