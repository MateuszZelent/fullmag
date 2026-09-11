import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { build } from "vite";

// Exercise the production sampler and renderer without a solver or mock canvas.
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(appRoot, "scripts/fixtures/planar-color-browser.ts");
const bundle = await build({
  configFile: false,
  root: appRoot,
  logLevel: "error",
  resolve: { alias: { "@": resolve(appRoot, "src") } },
  build: {
    write: false,
    minify: false,
    lib: { entry, name: "PlanarColorProof", formats: ["iife"] },
  },
});
const output = Array.isArray(bundle) ? bundle[0].output : bundle.output;
const script = output.find((item) => item.type === "chunk" && item.isEntry);
assert.ok(script, "Browser fixture must bundle production renderer exports");

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent('<canvas width="400" height="100" style="width:400px;height:100px"></canvas>');
  await page.addScriptTag({ content: script.code });
  const result = await page.evaluate(async () => {
    const canvas = document.querySelector("canvas");
    const { colorizeScalarRaster, createPlanarRenderer } = globalThis.PlanarColorProof;
    const renderer = createPlanarRenderer(canvas);
    const pixels = colorizeScalarRaster([0, 0.5, 1, 99], { min: 0, max: 1 }, [0, 0, 0, 1]);
    renderer.draw(pixels, 4, 1);
    const context = canvas.getContext("2d");
    const read = () => [50, 150, 250, 350].map((x) => Array.from(context.getImageData(x, 50, 1, 1).data));
    const painted = read();
    const rect = canvas.getBoundingClientRect();
    // The renderer has no idle RAF loop; settled pixels must remain unchanged.
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    const settled = read();
    const dimensions = [canvas.width, canvas.height];
    renderer.dispose();
    return {
      dimensions,
      disposed: [canvas.width, canvas.height],
      painted,
      settled,
      visible: rect.width > 0 && rect.height > 0,
    };
  });
  assert.deepEqual(errors, []);
  assert.equal(result.visible, true);
  assert.deepEqual(result.dimensions, [400, 100]);
  assert.deepEqual(result.painted, [[68, 1, 84, 255], [51, 144, 132, 255], [253, 231, 37, 255], [0, 0, 0, 0]]);
  assert.deepEqual(result.settled, result.painted);
  assert.deepEqual(result.disposed, [0, 0]);
  console.log(JSON.stringify({ status: "PASS", ...result }));
} finally {
  await browser.close();
}
