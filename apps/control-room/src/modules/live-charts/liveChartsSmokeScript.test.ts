import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const smokeScriptUrl = new URL(
  "../../../scripts/smoke-live-charts.mjs",
  import.meta.url,
);

describe("Live Charts browser smoke contract", () => {
  it("registers the Live Charts and Quick Chart acceptance commands", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["smoke:live-charts"]).toBe(
      "node scripts/smoke-live-charts.mjs",
    );
    expect(packageJson.scripts?.["smoke:analysis-quick-chart"]).toBe(
      "node scripts/smoke-analysis-quick-chart.mjs",
    );
  });

  it("uses exact dimensionless fixture values and all eight visibility states", () => {
    expect(existsSync(smokeScriptUrl)).toBe(true);
    const source = readFileSync(smokeScriptUrl, "utf8");

    expect(source).toContain("mx: 0.97982");
    expect(source).toContain("my: 0.10317");
    expect(source).toContain("mz: 4.447e-6");
    expect(source).toContain("const VISIBILITY_COMBINATIONS = 2 ** 3");
    expect(source).toContain("verifyExactScientificValues");
    expect(source).toContain("verifyVisibilityMatrix");
    expect(source).toContain("verifyCanonicalCsvExport");
    expect(source).toContain("forbidden prefixed dimensionless label");
  });

  it("gates revision coalescing, retained canvas, layout, and request budgets", () => {
    const source = readFileSync(smokeScriptUrl, "utf8");

    expect(source).toContain("const REVISION_STRESS_COUNT = 100");
    expect(source).toContain("runRevisionStress");
    expect(source).toContain("data-retained");
    expect(source).toContain("blocking loading state appeared after initial payload");
    expect(source).toContain("layout shift exceeded budget");
    expect(source).toContain("coalesced table fetch budget exceeded");
    expect(source).toContain("verifyIrrelevantRevisionBudget");
    expect(source).toContain("local interaction issued a resource request");
    expect(source).toContain("pause issued a payload request");
    expect(source).toContain("resume did not issue exactly one latest payload request");
  });

  it("requires the Live Charts Inspector to open with signal controls", () => {
    const source = readFileSync(smokeScriptUrl, "utf8");

    expect(source).toContain("verifyLiveChartsInspector");
    expect(source).toContain("[data-slot-id='panel-right']");
    expect(source).toContain('getByRole("checkbox", { name: "Show mx" })');
    expect(source).toContain("Live Charts Inspector must expose mx, my, and mz signal controls.");
  });

  it("scopes local-action budgets to Live Charts data resources", () => {
    const source = readFileSync(smokeScriptUrl, "utf8");
    const assertionStart = source.indexOf("function assertNoRequestsSince");
    const assertionEnd = source.indexOf("function viewportTab", assertionStart);
    const assertion = source.slice(assertionStart, assertionEnd);

    expect(source).toContain("const LIVE_CHARTS_OWNED_RESOURCE_PATTERNS");
    expect(source).toContain("/data\\/tables(?:\\/|\\?|$)/");
    expect(source).toContain("/data\\/scalars(?:\\?|$)/");
    expect(source).toContain("/simulation\\/solver\\/energies\\/");
    expect(source).toContain("function liveChartsOwnedRequestsSince");
    expect(assertion).toContain("liveChartsOwnedRequestsSince(evidence, index)");
    expect(assertion).not.toContain("evidence.requests.slice(index)");
    expect(source).toContain("rowsRequestsSince(evidence, requestStart)");
    expect(source).toContain("rowsRequestsSince(evidence, pauseRequestStart)");
    expect(source).toContain("rowsRequestsSince(evidence, resumeRequestStart)");
    expect(source).toContain("waitForRowsRequestCount(page, evidence, resumeRequestStart, 1)");
    expect(source).toContain("async function waitForRowsRequestCount");
    expect(source).toContain("isLiveChartsOwnedPath(url.pathname)");
    expect(source).toContain("owned Live Charts fixture resource is not implemented");
    expect(source).toContain('await route.fulfill({ body: "", headers: cors, status: 204 })');
    expect(source).not.toContain("fixture resource not published");
    expect(source).toContain("liveChartsStatusFixture");
    expect(source).toContain("liveChartsVisualizationStateFixture");
    expect(source).toContain("liveChartsDomainMetaFixture");
    expect(source).toContain("liveChartsUniverseFixture");
  });

  it("scopes Pause and Follow controls to the Live Charts surface", () => {
    const source = readFileSync(smokeScriptUrl, "utf8");
    const flowStart = source.indexOf("async function keyboardPauseAndFollow");
    const flowEnd = source.indexOf("async function runLifecycleStress", flowStart);
    const flow = source.slice(flowStart, flowEnd);

    expect(flow).toContain('const liveCharts = page.locator(".fm-live-charts")');
    expect(flow).toContain('liveCharts.getByRole("button", { name: "Pause", exact: true })');
    expect(flow).toContain('liveCharts.getByRole("button", { name: "Follow", exact: true })');
    expect(flow).not.toContain('page.getByRole("button", { name: "Pause", exact: true })');
    expect(flow).not.toContain('page.getByRole("button", { name: "Follow", exact: true })');
  });

  it("covers keyboard-only scientific interactions and visual variants", () => {
    const source = readFileSync(smokeScriptUrl, "utf8");

    for (const marker of [
      "keyboardSelectSignal",
      "keyboardHideSignal",
      "keyboardShowSignal",
      "keyboardSoloSignal",
      "keyboardResetRange",
      "keyboardPauseAndFollow",
      "keyboardInspectPoint",
      "keyboardExport",
    ]) {
      expect(source).toContain(marker);
    }
    expect(source).toContain('colorScheme: "dark"');
    expect(source).toContain('colorScheme: "light"');
    expect(source).toContain('reducedMotion: "reduce"');
    expect(source).toContain("deviceScaleFactor: 2");
    expect(source).toContain("scrollIntoViewIfNeeded");
    expect(source).toContain("verifyZoomChartViewport");
    expect(source).toContain("zoom chart axes are clipped");
    expect(source).toContain("Live Charts zoom proof");
    expect(source).toContain("live-charts-mocha.png");
    expect(source).toContain("live-charts-latte.png");
    expect(source).toContain("live-charts-reduced-motion.png");
    expect(source).toContain("live-charts-zoom-200.png");

    const keyboardStart = source.indexOf("async function verifyKeyboardInteractions");
    const keyboardEnd = source.indexOf("async function keyboardSelectSignal", keyboardStart);
    const keyboardFlow = source.slice(keyboardStart, keyboardEnd);
    expect(keyboardFlow.indexOf("keyboardSoloSignal")).toBeLessThan(
      keyboardFlow.indexOf("showAllSignals"),
    );
    expect(keyboardFlow.indexOf("showAllSignals")).toBeLessThan(
      keyboardFlow.indexOf("keyboardInspectPoint"),
    );
  });

  it("records and validates renderer, observer, listener, frame, and resource lifecycle", () => {
    const source = readFileSync(smokeScriptUrl, "utf8");

    expect(source).toContain("__FULLMAG_CHART_DIAGNOSTICS__");
    expect(source).toContain("activeInstances");
    expect(source).toContain("createdInstances");
    expect(source).toContain("disposedInstances");
    expect(source).toContain("ResizeObserver");
    expect(source).toContain("addEventListener");
    expect(source).toContain("requestAnimationFrame");
    expect(source).toContain("verifyLifecycleCounters");
    expect(source).toContain("const lifecycleBaseline = await runLifecycleStress(page)");
    expect(source).toContain("counters.activeWorkers !== baseline.activeWorkers");
    expect(source).toContain("counters.activeObjectUrls !== baseline.activeObjectUrls");
    expect(source).not.toContain('counters.activeWorkers !== 0) failures.push(`workers=');
    expect(source).toContain("verifyOneVisibleCanvas");
    expect(source).toContain("verifyNoVisibleErrorNotifications");
    expect(source).toContain("failedResponses: evidence.failedResponses.length");
    expect(source).toContain("proof.failedResponses > 0");
    expect(source).not.toContain("setInterval");
  });
});
