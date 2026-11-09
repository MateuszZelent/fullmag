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
  fixture_callback_coverage: "production Object/Airbox Inspector controls and StudyRuntimeSection retry call controlled synthetic fixture callbacks",
  study_compute_retry_coverage: "synthetic callback only; not a backend API, runtime, or science submission",
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
let initialTheme = "dark";
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

async function setRetryState(state) {
  await page.evaluate((next) => {
    const driver = window.__fullmagInspectorActionsFixture;
    if (!driver) throw new Error("Inspector fixture driver is unavailable.");
    driver.setRetryState(next);
  }, state);
}

async function setDocumentTheme(theme) {
  await page.evaluate((next) => {
    if (document.documentElement.dataset.theme !== next) {
      window.dispatchEvent(new Event("fullmag:theme-toggle"));
    }
  }, theme);
  await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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

async function pinStudyRetryIdentity() {
  await page.evaluate(() => {
    const root = document.querySelector('[aria-label="Inspector"]');
    const viewport = root?.querySelector(".fm-inspector__content [data-radix-scroll-area-viewport]");
    const runtimeGroup = Array.from(root?.querySelectorAll('[data-slot="inspector-group"]') ?? [])
      .find((group) => group.querySelector("h3")?.textContent?.trim() === "Runtime");
    const toolbars = Array.from(runtimeGroup?.querySelectorAll(".fm-inspector-toolbar") ?? []);
    const toolbar = toolbars.find((candidate) =>
      Array.from(candidate.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Compute"),
    );
    const buttons = Array.from(toolbar?.querySelectorAll("button") ?? []);
    const compute = buttons.find((button) => button.textContent?.trim() === "Compute");
    const build = buttons.find((button) => button.textContent?.trim() === "Build + Study");
    const fit = Array.from(root?.querySelectorAll("button") ?? []).find((button) =>
      button.getAttribute("aria-label") === "Fit view" || button.textContent?.trim() === "Fit view",
    );
    if (!root || !viewport || !runtimeGroup || !toolbar || !compute || !build || !fit) {
      throw new Error("Study retry Inspector identity targets are unavailable.");
    }
    window.__inspectorActionsRetryIdentity = { build, compute, fit, root, runtimeGroup, toolbar, viewport };
  });
}

async function assertStudyRetryIdentity(label) {
  const identity = await page.evaluate(() => {
    const before = window.__inspectorActionsRetryIdentity;
    const root = document.querySelector('[aria-label="Inspector"]');
    const viewport = root?.querySelector(".fm-inspector__content [data-radix-scroll-area-viewport]");
    const runtimeGroup = Array.from(root?.querySelectorAll('[data-slot="inspector-group"]') ?? [])
      .find((group) => group.querySelector("h3")?.textContent?.trim() === "Runtime");
    const toolbars = Array.from(runtimeGroup?.querySelectorAll(".fm-inspector-toolbar") ?? []);
    const toolbar = toolbars.find((candidate) =>
      Array.from(candidate.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Compute"),
    );
    const buttons = Array.from(toolbar?.querySelectorAll("button") ?? []);
    const compute = buttons.find((button) => button.textContent?.trim() === "Compute");
    const build = buttons.find((button) => button.textContent?.trim() === "Build + Study");
    const fit = Array.from(root?.querySelectorAll("button") ?? []).find((button) =>
      button.getAttribute("aria-label") === "Fit view" || button.textContent?.trim() === "Fit view",
    );
    return {
      activeFit: Boolean(before && document.activeElement === before.fit),
      buildSame: Boolean(before && before.build === build),
      computeSame: Boolean(before && before.compute === compute),
      fitEnabled: Boolean(before?.fit instanceof HTMLButtonElement && !before.fit.disabled),
      fitSame: Boolean(before && before.fit === fit),
      rootSame: Boolean(before && before.root === root),
      runtimeGroupSame: Boolean(before && before.runtimeGroup === runtimeGroup),
      toolbarSame: Boolean(before && before.toolbar === toolbar),
      viewportSame: Boolean(before && before.viewport === viewport),
    };
  });
  for (const key of ["rootSame", "viewportSame", "runtimeGroupSame", "toolbarSame", "computeSame", "buildSame", "fitSame", "activeFit", "fitEnabled"]) {
    assert.equal(identity[key], true, label + " changed retry or normal-control identity/focus: " + key);
  }
}

async function assertNoHorizontalOverflow(label) {
  const widths = await page.evaluate(() => {
    const inspector = document.querySelector('[aria-label="Inspector"]');
    const viewport = inspector?.querySelector(".fm-inspector__content [data-radix-scroll-area-viewport]");
    const runtimeGroup = Array.from(inspector?.querySelectorAll('[data-slot="inspector-group"]') ?? [])
      .find((group) => group.querySelector("h3")?.textContent?.trim() === "Runtime");
    const compute = Array.from(runtimeGroup?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent?.trim() === "Compute");
    const toolbar = compute?.closest(".fm-inspector-toolbar");
    return {
      body: document.body.scrollWidth,
      document: document.documentElement.scrollWidth,
      inspectorViewport: viewport ? { client: viewport.clientWidth, scroll: viewport.scrollWidth } : null,
      runtimeToolbar: toolbar ? { client: toolbar.clientWidth, scroll: toolbar.scrollWidth } : null,
      viewport: window.innerWidth,
    };
  });
  assert.ok(widths.inspectorViewport, label + " could not measure the Inspector scroll viewport");
  assert.ok(widths.runtimeToolbar, label + " could not measure the Runtime toolbar");
  assert.ok(widths.document <= widths.viewport, label + " caused document horizontal overflow");
  assert.ok(widths.body <= widths.viewport, label + " caused body horizontal overflow");
  assert.ok(widths.inspectorViewport.scroll <= widths.inspectorViewport.client, label + " caused Inspector viewport horizontal overflow");
  assert.ok(widths.runtimeToolbar.scroll <= widths.runtimeToolbar.client, label + " caused Runtime toolbar horizontal overflow");
}

async function assertStudyRetryVisibleInScrollViewport(retry, label) {
  await retry.scrollIntoViewIfNeeded();
  const bounds = await retry.evaluate((control) => {
    const inspector = control.closest('[aria-label="Inspector"]');
    const viewport = inspector?.querySelector(".fm-inspector__content [data-radix-scroll-area-viewport]");
    if (!viewport) return null;
    const controlRect = control.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const left = viewportRect.left + viewport.clientLeft;
    const top = viewportRect.top + viewport.clientTop;
    return {
      control: {
        bottom: controlRect.bottom,
        left: controlRect.left,
        right: controlRect.right,
        top: controlRect.top,
      },
      viewport: {
        bottom: top + viewport.clientHeight,
        left,
        right: left + viewport.clientWidth,
        top,
      },
    };
  });
  assert.ok(bounds, label + " could not measure the Inspector scroll viewport");
  assert.ok(bounds.control.left >= bounds.viewport.left, label + " retry control is clipped on the left");
  assert.ok(bounds.control.right <= bounds.viewport.right, label + " retry control is clipped on the right");
  assert.ok(bounds.control.top >= bounds.viewport.top, label + " retry control is clipped above the scroll viewport");
  assert.ok(bounds.control.bottom <= bounds.viewport.bottom, label + " retry control is clipped below the scroll viewport");
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
  initialTheme = await page.evaluate(() => document.documentElement.dataset.theme || "dark");
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
    const detailsGroup = inspector.locator('[data-slot="inspector-group"]').filter({ has: trigger });
    const content = detailsGroup.locator('[data-slot="inspector-group-content"]');
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

  await step("study-compute-retry-preserves-toolbar-and-binds-original-intent", async () => {
    const fitView = inspector.getByRole("button", { name: "Fit view", exact: true });
    assert.equal(await fitView.isEnabled(), true);
    await fitView.focus();
    await pinStudyRetryIdentity();

    const originalA = {
      currentSession: "session-a@1",
      hasOriginalRequest: true,
      intentId: "study-compute-a",
      intentSession: "session-a@1",
      isPending: true,
    };
    await setRetryState(originalA);
    const retry = inspector.getByRole("button", { name: "Retry original Compute", exact: true });
    await retry.waitFor();
    await page.waitForFunction(() => window.__fullmagInspectorActionsFixture?.read().retryableIntentId === "study-compute-a");
    assert.deepEqual((await snapshot()).studyCommandCalls, [], "rendering retry submitted a command");
    await assertStudyRetryIdentity("original A retry shown");

    await setRetryState({ ...originalA, isPending: false });
    await page.waitForFunction(() => window.__fullmagInspectorActionsFixture?.read().retryableIntentId === null);
    assert.equal(await retry.count(), 0);
    assert.deepEqual((await snapshot()).studyCommandCalls, [], "toggling retry off submitted a command");
    await assertStudyRetryIdentity("original A retry hidden");

    await setRetryState(originalA);
    await retry.waitFor();
    assert.deepEqual((await snapshot()).studyCommandCalls, [], "toggling retry on submitted a command");
    await assertStudyRetryIdentity("original A retry shown again");

    await retry.click();
    await page.waitForFunction(() => window.__fullmagInspectorActionsFixture?.read().studyCommandCalls.length === 1);
    assert.deepEqual((await snapshot()).studyCommandCalls, [{
      commandId: "study.retry-compute",
      input: { clientIntentId: "study-compute-a" },
    }], "click did not submit the exact captured retry intent once");
    await retry.focus();
    await retry.press("Enter");
    await page.waitForFunction(() => window.__fullmagInspectorActionsFixture?.read().studyCommandCalls.length === 2);
    assert.deepEqual((await snapshot()).studyCommandCalls, [
      { commandId: "study.retry-compute", input: { clientIntentId: "study-compute-a" } },
      { commandId: "study.retry-compute", input: { clientIntentId: "study-compute-a" } },
    ], "keyboard activation did not invoke the same captured retry intent exactly once");

    await fitView.focus();
    await pinStudyRetryIdentity();
    await setRetryState({ ...originalA, currentSession: "session-b@1" });
    await page.waitForFunction(() => window.__fullmagInspectorActionsFixture?.read().retryableIntentId === null);
    assert.equal(await retry.count(), 0, "new session exposed the previous session retry");
    assert.equal((await snapshot()).studyCommandCalls.length, 2);
    await assertStudyRetryIdentity("new session with old intent");

    const newSessionWithoutBody = {
      currentSession: "session-b@1",
      hasOriginalRequest: false,
      intentId: "study-compute-b",
      intentSession: "session-b@1",
      isPending: true,
    };
    await setRetryState(newSessionWithoutBody);
    await page.waitForFunction(() => {
      const state = window.__fullmagInspectorActionsFixture?.read();
      return state?.retryState.currentSession === "session-b@1" &&
        state.retryState.intentId === "study-compute-b" &&
        state.retryState.hasOriginalRequest === false &&
        state.retryableIntentId === null;
    });
    assert.equal(await retry.count(), 0, "retry appeared without the original request body");
    assert.equal((await snapshot()).studyCommandCalls.length, 2);
    await assertStudyRetryIdentity("new session without original body");

    await setRetryState({ ...newSessionWithoutBody, hasOriginalRequest: true });
    await retry.waitFor();
    await page.waitForFunction(() => window.__fullmagInspectorActionsFixture?.read().retryableIntentId === "study-compute-b");
    assert.deepEqual((await snapshot()).studyCommandCalls, [
      { commandId: "study.retry-compute", input: { clientIntentId: "study-compute-a" } },
      { commandId: "study.retry-compute", input: { clientIntentId: "study-compute-a" } },
    ], "new intent render caused an implicit command");
    await assertStudyRetryIdentity("new session with new retry intent");

    for (const theme of ["dark", "light"]) {
      await setDocumentTheme(theme);
      for (const width of [300, 380]) {
        await page.setViewportSize({ width, height: 844 });
        const label = theme + " retry UI at " + width + "px";
        await assertStudyRetryVisibleInScrollViewport(retry, label);
        await assertStudyRetryIdentity(label);
        await assertNoHorizontalOverflow(label);
        await capture(`inspector-actions-study-retry-${theme}-${width}.png`);
      }
    }

    await setRetryState({
      currentSession: "session-b@1",
      hasOriginalRequest: false,
      intentId: null,
      intentSession: null,
      isPending: false,
    });
    await page.waitForFunction(() => window.__fullmagInspectorActionsFixture?.read().retryableIntentId === null);
    await page.setViewportSize({ width: 1280, height: 900 });
    await setDocumentTheme(initialTheme);
    assert.equal((await snapshot()).studyCommandCalls.length, 2);
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
    study_compute_retry_calls: report.final_snapshot.studyCommandCalls.length,
  };
  report.study_compute_retry = {
    calls: report.final_snapshot.studyCommandCalls,
    qualification: "synthetic_fixture_callback_only_not_backend_or_api_submission",
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
  study_compute_retry: report.study_compute_retry,
  state: report.state,
}));
if (failure) {
  console.error(failure instanceof Error ? failure.stack || failure.message : String(failure));
  process.exitCode = 1;
}
