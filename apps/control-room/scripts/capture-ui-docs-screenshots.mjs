import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(__dirname, "../../../public_docs/site/_static/images/ui");
mkdirSync(outputDir, { recursive: true });

const url = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    try {
      return await import("@playwright/test");
    } catch {
      return null;
    }
  }
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error("Playwright required to capture documentation screenshots.");
  process.exit(2);
}

const browser = await playwright.chromium.launch({
  headless: true,
});

const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});

const page = await context.newPage();

await page.addInitScript(() => {
  window.__FULLMAG_CONFIG__ = {
    ...(window.__FULLMAG_CONFIG__ ?? {}),
    allowMissingSessionSmoke: true,
    controlRoomApiBase: "http://localhost:8081",
  };
});

await installFdmFixtureApi(page);

try {
  console.log(`Navigating to ${url}...`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // 1. Overview Workspace Screenshot
  console.log("Capturing 1: Full Workspace Overview...");
  await page.screenshot({
    path: resolve(outputDir, "control-room-workspace-overview.png"),
    fullPage: false,
  });

  // 2. Ribbon Tabs - Geometry
  console.log("Capturing 2: Geometry Ribbon Tab...");
  const geomTab = page.getByRole("tab", { exact: true, name: "Geometry" });
  if (await geomTab.isVisible()) {
    await geomTab.click({ force: true });
    await page.waitForTimeout(600);
  }
  const ribbonStrip = page.locator(".fm-ribbon-bar, header").first();
  if (await ribbonStrip.isVisible()) {
    await ribbonStrip.screenshot({
      path: resolve(outputDir, "ribbon-tabs-geometry.png"),
    });
  }

  // 3. Ribbon Tabs - Physics
  console.log("Capturing 3: Physics Ribbon Tab...");
  const physicsTab = page.getByRole("tab", { exact: true, name: "Physics" });
  if (await physicsTab.isVisible()) {
    await physicsTab.click({ force: true });
    await page.waitForTimeout(600);
    if (await ribbonStrip.isVisible()) {
      await ribbonStrip.screenshot({
        path: resolve(outputDir, "ribbon-tabs-physics.png"),
      });
    }
  }

  // 4. Explorer Tree Close-up
  console.log("Capturing 4: Explorer Tree Structure...");
  const leftPanel = page.locator("aside").first();
  if (await leftPanel.isVisible()) {
    await leftPanel.screenshot({
      path: resolve(outputDir, "explorer-tree-structure.png"),
    });
  }

  // 5. 3D Viewport Close-up
  console.log("Capturing 5: Viewport 3D Interactive View...");
  const viewport3D = page.locator(".fm-viewport-3d").first();
  if (await viewport3D.isVisible()) {
    await viewport3D.screenshot({
      path: resolve(outputDir, "viewport-3d-interactive.png"),
    });
  }

  // 6. Inspector Panel Close-up
  console.log("Capturing 6: Inspector Panel...");
  // Expand object tree node and select object to populate Inspector
  const firstNode = page.locator("[data-node-id]").first();
  if (await firstNode.isVisible()) {
    await firstNode.click({ force: true });
    await page.waitForTimeout(500);
  }
  const inspectorPanel = page.locator(".fm-inspector-shell, .fm-inspector-panel, [data-panel-id='inspector']").first();
  if (await inspectorPanel.isVisible()) {
    await inspectorPanel.screenshot({
      path: resolve(outputDir, "inspector-panel-draft.png"),
    });
  } else {
    // Fallback: take right panel screenshot
    const rightPanel = page.locator("aside").last();
    if (await rightPanel.isVisible()) {
      await rightPanel.screenshot({
        path: resolve(outputDir, "inspector-panel-draft.png"),
      });
    }
  }

  // 7. Status Bar & Footer
  console.log("Capturing 7: Status Bar & Footer...");
  const statusBar = page.locator(".fm-status-bar, footer").first();
  if (await statusBar.isVisible()) {
    await statusBar.screenshot({
      path: resolve(outputDir, "status-bar-footer.png"),
    });
  }

  console.log("All UI screenshots captured successfully!");
} finally {
  await browser.close();
}

async function installFdmFixtureApi(page) {
  await page.route("**/v2/sessions/current/**", async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204 });
      return;
    }
    const path = requestUrl.pathname;
    if (path === "/v2/sessions/current/status") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          active_run_id: "run-01",
          session_id: "sess-01",
          solver_engine: "fem",
          backend_device: "gpu",
          state: "ready",
        }),
      });
      return;
    }
    if (path === "/v2/sessions/current/visualization/state") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          active_quantity: "m",
          vector_glyph_style: "arrows",
          colormap: "viridis",
          overrides: [],
          revision: 1,
        }),
      });
      return;
    }
    if (path === "/v2/sessions/current/data/domain/meta") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          bounds_max: [500e-9, 200e-9, 20e-9],
          bounds_min: [-500e-9, -200e-9, -20e-9],
          cell_count: [100, 40, 4],
          domain_type: "fdm",
          grid_spacing: [10e-9, 10e-9, 10e-9],
        }),
      });
      return;
    }
    if (path === "/v2/sessions/current/data/domain/topology") {
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === "/v2/sessions/current/data/fields/m/samples/vector") {
      const floats = new Float32Array(48000);
      for (let i = 0; i < 16000; i++) {
        floats[i * 3 + 0] = Math.sin(i * 0.05);
        floats[i * 3 + 1] = Math.cos(i * 0.05);
        floats[i * 3 + 2] = 0.2;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: Buffer.from(floats.buffer),
      });
      return;
    }
    if (path === "/v2/sessions/current/model/scene") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          objects: [
            {
              id: "nanowire",
              name: "Permalloy Nanowire",
              regions: [
                {
                  region_id: "core",
                  name: "Py Core",
                  enabled: true,
                  frame: "object",
                  shape: { kind: "box", size: [1e-6, 4e-7, 4e-8] },
                },
              ],
              transform: { translation: [0, 0, 0] },
              visible: true,
            },
          ],
          revision: 1,
          schema_version: 2,
        }),
      });
      return;
    }
    if (path === "/v2/sessions/current/model/universe") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          mesh_dirty: false,
          object_bounds_max: [500e-9, 200e-9, 20e-9],
          object_bounds_min: [-500e-9, -200e-9, -20e-9],
          scene_revision: 1,
          study_universe_mesh: null,
          universe: null,
        }),
      });
      return;
    }
    await route.fulfill({ status: 204 });
  });
}
