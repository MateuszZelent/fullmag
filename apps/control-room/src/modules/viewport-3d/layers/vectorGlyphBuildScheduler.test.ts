import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildViewport3DVectorGlyphsOffMainThread } from "./vectorGlyphBuildScheduler";

describe("vectorGlyphBuildScheduler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the shared glyph builder when workers are unavailable", async () => {
    vi.stubGlobal("Worker", undefined);

    const result = await buildViewport3DVectorGlyphsOffMainThread({
      colorMode: "x",
      headRadiusRatio: 0.2,
      segments: new Float32Array([
        0, 0, 0, 2, 0, 0, 1,
        0, 0, 0, 0, 3, 0, 0.5,
      ]),
      shaftRadiusRatio: 0.08,
    });

    expect(result.transforms.count).toBe(2);
    expect(Array.from(result.transforms.directions)).toEqual([
      1, 0, 0,
      0, 1, 0,
    ]);
    expect(result.colors).toBeInstanceOf(Float32Array);
    expect(result.colors?.length).toBe(6);
  });

  it("transfers glyph input and output buffers through the worker path", () => {
    const schedulerSource = readFileSync(
      new URL("./vectorGlyphBuildScheduler.ts", import.meta.url),
      "utf8",
    );
    const workerSource = readFileSync(
      new URL("./vectorGlyphBuildWorker.ts", import.meta.url),
      "utf8",
    );

    expect(schedulerSource).toContain(
      "this.worker.postMessage(request, transferables)",
    );
    expect(schedulerSource).toContain("addArrayBufferTransferable");
    expect(workerSource).toContain(
      "transferablesForVectorGlyphBuildResult(result)",
    );
  });

  it("keeps pure glyph build logic out of the client worker scheduler", () => {
    const workerSource = readFileSync(
      new URL("./vectorGlyphBuildWorker.ts", import.meta.url),
      "utf8",
    );

    expect(workerSource).toContain("./vectorGlyphBuildModel");
    expect(workerSource).not.toContain("./vectorGlyphBuildScheduler");
  });
});
