import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizePunchContour, parseDxfContour, readDxfFile } from "../app/dxf-parser.js";

function group(code, value) {
  return [String(code), String(value)];
}

function line(x1, y1, x2, y2) {
  return [
    ...group(0, "LINE"),
    ...group(10, x1),
    ...group(20, y1),
    ...group(11, x2),
    ...group(21, y2),
  ];
}

function rectangle(x, y, width, height) {
  return [
    ...line(x, y, x + width, y),
    ...line(x + width, y, x + width, y + height),
    ...line(x + width, y + height, x, y + height),
    ...line(x, y + height, x, y),
  ];
}

function makeDxf(entities, { units = 4, includeUnits = true } = {}) {
  const pairs = [
    ...group(0, "SECTION"),
    ...group(2, "HEADER"),
    ...(includeUnits ? [...group(9, "$INSUNITS"), ...group(70, units)] : []),
    ...group(0, "ENDSEC"),
    ...group(0, "SECTION"),
    ...group(2, "ENTITIES"),
    ...entities,
    ...group(0, "ENDSEC"),
    ...group(0, "EOF"),
  ];
  return `${pairs.join("\n")}\n`;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeDescriptorZip(name, contents) {
  const nameBytes = Buffer.from(name, "utf8");
  const payload = Buffer.from(contents, "utf8");
  const checksum = crc32(payload);
  const flags = 0x0008 | 0x0800;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(flags, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(nameBytes.length, 26);

  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(checksum, 4);
  descriptor.writeUInt32LE(payload.length, 8);
  descriptor.writeUInt32LE(payload.length, 12);

  const centralOffset = localHeader.length + nameBytes.length + payload.length + descriptor.length;
  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(flags, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(payload.length, 20);
  centralHeader.writeUInt32LE(payload.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt32LE(0, 42);

  const centralSize = centralHeader.length + nameBytes.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([localHeader, nameBytes, payload, descriptor, centralHeader, nameBytes, eocd]);
}

function fileLike(name, bytes) {
  return {
    name,
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

test("parses a single closed millimetre LINE contour", () => {
  const result = parseDxfContour(makeDxf(rectangle(0, 0, 20, 10)), { entryName: "part.dxf" });
  assert.equal(result.closed, true);
  assert.equal(result.units, 4);
  assert.equal(result.entryName, "part.dxf");
  assert.equal(result.points.length, 4);
  assert.equal(result.entityCount, 4);
});

test("rejects missing or non-millimetre $INSUNITS", () => {
  assert.throws(
    () => parseDxfContour(makeDxf(rectangle(0, 0, 20, 10), { includeUnits: false })),
    /缺少 \$INSUNITS/
  );
  assert.throws(
    () => parseDxfContour(makeDxf(rectangle(0, 0, 20, 10), { units: 1 })),
    /仅接受 \$INSUNITS=4/
  );
});

for (const entity of ["CIRCLE", "LWPOLYLINE", "POLYLINE", "VERTEX", "SPLINE", "ELLIPSE"]) {
  test(`rejects unsupported ${entity} geometry`, () => {
    assert.throws(
      () => parseDxfContour(makeDxf([...group(0, entity), ...group(10, 0), ...group(20, 0)])),
      new RegExp(`不支持的实体 ${entity}`)
    );
  });
}

test("rejects a self-intersecting main contour", () => {
  const bowTie = [
    ...line(0, 0, 10, 10),
    ...line(10, 10, 0, 10),
    ...line(0, 10, 10, 0),
    ...line(10, 0, 0, 0),
  ];
  assert.throws(() => parseDxfContour(makeDxf(bowTie)), /自交/);
});

test("rejects non-planar LINE geometry instead of projecting it to 2D", () => {
  const nonPlanar = [
    ...group(0, "LINE"),
    ...group(10, 0),
    ...group(20, 0),
    ...group(30, 5),
    ...group(11, 10),
    ...group(21, 0),
    ...group(31, 5),
    ...rectangle(0, 0, 20, 10),
  ];
  assert.throws(() => parseDxfContour(makeDxf(nonPlanar)), /不是 XY 平面二维实体/);
});

test("rejects multiple similarly large closed contours", () => {
  const entities = [...rectangle(0, 0, 20, 10), ...rectangle(40, 0, 20, 10)];
  assert.throws(() => parseDxfContour(makeDxf(entities)), /多个大型闭合轮廓/);
});

test("reads a flags=0x0008 ZIP from its central directory and validates its descriptor", async () => {
  const zip = makeDescriptorZip("tool-outline.DXF", makeDxf(rectangle(0, 0, 30, 12)));
  const result = await readDxfFile(fileLike("tool-outline.DXF.zip", zip));
  assert.equal(result.closed, true);
  assert.equal(result.units, 4);
  assert.equal(result.entryName, "tool-outline.DXF");
  assert.equal(result.points.length, 4);
});

test("rejects a ZIP whose payload does not match the central-directory CRC32", async () => {
  const name = "tool.DXF";
  const zip = makeDescriptorZip(name, makeDxf(rectangle(0, 0, 30, 12)));
  zip[30 + Buffer.byteLength(name) + 8] ^= 0x01;
  await assert.rejects(() => readDxfFile(fileLike("tool.DXF.zip", zip)), /CRC32/);
});

test("rejects a truncated ZIP central directory", async () => {
  const zip = makeDescriptorZip("tool.DXF", makeDxf(rectangle(0, 0, 30, 12)));
  const truncated = zip.subarray(0, zip.length - 10);
  await assert.rejects(() => readDxfFile(fileLike("tool.DXF.zip", truncated)), /中央目录/);
});

test("normalizes a punch whose tip is at the source contour minimum Y", () => {
  const normalized = normalizePunchContour([
    { x: -2, y: 0 },
    { x: 2, y: 0 },
    { x: 12, y: 40 },
    { x: -12, y: 40 },
  ]);
  assert.deepEqual(normalized.slice(0, 2), [
    { x: -2, y: 0 },
    { x: 2, y: 0 },
  ]);
  assert.ok(normalized.slice(2).every((point) => point.y < 0));
});

test("normalizes a punch whose tip is at the source contour maximum Y", () => {
  const normalized = normalizePunchContour([
    { x: -12, y: 0 },
    { x: 12, y: 0 },
    { x: 2, y: 40 },
    { x: -2, y: 40 },
  ]);
  assert.deepEqual(normalized.slice(2), [
    { x: 2, y: 0 },
    { x: -2, y: 0 },
  ]);
  assert.ok(normalized.slice(0, 2).every((point) => point.y < 0));
});

for (const article of ["11200", "19224"]) {
  test(`real CTG ${article} DXF and descriptor ZIP remain importable`, async (context) => {
    const dxfPath = `/private/tmp/ukb-dxf-samples/${article}.DXF`;
    const zipPath = `/private/tmp/${article}.DXF.zip`;
    if (!existsSync(dxfPath) || !existsSync(zipPath)) {
      context.skip("CTG fixture is not available on this machine");
      return;
    }
    const dxf = await readFile(dxfPath);
    const rawResult = await readDxfFile(fileLike(`${article}.DXF`, dxf));
    assert.equal(rawResult.closed, true);
    assert.equal(rawResult.units, 4);
    assert.ok(rawResult.points.length >= 20);

    const zip = await readFile(zipPath);
    const zipResult = await readDxfFile(fileLike(`${article}.DXF.zip`, zip));
    assert.equal(zipResult.closed, true);
    assert.equal(zipResult.units, 4);
    assert.equal(zipResult.entryName, `${article}.DXF`);
    assert.deepEqual(zipResult.points, rawResult.points);
  });
}
