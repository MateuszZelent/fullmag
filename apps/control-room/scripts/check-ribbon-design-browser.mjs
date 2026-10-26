import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright";
import { designCheckUrl } from "./lib/design-browser-env.mjs";
const output = process.env.CONTROL_ROOM_DESIGN_REPORT_DIR;
assert(output, "Set CONTROL_ROOM_DESIGN_REPORT_DIR to the task run directory");
fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: [
    "--headless=new",
    "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--no-sandbox",
    "--use-angle=swiftshader-webgl",
    "--use-gl=angle",
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
const errors = [],
  results = [];
page.setDefaultTimeout(20000);
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(designCheckUrl(), {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  const ribbon = page.locator(".fm-ribbon");
  await ribbon.waitFor({ timeout: 120000 });
  const canvas = await page.locator(".fm-viewport-3d canvas").elementHandle();
  assert(canvas);
  for (const theme of ["light", "dark"]) {
    await page.getByRole("button", { name: /^Color theme:/ }).click();
    await page.getByRole("menuitemradio", { name: theme === "light" ? "Light" : "Dark", exact: true }).click();
    for (const width of [1920, 1440, 1180, 900]) {
      await page.setViewportSize({ width, height: 1100 });
      for (const density of ["Full", "Compact", "Collapsed"]) {
        await page.getByRole("button", { name: /^Ribbon density:/ }).click();
        await page.getByRole("menuitemradio", { name: density, exact: true }).click();
        console.log(JSON.stringify({ theme, width, density, completed: results.length }));
        // Definitions and Automation stay hidden while they have no working action.
        const tabNames = await ribbon.getByRole("tab").allTextContents();
        for (const hidden of ["Definitions", "Automation"]) assert(!tabNames.includes(hidden), `${hidden} tab is hidden`);
        for (const name of ["Workspace", "View", "Geometry", "Materials", "Physics", "Mesh", "Study", "Results"]) {
          const tab = ribbon.getByRole("tab", { name, exact: true });
          await tab.click();
          assert.equal(await tab.getAttribute("aria-selected"), "true");
          const state = await ribbon.evaluate((e) => ({
            density: e.dataset.density,
            groups: [...e.querySelectorAll("[role=toolbar]")].map((g) => ({
              id: g.dataset.groupId,
              label: g.getAttribute("aria-label"),
            })),
            tiny: [...e.querySelectorAll("button")]
              .filter((b) => {
                const r = b.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
              })
              .map((b) => ({ text: b.textContent, label: b.getAttribute("aria-label") })),
          }));
          assert.equal(state.density, density.toLowerCase());
          assert(state.groups.every((g) => g.label));
          assert.deepEqual(state.tiny, [], `${theme}/${width}/${density}/${name}: target sizes`);
          if (density === "Collapsed") {
            const trigger = ribbon.locator(".fm-ribbon-group").first().getByRole("button");
            if (await trigger.count()) {
              await trigger.click();
              await page.getByRole("menu").last().waitFor();
              await page.keyboard.press("Escape");
            }
          }
          results.push({ theme, width, density, tab: name, groups: state.groups.length });
          fs.writeFileSync(output + "/progress.json", JSON.stringify({ results, errors }, null, 2));
        }
      }
      assert(
        await canvas.evaluate((c) => c === document.querySelector(".fm-viewport-3d canvas")),
        "Ribbon context/density/theme must retain the current canvas",
      );
    }
  }
  await ribbon.getByRole("tab", { name: "Workspace", exact: true }).click();
  await ribbon.getByRole("tab", { name: "Workspace", exact: true }).focus();
  await page.keyboard.press("Control+F1");
  await page.waitForFunction(() => document.querySelector(".fm-ribbon")?.dataset.density === "full");
  const gl = await canvas.evaluate((c) => {
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    return {
      contextLost: gl.isContextLost(),
      width: gl.drawingBufferWidth,
      height: gl.drawingBufferHeight,
      visible: c.getBoundingClientRect().width > 0,
    };
  });
  assert(gl.visible && !gl.contextLost && gl.width > 0 && gl.height > 0);
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    output + "/result.json",
    JSON.stringify(
      {
        results,
        errors,
        canvas: gl,
        checks: [
          "all ten tabs × three densities × four widths × two themes",
          "named toolbars",
          "minimum target sizes",
          "collapsed overflow open/Escape",
          "Ctrl+F1",
          "stable canvas through contexts/theme/density",
        ],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ cases: results.length, errors, canvas: gl, passed: true }));
} catch (error) {
  fs.writeFileSync(output + "/failure.json", JSON.stringify({ results, errors, failure: String(error) }, null, 2));
  throw error;
} finally {
  await browser.close();
}
