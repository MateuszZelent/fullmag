import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const reportDirectory = process.env.FULLMAG_INSPECTOR_ACTIONS_REPORT_DIR;
const fixtureUrl = process.env.CONTROL_ROOM_URL;
const browserChannel = process.env.FULLMAG_INSPECTOR_ACTIONS_BROWSER_CHANNEL || undefined;

if (!reportDirectory || !fixtureUrl) {
  throw new Error("The managed Inspector actions report directory and fixture URL are required.");
}

await mkdir(reportDirectory, { recursive: true });
const reportPath = resolve(reportDirectory, "inspector-actions-report.json");
const report = {
  schema: "fullmag_inspector_actions_browser_smoke_v1",
  state: "running",
  started_at: new Date().toISOString(),
  fixture_url: fixtureUrl,
  browser_channel: browserChannel || "playwright_chromium",
  qualification: "fixture_callback_only_not_api_end_to_end_or_backend_runtime_or_science",
  backend_api_end_to_end: false,
  fixture_callback_coverage: "production Inspector controls call controlled synthetic fixture callbacks",
  backend_mutation_requests: {
    count: 0,
    path_scope: "/api/v2 mutation requests (POST, PUT, PATCH, DELETE)",
    qualification: "fixture callback coverage only; not API end-to-end",
  },
  react_commit_limit_per_apply_transaction: 32,
  react_commit_observations: [],
  unit_tests: "not_compiled_not_run",
  steps: [],
  screenshots: [],
};
let browser;
let page;
let failure = null;
const backendMutationRequests = [];
const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function capture(name) {
  const path = resolve(reportDirectory, name);
  await page.screenshot({ animations: "disabled", fullPage: true, path });
  report.screenshots.push(path);
}

async function step(id, action) {
  await action();
  report.steps.push({ id, status: "passed" });
}

async function snapshot() {
  return page.evaluate(() => {
    const driver = window.__fullmagInspectorActionsFixture;
    return driver ? driver.read() : null;
  });
}

async function beginApplyTransaction(label) {
  const baseline = await page.evaluate(() => {
    const state = window.__fullmagInspectorActionsFixture?.read();
    if (!state) throw new Error("Inspector fixture driver is unavailable.");
    return state.reactCommits;
  });
  const observation = { label, baseline, observed: baseline, delta: 0 };
  report.react_commit_observations.push(observation);
  return observation;
}

async function assertApplyCommitBound(observation, label) {
  const observed = await page.evaluate(() => {
    const state = window.__fullmagInspectorActionsFixture?.read();
    if (!state) throw new Error("Inspector fixture driver is unavailable.");
    return state.reactCommits;
  });
  const delta = observed - observation.baseline;
  observation.observed = observed;
  observation.delta = delta;
  assert.ok(delta >= 0, label + " reported a decreasing React commit count");
  assert.ok(
    delta < report.react_commit_limit_per_apply_transaction,
    label + " exceeded the bounded React commit count for one Apply transaction",
  );
}

async function setMode(mode) {
  await page.evaluate((next) => {
    const driver = window.__fullmagInspectorActionsFixture;
    if (!driver) throw new Error("Inspector fixture driver is unavailable.");
    driver.setMode(next);
  }, mode);
}

async function setTarget(target) {
  await page.evaluate((next) => {
    const driver = window.__fullmagInspectorActionsFixture;
    if (!driver) throw new Error("Inspector fixture driver is unavailable.");
    driver.setDescriptor(next);
  }, target);
}

async function assertNoIsolate(inspector) {
  assert.equal(await inspector.getByRole("button", { name: "Isolate", exact: true }).count(), 0);
  assert.equal(await inspector.getByText("Isolate", { exact: true }).count(), 0);
}

async function assertNoOpacityTransitions(inspector, label) {
  const violations = await inspector.locator("button, [role='tab'], [data-slot='inspector-group-content']").evaluateAll((nodes) =>
    nodes.flatMap((node) => {
      const style = getComputedStyle(node);
      const properties = style.transitionProperty.split(",").map((value) => value.trim());
      const durations = style.transitionDuration.split(",").map((value) => value.trim());
      const hasOpacityTransition = properties.some((property, index) => {
        if (property !== "opacity" && property !== "all") return false;
        const duration = durations[index % durations.length] || "0s";
        return Number.parseFloat(duration) > 0;
      });
      const hasOpacityAnimation = node.getAnimations().some((animation) =>
        animation.effect?.getKeyframes().some((frame) => Object.hasOwn(frame, "opacity")),
      );
      if (!hasOpacityTransition && !hasOpacityAnimation) return [];
      return [{
        control: node.getAttribute("aria-label") || node.textContent?.trim() || node.tagName,
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        opacityAnimation: hasOpacityAnimation,
      }];
    }),
  );
  assert.deepEqual(violations, [], label + " has active opacity transitions on Inspector controls");
}

async function pinIdentity() {
  await page.evaluate(() => {
    const root = document.querySelector('[aria-label="Inspector"]');
    const viewport = root?.querySelector(".fm-inspector__content [data-radix-scroll-area-viewport]");
    const apply = root?.querySelector(".fm-inspector__action-btn--apply");
    const field = root?.querySelector('[data-testid="inspector-actions-stable-field"]');
    const target = window.__fullmagInspectorActionsFixture?.read().target;
    if (!root || !viewport || !apply || !(field instanceof HTMLInputElement) || !target) {
      throw new Error("Inspector identity targets are unavailable.");
    }
    window.__inspectorActionsIdentity = {
      apply,
      field,
      fieldDisabled: field.disabled,
      fieldOpacity: getComputedStyle(field).opacity,
      fieldValue: field.value,
      target,
      owner: root.getAttribute("data-inspector-owner"),
      root,
      scrollTop: viewport.scrollTop,
      viewport,
    };
  });
}

async function assertPinnedIdentity(label) {
  const identity = await page.evaluate(() => {
    const before = window.__inspectorActionsIdentity;
    const root = document.querySelector('[aria-label="Inspector"]');
    const viewport = root?.querySelector(".fm-inspector__content [data-radix-scroll-area-viewport]");
    return {
      activeField: Boolean(before && document.activeElement === before.field),
      applySame: Boolean(before && before.apply === root?.querySelector(".fm-inspector__action-btn--apply")),
      fieldSame: Boolean(before && before.field === root?.querySelector('[data-testid="inspector-actions-stable-field"]')),
      fieldDisabled: Boolean(before?.fieldDisabled),
      fieldDisabledSame: Boolean(before && before.field instanceof HTMLInputElement && before.field.disabled === before.fieldDisabled),
      fieldOpacity: before?.fieldOpacity ?? null,
      fieldOpacitySame: Boolean(before && before.field instanceof HTMLInputElement && getComputedStyle(before.field).opacity === before.fieldOpacity),
      fieldValueSame: Boolean(before && before.field instanceof HTMLInputElement && before.field.value === before.fieldValue),
      ownerSame: Boolean(before && before.owner === root?.getAttribute("data-inspector-owner")),
      rootSame: Boolean(before && before.root === root),
      targetSame: Boolean(before && before.target === window.__fullmagInspectorActionsFixture?.read().target),
      scrollTopSame: Boolean(before && viewport && Math.abs(before.scrollTop - viewport.scrollTop) < 1),
      viewportSame: Boolean(before && before.viewport === viewport),
    };
  });
  assert.equal(identity.rootSame, true, label + " remounted the Inspector root");
  assert.equal(identity.ownerSame, true, label + " changed the selected Inspector owner");
  assert.equal(identity.targetSame, true, label + " changed the selected descriptor target");
  assert.equal(identity.viewportSame, true, label + " remounted the Inspector scroll viewport");
  assert.equal(identity.applySame, true, label + " remounted the staged Apply control");
  assert.equal(identity.scrollTopSame, true, label + " changed the Inspector scroll position");
  assert.equal(identity.fieldSame, true, label + " replaced the unrelated Inspector field");
  assert.equal(identity.fieldDisabled, false, label + " began with an unrelated field already disabled");
  assert.equal(identity.fieldDisabledSame, true, label + " changed the unrelated field disabled state");
  assert.equal(identity.fieldOpacitySame, true, label + " changed the unrelated field computed opacity");
  assert.equal(identity.activeField, true, label + " moved focus away from the unrelated Inspector field");
  assert.equal(identity.fieldValueSame, true, label + " changed the unrelated Inspector field value");
}

try {
  browser = await chromium.launch({ channel: browserChannel, headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/^\/api\/v2(?:\/|$)/.test(url.pathname) && mutatingMethods.has(request.method())) {
      backendMutationRequests.push({ method: request.method(), path: url.pathname });
    }
  });
  page.setDefaultTimeout(12_000);
  await page.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__fullmagInspectorActionsFixture));
  const inspector = page.getByRole("region", { name: "Inspector" });
  await inspector.locator('footer[data-edit-mode="staged"]').waitFor();
  await inspector.locator(".fm-inspector__action-btn--apply").waitFor();

  await step("object-staged-validation-and-production-controls", async () => {
    assert.equal(await inspector.getByRole("heading", { name: "Fixture Object" }).count(), 1);
    const apply = inspector.getByRole("button", { name: "Apply", exact: true });
    assert.equal(await apply.count(), 1);
    assert.equal(await apply.isDisabled(), true);
    assert.match(
      (await inspector.locator(".fm-inspector__action-reason").textContent()) || "",
      /Resolve validation errors before applying/,
    );
    assert.equal((await snapshot()).applyCalls, 0);
    await assertNoIsolate(inspector);
    await assertNoOpacityTransitions(inspector, "wide invalid Object");
    await capture("inspector-actions-object-wide-invalid.png");
  });

  await step("production-group-disclosure-preserves-input", async () => {
    const trigger = inspector.getByRole("button", { name: "Fixture details", exact: true });
    const field = inspector.getByRole("textbox", { name: "Unchanged fixture field", exact: true });
    const content = inspector.locator('[data-slot="inspector-group-content"]');
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    assert.equal(await field.inputValue(), "keep-this-value");
    await assertNoOpacityTransitions(inspector, "open InspectorGroup");
    await trigger.click();
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    assert.equal(await content.isHidden(), true);
    await assertNoOpacityTransitions(inspector, "closed InspectorGroup");
    await trigger.click();
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    assert.equal(await field.inputValue(), "keep-this-value");
    await assertNoOpacityTransitions(inspector, "reopened InspectorGroup");
    await field.fill("preserve-through-actions");
    await field.focus();
    await capture("inspector-actions-object-wide-group-open.png");
  });

  await step("apply-pending-rejected-ack-and-stable-target", async () => {
    await page.evaluate(() => {
      const driver = window.__fullmagInspectorActionsFixture;
      if (!driver) throw new Error("Inspector fixture driver is unavailable.");
      driver.setValid(true);
    });
    const apply = inspector.locator(".fm-inspector__action-btn--apply");
    await page.waitForFunction(() => {
      const button = document.querySelector(".fm-inspector__action-btn--apply");
      return button && !button.disabled;
    });
    const viewport = inspector.locator(".fm-inspector__content [data-radix-scroll-area-viewport]");
    await viewport.evaluate((element) => {
      element.scrollTop = Math.min(180, element.scrollHeight - element.clientHeight);
    });
    const stableField = inspector.getByRole("textbox", { name: "Unchanged fixture field", exact: true });
    await stableField.evaluate((element) => element.focus({ preventScroll: true }));
    await pinIdentity();
    const rejectedTransaction = await beginApplyTransaction("rejected-ack");
    await page.evaluate(() => {
      const button = document.querySelector(".fm-inspector__action-btn--apply");
      if (!(button instanceof HTMLButtonElement)) throw new Error("Production Apply button is unavailable.");
      button.click();
    });
    await page.getByRole("button", { name: "Applying…", exact: true }).waitFor();
    assert.equal(await apply.isDisabled(), true);
    await page.waitForFunction(() => {
      const state = window.__fullmagInspectorActionsFixture?.read();
      return state?.applyCalls === 1 && state.pending;
    });
    assert.equal((await snapshot()).applyCalls, 1);
    assert.equal((await snapshot()).pending, true);
    await assertPinnedIdentity("pending Apply");
    await assertApplyCommitBound(rejectedTransaction, "pending Apply");
    await assertNoOpacityTransitions(inspector, "pending Apply");
    await capture("inspector-actions-object-wide-pending.png");

    await page.evaluate(() => {
      const driver = window.__fullmagInspectorActionsFixture;
      if (!driver) throw new Error("Inspector fixture driver is unavailable.");
      driver.settleApply(false);
    });
    await inspector.getByRole("alert").waitFor();
    assert.match((await inspector.getByRole("alert").textContent()) || "", /Apply did not finish/);
    await page.waitForFunction(() =>
      window.__fullmagInspectorActionsFixture?.read().lastApplyAck === false,
    );
    assert.equal((await snapshot()).lastApplyAck, false);
    assert.equal((await snapshot()).dirty, true);
    await assertPinnedIdentity("rejected Apply ACK");
    await assertApplyCommitBound(rejectedTransaction, "rejected Apply ACK");
    await assertNoOpacityTransitions(inspector, "rejected Apply ACK");
    await capture("inspector-actions-object-wide-rejected-ack.png");

    const acceptedTransaction = await beginApplyTransaction("accepted-ack");
    await page.evaluate(() => {
      const button = document.querySelector(".fm-inspector__action-btn--apply");
      if (!(button instanceof HTMLButtonElement)) throw new Error("Production Apply button is unavailable.");
      button.click();
    });
    await page.getByRole("button", { name: "Applying…", exact: true }).waitFor();
    await page.waitForFunction(() => {
      const state = window.__fullmagInspectorActionsFixture?.read();
      return state?.applyCalls === 2 && state.pending;
    });
    assert.equal((await snapshot()).applyCalls, 2);
    await assertPinnedIdentity("second pending Apply");
    await assertApplyCommitBound(acceptedTransaction, "second pending Apply");
    await page.evaluate(() => {
      const driver = window.__fullmagInspectorActionsFixture;
      if (!driver) throw new Error("Inspector fixture driver is unavailable.");
      driver.settleApply(true);
    });
    await inspector.getByRole("button", { name: "Apply", exact: true }).waitFor();
    await page.waitForFunction(() => {
      const state = window.__fullmagInspectorActionsFixture?.read();
      return state?.lastApplyAck === true && !state.dirty;
    });
    assert.equal((await snapshot()).lastApplyAck, true);
    assert.equal((await snapshot()).dirty, false);
    await assertPinnedIdentity("accepted Apply ACK");
    await assertApplyCommitBound(acceptedTransaction, "accepted Apply ACK");
    await capture("inspector-actions-object-wide-accepted-ack.png");
  });

  await step("revert-and-real-focus-callbacks", async () => {
    await setMode("staged");
    await page.waitForFunction(() => {
      const state = window.__fullmagInspectorActionsFixture?.read();
      return state?.mode === "staged" && state.dirty;
    });
    const revert = inspector.getByRole("button", { name: "Revert", exact: true });
    assert.equal(await revert.isEnabled(), true);
    await revert.click();
    await page.waitForFunction(() => {
      const state = window.__fullmagInspectorActionsFixture?.read();
      return state?.resetCalls === 1 && state.dirty === false;
    });
    assert.equal((await snapshot()).lastResetMode, "staged");
    await inspector.getByRole("button", { name: "Fit view", exact: true }).click();
    assert.equal((await snapshot()).focusCalls, 1);
    await assertNoOpacityTransitions(inspector, "staged Revert and Fit view");
    await capture("inspector-actions-object-wide-reverted.png");
  });

  await step("immediate-session-keeps-actions-in-panel", async () => {
    await setMode("immediate");
    await page.waitForFunction(() => {
      const state = window.__fullmagInspectorActionsFixture?.read();
      return state?.mode === "immediate";
    });
    await inspector.locator('footer[data-edit-mode="immediate"]').waitFor();
    assert.equal(await inspector.locator(".fm-inspector__action-btn--apply").count(), 0);
    assert.equal(await inspector.getByRole("button", { name: "Revert", exact: true }).count(), 0);
    assert.equal(await inspector.getByRole("button", { name: "Reset display", exact: true }).count(), 0);
    assert.match(
      (await inspector.locator(".fm-inspector__action-reason").textContent()) || "",
      /Use the actions in this panel/,
    );
    await assertNoIsolate(inspector);
    await assertNoOpacityTransitions(inspector, "immediate Object session");
    await capture("inspector-actions-object-wide-immediate.png");
  });

  await step("airbox-live-display-reset-at-narrow-width", async () => {
    await setTarget("airbox");
    await setMode("liveViewport");
    await page.waitForFunction(() => {
      const state = window.__fullmagInspectorActionsFixture?.read();
      return state?.target === "airbox" && state.mode === "liveViewport";
    });
    await inspector.locator('footer[data-edit-mode="liveViewport"]').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await inspector.getByRole("heading", { name: "Airbox" }).waitFor();
    const apply = inspector.locator(".fm-inspector__action-btn--apply");
    const reset = inspector.getByRole("button", { name: "Reset display", exact: true });
    assert.equal(await apply.count(), 0);
    assert.equal(await reset.count(), 1);
    assert.equal(await reset.isEnabled(), true);
    await assertNoIsolate(inspector);
    await assertNoOpacityTransitions(inspector, "narrow live Airbox");
    const dimensions = await page.evaluate(() => ({
      inspectorWidth: document.querySelector('[aria-label="Inspector"]')?.getBoundingClientRect().width ?? 0,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    assert.equal(dimensions.inspectorWidth, 390);
    assert.ok(dimensions.pageWidth <= dimensions.viewportWidth, "narrow Inspector caused horizontal page overflow");
    await capture("inspector-actions-airbox-narrow-live.png");

    await reset.click();
    await page.waitForFunction(() => {
      const state = window.__fullmagInspectorActionsFixture?.read();
      return state?.resetCalls === 2 && state.lastResetMode === "liveViewport" && state.dirty === false;
    });
    assert.equal(await reset.count(), 1);
    assert.equal(await reset.isDisabled(), true);
    await capture("inspector-actions-airbox-narrow-reset.png");
  });

  await step("read-only-no-session-has-no-edit-actions", async () => {
    await setMode(null);
    await page.waitForFunction(() =>
      document.querySelector('[aria-label="Inspector"] footer[data-edit-mode="none"]'),
    );
    assert.equal(await inspector.locator(".fm-inspector__action-btn--apply").count(), 0);
    assert.equal(await inspector.getByRole("button", { name: "Reset display", exact: true }).count(), 0);
    assert.equal((await snapshot()).mode, null);
    await assertNoIsolate(inspector);
    await assertNoOpacityTransitions(inspector, "read-only Airbox with no session");
    await capture("inspector-actions-airbox-narrow-readonly.png");
  });

  report.final_snapshot = await snapshot();
  report.fixture_callback_counts = {
    apply_calls: report.final_snapshot.applyCalls,
    reset_calls: report.final_snapshot.resetCalls,
    focus_calls: report.final_snapshot.focusCalls,
  };
  report.backend_mutation_requests.count = backendMutationRequests.length;
  report.backend_mutation_requests.observed = backendMutationRequests;
  assert.deepEqual(backendMutationRequests, [], "fixture unexpectedly sent a backend /api/v2 mutation request");
  report.state = "passed";
} catch (error) {
  failure = error;
  report.state = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  if (page) {
    try {
      await capture("inspector-actions-failed.png");
    } catch (captureError) {
      report.screenshot_error = captureError instanceof Error ? captureError.message : String(captureError);
    }
  }
} finally {
  report.finished_at = new Date().toISOString();
  report.backend_mutation_requests.count = backendMutationRequests.length;
  report.backend_mutation_requests.observed = backendMutationRequests;
  if (browser) await browser.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
}

console.log(JSON.stringify({
  report: reportPath,
  screenshots: report.screenshots,
  backend_mutation_requests: report.backend_mutation_requests,
  backend_api_end_to_end: report.backend_api_end_to_end,
  react_commit_limit_per_apply_transaction: report.react_commit_limit_per_apply_transaction,
  react_commit_observations: report.react_commit_observations,
  state: report.state,
}));
if (failure) {
  console.error(failure instanceof Error ? failure.stack || failure.message : String(failure));
  process.exitCode = 1;
}
