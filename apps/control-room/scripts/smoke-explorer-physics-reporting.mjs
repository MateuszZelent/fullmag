import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const reportDirectory = process.env.FULLMAG_EXPLORER_PHYSICS_REPORTING_REPORT_DIR;
const fixtureUrl = process.env.CONTROL_ROOM_URL;
const browserChannel = process.env.FULLMAG_EXPLORER_PHYSICS_REPORTING_BROWSER_CHANNEL || undefined;

if (!reportDirectory || !fixtureUrl) {
  throw new Error("The managed Explorer physics reporting report directory and fixture URL are required.");
}

await mkdir(reportDirectory, { recursive: true });
const reportPath = resolve(reportDirectory, "explorer-physics-reporting-report.json");
const expectedApiInstance = new URL(fixtureUrl).searchParams.get("fullmag_api_instance");
if (!expectedApiInstance) {
  throw new Error("The managed Explorer physics reporting URL must pin fullmag_api_instance.");
}
const report = {
  schema: "fullmag_explorer_physics_reporting_browser_smoke_v1",
  state: "running",
  started_at: new Date().toISOString(),
  fixture_path: new URL(fixtureUrl).pathname,
  browser_channel: browserChannel || "playwright_chromium",
  qualification: "production_explorer_tree_fixture_only_not_api_end_to_end_backend_runtime_or_science",
  backend_api_end_to_end: false,
  production_path: "modelTreeSnapshotFromScene -> buildModelTree -> ExplorerTreeView",
  api_instance_query_present: Boolean(expectedApiInstance),
  api_responses: {
    contract_version: "1.0.0",
    pinned_instance_echoed: true,
    session_collection: "/v2/sessions",
    no_session_status: "/v2/sessions/current/status",
    health: "/v2/platform/health",
  },
  api_requests: [],
  page_errors: [],
  session_status_get_count: 0,
  cors_preflights: [],
  unexpected_gets: [],
  blocked_mutation_requests: [],
  blocked_mutation_preflights: [],
  steps: [],
  screenshots: [],
  unit_tests: "not_compiled_not_run",
  frontend: "managed Next dev route compilation",
  backend_builds: "not_run",
};

let browser;
let page;
let failure = null;
const pageErrors = [];
const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const responseHeadersFor = (requestHeaders) => {
  const headers = {
    "content-type": "application/json",
    "x-api-contract-version": "1.0.0",
  };
  const requestInstance = requestHeaders["x-fullmag-api-instance"];
  if (requestInstance) headers["x-fullmag-api-instance"] = requestInstance;
  const origin = requestHeaders.origin;
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-credentials"] = "true";
    headers.vary = "Origin";
  }
  return headers;
};

async function capture(name) {
  const path = resolve(reportDirectory, name);
  await page.screenshot({ animations: "disabled", fullPage: true, path });
  report.screenshots.push(path);
}

async function step(id, action) {
  await action();
  report.steps.push({ id, status: "passed" });
}

function interactionNodeId(objectId, kind) {
  return `model:object:${objectId}:magnetic-parameters:${kind}`;
}

async function assertInteraction(tree, objectId, kind, expected) {
  const row = tree.locator(`[data-node-id="${interactionNodeId(objectId, kind)}"]`);
  await row.waitFor();
  assert.equal(await row.getAttribute("data-status"), expected.status);
  assert.equal(await row.locator(".fm-explorer-tree-row__badge").textContent(), expected.badge);
}

try {
  browser = await chromium.launch({ channel: browserChannel, headless: true });
  page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/v2/")) {
      await route.continue();
      return;
    }

    const method = request.method();
    const headers = request.headers();
    const responseHeaders = responseHeadersFor(headers);
    if (method === "OPTIONS") {
      const requestedMethod = headers["access-control-request-method"]?.toUpperCase();
      report.cors_preflights.push({ path: url.pathname, requested_method: requestedMethod || null });
      if (requestedMethod && requestedMethod !== "GET") {
        report.blocked_mutation_preflights.push({ path: url.pathname, requested_method: requestedMethod });
      }
      responseHeaders["access-control-allow-methods"] = "GET, OPTIONS";
      responseHeaders["access-control-allow-headers"] = headers["access-control-request-headers"] || "*";
      await route.fulfill({ status: 204, headers: responseHeaders });
      return;
    }

    report.api_requests.push({
      method,
      path: url.pathname,
      has_api_instance_header: Boolean(headers["x-fullmag-api-instance"]),
      api_instance_matches_url: headers["x-fullmag-api-instance"] === expectedApiInstance,
    });

    if (mutatingMethods.has(method)) {
      report.blocked_mutation_requests.push({ method, path: url.pathname });
      await route.fulfill({
        status: 405,
        headers: responseHeaders,
        body: JSON.stringify({ code: "fixture_mutation_blocked", message: "This browser fixture does not permit API mutations." }),
      });
      return;
    }

    if (method !== "GET") {
      report.unexpected_gets.push({ method, path: url.pathname });
      await route.fulfill({
        status: 404,
        headers: responseHeaders,
        body: JSON.stringify({ code: "fixture_method_not_stubbed", path: url.pathname }),
      });
      return;
    }

    if (url.pathname === "/v2/sessions") {
      await route.fulfill({
        status: 200,
        headers: responseHeaders,
        body: JSON.stringify({ schema_version: "fullmag.session-list.v1", sessions: [] }),
      });
      return;
    }
    if (url.pathname === "/v2/platform/instances") {
      await route.fulfill({
        status: 200,
        headers: responseHeaders,
        body: JSON.stringify({
          first_port: 3197,
          instances: [],
          last_port: 3260,
          schema_version: "1.0.0",
          self_api_instance_id: "fixture-instance",
        }),
      });
      return;
    }
    if (url.pathname === "/v2/platform/health") {
      await route.fulfill({
        status: 200,
        headers: responseHeaders,
        body: JSON.stringify({
          active_session: false,
          api_contract_version: "1.0.0",
          status: "ok",
          uptime_seconds: 1,
        }),
      });
      return;
    }
    if (url.pathname === "/v2/sessions/current/status") {
      report.session_status_get_count += 1;
      await route.fulfill({
        status: 404,
        headers: responseHeaders,
        body: JSON.stringify({ code: "no_active_session", message: "The fixture has no active session." }),
      });
      return;
    }

    report.unexpected_gets.push({ method, path: url.pathname });
    await route.fulfill({
      status: 404,
      headers: responseHeaders,
      body: JSON.stringify({ code: "fixture_get_not_stubbed", path: url.pathname }),
    });
  });

  await page.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
  const tree = page.getByRole("tree", { name: "Explorer tree" });
  await tree.waitFor();
  await page.getByTestId("explorer-physics-reporting-scenario").waitFor();

  await step("zero-and-missing-material-values-produce-no-dmi-rows", async () => {
    for (const objectId of ["zero-dmi-film", "missing-dmi-film"]) {
      assert.equal(await tree.locator(`[data-node-id="model:object:${objectId}"]`).count(), 1);
      await assertInteraction(tree, objectId, "exchange", { badge: "active", status: "ready" });
      await assertInteraction(tree, objectId, "demag", { badge: "active", status: "ready" });
      assert.equal(await tree.locator(`[data-node-id*="model:object:${objectId}:magnetic-parameters:interfacial_dmi"]`).count(), 0);
      assert.equal(await tree.locator(`[data-node-id*="model:object:${objectId}:magnetic-parameters:bulk_dmi"]`).count(), 0);
    }
    await capture("explorer-physics-reporting-zero-and-missing.png");
  });

  await step("signed-nonzero-material-values-render-active-dmi", async () => {
    await page.getByRole("button", { name: "Positive and negative DMI", exact: true }).click();
    await page.getByTestId("explorer-physics-reporting-scenario").filter({ hasText: "Positive and negative DMI" }).waitFor();
    for (const objectId of ["positive-dmi-film", "negative-dmi-film"]) {
      await assertInteraction(tree, objectId, "interfacial_dmi", { badge: "active", status: "ready" });
      await assertInteraction(tree, objectId, "bulk_dmi", { badge: "active", status: "ready" });
    }
    await capture("explorer-physics-reporting-signed-nonzero.png");
  });

  await step("explicit-stack-study-flags-trimming-and-nonmagnetic-roles", async () => {
    await page.getByRole("button", { name: "Explicit stack and Study overrides", exact: true }).click();
    await page.getByTestId("explorer-physics-reporting-scenario").filter({ hasText: "Explicit stack and Study overrides" }).waitFor();
    await assertInteraction(tree, "explicit-stack-film", "exchange", { badge: "disabled", status: "degraded" });
    await assertInteraction(tree, "explicit-stack-film", "demag", { badge: "active", status: "ready" });
    await assertInteraction(tree, "explicit-stack-film", "interfacial_dmi", { badge: "disabled", status: "degraded" });
    await assertInteraction(tree, "explicit-stack-film", "bulk_dmi", { badge: "active", status: "ready" });
    await assertInteraction(tree, "explicit-stack-film", "uniaxial_anisotropy", { badge: "disabled", status: "degraded" });
    assert.equal(await tree.locator('[data-node-id="model:object:explicit-stack-film:magnetic-parameters:unknown_future_interaction"]').count(), 0);

    for (const objectId of ["auxiliary-with-stack", "antenna-with-stack"]) {
      assert.equal(await tree.locator(`[data-node-id="model:object:${objectId}"]`).count(), 1);
      for (const kind of ["exchange", "demag", "interfacial_dmi", "bulk_dmi", "uniaxial_anisotropy"]) {
        assert.equal(await tree.locator(`[data-node-id="${interactionNodeId(objectId, kind)}"]`).count(), 0);
      }
    }
    await capture("explorer-physics-reporting-explicit-overrides.png");
  });

  await step("antenna-readiness-reasons-and-source-spectrum", async () => {
    await page.getByRole("button", { name: "Antenna readiness and source spectrum", exact: true }).click();
    const row = suffix => tree.locator(`[data-node-id="model:object:antenna:antenna:${suffix}"]`);
    const description = row => row.locator(".fm-explorer-tree-row__description").innerText();
    const configured = row("port:configured-port"), broken = row("port:broken-port"), solve = row("solution:blocked-solve");
    await configured.waitFor();
    const regional = row("regional");
    assert.equal(await regional.getAttribute("data-status"), "unavailable");
    assert.equal(await regional.locator(".fm-explorer-tree-row__badge").innerText(), "not configured");
    assert.match(await description(regional), /No regional field source is assigned/);
    assert.equal(await configured.getAttribute("aria-describedby"), await configured.locator(".fm-explorer-tree-row__description").getAttribute("id"));
    assert.equal(await configured.getAttribute("data-status"), "ready");
    assert.match(await description(configured), /qualification still require execution/);
    assert.match(await configured.locator(".fm-explorer-tree-row__badge").innerText(), /configured/);
    assert.equal(await broken.getAttribute("data-status"), "warning");
    assert.equal(await broken.locator(".fm-explorer-tree-row__status").textContent(), "Needs review");
    assert.match(await description(broken), /missing-transport.*missing or ambiguous/);
    assert.equal(await solve.getAttribute("data-status"), "validation-blocked");
    assert.equal(await solve.locator(".fm-explorer-tree-row__status").textContent(), "Blocked");
    assert.match(await description(solve), /missing current transport/);
    assert.equal(await row("spectrum:source-k").locator(".fm-explorer-tree-row__label").innerText(), "Source spectrum 1");
    assert.match(await description(row("spectrum:source-k")), /Spectrum request ID: source-k/);
    assert.match(await description(row("spectrum:source-k")), /not a measured magnetization response/);
    await solve.scrollIntoViewIfNeeded();
    await capture("explorer-antenna-readiness.png");
  });

  await step("regional-source-status-requires-explicit-binding", async () => {
    await page.getByRole("button", { name: "Explicit regional source bindings", exact: true }).click();
    for (const [objectId, status, badge] of [["active", "ready", "configured"], ["disabled", "degraded", "disabled"], ["legacy", "warning", "migration required"]]) {
      const row = tree.locator(`[data-node-id="model:object:${objectId}:antenna:regional"]`);
      await row.waitFor();
      assert.equal(await row.getAttribute("data-status"), status);
      assert.equal(await row.locator(".fm-explorer-tree-row__badge").innerText(), badge);
      assert.match(await row.locator(".fm-explorer-tree-row__description").textContent(), objectId === "legacy" ? /migrate it explicitly/ : /does not solve conductor current/);
    }
    await capture("explorer-explicit-regional-sources.png");
  });

  assert.ok(report.api_requests.some((request) => request.path === "/v2/sessions"));
  report.session_status_get_count = report.api_requests.filter(
    (request) => request.path === "/v2/sessions/current/status",
  ).length;
  assert.equal(report.blocked_mutation_requests.length, 0, "the fixture observed a backend mutation request");
  assert.equal(report.blocked_mutation_preflights.length, 0, "the fixture observed a mutating CORS preflight");
  assert.deepEqual(report.unexpected_gets, [], "the fixture observed an unexpected API read");
  assert.ok(report.api_requests.every((request) => request.api_instance_matches_url), "the typed API client did not preserve the URL-pinned API instance");
  assert.deepEqual(pageErrors, [], "the fixture reported an uncaught browser page error");
  report.page_errors = [...pageErrors];
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  if (page) {
    try {
      await capture("explorer-physics-reporting-failure.png");
    } catch {
      // Preserve the original failure if the browser could not capture a screenshot.
    }
  }
} finally {
  report.finished_at = new Date().toISOString();
  report.state = failure ? "failed" : "passed";
  report.page_errors = [...pageErrors];
  report.failure = failure
    ? { message: failure.message, stack: failure.stack || null }
    : null;
  report.api_mutation_request_count = report.blocked_mutation_requests.length;
  report.unexpected_get_count = report.unexpected_gets.length;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (browser) await browser.close();
}

if (failure) throw failure;
