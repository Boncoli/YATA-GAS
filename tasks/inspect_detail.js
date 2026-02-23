const fs = require('fs');
const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');

const targetFile = '20170504_サイコロドライブ.kmz';
const zip = new AdmZip(targetFile);
const kmlEntry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.kml'));
const kmlContent = zip.readAsText(kmlEntry);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
const kmlObj = parser.parse(kmlContent);

function findDriveCourse(obj) {
    if (!obj) return;
    
    if (obj.Placemark) {
        const pms = Array.isArray(obj.Placemark) ? obj.Placemark : [obj.Placemark];
        const target = pms.find(p => p.name === 'ドライブコース');
        if (target) {
            console.log("=== Found 'ドライブコース' ===");
            console.log(JSON.stringify(target, null, 2).substring(0, 1000)); // 先頭1000文字だけ
            return;
        }
    }

    for (const key in obj) {
        if (typeof obj[key] === 'object') findDriveCourse(obj[key]);
    }
}

findDriveCourse(kmlObj.kml);
