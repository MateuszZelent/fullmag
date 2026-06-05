const apiBase = (
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8081"
).replace(/\/$/, "");
const workspaceUrl =
  process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const timeoutMs = numericEnv("CONTROL_ROOM_CHART_PERFORMANCE_TIMEOUT_MS", 120_000);
const idleObserveMs = numericEnv(
  "CONTROL_ROOM_CHART_PERFORMANCE_IDLE_OBSERVE_MS",
  3_000,
);
const tabSwitches = numericEnv(
  "CONTROL_ROOM_CHART_PERFORMANCE_TAB_SWITCHES",
  100,
);

const ROWS_BIN_PATTERN =
  /^\/v2\/sessions\/current\/data\/tables\/default\/rows\.bin(?:\?|$)/;

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    throw new Error(
      "Chart performance audit requires Playwright or @playwright/test.",
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
    failedResponses.push({
      path: currentSessionPath(response.url()),
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
    await waitForAnalysisChart(page);
    await waitForStableChartDiagnostics(page);
    const idleProofs = [];
    idleProofs.push(await verifyIdleChartBudget(page, rowsBinRequests));
    const lifecycleProof = await verifyChartInstanceLifecycle(
      page,
      tabSwitches,
    );
    idleProofs.push(await verifyIdleChartBudget(page, rowsBinRequests));

    const diagnostics = await collectChartDiagnostics(page);
    const failures = [];
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
      throw new Error("Chart performance audit failed:\n" + failures.join("\n"));
    }

    console.log(
      `Chart performance proof: ${JSON.stringify({
        apiBase,
        diagnostics,
        failedResponses: failedResponses.length,
        idleProofs,
        lifecycleProof,
        tabSwitches,
        workspaceUrl,
      })}`,
    );
    console.log(`Chart performance audit passed at ${workspaceUrl}.`);
  } finally {
    await browser.close();
  }
}

async function openAnalysisPlots(page) {
  const analysisTab = viewportTab(page, /^Analysis$/);
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
  await waitForActiveViewportModule(page, "analysis-plots");
}

async function waitForAnalysisChart(page) {
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".fm-analysis-plots");
      const canvas = root?.querySelector(".fm-analysis-plots__echarts canvas");
      return (
        canvas instanceof HTMLCanvasElement &&
        canvas.width > 0 &&
        canvas.height > 0
      );
    },
    { timeout: timeoutMs },
  );
  await page.waitForFunction(
    () => {
      const diagnostics = window.__FULLMAG_CHART_DIAGNOSTICS__;
      const chartSurfaceCount = document.querySelectorAll(
        ".fm-analysis-plots__echarts canvas",
      ).length;
      return (
        diagnostics &&
        chartSurfaceCount > 0 &&
        diagnostics.activeInstances === chartSurfaceCount &&
        diagnostics.setOptionCalls > 0
      );
    },
    { timeout: timeoutMs },
  );
}

async function waitForStableChartDiagnostics(page) {
  let previous = await collectChartDiagnostics(page);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(250);
    const current = await collectChartDiagnostics(page);
    const chartSurfaceCount = await collectChartSurfaceCount(page);
    if (
      chartSurfaceCount > 0 &&
      current.activeInstances === chartSurfaceCount &&
      current.resizeCalls === previous.resizeCalls &&
      current.setOptionCalls === previous.setOptionCalls
    ) {
      return current;
    }
    previous = current;
  }
  throw new Error(
    `chart diagnostics did not settle: ${JSON.stringify(previous)}`,
  );
}

async function verifyIdleChartBudget(page, rowsBinRequests) {
  await waitForActiveViewportModule(page, "analysis-plots");
  await waitForStableChartDiagnostics(page);
  await waitForQuietRowsBinRequests(page, rowsBinRequests);
  rowsBinRequests.length = 0;
  const beforeSnapshot = await collectChartDataSnapshot(page);
  const before = await collectChartDiagnostics(page);
  await page.waitForTimeout(idleObserveMs);
  const after = await collectChartDiagnostics(page);
  const afterSnapshot = await collectChartDataSnapshot(page);
  const redraws = after.setOptionCalls - before.setOptionCalls;
  if (redraws !== 0 && sameChartDataSnapshot(beforeSnapshot, afterSnapshot)) {
    throw new Error(`chart redraws during idle without data change: ${redraws}`);
  }
  if (rowsBinRequests.length > 0) {
    throw new Error(
      `rows.bin requests during chart idle: ${rowsBinRequests.length} ${summarizeRowsBinRequests(rowsBinRequests)}`,
    );
  }
  return {
    afterSnapshot,
    beforeSnapshot,
    liveRedraws: redraws,
  };
}

async function waitForQuietRowsBinRequests(page, rowsBinRequests) {
  const quietMs = Math.max(1_500, Math.min(idleObserveMs, 3_000));
  const deadline = Date.now() + timeoutMs;
  let lastCount = rowsBinRequests.length;
  let quietSince = Date.now();

  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    if (rowsBinRequests.length !== lastCount) {
      lastCount = rowsBinRequests.length;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietMs) return;
  }

  throw new Error(
    `rows.bin requests did not settle before idle audit: ${rowsBinRequests.length} ${summarizeRowsBinRequests(rowsBinRequests)}`,
  );
}

function summarizeRowsBinRequests(rowsBinRequests) {
  const paths = rowsBinRequests.map((request) => request.path);
  const uniquePaths = Array.from(new Set(paths));
  return JSON.stringify({
    last: paths.slice(-5),
    unique: uniquePaths.slice(-5),
    uniqueCount: uniquePaths.length,
  });
}

async function verifyChartInstanceLifecycle(page, switchCount) {
  const analysisTab = viewportTab(page, /^Analysis$/);
  const viewport3dTab = viewportTab(page, /^3D Viewport$/);
  await viewport3dTab
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });

  for (let index = 0; index < switchCount; index += 1) {
    await viewport3dTab.first().click({ timeout: timeoutMs });
    await waitForActiveViewportModule(page, "viewport-3d");
    await page.waitForFunction(
      () => window.__FULLMAG_CHART_DIAGNOSTICS__?.activeInstances === 0,
      { timeout: timeoutMs },
    );

    await analysisTab.first().click({ timeout: timeoutMs });
    await waitForActiveViewportModule(page, "analysis-plots");
    await waitForAnalysisChart(page);
  }

  const diagnostics = await collectChartDiagnostics(page);
  const chartSurfaceCount = await collectChartSurfaceCount(page);
  if (chartSurfaceCount < 1) {
    throw new Error("chart instance leak: no active chart surfaces");
  }
  if (diagnostics.activeInstances !== chartSurfaceCount) {
    throw new Error(
      `chart instance leak: active=${diagnostics.activeInstances}, surfaces=${chartSurfaceCount}`,
    );
  }
  if (
    diagnostics.createdInstances - diagnostics.disposedInstances !==
    diagnostics.activeInstances
  ) {
    throw new Error(
      `chart instance leak: created=${diagnostics.createdInstances}, disposed=${diagnostics.disposedInstances}, active=${diagnostics.activeInstances}`,
    );
  }
  return {
    activeInstances: diagnostics.activeInstances,
    createdInstances: diagnostics.createdInstances,
    disposedInstances: diagnostics.disposedInstances,
  };
}

async function waitForActiveViewportModule(page, moduleId) {
  await page
    .locator(
      `[data-slot-id='viewport-main'][data-active-module-id='${moduleId}']`,
    )
    .waitFor({ state: "attached", timeout: timeoutMs });
}

function viewportTab(page, text) {
  return page.locator(".fm-viewport-tabs__trigger").filter({ hasText: text });
}

async function collectChartDiagnostics(page) {
  return page.evaluate(
    () =>
      window.__FULLMAG_CHART_DIAGNOSTICS__ ?? {
        activeInstances: 0,
        createdInstances: 0,
        disposedInstances: 0,
        resizeCalls: 0,
        setOptionCalls: 0,
      },
  );
}

async function collectChartSurfaceCount(page) {
  return page.evaluate(
    () =>
      document.querySelectorAll(".fm-analysis-plots__echarts canvas").length,
  );
}

async function collectChartDataSnapshot(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".fm-analysis-plots");
    return {
      rangeText:
        root?.querySelector(".fm-analysis-plots__range span:first-child")
          ?.textContent ?? "",
      visibleText:
        root?.querySelector(".fm-analysis-plots__range span:nth-child(2)")
          ?.textContent ?? "",
    };
  });
}

function sameChartDataSnapshot(left, right) {
  return (
    left.rangeText === right.rangeText &&
    left.visibleText === right.visibleText
  );
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
  console.error(`Chart performance audit failed: ${error.stack ?? error.message}`);
  process.exit(1);
});
