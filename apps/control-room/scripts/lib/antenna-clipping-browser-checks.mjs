import assert from "node:assert/strict";

/** Shared production section command, sync controller and renderer; synthetic SI data only. */
export async function verifyAntennaClipping({ page, root, open, shot }) {
  const checks = [];
  const read = () => page.evaluate(() => window.__antennaVisualizationFixture.read());
  const canvas = () => page.evaluate(() => window.__antennaFieldCanvas());
  for (const [quantity, label, shift] of [
    ["device_potential", "Electric potential V [V]", false],
    ["current_density", "Current density J [A/m^2]", false],
    ["magnetic_field", "Inspection Oersted field H [A/m]", true],
  ]) {
    await open("inspection-closed");
    await page.waitForFunction(() => document.querySelector('button[aria-label="Toggle Points"]')?.matches(":enabled"));
    await root.getByRole("combobox", { name: "Antenna quantity", exact: true }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
    const surface = root.getByRole("button", { name: "Toggle Surface", exact: true });
    if (await surface.getAttribute("aria-pressed") !== "true") await surface.click();
    for (const layer of ["Points", "Vectors"]) {
      const toggle = root.getByRole("button", { name: `Toggle ${layer}`, exact: true });
      if (await toggle.isEnabled() && await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
    }
    await page.waitForFunction(q => window.__antennaFieldCanvas?.().quantity === q && window.__antennaFieldCanvas().surfaceTriangles === 4, quantity);
    await root.getByRole("button", { name: /Clipping & Section/ }).click();
    await page.waitForFunction(() => document.querySelector('button[aria-label="Section enabled"]')?.matches(":enabled"));
    const inspector = await root.elementHandle();
    const initial = await canvas(), initialCalls = await read();
    const point = [-4e-7/3 + (shift ? 3e-7 : 0), -1e-7/3, 1e-7/3 + (shift ? 3e-8 : 0)];
    const pixel = () => page.evaluate(position => window.__antennaFieldPixel(position), point);
    const originalPixel = await pixel();
    assert.ok(originalPixel.slice(0, 3).some(value => value > 20));
    await root.getByRole("switch", { name: "Section enabled", exact: true }).click();
    await page.waitForFunction(() => window.__antennaFieldCanvas?.().clippingPlanes === 1);
    const slider = root.getByRole("slider", { name: "Section position", exact: true });
    await slider.focus(); await slider.press("End");
    await page.waitForFunction(() => window.__antennaVisualizationFixture.read().clip.position_percent === 100);
    const firstPixel = await pixel();
    await root.getByRole("switch", { name: "Flip section side", exact: true }).click();
    await page.waitForFunction(() => window.__antennaVisualizationFixture.read().clip.flipped);
    const flippedPixel = await pixel();
    assert.ok(firstPixel.slice(0, 3).some((value, axis) => Math.abs(value - flippedPixel[axis]) > 8), `Section did not remove field pixels: ${firstPixel} -> ${flippedPixel}`);
    const clipped = await canvas();
    assert.equal(clipped.surfaceUuid, initial.surfaceUuid);
    assert.equal(clipped.minimum, initial.minimum); assert.equal(clipped.maximum, initial.maximum);
    assert.equal(clipped.sampleCount, initial.sampleCount); assert.equal(clipped.surfaceTriangles, initial.surfaceTriangles);
    assert.equal(clipped.lost, false); assert.ok(clipped.width > 0 && clipped.height > 0);
    await shot(`section-${quantity}-flipped`, true);
    if (quantity === "current_density") await shot("section-controls-current-density", false, ".fm-antenna-clipping");
    await root.getByRole("switch", { name: "Section enabled", exact: true }).click();
    await page.waitForFunction(() => window.__antennaFieldCanvas?.().clippingPlanes === 0);
    assert.deepEqual(await pixel(), originalPixel);
    const after = await read();
    assert.equal(after.calls.filter(call => call.range).length, initialCalls.calls.filter(call => call.range).length);
    assert.ok(after.calls.slice(initialCalls.calls.length).every(call => call.path.endsWith("/visualization/state")));
    assert.ok(after.calls.filter(call => call.method === "PATCH").length <= 4);
    assert.equal(await inspector.evaluate(element => element === document.querySelector('[data-inspector-owner="object.antenna.visualization"]')), true);
    assert.deepEqual(after.unexpected, []);
    checks.push(`${quantity}: actual GPU pixels change on global section flip and restore exactly on disable; real shared plane, scoped bounded PATCHes, no field reads/solve, unchanged samples/range/carrier and healthy WebGL`);
  }
  await open("inspection-closed");
  await page.waitForFunction(() => document.querySelector('button[aria-label="Toggle Points"]')?.matches(":enabled"));
  await root.getByRole("button", { name: /Clipping & Section/ }).click();
  const position = root.getByRole("slider", { name: "Section position", exact: true });
  await position.focus();
  await page.evaluate(() => {
    const panel = document.querySelector('[data-inspector-owner="object.antenna.visualization"]');
    const focus = document.activeElement;
    const controls = [...panel.querySelectorAll("button,input,select")].map(element => ({ element, disabled: element.disabled, opacity: getComputedStyle(element).opacity }));
    const trace = { panel, focus, controls, scrollY, roots: 0, focusChanges: 0, disabled: 0, opacity: 0, animations: 0, scroll: 0, latest: null, overwritten: 0, frame: 0, stopped: false };
    const sample = () => {
      if (trace.stopped) return;
      if (panel !== document.querySelector('[data-inspector-owner="object.antenna.visualization"]')) trace.roots++;
      if (document.activeElement !== focus) trace.focusChanges++;
      for (const saved of controls) {
        if (saved.element.disabled !== saved.disabled) trace.disabled++;
        if (getComputedStyle(saved.element).opacity !== saved.opacity) trace.opacity++;
      }
      if (trace.latest !== null && focus.getAttribute("aria-valuenow") !== String(trace.latest)) trace.overwritten++;
      trace.scroll = Math.max(trace.scroll, Math.abs(scrollY - trace.scrollY));
      trace.animations += panel.getAnimations({ subtree: true }).filter(animation => animation.effect?.getKeyframes().some(frame => frame.opacity !== undefined)).length;
      trace.frame = requestAnimationFrame(sample);
    };
    window.__sectionStability = trace; sample();
    window.__antennaVisualizationFixture.holdClip();
  });
  await position.press("End");
  await page.waitForFunction(() => window.__antennaVisualizationFixture.read().clipPending === 1);
  await position.press("Home");
  assert.equal(await position.getAttribute("aria-valuenow"), "0");
  await page.evaluate(() => { window.__sectionStability.latest = 0; });
  await page.waitForTimeout(200);
  assert.equal(await root.getByRole("combobox", { name: "Section axis", exact: true }).isEnabled(), true);
  await page.evaluate(() => window.__antennaVisualizationFixture.releaseClip());
  await page.waitForFunction(() => window.__antennaVisualizationFixture.read().clip.position_percent === 0);
  await page.waitForTimeout(150);
  const stability = await page.evaluate(() => {
    const trace = window.__sectionStability; trace.stopped = true; cancelAnimationFrame(trace.frame);
    delete window.__sectionStability;
    return { roots: trace.roots, focus: trace.focusChanges, disabled: trace.disabled, opacity: trace.opacity, animations: trace.animations, scroll: trace.scroll, overwritten: trace.overwritten };
  });
  assert.deepEqual(stability, { roots: 0, focus: 0, disabled: 0, opacity: 0, animations: 0, scroll: 0, overwritten: 0 });
  checks.push("Held section PATCH preserves Inspector root, slider focus, scroll, all unrelated disabled/opacity states and zero opacity animations through pending and ACK; an older ACK never overwrites the newer slider gesture");
  await open("clip-unavailable");
  await root.getByRole("button", { name: /Clipping & Section/ }).click();
  assert.equal(await root.getByRole("switch", { name: "Section enabled", exact: true }).isEnabled(), false);
  assert.equal(await root.getByRole("combobox", { name: "Section axis", exact: true }).isEnabled(), false);
  checks.push("Unavailable global section state/command leaves controls disabled without a local fallback");
  await open("clip-reject");
  await root.getByRole("button", { name: /Clipping & Section/ }).click();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Section enabled"]')?.matches(":enabled"));
  await root.getByRole("switch", { name: "Section enabled", exact: true }).click();
  await root.getByRole("alert").filter({ hasText: "Global visualization sync" }).waitFor();
  await page.waitForFunction(() => window.__antennaFieldCanvas?.().clippingPlanes === 0);
  assert.equal((await read()).clip.enabled, false);
  checks.push("Rejected global section PATCH shows sync error and removes optimistic clipping; no false saved state");
  return checks;
}
