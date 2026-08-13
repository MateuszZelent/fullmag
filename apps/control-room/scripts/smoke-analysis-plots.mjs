import { mkdirSync } from "node:fs";
import path from "node:path";

const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8081"
).replace(/\/$/, "");
const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const timeoutMs = numericEnv("CONTROL_ROOM_ANALYSIS_PLOTS_TIMEOUT_MS", 90_000);
const observeMs = numericEnv("CONTROL_ROOM_ANALYSIS_PLOTS_OBSERVE_MS", 8_000);
const maxRowsBinRequests = nonNegativeNumericEnv(
  "CONTROL_ROOM_ANALYSIS_PLOTS_MAX_ROWS_BIN_REQUESTS",
  0,
);
const useFixture = process.env.CONTROL_ROOM_ANALYSIS_PLOTS_FIXTURE === "1";
const liveRefreshObserveMs = numericEnv(
  "ANALYSIS_LIVE_REFRESH_OBSERVE_MS",
  3_000,
);
const acceptanceDirectory =
  process.env.CONTROL_ROOM_ACCEPTANCE_DIR ??
  path.resolve(".fullmag/reports/live-charts-analysis-acceptance/latest");

const ANALYSIS_SURFACES = [
  "Dynamics", "Resonance & FMR", "Dispersion", "Hysteresis", "Comparison",
];
const ROWS_BIN_PATTERN =
  /^\/v2\/sessions\/current\/data\/tables\/[^/]+\/rows\.bin(?:\?|$)/;

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error(
      "Analysis plots smoke requires Playwright or @playwright/test.",
    );
  }

  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
  const errors = [];
  const failedResponses = [];
  const rowsBinRequests = [];
  const analysisPlotRequests = [];

  await page.addInitScript(({ allowMissingSessionSmoke, baseUrl }) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      ...(allowMissingSessionSmoke ? { allowMissingSessionSmoke: true } : {}),
      ...(allowMissingSessionSmoke ? { disableRealtime: true } : {}),
      controlRoomApiBase: baseUrl,
    };
    window.__FULLMAG_ENABLE_CHART_DIAGNOSTICS__ = true;
    window.__FULLMAG_CHART_DIAGNOSTICS__ = {
      activeInstances: 0,
      createdInstances: 0,
      disposedInstances: 0,
      modelBuilds: 0,
      plannedPoints: 0,
      renderedPoints: 0,
      resizeCalls: 0,
      setOptionCalls: 0,
    };
  }, { allowMissingSessionSmoke: useFixture, baseUrl: apiBase });

  if (useFixture) await installAnalysisDatasetFixtureRoutes(page);

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.startsWith("Failed to load resource:")) return;
    errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() < 400) return;
    failedResponses.push({
      path: currentSessionPath(response.url()),
      status: response.status(),
      url: response.url(),
    });
  });
  page.on("request", (request) => {
    const path = currentSessionPath(request.url());
    if (
      path &&
      (path.startsWith("/v2/sessions/current/data/tables") ||
        path.startsWith("/v2/sessions/current/analysis/"))
    ) {
      analysisPlotRequests.push({ path, timestamp: Date.now() });
    }
    if (path && ROWS_BIN_PATTERN.test(path)) {
      rowsBinRequests.push({ path, timestamp: Date.now() });
    }
  });

  try {
    await page.goto(workspaceUrl, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    await page.locator("main").waitFor({ state: "visible", timeout: timeoutMs });
    await openAnalysisPlots(page);
    await verifyAnalysisSurfaceContract(page);
    const selectedDatasetRef = await selectPublishedDataset(page);
    await waitForAnalysisRowsAndCanvas(page);
    await verifyPinnedDatasetProvenance(page, selectedDatasetRef);
    await verifySeriesLegend(page);
    await verifyPointSelection(page);
    await verifyAnalysisInspectorSummary(page, selectedDatasetRef);
    await verifyLocalSeriesSelection(page, rowsBinRequests);
    await verifyLocalRangeSelection(page, rowsBinRequests);
    await verifyReducedMotionAndKeyboardControls(page);
    await verifyResponsiveAnalysisFixtures(page);
    const explicitDatasetRequestBaseline = analysisPlotRequests.length;
    await verifyNoImplicitLiveRefresh(
      page,
      analysisPlotRequests,
      explicitDatasetRequestBaseline,
    );
    await assertNoVisibleResourceErrors(page, errors);
    const screenshots = await captureAnalysisAcceptanceScreenshots(page, errors);

    rowsBinRequests.length = 0;
    await page.waitForTimeout(observeMs);
    const proof = await collectAnalysisPlotProof(page);
    const failures = validateProof(proof, selectedDatasetRef);
    if (rowsBinRequests.length > maxRowsBinRequests) {
      failures.push(
        `rows.bin request budget exceeded: ${rowsBinRequests.length}/${maxRowsBinRequests} in ${observeMs} ms`,
      );
    }
    const failedRowsBinResponses = failedResponses.filter(
      (response) => response.path && ROWS_BIN_PATTERN.test(response.path),
    );
    if (failedRowsBinResponses.length > 0) {
      failures.push(
        `rows.bin responses failed: ${JSON.stringify(failedRowsBinResponses)}`,
      );
    }
    if (errors.length > 0) {
      failures.push("Browser console errors:\n" + errors.join("\n"));
    }
    if (failures.length > 0) {
      throw new Error("Analysis plots smoke failed:\n" + failures.join("\n"));
    }

    console.log(
      `Analysis plots proof: ${JSON.stringify({
        ...proof,
        apiBase,
        failedResponses: failedResponses.length,
        rowsBinRequests: rowsBinRequests.length,
        rowsBinRequestBudget: maxRowsBinRequests,
        resourceFamilyCounts: countResourceFamilies(analysisPlotRequests),
        screenshots,
        workspaceUrl,
      })}`,
    );
    console.log(`Analysis plots smoke passed at ${workspaceUrl}.`);
  } finally {
    await browser.close();
  }
}

async function verifyNoImplicitLiveRefresh(
  page,
  analysisPlotRequests,
  explicitDatasetRequestBaseline,
) {
  await page.waitForTimeout(liveRefreshObserveMs);
  const implicitRequests = analysisPlotRequests.slice(explicitDatasetRequestBaseline);
  if (implicitRequests.length > 0) {
    throw new Error(
      `Analysis implicitly refreshed an explicitly selected dataset: ${JSON.stringify(implicitRequests)}`,
    );
  }
  const provenance = await page
    .locator(".fm-analysis-plots__header")
    .getByText(/^Dataset provenance:/)
    .innerText();
  if (!/Dataset provenance: .+revision\s+\d+/.test(provenance)) {
    throw new Error(`Analysis did not retain frozen dataset provenance: ${provenance}`);
  }
}

async function assertNoVisibleResourceErrors(page, errors) {
  if (errors.length > 0) {
    throw new Error(`Browser page errors before screenshot capture: ${errors.join(" | ")}`);
  }
  const errorNotifications = page.locator(
    '.fm-notifications__toast[data-kind="error"], .fm-toast[data-variant="error"]',
  );
  const visibleErrors = [];
  for (let index = 0; index < await errorNotifications.count(); index += 1) {
    const notification = errorNotifications.nth(index);
    if (await notification.isVisible()) visibleErrors.push(await notification.innerText());
  }
  if (visibleErrors.length > 0) {
    throw new Error(
      `Visible resource error notification before screenshot capture: ${visibleErrors.join(" | ")}`,
    );
  }
}

async function captureAnalysisAcceptanceScreenshots(page, errors) {
  mkdirSync(acceptanceDirectory, { recursive: true });
  const screenshots = [];
  for (const [theme, filename] of [
    ["dark", "analysis-mocha.png"],
    ["light", "analysis-latte.png"],
  ]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.waitForTimeout(100);
    await assertNoVisibleResourceErrors(page, errors);
    const target = path.join(acceptanceDirectory, filename);
    await page.screenshot({ path: target });
    screenshots.push(target);
  }
  await page.evaluate(() => {
    document.body.style.zoom = "200%";
  });
  await assertNoVisibleResourceErrors(page, errors);
  const zoomTarget = path.join(acceptanceDirectory, "analysis-zoom-200.png");
  await page.screenshot({ fullPage: true, path: zoomTarget });
  screenshots.push(zoomTarget);
  await page.evaluate(() => {
    document.body.style.zoom = "";
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await assertNoVisibleResourceErrors(page, errors);
  const reducedTarget = path.join(
    acceptanceDirectory,
    "analysis-reduced-motion.png",
  );
  await page.screenshot({ path: reducedTarget });
  screenshots.push(reducedTarget);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  return screenshots;
}

async function verifyResponsiveAnalysisFixtures(page) {
  const widths = [360, 640, 900, 1280];
  for (const width of widths) {
    await page.setViewportSize({ height: 1000, width });
    await page.waitForTimeout(150);
    const fixture = await page.evaluate(() => {
      const root = document.querySelector(".fm-analysis-plots");
      const required = [
        ["chart title", root?.querySelector(".fm-chart-section__title")],
        ["dataset selector", root?.querySelector('[aria-label="Analysis dataset"]')],
        ["legend item", root?.querySelector(".fm-chart-legend__item")],
        ["chart surface", root?.querySelector('.fm-analysis-chart-surface[role="img"]')],
        ["chart canvas", root?.querySelector(".fm-analysis-chart-surface canvas")],
        ["range cursor", root?.querySelector(".fm-analysis-plots__range-cursor")],
        ["chart footer", root?.querySelector(".fm-chart-section__footer")],
        ["export button", root?.querySelector(".fm-analysis-chart-export button")],
      ];
      const rootRect = root?.getBoundingClientRect();
      const fits = ([, node]) => {
        if (!(node instanceof HTMLElement) || !rootRect) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left >= rootRect.left && rect.right <= rootRect.right + 1;
      };
      const visible = required.every(fits);
      const controls = root?.querySelector(".fm-analysis-chart-export");
      const chartOwner = root?.querySelector('.fm-analysis-chart-surface[role="img"]');
      return {
        axisDescription: chartOwner?.getAttribute("aria-label") ?? "",
        clipped: required.filter(([name, node]) => !fits([name, node])).map(([name, node]) => ({
          name,
          rect: node instanceof HTMLElement ? node.getBoundingClientRect().toJSON() : null,
        })),
        controlsDirection: controls ? getComputedStyle(controls).flexDirection : null,
        documentFitsViewport: document.documentElement.scrollWidth <= window.innerWidth + 1,
        rootFitsViewport: Boolean(
          rootRect && rootRect.left >= -1 && rootRect.right <= window.innerWidth + 1,
        ),
        visible,
      };
    });
    if (!fixture.visible || !fixture.rootFitsViewport || !fixture.documentFitsViewport) {
      throw new Error(`Analysis responsive fixture clips a required scientific control at ${width}px.`);
    }
    if (!/X axis .+\[.+\]\. Y axes .+\[.+\]\./.test(fixture.axisDescription)) {
      throw new Error(`Analysis chart does not expose axis labels and units at ${width}px: ${fixture.axisDescription}`);
    }
    if (width === 360 && fixture.controlsDirection !== "column") {
      throw new Error(`Analysis controls did not stack at 360px: ${fixture.controlsDirection}.`);
    }
  }
  await page.setViewportSize({ height: 1000, width: 1440 });
}

async function verifyReducedMotionAndKeyboardControls(page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const legendItem = page.locator(".fm-chart-legend__item").first();
  const initialPressed = await legendItem.getAttribute("aria-pressed");
  await legendItem.focus();
  await legendItem.press("Space");
  await page.waitForFunction(
    (previous) => document.querySelector(".fm-chart-legend__item")?.getAttribute("aria-pressed") !== previous,
    initialPressed,
    { timeout: timeoutMs },
  );
  await legendItem.press("Enter");
  await page.waitForFunction(
    (expected) => document.querySelector(".fm-chart-legend__item")?.getAttribute("aria-pressed") === expected,
    initialPressed,
    { timeout: timeoutMs },
  );

  const dataTable = page.getByRole("button", { name: "Data Table" });
  await dataTable.focus();
  await dataTable.press("Enter");
  const dialog = page.locator(".fm-points-table-dialog");
  await dialog.waitFor({ state: "visible", timeout: timeoutMs });
  const cursor = page.locator(".fm-analysis-plots__range-cursor").first();
  const cursorBefore = await cursor.innerText();
  const pointActions = dialog.getByRole("button", { name: /^Select .+ row \d+$/ });
  await pointActions.first().waitFor({ state: "visible", timeout: timeoutMs });
  const pointAction = pointActions.nth(Math.min(1, (await pointActions.count()) - 1));
  await pointAction.focus();
  await pointAction.press("Enter");
  await page.waitForFunction(
    (previous) => document.querySelector(".fm-analysis-plots__range-cursor")?.textContent?.trim() !== previous,
    cursorBefore.trim(),
    { timeout: timeoutMs },
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: timeoutMs });
  await page.emulateMedia({ reducedMotion: "no-preference" });
}

function countResourceFamilies(requests) {
  return requests.reduce((counts, request) => {
    const family = request.path.includes("/data/tables") ? "data.tables" : "analysis";
    counts[family] = (counts[family] ?? 0) + 1;
    return counts;
  }, {});
}

async function openAnalysisPlots(page) {
  const analysisTab = page
    .locator(".fm-viewport-tabs__trigger")
    .filter({ hasText: /^Analysis$/ });
  await analysisTab
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .catch(async () => {
      const body = await page.locator("body").innerText({ timeout: 5_000 });
      throw new Error(
        `Analysis viewport tab was not found. Body snippet:\n${body.slice(0, 1_500)}`,
      );
    });
  await analysisTab.first().click({ timeout: timeoutMs });
  await page
    .locator("[data-slot-id='viewport-main'][data-active-module-id='analysis-plots']")
    .waitFor({ state: "attached", timeout: timeoutMs });
  await page
    .locator(".fm-analysis-plots")
    .waitFor({ state: "visible", timeout: timeoutMs });
}

async function verifyAnalysisSurfaceContract(page) {
  const tabs = page.locator(".fm-analysis-plots__tabs .fm-analysis-plots__tab");
  await tabs.first().waitFor({ state: "visible", timeout: timeoutMs });
  const labels = (await tabs.allTextContents()).map((label) => label.trim());
  if (JSON.stringify(labels) !== JSON.stringify(ANALYSIS_SURFACES)) {
    throw new Error(
      `Analysis workbench surfaces differ from the dataset-driven contract: ${JSON.stringify(labels)}`,
    );
  }
}

async function selectPublishedDataset(page) {
  const trigger = page.getByRole("combobox", { name: "Analysis dataset" });
  await trigger.waitFor({ state: "visible", timeout: timeoutMs });
  await trigger.click({ timeout: timeoutMs });
  const option = page.getByRole("option").first();
  await option.waitFor({ state: "visible", timeout: timeoutMs }).catch(async () => {
    const body = await page.locator(".fm-analysis-plots").innerText();
    throw new Error(
      `No published Analysis dataset is available. Analysis snippet:\n${body.slice(0, 1_000)}`,
    );
  });
  const datasetRef = (await option.innerText()).trim();
  if (!datasetRef) throw new Error("Published Analysis dataset has an empty identity.");
  await option.click({ timeout: timeoutMs });
  await page.waitForFunction(
    (expected) => {
      const selector = document.querySelector('[aria-label="Analysis dataset"]');
      return selector?.textContent?.trim().includes(expected);
    },
    datasetRef,
    { timeout: timeoutMs },
  );
  return datasetRef;
}

async function waitForAnalysisRowsAndCanvas(page) {
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".fm-analysis-plots");
      const pointSummary =
        root?.querySelector(".fm-chart-section__point-count")?.textContent ?? "";
      const canvas = root?.querySelector(".fm-analysis-chart-surface canvas");
      return (
        /[1-9]\d*(?:\s*\/\s*[1-9]\d*)?\s+rows/.test(pointSummary) &&
        canvas instanceof HTMLCanvasElement &&
        canvas.width > 0 &&
        canvas.height > 0
      );
    },
    { timeout: timeoutMs },
  );
}

async function verifyPinnedDatasetProvenance(page, datasetRef) {
  await page.waitForFunction(
    ({ expectedDatasetRef }) => {
      const text =
        document.querySelector(".fm-analysis-plots__header span")?.textContent ?? "";
      return (
        text.includes(`Dataset provenance: ${expectedDatasetRef}`) &&
        /\brevision\s+\d+\b/.test(text)
      );
    },
    { expectedDatasetRef: datasetRef },
    { timeout: timeoutMs },
  ).catch(async () => {
    const header = await page.locator(".fm-analysis-plots__header").innerText();
    throw new Error(
      `Analysis dataset provenance lacks the selected identity or frozen revision: ${header}`,
    );
  });
}

async function verifySeriesLegend(page) {
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".fm-analysis-plots");
      const items = Array.from(
        root?.querySelectorAll(".fm-chart-legend__item") ?? [],
      );
      return items.length > 0 && items.every((item) => {
        const label = item.querySelector(".fm-chart-legend__label");
        const latest = item.querySelector(".fm-chart-legend__latest");
        const swatch = item.querySelector(".fm-chart-legend__swatch");
        const ariaLabel = item.getAttribute("aria-label") ?? "";
        return (
          label?.textContent?.trim() &&
          latest?.textContent?.trim() &&
          swatch instanceof HTMLElement &&
          /, unit (?:dimensionless|.+), latest .+\./.test(ariaLabel) &&
          (item.getAttribute("aria-pressed") === "true" ||
            item.getAttribute("aria-pressed") === "false")
        );
      });
    },
    { timeout: timeoutMs },
  ).catch(async () => {
    const body = await page.locator(".fm-analysis-plots").innerText();
    const items = await page.locator(".fm-chart-legend__item").evaluateAll((nodes) =>
      nodes.map((node) => ({
        ariaLabel: node.getAttribute("aria-label"),
        ariaPressed: node.getAttribute("aria-pressed"),
        html: node.innerHTML,
      })),
    );
    throw new Error(
      `analysis series legend is missing or incomplete. Items: ${JSON.stringify(items)}. Analysis snippet:\n${body.slice(0, 1_000)}`,
    );
  });
}

async function verifyPointSelection(page) {
  const dispatched = await page.evaluate(() => {
    const dispatch = window.__FULLMAG_CHART_DIAGNOSTICS__?.dispatchPointClick;
    if (typeof dispatch !== "function") return false;
    dispatch(0, 0);
    return true;
  });
  if (!dispatched) {
    throw new Error("ECharts diagnostic point-click dispatcher was not installed.");
  }
  await page.waitForFunction(
    () => {
      const cursor = document.querySelector(".fm-analysis-plots__range-cursor");
      return Boolean(cursor && !/cursor\s+—/i.test(cursor.textContent ?? ""));
    },
    { timeout: timeoutMs },
  ).catch(async () => {
    const body = await page.locator(".fm-analysis-plots").innerText();
    throw new Error(
      `chart point selection did not update cursor status. Analysis snippet:\n${body.slice(0, 1_000)}`,
    );
  });
}

async function verifyAnalysisInspectorSummary(page, datasetRef) {
  const inspector = page.locator(".fm-inspector-panel");
  await inspector.getByText("Analysis chart", { exact: true }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  const text = await inspector.innerText();
  for (const required of ["Surface", "Dataset", datasetRef, "X axis", "Range", "Series"]) {
    if (!text.includes(required)) {
      throw new Error(`Analysis Inspector is missing ${required}: ${text}`);
    }
  }
  for (const forbidden of ["Chart controls", "Following", "Resume live chart updates"]) {
    if (text.includes(forbidden)) {
      throw new Error(`Analysis Inspector still exposes Live Chart control ${forbidden}.`);
    }
  }
}

async function verifyLocalSeriesSelection(page, rowsBinRequests) {
  rowsBinRequests.length = 0;
  const item = page.locator(".fm-chart-legend__item").first();
  const before = await item.getAttribute("aria-pressed");
  if (before !== "true" && before !== "false") {
    throw new Error(`Analysis legend item lacks selection state: ${before}`);
  }
  await item.click({ timeout: timeoutMs });
  await page.waitForFunction(
    ({ previous }) =>
      document.querySelector(".fm-chart-legend__item")?.getAttribute("aria-pressed") !== previous,
    { previous: before },
    { timeout: timeoutMs },
  );
  await page.waitForTimeout(250);
  if (rowsBinRequests.length > 0) {
    throw new Error(
      `rows.bin requests after local series selection: ${rowsBinRequests.length}`,
    );
  }
  await item.click({ timeout: timeoutMs });
  await page.waitForFunction(
    ({ expected }) =>
      document.querySelector(".fm-chart-legend__item")?.getAttribute("aria-pressed") === expected,
    { expected: before },
    { timeout: timeoutMs },
  );
}

async function verifyLocalRangeSelection(page, rowsBinRequests) {
  rowsBinRequests.length = 0;
  const dispatched = await page.evaluate(() => {
    const dispatch = window.__FULLMAG_CHART_DIAGNOSTICS__?.dispatchDataZoom;
    if (typeof dispatch !== "function") return false;
    dispatch(20, 40);
    return true;
  });
  if (!dispatched) {
    throw new Error("ECharts diagnostic dataZoom dispatcher was not installed.");
  }
  await page.waitForFunction(
    () => {
      const zoom = document.querySelector(".fm-analysis-plots__range-zoom");
      return /zoom\s+20(?:\.0+)?\s*-\s*40(?:\.0+)?/.test(zoom?.textContent ?? "");
    },
    { timeout: timeoutMs },
  ).catch(async () => {
    const body = await page.locator(".fm-analysis-plots").innerText();
    throw new Error(
      `local Analysis range selection was not retained. Analysis snippet:\n${body.slice(0, 1_000)}`,
    );
  });
  await page.waitForTimeout(250);
  if (rowsBinRequests.length > 0) {
    throw new Error(
      `rows.bin requests after local range selection: ${rowsBinRequests.length}`,
    );
  }
}

async function collectAnalysisPlotProof(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".fm-analysis-plots");
    const host = root?.querySelector(".fm-analysis-chart-surface") ?? null;
    const canvas = host?.querySelector("canvas") ?? null;
    const rootRect = root?.getBoundingClientRect();
    const hostRect = host?.getBoundingClientRect();
    const selectedDatasetRef =
      root?.querySelector('[aria-label="Analysis dataset"]')?.textContent?.trim() ?? "";
    const provenance =
      root?.querySelector(".fm-analysis-plots__header span")?.textContent?.trim() ?? "";
    const surfaceLabels = Array.from(
      root?.querySelectorAll(".fm-analysis-plots__tab") ?? [],
    ).map((element) => element.textContent?.trim() ?? "");
    const pointSummary =
      root?.querySelector(".fm-chart-section__point-count")?.textContent?.trim() ?? "";
    const cursor =
      root?.querySelector(".fm-analysis-plots__range-cursor")?.textContent?.trim() ?? "";
    const legend = Array.from(
      root?.querySelectorAll(".fm-chart-legend__item") ?? [],
    ).map((element) => element.getAttribute("aria-label") ?? "");
    const inspectorText =
      document.querySelector(".fm-inspector-panel")?.textContent ?? "";

    let canvasProof = null;
    if (canvas instanceof HTMLCanvasElement) {
      const rect = canvas.getBoundingClientRect();
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const width = Math.max(1, Math.floor(canvas.width));
      const height = Math.max(1, Math.floor(canvas.height));
      const unique = new Set();
      let nonTransparent = 0;
      let sampled = 0;
      if (ctx) {
        const stepX = Math.max(1, Math.floor(width / 32));
        const stepY = Math.max(1, Math.floor(height / 32));
        for (let y = 0; y < height; y += stepY) {
          for (let x = 0; x < width; x += stepX) {
            const data = ctx.getImageData(x, y, 1, 1).data;
            sampled += 1;
            if (data[3] !== 0) nonTransparent += 1;
            unique.add(`${data[0]},${data[1]},${data[2]},${data[3]}`);
          }
        }
      }
      canvasProof = {
        cssHeight: rect.height,
        cssWidth: rect.width,
        height: canvas.height,
        nonTransparent,
        sampled,
        uniqueColors: unique.size,
        width: canvas.width,
      };
    }

    return {
      activeModuleId:
        document
          .querySelector("[data-slot-id='viewport-main']")
          ?.getAttribute("data-active-module-id") ?? null,
      canvas: canvasProof,
      cursor,
      hostRect: hostRect ? { height: hostRect.height, width: hostRect.width } : null,
      inspectorText,
      legend,
      pointSummary,
      provenance,
      retainedRefresh: root?.querySelector(".fm-analysis-chart-surface")?.getAttribute("data-status") === "refreshing",
      rootRect: rootRect ? { height: rootRect.height, width: rootRect.width } : null,
      selectedDatasetRef,
      surfaceLabels,
    };
  });
}

function validateProof(proof, expectedDatasetRef) {
  const failures = [];
  if (proof.activeModuleId !== "analysis-plots") {
    failures.push(`analysis-plots is not active: ${proof.activeModuleId}`);
  }
  if (!proof.rootRect || proof.rootRect.width <= 0 || proof.rootRect.height <= 0) {
    failures.push("analysis-plots root has no visible bounds.");
  }
  if (!proof.hostRect || proof.hostRect.width <= 0 || proof.hostRect.height <= 0) {
    failures.push("ECharts host has no visible bounds.");
  }
  if (!proof.canvas) {
    failures.push("ECharts canvas was not created.");
  } else {
    if (proof.canvas.width <= 0 || proof.canvas.height <= 0) {
      failures.push(
        `ECharts canvas has invalid drawing buffer: ${proof.canvas.width}x${proof.canvas.height}`,
      );
    }
    if (proof.canvas.nonTransparent <= 0 || proof.canvas.uniqueColors < 2) {
      failures.push(
        `ECharts canvas appears blank: nonTransparent=${proof.canvas.nonTransparent}, uniqueColors=${proof.canvas.uniqueColors}`,
      );
    }
  }
  if (proof.selectedDatasetRef !== expectedDatasetRef) {
    failures.push(
      `selected Analysis dataset changed: ${proof.selectedDatasetRef} != ${expectedDatasetRef}`,
    );
  }
  if (!proof.provenance.includes(expectedDatasetRef) || !/\brevision\s+\d+\b/.test(proof.provenance)) {
    failures.push(`analysis provenance is incomplete: ${proof.provenance}`);
  }
  if (JSON.stringify(proof.surfaceLabels) !== JSON.stringify(ANALYSIS_SURFACES)) {
    failures.push(`analysis workbench surfaces changed: ${JSON.stringify(proof.surfaceLabels)}`);
  }
  if (!/[1-9]\d*(?:\s*\/\s*[1-9]\d*)?\s+rows/.test(proof.pointSummary)) {
    failures.push(`analysis point summary is missing: ${proof.pointSummary}`);
  }
  if (!Array.isArray(proof.legend) || proof.legend.length === 0) {
    failures.push("analysis series legend is missing.");
  } else if (!proof.legend.every((entry) => /.+, unit .+, latest .+\./.test(entry))) {
    failures.push(`analysis series legend is incomplete: ${proof.legend.join(" | ")}`);
  }
  if (!proof.cursor || /cursor\s+—/i.test(proof.cursor)) {
    failures.push(`analysis cursor selection is missing: ${proof.cursor}`);
  }
  for (const forbidden of ["Chart controls", "Following", "Resume live chart updates"]) {
    if (proof.inspectorText.includes(forbidden)) {
      failures.push(`Analysis Inspector exposes Live Chart control ${forbidden}.`);
    }
  }
  return failures;
}

async function installAnalysisDatasetFixtureRoutes(page) {
  const datasetRef = "analysis-fixture";
  const revision = 17;
  const columns = [
    { column_id: "step", component: null, dimension: "count", label: "step", quantity_id: "step", reduction: null, unit: "1", value_type: "integer" },
    { column_id: "mx", component: "x", dimension: "magnetization", label: "mx", quantity_id: "mx", reduction: "mean", unit: "1", value_type: "float" },
    { column_id: "my", component: "y", dimension: "magnetization", label: "my", quantity_id: "my", reduction: "mean", unit: "1", value_type: "float" },
    { column_id: "mz", component: "z", dimension: "magnetization", label: "mz", quantity_id: "mz", reduction: "mean", unit: "1", value_type: "float" },
    { column_id: "e_total", component: null, dimension: "energy", label: "total energy", quantity_id: "e_total", reduction: "sum", unit: "J", value_type: "float" },
  ];
  const table = {
    binary_rows_href: `/v2/sessions/current/data/tables/${datasetRef}/rows.bin`,
    columns: [],
    columns_href: `/v2/sessions/current/data/tables/${datasetRef}/columns`,
    revision,
    rows_href: `/v2/sessions/current/data/tables/${datasetRef}/rows`,
    schema_revision: 1,
    table_id: datasetRef,
    total_rows: 256,
  };
  await page.route("**/v2/sessions/current/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const cors = {
      "access-control-expose-headers": "x-api-contract-version",
      "access-control-allow-origin": "*",
      "x-api-contract-version": "1.0.0",
    };
    if (request.method() !== "GET") {
      await route.fulfill({ body: "", headers: cors, status: 204 });
      return;
    }
    if (url.pathname === "/v2/sessions/current/status") {
      await route.fulfill({
        body: JSON.stringify(analysisStatusFixture()),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (url.pathname === "/v2/sessions/current/data/tables") {
      await route.fulfill({
        body: JSON.stringify({ revision, tables: [table] }),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (url.pathname === `/v2/sessions/current/data/tables/${datasetRef}`) {
      await route.fulfill({
        body: JSON.stringify(table),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (url.pathname === `/v2/sessions/current/data/tables/${datasetRef}/columns`) {
      await route.fulfill({
        body: JSON.stringify(columns),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (url.pathname === `/v2/sessions/current/data/tables/${datasetRef}/rows.bin`) {
      const requestedColumns = (url.searchParams.get("columns") ?? "")
        .split(",")
        .filter(Boolean);
      await route.fulfill({
        body: makeRowsFixture(requestedColumns, 256, revision),
        contentType: "application/vnd.fullmag.table-rows.v1+octet-stream",
        headers: cors,
        status: 200,
      });
      return;
    }
    await fulfillMissingFixtureResource(route, cors);
  });
}

function analysisStatusFixture() {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      algorithms_available: [],
      binary_fields: false,
      cell_fields: false,
      eigen_modes: false,
      explicit_topology: false,
      gpu_telemetry: false,
      node_fields: false,
      preview_2d: false,
      preview_3d: false,
      scalar_history: true,
      structured_grid: false,
    },
    display: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
      max_points: 120000,
      slice_layer: 0,
      slice_mode: "xy",
      vector_density: 2,
      vector_glyphs: false,
      view_mode: "3d",
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    domain: { cell_count: 0, discretization: "unknown", generation_id: 0 },
    energies: {},
    metrics: { steps_per_second: null, total_steps: 0, uptime_seconds: 0 },
    resources: {
      artifact_revision: 0,
      artifacts_revision: 0,
      command_completion_revision: 0,
      commands_revision: 0,
      display_revision: 0,
      domain_generation_id: 0,
      engine_log_revision: 0,
      field_catalog_revision: 0,
      field_revision: 0,
      fields_revision: 0,
      mesh_build_revision: 0,
      mesh_revision: 0,
      scalars_revision: 17,
      scene_revision: 0,
      slice_revision: 0,
      stages_revision: 0,
      topology_revision: 0,
      visualization_state_revision: 0,
      workspace_revision: 0,
    },
    run: null,
    runtime_bundle_version: "analysis-plots-fixture",
    session: {
      created_at: "0",
      name: "analysis-plots-fixture",
      session_id: "analysis-plots-fixture",
      workspace_root: "/tmp/fullmag-analysis-plots-fixture",
    },
    solver: { state: "idle" },
  };
}

async function fulfillMissingFixtureResource(route, headers) {
  await route.fulfill({ body: "", headers, status: 204 });
}

function makeRowsFixture(columns, rowCount, revision) {
  if (columns.length === 0) {
    throw new Error("Analysis rows fixture requires requested columns.");
  }
  const buffer = Buffer.alloc(60 + rowCount * columns.length * 8);
  buffer.write("FMTB", 0, "ascii");
  buffer.writeUInt16LE(1, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeBigUInt64LE(BigInt(revision), 8);
  buffer.writeBigUInt64LE(1n, 16);
  buffer.writeBigUInt64LE(0n, 24);
  buffer.writeBigUInt64LE(BigInt(rowCount), 32);
  buffer.writeBigUInt64LE(BigInt(rowCount), 40);
  buffer.writeBigUInt64LE(BigInt(rowCount), 48);
  buffer.writeUInt32LE(columns.length, 56);
  let offset = 60;
  for (let row = 0; row < rowCount; row += 1) {
    for (const column of columns) {
      const phase = row / 20;
      const value = column === "step"
        ? row
        : column === "mx"
          ? Math.cos(phase)
          : column === "my"
            ? Math.sin(phase)
            : column === "mz"
              ? 0.1 * Math.sin(phase / 3)
              : column === "e_total"
                ? -1e-18 * (1 + row / rowCount)
                : row;
      buffer.writeDoubleLE(value, offset);
      offset += 8;
    }
  }
  return buffer;
}

function currentSessionPath(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith("/v2/sessions/current/")) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

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

function numericEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumericEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

main().catch((error) => {
  console.error(`Analysis plots smoke failed: ${error.stack ?? error.message}`);
  process.exit(1);
});
