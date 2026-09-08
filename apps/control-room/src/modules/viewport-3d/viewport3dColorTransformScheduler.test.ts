import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import { buildVertexScalarColorsOffMainThread } from "./viewport3dColorTransformScheduler";
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

  describe("M-08 · recovers the worker instead of permanently degrading a lane", () => {
    const source = readFileSync(
      new URL("./viewport3dColorTransformScheduler.ts", import.meta.url),
      "utf8",
    );
    const executeStart = source.indexOf(
      "async function executeVertexScalarColorBuild",
    );
    const getClientStart = source.indexOf(
      "function getColorTransformWorkerClient(",
    );
    const executeSource = source.slice(executeStart, getClientStart);
    const getClientSource = source.slice(
      getClientStart,
      source.indexOf("\n}\n", getClientStart),
    );

    it("disposes the failed worker and clears it to undefined instead of null so it can be recreated", () => {
      expect(executeSource).toContain(
        "colorTransformWorkerClient?.dispose(error);",
      );
      expect(executeSource).toContain(
        "colorTransformWorkerClient = undefined;",
      );
      expect(executeSource).not.toContain("colorTransformWorkerClient = null;");
    });

    it("backs off before recreating a worker that just failed", () => {
      expect(source).toContain(
        "const COLOR_TRANSFORM_WORKER_RETRY_BACKOFF_MS = 5_000;",
      );
      expect(executeSource).toContain(
        "colorTransformWorkerRetryNotBeforeMs =\n        Date.now() + COLOR_TRANSFORM_WORKER_RETRY_BACKOFF_MS;",
      );
      expect(getClientSource).toContain(
        "if (Date.now() < colorTransformWorkerRetryNotBeforeMs) {",
      );
    });

    it("resets the backoff window on an explicit dispose", () => {
      expect(source).toContain(
        "colorTransformWorkerFallbackReason = undefined;\n  colorTransformWorkerRetryNotBeforeMs = 0;",
      );
    });
  });
});
