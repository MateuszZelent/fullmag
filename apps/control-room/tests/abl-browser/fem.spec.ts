import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type Response } from "playwright/test";
import { decodeTopology } from "../../src/kernel/api/codecs/topologyCodec";
import { decodeFieldVector } from "../../src/kernel/api/codecs/fieldVectorCodec";

import { scalarColorRgb } from "../../src/shared/visualization/scalarColorPalette";
import { installFemAlphaProbe, type FemDraw } from "./renderedFemAlpha";

test.use({
  browserName: "chromium",
  screenshot: "only-on-failure",
  viewport: { width: 1600, height: 1060 },
  launchOptions: {
    executablePath: process.env.FULLMAG_QA_CHROMIUM || undefined,
    args: ["--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  },
});

function weight(depthNm: number, widthNm: number, rampNm: number, exponent: number) {
  if (depthNm < -1e-8 || depthNm > widthNm) return 0;
  return Math.min(1, (widthNm - depthNm) / rampNm) ** exponent;
}

test("Material alpha follows the two ends and the region-clipped cylinder after an inspector edit", async ({ page }, info) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  expect(process.env.FULLMAG_QA_ALLOW_ABL_WRITE).toBe("1");
  const fixture = JSON.parse(await readFile(process.env.FULLMAG_QA_FIXTURE!, "utf8"));
  const origin = new URL(process.env.FULLMAG_QA_URL!);
  expect(origin.protocol).toBe("http:");
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(origin.hostname);
  expect(origin.port).toBeTruthy();
  expect(fixture.origin).toBe(origin.origin);
  expect(fixture.name).toMatch(/^ABL FEM browser QA [0-9a-f]{32}$/);
  expect(fixture.object_id).toBe("film");
  expect(fixture.mesh_command).toBeTruthy();
  const { session_id: session, session_epoch: epoch, request_scope_epoch } = fixture.pin;
  const headers = { "x-fullmag-session-scope": new URLSearchParams({ session, epoch, request_scope_epoch }).toString() };
  const prefix = origin.origin + "/v2/sessions/current/";
  async function get(path: string) {
    const response = await page.request.get(prefix + path, { headers });
    expect(response.status(), path).toBe(200);
    return response;
  }
  const status = await (await get("status")).json();
  expect(status.session).toMatchObject({ ...fixture.pin, name: fixture.name });
  const scene = await (await get("model/scene")).json();
  expect(scene.objects.map((o: { id: string }) => o.id)).toEqual(["film"]);
  expect(scene.objects[0].absorbing_boundary.layers.map((l: { layer_id: string }) => l.layer_id))
    .toEqual(["left", "right", "ring"]);
  const topology = decodeTopology(Uint8Array.from(await (await get("data/domain/topology")).body()).buffer);
  const manifest = await (await get("meshing/meshes/shared-domain/manifest")).json();
  const filmNodes = new Set<number>();
  for (const segment of manifest.object_segments.filter((s: { object_id: string }) => s.object_id === "film")) {
    for (let i = 0; i < segment.node_count; i++) filmNodes.add(segment.node_start + i);
  }
  expect(filmNodes.size).toBeGreaterThan(0);
  async function checkMap(amplitude: number, response: Response) {
    const field = decodeFieldVector(Uint8Array.from(await response.body()).buffer);
    expect(field.quantityId).toBe("mat_alpha");
    expect(field.nComp).toBe(1);
    expect(field.meshTopologyHash?.replace(/^sha256:/, "")).toBe(manifest.topology_fingerprint.replace(/^sha256:/, ""));
    const covered = new Set<number>();
    const hits = { left: 0, right: 0, upperRing: 0, lowerControl: 0, base: 0 };
    let maxError = 0;
    for (let i = 0; i < field.pointCount; i++) {
      const node = field.indexing === "full_domain" ? i : field.nodeIndices![i];
      if (!filmNodes.has(node)) continue;
      covered.add(node);
      const x = topology.positions[3 * node] * 1e9;
      const y = topology.positions[3 * node + 1] * 1e9;
      const depth = 35 - Math.hypot(x - 8, y);
      const left = 0.3 * weight(100 + x, 25, 20, 1);
      const right = 0.6 * weight(100 - x, 40, 24, 2);
      const ring = y >= -1e-9 ? amplitude * weight(depth, 15, 12, 3) : 0;
      const expected = 0.01 + Math.max(left, right, ring);
      maxError = Math.max(maxError, Math.abs(field.values[i] - expected));
      if (left > 0.1) hits.left++;
      if (right > 0.1) hits.right++;
      if (y > 0 && ring > amplitude / 2) hits.upperRing++;
      if (y < -1 && depth > 0 && depth < 10 && expected === 0.01) hits.lowerControl++;
      if (expected === 0.01) hits.base++;
    }
    expect(covered.size).toBe(filmNodes.size);
    expect(Math.min(...Object.values(hits))).toBeGreaterThan(0);
    expect(maxError).toBeLessThan(3e-6);
    const fieldMin = field.values.reduce((lo, v) => Math.min(lo, v), Infinity);
    const fieldMax = field.values.reduce((hi, v) => Math.max(hi, v), -Infinity);
    return { amplitude, nodes: covered.size, hits, maxError, fieldMin, fieldMax };
  }

  async function verifyDraw(map: Awaited<ReturnType<typeof checkMap>>, after: number) {
    let matched: FemDraw | undefined;
    await expect.poll(async () => {
      const draws = await page.evaluate(() => window.ablFemProbe.draws);
      matched = draws.find(draw => draw.sequence > after && draw.samples.every(({ x, y, value }) => {
        const alpha = 0.01 + Math.max(0.3 * weight(100 + x, 25, 20, 1),
          0.6 * weight(100 - x, 40, 24, 2),
          y >= 0 ? map.amplitude * weight(35 - Math.hypot(x - 8, y), 15, 12, 3) : 0);
        const t = (alpha - map.fieldMin) / (map.fieldMax - map.fieldMin);
        const expected = draw.mode === "scalar" ? [t] : scalarColorRgb(t, "viridis");
        return value.every((channel, i) => Math.abs(channel - expected[i]) < 0.0003);
      }));
      return Boolean(matched);
    }, { timeout: 30_000 }).toBe(true);
    return matched!;
  }

  await page.addInitScript(installFemAlphaProbe);
  await page.goto(origin.origin + "/workspace", { waitUntil: "domcontentloaded", timeout: 120_000 });
  await expect(page.getByRole("tab", { name: fixture.name, exact: true })).toBeVisible({ timeout: 120_000 });
  if (await page.locator('.fm-home-overlay[data-state="home-overlay"]').isVisible()) {
    await page.getByRole("button", { name: "Back to simulation", exact: true }).click();
  }
  await page.getByRole("tab", { name: "Workspace", exact: true }).click();
  await page.getByTitle("Expand All", { exact: true }).click();
  await page.locator('[data-node-id="model:object:film:visualization"]').click();
  const quantity = page.getByRole("combobox", { name: "Quantity source", exact: true });
  await expect(quantity).toBeEnabled({ timeout: 90_000 });
  await quantity.click();
  const isAlpha = (r: Response) => new URL(r.url()).pathname.endsWith("/data/fields/mat_alpha/samples/vector") && r.status() === 200;
  const [initialResponse] = await Promise.all([
    page.waitForResponse(isAlpha),
    page.getByRole("option", { name: /alpha|α/i }).first().click(),
  ]);
  await expect(quantity).toContainText(/alpha|α/i);
  const canvas = page.locator(".fm-viewport-3d canvas").first();
  await expect(canvas).toBeVisible();
  const buffer = await canvas.evaluate((c: HTMLCanvasElement) => {
    const gl = c.getContext("webgl2");
    return gl && !gl.isContextLost() ? [gl.drawingBufferWidth, gl.drawingBufferHeight] : [];
  });
  expect(buffer).toHaveLength(2);
  expect(Math.min(...buffer)).toBeGreaterThan(0);
  const initial = await checkMap(0.45, initialResponse);
  const initialDraw = await verifyDraw(initial, 0);
  await page.screenshot({ path: info.outputPath("material-alpha.png") });
  await page.locator('[data-node-id="model:object:film:magnetic-parameters:absorbing-boundary"]').click();
  const select = (name: string) => page.locator("select").and(page.getByLabel(name, { exact: true }));
  await select("Layer").selectOption("ring");
  await expect(select("Geometry")).toHaveValue("cylinder");
  await expect(select("Target material")).toHaveValue("upper-half");
  await expect(page.getByLabel("Layer name", { exact: true })).toHaveValue("Upper semicircle");
  await page.screenshot({ path: info.outputPath("semicircle-inspector.png") });
  const before = await page.evaluate(() => window.ablFemProbe.sequence);
  await page.getByLabel("Maximum damping", { exact: true }).fill("0.12");
  const [patch, updatedResponse] = await Promise.all([
    page.waitForResponse(r => r.request().method() === "PATCH" && new URL(r.url()).pathname.endsWith("/model/objects/film")),
    page.waitForResponse(isAlpha),
    page.getByRole("button", { name: "Apply", exact: true }).click(),
  ]);
  expect(patch.status()).toBe(200);
  const updated = await checkMap(0.12, updatedResponse);
  const updatedDraw = await verifyDraw(updated, before);
  await page.screenshot({ path: info.outputPath("semicircle-after-edit.png") });
  await writeFile(info.outputPath("nodal-alpha.json"), JSON.stringify({ session, buffer, initial, initialDraw, updated, updatedDraw }, null, 2));
});
