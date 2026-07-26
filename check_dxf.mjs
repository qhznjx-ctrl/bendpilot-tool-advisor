import { parseDxfContour } from './app/dxf-parser.js';
import { readFileSync, readdirSync } from 'fs';

const dxfDir = 'public/dxf';
const files = readdirSync(dxfDir).filter(f => /\.dxf$/i.test(f)).sort();
let ok = 0, fail = 0, failedList = [];
for (const f of files) {
  try {
    const text = readFileSync(dxfDir + '/' + f, 'utf-8');
    if (!text.includes('SECTION')) continue;
    parseDxfContour(text, { entryName: f });
    ok++;
  } catch(e) {
    fail++;
    failedList.push(f + ': ' + e.message);
  }
}
console.log(JSON.stringify({ total: files.length, ok, fail, failed: failedList.slice(0, 20) }));
