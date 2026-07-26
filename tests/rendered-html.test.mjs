import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the BendPilot application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>BendPilot — 折弯模具智能选型<\/title>/i);
  assert.match(html, /BEND<em>PILOT<\/em>/);
  assert.match(html, />模具库<\/button>/);
  assert.match(html, /CTG 模具库/);
  assert.match(html, /二维工件截面画布/);
  assert.doesNotMatch(html, /Your site is taking shape|Codex is working|react-loading-skeleton/i);
});

test("ships a source-linked CTG catalog and strict local DXF workflow", async () => {
  const [catalogText, library, advisor, parser] = await Promise.all([
    readFile(new URL("../app/ctg-tool-data.json", import.meta.url), "utf8"),
    readFile(new URL("../app/tool-library.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/tool-advisor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/dxf-parser.js", import.meta.url), "utf8"),
  ]);
  const catalog = JSON.parse(catalogText);

  assert.equal(catalog.total, 880);
  assert.equal(catalog.tools.length, 880);
  assert.ok(catalog.tools.every((tool) => tool.sourceUrl.startsWith("https://www.ukb-gmbh.de/")));
  assert.ok(catalog.tools.some((tool) => tool.geometryStatus === "official-dxf-candidate"));
  assert.match(library, /非原厂族级示意/);
  assert.match(library, /不上传或再分发/);
  assert.match(library, /导入匹配的 DXF \/ ZIP/);
  assert.match(advisor, /DXF_GEOMETRY_PARSER_VERSION = "ukb-ascii-dxf\/2"/);
  assert.match(advisor, /采用修改方案并完成/);
  assert.match(advisor, /resolvePunchProfile\(selected\.punchProfile, custom\)/);
  assert.match(advisor, /保留原 \$\{punchProfileValue\(selected\.punchProfile\)\.polygon\.length\} 个轮廓点/);
  assert.doesNotMatch(advisor, /customProfileActive \? "gp28" : selected\.punchProfile/);
  assert.match(parser, /ZIP 中 DXF 的 CRC32 校验失败/);
  assert.match(parser, /仅允许 LINE\/ARC/);
});
