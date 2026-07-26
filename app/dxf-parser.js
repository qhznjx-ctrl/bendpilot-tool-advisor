const LIMITS = Object.freeze({
  maxUploadBytes: 8 * 1024 * 1024,
  maxDxfBytes: 4 * 1024 * 1024,
  maxZipEntries: 128,
  maxZipNameBytes: 1024,
  maxPairs: 240_000,
  maxEntities: 5_000,
  maxSegments: 5_000,
  maxPoints: 30_000,
  maxCoordinate: 100_000,
  maxRadius: 25_000,
  maxArcSamples: 2_048,
  maxIntersectionChecks: 300_000,
});

const LARGE_CONTOUR_AREA_RATIO = 0.2;
const SUPPORTED_ENTITIES = new Set(["LINE", "ARC"]);
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_DATA_DESCRIPTOR = 0x08074b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function finiteNumber(entity, code, label) {
  const values = entity.values.get(code) ?? [];
  if (values.length !== 1) throw new Error(`${entity.type} 的 ${label} 数量无效`);
  const raw = values[0];
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value)) {
    throw new Error(`${entity.type} 缺少有效的 ${label}`);
  }
  return value;
}

function optionalFiniteNumber(entity, code, fallback, label) {
  const values = entity.values.get(code) ?? [];
  if (values.length === 0) return fallback;
  if (values.length !== 1) throw new Error(`${entity.type} 的 ${label} 数量无效`);
  const value = Number(values[0]);
  if (!Number.isFinite(value)) throw new Error(`${entity.type} 的 ${label} 无效`);
  return value;
}

function assertPlanarEntity(entity, zCodes) {
  for (const code of zCodes) {
    if (Math.abs(optionalFiniteNumber(entity, code, 0, `Z 坐标 ${code}`)) > 1e-8) {
      throw new Error(`${entity.type} 不是 XY 平面二维实体`);
    }
  }
  const normalX = optionalFiniteNumber(entity, 210, 0, "法向量 X");
  const normalY = optionalFiniteNumber(entity, 220, 0, "法向量 Y");
  const normalZ = optionalFiniteNumber(entity, 230, 1, "法向量 Z");
  if (Math.abs(normalX) > 1e-8 || Math.abs(normalY) > 1e-8 || Math.abs(normalZ - 1) > 1e-8) {
    throw new Error(`${entity.type} 使用了不支持的非默认坐标平面`);
  }
}

function checkedCoordinate(value, label) {
  if (Math.abs(value) > LIMITS.maxCoordinate) {
    throw new Error(`${label} 超出允许的坐标范围`);
  }
  return value;
}

function checkedPoint(x, y, label) {
  return {
    x: checkedCoordinate(x, `${label} X`),
    y: checkedCoordinate(y, `${label} Y`),
  };
}

function sampleArc(entity) {
  assertPlanarEntity(entity, [30]);
  const center = checkedPoint(
    finiteNumber(entity, 10, "圆心 X"),
    finiteNumber(entity, 20, "圆心 Y"),
    "圆心"
  );
  const radius = finiteNumber(entity, 40, "半径");
  if (!(radius > 0) || radius > LIMITS.maxRadius) {
    throw new Error("ARC 半径无效或超出允许范围");
  }

  const startDegrees = finiteNumber(entity, 50, "起始角");
  const endDegrees = finiteNumber(entity, 51, "结束角");
  let sweepDegrees = (endDegrees - startDegrees) % 360;
  if (sweepDegrees < 0) sweepDegrees += 360;
  if (!(sweepDegrees > 1e-8) || sweepDegrees >= 360 - 1e-8) {
    throw new Error("ARC 扫掠角无效；完整圆必须拒绝导入");
  }

  const start = startDegrees * Math.PI / 180;
  const sweep = sweepDegrees * Math.PI / 180;
  const steps = Math.max(6, Math.ceil(sweep * radius / 2.5));
  if (steps > LIMITS.maxArcSamples) {
    throw new Error("ARC 采样点过多，已拒绝导入");
  }

  const points = new Array(steps + 1);
  for (let index = 0; index <= steps; index += 1) {
    const angle = start + sweep * index / steps;
    points[index] = checkedPoint(
      center.x + Math.cos(angle) * radius,
      center.y + Math.sin(angle) * radius,
      "ARC"
    );
  }
  return points;
}

function entitySegment(entity) {
  if (entity.type === "LINE") {
    assertPlanarEntity(entity, [30, 31]);
    const start = checkedPoint(
      finiteNumber(entity, 10, "起点 X"),
      finiteNumber(entity, 20, "起点 Y"),
      "LINE 起点"
    );
    const end = checkedPoint(
      finiteNumber(entity, 11, "终点 X"),
      finiteNumber(entity, 21, "终点 Y"),
      "LINE 终点"
    );
    if (distance(start, end) <= 1e-9) throw new Error("DXF 包含零长度 LINE");
    return { points: [start, end] };
  }
  return { points: sampleArc(entity) };
}

function coordinateSpan(segments) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const segment of segments) {
    for (const point of segment.points) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }
  return Math.max(maxX - minX, maxY - minY, 1);
}

function bucketCoordinates(point, tolerance) {
  return [Math.floor(point.x / tolerance), Math.floor(point.y / tolerance)];
}

function bucketKey(x, y) {
  return `${x}:${y}`;
}

function chainContours(segments) {
  if (segments.length > LIMITS.maxSegments) throw new Error("DXF 线段数量过多");
  const tolerance = Math.min(0.1, Math.max(0.005, coordinateSpan(segments) * 0.00005));
  const endpointBuckets = new Map();

  const addEndpoint = (point, segmentIndex, atEnd) => {
    const [x, y] = bucketCoordinates(point, tolerance);
    const key = bucketKey(x, y);
    const references = endpointBuckets.get(key) ?? [];
    references.push({ segmentIndex, atEnd });
    endpointBuckets.set(key, references);
  };

  for (let index = 0; index < segments.length; index += 1) {
    const points = segments[index].points;
    addEndpoint(points[0], index, false);
    addEndpoint(points[points.length - 1], index, true);
  }

  const unused = new Set();
  for (let index = 0; index < segments.length; index += 1) unused.add(index);
  const contours = [];
  let totalContourPoints = 0;

  while (unused.size) {
    const firstIndex = unused.values().next().value;
    unused.delete(firstIndex);
    const points = segments[firstIndex].points.slice();
    let closed = false;

    while (unused.size) {
      const tail = points[points.length - 1];
      if (points.length >= 3 && distance(points[0], tail) <= tolerance) {
        points.pop();
        closed = true;
        break;
      }

      const [bucketX, bucketY] = bucketCoordinates(tail, tolerance);
      const matches = new Map();
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const references = endpointBuckets.get(bucketKey(bucketX + dx, bucketY + dy)) ?? [];
          for (const reference of references) {
            if (!unused.has(reference.segmentIndex)) continue;
            const candidatePoints = segments[reference.segmentIndex].points;
            const endpoint = reference.atEnd ? candidatePoints[candidatePoints.length - 1] : candidatePoints[0];
            const gap = distance(tail, endpoint);
            if (gap > tolerance) continue;
            const previous = matches.get(reference.segmentIndex);
            if (!previous || gap < previous.gap) matches.set(reference.segmentIndex, { ...reference, gap });
          }
        }
      }

      if (matches.size === 0) break;
      if (matches.size > 1) throw new Error("DXF 端点拓扑存在歧义，无法确定唯一轮廓");
      const match = matches.values().next().value;
      unused.delete(match.segmentIndex);
      const next = segments[match.segmentIndex].points;
      if (match.atEnd) {
        for (let index = next.length - 2; index >= 0; index -= 1) points.push(next[index]);
      } else {
        for (let index = 1; index < next.length; index += 1) points.push(next[index]);
      }
      if (points.length > LIMITS.maxPoints) throw new Error("DXF 轮廓点数过多");
    }

    if (!closed && points.length >= 3 && distance(points[0], points[points.length - 1]) <= tolerance) {
      points.pop();
      closed = true;
    }
    totalContourPoints += points.length;
    if (totalContourPoints > LIMITS.maxPoints) throw new Error("DXF 总轮廓点数过多");
    contours.push({ points, closed });
  }
  return contours;
}

function polygonArea(points) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += point.x * next.y - next.x * point.y;
  }
  return twiceArea / 2;
}

function contourSpan(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return Math.max(maxX - minX, maxY - minY, 1);
}

function cross(left, middle, right) {
  return (middle.x - left.x) * (right.y - left.y) - (middle.y - left.y) * (right.x - left.x);
}

function pointOnSegment(point, start, end, epsilon) {
  return point.x >= Math.min(start.x, end.x) - epsilon
    && point.x <= Math.max(start.x, end.x) + epsilon
    && point.y >= Math.min(start.y, end.y) - epsilon
    && point.y <= Math.max(start.y, end.y) + epsilon;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd, epsilon) {
  const a = cross(firstStart, firstEnd, secondStart);
  const b = cross(firstStart, firstEnd, secondEnd);
  const c = cross(secondStart, secondEnd, firstStart);
  const d = cross(secondStart, secondEnd, firstEnd);
  if (((a > epsilon && b < -epsilon) || (a < -epsilon && b > epsilon))
    && ((c > epsilon && d < -epsilon) || (c < -epsilon && d > epsilon))) return true;
  if (Math.abs(a) <= epsilon && pointOnSegment(secondStart, firstStart, firstEnd, epsilon)) return true;
  if (Math.abs(b) <= epsilon && pointOnSegment(secondEnd, firstStart, firstEnd, epsilon)) return true;
  if (Math.abs(c) <= epsilon && pointOnSegment(firstStart, secondStart, secondEnd, epsilon)) return true;
  if (Math.abs(d) <= epsilon && pointOnSegment(firstEnd, secondStart, secondEnd, epsilon)) return true;
  return false;
}

function assertSimpleContour(points) {
  const span = contourSpan(points);
  const epsilon = Math.max(1e-9, span * span * 1e-11);
  const edges = new Array(points.length);
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    edges[index] = {
      index,
      start,
      end,
      minX: Math.min(start.x, end.x),
      maxX: Math.max(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxY: Math.max(start.y, end.y),
    };
  }
  edges.sort((left, right) => left.minX - right.minX || left.minY - right.minY);

  const active = [];
  let checks = 0;
  for (const edge of edges) {
    let writeIndex = 0;
    for (let index = 0; index < active.length; index += 1) {
      const candidate = active[index];
      checks += 1;
      if (checks > LIMITS.maxIntersectionChecks) {
        throw new Error("DXF 轮廓过于复杂，无法安全完成自交校验");
      }
      if (candidate.maxX + epsilon < edge.minX) continue;
      active[writeIndex] = candidate;
      writeIndex += 1;
      const adjacent = Math.abs(candidate.index - edge.index) === 1
        || (candidate.index === 0 && edge.index === points.length - 1)
        || (edge.index === 0 && candidate.index === points.length - 1);
      if (adjacent) continue;
      if (candidate.maxY + epsilon < edge.minY || edge.maxY + epsilon < candidate.minY) continue;
      if (segmentsIntersect(candidate.start, candidate.end, edge.start, edge.end, epsilon)) {
        throw new Error("DXF 主轮廓存在自交，已拒绝导入");
      }
    }
    active.length = writeIndex;
    active.push(edge);
  }
}

function parseEntitiesAndUnits(text) {
  if (typeof text !== "string" || text.length === 0) throw new Error("DXF 文件为空");
  if (text.length > LIMITS.maxDxfBytes) throw new Error("DXF 文件超过允许大小");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > LIMITS.maxPairs * 2 + 1) throw new Error("DXF 组码数量过多");
  if (lines.length % 2 === 1 && lines[lines.length - 1].trim() !== "") {
    throw new Error("DXF 组码结构不完整");
  }

  let section = null;
  let awaitingSectionName = false;
  let current = null;
  let headerVariable = null;
  let units = null;
  let pairCount = 0;
  const entities = [];

  const flushEntity = () => {
    if (!current) return;
    entities.push(current);
    if (entities.length > LIMITS.maxEntities) throw new Error("DXF 实体数量过多");
    current = null;
  };

  for (let index = 0; index + 1 < lines.length; index += 2) {
    pairCount += 1;
    if (pairCount > LIMITS.maxPairs) throw new Error("DXF 组码数量过多");
    const rawCode = lines[index].trim();
    const code = Number(rawCode);
    const value = lines[index + 1].trim();
    if (!Number.isInteger(code)) throw new Error(`DXF 含无效组码：${rawCode || "空"}`);
    const upperValue = value.toUpperCase();

    if (code === 0) {
      if (section === "ENTITIES") flushEntity();
      if (upperValue === "SECTION") {
        section = null;
        awaitingSectionName = true;
      } else if (upperValue === "ENDSEC") {
        section = null;
        awaitingSectionName = false;
      } else if (upperValue === "EOF") {
        section = null;
      } else if (section === "ENTITIES") {
        // Skip unsupported entities like INSERT, DIMENSION, MTEXT
        if (!SUPPORTED_ENTITIES.has(upperValue)) {
          current = null;
        } else {
          current = { type: upperValue, values: new Map() };
        }
        continue;
      }
    }

    if (awaitingSectionName && upperValue !== "SECTION") {
      if (code !== 2) throw new Error("DXF SECTION 缺少名称");
      section = upperValue;
      awaitingSectionName = false;
      continue;
    }

    if (section === "HEADER") {
      if (code === 9) {
        headerVariable = upperValue;
      } else if (headerVariable === "$INSUNITS" && code === 70) {
        const parsedUnits = Number(value);
        if (!Number.isInteger(parsedUnits)) throw new Error("DXF $INSUNITS 无效");
        if (units !== null && units !== parsedUnits) throw new Error("DXF 包含冲突的 $INSUNITS");
        units = parsedUnits;
        headerVariable = null;
      }
    } else if (section === "ENTITIES" && current) {
      const values = current.values.get(code) ?? [];
      if (values.length >= 64) throw new Error(`${current.type} 的组码数据过多`);
      values.push(value);
      current.values.set(code, values);
    }
  }
  if (section === "ENTITIES") flushEntity();
  // Default to millimeters if $INSUNITS is not set
  if (units === null) units = 4;
  if (units !== 4) {
    throw new Error(`DXF 单位代码为 ${units}；仅接受毫米制`);
  }
  if (entities.length === 0) throw new Error("DXF ENTITIES 中没有 LINE/ARC 实体");
  return { entities, units };
}

export function parseDxfContour(text, options = {}) {
  const { entities, units } = parseEntitiesAndUnits(text);
  const segments = entities.map(entitySegment);
  let sampledPoints = 0;
  for (const segment of segments) {
    sampledPoints += segment.points.length;
    if (sampledPoints > LIMITS.maxPoints) throw new Error("DXF 采样点数过多");
  }

  const contours = chainContours(segments);
  const closedContours = [];
  for (const contour of contours) {
    if (!contour.closed || contour.points.length < 3) continue;
    assertSimpleContour(contour.points);
    const area = Math.abs(polygonArea(contour.points));
    const span = contourSpan(contour.points);
    if (!(area > Math.max(1e-7, span * span * 1e-10))) {
      throw new Error("DXF 主轮廓面积为零或过小");
    }
    closedContours.push({ ...contour, area });
  }
  closedContours.sort((left, right) => right.area - left.area || right.points.length - left.points.length);
  const contour = closedContours[0];
  if (!contour) throw new Error("DXF 中未找到可用的二维闭合轮廓");
  if (closedContours[1] && closedContours[1].area >= contour.area * LARGE_CONTOUR_AREA_RATIO) {
    throw new Error("DXF 包含多个大型闭合轮廓，无法确定唯一主轮廓");
  }

  return {
    points: contour.points,
    closed: true,
    units,
    entryName: options.entryName ?? null,
    contourCount: contours.length,
    closedContourCount: closedContours.length,
    entityCount: entities.length,
    segmentCount: segments.length,
  };
}

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

function crc32(bytes) {
  const table = getCrcTable();
  let value = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) value = table[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function checkedRange(start, length, limit, label) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start > limit - length) {
    throw new Error(`ZIP ${label} 越界`);
  }
  return start + length;
}

function decodeZipName(bytes, utf8) {
  try {
    return new TextDecoder(utf8 ? "utf-8" : "windows-1252", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("ZIP 文件名编码无效");
  }
}

function safeZipName(name) {
  return name.length > 0
    && !name.includes("\0")
    && !name.startsWith("/")
    && !name.startsWith("\\")
    && !/^[A-Za-z]:/.test(name)
    && !name.split(/[\\/]/).includes("..");
}

async function inflateRaw(payload, expectedSize) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前浏览器不能解压 DXF ZIP，请先解压后导入 .DXF 文件");
  }
  let stream;
  try {
    stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  } catch {
    throw new Error("当前浏览器不能解压 DXF ZIP，请先解压后导入 .DXF 文件");
  }
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS.maxDxfBytes || total > expectedSize) {
        await reader.cancel();
        throw new Error("ZIP 解压数据超过声明或允许大小");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ZIP 解压数据")) throw error;
    throw new Error("ZIP 中的 DXF 压缩数据已损坏");
  }
  if (total !== expectedSize) throw new Error("ZIP 解压大小与中央目录不一致");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function findEndOfCentralDirectory(bytes, view) {
  const minimumOffset = Math.max(0, bytes.length - 22 - 65_535);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  throw new Error("ZIP 缺少有效的中央目录尾记录");
}

function readCentralDirectory(bytes, view) {
  const eocdOffset = findEndOfCentralDirectory(bytes, view);
  const disk = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw new Error("不支持分卷 ZIP");
  if (totalEntries === 0 || totalEntries > LIMITS.maxZipEntries) throw new Error("ZIP 条目数量无效或过多");
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff || totalEntries === 0xffff) throw new Error("不支持 ZIP64");
  const centralEnd = checkedRange(centralOffset, centralSize, eocdOffset, "中央目录");

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    checkedRange(offset, 46, centralEnd, "中央目录条目");
    if (view.getUint32(offset, true) !== ZIP_CENTRAL_HEADER) throw new Error("ZIP 中央目录签名无效");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const checksum = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const startDisk = view.getUint16(offset + 34, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (nameLength === 0 || nameLength > LIMITS.maxZipNameBytes) throw new Error("ZIP 文件名长度无效");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("不支持 ZIP64 条目");
    if (startDisk !== 0) throw new Error("不支持分卷 ZIP 条目");
    const entryEnd = checkedRange(offset, 46 + nameLength + extraLength + commentLength, centralEnd, "中央目录条目");
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeZipName(nameBytes, (flags & 0x0800) !== 0);
    if (!safeZipName(name)) throw new Error("ZIP 包含不安全的文件路径");
    entries.push({ flags, method, checksum, compressedSize, uncompressedSize, name, nameBytes, localOffset });
    offset = entryEnd;
  }
  if (offset !== centralEnd) throw new Error("ZIP 中央目录长度不一致");
  return { entries, centralOffset };
}

function assertDataDescriptor(bytes, view, offset, entry, centralOffset) {
  let cursor = offset;
  checkedRange(cursor, 4, centralOffset, "数据描述符");
  if (view.getUint32(cursor, true) === ZIP_DATA_DESCRIPTOR) cursor += 4;
  checkedRange(cursor, 12, centralOffset, "数据描述符");
  const checksum = view.getUint32(cursor, true);
  const compressedSize = view.getUint32(cursor + 4, true);
  const uncompressedSize = view.getUint32(cursor + 8, true);
  if (checksum !== entry.checksum || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize) {
    throw new Error("ZIP 数据描述符与中央目录不一致");
  }
}

async function unzipDxf(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { entries, centralOffset } = readCentralDirectory(bytes, view);
  const candidates = entries.filter((entry) => /\.dxf$/i.test(entry.name) && !/^__MACOSX[\\/]/i.test(entry.name));
  if (candidates.length === 0) throw new Error("ZIP 中没有找到 DXF 文件");
  if (candidates.length > 1) throw new Error("ZIP 中包含多个 DXF 文件，无法确定要导入的图纸");
  const entry = candidates[0];
  if ((entry.flags & 1) !== 0) throw new Error("不支持加密 ZIP");
  if (entry.method !== 0 && entry.method !== 8) throw new Error("ZIP 使用了不支持的压缩方法");
  if (entry.uncompressedSize === 0 || entry.uncompressedSize > LIMITS.maxDxfBytes) throw new Error("ZIP 中 DXF 的声明大小无效或过大");
  if (entry.compressedSize > LIMITS.maxUploadBytes) throw new Error("ZIP 中 DXF 的压缩数据过大");
  if (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize) throw new Error("ZIP 存储条目的大小不一致");

  checkedRange(entry.localOffset, 30, centralOffset, "本地文件头");
  if (view.getUint32(entry.localOffset, true) !== ZIP_LOCAL_HEADER) throw new Error("ZIP 本地文件头签名无效");
  const localFlags = view.getUint16(entry.localOffset + 6, true);
  const localMethod = view.getUint16(entry.localOffset + 8, true);
  const localChecksum = view.getUint32(entry.localOffset + 14, true);
  const localCompressedSize = view.getUint32(entry.localOffset + 18, true);
  const localUncompressedSize = view.getUint32(entry.localOffset + 22, true);
  const localNameLength = view.getUint16(entry.localOffset + 26, true);
  const localExtraLength = view.getUint16(entry.localOffset + 28, true);
  if (localFlags !== entry.flags || localMethod !== entry.method) throw new Error("ZIP 本地文件头与中央目录不一致");
  if (localNameLength !== entry.nameBytes.length) throw new Error("ZIP 本地文件名与中央目录不一致");
  const dataStart = checkedRange(entry.localOffset, 30 + localNameLength + localExtraLength, centralOffset, "本地文件头");
  const localName = bytes.subarray(entry.localOffset + 30, entry.localOffset + 30 + localNameLength);
  for (let index = 0; index < localName.length; index += 1) {
    if (localName[index] !== entry.nameBytes[index]) throw new Error("ZIP 本地文件名与中央目录不一致");
  }
  const dataEnd = checkedRange(dataStart, entry.compressedSize, centralOffset, "压缩数据");
  if ((entry.flags & 8) !== 0) {
    assertDataDescriptor(bytes, view, dataEnd, entry, centralOffset);
  } else if (localChecksum !== entry.checksum || localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize) {
    throw new Error("ZIP 本地文件头的 CRC 或大小与中央目录不一致");
  }

  const payload = bytes.subarray(dataStart, dataEnd);
  const result = entry.method === 0 ? payload.slice() : await inflateRaw(payload, entry.uncompressedSize);
  if (result.byteLength !== entry.uncompressedSize) throw new Error("ZIP 解压大小与中央目录不一致");
  if (crc32(result) !== entry.checksum) throw new Error("ZIP 中 DXF 的 CRC32 校验失败");
  return { bytes: result, entryName: entry.name };
}

function decodeDxf(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("DXF 不是有效的 UTF-8/ASCII 文本文件");
  }
}

export async function readDxfFile(file) {
  if (!file || typeof file.arrayBuffer !== "function") throw new Error("请选择有效的 DXF 或 ZIP 文件");
  const fileName = String(file.name ?? "");
  const isZip = /\.zip$/i.test(fileName);
  if (!isZip && !/\.dxf$/i.test(fileName)) throw new Error("仅支持 .DXF 或 .ZIP 文件");
  if (Number.isFinite(file.size) && (file.size <= 0 || file.size > LIMITS.maxUploadBytes)) {
    throw new Error("上传文件为空或超过 8 MB 限制");
  }
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > LIMITS.maxUploadBytes) throw new Error("上传文件为空或超过 8 MB 限制");
  const extracted = isZip
    ? await unzipDxf(buffer)
    : { bytes: new Uint8Array(buffer), entryName: fileName.split(/[\\/]/).pop() || "drawing.dxf" };
  if (extracted.bytes.byteLength > LIMITS.maxDxfBytes) throw new Error("DXF 文件超过 4 MB 限制");
  return parseDxfContour(decodeDxf(extracted.bytes), { entryName: extracted.entryName });
}

export function normalizePunchContour(points) {
  if (!Array.isArray(points) || points.length < 3 || points.length > LIMITS.maxPoints) {
    throw new Error("上模轮廓点数无效");
  }
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw new Error("上模轮廓包含无效坐标");
    checkedCoordinate(point.x, "上模轮廓 X");
    checkedCoordinate(point.y, "上模轮廓 Y");
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  const height = maxY - minY;
  if (!(height > 1e-9)) throw new Error("上模轮廓高度无效");
  const band = Math.max(0.5, height * 0.04);
  let minBandMinX = Infinity;
  let minBandMaxX = -Infinity;
  let maxBandMinX = Infinity;
  let maxBandMaxX = -Infinity;
  for (const point of points) {
    if (point.y <= minY + band) {
      if (point.x < minBandMinX) minBandMinX = point.x;
      if (point.x > minBandMaxX) minBandMaxX = point.x;
    }
    if (point.y >= maxY - band) {
      if (point.x < maxBandMinX) maxBandMinX = point.x;
      if (point.x > maxBandMaxX) maxBandMaxX = point.x;
    }
  }
  const tipAtMin = minBandMaxX - minBandMinX <= maxBandMaxX - maxBandMinX;
  const centerX = tipAtMin ? (minBandMinX + minBandMaxX) / 2 : (maxBandMinX + maxBandMaxX) / 2;
  return points.map((point) => ({
    x: point.x - centerX,
    y: tipAtMin ? minY - point.y : point.y - maxY,
  }));
}

// Generate a minimal valid DXF file from an array of points
export function generateDxfFile(points, entryName = "drawing.dxf") {
  const header = [
    "0", "SECTION",
    "2", "HEADER",
    "9", "$INSUNITS",
    "70", "4",
    "0", "ENDSEC",
    "0", "SECTION",
    "2", "ENTITIES",
  ];

  const lines = [];
  for (const p of points) {
    lines.push(
      "0", "LINE",
      "8", "0",
      "10", formatCoord(p.x), "20", formatCoord(p.y), "30", "0",
      "11", formatCoord(p.x), "21", formatCoord(p.y), "31", "0",
    );
  }

  const footer = [
    "0", "ENDSEC",
    "0", "EOF",
  ];

  const allLines = [...header, ...lines, ...footer];
  const text = allLines.join("\n");
  return new Blob([text], { type: "application/dxf" });
}

function formatCoord(value) {
  return Number.isFinite(value) ? value.toFixed(6) : "0.000000";
}

// Generate a minimal valid DXF file from an array of points
// Generate a minimal valid DXF file from an array of points
