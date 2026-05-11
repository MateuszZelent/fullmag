import { inflateSync } from "node:zlib";

const url = process.env.CONTROL_ROOM_URL ?? "http://127.0.0.1:3100/workspace";
const apiBase =
  process.env.CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL ??
  process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE ??
  process.env.NEXT_PUBLIC_API_URL ??
  null;
const allowMissingSession =
  process.env.CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION === "1";

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

if (apiBase) {
  await page.addInitScript((baseUrl) => {
    window.__FULLMAG_CONFIG__ = {
      ...(window.__FULLMAG_CONFIG__ ?? {}),
      controlRoomApiBase: baseUrl,
    };
  }, apiBase);
}

page.on("console", (message) => {
  if (message.type() === "error") {
    const text = message.text();
    if (isIgnorableConsoleError(text)) {
      return;
    }
    errors.push(text);
  }
});
page.on("pageerror", (error) => {
  errors.push(error.message);
});
page.on("response", (response) => {
  const status = response.status();
  if (status < 400 || isAllowedMissingSessionResponse(response.url(), status)) {
    return;
  }

  errors.push(`${status} ${response.url()}`);
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const canvas = page.locator(".fm-viewport-3d canvas");
  await canvas.waitFor({ state: "visible", timeout: 15_000 });
  await canvas.evaluate((node) =>
    new Promise((resolve) => {
      const deadline = performance.now() + 5_000;
      const ready = () => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const tick = () => {
        if (ready() || performance.now() > deadline) {
          resolve(undefined);
          return;
        }
        requestAnimationFrame(tick);
      };
      if (ready()) {
        resolve(undefined);
        return;
      }
      requestAnimationFrame(tick);
    }),
  );

  const hasContext = await canvas.evaluate((node) => {
    const canvasNode = node;
    const context = canvasNode.getContext("webgl2") ?? canvasNode.getContext("webgl");
    return Boolean(context);
  });
  const pixelSample = await sampleCanvasComposite(page, canvas);

  if (!hasContext) {
    throw new Error("3D viewport canvas has no WebGL context.");
  }
  if (!pixelSample.nonBlank) {
    throw new Error(
      `3D viewport canvas composite is blank: ${pixelSample.variedPixels}/${pixelSample.sampledPixels} sampled pixels differ from background.`,
    );
  }
  if (errors.length > 0) {
    throw new Error(`Browser console errors:\n${errors.join("\n")}`);
  }

  console.log(`Viewport 3D smoke passed at ${url}.`);
} finally {
  await browser.close();
}

async function sampleCanvasComposite(page, canvas) {
  const box = await canvas.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      height: rect.height,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    };
  });
  if (box.width <= 0 || box.height <= 0) {
    throw new Error(
      `3D viewport canvas has no measurable bounding box: ${box.width}x${box.height}.`,
    );
  }

  const background = await canvas.evaluate((node) => {
    const viewport = node.closest(".fm-viewport-3d");
    return viewport ? getComputedStyle(viewport).backgroundColor : "";
  });
  const backgroundRgb = parseCssRgb(background);
  const png = await page.screenshot({
    clip: {
      height: Math.max(1, Math.floor(box.height)),
      width: Math.max(1, Math.floor(box.width)),
      x: Math.max(0, Math.floor(box.x)),
      y: Math.max(0, Math.floor(box.y)),
    },
  });
  const bitmap = parsePng(png);
  const stride = Math.max(1, Math.floor(Math.min(bitmap.width, bitmap.height) / 32));
  let sampledPixels = 0;
  let variedPixels = 0;

  for (let y = 0; y < bitmap.height; y += stride) {
    for (let x = 0; x < bitmap.width; x += stride) {
      sampledPixels += 1;
      const offset = (y * bitmap.width + x) * 4;
      const alpha = bitmap.rgba[offset + 3];
      if (alpha === 0) {
        continue;
      }

      const rgb = [
        bitmap.rgba[offset],
        bitmap.rgba[offset + 1],
        bitmap.rgba[offset + 2],
      ];
      if (pixelDiffers(rgb, backgroundRgb)) {
        variedPixels += 1;
      }
    }
  }

  return {
    nonBlank: variedPixels > 0,
    sampledPixels,
    variedPixels,
  };
}

function parsePng(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) {
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

function isIgnorableConsoleError(text) {
  if (text === "Failed to load resource: the server responded with a status of 404 (Not Found)") {
    return true;
  }

  return (
    allowMissingSession &&
    text.includes("/v2/sessions/current/events/ws") &&
    text.includes("Unexpected response code: 404")
  );
}

function isAllowedMissingSessionResponse(responseUrl, status) {
  if (!allowMissingSession || status !== 404) {
    return false;
  }

  try {
    const pathname = new URL(responseUrl).pathname;
    return pathname.startsWith("/v2/sessions/current/");
  } catch {
    return false;
  }
}
