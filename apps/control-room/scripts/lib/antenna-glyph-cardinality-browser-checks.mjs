import assert from "node:assert/strict";

export async function verifyAntennaGlyphCardinality({ page, root, open, shot }) {
  const checks = [];
  for (const count of [7, 14]) {
    await open(`glyph-count-${count}`);
    await page.waitForFunction(() => document.querySelector('button[aria-label="Toggle Points"]')?.matches(":enabled"));
    await root.getByRole("radio", { name: "Vectors", exact: true }).click();
    await page.waitForFunction(n => {
      const state = window.__antennaFieldCanvas?.();
      return state?.glyphCount === n && state.pointCount === 0 && state.glyphMatrices.length === 2 &&
        state.glyphMatrices.every(matrix => matrix.length === n * 16 && Math.abs(matrix[0]) < 1e-6);
    }, count);
    const state = await page.evaluate(() => window.__antennaFieldCanvas());
    assert.equal(state.sampleCount, count);
    assert.equal(state.lost, false); assert.ok(state.width > 0 && state.height > 0);
    const maximumNorm = Math.hypot((count - 1) * 3 + 0.25, (count - 1) * 3 + 1.25, (count - 1) * 3 + 2.25);
    const extent = Math.hypot(4e-7, Math.floor((count - 1) / 5) * 2e-7);
    const displayScale = extent / Math.max(4, Math.cbrt(count)) * 0.45 / maximumNorm;
    for (let index = 0; index < count; index++) {
      const matrix = state.glyphMatrices[0].slice(index * 16, index * 16 + 16);
      const axis = matrix.slice(4, 7), length = Math.hypot(...axis);
      const expected = [index * 3 + 0.25, index * 3 + 1.25, index * 3 + 2.25];
      const anchor = [(index % 5 - 2) * 1e-7, (Math.floor(index / 5) - 0.5) * 2e-7, 0];
      // The production model uploads Float32 endpoints; subtracting nearby
      // coordinates rounds short vectors before the shared decoder sees them.
      const projected = expected.map((value, coordinate) => Math.fround(Math.fround(anchor[coordinate]) + value * displayScale) - Math.fround(anchor[coordinate]));
      const norm = Math.hypot(...projected);
      assert.ok(length > 0);
      for (let coordinate = 0; coordinate < 3; coordinate++) {
        assert.ok(Math.abs(matrix[12 + coordinate] - axis[coordinate] / 2 - anchor[coordinate]) < 1e-13, `Wrong sample ${index} anchor`);
        assert.ok(Math.abs(axis[coordinate] / length - projected[coordinate] / norm) < 1e-6, `Wrong sample ${index} direction`);
      }
    }
    await shot(`all-${count}-antenna-glyphs`, true);
    const before = await page.evaluate(() => window.__antennaVisualizationFixture.read().calls.length);
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.__antennaVisualizationFixture.read().calls.length), before);
    assert.deepEqual(await page.evaluate(() => window.__antennaVisualizationFixture.read().unexpected), []);
    checks.push(`${count} antenna samples render exactly ${count} glyphs through the shared production decoder; every sample anchor and Cartesian direction matches fixture SI data, visible healthy WebGL and no idle requests`);
  }
  return checks;
}
