import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const outputDir = resolve(
  process.cwd(),
  process.env.CONTROL_ROOM_INSPECTOR_REPORT_DIR ?? ".fullmag/reports/inspector-2-browser",
);
const INSPECTOR_REQUEST_QUIET_MS = 500;
const INSPECTOR_REQUEST_TIMEOUT_MS = 5_000;
const INSPECTOR_MAX_REQUESTS_PER_PATH = 8;
const INSPECTOR_REQUEST_LIMITS = new Map([
  [
    "PATCH /v2/sessions/current/visualization/state",
    32,
  ],
  [
    "POST /v2/sessions/current/visualization/client-acks",
    32,
  ],
]);
const fixture = createInspectorFixture();

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    try {
      return await import("@playwright/test");
    } catch {
      return null;
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error("Inspector smoke requires Playwright or @playwright/test.");
  process.exit(2);
}

await mkdir(outputDir, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const consoleErrors = [];
const previewRequests = [];

page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message));
page.on("request", (request) => {
  const url = request.url();
  if (/inspector.*(?:thumbnail|screenshot|snapshot)|(?:thumbnail|screenshot).*inspector/i.test(url)) {
    previewRequests.push(url);
  }
});

await page.addInitScript((baseUrl) => {
  window.__FULLMAG_CONFIG__ = {
    ...(window.__FULLMAG_CONFIG__ ?? {}),
    allowMissingSessionSmoke: true,
    controlRoomApiBase: baseUrl,
    disableRealtime: true,
  };
}, new URL(workspaceUrl).origin);
await installInspectorFixtureApi(page, fixture);

try {
  await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const inspector = page.locator(".fm-inspector");
  try {
    await inspector.waitFor({ state: "visible", timeout: 30_000 });
  } catch (error) {
    const bodyText = await page.locator("body").textContent();
    throw new Error(
      `Inspector did not mount. Fixture requests: ${JSON.stringify(fixture.requests.slice(-40))}. Browser errors: ${JSON.stringify(consoleErrors)}. Body text: ${JSON.stringify(bodyText?.slice(0, 3000))}. ${error}`,
    );
  }
  const screenshotFiles = [];
  await qualifyExplorerKeyboardNavigation(page);
  await qualifyInspectorRoutingMatrix(page, inspector, screenshotFiles, fixture);

  await ensureModelNodeVisible(page, "model:object:film:visualization");
  const visualizationNode = page.locator(
    '[data-node-id="model:object:film:visualization"]',
  ).first();
  assert(await visualizationNode.count(), "Visualization Explorer node is required for the Inspector smoke.");
  await visualizationNode.click();
  await page.waitForTimeout(500);

  const expectedTabs = [];
  const tabLabels = await inspector.locator('[role="tab"]').allTextContents();
  assert(
    JSON.stringify(tabLabels) === JSON.stringify(expectedTabs),
    `Unexpected Visualization tabs: ${JSON.stringify(tabLabels)}`,
  );

  const overview = inspector.locator(
    '[data-slot="object-visualization-overview"]',
  );
  assert(
    (await overview.count()) === 1,
    "Visualization Inspector must expose exactly one reference Overview.",
  );
  assert(
    (await overview
      .locator('[data-slot="inspector-group"]')
      .filter({ has: page.getByRole("heading", { name: "Display", exact: true }) })
      .count()) === 1,
    "Visualization Overview must expose exactly one Display group.",
  );
  assert(
    (await inspector.locator(".fm-inspector-section").count()) === 0,
    "Visualization Inspector contains obsolete compatibility sections.",
  );
  assert(
    (await inspector.locator("img, canvas").count()) === 0,
    "Inspector rendered preview media.",
  );

  const geometry = await overview.evaluate((element) => {
    const frame = element.querySelector('[data-slot="inspector-overview-frame"]') ?? element;
    const labels = Array.from(
      element.querySelectorAll('[data-slot="inspector-property-label"]'),
    );
    const controls = Array.from(
      element.querySelectorAll(
        '.fm-visualization-toggle, [data-slot="segmented-control-item"], select',
      ),
    ).filter((control) => control.getBoundingClientRect().height > 0);
    const groups = Array.from(
      element.querySelectorAll('[data-slot="inspector-group"]'),
    );
    const segmented = element.querySelector('[data-slot="segmented-control"]');
    const segmentedItems = Array.from(
      element.querySelectorAll('[data-slot="segmented-control-item"]'),
    );
    const overviewRect = frame.getBoundingClientRect();
    const segmentedRect = segmented?.getBoundingClientRect();
    return {
      groupShadows: groups.map((group) => getComputedStyle(group).boxShadow),
      groupSpacing: Number.parseFloat(getComputedStyle(frame).rowGap),
      labelSizes: labels.map((label) => Number.parseFloat(getComputedStyle(label).fontSize)),
      controlHeights: controls.map((control) => ({
        className: control.className,
        element: control.tagName.toLowerCase(),
        height: control.getBoundingClientRect().height,
        slot: control.getAttribute("data-slot"),
      })),
      minControlHeight: Math.min(
        ...controls.map((control) => control.getBoundingClientRect().height),
      ),
      segmentedFits:
        !segmentedRect || segmentedRect.right <= overviewRect.right + 0.5,
      segmentedItemsFit: segmentedItems.every(
        (item) =>
          item.scrollWidth <= item.clientWidth &&
          item.scrollHeight <= item.clientHeight,
      ),
    };
  });
  assert(
    geometry.labelSizes.length > 0 && geometry.labelSizes.every((size) => size >= 10.5),
    `Inspector field labels are too small: ${JSON.stringify(geometry.labelSizes)}`,
  );
  assert(
    geometry.minControlHeight >= 26,
    `Inspector control height is below 26px: ${JSON.stringify(geometry.controlHeights)}.`,
  );
  assert(
    geometry.groupSpacing >= 10,
    `Inspector group spacing is below 10px: ${geometry.groupSpacing}px.`,
  );
  assert(
    geometry.groupShadows.every((shadow) => shadow === "none"),
    `Ordinary Inspector groups must not have shadows: ${JSON.stringify(geometry.groupShadows)}`,
  );
  assert(geometry.segmentedFits, "Render Mode segmented control is clipped.");
  assert(
    geometry.segmentedItemsFit,
    "Display mode label overflows its segmented-control item.",
  );

  const panel = page.getByTestId("panel-right");
  const resizeHandle = page.getByRole("separator", { name: /Inspector/ }).last();
  const visibleToggle = overview.getByRole("button", {
    name: "Toggle target visibility",
    exact: true,
  });
  const resetButton = panel.getByRole("button", { name: "Reset", exact: true });
  const initialVisible = (await visibleToggle.getAttribute("aria-pressed")) === "true";
  if (!initialVisible) {
    await visibleToggle.click();
    await page.waitForTimeout(150);
  }
  assert(
    (await page.getByRole("dialog", { name: "Airbox visualization diagnostic" }).count()) === 0,
    "Visible must not open the removed Airbox diagnostic dialog.",
  );
  for (const width of [360, 416, 560]) {
    const handleBox = await resizeHandle.boundingBox();
    const panelBox = await panel.boundingBox();
    assert(handleBox && panelBox, "Inspector resize geometry is unavailable.");
    const targetHandleCenter = panelBox.x + panelBox.width - width - handleBox.width / 2;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetHandleCenter, handleBox.y + handleBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    const resized = await panel.boundingBox();
    assert(resized, `Inspector geometry missing after resizing to ${width}px.`);
    assert(
      Math.abs(resized.width - width) <= 3,
      `Inspector width ${resized.width}px does not match ${width}px.`,
    );
    assert(
      await inspector.evaluate((element) => element.scrollWidth <= element.clientWidth),
      `Inspector overflows horizontally at ${width}px.`,
    );
    for (const theme of ["light", "dark"]) {
      await page.evaluate((nextTheme) => {
        document.documentElement.dataset.theme = nextTheme;
      }, theme);
      await page.waitForTimeout(100);
      const fileName = `visualization-overview-${theme}-${width}.png`;
      await panel.screenshot({ path: resolve(outputDir, fileName) });
      screenshotFiles.push(fileName);
    }
  }

  await resizeHandle.dblclick();
  await page.waitForTimeout(150);
  const resetWidth = await panel.boundingBox();
  assert(resetWidth && Math.abs(resetWidth.width - 416) <= 3, "Double-click did not restore 416px.");

  await page.setViewportSize({ height: 900, width: 800 });
  await page.evaluate(() => {
    document.body.style.zoom = "200%";
  });
  await page.waitForTimeout(150);
  const zoomGeometry = await inspector.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const visibleControls = Array.from(
      element.querySelectorAll("button, input, select, [role=\"slider\"]"),
    ).filter((control) => {
      const rect = control.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    return {
      controlsFit: visibleControls.every((control) => {
        const rect = control.getBoundingClientRect();
        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
      }),
      inspectorFits: element.scrollWidth <= element.clientWidth,
    };
  });
  assert(
    zoomGeometry.inspectorFits && zoomGeometry.controlsFit,
    `Inspector overflows at 200% zoom: ${JSON.stringify(zoomGeometry)}`,
  );
  await panel.screenshot({
    path: resolve(outputDir, "visualization-overview-zoom-200.png"),
  });
  screenshotFiles.push("visualization-overview-zoom-200.png");
  await page.evaluate(() => {
    document.body.style.zoom = "";
  });
  await page.setViewportSize({ height: 900, width: 1600 });
  await page.waitForTimeout(150);

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  const overviewContent = inspector.locator(
    ".fm-inspector__content > .fm-scroll-area__viewport",
  );
  await overviewContent.evaluate((element) => {
    element.scrollTop = 140;
  });
  await page.waitForTimeout(100);
  const controlsGeometry = await overview.evaluate((element) => {
    const segmented = element.querySelector('[data-slot="segmented-control"]');
    const quantity = element.querySelector('select[aria-label="Quantity Source"]');
    const renderMode = element.querySelector('[role="radiogroup"][aria-label="Render mode"]');
    return {
      overview: element.getBoundingClientRect().toJSON(),
      quantity: quantity?.getBoundingClientRect().toJSON() ?? null,
      segmented: (renderMode ?? segmented)?.getBoundingClientRect().toJSON() ?? null,
    };
  });
  assert(
    controlsGeometry.segmented && controlsGeometry.quantity,
    `Overview controls are missing after scroll: ${JSON.stringify(controlsGeometry)}`,
  );
  await panel.screenshot({
    path: resolve(outputDir, "visualization-overview-controls-light-416.png"),
  });
  await overviewContent.evaluate((element) => {
    element.scrollTop = 0;
  });

  const surfaceDisclosure = overview
    .locator('[data-slot="inspector-group-trigger"]')
    .filter({ hasText: "Surface Coloring" });
  await surfaceDisclosure.click();
  await surfaceDisclosure.evaluate((element) => {
    element.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(100);
  const surfaceFile = "visualization-surface-coloring-light-416.png";
  await panel.screenshot({ path: resolve(outputDir, surfaceFile) });
  screenshotFiles.push(surfaceFile);
  await surfaceDisclosure.click();

  const vectorsToggle = overview.getByRole("button", {
    name: "Toggle vector field arrows",
    exact: true,
  });
  if ((await vectorsToggle.getAttribute("aria-pressed")) !== "true") {
    await vectorsToggle.click();
    await page.waitForTimeout(150);
  }
  assert(
    (await page.getByRole("dialog", { name: "Airbox visualization diagnostic" }).count()) === 0,
    "Vectors must not open the removed Airbox diagnostic dialog.",
  );
  const vectorsDisclosure = overview
    .locator('[data-slot="inspector-group-trigger"]')
    .filter({ hasText: "Vectors" });
  await vectorsDisclosure.click();
  await vectorsDisclosure.evaluate((element) => {
    element.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(100);
  assert(
    (await overview.locator(".fm-radio-group, .fm-visualization-range").count()) === 0,
    "Vectors still renders legacy radio or range controls.",
  );
  const vectorSliders = overview.locator(
    '[data-slot="visualization-number-control"]:visible',
  );
  assert((await vectorSliders.count()) >= 4, "Vectors must expose shared numeric sliders.");
  const vectorSliderHeights = await vectorSliders.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().height),
  );
  assert(
    vectorSliderHeights.every((height) => height >= 28),
    `Vector slider hit area is below 28px: ${JSON.stringify(vectorSliderHeights)}`,
  );
  const vectorsTopFile = "visualization-vectors-light-416.png";
  await panel.screenshot({ path: resolve(outputDir, vectorsTopFile) });
  screenshotFiles.push(vectorsTopFile);

  const vectorThicknessSlider = overview.getByRole("slider", { name: "Thickness" });
  const vectorThicknessRow = vectorThicknessSlider.locator(
    'xpath=ancestor::*[@data-slot="inspector-property-row"]',
  );
  await vectorThicknessRow.evaluate((element) => {
    element.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(100);
  const vectorsControlsFile = "visualization-vectors-controls-light-416.png";
  await panel.screenshot({ path: resolve(outputDir, vectorsControlsFile) });
  screenshotFiles.push(vectorsControlsFile);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.waitForTimeout(100);
  const vectorsDarkFile = "visualization-vectors-controls-dark-416.png";
  await panel.screenshot({ path: resolve(outputDir, vectorsDarkFile) });
  screenshotFiles.push(vectorsDarkFile);
  await overviewContent.evaluate((element) => {
    element.scrollTop = 0;
  });

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  const renderModeControl = overview.locator(
    '[role="radiogroup"][aria-label="Render mode"]',
  );
  const initialRenderMode = await renderModeControl
    .locator('[role="radio"][aria-checked="true"]')
    .getAttribute("aria-label");
  assert(
    (await overview.getByRole("button", { name: /^(Surface|Wireframe|Points)$/ }).count()) === 0,
    "Drawable passes must not have duplicate toggle buttons beside Display mode.",
  );
  const vectorsBeforeOff = await vectorsToggle.getAttribute("aria-pressed");
  await renderModeControl.getByRole("radio", { name: "Off", exact: true }).click();
  await page.waitForTimeout(500);
  assert(
    (await renderModeControl
      .locator('[role="radio"][aria-checked="true"]')
      .getAttribute("aria-label")) === "Off",
    "Display mode did not remain Off after the resource update settled.",
  );
  assert(
    (await vectorsToggle.getAttribute("aria-pressed")) === vectorsBeforeOff,
    "Display mode Off changed the independent Vectors overlay.",
  );
  if (initialRenderMode && initialRenderMode !== "off") {
    await renderModeControl.getByRole("radio", { name: initialRenderMode, exact: true }).click();
    await page.waitForTimeout(200);
  }
  if ((await visibleToggle.getAttribute("aria-pressed")) === "true") {
    await visibleToggle.click();
  }
  const resetElement = await resetButton.elementHandle();
  assert(resetElement, "Reset control is unavailable after a live display change.");
  await page.waitForFunction((button) => !button.disabled, resetElement, { timeout: 5_000 });
  assert(!(await resetButton.isDisabled()), "A live display change did not enable Reset.");
  const disabledControl = overview.locator("select:disabled").first();
  assert(await disabledControl.count(), "Hidden target did not expose a disabled readable control.");
  const disabledStyle = await disabledControl.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, opacity: Number.parseFloat(style.opacity) };
  });
  assert(
    disabledStyle.color !== "transparent" && disabledStyle.opacity >= 0.7,
    `Disabled control is unreadable: ${JSON.stringify(disabledStyle)}`,
  );
  const disabledFile = "visualization-overview-light-disabled-416.png";
  await panel.screenshot({ path: resolve(outputDir, disabledFile) });
  screenshotFiles.push(disabledFile);
  if (!(await resetButton.isDisabled())) {
    await resetButton.click();
  }
  const resetDeadline = Date.now() + 3_000;
  while (!(await resetButton.isDisabled()) && Date.now() < resetDeadline) {
    await page.waitForTimeout(100);
  }
  const resetState = await resetButton.evaluate((button) => ({
    ariaDisabled: button.getAttribute("aria-disabled"),
    disabled: button.disabled,
  }));
  assert(
    resetState.disabled,
    `Visualization Reset did not restore the applied baseline: ${JSON.stringify({
      requests: fixture.requests.slice(-8),
      resetState,
      visualizationRevision: await panel.getAttribute("data-visualization-revision"),
    })}`,
  );
  const resetRenderMode = await renderModeControl
    .locator('[role="radio"][aria-checked="true"]')
    .getAttribute("aria-label");
  assert(
    resetRenderMode === initialRenderMode,
    `Visualization Reset changed the initial render mode from ${initialRenderMode} to ${resetRenderMode}: ${JSON.stringify(fixture.visualizationMutationBodies.slice(-6))}.`,
  );

  if ((await visibleToggle.getAttribute("aria-pressed")) !== "true") {
    await visibleToggle.click();
    await page.waitForTimeout(200);
  }

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  const degradedFile = "visualization-overview-dark-degraded-416.png";
  await panel.screenshot({ path: resolve(outputDir, degradedFile) });
  screenshotFiles.push(degradedFile);

  const segmentedItem = renderModeControl
    .locator('[role="radio"][aria-checked="true"]')
    .first();
  const initialFocusedMode = await segmentedItem.getAttribute("aria-label");
  await segmentedItem.focus();
  await segmentedItem.press("Tab");
  await page.waitForTimeout(200);
  assert(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label")) !== initialFocusedMode,
    "Render Mode controls did not respond to keyboard focus navigation.",
  );
  if (!(await resetButton.isDisabled())) {
    await resetButton.click();
  }

  const headerTop = await inspector.locator(".fm-inspector__header").boundingBox();
  const actionsTop = await inspector.locator(".fm-inspector__action-bar").boundingBox();
  assert(
    (await inspector.locator(".fm-inspector__tabs").count()) === 0,
    "Visualization must use one continuous surface without shell tabs.",
  );
  const continuousFile = "visualization-continuous-light-416.png";
  await panel.screenshot({ path: resolve(outputDir, continuousFile) });
  screenshotFiles.push(continuousFile);

  const content = inspector.locator(".fm-inspector__content");
  await content.hover();
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(100);
  const stableHeader = await inspector.locator(".fm-inspector__header").boundingBox();
  const stableActions = await inspector.locator(".fm-inspector__action-bar").boundingBox();
  assert(stableHeader?.y === headerTop?.y, "Inspector header moved with content scroll.");
  assert(stableActions?.y === actionsTop?.y, "Inspector action bar moved with content scroll.");

  await qualifyVisualizationMutationStability(page, inspector, fixture);

  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await inspector.waitFor({ state: "visible" });
  const objectNode = page
    .locator('[role="treeitem"]')
    .filter({ hasText: /^periodic_antidot_film/ })
    .first();
  if (await objectNode.count()) {
    if ((await objectNode.getAttribute("aria-expanded")) !== "true") {
      await objectNode.locator(".fm-explorer-tree-row__branch").click();
    }
    const objectMeshNode = page
      .locator('[role="treeitem"]')
      .filter({ hasText: /^Meshprimitive-onlyprimitive/ })
      .first();
    const geometryNode = page
      .locator('[role="treeitem"]')
      .filter({ hasText: /^GeometryDifference/ })
      .first();
    await objectMeshNode.click();
    await page.waitForTimeout(1_000);
    const propertiesTab = inspector.getByRole("tab", { name: "Properties", exact: true });
    await propertiesTab.click();
    await page.waitForTimeout(300);
    assert((await propertiesTab.getAttribute("aria-selected")) === "true", "Mesh Properties did not activate.");
    const presetsSection = inspector.getByRole("button", { name: /Mesh Size Presets/ });
    if ((await presetsSection.getAttribute("aria-expanded")) === "false") {
      await presetsSection.click();
    }
    const sizeFactor = inspector.locator('[aria-label="Size factor"]');
    await sizeFactor.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const originalSizeFactor = await sizeFactor.inputValue();
    await sizeFactor.fill(originalSizeFactor === "1" ? "1.01" : "1");
    assert(
      !(await inspector.getByRole("button", { name: "Apply", exact: true }).isDisabled()),
      "A valid object-mesh draft did not enable Apply.",
    );
    assert(
      !(await inspector.getByRole("button", { name: "Reset", exact: true }).isDisabled()),
      "A dirty object-mesh draft did not enable Reset.",
    );

    await geometryNode.click();
    const dirtyDialog = page.getByRole("dialog", { name: "Unapplied Inspector changes" });
    assert(await dirtyDialog.isVisible(), "Changing selection did not guard a dirty draft.");
    assert(
      (await inspector.locator(".fm-inspector__title").textContent()) === "Object Mesh Policy",
      "Dirty selection changed before the user decided what to do.",
    );
    await dirtyDialog.getByRole("button", { name: "Cancel" }).click();
    assert(!(await dirtyDialog.isVisible()), "Cancel did not close the dirty-selection dialog.");

    await geometryNode.click();
    await dirtyDialog.getByRole("button", { name: "Discard" }).click();
    await page.waitForTimeout(100);
    assert(
      (await inspector.locator(".fm-inspector__title").textContent()) === "Geometry",
      "Discard did not continue to the requested selection.",
    );
  }

  assert((await inspector.locator("img, canvas").count()) === 0, "Inspector rendered preview media.");
  await waitForInspectorRequestQuiet(page, fixture);
  assert(
    fixture.requestBudgetViolation === null,
    `Inspector request budget exceeded: ${JSON.stringify(fixture.requestBudgetViolation)}`,
  );
  assert(
    fixture.unknownGetPaths.length === 0,
    `Inspector fixture received unknown GET resources: ${JSON.stringify(fixture.unknownGetPaths)}`,
  );
  assert(
    fixture.unknownMutationPaths.length === 0,
    `Inspector fixture received unknown mutations: ${JSON.stringify(fixture.unknownMutationPaths)}`,
  );
  assert(previewRequests.length === 0, `Inspector caused preview requests: ${previewRequests.join(", ")}`);
  assert(consoleErrors.length === 0, `Browser errors:\n${consoleErrors.join("\n")}`);

  const viewportCanvas = page.locator('[data-testid="panel-viewport-main"] canvas, [data-testid="viewport-3d-canvas"], canvas').first();
  if (await viewportCanvas.count()) {
    const webgl = await viewportCanvas.evaluate((canvas) => {
      const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      return context
        ? {
            height: context.drawingBufferHeight,
            lost: context.isContextLost(),
            width: context.drawingBufferWidth,
          }
        : null;
    });
    assert(webgl && !webgl.lost && webgl.width > 0 && webgl.height > 0, "Viewport WebGL is not healthy.");
  }

  console.log(
    JSON.stringify(
      {
        consoleErrors: consoleErrors.length,
        dirtySelectionGuard: "verified",
        previewRequests: previewRequests.length,
        screenshots: screenshotFiles,
        tabs: expectedTabs,
        themes: ["light", "dark"],
        visualizationReset: "verified",
        visualizationMutationStability: "verified; mutation budget: 20",
        widths: [360, 416, 560],
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}

async function qualifyVisualizationMutationStability(page, inspector, fixture) {
  const targets = [
    { iterations: 4, label: "Object", nodeId: "model:object:film:visualization" },
    { iterations: 16, label: "Airbox", nodeId: "model:airbox:visualization" },
  ];
  fixture.visualizationPatchDelayMs = 180;
  try {
    for (const target of targets) {
      await selectInspectorNode(page, inspector, target.nodeId, {
        owner: target.label === "Airbox" ? "airbox-visualization" : "object-visualization",
        label: target.label === "Airbox" ? "Airbox" : "Film",
      });
      const overview = inspector.locator('[data-slot="object-visualization-overview"]');
      await overview.waitFor({ state: "visible" });
      const unrelatedVisibility = overview.getByRole("button", {
        name: "Toggle target visibility",
        exact: true,
      });
      let mutationControl;
      let focusControl;
      let expectedFocusedLabel;
      if (target.label === "Object") {
        const surfaceGroup = overview
          .locator('[data-slot="inspector-group"]')
          .filter({ hasText: "Surface Coloring" });
        const surfaceTrigger = surfaceGroup.locator('[data-slot="inspector-group-trigger"]');
        if ((await surfaceTrigger.getAttribute("aria-expanded")) !== "true") {
          await surfaceTrigger.click();
        }
        mutationControl = surfaceGroup.locator('select[aria-label="Color source"]');
        focusControl = mutationControl;
        expectedFocusedLabel = "Color source";
      } else {
        mutationControl = overview.getByRole("button", {
          name: "Toggle target bounds",
          exact: true,
        });
        focusControl = unrelatedVisibility;
        expectedFocusedLabel = "Toggle target visibility";
      }
      await mutationControl.waitFor({ state: "visible" });

      const identity = `${target.label.toLowerCase()}-visualization-stability`;
      const baseline = await overview.evaluate((element, marker) => {
        element.dataset.mutationStabilityMarker = marker;
        const scroller = element.closest(".fm-inspector");
        if (scroller) scroller.scrollTop = Math.min(80, scroller.scrollHeight - scroller.clientHeight);
        return {
          opacity: getComputedStyle(element).opacity,
          scrollTop: scroller?.scrollTop ?? 0,
        };
      }, identity);

      for (let iteration = 0; iteration < target.iterations; iteration += 1) {
        await focusControl.focus();
        if (target.label === "Object") {
          const nextValue = iteration % 2 === 0 ? "component_x" : "solid";
          await mutationControl.selectOption(nextValue);
        } else {
          await mutationControl.evaluate((control) => control.click());
        }
        await page.waitForTimeout(40);
        const duringMutation = await overview.evaluate((element) => {
          const scroller = element.closest(".fm-inspector");
          const opacityAnimations = element
            .getAnimations({ subtree: true })
            .filter((animation) => {
              const frames = animation.effect?.getKeyframes?.() ?? [];
              return frames.some((frame) => Object.hasOwn(frame, "opacity"));
            });
          return {
            connected: element.isConnected,
            focusedLabel: document.activeElement?.getAttribute("aria-label") ??
              document.activeElement?.labels?.[0]?.textContent?.trim() ?? null,
            marker: element.dataset.mutationStabilityMarker,
            opacity: getComputedStyle(element).opacity,
            opacityAnimations: opacityAnimations.length,
            scrollTop: scroller?.scrollTop ?? 0,
          };
        });
        assert(
          duringMutation.connected && duringMutation.marker === identity,
          `${target.label}: Visualization Inspector remounted during mutation.`,
        );
        assert(
          !(await unrelatedVisibility.isDisabled()),
          `${target.label}: unrelated visibility control was disabled during mutation.`,
        );
        assert(
          duringMutation.opacity === baseline.opacity && duringMutation.opacityAnimations === 0,
          `${target.label}: mutation changed Inspector opacity or started an opacity animation.`,
        );
        assert(
          Math.abs(duringMutation.scrollTop - baseline.scrollTop) <= 1,
          `${target.label}: mutation changed Inspector scroll position.`,
        );
        assert(
          duringMutation.focusedLabel === expectedFocusedLabel,
          `${target.label}: mutation lost control focus.`,
        );
        await page.waitForTimeout(fixture.visualizationPatchDelayMs + 80);
        assert(
          (await overview.getAttribute("data-mutation-stability-marker")) === identity,
          `${target.label}: Visualization Inspector remounted after mutation ACK.`,
        );
      }
    }
  } finally {
    fixture.visualizationPatchDelayMs = 0;
  }
}

async function qualifyInspectorRoutingMatrix(page, inspector, screenshotFiles, fixture) {
  await selectInspectorNode(page, inspector, "model:airbox:visualization", {
    owner: "airbox-visualization",
    label: "Airbox",
  });
  await selectInspectorNode(page, inspector, "model:object:film:visualization", {
    owner: "object-visualization",
    label: "Film",
  });
  await selectInspectorNode(page, inspector, "model:mesh:unassigned:orphan-part", {
    owner: "mesh-part-visualization",
    label: "Orphan Mesh Part",
  });

  const resultsTab = page
    .locator(".fm-explorer .fm-tabs-trigger")
    .filter({ hasText: /^Results$/ });
  await resultsTab.click();
  const resultRootId = "results:run:inspector-run";
  const resonanceRootId = `${resultRootId}:resonance`;
  const drivenStageId = `${resonanceRootId}:stage:frequency-response:driven_response`;
  await expandInspectorNode(page, resultRootId);
  await expandInspectorNode(page, resonanceRootId);
  await expandInspectorNode(page, drivenStageId);

  const responseSweepNode = page.locator(
    `[data-node-id="${drivenStageId}:frequency-points"]`,
  );
  await responseSweepNode.waitFor({ state: "visible", timeout: 60_000 });
  await responseSweepNode.click();
  await page.waitForFunction(
    () =>
      document.querySelector(".fm-inspector")?.getAttribute("data-inspector-owner") ===
      "frequency-domain-results-resonance-driven-frequency_points",
    { timeout: 60_000 },
  );
  await inspector
    .getByRole("heading", { exact: true, level: 2, name: "Response Frequency Points" })
    .waitFor();
  const frequencyPointsScreenshot = "physics-first-frequency-points-416.png";
  await inspector.screenshot({ path: resolve(outputDir, frequencyPointsScreenshot) });
  screenshotFiles.push(frequencyPointsScreenshot);
  const responsePointPlotButton = inspector.getByRole("button", {
    name: /Plot this response field with phase-rotated real display at 12\.5 GHz/,
  });
  await responsePointPlotButton.focus();
  await responsePointPlotButton.press("Space");
  const inspectorViewport = inspector.locator(".fm-scroll-area__viewport");
  await inspectorViewport.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  assert(
    await inspectorViewport.evaluate((element) => element.scrollTop > 0),
    "Inspector fixture did not create a non-zero scroll position.",
  );

  const responseFieldsNode = page.locator(
    `[data-node-id="${drivenStageId}:response-fields"]`,
  );
  await responseFieldsNode.waitFor({ state: "visible", timeout: 60_000 });
  await responseFieldsNode.click();
  await page.waitForFunction(
    () =>
      document.querySelector(".fm-inspector")?.getAttribute("data-inspector-owner") ===
      "frequency-domain-results-resonance-driven-fields",
    { timeout: 60_000 },
  );
  await inspector
    .getByRole("heading", { exact: true, level: 2, name: "Response Fields" })
    .waitFor();
  assert(
    await inspectorViewport.evaluate((element) => element.scrollTop === 0),
    "Inspector did not reset scroll position after selecting a new physics result.",
  );
  const responseFieldsScreenshot = "physics-first-response-fields-416.png";
  await inspector.screenshot({ path: resolve(outputDir, responseFieldsScreenshot) });
  screenshotFiles.push(responseFieldsScreenshot);
  const plotButton = inspector.getByRole("button", {
    name: /Plot this response field with phase-rotated real display at 12\.5 GHz/,
  });
  await plotButton.waitFor({ state: "visible", timeout: 60_000 });
  assert(await plotButton.isEnabled(), "Mode visualization Plot 3D action is disabled.");
  await plotButton.focus();
  await plotButton.press("Enter");

  const modelTab = page
    .locator(".fm-explorer .fm-tabs-trigger")
    .filter({ hasText: /^Model$/ });
  await modelTab.click();
  await expandInspectorNode(page, "model:objects");
  await expandInspectorNode(page, "model:object:film");
  await expandInspectorNode(page, "model:object:film:visualization");
  await selectInspectorNode(page, inspector, "model:object:film:visualization:mode-visualization", {
    owner: "object-mode-visualization-overview",
    label: "Film",
  });
  await assertHealthyViewportCanvas(page, "mode visualization");
  const phaseSlider = inspector.getByRole("slider", {
    name: "Mode visualization phase slider",
  });
  await phaseSlider.focus();
  await phaseSlider.press("ArrowRight");
  const playPhase = inspector.getByRole("button", {
    name: "Play mode phase animation",
  });
  await playPhase.focus();
  await playPhase.press("Enter");
  try {
    await inspector.getByRole("button", { name: "Pause mode phase animation" }).waitFor();
  } catch (error) {
    const modeStatus = await inspector.locator('[role="status"]').allTextContents();
    const phaseButtons = await inspector.locator('[aria-label*="mode phase"]').evaluateAll((elements) =>
      elements.map((element) => ({
        ariaLabel: element.getAttribute("aria-label"),
        disabled: element.hasAttribute("disabled"),
      })),
    );
    throw new Error(
      `Mode phase animation did not activate. Status: ${JSON.stringify(modeStatus)}. Controls: ${JSON.stringify(phaseButtons)}. Metadata requests: ${JSON.stringify(fixture.requests.filter((entry) => entry.includes("/meta")))}. Recent fixture requests: ${JSON.stringify(fixture.requests.slice(-30))}. ${error}`,
    );
  }
  const loopPhase = inspector.getByRole("button", {
    name: "Loop mode phase animation",
  });
  assert(
    (await loopPhase.getAttribute("aria-pressed")) === "true",
    "Mode phase animation is not loop-enabled by default.",
  );
  await loopPhase.click();
  assert(
    (await loopPhase.getAttribute("aria-pressed")) === "false",
    "Mode phase animation loop toggle did not update.",
  );
  const modeViewScreenshot = "mode-visualization-phase-controls-416.png";
  await inspector.screenshot({ path: resolve(outputDir, modeViewScreenshot) });
  screenshotFiles.push(modeViewScreenshot);
  assert(
    await inspector.evaluate((element) => element.scrollWidth <= element.clientWidth),
    "Mode visualization Inspector has horizontal overflow.",
  );

  await selectInspectorNode(page, inspector, "model:object:film:visualization", {
    owner: "object-visualization",
    label: "Film after mode return",
  });
  await assertHealthyViewportCanvas(page, "return to object viewport");
  await qualifyModalDispersionAndPostprocessing(page, inspector, screenshotFiles, fixture);
}

async function qualifyModalDispersionAndPostprocessing(page, inspector, screenshotFiles, fixture) {
  fixture.analysisProduct = "modal_eigen";
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await inspector.waitFor({ state: "visible", timeout: 30_000 });

  const resultsTab = page
    .locator(".fm-explorer .fm-tabs-trigger")
    .filter({ hasText: /^Results$/ });
  await resultsTab.click();
  const resultRootId = "results:run:inspector-run";
  const dispersionRootId = `${resultRootId}:k-resolved`;
  const modalStageId = `${dispersionRootId}:stage:eigen-dispersion:modal_eigen`;
  await expandInspectorNode(page, resultRootId);
  await expandInspectorNode(page, dispersionRootId);
  await expandInspectorNode(page, modalStageId);

  await selectResultInspectorNode(page, inspector, `${modalStageId}:dispersion`, {
    owner: "frequency-domain-results-dispersion-modal-relation",
    heading: "Dispersion Relation",
    label: "Modal dispersion relation",
  });
  const dispersionScreenshot = "physics-first-dispersion-relation-416.png";
  await inspector.screenshot({ path: resolve(outputDir, dispersionScreenshot) });
  screenshotFiles.push(dispersionScreenshot);

  await selectResultInspectorNode(page, inspector, `${modalStageId}:branches`, {
    owner: "frequency-domain-results-dispersion-modal-branches",
    heading: "Mode Branches",
    label: "Modal mode branches",
  });
  const branchesScreenshot = "physics-first-mode-branches-416.png";
  await inspector.screenshot({ path: resolve(outputDir, branchesScreenshot) });
  screenshotFiles.push(branchesScreenshot);

  for (const [suffix, heading, owner, label] of [
    ["analysis-views", "Analysis Views", "frequency-domain-results-analysis_views-root", "Analysis Views"],
    ["derived-values", "Derived Values", "frequency-domain-results-derived_values-root", "Derived Values"],
    ["tables", "Tables", "frequency-domain-results-tables-root", "Tables"],
    ["exports", "Exports", "frequency-domain-results-exports-root", "Exports"],
  ]) {
    await selectResultInspectorNode(page, inspector, `${resultRootId}:${suffix}`, {
      owner,
      heading,
      label,
    });
  }

  fixture.analysisProduct = "driven_response";
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await inspector.waitFor({ state: "visible", timeout: 30_000 });
  const modelTab = page
    .locator(".fm-explorer .fm-tabs-trigger")
    .filter({ hasText: /^Model$/ });
  await modelTab.click();
  await expandInspectorNode(page, "model:objects");
  await expandInspectorNode(page, "model:object:film");
  await page.locator('[data-node-id="model:object:film:visualization"]').waitFor({
    state: "visible",
    timeout: 60_000,
  });
}

async function selectResultInspectorNode(page, inspector, nodeId, { owner, heading, label }) {
  await ensureModelNodeVisible(page, nodeId);
  const node = page.locator(`[data-node-id="${nodeId}"]`);
  await node.click();
  await page.waitForFunction(
    (id) => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("aria-selected") === "true",
    nodeId,
    { timeout: 60_000 },
  );
  await page.waitForFunction(
    (expectedOwner) => document.querySelector(".fm-inspector")?.getAttribute("data-inspector-owner") === expectedOwner,
    owner,
    { timeout: 60_000 },
  );
  await inspector.getByRole("heading", { exact: true, level: 2, name: heading }).waitFor();
  assert(
    (await inspector.getAttribute("data-inspector-owner")) === owner,
    `${label} resolved to the wrong Inspector owner: ${await inspector.getAttribute("data-inspector-owner") ?? "none"}.`,
  );
}

async function qualifyExplorerKeyboardNavigation(page) {
  const tree = page.locator('[role="tree"][aria-label="Explorer tree"]').first();
  const session = tree.locator('[data-node-id="model:session"]');
  await session.waitFor({ state: "visible", timeout: 60_000 });
  await session.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert(
    await tree.locator('[role="treeitem"]:focus').count() === 1,
    "Explorer tree keyboard navigation did not retain a focused tree row.",
  );
}

async function selectInspectorNode(page, inspector, nodeId, { owner, label }) {
  await ensureModelNodeVisible(page, nodeId);
  const node = page.locator(`[data-node-id="${nodeId}"]`);
  await node.click();
  await page.waitForFunction(
    (id) => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("aria-selected") === "true",
    nodeId,
    { timeout: 60_000 },
  );
  await inspector.waitFor({ state: "visible", timeout: 60_000 });
  const title = (await inspector.locator(".fm-inspector__title").textContent())?.trim() ?? "";
  const breadcrumbs = await inspector
    .locator('[aria-label="Selection path"]')
    .allTextContents();
  const identityText = [title, ...breadcrumbs].join(" ");
  assert(
    inspector.getAttribute("data-inspector-owner")
      ? (await inspector.getAttribute("data-inspector-owner")) === owner
      : false,
    `${label} selection resolved to the wrong Inspector owner: ${await inspector.getAttribute("data-inspector-owner") ?? "none"}.`,
  );
  assert(title.length > 0, `${label} selection has no Inspector title.`);
  assert(
    !/^(?:Selection|Placeholder|Nothing selected)$/i.test(title) &&
      !/placeholder/i.test(identityText),
    `No placeholder Inspector may own ${label} selection: ${identityText}`,
  );
  assert(breadcrumbs.length > 0, `${label} selection has no breadcrumb identity.`);
  const focus = inspector.getByRole("button", { name: "Focus", exact: true });
  assert(await focus.isVisible(), `${label} selection has no visible primary Inspector action.`);
}

async function ensureModelNodeVisible(page, nodeId) {
  if (nodeId.startsWith("results:")) return;
  const modelTab = page
    .locator(".fm-explorer .fm-tabs-trigger")
    .filter({ hasText: /^Model$/ });
  if (await modelTab.count() && await modelTab.getAttribute("aria-selected") !== "true") {
    await modelTab.click();
  }
  const parentIds = nodeId.startsWith("model:airbox:")
    ? ["model:universe", "model:airbox"]
    : nodeId.startsWith("model:object:film:")
      ? ["model:objects", "model:object:film"]
      : nodeId.startsWith("model:mesh:unassigned:")
        ? ["model:mesh", "model:mesh:unassigned"]
        : [];
  for (const parentId of parentIds) {
    if (parentId === nodeId) continue;
    await expandInspectorNode(page, parentId);
  }
  const node = page.locator(`[data-node-id="${nodeId}"]`);
  await node.waitFor({ state: "visible", timeout: 60_000 });
  await node.scrollIntoViewIfNeeded();
}

async function expandInspectorNode(page, nodeId) {
  const node = page.locator(`[data-node-id="${nodeId}"]`);
  try {
    await node.waitFor({ state: "visible", timeout: 60_000 });
  } catch (error) {
    const treeState = await page.locator('[role="treeitem"]').evaluateAll((items) =>
      items.slice(0, 80).map((item) => ({
        id: item.getAttribute("data-node-id"),
        label: item.textContent?.trim(),
        selected: item.getAttribute("aria-selected"),
      })),
    );
    throw new Error(
      `Explorer node ${nodeId} did not become visible. Tree snapshot: ${JSON.stringify(treeState)}. ${error}`,
    );
  }
  if ((await node.getAttribute("aria-expanded")) !== "false") return;
  const branch = node.locator(".fm-explorer-tree-row__branch");
  if (await branch.count()) {
    await branch.click();
  } else {
    await node.dblclick();
  }
  await page.waitForFunction(
    (id) => document.querySelector(`[data-node-id="${id}"]`)?.getAttribute("aria-expanded") === "true",
    nodeId,
    { timeout: 60_000 },
  );
}

async function assertHealthyViewportCanvas(page, label) {
  const canvas = page.locator(".fm-viewport-3d canvas").first();
  await canvas.waitFor({ state: "visible", timeout: 60_000 });
  const state = await canvas.evaluate((node) => {
    const gl = node.getContext("webgl2") ?? node.getContext("webgl");
    return {
      drawingBufferHeight: gl?.drawingBufferHeight ?? 0,
      drawingBufferWidth: gl?.drawingBufferWidth ?? 0,
      isContextLost: gl?.isContextLost() ?? true,
    };
  });
  assert(
    !state.isContextLost && state.drawingBufferWidth > 0 && state.drawingBufferHeight > 0,
    `${label}: viewport WebGL failed: ${JSON.stringify(state)}`,
  );
}

function createInspectorFixture() {
  const revision = 12;
  const scene = {
    metadata: {
      authoring_schema: "scene-document.v1",
      id: "inspector-routing-smoke",
      name: "Inspector routing smoke",
      source_of_truth: "fixture",
    },
    revision,
    current_modules: { excitation_analysis: null, modules: [] },
    editor: {},
    magnetization_assets: [],
    materials: [],
    objects: [
      {
        geometry: {
          geometry_kind: "Box",
          geometry_params: { size: [200e-9, 80e-9, 5e-9] },
        },
        id: "film",
        material_ref: null,
        name: "Film",
        region_name: "film",
        regions: [],
        role: "magnet",
        tags: ["mesh:ready"],
        transform: {
          pivot: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          translation: [0, 0, 0],
        },
      },
    ],
    outputs: { items: [] },
    study: {
      requested_backend: "fem",
      requested_device: "cpu",
      requested_mode: "strict",
      requested_precision: "double",
      stages: [],
    },
    universe: {
      id: "universe",
      name: "Universe",
      size: [1e-6, 1e-6, 1e-6],
    },
  };
  return {
    manifest: {
      generation_id: "1",
      mesh_name: "Inspector fixture mesh",
      mesh_parts: [
        inspectorMeshPart("airbox", "airbox", null, 0),
        inspectorMeshPart("film-part", "magnetic", "film", 1),
        inspectorMeshPart("orphan-part", "volume", null, 2),
      ],
      object_segments: [
        {
          element_count: 1,
          element_start: 1,
          id: "film-segment",
          node_count: 4,
          node_start: 4,
          object_id: "film",
          region_ids: [],
        },
      ],
      regions: [],
      revision: 7,
      source_scene_revision: revision,
      topology_fingerprint: "inspector-routing-topology",
    },
    requests: [],
    visualizationMutationBodies: [],
    requestCounts: new Map(),
    requestBudgetViolation: null,
    analysisProduct: "driven_response",
    unknownMutationPaths: [],
    unknownGetPaths: [],
    revision,
    scene,
    topology: inspectorTopologyBuffer(),
    visualizationPatchDelayMs: 0,
    visualization: inspectorVisualizationState(),
  };
}

function inspectorMeshPart(id, role, objectId, ordinal) {
  return {
    boundary_face_count: 4,
    boundary_face_indices: [0, 1, 2, 3].map((index) => index + ordinal * 4),
    boundary_face_start: ordinal * 4,
    bounds_max: [1 + ordinal, 1 + ordinal, 1 + ordinal],
    bounds_min: [-1 + ordinal, -1 + ordinal, -1 + ordinal],
    element_count: 1,
    element_start: ordinal,
    id,
    node_count: 4,
    node_indices: [0, 1, 2, 3].map((index) => index + ordinal * 4),
    node_start: ordinal * 4,
    object_id: objectId,
    role,
    surface_faces: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]],
    topology: "tet4",
  };
}

function inspectorVisualizationState() {
  return {
    active_quantity_id: "m",
    auto_contrast: true,
    camera: {
      fov_degrees: 45,
      orthographic_scale: null,
      position: [0, 0, 1],
      projection: "perspective",
      target: [0, 0, 0],
      up: [0, 1, 0],
    },
    clip: { axis: "x", enabled: false, flipped: false, position_percent: 50 },
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    diagnostics: { degraded_reasons: [], warnings: [] },
    domains: { active_scope: { object_id: null, part_id: null, scope: "full" }, topology_mode: "auto" },
    field_component: "magnitude",
    layers: {
      airbox: { render_mode: "wireframe", show_airbox: true, show_airbox_vectors: false },
      bounds: { visible: false },
      points: { visible: false },
      primitives: { visible: true },
      quantity: { visible: true },
      surface: { opacity: 1, visible: true },
      vectors: { density: 50, domain: "auto", visible: false },
      wireframe: { visible: false },
    },
    max_points: 16_384,
    overrides: [],
    quantity: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      component: "magnitude",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
    },
    revision: 1,
    sampling: { max_glyphs: 16_384, max_points: 16_384, profile: "balanced", progressive: true },
    schema_version: 5,
  };
}

async function installInspectorFixtureApi(page, fixture) {
  await page.route("**/v2/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    fixture.requests.push(`${request.method()} ${path}${url.search}`);
    const requestKey = `${request.method()} ${path}`;
    const requestCount = (fixture.requestCounts.get(requestKey) ?? 0) + 1;
    fixture.requestCounts.set(requestKey, requestCount);
    const requestLimit =
      INSPECTOR_REQUEST_LIMITS.get(requestKey) ??
      INSPECTOR_MAX_REQUESTS_PER_PATH;
    if (requestCount > requestLimit) {
      fixture.requestBudgetViolation ??= {
        count: requestCount,
        key: requestKey,
        limit: requestLimit,
        recent: fixture.requests.slice(-20),
      };
      return fulfillJson(
        route,
        { error: { code: "inspector_fixture_request_budget_exceeded" } },
        508,
      );
    }
    if (request.method() === "OPTIONS") return fulfillEmpty(route, 204);
    if (path === "/v2/sessions/current/visualization/state" && request.method() === "PATCH") {
      const patch = request.postDataJSON() ?? {};
      fixture.visualizationMutationBodies.push(patch);
      fixture.visualization = mergeInspectorVisualizationState(fixture.visualization, patch);
      fixture.visualization.revision += 1;
      if (fixture.visualizationPatchDelayMs > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, fixture.visualizationPatchDelayMs));
      }
      return fulfillJson(route, fixture.visualization);
    }
    if (path === "/v2/sessions/current/visualization/client-acks" && request.method() === "POST") {
      const body = request.postDataJSON() ?? {};
      return fulfillJson(route, {
        client_id: body.client_id ?? "fixture-client",
        revision: body.revision ?? fixture.revision,
        status: body.status ?? "ready",
      });
    }
    if (request.method() !== "GET") {
      fixture.unknownMutationPaths.push(`${request.method()} ${path}${url.search}`);
      return fulfillJson(
        route,
        { error: { code: "inspector_fixture_unknown_mutation", path } },
        405,
      );
    }
    if (path === "/v2/sessions/current/status") return fulfillJson(route, inspectorSessionStatus(fixture));
    if (path === "/v2/sessions/current/data/quantities") return fulfillJson(route, {
      quantities: [{
        capability_state: "supported",
        description: "Magnetization",
        domain: "magnetic",
        id: "m",
        interactive_preview: true,
        label: "Magnetization",
        location: "cell",
        materializable: true,
        materialization_reason_code: null,
        materialization_state: "ready",
        n_comp: 3,
        normalization_hint: "unit_vector",
        quick_access_label: "m",
        scalar_metric_key: null,
        shape: "vector",
        supports_export: true,
        supports_history: true,
        supports_preview_2d: true,
        supports_preview_3d: true,
        unit: "1",
      }],
      schema_version: "quantity-catalog.v1",
    });
    if (/^\/v2\/sessions\/current\/data\/fields\/[^/]+\/availability$/.test(path)) {
      const quantityId = decodeURIComponent(path.split("/").at(-2) ?? "m");
      return fulfillJson(route, {
        carrier_id: url.searchParams.get("scope_id"),
        generation: "inspector-field-generation",
        materialized: true,
        pending: false,
        quantity_id: quantityId,
        reason_code: null,
        revision: fixture.revision,
        scope_id: url.searchParams.get("scope_id"),
        scope_kind: url.searchParams.get("scope_kind") ?? "object",
        state: "ready",
        supported: true,
        target_id: url.searchParams.get("target_id") ?? "object:film",
      });
    }
    if (path === "/v2/sessions/current/model/scene") return fulfillJson(route, fixture.scene);
    if (path === "/v2/sessions/current/model/regions") return fulfillJson(route, { regions: [], revision: fixture.revision });
    if (path === "/v2/sessions/current/model/material-fields") return fulfillJson(route, { fields: [], revision: fixture.revision });
    if (path === "/v2/sessions/current/model/couplings") return fulfillJson(route, { couplings: [], revision: fixture.revision });
    if (path === "/v2/sessions/current/model/physics-graph") return fulfillJson(route, { interactions: [], revision: fixture.revision });
    if (path === "/v2/sessions/current/model/current-transports") return fulfillJson(route, { items: [], scene_revision: fixture.revision });
    if (path === "/v2/sessions/current/model/geometry/capabilities") return fulfillJson(route, { csg_capabilities: [], primitive_capabilities: [], revision: fixture.revision });
    if (path === "/v2/sessions/current/model/geometry/validation") return fulfillJson(route, { diagnostics: [], revision: fixture.revision, valid: true });
    if (path === "/v2/sessions/current/model/planar-monitors") return fulfillJson(route, { count: 0, monitors: [], scene_revision: fixture.revision });
    if (path === "/v2/sessions/current/model/universe") return fulfillJson(route, {
      mesh_dirty: false,
      object_bounds_max: [16e-9, 8e-9, 2e-9],
      object_bounds_min: [0, 0, 0],
      scene_revision: fixture.revision,
      study_universe_mesh: null,
      universe: null,
    });
    if (path === "/v2/sessions/current/simulation/preparation") return fulfillJson(route, inspectorPreparationResource());
    if (path === "/v2/sessions/current/data/domain/meta") return fulfillJson(route, inspectorDomainMeta());
    if (path === "/v2/sessions/current/data/fields") return fulfillJson(route, inspectorFieldCatalog());
    if (path === "/v2/sessions/current/visualization/state") return fulfillJson(route, fixture.visualization);
    if (path === "/v2/sessions/current/meshing/meshes/shared-domain/manifest") return fulfillJson(route, fixture.manifest);
    if (path === "/v2/sessions/current/meshing/builds") return fulfillJson(route, { history: [], revision: 7 });
    if (path === "/v2/sessions/current/meshing/capabilities") return fulfillJson(route, { mesh_adaptivity_state: null, mesh_capabilities: null, revision: 7 });
    if (path === "/v2/sessions/current/meshing/mesh/periodic_pairs.v1") return fulfillJson(route, {
      pairs: [],
      revision: 7,
      schema_version: "periodic_pairs.v1",
      status: "unavailable",
      status_reasons: ["Fixture mesh has no periodic boundaries."],
    });
    if (path === "/v2/sessions/current/meshing/policies/universe") return fulfillJson(route, { config: { hmax: 1e-8 }, revision: 7 });
    if (path === "/v2/sessions/current/meshing/semantics") return fulfillJson(route, {
      mesh_build_diagnostics: null,
      object_configs: [],
      render_only_controls_do_not_change_solver_domain: true,
      revision: 7,
      shared_domain_config: {},
      solver_mesh: null,
      universe_config: null,
    });
    if (path === "/v2/sessions/current/meshing/summary") return fulfillJson(route, { effective_airbox_target: { hmax: 1e-8 }, revision: 7 });
    if (path === "/v2/sessions/current/meshing/quality-gates") return fulfillJson(route, { gates: { status: "pass", checks: [] }, revision: 7 });
    if (path === "/v2/sessions/current/meshing/size-fields") return fulfillJson(route, { realized_size_fields: { fields: [] }, revision: 7 });
    if (path === "/v2/sessions/current/meshing/meshes/shared-domain/quality-gates") return fulfillJson(route, {
      gates: null,
      mixed_certificate: {
        certificate_fingerprint: null,
        certificate_schema_version: null,
        certificate_status: null,
        family_gates: [],
        mesh_revision: 7,
        reason: "Fixture mesh has no certified quality-gate certificate.",
        status: "unavailable",
        topology_fingerprint: null,
      },
      revision: 7,
    });
    if (path === "/v2/sessions/current/meshing/meshes/shared-domain/realized-size-fields") return fulfillJson(route, {
      realized_size_fields: {
        fields: [],
        reason: "Fixture mesh has no realized size fields.",
        source: "fixture",
      },
      revision: 7,
    });
    if (path === "/v2/sessions/current/meshing/meshes/shared-domain/report") return fulfillJson(route, { report: null, revision: 7 });
    if (path === "/v2/sessions/current/meshing/meshes/shared-domain/quality") return fulfillJson(route, { quality: null, revision: 7 });
    if (path === "/v2/sessions/current/meshing/meshes/universe/report") return fulfillJson(route, { report: null, revision: 7 });
    if (path === "/v2/sessions/current/meshing/meshes/universe/quality") return fulfillJson(route, { quality: null, revision: 7 });
    if (path === "/v2/sessions/current/meshing/builds/current") return fulfillJson(route, { active_build: null, mesh_pipeline_status: "ready", revision: 7 });
    if (path === "/v2/sessions/current/meshing/builds/latest-successful") return fulfillJson(route, { provenance: { scene_revision: fixture.revision }, revision: 7, status: "completed" });
    if (path === "/v2/sessions/current/meshing/region-memberships") return fulfillJson(route, { memberships: [], revision: 7 });
    if (path === "/v2/sessions/current/simulation/stages/execution") return fulfillJson(route, { stages: [], stage_statuses: [], total_stages: 0, revision: fixture.revision });
    if (path === "/v2/sessions/current/simulation/solver/status") return fulfillJson(route, { can_accept_commands: true, is_busy: false, runtime_state: "idle", revision: fixture.revision });
    if (path === "/v2/sessions/current/simulation/commands") return fulfillJson(route, { commands: [], latest_completed: null, revision: fixture.revision });
    if (path === "/v2/sessions/current/data/artifacts") return fulfillJson(route, []);
    if (path === "/v2/sessions/current/data/scalars") return fulfillJson(route, {
      columns: (url.searchParams.get("columns") ?? "").split(",").filter(Boolean),
      returned_rows: 0,
      revision: fixture.revision,
      rows: [],
      total_rows: 0,
    });
    if (path === "/v2/sessions/current/data/tables") return fulfillJson(route, { revision: fixture.revision, tables: [] });
    if (path === "/v2/sessions/current/persistence/checkpoints") return fulfillJson(route, { checkpoints: [], revision: fixture.revision });
    if (path === "/v2/sessions/current/simulation/runs/current") return fulfillJson(route, {
      artifact_dir: "/tmp/inspector-run",
      requested_backend: "fem",
      requested_device: "cpu",
      requested_mode: "frequency-domain",
      requested_precision: "double",
      revision: fixture.revision,
      run_id: "inspector-run",
      session_id: "inspector-session",
      started_at: "2026-08-11T12:00:00Z",
      status: "completed",
      total_steps: 1,
    });
    if (path === "/v2/sessions/current/simulation/objects/film/metrics") return fulfillJson(route, inspectorObjectMetrics());
    if (path === "/v2/sessions/current/analysis/frequency-domain/manifest.v1") return fulfillJson(route, inspectorFrequencyManifest(fixture));
    if (path === "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2") return fulfillJson(route, inspectorFrequencySpectrum(fixture));
    if (path === "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2") return fulfillJson(route, inspectorFrequencyBranches(fixture));
    if (path === "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion") return fulfillJson(route, inspectorFrequencyDispersion(fixture));
    if (path === "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2") return fulfillJson(route, inspectorFrequencyDiagnostics());
    if (path === "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep") return fulfillJson(route, inspectorFrequencyResponseSweep());
    if (
      path === "/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1" ||
      path === "/v2/sessions/current/analysis/frequency-domain/response/progress.v1"
    ) return fulfillEmpty(route, 204);
    if (path.includes("/analysis/frequency-domain/") && path.endsWith("/meta")) {
      return fulfillJson(route, inspectorFieldMeta(path));
    }
    if (path.includes("/data/fields/") && path.endsWith("/meta")) return fulfillJson(route, inspectorFieldMeta(path));
    if (path.includes("/data/fields/") && path.endsWith("/samples/vector")) return fulfillBinary(route, inspectorFieldVector(path));
    if (path === "/v2/sessions/current/data/domain/topology") return fulfillTopology(route, fixture.topology);
    fixture.unknownGetPaths.push(`${request.method()} ${path}${url.search}`);
    return fulfillJson(
      route,
      { error: { code: "inspector_fixture_unknown_resource", path } },
      404,
    );
  });
}

async function waitForInspectorRequestQuiet(page, fixture) {
  const deadline = Date.now() + INSPECTOR_REQUEST_TIMEOUT_MS;
  let previousCount = fixture.requests.length;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    if (fixture.requests.length !== previousCount) {
      previousCount = fixture.requests.length;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= INSPECTOR_REQUEST_QUIET_MS) return;
  }
  throw new Error(
    `Inspector requests did not settle before smoke completion: ${JSON.stringify(fixture.requests.slice(-20))}`,
  );
}

function mergeInspectorVisualizationState(state, patch) {
  return {
    ...state,
    ...patch,
    layers: { ...state.layers, ...(patch.layers ?? {}) },
    quantity: { ...state.quantity, ...(patch.quantity ?? {}) },
    revision: state.revision,
  };
}

function inspectorSessionStatus(fixture) {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      algorithms_available: ["llg_overdamped", "projected_gradient_bb"],
      binary_fields: true,
      cell_fields: true,
      eigen_modes: true,
      explicit_topology: true,
      gpu_telemetry: false,
      node_fields: true,
      preview_2d: true,
      preview_3d: true,
      scalar_history: true,
      structured_grid: false,
    },
    display: { active_quantity_id: "m", field_component: "magnitude", view_mode: "3d", vector_glyphs: true },
    domain: { cell_count: 3, discretization: "fem", generation_id: 1 },
    energies: {},
    metrics: { steps_per_second: null, total: { steps: 0, time_seconds: 0 }, total_steps: 0, uptime_seconds: 0 },
    resources: {
      artifact_revision: 0,
      artifacts_revision: 0,
      command_completion_revision: 0,
      commands_revision: fixture.revision,
      display_revision: fixture.visualization.revision,
      domain_generation_id: 1,
      engine_log_revision: 0,
      field_catalog_revision: 1,
      field_revision: 1,
      fields_revision: 1,
      mesh_build_revision: 7,
      mesh_revision: 7,
      scalars_revision: 0,
      scene_revision: fixture.revision,
      simulation_preparation_revision: 1,
      solver_profile_revision: 0,
      stages_revision: fixture.revision,
      topology_revision: 7,
      visualization_state_revision: fixture.visualization.revision,
      workspace_revision: 1,
    },
    run: null,
    runtime_bundle_version: "inspector-routing-smoke",
    session: { created_at: "2026-08-11T00:00:00.000Z", name: "Inspector routing smoke", session_id: "inspector-routing-smoke", workspace_root: "/tmp/fullmag-inspector-routing-smoke" },
    solver: { state: "idle" },
  };
}

function inspectorPreparationResource() {
  return {
    active_stage_id: null,
    completed_at_unix_ms: 1,
    failure: null,
    log_tail: [],
    preparation_id: "inspector-routing-preparation",
    requested_execution: null,
    resolved_execution: null,
    revision: 1,
    started_at_unix_ms: 0,
    stages: [],
    status: "ready",
  };
}

function inspectorObjectMetrics() {
  return {
    energies: {
      anisotropy: 0,
      demag: 0,
      dmi: 0,
      exchange: 0,
      total: 0,
      zeeman: 0,
    },
    has_solver_sample: false,
    magnetization_average: { mx: 1, my: 0, mz: 0 },
    object_id: "film",
    revision: 1,
    source: "fixture",
    step: 0,
    time_seconds: 0,
  };
}

function inspectorDomainMeta() {
  return {
    bounds: { max: [5e-7, 5e-7, 5e-7], min: [-5e-7, -5e-7, -5e-7] },
    counts: { cells: 3, nodes: 12 },
    discretization: "fem",
    domain_id: "inspector-routing-domain",
    generation_id: 1,
    units: "m",
  };
}

function inspectorFieldCatalog() {
  return {
    domain_generation_id: 1,
    quantities: ["m", "H_eff", "H_demag", "H_ext"].map((quantity_id) => ({
      available: true,
      components: 3,
      domain_generation_id: 1,
      field_revision: 1,
      kind: "vector",
      label: quantity_id,
      location: "nodes",
      quantity_id,
      state: "complete",
      unit: quantity_id === "m" ? "1" : "A/m",
    })),
    revision: 1,
  };
}

function inspectorFieldMeta(path) {
  const encoded = path.split("/data/fields/")[1]?.split("/")[0] ?? "m";
  const eigenMatch = /\/eigen\/mode-field\/(\d+)\/(\d+)\/meta$/.exec(path);
  const responseMatch = /\/response\/field\/(\d+)\/meta$/.exec(path);
  const fieldId = eigenMatch
    ? `analysis:eigen:sample-${eigenMatch[1].padStart(4, "0")}:mode-${eigenMatch[2].padStart(4, "0")}`
    : responseMatch
      ? `analysis:frequency-response:frequency-${responseMatch[1].padStart(4, "0")}`
      : decodeURIComponent(encoded);
  const resourceKey = `/v2/sessions/current/data/fields/${encodeURIComponent(fieldId)}/samples/vector?view=phase_rotated_real&phase_rad=0`;
  return {
    artifact_path: `${fieldId}.field.v2.bin`,
    available_views: ["complex", "real", "imag", "abs", "phase_rotated_real"],
    component_basis: "global_xyz",
    component_count: 3,
    components: ["x", "y", "z"],
    default_phase_rad: 0,
    default_view: "phase_rotated_real",
    field_id: fieldId,
    missing_reason: null,
    quantity: "delta_m",
    resource_key: resourceKey,
    schema_version: eigenMatch
      ? "frequency_domain_eigen_mode_field.v1"
      : "frequency_domain_response_field.v1",
    source_family: eigenMatch
      ? "analysis/eigen"
      : "analysis/frequency-response",
    stats: { max: 1, min: 0 },
    status: "ready",
    unit: "1",
    value_kind: "complex_vector",
  };
}

function inspectorFieldVector(path) {
  const encoded = path.split("/data/fields/")[1]?.split("/")[0] ?? "m";
  const quantityId = decodeURIComponent(encoded);
  const grid = [8, 4, 1];
  const valueCount = grid[0] * grid[1] * grid[2] * 3;
  const buffer = new ArrayBuffer(48 + valueCount * Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) view.setUint8(index, code.charCodeAt(0));
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, 3);
  view.setUint32(12, valueCount, true);
  view.setUint32(16, grid[0], true);
  view.setUint32(20, grid[1], true);
  view.setUint32(24, grid[2], true);
  new TextEncoder().encodeInto(quantityId, new Uint8Array(buffer, 28, 16));
  const values = new Float64Array(buffer, 48);
  for (let index = 0; index < valueCount; index += 3) {
    values[index] = 1;
    values[index + 1] = 0.2;
    values[index + 2] = 0.1;
  }
  return buffer;
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({
    body: JSON.stringify(body),
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*", "x-api-contract-version": "1.0.0" },
    status,
  });
}

async function fulfillBinary(route, body, status = 200) {
  await route.fulfill({
    body: Buffer.from(body),
    contentType: "application/octet-stream",
    headers: { "access-control-allow-origin": "*", "x-api-contract-version": "1.0.0" },
    status,
  });
}

async function fulfillEmpty(route, status) {
  await route.fulfill({ body: "", headers: { "access-control-allow-origin": "*" }, status });
}

async function fulfillTopology(route, topology) {
  const range = route.request().headers().range;
  if (!range) return fulfillBinary(route, topology);
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!match) return fulfillEmpty(route, 416);
  const start = Number(match[1]);
  const end = Math.min(Number(match[2]), topology.byteLength - 1);
  return route.fulfill({
    body: Buffer.from(topology.slice(start, end + 1)),
    contentType: "application/octet-stream",
    headers: {
      "access-control-allow-origin": "*",
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${topology.byteLength}`,
      "x-api-contract-version": "1.0.0",
    },
    status: 206,
  });
}

function inspectorTopologyBuffer() {
  const nodeCount = 12;
  const elementCount = 3;
  const boundaryFaceCount = 12;
  const buffer = new ArrayBuffer(
    32 + nodeCount * 3 * 8 + elementCount * 4 * 4 + boundaryFaceCount * 3 * 4 + elementCount * 4 * 2,
  );
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMMT"].entries()) view.setUint8(index, code.charCodeAt(0));
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, elementCount, true);
  view.setUint32(16, boundaryFaceCount, true);
  view.setUint32(20, elementCount, true);
  view.setUint32(24, elementCount, true);
  let offset = 32;
  new Float64Array(buffer, offset, nodeCount * 3).set([
    0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1,
    -1, -1, -1, 2, -1, -1, -1, 2, -1, -1, -1, 2,
    0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 2,
  ]);
  offset += nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, elementCount * 4).set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  offset += elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, boundaryFaceCount * 3).set([
    0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3,
    4, 5, 6, 4, 5, 7, 4, 6, 7, 5, 6, 7,
    8, 9, 10, 8, 9, 11, 8, 10, 11,
  ]);
  offset += boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, elementCount).set([1, 0, 2]);
  offset += elementCount * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, elementCount).set([1, 0, 2]);
  return buffer;
}

function inspectorFrequencyCapability(status) {
  return { reason: "", status };
}

function inspectorFrequencyManifest(fixture = { analysisProduct: "driven_response" }) {
  const modal = fixture.analysisProduct === "modal_eigen";
  const resultPayload = modal
    ? {
        equilibrium_identity: "equilibrium-1",
        observables: [],
        requested_execution: {
          boundary_context: "floquet_periodic",
          calculation_mode: "eigenmodes",
          k_sampling: { kind: "path" },
        },
        revision: "result-modal-7",
        stage_id: "eigen-dispersion",
        stage_label: "Dispersion Eigenmodes",
        study_product: "modal_eigen",
      }
    : {
        equilibrium_identity: "equilibrium-1",
        observables: [{ identity: "absorbed-power", kind: "absorbed_power", unit: "W" }],
        requested_execution: { boundary_context: "finite_open", calculation_mode: "fmr_response" },
        revision: "result-7",
        stage_id: "frequency-response",
        stage_label: "Frequency Response",
        study_product: "driven_response",
      };
  return {
    capabilities: {
      modal: {
        mode_field_payload: inspectorFrequencyCapability("reference_executable"),
        mode_tracking: inspectorFrequencyCapability("reference_executable"),
      },
      response: { frequency_sweep: inspectorFrequencyCapability("reference_executable") },
      visualization: {
        mode_3d_overlay: inspectorFrequencyCapability("reference_executable"),
        modal_spectrum_chart: inspectorFrequencyCapability("reference_executable"),
        mode_table: inspectorFrequencyCapability("reference_executable"),
      },
    },
    eigenmodes: { modal_solver_available: true, reason: "", status: "ok", study_kind: "eigenmodes" },
    response: { driven_response_available: true, reason: "", status: "ok", study_kind: "frequency_response" },
    result_manifest: {
      artifact_path: "result-manifest.json",
      missing_reason: null,
      payload: resultPayload,
      resource_key: "/v2/sessions/current/analysis/frequency-domain/manifest.v1",
      schema_version: "frequency_domain_result_manifest.v1",
      status: "ready",
    },
    requested_execution: resultPayload.requested_execution,
    response_cancel_requested: null,
    response_progress: null,
    resources: { response_field_resources: [] },
    artifacts: {
      branches_v2_path: "eigen/branches.v2.json",
      dispersion_csv_path: "eigen/dispersion.csv",
      eigen_diagnostics_v2_path: "eigen/diagnostics.v2.json",
      response_sweep_v2_path: "response/magnetic_response_sweep.v2.json",
      spectrum_v2_path: "eigen/spectrum.v2.json",
    },
    schema_version: "frequency_domain_manifest.v1",
  };
}

function inspectorFrequencySpectrum() {
  return {
    artifact_path: "eigen/spectrum.v2.json",
    missing_reason: null,
    payload: {
      modes: [{
        branch_id: "branch-0",
        damping_rate_hz: 12e6,
        frequency_hz: 12.5e9,
        mode_field_id: "analysis:eigen:sample-0000:mode-0002",
        mode_field_resource_key: "/v2/sessions/current/data/fields/analysis%3Aeigen%3Asample-0000%3Amode-0002/samples/vector?view=phase_rotated_real&phase_rad=0",
        raw_mode_index: 2,
        residual_norm: 1e-8,
        sample_index: 0,
        tangent_leakage_max: 2e-9,
      }],
      schema_version: "eigen_spectrum.v2",
    },
    resource_key: "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
    schema_version: "frequency_domain_eigen_spectrum.v2",
    status: "ready",
  };
}

function inspectorFrequencyBranches() {
  return {
    artifact_path: "eigen/branches.v2.json",
    missing_reason: null,
    payload: {
      branches: [{
        branch_id: "branch-0",
        label: "Acoustic branch",
        points: [{
          frequency_imag_hz: -12e6,
          frequency_real_hz: 12.5e9,
          mode_field_id: "analysis:eigen:sample-0000:mode-0002",
          mode_field_resource_key: "/v2/sessions/current/data/fields/analysis%3Aeigen%3Asample-0000%3Amode-0002/samples/vector?view=phase_rotated_real&phase_rad=0",
          overlap_prev: 0.99,
          raw_mode_index: 2,
          residual_norm: 1e-8,
          sample_index: 0,
          tracking_confidence: 0.995,
        }],
      }],
      schema_version: "eigen_branches.v2",
      solver_model: "linearized_llg_reference",
    },
    resource_key: "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2",
    schema_version: "frequency_domain_eigen_branches.v2",
    status: "ready",
  };
}

function inspectorFrequencyDispersion(fixture = { analysisProduct: "driven_response" }) {
  const modal = fixture.analysisProduct === "modal_eigen";
  return {
    artifact_path: "eigen/dispersion.csv",
    content_type: "text/csv",
    missing_reason: null,
    path_metadata: modal
      ? {
          sampling: {
            kind: "path",
            points: [
              { k_vector: [0, 0, 0], label: "Γ" },
              { k_vector: [1e7, 0, 0], label: "X" },
            ],
            samples_per_segment: [1],
          },
        }
      : undefined,
    resource_key: "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
    schema_version: "frequency_domain_eigen_dispersion.csv",
    status: "ready",
    text: modal
      ? "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz,mode_field_id,mode_field_resource_key\n0,2,branch-0,0,12.5e9,analysis:eigen:sample-0000:mode-0002,/v2/sessions/current/data/fields/analysis%3Aeigen%3Asample-0000%3Amode-0002/samples/vector?view=phase_rotated_real&phase_rad=0\n1,2,branch-0,1e7,13e9,analysis:eigen:sample-0001:mode-0002,/v2/sessions/current/data/fields/analysis%3Aeigen%3Asample-0001%3Amode-0002/samples/vector?view=phase_rotated_real&phase_rad=0"
      : "sample_index,raw_mode_index,branch_id,path_s_rad_per_m,frequency_hz\n0,2,branch-0,0,12.5e9",
  };
}

function inspectorFrequencyDiagnostics() {
  return {
    artifact_path: "eigen/diagnostics.v2.json",
    missing_reason: null,
    payload: { schema_version: "eigen_diagnostics.v2" },
    resource_key: "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2",
    schema_version: "frequency_domain_eigen_diagnostics.v2",
    status: "ready",
  };
}

function inspectorFrequencyResponseSweep() {
  return {
    artifact_path: "response/magnetic_response_sweep.v2.json",
    missing_reason: null,
    payload: {
      points: [{
        absorbed_power_density: 4.5,
        amplitude: 0.75,
        field_id: "response-field-7",
        frequency_hz: 12.5e9,
        frequency_index: 7,
        observable_id: "mx",
        phase_rad: 1.25,
        residual_norm: 1e-5,
        susceptibility_tensor: [[1, 2], [3, 4]],
      }],
      schema_version: "magnetic_response_sweep.v2",
    },
    resource_key: "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep",
    schema_version: "frequency_domain_response_sweep.v2",
    status: "ready",
  };
}
