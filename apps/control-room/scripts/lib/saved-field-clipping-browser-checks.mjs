import assert from "node:assert/strict";

/** Production saved Inspector and shared API sync; controlled metadata, no saved renderer. */
export async function verifySavedFieldClipping({ page, url, shot }) {
  const target = new URL(url);
  target.searchParams.set("scenario", "saved-section");
  await page.goto(target.href);
  const root = page.locator(".fm-inspector");
  const panel = root.locator("[data-saved-field-visualization]");
  await panel.waitFor({ state: "visible", timeout: 60000 });
  await root.getByRole("button", { name: /Clipping & Section/ }).click();
  const position = root.getByRole("slider", { name: "Section position", exact: true });
  await page.waitForFunction(() => document.querySelector('button[aria-label="Section enabled"]')?.matches(":enabled"));
  assert.equal(await root.getByRole("button", { name: "Toggle Surface", exact: true }).isEnabled(), true);
  await position.scrollIntoViewIfNeeded();
  await position.focus();
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => {
    const shell = document.querySelector(".fm-inspector");
    const panel = shell.querySelector("[data-saved-field-visualization]");
    const scroll = shell.querySelector("[data-radix-scroll-area-viewport]");
    const focus = document.activeElement;
    const controls = [...shell.querySelectorAll("button,input,select")].map(element => ({
      element, disabled: element.disabled,
    }));
    const opacityTargets = new Set([shell, panel, scroll]);
    for (const { element } of controls) {
      for (let ancestor = element; ancestor && shell.contains(ancestor); ancestor = ancestor.parentElement) {
        opacityTargets.add(ancestor);
      }
    }
    const opacity = [...opacityTargets].map(element => ({ element, value: getComputedStyle(element).opacity }));
    const trace = {
      shell, panel, scroll, focus, controls, scrollTop: scroll.scrollTop,
      roots: 0, focusChanges: 0, disabled: 0, opacity: 0, animations: 0,
      scrollChanges: 0, latest: null, overwritten: 0, frames: 0, stopped: false, frame: 0,
    };
    const sample = () => {
      if (trace.stopped) return;
      trace.frames++;
      if (shell !== document.querySelector(".fm-inspector") ||
          panel !== shell.querySelector("[data-saved-field-visualization]") ||
          scroll !== shell.querySelector("[data-radix-scroll-area-viewport]")) trace.roots++;
      if (document.activeElement !== focus) trace.focusChanges++;
      for (const saved of controls) {
        if (!saved.element.isConnected || saved.element.disabled !== saved.disabled) trace.disabled++;
      }
      for (const saved of opacity) {
        if (!saved.element.isConnected || getComputedStyle(saved.element).opacity !== saved.value) trace.opacity++;
      }
      trace.scrollChanges = Math.max(trace.scrollChanges, Math.abs(scroll.scrollTop - trace.scrollTop));
      if (trace.latest !== null && focus.getAttribute("aria-valuenow") !== String(trace.latest)) trace.overwritten++;
      trace.animations += shell.getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getKeyframes().some(frame => frame.opacity !== undefined)).length;
      trace.frame = requestAnimationFrame(sample);
    };
    window.__savedSectionStability = trace;
    sample();
    window.__antennaVisualizationFixture.holdClip();
    return { ...window.__antennaVisualizationFixture.read(), scrollTop: trace.scrollTop };
  });
  assert.ok(before.scrollTop > 0, "The real Inspector scroll viewport must be exercised");
  await position.press("End");
  await page.waitForFunction(() => window.__antennaVisualizationFixture.read().clipPending === 1);
  await position.press("Home");
  assert.equal(await position.getAttribute("aria-valuenow"), "0");
  await page.evaluate(() => { window.__savedSectionStability.latest = 0; });
  await page.waitForTimeout(200);
  assert.equal(await root.getByRole("combobox", { name: "Section axis", exact: true }).isEnabled(), true);
  await shot("saved-section-pending", false, ".fm-inspector");
  await page.evaluate(() => window.__antennaVisualizationFixture.releaseClip());
  await page.waitForFunction(() => {
    const state = window.__antennaVisualizationFixture.read();
    return state.clip.position_percent === 0 && state.clipPending === 0;
  });
  await page.waitForTimeout(200);
  const trace = await page.evaluate(() => {
    const trace = window.__savedSectionStability;
    trace.stopped = true; cancelAnimationFrame(trace.frame);
    delete window.__savedSectionStability;
    return {
      roots: trace.roots, focus: trace.focusChanges, disabled: trace.disabled, opacity: trace.opacity,
      animations: trace.animations, scroll: trace.scrollChanges, overwritten: trace.overwritten, frames: trace.frames,
    };
  });
  assert.ok(trace.frames > 2, "Stability must be sampled through pending and ACK");
  const { frames: _frames, ...failures } = trace;
  assert.deepEqual(failures, { roots: 0, focus: 0, disabled: 0, opacity: 0, animations: 0, scroll: 0, overwritten: 0 });
  const after = await page.evaluate(() => window.__antennaVisualizationFixture.read());
  const transactionCalls = after.calls.slice(before.calls.length);
  assert.equal(transactionCalls.filter(call => call.method === "PATCH").length, 2);
  assert.ok(transactionCalls.length <= 6, "Section transaction request count is unbounded");
  assert.ok(transactionCalls.every(call => call.path.endsWith("/visualization/state") && !call.range));
  assert.ok(after.reactCommits - before.reactCommits <= 32, "Section transaction React commits are unbounded");
  assert.deepEqual(after.unexpected, []);
  await shot("saved-section-ack", false, ".fm-inspector");
  await page.waitForTimeout(300);
  const idle = await page.evaluate(() => window.__antennaVisualizationFixture.read());
  assert.equal(idle.calls.length, after.calls.length, "Idle saved Inspector must not issue requests");
  assert.ok(idle.reactCommits - after.reactCommits <= 1, "Idle saved Inspector keeps rendering");
  return [
    "Saved H Inspector: real shared PATCH/optimistic sync preserves shell/panel/scroll roots, focus, nonzero scroll, unrelated enabled/opacity states and zero opacity animations through held ACK; newer Home gesture survives older End ACK",
    "Saved H Inspector: exactly two section PATCHes, bounded GETs and React commits, no binary or Solve requests and no idle requests; controlled metadata only, not saved renderer or scientific qualification",
  ];
}
