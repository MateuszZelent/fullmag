import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const output = process.env.FULLMAG_PREPARATION_WORKSPACE_REPORT_DIR;
const url = process.env.CONTROL_ROOM_URL;
if (!output || !url) throw new Error("Managed fixture URL and report directory are required");
await mkdir(output, { recursive: true });
const report = { schema: "fullmag_preparation_workspace_browser_v1", state: "running", qualification: "production_components_controlled_preparation_not_backend_startup_or_science", steps: [], webgl: [], screenshots: [], errors: [] };
let browser;
try {
  const channel = process.env.FULLMAG_PREPARATION_WORKSPACE_BROWSER_CHANNEL;
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", error => report.errors.push(error.message));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForFunction(() => window.__fullmagPreparationFixture && window.__antennaCpwViewport?.read().meshes.length === 2);
  const input = page.getByRole("textbox", { name: "Unchanged fixture field", exact: true });
  await input.fill("unsaved preparation draft");
  await input.focus();
  await page.evaluate(() => { window.__preparationInput = document.activeElement; window.__preparationCanvas = document.querySelector("canvas"); });
  for (const phase of ["running", "ready", "running", "stale", "failed"]) {
    await page.evaluate(phase => window.__fullmagPreparationFixture.setPhase(phase), phase);
    await page.waitForFunction(phase => window.__fullmagPreparationFixture.phase === phase, phase);
    const evidence = await page.evaluate(() => ({
      sameInput: window.__preparationInput === document.querySelector('[data-testid="inspector-actions-stable-field"]'),
      sameCanvas: window.__preparationCanvas === document.querySelector("canvas"),
      focusPreserved: document.activeElement === window.__preparationInput,
      inertAncestors: Boolean(window.__preparationInput?.closest("[inert]")),
      modalCount: document.querySelectorAll('[aria-modal="true"]').length,
      viewport: window.__antennaCpwViewport.read(),
    }));
    assert.equal(evidence.sameInput, true); assert.equal(evidence.sameCanvas, true);
    assert.equal(evidence.focusPreserved, true); assert.equal(evidence.inertAncestors, false);
    assert.equal(evidence.modalCount, 0);
    assert.equal(await input.inputValue(), "unsaved preparation draft");
    assert.equal(evidence.viewport.contextLost, false);
    assert.ok(evidence.viewport.width > 0 && evidence.viewport.height > 0);
    assert.equal(await page.locator("canvas").isVisible(), true);
    if (phase !== "ready") {
      const status = page.getByRole("complementary", { name: "Simulation preparation status" });
      assert.equal(await status.locator('.fm-accordion-content').isVisible(), false);
      assert.ok((await status.boundingBox()).height < 300, "Collapsed status must remain compact");
    }
    report.steps.push({ phase, status: "passed" }); report.webgl.push(evidence.viewport);
  }
  const status = page.getByRole("complementary", { name: "Simulation preparation status" });
  const details = status.getByRole("button", { name: "View failure details", exact: true });
  await details.click();
  await page.waitForFunction(() => document.querySelector('.fm-simulation-startup__details-trigger')?.getAttribute('aria-expanded') === 'true');
  await status.locator('.fm-accordion-content').waitFor({ state: "visible" });
  assert.equal(await status.getByRole("button", { name: "Copy diagnostics", exact: true }).isVisible(), true);
  await details.click();
  await page.waitForFunction(() => document.querySelector('.fm-simulation-startup__details-trigger')?.getAttribute('aria-expanded') === 'false');
  assert.equal(await status.locator('.fm-accordion-content').isVisible(), false);
  report.steps.push({ action: "preparation details expand and collapse without a modal", status: "passed" });
  await page.getByRole("button", { name: "Below sample", exact: true }).click();
  await page.waitForFunction(() => window.__antennaCpwViewport.read().side === "below");
  report.steps.push({ action: "viewport controls remain clickable during failed preparation", status: "passed" });
  const screenshot = resolve(output, "preparation-workspace.png");
  await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
  assert.deepEqual(report.errors, []);
  report.state = "passed";
} catch (error) {
  report.state = "failed"; report.error = error.stack ?? String(error); process.exitCode = 1;
} finally {
  await browser?.close();
  await writeFile(resolve(output, "preparation-workspace-report.json"), JSON.stringify(report, null, 2));
}
