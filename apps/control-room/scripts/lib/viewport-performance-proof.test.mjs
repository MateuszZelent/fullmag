import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VIEWPORT_PERFORMANCE_REASON_LIMIT,
  assertOrbitPerformanceDelta,
  assertQuantitySwitchPerformanceDelta,
  assertViewportPerformanceTrace,
  assertViewportOrbitPerformanceArtifactFile,
  captureViewportPerformanceSnapshot,
  installViewportPerformanceProbe,
  serializeViewportPerformanceSnapshot,
  validateViewportOrbitPerformanceArtifact,
  writeViewportOrbitPerformanceArtifact,
} from "./viewport-performance-proof.mjs";

describe("viewport-performance-proof", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("installs the opt-in probe and serializes a bounded raw snapshot", async () => {
    const testWindow = {};
    vi.stubGlobal("window", testWindow);
    const page = {
      addInitScript: vi.fn(async (callback) => callback()),
      evaluate: vi.fn(async (callback) => callback()),
    };

    await installViewportPerformanceProbe(page);
    testWindow.__FULLMAG_VISUALIZATION_DEBUG_PERFORMANCE__.viewportFrameReasons = Object.fromEntries(
      Array.from({ length: VIEWPORT_PERFORMANCE_REASON_LIMIT + 2 }, (_, index) => [
        `reason-${String(index).padStart(3, "0")}`,
        1,
      ]),
    );
    const snapshot = await captureViewportPerformanceSnapshot(page, "baseline");

    expect(page.addInitScript).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({ label: "baseline", schemaVersion: 1 });
    expect(Object.keys(snapshot.counters.viewportFrameReasons)).toHaveLength(
      VIEWPORT_PERFORMANCE_REASON_LIMIT,
    );
    expect(snapshot.counters.viewportFrameReasonsDropped).toBe(2);
    expect(snapshot.counters.viewportFrameReasonsOverflowed).toBe(true);
  });

  it("requires a serialized trace and rejects quantity or orbit budget violations", () => {
    const before = serializeViewportPerformanceSnapshot({}, "before");
    const after = serializeViewportPerformanceSnapshot({}, "after");

    expect(() => assertViewportPerformanceTrace()).toThrow("raw snapshots");
    expect(() => assertViewportPerformanceTrace([before, after])).not.toThrow();
    expect(() =>
      assertQuantitySwitchPerformanceDelta({
        after: serializeViewportPerformanceSnapshot({ topologyBuilds: 1 }, "quantity-after"),
        before,
        fieldGetsAfter: 0,
        fieldGetsBefore: 0,
        maxFieldDecodes: 0,
        maxFieldGets: 0,
        maxFieldSwaps: 0,
        plan: "warmed-cache",
      }),
    ).toThrow("topology builds");
    expect(() =>
      assertOrbitPerformanceDelta({
        acknowledgementsAfter: 1,
        acknowledgementsBefore: 0,
        after: serializeViewportPerformanceSnapshot({}, "orbit-after"),
        before,
        fieldGetsAfter: 0,
        fieldGetsBefore: 0,
      }),
    ).toThrow("acknowledgements");
  });

  it("atomically persists and revalidates the labeled orbit proof before smoke PASS", async () => {
    const artifactDirectory = await mkdtemp(join(tmpdir(), "fullmag-orbit-proof-"));
    const before = serializeViewportPerformanceSnapshot({}, "camera-orbit-before");
    const after = serializeViewportPerformanceSnapshot({}, "camera-orbit-after");
    const delta = assertOrbitPerformanceDelta({
      acknowledgementsAfter: 0,
      acknowledgementsBefore: 0,
      after,
      before,
      fieldGetsAfter: 0,
      fieldGetsBefore: 0,
    });

    try {
      const outputPath = await writeViewportOrbitPerformanceArtifact({
        artifactDirectory,
        delta,
        rawPerformanceTrace: [before, after],
      });
      const persisted = await assertViewportOrbitPerformanceArtifactFile(outputPath);

      expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(persisted);
      expect(persisted).toMatchObject({
        gate: { id: "camera-orbit-locality", passed: true },
        rawPerformanceTrace: [before, after],
      });
    } finally {
      await rm(artifactDirectory, { force: true, recursive: true });
    }
  });

  it("rejects a PASS artifact without the mandatory raw before/after trace", () => {
    expect(() =>
      validateViewportOrbitPerformanceArtifact({
        delta: {},
        gate: { id: "camera-orbit-locality", passed: true },
        rawPerformanceTrace: [],
        schemaVersion: "fullmag.viewport-orbit-performance-proof.v1",
      }),
    ).toThrow("raw snapshots");
  });
});
