// Regression: dock separators identify their neighbours; Inspector double-click restores its canonical width without moving Explorer or submitting model writes.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { designCheckUrl, designReportDir } from "./lib/design-browser-env.mjs";
const browser = await chromium.launch({
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--use-angle=swiftshader-webgl",
    "--use-gl=angle",
  ],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const mutations = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && /commands|transactions|syncs/.test(r.url())) mutations.push(r.url());
  });
  await page.goto(designCheckUrl(), { waitUntil: "domcontentloaded" });
  const panel = page.getByTestId("panel-right");
  await panel.waitFor({ state: "visible" });
  const handle = page.getByRole("separator", { name: /Inspector/ }).last();
  await handle.waitFor({ state: "visible" });
  const explorerBefore = await page.getByTestId("panel-left").boundingBox();
  const labels = await page.getByRole("separator").evaluateAll((ns) => ns.map((n) => n.getAttribute("aria-label")));
  const results = [];
  for (const width of [360, 416, 560]) {
    const h = await handle.boundingBox(),
      p = await panel.boundingBox();
    assert(h && p);
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(p.x + p.width - width - h.width / 2, h.y + h.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after = await panel.boundingBox();
    results.push({ expected: width, actual: after.width });
    assert(Math.abs(after.width - width) <= 3, JSON.stringify(results));
  }
  await handle.dblclick();
  await page.waitForTimeout(200);
  const reset = await panel.boundingBox();
  assert(Math.abs(reset.width - 416) <= 3, `Reset width=${reset.width}`);
  assert.equal(mutations.length, 0);
  const explorerAfter = await page.getByTestId("panel-left").boundingBox();
  assert(
    Math.abs(explorerBefore.width - explorerAfter.width) <= 1,
    `Explorer changed: ${explorerBefore.width} -> ${explorerAfter.width}`,
  );
  const canvas = page.locator(".fm-viewport-3d canvas");
  await canvas.waitFor({ state: "visible" });
  const webgl = await canvas.evaluate((c) => {
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    return {
      contextLost: gl?.isContextLost() ?? true,
      width: gl?.drawingBufferWidth ?? 0,
      height: gl?.drawingBufferHeight ?? 0,
    };
  });
  assert(!webgl.contextLost && webgl.width > 0 && webgl.height > 0);
  const result = {
    state: "passed",
    labels,
    widths: results,
    resetWidth: reset.width,
    explorerBefore: explorerBefore.width,
    explorerAfter: explorerAfter.width,
    webgl,
    mutations,
  };
  const report = designReportDir();
  await mkdir(report, { recursive: true });
  await writeFile(`${report}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
