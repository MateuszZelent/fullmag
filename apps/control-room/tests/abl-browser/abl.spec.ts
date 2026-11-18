import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, expect, type Response } from "playwright/test";
import { scalarColorRgb } from "../../src/shared/visualization/scalarColorPalette";
import { installFdmColorProbe } from "./renderedFdmColors";
import { decodeFieldVector } from "../../src/kernel/api/codecs/fieldVectorCodec";

type Profile = "logarithmic" | "tanh" | "custom";
type Face = "x+" | "x-";
type Layer = { profile: Profile; face: Face; amplitude: number };

test.use({
  browserName: "chromium",
  viewport: { width: 1440, height: 1000 },
  launchOptions: {
    executablePath: process.env.FULLMAG_QA_CHROMIUM || undefined,
    args: ["--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  },
});

function expectedAlpha(x: number, layer: Layer | null): number {
  if (!layer) return 0.01;
  const distanceNm = ((layer.face === "x-" ? x : 31 - x) + 0.5) * 5;
  const u = Math.max(0, Math.min(1, (40 - distanceNm) / 20));
  const weight = {
    logarithmic: Math.log1p(9 * u) / Math.log(10),
    tanh: (1 + Math.tanh(4 * u - 2) / Math.tanh(2)) / 2,
    custom: u ** 3,
  }[layer.profile];
  return 0.01 + layer.amplitude * weight;
}

test("ABL editor updates the live FDM damping field and canonical script", async ({ page }, info) => {
  test.setTimeout(360_000);
  const workspaceStartupTimeout = 120_000;
  const timeout = 30_000;
  page.setDefaultTimeout(timeout);
  expect(process.env.FULLMAG_QA_ALLOW_ABL_WRITE, "requires explicit writes to a seeded QA scene").toBe("1");
  const fixture = JSON.parse(await readFile(process.env.FULLMAG_QA_FIXTURE!, "utf8"));
  const origin = new URL(process.env.FULLMAG_QA_URL!);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(origin.hostname);
  expect(origin.protocol).toBe("http:");
  expect(origin.port).toBeTruthy();
  expect(fixture.origin).toBe(origin.origin);
  expect(fixture.name).toMatch(/^ABL browser QA [0-9a-f]{32}$/);
  expect(fixture.object_id).toBe("ABL QA film");
  expect(fixture.baseline_grid_command).toBeTruthy();
  const url = (path: string) => new URL("/v2/sessions/current/" + path, origin).href;
  const pin = fixture.pin;
  const scope = new URLSearchParams({
    session: pin.session_id, epoch: pin.session_epoch, request_scope_epoch: pin.request_scope_epoch,
  }).toString();
  const headers = { "x-fullmag-session-scope": scope };
  const verifyIdentity = async () => {
    const response = await page.request.get(url("status"));
    expect(response.status()).toBe(200);
    const status = await response.json();
    expect(status.lifecycle.session_resource).toBe("active");
    for (const key of ["session_id", "session_epoch", "request_scope_epoch"]) {
      expect(typeof pin[key]).toBe("string");
      expect(pin[key]).toBeTruthy();
      expect(status.session[key]).toBe(pin[key]);
    }
    expect(status.session.name).toBe(fixture.name);
  };
  const readScene = async () => {
    await verifyIdentity();
    const response = await page.request.get(url("model/scene"), { headers });
    expect(response.status()).toBe(200);
    const scene = await response.json();
    expect(scene.scene.name).toBe(fixture.name);
    expect(scene.objects.map((obj: { id: string }) => obj.id)).toEqual([fixture.object_id]);
    return scene;
  };

  let revision = (await readScene()).revision;
  expect((await readScene()).objects[0].absorbing_boundary ?? null).toBeNull();
  const objectUrl = url("model/objects/" + encodeURIComponent(fixture.object_id));
  const samplesUrl = url("data/fields/mat_alpha/samples/vector");
  const viewport = page.locator(".fm-viewport-3d");
  const canvas = viewport.locator("canvas").first();
  const label = viewport.locator('[data-quantity-id="mat_alpha"][data-field-state="data-ready"]');
  const inspectField = async (response: Response, layer: Layer | null) => {
    const bytes = await response.body();
    const packet = decodeFieldVector(Uint8Array.from(bytes).buffer);
    expect(packet.quantityId).toBe("mat_alpha");
    expect(packet.grid).toEqual([32, 8, 2]);
    expect(packet.nComp).toBe(1);
    let maximumError = 0;
    for (let i = 0; i < packet.values.length; i++) {
      maximumError = Math.max(maximumError, Math.abs(packet.values[i] - expectedAlpha(i % 32, layer)));
    }
    return { maximumError, etag: response.headers().etag, sha256: createHash("sha256").update(bytes).digest("hex"),
      firstRow: Array.from(packet.values.slice(0, 32)) };
  };
  await page.addInitScript(installFdmColorProbe);
  const evidence: unknown[] = [];
  const observeChange = async (step: string, layer: Layer | null, action: () => Promise<void>) => {
    // Only traffic issued by this page after the edit counts. A separate API
    // poll could otherwise make a stale viewport look like an updated field.
    const issued = new WeakSet();
    const onRequest = (request: import("playwright/test").Request) => {
      if (request.url().split("?")[0] === samplesUrl) issued.add(request);
    };
    const beforeDraw = page.url() === "about:blank" ? 0 : await page.evaluate(() => {
      window.ablColorProbe.armed = true;
      return window.ablColorProbe.sequence;
    });
    page.on("request", onRequest);
    let lastObservation: Awaited<ReturnType<typeof inspectField>> | undefined;
    try {
      await Promise.all([
        page.waitForResponse(async (response) => {
          if (!issued.has(response.request()) || response.status() !== 200) return false;
          lastObservation = await inspectField(response, layer);
          return lastObservation.maximumError < 2e-7;
        }, { timeout: step === "baseline" ? workspaceStartupTimeout + timeout : timeout }),
        action(),
      ]);
      await expect(label).toBeVisible({ timeout });
      // The clean fixture uses the default Viridis palette and automatic range.
      // Compare the FMVP row with RGB actually bound to a cuboid draw, ordered
      // by world x from its per-instance matrices. A stale redraw cannot pass.
      const row = lastObservation!.firstRow;
      const min = Math.min(...row), max = Math.max(...row);
      const expectedColors = row.map(alpha => scalarColorRgb(max === min ? 0.5 : (alpha - min) / (max - min), "viridis"));
      const matched = await page.waitForFunction(({ beforeDraw, expectedColors }) => {
        const draw = window.ablColorProbe.draw;
        if (!draw || draw.sequence <= beforeDraw || !(draw.spread <= 1e-5)) return false;
        return draw.row.every((rgb, x) =>
          rgb.every((channel, k) => Math.abs(channel - expectedColors[x][k]) < 1e-5)) ? draw : false;
      }, { beforeDraw, expectedColors }, { timeout });
      const rendered = await matched.jsonValue();
      await matched.dispose();
      await expect(viewport).toHaveAttribute("data-fdm-model-count", "512", { timeout });
      await expect(canvas).toBeVisible();
      const drawingBuffer = await canvas.evaluate((node: HTMLCanvasElement) => {
        const gl = node.getContext("webgl2") || node.getContext("webgl");
        return gl && !gl.isContextLost() ? [gl.drawingBufferWidth, gl.drawingBufferHeight] : [];
      });
      expect(drawingBuffer).toHaveLength(2);
      expect(Math.min(...drawingBuffer)).toBeGreaterThan(0);
      await canvas.screenshot({ path: info.outputPath(step + ".png") });
      evidence.push({ step, revision, layer, drawingBuffer, rendered, ...lastObservation });
    } finally {
      page.off("request", onRequest);
      if (!page.isClosed() && page.url() !== "about:blank") {
        const lastDraw = await page.evaluate(() => {
          window.ablColorProbe.armed = false;
          return window.ablColorProbe.draw;
        });
        await info.attach(step + "-surface-rgb", { body: JSON.stringify(lastDraw), contentType: "application/json" });
      }
      await info.attach(step + "-samples", { body: JSON.stringify(lastObservation ?? null), contentType: "application/json" });
    }
  };

  await observeChange("baseline", null, async () => {
    await page.goto(new URL("/workspace", origin).href, { waitUntil: "domcontentloaded", timeout: workspaceStartupTimeout });
    await expect(page.getByRole("tab", { name: fixture.name, exact: true })).toBeVisible({ timeout: workspaceStartupTimeout });
    const home = page.locator('.fm-home-overlay[data-state="home-overlay"]');
    if (await home.isVisible()) await page.getByRole("button", { name: "Back to simulation", exact: true }).click();
    await page.locator("#fm-main-content.fm-workspace-body").waitFor();
    if (!(await viewport.locator('[data-quantity-id="mat_alpha"]').isVisible())) {
      await page.locator("#fm-ribbon-tab-results").click();
      await page.locator('[data-ribbon-action-id="res-m"] [data-ribbon-menu-trigger]').click();
      await page.getByRole("menuitemradio", { name: "α", exact: true }).click();
    }
  });
  await page.getByRole("tab", { name: "Workspace", exact: true }).click();
  await page.getByTitle("Expand All", { exact: true }).click();
  const parentId = `model:object:${fixture.object_id}:magnetic-parameters`;
  const parent = page.locator(`[data-node-id="${parentId}"]`);
  const child = page.locator(`[data-node-id="${parentId}:absorbing-boundary"]`);
  await parent.click();
  const enabled = page.getByRole("checkbox", { name: "Absorbing Boundary", exact: true });
  const save = page.getByRole("button", { name: "Apply", exact: true });
  await expect(enabled).not.toBeChecked();
  await expect(child).toHaveCount(0);
  await expect(page.getByLabel("Ramp width", { exact: true })).toHaveCount(0);
  if (await parent.getAttribute("aria-expanded") === "true") {
    await parent.locator(".fm-explorer-tree-row__branch").click();
  }
  await enabled.check();
  const [activation] = await Promise.all([
    page.waitForResponse(r => r.url() === objectUrl && r.request().method() === "PATCH"),
    save.click(),
  ]);
  expect(activation.status()).toBe(200);
  const activatedScene = await readScene();
  expect(activatedScene.revision).toBeGreaterThan(revision);
  revision = activatedScene.revision;
  expect(activatedScene.objects[0].absorbing_boundary.faces).toContain("x+");
  await expect(parent).toHaveAttribute("aria-expanded", "true");
  await expect(child).toBeVisible();
  await child.click();
  const field = (name: string) => page.locator("input,select").and(page.getByLabel(name, { exact: true }));
  const group = page.locator('section[data-slot="inspector-group"]').filter({ has: field("Profile") });
  await expect(group).toBeVisible();
  const panel = await group.elementHandle();
  const apply = async (step: string, layer: Layer | null) => {
    await readScene();
    const patch = layer ? { total_width_m: 40e-9, ramp_width_m: 20e-9, max_damping: layer.amplitude,
      profile: layer.profile, frame: "universe", faces: [layer.face],
      ...(layer.profile === "custom" ? { expression: "u**3" } : {}) } : null;
    await observeChange(step, layer, async () => {
      const [saved] = await Promise.all([
        page.waitForResponse((r) => r.url() === objectUrl && r.request().method() === "PATCH", { timeout }),
        save.click(),
      ]);
      expect(saved.status()).toBe(200);
      expect(saved.request().postDataJSON().absorbing_boundary).toEqual(patch);
      const scene = await readScene();
      expect(scene.revision).toBeGreaterThan(revision);
      revision = scene.revision;
      expect(scene.objects[0].absorbing_boundary ?? null).toEqual(patch);
    });
    if (layer) {
      await expect(group).toBeVisible();
      expect(await group.evaluate((element, original) => element === original, panel)).toBe(true);
    } else {
      await expect(child).toHaveCount(0);
      await expect(enabled).not.toBeChecked();
    }
    if (layer?.profile === "custom" || !layer) {
      const rendered = await page.request.post(url("model/syncs"), { headers, data: { expected_scene_revision: revision } });
      expect(rendered.status()).toBe(200);
      const { source } = await rendered.json();
      expect(typeof source).toBe("string");
      const calls = source.split("\n").filter((line: string) => line.includes(".alpha.absorbing_boundary("));
      expect(calls).toHaveLength(layer ? 1 : 0);
      if (layer) {
        expect(calls[0]).toContain('expression="u**3"');
        expect(calls[0]).toContain('faces=("x-",)');
      }
      await info.attach(step + "-export.py", { body: source, contentType: "text/x-python" });
    }
  };
  await field("Total width").fill("4e-8");
  await field("Ramp width").fill("2e-8");
  await field("Maximum damping").fill("0.5");
  await field("Frame").selectOption("universe");
  await field("Profile").selectOption("logarithmic");
  await field("x+").check();
  await expect(field("Expression")).toHaveCount(0);
  await apply("added-x-plus", { profile: "logarithmic", face: "x+", amplitude: 0.5 });
  await field("x+").uncheck();
  await field("x-").check();
  await field("Profile").selectOption("tanh");
  await field("Maximum damping").fill("0.8");
  await expect(field("Expression")).toHaveCount(0);
  await apply("moved-x-minus", { profile: "tanh", face: "x-", amplitude: 0.8 });
  await field("Profile").selectOption("custom");
  await field("Expression").fill("u**3");
  await apply("custom", { profile: "custom", face: "x-", amplitude: 0.8 });
  await parent.click();
  await enabled.uncheck();
  await apply("removed", null);
  await info.attach("abl-field-evidence", { body: JSON.stringify({ session: pin, evidence }), contentType: "application/json" });
});
