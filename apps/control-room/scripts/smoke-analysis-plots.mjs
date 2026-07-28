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
const maxRowsBinRequests = numericEnv(
  "CONTROL_ROOM_ANALYSIS_PLOTS_MAX_ROWS_BIN_REQUESTS",
  12,
);

const ROWS_BIN_PATTERN =
  /^\/v2\/sessions\/current\/data\/tables\/default\/rows\.bin(?:\?|$)/;

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

  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
    };
    window.__FULLMAG_ENABLE_CHART_DIAGNOSTICS__ = true;
    window.__FULLMAG_CHART_DIAGNOSTICS__ = {
      activeInstances: 0,
      createdInstances: 0,
      disposedInstances: 0,
      resizeCalls: 0,
      setOptionCalls: 0,
    };
  }, apiBase);

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.startsWith("Failed to load resource:")) return;
    errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const path = currentSessionPath(response.url());
    failedResponses.push({
      path,
      status: response.status(),
      url: response.url(),
    });
  });
  page.on("request", (request) => {
    const path = currentSessionPath(request.url());
    if (!path || !ROWS_BIN_PATTERN.test(path)) return;
    rowsBinRequests.push({ path, timestamp: Date.now() });
  });

  try {
    await page.goto(workspaceUrl, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    await page.locator("main").waitFor({ state: "visible", timeout: timeoutMs });
    await openAnalysisPlots(page);
    await waitForAnalysisRowsAndCanvas(page);
    await verifySeriesLegend(page);
    await verifyInspectorOwnsChartControls(page);
    await verifyLast160PointsFetch(page, rowsBinRequests);
    await verifyPointSelection(page);
    if (await hasAxisControlPanel(page)) {
      await verifyAxisControlInteraction(page, rowsBinRequests);
      await verifyThirdUnitSelectionDisabled(page);
      await verifyAtLeastOneYAxisRemainsSelected(page, rowsBinRequests);
    }
    await verifyAddSeriesEvent(page, rowsBinRequests);
    await verifyZoomRangeFetch(page, rowsBinRequests);

    rowsBinRequests.length = 0;
    await page.waitForTimeout(observeMs);
    const proof = await collectAnalysisPlotProof(page);

    const failures = validateProof(proof);
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
        workspaceUrl,
      })}`,
    );
    console.log(`Analysis plots smoke passed at ${workspaceUrl}.`);
  } finally {
    await browser.close();
  }
}

async function hasAxisControlPanel(page) {
  return page
    .locator(".fm-inspector-panel .fm-analysis-plots__column-row")
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false);
}

async function verifyInspectorOwnsChartControls(page) {
  await page
    .locator(".fm-inspector-panel [aria-label='Chart controls']")
    .waitFor({ state: "visible", timeout: timeoutMs });
  const controlsInChart = await page
    .locator(".fm-analysis-plots .fm-chart-control-bar")
    .count();
  const columnsInChart = await page
    .locator(".fm-analysis-plots .fm-analysis-plots__column-row")
    .count();
  if (controlsInChart !== 0 || columnsInChart !== 0) {
    throw new Error(
      "Analysis chart surface still owns controls or quantity selection instead of the Inspector.",
    );
  }
}

async function verifyLast160PointsFetch(page, rowsBinRequests) {
  rowsBinRequests.length = 0;
  await page
    .locator(".fm-inspector-panel [aria-label='Chart range']")
    .click({ timeout: timeoutMs });
  await page
    .getByRole("option", { exact: true, name: "Last 160 points" })
    .click({ timeout: timeoutMs });

  const request = await waitForRowsBinRequest(rowsBinRequests, (path) => {
    const params = queryParams(path);
    return (
      params.get("include_tail") === "true" &&
      params.get("limit") === "160" &&
      params.get("target_points") === "160"
    );
  }, page);
  if (!request) {
    throw new Error(
      "Last 160 points did not request an exact 160-row tail window.",
    );
  }
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

async function waitForAnalysisRowsAndCanvas(page) {
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".fm-analysis-plots");
      const summary =
        root?.querySelector(".fm-analysis-plots__header span")?.textContent ??
        root?.querySelector(".fm-chart-section__subtitle")?.textContent ??
        "";
      const visible =
        root?.querySelector(".fm-chart-control-bar__points")?.textContent ??
        root?.querySelector(".fm-chart-section__point-count")?.textContent ??
        root?.querySelector(".fm-analysis-plots__range span:last-child")?.textContent ??
        "";
      const canvas = root?.querySelector(
        ".fm-analysis-plots__echarts canvas, .fm-analysis-chart-surface canvas",
      );
      return (
        Boolean(root) &&
        (/\d+ rows \/ \d+ columns/.test(summary) || summary.length > 0) &&
        (/\d+/.test(visible)) &&
        canvas instanceof HTMLCanvasElement &&
        canvas.width > 0 &&
        canvas.height > 0
      );
    },
    { timeout: timeoutMs },
  );
}

async function verifyPointSelection(page) {
  const dispatched = await page.evaluate(() => {
    const dispatch =
      window.__FULLMAG_CHART_DIAGNOSTICS__?.dispatchPointClick;
    if (typeof dispatch !== "function") return false;
    dispatch(0, 0);
    return true;
  });
  if (!dispatched) {
    throw new Error("ECharts diagnostic point-click dispatcher was not installed.");
  }
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".fm-analysis-plots");
      const cursor = root?.querySelector(".fm-analysis-plots__range-cursor");
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

async function verifySeriesLegend(page) {
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".fm-analysis-plots");
      const legend = root?.querySelector(".fm-chart-section__legend");
      const items = Array.from(
        legend?.querySelectorAll(".fm-chart-legend__item") ?? [],
      );
      return (
        legend instanceof HTMLElement &&
        items.length > 0 &&
        items.every((item) => {
          const label = item.querySelector(".fm-chart-legend__label");
          const unit = item.querySelector(".fm-chart-legend__unit");
          const latest = item.querySelector(".fm-chart-legend__latest");
          const swatch = item.querySelector(".fm-chart-legend__swatch");
          return (
            label?.textContent?.trim() &&
            unit?.textContent?.trim() &&
            latest?.textContent?.trim() &&
            swatch instanceof HTMLElement &&
            item.getAttribute("aria-label")?.includes(" latest ")
          );
        })
      );
    },
    { timeout: timeoutMs },
  ).catch(async () => {
    const body = await page.locator(".fm-analysis-plots").innerText();
    throw new Error(
      `analysis series legend is missing or incomplete. Analysis snippet:\n${body.slice(0, 1_000)}`,
    );
  });
}

async function verifySeriesSelectionEvent(page, rowsBinRequests) {
  rowsBinRequests.length = 0;
  await page
    .locator(".fm-chart-legend__item")
    .first()
    .click({ timeout: timeoutMs });
  await page.waitForFunction(
    () => {
      const event =
        window.__FULLMAG_CHART_DIAGNOSTICS__?.seriesSelectedEvents?.at(-1);
      return (
        event?.chartId === "default" &&
        event.tableId === "default" &&
        typeof event.seriesId === "string" &&
        event.seriesId.length > 0 &&
        typeof event.resourceKey === "string" &&
        event.resourceKey.includes("/data/tables/default/rows") &&
        typeof event.quantity === "string" &&
        event.quantity.length > 0
      );
    },
    { timeout: timeoutMs },
  ).catch(async () => {
    const events = await page.evaluate(
      () => window.__FULLMAG_CHART_DIAGNOSTICS__?.seriesSelectedEvents ?? [],
    );
    throw new Error(
      `chart series-selected event was not emitted. Events: ${JSON.stringify(events)}`,
    );
  });
  if (rowsBinRequests.length > 0) {
    throw new Error(
      `rows.bin requests after series selection: ${rowsBinRequests.length}`,
    );
  }
}

async function verifyAxisControlInteraction(page, rowsBinRequests) {
  rowsBinRequests.length = 0;
  const xAxisRadios = page.locator(
    ".fm-inspector-panel .fm-analysis-plots__column-row input[type='radio']",
  );
  if ((await xAxisRadios.count()) < 2) return;
  const targetIndex = await xAxisRadios.first().isChecked() ? 1 : 0;
  await xAxisRadios.nth(targetIndex).click({ timeout: timeoutMs });
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".fm-inspector-panel");
      const radios = Array.from(
        root?.querySelectorAll(".fm-analysis-plots__column-row input[type='radio']") ?? [],
      );
      const canvas = document.querySelector(".fm-analysis-chart-surface canvas");
      return (
        radios.some((radio) => radio instanceof HTMLInputElement && radio.checked) &&
        canvas instanceof HTMLCanvasElement &&
        canvas.width > 0 &&
        canvas.height > 0
      );
    },
    { timeout: timeoutMs },
  );
  if (rowsBinRequests.length > 0) {
    throw new Error(
      `rows.bin requests after axis interaction: ${rowsBinRequests.length}`,
    );
  }
}

async function verifyThirdUnitSelectionDisabled(page) {
  const torqueRow = page
    .locator(".fm-inspector-panel .fm-analysis-plots__column-row")
    .filter({ hasText: /max torque/i });
  if ((await torqueRow.count()) === 0) return;
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".fm-inspector-panel");
      const row = Array.from(
        root?.querySelectorAll(".fm-analysis-plots__column-row") ?? [],
      ).find((element) => /max torque/i.test(element.textContent ?? ""));
      const checkbox = row?.querySelector("input[type='checkbox']");
      return (
        checkbox instanceof HTMLInputElement &&
        checkbox.disabled &&
        checkbox.title === "Select at most two Y-axis unit groups"
      );
    },
    { timeout: timeoutMs },
  ).catch(async () => {
    const body = await page.locator(".fm-analysis-plots").innerText();
    throw new Error(
      `third-unit Y-axis checkbox remained enabled. Analysis snippet:\n${body.slice(0, 1_000)}`,
    );
  });
}

async function verifyAtLeastOneYAxisRemainsSelected(page, rowsBinRequests) {
  rowsBinRequests.length = 0;
  const checkedEnabledYAxes = page.locator(
    ".fm-inspector-panel .fm-analysis-plots__column-row input[type='checkbox']:checked:not(:disabled)",
  );
  while ((await checkedEnabledYAxes.count()) > 1) {
    await checkedEnabledYAxes.first().click({ timeout: timeoutMs });
  }
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".fm-inspector-panel");
      const checkboxes = Array.from(
        root?.querySelectorAll(
          ".fm-analysis-plots__column-row input[type='checkbox']",
        ) ?? [],
      ).filter((input) => input instanceof HTMLInputElement);
      const checked = checkboxes.filter((input) => input.checked);
      const enabledChecked = checked.filter((input) => !input.disabled);
      const canvas = document.querySelector(".fm-analysis-chart-surface canvas");
      return (
        checked.length === 1 &&
        enabledChecked.length === 0 &&
        canvas instanceof HTMLCanvasElement &&
        canvas.width > 0 &&
        canvas.height > 0
      );
    },
    { timeout: timeoutMs },
  );
  if (rowsBinRequests.length > 0) {
    throw new Error(
      `rows.bin requests after Y-axis toggle: ${rowsBinRequests.length}`,
    );
  }
}

async function verifyAddSeriesEvent(page, rowsBinRequests) {
  rowsBinRequests.length = 0;
  const dispatched = await page.evaluate(() => {
    const dispatch =
      window.__FULLMAG_CHART_DIAGNOSTICS__?.dispatchSeriesRequest;
    if (typeof dispatch !== "function") return false;
    dispatch("mx");
    return true;
  });
  if (!dispatched) {
    throw new Error("Chart add-series diagnostic dispatcher was not installed.");
  }
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".fm-analysis-plots");
      const hasRequestedSeries = Array.from(
        root?.querySelectorAll(".fm-chart-legend__label") ?? [],
      ).some((element) => element.textContent?.trim() === "mx");
      return hasRequestedSeries;
    },
    { timeout: timeoutMs },
  ).catch(async () => {
    const body = await page.locator(".fm-analysis-plots").innerText();
    throw new Error(
      `chart add-series event did not add the requested series. Analysis snippet:\n${body.slice(0, 1_000)}`,
    );
  });
  if (rowsBinRequests.length > 0) {
    throw new Error(
      `rows.bin requests after add-series event: ${rowsBinRequests.length}`,
    );
  }
}

async function verifyZoomRangeFetch(page, rowsBinRequests) {
  rowsBinRequests.length = 0;
  const dispatched = await page.evaluate(() => {
    const dispatch =
      window.__FULLMAG_CHART_DIAGNOSTICS__?.dispatchDataZoom;
    if (typeof dispatch !== "function") return false;
    dispatch(20, 40);
    return true;
  });
  if (!dispatched) {
    throw new Error("ECharts diagnostic dataZoom dispatcher was not installed.");
  }
  await page.waitForFunction(
    () => {
      const event =
        window.__FULLMAG_CHART_DIAGNOSTICS__?.rangeSelectedEvents?.at(-1);
      return (
        event?.chartId === "default" &&
        event.tableId === "default" &&
        typeof event.xAxisId === "string" &&
        event.xAxisId.length > 0 &&
        event.range?.fromValue === 20 &&
        event.range?.toValue === 40
      );
    },
    { timeout: timeoutMs },
  ).catch(async () => {
    const events = await page.evaluate(
      () => window.__FULLMAG_CHART_DIAGNOSTICS__?.rangeSelectedEvents ?? [],
    );
    throw new Error(
      `chart range-selected event was not emitted for zoom. Events: ${JSON.stringify(events)}`,
    );
  });
  await page
    .locator(".fm-inspector-panel .fm-analysis-plots__range-clear")
    .waitFor({ state: "visible", timeout: timeoutMs });
  const request = await waitForRowsBinRequest(rowsBinRequests, (path) => {
    const params = queryParams(path);
    const hasVisibleRange = params.has("from_row") || params.has("from_t");
    return hasVisibleRange && !params.has("cursor");
  }, page);
  if (!request) {
    throw new Error(
      "zoom rows.bin request did not include a visible range without cursor",
    );
  }
  await page
    .locator(".fm-inspector-panel .fm-analysis-plots__range-clear")
    .click({ timeout: timeoutMs });
  await page.waitForFunction(
    () => {
      const event =
        window.__FULLMAG_CHART_DIAGNOSTICS__?.rangeSelectedEvents?.at(-1);
      return (
        event?.chartId === "default" &&
        event.tableId === "default" &&
        typeof event.xAxisId === "string" &&
        event.xAxisId.length > 0 &&
        event.range === null
      );
    },
    { timeout: timeoutMs },
  ).catch(async () => {
    const events = await page.evaluate(
      () => window.__FULLMAG_CHART_DIAGNOSTICS__?.rangeSelectedEvents ?? [],
    );
    throw new Error(
      `chart range-selected clear event was not emitted. Events: ${JSON.stringify(events)}`,
    );
  });
  await page
    .locator(".fm-inspector-panel .fm-analysis-plots__range-clear")
    .waitFor({ state: "detached", timeout: timeoutMs });
}

async function collectAnalysisPlotProof(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".fm-analysis-plots");
    const host = root?.querySelector(".fm-analysis-chart-surface") ?? null;
    const canvas = host?.querySelector("canvas") ?? null;
    const rootRect = root?.getBoundingClientRect();
    const hostRect = host?.getBoundingClientRect();
    const inspector = document.querySelector(".fm-inspector-panel");
    const columns = Array.from(
      inspector?.querySelectorAll(".fm-analysis-plots__column-row") ?? [],
    ).map((element) => element.textContent?.trim() ?? "");
    const summary =
      root?.querySelector(".fm-analysis-plots__header span")?.textContent ??
      "";
    const range = Array.from(
      root?.querySelectorAll(".fm-chart-section__footer-row span") ?? [],
    ).map((element) => element.textContent ?? "");
    const legend = Array.from(
      root?.querySelectorAll(".fm-chart-legend__item") ?? [],
    ).map((element) => element.getAttribute("aria-label") ?? "");
    const empty =
      root?.querySelector(".fm-analysis-plots__chart-empty")?.textContent ??
      null;

    let canvasProof = null;
    if (canvas instanceof HTMLCanvasElement) {
      const rect = canvas.getBoundingClientRect();
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        canvasProof = {
          cssHeight: rect.height,
          cssWidth: rect.width,
          height: canvas.height,
          nonTransparent: 0,
          sampled: 0,
          uniqueColors: 0,
          width: canvas.width,
        };
      } else {
        const width = Math.max(1, Math.floor(canvas.width));
        const height = Math.max(1, Math.floor(canvas.height));
        const stepX = Math.max(1, Math.floor(width / 32));
        const stepY = Math.max(1, Math.floor(height / 32));
        const unique = new Set();
        let nonTransparent = 0;
        let sampled = 0;
        for (let y = 0; y < height; y += stepY) {
          for (let x = 0; x < width; x += stepX) {
            const data = ctx.getImageData(x, y, 1, 1).data;
            sampled += 1;
            if (data[3] !== 0) nonTransparent += 1;
            unique.add(`${data[0]},${data[1]},${data[2]},${data[3]}`);
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
    }

    return {
      activeModuleId:
        document
          .querySelector("[data-slot-id='viewport-main']")
          ?.getAttribute("data-active-module-id") ?? null,
      canvas: canvasProof,
      columns,
      empty,
      hasAxisControls: columns.length > 0,
      hostRect: hostRect
        ? { height: hostRect.height, width: hostRect.width }
        : null,
      legend,
      range,
      rootRect: rootRect
        ? { height: rootRect.height, width: rootRect.width }
        : null,
      summary,
    };
  });
}

function validateProof(proof) {
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
  if (!/\d+ rows \/ \d+ columns/.test(proof.summary)) {
    failures.push(`analysis summary did not include rows/columns: ${proof.summary}`);
  }
  if (!proof.range.some((entry) => /[1-9]\d* (pts|rows)/.test(entry))) {
    failures.push(`analysis range did not include visible rows: ${proof.range.join(" | ")}`);
  }
  if (!Array.isArray(proof.legend) || proof.legend.length === 0) {
    failures.push("analysis series legend is missing.");
  } else if (!proof.legend.every((entry) => /.+, unit .+, latest .+/.test(entry))) {
    failures.push(`analysis series legend is incomplete: ${proof.legend.join(" | ")}`);
  }
  if (proof.hasAxisControls && proof.columns.length < 2) {
    failures.push(`analysis column list is too small: ${proof.columns.length}`);
  }
  if (proof.empty) {
    failures.push(`analysis chart still shows empty state: ${proof.empty}`);
  }
  return failures;
}

async function waitForRowsBinRequest(rowsBinRequests, predicate, page) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const request = rowsBinRequests.find(({ path }) => predicate(path));
    if (request) return request;
    await page.waitForTimeout(100);
  }
  return null;
}

function queryParams(path) {
  return new URL(path, "http://control-room.local").searchParams;
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

main().catch((error) => {
  console.error(`Analysis plots smoke failed: ${error.stack ?? error.message}`);
  process.exit(1);
});
