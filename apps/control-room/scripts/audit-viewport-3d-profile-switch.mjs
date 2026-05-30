const url = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const apiBase =
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  null;

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
  console.error(
    "Viewport 3D profile-switch audit requires Playwright or @playwright/test.",
  );
  process.exit(2);
}

const browser = await playwright.chromium.launch();
const page = await browser.newPage({
  viewport: { height: 900, width: 1440 },
});
const errors = [];
const resourceRequests = [];
let auditActive = false;

if (apiBase) {
  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
    };
  }, apiBase);
}

page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => {
  errors.push(error.message);
});
page.on("response", (response) => {
  const status = response.status();
  if (status >= 400) errors.push(`${status} ${response.url()}`);
});
page.on("request", (request) => {
  if (!auditActive) return;
  const requestUrl = request.url();
  if (
    requestUrl.includes("/v2/sessions/current/data/fields/") ||
    requestUrl.includes("/v2/sessions/current/data/domain/topology") ||
    requestUrl.includes("/v2/sessions/current/meshing/meshes/shared-domain/topology")
  ) {
    resourceRequests.push(`${request.method()} ${requestUrl}`);
  }
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await openViewport3D(page);
  const viewport = page.locator(".fm-viewport-3d");
  const canvas = page.locator(".fm-viewport-3d canvas");
  await canvas.waitFor({ state: "visible", timeout: 15_000 });
  await waitForCanvasReady(canvas);
  await waitForDiagnostics(viewport);
  await page.waitForTimeout(500);

  const baseline = await readDiagnostics(viewport);
  const sequence = [
    "interactive-lite",
    "interactive",
    "balanced",
    "figure",
    "interactive",
    "figure",
  ];

  auditActive = true;
  for (const profile of sequence) {
    await setVisualProfile(page, viewport, profile);
  }
  auditActive = false;
  await page.waitForTimeout(500);

  const after = await readDiagnostics(viewport);
  const maxGeometryGrowth = Math.max(12, baseline.geo * 2);
  const cacheGrowth = after.cacheBytes - baseline.cacheBytes;
  if (after.geo > baseline.geo + maxGeometryGrowth) {
    throw new Error(
      `Profile switching leaked geometry resources: baseline=${baseline.geo}, after=${after.geo}.`,
    );
  }
  if (cacheGrowth > 1024 * 1024) {
    throw new Error(
      `Profile switching grew viewport cache by ${cacheGrowth} bytes; expected style-only switching.`,
    );
  }
  if (resourceRequests.length > 0) {
    throw new Error(
      `Profile switching refetched topology/field resources:\n${resourceRequests.join("\n")}`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`Browser console/network errors:\n${errors.join("\n")}`);
  }

  console.log(
    "Viewport 3D profile-switch audit passed:",
    `profiles=${sequence.join(",")}`,
    `geo=${baseline.geo}->${after.geo}`,
    `cache=${baseline.cacheBytes}->${after.cacheBytes}`,
    `frames=${baseline.frames}->${after.frames}`,
  );
} finally {
  auditActive = false;
  await browser.close();
}

async function openViewport3D(page) {
  const tab = page.getByRole("tab", { exact: true, name: "3D" }).first();
  if ((await tab.count()) > 0) {
    await tab.click({ force: true });
    return;
  }

  const action = page.locator('[data-action-id="viewport-3d.open"]').first();
  if ((await action.count()) > 0) {
    await action.click({ force: true });
  }
}

async function setVisualProfile(page, viewport, profile) {
  if ((await viewport.getAttribute("data-visual-profile-id")) === profile) return;

  await page.getByRole("tab", { name: "View" }).click({ force: true });
  await page.locator('[data-action-id="view-render-quality"]').click({ force: true });
  await page
    .getByRole("menuitemradio", { exact: true, name: profileLabel(profile) })
    .click();
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector(".fm-viewport-3d")
        ?.getAttribute("data-visual-profile-id") === expected,
    profile,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(120);
}

function profileLabel(profile) {
  if (profile === "balanced") return "Balanced";
  if (profile === "figure") return "Figure";
  if (profile === "interactive") return "Interactive";
  if (profile === "interactive-lite") return "Interactive Lite";
  return profile;
}

async function waitForCanvasReady(canvas) {
  await canvas.evaluate((node) =>
    new Promise((resolve) => {
      const deadline = performance.now() + 5_000;
      const tick = () => {
        const rect = node.getBoundingClientRect();
        if ((rect.width > 0 && rect.height > 0) || performance.now() > deadline) {
          resolve(undefined);
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    }),
  );
}

async function waitForDiagnostics(viewport) {
  await viewport.evaluate((node) =>
    new Promise((resolve, reject) => {
      const deadline = performance.now() + 15_000;
      const tick = () => {
        const spans = Array.from(node.querySelectorAll(".fm-viewport-3d__hud span"));
        if (spans.some((span) => span.textContent?.includes("geo:"))) {
          resolve(undefined);
          return;
        }
        if (performance.now() > deadline) {
          reject(new Error("Timed out waiting for viewport diagnostics HUD."));
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    }),
  );
}

async function readDiagnostics(viewport) {
  const value = await viewport.evaluate((node) => {
    const spans = Array.from(node.querySelectorAll(".fm-viewport-3d__hud span"));
    return spans.find((span) => span.textContent?.includes("geo:"))?.textContent ?? "";
  });
  return {
    cacheBytes: parseCacheBytes(readDiagnosticToken(value, "cache")),
    frames: Number(readDiagnosticToken(value, "frames") ?? 0),
    geo: Number(readDiagnosticToken(value, "geo") ?? 0),
    raw: value,
  };
}

function readDiagnosticToken(value, key) {
  const match = value.match(new RegExp(`(?:^|\\s)${key}:([^\\s]+)`));
  return match?.[1] ?? null;
}

function parseCacheBytes(value) {
  if (!value) return 0;
  const match = value.match(/^([0-9]+)(B|KB|MB)$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  if (match[2] === "MB") return amount * 1024 * 1024;
  if (match[2] === "KB") return amount * 1024;
  return amount;
}
