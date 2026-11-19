import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test, expect, type APIResponse, type Request, type Response } from "playwright/test";
import { scalarColorRgb } from "../../src/shared/visualization/scalarColorPalette";
import { installFdmColorProbe } from "./renderedFdmColors";
import { installInspectorCommitTrace } from "../../scripts/lib/inspector-commit-trace.mjs";
import { decodeFieldVector } from "../../src/kernel/api/codecs/fieldVectorCodec";

type Profile = "logarithmic" | "tanh" | "custom";
type Face = "x+" | "x-";
type Layer = { profile: Profile; face: Face; amplitude: number; boundaryNm?: number };
type FieldCase = Layer | Layer[] | null;

test.use({
  browserName: "chromium",
  screenshot: "only-on-failure",
  viewport: { width: 1440, height: 1000 },
  launchOptions: {
    executablePath: process.env.FULLMAG_QA_CHROMIUM || undefined,
    args: ["--use-angle=swiftshader-webgl", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  },
});

function expectedAlpha(x: number, layer: FieldCase): number {
  if (!layer) return 0.01;
  if (Array.isArray(layer)) return Math.max(0.01, ...layer.map(item => expectedAlpha(x, item)));
  const xNm = -80 + (x + 0.5) * 5;
  const boundary = layer.boundaryNm ?? (layer.face === "x-" ? -80 : 80);
  const distanceNm = layer.face === "x-" ? xNm - boundary : boundary - xNm;
  if (distanceNm < 0 || distanceNm > 40) return 0.01;
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
  const inspectField = async (response: Response | APIResponse, layer: FieldCase) => {
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
  await installInspectorCommitTrace(page);
  const evidence: unknown[] = [];
  const observeChange = async (step: string, layer: FieldCase, action: () => Promise<void>) => {
    // Only traffic issued by this page after the edit counts. A separate API
    // poll could otherwise make a stale viewport look like an updated field.
    const issued = new WeakSet<Request>();
    const traffic: unknown[] = [];
    const record = (entry: unknown) => {
      if (traffic.length === 64) traffic.shift();
      traffic.push(entry);
    };
    const onRequest = (request: Request) => {
      if (request.url().split("?")[0] !== samplesUrl) return;
      issued.add(request);
      record({ event: "request", query: new URL(request.url()).search,
        ifNoneMatch: request.headers()["if-none-match"] });
    };
    const onResponse = (response: Response) => {
      if (issued.has(response.request())) record({ event: "response", status: response.status(),
        etag: response.headers().etag, revision: response.headers()["x-fullmag-field-revision"] });
    };
    const onFailure = (request: Request) => {
      if (issued.has(request)) record({ event: "failure", error: request.failure()?.errorText });
    };
    const beforeDraw = page.url() === "about:blank" ? 0 : await page.evaluate(() => {
      window.ablColorProbe.armed = true;
      return window.ablColorProbe.sequence;
    });
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("requestfailed", onFailure);
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
    } catch (error) {
      const diagnostics: Record<string, unknown> = { revision, pin, traffic };
      try {
        await verifyIdentity();
        const meta = await page.request.get(url("data/fields/mat_alpha/meta"), { headers, timeout: 5000 });
        diagnostics.metaStatus = meta.status();
        if (meta.ok()) {
          const field = await meta.json();
          diagnostics.field = Object.fromEntries(["state", "field_revision", "source_revision", "domain_generation_id",
            "location", "stats", "materialization_reason_code"].map(key => [key, field[key]]));
        }
        const response = await page.request.get(samplesUrl + "?component=full", { headers, timeout: 5000 });
        diagnostics.directStatus = response.status();
        if (response.status() === 200) diagnostics.directField = await inspectField(response, layer);
      } catch (probeError) {
        diagnostics.probeError = String(probeError);
      }
      await writeFile(info.outputPath(step + "-field-diagnostics.json"), JSON.stringify(diagnostics, null, 2));
      throw error;
    } finally {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onFailure);
      if (!page.isClosed() && page.url() !== "about:blank") {
        const lastDraw = await page.evaluate(() => {
          window.ablColorProbe.armed = false;
          return window.ablColorProbe.draw;
        });
        await writeFile(info.outputPath(step + "-surface-rgb.json"), JSON.stringify(lastDraw));
      }
      await writeFile(info.outputPath(step + "-samples.json"), JSON.stringify(lastObservation ?? null));
    }
  };

  await observeChange("baseline", null, async () => {
    await page.goto(new URL("/workspace", origin).href, { waitUntil: "domcontentloaded", timeout: workspaceStartupTimeout });
    await expect(page.getByRole("tab", { name: fixture.name, exact: true })).toBeVisible({ timeout: workspaceStartupTimeout });
    const home = page.locator('.fm-home-overlay[data-state="home-overlay"]');
    if (await home.isVisible()) await page.getByRole("button", { name: "Back to simulation", exact: true }).click();
    await page.locator("#fm-main-content.fm-workspace-body").waitFor();
    await page.getByRole("tab", { name: "Workspace", exact: true }).click();
    await page.getByTitle("Expand All", { exact: true }).click();
    await page.locator(`[data-node-id="model:object:${fixture.object_id}:visualization"]`).click();
    const shaded = page.getByRole("radio", { name: "Shaded", exact: true });
    await page.getByRole("radio", { name: "Off", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Off", exact: true })).toBeChecked();
    await shaded.click();
    await expect(shaded).toBeChecked();
    const quantity = page.getByRole("combobox", { name: "Quantity source", exact: true });
    await expect(quantity).toBeEnabled({ timeout });
    await quantity.click();
    await page.getByRole("option", { name: /material alpha|gilbert damping|α/i }).first().click();
    await expect(quantity).toContainText(/alpha|damping|α/i);
  });
  await page.screenshot({ path: info.outputPath("shaded-material-alpha.png") });
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
      await writeFile(info.outputPath(step + "-export.py"), source);
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
  const left: Layer = { profile: "custom", face: "x-", amplitude: 0.8, boundaryNm: -80 };
  const right: Layer = { profile: "custom", face: "x+", amplitude: 0.3, boundaryNm: 40 };
  await field("Geometry").selectOption("plane");
  await field("Origin X").fill("-8e-8");
  await page.getByRole("button", { name: "Reverse normal" }).click();
  await field("Layer name").fill("Left plane");
  await page.getByRole("button", { name: "Duplicate layer" }).click();
  await field("Layer name").fill("Interior plane");
  await field("Origin X").fill("4e-8");
  await page.getByRole("button", { name: "Reverse normal" }).click();
  await field("Maximum damping").fill("0.3");
  // Hold the first collection PATCH to exercise draft focus and structural stability across pending and ACK.
  const inspectorSnapshot = () => group.evaluate(root => {
    const scrollArea = root.closest(".fm-scroll-area__viewport");
    if (!scrollArea) throw new Error("Missing Inspector scroll viewport");
    return {
      fields: [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select")].map(control => ({
        label: control.getAttribute("aria-label"), disabled: control.disabled, opacity: getComputedStyle(control).opacity,
      })),
      animations: root.getAnimations({ subtree: true }).filter(a =>
        a.effect instanceof KeyframeEffect && a.effect.getKeyframes().some(frame => "opacity" in frame)).length,
      scroll: scrollArea.scrollTop, focus: document.activeElement?.getAttribute("aria-label"),
    };
  });
  const commitCount = () => page.evaluate(() => {
    const trace = (window as Window & {
      __FULLMAG_INSPECTOR_COMMIT_TRACE__?: { commits: unknown[]; dropped: number; errors: number };
    }).__FULLMAG_INSPECTOR_COMMIT_TRACE__;
    if (!trace || trace.errors) throw new Error("Inspector render trace is unavailable");
    return trace.commits.length + trace.dropped;
  });
  const saveLayers = async (step: string, expected: Layer[], expectedCount: number) => {
    await verifyIdentity();
    await observeChange(step, expected, async () => {
      const [response] = await Promise.all([
        page.waitForResponse(r => r.url() === objectUrl && r.request().method() === "PATCH"),
        save.evaluate((button: HTMLButtonElement) => button.click()),
      ]);
      expect(response.status()).toBe(200);
      const scene = await readScene();
      expect(scene.revision).toBeGreaterThan(revision);
      revision = scene.revision;
      const layers = scene.objects[0].absorbing_boundary.layers;
      expect(layers).toEqual(response.request().postDataJSON().absorbing_boundary.layers);
      expect(new Set(layers.map((item: { layer_id: string }) => item.layer_id)).size).toBe(expectedCount);
      expect(layers[0]).toMatchObject({ name: "Left plane", geometry: { kind: "plane", normal: [-1, 0, 0], origin: [expectedCount === 2 ? -8e-8 : -6e-8, 0, 0] } });
      if (expectedCount === 2) {
        expect(layers[1]).toMatchObject({ name: "Interior plane", enabled: expected.length === 2,
          geometry: { kind: "plane", normal: [1, 0, 0], origin: [4e-8, 0, 0] } });
      }
    });
    expect(await group.evaluate((element, original) => element === original, panel)).toBe(true);
  };
  await field("Origin X").focus();
  const baseline = await inspectorSnapshot();
  expect(baseline.focus).toBe("Origin X");
  expect(baseline.animations).toBe(0);
  const beforeCommits = await commitCount();
  let patchCount = 0;
  await page.route(objectUrl, async route => {
    if (route.request().method() === "PATCH") {
      patchCount++;
      try {
        expect(await inspectorSnapshot()).toEqual(baseline);
        expect(await group.evaluate((element, original) => element === original, panel)).toBe(true);
      } finally {
        await route.continue();
      }
    } else {
      await route.continue();
    }
  });
  try {
    await saveLayers("two-distinct-planes", [left, right], 2);
    expect(await inspectorSnapshot()).toEqual(baseline);
    expect(patchCount).toBe(1);
    expect(await commitCount() - beforeCommits).toBeLessThanOrEqual(48);
    await page.screenshot({ path: info.outputPath("independent-planes-inspector.png") });
  } finally {
    await page.unroute(objectUrl);
  }
  await field("Layer enabled").uncheck();
  await saveLayers("interior-plane-disabled", [left], 2);
  await page.getByRole("button", { name: "Remove layer" }).click();
  // Reposition the remaining plane so its field changes after removal as well.
  await field("Origin X").fill("-6e-8");
  await saveLayers("interior-plane-removed", [{ ...left, boundaryNm: -60 }], 1);
  await parent.click();
  await enabled.uncheck();
  await apply("removed", null);
  await writeFile(info.outputPath("abl-field-evidence.json"), JSON.stringify({ session: pin, evidence }, null, 2));
});
