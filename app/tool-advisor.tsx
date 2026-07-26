"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ToolLibrary } from "./tool-library";
import { findCtgTool, CTG_SYSTEMS, CTG_TOOLS, type CtgToolRecord } from "./ctg-tool-catalog";
import { generateDxfFile, parseDxfContour, normalizePunchContour } from "./dxf-parser.js";
import dxfArticles from "./dxf-articles.json";
type MaterialKey = "dc01" | "ss304" | "al5052" | "hss";
type CanvasMode = "formed" | "flat";
type PressStage = "open" | "pressed" | "flat";
type PunchProfileId = "gp28" | "dg30" | "sp88";
type DieProfileId = "sd85" | "sl85" | "hd85";

type Point = { x: number; y: number };
type BendDirection = -1 | 1;
type ProfileMeta = {
  bendRadii: number[];
  bendDirections: BendDirection[];
  startAngle: number;
};
type ProfileDefinition = ProfileMeta & {
  flanges: number[];
  bendAngles: number[];
};
type RoundedCorner = {
  incoming: Point;
  outgoing: Point;
  center: Point;
  radius: number;
  startAngle: number;
  sweep: number;
};

type CustomerInfo = {
  company: string;
  contact: string;
  phone: string;
  email: string;
  address: string;
  note: string;
};

type QuoteToolDetail = {
  role: "上模" | "下模";
  articleNumber: string;
  name: string;
  system: string;
  angle: string;
  totalLength: number;
  segments: number[];
  source: string;
  specification: string;
  capacity: string;
  contour: Point[];
  color: string;
};

type QuotePdfData = {
  quoteNo: string;
  createdAt: Date;
  customer: CustomerInfo;
  projectName: string;
  material: string;
  thickness: number;
  bendLength: number;
  bendSequence: string;
  estimatedForce: number;
  punch: QuoteToolDetail;
  die: QuoteToolDetail;
  validation: string[];
  delivery: string;
};

const LENGTH_SEGMENTS: Record<string, number[]> = {
  "515": [515],
  "835": [100, 215, 85, 215, 220],
  "1030": [515, 515],
};

const EMPTY_CUSTOMER: CustomerInfo = {
  company: "",
  contact: "",
  phone: "",
  email: "",
  address: "",
  note: "",
};

const DXF_GEOMETRY_STORAGE_KEY = "bendpilot-dxf-geometries";
const DXF_GEOMETRY_SCHEMA_VERSION = 3;
const DXF_GEOMETRY_PARSER_VERSION = "ukb-ascii-dxf/2";
const MAX_STORED_DXF_GEOMETRIES = 24;
const MAX_DXF_POINTS = 600;
const MAX_DXF_COORDINATE = 5000;
const DXF_DIR = "/dxf";
const MAX_DXF_BATCH = 50;

type StoredDxfGeometries = {
  schemaVersion: number;
  parserVersion: string;
  geometries: Record<string, {
    points: Point[];
    source: "user-confirmed-ukb-download";
    validatedAt: string;
  }>;
};

function contourCross(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnContourSegment(point: Point, start: Point, end: Point, epsilon: number) {
  return point.x >= Math.min(start.x, end.x) - epsilon
    && point.x <= Math.max(start.x, end.x) + epsilon
    && point.y >= Math.min(start.y, end.y) - epsilon
    && point.y <= Math.max(start.y, end.y) + epsilon;
}

function contourSegmentsIntersect(a: Point, b: Point, c: Point, d: Point, epsilon: number) {
  const abC = contourCross(a, b, c);
  const abD = contourCross(a, b, d);
  const cdA = contourCross(c, d, a);
  const cdB = contourCross(c, d, b);
  if (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon))
    && ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))) return true;
  return (Math.abs(abC) <= epsilon && pointOnContourSegment(c, a, b, epsilon))
    || (Math.abs(abD) <= epsilon && pointOnContourSegment(d, a, b, epsilon))
    || (Math.abs(cdA) <= epsilon && pointOnContourSegment(a, c, d, epsilon))
    || (Math.abs(cdB) <= epsilon && pointOnContourSegment(b, c, d, epsilon));
}

function structurallyValidContour(points: Point[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    if (Math.hypot(point.x - next.x, point.y - next.y) < 1e-7) return false;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    twiceArea += point.x * next.y - next.x * point.y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (width < 1 || height < 1 || width > 1000 || height > 1000 || Math.abs(twiceArea) < 1e-5) return false;
  const epsilon = Math.max(1e-9, Math.max(width, height) ** 2 * 1e-11);
  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length;
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length;
      if (second === firstNext || secondNext === first) continue;
      if (contourSegmentsIntersect(points[first], points[firstNext], points[second], points[secondNext], epsilon)) return false;
    }
  }
  return true;
}

function sanitizeDxfGeometry(value: unknown): Point[] | null {
  if (!Array.isArray(value) || value.length < 3 || value.length > MAX_DXF_POINTS) return null;
  const points: Point[] = [];
  for (const point of value) {
    if (!point || typeof point !== "object") return null;
    const x = (point as { x?: unknown }).x;
    const y = (point as { y?: unknown }).y;
    if (
      typeof x !== "number"
      || typeof y !== "number"
      || !Number.isFinite(x)
      || !Number.isFinite(y)
      || Math.abs(x) > MAX_DXF_COORDINATE
      || Math.abs(y) > MAX_DXF_COORDINATE
    ) {
      return null;
    }
    points.push({ x, y });
  }
  return structurallyValidContour(points) ? points : null;
}

function boundedDxfGeometries(value: unknown): Record<string, Point[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawEntries = Object.entries(value);
  if (rawEntries.length > MAX_STORED_DXF_GEOMETRIES) return null;
  const entries: Array<[string, Point[]]> = [];
  for (const [articleNumber, rawGeometry] of rawEntries) {
    if (!articleNumber.trim() || articleNumber.length > 80) return null;
    if (!rawGeometry || typeof rawGeometry !== "object" || Array.isArray(rawGeometry)) return null;
    const stored = rawGeometry as { points?: unknown; source?: unknown; validatedAt?: unknown };
    if (stored.source !== "user-confirmed-ukb-download" || typeof stored.validatedAt !== "string") return null;
    const points = sanitizeDxfGeometry(stored.points);
    if (!points) return null;
    entries.push([articleNumber, points]);
  }
  return Object.fromEntries(entries);
}

function parseStoredDxfGeometries(value: unknown): Record<string, Point[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = value as Partial<StoredDxfGeometries>;
  if (
    stored.schemaVersion !== DXF_GEOMETRY_SCHEMA_VERSION
    || stored.parserVersion !== DXF_GEOMETRY_PARSER_VERSION
  ) {
    return null;
  }
  return boundedDxfGeometries(stored.geometries);
}

function withStoredDxfGeometry(
  current: Record<string, Point[]>,
  articleNumber: string,
  points: Point[]
) {
  const kept = Object.entries(current)
    .filter(([article]) => article !== articleNumber)
    .slice(-(MAX_STORED_DXF_GEOMETRIES - 1));
  return Object.fromEntries([...kept, [articleNumber, points]]);
}

function persistDxfGeometries(geometries: Record<string, Point[]>) {
  const payload: StoredDxfGeometries = {
    schemaVersion: DXF_GEOMETRY_SCHEMA_VERSION,
    parserVersion: DXF_GEOMETRY_PARSER_VERSION,
    geometries: Object.fromEntries(Object.entries(geometries).map(([articleNumber, points]) => [
      articleNumber,
      {
        points,
        source: "user-confirmed-ukb-download" as const,
        validatedAt: new Date().toISOString(),
      },
    ])),
  };
  try {
    window.localStorage.setItem(DXF_GEOMETRY_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}


// --- Profile definition from hand-drawn points ---

function maximumBendRadius(flanges: number[], bendAngles: number[], index: number) {
  const adjacentLength = Math.min(flanges[index] ?? 0, flanges[index + 1] ?? 0);
  const includedAngle = clamp(bendAngles[index] ?? 90, 20, 170) * (Math.PI / 180);
  return Math.max(0.2, Math.min(50, adjacentLength * 0.44 * Math.tan(includedAngle / 2)));
}

function definitionFromPoints(points: Point[], radii: number[]): ProfileDefinition | null {
  if (points.length < 2) return null;
  const flanges: number[] = [];
  const directions: number[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const length = Math.hypot(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
    if (!Number.isFinite(length) || length < 10) return null;
    flanges.push(Math.round(length * 10) / 10);
    directions.push((Math.atan2(points[index + 1].y - points[index].y, points[index + 1].x - points[index].x) * 180) / Math.PI);
  }
  const bendAngles: number[] = [];
  const bendDirections: BendDirection[] = [];
  for (let index = 0; index < directions.length - 1; index += 1) {
    const delta = normalizeDegrees(directions[index + 1] - directions[index]);
    const includedAngle = 180 - Math.abs(delta);
    // Removed angle constraint
    bendAngles.push(Math.round(includedAngle * 10) / 10);
    bendDirections.push(delta < 0 ? -1 : 1);
  }
  return {
    flanges,
    bendAngles,
    bendRadii: bendAngles.map((_, index) => clamp(
      radii[index] ?? 1,
      0.2,
      maximumBendRadius(flanges, bendAngles, index)
    )),
    bendDirections,
    startAngle: Math.round(directions[0] * 10) / 10,
  };
}

function validProfileDefinition(profile: ProfileDefinition) {
  const bendCount = Math.max(0, profile.flanges.length - 1);
  return profile.flanges.length >= 2
    && profile.bendAngles.length === bendCount
    && profile.bendRadii.length === bendCount
    && profile.bendDirections.length === bendCount
    && Number.isFinite(profile.startAngle)
    && profile.flanges.every((value) => Number.isFinite(value) && value >= 10)
    && profile.bendAngles.every((value) => Number.isFinite(value) && value >= 20)
    && profile.bendRadii.every((value, index) => Number.isFinite(value)
      && value >= 0.2
      && value <= maximumBendRadius(profile.flanges, profile.bendAngles, index) + 0.001)
    && profile.bendDirections.every((value) => value === -1 || value === 1);
}

function roundedCorners(points: Point[], radii: number[]) {
  return points.slice(1, -1).map((corner, index): RoundedCorner | null => {
    const previous = points[index];
    const next = points[index + 2];
    const incomingLength = Math.hypot(previous.x - corner.x, previous.y - corner.y);
    const outgoingLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    if (incomingLength < 0.001 || outgoingLength < 0.001) return null;
    const incomingUnit = {
      x: (previous.x - corner.x) / incomingLength,
      y: (previous.y - corner.y) / incomingLength,
    };
    const outgoingUnit = {
      x: (next.x - corner.x) / outgoingLength,
      y: (next.y - corner.y) / outgoingLength,
    };
    const dot = clamp(incomingUnit.x * outgoingUnit.x + incomingUnit.y * outgoingUnit.y, -1, 1);
    const includedAngle = Math.acos(dot);
    if (includedAngle < 0.01 || Math.PI - includedAngle < 0.01) return null;
    const requestedRadius = Math.max(0, radii[index] ?? 0);
    if (requestedRadius < 0.01) return null;
    const tangentForRadius = requestedRadius / Math.tan(includedAngle / 2);
    const tangentDistance = Math.min(tangentForRadius, incomingLength * 0.44, outgoingLength * 0.44);
    const effectiveRadius = tangentDistance * Math.tan(includedAngle / 2);
    if (!Number.isFinite(effectiveRadius) || effectiveRadius < 0.01) return null;
    const bisector = {
      x: incomingUnit.x + outgoingUnit.x,
      y: incomingUnit.y + outgoingUnit.y,
    };
    const bisectorLength = Math.hypot(bisector.x, bisector.y);
    if (bisectorLength < 0.001) return null;
    const centerDistance = effectiveRadius / Math.sin(includedAngle / 2);
    const center = {
      x: corner.x + (bisector.x / bisectorLength) * centerDistance,
      y: corner.y + (bisector.y / bisectorLength) * centerDistance,
    };
    const incoming = {
      x: corner.x + incomingUnit.x * tangentDistance,
      y: corner.y + incomingUnit.y * tangentDistance,
    };
    const outgoing = {
      x: corner.x + outgoingUnit.x * tangentDistance,
      y: corner.y + outgoingUnit.y * tangentDistance,
    };
    const startAngle = Math.atan2(incoming.y - center.y, incoming.x - center.x);
    const endAngle = Math.atan2(outgoing.y - center.y, outgoing.x - center.x);
    let sweep = endAngle - startAngle;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    return { incoming, outgoing, center, radius: effectiveRadius, startAngle, sweep };
  });
}

function sampleRoundedPolyline(points: Point[], radii: number[], samplesPerArc = 8) {
  if (points.length < 3 || radii.every((radius) => radius <= 0)) return points;
  const corners = roundedCorners(points, radii);
  const sampled: Point[] = [points[0]];
  corners.forEach((corner, index) => {
    if (!corner) {
      sampled.push(points[index + 1]);
      return;
    }
    sampled.push(corner.incoming);
    for (let step = 1; step <= samplesPerArc; step += 1) {
      const angle = corner.startAngle + corner.sweep * (step / samplesPerArc);
      sampled.push({
        x: corner.center.x + Math.cos(angle) * corner.radius,
        y: corner.center.y + Math.sin(angle) * corner.radius,
      });
    }
  });
  sampled.push(points[points.length - 1]);
  return sampled;
}

function ukbSystemsCompatible(left?: CtgToolRecord, right?: CtgToolRecord) {
  if (!left || !right || left.system === "Other" || right.system === "Other") return true;
  return left.system === right.system;
}

function ukbDieVOpening(tool?: CtgToolRecord) {
  return typeof tool?.vOpeningMm === "number"
    && Number.isFinite(tool.vOpeningMm)
    && tool.vOpeningMm > 0
    ? tool.vOpeningMm
    : null;
}

type PunchProfile = {
  id: string;
  label: string;
  kind: "gooseneck" | "deep-gooseneck" | "straight";
  throat: number;
  height: number;
  tipRadius: number;
  polygon: Point[];
};

type DieProfile = {
  id: string;
  label: string;
  halfWidth: number;
  bottomHalfWidth: number;
  height: number;
  includedAngle: number;
  polygon?: Point[];
};

type PunchProfileInput = PunchProfileId | PunchProfile;
type DieProfileInput = DieProfileId | DieProfile;

type CustomPunch = {
  throat: number;
  height: number;
  body: number;
  tipRadius: number;
};

type Material = {
  name: string;
  short: string;
  tensile: number;
  radiusRatio: number;
  vMultiplier: number;
  springback: number;
};

type Solution = {
  id: string;
  name: string;
  punchArticle?: string;
  dieArticle?: string;
  punchProfile: PunchProfileInput;
  dieProfile: DieProfileInput;
  punch: string;
  die: string;
  throat: number;
  height: number;
  capacity: number;
  score: number;
  price: number;
  owned: boolean;
  collision: boolean;
  collisionSteps: number;
  tags: string[];
  source?: "built-in" | "ukb-library";
};

type SequenceEvaluation = {
  sequence: number[];
  flips: boolean[];
  collisionByPosition: boolean[];
  contactCountByPosition: number[];
  collidingSamplesByPosition: number[];
  collisionSteps: number;
  totalContacts: number;
  totalCollidingSamples: number;
  orderPenalty: number;
  /** For each position, the angle used during evaluation (may be an intermediate angle like 135° if target is 90°). */
  intermediateAngles: number[];
};

const MATERIALS: Record<MaterialKey, Material> = {
  dc01: {
    name: "DC01 低碳钢",
    short: "低碳钢",
    tensile: 450,
    radiusRatio: 0.16,
    vMultiplier: 1,
    springback: 2,
  },
  ss304: {
    name: "SUS304 不锈钢",
    short: "不锈钢",
    tensile: 700,
    radiusRatio: 0.2,
    vMultiplier: 1.15,
    springback: 4,
  },
  al5052: {
    name: "5052-H32 铝合金",
    short: "铝合金",
    tensile: 260,
    radiusRatio: 0.12,
    vMultiplier: 1,
    springback: 3,
  },
  hss: {
    name: "S700 高强钢",
    short: "高强钢",
    tensile: 900,
    radiusRatio: 0.22,
    vMultiplier: 1.25,
    springback: 5,
  },
};

const PUNCH_CATALOG: Record<PunchProfileId, PunchProfile> = {
  gp28: {
    id: "gp28",
    label: "GP-28 · 鹅颈 R1.0",
    kind: "gooseneck",
    throat: 82,
    height: 160,
    tipRadius: 1,
    polygon: [
      { x: -28.8, y: -160 }, { x: -6, y: -160 }, { x: -6, y: -135 },
      { x: -13.2, y: -124 }, { x: -19.2, y: -105 }, { x: -20.4, y: -78 },
      { x: -16.2, y: -58 }, { x: -7.2, y: -42 }, { x: 4, y: -24 },
      { x: 4, y: -8 }, { x: 0, y: 0 }, { x: -2.4, y: -8 },
      { x: -13.8, y: -28 }, { x: -28.8, y: -45 }, { x: -34.8, y: -68 },
      { x: -34.8, y: -105 }, { x: -30, y: -132 },
    ],
  },
  dg30: {
    id: "dg30",
    label: "DG-30 · 深鹅颈 R0.8",
    kind: "deep-gooseneck",
    throat: 112,
    height: 180,
    tipRadius: 0.8,
    polygon: [
      { x: -48, y: -180 }, { x: -10, y: -180 }, { x: -10, y: -151.9 },
      { x: -22, y: -139.5 }, { x: -32, y: -118.1 }, { x: -34, y: -87.8 },
      { x: -27, y: -65.3 }, { x: -4, y: -47.3 }, { x: 12, y: -27 },
      { x: 12, y: -9 }, { x: 8, y: 0 }, { x: 4, y: -9 },
      { x: -15, y: -31.5 }, { x: -48, y: -50.6 }, { x: -58, y: -76.5 },
      { x: -58, y: -118.1 }, { x: -50, y: -148.5 },
    ],
  },
  sp88: {
    id: "sp88",
    label: "SP-88 · 直剑 R1.2",
    kind: "straight",
    throat: 0,
    height: 145,
    tipRadius: 1.2,
    polygon: [
      { x: -30, y: -145 }, { x: 30, y: -145 }, { x: 30, y: -128 },
      { x: 18, y: -128 }, { x: 18, y: -48 }, { x: 12, y: -25 },
      { x: 6, y: -7 }, { x: 2, y: 0 }, { x: -2, y: 0 },
      { x: -6, y: -7 }, { x: -12, y: -25 }, { x: -18, y: -48 },
      { x: -18, y: -128 }, { x: -30, y: -128 },
    ],
  },
};

const DIE_CATALOG: Record<DieProfileId, DieProfile> = {
  sd85: { id: "sd85", label: "SD-85 · 单 V", halfWidth: 43, bottomHalfWidth: 38, height: 48, includedAngle: 85 },
  sl85: { id: "sl85", label: "SL-85 · 窄体 V", halfWidth: 32, bottomHalfWidth: 24, height: 58, includedAngle: 85 },
  hd85: { id: "hd85", label: "HD-85 · 重载 V", halfWidth: 56, bottomHalfWidth: 58, height: 66, includedAngle: 85 },
};

function punchProfileValue(profile: PunchProfileInput) {
  return typeof profile === "string" ? PUNCH_CATALOG[profile] : profile;
}

function dieProfileValue(profile: DieProfileInput) {
  return typeof profile === "string" ? DIE_CATALOG[profile] : profile;
}

function punchMarkProfile(profile: PunchProfileInput): PunchProfileId {
  const value = punchProfileValue(profile);
  return value.kind === "straight" ? "sp88" : value.kind === "deep-gooseneck" ? "dg30" : "gp28";
}

function dieMarkProfile(profile: DieProfileInput): DieProfileId {
  if (typeof profile === "string") return profile;
  return profile.halfWidth >= 50 ? "hd85" : profile.halfWidth <= 34 ? "sl85" : "sd85";
}

function buildLibraryPunchProfile(tool: CtgToolRecord, cadGeometry?: Point[]): PunchProfile {
  const kind: PunchProfile["kind"] = tool.family === "deep-gooseneck"
    ? "deep-gooseneck"
    : tool.family === "gooseneck"
      ? "gooseneck"
      : "straight";
  const base = kind === "deep-gooseneck" ? PUNCH_CATALOG.dg30 : kind === "gooseneck" ? PUNCH_CATALOG.gp28 : PUNCH_CATALOG.sp88;
  const targetHeight = clamp(tool.heightMm ?? base.height, 55, 320);
  const polygon = cadGeometry?.length
    ? cadGeometry
    : base.polygon.map((point) => ({
        x: point.x * clamp(targetHeight / base.height, 0.65, 1.75),
        y: point.y * (targetHeight / base.height),
      }));
  const height = Math.max(...polygon.map((point) => point.y)) - Math.min(...polygon.map((point) => point.y));
  const throat = kind === "straight" ? 0 : Math.max(...polygon.map((point) => Math.abs(point.x)));
  return {
    id: `ukb-${tool.id}`,
    label: `${tool.articleNumber} · ${tool.name}`,
    kind,
    throat,
    height,
    tipRadius: tool.radiusMm ?? 1,
    polygon,
  };
}

function buildLibraryDieProfile(tool: CtgToolRecord, cadGeometry?: Point[]): DieProfile {
  const opening = clamp(tool.vOpeningMm ?? 24, 4, 100);
  const polygon = cadGeometry?.length ? cadGeometry : undefined;
  const minY = polygon ? Math.min(...polygon.map((point) => point.y)) : 0;
  const maxY = polygon ? Math.max(...polygon.map((point) => point.y)) : 0;
  const measuredHeight = maxY - minY;
  const height = polygon ? measuredHeight : clamp(tool.heightMm ?? 60, 30, 180);
  const measuredHalfWidth = polygon ? Math.max(...polygon.map((point) => Math.abs(point.x))) : 0;
  const bottomPoints = polygon?.filter((point) => point.y >= maxY - Math.max(1, measuredHeight * 0.05)) ?? [];
  const measuredBottomHalfWidth = bottomPoints.length
    ? Math.max(...bottomPoints.map((point) => Math.abs(point.x)))
    : measuredHalfWidth;
  return {
    id: `ukb-${tool.id}`,
    label: `${tool.articleNumber} · ${tool.name}`,
    halfWidth: polygon ? measuredHalfWidth : Math.max(30, opening * 1.35),
    bottomHalfWidth: polygon ? measuredBottomHalfWidth : Math.max(24, opening * 1.1),
    height,
    includedAngle: tool.angleDeg ?? 85,
    polygon,
  };
}

const V_CATALOG = [4, 6, 8, 10, 12, 16, 20, 25, 32, 40, 50, 63, 80];

const STEPS = [
  { n: 1, label: "定义工件", hint: "机器与截面" },
  { n: 2, label: "编辑参数", hint: "法兰与折弯" },
  { n: 3, label: "模具建议", hint: "匹配与校核" },
  { n: 4, label: "优化模具", hint: "消除碰撞" },
  { n: 5, label: "完成项目", hint: "长度与清单" },
] as const;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function recommendV(thickness: number, material: Material) {
  const ratio = thickness <= 2 ? 6 : thickness <= 6 ? 8 : thickness <= 12 ? 10 : 12;
  const raw = thickness * ratio * material.vMultiplier;
  return V_CATALOG.find((v) => v >= raw) ?? V_CATALOG[V_CATALOG.length - 1];
}

function buildModelPoints(flanges: number[], bendAngles: number[], flat: boolean, meta?: Pick<ProfileMeta, "bendDirections" | "startAngle">) {
  const points = [{ x: 0, y: 0 }];
  let direction = flat ? 0 : meta?.startAngle ?? -90;
  flanges.forEach((length, index) => {
    const rad = (direction * Math.PI) / 180;
    const previous = points[points.length - 1];
    points.push({
      x: previous.x + Math.cos(rad) * length,
      y: previous.y + Math.sin(rad) * length,
    });
    if (!flat && index < flanges.length - 1) {
      direction += (meta?.bendDirections[index] ?? 1) * (180 - (bendAngles[index] ?? 90));
    }
  });
  return points;
}

function autoSequenceOrder(bendCount: number, flanges: number[]) {
  const center = (bendCount - 1) / 2;
  return Array.from({ length: bendCount }, (_, index) => index).sort((left, right) => {
    const leftGrip = Math.min(flanges[left] ?? Infinity, flanges[left + 1] ?? Infinity);
    const rightGrip = Math.min(flanges[right] ?? Infinity, flanges[right + 1] ?? Infinity);
    const gripDifference = leftGrip - rightGrip;
    if (gripDifference !== 0) return gripDifference;
    const outsideDifference = Math.abs(right - center) - Math.abs(left - center);
    return outsideDifference || left - right;
  });
}

function normalizeSequence(sequence: number[], bendCount: number, flanges: number[]) {
  const seen = new Set<number>();
  const normalized = sequence.filter((bend) => {
    if (!Number.isInteger(bend) || bend < 0 || bend >= bendCount || seen.has(bend)) return false;
    seen.add(bend);
    return true;
  });
  autoSequenceOrder(bendCount, flanges).forEach((bend) => {
    if (!seen.has(bend)) normalized.push(bend);
  });
  return normalized;
}

function buildSequenceAngles(
  targetAngles: number[],
  sequence: number[],
  activePosition: number
) {
  const stagedAngles = targetAngles.map(() => 180);
  sequence.slice(0, activePosition + 1).forEach((bend) => {
    if (bend >= 0 && bend < targetAngles.length) stagedAngles[bend] = targetAngles[bend];
  });
  return stagedAngles;
}

const PUNCH_CONTACT_PROGRESS = 0.18;
const PUNCH_APPROACH_GAP = 30;

function bendingProgress(strokeProgress: number) {
  return clamp(
    (strokeProgress - PUNCH_CONTACT_PROGRESS) / (1 - PUNCH_CONTACT_PROGRESS),
    0,
    1
  );
}

function currentPressAngle(targetAngle: number, strokeProgress: number) {
  return 180 - (180 - targetAngle) * bendingProgress(strokeProgress);
}

function normalizeDegrees(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function pointAngle(point: Point) {
  return (Math.atan2(point.y, point.x) * 180) / Math.PI;
}

function rotatePoint(point: Point, angle: number) {
  const radians = (angle * Math.PI) / 180;
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
  };
}

function buildPressPartModel(
  flanges: number[],
  bendAngles: number[],
  criticalBend: number,
  progress: number,
  partFlipped = false,
  profileMeta?: ProfileMeta
) {
  const pivotIndex = Math.round(clamp(criticalBend + 1, 1, Math.max(1, flanges.length - 1)));
  const formedProfile = buildModelPoints(flanges, bendAngles, false, profileMeta);
  const pivot = formedProfile[pivotIndex] ?? { x: 0, y: 0 };
  const relativeProfile = formedProfile.map((point) => ({
    x: point.x - pivot.x,
    y: point.y - pivot.y,
  }));
  const targetAngle = bendAngles[criticalBend] ?? 90;
  const rawLeftAngle = pointAngle(relativeProfile[pivotIndex - 1]);
  const rawRightAngle = pointAngle(relativeProfile[pivotIndex + 1]);
  const signedTargetAngle = normalizeDegrees(rawRightAngle - rawLeftAngle);
  const formedBisector = rawLeftAngle + signedTargetAngle / 2;
  const alignmentRotation = -90 - formedBisector;
  const alignedProfile = relativeProfile.map((point) => rotatePoint(point, alignmentRotation));
  const formedLeftAngle = pointAngle(alignedProfile[pivotIndex - 1]);
  const formedRightAngle = pointAngle(alignedProfile[pivotIndex + 1]);
  const turnSign = signedTargetAngle < 0 ? -1 : 1;
  const currentIncludedAngle = currentPressAngle(targetAngle, progress);
  const currentLeftAngle = -90 - turnSign * currentIncludedAngle / 2;
  const currentRightAngle = -90 + turnSign * currentIncludedAngle / 2;
  const leftRotation = normalizeDegrees(currentLeftAngle - formedLeftAngle);
  const rightRotation = normalizeDegrees(currentRightAngle - formedRightAngle);
  const points = alignedProfile.map((point, index) => {
    if (index < pivotIndex) return rotatePoint(point, leftRotation);
    if (index > pivotIndex) return rotatePoint(point, rightRotation);
    return { x: 0, y: 0 };
  });
  return {
    points: partFlipped ? points.map((point) => ({ x: -point.x, y: point.y })) : points,
    pivotIndex,
  };
}

function segmentIntersection(a: Point, b: Point, c: Point, d: Point) {
  const denominator = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
  if (Math.abs(denominator) < 0.0001) return null;
  const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / denominator;
  const u = -((a.x - b.x) * (a.y - c.y) - (a.y - b.y) * (a.x - c.x)) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

function resolvePunchProfile(profile: PunchProfileInput, customPunch?: CustomPunch) {
  if (!customPunch) return punchProfileValue(profile);
  const base = punchProfileValue(profile);
  const xs = base.polygon.map((point) => point.x);
  const ys = base.polygon.map((point) => point.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const baseHeight = Math.max(1, maxY - minY);
  const baseBody = Math.max(1, Math.max(...xs) - Math.min(...xs));
  const heightScale = clamp(customPunch.height / baseHeight, 0.35, 3.5);
  const bodyScale = clamp(customPunch.body / baseBody, 0.35, 3.5);
  const tipScale = clamp(customPunch.tipRadius / Math.max(0.1, base.tipRadius), 0.25, 6);
  const throatDelta = customPunch.throat - base.throat;
  const smoothstep = (edge0: number, edge1: number, value: number) => {
    const normalized = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
    return normalized * normalized * (3 - 2 * normalized);
  };
  return {
    ...base,
    label: `${base.label} · 轮廓修改`,
    throat: customPunch.throat,
    height: customPunch.height,
    tipRadius: customPunch.tipRadius,
    polygon: base.polygon.map((point) => ({
      x: point.x * (
        bodyScale
        + (tipScale - bodyScale) * (1 - smoothstep(0.04, 0.2, (maxY - point.y) / baseHeight))
      ) - throatDelta * smoothstep(0.18, 0.68, (maxY - point.y) / baseHeight),
      y: maxY + (point.y - maxY) * heightScale,
    })),
  };
}

function customPunchFromProfile(profile: PunchProfileInput): CustomPunch {
  const value = punchProfileValue(profile);
  const xs = value.polygon.map((point) => point.x);
  const bodyWidth = Math.max(...xs) - Math.min(...xs);
  return {
    throat: Math.round(value.throat * 10) / 10,
    height: Math.round(value.height * 10) / 10,
    body: Math.round(bodyWidth * 10) / 10,
    tipRadius: Math.round(value.tipRadius * 10) / 10,
  };
}

function findPunchContacts(
  punch: PunchProfile,
  flanges: number[],
  bendAngles: number[],
  criticalBend: number,
  progress: number,
  thickness: number,
  partFlipped = false,
  profileMeta?: ProfileMeta
) {
  const rawPart = buildPressPartModel(flanges, bendAngles, criticalBend, progress, partFlipped, profileMeta);
  const points = sampleRoundedPolyline(rawPart.points, profileMeta?.bendRadii ?? []);
  const punchOffsetY = progress < PUNCH_CONTACT_PROGRESS
    ? -PUNCH_APPROACH_GAP * (1 - progress / PUNCH_CONTACT_PROGRESS)
    : 0;
  const punchPolygon = punch.polygon.map((point) => ({ x: point.x, y: point.y + punchOffsetY }));
  const allowedContactY = -(14 + thickness * 1.5);
  const contacts: Point[] = [];
  for (let partIndex = 0; partIndex < points.length - 1; partIndex += 1) {
    for (let toolIndex = 0; toolIndex < punchPolygon.length; toolIndex += 1) {
      const contact = segmentIntersection(
        points[partIndex],
        points[partIndex + 1],
        punchPolygon[toolIndex],
        punchPolygon[(toolIndex + 1) % punchPolygon.length]
      );
      if (
        contact &&
        contact.y < allowedContactY &&
        !contacts.some((item) => Math.hypot(item.x - contact.x, item.y - contact.y) < 2)
      ) {
        contacts.push(contact);
      }
    }
  }
  return contacts;
}

function evaluatePunchSweep(
  profileId: PunchProfileInput,
  flanges: number[],
  bendAngles: number[],
  criticalBend: number,
  thickness: number,
  customPunch?: CustomPunch,
  partFlipped = false,
  profileMeta?: ProfileMeta
) {
  if (flanges.length < 2) {
    return {
      punch: null,
      samples: [],
      collision: false,
      firstCollisionProgress: null,
    };
  }
  const punch = resolvePunchProfile(profileId, customPunch);
  const progressSamples = Array.from(new Set([
    ...Array.from({ length: 13 }, (_, index) => index / 12),
    PUNCH_CONTACT_PROGRESS - 0.005,
    PUNCH_CONTACT_PROGRESS,
    PUNCH_CONTACT_PROGRESS + 0.005,
  ])).sort((left, right) => left - right);
  const samples = progressSamples.map((progress) => {
    return {
      progress,
      contacts: findPunchContacts(punch, flanges, bendAngles, criticalBend, progress, thickness, partFlipped, profileMeta),
    };
  });
  const firstCollision = samples.find((sample) => sample.contacts.length > 0);
  return {
    punch,
    samples,
    collision: Boolean(firstCollision),
    firstCollisionProgress: firstCollision?.progress ?? null,
  };
}

function sweepContactCount(sweep: ReturnType<typeof evaluatePunchSweep>) {
  return sweep.samples.reduce((total, sample) => total + sample.contacts.length, 0);
}

function sequenceOrderPenalty(sequence: number[], flanges: number[]) {
  const preferred = autoSequenceOrder(sequence.length, flanges);
  return sequence.reduce(
    (total, bend, position) => total + Math.abs(position - preferred.indexOf(bend)),
    0
  );
}

/** Intermediate angles to try when the target angle causes collision. Higher = more open = less interference. */
const INTERMEDIATE_ANGLES = [135, 120, 110, 105];

function evaluateBendSequence(
  profileId: PunchProfileInput,
  flanges: number[],
  targetAngles: number[],
  sequence: number[],
  thickness: number,
  customPunch?: CustomPunch,
  profileMeta?: ProfileMeta
): SequenceEvaluation {
  if (flanges.length < 2) {
    return {
      sequence: [],
      flips: [],
      collisionByPosition: [],
      contactCountByPosition: [],
      collidingSamplesByPosition: [],
      collisionSteps: 0,
      totalContacts: 0,
      totalCollidingSamples: 0,
      orderPenalty: 0,
      intermediateAngles: [],
    };
  }
  const flips: boolean[] = [];
  const collisionByPosition: boolean[] = [];
  const contactCountByPosition: number[] = [];
  const collidingSamplesByPosition: number[] = [];
  const intermediateAngles: number[] = [];

  sequence.forEach((criticalBend, position) => {
    let bestSweep: ReturnType<typeof evaluatePunchSweep> | null = null;
    let bestFlipped = false;
    let bestContacts = Infinity;
    let bestCollidingSamples = Infinity;
    let usedAngle = targetAngles[criticalBend] ?? 90;
    let foundCollisionFree = false;

    // Try target angle first (normal + flipped)
    const stagedAngles = buildSequenceAngles(targetAngles, sequence, position);
    const normalSweep = evaluatePunchSweep(
      profileId, flanges, stagedAngles, criticalBend, thickness, customPunch, false, profileMeta
    );
    const flippedSweep = evaluatePunchSweep(
      profileId, flanges, stagedAngles, criticalBend, thickness, customPunch, true, profileMeta
    );
    const normalContacts = sweepContactCount(normalSweep);
    const flippedContacts = sweepContactCount(flippedSweep);
    const normalCollidingSamples = normalSweep.samples.filter((s) => s.contacts.length > 0).length;
    const flippedCollidingSamples = flippedSweep.samples.filter((s) => s.contacts.length > 0).length;

    const useFlipped = flippedCollidingSamples < normalCollidingSamples
      || (flippedCollidingSamples === normalCollidingSamples && flippedContacts < normalContacts);
    const chosenSweep = useFlipped ? flippedSweep : normalSweep;
    const chosenContacts = useFlipped ? flippedContacts : normalContacts;
    const chosenCollidingSamples = useFlipped ? flippedCollidingSamples : normalCollidingSamples;

    if (!chosenSweep.collision) {
      // Target angle works fine
      bestSweep = chosenSweep;
      bestFlipped = useFlipped;
      bestContacts = chosenContacts;
      bestCollidingSamples = chosenCollidingSamples;
      foundCollisionFree = true;
    } else {
      // Try intermediate angles to see if a more-open bend avoids collision
      for (const interAngle of INTERMEDIATE_ANGLES) {
        if (foundCollisionFree) break;
        const interStagedAngles = stagedAngles.map((a, i) =>
          i === criticalBend ? Math.max(a, interAngle) : a
        );
        const interNormal = evaluatePunchSweep(
          profileId, flanges, interStagedAngles, criticalBend, thickness, customPunch, false, profileMeta
        );
        const interFlipped = evaluatePunchSweep(
          profileId, flanges, interStagedAngles, criticalBend, thickness, customPunch, true, profileMeta
        );
        const iNormalContacts = sweepContactCount(interNormal);
        const iFlippedContacts = sweepContactCount(interFlipped);
        const iNormalColliding = interNormal.samples.filter((s) => s.contacts.length > 0).length;
        const iFlippedColliding = interFlipped.samples.filter((s) => s.contacts.length > 0).length;
        const iUseFlipped = iFlippedColliding < iNormalColliding
          || (iFlippedColliding === iNormalColliding && iFlippedContacts < iNormalContacts);
        const iChosen = iUseFlipped ? interFlipped : interNormal;
        const iContacts = iUseFlipped ? iFlippedContacts : iNormalContacts;
        const iColliding = iUseFlipped ? iFlippedColliding : iNormalColliding;
        if (!iChosen.collision && iColliding < bestCollidingSamples) {
          bestSweep = iChosen;
          bestFlipped = iUseFlipped;
          bestContacts = iContacts;
          bestCollidingSamples = iColliding;
          usedAngle = interAngle;
          foundCollisionFree = true;
        }
      }
      if (!foundCollisionFree) {
        // Stick with the original target-angle result
        bestSweep = chosenSweep;
        bestFlipped = useFlipped;
        bestContacts = chosenContacts;
        bestCollidingSamples = chosenCollidingSamples;
      }
    }

    flips.push(bestFlipped);
    collisionByPosition.push(bestSweep!.collision);
    contactCountByPosition.push(bestContacts);
    collidingSamplesByPosition.push(bestCollidingSamples);
    intermediateAngles.push(usedAngle);
  });

  return {
    sequence: [...sequence],
    flips,
    collisionByPosition,
    contactCountByPosition,
    collidingSamplesByPosition,
    collisionSteps: collisionByPosition.filter(Boolean).length,
    totalContacts: contactCountByPosition.reduce((total, count) => total + count, 0),
    totalCollidingSamples: collidingSamplesByPosition.reduce((total, count) => total + count, 0),
    orderPenalty: sequenceOrderPenalty(sequence, flanges),
    intermediateAngles,
  };
}

function permuteBends(values: number[]): number[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    permuteBends([...values.slice(0, index), ...values.slice(index + 1)]).map((tail) => [value, ...tail])
  );
}

function findBestBendSequence(
  profileId: PunchProfileInput,
  flanges: number[],
  targetAngles: number[],
  thickness: number,
  customPunch?: CustomPunch,
  profileMeta?: ProfileMeta
) {
  if (targetAngles.length > 5) {
    return evaluateBendSequence(
      profileId,
      flanges,
      targetAngles,
      autoSequenceOrder(targetAngles.length, flanges),
      thickness,
      customPunch,
      profileMeta
    );
  }
  const operationCache = new Map<string, {
    flipped: boolean;
    collision: boolean;
    contactCount: number;
    collidingSamples: number;
    usedAngle: number;
  }>();
  const evaluateCachedSequence = (sequence: number[]): SequenceEvaluation => {
    let completedMask = 0;
    const flips: boolean[] = [];
    const collisionByPosition: boolean[] = [];
    const contactCountByPosition: number[] = [];
    const collidingSamplesByPosition: number[] = [];

    sequence.forEach((criticalBend) => {
      const cacheKey = `${completedMask}:${criticalBend}`;
      let operation = operationCache.get(cacheKey);
      if (!operation) {
        const stagedAngles = targetAngles.map((angle, bend) =>
          (completedMask & (1 << bend)) !== 0 || bend === criticalBend ? angle : 180
        );
        const normalSweep = evaluatePunchSweep(
          profileId,
          flanges,
          stagedAngles,
          criticalBend,
          thickness,
          customPunch,
          false,
          profileMeta
        );
        const flippedSweep = evaluatePunchSweep(
          profileId,
          flanges,
          stagedAngles,
          criticalBend,
          thickness,
          customPunch,
          true,
          profileMeta
        );
        const normalContacts = sweepContactCount(normalSweep);
        const flippedContacts = sweepContactCount(flippedSweep);
        const normalCollidingSamples = normalSweep.samples.filter((sample) => sample.contacts.length > 0).length;
        const flippedCollidingSamples = flippedSweep.samples.filter((sample) => sample.contacts.length > 0).length;
        const flipped = flippedCollidingSamples < normalCollidingSamples
          || (flippedCollidingSamples === normalCollidingSamples && flippedContacts < normalContacts);
        // Try target angle first
        let bestUsedAngle = targetAngles[criticalBend] ?? 90;
        let bestResult = {
          flipped,
          collision: flipped ? flippedSweep.collision : normalSweep.collision,
          contactCount: flipped ? flippedContacts : normalContacts,
          collidingSamples: flipped ? flippedCollidingSamples : normalCollidingSamples,
        };

        // If there's collision, try intermediate angles
        if (bestResult.collision || bestResult.collidingSamples > 0) {
          for (const interAngle of INTERMEDIATE_ANGLES) {
            const interStagedAngles = stagedAngles.map((a, i) =>
              i === criticalBend ? Math.max(a, interAngle) : a
            );
            const interNormal = evaluatePunchSweep(
              profileId, flanges, interStagedAngles, criticalBend, thickness, customPunch, false, profileMeta
            );
            const interFlipped = evaluatePunchSweep(
              profileId, flanges, interStagedAngles, criticalBend, thickness, customPunch, true, profileMeta
            );
            const iNc = sweepContactCount(interNormal);
            const iFc = sweepContactCount(interFlipped);
            const iNs = interNormal.samples.filter((s) => s.contacts.length > 0).length;
            const iFs = interFlipped.samples.filter((s) => s.contacts.length > 0).length;
            const iUseFlipped = iFs < iNs || (iFs === iNs && iFc < iNc);
            const iChosen = iUseFlipped ? interFlipped : interNormal;
            const iContacts = iUseFlipped ? iFc : iNc;
            const iColliding = iUseFlipped ? iFs : iNs;
            if (!iChosen.collision && iColliding < bestResult.collidingSamples) {
              bestUsedAngle = interAngle;
              bestResult = {
                flipped: iUseFlipped,
                collision: iChosen.collision,
                contactCount: iContacts,
                collidingSamples: iColliding,
              };
              break;
            }
          }
        }

        operationCache.set(cacheKey, { ...bestResult, usedAngle: bestUsedAngle });
      }
      const op = operationCache.get(cacheKey)!;
      flips.push(op.flipped);
      collisionByPosition.push(op.collision);
      contactCountByPosition.push(op.contactCount);
      collidingSamplesByPosition.push(op.collidingSamples);
      completedMask |= 1 << criticalBend;
    });

    return {
      sequence: [...sequence],
      flips,
      collisionByPosition,
      contactCountByPosition,
      collidingSamplesByPosition,
      collisionSteps: collisionByPosition.filter(Boolean).length,
      totalContacts: contactCountByPosition.reduce((total, count) => total + count, 0),
      totalCollidingSamples: collidingSamplesByPosition.reduce((total, count) => total + count, 0),
      orderPenalty: sequenceOrderPenalty(sequence, flanges),
      intermediateAngles: flips.map((_, i) => {
        // Reconstruct the cache key for this position
        let mask = 0;
        for (let j = 0; j < i; j++) mask |= 1 << sequence[j];
        const key = `${mask}:${sequence[i]}`;
        const op = operationCache.get(key);
        return op?.usedAngle ?? targetAngles[sequence[i]] ?? 90;
      }),
    };
  };
  const candidates = permuteBends(Array.from({ length: targetAngles.length }, (_, index) => index));
  const fallback = evaluateCachedSequence(autoSequenceOrder(targetAngles.length, flanges));
  return candidates.reduce((best, sequence) => {
    const candidate = evaluateCachedSequence(sequence);
    if (candidate.collisionSteps !== best.collisionSteps) {
      return candidate.collisionSteps < best.collisionSteps ? candidate : best;
    }
    if (candidate.totalCollidingSamples !== best.totalCollidingSamples) {
      return candidate.totalCollidingSamples < best.totalCollidingSamples ? candidate : best;
    }
    if (candidate.totalContacts !== best.totalContacts) {
      return candidate.totalContacts < best.totalContacts ? candidate : best;
    }
    const candidateFlips = candidate.flips.filter(Boolean).length;
    const bestFlips = best.flips.filter(Boolean).length;
    if (candidateFlips !== bestFlips) return candidateFlips < bestFlips ? candidate : best;
    return candidate.orderPenalty < best.orderPenalty ? candidate : best;
  }, fallback);
}

function ToolMark({
  type,
  profile,
}: {
  type: "punch" | "die";
  profile?: PunchProfileInput | DieProfileInput;
}) {
  const renderContour = (points: Point[]) => {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const padding = Math.max(width, height) * 0.06;
    const svgPoints = points.map((point) => `${point.x},${point.y}`).join(" ");
    return (
      <svg
        viewBox={`${minX - padding} ${minY - padding} ${width + padding * 2} ${height + padding * 2}`}
        preserveAspectRatio="xMidYMid meet"
        className={`tool-mark tool-mark-svg ${type}`}
        aria-hidden="true"
      >
        <polygon points={svgPoints} />
      </svg>
    );
  };
  if (typeof profile === "string") {
    return <span className={`tool-mark ${type} ${profile}`} aria-hidden="true" />;
  }
  if (type === "punch" && typeof profile === "object" && "polygon" in profile) {
    const poly = (profile as PunchProfile).polygon;
    if (!poly.length) return <span className={`tool-mark ${type}`} aria-hidden="true" />;
    return renderContour(poly);
  }
  if (type === "die" && typeof profile === "object" && "halfWidth" in profile) {
    const d = profile as DieProfile;
    if (d.polygon?.length) return renderContour(d.polygon);
    const hw = d.halfWidth, bhw = d.bottomHalfWidth, h = d.height, angle = d.includedAngle || 85;
    const topW = hw * 2, botW = bhw * 2;
    const pts = [
      `${((0.5 - topW / 200) * 100).toFixed(1)}% ${(100 - 100 / h).toFixed(1)}%`,
      `${((0.5 + topW / 200) * 100).toFixed(1)}% ${(100 - 100 / h).toFixed(1)}%`,
      "50% 60%",
      `${((0.5 - botW / 200) * 100).toFixed(1)}% 100%`,
      `${((0.5 + botW / 200) * 100).toFixed(1)}% 100%`,
    ].join(" ");
    return <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" className="tool-mark tool-mark-svg die" aria-hidden="true"><polygon points={pts} /></svg>;
  }
  return <span className={`tool-mark ${type}`} aria-hidden="true" />;
}

function quoteFont(size: number, weight = 400) {
  return `${weight} ${size}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", Arial, sans-serif`;
}

function quoteRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string,
  stroke?: string
) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function quoteText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  weight = 400,
  align: CanvasTextAlign = "left"
) {
  ctx.font = quoteFont(size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
}

function quoteWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
  size: number,
  color: string,
  weight = 400
) {
  ctx.font = quoteFont(size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  const characters = [...text];
  const lines: string[] = [];
  let current = "";
  for (const character of characters) {
    const next = current + character;
    if (ctx.measureText(next).width <= maxWidth || current.length === 0) {
      current = next;
    } else {
      lines.push(current);
      current = character;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  const consumed = lines.join("").length;
  if (consumed < characters.length && lines.length) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}…`;
  }
  lines.forEach((line, index) => ctx.fillText(line, x, y + index * lineHeight));
}

function quoteDrawContour(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  x: number,
  y: number,
  width: number,
  height: number,
  color: string
) {
  if (points.length < 3) return;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const sourceWidth = Math.max(1, maxX - minX);
  const sourceHeight = Math.max(1, maxY - minY);
  const scale = Math.min((width - 26) / sourceWidth, (height - 22) / sourceHeight);
  const offsetX = x + (width - sourceWidth * scale) / 2;
  const offsetY = y + (height - sourceHeight * scale) / 2;
  ctx.save();
  ctx.beginPath();
  points.forEach((point, index) => {
    const px = offsetX + (point.x - minX) * scale;
    const py = offsetY + (point.y - minY) * scale;
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = color === "#3d6f9f" ? "#24577f" : "#607b70";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function quoteDieContour(profile: DieProfileInput) {
  const die = dieProfileValue(profile);
  if (die.polygon?.length) return die.polygon;
  const shoulder = Math.min(die.halfWidth * 0.35, 18);
  return [
    { x: -die.halfWidth, y: 0 },
    { x: -shoulder, y: 0 },
    { x: 0, y: die.height * 0.42 },
    { x: shoulder, y: 0 },
    { x: die.halfWidth, y: 0 },
    { x: die.bottomHalfWidth, y: die.height },
    { x: -die.bottomHalfWidth, y: die.height },
  ];
}

function drawQuoteToolCard(ctx: CanvasRenderingContext2D, tool: QuoteToolDetail, x: number, y: number) {
  const width = 351;
  const height = 336;
  quoteRoundedRect(ctx, x, y, width, height, 12, "#ffffff", "#d8e1dc");
  quoteText(ctx, tool.role, x + 18, y + 30, 13, "#168052", 700);
  quoteText(ctx, tool.articleNumber, x + width - 18, y + 30, 17, "#19372b", 750, "right");
  quoteWrappedText(ctx, tool.name, x + 18, y + 55, width - 36, 17, 2, 11, "#3e5148", 600);
  quoteRoundedRect(ctx, x + 18, y + 91, width - 36, 126, 8, "#f3f7f5");
  quoteDrawContour(ctx, tool.contour, x + 18, y + 91, width - 36, 126, tool.color);

  const rows = [
    ["系统 / 角度", `${tool.system} / ${tool.angle}`],
    ["订购总长", `${tool.totalLength} mm`],
    ["分段长度", tool.segments.map((segment) => `${segment}`).join(" + ") + " mm"],
    ["规格", tool.specification],
    ["允许载荷", tool.capacity],
    ["轮廓来源", tool.source],
  ];
  rows.forEach(([label, value], index) => {
    const rowY = y + 236 + index * 15;
    quoteText(ctx, label, x + 18, rowY, 8, "#7d8b84", 400);
    quoteText(ctx, value, x + width - 18, rowY, 8, "#253b31", 600, "right");
  });
}

function createQuoteCanvas(data: QuotePdfData) {
  const scale = 2;
  const width = 827;
  const height = 1169;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器无法创建 PDF 画布");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#f7faf8";
  ctx.fillRect(0, 0, width, height);

  quoteRoundedRect(ctx, 38, 34, 751, 100, 14, "#17382d");
  quoteRoundedRect(ctx, 57, 55, 46, 46, 12, "#59d292");
  quoteText(ctx, "BP", 80, 85, 16, "#17382d", 800, "center");
  quoteText(ctx, "BENDPILOT", 120, 76, 12, "#a8d1bc", 750);
  quoteText(ctx, "折弯模具正式询价单", 120, 103, 24, "#ffffff", 750);
  quoteText(ctx, `询价单号  ${data.quoteNo}`, 766, 70, 10, "#c6d8cf", 500, "right");
  quoteText(ctx, `生成日期  ${data.createdAt.toLocaleDateString("zh-CN")}`, 766, 91, 10, "#c6d8cf", 500, "right");
  quoteText(ctx, "币种 CNY · 价格及交期请供应商正式回复", 766, 112, 9, "#83b59b", 500, "right");

  quoteText(ctx, "客户信息", 48, 160, 13, "#19372b", 700);
  quoteRoundedRect(ctx, 38, 174, 751, 119, 10, "#ffffff", "#d8e1dc");
  const customerRows = [
    ["客户名称", data.customer.company, 58, 202, 360],
    ["联系人", data.customer.contact, 58, 230, 230],
    ["电话", data.customer.phone || "-", 318, 230, 190],
    ["邮箱", data.customer.email || "-", 532, 230, 230],
    ["地址", data.customer.address || "-", 58, 258, 700],
    ["询价备注", data.customer.note || "按所列规格提供含税/未税价格、交期及运输方式。", 58, 282, 700],
  ] as const;
  customerRows.forEach(([label, value, x, y, maxWidth]) => {
    quoteText(ctx, label, x, y, 8, "#84918b", 400);
    quoteWrappedText(ctx, value, x + 56, y, maxWidth - 56, 12, 1, 9, "#243b31", 600);
  });

  quoteText(ctx, "项目与工艺条件", 48, 320, 13, "#19372b", 700);
  quoteRoundedRect(ctx, 38, 334, 751, 80, 10, "#edf7f1", "#cce5d7");
  const projectFacts = [
    ["项目", data.projectName],
    ["材料", data.material],
    ["板厚", `${data.thickness} mm`],
    ["折弯长度", `${data.bendLength} mm`],
    ["预计折弯力", `${Math.round(data.estimatedForce)} kN`],
    ["工序", data.bendSequence],
  ];
  projectFacts.forEach(([label, value], index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = 58 + column * 242;
    const y = 365 + row * 31;
    quoteText(ctx, label, x, y, 8, "#74877d", 400);
    quoteText(ctx, value, x + 54, y, 10, "#17382d", 700);
  });

  quoteText(ctx, "询价模具明细", 48, 444, 13, "#19372b", 700);
  drawQuoteToolCard(ctx, data.punch, 38, 458);
  drawQuoteToolCard(ctx, data.die, 438, 458);

  quoteText(ctx, "技术校核与商务要求", 48, 826, 13, "#19372b", 700);
  quoteRoundedRect(ctx, 38, 840, 751, 185, 10, "#ffffff", "#d8e1dc");
  const checks = [
    ...data.validation.slice(0, 4),
    `数量：上模 1 套、下模 1 套；订购总长均为 ${data.punch.totalLength} mm。`,
    `交期要求：${data.delivery}；请在正式报价中注明包装、运输、税率和报价有效期。`,
  ];
  checks.forEach((item, index) => {
    const y = 872 + index * 24;
    quoteRoundedRect(ctx, 56, y - 11, 14, 14, 7, index < 4 ? "#51c987" : "#dfe8e3");
    quoteText(ctx, index < 4 ? "✓" : "•", 63, y, 8, index < 4 ? "#15352a" : "#61736a", 800, "center");
    quoteWrappedText(ctx, item, 82, y, 680, 14, 1, 9, "#34483f", index < 4 ? 600 : 400);
  });
  quoteText(ctx, "供应商回复", 57, 1008, 8, "#7d8b84", 400);
  quoteText(ctx, "单价：________________  总价：________________  交期：________________", 133, 1008, 9, "#34483f", 500);

  quoteRoundedRect(ctx, 38, 1047, 751, 66, 10, "#17382d");
  quoteText(ctx, "本询价单由 BendPilot 依据所选 CTG 模具轮廓与工艺参数自动生成。", 58, 1077, 10, "#ffffff", 650);
  quoteText(ctx, "下单前须由供应商复核模具接口、V 口、承载能力、分段方式及设备兼容性。", 58, 1098, 9, "#a9c3b6", 400);
  quoteText(ctx, "客户确认：________________", 598, 1077, 9, "#d9e7df", 500);
  quoteText(ctx, "供应商确认：______________", 598, 1098, 9, "#d9e7df", 500);
  quoteText(ctx, `BendPilot · ${data.quoteNo} · 第 1 / 1 页`, 414, 1143, 8, "#84918b", 500, "center");
  return canvas;
}

async function createQuotePdfBlob(data: QuotePdfData) {
  const { jsPDF } = await import("jspdf");
  const canvas = createQuoteCanvas(data);
  const documentPdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  documentPdf.setProperties({
    title: `${data.quoteNo} BendPilot 模具询价单`,
    subject: `${data.projectName} 上下模询价`,
    author: "BendPilot",
    creator: "BendPilot Tool Advisor",
  });
  documentPdf.addImage(canvas.toDataURL("image/jpeg", 0.94), "JPEG", 0, 0, 210, 297, undefined, "FAST");
  return documentPdf.output("blob");
}

function quoteBlobToBase64(blob: Blob) {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  });
}

function downloadQuoteBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function createQuoteNumber(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `BP-RFQ-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function ProfileCanvas({
  thickness,
  profile,
  mode,
  selectedFlange,
  selectedBend,
  onSelectFlange,
  onSelectBend,
  onCommit,
  onInvalidDrag,
}: {
  thickness: number;
  profile: ProfileDefinition;
  mode: CanvasMode;
  selectedFlange: number;
  selectedBend: number;
  onSelectFlange: (index: number) => void;
  onSelectBend: (index: number) => void;
  onCommit: (profile: ProfileDefinition) => void;
  onInvalidDrag: (message: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const pendingPointRef = useRef<Point | null>(null);
  type ViewTransform = { scale: number; offsetX: number; offsetY: number };
  type DragState = {
    pointerId: number;
    nodeIndex: number;
    points: Point[];
    transform: ViewTransform;
    rect: DOMRect;
  };
  const dragRef = useRef<DragState | null>(null);
  const viewportRef = useRef<ViewTransform | null>(null);
  const layoutRef = useRef<{
    points: Point[];
    scale: number;
    offsetX: number;
    offsetY: number;
    modelPoints: Point[];
    bendArcs: Array<RoundedCorner | null>;
    bendLabels: Array<{ left: number; top: number; right: number; bottom: number }>;
  } | null>(null);
  const drawRef = useRef<((points?: Point[], frozen?: ViewTransform, draft?: boolean) => void) | null>(null);
  const [size, setSize] = useState({ width: 720, height: 470 });
  const [zoomPercent, setZoomPercent] = useState(100);
  const wheelButtonRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      viewportRef.current = null;
      setZoomPercent(100);
      setSize({
        width: Math.max(360, Math.floor(entry.contentRect.width)),
        height: Math.min(Math.max(330, Math.floor(entry.contentRect.height)), 500),
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const drawProfile = useCallback(function drawProfile(
    suppliedPoints?: Point[],
    frozenTransform?: ViewTransform,
    draft = false
  ) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(size.width * dpr);
    const pixelHeight = Math.round(size.height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    const modelPoints = suppliedPoints ?? buildModelPoints(
      profile.flanges,
      profile.bendAngles,
      mode === "flat",
      profile
    );
    const xs = modelPoints.map((p) => p.x);
    const ys = modelPoints.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const modelW = Math.max(80, maxX - minX);
    const modelH = Math.max(80, maxY - minY);
    const retainedTransform = profile.flanges.length === 0 ? null : viewportRef.current;
    const activeTransform = frozenTransform ?? retainedTransform;
    const scale = activeTransform?.scale
      ?? Math.max(0.45, Math.min((size.width - 150) / modelW, (size.height - 150) / modelH, 3.2));
    const offsetX = activeTransform?.offsetX
      ?? size.width / 2 - ((minX + maxX) / 2) * scale;
    const offsetY = activeTransform?.offsetY
      ?? size.height / 2 - ((minY + maxY) / 2) * scale + 15;
    // Use sampleRoundedPolyline so profile canvas matches simulation rendering
    const roundedModelPoints = mode === "formed" && profile.bendRadii.some((r) => r > 0)
      ? sampleRoundedPolyline(modelPoints, profile.bendRadii)
      : modelPoints;
    const points = roundedModelPoints.map((p) => ({
      x: p.x * scale + offsetX,
      y: p.y * scale + offsetY,
    }));
    if (!frozenTransform) viewportRef.current = { scale, offsetX, offsetY };
    layoutRef.current = {
      points,
      scale,
      offsetX,
      offsetY,
      modelPoints,
      bendArcs: [],
      bendLabels: [],

    };

    ctx.fillStyle = "#fbfcfb";
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.strokeStyle = "#e6ebe8";
    ctx.lineWidth = 1;
    for (let x = 18; x < size.width; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size.height);
      ctx.stroke();
    }
    for (let y = 18; y < size.height; y += 24) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size.width, y);
      ctx.stroke();
    }

    if (modelPoints.length === 1 && profile.flanges.length === 0) {
      const origin = points[0];
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, 12, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(73,185,128,.16)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#49b980";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#40554a";
      ctx.font = "700 14px Arial";
      ctx.textAlign = "center";
      ctx.fillText("从这里开始绘制", origin.x, origin.y - 36);
      ctx.fillStyle = "#87938d";
      ctx.font = "500 11px Arial";
      ctx.fillText("单击任意点开始绘制，拖出第一段", origin.x, origin.y - 17);
      return;
    }

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const modelCorners = mode === "formed" ? roundedCorners(modelPoints, profile.bendRadii) : [];
    const screenCorners = modelCorners.map((corner) => corner ? {
      ...corner,
      incoming: { x: corner.incoming.x * scale + offsetX, y: corner.incoming.y * scale + offsetY },
      outgoing: { x: corner.outgoing.x * scale + offsetX, y: corner.outgoing.y * scale + offsetY },
      center: { x: corner.center.x * scale + offsetX, y: corner.center.y * scale + offsetY },
      radius: corner.radius * scale,
    } : null);
    layoutRef.current.bendArcs = screenCorners;

    // Compute line width based on plate thickness
    const lineWidth = Math.round(clamp(2 + thickness * 1.2, 3, 16));
    // Draw the rounded polyline as a continuous path
    if (points.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.strokeStyle = draft ? "#3d7460" : "#24352d";
      ctx.lineWidth = lineWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      // Highlight selected flange segment
      if (!draft && selectedFlange >= 0 && selectedFlange < points.length - 1) {
        ctx.beginPath();
        ctx.moveTo(points[selectedFlange].x, points[selectedFlange].y);
        ctx.lineTo(points[selectedFlange + 1].x, points[selectedFlange + 1].y);
        ctx.strokeStyle = "#49b980";
        ctx.lineWidth = lineWidth + 2;
        ctx.stroke();
      }

      // Length labels at segment midpoints
      for (let i = 0; i < modelPoints.length - 1; i++) {
        // Map model segment to screen segment
        let screenStart = 0;
        for (let s = 0; s < points.length - 1; s++) {
          const dx = points[s].x - (modelPoints[i].x * scale + offsetX);
          const dy = points[s].y - (modelPoints[i].y * scale + offsetY);
          if (Math.hypot(dx, dy) < 2) { screenStart = s; break; }
        }
        const midX = (points[screenStart].x + points[screenStart + 1].x) / 2;
        const midY = (points[screenStart].y + points[screenStart + 1].y) / 2;
      ctx.font = "600 12px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const length = Math.hypot(
        modelPoints[i + 1].x - modelPoints[i].x,
        modelPoints[i + 1].y - modelPoints[i].y
      );
      const label = `${Number.isInteger(length) ? length : length.toFixed(1)} mm`;
      const width = ctx.measureText(label).width + 16;
      ctx.fillStyle = "rgba(255,255,255,.94)";
      ctx.fillRect(midX - width / 2, midY - 25, width, 20);
      ctx.fillStyle = i === selectedFlange ? "#178956" : "#516159";
      ctx.fillText(label, midX, midY - 15);
      }
    }


    // Draw gray R-radius arc markers at each inner corner
    if (mode === "formed") {
      for (let i = 1; i < modelPoints.length - 1; i++) {
        const prevPt = modelPoints[i - 1];
        const corner = modelPoints[i];
        const nextPt = modelPoints[i + 1];
        // Incoming direction (from previous to corner)
        const inDx = corner.x - prevPt.x;
        const inDy = corner.y - prevPt.y;
        const inLen = Math.hypot(inDx, inDy);
        if (inLen < 0.01) continue;
        const inUnitX = inDx / inLen;
        const inUnitY = inDy / inLen;
        // Outgoing direction (from corner to next)
        const outDx = nextPt.x - corner.x;
        const outDy = nextPt.y - corner.y;
        const outLen = Math.hypot(outDx, outDy);
        if (outLen < 0.01) continue;
        const outUnitX = outDx / outLen;
        const outUnitY = outDy / outLen;
        // Compute included angle
        const dot = clamp(inUnitX * outUnitX + inUnitY * outUnitY, -1, 1);
        const includedAngle = Math.acos(dot);
        if (includedAngle < 0.01) continue;
        // Bend radius for this corner
        const bendR = Math.max(0, profile.bendRadii[i - 1] ?? 0);
        // Screen position of corner
        const cx = corner.x * scale + offsetX;
        const cy = corner.y * scale + offsetY;
        const screenR = bendR * scale;
        if (screenR < 1) continue;
        // Draw the R-arc
        const startAngle = Math.atan2(-inUnitY, -inUnitX);
        const endAngle = Math.atan2(outUnitY, outUnitX);
        let sweep = endAngle - startAngle;
        while (sweep > Math.PI) sweep -= Math.PI * 2;
        while (sweep < -Math.PI) sweep += Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, screenR, startAngle, startAngle + sweep, sweep < 0);
        ctx.strokeStyle = "#9aa8a2";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.stroke();
      }
    }

    if (mode === "formed") {
      const bendLabels: Array<{ left: number; top: number; right: number; bottom: number }> = [];
      // Use original model corner positions for bend labels (not sampled arc points)
      for (let i = 1; i < modelPoints.length - 1; i++) {
        const cornerModel = modelPoints[i];
        const labelX = cornerModel.x * scale + offsetX + 8;
        const labelY = cornerModel.y * scale + offsetY - 29;
        const label = `B${i} · R${(profile.bendRadii[i - 1] ?? 1).toFixed(1)}`;
        ctx.font = "700 10px Arial";
        const width = ctx.measureText(label).width + 14;
        ctx.fillStyle = (i - 1) === selectedBend ? "#def7e9" : "rgba(255,255,255,.94)";
        ctx.fillRect(labelX - width / 2, labelY - 10, width, 19);
        ctx.strokeStyle = (i - 1) === selectedBend ? "#49b980" : "#d9e3de";
        ctx.lineWidth = 1;
        ctx.strokeRect(labelX - width / 2, labelY - 10, width, 19);
        ctx.fillStyle = (i - 1) === selectedBend ? "#137548" : "#4e5e56";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, labelX, labelY);
        bendLabels.push({
          left: labelX - width / 2,
          top: labelY - 10,
          right: labelX + width / 2,
          bottom: labelY + 9,
        });
      }
      layoutRef.current.bendLabels = bendLabels;
    }
  }, [mode, profile, selectedBend, selectedFlange, size]);

  useEffect(() => {
    drawRef.current = drawProfile;
    drawProfile();
  }, [drawProfile]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  function findSegment(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    if (!canvas || !layout) return -1;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = { index: -1, distance: Number.POSITIVE_INFINITY };
    layout.points.slice(0, -1).forEach((a, index) => {
      const b = layout.points[index + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      const t = clamp(((x - a.x) * dx + (y - a.y) * dy) / l2, 0, 1);
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      const distance = Math.hypot(x - px, y - py);
      if (distance < best.distance) best = { index, distance };
    });
    return best.distance < 18 ? best.index : -1;
  }

  function findBendAt(x: number, y: number) {
    const layout = layoutRef.current;
    if (!layout) return -1;
    const labelIndex = layout.bendLabels.findIndex((label) => (
      x >= label.left - 5 && x <= label.right + 5 && y >= label.top - 5 && y <= label.bottom + 5
    ));
    if (labelIndex >= 0) return labelIndex;
    let best = { index: -1, distance: Number.POSITIVE_INFINITY };
    layout.bendArcs.forEach((corner, index) => {
      if (!corner) return;
      for (let sample = 0; sample <= 12; sample += 1) {
        const angle = corner.startAngle + corner.sweep * (sample / 12);
        const arcX = corner.center.x + Math.cos(angle) * corner.radius;
        const arcY = corner.center.y + Math.sin(angle) * corner.radius;
        const distance = Math.hypot(x - arcX, y - arcY);
        if (distance < best.distance) best = { index, distance };
      }
    });
    return best.distance <= 16 ? best.index : -1;
  }

  function snapToOrthogonal(start: Point, end: Point): Point {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const angle = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
    const normalized = ((angle % 180) + 180) % 180;
    const isHorizontal = normalized < 15 || normalized > 165;
    const isVertical = Math.abs(normalized - 90) < 15;
    if (isHorizontal) {
      return { x: end.x, y: start.y };
    }
    if (isVertical) {
      return { x: start.x, y: end.y };
    }
    return end;
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const layout = layoutRef.current;
    const canvas = canvasRef.current;
    if (!layout || !canvas) return;
    event.preventDefault();
    // Middle button (button 1) = enter pan mode
    if (event.button === 1) {
      wheelButtonRef.current = true;
      panStartRef.current = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (profile.flanges.length === 0) {
      // Any-point drawing: click anywhere on the canvas to start
      const modelX = (x - layout.offsetX) / layout.scale;
      const modelY = (y - layout.offsetY) / layout.scale;
      dragRef.current = {
        pointerId: event.pointerId,
        nodeIndex: 1,
        points: [{ x: 0, y: 0 }, { x: modelX, y: modelY }],
        transform: { scale: layout.scale, offsetX: layout.offsetX, offsetY: layout.offsetY },
        rect,
      };
      canvas.setPointerCapture(event.pointerId);
      pendingPointRef.current = null;
      return;
    }

    // Click anywhere far from existing nodes → start adding a new segment from last point
    let nearestNodeDist = Number.POSITIVE_INFINITY;
    layout.points.forEach((point) => {
      const d = Math.hypot(x - point.x, y - point.y);
      if (d < nearestNodeDist) nearestNodeDist = d;
    });
    if (nearestNodeDist > 30) {
      const lastPoint = layout.modelPoints[layout.modelPoints.length - 1];
      dragRef.current = {
        pointerId: event.pointerId,
        nodeIndex: layout.modelPoints.length,
        points: [...layout.modelPoints.map((point) => ({ ...point })), { ...lastPoint }],
        transform: { scale: layout.scale, offsetX: layout.offsetX, offsetY: layout.offsetY },
        rect,
      };
      pendingPointRef.current = null;
      canvas.setPointerCapture(event.pointerId);
      return;
    }

    if (mode === "formed") {
      let nodeIndex = -1;
      let nodeDistance = Number.POSITIVE_INFINITY;
      layout.points.forEach((point, index) => {
        const distance = Math.hypot(x - point.x, y - point.y);
        if (distance < nodeDistance) {
          nodeIndex = index;
          nodeDistance = distance;
        }
      });
      if (nodeIndex > 0 && nodeDistance < 22) {
        onSelectFlange(nodeIndex - 1);
        if (nodeIndex < layout.points.length - 1) onSelectBend(nodeIndex - 1);
        dragRef.current = {
          pointerId: event.pointerId,
          nodeIndex,
          points: layout.modelPoints.map((point) => ({ ...point })),
          transform: { scale: layout.scale, offsetX: layout.offsetX, offsetY: layout.offsetY },
          rect,
        };
        pendingPointRef.current = null;
        canvas.setPointerCapture(event.pointerId);
        return;
      }
    }

    const bend = findBendAt(x, y);
    if (bend >= 0) {
      onSelectBend(bend);
      return;
    }

    const segment = findSegment(event.clientX, event.clientY);
    if (segment >= 0) {
      onSelectFlange(segment);
      if (segment < profile.bendAngles.length) onSelectBend(segment);
    }
  }

  function renderPendingDrag() {
    frameRef.current = null;
    const drag = dragRef.current;
    const pending = pendingPointRef.current;
    if (!drag || !pending) return;
    drag.points[drag.nodeIndex] = pending;
    drawRef.current?.(drag.points, drag.transform, true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    // Pan while wheel button is held
    if (wheelButtonRef.current) {
      const layout = layoutRef.current;
      if (!layout) return;
      const dx = event.movementX || 0;
      const dy = event.movementY || 0;
      const next = {
        scale: layout.scale,
        offsetX: layout.offsetX + dx * 2,
        offsetY: layout.offsetY + dy * 2,
      };
      viewportRef.current = next;
      drawRef.current?.(undefined, next);
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const x = event.clientX - drag.rect.left;
    const y = event.clientY - drag.rect.top;
    const rawPoint = {
      x: (x - drag.transform.offsetX) / drag.transform.scale,
      y: (y - drag.transform.offsetY) / drag.transform.scale,
    };
    // Orthogonal snap: snap to horizontal/vertical relative to previous point
    const prevPoint = drag.points[drag.nodeIndex - 1] ?? drag.points[0];
    const snappedPoint = snapToOrthogonal(prevPoint, rawPoint);
    pendingPointRef.current = snappedPoint;
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(renderPendingDrag);
    }
  }

  function finishDrag(event: ReactPointerEvent<HTMLCanvasElement>, cancelled = false) {
    // Exit pan mode
    if (wheelButtonRef.current && event.button === 1) {
      wheelButtonRef.current = false;
      panStartRef.current = null;
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const pending = pendingPointRef.current;
    if (pending) drag.points[drag.nodeIndex] = pending;
    dragRef.current = null;
    pendingPointRef.current = null;
    if (cancelled) {
      drawRef.current?.();
      return;
    }
    const next = definitionFromPoints(drag.points, profile.bendRadii);
    if (!next) {
      onInvalidDrag("线段长度需在 10mm 以上");
      drawRef.current?.();
      return;
    }
    viewportRef.current = drag.transform;
    onCommit(next);
    onSelectFlange(Math.max(0, drag.nodeIndex - 1));
    if (next.bendAngles.length > 0) {
      onSelectBend(Math.min(next.bendAngles.length - 1, Math.max(0, drag.nodeIndex - 1)));
    }
    drawRef.current?.(
      buildModelPoints(next.flanges, next.bendAngles, mode === "flat", next)
    );
  }

  function setCanvasZoom(nextPercent: number) {
    const layout = layoutRef.current;
    const current = viewportRef.current;
    if (!layout || !current) return;
    const bounded = Math.round(clamp(nextPercent, 40, 240));
    const factor = bounded / zoomPercent;
    const centerX = size.width / 2;
    const centerY = size.height / 2;
    const next = {
      scale: current.scale * factor,
      offsetX: centerX - (centerX - current.offsetX) * factor,
      offsetY: centerY - (centerY - current.offsetY) * factor,
    };
    viewportRef.current = next;
    setZoomPercent(bounded);
    drawRef.current?.(undefined, next);
  }

  function fitCanvas() {
    viewportRef.current = null;
    setZoomPercent(100);
    drawRef.current?.();
  }

  return (
    <>
      <div className={`canvas-wrap profile-canvas ${profile.flanges.length === 0 ? "empty" : ""}`} ref={wrapRef}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label="二维工件截面画布"
          aria-describedby="profile-canvas-help"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => finishDrag(event)}
          onPointerCancel={(event) => finishDrag(event, true)}
          onContextMenu={(e) => e.preventDefault()}
          onWheel={(event) => {
            event.preventDefault();
            if (wheelButtonRef.current) {
              // Wheel button held → pan the canvas
              const layout = layoutRef.current;
              if (!layout) return;
              const next = {
                scale: layout.scale,
                offsetX: layout.offsetX + event.movementX * 2,
                offsetY: layout.offsetY + event.movementY * 2,
              };
              viewportRef.current = next;
              drawRef.current?.(undefined, next);
            } else {
              // Normal scroll → zoom
              const delta = event.deltaY > 0 ? -10 : 10;
              setCanvasZoom(zoomPercent + delta);
            }
          }}
        />
        <div className="canvas-hint" id="profile-canvas-help"><span />{
          profile.flanges.length === 0
            ? "空白轮廓 · 单击任意点开始绘制，拖出第一段"
            : mode === "flat"
              ? "展开视图用于校核长度 · 返回成形截面可拖动节点"
              : "拖动节点调整 · 空白处单击追加线段 · 点击圆弧编辑 R"
        }</div>
      </div>
      <div className="zoom-strip" aria-label="轮廓画布缩放">
        <button type="button" onClick={() => setCanvasZoom(zoomPercent - 10)} aria-label="缩小轮廓">−</button>
        <button type="button" onClick={() => setCanvasZoom(100)}>{zoomPercent}%</button>
        <button type="button" onClick={() => setCanvasZoom(zoomPercent + 10)} aria-label="放大轮廓">＋</button>
        <button type="button" onClick={fitCanvas}>⌖ 适合画布</button>
      </div>
    </>
  );
}

function PressSimulation({
  stage,
  punchProfile,
  dieProfile,
  vOpening,
  flanges,
  bendAngles,
  criticalBend,
  progress,
  thickness,
  customPunch,
  partFlipped = false,
}: {
  stage: PressStage;
  punchProfile: PunchProfileInput;
  dieProfile: DieProfileInput;
  vOpening: number;
  flanges: number[];
  bendAngles: number[];
  criticalBend: number;
  progress: number;
  thickness: number;
  customPunch?: CustomPunch;
  partFlipped?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 660, height: 430 });
  const [zoom, setZoom] = useState(1);
  const sweep = useMemo(
    () => evaluatePunchSweep(punchProfile, flanges, bendAngles, criticalBend, thickness, customPunch, partFlipped),
    [bendAngles, criticalBend, customPunch, flanges, partFlipped, punchProfile, thickness]
  );
  const normalizedProgress = clamp(progress / 100, 0, 1);
  const currentContacts = useMemo(
    () => sweep.punch ? findPunchContacts(sweep.punch, flanges, bendAngles, criticalBend, normalizedProgress, thickness, partFlipped) : [],
    [bendAngles, criticalBend, flanges, normalizedProgress, partFlipped, sweep.punch, thickness]
  );
  const currentCollision = currentContacts.length > 0;

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: Math.max(360, Math.floor(entry.contentRect.width)),
        height: Math.min(Math.max(320, Math.floor(entry.contentRect.height)), 500),
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size.width, size.height);

    const die = dieProfileValue(dieProfile);
    const catalogDie = die.polygon?.length ? die.polygon : null;
    const catalogTopY = catalogDie ? Math.min(...catalogDie.map((point) => point.y)) : 0;
    const catalogCenterPoints = catalogDie?.filter((point) => Math.abs(point.x) <= Math.max(1, vOpening * 0.15)) ?? [];
    const vDepth = catalogCenterPoints.length
      ? Math.max(...catalogCenterPoints.map((point) => point.y)) - catalogTopY
      : Math.max(9, (vOpening / 2) / Math.tan((die.includedAngle / 2) * (Math.PI / 180)));
    const dieWorld: Point[] = catalogDie
      ? catalogDie.map((point) => ({ x: point.x, y: point.y - catalogTopY }))
      : [
          { x: -die.bottomHalfWidth, y: die.height },
          { x: -die.halfWidth, y: 0 },
          { x: -vOpening / 2, y: 0 },
          { x: 0, y: vDepth },
          { x: vOpening / 2, y: 0 },
          { x: die.halfWidth, y: 0 },
          { x: die.bottomHalfWidth, y: die.height },
        ];
    const buildPose = (poseProgress: number, simAngles: number[]) => {
      const targetAngle = simAngles[criticalBend] ?? 90;
      const includedAngle = currentPressAngle(targetAngle, poseProgress);
      const supportDepth = includedAngle >= 179.5
        ? 0
        : (vOpening / 2) / Math.tan((includedAngle / 2) * (Math.PI / 180));
      const partPivotY = Math.min(Math.max(0, vDepth - thickness * 0.35), supportDepth);
      const punchTipY = poseProgress < PUNCH_CONTACT_PROGRESS
        ? -PUNCH_APPROACH_GAP * (1 - poseProgress / PUNCH_CONTACT_PROGRESS)
        : partPivotY;
      const partModel = buildPressPartModel(flanges, simAngles, criticalBend, poseProgress, partFlipped);
      return {
        partPivotY,
        punchTipY,
        pivotIndex: partModel.pivotIndex,
        part: partModel.points.map((point) => ({ x: point.x, y: point.y + partPivotY })),
        punch: sweep.punch?.polygon.map((point) => ({ x: point.x, y: point.y + punchTipY })) || [],
      };
    };
    const pose = buildPose(normalizedProgress, bendAngles);
    const fitPoints = [
      ...dieWorld,
      ...buildPose(0, bendAngles).part,
      ...buildPose(0, bendAngles).punch,
      ...buildPose(PUNCH_CONTACT_PROGRESS, bendAngles).part,
      ...buildPose(PUNCH_CONTACT_PROGRESS, bendAngles).punch,
      ...buildPose(0.55, bendAngles).part,
      ...buildPose(0.55, bendAngles).punch,
      ...buildPose(1, bendAngles).part,
      ...buildPose(1, bendAngles).punch,
    ];
    const xs = fitPoints.map((point) => point.x);
    const ys = fitPoints.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const paddingX = 36;
    const paddingY = 24;
    const worldScale = Math.min(
      (size.width - paddingX * 2) / Math.max(80, maxX - minX),
      (size.height - paddingY * 2) / Math.max(100, maxY - minY)
    );
    const offsetX = (size.width - (maxX - minX) * worldScale) / 2 - minX * worldScale;
    const offsetY = (size.height - (maxY - minY) * worldScale) / 2 - minY * worldScale;
    const toScreen = (point: Point) => ({
      x: point.x * worldScale + offsetX,
      y: point.y * worldScale + offsetY,
    });
    const pivot = toScreen({ x: 0, y: pose.partPivotY });

    ctx.strokeStyle = "rgba(89, 107, 98, .13)";
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, pivot.y);
    ctx.lineTo(size.width, pivot.y);
    ctx.moveTo(pivot.x, 0);
    ctx.lineTo(pivot.x, size.height);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.save();
    ctx.translate(pivot.x, pivot.y);
    ctx.scale(zoom, zoom);
    ctx.translate(-pivot.x, -pivot.y);

    const screenDie = dieWorld.map(toScreen);
    const dieMark = dieMarkProfile(dieProfile);
    ctx.fillStyle = dieMark === "hd85" ? "#6f8ba8" : dieMark === "sl85" ? "#89a2bb" : "#7894b1";
    ctx.strokeStyle = "#617d99";
    ctx.lineWidth = 1;
    ctx.beginPath();
    screenDie.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    const screenPunch = pose.punch.map(toScreen);
    ctx.fillStyle = "#426b96";
    ctx.strokeStyle = "#31597f";
    ctx.lineWidth = 1;
    ctx.beginPath();
    screenPunch.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    const screenPoints = pose.part.map(toScreen);
    const targetAngle = bendAngles[criticalBend] ?? 90;
    const displayedAngle = currentPressAngle(targetAngle, normalizedProgress);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    screenPoints.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.strokeStyle = "#65706d";
    ctx.lineWidth = 6.5;
    ctx.stroke();
    ctx.strokeStyle = "#aeb4b1";
    ctx.lineWidth = 4.5;
    ctx.stroke();

    screenPoints.slice(1, -1).forEach((point, index) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, index + 1 === pose.pivotIndex ? 5.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = index + 1 === pose.pivotIndex ? "#426b96" : "#78857f";
      ctx.lineWidth = index + 1 === pose.pivotIndex ? 2.5 : 1.5;
      ctx.stroke();
    });

    ctx.font = "700 10px Arial";
    ctx.fillStyle = "#426b96";
    ctx.textAlign = "left";
    ctx.fillText(`B${criticalBend + 1} · ${Math.round(displayedAngle)}°${partFlipped ? " · 调头" : ""}`, pivot.x + 12, pivot.y + 18);

    if (currentCollision) {
      const worldContact = {
        x: currentContacts[0].x,
        y: currentContacts[0].y + pose.partPivotY,
      };
      const marker = toScreen(worldContact);
      ctx.fillStyle = "rgba(220, 71, 61, .18)";
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, 17, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#dc473d";
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 9px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("1", marker.x, marker.y + 0.5);
    } else if (!sweep.collision) {
      ctx.strokeStyle = "rgba(65, 183, 122, .7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(pivot.x, pivot.y, 14, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }, [bendAngles, criticalBend, currentCollision, currentContacts, dieProfile, flanges, normalizedProgress, partFlipped, size, sweep.collision, sweep.punch, thickness, vOpening, zoom]);

  const stateText = currentCollision
    ? `当前姿态发现 ${currentContacts.length} 处干涉`
    : sweep.collision
      ? `干涉始于约 ${Math.round((sweep.firstCollisionProgress ?? 0) * 100)}% 行程`
      : `${sweep.samples.length} 个行程采样点上模避让通过`;

  return (
    <div className="canvas-wrap press-canvas" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        aria-label="折弯模具二维碰撞模拟"
        data-punch-profile={sweep.punch?.id ?? ""}
        data-punch-points={sweep.punch?.polygon.length ?? 0}
        onWheel={(event) => {
          event.preventDefault();
          setZoom((current) => clamp(current + (event.deltaY < 0 ? 0.1 : -0.1), 0.7, 1.8));
        }}
      />
      <div className={`simulation-state ${currentCollision || sweep.collision ? "bad" : "good"}`}>
        <span />{stateText}
      </div>
      <div className="simulation-view-badge">完整工件 · {partFlipped ? "调头 · " : "正向 · "}{stage === "flat" ? "板材支承" : stage === "pressed" ? "压合" : normalizedProgress < PUNCH_CONTACT_PROGRESS ? "上模接近" : "折弯行程"}</div>
      <div className="simulation-zoom" aria-label="模拟画布缩放">
        <button type="button" onClick={() => setZoom((current) => clamp(current - 0.1, 0.7, 1.8))}>−</button>
        <button type="button" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
        <button type="button" onClick={() => setZoom((current) => clamp(current + 0.1, 0.7, 1.8))}>＋</button>
      </div>
    </div>
  );
}

function SimulationPlayer({
  progress,
  playing,
  targetAngle,
  onProgress,
  onToggle,
}: {
  progress: number;
  playing: boolean;
  targetAngle: number;
  onProgress: (value: number) => void;
  onToggle: () => void;
}) {
  const currentAngle = currentPressAngle(targetAngle, progress / 100);
  return (
    <div className="simulation-player">
      <button type="button" className="play-button" onClick={onToggle} aria-label={playing ? "暂停折弯模拟" : "播放折弯模拟"}>
        {playing ? "Ⅱ" : "▶"}
      </button>
      <span className="player-label">上止点</span>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={progress}
        onChange={(event) => onProgress(Number(event.target.value))}
        aria-label="折弯模拟行程"
      />
      <span className="player-label">压合</span>
      <strong>{Math.round(currentAngle)}°<small>{Math.round(progress)}% 行程</small></strong>
    </div>
  );
}

function BendSequenceEditor({
  sequence,
  activePosition,
  bendAngles,
  compact = false,
  playingAll = false,
  evaluation,
  onSelect,
  onMove,
  onAuto,
  onPlayAll,
}: {
  sequence: number[];
  activePosition: number;
  bendAngles: number[];
  compact?: boolean;
  playingAll?: boolean;
  evaluation?: SequenceEvaluation;
  onSelect: (position: number) => void;
  onMove: (position: number, direction: -1 | 1) => void;
  onAuto: () => void;
  onPlayAll?: () => void;
}) {
  const flippedSteps = evaluation?.flips.filter(Boolean).length ?? 0;
  const collidingBends = evaluation
    ? sequence.filter((_, position) => evaluation.collisionByPosition[position]).map((bend) => `B${bend + 1}`)
    : [];
  const intermediateCount = evaluation?.intermediateAngles?.filter((a, i) => a !== (bendAngles[evaluation.sequence[i]] ?? 90)).length ?? 0;
  const sequenceSummary = evaluation
    ? evaluation.collisionSteps > 0
      ? `! ${evaluation.collisionSteps}/${sequence.length} 道干涉 · ${collidingBends.join("、")}`
      : `✓ 上模避让 ${sequence.length}/${sequence.length} 道通过${flippedSteps > 0 ? ` · ${flippedSteps} 道调头` : ""}${intermediateCount > 0 ? ` · ${intermediateCount} 道中间角度避让` : ""}`
    : "碰撞优先 · 短边先折";
  return (
    <section className={`bend-sequence-editor ${compact ? "compact" : ""}`} aria-label="折弯工序顺序">
      <div className="sequence-heading">
        <div><strong>折弯顺序</strong><span role="status" aria-live="polite" className={evaluation?.collisionSteps ? "warning" : ""}>{sequenceSummary}</span></div>
        <div>
          <button type="button" className="sequence-auto" onClick={onAuto}>✦ 自动避碰排刀</button>
          {onPlayAll && (
            <button type="button" className={`sequence-play ${playingAll ? "active" : ""}`} onClick={onPlayAll}>
              {playingAll ? "Ⅱ 暂停全部" : "▶ 播放全部"}
            </button>
          )}
        </div>
      </div>
      <div className="sequence-items">
        {sequence.map((bend, position) => {
          const hasCollision = evaluation?.collisionByPosition[position] ?? false;
          const isFlipped = evaluation?.flips[position] ?? false;
          const interAngle = evaluation?.intermediateAngles?.[position];
          const usesIntermediate = interAngle !== undefined && interAngle !== bendAngles[bend];
          const displayAngle = usesIntermediate ? interAngle : (bendAngles[bend] ?? 90);
          const poseLabel = hasCollision
            ? `${isFlipped ? "调头" : "正向"}仍有干涉`
            : usesIntermediate
              ? `暂以${interAngle}°避让`
              : isFlipped ? "调头通过" : "正向通过";
          return (
            <div className={`sequence-item ${activePosition === position ? "active" : position < activePosition ? "done" : "pending"} ${hasCollision ? "collision" : "clear"} ${isFlipped ? "flipped" : ""} ${usesIntermediate ? "intermediate" : ""}`} key={`sequence-${bend}`}>
              <button type="button" className="sequence-main" onClick={() => onSelect(position)} aria-label={`选择第 ${position + 1} 道工序，折弯 B${bend + 1}，${poseLabel}`}>
                <small>{String(position + 1).padStart(2, "0")}</small>
                <strong>B{bend + 1}</strong>
                <span>{displayAngle}°</span>
                <em>{hasCollision ? `! ${isFlipped ? "调头" : "正向"}仍干涉` : usesIntermediate ? `◇ 先${interAngle}°后${bendAngles[bend]}°` : isFlipped ? "↔ 调头通过" : "✓ 正向通过"}</em>
              </button>
              <div className="sequence-move">
                <button type="button" disabled={position === 0} onClick={() => onMove(position, -1)} aria-label={`将折弯 B${bend + 1} 前移`}>←</button>
                <button type="button" disabled={position === sequence.length - 1} onClick={() => onMove(position, 1)} aria-label={`将折弯 B${bend + 1} 后移`}>→</button>
              </div>
            </div>
          );
        })}
      </div>
      {!compact && <p>避碰排刀会比较全部顺序和正向/调头姿态；仍需按实际下模、后挡料与装夹复核。</p>}
    </section>
  );
}

function Field({
  label,
  value,
  unit,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(null);
  }, [value, editing]);

  const commit = () => {
    if (draft == null) {
      setEditing(false);
      return;
    }
    const num = Number(draft);
    if (Number.isNaN(num)) {
      setDraft(null);
      setEditing(false);
      return;
    }
    onChange(clamp(num, min ?? -Infinity, max ?? Number.POSITIVE_INFINITY));
    setEditing(false);
  };

  return (
    <label className="field numeric-field">
      <span>{label}</span>
      <div>
        <input
          type="number"
          value={editing ? (draft != null ? draft : '') : value}
          min={min}
          max={max}
          step={step}
          onFocus={() => { setEditing(true); setDraft(null); }}
          onBlur={commit}
          onChange={(e) => {
            const v = e.target.value.trim();
            setDraft(v === '' ? null : Number(v));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
        <em>{unit}</em>
      </div>
    </label>
  );
}

function CommitField({
  label,
  value,
  unit,
  min,
  max,
  step = 1,
  onCommit,
}: {
  label: string;
  value: number;
  unit: string;
  min: number;
  max?: number;
  step?: number;
  onCommit: (value: number) => void;
}) {
  function commit(input: HTMLInputElement) {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) {
      input.value = String(value);
      return;
    }
    const next = Math.round(clamp(parsed, min, max ?? Number.POSITIVE_INFINITY) * 10) / 10;
    input.value = String(next);
    if (next !== value) onCommit(next);
  }

  return (
    <label className="field numeric-field commit-field">
      <span>{label}</span>
      <div>
        <input
          key={`${label}-${value}`}
          type="number"
          inputMode="decimal"
          defaultValue={value}
          min={min}
          max={max}
          step={step}
          onBlur={(event) => commit(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = String(value);
              event.currentTarget.blur();
            }
          }}
        />
        <em>{unit}</em>
      </div>
    </label>
  );
}


export function ToolAdvisor() {
  const [step, setStep] = useState(1);
  const [selectedSystem, setSelectedSystem] = useState<string | null>(null);
  const [materialKey, setMaterialKey] = useState<MaterialKey>("dc01");
  const [thickness, setThickness] = useState(2);
  const [bendLength, setBendLength] = useState(1000);
  const [flanges, setFlanges] = useState<number[]>([]);
  const [bendAngles, setBendAngles] = useState<number[]>([]);
  const [bendRadii, setBendRadii] = useState<number[]>([]);
  const [bendDirections, setBendDirections] = useState<BendDirection[]>([]);
  const [profileMeta, setProfileMeta] = useState<{
    bendRadii: number[];
    bendDirections: BendDirection[];
    startAngle: number;
  }>({ bendRadii: [], bendDirections: [], startAngle: -90 });
  const profileDefinition = useMemo<ProfileDefinition>(() => ({
    flanges,
    bendAngles,
    bendRadii: bendRadii.length === bendAngles.length
      ? bendRadii
      : bendAngles.map((_, i) => 1),
    bendDirections: bendDirections.length === bendAngles.length
      ? bendDirections
      : bendAngles.map(() => 1 as BendDirection),
    startAngle: profileMeta.startAngle ?? -90,
  }), [flanges, bendAngles, bendRadii, bendDirections, profileMeta]);
  const profileReady = validProfileDefinition(profileDefinition);
  const [selectedFlange, setSelectedFlange] = useState(0);
  const [selectedBend, setSelectedBend] = useState(0);
  const [bendSequence, setBendSequence] = useState(() => autoSequenceOrder(0, []));
  const [sequencePosition, setSequencePosition] = useState(0);
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("formed");
  const [bendProgress, setBendProgress] = useState(0);
  const [simulationPlaying, setSimulationPlaying] = useState(false);
  const [playingAll, setPlayingAll] = useState(false);
  const [sortBy, setSortBy] = useState("versatility");
  const [selectedSolution, setSelectedSolution] = useState("load");
  const [custom, setCustom] = useState({ throat: 48, height: 135, body: 42, tipRadius: 1 });
  const [customProfileActive, setCustomProfileActive] = useState(false);
  const [customAdopted, setCustomAdopted] = useState(false);
  const [lengthPlan, setLengthPlan] = useState("835");
  const [toast, setToast] = useState("");
  const [savedAt, setSavedAt] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryPunchArticle, setLibraryPunchArticle] = useState<string | null>(null);
  const [libraryDieArticle, setLibraryDieArticle] = useState<string | null>(null);
  const [catalogGeometries, setCatalogGeometries] = useState<Record<string, Point[]>>({});
  const [dxfLoadProgress, setDxfLoadProgress] = useState<{ loaded: number; total: number; failed: string[] }>({ loaded: 0, total: 0, failed: [] });
  const [customerInfo, setCustomerInfo] = useState<CustomerInfo>(EMPTY_CUSTOMER);
  const [quoteGenerating, setQuoteGenerating] = useState(false);
  const [quoteDeliveryStatus, setQuoteDeliveryStatus] = useState("PDF 将下载到本地；绑定后台邮箱后同步抄送");

  const material = MATERIALS[materialKey];
  const libraryPunchTool = findCtgTool(libraryPunchArticle);
  const libraryDieTool = findCtgTool(libraryDieArticle);
  const libraryPunchProfile = useMemo(
    () => libraryPunchTool ? buildLibraryPunchProfile(libraryPunchTool, catalogGeometries[libraryPunchTool.articleNumber]) : null,
    [catalogGeometries, libraryPunchTool]
  );
  const libraryDieProfile = useMemo(
    () => libraryDieTool ? buildLibraryDieProfile(libraryDieTool, catalogGeometries[libraryDieTool.articleNumber]) : null,
    [catalogGeometries, libraryDieTool]
  );
  const criticalBend = bendSequence[sequencePosition] ?? 0;
  const simulationAngles = useMemo(
    () => buildSequenceAngles(bendAngles, bendSequence, sequencePosition),
    [bendAngles, bendSequence, sequencePosition]
  );
    const pressStage: PressStage = bendProgress <= 5 ? "flat" : bendProgress >= 95 ? "pressed" : "open";
  const recommendedVOpening = recommendV(thickness, material);
  const libraryDieVOpening = ukbDieVOpening(libraryDieTool);
  const vOpening = selectedSolution === "library" && libraryDieVOpening !== null
    ? libraryDieVOpening
    : recommendedVOpening;
  const insideRadius = Math.max(1, material.radiusRatio * vOpening);
  const minimumFlange = 0.7 * vOpening + 0.5 * thickness;
  const force = (1.42 * material.tensile * bendLength * thickness * thickness) / (1000 * vOpening);
  const requiredThroat = Math.ceil(Math.max(...flanges) * 0.48 + thickness * 2);
  
  const solutions = useMemo<Solution[]>(() => {
    const items: Solution[] = [];
    const scoredItems: Array<{ solution: Solution; collisionSteps: number; totalCollidingSamples: number }> = [];

    // --- CTG catalog-based recommendations ---
    const systemMatches = (tool?: CtgToolRecord) => !tool || !selectedSystem || tool.system === selectedSystem;
    
    // Filter straight punches (most versatile for general bending)
    const candidatePunches = CTG_TOOLS.filter((tool) => {
      if (tool.kind !== "punch") return false;
      if (!systemMatches(tool)) return false;
      if (/flattening|adapter|accessory/i.test(tool.family)) return false;
      if (tool.family !== "straight-punch" && tool.family !== "radius-punch") return false;
      return true;
    });
    
    // Filter single-V dies with V-opening compatible with thickness
    // Single-V dies lack explicit vOpeningMm; use height as proxy for V-size in scoring
    // Don't hard-filter by height — let scoring pick the best match
    const candidateDies = CTG_TOOLS.filter((tool) => {
      if (tool.kind !== "die") return false;
      if (!systemMatches(tool)) return false;
      if (tool.family !== "single-v-die") return false;
      return true;
    });

    // If user has explicitly selected both library tools, prioritize that combo
    let explicitLibraryCheck: SequenceEvaluation | null = null;
    if (
      libraryPunchTool
      && libraryDieTool
      && systemMatches(libraryPunchTool)
      && systemMatches(libraryDieTool)
      && ukbSystemsCompatible(libraryPunchTool, libraryDieTool)
    ) {
      const punch = libraryPunchProfile ?? buildLibraryPunchProfile(libraryPunchTool);
      const die = libraryDieProfile ?? buildLibraryDieProfile(libraryDieTool, catalogGeometries[libraryDieTool.articleNumber]);
      explicitLibraryCheck = evaluateBendSequence(punch, flanges, bendAngles, bendSequence, thickness);
    }

    // Build and score compatible punch/die pairs
    const maxSolutions = 15;
    const maxEvals = 200;
    let evalCount = 0;
    
    // Group dies by heightMm (proxy for V-opening for single-V dies)
    const diesByHeight = new Map<number, CtgToolRecord[]>();
    for (const dieTool of candidateDies) {
      const h = Math.round(dieTool.heightMm ?? 80);
      const existing = diesByHeight.get(h) ?? [];
      existing.push(dieTool);
      diesByHeight.set(h, existing);
    }
    
    // For each punch, find best matching dies
    for (const punchTool of candidatePunches) {
      if (evalCount >= maxEvals) break;
      const punchProfile = buildLibraryPunchProfile(punchTool, catalogGeometries[punchTool.articleNumber]);
      
      // Find best die for this punch based on height/V-opening match
      let bestDie: { tool: CtgToolRecord; profile: DieProfile; heightDiff: number } | null = null;
      
      for (const [h, dies] of diesByHeight.entries()) {
        if (evalCount >= maxEvals) break;

        const dieTool = dies.find((candidate) => ukbSystemsCompatible(punchTool, candidate));
        if (!dieTool) continue;
        const dieProfile = buildLibraryDieProfile(dieTool, catalogGeometries[dieTool.articleNumber]);
        const heightDiff = Math.abs(h - (vOpening * 1.5)); // height correlates with V-opening
        
        if (!bestDie || heightDiff < bestDie.heightDiff) {
          bestDie = { tool: dieTool, profile: dieProfile, heightDiff };
        }
        
        evalCount++;
      }
      
      if (!bestDie) continue;
      
      const check = evaluateBendSequence(punchProfile, flanges, bendAngles, bendSequence, thickness);
      const cadReady = Boolean(catalogGeometries[punchTool.articleNumber]);
      const dieCadReady = Boolean(catalogGeometries[bestDie.tool.articleNumber]);
      const dieVKnown = ukbDieVOpening(bestDie.tool) !== null;
      const collisionPenalty = check.collisionSteps * 10 + check.totalCollidingSamples * 0.5;
      const throatPenalty = Math.max(0, punchProfile.throat - requiredThroat) * 0.5;
      const vMatchBonus = Math.max(0, 15 - bestDie.heightDiff * 0.3);
      const capacityBonus = Math.min(1000, punchProfile.height + bestDie.profile.height) * 0.02;
      const cadBonus = cadReady ? 8 : 0;
      
      const baseScore = Math.round(clamp(96 - Math.abs(vOpening - thickness * 8) * 1.4, 70, 98));
      const score = Math.round(clamp(baseScore + cadBonus + vMatchBonus - collisionPenalty - throatPenalty + capacityBonus, 50, 98));
      
      const solution: Solution = {
        id: `ukb-${punchTool.id}-${bestDie.tool.id}`,
        name: `${punchTool.system} 推荐组合`,
        punchArticle: punchTool.articleNumber,
        dieArticle: bestDie.tool.articleNumber,
        punchProfile,
        dieProfile: bestDie.profile,
        punch: `${punchTool.articleNumber} · ${punchTool.name}`,
        die: `${bestDie.tool.articleNumber} · ${bestDie.tool.name}`,
        throat: punchProfile.throat,
        height: punchProfile.height,
        capacity: Math.round(600 + (bestDie.profile.halfWidth - 30) * 15),
        score,
        price: 0,
        owned: false,
        collision: check.collisionSteps > 0,
        collisionSteps: check.collisionSteps,
        tags: [
          cadReady ? "DXF 校验上模" : "目录参数上模",
          dieCadReady ? "DXF 校验下模" : dieVKnown ? "CTG 下模" : "目录参数下模",
          check.collisionSteps === 0 ? "全序通过" : `${check.collisionSteps} 道干涉`,
        ],
        source: "ukb-library",
      };
      scoredItems.push({ solution, collisionSteps: check.collisionSteps, totalCollidingSamples: check.totalCollidingSamples });
    }

    // Sort: collision-free first, then by score desc
    scoredItems.sort((a, b) => {
      if (a.collisionSteps !== b.collisionSteps) return a.collisionSteps - b.collisionSteps;
      return b.solution.score - a.solution.score;
    });

    // Take top N unique solutions
    const seen = new Set<string>();
    for (const item of scoredItems) {
      if (seen.has(item.solution.id)) continue;
      seen.add(item.solution.id);
      items.push(item.solution);
      if (items.length >= maxSolutions) break;
    }

    // Apply user sort order
    if (sortBy === "price") items.sort((a, b) => a.price - b.price);
    else if (sortBy === "capacity") items.sort((a, b) => b.capacity - a.capacity);
    else items.sort((a, b) => b.score - a.score);

    // Insert explicit library selection at top if it exists
    if (explicitLibraryCheck) {
      const punch = libraryPunchProfile ?? buildLibraryPunchProfile(libraryPunchTool!);
      const die = libraryDieProfile ?? buildLibraryDieProfile(libraryDieTool!, catalogGeometries[libraryDieTool!.articleNumber]);
      const cadReady = Boolean(libraryPunchTool && catalogGeometries[libraryPunchTool.articleNumber]);
      const dieCadReady = Boolean(libraryDieTool && catalogGeometries[libraryDieTool.articleNumber]);
      const dieVKnown = !libraryDieTool || ukbDieVOpening(libraryDieTool) !== null;
      const libSolution: Solution = {
        id: "library",
        name: "当前自选组合",
        punchArticle: libraryPunchTool?.articleNumber,
        dieArticle: libraryDieTool?.articleNumber,
        punchProfile: punch,
        dieProfile: die,
        punch: libraryPunchTool ? `${libraryPunchTool.articleNumber} · ${libraryPunchTool.name}` : "—",
        die: libraryDieTool ? `${libraryDieTool.articleNumber} · ${libraryDieTool.name}` : "—",
        throat: punch.throat,
        height: punch.height,
        capacity: 600,
        score: cadReady ? 96 : 84,
        price: 0,
        owned: true,
        collision: explicitLibraryCheck.collisionSteps > 0,
        collisionSteps: explicitLibraryCheck.collisionSteps,
        tags: [
          cadReady ? "DXF 校验上模" : "上模 CAD 缺失",
          libraryDieTool ? dieCadReady ? "DXF 校验下模" : dieVKnown ? "CTG 下模" : "下模 V 口待核" : "标准下模",
          selectedSystem ? `系统 ${selectedSystem}` : "",
          explicitLibraryCheck.collisionSteps === 0 ? "全序通过" : `${explicitLibraryCheck.collisionSteps} 道干涉`,
        ].filter(Boolean),
        source: "ukb-library",
      };
      items.unshift(libSolution);
    }

    return items;
  }, [bendAngles, bendSequence, catalogGeometries, flanges, libraryDieProfile, libraryDieTool, libraryDieVOpening, libraryPunchProfile, libraryPunchTool, sortBy, thickness, vOpening, requiredThroat, selectedSystem]);

  const selected = solutions.find((solution) => solution.id === selectedSolution) ?? solutions[0];
  const punchChoices = useMemo(() => {
    const seen = new Set<string>();
    return solutions.flatMap((solution) => {
      if (!solution.punchArticle || seen.has(solution.punchArticle)) return [];
      const tool = findCtgTool(solution.punchArticle);
      if (!tool) return [];
      seen.add(solution.punchArticle);
      return [{
        tool,
        profile: solution.punchProfile,
        score: solution.score,
        collisionSteps: solution.collisionSteps,
      }];
    }).slice(0, 15);
  }, [solutions]);
  const dieChoices = useMemo(() => {
    const activePunchTool = findCtgTool(selected.punchArticle) ?? libraryPunchTool;
    const scored = CTG_TOOLS
      .filter((tool) => {
        if (tool.kind !== "die" || tool.family !== "single-v-die") return false;
        if (selectedSystem && tool.system !== selectedSystem) return false;
        if (activePunchTool && !ukbSystemsCompatible(activePunchTool, tool)) return false;
        return Boolean(catalogGeometries[tool.articleNumber]) || ukbDieVOpening(tool) !== null;
      })
      .map((tool) => {
        const profile = buildLibraryDieProfile(tool, catalogGeometries[tool.articleNumber]);
        const opening = ukbDieVOpening(tool);
        const matchDistance = opening === null
          ? Math.abs(profile.height - vOpening * 1.5)
          : Math.abs(opening - vOpening) * 4;
        return { tool, profile, matchDistance, cadReady: Boolean(catalogGeometries[tool.articleNumber]) };
      })
      .sort((left, right) => {
        if (left.matchDistance !== right.matchDistance) return left.matchDistance - right.matchDistance;
        if (left.cadReady !== right.cadReady) return left.cadReady ? -1 : 1;
        return left.tool.articleNumber.localeCompare(right.tool.articleNumber, "zh-CN", { numeric: true });
      });
    const activeIndex = scored.findIndex((choice) => choice.tool.articleNumber === selected.dieArticle);
    if (activeIndex > 0) scored.unshift(...scored.splice(activeIndex, 1));
    return scored;
  }, [catalogGeometries, libraryPunchTool, selected.dieArticle, selected.punchArticle, selectedSystem, vOpening]);

  useEffect(() => {
    if (step !== 3 || selectedSolution === "library") return;
    const initialPunch = libraryPunchTool ?? findCtgTool(selected.punchArticle);
    const initialDie = libraryDieTool ?? findCtgTool(selected.dieArticle);
    if (
      !initialPunch
      || initialPunch.kind !== "punch"
      || !initialDie
      || initialDie.kind !== "die"
      || !ukbSystemsCompatible(initialPunch, initialDie)
    ) return;
    setLibraryPunchArticle(initialPunch.articleNumber);
    setLibraryDieArticle(initialDie.articleNumber);
    setSelectedSolution("library");
  }, [libraryDieTool, libraryPunchTool, selected.dieArticle, selected.punchArticle, selectedSolution, step]);

  const selectedLibraryDieVUnknown = selected.source === "ukb-library"
    && Boolean(libraryDieTool)
    && libraryDieVOpening === null;
  const standardSequenceEvaluation = useMemo(
    () => evaluateBendSequence(selected.punchProfile, flanges, bendAngles, bendSequence, thickness),
    [bendAngles, bendSequence, flanges, selected.punchProfile, thickness]
  );
  const customSequenceEvaluation = useMemo(
    () => evaluateBendSequence(
      selected.punchProfile,
      flanges,
      bendAngles,
      bendSequence,
      thickness,
      customProfileActive ? custom : undefined
    ),
    [bendAngles, bendSequence, custom, customProfileActive, flanges, selected.punchProfile, thickness]
  );
  const activeSequenceEvaluation = step === 4 ? customSequenceEvaluation : standardSequenceEvaluation;
  const activePartFlipped = activeSequenceEvaluation.flips[sequencePosition] ?? false;
  const currentStandardCollision = standardSequenceEvaluation.collisionByPosition[sequencePosition] ?? false;
  const customCollision = customSequenceEvaluation.collisionSteps > 0 || (customProfileActive && custom.body > 56);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = localStorage.getItem("bendpilot-project");
      if (!saved) return;
      try {
        const project = JSON.parse(saved) as {
          schemaVersion?: number;
          materialKey?: MaterialKey;
          thickness?: number;
          bendLength?: number;
          flanges?: number[];
          bendAngles?: number[];
          bendSequence?: number[];
          libraryPunchArticle?: string | null;
          libraryDieArticle?: string | null;
        };
        if (project.schemaVersion !== 2) {
          localStorage.removeItem("bendpilot-project");
          return;
        }
        if (project.materialKey) setMaterialKey(project.materialKey);
        if (project.thickness) setThickness(project.thickness);
        if (project.bendLength) setBendLength(project.bendLength);
        let restoredGeometries: Record<string, Point[]> = {};
        try {
          const storedGeometryText = localStorage.getItem(DXF_GEOMETRY_STORAGE_KEY);
          restoredGeometries = storedGeometryText
            ? parseStoredDxfGeometries(JSON.parse(storedGeometryText)) ?? {}
            : {};
        } catch {
          restoredGeometries = {};
        }
        if (Object.keys(restoredGeometries).length) setCatalogGeometries(restoredGeometries);
        const restoredPunch = findCtgTool(project.libraryPunchArticle);
        const restoredDie = findCtgTool(project.libraryDieArticle);
        const validPunch = restoredPunch?.kind === "punch" && restoredGeometries[restoredPunch.articleNumber]
          ? restoredPunch
          : undefined;
        const validDie = restoredDie?.kind === "die" && ukbDieVOpening(restoredDie) !== null
          ? restoredDie
          : undefined;
        const compatibleDie = validPunch && validDie && !ukbSystemsCompatible(validPunch, validDie)
          ? undefined
          : validDie;
        if (validPunch) setLibraryPunchArticle(validPunch.articleNumber);
        if (compatibleDie) setLibraryDieArticle(compatibleDie.articleNumber);
        if (validPunch || compatibleDie) setSelectedSolution("library");
        if (validDie && !compatibleDie) {
          setToast(`已恢复 ${validPunch?.system} 上模；${validDie.system} 下模因系统不兼容未载入`);
        }
        const savedFlanges = Array.isArray(project.flanges) && project.flanges.length >= 2
          ? project.flanges.filter((value) => Number.isFinite(value)).slice(0, 6)
          : null;
        const savedAngles = Array.isArray(project.bendAngles)
          ? project.bendAngles.filter((value) => Number.isFinite(value)).slice(0, 5)
          : null;
        if (savedFlanges) setFlanges(savedFlanges);
        if (savedAngles && savedFlanges && savedAngles.length === savedFlanges.length - 1) {
          setBendAngles(savedAngles);
          setBendSequence(normalizeSequence(project.bendSequence ?? [], savedAngles.length, savedFlanges));
          setSequencePosition(0);
        }
      } catch {
        localStorage.removeItem("bendpilot-project");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = localStorage.getItem(DXF_GEOMETRY_STORAGE_KEY);
        if (!saved) return;
        const cleaned = parseStoredDxfGeometries(JSON.parse(saved));
        if (!cleaned) {
          localStorage.removeItem(DXF_GEOMETRY_STORAGE_KEY);
          return;
        }
        setCatalogGeometries(cleaned);
      } catch {
        try {
          localStorage.removeItem(DXF_GEOMETRY_STORAGE_KEY);
        } catch {
          // Storage may be unavailable in private or quota-restricted contexts.
        }
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setBendSequence((current) => {
        const next = normalizeSequence(current, bendAngles.length, flanges);
        return next.length === current.length && next.every((bend, index) => bend === current[index])
          ? current
          : next;
      });
      setSequencePosition((current) => Math.round(clamp(current, 0, Math.max(0, bendAngles.length - 1))));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [bendAngles.length, flanges]);

  useEffect(() => {
    if (selectedSystem) {
      if (libraryPunchTool && libraryPunchTool.system !== selectedSystem) {
        setLibraryPunchArticle(null);
      }
      if (libraryDieTool && libraryDieTool.system !== selectedSystem) {
        setLibraryDieArticle(null);
      }
    }
  }, [selectedSystem]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    try {
      const savedCustomer = localStorage.getItem("bendpilot-customer");
      if (!savedCustomer) return;
      const parsed = JSON.parse(savedCustomer) as Partial<CustomerInfo>;
      setCustomerInfo({
        company: typeof parsed.company === "string" ? parsed.company : "",
        contact: typeof parsed.contact === "string" ? parsed.contact : "",
        phone: typeof parsed.phone === "string" ? parsed.phone : "",
        email: typeof parsed.email === "string" ? parsed.email : "",
        address: typeof parsed.address === "string" ? parsed.address : "",
        note: typeof parsed.note === "string" ? parsed.note : "",
      });
    } catch {
      localStorage.removeItem("bendpilot-customer");
    }
  }, []);

  // Auto-load all DXF files from public/dxf/ on startup
  useEffect(() => {
    const dxfArticleToCatalogNumber = (raw: string): string => {
      if (raw.includes(".")) return raw;
      if (raw.length > 3) return raw.slice(0, -3) + "." + raw.slice(-3);
      return raw;
    };

    const timer = window.setTimeout(async () => {
      try {
        // dxfArticles contains article numbers without .dxf extension (e.g. "10115")
        const articleNames = dxfArticles as string[];
        if (articleNames.length === 0) return;

        setDxfLoadProgress({ loaded: 0, total: articleNames.length, failed: [] });
        const geometries: Record<string, Point[]> = {};

        for (let i = 0; i < articleNames.length; i += MAX_DXF_BATCH) {
          const batch = articleNames.slice(i, i + MAX_DXF_BATCH);
          const results = await Promise.all(
            batch.map(async (articleNumber) => {
              try {
                const url = `${DXF_DIR}/${articleNumber}.dxf`;
                const resp = await fetch(url);
                if (!resp.ok) return { ok: false, article: articleNumber, error: "fetch failed" };
                const text = await resp.text();
                if (!text.includes("SECTION")) return { ok: false, article: articleNumber, error: "not a valid DXF" };
                const parsed = parseDxfContour(text, { entryName: articleNumber });
                const catalogArticle = dxfArticleToCatalogNumber(articleNumber);
                const tool = findCtgTool(catalogArticle);
                const maxY = Math.max(...parsed.points.map((p: Point) => p.y));
                const normalized = tool?.kind === "punch"
                  ? normalizePunchContour(parsed.points)
                  : tool?.kind === "die" || tool?.kind === "adapter"
                    ? parsed.points.map((p: Point) => ({ x: p.x, y: maxY - p.y }))
                    : parsed.points;
                const safePoints = sanitizeDxfGeometry(normalized);
                if (!safePoints) return { ok: false, article: articleNumber, error: "invalid contour" };
                return { ok: true, article: catalogArticle, points: safePoints };
              } catch (err) {
                return { ok: false, article: articleNumber, error: String(err) };
              }
            })
          );

          let successCount = 0;
          const failed: string[] = [];
          for (const result of results) {
            if (result.ok) {
              geometries[result.article] = result.points!;
              successCount++;
            } else {
              failed.push(`${result.article}: ${result.error}`);
            }
          }

          setDxfLoadProgress((prev) => ({
            loaded: prev.loaded + successCount,
            total: prev.total,
            failed: [...prev.failed, ...failed],
          }));
        }

        setCatalogGeometries((current) => {
          const merged = { ...current, ...geometries };
          return merged;
        });

        const totalLoaded = Object.keys(geometries).length;
        if (totalLoaded > 0) {
          console.log(`[DXF] 已自动加载 ${totalLoaded}/${articleNames.length} 个模具轮廓`);
          setToast('模具库 DXF 已自动加载 ' + totalLoaded + ' 个轮廓，可在"模具库"中查看');
        } else {
          console.warn('[DXF] 未成功加载任何模具轮廓');
        }
      } catch (err) {
        console.error("[DXF] 自动加载失败:", err);
      }
    }, 100);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!simulationPlaying) return;
    const timer = window.setInterval(() => {
      setBendProgress((current) => Math.min(100, current + 1.25));
    }, 40);
    return () => window.clearInterval(timer);
  }, [simulationPlaying]);

  useEffect(() => {
    if (!simulationPlaying || bendProgress < 100) return;
    const hasNextStep = playingAll && sequencePosition < bendSequence.length - 1;
    const timer = window.setTimeout(() => {
      if (hasNextStep) {
        setSequencePosition((current) => Math.min(bendSequence.length - 1, current + 1));
        setBendProgress(0);
      } else {
        setSimulationPlaying(false);
        setPlayingAll(false);
      }
    }, hasNextStep ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [bendProgress, bendSequence.length, playingAll, sequencePosition, simulationPlaying]);

  function selectPressStage(nextStage: PressStage) {
    setSimulationPlaying(false);
    setPlayingAll(false);
    setBendProgress(nextStage === "flat" ? 0 : nextStage === "open" ? 35 : 100);
  }

  function updateBendProgress(value: number) {
    setSimulationPlaying(false);
    setPlayingAll(false);
    setBendProgress(value);
  }

  function toggleSimulation() {
    if (!simulationPlaying && bendProgress >= 100) setBendProgress(0);
    setPlayingAll(false);
    setSimulationPlaying((current) => !current);
  }

  function selectSequenceStep(position: number) {
    setSimulationPlaying(false);
    setPlayingAll(false);
    setSequencePosition(Math.round(clamp(position, 0, Math.max(0, bendSequence.length - 1))));
    setBendProgress(0);
  }

  function selectBend(bend: number) {
    setSelectedBend(bend);
    const position = bendSequence.indexOf(bend);
    if (position >= 0) selectSequenceStep(position);
  }

  function moveSequenceStep(position: number, direction: -1 | 1) {
    const destination = position + direction;
    if (destination < 0 || destination >= bendSequence.length) return;
    setSimulationPlaying(false);
    setPlayingAll(false);
    setBendProgress(0);
    if (step === 4) setCustomAdopted(false);
    setBendSequence((current) => {
      const next = [...current];
      [next[position], next[destination]] = [next[destination], next[position]];
      return next;
    });
    setSequencePosition((current) => current === position ? destination : current === destination ? position : current);
    setToast("折弯顺序已手动调整");
  }

  function applyAutoSequence() {
    setSimulationPlaying(false);
    setPlayingAll(false);
    if (step === 4) setCustomAdopted(false);
    const plan = findBestBendSequence(
      selected.punchProfile,
      flanges,
      bendAngles,
      thickness,
      step === 4 && customProfileActive ? custom : undefined,
      profileMeta
    );
    setBendSequence(plan.sequence);
    setSequencePosition(0);
    setBendProgress(0);
    if (plan.collisionSteps === 0) {
      const flipCount = plan.flips.filter(Boolean).length;
      const interCount = plan.intermediateAngles?.filter((a, i) => a !== (bendAngles[plan.sequence[i]] ?? 90)).length ?? 0;
      let msg = `已找到上模避让通过的顺序`;
      if (interCount > 0) msg += `，其中 ${interCount} 道中间角度避让`;
      if (flipCount > 0) msg += `，其中 ${flipCount} 道调头装夹`;
      setToast(msg);
    } else {
      setToast(`未找到上模避让全序无碰撞顺序，已采用干涉最少方案（仍有 ${plan.collisionSteps} 道）`);
    }
  }

  function togglePlayAll() {
    if (simulationPlaying && playingAll) {
      setSimulationPlaying(false);
      setPlayingAll(false);
      return;
    }
    setSequencePosition(0);
    setBendProgress(0);
    setPlayingAll(true);
    setSimulationPlaying(true);
  }

  function updateFlange(index: number, value: number) {
    setFlanges((current) => current.map((item, i) => (i === index ? value : item)));
  }

  function updateBend(index: number, value: number) {
    if (index < 0 || index >= bendAngles.length) return;
    const nextAngles = bendAngles.map((item, i) => (i === index ? value : item));
    setBendAngles(nextAngles);
    setBendRadii((current) => current.map((radius, i) => Math.min(
      radius,
      maximumBendRadius(flanges, nextAngles, i)
    )));
  }


  function updateBendRadius(index: number, value: number) {
    if (index < 0 || index >= bendRadii.length) return;
    setBendRadii((current) => current.map((item, i) => (
      i === index ? Math.min(value, maximumBendRadius(flanges, bendAngles, index)) : item
    )));
  }

  function toggleBendDirection(index: number) {
    if (index < 0 || index >= bendDirections.length) return;
    setBendDirections((current) => current.map((item, i) => (i === index ? (item === 1 ? -1 : 1) : item)));
  }
  function addFlange() {
    if (false) { // Removed flange count limit
      setToast("演示项目最多支持 6 段法兰");
      return;
    }
    if (flanges.length === 0) {
      setFlanges([80]);
      setSelectedFlange(0);
      setSelectedBend(-1);
      setToast("已添加第一段；可拖动绿色端点调整方向和长度");
    } else {
      const nextFlanges = [...flanges, 60];
      const nextAngles = [...bendAngles, 90];
      const nextBend = nextAngles.length - 1;
      const defaultRadius = Math.round(clamp(
        1,
        0.2,
        maximumBendRadius(nextFlanges, nextAngles, nextBend)
      ) * 10) / 10;
      setFlanges(nextFlanges);
      setBendAngles(nextAngles);
      setBendRadii([...bendRadii, defaultRadius]);
      setBendDirections([...bendDirections, 1]);
      setSelectedFlange(flanges.length);
      setSelectedBend(flanges.length - 1);
    }
    setSimulationPlaying(false);
    setPlayingAll(false);
    setBendProgress(0);
  }

  function undoFlange() {
    if (flanges.length <= 2) return;
    setFlanges((current) => current.slice(0, -1));
    setBendAngles((current) => current.slice(0, -1));
    setBendRadii((current) => current.slice(0, -1));
    setBendDirections((current) => current.slice(0, -1));
    setSelectedFlange((current) => Math.max(0, current - 1));
    setSelectedBend((current) => {
      const nextCount = flanges.length - 2;
      return nextCount <= 0 ? -1 : Math.min(nextCount - 1, Math.max(0, current));
    });
    setSimulationPlaying(false);
    setPlayingAll(false);
    setBendProgress(0);
  }

  function resetProfile() {
    setFlanges([]);
    setBendAngles([]);
    setBendRadii([]);
    setBendDirections([]);
    setBendSequence(autoSequenceOrder(0, []));
    setSelectedFlange(-1);
    setSelectedBend(-1);
    setSequencePosition(0);
    setSimulationPlaying(false);
    setPlayingAll(false);
    setBendProgress(0);
  }

  function runAutoFit() {
    const baseline = customPunchFromProfile(selected.punchProfile);
    const startingPunch = customProfileActive ? custom : baseline;
    const startThroat = Math.max(0, Math.round(startingPunch.throat / 5) * 5);
    const maxThroat = Math.min(200, Math.max(startThroat + 80, Math.ceil((requiredThroat + 40) / 5) * 5));
    const heightCandidates = [...new Set([
      startingPunch.height,
      clamp(startingPunch.height + 20, 55, 320),
      clamp(startingPunch.height + 40, 55, 320),
    ])];
    let solved: { punch: CustomPunch; plan: SequenceEvaluation } | null = null;
    let leastInterference: { punch: CustomPunch; plan: SequenceEvaluation } | null = null;
    for (let throat = startThroat; throat <= maxThroat && !solved; throat += 5) {
      for (const height of heightCandidates) {
        const candidate = {
          throat,
          height,
          body: startingPunch.body,
          tipRadius: startingPunch.tipRadius,
        };
        const plan = findBestBendSequence(
          selected.punchProfile,
          flanges,
          bendAngles,
          thickness,
          candidate,
          profileMeta
        );
        if (
          !leastInterference
          || plan.collisionSteps < leastInterference.plan.collisionSteps
          || (plan.collisionSteps === leastInterference.plan.collisionSteps && plan.totalCollidingSamples < leastInterference.plan.totalCollidingSamples)
          || (plan.collisionSteps === leastInterference.plan.collisionSteps && plan.totalCollidingSamples === leastInterference.plan.totalCollidingSamples && plan.totalContacts < leastInterference.plan.totalContacts)
        ) {
          leastInterference = { punch: candidate, plan };
        }
        if (plan.collisionSteps === 0) {
          solved = { punch: candidate, plan };
          break;
        }
      }
    }
    if (solved) {
      setCustomAdopted(false);
      setCustomProfileActive(true);
      setCustom(solved.punch);
      setBendSequence(solved.plan.sequence);
      setSequencePosition(0);
      setBendProgress(0);
      setSimulationPlaying(false);
      setPlayingAll(false);
      const interCount = solved.plan.intermediateAngles?.filter((a, i) => a !== (bendAngles[solved.plan.sequence[i]] ?? 90)).length ?? 0;
      let autoMsg = "AutoFit 已联合优化模具、顺序与调头姿态，上模避让全序通过";
      if (interCount > 0) autoMsg += `（${interCount} 道中间角度避让）`;
      setToast(autoMsg);
    } else if (leastInterference) {
      setCustomAdopted(false);
      setCustomProfileActive(true);
      setCustom(leastInterference.punch);
      setBendSequence(leastInterference.plan.sequence);
      setSequencePosition(0);
      setBendProgress(0);
      setSimulationPlaying(false);
      setPlayingAll(false);
      setToast(`未找到上模避让全序无碰撞方案，已降至 ${leastInterference.plan.collisionSteps} 道干涉`);
    } else {
      setToast("当前参数范围内未找到无碰撞轮廓");
    }
  }

  function updateCustomPunch(next: CustomPunch) {
    setCustomAdopted(false);
    setCustomProfileActive(true);
    setCustom(next);
  }

  function selectLibraryToolState(tool: CtgToolRecord) {
    let clearedTool: CtgToolRecord | undefined;
    if (tool.kind === "punch") {
      if (libraryDieTool && !ukbSystemsCompatible(tool, libraryDieTool)) {
        clearedTool = libraryDieTool;
        setLibraryDieArticle(null);
      }
      setLibraryPunchArticle(tool.articleNumber);
    } else if (tool.kind === "die") {
      if (libraryPunchTool && !ukbSystemsCompatible(libraryPunchTool, tool)) {
        clearedTool = libraryPunchTool;
        setLibraryPunchArticle(null);
      }
      setLibraryDieArticle(tool.articleNumber);
    }
    setCustomAdopted(false);
    return clearedTool;
  }

  function useLibraryTool(tool: CtgToolRecord) {
    if (tool.kind !== "punch" && tool.kind !== "die") return;
    if (tool.kind === "punch" && !catalogGeometries[tool.articleNumber]) {
      setToast(`${tool.articleNumber} 尚无通过校验的 DXF，未加入主模拟`);
      return;
    }
    if (tool.kind === "die" && ukbDieVOpening(tool) === null && !catalogGeometries[tool.articleNumber]) {
      setToast(`${tool.articleNumber} 的 V 口规格未知且无已加载 DXF，未加入主模拟`);
      return;
    }
    const clearedTool = selectLibraryToolState(tool);
    setSelectedSolution("library");
    setStep(3);
    setSequencePosition(0);
    setBendProgress(0);
    setSimulationPlaying(false);
    setPlayingAll(false);
    setLibraryOpen(false);
    const hasCad = Boolean(catalogGeometries[tool.articleNumber]);
    const clearedMessage = clearedTool
      ? `；已清除不同系统的 ${clearedTool.articleNumber}（${clearedTool.system}）`
      : "";
    setToast(`${tool.articleNumber} 已设为当前${tool.kind === "punch" ? "上模" : "下模"}${hasCad ? "，使用已校验 DXF 轮廓" : ""}${clearedMessage}`);
  }

  function importLibraryGeometry(tool: CtgToolRecord, points: Point[]) {
    const safePoints = sanitizeDxfGeometry(points);
    if (!safePoints) {
      setToast(`DXF 未载入：轮廓需为 3–${MAX_DXF_POINTS} 点，且坐标必须在 ±${MAX_DXF_COORDINATE} mm 内`);
      return false;
    }
    const next = withStoredDxfGeometry(catalogGeometries, tool.articleNumber, safePoints);
    if (!persistDxfGeometries(next)) {
      setToast("DXF 未载入：本机存储不可用或空间不足，未标记为可用轮廓");
      return false;
    }
    setCatalogGeometries(next);
    if (tool.kind === "punch") {
      const clearedTool = selectLibraryToolState(tool);
      setSelectedSolution("library");
      const clearedMessage = clearedTool
        ? `；已清除不同系统的 ${clearedTool.articleNumber}（${clearedTool.system}）`
        : "";
      setToast(`${tool.articleNumber} 的 DXF 轮廓已在本机载入并设为当前上模${clearedMessage}`);
      return true;
    }
    if (tool.kind === "die") {
      setToast(`${tool.articleNumber} 的 DXF 已保存为图纸预览；V 口规格未知，未加入主模拟`);
      return true;
    }
    setToast(`${tool.articleNumber} 的 DXF 轮廓已在本机载入，仅用于图纸预览`);
    return true;
  }

  function saveProject() {
    localStorage.setItem(
      "bendpilot-project",
      JSON.stringify({ schemaVersion: 2, materialKey, thickness, bendLength, flanges, bendAngles, bendSequence, libraryPunchArticle, libraryDieArticle })
    );
    const now = new Date();
    setSavedAt(`${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`);
    setToast("项目已保存到此设备");
  }

  function selectPunchChoice(articleNumber: string) {
    const punch = findCtgTool(articleNumber);
    if (!punch || punch.kind !== "punch") return;
    const currentDie = libraryDieTool ?? findCtgTool(selected.dieArticle);
    const compatibleDie = currentDie && ukbSystemsCompatible(punch, currentDie)
      ? currentDie
      : dieChoices.find((choice) => ukbSystemsCompatible(punch, choice.tool))?.tool;
    if (!compatibleDie) {
      setToast(`${punch.articleNumber} 没有可用的同系统下模`);
      return;
    }
    setCustomAdopted(false);
    setCustomProfileActive(false);
    setLibraryPunchArticle(punch.articleNumber);
    setLibraryDieArticle(compatibleDie.articleNumber);
    setSelectedSolution("library");
    setSequencePosition(0);
    setBendProgress(0);
    setToast(`上模已改为 ${punch.articleNumber}，保留下模 ${compatibleDie.articleNumber}`);
  }

  function selectDieChoice(articleNumber: string) {
    const die = findCtgTool(articleNumber);
    if (!die || die.kind !== "die") return;
    const currentPunch = libraryPunchTool ?? findCtgTool(selected.punchArticle) ?? punchChoices[0]?.tool;
    if (!currentPunch || !ukbSystemsCompatible(currentPunch, die)) {
      setToast(`${die.articleNumber} 与当前上模系统不兼容`);
      return;
    }
    setCustomAdopted(false);
    setCustomProfileActive(false);
    setLibraryPunchArticle(currentPunch.articleNumber);
    setLibraryDieArticle(die.articleNumber);
    setSelectedSolution("library");
    setSequencePosition(0);
    setBendProgress(0);
    setToast(`下模已改为 ${die.articleNumber}，保留上模 ${currentPunch.articleNumber}`);
  }

  function navigateToStep(nextStep: number) {
    setCustomAdopted(false);
    if (nextStep === 4 && step < 4) {
      setCustom(customPunchFromProfile(selected.punchProfile));
      setCustomProfileActive(false);
    }
    setStep(Math.round(clamp(nextStep, 1, 5)));
  }

  function advanceStep() {
    if (step === 4) {
      setCustomAdopted(customProfileActive);
      setStep(5);
      return;
    }
    if (step === 3) {
      setCustom(customPunchFromProfile(selected.punchProfile));
      setCustomProfileActive(false);
    }
    setCustomAdopted(false);
    setStep((current) => Math.min(5, current + 1));
  }

  function returnToPreviousStep() {
    setCustomAdopted(false);
    setStep((current) => Math.max(1, current - 1));
  }

  const priceFactor = lengthPlan === "515" ? 0.68 : lengthPlan === "1030" ? 1.21 : 1;
  const isCatalogSelection = selected.source === "ukb-library";
  const finalUsesCustom = customAdopted;
  const finalPlanCollision = finalUsesCustom
    ? customCollision
    : standardSequenceEvaluation.collisionSteps > 0;
  const finalConstraintCount = finalUsesCustom
    ? customSequenceEvaluation.collisionSteps + (custom.body > 56 ? 1 : 0)
    : standardSequenceEvaluation.collisionSteps;
  const finalPunchProfile: PunchProfileInput = finalUsesCustom
    ? resolvePunchProfile(selected.punchProfile, custom)
    : selected.punchProfile;
  const finalPunchLabel = finalUsesCustom
    ? `${selected.punch} · 修改 A${custom.throat} H${custom.height} R${custom.tipRadius}`
    : selected.punch;
  const finalPunchCadPoints = !finalUsesCustom && isCatalogSelection && libraryPunchTool
    ? catalogGeometries[libraryPunchTool.articleNumber]
    : undefined;
  const finalPunchCapacity = finalUsesCustom ? 560 : selected.capacity;
  const finalPunchValue = punchProfileValue(finalPunchProfile);
  const finalPunchStatus = finalPlanCollision
    ? `${finalConstraintCount} 项待处理`
    : finalUsesCustom
      ? `所选轮廓修改 · ${finalPunchValue.polygon.length} 点`
      : finalPunchCadPoints
        ? `CTG DXF · ${finalPunchCadPoints.length} 点`
        : isCatalogSelection && libraryPunchTool
          ? "CTG CAD 缺失"
          : "二维上模通过";
  const finalPunchSource = finalUsesCustom
    ? `基于所选 ${selected.punch} 轮廓修改`
    : finalPunchCadPoints
      ? "本机导入 CTG DXF"
      : isCatalogSelection && libraryPunchTool
        ? "CTG 目录参数"
        : "内置模具库";
  const finalCatalogPunchPricing = isCatalogSelection && !finalUsesCustom && Boolean(libraryPunchTool);
  const finalCatalogDiePricing = isCatalogSelection && Boolean(libraryDieTool);
  const finalHasCatalogPricing = finalCatalogPunchPricing || finalCatalogDiePricing;
  const finalPrice = finalUsesCustom
    ? Math.round((8600 + custom.throat * 24) * priceFactor)
    : isCatalogSelection
      ? 0
      : Math.round(selected.price * priceFactor);
  const selectedLengthSegments = LENGTH_SEGMENTS[lengthPlan] ?? [Number(lengthPlan) || 835];
  const selectedTotalLength = selectedLengthSegments.reduce((total, segment) => total + segment, 0);

  function updateCustomerInfo(field: keyof CustomerInfo, value: string) {
    setCustomerInfo((current) => ({ ...current, [field]: value.slice(0, field === "note" ? 240 : 100) }));
  }

  async function generateFormalQuote() {
    const customer = Object.fromEntries(
      Object.entries(customerInfo).map(([key, value]) => [key, value.trim()])
    ) as CustomerInfo;
    if (!customer.company || !customer.contact) {
      setToast("请先填写客户名称和联系人");
      return;
    }
    if (!customer.phone && !customer.email) {
      setToast("请至少填写客户电话或邮箱");
      return;
    }

    setQuoteGenerating(true);
    setQuoteDeliveryStatus("正在生成正式 PDF…");
    const createdAt = new Date();
    const quoteNo = createQuoteNumber(createdAt);
    const punchTool = libraryPunchTool ?? findCtgTool(selected.punchArticle);
    const dieTool = libraryDieTool ?? findCtgTool(selected.dieArticle);
    const punchName = finalUsesCustom
      ? `${punchTool?.name ?? selected.punch}（所选轮廓修改）`
      : punchTool?.name ?? selected.punch;
    const dieName = dieTool?.name ?? selected.die;
    const delivery = finalHasCatalogPricing
      ? "请原厂确认"
      : finalPlanCollision
        ? "完成避碰复核后确认"
        : finalUsesCustom
          ? "12-15 个工作日"
          : "7-10 个工作日";
    const quoteData: QuotePdfData = {
      quoteNo,
      createdAt,
      customer,
      projectName: "箱体侧板 · A01",
      material: `${material.name}`,
      thickness,
      bendLength,
      bendSequence: bendSequence.map((bend) => `B${bend + 1}`).join(" → "),
      estimatedForce: force,
      punch: {
        role: "上模",
        articleNumber: punchTool?.articleNumber ?? selected.punchArticle ?? "非标上模",
        name: punchName,
        system: punchTool?.system ?? selectedSystem ?? "通用",
        angle: punchTool?.angleDeg ? `${punchTool.angleDeg}°` : "按轮廓",
        totalLength: selectedTotalLength,
        segments: selectedLengthSegments,
        source: finalPunchSource,
        specification: finalUsesCustom
          ? `A${custom.throat} / H${custom.height} / W${custom.body} / R${custom.tipRadius}`
          : `${finalPunchValue.kind === "straight" ? "直剑" : `鹅颈 A${Math.round(selected.throat)}`} / H${Math.round(selected.height)} / R${finalPunchValue.tipRadius}`,
        capacity: `${finalPunchCapacity} kN/m`,
        contour: finalPunchValue.polygon,
        color: "#3d6f9f",
      },
      die: {
        role: "下模",
        articleNumber: dieTool?.articleNumber ?? selected.dieArticle ?? "标准下模",
        name: dieName,
        system: dieTool?.system ?? selectedSystem ?? "通用",
        angle: dieTool?.angleDeg ? `${dieTool.angleDeg}°` : `${dieProfileValue(selected.dieProfile).includedAngle}°`,
        totalLength: selectedTotalLength,
        segments: selectedLengthSegments,
        source: isCatalogSelection && dieTool ? "CTG 目录 / 已加载轮廓" : "内置模具库",
        specification: selectedLibraryDieVUnknown
          ? `V 口待原厂确认 / H${Math.round(dieProfileValue(selected.dieProfile).height)}`
          : `V${vOpening} / H${Math.round(dieProfileValue(selected.dieProfile).height)}`,
        capacity: isCatalogSelection && dieTool ? "待原厂确认" : "1,500 kN/m",
        contour: quoteDieContour(selected.dieProfile),
        color: "#8da69b",
      },
      validation: [
        finalPlanCollision ? `上模避让仍有 ${finalConstraintCount} 项待处理。` : "完整工序上模避让校核通过。",
        selectedLibraryDieVUnknown ? "下模 V 口规格须由供应商在报价中确认。" : `V 口 V${vOpening} 与当前板厚匹配。`,
        `预计折弯力 ${Math.round(force)} kN；折弯长度 ${bendLength} mm。`,
        `轮廓：上模 ${finalPunchValue.polygon.length} 点；下模 ${quoteDieContour(selected.dieProfile).length} 点。`,
      ],
      delivery,
    };

    try {
      const pdfBlob = await createQuotePdfBlob(quoteData);
      const filename = `${quoteNo}-模具询价单.pdf`;
      downloadQuoteBlob(pdfBlob, filename);
      localStorage.setItem("bendpilot-customer", JSON.stringify(customer));
      setQuoteDeliveryStatus("PDF 已下载，正在提交后台邮件抄送…");

      try {
        const pdfBase64 = await quoteBlobToBase64(pdfBlob);
        const response = await fetch("/api/quote-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quoteNo,
            filename,
            pdfBase64,
            customer,
            projectName: quoteData.projectName,
            punchArticle: quoteData.punch.articleNumber,
            dieArticle: quoteData.die.articleNumber,
          }),
        });
        const result = await response.json() as { emailed?: boolean; configured?: boolean; error?: string };
        if (!response.ok) throw new Error(result.error || "后台邮件发送失败");
        if (result.emailed) {
          setQuoteDeliveryStatus("PDF 已下载；后台邮件副本已发送");
          setToast("正式询价单已下载，邮件副本已发送");
        } else {
          setQuoteDeliveryStatus("PDF 已下载；后台收件邮箱尚未绑定");
          setToast("正式询价单已下载；绑定后台邮箱后将自动抄送");
        }
      } catch {
        setQuoteDeliveryStatus("PDF 已下载；后台邮件暂未发送");
        setToast("正式询价单已下载；后台邮件发送失败，可稍后重试");
      }
    } catch {
      setQuoteDeliveryStatus("PDF 生成失败，请检查浏览器下载权限后重试");
      setToast("询价单 PDF 生成失败");
    } finally {
      setQuoteGenerating(false);
    }
  }

  async function exportAllDxfFiles() {
    const entries = Object.entries(catalogGeometries);
    if (entries.length === 0) {
      setToast("当前没有已保存的 DXF 轮廓，无法导出");
      return;
    }
    let savedCount = 0;
    for (const [articleNumber, points] of entries) {
      const tool = findCtgTool(articleNumber);
      const kind = tool ? tool.kind : "punch";
      const blob = generateDxfFile(points, articleNumber + "." + kind + ".dxf");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = articleNumber + "." + kind + ".dxf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      savedCount++;
      await new Promise(function(r) { setTimeout(r, 300); });
    }
    setToast("已导出 " + savedCount + " 个 DXF 文件，请将其放入项目的 public/dxf/ 目录");
  }

  return (
    <main className="app-shell">
      <aside className="side-rail">
        <div className="brand">
          <span className="brand-glyph"><i /><i /><i /></span>
          <span>BEND<em>PILOT</em></span>
        </div>
        <button className="project-switcher" type="button">
          <span className="project-icon">P1</span>
          <span><small>当前项目</small><strong>箱体侧板 · A01</strong></span>
          <b>⌄</b>
        </button>
        <nav className="step-nav" aria-label="选型步骤">
          <p>模具选型流程</p>
          {STEPS.map((item) => (
            <button
              type="button"
              key={item.n}
              className={`${step === item.n ? "active" : ""} ${step > item.n ? "done" : ""}`}
              onClick={() => navigateToStep(item.n)}
              aria-current={step === item.n ? "step" : undefined}
            >
              <span>{step > item.n ? "✓" : item.n}</span>
              <strong>{item.label}<small>{item.hint}</small></strong>
            </button>
          ))}
        </nav>
        <div className="rail-footer">
          <button type="button"><span>◫</span>我的设备</button>
          <button type="button" className={libraryOpen ? "active" : ""} onClick={() => setLibraryOpen(true)}><span>▤</span>模具库</button>
          <button type="button"><span>?</span>使用帮助</button>
          <div className="rail-status"><i /> CTG 模具库 <b>v0.4</b></div>
        </div>
      </aside>

      <section className="app-main">
        <header className="topbar">
          <div>
            <span>项目</span><b>/</b><strong>箱体侧板 · A01</strong>
            <em>草稿</em>
          </div>
          <div className="top-actions">
            <span className="saved-state">{savedAt ? `已保存 ${savedAt}` : "尚未保存"}</span>
            <button type="button" className="ghost-button" onClick={saveProject}>保存项目</button>
            <button type="button" className="icon-button" aria-label="通知">●</button>
            <span className="avatar">陈</span>
          </div>
        </header>

        <div className="content">
          <div className="page-heading">
            <div>
              <p>STEP {step.toString().padStart(2, "0")} / 05</p>
              <h1>{STEPS[step - 1].label}</h1>
              <span>{step === 1 && "定义机器、材料，并绘制需要校核的二维工件截面。"}</span>
              <span>{step === 2 && "精确设置每段法兰与折弯，并自动排刀或手动调整工序。"}</span>
              <span>{step === 3 && "逐道比较上下模组合，并按工序检查完整折弯过程。"}</span>
              <span>{step === 4 && "调整模具轮廓，或使用 AutoFit 自动寻找安全参数。"}</span>
              <span>{step === 5 && "确认模具长度、分段方案与项目估算清单。"}</span>
            </div>
            <div className="heading-metrics">
              <div><small>{selectedLibraryDieVUnknown ? "仿真暂用 V 口" : "推荐 V 口"}</small><strong>V{vOpening}</strong><em>mm</em></div>
              <div><small>{selectedLibraryDieVUnknown ? "暂估内 R" : "预计内 R"}</small><strong>{insideRadius.toFixed(1)}</strong><em>mm</em></div>
              <div><small>{selectedLibraryDieVUnknown ? "暂估折弯力" : "折弯力"}</small><strong>{force.toFixed(0)}</strong><em>kN</em></div>
            </div>
          </div>

          {(step === 1 || step === 2) && (
            <div className="workbench profile-workbench">
              <aside className="panel spec-panel">
                <div className="panel-title"><span>工艺条件</span><button type="button">重置</button></div>
                <label className="field">
                  <span>模具系统</span>
                  <select value={selectedSystem ?? "all"} onChange={(event) => setSelectedSystem(event.target.value === "all" ? null : event.target.value)}>
                    <option value="all">全部系统</option>
                    {CTG_SYSTEMS.map((system) => (
                      <option key={system} value={system}>{system}</option>
                    ))}
                  </select>
                  <small className="field-meta">选择系统后仅推荐该模具系列</small>
                </label>
                <label className="field">
                  <span>材料</span>
                  <select value={materialKey} onChange={(event) => setMaterialKey(event.target.value as MaterialKey)}>
                    {Object.entries(MATERIALS).map(([key, value]) => (
                      <option key={key} value={key}>{value.name}</option>
                    ))}
                  </select>
                </label>
                <div className="field-row">
                  <Field label="板厚" value={thickness} unit="mm" step={0.5} onChange={setThickness} />
                  <Field label="折弯长度" value={bendLength} unit="mm" min={50} max={4100} onChange={setBendLength} />
                </div>
                <div className="rule-card">
                  <span>工艺预检</span>
                  <strong><i />空气折弯可行</strong>
                  <dl>
                    <div><dt>最小法兰</dt><dd>{minimumFlange.toFixed(1)} mm</dd></div>
                    <div><dt>回弹补偿</dt><dd>约 {material.springback}°</dd></div>
                  </dl>
                </div>
                <p className="safety-note">演示计算用于初步选型，生产前需按实际材料批次和设备能力复核。</p>
              </aside>

              <section className="drawing-panel">
                <div className="drawing-toolbar">
                  <div>
                    <button className={canvasMode === "formed" ? "active" : ""} type="button" onClick={() => setCanvasMode("formed")}>成形截面</button>
                    <button className={canvasMode === "flat" ? "active" : ""} type="button" onClick={() => setCanvasMode("flat")}>展开视图</button>
                  </div>
                  <div>
                    <button type="button" onClick={undoFlange} disabled={flanges.length <= 2}>↶ 撤销</button>
                    <button type="button" onClick={resetProfile}>重置</button>
                    <button type="button" className="add-button" onClick={addFlange}>＋ 添加法兰</button>
                  </div>
                </div>
                {step === 2 && (
                  <BendSequenceEditor
                    compact
                    sequence={bendSequence}
                    activePosition={sequencePosition}
                    bendAngles={bendAngles}
                    evaluation={standardSequenceEvaluation}
                    onSelect={selectSequenceStep}
                    onMove={moveSequenceStep}
                    onAuto={applyAutoSequence}
                  />
                )}
                <ProfileCanvas
                  thickness={thickness}
                  profile={profileDefinition}
                  mode={canvasMode}
                  selectedFlange={selectedFlange}
                  selectedBend={selectedBend}
                  onSelectFlange={setSelectedFlange}
                  onSelectBend={setSelectedBend}
                  onCommit={(newProfile) => {
                    setFlanges(newProfile.flanges);
                    setBendAngles(newProfile.bendAngles);
                    setBendRadii(newProfile.bendRadii);
                    setBendDirections(newProfile.bendDirections);
                    setProfileMeta({
                      bendRadii: newProfile.bendRadii,
                      bendDirections: newProfile.bendDirections,
                      startAngle: newProfile.startAngle,
                    });
                  }}
                  onInvalidDrag={(msg) => setToast(msg)}
                />
              </section>

              <aside className="panel property-panel">
                <div className="panel-title"><span>{step === 1 ? "截面结构" : "精确参数"}</span><em>{flanges.length} 段 · {bendAngles.length} 折</em></div>
                {flanges.length === 0 ? (
                  <div className="profile-empty-sidebar">
                    <strong>画布已自动清空</strong>
                    <p>从绿色起点拖出第一段，或点"添加直段"。随后可拖动任一节点调整轮廓。</p>
                    <span>长度、内角、每个折弯的 R 半径均可独立编辑。</span>
                  </div>
                ) : (
                  <>
                    <div className="section-label">直段</div>
                    <div className="entity-list">
                      {flanges.map((length, index) => (
                        <button
                          type="button"
                          className={selectedFlange === index ? "active" : ""}
                          key={`F${index}`}
                          onClick={() => setSelectedFlange(index)}
                        >
                          <span>F{index + 1}</span><strong>{length} mm</strong><em>›</em>
                        </button>
                      ))}
                    </div>
                    {selectedFlange >= 0 && (
                      <CommitField
                        label={`直段 F${selectedFlange + 1} 长度`}
                        value={flanges[selectedFlange] ?? 60}
                        unit="mm"
                        min={10}
                        // Removed max constraint
                        step={0.1}
                        onCommit={(value) => updateFlange(selectedFlange, value)}
                      />
                    )}
                    <div className="section-label bend-label">折弯与圆弧</div>
                    {bendAngles.length === 0 ? (
                      <p className="bend-empty-note">再添加一段即可生成 B1，并设置角度与 R。</p>
                    ) : (
                      <div className="bend-chips">
                        {bendAngles.map((angle, index) => (
                          <button
                            type="button"
                            key={`B${index}`}
                            className={selectedBend === index ? "active" : ""}
                            onClick={() => selectBend(index)}
                          >B{index + 1}<small>{angle}° · R{(bendRadii[index] ?? 1).toFixed(1)}</small>
                          </button>
                        ))}
                      </div>
                    )}
                    {selectedBend >= 0 && bendAngles[selectedBend] !== undefined && (
                      <div className="bend-property-grid">
                        <CommitField
                          label={`B${selectedBend + 1} 内角`}
                          value={bendAngles[selectedBend]}
                          unit="°"
                          min={20}
                          // Removed angle max constraint
                          step={0.1}
                          onCommit={(value) => updateBend(selectedBend, value)}
                        />
                        <CommitField
                          label={`B${selectedBend + 1} 内 R · 最大 ${maximumBendRadius(flanges, bendAngles, selectedBend).toFixed(1)}`}
                          value={bendRadii[selectedBend] ?? 1}
                          unit="mm"
                          min={0.2}
                          max={maximumBendRadius(flanges, bendAngles, selectedBend)}
                          step={0.1}
                          onCommit={(value) => updateBendRadius(selectedBend, value)}
                        />
                        <button type="button" className="direction-button" onClick={() => toggleBendDirection(selectedFlange)} disabled={selectedFlange >= bendDirections.length}>
                          ↔ 折弯方向：{bendDirections[selectedFlange] === -1 ? "右转" : "左转"}
                        </button>
                      </div>
                    )}
                    {step === 2 && profileReady ? (
                      <div className="critical-card">
                        <span>当前工序 {sequencePosition + 1}/{bendSequence.length}</span>
                        <strong>B{criticalBend + 1}</strong>
                        <p>几何属性与排刀顺序分开编辑；拖动节点不会逐像素重跑碰撞。</p>
                      </div>
                    ) : (
                      <div className="editor-guide-card">拖动节点时只进行本地预览，松手后统一更新尺寸与校核。</div>
                    )}
                  </>
                )}
              </aside>
            </div>
          )}

          {step === 3 && (
            <div className="recommend-layout">
              <aside className="solution-list split-tool-list">
                <div className="split-selector-toolbar">
                  <span>上模、下模分开选择</span>
                  <select value={sortBy} onChange={(event) => setSortBy(event.target.value)} aria-label="上模推荐排序">
                    <option value="versatility">通用性</option>
                    <option value="price">价格</option>
                    <option value="capacity">承载</option>
                  </select>
                </div>
                <section className="tool-choice-group" aria-label="选择上模">
                  <div className="tool-choice-heading"><span>上模</span><em>{punchChoices.length} 个推荐 · 可单独更换</em></div>
                  <div className="tool-choice-scroll">
                    {punchChoices.map((choice) => {
                      const active = selected.punchArticle === choice.tool.articleNumber;
                      return (
                        <button
                          type="button"
                          key={choice.tool.id}
                          className={`tool-choice-card ${active ? "active" : ""}`}
                          aria-pressed={active}
                          onClick={() => selectPunchChoice(choice.tool.articleNumber)}
                        >
                          <ToolMark type="punch" profile={choice.profile} />
                          <span><strong>{choice.tool.articleNumber}</strong><small>{choice.tool.name}</small><em>{choice.score} 分 · {choice.collisionSteps === 0 ? "全序通过" : `${choice.collisionSteps} 道干涉`}</em></span>
                          <b>{active ? "✓" : "›"}</b>
                        </button>
                      );
                    })}
                  </div>
                </section>
                <section className="tool-choice-group" aria-label="选择下模">
                  <div className="tool-choice-heading"><span>下模</span><em>全部 {dieChoices.length} 个匹配 · 可单独更换</em></div>
                  <div className="tool-choice-scroll">
                    {dieChoices.map((choice) => {
                      const active = selected.dieArticle === choice.tool.articleNumber;
                      const opening = ukbDieVOpening(choice.tool);
                      return (
                        <button
                          type="button"
                          key={choice.tool.id}
                          className={`tool-choice-card ${active ? "active" : ""}`}
                          aria-pressed={active}
                          onClick={() => selectDieChoice(choice.tool.articleNumber)}
                        >
                          <ToolMark type="die" profile={choice.profile} />
                          <span><strong>{choice.tool.articleNumber}</strong><small>{choice.tool.name}</small><em>{opening ? `V${opening}` : "V 口待核"} · {choice.tool.angleDeg ?? "—"}° · {choice.cadReady ? "DXF" : "目录"}</em></span>
                          <b>{active ? "✓" : "›"}</b>
                        </button>
                      );
                    })}
                  </div>
                </section>
              </aside>
              <section className="simulation-panel">
                <div className="simulation-toolbar">
                  <div><strong>工序 {sequencePosition + 1}/{bendSequence.length} · 折弯 B{criticalBend + 1} · {activePartFlipped ? "调头" : "正向"}</strong><span>{selected.punch} + {selected.die}</span></div>
                  <div className="segmented-control">
                    {(["open", "pressed", "flat"] as PressStage[]).map((stage) => (
                      <button key={stage} type="button" className={pressStage === stage ? "active" : ""} onClick={() => selectPressStage(stage)}>
                        {stage === "open" ? "正常" : stage === "pressed" ? "压合" : "展开"}
                      </button>
                    ))}
                  </div>
                </div>
                <BendSequenceEditor
                  compact
                  sequence={bendSequence}
                  activePosition={sequencePosition}
                  bendAngles={bendAngles}
                  playingAll={playingAll}
                  evaluation={standardSequenceEvaluation}
                  onSelect={selectSequenceStep}
                  onMove={moveSequenceStep}
                  onAuto={applyAutoSequence}
                  onPlayAll={togglePlayAll}
                />
                <PressSimulation
                  stage={pressStage}
                  punchProfile={selected.punchProfile}
                  dieProfile={selected.dieProfile}
                  vOpening={vOpening}
                  flanges={flanges}
                  bendAngles={simulationAngles}
                  criticalBend={criticalBend}
                  progress={bendProgress}
                  thickness={thickness}
                  partFlipped={standardSequenceEvaluation.flips[sequencePosition] ?? false}
                />
                <SimulationPlayer
                  progress={bendProgress}
                  playing={simulationPlaying}
                  targetAngle={bendAngles[criticalBend] ?? 90}
                  onProgress={updateBendProgress}
                  onToggle={toggleSimulation}
                />
              </section>
              <aside className="panel analysis-panel">
                <div className="panel-title"><span>组合校核</span><em>ID {selected.id.toUpperCase()}-{selectedLibraryDieVUnknown ? "V?" : vOpening}</em></div>
                <div className={`status-banner ${selected.collision ? "bad" : "good"}`}>
                  <span>{selected.collision ? "!" : "✓"}</span>
                  <div><strong>{selected.collision ? `上模避让全序仍有 ${standardSequenceEvaluation.collisionSteps} 道干涉` : "上模避让全序通过"}</strong><small>{currentStandardCollision ? `当前工序 ${sequencePosition + 1} 发现上模干涉` : `当前工序 ${sequencePosition + 1} 的 16 个上模采样点通过`}</small></div>
                </div>
                <div className="check-list">
                  <div><span>V 口匹配</span><strong className={selectedLibraryDieVUnknown ? "warning" : "pass"}>{selectedLibraryDieVUnknown ? "规格未知" : "通过"}</strong><small>{selectedLibraryDieVUnknown ? `CTG 目录缺少 V 口；暂用推荐 V${vOpening}` : `推荐 V${vOpening}`}</small></div>
                  <div><span>折弯力</span><strong className={selectedLibraryDieVUnknown ? "warning" : force <= 1350 ? "pass" : "warning"}>{selectedLibraryDieVUnknown ? "暂估" : force <= 1350 ? "通过" : "超限"}</strong><small>{selectedLibraryDieVUnknown ? `按推荐 V${vOpening} 暂估 ${force.toFixed(0)} kN` : `${force.toFixed(0)} kN`}</small></div>
                  <div><span>线载荷</span><strong className={selectedLibraryDieVUnknown ? "warning" : force / (bendLength / 1000) <= selected.capacity ? "pass" : "warning"}>{selectedLibraryDieVUnknown ? "未校核" : force / (bendLength / 1000) <= selected.capacity ? "通过" : "超限"}</strong><small>{selectedLibraryDieVUnknown ? "缺少下模 V 口与额定载荷规格" : `${(force / (bendLength / 1000)).toFixed(0)} / ${selected.capacity} kN/m`}</small></div>
                  <div><span>上模全序间隙</span><strong className={selected.collision ? "warning" : "pass"}>{selected.collision ? `${selected.collisionSteps} 道干涉` : "通过"}</strong><small>{punchProfileValue(selected.punchProfile).kind === "straight" ? "直剑轮廓" : `鹅颈深度 ${selected.throat.toFixed(0)} mm`}</small></div>
                </div>
                <div className="score-grid">
                  <div><span>通用性</span><b style={{ width: `${selected.score}%` }} /><em>{selected.score}%</em></div>
                  <div><span>承载余量</span><b style={{ width: `${selectedLibraryDieVUnknown ? 12 : clamp(100 - (force / selected.capacity) * 100, 12, 96)}%` }} /><em>{selectedLibraryDieVUnknown ? "待核" : `${Math.max(0, Math.round(100 - (force / selected.capacity) * 100))}%`}</em></div>
                </div>
                {selected.collision && <button className="solve-link" type="button" onClick={() => navigateToStep(4)}>进入模具优化 <span>→</span></button>}
              </aside>
            </div>
          )}

          {step === 4 && (
            <div className="customize-layout">
              <section className="simulation-panel custom-canvas">
                <div className="simulation-toolbar">
                  <div><strong>{customProfileActive ? "所选上模轮廓修改" : "所选上模基线"}</strong><span>{customProfileActive ? `保留 ${selected.punch} 的 ${punchProfileValue(selected.punchProfile).polygon.length} 点轮廓` : selected.punch}</span></div>
                  <div className="stage-chip">工序 {sequencePosition + 1} · B{criticalBend + 1} · {activePartFlipped ? "调头" : "正向"}</div>
                </div>
                <BendSequenceEditor
                  compact
                  sequence={bendSequence}
                  activePosition={sequencePosition}
                  bendAngles={bendAngles}
                  playingAll={playingAll}
                  evaluation={customSequenceEvaluation}
                  onSelect={selectSequenceStep}
                  onMove={moveSequenceStep}
                  onAuto={applyAutoSequence}
                  onPlayAll={togglePlayAll}
                />
                <PressSimulation
                  stage={pressStage}
                  punchProfile={selected.punchProfile}
                  dieProfile={selected.dieProfile}
                  vOpening={vOpening}
                  flanges={flanges}
                  bendAngles={simulationAngles}
                  criticalBend={criticalBend}
                  progress={bendProgress}
                  thickness={thickness}
                  customPunch={customProfileActive ? custom : undefined}
                  partFlipped={customSequenceEvaluation.flips[sequencePosition] ?? false}
                />
                <SimulationPlayer
                  progress={bendProgress}
                  playing={simulationPlaying}
                  targetAngle={bendAngles[criticalBend] ?? 90}
                  onProgress={updateBendProgress}
                  onToggle={toggleSimulation}
                />
                <div className="dimension-strip">
                  <span><small>鹅颈深度</small><strong>{custom.throat} mm</strong></span>
                  <span><small>总高度</small><strong>{custom.height} mm</strong></span>
                  <span><small>模体宽度</small><strong>{custom.body} mm</strong></span>
                  <span><small>尖端半径</small><strong>R{custom.tipRadius}</strong></span>
                </div>
              </section>
              <aside className="custom-controls">
                <div className="autofit-card">
                  <span className="spark">✦</span>
                  <div><strong>AutoFit · 联合避碰</strong><p>同时搜索模具参数、折弯顺序与调头装夹。</p></div>
                  <button type="button" onClick={runAutoFit}>自动求解</button>
                </div>
                <div className="panel parameter-card">
                  <div className="panel-title"><span>{customProfileActive ? "所选轮廓修改参数" : "所选上模参数"}</span><em>{customProfileActive ? `保留原 ${punchProfileValue(selected.punchProfile).polygon.length} 个轮廓点` : "从当前轮廓继续修改"}</em></div>
                  <Field label="鹅颈深度 A" value={custom.throat} unit="mm" min={0} max={200} onChange={(value) => updateCustomPunch({ ...custom, throat: value })} />
                  <input className="range" type="range" min="0" max="200" value={custom.throat} onChange={(event) => updateCustomPunch({ ...custom, throat: Number(event.target.value) })} aria-label="鹅颈深度滑块" />
                  <Field label="模具总高度 H" value={custom.height} unit="mm" min={55} max={320} onChange={(value) => updateCustomPunch({ ...custom, height: value })} />
                  <input className="range" type="range" min="55" max="320" value={custom.height} onChange={(event) => updateCustomPunch({ ...custom, height: Number(event.target.value) })} aria-label="模具总高度滑块" />
                  <Field label="模体宽度 W" value={custom.body} unit="mm" min={1} max={200} onChange={(value) => updateCustomPunch({ ...custom, body: value })} />
                  <Field label="尖端半径 R" value={custom.tipRadius} unit="mm" min={0.1} max={30} step={0.1} onChange={(value) => updateCustomPunch({ ...custom, tipRadius: value })} />
                  {customProfileActive && <button type="button" className="restore-profile-button" onClick={() => {
                    setCustom(customPunchFromProfile(selected.punchProfile));
                    setCustomProfileActive(false);
                    setCustomAdopted(false);
                    setBendProgress(0);
                    setToast("已恢复所选模具原始轮廓");
                  }}>恢复所选模具原始轮廓</button>}
                </div>
                <div className={`constraint-card ${customCollision ? "bad" : "good"}`}>
                  <div><span>{customCollision ? "!" : "✓"}</span><strong>{customCollision ? `仍有 ${customSequenceEvaluation.collisionSteps + (custom.body > 56 ? 1 : 0)} 项二维上模约束未通过` : customProfileActive ? "所选轮廓修改后全序通过" : "二维上模校核全序通过"}</strong></div>
                  <p>{customSequenceEvaluation.collisionSteps > 0 ? `${customSequenceEvaluation.collisionSteps} 道工序仍与上模干涉；请先避碰排刀，或使用 AutoFit 联合优化。` : custom.body > 56 ? "模体宽度不得超过 56 mm。" : `全序每道 16 点上模采样通过，预计允许线载荷 560 kN/m。`}</p>
                </div>
              </aside>
            </div>
          )}

          {step === 5 && (
            <div className="finish-layout">
              <section className="finish-main">
                <div className="finish-hero">
                  <div className={`finish-check ${finalPlanCollision ? "bad" : ""}`}>{finalPlanCollision ? "!" : "✓"}</div>
                  <div><span>{finalPlanCollision ? `方案仍有 ${finalConstraintCount} 项约束未通过` : finalUsesCustom ? "所选模具轮廓修改方案二维校核完成" : finalPunchCadPoints ? "CTG DXF 主轮廓校核完成" : "标准方案二维上模校核完成"}</span><h2>箱体侧板 · A01</h2><p>{material.short} {thickness} mm · 折弯长度 {bendLength} mm · 工序 {bendSequence.map((bend) => `B${bend + 1}`).join(" → ")}</p></div>
                  <div className="finish-score"><strong>{selected.score}</strong><small>综合评分</small></div>
                </div>
                <div className="summary-grid">
                  <div className="summary-card">
                    <div className="summary-heading"><ToolMark type="punch" profile={finalPunchProfile} /><span><small>{finalUsesCustom ? "所选轮廓修改后上模" : "上模"}</small><strong>{finalPunchLabel}</strong></span><em>{finalPunchStatus}</em></div>
                    {finalUsesCustom ? (
                      <dl><div><dt>鹅颈深度</dt><dd>{custom.throat} mm</dd></div><div><dt>工作高度</dt><dd>{custom.height} mm</dd></div><div><dt>允许载荷</dt><dd>{finalPunchCapacity} kN/m</dd></div><div><dt>方案来源</dt><dd>{finalPunchSource}</dd></div></dl>
                    ) : (
                      <dl><div><dt>{finalPunchValue.kind === "straight" ? "模具类型" : "鹅颈深度"}</dt><dd>{finalPunchValue.kind === "straight" ? "直剑" : `${Math.round(selected.throat)} mm`}</dd></div><div><dt>工作高度</dt><dd>{Math.round(selected.height)} mm</dd></div><div><dt>允许载荷</dt><dd>{finalPunchCapacity} kN/m</dd></div><div><dt>轮廓来源</dt><dd>{finalPunchSource}</dd></div></dl>
                    )}
                  </div>
                  <div className="summary-card">
                    <div className="summary-heading"><ToolMark type="die" profile={selected.dieProfile} /><span><small>下模</small><strong>{selected.die}</strong></span><em>{isCatalogSelection && libraryDieTool ? "CTG 目录" : "标准"}</em></div>
                    <dl><div><dt>V 口</dt><dd>{selectedLibraryDieVUnknown ? "规格未知" : `${vOpening} mm`}</dd></div><div><dt>模肩半径</dt><dd>{selectedLibraryDieVUnknown ? "未校核" : `R${Math.max(1, vOpening * 0.12).toFixed(1)}`}</dd></div><div><dt>允许载荷</dt><dd>{isCatalogSelection && libraryDieTool ? "未校核" : "1,500 kN/m"}</dd></div></dl>
                  </div>
                </div>
                <div className="length-card">
                  <div><h3>选择模具长度</h3><p>系统将按所选总长生成推荐分段。</p></div>
                  <div className="length-options">
                    {[{ value: "515", label: "515 mm", sub: "单段" }, { value: "835", label: "835 mm", sub: "推荐 · 5 段" }, { value: "1030", label: "1030 mm", sub: "2 × 515" }].map((option) => (
                      <button type="button" key={option.value} className={lengthPlan === option.value ? "active" : ""} onClick={() => setLengthPlan(option.value)}>
                        <span>{lengthPlan === option.value ? "●" : "○"}</span><strong>{option.label}</strong><small>{option.sub}</small>
                      </button>
                    ))}
                  </div>
                  <div className="segment-bar"><span style={{ width: "18%" }}>100</span><span style={{ width: "26%" }}>215</span><span style={{ width: "16%" }}>85</span><span style={{ width: "26%" }}>215</span><span style={{ width: "14%" }}>220</span></div>
                </div>
              </section>
              <aside className="quote-panel">
                <div className="panel-title"><span>正式询价单</span><em>PDF · 自动下载</em></div>
                <div className="customer-form">
                  <div className="customer-form-heading"><strong>客户信息</strong><span>* 为必填</span></div>
                  <label className="wide"><span>客户名称 *</span><input aria-label="客户名称" value={customerInfo.company} onChange={(event) => updateCustomerInfo("company", event.target.value)} placeholder="公司或客户全称" /></label>
                  <label><span>联系人 *</span><input aria-label="联系人" value={customerInfo.contact} onChange={(event) => updateCustomerInfo("contact", event.target.value)} placeholder="姓名" /></label>
                  <label><span>联系电话</span><input aria-label="联系电话" value={customerInfo.phone} onChange={(event) => updateCustomerInfo("phone", event.target.value)} placeholder="手机或座机" /></label>
                  <label className="wide"><span>客户邮箱</span><input aria-label="客户邮箱" type="email" value={customerInfo.email} onChange={(event) => updateCustomerInfo("email", event.target.value)} placeholder="用于询价联系" /></label>
                  <label className="wide"><span>客户地址</span><input aria-label="客户地址" value={customerInfo.address} onChange={(event) => updateCustomerInfo("address", event.target.value)} placeholder="收货或开票地址" /></label>
                  <label className="wide"><span>询价备注</span><textarea aria-label="询价备注" value={customerInfo.note} onChange={(event) => updateCustomerInfo("note", event.target.value)} placeholder="税率、运输、交期等特殊要求" /></label>
                </div>
                <div className="quote-subtitle"><span>项目估算</span><em>CNY · 未税</em></div>
                <div className="quote-lines"><div><span>{finalUsesCustom ? "修改后上模" : "上模组合"}</span><strong>{finalCatalogPunchPricing ? "原厂询价" : `¥ ${Math.round(finalPrice * 0.54).toLocaleString()}`}</strong></div><div><span>下模组合</span><strong>{finalCatalogDiePricing ? "原厂询价" : `¥ ${Math.round(finalPrice * 0.38).toLocaleString()}`}</strong></div><div><span>分段与处理</span><strong>{finalHasCatalogPricing ? "待确认" : `¥ ${Math.round(finalPrice * 0.08).toLocaleString()}`}</strong></div></div>
                <div className="quote-total"><span>估算合计</span><strong>{finalHasCatalogPricing ? finalUsesCustom ? `轮廓修改 ¥ ${finalPrice.toLocaleString()} + CTG 询价` : "联系 CTG" : `¥ ${finalPrice.toLocaleString()}`}</strong><small>{finalHasCatalogPricing ? "CTG 目录件价格与交期以原厂页面为准" : "最终价格以制造评审为准"}</small></div>
                <div className="delivery"><span>预计交付</span><strong>{finalHasCatalogPricing ? "原厂确认" : finalPlanCollision ? "待完成避碰" : finalUsesCustom ? "12–15 个工作日" : "7–10 个工作日"}</strong></div>
                <button type="button" className="primary-action" disabled={quoteGenerating} onClick={generateFormalQuote}>{quoteGenerating ? "正在生成 PDF…" : "生成并下载正式询价单"} <span>{quoteGenerating ? "…" : "→"}</span></button>
                <p className="quote-delivery-status">{quoteDeliveryStatus}</p>
                <button type="button" className="secondary-action" onClick={saveProject}>保存项目</button>
                <p className="quote-note">生成询价单不会提交订单或付款；后台邮件仅发送到后期绑定的内部收件邮箱。</p>
              </aside>
            </div>
          )}

          <footer className="flow-footer">
            <button type="button" className="back-button" disabled={step === 1} onClick={returnToPreviousStep}>← 上一步</button>
            <div className="progress-dots">{STEPS.map((item) => <span key={item.n} className={step >= item.n ? "active" : ""} />)}</div>
            {step < 5 ? (
              <button type="button" className="next-button" onClick={advanceStep}>
                {step === 1 ? "确认截面" : step === 2 ? "计算模具建议" : step === 3 ? "优化所选模具" : customProfileActive ? "采用修改方案并完成" : "采用所选模具并完成"}<span>→</span>
              </button>
            ) : (
              <button type="button" className="next-button" onClick={generateFormalQuote}>完成并保存<span>✓</span></button>
            )}
          </footer>
        </div>
      </section>
      <ToolLibrary
        open={libraryOpen}
        activePunch={libraryPunchArticle}
        activeDie={libraryDieArticle}
        geometries={catalogGeometries}
        onClose={() => setLibraryOpen(false)}
        onUseTool={useLibraryTool}
        onImportGeometry={importLibraryGeometry}
        onExportGeometries={exportAllDxfFiles}
      />
      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </main>
  );
}
