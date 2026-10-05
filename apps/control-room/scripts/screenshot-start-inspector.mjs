import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

import { installWorkspaceApi } from "./fixtures/start-screen-workspace-api.mjs";

// Screenshots of the start screen's inspector for a project, a script and a
// result folder (workspace API served from fixtures), next to the approved
// sketch. Skipped unless SCREENSHOT_DIR is set; START_SCREEN_URL names the
// running control room (default http://localhost:3299).

const outDir = process.env.SCREENSHOT_DIR?.trim();
if (!outDir) {
  console.log("SCREENSHOT_DIR is not set: skipping the inspector screenshots.");
  process.exit(0);
}
const base = (process.env.START_SCREEN_URL ?? "http://localhost:3299").replace(/\/$/, "");
const sketch = pathToFileURL(
  path.resolve(
    fileURLToPath(new URL("../../../docs/design/start-screen/mockups/reference-start-screen-2026-10-03.html", import.meta.url)),
  ),
).href;

await mkdir(outDir, { recursive: true });
const browserChannel = process.env.CONTROL_ROOM_BROWSER_CHANNEL ?? "chrome";
const browser = await chromium.launch(browserChannel === "chromium" ? {} : { channel: browserChannel });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: "dark" });
  const page = await context.newPage();
  await installWorkspaceApi(page);

  const shot = async (name) => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    console.log(`wrote ${name}.png`);
  };

  await page.goto(`${base}/workspace`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForSelector(".fm-start", { timeout: 60_000 });
  await page.waitForSelector('[role="option"]', { timeout: 30_000 });

  // Project: overview, then the Runs tab.
  await page.getByRole("option", { name: /YIG waveguide/ }).click();
  await page.waitForSelector('[aria-label="Project details"] .fm-start-kv');
  await shot("inspector-project-overview");
  await page.getByRole("tab", { name: "Runs" }).click();
  await shot("inspector-project-runs");

  // Script: overview, history (edit events), runs.
  await page.locator('[role="option"][data-kind="script"]').first().click();
  await page.waitForSelector('[aria-label="Script details"]');
  await page.waitForSelector('[aria-label="Script details"] .fm-start-kv');
  await shot("inspector-script-overview");
  await page.getByRole("tab", { name: "History" }).click();
  await shot("inspector-script-history");
  await page.getByRole("tab", { name: "Runs" }).click();
  await shot("inspector-script-runs");

  // Result folder.
  await page.locator('[role="option"][data-kind="result"]').first().click();
  await page.waitForSelector('[aria-label="Result details"] .fm-start-kv');
  await shot("inspector-result-overview");
  await page.getByRole("tab", { name: "Stages" }).click();
  await shot("inspector-result-stages");

  // Settings: indexed locations.
  await page.getByRole("button", { name: /Settings/ }).first().click();
  await page.waitForSelector('[data-section="indexed-locations"]');
  await page.getByRole("button", { name: "Scan now" }).click();
  await page.waitForSelector(".fm-start-scan");
  await shot("settings-indexed-locations");

  const sketchPage = await context.newPage();
  await sketchPage.goto(sketch);
  await sketchPage.waitForTimeout(500);
  await sketchPage.screenshot({ path: path.join(outDir, "sketch.png") });
  console.log("wrote sketch.png");
} finally {
  await browser.close();
}
