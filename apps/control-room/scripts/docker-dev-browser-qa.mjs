import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const playwrightPackage = require("playwright/package.json");
const expectedVersion = process.env.CONTROL_ROOM_EXPECTED_PLAYWRIGHT_VERSION ?? "1.62.1";
const timeout = Number.parseInt(process.env.CONTROL_ROOM_BROWSER_QA_TIMEOUT_MS ?? "180000", 10);
const publicUrl = process.env.CONTROL_ROOM_PUBLIC_URL ?? "";
const probeUrl = process.env.CONTROL_ROOM_URL ?? "http://frontend:8080";
const browserGpuMode = process.env.CONTROL_ROOM_BROWSER_GPU_MODE ?? "swiftshader-webgl-requested";
const resultSchema = "fullmag.docker-dev-browser-qa-result.v1";

const pageErrors = [];
const consoleErrors = [];
const requestFailures = [];
const bounded = (value) => String(value).slice(0, 2048);
const collect = (target, value) => {
  if (target.length < 32) target.push(bounded(value));
};

const sessionIdentity = async (page) => {
  const endpoint = new URL("/v2/sessions/current/status", page.url()).toString();
  const response = await page.request.get(endpoint, { timeout });
  if (response.status() !== 200) {
    throw new Error(`GET /v2/sessions/current/status returned ${response.status()}`);
  }
  const body = await response.json();
  const session = body?.session;
  const lifecycle = body?.lifecycle;
  for (const key of ["session_id", "session_epoch", "request_scope_epoch"]) {
    if (typeof session?.[key] !== "string" || session[key].trim() === "") {
      throw new Error(`Current status response omitted session.${key}`);
    }
  }
  if (lifecycle?.session_resource !== "active") {
    throw new Error("Current status response did not identify an active session resource");
  }
  return {
    session_id: session.session_id,
    session_epoch: session.session_epoch,
    request_scope_epoch: session.request_scope_epoch,
  };
};

const canvasState = async (page) => page.locator(".fm-viewport-3d canvas").first().evaluate((canvas) => {
  const rect = canvas.getBoundingClientRect();
  const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const debugInfo = context?.getExtension("WEBGL_debug_renderer_info");
  return {
    rect: { width: rect.width, height: rect.height },
    width: canvas.width,
    height: canvas.height,
    context_type: context?.constructor?.name ?? null,
    context_lost: context?.isContextLost?.() ?? null,
    drawing_buffer_width: context?.drawingBufferWidth ?? 0,
    drawing_buffer_height: context?.drawingBufferHeight ?? 0,
    vendor: debugInfo ? context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null,
    renderer: debugInfo ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
  };
});

const assertCanvas = async (page, label) => {
  const canvas = page.locator(".fm-viewport-3d canvas");
  await canvas.first().waitFor({ state: "visible", timeout });
  if (await canvas.count() !== 1) throw new Error(`${label}: expected one viewport canvas`);
  const state = await canvasState(page);
  if (state.rect.width <= 0 || state.rect.height <= 0 || state.width <= 0 || state.height <= 0
      || !state.context_type || state.context_lost !== false
      || state.drawing_buffer_width <= 0 || state.drawing_buffer_height <= 0) {
    throw new Error(`${label}: visible WebGL canvas/context/drawing buffer is invalid`);
  }
  return state;
};

const main = async () => {
  if (!publicUrl) throw new Error("CONTROL_ROOM_PUBLIC_URL is required");
  if (playwrightPackage.version !== expectedVersion || expectedVersion !== "1.62.1") {
    throw new Error(`Playwright package ${playwrightPackage.version} does not match ${expectedVersion}`);
  }
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
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    page.on("pageerror", (error) => collect(pageErrors, error));
    page.on("console", (message) => {
      if (message.type() === "error") collect(consoleErrors, message.text());
    });
    page.on("requestfailed", (request) => collect(requestFailures, `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`));

    const response = await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout });
    if (!response || response.status() >= 400) throw new Error(`Fullmag DEV returned ${response?.status() ?? "no response"}`);
    if (!new URL(page.url()).pathname.startsWith("/workspace")) throw new Error(`Expected /workspace, got ${page.url()}`);
    const home = page.locator('.fm-home-overlay[data-state="home-overlay"]');
    if (await home.isVisible()) {
      const returnToWorkspace = page.getByRole("button", { name: "Back to simulation", exact: true });
      await returnToWorkspace.click();
      await home.waitFor({ state: "hidden", timeout });
    }
    await page.locator("#fm-main-content.fm-workspace-body").waitFor({ state: "visible", timeout });
    const before = await assertCanvas(page, "before Home");
    const canvasHandle = await page.locator(".fm-viewport-3d canvas").first().elementHandle();
    if (!canvasHandle) throw new Error("before Home: could not retain the workspace canvas element");
    const sessionBefore = await sessionIdentity(page);

    const start = page.getByRole("button", { name: "Start", exact: true });
    await start.waitFor({ state: "visible", timeout });
    await start.click();
    await home.waitFor({ state: "visible", timeout });
    await page.waitForFunction(() => document.querySelector(".fm-home-overlay .fm-start-status")?.textContent?.includes("Simulation open:") === true, null, { timeout });
    const homeText = await home.innerText();
    if (!homeText.includes("Simulation open:")) throw new Error("Home did not show the active session label");

    const back = page.getByRole("button", { name: "Back to simulation", exact: true });
    await back.waitFor({ state: "visible", timeout });
    await back.click();
    await home.waitFor({ state: "hidden", timeout });
    await page.locator("#fm-main-content.fm-workspace-body").waitFor({ state: "visible", timeout });
    const canvasDomStable = await canvasHandle.evaluate((canvas) => canvas === document.querySelector(".fm-viewport-3d canvas") && document.contains(canvas));
    if (!canvasDomStable) throw new Error("Home unmounted or replaced the workspace canvas");
    const after = await assertCanvas(page, "after Home");
    const sessionAfter = await sessionIdentity(page);
    if (JSON.stringify(sessionBefore) !== JSON.stringify(sessionAfter)) throw new Error("Active session identity changed during Home round trip");
    if (pageErrors.length || consoleErrors.length || requestFailures.length) {
      throw new Error("Browser flow recorded page, console, or request failures");
    }

    return {
      schema: resultSchema,
      state: "passed",
      public_url: publicUrl,
      probe_url: probeUrl,
      final_url: page.url(),
      playwright_version: playwrightPackage.version,
      browser_gpu_mode: browserGpuMode,
      home_round_trip: true,
      home: { section: "home", visible: true, session_label: homeText.match(/Simulation open:[^\n]*/)?.[0] ?? "Simulation open:" },
      session: sessionAfter,
      workspace: { visible: true, canvas_dom_stable: canvasDomStable },
      canvas_before: before,
      canvas_after: after,
      page_errors: pageErrors.length,
      console_errors: consoleErrors.length,
      request_failures: requestFailures.length,
    };
  } finally {
    await browser.close();
  }
};

try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  console.log(JSON.stringify({
    schema: resultSchema,
    state: "failed",
    public_url: publicUrl,
    probe_url: probeUrl,
    playwright_version: playwrightPackage.version ?? null,
    browser_gpu_mode: browserGpuMode,
    error: bounded(error?.stack ?? error),
    page_errors: pageErrors,
    console_errors: consoleErrors,
    request_failures: requestFailures,
  }));
  process.exitCode = 1;
}
