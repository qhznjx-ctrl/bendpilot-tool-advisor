import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT_URL = "https://www.ukb-gmbh.de/en/products/?mode=list";
const IMPORTED_AT = new Date().toISOString();
const OUTPUT = resolve(process.cwd(), "app/ctg-tool-data.json");

function decodeHtml(value = "") {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&deg;/g, "°")
    .replace(/&ndash;|&#8211;/g, "–")
    .replace(/&mdash;|&#8212;/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}

function decimal(value) {
  if (!value) return undefined;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function systemFrom(description) {
  const systems = ["Amada", "Trumpf", "Wila", "LVD", "Bystronic", "EHT", "Weinbrenner"];
  return systems.find((system) => new RegExp(`\\b${system}\\b`, "i").test(description)) ?? "Other";
}

function kindFrom(description) {
  if (/adaptor|adapter|intermediate|clamp|holder|distance piece|safety pin|protective film|insert|cabinet|setup aid|accessor|\bkit\b|adjusting strip|die retainer|\bslider\b/i.test(description)) return "adapter";
  if (/\bdies?\b|bottom[- ]tool|lower[- ]tool|v-block|unibend|wingbend/i.test(description)) return "die";
  if (/punch|top[- ]tool|blade|radius[- ]tool/i.test(description)) return "punch";
  return "other";
}

function familyFrom(description, kind) {
  if (kind === "punch") {
    if (/deep.*goose|deep.*swan/i.test(description)) return "deep-gooseneck";
    if (/goose|swan|cranked|neck/i.test(description)) return "gooseneck";
    if (/flatten|hemming/i.test(description)) return "flattening-punch";
    if (/radius/i.test(description)) return "radius-punch";
    return "straight-punch";
  }
  if (kind === "die") {
    if (/adjustable/i.test(description)) return "adjustable-die";
    if (/flatten|hemming/i.test(description)) return "flattening-die";
    if (/multi|double/i.test(description)) return "multi-v-die";
    return "single-v-die";
  }
  return kind === "adapter" ? "adapter-clamping" : "catalog-reference";
}

function parseSpecs(description, variant) {
  const angle = decimal(description.match(/(\d{2,3}(?:[.,]\d+)?)\s*°/)?.[1]);
  const height = decimal(description.match(/\bH\s*=\s*(\d+(?:[.,]\d+)?)\s*mm/i)?.[1]);
  const radius = decimal(description.match(/\bR\s*(?:=\s*)?(\d+(?:[.,]\d+)?)/i)?.[1]);
  const vOpening = decimal(description.match(/\bV\s*(\d+(?:[.,]\d+)?)/i)?.[1]);
  const length = decimal(variant.match(/\bL\s*=\s*(\d+(?:[.,]\d+)?)\s*mm/i)?.[1]);
  return { angle, height, radius, vOpening, length };
}

function extractAnalytics(html) {
  const marker = "gtag('event', 'view_item_list', ";
  const start = html.indexOf(marker);
  if (start < 0) return new Map();
  const objectStart = html.indexOf("{", start + marker.length);
  const objectEnd = html.indexOf("});", objectStart);
  if (objectStart < 0 || objectEnd < 0) return new Map();
  try {
    const parsed = JSON.parse(html.slice(objectStart, objectEnd + 1));
    return new Map((parsed.items ?? []).map((item) => [String(item.item_name), item]));
  } catch {
    return new Map();
  }
}

function extractProducts(html) {
  const starts = [...html.matchAll(/<div class="product-list-holder"[^>]*data-json="([^"]+)"[^>]*>/g)];
  const analytics = extractAnalytics(html);
  return starts.map((match, index) => {
    const block = html.slice(match.index, starts[index + 1]?.index ?? html.length);
    const sourceUrl = match[1].replace(/\?format=json(?:&amp;)?$/, "");
    const articleNumber = decodeHtml(block.match(/class="title"[^>]*>([\s\S]*?)<\/a>/)?.[1]);
    const description = decodeHtml(block.match(/<div class="description">([\s\S]*?)<\/div>/)?.[1]);
    const analyticsItem = analytics.get(articleNumber) ?? {};
    const variant = decodeHtml(String(analyticsItem.item_variant ?? ""));
    const priceEur = decimal(analyticsItem.price);
    const kind = kindFrom(description);
    const system = systemFrom(description);
    const specs = parseSpecs(description, variant);
    const compactArticle = articleNumber.replace(/[^0-9A-Za-z]/g, "");
    const hasDxfCandidate = /^[0-9]{2,3}\.[0-9]{3}[A-Za-z]?$/.test(articleNumber);
    return {
      id: compactArticle.toLowerCase(),
      maker: "CTG",
      articleNumber,
      name: description || `CTG ${articleNumber}`,
      kind,
      family: familyFrom(description, kind),
      system,
      angleDeg: specs.angle,
      radiusMm: specs.radius,
      heightMm: specs.height,
      vOpeningMm: specs.vOpening,
      lengthMm: specs.length,
      variant: variant || undefined,
      priceEur,
      sourceUrl,
      dxfUrl: compactArticle && hasDxfCandidate
        ? `https://daten.ukb-gmbh.de/dxf/zip/${compactArticle}.DXF.zip`
        : undefined,
      geometryStatus: (kind === "punch" || kind === "die") && hasDxfCandidate ? "official-dxf-candidate" : "metadata-only",
      licenseStatus: "source-link-only",
      importedAt: IMPORTED_AT,
    };
  }).filter((tool) => tool.articleNumber && tool.sourceUrl);
}

async function fetchPage(page) {
  const url = page === 1
    ? ROOT_URL
    : `https://www.ukb-gmbh.de/en/products/page${page}.html?mode=list`;
  const response = await fetch(url, {
    headers: { "user-agent": "BendPilot catalog indexer/1.0 (+source links only)" },
  });
  if (!response.ok) throw new Error(`CTG page ${page}: ${response.status}`);
  return response.text();
}

if (process.argv.includes("--normalize-existing")) {
  const existing = JSON.parse(await readFile(OUTPUT, "utf8"));
  const tools = existing.tools.map((tool) => {
    const kind = kindFrom(tool.name);
    const compactArticle = tool.articleNumber.replace(/[^0-9A-Za-z]/g, "");
    const hasDxfCandidate = /^[0-9]{2,3}\.[0-9]{3}[A-Za-z]?$/.test(tool.articleNumber);
    return {
      ...tool,
      kind,
      family: familyFrom(tool.name, kind),
      dxfUrl: compactArticle && hasDxfCandidate
        ? `https://daten.ukb-gmbh.de/dxf/zip/${compactArticle}.DXF.zip`
        : undefined,
      geometryStatus: (kind === "punch" || kind === "die") && hasDxfCandidate
        ? "official-dxf-candidate"
        : "metadata-only",
    };
  });
  const counts = tools.reduce((result, tool) => {
    result[tool.kind] = (result[tool.kind] ?? 0) + 1;
    return result;
  }, {});
  await writeFile(OUTPUT, `${JSON.stringify({ ...existing, total: tools.length, counts, tools }, null, 2)}\n`);
  process.stdout.write(`Normalized ${tools.length} existing CTG records in ${OUTPUT}\n`);
  process.exit(0);
}

const firstHtml = await fetchPage(1);
const pageNumbers = [...firstHtml.matchAll(/\/page(\d+)\.html\?mode=list/g)]
  .map((match) => Number(match[1]));
const pageCount = Math.max(1, ...pageNumbers);
const pages = [firstHtml];

for (let page = 2; page <= pageCount; page += 1) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
  pages.push(await fetchPage(page));
  process.stdout.write(`Imported CTG page ${page}/${pageCount}\n`);
}

const deduplicated = new Map();
for (const tool of pages.flatMap(extractProducts)) {
  const key = `${tool.articleNumber}|${tool.variant ?? ""}`;
  if (!deduplicated.has(key)) deduplicated.set(key, tool);
}

const tools = [...deduplicated.values()].sort((left, right) =>
  left.articleNumber.localeCompare(right.articleNumber, "en", { numeric: true })
);
const counts = tools.reduce((result, tool) => {
  result[tool.kind] = (result[tool.kind] ?? 0) + 1;
  return result;
}, {});

await writeFile(OUTPUT, `${JSON.stringify({
  source: ROOT_URL,
  importedAt: IMPORTED_AT,
  pageCount,
  total: tools.length,
  counts,
  tools,
}, null, 2)}\n`);

process.stdout.write(`Saved ${tools.length} CTG records to ${OUTPUT}\n`);
