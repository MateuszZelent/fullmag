import path from "node:path";
import {
  assertNoUiErrors,
  assertWebGLCanvasHealthy,
  captureAndVerifyPng,
} from "./assertions.mjs";
import { createDocsFixtureContext } from "./fixtures.mjs";

const BASE_URL = "http://127.0.0.1:3274";
const VIEWPORT = { width: 1600, height: 1000 };
const DEVICE_SCALE = 2;

async function waitForUiSettled(page, ms = 650) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(ms);
}

async function waitForCanvasRendered(page, label, { requireWebGL = true } = {}) {
  await page.waitForSelector("canvas", { state: "visible", timeout: 20_000 });
  await page.waitForTimeout(900);
  await assertWebGLCanvasHealthy(page, label, { requireWebGL });
}

async function getBoundingClip(page, selectors, fallbackClip, padding = 0) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if (await loc.count()) {
      const box = await loc.boundingBox();
      if (box && box.width >= 40 && box.height >= 24) {
        const x = Math.max(0, Math.floor(box.x - padding));
        const y = Math.max(0, Math.floor(box.y - padding));
        const maxW = VIEWPORT.width - x;
        const maxH = VIEWPORT.height - y;
        return {
          x,
          y,
          width: Math.min(maxW, Math.ceil(box.width + padding * 2)),
          height: Math.min(maxH, Math.ceil(box.height + padding * 2)),
        };
      }
    }
  }
  return fallbackClip;
}

async function getCanvasSubRect(page, selectors = [".fm-viewport-3d canvas", ".fm-field-map canvas", "canvas"]) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if (await loc.count()) {
      const box = await loc.boundingBox();
      if (box && box.width >= 80 && box.height >= 80) {
        return {
          x: Math.max(0, box.x + 8),
          y: Math.max(0, box.y + 8),
          width: Math.max(32, box.width - 16),
          height: Math.max(32, box.height - 16),
        };
      }
    }
  }
  return undefined;
}

async function openFreshPage(browser, fixtureOptions, routePath) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE,
    colorScheme: fixtureOptions.theme === "light" ? "light" : "dark",
  });
  const fixture = createDocsFixtureContext(fixtureOptions);
  await fixture.install(context);
  const page = await context.newPage();
  const guard = (await import("./assertions.mjs")).attachPageErrorGuards(page);

  await page.goto(`${BASE_URL}${routePath}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await waitForUiSettled(page, 1200);
  return { context, page, fixture, guard };
}

async function closeSession({ context, guard, fixture }, label) {
  const unmocked = fixture.getUnmockedRequests();
  if (unmocked.length > 0) {
    throw new Error(`[${label}] Unmocked /v2/** routes encountered:\n${unmocked.join("\n")}`);
  }
  guard.assertClean(label);
  guard.detach();
  await context.close();
}

async function clickFirstMatching(page, locators) {
  for (const item of locators) {
    const loc = typeof item === "function" ? item(page) : page.locator(item).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      await loc.click();
      return true;
    }
  }
  return false;
}

async function selectExplorerTab(page, tabName) {
  await page.waitForSelector('.fm-explorer [role="tab"]', { timeout: 15_000 });
  const tab = page.locator(".fm-explorer").getByRole("tab", { name: tabName, exact: true }).first();
  if ((await tab.count()) === 0) {
    throw new Error(`[selectExplorerTab] Explorer tab "${tabName}" not found`);
  }
  if ((await tab.getAttribute("aria-selected")) !== "true") {
    await tab.click();
    await waitForUiSettled(page, 600);
  }
  await page
    .waitForFunction(() => document.querySelectorAll(".fm-explorer [data-node-id]").length > 0, null, { timeout: 15_000 })
    .catch(() => {});
  await waitForUiSettled(page, 250);
  return true;
}

async function expandExplorerModelTree(page, tabName = "Model") {
  if (tabName) {
    await selectExplorerTab(page, tabName);
  }
  await page.waitForFunction(() => document.querySelectorAll(".fm-explorer [data-node-id]").length > 0, null, {
    timeout: 20_000,
  });
  const expandAllBtn = page.locator('.fm-explorer [aria-label="Expand all explorer nodes"]').first();
  if (await expandAllBtn.count()) {
    await expandAllBtn.click();
    await waitForUiSettled(page, 450);
    return;
  }
  for (let pass = 0; pass < 5; pass += 1) {
    const collapsed = page.locator('.fm-explorer [aria-expanded="false"], [data-slot="explorer"] [aria-expanded="false"]');
    const count = await collapsed.count();
    if (count === 0) break;
    for (let i = 0; i < Math.min(count, 40); i += 1) {
      await collapsed.nth(i).locator(".fm-explorer-tree-row__branch").first().click({ timeout: 5000 }).catch(() => {});
    }
    await waitForUiSettled(page, 250);
  }
}

async function clickExplorerLocator(locator, page) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({ timeout: 20_000 });
  } catch {
    await locator.evaluate((el) => el.click());
  }
  await waitForUiSettled(page, 500);
}

async function selectExplorerNode(page, nodePatterns, { tab = "Model" } = {}) {
  await expandExplorerModelTree(page, tab);
  for (const pattern of nodePatterns) {
    const byId = page.locator(`.fm-explorer [data-node-id="${pattern}"]`).first();
    if (await byId.count()) {
      await clickExplorerLocator(byId, page);
      return true;
    }
  }
  for (const pattern of nodePatterns) {
    const byPartial = page.locator(`.fm-explorer [data-node-id*="${pattern}"]`).first();
    if (await byPartial.count()) {
      await clickExplorerLocator(byPartial, page);
      return true;
    }
  }
  for (const pattern of nodePatterns) {
    const byText = page.locator(".fm-explorer, aside").getByText(pattern, { exact: false }).first();
    if ((await byText.count()) && (await byText.isVisible().catch(() => false))) {
      await clickExplorerLocator(byText, page);
      return true;
    }
  }
  throw new Error(`[selectExplorerNode] Failed to find Explorer node matching: ${nodePatterns.join(", ")}`);
}

async function clickWorkspaceCenterTab(page, tabName) {
  await page.waitForSelector('.fm-viewport-tabs [role="tab"]', { timeout: 20_000 });
  const tab = page.locator(".fm-viewport-tabs").getByRole("tab", { name: tabName, exact: true }).first();
  await tab.waitFor({ state: "visible", timeout: 15_000 });
  await tab.click();
  await page.waitForFunction(
    (expectedName) => {
      const tabs = [...document.querySelectorAll('.fm-viewport-tabs [role="tab"]')];
      return tabs.some((el) => el.textContent?.trim() === expectedName && el.getAttribute("aria-selected") === "true");
    },
    tabName,
    { timeout: 10_000 },
  );
  await waitForUiSettled(page, 900);
  return true;
}

/**
 * Returns the full ordered list of all 41 required documentation screenshot jobs.
 */
export function buildAllCaptureJobs(outputDir) {
  const out = (name) => path.join(outputDir, name);

  return [
    // =========================================================================
    // 1. CORE & THEMES (9)
    // =========================================================================
    {
      filename: "control-room-workspace-overview.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await expandExplorerModelTree(s.page);
          await waitForCanvasRendered(s.page, "control-room-workspace-overview");
          await assertNoUiErrors(s.page, "control-room-workspace-overview");
          const canvasRect = await getCanvasSubRect(s.page);
          return await captureAndVerifyPng(s.page, out("control-room-workspace-overview.png"), "control-room-workspace-overview", {
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 24,
          });
        } finally {
          await closeSession(s, "control-room-workspace-overview");
        }
      },
    },
    {
      filename: "control-room-light-latte-overview.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "light" }, "/session/yig-waveguide");
        try {
          await expandExplorerModelTree(s.page);
          await waitForCanvasRendered(s.page, "control-room-light-latte-overview");
          const appliedTheme = await s.page.evaluate(() => document.documentElement.dataset.theme);
          if (appliedTheme !== "light") {
            await clickFirstMatching(s.page, [(p) => p.locator('[aria-label^="Color theme:"]').first()]);
            await clickFirstMatching(s.page, [(p) => p.getByRole("menuitemradio", { name: "Light" }).first()]);
            await waitForUiSettled(s.page, 350);
          }
          await assertNoUiErrors(s.page, "control-room-light-latte-overview");
          const canvasRect = await getCanvasSubRect(s.page);
          return await captureAndVerifyPng(s.page, out("control-room-light-latte-overview.png"), "control-room-light-latte-overview", {
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 24,
          });
        } finally {
          await closeSession(s, "control-room-light-latte-overview");
        }
      },
    },
    {
      filename: "ribbon-tabs-geometry.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await waitForUiSettled(s.page, 800);
          await s.page.locator("#fm-ribbon-tab-geometry").click();
          await waitForUiSettled(s.page, 350);
          await assertNoUiErrors(s.page, "ribbon-tabs-geometry");
          return await captureAndVerifyPng(s.page, out("ribbon-tabs-geometry.png"), "ribbon-tabs-geometry", {
            clip: { x: 0, y: 0, width: 1600, height: 202 },
          });
        } finally {
          await closeSession(s, "ribbon-tabs-geometry");
        }
      },
    },
    {
      filename: "ribbon-tabs-physics.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await waitForUiSettled(s.page, 800);
          await s.page.locator("#fm-ribbon-tab-physics").click();
          await waitForUiSettled(s.page, 350);
          await assertNoUiErrors(s.page, "ribbon-tabs-physics");
          return await captureAndVerifyPng(s.page, out("ribbon-tabs-physics.png"), "ribbon-tabs-physics", {
            clip: { x: 0, y: 0, width: 1600, height: 202 },
          });
        } finally {
          await closeSession(s, "ribbon-tabs-physics");
        }
      },
    },
    {
      filename: "explorer-tree-structure.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await expandExplorerModelTree(s.page);
          await assertNoUiErrors(s.page, "explorer-tree-structure");
          const clip = await getBoundingClip(s.page, [".fm-explorer", "aside", '[data-panel-id="explorer"]'], { x: 0, y: 120, width: 320, height: 820 });
          return await captureAndVerifyPng(s.page, out("explorer-tree-structure.png"), "explorer-tree-structure", { clip });
        } finally {
          await closeSession(s, "explorer-tree-structure");
        }
      },
    },
    {
      filename: "viewport-3d-interactive.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await waitForCanvasRendered(s.page, "viewport-3d-interactive");
          await assertNoUiErrors(s.page, "viewport-3d-interactive");
          const clip = await getBoundingClip(s.page, [".fm-viewport-3d", "main"], { x: 300, y: 130, width: 920, height: 780 });
          const canvasRect = await getCanvasSubRect(s.page);
          return await captureAndVerifyPng(s.page, out("viewport-3d-interactive.png"), "viewport-3d-interactive", {
            clip,
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 20,
          });
        } finally {
          await closeSession(s, "viewport-3d-interactive");
        }
      },
    },
    {
      filename: "inspector-panel-draft.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await selectExplorerNode(s.page, ["model:object:obj_yig_film:geometry", "YIG Film Core"]);
          const inputs = s.page.locator('.fm-inspector input[type="text"], .fm-inspector input:not([type]), [data-panel-id="inspector"] input');
          if (await inputs.count()) {
            const firstInput = inputs.first();
            const current = await firstInput.inputValue().catch(() => "1.92e-7");
            const nextVal = current.includes("e-") ? "2.40e-7" : "240";
            await firstInput.click();
            await firstInput.fill(nextVal).catch(() => {});
            await waitForUiSettled(s.page, 350);
          }
          await assertNoUiErrors(s.page, "inspector-panel-draft");
          const clip = await getBoundingClip(s.page, [".fm-inspector", '[data-panel-id="inspector"]'], { x: 1200, y: 120, width: 400, height: 820 });
          return await captureAndVerifyPng(s.page, out("inspector-panel-draft.png"), "inspector-panel-draft", { clip });
        } finally {
          await closeSession(s, "inspector-panel-draft");
        }
      },
    },
    {
      filename: "status-bar-footer.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await waitForUiSettled(s.page, 800);
          // Open Telemetry/Diagnostics drawer in footer if a toggle exists so status bar + footer dock look informative
          await clickFirstMatching(s.page, [
            (p) => p.locator("footer button").first(),
          ]).catch(() => {});
          await waitForUiSettled(s.page, 300);
          await assertNoUiErrors(s.page, "status-bar-footer");
          const clip = await getBoundingClip(s.page, [".fm-footer", "footer", '[role="contentinfo"]'], { x: 0, y: 740, width: 1600, height: 260 }, 4);
          return await captureAndVerifyPng(s.page, out("status-bar-footer.png"), "status-bar-footer", {
            clip: { x: 0, y: Math.min(clip.y, 880), width: 1600, height: VIEWPORT.height - Math.min(clip.y, 880) },
          });
        } finally {
          await closeSession(s, "status-bar-footer");
        }
      },
    },
    {
      filename: "multi-instance-session-tabs.png",
      run: async (browser) => {
        const s = await openFreshPage(
          browser,
          { scenario: "fdm-skyrmion", theme: "dark", instanceTabs: [3206, 3212] },
          "/session/yig-waveguide",
        );
        try {
          await waitForCanvasRendered(s.page, "multi-instance-session-tabs");
          await assertNoUiErrors(s.page, "multi-instance-session-tabs");
          const canvasRect = await getCanvasSubRect(s.page);
          return await captureAndVerifyPng(s.page, out("multi-instance-session-tabs.png"), "multi-instance-session-tabs", {
            verifyCanvasRect: canvasRect,
          });
        } finally {
          await closeSession(s, "multi-instance-session-tabs");
        }
      },
    },

    // =========================================================================
    // 2. START SCREEN /home (4)
    // =========================================================================
    {
      filename: "start-screen-hub-overview.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "start-screen-hub", theme: "dark" }, "/home");
        try {
          await s.page.waitForSelector(".fm-start .fm-start__content-inner", { timeout: 15_000 });
          await s.page.waitForFunction(() => {
            if (document.querySelector("[data-start-screen-fallback]")) return false;
            const text = document.body?.innerText || "";
            return !text.includes("Reading host telemetry") && !text.includes("Session services are reconnecting");
          }, { timeout: 15_000 }).catch(() => {});
          await waitForUiSettled(s.page, 400);
          await assertNoUiErrors(s.page, "start-screen-hub-overview");
          return await captureAndVerifyPng(s.page, out("start-screen-hub-overview.png"), "start-screen-hub-overview", { minUniqueBuckets: 16 });
        } finally {
          await closeSession(s, "start-screen-hub-overview");
        }
      },
    },
    {
      filename: "start-screen-model-templates.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "start-screen-hub", theme: "dark" }, "/home");
        try {
          await s.page.waitForSelector(".fm-start .fm-start__content-inner", { timeout: 15_000 });
          await s.page.waitForFunction(() => {
            if (document.querySelector("[data-start-screen-fallback]")) return false;
            const text = document.body?.innerText || "";
            return !text.includes("Reading host telemetry") && !text.includes("Session services are reconnecting");
          }, { timeout: 15_000 }).catch(() => {});
          await s.page.locator('nav[aria-label="Start screen sections"] button', { hasText: /Templates/i }).first().click();
          await s.page.waitForFunction(() => {
            const h1 = document.querySelector(".fm-start__content-inner h1");
            return Boolean(h1 && !/Welcome/i.test(h1.textContent || ""));
          }, { timeout: 10_000 });
          await waitForUiSettled(s.page, 500);
          await assertNoUiErrors(s.page, "start-screen-model-templates");
          return await captureAndVerifyPng(s.page, out("start-screen-model-templates.png"), "start-screen-model-templates", { minUniqueBuckets: 16 });
        } finally {
          await closeSession(s, "start-screen-model-templates");
        }
      },
    },
    {
      filename: "start-screen-recent-sessions.png",
      run: async (browser) => {
        const s = await openFreshPage(
          browser,
          { scenario: "start-screen-hub", theme: "dark", instanceTabs: [3206, 3212] },
          "/home",
        );
        try {
          await s.page.waitForSelector(".fm-start .fm-start__content-inner", { timeout: 15_000 });
          await s.page.waitForFunction(() => {
            if (document.querySelector("[data-start-screen-fallback]")) return false;
            const text = document.body?.innerText || "";
            return !text.includes("Session services are reconnecting");
          }, { timeout: 15_000 }).catch(() => {});
          await s.page.locator(".fm-start").getByText("YIG Dispersion & Hysteresis Benchmark").first().waitFor({ timeout: 5_000 }).catch(() => {});
          await clickFirstMatching(s.page, [
            (p) => p.locator(".fm-start").getByText("YIG Dispersion & Hysteresis Benchmark").first(),
          ]).catch(() => {});
          await waitForUiSettled(s.page, 400);
          await assertNoUiErrors(s.page, "start-screen-recent-sessions");
          return await captureAndVerifyPng(s.page, out("start-screen-recent-sessions.png"), "start-screen-recent-sessions", { minUniqueBuckets: 16 });
        } finally {
          await closeSession(s, "start-screen-recent-sessions");
        }
      },
    },
    {
      filename: "start-screen-python-live-connect.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "start-screen-live", theme: "dark" }, "/home");
        try {
          await s.page.waitForSelector(".fm-start .fm-start__content-inner", { timeout: 15_000 });
          await s.page.waitForFunction(() => {
            if (document.querySelector("[data-start-screen-fallback]")) return false;
            const text = document.body?.innerText || "";
            return !text.includes("Reading host telemetry") && !text.includes("Session services are reconnecting");
          }, { timeout: 15_000 }).catch(() => {});
          await waitForUiSettled(s.page, 600);
          await assertNoUiErrors(s.page, "start-screen-python-live-connect");
          return await captureAndVerifyPng(s.page, out("start-screen-python-live-connect.png"), "start-screen-python-live-connect", { minUniqueBuckets: 16 });
        } finally {
          await closeSession(s, "start-screen-python-live-connect");
        }
      },
    },

    // =========================================================================
    // 3. RIBBON, COMMAND PALETTE & EXPLORER TABS (7)
    // =========================================================================
    {
      filename: "ribbon-tabs-materials-and-mesh.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fem-airbox", theme: "dark" }, "/session/yig-waveguide");
        try {
          await waitForUiSettled(s.page, 800);
          await s.page.locator("#fm-ribbon-tab-mesh").click();
          await waitForUiSettled(s.page, 350);
          await assertNoUiErrors(s.page, "ribbon-tabs-materials-and-mesh");
          return await captureAndVerifyPng(s.page, out("ribbon-tabs-materials-and-mesh.png"), "ribbon-tabs-materials-and-mesh", {
            clip: { x: 0, y: 0, width: 1600, height: 202 },
          });
        } finally {
          await closeSession(s, "ribbon-tabs-materials-and-mesh");
        }
      },
    },
    {
      filename: "ribbon-tabs-study-and-results.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "study-hysteresis", theme: "dark" }, "/session/yig-waveguide");
        try {
          await waitForUiSettled(s.page, 800);
          await s.page.locator("#fm-ribbon-tab-study").click();
          await waitForUiSettled(s.page, 350);
          await assertNoUiErrors(s.page, "ribbon-tabs-study-and-results");
          return await captureAndVerifyPng(s.page, out("ribbon-tabs-study-and-results.png"), "ribbon-tabs-study-and-results", {
            clip: { x: 0, y: 0, width: 1600, height: 202 },
          });
        } finally {
          await closeSession(s, "ribbon-tabs-study-and-results");
        }
      },
    },
    {
      filename: "ribbon-tabs-automation-python.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await waitForUiSettled(s.page, 800);
          await clickFirstMatching(s.page, [(p) => p.getByRole("button", { name: "File", exact: true }).first()]);
          await waitForUiSettled(s.page, 350);
          await assertNoUiErrors(s.page, "ribbon-tabs-automation-python");
          return await captureAndVerifyPng(s.page, out("ribbon-tabs-automation-python.png"), "ribbon-tabs-automation-python", {
            clip: { x: 0, y: 0, width: 1100, height: 420 },
          });
        } finally {
          await closeSession(s, "ribbon-tabs-automation-python");
        }
      },
    },
    {
      filename: "command-palette-ctrl-k.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await waitForCanvasRendered(s.page, "command-palette-ctrl-k");
          const opened = await clickFirstMatching(s.page, [
            (p) => p.locator('[title*="Command search"]').first(),
          ]);
          if (!opened) {
            await s.page.keyboard.press("Control+Shift+P");
          }
          await waitForUiSettled(s.page, 400);
          await assertNoUiErrors(s.page, "command-palette-ctrl-k");
          return await captureAndVerifyPng(s.page, out("command-palette-ctrl-k.png"), "command-palette-ctrl-k", { minUniqueBuckets: 16 });
        } finally {
          await closeSession(s, "command-palette-ctrl-k");
        }
      },
    },
    {
      filename: "explorer-resources-tab.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fem-airbox", theme: "dark" }, "/session/yig-waveguide");
        try {
          await waitForUiSettled(s.page, 700);
          await selectExplorerTab(s.page, "Resources");
          await s.page.locator('.fm-explorer [aria-label="Expand all explorer nodes"]').click().catch(() => {});
          await waitForUiSettled(s.page, 350);
          await assertNoUiErrors(s.page, "explorer-resources-tab");
          const clip = await getBoundingClip(s.page, [".fm-explorer", '[data-panel-id="panel-left"]', "aside"], { x: 0, y: 120, width: 350, height: 600 });
          return await captureAndVerifyPng(s.page, out("explorer-resources-tab.png"), "explorer-resources-tab", { clip });
        } finally {
          await closeSession(s, "explorer-resources-tab");
        }
      },
    },
    {
      filename: "explorer-results-tab.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "results-eigen-dispersion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await selectExplorerTab(s.page, "Results");
          await s.page.locator('.fm-explorer [aria-label="Expand all explorer nodes"]').click().catch(() => {});
          await waitForUiSettled(s.page, 350);
          await assertNoUiErrors(s.page, "explorer-results-tab");
          const clip = await getBoundingClip(s.page, [".fm-explorer", '[data-panel-id="panel-left"]', "aside"], { x: 0, y: 120, width: 350, height: 600 });
          return await captureAndVerifyPng(s.page, out("explorer-results-tab.png"), "explorer-results-tab", { clip });
        } finally {
          await closeSession(s, "explorer-results-tab");
        }
      },
    },
    {
      filename: "explorer-jobs-and-diagnostics-tabs.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fem-airbox", theme: "dark" }, "/session/yig-waveguide");
        try {
          await waitForUiSettled(s.page, 700);
          await selectExplorerTab(s.page, "Diagnostics");
          await s.page.locator('.fm-explorer [aria-label="Expand all explorer nodes"]').click().catch(() => {});
          await waitForUiSettled(s.page, 350);
          await assertNoUiErrors(s.page, "explorer-jobs-and-diagnostics-tabs");
          const clip = await getBoundingClip(s.page, [".fm-explorer", '[data-panel-id="panel-left"]', "aside"], { x: 0, y: 120, width: 350, height: 600 });
          return await captureAndVerifyPng(s.page, out("explorer-jobs-and-diagnostics-tabs.png"), "explorer-jobs-and-diagnostics-tabs", { clip });
        } finally {
          await closeSession(s, "explorer-jobs-and-diagnostics-tabs");
        }
      },
    },

    // =========================================================================
    // 4. 3D WEBGL VIEWPORT, FEM AIRBOX & STUDIO RENDERING (4)
    // =========================================================================
    {
      filename: "viewport-3d-fem-mesh-airbox.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fem-airbox", theme: "dark" }, "/session/yig-waveguide");
        try {
          await selectExplorerNode(s.page, ["model:airbox:mesh", "model:mesh:shared-domain", "Airbox", "Shared Domain"]);
          await waitForCanvasRendered(s.page, "viewport-3d-fem-mesh-airbox");
          await assertNoUiErrors(s.page, "viewport-3d-fem-mesh-airbox");
          const clip = await getBoundingClip(s.page, [".fm-viewport-3d", "main"], { x: 300, y: 130, width: 920, height: 780 });
          const canvasRect = await getCanvasSubRect(s.page);
          return await captureAndVerifyPng(s.page, out("viewport-3d-fem-mesh-airbox.png"), "viewport-3d-fem-mesh-airbox", {
            clip,
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 16,
          });
        } finally {
          await closeSession(s, "viewport-3d-fem-mesh-airbox");
        }
      },
    },
    {
      filename: "viewport-3d-surface-projections-clipping.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fem-airbox", theme: "dark" }, "/session/yig-waveguide");
        try {
          const curViz = s.fixture.getVizState();
          s.fixture.setVizState({
            clip: { enabled: true, axis: "x", flipped: false, position_percent: 58 },
            targets: {
              ...curViz.targets,
              objects: curViz.targets.objects.map((obj) => ({
                ...obj,
                settings: {
                  ...obj.settings,
                  render_mode: "surface+edges",
                  surface_projection_mode: "thickness_average_z",
                  wireframe_visible: true,
                },
              })),
            },
          });
          await s.page.reload({ waitUntil: "domcontentloaded" });
          await waitForUiSettled(s.page, 1000);
          await waitForCanvasRendered(s.page, "viewport-3d-surface-projections-clipping");
          await assertNoUiErrors(s.page, "viewport-3d-surface-projections-clipping");
          const clip = await getBoundingClip(s.page, [".fm-viewport-3d", "main"], { x: 300, y: 130, width: 920, height: 780 });
          const canvasRect = await getCanvasSubRect(s.page);
          return await captureAndVerifyPng(s.page, out("viewport-3d-surface-projections-clipping.png"), "viewport-3d-surface-projections-clipping", {
            clip,
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 16,
          });
        } finally {
          await closeSession(s, "viewport-3d-surface-projections-clipping");
        }
      },
    },
    {
      filename: "viewport-3d-studio-rendering.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "study-hysteresis", theme: "dark" }, "/session/yig-waveguide");
        try {
          await waitForCanvasRendered(s.page, "viewport-3d-studio-rendering");
          // Open View Settings and select Presentation (PBR & studio HDRI).
          await clickFirstMatching(s.page, [(p) => p.locator(".fm-viewport-3d__render-details-trigger").first()]);
          await waitForUiSettled(s.page, 350);
          await s.page.getByRole("radiogroup", { name: "Visualization mode", exact: true })
            .getByRole("radio", { name: "Presentation", exact: true }).click({ timeout: 2500 });
          await clickFirstMatching(s.page, [
            (p) => p.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).first(),
          ]).catch(() => {});
          await s.page.keyboard.press("Escape").catch(() => {});
          await waitForUiSettled(s.page, 700);
          await assertNoUiErrors(s.page, "viewport-3d-studio-rendering");
          const clip = await getBoundingClip(s.page, [".fm-viewport-3d", "main"], { x: 300, y: 130, width: 920, height: 780 });
          const canvasRect = await getCanvasSubRect(s.page);
          return await captureAndVerifyPng(s.page, out("viewport-3d-studio-rendering.png"), "viewport-3d-studio-rendering", {
            clip,
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 20,
          });
        } finally {
          await closeSession(s, "viewport-3d-studio-rendering");
        }
      },
    },
    {
      filename: "viewport-3d-eigenmode-spatial-profile.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "results-eigen-dispersion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await selectExplorerTab(s.page, "Results");
          await s.page.waitForSelector(".fm-explorer [data-node-id]", { timeout: 15_000 });
          await s.page.locator('.fm-explorer [aria-label="Expand all explorer nodes"]').click().catch(() => {});
          await waitForUiSettled(s.page, 350);
          await selectExplorerNode(s.page, ["Sample 0 · Mode 2", "Mode 2", "Mode Shapes", "Resonance"], { tab: null });
          await waitForCanvasRendered(s.page, "viewport-3d-eigenmode-spatial-profile");
          await assertNoUiErrors(s.page, "viewport-3d-eigenmode-spatial-profile");
          const clip = await getBoundingClip(s.page, [".fm-viewport-3d", "main"], { x: 300, y: 130, width: 920, height: 780 });
          const canvasRect = await getCanvasSubRect(s.page);
          return await captureAndVerifyPng(s.page, out("viewport-3d-eigenmode-spatial-profile.png"), "viewport-3d-eigenmode-spatial-profile", {
            clip,
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 16,
          });
        } finally {
          await closeSession(s, "viewport-3d-eigenmode-spatial-profile");
        }
      },
    },

    // =========================================================================
    // 5. 2D PLANAR FIELD MAP & TOOLS (4)
    // =========================================================================
    {
      filename: "planar-2d-field-map-overview.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await clickWorkspaceCenterTab(s.page, "2D View");
          await s.page.waitForSelector(".fm-field-map canvas.fm-field-map__canvas", { state: "visible", timeout: 15_000 });
          await waitForUiSettled(s.page, 800);
          await assertNoUiErrors(s.page, "planar-2d-field-map-overview");
          const clip = await getBoundingClip(s.page, [".fm-field-map", ".fm-viewport-tabs"], { x: 280, y: 120, width: 960, height: 800 });
          const canvasRect = await getCanvasSubRect(s.page, [".fm-field-map canvas.fm-field-map__canvas", ".fm-field-map canvas"]);
          return await captureAndVerifyPng(s.page, out("planar-2d-field-map-overview.png"), "planar-2d-field-map-overview", {
            clip,
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 20,
          });
        } finally {
          await closeSession(s, "planar-2d-field-map-overview");
        }
      },
    },
    {
      filename: "planar-2d-streamlines-and-contours.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          s.fixture.setVizState({
            planar: {
              ...s.fixture.getVizState().planar,
              layers: {
                ...s.fixture.getVizState().planar?.layers,
                boundaries: false,
                bounds: true,
                contours: true,
                mesh: false,
                points: false,
                probes: true,
                raster: true,
                streamlines: true,
                vectors: false,
              },
            },
          });
          await s.page.reload({ waitUntil: "domcontentloaded" });
          await waitForUiSettled(s.page, 700);
          await clickWorkspaceCenterTab(s.page, "2D View");
          await s.page.waitForSelector(".fm-field-map canvas.fm-field-map__canvas", { state: "visible", timeout: 15_000 });
          await waitForUiSettled(s.page, 800);
          await assertNoUiErrors(s.page, "planar-2d-streamlines-and-contours");
          const clip = await getBoundingClip(s.page, [".fm-field-map", ".fm-viewport-tabs"], { x: 280, y: 120, width: 960, height: 800 });
          const canvasRect = await getCanvasSubRect(s.page, [".fm-field-map canvas.fm-field-map__canvas", ".fm-field-map canvas"]);
          return await captureAndVerifyPng(s.page, out("planar-2d-streamlines-and-contours.png"), "planar-2d-streamlines-and-contours", {
            clip,
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 18,
          });
        } finally {
          await closeSession(s, "planar-2d-streamlines-and-contours");
        }
      },
    },
    {
      filename: "planar-2d-line-profile-and-measure.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await clickWorkspaceCenterTab(s.page, "2D View");
          await s.page.waitForSelector(".fm-field-map canvas.fm-field-map__canvas", { state: "visible", timeout: 15_000 });
          await waitForUiSettled(s.page, 800);
          // Click "Line profile" radio tool in "2D view tools" toolbar & drag across the 2D canvas
          const lineProfileTool = s.page
            .getByRole("toolbar", { name: "2D view tools", exact: true })
            .getByRole("radio", { name: "Line profile", exact: true });
          if (await lineProfileTool.count()) {
            await lineProfileTool.click();
            await waitForUiSettled(s.page, 250);
          }
          const canvasRect = await getCanvasSubRect(s.page, [".fm-field-map canvas.fm-field-map__canvas", ".fm-field-map canvas"]);
          if (canvasRect) {
            const x1 = canvasRect.x + canvasRect.width * 0.22;
            const y1 = canvasRect.y + canvasRect.height * 0.52;
            const x2 = canvasRect.x + canvasRect.width * 0.78;
            const y2 = canvasRect.y + canvasRect.height * 0.48;
            await s.page.mouse.move(x1, y1);
            await s.page.mouse.down();
            await s.page.mouse.move(x2, y2, { steps: 10 });
            await s.page.mouse.up();
            await waitForUiSettled(s.page, 800);
          }
          await assertNoUiErrors(s.page, "planar-2d-line-profile-and-measure");
          const clip = await getBoundingClip(s.page, [".fm-field-map", ".fm-viewport-tabs"], { x: 280, y: 120, width: 960, height: 800 });
          return await captureAndVerifyPng(s.page, out("planar-2d-line-profile-and-measure.png"), "planar-2d-line-profile-and-measure", {
            clip,
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 16,
          });
        } finally {
          await closeSession(s, "planar-2d-line-profile-and-measure");
        }
      },
    },
    {
      filename: "planar-2d-multislice-and-layers.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fem-airbox", theme: "dark" }, "/session/yig-waveguide");
        try {
          s.fixture.setVizState({
            planar: {
              ...s.fixture.getVizState().planar,
              layers: {
                ...s.fixture.getVizState().planar?.layers,
                boundaries: false,
                bounds: true,
                contours: false,
                mesh: true,
                points: false,
                probes: true,
                raster: true,
                streamlines: false,
                vectors: true,
              },
              multislice: { enabled: true, position_fractions: [0.25, 0.5, 0.75] },
            },
          });
          await s.page.reload({ waitUntil: "domcontentloaded" });
          await waitForUiSettled(s.page, 700);
          await clickWorkspaceCenterTab(s.page, "2D View");
          await s.page.waitForSelector('.fm-field-map [data-multislice-state="ready"] canvas.fm-field-map__multislice-canvas', { state: "visible", timeout: 15_000 });
          await waitForUiSettled(s.page, 900);
          await assertNoUiErrors(s.page, "planar-2d-multislice-and-layers");
          const clip = await getBoundingClip(s.page, [".fm-field-map", ".fm-viewport-tabs"], { x: 280, y: 120, width: 960, height: 800 });
          const canvasRect = await getCanvasSubRect(s.page, [".fm-field-map canvas.fm-field-map__multislice-canvas", ".fm-field-map canvas"]);
          return await captureAndVerifyPng(s.page, out("planar-2d-multislice-and-layers.png"), "planar-2d-multislice-and-layers", {
            clip,
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 18,
          });
        } finally {
          await closeSession(s, "planar-2d-multislice-and-layers");
        }
      },
    },

    // =========================================================================
    // 6. LIVE CHARTS, HYSTERESIS, DISPERSION/FMR & SAVED RESULTS (4)
    // =========================================================================
    {
      filename: "charts-live-time-series.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await clickWorkspaceCenterTab(s.page, "Live Charts");
          await s.page.waitForFunction(
            () => {
              const root = document.querySelector(".fm-live-charts");
              const canvas = root?.querySelector(".fm-analysis-chart-surface canvas") ?? root?.querySelector("canvas");
              const legendLatest = root?.querySelector(".fm-chart-legend__latest");
              if (!canvas || canvas.width <= 0 || canvas.height <= 0 || !legendLatest) {
                return false;
              }
              const rect = canvas.getBoundingClientRect();
              return rect.width > 120 && rect.height > 120;
            },
            null,
            { timeout: 15000 }
          );
          await waitForUiSettled(s.page, 600);
          await assertNoUiErrors(s.page, "charts-live-time-series");
          const clip = await getBoundingClip(s.page, [".fm-viewport-tabs"], { x: 280, y: 120, width: 960, height: 800 });
          const canvasRect = await getCanvasSubRect(s.page, [
            ".fm-live-charts .fm-analysis-chart-surface canvas",
            ".fm-live-charts canvas",
          ]);
          return await captureAndVerifyPng(s.page, out("charts-live-time-series.png"), "charts-live-time-series", {
            clip,
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 12,
          });
        } finally {
          await closeSession(s, "charts-live-time-series");
        }
      },
    },
    {
      filename: "charts-hysteresis-loop-playback.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "study-hysteresis", theme: "dark" }, "/session/yig-waveguide");
        try {
          await s.page.evaluate(() => {
            window.localStorage.setItem(
              "fm:analysis-view-preferences:v2",
              JSON.stringify({
                schemaVersion: 2,
                activeSurface: "hysteresis",
                activeSubviews: { hysteresis: "hysteresis.loop" },
              })
            );
          });
          await s.page.reload({ waitUntil: "domcontentloaded" });
          await clickWorkspaceCenterTab(s.page, "Analysis");
          await expandExplorerModelTree(s.page);
          await selectExplorerNode(s.page, ["stage_hysteresis_01", "Hysteresis Sweep"]);
          await s.page.waitForFunction(
            () => {
              const root = document.querySelector(".fm-analysis-plots");
              const canvas = root?.querySelector("canvas");
              if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
                return false;
              }
              const rect = canvas.getBoundingClientRect();
              return rect.width > 120 && rect.height > 120;
            },
            null,
            { timeout: 15000 }
          );
          await s.page.evaluate(() => {
            const target =
              document.querySelector(".fm-analysis-plots .fm-analysis-chart-surface") ??
              document.querySelector(".fm-analysis-plots canvas");
            target?.scrollIntoView({ block: "end", inline: "nearest" });
          });
          await waitForUiSettled(s.page, 700);
          await assertNoUiErrors(s.page, "charts-hysteresis-loop-playback");
          const clip = await getBoundingClip(s.page, [".fm-viewport-tabs"], { x: 280, y: 120, width: 960, height: 800 });
          const canvasRect = await getCanvasSubRect(s.page, [".fm-analysis-plots canvas"]);
          return await captureAndVerifyPng(s.page, out("charts-hysteresis-loop-playback.png"), "charts-hysteresis-loop-playback", {
            clip,
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 12,
          });
        } finally {
          await closeSession(s, "charts-hysteresis-loop-playback");
        }
      },
    },
    {
      filename: "charts-dispersion-and-fmr-spectrum.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "results-eigen-dispersion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await s.page.evaluate(() => {
            window.localStorage.setItem(
              "fm:analysis-view-preferences:v2",
              JSON.stringify({
                schemaVersion: 2,
                activeSurface: "dispersion",
                activeSubviews: { dispersion: "dispersion.modal" },
              })
            );
          });
          await s.page.reload({ waitUntil: "domcontentloaded" });
          await clickWorkspaceCenterTab(s.page, "Analysis");
          await s.page.waitForFunction(
            () => {
              const root = document.querySelector(".fm-analysis-plots");
              const canvas = root?.querySelector(".fm-analysis-chart-surface canvas") ?? root?.querySelector("canvas");
              const legendLabel = root?.querySelector(".fm-chart-legend__label");
              if (!canvas || canvas.width <= 0 || canvas.height <= 0 || !legendLabel) {
                return false;
              }
              const rect = canvas.getBoundingClientRect();
              return rect.width > 120 && rect.height > 120;
            },
            null,
            { timeout: 15000 }
          );
          await s.page.evaluate(() => {
            const target =
              document.querySelector(".fm-analysis-plots .fm-analysis-chart-surface") ??
              document.querySelector(".fm-analysis-plots canvas");
            target?.scrollIntoView({ block: "end", inline: "nearest" });
          });
          await waitForUiSettled(s.page, 700);
          await assertNoUiErrors(s.page, "charts-dispersion-and-fmr-spectrum");
          const clip = await getBoundingClip(s.page, [".fm-viewport-tabs"], { x: 280, y: 120, width: 960, height: 800 });
          const canvasRect = await getCanvasSubRect(s.page, [
            ".fm-analysis-plots .fm-analysis-chart-surface canvas",
            ".fm-analysis-plots canvas",
          ]);
          return await captureAndVerifyPng(s.page, out("charts-dispersion-and-fmr-spectrum.png"), "charts-dispersion-and-fmr-spectrum", {
            clip,
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 12,
          });
        } finally {
          await closeSession(s, "charts-dispersion-and-fmr-spectrum");
        }
      },
    },
    {
      filename: "results-saved-navigator-comparison.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "results-saved-project", theme: "dark" }, "/session/yig-waveguide");
        try {
          await waitForCanvasRendered(s.page, "results-saved-navigator-comparison").catch(() => {});
          await selectExplorerTab(s.page, "Results");
          const savedSummary = s.page.locator("summary", { hasText: "Saved Study results" }).first();
          await savedSummary.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
          const isDetailsOpen = await savedSummary.evaluate((el) => Boolean(el.closest("details")?.open)).catch(() => false);
          if (!isDetailsOpen) {
            await savedSummary.click().catch(() => {});
            await waitForUiSettled(s.page, 300);
          }
          await s.page.locator('ul[aria-label="Published Study final states"] button').first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
          await clickFirstMatching(s.page, [
            (p) => p.locator('ul[aria-label="Published Study final states"] button', { hasText: /ss_eigen_modes|run_sweep_042_fem/i }).first(),
            (p) => p.locator('ul[aria-label="Published Study final states"] button').first(),
          ]).catch(() => {});
          await waitForUiSettled(s.page, 300);
          await s.page.locator('.fm-explorer [aria-label="Expand all explorer nodes"]').click().catch(() => {});
          await waitForUiSettled(s.page, 300);
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const collapsed = s.page.locator('.fm-explorer [role="treeitem"][aria-expanded="false"] .fm-explorer-tree-row__branch').first();
            if ((await collapsed.count()) === 0) {
              break;
            }
            await collapsed.click().catch(() => {});
            await waitForUiSettled(s.page, 120);
          }
          await waitForUiSettled(s.page, 500);
          await assertNoUiErrors(s.page, "results-saved-navigator-comparison");
          return await captureAndVerifyPng(s.page, out("results-saved-navigator-comparison.png"), "results-saved-navigator-comparison", { minUniqueBuckets: 16 });
        } finally {
          await closeSession(s, "results-saved-navigator-comparison");
        }
      },
    },

    // =========================================================================
    // 7. DEDICATED SEMANTIC INSPECTORS (9)
    // =========================================================================
    {
      filename: "inspector-geometry-and-csg.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await selectExplorerNode(s.page, ["model:object:obj_yig_film:geometry", "Geometry"]);
          await assertNoUiErrors(s.page, "inspector-geometry-and-csg");
          const clip = await getBoundingClip(s.page, [".fm-inspector", '[data-panel-id="inspector"]'], { x: 1200, y: 120, width: 400, height: 820 });
          return await captureAndVerifyPng(s.page, out("inspector-geometry-and-csg.png"), "inspector-geometry-and-csg", { clip });
        } finally {
          await closeSession(s, "inspector-geometry-and-csg");
        }
      },
    },
    {
      filename: "inspector-material-and-regions.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await selectExplorerNode(s.page, ["model:object:obj_yig_film:regions", "model:object:obj_yig_film:material", "Skyrmion Core", "Material"]);
          await assertNoUiErrors(s.page, "inspector-material-and-regions");
          const clip = await getBoundingClip(s.page, [".fm-inspector", '[data-panel-id="inspector"]'], { x: 1200, y: 120, width: 400, height: 820 });
          return await captureAndVerifyPng(s.page, out("inspector-material-and-regions.png"), "inspector-material-and-regions", { clip });
        } finally {
          await closeSession(s, "inspector-material-and-regions");
        }
      },
    },
    {
      filename: "inspector-magnetic-texture.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await selectExplorerNode(s.page, ["model:object:obj_yig_film:magnetic-texture", "Magnetic Texture", "Magnetization"]);
          await assertNoUiErrors(s.page, "inspector-magnetic-texture");
          const clip = await getBoundingClip(s.page, [".fm-inspector", '[data-panel-id="inspector"]'], { x: 1200, y: 120, width: 400, height: 820 });
          return await captureAndVerifyPng(s.page, out("inspector-magnetic-texture.png"), "inspector-magnetic-texture", { clip });
        } finally {
          await closeSession(s, "inspector-magnetic-texture");
        }
      },
    },
    {
      filename: "inspector-physics-couplings-frozen-spins.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await selectExplorerNode(s.page, ["frz_edge_pin", "Left Edge Pinning", "Frozen Spins", "cpl_rkky_01"]);
          await assertNoUiErrors(s.page, "inspector-physics-couplings-frozen-spins");
          const clip = await getBoundingClip(s.page, [".fm-inspector", '[data-panel-id="inspector"]'], { x: 1200, y: 120, width: 400, height: 820 });
          return await captureAndVerifyPng(s.page, out("inspector-physics-couplings-frozen-spins.png"), "inspector-physics-couplings-frozen-spins", { clip });
        } finally {
          await closeSession(s, "inspector-physics-couplings-frozen-spins");
        }
      },
    },
    {
      filename: "inspector-antenna-rf-and-waveforms.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fem-airbox", theme: "dark" }, "/session/yig-waveguide");
        try {
          await selectExplorerNode(s.page, [
            "model:object:obj_cpw_track:antenna:drive:drv_cpw_sinc",
            "model:object:obj_cpw_track:antenna:port:port_cpw_inlet",
            "model:object:obj_cpw_track:antenna",
            "Broadband Sinc RF Drive",
          ]);
          await s.page.waitForFunction(
            () => {
              const canvas = document.querySelector(".fm-inspector canvas");
              if (!canvas || canvas.width <= 0 || canvas.height <= 0) return false;
              const rect = canvas.getBoundingClientRect();
              return rect.width > 120 && rect.height > 40;
            },
            null,
            { timeout: 15_000 }
          );
          await s.page.evaluate(() => {
            const scroller = [...document.querySelectorAll('.fm-inspector, [data-panel-id="inspector"], .fm-inspector *')]
              .find((el) => el.scrollHeight > el.clientHeight + 40);
            if (scroller) {
              scroller.scrollTop = scroller.scrollHeight;
            }
          });
          await waitForUiSettled(s.page, 900);
          await assertNoUiErrors(s.page, "inspector-antenna-rf-and-waveforms");
          const clip = await getBoundingClip(s.page, [".fm-inspector", '[data-panel-id="inspector"]'], { x: 1200, y: 120, width: 400, height: 820 });
          const canvasRect = await getCanvasSubRect(s.page, [".fm-inspector canvas"]);
          return await captureAndVerifyPng(s.page, out("inspector-antenna-rf-and-waveforms.png"), "inspector-antenna-rf-and-waveforms", {
            clip,
            verifyCanvasRect: canvasRect,
            minUniqueBuckets: 6,
          });
        } finally {
          await closeSession(s, "inspector-antenna-rf-and-waveforms");
        }
      },
    },
    {
      filename: "inspector-spin-transport-sot-stt.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await selectExplorerNode(s.page, [
            "model:object:obj_yig_film:physics:module:st_sot_stack",
            "model:object:obj_yig_film:physics:module:spin_yig_diffusion",
            "st_sot_stack",
            "Pt/CoFeB Spin-Orbit Torque",
            "Spin-Orbit Torque",
          ]);
          await assertNoUiErrors(s.page, "inspector-spin-transport-sot-stt");
          const clip = await getBoundingClip(s.page, [".fm-inspector", '[data-panel-id="inspector"]'], { x: 1200, y: 120, width: 400, height: 820 });
          return await captureAndVerifyPng(s.page, out("inspector-spin-transport-sot-stt.png"), "inspector-spin-transport-sot-stt", { clip });
        } finally {
          await closeSession(s, "inspector-spin-transport-sot-stt");
        }
      },
    },
    {
      filename: "inspector-fem-mesh-and-airbox.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fem-airbox", theme: "dark" }, "/session/yig-waveguide");
        try {
          await selectExplorerNode(s.page, ["model:airbox:mesh", "model:airbox:mesh:parameters", "model:mesh:shared-domain", "Airbox", "Mesh"]);
          await assertNoUiErrors(s.page, "inspector-fem-mesh-and-airbox");
          const clip = await getBoundingClip(s.page, [".fm-inspector", '[data-panel-id="inspector"]'], { x: 1200, y: 120, width: 400, height: 820 });
          return await captureAndVerifyPng(s.page, out("inspector-fem-mesh-and-airbox.png"), "inspector-fem-mesh-and-airbox", { clip });
        } finally {
          await closeSession(s, "inspector-fem-mesh-and-airbox");
        }
      },
    },
    {
      filename: "inspector-study-stages-and-rerun.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "study-hysteresis", theme: "dark" }, "/session/yig-waveguide");
        try {
          await selectExplorerNode(s.page, ["stage_hysteresis_01", "Hysteresis Sweep", "Study"]);
          await assertNoUiErrors(s.page, "inspector-study-stages-and-rerun");
          const clip = await getBoundingClip(s.page, [".fm-inspector", '[data-panel-id="inspector"]'], { x: 1200, y: 120, width: 400, height: 820 });
          return await captureAndVerifyPng(s.page, out("inspector-study-stages-and-rerun.png"), "inspector-study-stages-and-rerun", { clip });
        } finally {
          await closeSession(s, "inspector-study-stages-and-rerun");
        }
      },
    },
    {
      filename: "inspector-planar-monitor-and-frequency.png",
      run: async (browser) => {
        const s = await openFreshPage(browser, { scenario: "fdm-skyrmion", theme: "dark" }, "/session/yig-waveguide");
        try {
          await selectExplorerNode(s.page, ["model:definitions:planar-monitors:planar_mon_core", "planar_mon_core", "Mid-Plane RF Monitor", "Planar Monitor"]);
          await assertNoUiErrors(s.page, "inspector-planar-monitor-and-frequency");
          const clip = await getBoundingClip(s.page, [".fm-inspector", '[data-panel-id="inspector"]'], { x: 1200, y: 120, width: 400, height: 820 });
          return await captureAndVerifyPng(s.page, out("inspector-planar-monitor-and-frequency.png"), "inspector-planar-monitor-and-frequency", { clip });
        } finally {
          await closeSession(s, "inspector-planar-monitor-and-frequency");
        }
      },
    },
  ];
}
