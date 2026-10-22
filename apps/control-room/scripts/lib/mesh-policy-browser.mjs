import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Uses the production UI and the inspector smoke's typed resource fixture.
// PUT responses remain pending until the test explicitly acknowledges them.
export async function qualifyMeshPolicyEditing({ page, fixture, outputDir, workspaceUrl, fulfillJson, fulfillTopology }) {
  const originalViewport = page.viewportSize();
  const auditViewport = originalViewport ? { ...originalViewport, height: Math.min(originalViewport.height, 620) } : null;
  let viewportChanged = false;
  const objectPath = "/v2/sessions/current/meshing/policies/objects/film";
  const airboxPath = "/v2/sessions/current/meshing/policies/universe";
  const policies = new Map([
    [objectPath, { object_id: "film", config: { maximum_element_size: 1e-8 }, effective_config: null, revision: 12 }],
    [airboxPath, { config: { airbox_hmax: 2e-8, padding: [1e-7, 1e-7, 1e-7] }, effective_config: null, revision: 12 }],
  ]);
  const evidence = { scenarios: [], mutations: [], requests: [], screenshots: [] };
  let acknowledge = null;
  let pendingRequest = null;
  await page.route("**/v2/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    evidence.requests.push(`${request.method()} ${path}`);
    if (policies.has(path)) {
      if (request.method() === "PUT") {
        const body = request.postDataJSON();
        evidence.mutations.push({ path, body });
        pendingRequest = path;
        await new Promise((resolveAck) => { acknowledge = resolveAck; });
        fixture.revision += 1;
        fixture.scene.revision = fixture.revision;
        policies.set(path, { ...policies.get(path), config: body.config, revision: fixture.revision });
        pendingRequest = null;
      }
      return fulfillJson(route, policies.get(path));
    }
    if (path === "/v2/sessions/current/meshing/meshes/objects/film/topology") return fulfillTopology(route, fixture.topology);
    if (path === "/v2/sessions/current/meshing/meshes/objects/film/report") return fulfillJson(route, { object_id: "film", report: null, revision: fixture.revision });
    if (path === "/v2/sessions/current/meshing/meshes/objects/film/quality") return fulfillJson(route, { object_id: "film", quality: null, revision: fixture.revision });
    if (path === "/v2/sessions/current/meshing/meshes/objects/film/size-field") return fulfillJson(route, { object_id: "film", size_field: null, revision: fixture.revision });
    return route.fallback();
  });
  const targets = [
    { name: "object", path: objectPath, node: "model:object:film:mesh", parents: ["model:session", "model:objects", "model:object:film"], jsonLabel: "Policy JSON", jsonGroup: "Advanced JSON", configKey: "maximum_element_size", apply: "Apply Policy", success: "Policy saved. Current solver mesh is stale until a mesh build completes." },
    { name: "airbox", path: airboxPath, node: "model:airbox:mesh:parameters", parents: ["model:session", "model:universe", "model:airbox", "model:airbox:mesh"], jsonLabel: "Advanced universe policy JSON", jsonGroup: "Advanced Authored Policy JSON", configKey: "airbox_hmax", apply: "Apply Airbox Policy", success: "Canonical Airbox policy saved. The realized shared-domain mesh is stale until rebuilt." },
  ];
  try {
    if (auditViewport && (auditViewport.width !== originalViewport.width || auditViewport.height !== originalViewport.height)) {
      await page.setViewportSize(auditViewport);
      viewportChanged = true;
    }
    await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: 180_000 });
    const inspector = page.locator(".fm-inspector");
    await inspector.waitFor({ state: "visible", timeout: 60_000 });
    for (const target of targets) {
      await selectNode(page, target.node, target.parents);
      const properties = inspector.getByRole("tab", { name: "Properties", exact: true });
      if (await properties.count()) await properties.click();
      const panel = inspector.locator(".fm-inspector-panel").first();
      const maxSize = panel.locator('[aria-label="Maximum element size"]');
      const scrollViewport = inspector.locator(".fm-inspector__content .fm-scroll-area__viewport").first();
      await maxSize.waitFor({ state: "visible" });
      await scrollViewport.waitFor({ state: "visible" });
      const baselineFile = `${target.name}-mesh-before.png`;
      await maxSize.scrollIntoViewIfNeeded();
      await inspector.screenshot({ path: resolve(outputDir, baselineFile) });
      evidence.screenshots.push(baselineFile);
      if (target.jsonGroup) {
        const group = panel.getByRole("button", { name: new RegExp(`^${target.jsonGroup}`) });
        if (await group.count() && await group.getAttribute("aria-expanded") === "false") await group.click();
      }
      const json = panel.locator(`[aria-label="${target.jsonLabel}"]`);
      await json.waitFor({ state: "visible" });
      const nextConfig = { ...policies.get(target.path).config, [target.configKey]: 3e-8 };
      await json.fill(JSON.stringify(nextConfig, null, 2));
      assert.equal(Number(await maxSize.inputValue()), 3e-8, `${target.name}: JSON did not update the structured size field`);
      await maxSize.fill("4e-8");
      assert.equal(JSON.parse(await json.inputValue())[target.configKey], 4e-8, `${target.name}: structured field did not update JSON`);

      const mutationsBeforeInvalid = evidence.mutations.length;
      await json.fill("{ invalid");
      const apply = panel.getByRole("button", { name: target.apply, exact: true });
      if (!(await apply.isDisabled())) await apply.click();
      await page.waitForTimeout(100);
      assert.equal(evidence.mutations.length, mutationsBeforeInvalid, `${target.name}: invalid JSON reached the API`);
      await json.fill(JSON.stringify({ ...nextConfig, [target.configKey]: 4e-8 }, null, 2));

      const nextNode = target.name === "airbox"
        ? "model:airbox:mesh:statistics"
        : "model:object:film:geometry";
      await page.locator(`[data-node-id="${nextNode}"]`).click();
      const dialog = page.getByRole("dialog", { name: "Unapplied Inspector changes" });
      await dialog.waitFor({ state: "visible" });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(Number(await maxSize.inputValue()), 4e-8, `${target.name}: cancel selection lost the draft`);

      await maxSize.scrollIntoViewIfNeeded();
      await scrollViewport.evaluate((element) => {
        if (element.scrollHeight > element.clientHeight && element.scrollTop <= 0) element.scrollTop = 1;
      });
      await maxSize.evaluate((element) => element.focus({ preventScroll: true }));
      // Exclude settled selection/form rendering from the mutation budget.
      await page.waitForTimeout(1_100);
      const marker = `${target.name}-mesh-stability`;
      await panel.evaluate((element, identity) => {
        element.dataset.meshStabilityMarker = identity;
        for (const entry of performance.getEntriesByType("measure")) {
          if (entry.name.startsWith("fullmag.react.render.InspectorModule.")) performance.clearMeasures(entry.name);
        }
      }, marker);
      const baseline = await inspectPanel(panel);
      assert.ok(baseline.scrollHeight > baseline.clientHeight, `${target.name}: inspector viewport has no natural overflow`);
      assert.ok(baseline.scrollTop > 0, `${target.name}: inspector viewport did not reach a nonzero scroll offset`);
      const requestStart = evidence.requests.length;
      const mutationStart = evidence.mutations.length;
      await apply.evaluate((button) => button.click());
      await waitUntil(() => pendingRequest === target.path, `${target.name}: PUT was not submitted`);
      await page.waitForTimeout(80);
      const during = await inspectPanel(panel);
      assertStable(target.name, during, baseline, marker);
      assert.equal(await maxSize.isDisabled(), false, `${target.name}: unrelated size control disabled during PUT`);
      const pendingFile = `${target.name}-mesh-pending.png`;
      await inspector.screenshot({ path: resolve(outputDir, pendingFile) });
      evidence.screenshots.push(pendingFile);
      const ackResponsePromise = page.waitForResponse((response) => {
        const request = response.request();
        return request.method() === "PUT" && new URL(response.url()).pathname === target.path;
      }, { timeout: 15_000 });
      acknowledge();
      const ackResponse = await ackResponsePromise;
      assert.equal(ackResponse.status(), 200, `${target.name}: PUT did not return success`);
      assert.equal(await ackResponse.finished(), null, `${target.name}: PUT response did not finish cleanly`);
      const ackBody = await ackResponse.json();
      assert.equal(ackBody.config?.[target.configKey], 4e-8, `${target.name}: acknowledged response contains a stale size value`);
      await waitUntil(() => pendingRequest === null, `${target.name}: PUT did not acknowledge`);
      await page.waitForFunction(({ applyLabel, successText }) => {
        const panel = document.querySelector(".fm-inspector-panel");
        if (!panel) return false;
        const apply = Array.from(panel.querySelectorAll("button")).find((button) => button.textContent?.trim() === applyLabel);
        return Boolean(apply && !apply.disabled && panel.textContent?.includes(successText));
      }, { applyLabel: target.apply, successText: target.success }, { timeout: 15_000 });
      const after = await inspectPanel(panel);
      assertStable(target.name, after, baseline, marker);
      assert.equal(await maxSize.isDisabled(), false, `${target.name}: size control remained disabled after ACK`);
      assert.equal(Number(await maxSize.inputValue()), 4e-8, `${target.name}: ACK lost the applied value`);
      assert.equal(evidence.mutations.length - mutationStart, 1, `${target.name}: apply issued duplicate PUTs`);
      assert.equal(evidence.mutations.at(-1).body.config[target.configKey], 4e-8, `${target.name}: PUT contained a stale size value`);
      const mutationRequests = evidence.requests.slice(requestStart);
      assert.ok(mutationRequests.length <= 20, `${target.name}: request budget exceeded: ${JSON.stringify(mutationRequests)}`);
      assert.ok(after.renderCount <= 8, `${target.name}: render budget exceeded: ${after.renderCount}`);
      const afterFile = `${target.name}-mesh-after-ack.png`;
      await inspector.screenshot({ path: resolve(outputDir, afterFile) });
      evidence.screenshots.push(afterFile);
      evidence.scenarios.push({ target: target.name, jsonSynchronization: "passed", invalidJson: "passed", dirtySelection: "passed", during, after, mutationRequests });
    }
    if (process.env.CONTROL_ROOM_INSPECTOR_RETAINED_MESH === "1") {
      evidence.retainedMesh = await qualifyRetainedMeshArtifact(page, fixture);
    }
    const canvas = page.locator(".fm-viewport-3d canvas").first();
    assert.ok(await canvas.isVisible(), "3D canvas is not visible");
    evidence.webgl = await canvas.evaluate((element) => {
      const gl = element.getContext("webgl2") ?? element.getContext("webgl");
      return gl ? { lost: gl.isContextLost(), width: gl.drawingBufferWidth, height: gl.drawingBufferHeight } : null;
    });
    assert.ok(evidence.webgl && !evidence.webgl.lost && evidence.webgl.width > 0 && evidence.webgl.height > 0, "3D drawing buffer is unhealthy");
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error.stack ?? String(error);
    await page.screenshot({ path: resolve(outputDir, "mesh-policy-failure.png"), fullPage: true });
    throw error;
  } finally {
    acknowledge?.();
    try {
      if (viewportChanged && originalViewport) await page.setViewportSize(originalViewport);
    } finally {
      await writeFile(resolve(outputDir, "mesh-policy-browser.json"), JSON.stringify(evidence, null, 2));
    }
  }
  console.log(JSON.stringify(evidence, null, 2));
}

async function qualifyRetainedMeshArtifact(page, fixture) {
  await selectNode(page, "model:mesh:builds", ["model:mesh"]);
  const inspector = page.locator(".fm-inspector");
  const panel = inspector.locator(".fm-inspector-panel").first();
  const [panelText, meshRootText, buildNodeText] = await Promise.all([
    panel.innerText(),
    page.locator('[data-node-id="model:mesh"]').innerText(),
    page.locator('[data-node-id="model:mesh:builds"]').innerText(),
  ]);

  assert.match(
    panelText,
    /The latest mesh build failed\. The candidate was not promoted;/,
    "Mesh Inspector did not explain retained last-good state.",
  );
  assert.match(panelText, /Retained after failure\s+yes — published artifact unchanged/);
  assert.match(panelText, /Retained build id\s+mesh:inspector-good/);
  assert.match(panelText, /Retained generation\s+1/);
  assert.match(
    meshRootText,
    /failed · retained Inspector fixture mesh/,
    "Explorer mesh root hid the retained artifact identity.",
  );
  assert.match(
    buildNodeText,
    /failed · retained rev 7/,
    "Explorer build node hid the retained artifact revision.",
  );

  return {
    buildId: "mesh:inspector-good",
    generationId: fixture.manifest.generation_id,
    meshName: fixture.manifest.mesh_name,
    meshRevision: fixture.manifest.revision,
    sourceSceneRevision: fixture.manifest.source_scene_revision,
    state: "retained",
  };
}

async function selectNode(page, nodeId, parents) {
  const tab = page.locator(".fm-explorer .fm-tabs-trigger").filter({ hasText: /^Model$/ });
  if (await tab.count() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
  for (const id of parents) {
    const parent = page.locator(`[data-node-id="${id}"]`);
    await parent.waitFor({ state: "visible" });
    if (await parent.getAttribute("aria-expanded") === "false") await parent.locator(".fm-explorer-tree-row__branch").click();
  }
  await page.locator(`[data-node-id="${nodeId}"]`).click();
}

async function inspectPanel(panel) {
  return panel.evaluate((element) => {
    const scrollViewport = element.closest(".fm-inspector")?.querySelector(".fm-inspector__content .fm-scroll-area__viewport");
    const formControls = Array.from(element.querySelectorAll('input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]), select, textarea'))
      .map((control, index) => {
        const ancestors = [];
        let current = control;
        while (current) {
          const classes = typeof current.className === "string" ? current.className.trim().split(/\s+/).filter(Boolean) : [];
          ancestors.push({
            selector: `${current.tagName.toLowerCase()}${classes.map((name) => `.${name}`).join("")}`,
            opacity: getComputedStyle(current).opacity,
          });
          current = current.parentElement;
        }
        return {
          key: control.getAttribute("aria-label") ?? control.getAttribute("name") ?? `${control.tagName.toLowerCase()}[${index}]`,
          disabled: Boolean(control.disabled),
          ancestors,
        };
      });
    return {
      marker: element.dataset.meshStabilityMarker,
      connected: element.isConnected,
      opacity: getComputedStyle(element).opacity,
      focusedLabel: document.activeElement?.getAttribute("aria-label"),
      scrollTop: scrollViewport?.scrollTop ?? 0,
      scrollHeight: scrollViewport?.scrollHeight ?? 0,
      clientHeight: scrollViewport?.clientHeight ?? 0,
      formControls,
      opacityAnimations: element.getAnimations({ subtree: true }).filter((animation) =>
        (animation.effect?.getKeyframes?.() ?? []).some((frame) => Object.hasOwn(frame, "opacity"))).length,
      renderCount: performance.getEntriesByType("measure").filter((entry) => entry.name.startsWith("fullmag.react.render.InspectorModule")).length,
    };
  });
}

function assertStable(target, snapshot, baseline, marker) {
  assert.ok(snapshot.connected && snapshot.marker === marker, `${target}: inspector root remounted`);
  assert.equal(snapshot.opacity, baseline.opacity, `${target}: inspector opacity changed`);
  assert.equal(snapshot.opacityAnimations, 0, `${target}: active opacity animation`);
  assert.equal(snapshot.focusedLabel, "Maximum element size", `${target}: field focus was lost`);
  assert.ok(Math.abs(snapshot.scrollTop - baseline.scrollTop) <= 1, `${target}: scroll position changed`);
  assert.deepEqual(snapshot.formControls, baseline.formControls, `${target}: form-control disabled state or ancestor opacity changed`);
}

async function waitUntil(condition, message) {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  assert.ok(condition(), message);
}
