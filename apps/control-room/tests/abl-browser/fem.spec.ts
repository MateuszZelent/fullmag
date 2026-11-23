import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "playwright/test";
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
  // Verify the nodal field independently of the WebGL vertex attributes.
  // Chromium may release a response body when a resource hook supersedes a request.
  async function checkMap(amplitude: number, sampleUrl: string) {
    expect(sampleUrl.startsWith(prefix)).toBe(true);
    const response = await get(sampleUrl.slice(prefix.length));
    const field = decodeFieldVector(Uint8Array.from(await response.body()).buffer);
    expect(field.quantityId).toBe("mat_alpha");
    expect(field.nComp).toBe(1);
    expect(field.meshTopologyHash?.replace(/^sha256:/, "")).toBe(manifest.topology_fingerprint.replace(/^sha256:/, ""));
    const covered = new Set<number>();
    const hits = { left: 0, right: 0, upperRing: 0, lowerControl: 0, base: 0 };
    let maxError = 0;
    let worst: { node: number; x: number; y: number; expected: number; actual: number } | null = null;
    for (let i = 0; i < field.pointCount; i++) {
      const node = field.indexing === "full_domain" ? i : field.nodeIndices![i];
      if (!filmNodes.has(node)) continue;
      covered.add(node);
      const x = topology.positions[3 * node] * 1e9;
      const y = topology.positions[3 * node + 1] * 1e9;
      const depth = 35 - Math.hypot(x - 8, y);
      const left = 0.3 * weight(100 + x, 25, 20, 1);
      const right = 0.6 * weight(100 - x, 40, 24, 2);
      const insideUpperHalf = Math.abs(y - 25) <= 25 * (1 + 1e-12);
      const ring = insideUpperHalf ? amplitude * weight(depth, 15, 12, 3) : 0;
      const expected = 0.01 + Math.max(left, right, ring);
      const error = Math.abs(field.values[i] - expected);
      if (!Number.isFinite(error)) throw new Error(`Nonfinite material comparison at node ${node}`);
      if (error > maxError) {
        maxError = error;
        worst = { node, x, y, expected, actual: field.values[i] };
      }
      if (left > 0.1) hits.left++;
      if (right > 0.1) hits.right++;
      if (y > 0 && ring > amplitude / 2) hits.upperRing++;
      if (y < -1 && depth > 0 && depth < 10 && expected === 0.01) hits.lowerControl++;
      if (expected === 0.01) hits.base++;
    }
    await writeFile(info.outputPath(`fem-alpha-${amplitude}.json`),
      JSON.stringify({ nodes: covered.size, expectedNodes: filmNodes.size, hits, maxError, worst }, null, 2));
    expect(covered.size).toBe(filmNodes.size);
    expect(Math.min(...Object.values(hits))).toBeGreaterThan(0);
    expect(maxError, JSON.stringify(worst)).toBeLessThan(3e-6);
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
  const shaded = page.getByRole("radio", { name: "Shaded", exact: true });
  await page.getByRole("radio", { name: "Off", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Off", exact: true })).toBeChecked();
  await shaded.click();
  await expect(shaded).toBeChecked();
  const quantity = page.getByRole("combobox", { name: "Quantity source", exact: true });
  await expect(quantity).toBeEnabled({ timeout: 90_000 });
  await quantity.click();
  const nextAlphaTransfer = (previousEtag?: string) => page.waitForEvent("requestfinished", async request => {
    if (new URL(request.url()).pathname !== "/v2/sessions/current/data/fields/mat_alpha/samples/vector") return false;
    const response = await request.response();
    return response?.status() === 200 && !!response.headers().etag && response.headers().etag !== previousEtag;
  });
  const [initialRequest] = await Promise.all([
    nextAlphaTransfer(),
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
  const initialEtag = (await initialRequest.response())!.headers().etag;
  const initial = await checkMap(0.45, initialRequest.url());
  const initialDraw = await verifyDraw(initial, 0);
  await page.screenshot({ path: info.outputPath("material-alpha.png") });
  // The existing three-layer FEM absorber should open without rewriting its settings.
  await page.locator('[data-node-id="model:object:film"]').click();
  await page.getByRole("tab", { name: "Physics", exact: true }).click();
  await page.getByRole("button", { name: "Add ABL", exact: true }).click();
  await expect(page.locator('[data-node-id="model:object:film:absorbing-boundary"]'))
    .toHaveAttribute("aria-selected", "true");
  const reopened = await (await get("model/scene")).json();
  expect(reopened.revision).toBe(scene.revision);
  expect(reopened.objects[0].absorbing_boundary).toEqual(scene.objects[0].absorbing_boundary);
  await page.getByRole("button", { name: "Upper semicircle", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Contour geometry", exact: true }))
    .toHaveText("Cylindrical radial shell");
  await expect(page.getByRole("combobox", { name: "Target region", exact: true }))
    .toHaveText("Upper half");
  await expect(page.getByRole("textbox", { name: "Layer name", exact: true })).toHaveValue("Upper semicircle");
  await page.screenshot({ path: info.outputPath("semicircle-inspector.png") });
  const before = await page.evaluate(() => window.ablFemProbe.sequence);
  await page.locator("input").and(page.getByLabel("Maximum damping increment", { exact: true })).fill("0.12");
  const [, updatedRequest] = await Promise.all([
    page.waitForResponse(r => r.request().method() === "PATCH" && new URL(r.url()).pathname.endsWith("/model/objects/film"))
      .then(async response => {
        if (!response.ok()) throw new Error("FEM layer edit returned " + response.status() + ": " + (await response.text()).slice(0, 2000));
        const saved = await response.json();
        expect(saved.revision).toBeGreaterThan(scene.revision);
      }),
    nextAlphaTransfer(initialEtag),
    page.getByRole("button", { name: "Apply", exact: true }).click(),
  ]);
  const updated = await checkMap(0.12, updatedRequest.url());
  const updatedDraw = await verifyDraw(updated, before);
  await expect(page.locator(".fm-viewport-3d")).not.toContainText("topology stale");
  await page.screenshot({ path: info.outputPath("semicircle-after-edit.png") });
  await writeFile(info.outputPath("nodal-alpha.json"), JSON.stringify({ session, buffer, initial, initialDraw, updated, updatedDraw }, null, 2));
});
