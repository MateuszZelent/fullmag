import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const outputDir = resolve(
  process.cwd(),
  process.env.CONTROL_ROOM_INSPECTOR_REPORT_DIR ?? ".fullmag/reports/inspector-2-browser",
);

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

try {
  await page.goto(workspaceUrl, { waitUntil: "networkidle", timeout: 60_000 });
  const inspector = page.locator(".fm-inspector");
  await inspector.waitFor({ state: "visible" });

  const visualizationNode = page
    .locator('[role="treeitem"]')
    .filter({ hasText: /^Visualizationdisplay/ })
    .first();
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
    (await inspector.locator(".fm-inspector-section .fm-inspector-section").count()) === 0,
    "Visualization Inspector contains nested compatibility cards.",
  );
  assert(
    (await inspector.locator("img, canvas").count()) === 0,
    "Inspector rendered preview media.",
  );

  const geometry = await overview.evaluate((element) => {
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
    const overviewRect = element.getBoundingClientRect();
    const segmentedRect = segmented?.getBoundingClientRect();
    return {
      groupShadows: groups.map((group) => getComputedStyle(group).boxShadow),
      groupSpacing: Number.parseFloat(getComputedStyle(element).rowGap),
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

  const panel = page.getByTestId("panel-right");
  const resizeHandle = page.getByRole("separator", { name: /Inspector/ }).last();
  const visibleToggle = overview.getByRole("button", { name: "Visible", exact: true });
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
  const screenshotFiles = [];
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
    const quantity = element.querySelector('select[aria-label="Quantity source"]');
    return {
      overview: element.getBoundingClientRect().toJSON(),
      quantity: quantity?.getBoundingClientRect().toJSON() ?? null,
      segmented: segmented?.getBoundingClientRect().toJSON() ?? null,
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

  const vectorsToggle = overview
    .locator(".fm-visualization-toggle")
    .filter({ hasText: /^Vectors$/ });
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
    '[data-slot="segmented-control"][aria-label="Display mode"]',
  );
  const initialRenderMode = await renderModeControl
    .locator('[data-slot="segmented-control-item"][data-state="checked"]')
    .getAttribute("data-value");
  assert(
    (await overview.getByRole("button", { name: /^(Surface|Wireframe|Points)$/ }).count()) === 0,
    "Drawable passes must not have duplicate toggle buttons beside Display mode.",
  );
  const vectorsBeforeOff = await vectorsToggle.getAttribute("aria-pressed");
  await renderModeControl
    .locator('[data-slot="segmented-control-item"][data-value="off"]')
    .click();
  await page.waitForTimeout(500);
  assert(
    (await renderModeControl
      .locator('[data-slot="segmented-control-item"][data-state="checked"]')
      .getAttribute("data-value")) === "off",
    "Display mode did not remain Off after the resource update settled.",
  );
  assert(
    (await vectorsToggle.getAttribute("aria-pressed")) === vectorsBeforeOff,
    "Display mode Off changed the independent Vectors overlay.",
  );
  if (initialRenderMode && initialRenderMode !== "off") {
    await renderModeControl
      .locator(`[data-slot="segmented-control-item"][data-value="${initialRenderMode}"]`)
      .click();
    await page.waitForTimeout(200);
  }
  if ((await visibleToggle.getAttribute("aria-pressed")) === "true") {
    await visibleToggle.click();
  }
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
  await resetButton.click();
  await page.waitForTimeout(150);
  assert(await resetButton.isDisabled(), "Visualization Reset did not restore the applied baseline.");
  assert(
    (await renderModeControl
      .locator('[data-slot="segmented-control-item"][data-state="checked"]')
      .getAttribute("data-value")) === initialRenderMode,
    "Visualization Reset changed the initial render mode.",
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
    .locator('[data-slot="segmented-control-item"][data-state="checked"]')
    .first();
  const initialFocusedMode = await segmentedItem.getAttribute("data-value");
  await segmentedItem.focus();
  await segmentedItem.press("ArrowRight");
  await page.waitForTimeout(200);
  assert(
    (await page.evaluate(() =>
      document.activeElement?.getAttribute("data-value"),
    )) !== initialFocusedMode,
    "Render Mode focus did not respond to keyboard navigation.",
  );
  await resetButton.click();

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

  await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
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
        widths: [360, 416, 560],
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
