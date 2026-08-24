import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceUrl = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const outputDir = resolve(
  process.cwd(),
  process.env.CONTROL_ROOM_FROZEN_SPINS_REPORT_DIR ?? ".fullmag/reports/frozen-spins-browser",
);

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const playwright = await loadPlaywright();
if (!playwright?.chromium) {
  console.error("Frozen spins smoke requires Playwright or @playwright/test.");
  process.exit(2);
}

await mkdir(outputDir, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const consoleErrors = [];

page.on("console", (message) => {
  if (message.type() === "error") {
    consoleErrors.push(message.text());
  }
});
page.on("pageerror", (error) => {
  consoleErrors.push(error.stack ?? error.message);
});

try {
  console.log(`Navigating to workspace at ${workspaceUrl}...`);
  await page.goto(workspaceUrl, { waitUntil: "networkidle", timeout: 30_000 });

  // 1. Check Explorer and Ribbon
  const ribbon = await page.waitForSelector(".fm-ribbon", { timeout: 10_000 });
  assert(ribbon !== null, "Ribbon bar must be visible");

  // 2. Check 3D Viewport canvas and WebGL context
  const canvas = await page.waitForSelector(".fm-viewport-3d canvas", { timeout: 15_000 });
  assert(canvas !== null, "Viewport 3D canvas must be rendered");

  const webglStatus = await page.evaluate(() => {
    const el = document.querySelector(".fm-viewport-3d canvas");
    if (!el) return { found: false };
    const gl = el.getContext("webgl2") || el.getContext("webgl");
    if (!gl) return { found: true, hasContext: false };
    return {
      found: true,
      hasContext: true,
      isContextLost: gl.isContextLost(),
      width: gl.drawingBufferWidth,
      height: gl.drawingBufferHeight,
    };
  });

  assert(webglStatus.found, "Canvas element must be found in DOM");
  assert(webglStatus.hasContext, "Canvas must have an active WebGL context");
  assert(!webglStatus.isContextLost, "WebGL context must not be lost");
  assert(webglStatus.width > 0 && webglStatus.height > 0, "WebGL drawing buffer must be > 0");

  console.log("WebGL context verified successfully:", webglStatus);

  // Filter out non-fatal errors if any, but ensure no WebGL context loss errors
  const criticalErrors = consoleErrors.filter(
    (err) =>
      err.includes("WebGLRenderer: Context Lost") ||
      err.includes("frozen_spins") ||
      err.includes("Uncaught Error"),
  );
  assert(criticalErrors.length === 0, `Encountered critical errors: ${criticalErrors.join("; ")}`);

  console.log("PASS: Frozen spins browser & WebGL smoke verified.");
} catch (error) {
  console.error("FAIL: Frozen spins browser smoke failed:", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
