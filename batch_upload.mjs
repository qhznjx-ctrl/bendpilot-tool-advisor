import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseDxfContour, normalizePunchContour } from './app/dxf-parser.js';

const moldDir = '/Users/xikemima1111/Desktop/上传的模具/';
const files = [
  '20.210.dxf','20.211.dxf','20.212.dxf','20.213.dxf','20.214.dxf','20.215.dxf',
  '20.297.dxf','20.298.dxf','20.299.dxf','20.300.dxf','20.301.dxf','20.308.dxf',
  '20.311.dxf','20.349.dxf','21.231.dxf','21.264.dxf','21.303.dxf','21.305.dxf'
];

const results = [];
for (const f of files) {
  try {
    const text = readFileSync(join(moldDir, f), 'utf-8');
    const parsed = parseDxfContour(text, { entryName: f });
    const normalized = normalizePunchContour(parsed.points);
    results.push({
      articleNumber: f.replace('.dxf', ''),
      kind: 'punch',
      pointsCount: normalized.length,
      points: normalized,
      source: 'user-confirmed-ukb-download',
      validatedAt: new Date().toISOString()
    });
    console.log(`✅ ${f}: ${normalized.length} points`);
  } catch(e) {
    results.push({ file: f, error: e.message });
    console.error(`❌ ${f}: ${e.message}`);
  }
}

// Build localStorage payload matching app schema
const payload = {
  schemaVersion: 3,
  parserVersion: 'ukb-ascii-dxf/2',
  geometries: {}
};

let successCount = 0;
for (const r of results) {
  if (r.points) {
    payload.geometries[r.articleNumber] = {
      points: r.points,
      source: r.source,
      validatedAt: r.validatedAt
    };
    successCount++;
  }
}

writeFileSync('/tmp/dxf_geometries_payload.json', JSON.stringify(payload));
console.log(`\nSaved ${successCount} geometries to /tmp/dxf_geometries_payload.json`);
