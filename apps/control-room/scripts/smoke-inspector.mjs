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

  const expectedTabs = ["Overview", "Properties", "Display", "Diagnostics"];
  const tabLabels = await inspector.locator('[role="tab"]').allTextContents();
  assert(
    JSON.stringify(tabLabels) === JSON.stringify(expectedTabs),
    `Unexpected Visualization tabs: ${JSON.stringify(tabLabels)}`,
  );

  const panel = page.getByTestId("panel-right");
  const resizeHandle = page.getByRole("separator", { name: "Resize Inspector" });
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
    await page.screenshot({ path: resolve(outputDir, `inspector-${width}.png`) });
  }

  await resizeHandle.dblclick();
  await page.waitForTimeout(150);
  const resetWidth = await panel.boundingBox();
  assert(resetWidth && Math.abs(resetWidth.width - 416) <= 3, "Double-click did not restore 416px.");

  const headerTop = await inspector.locator(".fm-inspector__header").boundingBox();
  const tabsTop = await inspector.locator(".fm-inspector__tabs").boundingBox();
  const actionsTop = await inspector.locator(".fm-inspector__action-bar").boundingBox();
  for (const tabName of expectedTabs) {
    const tab = inspector.getByRole("tab", { name: tabName, exact: true });
    await tab.click();
    await page.waitForTimeout(250);
    assert((await tab.getAttribute("aria-selected")) === "true", `${tabName} did not become active.`);
    assert(
      (await inspector.locator('[role="tabpanel"]:visible').count()) === 1,
      `${tabName} must expose exactly one mounted visible tab panel.`,
    );
    await page.screenshot({
      path: resolve(outputDir, `visualization-${tabName.toLowerCase()}-416.png`),
    });
  }

  const content = inspector.locator(".fm-inspector__content");
  await content.hover();
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(100);
  const stableHeader = await inspector.locator(".fm-inspector__header").boundingBox();
  const stableTabs = await inspector.locator(".fm-inspector__tabs").boundingBox();
  const stableActions = await inspector.locator(".fm-inspector__action-bar").boundingBox();
  assert(stableHeader?.y === headerTop?.y, "Inspector header moved with content scroll.");
  assert(stableTabs?.y === tabsTop?.y, "Inspector tabs moved with content scroll.");
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
        screenshots: 7,
        tabs: expectedTabs,
        widths: [360, 416, 560],
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
