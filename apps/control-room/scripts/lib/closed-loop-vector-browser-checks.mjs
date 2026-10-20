import assert from "node:assert/strict";

/** Additional checks against the existing production UI fixture, not a solver oracle. */
export async function verifyClosedLoopVectorDisplay({ page, root, open, shot }) {
  const checks = [];
  const choose = async (label) => {
    await root.getByRole("combobox", { name: "Antenna quantity", exact: true }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
  };
  const enable = async (label) => {
    const button = root.getByRole("button", { name: `Toggle ${label}`, exact: true });
    assert.equal(await button.isEnabled(), true);
    if (await button.getAttribute("aria-pressed") !== "true") await button.click();
  };
  const read = () => page.evaluate(() => window.__antennaFieldCanvas());
  for (const [quantity, label, count] of [
    ["current_density", "Current density J [A/m^2]", 1],
    ["current_density_per_ampere", "Inspection current J/Ic [1/m^2]", 1],
    ["magnetic_field", "Inspection Oersted field H [A/m]", 4],
    ["magnetic_field_per_ampere", "Inspection Oersted field H/Ic [1/m]", 4],
  ]) {
    await open("inspection-closed");
    await page.waitForFunction(() => document.querySelector('button[aria-label="Toggle Points"]')?.matches(":enabled"));
    const inspector = await root.elementHandle();
    await choose(label);
    await enable("Surface"); await enable("Points"); await enable("Vectors");
    await page.waitForFunction(([q, n]) => {
      const canvas = window.__antennaFieldCanvas?.();
      return canvas?.quantity === q && canvas.pointCount === n && canvas.glyphCount === n && canvas.surfaceTriangles === 4;
    }, [quantity, count]);
    assert.equal(await page.locator('[data-antenna-field-viewport] canvas').isVisible(), true);
    // Instance count is allocated before the asynchronous matrix/color uploads finish.
    await page.waitForFunction(() => {
      const state = window.__antennaFieldCanvas?.();
      return state?.pointColors?.length && state.glyphMatrices.length === 2 && state.glyphMatrices.every(matrix => matrix.length && Math.abs(matrix[0]) < 1e-6) &&
        state.glyphColors.length === 2 && state.glyphColors.every(colors => JSON.stringify(colors) === JSON.stringify(state.pointColors));
    });
    const initial = await read();
    const identities = state => [state.surfaceUuid, state.pointsUuid, state.materialUuid, state.paletteUuid];
    const expected = identities(initial);
    assert.ok(expected.every(Boolean));
    const callsBeforeRange = await page.evaluate(() => window.__antennaVisualizationFixture.read().calls.length);
    assert.deepEqual(initial.glyphDepthTests, [true, true]);
    const occlusion = root.getByRole("combobox", { name: "Vector occlusion", exact: true });
    const shaftCenter = initial.glyphMatrices[0].slice(12, 15);
    const depthPixel = await page.evaluate(position => window.__antennaFieldPixel(position), shaftCenter);
    await occlusion.selectOption("overlay");
    await page.waitForFunction(() => window.__antennaFieldCanvas?.().glyphDepthTests.length === 2 && window.__antennaFieldCanvas().glyphDepthTests.every(value => !value));
    const overlay = await read();
    assert.deepEqual(overlay.glyphDepthWrites, [false, false]);
    assert.deepEqual(overlay.glyphMeshUuids, initial.glyphMeshUuids, "Depth toggle reconstructed InstancedMesh");
    assert.deepEqual(overlay.glyphMaterialUuids, initial.glyphMaterialUuids, "Depth toggle replaced the material");
    assert.deepEqual(overlay.glyphMatrices, initial.glyphMatrices);
    assert.deepEqual(overlay.glyphColors, initial.glyphColors);
    assert.deepEqual(identities(overlay), expected);
    const overlayPixel = await page.evaluate(position => window.__antennaFieldPixel(position), shaftCenter);
    if (quantity === "current_density") assert.notDeepEqual(overlayPixel, depthPixel, "Interior glyph remains hidden behind its carrier");
    await shot(`through-surface-vectors-${quantity}`);
    await occlusion.selectOption("depth");
    await page.waitForFunction(() => window.__antennaFieldCanvas?.().glyphDepthTests.length === 2 && window.__antennaFieldCanvas().glyphDepthTests.every(Boolean));
    assert.deepEqual((await read()).glyphMatrices, initial.glyphMatrices);
    assert.equal(await page.evaluate(() => window.__antennaVisualizationFixture.read().calls.length), callsBeforeRange);
    checks.push(`${quantity}: explicit through-surface glyph overlay toggles depth test/write in place, preserves mesh/material UUIDs and transforms/RGB/carrier, restores depth and makes zero reads; pixels ${depthPixel} -> ${overlayPixel}`);
    await root.getByRole("radio", { name: "Vectors", exact: true }).click();
    assert.equal(await root.getByRole("radio", { name: "Vectors", exact: true }).getAttribute("aria-checked"), "true");
    assert.equal(await root.getByRole("radio", { name: "Off", exact: true }).getAttribute("aria-checked"), "false");
    await page.waitForFunction(() => window.__antennaFieldCanvas?.().surfaceTriangles === 0 && window.__antennaFieldCanvas?.().pointCount === 0);
    await root.getByRole("combobox", { name: "Vector width", exact: true }).selectOption("4");
    await page.waitForFunction(before => {
      const now = window.__antennaFieldCanvas?.().glyphMatrices;
      return now?.length === 2 && Math.hypot(...now[0].slice(0, 3)) > Math.hypot(...before[0].slice(0, 3)) * 3.9;
    }, initial.glyphMatrices);
    const vectorsOnly = await read();
    assert.equal(vectorsOnly.glyphCount, count);
    for (let mesh = 0; mesh < 2; mesh++) for (let index = 0; index < count; index++) {
      const a = initial.glyphMatrices[mesh].slice(index * 16, index * 16 + 16), b = vectorsOnly.glyphMatrices[mesh].slice(index * 16, index * 16 + 16);
      assert.deepEqual(b.slice(4, 8), a.slice(4, 8), "Width changed the glyph length or direction");
      assert.deepEqual(b.slice(12, 16), a.slice(12, 16), "Width moved the glyph");
      for (const column of [0, 8]) for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(b[column + axis] - a[column + axis] * 4) < 1e-14);
    }
    // Standard radial proportions remain recognizable when the vector points towards the camera.
    await root.getByRole("combobox", { name: "Vector width", exact: true }).selectOption("1");
    await root.getByRole("combobox", { name: "Glyph length", exact: true }).selectOption("4");
    await page.waitForFunction(before => {
      const now = window.__antennaFieldCanvas?.().glyphMatrices;
      return now?.length === 2 && Math.hypot(...now[0].slice(4, 7)) > Math.hypot(...before[0].slice(4, 7)) * 3.9;
    }, initial.glyphMatrices);
    const enlarged = await read();
    assert.deepEqual(enlarged.glyphColors, initial.glyphColors);
    for (let index = 0; index < count; index++) {
      const before = initial.glyphMatrices[0].slice(index * 16, index * 16 + 16), after = enlarged.glyphMatrices[0].slice(index * 16, index * 16 + 16);
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(Math.abs(after[4 + axis] - before[4 + axis] * 4) < 1e-13, "Glyph direction or relative length changed");
        const oldTail = before[12 + axis] - before[4 + axis] / 2, newTail = after[12 + axis] - after[4 + axis] / 2;
        assert.ok(Math.abs(newTail - oldTail) < 1e-13, "Global display scale moved the vector sample anchor");
      }
    }
    assert.ok(enlarged.glyphPixelBounds.some(([width, height]) => Math.max(width, height) >= 6 && Math.min(width, height) >= 2), `No readable dominant glyph: ${JSON.stringify(enlarged.glyphPixelBounds)}`);
    assert.equal(vectorsOnly.lost, false); assert.ok(vectorsOnly.width > 0 && vectorsOnly.height > 0);
    await shot(`vectors-only-readable-${quantity}`, true);
    await root.getByRole("combobox", { name: "Glyph length", exact: true }).selectOption("1");
    await root.getByRole("combobox", { name: "Vector width", exact: true }).selectOption("1");
    await enable("Surface"); await enable("Points");
    await page.waitForFunction(before => {
      const now = window.__antennaFieldCanvas?.();
      return now?.surfaceTriangles === 4 && now.pointCount > 0 && JSON.stringify(now.glyphMatrices) === JSON.stringify(before);
    }, initial.glyphMatrices);
    assert.deepEqual(identities(await read()), expected);
    assert.equal(await page.evaluate(() => window.__antennaVisualizationFixture.read().calls.length), callsBeforeRange);
    checks.push(`${quantity}: explicit vectors-only frame and explicit 4x global length/standard width preserve arrow proportions and a bounded dominant glyph footprint, preserve sample anchors/directions/relative amplitudes/all samples and restore carrier without reads`);
    const minimum = root.getByRole("textbox", { name: "Color minimum", exact: true });
    const maximum = root.getByRole("textbox", { name: "Color maximum", exact: true });
    await minimum.fill("2"); await maximum.fill("1");
    await root.getByRole("button", { name: "Apply color range", exact: true }).click();
    await root.getByRole("alert").filter({ hasText: "minimum < maximum" }).waitFor();
    assert.equal((await read()).rangeMaximum, initial.maximum);
    const upper = initial.maximum * 2;
    assert.ok(upper > 0);
    await minimum.fill("0"); await maximum.fill(String(upper));
    await root.getByRole("button", { name: "Apply color range", exact: true }).click();
    await page.waitForFunction(value => window.__antennaFieldCanvas?.().rangeMaximum === value, upper);
    await page.waitForFunction(previous => {
      const current = window.__antennaFieldCanvas?.();
      return current?.glyphColors?.length && JSON.stringify(current.pointColors) !== JSON.stringify(previous) && current.glyphColors.every(colors => JSON.stringify(colors) === JSON.stringify(current.pointColors));
    }, initial.pointColors);
    const manual = await read();
    assert.notDeepEqual(manual.pointColors, initial.pointColors);
    assert.deepEqual(manual.glyphMatrices, initial.glyphMatrices, "Color range changed glyph direction, length or position");
    assert.ok(manual.glyphColors.every(colors => JSON.stringify(colors) === JSON.stringify(manual.pointColors)));
    await shot(`manual-color-range-${quantity}`);
    assert.deepEqual(identities(manual), expected);
    assert.equal(manual.minimum, initial.minimum); assert.equal(manual.maximum, initial.maximum);
    assert.equal(manual.shaderMinimum, 0); assert.equal(manual.shaderMaximum, Math.fround(upper / manual.vectorScale));
    assert.equal(manual.pointCount, count); assert.equal(manual.glyphCount, count);
    await root.getByRole("combobox", { name: "Point / vector palette", exact: true }).selectOption("coolwarm");
    assert.equal((await read()).rangeMaximum, upper);
    await root.getByRole("button", { name: "Reset color range to Auto", exact: true }).click();
    await page.waitForFunction(value => window.__antennaFieldCanvas?.().rangeMaximum === value, initial.maximum);
    assert.deepEqual(identities(await read()), expected);
    await maximum.fill(String(upper)); await minimum.fill("0");
    await root.getByRole("button", { name: "Apply color range", exact: true }).click();
    await page.waitForFunction(value => window.__antennaFieldCanvas?.().rangeMaximum === value, upper);
    await root.getByRole("combobox", { name: "Component", exact: true }).selectOption("x");
    await page.waitForFunction(() => document.querySelector('[data-inspector-owner="object.antenna.visualization"]')?.textContent.includes("Auto color range"));
    assert.equal(await page.evaluate(() => window.__antennaVisualizationFixture.read().calls.length), callsBeforeRange);
    checks.push(`${quantity}: explicit finite ordered SI color range, actual shared point/glyph RGB change and shader limits, unchanged data stats/geometry/glyph matrices/LUT, palette retention, Auto/component reset and zero requests`);
    for (const component of ["x", "y", "z", "magnitude"]) {
      await root.getByRole("combobox", { name: "Component", exact: true }).selectOption(component);
      await page.waitForFunction(value => window.__antennaFieldCanvas?.().currentComponent === value,
        component === "magnitude" ? 0 : { x: 1, y: 2, z: 3 }[component]);
      const state = await read();
      assert.equal(state.glyphCount, count); assert.equal(state.surfaceTriangles, 4);
      assert.equal(state.lost, false); assert.ok(state.width > 0 && state.height > 0);
      assert.ok(Number.isFinite(state.minimum) && Number.isFinite(state.maximum));
      assert.deepEqual(identities(state), expected);
    }
    for (const palette of ["coolwarm", "viridis"]) {
      await root.getByRole("combobox", { name: "Point / vector palette", exact: true }).selectOption(palette);
      await page.waitForTimeout(150);
      assert.deepEqual(identities(await read()), expected);
    }
    assert.equal(await root.evaluate((element, previous) => element === previous, inspector), true);
    const before = await page.evaluate(() => window.__antennaVisualizationFixture.read().calls.length);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__antennaVisualizationFixture.read().calls.length), before);
    assert.deepEqual(await page.evaluate(() => window.__antennaVisualizationFixture.read().unexpected), []);
    await shot(`closed-loop-${quantity}-vectors`);
    await page.evaluate(() => window.__antennaVisualizationFixture.selectOther());
    await page.waitForFunction(() => window.__antennaFieldCanvas?.().sampleCount === 0 && window.__antennaFieldCanvas?.().paletteTextures === 0);
    checks.push(`${quantity}: complete glyphs, xyz/magnitude, stable geometry/material/LUT and Inspector, no idle reads, owner cleanup`);
  }
  // These scenarios must bind the helper's corresponding cancellation option.
  for (const [family, label, xShift, zShift] of [
    ["current", "Current density J [A/m^2]", 0, 0],
    ["magnetic", "Inspection Oersted field H [A/m]", 3e-7, 3e-8],
  ]) {
    await open(`inspection-closed-${family}-cancellation`);
    await page.waitForFunction(() => document.querySelector('button[aria-label="Toggle Points"]')?.matches(":enabled"));
    await choose(label); await enable("Surface");
    await root.getByRole("combobox", { name: "Component", exact: true }).selectOption("magnitude");
    await page.waitForFunction(() => window.__antennaFieldCanvas?.().surfaceTriangles === 4 && window.__antennaFieldCanvas?.().currentComponent === 0);
    const pixel = await page.evaluate(position => window.__antennaFieldPixel(position), [-4e-7/3+xShift,-1e-7/3,1e-7/3+zShift]);
    const reference = await page.evaluate(position => window.__antennaFieldPixel(position), [-0.4e-7+xShift,-0.8e-7,0.1e-7+zShift]);
    assert.ok(pixel[0] > 30 && pixel[1] < 45 && pixel[2] > 50 && pixel[3] === 255, `Wrong ${family} cancellation pixel: ${pixel}`);
    assert.ok(reference[1] > pixel[1]+50, `Missing ${family} magnitude contrast: ${reference}`);
    await shot(`closed-loop-${family}-vector-cancellation`);
    checks.push(`${family}: GPU pixel readback confirms norm after vector interpolation, cancellation=${pixel}, reference=${reference}`);
  }
  return checks;
}
