import { describe, expect, it } from "vitest";

import {
  assertPlanarEvidenceReady,
  createPlanarEvidence,
} from "./fieldMapEvidence";

describe("field-map evidence", () => {
  const requested = {
    component: "magnitude",
    fieldRevision: 18,
    monitorId: "xy-slab",
    operatorKind: "slab_average",
    quantityId: "m",
    sampleIdentity: "\"fm-planar-sha256:current\"",
  } as const;

  it("rejects a non-empty stale canvas while the requested sample is still loading", () => {
    const evidence = createPlanarEvidence({
      ...requested,
      glyphCount: 64,
      overlayCounts: { contours: 12, meshSegments: 48 },
      raster: { checksum: "fnv1a32:deadbeef", max: 1, min: 0, sampleCount: 4 },
      status: "loading",
    });

    expect(() => assertPlanarEvidenceReady(evidence, requested)).toThrow(
      /status loading/,
    );
  });

  it("rejects a ready raster from another sample identity", () => {
    const evidence = createPlanarEvidence({
      ...requested,
      glyphCount: 64,
      overlayCounts: { contours: 12, meshSegments: 48 },
      raster: { checksum: "fnv1a32:deadbeef", max: 1, min: 0, sampleCount: 4 },
      sampleIdentity: "\"fm-planar-sha256:stale\"",
      status: "ready",
    });

    expect(() => assertPlanarEvidenceReady(evidence, requested)).toThrow(
      /sample identity mismatch/,
    );
  });

  it("accepts the ready raster only when monitor, operator, revision, and identity match", () => {
    const evidence = createPlanarEvidence({
      ...requested,
      glyphCount: 64,
      overlayCounts: { contours: 12, meshSegments: 48 },
      raster: { checksum: "fnv1a32:deadbeef", max: 1, min: 0, sampleCount: 4 },
      status: "ready",
    });

    expect(assertPlanarEvidenceReady(evidence, requested)).toEqual(evidence);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.overlayCounts)).toBe(true);
  });
});
