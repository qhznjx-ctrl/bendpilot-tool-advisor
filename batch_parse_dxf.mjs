import { readFileSync } from 'fs';
import { parseDxfContour } from './app/dxf-parser.js';

const moldDir = '/Users/xikemima1111/Desktop/上传的模具/';
const files = [
  '20.210.dxf','20.211.dxf','20.212.dxf','20.213.dxf','20.214.dxf','20.215.dxf',
  '20.297.dxf','20.298.dxf','20.299.dxf','20.300.dxf','20.301.dxf','20.308.dxf',
  '20.311.dxf','20.349.dxf','21.231.dxf','21.264.dxf','21.303.dxf','21.305.dxf'
];

let success = 0, fail = 0;
for (const f of files) {
  try {
    const text = readFileSync(moldDir + f, 'utf-8');
    const result = parseDxfContour(text, { entryName: f });
    console.log(JSON.stringify({
      file: f,
      articleNumber: f.replace('.dxf',''),
      pointsCount: result.points.length,
      entityCount: result.entityCount,
      segmentCount: result.segmentCount,
      closedContourCount: result.closedContourCount,
      samplePoints: result.points.slice(0, 5)
    }));
    success++;
  } catch(e) {
    console.error(JSON.stringify({ file: f, error: e.message }));
    fail++;
  }
}
console.log(`\nTotal: ${success} success, ${fail} failed`);
