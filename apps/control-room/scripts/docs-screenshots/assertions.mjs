import fs from "node:fs";
import zlib from "node:zlib";

export const FORBIDDEN_UI_ERROR_PATTERNS = [
  "API pending ERROR",
  "Resource load failed",
  "API contract version mismatch",
  "Unhandled Runtime Error",
  "Application error",
  "Failed to load resource",
];

/**
 * Decodes PNG signature, IHDR, and uncompressed RGB/RGBA scanlines cleanly in pure Node
 * so every saved Retina PNG can be verified for non-blank, multi-colored rendered content.
 */
export function inspectPngBuffer(pngBuffer) {
  if (pngBuffer.byteLength < 33) {
    throw new Error("PNG buffer too small");
  }
  const sig = pngBuffer.subarray(0, 8);
  const expectedSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!sig.equals(expectedSig)) {
    throw new Error("Invalid PNG signature");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset + 8 <= pngBuffer.byteLength) {
    const length = pngBuffer.readUInt32BE(offset);
    const type = pngBuffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > pngBuffer.byteLength) break;

    if (type === "IHDR") {
      width = pngBuffer.readUInt32BE(dataStart);
      height = pngBuffer.readUInt32BE(dataStart + 4);
      bitDepth = pngBuffer.readUInt8(dataStart + 8);
      colorType = pngBuffer.readUInt8(dataStart + 9);
    } else if (type === "IDAT") {
      idatChunks.push(pngBuffer.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0 || bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(
      `Unsupported PNG dimensions or format: ${width}x${height} depth=${bitDepth} color=${colorType}`,
    );
  }

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  if (inflated.byteLength < height * (stride + 1)) {
    throw new Error(`PNG IDAT short read: ${inflated.byteLength} bytes`);
  }

  const reconstructed = Buffer.allocUnsafe(height * stride);
  for (let y = 0; y < height; y += 1) {
    const srcRowStart = y * (stride + 1);
    const filter = inflated[srcRowStart];
    const dstRowStart = y * stride;
    const prevRowStart = (y - 1) * stride;

    for (let i = 0; i < stride; i += 1) {
      const raw = inflated[srcRowStart + 1 + i];
      const left = i >= bpp ? reconstructed[dstRowStart + i - bpp] : 0;
      const up = y > 0 ? reconstructed[prevRowStart + i] : 0;
      const upLeft = y > 0 && i >= bpp ? reconstructed[prevRowStart + i - bpp] : 0;
      let val;
      if (filter === 0) val = raw;
      else if (filter === 1) val = (raw + left) & 0xff;
      else if (filter === 2) val = (raw + up) & 0xff;
      else if (filter === 3) val = (raw + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) val = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      else throw new Error(`Unsupported PNG filter ${filter}`);
      reconstructed[dstRowStart + i] = val;
    }
  }

  function sampleBox(box = { x: 0, y: 0, width, height }) {
    const x0 = Math.max(0, Math.min(width - 1, Math.floor(box.x)));
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(box.y)));
    const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(box.x + box.width)));
    const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil(box.y + box.height)));
    const stepY = Math.max(1, Math.floor((y1 - y0) / 48));
    const stepX = Math.max(1, Math.floor((x1 - x0) / 48));
    const buckets = new Set();
    let minLum = 255;
    let maxLum = 0;
    let sampledPixels = 0;

    for (let y = y0; y < y1; y += stepY) {
      const dstRowStart = y * stride;
      for (let x = x0; x < x1; x += stepX) {
        const idx = dstRowStart + x * bpp;
        const r = reconstructed[idx];
        const g = reconstructed[idx + 1];
        const b = reconstructed[idx + 2];
        const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
        buckets.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
        sampledPixels += 1;
      }
    }
    return {
      sampledPixels,
      uniqueColorBuckets: buckets.size,
      luminanceRange: maxLum - minLum,
      minLum,
      maxLum,
    };
  }

  const whole = sampleBox();
  return {
    width,
    height,
    ...whole,
    sampleBox,
  };
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function attachPageErrorGuards(page) {
  const runtimeErrors = [];
  const onPageError = (err) => {
    runtimeErrors.push(`pageerror: ${err?.stack ?? String(err)}`);
  };
  const onConsole = (msg) => {
    if (msg.type() === "error") {
      runtimeErrors.push(`console.error: ${msg.text()}`);
    }
  };
  const onResponse = (response) => {
    const status = response.status();
    if (status >= 400) {
      runtimeErrors.push(`http ${status}: ${response.request().method()} ${response.url()}`);
    }
  };

  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  page.on("response", onResponse);

  return {
    errors: runtimeErrors,
    clear() {
      runtimeErrors.length = 0;
    },
    assertClean(label) {
      if (runtimeErrors.length > 0) {
        throw new Error(`[${label}] Runtime/network errors detected:\n${runtimeErrors.join("\n")}`);
      }
    },
    detach() {
      page.off("pageerror", onPageError);
      page.off("console", onConsole);
      page.off("response", onResponse);
    },
  };
}

export async function assertNoUiErrors(page, label) {
  const inspection = await page.evaluate((patterns) => {
    const bodyText = document.body?.innerText ?? "";
    const matched = patterns.filter((pattern) => bodyText.includes(pattern));
    const portalDialogs = [...document.querySelectorAll("nextjs-portal [role='dialog'], [data-nextjs-dialog-overlay]")]
      .filter((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map((el) => el.textContent?.slice(0, 120) ?? "");
    return { matched, portalDialogs };
  }, FORBIDDEN_UI_ERROR_PATTERNS);

  if (inspection.matched.length > 0) {
    throw new Error(`[${label}] Forbidden UI error text visible: ${inspection.matched.join(", ")}`);
  }
  if (inspection.portalDialogs.length > 0) {
    throw new Error(`[${label}] Next.js error overlay visible: ${inspection.portalDialogs.join(" | ")}`);
  }
}

export async function assertWebGLCanvasHealthy(page, label, { requireWebGL = true, minBuckets = 10 } = {}) {
  const stats = await page.evaluate(
    ({ requireWebGL }) => {
      const canvases = [...document.querySelectorAll("canvas")].filter((canvas) => {
        const rect = canvas.getBoundingClientRect();
        return rect.width >= 32 && rect.height >= 32;
      });
      if (canvases.length === 0) {
        return { ok: false, reason: "no visible canvas >= 32x32" };
      }

      const details = [];
      for (const canvas of canvases) {
        const rect = canvas.getBoundingClientRect();
        if (canvas.width <= 0 || canvas.height <= 0) {
          return { ok: false, reason: `canvas has zero drawing buffer (${canvas.width}x${canvas.height})` };
        }
        const gl =
          canvas.getContext("webgl2") ||
          canvas.getContext("webgl") ||
          canvas.getContext("experimental-webgl");
        if (gl && gl.isContextLost()) {
          return { ok: false, reason: "WebGL context lost" };
        }
        if (requireWebGL && !gl) {
          // Allow 2D canvas only when requireWebGL=false; otherwise check if any visible canvas has WebGL
          details.push({ width: canvas.width, height: canvas.height, kind: "2d", rectWidth: rect.width, rectHeight: rect.height });
          continue;
        }
        details.push({
          width: canvas.width,
          height: canvas.height,
          kind: gl ? "webgl" : "2d",
          rectWidth: rect.width,
          rectHeight: rect.height,
        });
      }

      if (requireWebGL && !details.some((d) => d.kind === "webgl")) {
        return { ok: false, reason: `expected a WebGL canvas, found: ${JSON.stringify(details)}` };
      }

      // Sample center region pixels via 2D/WebGL readPixels if preserveDrawingBuffer or after rAF, or report canvas details
      let readSampleBuckets = null;
      const webglCanvas = canvases.find(
        (c) => c.getContext("webgl2") || c.getContext("webgl"),
      );
      if (webglCanvas) {
        const gl = webglCanvas.getContext("webgl2") || webglCanvas.getContext("webgl");
        if (gl) {
          const w = gl.drawingBufferWidth;
          const h = gl.drawingBufferHeight;
          const patchW = Math.min(w, 64);
          const patchH = Math.min(h, 64);
          const sx = Math.max(0, Math.floor((w - patchW) / 2));
          const sy = Math.max(0, Math.floor((h - patchH) / 2));
          const px = new Uint8Array(patchW * patchH * 4);
          gl.readPixels(sx, sy, patchW, patchH, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const buckets = new Set();
          for (let i = 0; i < px.length; i += 16) {
            buckets.add(((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3));
          }
          readSampleBuckets = buckets.size;
        }
      }

      return { ok: true, details, readSampleBuckets };
    },
    { requireWebGL },
  );

  if (!stats.ok) {
    throw new Error(`[${label}] Canvas health check failed: ${stats.reason}`);
  }
  return stats;
}

/**
 * Captures screenshot (full page or bounding-box clip), verifies PNG pixel diversity
 * and luminescence variation (including optional canvas sub-rectangle), and writes ONLY verified output to targetPath.
 */
export async function captureAndVerifyPng(
  page,
  targetPath,
  label,
  {
    clip = undefined,
    minUniqueBuckets = 10,
    minLuminanceRange = 20,
    minCanvasBuckets = 8,
    minCanvasLuminanceRange = 18,
    verifyCanvasRect = undefined,
    deviceScaleFactor = 2,
    animations = "disabled",
  } = {},
) {
  const pngBuffer = await page.screenshot({
    path: undefined,
    type: "png",
    clip,
    animations,
  });

  const stats = inspectPngBuffer(pngBuffer);
  if (stats.uniqueColorBuckets < minUniqueBuckets) {
    throw new Error(
      `[${label}] Captured PNG lacks color variety (${stats.uniqueColorBuckets} < ${minUniqueBuckets} buckets)`,
    );
  }
  if (stats.luminanceRange < minLuminanceRange) {
    throw new Error(
      `[${label}] Captured PNG is too flat/blank (luminanceRange=${stats.luminanceRange} < ${minLuminanceRange})`,
    );
  }

  let canvasStats = null;
  if (verifyCanvasRect) {
    const originX = clip ? clip.x : 0;
    const originY = clip ? clip.y : 0;
    const scaledBox = {
      x: (verifyCanvasRect.x - originX) * deviceScaleFactor,
      y: (verifyCanvasRect.y - originY) * deviceScaleFactor,
      width: verifyCanvasRect.width * deviceScaleFactor,
      height: verifyCanvasRect.height * deviceScaleFactor,
    };
    canvasStats = stats.sampleBox(scaledBox);
    if (canvasStats.uniqueColorBuckets < minCanvasBuckets) {
      throw new Error(
        `[${label}] Rendered canvas sub-rect lacks color variety (${canvasStats.uniqueColorBuckets} < ${minCanvasBuckets} buckets)`,
      );
    }
    if (canvasStats.luminanceRange < minCanvasLuminanceRange) {
      throw new Error(
        `[${label}] Rendered canvas sub-rect is flat/blank (luminanceRange=${canvasStats.luminanceRange} < ${minCanvasLuminanceRange})`,
      );
    }
  }

  fs.writeFileSync(targetPath, pngBuffer);
  return { ...stats, canvasStats };
}
