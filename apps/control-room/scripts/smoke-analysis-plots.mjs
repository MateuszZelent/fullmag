import { createHash } from "node:crypto";
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
const SESSION_COLLECTION_PATH = "/v2/sessions";
const DEVELOPMENT_BACKEND_FIXTURE_PATH = "/v2/platform/development-backend";
const FIXTURE_SESSION_ID = "analysis-plots-fixture";
const FIXTURE_SESSION_EPOCH = "00000000-0000-4000-8000-000000000017";
const FIXTURE_REQUEST_SCOPE_EPOCH = "00000000-0000-4000-8000-000000000018";
const ROWS_BIN_PATTERN =
  /^\/v2\/sessions\/current\/data\/tables\/[^/]+\/rows\.bin(?:\?|$)/;
const FREQUENCY_DOMAIN_PATHS = {
  dispersion: "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
  manifest: "/v2/sessions/current/analysis/frequency-domain/manifest.v1",
  modePrefix: "/v2/sessions/current/analysis/frequency-domain/eigen/modes/",
  response: "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep",
  spectrum: "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
};

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

  await page.addInitScript(({ disableRealtime, baseUrl }) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      ...(disableRealtime ? { disableRealtime: true } : {}),
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
  }, { disableRealtime: useFixture, baseUrl: apiBase });

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
    await page.locator("main.fm-workspace-shell").waitFor({ state: "visible", timeout: timeoutMs });
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
    const frequencyDomainFixtureProof = useFixture
      ? await verifyFrequencyDomainChartFixtures(browser, workspaceUrl, apiBase)
      : [];
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
    if (frequencyDomainFixtureProof.length > 0) {
      console.log(
        `Analysis frequency-domain chart proof: ${JSON.stringify(frequencyDomainFixtureProof)}`,
      );
    }
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

async function verifyFrequencyDomainChartFixtures(browser, workspaceUrl, baseUrl) {
  const proofs = [];
  for (const fixture of createFrequencyDomainChartFixtures()) {
    const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
    const errors = [];
    const failedResponses = [];
    const frequencyRequests = [];
    await page.addInitScript(({ apiBase }) => {
      window.__FULLMAG_CONFIG__ = {
        ...(window.__FULLMAG_CONFIG__ ?? {}),
        disableRealtime: true,
        controlRoomApiBase: apiBase,
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
    }, { apiBase: baseUrl });
    await installAnalysisDatasetFixtureRoutes(page, fixture);
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const messageText = message.text();
      if (!messageText.startsWith("Failed to load resource:")) errors.push(messageText);
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      const responsePath = currentSessionPath(response.url());
      if (
        response.status() >= 400 &&
        responsePath?.startsWith("/v2/sessions/current/analysis/")
      ) {
        failedResponses.push({ path: responsePath, status: response.status() });
      }
    });
    page.on("request", (request) => {
      const requestPath = currentSessionPath(request.url());
      if (requestPath?.startsWith("/v2/sessions/current/analysis/frequency-domain/")) {
        frequencyRequests.push(requestPath.split("?")[0]);
      }
    });

    try {
      await page.goto(workspaceUrl, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      await page.locator("main.fm-workspace-shell").waitFor({ state: "visible", timeout: timeoutMs });
      await openAnalysisPlots(page);
      await selectFrequencyDomainSubview(page, fixture.surfaceLabel, fixture.subviewId, fixture.subviewLabel);

      const legend = await waitForFrequencyChart(page, fixture);
      const renderedSeries = await inspectFrequencyChartOption(page, fixture);
      if (!frequencyRequests.includes(fixture.resourcePath)) {
        throw new Error(
          `${fixture.id} did not request its published chart artifact: ${frequencyRequests.join(", ")}`,
        );
      }
      const proof = {
        calculationMode: fixture.calculationMode,
        chartResource: fixture.resourcePath,
        fixture: fixture.id,
        legend,
        renderedSeries,
        requestedSubview: await page
          .locator(".fm-analysis-plots__subview")
          .getAttribute("data-analysis-subview"),
        renderedPoints: await page.evaluate(
          () => window.__FULLMAG_CHART_DIAGNOSTICS__?.renderedPoints ?? 0,
        ),
      };

      if (fixture.expectedSelection) {
        proof.selectedPoint = await clickFrequencyDomainPoint(
          page,
          fixture.expectedSelection,
          fixture.id,
        );
      }
      if (fixture.screenshot) {
        mkdirSync(acceptanceDirectory, { recursive: true });
        const screenshot = path.join(acceptanceDirectory, fixture.screenshot);
        await page.screenshot({ path: screenshot });
        proof.screenshot = screenshot;
      }
      await assertNoVisibleResourceErrors(page, errors);
      if (failedResponses.length > 0) {
        throw new Error(`${fixture.id} frequency-domain responses failed: ${JSON.stringify(failedResponses)}`);
      }
      proofs.push(proof);
    } finally {
      await page.close();
    }
  }
  return proofs;
}

async function selectFrequencyDomainSubview(page, surfaceLabel, subviewId, subviewLabel) {
  const surfaceTab = page
    .locator(".fm-analysis-plots__tab")
    .filter({ hasText: surfaceLabel });
  await surfaceTab.first().waitFor({ state: "visible", timeout: timeoutMs });
  await surfaceTab.first().click({ timeout: timeoutMs });

  const subviewTrigger = page.getByRole("combobox", { name: `${surfaceLabel} subview` });
  await subviewTrigger.waitFor({ state: "visible", timeout: timeoutMs });
  if (await subviewTrigger.getAttribute("data-analysis-subview") !== subviewId) {
    await subviewTrigger.click({ timeout: timeoutMs });
    await page.getByRole("option", { name: subviewLabel, exact: true })
      .click({ timeout: timeoutMs });
  }
  await page.waitForFunction(
    (expectedSubview) =>
      document.querySelector(".fm-analysis-plots__subview")
        ?.getAttribute("data-analysis-subview") === expectedSubview,
    subviewId,
    { timeout: timeoutMs },
  );
}

async function waitForFrequencyChart(page, fixture) {
  await page.waitForFunction(
    ({ expectedResourcePath, minimumRenderedPoints }) => {
      const root = document.querySelector(".fm-analysis-plots");
      const chartFrame = root?.querySelector(".fm-analysis-plots__chart-frame");
      const canvas = root?.querySelector(".fm-analysis-chart-surface canvas");
      const diagnostics = window.__FULLMAG_CHART_DIAGNOSTICS__;
      return (
        chartFrame?.getAttribute("data-resource-key") === expectedResourcePath &&
        canvas instanceof HTMLCanvasElement &&
        canvas.width > 0 && canvas.height > 0 &&
        (diagnostics?.renderedPoints ?? 0) >= minimumRenderedPoints
      );
    },
    {
      expectedResourcePath: fixture.resourcePath,
      minimumRenderedPoints: fixture.minimumRenderedPoints,
    },
    { timeout: timeoutMs },
  ).catch(async () => {
    const body = await page.locator(".fm-analysis-plots").innerText();
    const chartResource = await page
      .locator(".fm-analysis-plots__chart-frame")
      .first()
      .getAttribute("data-resource-key")
      .catch(() => null);
    const renderedPoints = await page.evaluate(
      () => window.__FULLMAG_CHART_DIAGNOSTICS__?.renderedPoints ?? 0,
    );
    throw new Error(
      `${fixture.id} did not render the requested chart artifact (resource=${chartResource}, renderedPoints=${renderedPoints}). Analysis snippet:\n${body.slice(0, 1_200)}`,
    );
  });

  const labels = await page.locator(".fm-chart-legend__label").allTextContents();
  const normalizedLabels = labels.map((label) => label.trim()).filter(Boolean);
  for (const requiredLabel of fixture.requiredLegendLabels ?? []) {
    if (!normalizedLabels.includes(requiredLabel)) {
      throw new Error(
        `${fixture.id} is missing chart series ${requiredLabel}: ${normalizedLabels.join(" | ")}`,
      );
    }
  }
  if (normalizedLabels.length < (fixture.minimumLegendCount ?? 1)) {
    throw new Error(`${fixture.id} chart legend is empty: ${normalizedLabels.join(" | ")}`);
  }
  return normalizedLabels;
}

async function inspectFrequencyChartOption(page, fixture) {
  const evidence = await page.evaluate(({ sourceGapRow, targetRowId }) => {
    const diagnostics = window.__FULLMAG_CHART_DIAGNOSTICS__;
    const readOption = diagnostics?.readRenderedOption;
    if (typeof readOption !== "function") return { available: false, series: [] };
    const option = readOption();
    const series = Array.isArray(option?.series) ? option.series : [];
    return {
      available: true,
      series: series.map((entry, seriesIndex) => {
        const data = Array.isArray(entry.data) ? entry.data : [];
        const targetDataIndex = targetRowId == null
          ? -1
          : data.findIndex((row) => Array.isArray(row) && row[2] === targetRowId);
        const target = targetDataIndex >= 0 ? data[targetDataIndex] : null;
        const targetPrevious = targetDataIndex > 0 ? data[targetDataIndex - 1] : null;
        return {
          connectNulls: entry.connectNulls ?? null,
          dataLength: data.length,
          name: entry.name ?? "",
          nonNullPointCount: data.filter((row) =>
            Array.isArray(row) && typeof row[1] === "number"
          ).length,
          nullSentinelCount: data.filter((row) =>
            Array.isArray(row) && row[1] === null && row[2] === null
          ).length,
          seriesIndex,
          showSymbol: entry.showSymbol === true,
          sourceGapRowRetained: sourceGapRow == null
            ? null
            : data.some((row) => Array.isArray(row) && row[2] === sourceGapRow),
          targetDataIndex,
          targetPreviousIsNullSentinel: Array.isArray(targetPrevious) &&
            targetPrevious[1] === null && targetPrevious[2] === null,
          targetSourceRowIndex: Array.isArray(target) && typeof target[2] === "number"
            ? target[2]
            : null,
          type: entry.type ?? "",
        };
      }),
    };
  }, {
    sourceGapRow: fixture.expectedSelection?.sourceGapRow ?? null,
    targetRowId: fixture.expectedSelection?.rowId ?? null,
  });

  if (!evidence.available) {
    throw new Error(`${fixture.id} has no opt-in reader for the applied ECharts option.`);
  }
  if (fixture.requireDispersionRenderEvidence) {
    const line = evidence.series.find((entry) => entry.type === "line");
    const scatter = evidence.series.find((entry) => entry.type === "scatter");
    if (!line || !scatter) {
      throw new Error(
        `${fixture.id} did not apply both tracked line and raw scatter series: ${JSON.stringify(evidence.series)}`,
      );
    }
    if (line.nonNullPointCount !== 5_000 || scatter.nonNullPointCount !== 5_000) {
      throw new Error(
        `${fixture.id} did not cap each series at 5,000 rendered points: ${JSON.stringify(evidence.series)}`,
      );
    }
    if (scatter.showSymbol !== true || line.showSymbol !== false) {
      throw new Error(
        `${fixture.id} changed scatter symbols or line symbols: ${JSON.stringify(evidence.series)}`,
      );
    }
    if (line.connectNulls !== false) {
      throw new Error(
        `${fixture.id} applied a tracked line that connects across null gaps: ${JSON.stringify(line)}`,
      );
    }
    if (
      line.sourceGapRowRetained !== false ||
      line.nullSentinelCount !== 1 ||
      line.targetSourceRowIndex !== fixture.expectedSelection.rowId ||
      !line.targetPreviousIsNullSentinel
    ) {
      throw new Error(
        `${fixture.id} lost the decimated source gap or its post-gap row: ${JSON.stringify(line)}`,
      );
    }
  }
  return evidence.series;
}

async function clickFrequencyDomainPoint(page, expected, fixtureId) {
  const host = page.locator(".fm-analysis-plots__echarts").first();
  await host.evaluate((element) => {
    element.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
  });
  const coordinateTarget = await page.evaluate(({ rowId, seriesType }) => {
    const diagnostics = window.__FULLMAG_CHART_DIAGNOSTICS__;
    const option = diagnostics?.readRenderedOption?.();
    const series = Array.isArray(option?.series) ? option.series : [];
    const seriesIndex = series.findIndex((entry) =>
      entry?.type === seriesType &&
      Array.isArray(entry.data) &&
      entry.data.some((row) => Array.isArray(row) && row[2] === rowId)
    );
    if (seriesIndex < 0) return null;
    const data = series[seriesIndex].data;
    const dataIndex = data.findIndex((row) => Array.isArray(row) && row[2] === rowId);
    const target = data[dataIndex];
    const resolvePoint = diagnostics?.resolveRenderedDataPoint;
    if (dataIndex < 0 || typeof resolvePoint !== "function") return null;
    const coordinate = resolvePoint(seriesIndex, dataIndex);
    if (!coordinate) return null;
    return {
      data: coordinate.data,
      dataIndex: coordinate.dataIndex,
      seriesIndex: coordinate.seriesIndex,
      targetData: target.slice(0, 3),
      type: series[seriesIndex].type,
      x: coordinate.x,
      y: coordinate.y,
    };
  }, { rowId: expected.rowId, seriesType: expected.seriesType });
  if (
    !coordinateTarget ||
    coordinateTarget.dataIndex < 0 ||
    coordinateTarget.data?.[2] !== expected.rowId ||
    coordinateTarget.targetData?.[2] !== expected.rowId ||
    coordinateTarget.type !== expected.seriesType ||
    !Number.isFinite(coordinateTarget.x) ||
    !Number.isFinite(coordinateTarget.y)
  ) {
    throw new Error(
      `Could not resolve rendered row ${expected.rowId} to its actual ECharts coordinate: ${JSON.stringify(coordinateTarget)}`,
    );
  }

  const expectedModePath = `${FREQUENCY_DOMAIN_PATHS.modePrefix}${expected.sampleIndex}/${expected.modeIndex}`;
  await page.mouse.move(coordinateTarget.x, coordinateTarget.y);
  // Tooltip text proves the user-facing mode/frequency content; the actual source row
  // is proven separately by the applied option, click tuple, and selected Inspector.
  const tooltip = await waitForFrequencyDomainTooltip(
    page,
    host,
    coordinateTarget,
    expected.tooltipTerms,
    fixtureId,
  );
  const expectedModeRequest = page.waitForRequest(
    (request) => currentSessionPath(request.url())?.split("?")[0] === expectedModePath,
    { timeout: 800 },
  ).catch(() => null);
  const expectedModeResponse = page.waitForResponse(
    (response) => currentSessionPath(response.url())?.split("?")[0] === expectedModePath,
    { timeout: 800 },
  ).catch(() => null);
  await page.mouse.click(coordinateTarget.x, coordinateTarget.y);
  const request = await expectedModeRequest;
  const modeResponse = await expectedModeResponse;
  if (!request || !modeResponse) {
    throw new Error(
      `Mouse click at the rendered row ${expected.rowId} coordinate did not request and receive ${expectedModePath}.`,
    );
  }
  if (!modeResponse.ok()) {
    throw new Error(
      `Selected eigen mode resource returned HTTP ${modeResponse.status()} for ${expectedModePath}.`,
    );
  }
  let modePayload = null;
  try {
    modePayload = (await modeResponse.json())?.payload ?? null;
  } catch (error) {
    throw new Error(
      `Selected eigen mode resource was not valid JSON for ${expectedModePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const modeDetailCanonicalRelativeL2Present =
    modePayload !== null &&
    Object.prototype.hasOwnProperty.call(modePayload, "residual_relative_l2");
  if (expected.expectModeDetailRelativeL2Absent && (
    modePayload === null ||
    typeof modePayload !== "object" ||
    Array.isArray(modePayload) ||
    modePayload.sample_index !== expected.sampleIndex ||
    modePayload.raw_mode_index !== expected.modeIndex
  )) {
    throw new Error(
      `Selected eigen mode response did not contain the requested sample/mode payload: ${JSON.stringify(modePayload)}`,
    );
  }
  if (expected.expectModeDetailRelativeL2Absent && modeDetailCanonicalRelativeL2Present) {
    throw new Error(
      `Selected mode detail published residual_relative_l2; the browser fallback case must obtain it from the spectrum.`,
    );
  }
  await page.waitForFunction(
    ({ expectedFieldId, expectedIdentity, expectedResourceRef }) => {
      const panel = document.querySelector(
        '[data-inspector-owner="frequency-domain.eigen-mode"]',
      );
      const text = panel?.textContent ?? "";
      return Boolean(
        panel &&
        text.includes(expectedIdentity) &&
        text.includes(expectedFieldId) &&
        text.includes(expectedResourceRef)
      );
    },
    {
      expectedFieldId: expected.fieldId,
      expectedIdentity: `sample ${expected.sampleIndex}, mode ${expected.modeIndex}`,
      expectedResourceRef: expected.resourceRef,
    },
    { timeout: 1_200 },
  ).catch(() => undefined);
  const inspectorText = await page
    .locator('[data-inspector-owner="frequency-domain.eigen-mode"]')
    .textContent()
    .catch(() => "");
  if (
    !inspectorText?.includes(`sample ${expected.sampleIndex}, mode ${expected.modeIndex}`) ||
    !inspectorText.includes(expected.fieldId) ||
    !inspectorText.includes(expected.resourceRef)
  ) {
    const inspectorText = await page
      .locator(".fm-inspector-panel")
      .textContent()
      .catch(() => "");
    throw new Error(
      `Rendered row ${expected.rowId} did not select sample ${expected.sampleIndex}, mode ${expected.modeIndex}, field ${expected.fieldId}. Inspector: ${inspectorText}`,
    );
  }
  const residualFields = expected.residualFields
    ? await waitForFrequencyDomainResidualFields(page, expected.residualFields)
    : null;
  const renderedClick = await page.evaluate(({ rowId, sourceGapRow }) => {
    const diagnostics = window.__FULLMAG_CHART_DIAGNOSTICS__;
    const click = diagnostics?.lastRenderedClick;
    const option = diagnostics?.readRenderedOption?.();
    const series = Array.isArray(option?.series) && click?.seriesIndex != null
      ? option.series[click.seriesIndex]
      : null;
    const data = Array.isArray(series?.data) ? series.data : [];
    const targetDataIndex = data.findIndex((row) => Array.isArray(row) && row[2] === rowId);
    const clickedData = click?.dataIndex == null ? null : data[click.dataIndex];
    const previousData = click?.dataIndex == null || click.dataIndex === 0
      ? null
      : data[click.dataIndex - 1];
    return {
      clickData: click?.data ?? null,
      clickDataIndex: click?.dataIndex ?? null,
      clickSeriesIndex: click?.seriesIndex ?? null,
      clickedSourceRowIndex: Array.isArray(clickedData) ? clickedData[2] ?? null : null,
      clickedSeriesType: series?.type ?? null,
      previousIsNullSentinel: Array.isArray(previousData) &&
        previousData[1] === null && previousData[2] === null,
      sourceGapRowRetained: sourceGapRow == null
        ? null
        : data.some((row) => Array.isArray(row) && row[2] === sourceGapRow),
      sourceRowIndex: click?.sourceRowIndex ?? null,
      targetDataIndex,
    };
  }, { rowId: expected.rowId, sourceGapRow: expected.sourceGapRow ?? null });
  if (
    renderedClick.clickDataIndex !== renderedClick.targetDataIndex ||
    renderedClick.clickedSourceRowIndex !== expected.rowId ||
    renderedClick.clickedSeriesType !== expected.seriesType ||
    renderedClick.sourceRowIndex !== expected.rowId ||
    renderedClick.clickData?.[2] !== expected.rowId
  ) {
    throw new Error(
      `ECharts click did not resolve to the rendered source row ${expected.rowId}: ${JSON.stringify(renderedClick)}`,
    );
  }
  if (
    expected.sourceGapRow != null &&
    (renderedClick.sourceGapRowRetained !== false || !renderedClick.previousIsNullSentinel)
  ) {
    throw new Error(
      `ECharts click did not follow the actual null gap sentinel: ${JSON.stringify(renderedClick)}`,
    );
  }
  return {
    coordinateTarget,
    expectedModePath,
    fieldId: expected.fieldId,
    modeId: expected.modeId,
    modeDetailCanonicalRelativeL2Present,
    resourceRef: expected.resourceRef,
    renderedClick,
    residualFields,
    rowId: expected.rowId,
    sampleId: expected.sampleId,
    sampleIndex: expected.sampleIndex,
    tooltip,
  };
}

async function waitForFrequencyDomainResidualFields(page, expectedFields) {
  await page.waitForFunction((fields) => {
    const panel = document.querySelector(
      '[data-inspector-owner="frequency-domain.eigen-mode"]',
    );
    if (!panel) return false;
    const renderedFields = new Map(
      Array.from(panel.querySelectorAll(".fm-inspector-field-row"))
        .map((row) => [
          row.querySelector(".fm-inspector-field-row__label")?.textContent?.trim() ?? "",
          row.querySelector(".fm-inspector-field-row__value")?.textContent?.trim() ?? "",
        ]),
    );
    return Object.entries(fields).every(([label, expected]) => {
      if (!renderedFields.has(label)) return false;
      const rendered = renderedFields.get(label);
      return typeof expected === "number"
        ? Number(rendered) === expected
        : rendered === expected;
    });
  }, expectedFields, { timeout: 1_200 }).catch(async () => {
    const renderedFields = await readFrequencyDomainInspectorFields(page);
    throw new Error(
      `Selected eigen mode residual fields did not match the published spectrum fallback: ${JSON.stringify({ expectedFields, renderedFields })}`,
    );
  });
  return readFrequencyDomainInspectorFields(page);
}

async function readFrequencyDomainInspectorFields(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(
      '[data-inspector-owner="frequency-domain.eigen-mode"]',
    );
    if (!panel) return {};
    return Object.fromEntries(
      Array.from(panel.querySelectorAll(".fm-inspector-field-row"))
        .map((row) => [
          row.querySelector(".fm-inspector-field-row__label")?.textContent?.trim() ?? "",
          row.querySelector(".fm-inspector-field-row__value")?.textContent?.trim() ?? "",
        ]),
    );
  });
}

async function waitForFrequencyDomainTooltip(
  page,
  host,
  coordinateTarget,
  expectedTerms,
  fixtureId,
) {
  if (!Array.isArray(expectedTerms) || expectedTerms.length === 0) {
    throw new Error(`${fixtureId} is missing user-facing tooltip expectations.`);
  }
  const tooltipAppeared = await page.waitForFunction((terms) => {
    const tooltipNodes = Array.from(document.querySelectorAll(".fm-chart-tooltip"));
    return tooltipNodes.some((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0" ||
        rect.width <= 0 ||
        rect.height <= 0
      ) return false;
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      return terms.every((term) => text.includes(String(term).toLowerCase()));
    });
  }, expectedTerms, { timeout: 1_000 }).catch(() => null);

  const tooltipTexts = await readFrequencyDomainTooltip(host);
  const matchingTooltip = tooltipTexts.find((entry) =>
    entry.visible && tooltipIncludesTerms(entry.text, expectedTerms),
  );
  if (tooltipAppeared && matchingTooltip) {
    return { expectedTerms, text: matchingTooltip.text };
  }

  const evidence = await readFrequencyDomainTooltipEvidence(host, coordinateTarget);
  const screenshotPath = path.join(
    acceptanceDirectory,
    `${fixtureId.replace(/[^a-z0-9_-]/gi, "-")}-tooltip-failure.png`,
  );
  let screenshot = screenshotPath;
  try {
    mkdirSync(acceptanceDirectory, { recursive: true });
    await page.screenshot({ path: screenshotPath });
  } catch (error) {
    screenshot = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  throw new Error(
    `${fixtureId} did not show expected user-facing tooltip content ${JSON.stringify(expectedTerms)}. Evidence: ${JSON.stringify({ tooltipTexts, ...evidence })}. Screenshot: ${screenshot}`,
  );
}

async function readFrequencyDomainTooltip(host) {
  return host.evaluate((element) => {
    const nodes = Array.from(element.ownerDocument.querySelectorAll(".fm-chart-tooltip"));
    return nodes.map((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        className: typeof node.className === "string" ? node.className : "",
        text: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
        visible: style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          rect.width > 0 && rect.height > 0,
      };
    }).filter((entry) => entry.text.length > 0);
  });
}

function tooltipIncludesTerms(tooltip, expectedTerms) {
  const normalized = String(tooltip).replace(/\s+/g, " ").trim().toLowerCase();
  return expectedTerms.every((term) => normalized.includes(String(term).toLowerCase()));
}

async function readFrequencyDomainTooltipEvidence(host, coordinateTarget) {
  return host.evaluate((element, target) => {
    const rect = element.getBoundingClientRect();
    const document = element.ownerDocument;
    const pointerTarget = document.elementFromPoint(target.x, target.y);
    const footer = document.querySelector(".fm-footer");
    const footerRect = footer?.getBoundingClientRect() ?? null;
    const option = window.__FULLMAG_CHART_DIAGNOSTICS__?.readRenderedOption?.();
    const series = Array.isArray(option?.series)
      ? option.series[target.seriesIndex]
      : null;
    const data = Array.isArray(series?.data)
      ? series.data[target.dataIndex]
      : null;
    return {
      chartRect: {
        height: rect.height,
        left: rect.left,
        top: rect.top,
        width: rect.width,
      },
      renderedPoint: {
        data,
        dataIndex: target.dataIndex,
        seriesIndex: target.seriesIndex,
        seriesName: series?.name ?? null,
        seriesType: series?.type ?? null,
      },
      pointer: { x: target.x, y: target.y },
      pointerHit: {
        className: typeof pointerTarget?.className === "string" ? pointerTarget.className : "",
        tagName: pointerTarget?.tagName ?? null,
        insideChartHost: pointerTarget !== null && element.contains(pointerTarget),
        insideFooter: pointerTarget !== null && footer?.contains(pointerTarget) === true,
      },
      footerRect: footerRect ? {
        bottom: footerRect.bottom,
        left: footerRect.left,
        right: footerRect.right,
        top: footerRect.top,
      } : null,
      tooltipTexts: Array.from(document.querySelectorAll(".fm-chart-tooltip"))
        .map((node) => ({
          className: typeof node.className === "string" ? node.className : "",
          text: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
          visible: getComputedStyle(node).display !== "none" &&
            getComputedStyle(node).visibility !== "hidden" &&
            getComputedStyle(node).opacity !== "0",
        })),
    };
  }, coordinateTarget);
}

function createFrequencyDomainChartFixtures() {
  const spectrumFieldId = "analysis:eigen:sample-0003:mode-0042";
  const dispersionGap = makeDecimatedDispersionFixture();
  return [
    {
      calculationMode: "free_modes",
      expectedSelection: {
        fieldId: spectrumFieldId,
        modeId: "sample-0003/mode-0042",
        modeIndex: 42,
        expectModeDetailRelativeL2Absent: true,
        rowId: 1,
        resourceRef: frequencyModeFieldResourceKey(spectrumFieldId),
        sampleId: "spectrum-sample-0003",
        sampleIndex: 3,
        seriesType: "line",
        frequencyHz: 2.25e9,
        tooltipTerms: ["mode index: 1", "Eigen frequency", "2.25 GHz"],
        residualFields: {
          "Absolute residual (L2)": "not available",
          "Relative residual (L2)": 1e-7,
          "Spectrum residual (type unspecified)": 2e-4,
        },
      },
      id: "modal-spectrum-alias-and-derived-field-key",
      minimumLegendCount: 1,
      minimumRenderedPoints: 3,
      resourcePath: FREQUENCY_DOMAIN_PATHS.spectrum,
      spectrumPayload: {
        samples: [{
          modes: [
            {
              frequency_hz: 1.5e9,
              mode_field_available: false,
              mode_id: "sample-0003/mode-0017",
              raw_mode_index: 17,
            },
            {
              frequency_hz: 2.25e9,
              mode_field_available: true,
              mode_field_id: spectrumFieldId,
              residual_norm: 2e-4,
              residual_relative_l2: 1e-7,
              mode_id: "sample-0003/mode-0042",
              raw_mode_index: 42,
            },
            {
              frequency_hz: 3e9,
              mode_field_available: false,
              mode_id: "sample-0003/mode-0073",
              raw_mode_index: 73,
            },
          ],
          sample_id: "spectrum-sample-0003",
          sample_index: 3,
        }],
        schema_version: "eigen_spectrum.v2",
      },
      subviewId: "resonance.eigenmodes",
      subviewLabel: "Eigenmodes",
      surfaceLabel: "Resonance & FMR",
    },
    {
      calculationMode: "frequency_response",
      id: "frequency-response manifest through FMR response subview",
      minimumLegendCount: 1,
      minimumRenderedPoints: 3,
      resourcePath: FREQUENCY_DOMAIN_PATHS.response,
      responsePayload: {
        points: [
          { frequency_hz: 1e9, frequency_index: 0, max_response_amplitude: 0.25, phase_rad: 0.1, absorbed_power_density: 0.02 },
          { frequency_hz: 2e9, frequency_index: 1, max_response_amplitude: 0.75, phase_rad: 0.3, absorbed_power_density: 0.06 },
          { frequency_hz: 3e9, frequency_index: 2, max_response_amplitude: 0.4, phase_rad: 0.2, absorbed_power_density: 0.03 },
        ],
        schema_version: "magnetic_response_sweep.v2",
      },
      subviewId: "resonance.frequency-response",
      subviewLabel: "Frequency Response",
      surfaceLabel: "Resonance & FMR",
    },
    {
      calculationMode: "dispersion_modal",
      expectedSelection: dispersionGap.expected,
      id: "dispersion-gap-decimation-and-raw-scatter",
      minimumLegendCount: 2,
      minimumRenderedPoints: 10_000,
      requireDispersionRenderEvidence: true,
      requiredLegendLabels: ["Branch tracked", "Raw modes"],
      resourcePath: FREQUENCY_DOMAIN_PATHS.dispersion,
      screenshot: "analysis-frequency-domain-decimated-gap-scatter.png",
      dispersionText: dispersionGap.text,
      subviewId: "dispersion.modal",
      subviewLabel: "Modal fₙ(k)",
      surfaceLabel: "Dispersion",
    },
  ];
}

function makeDecimatedDispersionFixture() {
  const sampleCount = 10_001;
  const gapAtRow = 5_003;
  const skippedSamples = 100;
  const retainedAfterGapRow = 5_005;
  const targetSampleIndex = retainedAfterGapRow + skippedSamples;
  const targetModeId = `tracked-mode-${targetSampleIndex}`;
  const targetFieldId = `analysis:eigen:sample-${String(targetSampleIndex).padStart(4, "0")}:mode-0001`;
  const targetRowId = 2 * retainedAfterGapRow;
  const rows = [
    "sample_index,sample_id,raw_mode_index,mode_id,branch_id,path_s_rad_per_m,frequency_hz,mode_field_available,mode_field_id",
  ];
  for (let rowIndex = 0; rowIndex < sampleCount; rowIndex += 1) {
    const sampleIndex = rowIndex < gapAtRow ? rowIndex : rowIndex + skippedSamples;
    const sampleId = `k-path-sample-${String(sampleIndex).padStart(5, "0")}`;
    const pathS = sampleIndex * 1e6;
    const frequencyHz = 1e9 + sampleIndex * 1e5;
    const isTarget = rowIndex === retainedAfterGapRow;
    rows.push([
      sampleIndex,
      sampleId,
      1,
      targetOrTrackedModeId(isTarget, targetModeId, sampleIndex),
      "tracked",
      pathS,
      frequencyHz,
      isTarget ? "true" : "false",
      isTarget ? targetFieldId : "",
    ].join(","));
    rows.push([
      sampleIndex,
      sampleId,
      2,
      `raw-mode-${sampleIndex}`,
      "",
      pathS + 200_000,
      frequencyHz + 1e8,
      "false",
      "",
    ].join(","));
  }
  return {
    expected: {
      fieldId: targetFieldId,
      frequencyHz: 1e9 + targetSampleIndex * 1e5,
      modeId: targetModeId,
      modeIndex: 1,
      resourceRef: frequencyModeFieldResourceKey(targetFieldId),
      rowId: targetRowId,
      sampleId: `k-path-sample-${String(targetSampleIndex).padStart(5, "0")}`,
      sampleIndex: targetSampleIndex,
      seriesType: "line",
      sourceGapRow: 2 * gapAtRow,
      tooltipTerms: ["path_s", "Branch tracked"],
    },
    text: rows.join("\n"),
  };
}

function frequencyModeFieldResourceKey(fieldId) {
  return `/v2/sessions/current/data/fields/${encodeURIComponent(fieldId)}/samples/vector?phase_rad=0&view=phase_rotated_real`;
}

function targetOrTrackedModeId(isTarget, targetModeId, sampleIndex) {
  return isTarget ? targetModeId : `tracked-mode-${sampleIndex}`;
}

async function installAnalysisDatasetFixtureRoutes(page, frequencyDomainFixture = null) {
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
  await page.route(`**${DEVELOPMENT_BACKEND_FIXTURE_PATH}`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = {
      "access-control-allow-headers": request.headers()["access-control-request-headers"] ?? "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-api-contract-version",
      "x-api-contract-version": "1.0.0",
    };
    if (url.pathname !== DEVELOPMENT_BACKEND_FIXTURE_PATH) {
      await route.fulfill({ body: "", headers, status: 404 });
      return;
    }
    if (request.method() === "OPTIONS") {
      await route.fulfill({ body: "", headers, status: 204 });
      return;
    }
    if (request.method() !== "GET") {
      await route.fulfill({ body: "", headers, status: 405 });
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
        schema_version: "1.0.0",
        configured: false,
        revision: 0,
        state: "disabled",
        current_build: null,
        ready_build: null,
        build_available: false,
        build_request_id: null,
        workspace_identity: null,
        restart_available: false,
        reason: "disabled",
      }),
      contentType: "application/json",
      headers,
      status: 200,
    });
  });
  await page.route(`**${SESSION_COLLECTION_PATH}`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const cors = {
      "access-control-expose-headers": "x-api-contract-version",
      "access-control-allow-origin": "*",
      "x-api-contract-version": "1.0.0",
    };
    if (request.method() !== "GET" || url.pathname !== SESSION_COLLECTION_PATH) {
      await fulfillMissingFixtureResource(route, cors);
      return;
    }
    await route.fulfill({
      body: JSON.stringify(sessionCollectionFixture()),
      contentType: "application/json",
      headers: cors,
      status: 200,
    });
  });

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
        body: JSON.stringify(analysisStatusFixture({
          frequencyDomainPublished: Boolean(frequencyDomainFixture),
          eigenModesPublished: frequencyDomainFixture?.calculationMode !== "frequency_response",
        })),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (url.pathname === "/v2/sessions/current/model/readiness") {
      await route.fulfill({
        body: JSON.stringify({
          blockers: [],
          capabilities: {
            move: { available: false, reason: "Analysis fixture has no scene objects." },
            rotate: { available: false, reason: "Analysis fixture has no scene objects." },
            scale: { available: false, reason: "Analysis fixture has no scene objects." },
          },
          checks: [],
          ready_to_export: true,
          ready_to_run: false,
          scene_revision: 0,
        }),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    const visualizationFixture = url.pathname === "/v2/sessions/current/visualization/state"
      ? analysisVisualizationStateFixture()
      : url.pathname === "/v2/sessions/current/visualization/mode-compositions/active"
        ? analysisModeCompositionFixture(Boolean(frequencyDomainFixture))
        : url.pathname === "/v2/sessions/current/model/universe"
          ? {
            scene_revision: 0,
            mesh_dirty: false,
            object_bounds_min: null,
            object_bounds_max: null,
            study_universe_mesh: null,
            universe: null,
          }
          : null;
    if (visualizationFixture !== null) {
      await route.fulfill({
        body: JSON.stringify(visualizationFixture),
        contentType: "application/json",
        headers: cors,
        status: 200,
      });
      return;
    }
    if (frequencyDomainFixture && await fulfillFrequencyDomainFixtureResource(
      route,
      url.pathname,
      frequencyDomainFixture,
      cors,
    )) {
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

async function fulfillFrequencyDomainFixtureResource(route, pathname, fixture, headers) {
  if (pathname === FREQUENCY_DOMAIN_PATHS.manifest) {
    await route.fulfill({
      body: JSON.stringify(frequencyDomainManifestFixture(fixture)),
      contentType: "application/json",
      headers,
      status: 200,
    });
    return true;
  }
  if (pathname === FREQUENCY_DOMAIN_PATHS.spectrum && fixture.spectrumPayload) {
    await route.fulfill({
      body: JSON.stringify(frequencyDomainJsonArtifactFixture({
        artifactPath: "eigen/spectrum.v2.json",
        payload: fixture.spectrumPayload,
        resourceKey: FREQUENCY_DOMAIN_PATHS.spectrum,
        schemaVersion: "frequency_domain_eigen_spectrum.v1",
      })),
      contentType: "application/json",
      headers,
      status: 200,
    });
    return true;
  }
  if (pathname === FREQUENCY_DOMAIN_PATHS.response && fixture.responsePayload) {
    await route.fulfill({
      body: JSON.stringify(frequencyDomainJsonArtifactFixture({
        artifactPath: "response/magnetic_response_sweep.v2.json",
        payload: fixture.responsePayload,
        resourceKey: FREQUENCY_DOMAIN_PATHS.response,
        schemaVersion: "frequency_domain_response_sweep_resource.v1",
      })),
      contentType: "application/json",
      headers,
      status: 200,
    });
    return true;
  }
  if (pathname === FREQUENCY_DOMAIN_PATHS.dispersion && fixture.dispersionText) {
    await route.fulfill({
      body: JSON.stringify(frequencyDomainTextArtifactFixture(fixture.dispersionText)),
      contentType: "application/json",
      headers,
      status: 200,
    });
    return true;
  }
  const expectedSelection = fixture.expectedSelection;
  if (expectedSelection) {
    const expectedModePath = `${FREQUENCY_DOMAIN_PATHS.modePrefix}${expectedSelection.sampleIndex}/${expectedSelection.modeIndex}`;
    if (pathname === expectedModePath) {
      const artifactPath = `eigen/modes/sample_${String(expectedSelection.sampleIndex).padStart(4, "0")}/mode_${String(expectedSelection.modeIndex).padStart(4, "0")}.json`;
      await route.fulfill({
        body: JSON.stringify(frequencyDomainJsonArtifactFixture({
          artifactPath,
          payload: {
            frequency_hz: expectedSelection.frequencyHz,
            frequency_real_hz: expectedSelection.frequencyHz,
            mode_field_id: expectedSelection.fieldId,
            mode_id: expectedSelection.modeId,
            raw_mode_index: expectedSelection.modeIndex,
            sample_id: expectedSelection.sampleId,
            sample_index: expectedSelection.sampleIndex,
            schema_version: "eigen_mode.v2",
          },
          resourceKey: pathname,
          schemaVersion: "frequency_domain_eigen_mode_resource.v1",
        })),
        contentType: "application/json",
        headers,
        status: 200,
      });
      return true;
    }
  }
  return false;
}

function frequencyDomainManifestFixture(fixture) {
  const isResponse = fixture.calculationMode === "frequency_response";
  const isDispersion = fixture.calculationMode === "dispersion_modal";
  const artifacts = isResponse
    ? { response_sweep_v2_path: "response/magnetic_response_sweep.v2.json" }
    : isDispersion
      ? { dispersion_csv_path: "eigen/dispersion.csv" }
      : { spectrum_v2_path: "eigen/spectrum.v2.json" };
  const payload = {
    artifacts,
    equilibrium_identity: "analysis-fixture-equilibrium",
    geometry_identity: "analysis-fixture-geometry",
    mesh_identity: "analysis-fixture-mesh",
    observables: [],
    physics: {
      analysis_family: "magnetic_frequency_domain",
      field_units: "dimensionless_delta_m",
      frequency_units: "Hz",
      normalization: "unit_l2",
      phase_convention: "exp_minus_i_omega_t",
    },
    requested_execution: {
      boundary_context: "finite_open",
      calculation_mode: fixture.calculationMode,
    },
    run_id: "analysis-frequency-fixture-run",
    schema_version: "frequency_domain_manifest.v1",
    stage_id: "analysis-frequency-fixture-stage",
    stage_kind: isResponse ? "frequency_response" : "eigenmodes",
    study_product: isResponse ? "driven_response" : "modal_eigen",
  };
  const payloadDigest = sha256Digest(Buffer.from(JSON.stringify(payload), "utf8"));
  const resultManifest = {
    artifact_path: "frequency_domain/manifest.v1.json",
    artifact_set_id: "analysis-frequency-fixture-artifact-set",
    content_digest: payloadDigest,
    mesh_generation_id: "analysis-fixture-mesh",
    payload,
    resource_key: FREQUENCY_DOMAIN_PATHS.manifest,
    revision: payloadDigest,
    run_id: "analysis-frequency-fixture-run",
    schema_version: "frequency_domain_manifest.v1",
    session_id: FIXTURE_SESSION_ID,
    stage_id: "analysis-frequency-fixture-stage",
    status: "ready",
  };
  return {
    capabilities: frequencyDomainCapabilitiesFixture(fixture.calculationMode),
    eigen_namespace: "eigen",
    eigenmodes: frequencyDomainAvailabilityFixture(
      "eigenmodes",
      !isResponse,
    ),
    existing_frequency_response_namespace_preserved: true,
    family_namespace: "frequencyDomain",
    floquet_nonzero_k_demag_supported: false,
    floquet_nonzero_k_response_supported: false,
    response: frequencyDomainAvailabilityFixture("frequency_response", isResponse),
    response_cancel_requested: null,
    response_progress: null,
    result_manifest: resultManifest,
    schema_version: "frequency_domain_manifest.v1",
  };
}

function frequencyDomainAvailabilityFixture(studyKind, available) {
  return {
    diagnostics_json: JSON.stringify({
      fixture: "analysis-plots-frequency-domain-smoke",
      schema_version: "frequency_domain_availability.v1",
    }),
    driven_response_available: false,
    dynamic_demag_k_available: false,
    floquet_modal_available: false,
    floquet_response_available: false,
    gpu_available: false,
    modal_solver_available: false,
    reason: available
      ? "A typed result artifact is published for this chart smoke; execution capability is not asserted."
      : "Not published by this chart smoke fixture.",
    static_periodic_response_available: false,
    status: available ? "ok" : "unavailable",
    study_kind: studyKind,
  };
}

function frequencyDomainCapabilitiesFixture(calculationMode) {
  const isModal = calculationMode === "free_modes" || calculationMode === "fmr_modal";
  const isDispersion = calculationMode === "dispersion_modal";
  const isResponse = calculationMode === "frequency_response" || calculationMode === "fmr_response";
  const entry = (available, label) => ({
    reason: available ? `${label} is published in the browser fixture.` : `Not published in the browser fixture: ${label}.`,
    status: available ? "available" : "unavailable",
  });
  return {
    boundary: {
      floquet_modal: entry(false, "Floquet modal execution"),
      floquet_response: entry(false, "Floquet response execution"),
      periodic_pair_diagnostics: entry(false, "periodic-pair diagnostics"),
      static_periodic: entry(false, "static-periodic execution"),
    },
    demag: {
      floquet_dynamic_k: entry(false, "dynamic-k demagnetization"),
      static_periodic_pbc: entry(false, "static-periodic demagnetization"),
    },
    dispersion: {
      branch_tracking: entry(isDispersion, "tracked dispersion branches"),
      k_path: entry(isDispersion, "dispersion k path"),
      production_cpu: entry(false, "production CPU eigensolver"),
      production_cpu_gamma_k_path: entry(false, "production CPU gamma k path"),
      production_gpu: entry(false, "production GPU eigensolver"),
      reference_cpu: entry(false, "reference CPU eigensolver"),
    },
    modal: {
      absorption_from_modes: entry(false, "modal absorption"),
      k_path: entry(isDispersion, "modal k path"),
      linewidths: entry(false, "mode linewidths"),
      mode_field_payload: entry(isModal || isDispersion, "mode field payload"),
      mode_tracking: entry(isDispersion, "mode tracking"),
      production_cpu: entry(false, "production CPU modal solver"),
      production_gpu: entry(false, "production GPU modal solver"),
      reference_cpu: entry(false, "reference CPU modal solver"),
    },
    response: {
      frequency_sweep: entry(isResponse, "frequency-response sweep"),
      magnetic_cpu: entry(false, "production CPU response solver"),
      magnetic_gpu: entry(false, "production GPU response solver"),
      magnetoelastic_elastodynamic: entry(false, "elastodynamic magnetoelastic response"),
      magnetoelastic_quasistatic: entry(false, "quasistatic magnetoelastic response"),
      mode_projected: entry(false, "mode-projected response"),
    },
    schema_version: "frequency_domain_capabilities.v1",
    validation: { fmr_k0: entry(false, "FMR k=0 validation") },
    visualization: {
      modal_dispersion_chart: entry(isDispersion, "modal dispersion chart"),
      modal_spectrum_chart: entry(isModal, "modal spectrum chart"),
      mode_3d_overlay: entry(false, "3D mode overlay"),
      mode_table: entry(isModal || isDispersion, "mode table"),
      response_field_3d_overlay: entry(false, "3D response-field overlay"),
      response_sweep_chart: entry(isResponse, "response-sweep chart"),
    },
  };
}

function frequencyDomainJsonArtifactFixture({ artifactPath, payload, resourceKey, schemaVersion }) {
  const contentDigest = sha256Digest(Buffer.from(JSON.stringify(payload), "utf8"));
  return {
    artifact_path: artifactPath,
    artifact_set_id: "analysis-frequency-fixture-artifact-set",
    content_digest: contentDigest,
    mesh_generation_id: "analysis-fixture-mesh",
    missing_reason: null,
    payload,
    resource_key: resourceKey,
    revision: contentDigest,
    run_id: "analysis-frequency-fixture-run",
    schema_version: schemaVersion,
    session_id: FIXTURE_SESSION_ID,
    stage_id: "analysis-frequency-fixture-stage",
    status: "ready",
  };
}

function frequencyDomainTextArtifactFixture(text) {
  const contentDigest = sha256Digest(Buffer.from(text, "utf8"));
  return {
    artifact_path: "eigen/dispersion.csv",
    artifact_set_id: "analysis-frequency-fixture-artifact-set",
    content_digest: contentDigest,
    content_type: "text/csv; charset=utf-8",
    mesh_generation_id: "analysis-fixture-mesh",
    missing_reason: null,
    path_metadata: null,
    resource_key: FREQUENCY_DOMAIN_PATHS.dispersion,
    revision: contentDigest,
    run_id: "analysis-frequency-fixture-run",
    schema_version: "frequency_domain_eigen_dispersion.v1",
    session_id: FIXTURE_SESSION_ID,
    stage_id: "analysis-frequency-fixture-stage",
    status: "ready",
    text,
  };
}

function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function analysisStatusFixture({
  eigenModesPublished = false,
  frequencyDomainPublished = false,
} = {}) {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      algorithms_available: [],
      binary_fields: false,
      cell_fields: false,
      eigen_modes: eigenModesPublished,
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
      artifact_revision: frequencyDomainPublished ? 17 : 0,
      artifacts_revision: frequencyDomainPublished ? 17 : 0,
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
      stages_revision: frequencyDomainPublished ? 17 : 0,
      topology_revision: 0,
      visualization_state_revision: 0,
      workspace_revision: 0,
    },
    run: null,
    runtime_bundle_version: "analysis-plots-fixture",
    session: {
      created_at: "2026-10-08T00:00:00.000Z",
      name: FIXTURE_SESSION_ID,
      request_scope_epoch: FIXTURE_REQUEST_SCOPE_EPOCH,
      session_epoch: FIXTURE_SESSION_EPOCH,
      session_id: FIXTURE_SESSION_ID,
      workspace_root: "/tmp/fullmag-analysis-plots-fixture",
    },
    solver: { state: "idle" },
  };
}

function analysisModeCompositionFixture(frequencyDomainPublished) {
  return {
    artifact_revision: "",
    composition_id: "active",
    layers: [],
    lifecycle: {
      artifact_revision: frequencyDomainPublished ? 17 : 0,
      mesh_revision: 0,
      run_id: null,
      session_id: FIXTURE_SESSION_ID,
    },
    phase_clock: { master_rate_hz: 1, synchronized: true },
    revision: 0,
    run_id: "",
    schema_version: "mode-composition.v1",
    stage_id: "",
  };
}
function analysisVisualizationStateFixture() {
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
    clip: {
      enabled: false,
      axis: "x",
      flipped: false,
      position_percent: 50,
    },
    colormap: "viridis",
    contrast_max: null,
    contrast_min: null,
    diagnostics: {
      degraded_reasons: [],
      warnings: [],
    },
    domains: {
      active_scope: {
        object_id: null,
        part_id: null,
        scope: "full",
      },
      topology_mode: "auto",
      volume_edges_budget: 100_000,
    },
    fdm: {
      x_chosen_size: 0,
      y_chosen_size: 0,
    },
    fem: {},
    field_component: "magnitude",
    layers: {
      airbox: {
        render_mode: "wireframe",
        show_airbox: false,
        show_airbox_vectors: false,
      },
      bounds: {
        visible: false,
      },
      points: {
        visible: false,
      },
      primitives: {
        visible: true,
      },
      quantity: {
        visible: true,
      },
      surface: {
        opacity: 1,
        visible: true,
      },
      vectors: {
        density: 50,
        domain: "auto",
        visible: false,
      },
      wireframe: {
        visible: false,
      },
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
    revision: 0,
    sampling: {
      max_bytes: null,
      max_glyphs: 16_384,
      max_points: 16_384,
      profile: "balanced",
      progressive: true,
    },
    schema_version: 5,
    slice: {
      axis: "z",
      auto_contrast: true,
      colormap: "viridis",
      component: "magnitude",
      layer_index: 0,
      mode: "single",
      position_percent: 50,
      projection_include_air_as_zero: false,
      projection_reduction: "mean_occupied",
      projection_resolution: 128,
      projection_samples: 32,
      quantity_id: "m",
      render_mode: "heatmap",
      show_airbox: false,
      show_magnetic_texture: true,
      show_mesh: false,
      show_primitives: true,
      show_quantity: true,
      show_vectors: false,
      thickness_percent: null,
    },
    slice_layer: 0,
    slice_mode: "single",
    targets: {
      airbox: {
        label: "Airbox",
        scope: "airbox",
        scope_id: "airbox",
        settings: {
          active_quantity_id: "m",
          bounds_visible: false,
          geometry_scope: "full",
          opacity: 0.28,
          points_visible: false,
          render_mode: "wireframe",
          surface_color_source: "solid",
          surface_visible: false,
          vector_alpha: 1,
          vector_color_mode: "orientation",
          vector_mono_color: "#00c2ff",
          vector_thickness: 1,
          vectors_visible: false,
          visible: true,
          wireframe_color: "#94a3b8",
          wireframe_opacity: 1,
          wireframe_visible: true,
        },
        source: "airbox",
      },
      objects: [],
      parts: [],
    },
    trim: {
      x: { enabled: false, max_percent: 100, min_percent: 0 },
      y: { enabled: false, max_percent: 100, min_percent: 0 },
      z: { enabled: false, max_percent: 100, min_percent: 0 },
    },
    vector_density: 50,
    vector_glyphs: false,
    vector_style: {
      alpha: 1,
      color_mode: "orientation",
      ferromagnet_visibility: "hide",
      length_scale: 1,
      mono_color: "#00c2ff",
      thickness: 1,
    },
    view_mode: "3d",
    x_chosen_size: 0,
    y_chosen_size: 0,
  };
}

function sessionCollectionFixture() {
  return {
    schema_version: "2.0.0",
    sessions: [{
      current: true,
      name: FIXTURE_SESSION_ID,
      session_id: FIXTURE_SESSION_ID,
      status: "active",
    }],
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
