import { inflateSync } from "node:zlib";

const url = process.env.CONTROL_ROOM_URL ?? "http://localhost:3100/workspace";
const apiBase =
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  null;
const requiredScenes = new Set(
  (process.env.CONTROL_ROOM_SCREENSHOT_SCENES ?? "object")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);
const requiredProfiles = ["interactive", "figure"];
const CANVAS_TOP_OVERLAY_EXCLUSION_PX = 48;

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
    "Viewport 3D screenshot gate requires Playwright or @playwright/test in the current environment.",
  );
  process.exit(2);
}

const browser = await playwright.chromium.launch();
const page = await browser.newPage({
  viewport: { height: 900, width: 1440 },
});
const errors = [];

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

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const viewport = page.locator(".fm-viewport-3d");
  const canvas = page.locator(".fm-viewport-3d canvas");
  await canvas.waitFor({ state: "visible", timeout: 15_000 });
  await waitForCanvasReady(canvas);

  const detectedScene = await detectScene(viewport);
  if (requiredScenes.has("object")) {
    await ensureObjectScene(page, viewport);
  }
  const detectedScenes = new Set([detectedScene]);
  if ((await primitiveObjectCount(viewport)) > 0) detectedScenes.add("object");

  for (const scene of requiredScenes) {
    if (!detectedScenes.has(scene)) {
      throw new Error(
        `Required screenshot scene '${scene}' is not available. Detected scenes: ${[
          ...detectedScenes,
        ].join(", ")}`,
      );
    }
  }

  const captures = [];
  for (const profile of requiredProfiles) {
    await setVisualProfile(page, viewport, profile);
    const sample = await sampleCanvasComposite(page, canvas);
    if (!sample.nonBlank) {
      throw new Error(
        `Viewport 3D ${profile} screenshot is blank: ${sample.variedPixels}/${sample.sampledPixels} sampled pixels differ from background.`,
      );
    }
    captures.push({ profile, sample });
  }

  const delta = canvasCompositeDifference(captures[0].sample, captures[1].sample);
  if (!delta.changed) {
    throw new Error(
      `Viewport 3D interactive/figure screenshots are too similar: ${delta.changedPixels}/${delta.sampledPixels} changed sampled pixels, minimum ${delta.minimumChangedPixels}.`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`Browser console/network errors:\n${errors.join("\n")}`);
  }

  console.log(
    "Viewport 3D screenshot gate passed:",
    `profiles=${requiredProfiles.join(",")}`,
    `scenes=${[...detectedScenes].join(",")}`,
    `changedPixels=${delta.changedPixels}/${delta.sampledPixels}`,
  );
} finally {
  await browser.close();
}

async function ensureObjectScene(page, viewport) {
  if ((await primitiveObjectCount(viewport)) > 0) return;

  await page.getByRole("tab", { name: "Geometry" }).click();
  const addBox = page.locator('[data-action-id="geometry.add-box"]');
  await addBox.waitFor({ state: "visible", timeout: 20_000 });
  await addBox.click();

  const draftName = page.locator('.fm-inspector-panel input[aria-label="Name"]').first();
  await draftName.waitFor({ state: "visible", timeout: 20_000 });
  await fillDraftInput(draftName, `Screenshot Box ${Date.now().toString(36)}`);
  await fillDraftField(page, "X", "9e-7");
  await fillDraftField(page, "Y", "7e-7");
  await fillDraftField(page, "Z", "1e-7");
  await fillDraftField(page, "TX", "-1.6e-6");

  await page
    .locator(".fm-inspector-panel button")
    .filter({ hasText: "Apply Draft" })
    .first()
    .click();

  await page.waitForFunction(
    () => {
      const value = document
        .querySelector(".fm-viewport-3d")
        ?.getAttribute("data-primitive-object-count");
      return Number(value ?? 0) > 0;
    },
    null,
    { timeout: 20_000 },
  );
}

async function setVisualProfile(page, viewport, profile) {
  if ((await viewport.getAttribute("data-visual-profile-id")) === profile) return;

  await page.getByRole("tab", { name: "View" }).click();
  await page.locator('[data-action-id="view-render-quality"]').click();
  await page.getByRole("menuitemradio", { name: profileLabel(profile) }).click();
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
  if (profile === "figure") return "Figure";
  if (profile === "interactive") return "Interactive";
  if (profile === "interactive-lite") return "Interactive Lite";
  return profile;
}

async function primitiveObjectCount(viewport) {
  const value = await viewport.getAttribute("data-primitive-object-count");
  return Number(value ?? 0);
}

async function detectScene(viewport) {
  const summary = await viewport.locator(".fm-viewport-3d__hud span").nth(2).textContent();
  if (/^\d+\/\d+$/.test(summary ?? "")) return "fdm";
  if (/^\d+\+\d+$/.test(summary ?? "")) return "fem";
  return "unknown";
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

async function fillDraftInput(locator, value) {
  await locator.fill("");
  await locator.fill(value);
  await locator.evaluate((node) => {
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    node.blur();
  });
}

async function fillDraftField(page, label, value) {
  const input = page.locator(`.fm-inspector-panel input[aria-label="${label}"]`).first();
  await input.waitFor({ state: "visible", timeout: 20_000 });
  await fillDraftInput(input, value);
}

async function sampleCanvasComposite(page, canvas) {
  const box = await canvas.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { height: rect.height, width: rect.width, x: rect.x, y: rect.y };
  });
  const background = await canvas.evaluate((node) => {
    const viewport = node.closest(".fm-viewport-3d");
    return viewport ? getComputedStyle(viewport).backgroundColor : "";
  });
  const backgroundRgb = parseCssRgb(background);
  const png = await page.screenshot({
    clip: {
      height: Math.max(
        1,
        Math.floor(box.height - CANVAS_TOP_OVERLAY_EXCLUSION_PX),
      ),
      width: Math.max(1, Math.floor(box.width)),
      x: Math.max(0, Math.floor(box.x)),
      y: Math.max(0, Math.floor(box.y + CANVAS_TOP_OVERLAY_EXCLUSION_PX)),
    },
  });
  const bitmap = parsePng(png);
  const stride = Math.max(1, Math.floor(Math.min(bitmap.width, bitmap.height) / 64));
  const signature = [];
  let sampledPixels = 0;
  let variedPixels = 0;

  for (let y = 0; y < bitmap.height; y += stride) {
    for (let x = 0; x < bitmap.width; x += stride) {
      sampledPixels += 1;
      const offset = (y * bitmap.width + x) * 4;
      const rgb = [
        bitmap.rgba[offset],
        bitmap.rgba[offset + 1],
        bitmap.rgba[offset + 2],
      ];
      signature.push(...rgb);
      if (pixelDiffers(rgb, backgroundRgb)) variedPixels += 1;
    }
  }

  return {
    nonBlank: variedPixels > 0,
    sampledPixels,
    signature,
    variedPixels,
  };
}

function canvasCompositeDifference(before, after) {
  const length = Math.min(before.signature.length, after.signature.length);
  let changedPixels = 0;
  for (let offset = 0; offset < length; offset += 3) {
    const delta =
      Math.abs(before.signature[offset] - after.signature[offset]) +
      Math.abs(before.signature[offset + 1] - after.signature[offset + 1]) +
      Math.abs(before.signature[offset + 2] - after.signature[offset + 2]);
    if (delta > 18) changedPixels += 1;
  }

  const sampledPixels = Math.floor(length / 3);
  const minimumChangedPixels = Math.max(6, Math.floor(sampledPixels * 0.003));
  return {
    changed: changedPixels >= minimumChangedPixels,
    changedPixels,
    minimumChangedPixels,
    sampledPixels,
  };
}

function parsePng(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Screenshot is not a PNG image.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) {
    throw new Error(
      `Unsupported PNG screenshot format: bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}.`,
    );
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const source = inflateSync(Buffer.concat(idat));
  const rowLength = width * bytesPerPixel;
  const raw = Buffer.alloc(height * rowLength);
  let sourceOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = source[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * rowLength;
    for (let x = 0; x < rowLength; x += 1) {
      const value = source[sourceOffset + x];
      const left = x >= bytesPerPixel ? raw[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? raw[rowOffset - rowLength + x] : 0;
      const upLeft =
        y > 0 && x >= bytesPerPixel
          ? raw[rowOffset - rowLength + x - bytesPerPixel]
          : 0;
      raw[rowOffset + x] = unfilterPngByte(filter, value, left, up, upLeft);
    }
    sourceOffset += rowLength;
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const sourceIndex = index * bytesPerPixel;
    const targetIndex = index * 4;
    rgba[targetIndex] = raw[sourceIndex];
    rgba[targetIndex + 1] = raw[sourceIndex + 1];
    rgba[targetIndex + 2] = raw[sourceIndex + 2];
    rgba[targetIndex + 3] = colorType === 6 ? raw[sourceIndex + 3] : 255;
  }

  return { height, rgba, width };
}

function unfilterPngByte(filter, value, left, up, upLeft) {
  if (filter === 0) return value;
  if (filter === 1) return (value + left) & 255;
  if (filter === 2) return (value + up) & 255;
  if (filter === 3) return (value + Math.floor((left + up) / 2)) & 255;
  if (filter === 4) return (value + paeth(left, up, upLeft)) & 255;
  throw new Error(`Unsupported PNG filter: ${filter}.`);
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function parseCssRgb(value) {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return [0, 0, 0];
  const channels = match[1].split(",").map((channel) => Number(channel.trim()));
  return [
    Number.isFinite(channels[0]) ? channels[0] : 0,
    Number.isFinite(channels[1]) ? channels[1] : 0,
    Number.isFinite(channels[2]) ? channels[2] : 0,
  ];
}

function pixelDiffers(rgb, backgroundRgb) {
  return rgb.some((channel, index) => Math.abs(channel - backgroundRgb[index]) > 8);
}
