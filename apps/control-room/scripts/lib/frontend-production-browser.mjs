import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { resetInspectorDocumentBudget } from "./inspector-request-budget.mjs";

const SCENE_PATH = "/v2/sessions/current/model/scene";
const MODEL_REGIONS_PATH = "/v2/sessions/current/model/regions";
const MESH_REGION_MEMBERSHIPS_PATH = "/v2/sessions/current/data/mesh-region-memberships";
const GEOMETRY_VALIDATION_PATH = "/v2/sessions/current/model/geometry/validation";
const NO_BACKEND_WRITES = [
  /^POST \/v2\/sessions\/current\/model\/transactions(?:\?|$)/,
  /^POST \/v2\/sessions\/current\/simulation\/commands(?:\?|$)/,
];

export async function qualifyFrontendProductionBrowser({
  page,
  fixture,
  outputDir,
  workspaceUrl,
  fulfillJson,
  consoleErrorEvents = [],
}) {
  await mkdir(outputDir, { recursive: true });
  const originalScene = structuredClone(fixture.scene);
  const originalRevision = fixture.revision;
  const originalManifestRevision = fixture.manifest.source_scene_revision;
  const initialMutationCount = fixture.unknownMutationPaths.length;
  const initialGeometryWrites = fixture.geometryMutationBodies.length;
  const initialTextureWrites = fixture.textureMutationBodies.length;
  const initialGridCommands = fixture.gridCommandBodies.length;
  const initialRequestIndex = fixture.requests.length;
  const initialTheme = await page.evaluate(() =>
    document.documentElement.getAttribute("data-theme"),
  );
  const evidence = {
    schema: "fullmag_frontend_production_browser_audit_v1",
    status: "running",
    scope: "mocked Control Room UI with the inspector fixture API; no solver/runtime claim",
    scenarios: [],
    screenshots: [],
    no_backend_edits_or_solve: null,
    request_counts: null,
    page_errors: [],
  };

  async function capture(name, locator = page) {
    const filename = `frontend-production-${name}.png`;
    await locator.screenshot({ path: resolve(outputDir, filename) });
    evidence.screenshots.push(filename);
    return filename;
  }

  async function runScenario(name, action) {
    console.log(`Frontend audit: ${name} started`);
    const result = { name, status: "passed" };
    try {
      result.details = await action();
    } catch (error) {
      result.status = "failed";
      result.error = error?.stack ?? String(error);
      console.log(`Frontend audit: ${name} failed`);
      evidence.scenarios.push(result);
      throw error;
    }
    evidence.scenarios.push(result);
    console.log(`Frontend audit: ${name} passed`);
    return result.details;
  }

  async function openWorkspace(label) {
    resetInspectorDocumentBudget(fixture.requestBudget, label);
    await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".fm-explorer").waitFor({ state: "visible", timeout: 60_000 });
    await page.locator(".fm-inspector").waitFor({ state: "visible", timeout: 60_000 });
    const modelTab = page.getByRole("tab", { name: "Model", exact: true });
    if (await modelTab.count() && await modelTab.getAttribute("aria-selected") !== "true") {
      await modelTab.click();
    }
  }

  function row(nodeId) {
    return page.locator(`[data-node-id="${nodeId}"]`);
  }

  async function focusedNodeId() {
    return page.evaluate(() => document.activeElement?.getAttribute("data-node-id") ?? null);
  }

  async function installExplorerNavigationProbe(tree) {
    await tree.evaluate((element) => {
      const events = [];
      const maxEvents = 200;
      const snapshot = () => {
        const rows = Array.from(element.querySelectorAll('[role="treeitem"]'));
        const rowHeight = rows[0]?.getBoundingClientRect().height ?? 0;
        const describeRow = (row) => {
          if (!row) return null;
          const rect = row.getBoundingClientRect();
          return {
            id: row.getAttribute("data-node-id"),
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            tabIndex: row.tabIndex,
          };
        };
        const spacers = Array.from(element.children)
          .map((child, index) => ({ child, index }))
          .filter(({ child }) => child.getAttribute("aria-hidden") === "true")
          .map(({ child, index }) => {
            const rect = child.getBoundingClientRect();
            return {
              childIndex: index,
              styleHeight: child.style.height,
              top: rect.top,
              bottom: rect.bottom,
              height: rect.height,
            };
          });
        const leadingSpacer = element.firstElementChild?.getAttribute("aria-hidden") === "true"
          ? element.firstElementChild
          : null;
        const virtualWindow = element.querySelector(".fm-explorer-tree__window");
        const virtualCanvas = element.querySelector(".fm-explorer-tree__canvas");
        const virtualStart = rowHeight > 0
          ? Math.round((virtualWindow ? Number.parseFloat(virtualWindow.style.top) : leadingSpacer?.getBoundingClientRect().height ?? 0) / rowHeight)
          : 0;
        return {
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
          maxScrollTop: Math.max(0, element.scrollHeight - element.clientHeight),
          mountedRowCount: rows.length,
          rowHeight,
          virtualStart,
          virtualEnd: virtualStart + rows.length,
          virtualExtent: virtualCanvas ? { height: virtualCanvas.getBoundingClientRect().height, windowTop: virtualWindow?.style.top } : null,
          firstMountedRow: describeRow(rows[0]),
          lastMountedRow: describeRow(rows.at(-1)),
          virtualSpacers: spacers,
        };
      };
      const record = (details) => {
        events.push({ ...snapshot(), ...details });
        if (events.length > maxEvents) events.shift();
      };
      const ownScrollTop = Object.getOwnPropertyDescriptor(element, "scrollTop");
      let scrollPrototype = Object.getPrototypeOf(element);
      let nativeScrollTop;
      while (scrollPrototype && !nativeScrollTop) {
        nativeScrollTop = Object.getOwnPropertyDescriptor(scrollPrototype, "scrollTop");
        scrollPrototype = Object.getPrototypeOf(scrollPrototype);
      }
      if (!nativeScrollTop?.get || !nativeScrollTop?.set) throw new Error("Native scrollTop accessor is unavailable.");
      Object.defineProperty(element, "scrollTop", {
        configurable: true,
        get() { return nativeScrollTop.get.call(this); },
        set(requested) {
          const before = nativeScrollTop.get.call(this);
          nativeScrollTop.set.call(this, requested);
          record({ type: "scrollTop-write", requested, before, actual: nativeScrollTop.get.call(this), stack: new Error().stack?.slice(0, 1500) });
        },
      });
      const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
      const nativeScrollIntoView = scrollIntoViewDescriptor?.value;
      const wrappedScrollIntoView = function (...args) {
        const result = nativeScrollIntoView.apply(this, args);
        if (this === element || element.contains(this)) {
          record({ type: "scrollIntoView-call", target: this.getAttribute("data-node-id"), options: args[0] ?? null, stack: new Error().stack?.slice(0, 1500) });
        }
        return result;
      };
      if (typeof nativeScrollIntoView === "function") {
        Object.defineProperty(Element.prototype, "scrollIntoView", { ...scrollIntoViewDescriptor, value: wrappedScrollIntoView });
      }
      const listeners = [];
      for (const eventName of ["keydown", "focusin", "scroll"]) {
        const listener = (event) => record({
          type: event.type,
          key: event.key ?? null,
          target: event.target?.getAttribute?.("data-node-id") ?? null,
          focused: document.activeElement?.getAttribute("data-node-id") ?? null,
        });
        element.addEventListener(eventName, listener);
        listeners.push([eventName, listener]);
      }
      const resizeObserver = new ResizeObserver((entries) => {
        record({
          type: "resize",
          observedSizes: entries.map((entry) => ({
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          })),
        });
      });
      resizeObserver.observe(element);
      window.__frontendAuditNavigationEvents = events;
      window.__frontendAuditNavigationProbeCleanup = () => {
        for (const [eventName, listener] of listeners) {
          element.removeEventListener(eventName, listener);
        }
        resizeObserver.disconnect();
        if (ownScrollTop) Object.defineProperty(element, "scrollTop", ownScrollTop);
        else delete element.scrollTop;
        if (Element.prototype.scrollIntoView === wrappedScrollIntoView) {
          Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoViewDescriptor);
        }
        delete window.__frontendAuditNavigationProbeCleanup;
      };
      record({ type: "probe-installed" });
    });
  }

  async function cleanupExplorerNavigationProbe() {
    await page.evaluate(() => window.__frontendAuditNavigationProbeCleanup?.());
  }

  async function waitForInspectorName(expectedName) {
    const name = page.locator(".fm-inspector").getByRole("textbox", { name: "Name", exact: true });
    await name.waitFor({ state: "visible" });
    await page.waitForFunction((expected) =>
      document.querySelector('.fm-inspector input[aria-label="Name"]')?.value === expected,
    expectedName, { timeout: 10_000 });
    assert.equal(await name.inputValue(), expectedName);
  }

  async function waitForFocusedNode(nodeId) {
    await page.waitForFunction(
      (expected) => document.activeElement?.getAttribute("data-node-id") === expected,
      nodeId,
      { timeout: 5_000 },
    );
  }

  async function assertFocusedRowSettles(tree, expectedId) {
    const frames = await tree.evaluate(async (element) => {
      const samples = [];
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
        const focused = document.activeElement;
        const rect = focused?.getBoundingClientRect();
        const viewport = element.getBoundingClientRect();
        samples.push({
          focusedId: focused?.getAttribute("data-node-id"),
          visible: Boolean(focused && element.contains(focused) && rect && rect.top >= viewport.top - 1 && rect.bottom <= viewport.top + element.clientHeight + 1),
          scrollTop: element.scrollTop,
        });
      }
      return samples;
    });
    assert.ok(frames.every((frame) => frame.focusedId === expectedId && frame.visible),
      "The focused row did not remain visible after layout settled: " + JSON.stringify(frames));
  }

  async function pressAndWaitForFocusChange(key) {
    const previous = await focusedNodeId();
    await page.keyboard.press(key);
    await page.waitForFunction(
      (previousId) => {
        const current = document.activeElement?.getAttribute("data-node-id");
        return current !== null && current !== undefined && current !== previousId;
      },
      previous,
      { timeout: 5_000 },
    );
    return focusedNodeId();
  }

  async function setRevision(revision) {
    fixture.revision = revision;
    fixture.scene.revision = revision;
    fixture.manifest.source_scene_revision = revision;
  }

  try {
    await runScenario("planar-raw-inputs-survive-field-remount", async () => {
      await page.goto(new URL("/dev/frontend-controls", workspaceUrl).href, { waitUntil: "domcontentloaded" });
      const panel = page.getByTestId("planar-draft-fixture");
      await panel.waitFor({ state: "visible" });
      const opacity = panel.getByRole("textbox", { name: "Audit planar opacity", exact: true });
      const count = async () => Number(await panel.getByTestId("planar-commit-count").textContent());
      const guard = async () => JSON.parse(await panel.getByTestId("planar-guard").textContent());
      await opacity.fill("");
      await opacity.press("Tab");
      assert.equal(await opacity.inputValue(), "");
      assert.equal((await guard()).dirty, true);
      assert.equal((await guard()).valid, false);
      assert.equal(await count(), 0, "Clearing an input unexpectedly committed zero.");
      await panel.getByRole("button", { name: "Show fixture 3D", exact: true }).click();
      assert.equal(await opacity.count(), 0);
      await panel.getByRole("button", { name: "Show fixture 2D", exact: true }).click();
      assert.equal(await opacity.inputValue(), "", "A remount lost the raw draft.");
      await opacity.fill("0");
      await opacity.press("Enter");
      assert.equal(await count(), 1);
      assert.equal(await panel.getByTestId("planar-opacity").textContent(), "0");
      const minimum = panel.getByRole("textbox", { name: "Range minimum", exact: true });
      const maximum = panel.getByRole("textbox", { name: "Range maximum", exact: true });
      await minimum.fill("5");
      await minimum.press("Tab");
      assert.equal(await minimum.inputValue(), "5");
      assert.equal(await count(), 1, "An invalid partial range reached the commit callback.");
      await maximum.fill("10");
      await maximum.press("Enter");
      assert.equal(await count(), 2);
      const range = JSON.parse(await panel.getByTestId("planar-range").textContent());
      assert.equal(range.min, 5);
      assert.equal(range.max, 10);
      await opacity.fill("-");
      await opacity.press("Tab");
      await panel.getByRole("button", { name: "Show fixture 3D", exact: true }).click();
      await panel.getByRole("button", { name: "Discard 2D input", exact: true }).click();
      await panel.getByRole("button", { name: "Show fixture 2D", exact: true }).click();
      assert.equal(await opacity.inputValue(), "0");
      assert.equal((await guard()).dirty, false);
      assert.equal(await count(), 2);
      await capture("planar-raw-inputs", panel);
      return { scope: "Production input components and field remount; no viewport proof", emptyPreserved: true, explicitZero: true, rangePair: range, discardWhileHidden: true, commitCount: await count() };
    });

    await runScenario("filter-collapse-clear-and-no-match", async () => {
      await openWorkspace("frontend-filter-audit");
      const filter = page.getByRole("searchbox", { name: "Filter explorer" });
      const geometry = row("model:object:film:geometry");

      await page.getByRole("button", { name: "Collapse all explorer nodes" }).click();
      assert.equal(await geometry.count(), 0, "Collapse All should hide the geometry child.");
      await filter.fill("Geometry");
      await geometry.waitFor({ state: "visible" });
      await capture("filter-reveals-collapsed-geometry", page.locator(".fm-explorer"));

      await filter.press("Escape");
      assert.equal(await filter.inputValue(), "", "Escape should clear the explorer filter.");
      assert.equal(await geometry.count(), 0, "Escape should restore the collapsed tree.");
      assert.equal(await row("model:session").getAttribute("aria-expanded"), "false");

      await filter.fill("Geometry");
      await geometry.waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Clear explorer filter" }).click();
      assert.equal(await filter.inputValue(), "", "Clear should reset the explorer filter.");
      assert.equal(await geometry.count(), 0, "Clear should restore the collapsed tree.");
      assert.equal(await row("model:session").getAttribute("aria-expanded"), "false");

      await filter.fill("__frontend_audit_no_matching_node__");
      const noMatches = page.getByRole("status").filter({ hasText: "No matching nodes." });
      await noMatches.waitFor({ state: "visible" });
      await capture("filter-no-matches-announced", page.locator(".fm-explorer"));
      const result = {
        clearRestoredCollapse: true,
        escapeRestoredCollapse: true,
        geometryNodeId: "model:object:film:geometry",
        noMatchAnnouncement: (await noMatches.innerText()).trim(),
        selectedRowsAfterNoMatch: await page.locator('.fm-explorer-tree-row[data-active="true"]').evaluateAll(
          (elements) => elements.map((element) => element.getAttribute("data-node-id")),
        ),
        visibleRowCountAfterNoMatch: await page.locator('.fm-explorer [role="treeitem"]').count(),
      };
      await filter.fill("");
      return result;
    });

    await runScenario("refresh-preserves-filter-inspector-and-external-focus", async () => {
      await openWorkspace("frontend-refresh-audit");
      const filter = page.getByRole("searchbox", { name: "Filter explorer" });
      await filter.fill("Film");
      const film = row("model:object:film");
      await film.waitFor({ state: "visible" });
      await film.click();

      const inspector = page.locator(".fm-inspector");
      const nameInput = inspector.getByRole("textbox", { name: "Name", exact: true });
      await nameInput.waitFor({ state: "visible" });
      const before = await inspector.evaluate((element) => {
        const identity = element.getAttribute("data-inspector-owner");
        element.dataset.frontendAuditInspector = "refresh-stability";
        return { identity, title: element.querySelector(".fm-inspector__title")?.textContent?.trim() ?? null };
      });
      await nameInput.evaluate((element) => {
        element.dataset.frontendAuditFocus = "external-inspector-input";
        element.focus();
      });

      const newObject = {
        ...structuredClone(fixture.scene.objects[0]),
        id: "audit-refresh-object",
        name: "Film after refresh",
        region_name: "film-after-refresh",
      };
      fixture.scene.objects.push(newObject);
      await setRevision(fixture.revision + 1);

      const sceneResponse = page.waitForResponse((response) => {
        const request = response.request();
        return request.method() === "GET" && new URL(response.url()).pathname === SCENE_PATH;
      }, { timeout: 15_000 });
      await page.getByRole("button", { name: "Refresh explorer" }).evaluate((button) => button.click());
      const response = await sceneResponse;
      assert.equal(response.status(), 200, "Refresh should fetch a successful fixture scene response.");
      const refreshedObject = row("model:object:audit-refresh-object");
      await refreshedObject.waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await filter.inputValue(), "Film", "Refresh cleared the explorer filter.");
      const after = await inspector.evaluate((element) => ({
        connected: element.isConnected,
        identity: element.getAttribute("data-inspector-owner"),
        marker: element.dataset.frontendAuditInspector,
        title: element.querySelector(".fm-inspector__title")?.textContent?.trim() ?? null,
      }));
      assert.ok(after.connected && after.marker === "refresh-stability", "Refresh remounted the Inspector root.");
      assert.equal(after.identity, before.identity, "Refresh changed the Inspector owner identity.");
      assert.equal(after.title, before.title, "Refresh changed the selected Inspector identity.");
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-frontend-audit-focus")),
        "external-inspector-input",
        "Refresh stole focus from the Inspector input outside Explorer.",
      );
      await capture("refresh-preserves-state", page);
      return {
        filterValue: await filter.inputValue(),
        inspectorIdentity: after.identity,
        inspectorTitle: after.title,
        externalFocusPreserved: true,
        refreshedObjectId: "model:object:audit-refresh-object",
        sceneResponseStatus: response.status(),
      };
    });

    fixture.scene = structuredClone(originalScene);
    await setRevision(originalRevision);
    fixture.manifest.source_scene_revision = originalManifestRevision;

    await runScenario("virtualized-tree-navigation-and-hierarchy", async () => {
      const copies = Array.from({ length: 30 }, (_, index) => ({
        ...structuredClone(fixture.scene.objects[0]),
        id: `audit-copy-${String(index + 1).padStart(2, "0")}`,
        name: `Film audit copy ${String(index + 1).padStart(2, "0")}`,
        region_name: `film-audit-copy-${String(index + 1).padStart(2, "0")}`,
      }));
      fixture.scene.objects.push(...copies);
      await setRevision(fixture.revision + 1);
      await openWorkspace("frontend-large-tree-audit");
      await page.getByRole("button", { name: "Expand all explorer nodes" }).click();
      const tree = page.locator(".fm-explorer-tree");
      await page.waitForFunction(() => {
        const element = document.querySelector(".fm-explorer-tree");
        const row = element?.querySelector('[role="treeitem"]');
        const rowHeight = row?.getBoundingClientRect().height ?? 0;
        return rowHeight > 0 && element.scrollHeight / rowHeight > 200;
      }, null, { timeout: 15_000 });
      const initial = await tree.evaluate((element) => {
        const row = element.querySelector('[role="treeitem"]');
        const rowHeight = row?.getBoundingClientRect().height ?? 1;
        return {
          clientHeight: element.clientHeight,
          renderedIds: Array.from(element.querySelectorAll('[role="treeitem"]'), (item) => item.getAttribute("data-node-id")),
          rowHeight,
          scrollHeight: element.scrollHeight,
          totalRows: Math.round(element.scrollHeight / rowHeight),
        };
      });
      assert.ok(initial.totalRows > 200, `Large-tree fixture only exposes ${initial.totalRows} logical rows.`);
      assert.ok(initial.renderedIds.length < initial.totalRows, "The large-tree case should use row virtualization.");
      evidence.virtualization_probe = initial;

      const farSelectedId = "model:object:audit-copy-30";
      await tree.locator('[role="treeitem"]').first().focus();
      await installExplorerNavigationProbe(tree);
      let farFocusId = await pressAndWaitForFocusChange("End");
      for (let step = 0; farFocusId !== farSelectedId && step < initial.totalRows; step += 1) {
        farFocusId = await pressAndWaitForFocusChange("ArrowUp");
      }
      assert.equal(farFocusId, farSelectedId, "Keyboard navigation could not reach the distant fixture object from End.");
      await page.keyboard.press("Space");
      await row(farSelectedId).waitFor({ state: "visible" });
      await page.waitForFunction((nodeId) =>
        document.querySelector(`[data-node-id="${nodeId}"]`)?.getAttribute("data-active") === "true",
      farSelectedId, { timeout: 5_000 });
      assert.equal(await row(farSelectedId).getAttribute("data-active"), "true", "Far fixture object was not selected.");
      const inspector = page.locator(".fm-inspector");
      const selectedObjectName = "Film audit copy 30";
      await waitForInspectorName(selectedObjectName);
      await page.keyboard.press("Home");
      await page.waitForFunction((farId) => {
        const activeNodeId = document.activeElement?.getAttribute("data-node-id");
        return Boolean(activeNodeId && activeNodeId !== farId);
      },
      farSelectedId, { timeout: 5_000 });

      let parentId = await focusedNodeId();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const currentRow = row(parentId);
        if (await currentRow.getAttribute("aria-expanded") === "true") break;
        parentId = await pressAndWaitForFocusChange("ArrowDown");
      }
      const parent = row(parentId);
      assert.equal(await parent.getAttribute("aria-expanded"), "true", "Could not reach an expanded tree parent from Home.");
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction((parentNodeId) => {
        const current = document.activeElement?.getAttribute("data-node-id");
        return current !== null && current !== parentNodeId;
      }, parentId, { timeout: 5_000 });
      const firstChildId = await focusedNodeId();
      assert.equal(await row(firstChildId).getAttribute("aria-level"),
        String(Number(await parent.getAttribute("aria-level")) + 1),
      "ArrowRight did not focus the first child of an expanded parent.");
      const firstChild = row(firstChildId);
      if (await firstChild.getAttribute("aria-expanded") === "true") {
        await page.keyboard.press("ArrowLeft");
        await page.waitForFunction((nodeId) =>
          document.querySelector(`[data-node-id="${nodeId}"]`)?.getAttribute("aria-expanded") === "false",
        firstChildId, { timeout: 5_000 });
        await waitForFocusedNode(firstChildId);
      }
      await page.keyboard.press("ArrowLeft");
      await waitForFocusedNode(parentId);

      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction((nodeId) =>
        document.querySelector(`[data-node-id="${nodeId}"]`)?.getAttribute("aria-expanded") === "false",
      parentId, { timeout: 5_000 });
      await waitForFocusedNode(parentId);
      const collapsed = await tree.evaluate((element) => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight }));
      assert.ok(collapsed.scrollTop < initial.rowHeight * 12, "Collapsing a focused parent jumped to the far selected row.");

      await page.keyboard.press("ArrowRight");
      await page.waitForFunction((nodeId) =>
        document.querySelector(`[data-node-id="${nodeId}"]`)?.getAttribute("aria-expanded") === "true",
      parentId, { timeout: 5_000 });
      await waitForFocusedNode(parentId);
      const expanded = await tree.evaluate((element) => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight }));
      assert.ok(expanded.scrollTop < initial.rowHeight * 12, "Expanding a focused parent revealed the distant selection and stole the viewport.");
      assert.equal(
        await inspector.getByRole("textbox", { name: "Name", exact: true }).inputValue(),
        selectedObjectName,
        "Keyboard expansion changed the selected Inspector identity.",
      );

      await page.keyboard.press("Home");
      await page.waitForFunction(() => Boolean(document.activeElement?.getAttribute("data-node-id")), null, { timeout: 5_000 });
      const firstId = await focusedNodeId();
      assert.ok(firstId, "Home did not focus a tree row.");
      const startTop = await tree.evaluate((element) => element.scrollTop);
      assert.ok(startTop < initial.rowHeight, `Home did not return to the first row (scrollTop=${startTop}).`);

      const downSteps = Math.min(Math.max(initial.renderedIds.length + 8, 45), 75);
      let crossedOriginalWindow = false;
      for (let step = 0; step < downSteps; step += 1) {
        const nextId = await pressAndWaitForFocusChange("ArrowDown");
        if (!initial.renderedIds.includes(nextId)) crossedOriginalWindow = true;
      }
      assert.ok(crossedOriginalWindow, "ArrowDown never navigated beyond the initial virtual DOM window.");
      const downId = await focusedNodeId();
      const downTop = await tree.evaluate((element) => element.scrollTop);
      assert.ok(downTop > startTop, "ArrowDown did not scroll the virtualized tree.");
      for (let step = 0; step < downSteps; step += 1) {
        await pressAndWaitForFocusChange("ArrowUp");
      }
      assert.equal(await focusedNodeId(), firstId, "ArrowUp did not return to the Home row across the virtual window.");
      await page.keyboard.press("End");
      await page.waitForFunction(() => {
        const element = document.querySelector(".fm-explorer-tree");
        if (!element) return false;
        const row = element.querySelector('[role="treeitem"]');
        const rowHeight = row?.getBoundingClientRect().height ?? 28;
        return element.scrollHeight - element.clientHeight - element.scrollTop <= rowHeight * 2;
      }, null, { timeout: 5_000 });
      const endState = await tree.evaluate((element) => ({
        maxScrollTop: element.scrollHeight - element.clientHeight,
        scrollTop: element.scrollTop,
        lastRenderedId: Array.from(element.querySelectorAll('[role="treeitem"]')).at(-1)?.getAttribute("data-node-id") ?? null,
        focusedId: document.activeElement?.getAttribute("data-node-id") ?? null,
      }));
      assert.ok(endState.maxScrollTop - endState.scrollTop <= initial.rowHeight * 2,
        `End did not reach the end of the full tree: ${JSON.stringify(endState)}.`);
      const endId = await focusedNodeId();
      assert.equal(endState.focusedId, endState.lastRenderedId,
        `End scrolled to the end without focusing the last logical row: ${JSON.stringify(endState)}.`);
      await assertFocusedRowSettles(tree, endState.lastRenderedId);
      await page.keyboard.press("Home");
      await page.waitForFunction(() => {
        const element = document.querySelector(".fm-explorer-tree");
        const row = element?.querySelector('[role="treeitem"]');
        const rowHeight = row?.getBoundingClientRect().height ?? 28;
        return Boolean(element && element.scrollTop < rowHeight);
      }, null, { timeout: 5_000 });
      const homeState = await tree.evaluate((element) => element.scrollTop);
      assert.ok(homeState < initial.rowHeight, "Home after End did not return to the start of the full tree.");
      assert.equal(await focusedNodeId(), firstId, "Home after End did not restore focus to the first logical row.");

      const film = row("model:object:film");
      await film.click();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowUp");
      await waitForFocusedNode("model:object:film");
      assert.equal(await film.getAttribute("data-active"), "true", "Keyboard focus changed the selected row.");
      const focusRing = [];
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        const appearance = await film.evaluate((element) => {
          const style = getComputedStyle(element);
          const layers = [];
          let depth = 0;
          let start = 0;
          for (let index = 0; index < style.boxShadow.length; index += 1) {
            const character = style.boxShadow[index];
            if (character === "(") depth += 1;
            else if (character === ")") depth -= 1;
            else if (character === "," && depth === 0) {
              layers.push(style.boxShadow.slice(start, index).trim());
              start = index + 1;
            }
          }
          if (style.boxShadow !== "none") layers.push(style.boxShadow.slice(start).trim());
          const visibleOutline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
          const visibleOuterShadow = layers.some((layer) => layer && !layer.startsWith("inset"));
          return {
            active: element.dataset.active === "true",
            focusVisible: element.matches(":focus-visible"),
            outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
            boxShadow: style.boxShadow,
            visibleRing: visibleOutline || visibleOuterShadow,
          };
        });
        assert.ok(appearance.active && appearance.focusVisible && appearance.visibleRing,
          `Selected Explorer row lacks a visible ${theme} focus ring: ${JSON.stringify(appearance)}.`);
        await capture(`selected-focus-ring-${theme}`, page.locator(".fm-explorer"));
        focusRing.push({ theme, ...appearance });
      }
      await page.evaluate((value) => {
        if (value === null) document.documentElement.removeAttribute("data-theme");
        else document.documentElement.dataset.theme = value;
      }, initialTheme);
      await capture("virtualized-home-end-arrows", page.locator(".fm-explorer"));
      await cleanupExplorerNavigationProbe();
      return {
        logicalRows: initial.totalRows,
        renderedRowsAtTop: initial.renderedIds.length,
        virtualizationActive: true,
        downSteps,
        crossedInitialWindow: crossedOriginalWindow,
        homeNodeId: firstId,
        afterDownNodeId: downId,
        endNodeId: endId,
        scrollAfterDown: downTop,
        hierarchy: { parentId, firstChildId, collapseAndExpandPreservedFocus: true },
        distantSelectionDidNotStealFocus: true,
        selectedFocusRing: focusRing,
      };
    });

    fixture.scene = structuredClone(originalScene);
    await setRevision(originalRevision);
    fixture.manifest.source_scene_revision = originalManifestRevision;

    await runScenario("virtualized-tree-shrink-preserves-selection-and-navigation", async () => {
      const copies = Array.from({ length: 60 }, (_, index) => {
        const ordinal = index + 1;
        const name = ordinal % 2 === 0 ? "Keep audit" : "Drop audit";
        return {
          ...structuredClone(fixture.scene.objects[0]),
          id: `audit-shrink-${String(ordinal).padStart(2, "0")}`,
          name: `${name} ${String(ordinal).padStart(2, "0")}`,
          region_name: `audit-shrink-region-${String(ordinal).padStart(2, "0")}`,
        };
      });
      fixture.scene.objects.push(...copies);
      await setRevision(fixture.revision + 1);

      try {
        await openWorkspace("frontend-tree-filter-shrink-audit");
        await page.getByRole("button", { name: "Expand all explorer nodes" }).click();
        const tree = page.locator(".fm-explorer-tree");
        await installExplorerNavigationProbe(tree);
        const measureTree = () => tree.evaluate((element) => {
          const rows = Array.from(element.querySelectorAll('[role="treeitem"]'));
          const firstRow = rows[0];
          const rowHeight = firstRow?.getBoundingClientRect().height ?? 0;
          const treeRect = element.getBoundingClientRect();
          const visibleRows = rows.filter((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > treeRect.top && rect.top < treeRect.bottom;
          });
          const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
          return {
            clientHeight: element.clientHeight,
            firstVisibleId: visibleRows[0]?.getAttribute("data-node-id") ?? null,
            lastVisibleId: visibleRows.at(-1)?.getAttribute("data-node-id") ?? null,
            logicalRows: rowHeight > 0 ? Math.round(element.scrollHeight / rowHeight) : 0,
            maxScrollTop,
            renderedIds: rows.map((row) => row.getAttribute("data-node-id")),
            rowHeight,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
            visibleRowCount: visibleRows.length,
          };
        });

        await page.waitForFunction(() => {
          const element = document.querySelector(".fm-explorer-tree");
          const row = element?.querySelector('[role="treeitem"]');
          const rowHeight = row?.getBoundingClientRect().height ?? 0;
          return rowHeight > 0 && element.scrollHeight / rowHeight > 200;
        }, null, { timeout: 15_000 });
        const before = await measureTree();
        assert.ok(before.logicalRows > 200, `Shrink fixture only exposes ${before.logicalRows} rows before filtering.`);
        assert.ok(before.renderedIds.length < before.logicalRows, "The shrink case should use row virtualization.");

        const farSelectedId = "model:object:audit-shrink-60";
        const farSelectedName = "Keep audit 60";
        await tree.locator('[role="treeitem"]').first().focus();
        let focusedId = await pressAndWaitForFocusChange("End");
        for (let step = 0; focusedId !== farSelectedId && step < before.logicalRows; step += 1) {
          focusedId = await pressAndWaitForFocusChange("ArrowUp");
        }
        assert.equal(focusedId, farSelectedId, "Keyboard navigation did not reach the distant kept object.");
        await page.keyboard.press("Space");
        await row(farSelectedId).waitFor({ state: "visible" });
        await page.waitForFunction((nodeId) =>
          document.querySelector(`[data-node-id="${nodeId}"]`)?.getAttribute("data-active") === "true",
        farSelectedId, { timeout: 5_000 });
        const inspector = page.locator(".fm-inspector");
        await waitForInspectorName(farSelectedName);

        await page.keyboard.press("End");
        await page.waitForFunction(() => {
          const element = document.querySelector(".fm-explorer-tree");
          const row = element?.querySelector('[role="treeitem"]');
          const rowHeight = row?.getBoundingClientRect().height ?? 28;
          return Boolean(element && element.scrollHeight - element.clientHeight - element.scrollTop <= rowHeight * 2);
        }, null, { timeout: 5_000 });
        const beforeFilterAtBottom = await measureTree();
        assert.ok(beforeFilterAtBottom.maxScrollTop - beforeFilterAtBottom.scrollTop <= beforeFilterAtBottom.rowHeight * 2,
          "The shrink regression must start filtering at the large tree's physical bottom.");

        const filter = page.getByRole("searchbox", { name: "Filter explorer" });
        await filter.fill("Keep audit");
        await page.waitForFunction((previousLogicalRows) => {
          const element = document.querySelector(".fm-explorer-tree");
          const rows = Array.from(element?.querySelectorAll('[role="treeitem"]') ?? []);
          const rowHeight = rows[0]?.getBoundingClientRect().height ?? 0;
          if (!element || rowHeight <= 0) return false;
          const treeRect = element.getBoundingClientRect();
          const visibleCount = rows.filter((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > treeRect.top && rect.top < treeRect.bottom;
          }).length;
          const logicalRows = Math.round(element.scrollHeight / rowHeight);
          return logicalRows > 200 && logicalRows < previousLogicalRows && rows.length > 0 && visibleCount > 0;
        }, before.logicalRows, { timeout: 15_000 });
        const afterFilter = await measureTree();
        assert.ok(afterFilter.logicalRows > 200,
          `Filtering should retain more than 200 logical rows; got ${afterFilter.logicalRows}.`);
        assert.ok(afterFilter.logicalRows < before.logicalRows,
          `Filtering did not shrink the tree (${before.logicalRows} -> ${afterFilter.logicalRows}).`);
        assert.ok(afterFilter.renderedIds.length > 0 && afterFilter.visibleRowCount > 0,
          `Filtering left an empty or offscreen virtual window: ${JSON.stringify(afterFilter)}.`);
        assert.ok(afterFilter.scrollHeight > afterFilter.clientHeight,
          "The filtered tree lost its virtual spacer height.");
        assert.ok(afterFilter.scrollTop <= afterFilter.maxScrollTop + afterFilter.rowHeight,
          `Filtered scroll position exceeds its new extent: ${JSON.stringify(afterFilter)}.`);
        await waitForInspectorName(farSelectedName);
        const selectedRowMountedAfterShrink = (await row(farSelectedId).count()) > 0;
        if (selectedRowMountedAfterShrink) {
          assert.equal(await row(farSelectedId).getAttribute("data-active"), "true",
            "Filtering changed the selected far object.");
        }

        await row(afterFilter.renderedIds[0]).focus();
        await page.keyboard.press("Home");
        await page.waitForFunction(() => {
          const element = document.querySelector(".fm-explorer-tree");
          const row = element?.querySelector('[role="treeitem"]');
          const rowHeight = row?.getBoundingClientRect().height ?? 28;
          return Boolean(element && element.scrollTop < rowHeight);
        }, null, { timeout: 5_000 });
        const homeId = await focusedNodeId();
        assert.ok(homeId, "Home did not focus a row in the shrunken tree.");
        const atHome = await measureTree();
        const downSteps = Math.min(Math.max(atHome.renderedIds.length + 8, 45), 75);
        let crossedInitialWindow = false;
        for (let step = 0; step < downSteps; step += 1) {
          const nextId = await pressAndWaitForFocusChange("ArrowDown");
          if (!atHome.renderedIds.includes(nextId)) crossedInitialWindow = true;
        }
        assert.ok(crossedInitialWindow, "ArrowDown did not cross the initial filtered virtual window.");
        assert.ok((await measureTree()).scrollTop > atHome.scrollTop,
          "ArrowDown did not scroll the filtered virtual tree.");

        await page.keyboard.press("End");
        await page.waitForFunction(() => {
          const element = document.querySelector(".fm-explorer-tree");
          const row = element?.querySelector('[role="treeitem"]');
          const rowHeight = row?.getBoundingClientRect().height ?? 28;
          return Boolean(element && element.scrollHeight - element.clientHeight - element.scrollTop <= rowHeight * 2);
        }, null, { timeout: 5_000 });
        const atEnd = await measureTree();
        const endId = await focusedNodeId();
        assert.ok(atEnd.visibleRowCount > 0 && endId,
          `End reached a blank window in the filtered tree: ${JSON.stringify(atEnd)}.`);
        assert.equal(endId, atEnd.renderedIds.at(-1), "End did not focus the final filtered logical row.");
        await assertFocusedRowSettles(tree, endId);
        assert.ok(atEnd.maxScrollTop - atEnd.scrollTop <= atEnd.rowHeight * 2,
          "End did not reach the bottom after the tree shrank.");
        await page.keyboard.press("ArrowUp");
        await page.waitForFunction((lastId) =>
          document.activeElement?.getAttribute("data-node-id") !== lastId,
        endId, { timeout: 5_000 });
        await waitForInspectorName(farSelectedName);
        await capture("virtualized-tree-shrink-nonempty-window", page.locator(".fm-explorer"));
        return {
          selectedNodeId: farSelectedId,
          selectedObjectName: farSelectedName,
          inspectorTitle: await inspector.locator(".fm-inspector__title").innerText(),
          largeTree: { logicalRows: before.logicalRows, renderedRows: before.renderedIds.length },
          filteredTree: {
            logicalRows: afterFilter.logicalRows,
            renderedRowsAfterShrink: afterFilter.renderedIds.length,
            visibleRowsAfterShrink: afterFilter.visibleRowCount,
            scrollHeight: afterFilter.scrollHeight,
            scrollTopAfterShrink: afterFilter.scrollTop,
          },
          bottomAfterShrink: {
            logicalRows: atEnd.logicalRows,
            focusedId: endId,
            lastMountedId: atEnd.renderedIds.at(-1),
            visibleRows: atEnd.visibleRowCount,
          },
          crossedInitialFilteredWindow: crossedInitialWindow,
          selectedRowMountedAfterShrink,
          selectionPreserved: true,
        };
      } catch (error) {
        evidence.shrink_failure_tree_state = await page.evaluate(() => {
          const tree = document.querySelector(".fm-explorer-tree");
          return {
            focused: document.activeElement?.getAttribute("data-node-id") ?? document.activeElement?.tagName,
            scrollTop: tree?.scrollTop,
            clientHeight: tree?.clientHeight,
            scrollHeight: tree?.scrollHeight,
            rows: Array.from(tree?.querySelectorAll('[role="treeitem"]') ?? [], (row) => ({ id: row.getAttribute("data-node-id"), rect: row.getBoundingClientRect().toJSON(), tabIndex: row.tabIndex })),
            navigationEvents: window.__frontendAuditNavigationEvents ?? [],
          };
        }).catch(() => null);
        throw error;
      } finally {
        await cleanupExplorerNavigationProbe().catch(() => {});
        fixture.scene = structuredClone(originalScene);
        await setRevision(originalRevision);
        fixture.manifest.source_scene_revision = originalManifestRevision;
      }
    });

    fixture.scene = structuredClone(originalScene);
    await setRevision(originalRevision);
    fixture.manifest.source_scene_revision = originalManifestRevision;

    await runScenario("region-memberships-refresh-recovers-after-error", async () => {
      const region = {
        bounds_max: [1e-7, 4e-8, 2.5e-9],
        bounds_min: [-1e-7, -4e-8, -2.5e-9],
        enabled: true,
        interaction_refs: [],
        material_ref: "fixture-material",
        mesh_part_ids: ["film-part"],
        name: "Core",
        owner_object_id: "film",
        region_id: "film:core",
        source: "authored_object_region",
        source_body_ids: ["film"],
        source_object_ids: ["film"],
      };
      fixture.scene.objects[0].regions = [{ ...region }];
      await setRevision(fixture.revision + 1);

      const regionsRoutePattern = `**${MODEL_REGIONS_PATH}**`;
      const membershipsRoutePattern = `**${MESH_REGION_MEMBERSHIPS_PATH}**`;
      const regionIdsByResponse = [];
      const regionRefreshOrigins = [];
      const membershipStatuses = [];
      const regionList = {
        geometry_realization_revision: fixture.revision,
        region_membership_revision: 1,
        region_topology_revision: 1,
        regions: [region],
        scene_revision: fixture.revision,
      };
      const membershipList = {
        memberships: [{
          boundary_face_indices: [],
          element_indices: [0],
          freshness: "current",
          mesh_generation_id: "frontend-audit-generation",
          mesh_id: "mesh:shared-domain",
          mesh_part_ids: ["film-part"],
          mesh_revision: 7,
          node_indices: [0, 1],
          owner_object_id: "film",
          realization: "conformal",
          region_id: "film:core",
          region_membership_revision: 1,
          source: "fixture",
          topology_fingerprint: "frontend-audit-topology",
        }],
        mesh_id: "mesh:shared-domain",
        mesh_revision: 7,
        unresolved_regions: [],
      };
      const regionsRoute = async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        if (new URL(route.request().url()).pathname !== MODEL_REGIONS_PATH) return route.fallback();
        regionIdsByResponse.push(regionList.regions.map((item) => item.region_id));
        regionRefreshOrigins.push(await page.evaluate(() =>
          window.__frontendAuditRegionMembershipRefreshClicked === true,
        ));
        return fulfillJson(route, regionList);
      };
      const membershipsRoute = async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        if (new URL(route.request().url()).pathname !== MESH_REGION_MEMBERSHIPS_PATH) return route.fallback();
        const refreshClicked = await page.evaluate(() =>
          window.__frontendAuditRegionMembershipRefreshClicked === true,
        );
        if (!refreshClicked) {
          membershipStatuses.push(503);
          return fulfillJson(route, {
            error: {
              code: "frontend_audit_membership_error",
              message: "Fixture region membership unavailable.",
            },
          }, 503);
        }
        membershipStatuses.push(200);
        return fulfillJson(route, membershipList);
      };

      await page.route(regionsRoutePattern, regionsRoute);
      await page.route(membershipsRoutePattern, membershipsRoute);
      try {
        await page.evaluate(() => { window.__frontendAuditRegionMembershipRefreshClicked = false; });
        const firstFailurePromise = page.waitForResponse((response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === MESH_REGION_MEMBERSHIPS_PATH,
        { timeout: 15_000 });
        await openWorkspace("frontend-region-membership-retry-audit");
        await page.getByRole("button", { name: "Expand all explorer nodes" }).click();
        const meshRowId = "model:object:film:regions:film:core:mesh";
        const meshRow = row(meshRowId);
        await meshRow.waitFor({ state: "visible", timeout: 10_000 });
        const firstFailure = await firstFailurePromise;
        assert.equal(firstFailure.status(), 503, "Initial region membership request did not fail as configured.");
        await page.waitForFunction((nodeId) =>
          document.querySelector(`[data-node-id="${nodeId}"]`)?.getAttribute("data-status") === "degraded",
        meshRowId, { timeout: 10_000 });

        const refreshButton = page.getByRole("button", { name: "Refresh explorer" });
        await refreshButton.evaluate((button) => {
          button.addEventListener("click", () => {
            window.__frontendAuditRegionMembershipRefreshClicked = true;
          }, { capture: true, once: true });
        });
        const refreshedMembershipPromise = page.waitForResponse((response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === MESH_REGION_MEMBERSHIPS_PATH &&
          response.status() === 200,
        { timeout: 15_000 });
        const refreshedRegionsPromise = page.waitForResponse((response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === MODEL_REGIONS_PATH,
        { timeout: 15_000 });
        await refreshButton.click();
        const recoveredMembership = await refreshedMembershipPromise;
        const refreshedRegions = await refreshedRegionsPromise;
        assert.equal(recoveredMembership.status(), 200, "Refresh did not recover the membership resource.");
        assert.equal(refreshedRegions.status(), 200, "Refresh did not reload the model regions resource.");
        await page.waitForFunction((nodeId) =>
          document.querySelector(`[data-node-id="${nodeId}"]`)?.getAttribute("data-status") === "mesh-ready",
        meshRowId, { timeout: 10_000 });
        assert.ok(regionIdsByResponse.length >= 2,
          `Expected initial and Refresh region-list reads, got ${regionIdsByResponse.length}.`);
        assert.deepEqual(regionIdsByResponse[0], ["film:core"], "Initial region IDs did not match the fixture.");
        assert.ok(regionIdsByResponse.every((ids) => JSON.stringify(ids) === JSON.stringify(["film:core"])),
          `Refresh changed authored region IDs: ${JSON.stringify(regionIdsByResponse)}.`);
        assert.equal(membershipStatuses[0], 503, "The first membership attempt was not the expected error.");
        assert.ok(membershipStatuses.includes(200), "No successful membership response followed Refresh.");
        assert.ok(regionRefreshOrigins.includes(true), "Refresh did not reload the same model-region IDs.");
        await capture("region-membership-refresh-recovered", page.locator(".fm-explorer"));
        return {
          endpoint: MESH_REGION_MEMBERSHIPS_PATH,
          initialStatus: firstFailure.status(),
          statusAfterRefresh: recoveredMembership.status(),
          membershipAttempts: membershipStatuses,
          regionIdsByResponse,
          regionRefreshOrigins,
          meshRowId,
          meshStatusBeforeRefresh: "degraded",
          meshStatusAfterRefresh: "mesh-ready",
          noRegionIdentityChange: true,
        };
      } finally {
        await page.unroute(regionsRoutePattern, regionsRoute);
        await page.unroute(membershipsRoutePattern, membershipsRoute);
        fixture.scene = structuredClone(originalScene);
        await setRevision(originalRevision);
        fixture.manifest.source_scene_revision = originalManifestRevision;
        await page.evaluate(() => { delete window.__frontendAuditRegionMembershipRefreshClicked; }).catch(() => {});
      }
    });

    await runScenario("real-object-and-geometry-validation-consumers", async () => {
      let validationMode = "ready";
      let releaseLoading = null;
      let markLoadingStarted = null;
      const loadingStarted = new Promise((resolveLoadingStarted) => {
        markLoadingStarted = resolveLoadingStarted;
      });
      let releasePendingValidation = new Promise((resolveValidation) => {
        releaseLoading = resolveValidation;
      });
      const routePattern = `**${GEOMETRY_VALIDATION_PATH}**`;
      const validationRoute = async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        if (validationMode === "loading") {
          markLoadingStarted?.();
          await releasePendingValidation;
          return route.fallback();
        }
        if (validationMode === "error") {
          return fulfillJson(route, {
            error: {
              code: "frontend_audit_validation_error",
              message: "Fixture geometry validation request failed.",
            },
          }, 503);
        }
        return route.fallback();
      };

      async function openValidationSummary() {
        const inspector = page.locator(".fm-inspector");
        const trigger = inspector
          .locator('[data-slot="inspector-group-trigger"]')
          .filter({ hasText: "Validation" })
          .last();
        await trigger.waitFor({ state: "visible" });
        if (await trigger.getAttribute("aria-expanded") === "false") await trigger.click();
        return trigger.locator("xpath=..").locator('[data-slot="inspector-group-content"]');
      }

      async function selectGeometryRow(nodeId) {
        for (const parentId of ["model:session", "model:objects", "model:object:film"]) {
          const parent = row(parentId);
          await parent.waitFor({ state: "visible" });
          if (await parent.getAttribute("aria-expanded") === "false") {
            await parent.locator(".fm-explorer-tree-row__branch").click();
          }
        }
        const target = row(nodeId);
        await target.waitFor({ state: "visible" });
        await target.click();
      }

      function normalizedText(locator) {
        return locator.innerText().then((text) => text.replace(/\s+/g, " ").trim());
      }

      async function waitForLoadingRoute() {
        let timer;
        try {
          await Promise.race([
            loadingStarted,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("Geometry validation loading route was not reached.")), 10_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }

      await page.route(routePattern, validationRoute);
      try {
        validationMode = "loading";
        await openWorkspace("frontend-real-validation-loading");
        await selectGeometryRow("model:object:film");
        const objectValidation = await openValidationSummary();
        await waitForLoadingRoute();
        const objectLoadingText = await normalizedText(objectValidation);
        assert.match(objectLoadingText, /Geometry validation is loading\./);
        assert.doesNotMatch(objectLoadingText, /no object issues/);
        await capture("real-object-validation-loading", page.locator(".fm-inspector"));

        await selectGeometryRow("model:object:film:geometry");
        const geometryValidation = await openValidationSummary();
        const geometryLoadingText = await normalizedText(geometryValidation);
        assert.match(geometryLoadingText, /Geometry validation is loading\./);
        assert.doesNotMatch(geometryLoadingText, /no object issues/);

        releaseLoading?.();
        releasePendingValidation = Promise.resolve();
        await page.waitForFunction(() =>
          Array.from(document.querySelectorAll('[data-slot="inspector-group-content"]'))
            .some((content) => content.textContent?.includes("no object issues")),
        null, { timeout: 10_000 });
        const geometryReadyText = await normalizedText(geometryValidation);
        assert.match(geometryReadyText, /no object issues/);
        await capture("real-geometry-validation-ready", page.locator(".fm-inspector"));

        await selectGeometryRow("model:object:film");
        const objectReady = await openValidationSummary();
        assert.match(await normalizedText(objectReady), /no object issues/);
        await capture("real-object-validation-ready", page.locator(".fm-inspector"));

        validationMode = "error";
        const responseTask = page.waitForResponse((response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === GEOMETRY_VALIDATION_PATH,
        { timeout: 15_000 });
        await openWorkspace("frontend-real-validation-error");
        await selectGeometryRow("model:object:film");
        const errorResponse = await responseTask;
        assert.equal(errorResponse.status(), 503, "The workspace error case did not use the mocked validation error.");
        const objectError = await openValidationSummary();
        await objectError.getByRole("alert").filter({ hasText: /Geometry validation could not be loaded/ }).waitFor({ state: "visible" });
        const objectErrorText = await normalizedText(objectError);
        assert.match(objectErrorText, /Geometry validation could not be loaded/);
        assert.doesNotMatch(objectErrorText, /no object issues/);
        await capture("real-object-validation-error", page.locator(".fm-inspector"));

        await selectGeometryRow("model:object:film:geometry");
        const geometryError = await openValidationSummary();
        await geometryError.getByRole("alert").filter({ hasText: /Geometry validation could not be loaded/ }).waitFor({ state: "visible" });
        const geometryErrorText = await normalizedText(geometryError);
        assert.match(geometryErrorText, /Geometry validation could not be loaded/);
        assert.doesNotMatch(geometryErrorText, /no object issues/);
        await capture("real-geometry-validation-error", page.locator(".fm-inspector"));
        return {
          consumers: ["ObjectGeneralPanel", "GeometryObjectPanel"],
          loadingWithoutSuccess: true,
          readyEmptySuccess: true,
          errorWithoutSuccess: true,
          mockedValidationErrorStatus: errorResponse.status(),
        };
      } finally {
        releaseLoading?.();
        await page.unroute(routePattern, validationRoute);
      }
    });

    await runScenario("raw-percent-object-id-and-clipboard-feedback", async () => {
      fixture.scene.objects[0].id = "film%";
      fixture.scene.objects[0].name = "Film percent";
      fixture.scene.objects[0].region_name = "film-percent";
      await setRevision(originalRevision + 1);
      await openWorkspace("frontend-percent-object-id-audit");
      const objectRowId = "model:object:film%";
      const percentObject = row(objectRowId);
      await percentObject.waitFor({ state: "visible" });
      await percentObject.click();
      const inspector = page.locator(".fm-inspector");
      await waitForInspectorName("Film percent");
      assert.equal(fixture.unknownGetPaths.length, 0, `Unexpected fixture GET paths: ${JSON.stringify(fixture.unknownGetPaths)}.`);

      async function copyNodeId() {
        await inspector.getByRole("button", { name: "Inspector options" }).click();
        await page.getByRole("menuitem", { name: "Copy node ID", exact: true }).click();
      }

      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async () => { throw new Error("fixture clipboard rejection"); } },
        });
      });
      await copyNodeId();
      const copyError = inspector.getByRole("alert").filter({ hasText: "Could not copy the node ID" });
      await copyError.waitFor({ state: "visible" });

      await page.evaluate(() => {
        window.__frontendAuditClipboardText = null;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (text) => { window.__frontendAuditClipboardText = text; } },
        });
      });
      await copyNodeId();
      await inspector.getByRole("status").filter({ hasText: "Node ID copied." }).waitFor({ state: "visible" });
      const copiedText = await page.evaluate(() => window.__frontendAuditClipboardText);
      assert.equal(copiedText, objectRowId, "Copy node ID transformed or decoded the raw percent-containing id.");
      await capture("percent-id-copy-feedback", inspector);
      return {
        selectedObjectId: "film%",
        explorerNodeId: objectRowId,
        selectedObjectName: "Film percent",
        inspectorTitle: await inspector.locator(".fm-inspector__title").innerText(),
        clipboardRejectAnnounced: true,
        clipboardResolveAnnounced: true,
        copiedNodeId: copiedText,
      };
    });

    await runScenario("vector3-callback-and-geometry-validation-states", async () => {
      resetInspectorDocumentBudget(fixture.requestBudget, "frontend-controls-fixture");
      const controlsUrl = new URL("/dev/frontend-controls", workspaceUrl).href;
      await page.goto(controlsUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const fixtureRoot = page.getByTestId("frontend-controls-fixture");
      await fixtureRoot.waitFor({ state: "visible", timeout: 30_000 });
      const callbackCount = page.getByTestId("vector-callback-count");
      const x = page.getByRole("textbox", { name: "Audit vector X", exact: true });
      await x.focus();
      await x.press("End");
      await x.press("7");
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="vector-callback-count"]')?.textContent?.trim() === "1",
      null, { timeout: 5_000 });
      assert.equal(await x.inputValue(), "07", "Vector3Field did not retain the single typed character.");
      assert.equal((await callbackCount.innerText()).trim(), "1", "One typed character should call Vector3Field.onChange once.");
      assert.equal(await x.getAttribute("aria-invalid"), "true", "Vector3Field did not expose its axis validation error.");
      const describedBy = await x.getAttribute("aria-describedby");
      assert.ok(describedBy, "Vector3Field error input has no aria-describedby reference.");
      const describedErrorText = await x.evaluate((input) =>
        (input.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent?.trim())
          .filter(Boolean),
      );
      assert.ok(describedErrorText.includes("Fixture vector validation error."),
        `Vector3Field aria-describedby does not reference its visible error: ${JSON.stringify(describedErrorText)}.`);

      const validationSurface = page.getByTestId("validation-summary-fixture");
      async function validationText(surface) {
        return (await surface.innerText()).replace(/\s+/g, " ").trim();
      }
      async function chooseValidationState(label, expectedState) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await page.waitForFunction((state) =>
          document.querySelector('[data-testid="validation-state"]')?.textContent?.trim() === state,
        expectedState, { timeout: 5_000 });
      }

      await chooseValidationState("Ready empty", "ready-empty");
      assert.match(await validationText(validationSurface), /Backend validation no object issues/);
      await capture("validation-ready-empty", fixtureRoot);

      await chooseValidationState("Loading", "loading");
      const loadingText = await validationText(validationSurface);
      assert.match(loadingText, /Geometry validation is loading\./);
      assert.doesNotMatch(loadingText, /no object issues/);
      await capture("validation-loading", fixtureRoot);

      await chooseValidationState("Error", "error");
      const errorText = await validationText(validationSurface);
      assert.match(errorText, /Fixture geometry validation request failed\./);
      assert.doesNotMatch(errorText, /no object issues/);
      await validationSurface.getByRole("alert").waitFor({ state: "visible" });
      await capture("validation-error", fixtureRoot);

      await chooseValidationState("Stale previous result", "stale");
      const staleText = await validationText(validationSurface);
      assert.match(staleText, /The geometry validation result is stale; showing the previous result\./);
      assert.match(staleText, /no object issues \(previous result\)/);
      await capture("validation-stale-previous-result", fixtureRoot);
      return {
        vector3: {
          typedCharacter: "7",
          inputValue: await x.inputValue(),
          callbackCount: 1,
          errorDescribedBy: describedBy,
          describedErrorText,
        },
        geometryValidation: {
          sharedSummaryFixture: true,
          readyEmptySuccess: true,
          loadingWithoutSuccess: true,
          errorWithoutSuccess: true,
          stalePreviousResultIsExplicit: true,
        },
      };
    });

    await runScenario("ribbon-native-color-keyboard-and-command", async () => {
      const color = page.getByLabel("Pick color: Audit color", { exact: true });
      const disabledColor = page.getByLabel("Pick color: Disabled color", { exact: true });
      const trigger = page.getByRole("button", { name: "Open audit color menu", exact: true });
      await trigger.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Before color controls", exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.textContent === "Before color controls");
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Pick color: Audit color");
      const focused = await color.evaluate((input) => ({
        focused: document.activeElement === input,
        type: input.type,
        nestedInteractive: Boolean(input.parentElement?.closest('button,[role="button"]')),
        focusVisible: input.matches(":focus-visible"),
        outlineStyle: getComputedStyle(input.parentElement).outlineStyle,
        outlineWidth: getComputedStyle(input.parentElement).outlineWidth,
      }));
      assert.equal(focused.focused, true, "Radix keyboard navigation did not reach the native color input.");
      assert.equal(focused.type, "color");
      assert.equal(focused.nestedInteractive, false, "Color input is nested in another interactive control.");
      assert.equal(focused.focusVisible, true);
      assert.equal(focused.outlineStyle, "solid");
      assert.ok(Number.parseFloat(focused.outlineWidth) >= 2, "Keyboard focus has no visible swatch outline.");
      assert.equal(await disabledColor.isDisabled(), true);
      await capture("native-color-keyboard-focus", page.getByRole("menu"));
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => document.activeElement?.textContent === "After color controls");
      assert.equal(await page.getByRole("menuitem", { name: "After color controls", exact: true }).evaluate((item) => document.activeElement === item), true,
        "Radix did not skip the disabled color input.");
      await page.keyboard.press("ArrowUp");
      await color.evaluate((input) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "#336699");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForFunction(() => document.querySelector('[data-testid="color-command-count"]')?.textContent === "1");
      assert.equal(await color.inputValue(), "#336699");
      assert.deepEqual(JSON.parse(await page.getByTestId("last-color-command").innerText()), { commandId: "audit.set-color", input: "#336699" });
      assert.equal(await page.getByTestId("color-command-count").innerText(), "1");
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "hidden" });
      // Radix FocusScope dispatches unmount autofocus in a deferred task.
      // Wait for that exact outcome instead of racing its cleanup after hide.
      const triggerElement = await trigger.elementHandle();
      assert.ok(triggerElement, "The color menu trigger was removed.");
      try {
        await page.waitForFunction(
          (button) => button.isConnected && document.activeElement === button,
          triggerElement,
          { timeout: 2_000 },
        );
      } finally {
        await triggerElement.dispose();
      }
      assert.equal(await trigger.evaluate((button) => document.activeElement === button), true, "Closing the menu did not restore trigger focus.");
      return { focused, radixMenu: true, disabledSkipped: true, triggerFocusRestored: true, commandCount: 1, nativeDialog: "not exercised; native input/change events exercised" };
    });

    const newRequests = fixture.requests.slice(initialRequestIndex);
    const forbiddenWrites = newRequests.filter((request) => NO_BACKEND_WRITES.some((pattern) => pattern.test(request)));
    assert.deepEqual(forbiddenWrites, [], `Audit attempted a model edit or Solve command: ${JSON.stringify(forbiddenWrites)}.`);
    assert.equal(fixture.unknownMutationPaths.length, initialMutationCount,
      `Audit triggered unexpected API mutations: ${JSON.stringify(fixture.unknownMutationPaths.slice(initialMutationCount))}.`);
    assert.equal(fixture.geometryMutationBodies.length, initialGeometryWrites, "Audit wrote object geometry.");
    assert.equal(fixture.textureMutationBodies.length, initialTextureWrites, "Audit wrote magnetization.");
    assert.equal(fixture.gridCommandBodies.length, initialGridCommands, "Audit issued a grid or Solve command.");
    evidence.no_backend_edits_or_solve = true;
    evidence.request_counts = Object.fromEntries(fixture.requestCounts);
    evidence.fixture_requests = newRequests;
    evidence.page_errors = consoleErrorEvents
      .filter((event) => event.source === "pageerror")
      .map((event) => event.text);
    assert.deepEqual(evidence.page_errors, [], `Browser pageerror events were observed: ${JSON.stringify(evidence.page_errors)}.`);
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error?.stack ?? String(error);
    evidence.failure_tree_state = await page.evaluate(() => {
      const tree = document.querySelector(".fm-explorer-tree");
      const rows = Array.from(tree?.querySelectorAll('[role="treeitem"]') ?? [], (row) => ({ id: row.getAttribute("data-node-id"), tabIndex: row.tabIndex }));
      return { focused: document.activeElement?.outerHTML?.slice(0, 1200), scrollTop: tree?.scrollTop, clientHeight: tree?.clientHeight, scrollHeight: tree?.scrollHeight, rows, navigationEvents: window.__frontendAuditNavigationEvents ?? [] };
    }).catch(() => null);
    evidence.page_errors = consoleErrorEvents
      .filter((event) => event.source === "pageerror")
      .map((event) => event.text);
    try {
      await page.screenshot({ path: resolve(outputDir, "frontend-production-failure.png"), fullPage: true });
      evidence.screenshots.push("frontend-production-failure.png");
    } catch {
      // The structured failure report remains useful when the page is already closed.
    }
    throw error;
  } finally {
    fixture.scene = structuredClone(originalScene);
    fixture.revision = originalRevision;
    fixture.scene.revision = originalRevision;
    fixture.manifest.source_scene_revision = originalManifestRevision;
    try {
      await page.evaluate((value) => {
        if (value === null) document.documentElement.removeAttribute("data-theme");
        else document.documentElement.dataset.theme = value;
      }, initialTheme);
    } catch {
      // Keep the report even if navigation left the page unavailable.
    }
    evidence.request_counts ??= Object.fromEntries(fixture.requestCounts);
    evidence.fixture_requests ??= fixture.requests.slice(initialRequestIndex);
    await writeFile(
      resolve(outputDir, "frontend-production-browser-audit.json"),
      JSON.stringify(evidence, null, 2),
    );
    console.log(JSON.stringify(evidence, null, 2));
  }
}
