import catalogSnapshot from "./ctg-tool-data.json";

export type CtgToolKind = "punch" | "die" | "adapter" | "other";
export type CtgGeometryStatus = "official-dxf-candidate" | "metadata-only";

export type CtgToolRecord = {
  id: string;
  maker: "CTG";
  articleNumber: string;
  name: string;
  kind: CtgToolKind;
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
  geometryStatus: CtgGeometryStatus;
  licenseStatus: "source-link-only";
  importedAt: string;
};

type CtgCatalogSnapshot = {
  source: string;
  importedAt: string;
  pageCount: number;
  total: number;
  counts: Partial<Record<CtgToolKind, number>>;
  tools: CtgToolRecord[];
};

export const CTG_CATALOG = catalogSnapshot as unknown as CtgCatalogSnapshot;
export const CTG_TOOLS = CTG_CATALOG.tools;
export const CTG_SYSTEMS = [...new Set(CTG_TOOLS.map((tool) => tool.system))].sort((left, right) =>
  left === "Other" ? 1 : right === "Other" ? -1 : left.localeCompare(right)
);
export const CTG_ANGLES = [
  ...new Set(
    CTG_TOOLS
      .map((tool) => tool.angleDeg)
      .filter((angle): angle is number => typeof angle === "number" && Number.isFinite(angle))
  ),
].sort((left, right) => left - right);

export function findCtgTool(articleNumber?: string | null) {
  if (!articleNumber) return undefined;
  return CTG_TOOLS.find((tool) => tool.articleNumber === articleNumber);
}
