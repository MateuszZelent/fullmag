import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildVertexScalarColorsOffMainThread,
  disposeViewport3DColorTransformWorker,
} from "./viewport3dColorTransformScheduler";
import type { Viewport3DBuildDiagnosticRecord } from "./build-engine/viewport3dBuildEngineTypes";

function fieldVectorFixture(): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [2, 1, 1],
    nComp: 3,
    pointCount: 2,
    quantityId: "m",
    valueCount: 6,
    values: new Float64Array([
      1, 0, 0,
      0, 1, 0,
    ]),
  };
}

describe("viewport3dColorTransformScheduler", () => {
  afterEach(() => {
    disposeViewport3DColorTransformWorker();
    vi.unstubAllGlobals();
  });

  it("delegates field-color runtime builds to the pure build model", () => {
    const source = readFileSync(
      new URL("./viewport3dColorTransformScheduler.ts", import.meta.url),
      "utf8",
    );
    const workerSource = readFileSync(
      new URL(
        "./field-colors/viewport3dFieldColorBuildWorker.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("buildViewport3DFieldColorBuffer");
    expect(source).toContain("estimateViewport3DFieldColorBuildInputBytes");
    expect(source).toContain("estimateViewport3DFieldColorBuildOutputBytes");
    expect(source).toContain(
      "./field-colors/viewport3dFieldColorBuildWorker.ts",
    );
    expect(workerSource).toContain("buildViewport3DFieldColorBuffer");
  });

  it("aborts one color transform without disposing the shared worker", () => {
    const source = readFileSync(
      new URL("./viewport3dColorTransformScheduler.ts", import.meta.url),
      "utf8",
    );
    const abortStart = source.indexOf("const abortListener = signal");
    const pendingSetStart = source.indexOf("this.pending.set(id", abortStart);
    const abortBlock = source.slice(abortStart, pendingSetStart);

    expect(abortBlock).toContain("this.abortPending(id)");
    expect(abortBlock).not.toContain("this.dispose(createAbortError())");
  });

  it("keeps the shared color transform worker warm across normal inspection pauses", () => {
    const source = readFileSync(
      new URL("./viewport3dColorTransformScheduler.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("COLOR_TRANSFORM_WORKER_IDLE_TIMEOUT_MS = 120_000");
  });

  it("routes semantic field-color builds through build-engine diagnostics", async () => {
    const records: Viewport3DBuildDiagnosticRecord[] = [];

    const result = await buildVertexScalarColorsOffMainThread(
      fieldVectorFixture(),
      {
        buildKey: "field-color:test-key",
        colorMode: "orientation",
        colorPalette: "viridis",
        groupKey: "field-color:test-group",
        latestWins: true,
        onDiagnosticRecord: (record) => records.push(record),
        revisionSummary: "topology=mesh-1 field=field-1 quantity=m",
        shaderOnly: true,
      },
    );

    expect(result.vectorValues?.length).toBe(6);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(
      expect.objectContaining({
        fallbackReason: "worker-unavailable",
        inputBytes: 48,
        itemCount: 2,
        key: "field-color:test-key",
        lane: "field-color",
        outputBytes: 24,
        revisionSummary: "topology=mesh-1 field=field-1 quantity=m",
        state: "ready",
      }),
    );
  });

  it("does not use a main-thread fallback when an FDM color worker is required", async () => {
    vi.stubGlobal("Worker", undefined);

    await expect(
      buildVertexScalarColorsOffMainThread(fieldVectorFixture(), {
        buildKey: "field-color:fdm-worker-required",
        colorMode: "magnitude",
        colorPalette: "viridis",
        target: {
          cellOrdinals: new Uint32Array([0, 1]),
          diagnosticsCacheKey: "field-buffer:m:r1",
          domainCellCount: 2,
          domainGridShape: [2, 1, 1],
          kind: "fdm-sampled",
        },
        workerRequired: true,
      }),
    ).rejects.toThrow("field-color worker is required");
  });
});
