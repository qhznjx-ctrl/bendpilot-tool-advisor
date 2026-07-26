import { readFileSync, writeFileSync } from 'fs';
import { parseDxfContour, normalizePunchContour } from './app/dxf-parser.js';

const moldDir = '/Users/xikemima1111/Desktop/上传的模具/';
const files = [
  '20.210.dxf','20.211.dxf','20.212.dxf','20.213.dxf','20.214.dxf','20.215.dxf',
  '20.297.dxf','20.298.dxf','20.299.dxf','20.300.dxf','20.301.dxf','20.308.dxf',
  '20.311.dxf','20.349.dxf','21.231.dxf','21.264.dxf','21.303.dxf','21.305.dxf'
];

const geometries = {};
let successCount = 0;
let failCount = 0;

for (const f of files) {
  try {
    const text = readFileSync(moldDir + f, 'utf-8');
    const parsed = parseDxfContour(text, { entryName: f });
    const normalized = normalizePunchContour(parsed.points);
    geometries[f.replace('.dxf', '')] = {
      points: normalized,
      source: 'user-confirmed-ukb-download',
      validatedAt: new Date().toISOString()
    };
    successCount++;
    console.log(`✅ ${f}: ${normalized.length} points`);
  } catch(e) {
    failCount++;
    console.error(`❌ ${f}: ${e.message}`);
  }
}

console.log(`\nTotal: ${successCount} success, ${failCount} failed`);

// Output as JS code for browser console
const localStorageCode = `localStorage.setItem('bendpilot-dxf-geometries', JSON.stringify({
  schemaVersion: 3,
  parserVersion: 'ukb-ascii-dxf/2',
  geometries: ${JSON.stringify(geometries)}
}));`;

writeFileSync('/tmp/browser_inject_code.js', localStorageCode);
console.log('\nSaved browser inject code to /tmp/browser_inject_code.js');
console.log('Length:', localStorageCode.length, 'bytes');
