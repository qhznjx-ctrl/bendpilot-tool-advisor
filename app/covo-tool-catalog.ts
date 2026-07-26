import catalogSnapshot from "./covo-tool-data.json";

export type CovoToolKind = "punch" | "die" | "adapter" | "other";
export type CovoGeometryStatus = "official-dxf-candidate" | "metadata-only";

export type CovoToolRecord = {
  id: string;
  maker: "COVO";
  articleNumber: string;
  name: string;
  kind: CovoToolKind;
  family: string;
  system: string;
  angleDeg?: number;
  radiusMm?: number;
  heightMm?: number;
  vOpeningMm?: number;
  lengthMm?: number;
  variant?: string;
  priceEur?: number;
  sourceUrl: string;
  dxfUrl?: string;
  geometryStatus: CovoGeometryStatus;
  licenseStatus: "source-link-only";
  importedAt: string;
};

type CovoCatalogSnapshot = {
  source: string;
  importedAt: string;
  pageCount: number;
  total: number;
  counts: Partial<Record<CovoToolKind, number>>;
  tools: CovoToolRecord[];
};

export const COVO_CATALOG = catalogSnapshot as unknown as CovoCatalogSnapshot;
export const COVO_TOOLS = COVO_CATALOG.tools;
export const COVO_SYSTEMS = [...new Set(COVO_TOOLS.map((tool) => tool.system))].sort((left, right) =>
  left === "Other" ? 1 : right === "Other" ? -1 : left.localeCompare(right)
);
export const COVO_ANGLES = [
  ...new Set(
    COVO_TOOLS
      .map((tool) => tool.angleDeg)
      .filter((angle): angle is number => typeof angle === "number" && Number.isFinite(angle))
  ),
].sort((left, right) => left - right);

export function findCovoTool(articleNumber?: string | null) {
  if (!articleNumber) return undefined;
  return COVO_TOOLS.find((tool) => tool.articleNumber === articleNumber);
}
