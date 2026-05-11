const url = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3100/workspace";

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
    "Viewport 3D smoke requires Playwright or @playwright/test in the current environment.",
  );
  process.exit(2);
}

const browser = await playwright.chromium.launch();
const page = await browser.newPage({
  viewport: { height: 900, width: 1440 },
});
const errors = [];

page.on("console", (message) => {
  if (message.type() === "error") {
    errors.push(message.text());
  }
});
page.on("pageerror", (error) => {
  errors.push(error.message);
});

try {
  await page.goto(url, { waitUntil: "networkidle" });
  const canvas = page.locator(".fm-viewport-3d canvas");
  await canvas.waitFor({ state: "visible", timeout: 15_000 });

  const pixelSample = await canvas.evaluate((node) => {
    const canvasNode = node;
    const context = canvasNode.getContext("webgl2") ?? canvasNode.getContext("webgl");
    if (!context) {
      return { hasContext: false, nonBlank: false };
    }
    const pixels = new Uint8Array(4);
    context.readPixels(
      Math.floor(canvasNode.width / 2),
      Math.floor(canvasNode.height / 2),
      1,
      1,
      context.RGBA,
      context.UNSIGNED_BYTE,
      pixels,
    );
    return {
      hasContext: true,
      nonBlank: pixels.some((value) => value !== 0),
    };
  });

  if (!pixelSample.hasContext) {
    throw new Error("3D viewport canvas has no WebGL context.");
  }
  if (!pixelSample.nonBlank) {
    throw new Error("3D viewport canvas center pixel is blank.");
  }
  if (errors.length > 0) {
    throw new Error(`Browser console errors:\n${errors.join("\n")}`);
  }

  console.log(`Viewport 3D smoke passed at ${url}.`);
} finally {
  await browser.close();
}
