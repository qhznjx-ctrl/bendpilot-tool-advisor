import catalog from "../app/ctg-tool-data.json" with { type: "json" };

const allowedKinds = new Set(["punch", "die", "adapter", "other"]);
const requiredHost = "www.ukb-gmbh.de";
const seen = new Set();
const problems = [];

for (const [index, tool] of catalog.tools.entries()) {
  const label = tool.articleNumber || `row ${index + 1}`;
  const key = `${tool.articleNumber}\u0000${tool.variant ?? ""}`;
  if (!tool.id || !tool.articleNumber || !tool.name) problems.push(`${label}: missing required identity field`);
  if (!allowedKinds.has(tool.kind)) problems.push(`${label}: unsupported kind ${tool.kind}`);
  if (seen.has(key)) problems.push(`${label}: duplicate article and variant`);
  seen.add(key);
  try {
    if (new URL(tool.sourceUrl).hostname !== requiredHost) problems.push(`${label}: source is not the official CTG domain`);
  } catch {
    problems.push(`${label}: invalid source URL`);
  }
  if (tool.dxfUrl) {
    try {
      const dxf = new URL(tool.dxfUrl);
      if (dxf.hostname !== "daten.ukb-gmbh.de" || !dxf.pathname.endsWith(".DXF.zip")) {
        problems.push(`${label}: invalid official DXF candidate URL`);
      }
    } catch {
      problems.push(`${label}: invalid DXF URL`);
    }
  }
  if (tool.geometryStatus === "official-dxf-candidate") {
    if (tool.kind !== "punch" && tool.kind !== "die") problems.push(`${label}: non-tool entry marked as DXF candidate`);
    if (!/^[0-9]{2,3}\.[0-9]{3}[A-Za-z]?$/.test(tool.articleNumber)) problems.push(`${label}: nonstandard article marked as DXF candidate`);
    if (!tool.dxfUrl) problems.push(`${label}: DXF candidate is missing its source address`);
  } else if (tool.geometryStatus !== "metadata-only") {
    problems.push(`${label}: unsupported geometry status ${tool.geometryStatus}`);
  }
}

if (catalog.total !== catalog.tools.length) problems.push(`catalog total ${catalog.total} does not match ${catalog.tools.length} rows`);
const counted = Object.values(catalog.counts).reduce((sum, value) => sum + value, 0);
if (counted !== catalog.tools.length) problems.push(`kind counts total ${counted} does not match ${catalog.tools.length} rows`);

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(`CTG catalog valid: ${catalog.tools.length} unique records across ${catalog.pageCount} source pages.`);
