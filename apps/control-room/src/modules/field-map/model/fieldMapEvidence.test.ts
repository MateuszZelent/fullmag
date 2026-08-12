import { describe, expect, it } from "vitest";

import {
  assertPlanarEvidenceReady,
  createPlanarEvidence,
  resolvePlanarEvidenceStatus,
} from "./fieldMapEvidence";

describe("field-map evidence", () => {
  const requested = {
    component: "magnitude",
    fieldRevision: 18,
    monitorId: "xy-slab",
    monitorHash: "sha256:monitor-current",
    monitorRevision: 27,
    operatorKind: "slab_average",
    operatorRevision: 27,
    quantityId: "m",
    metaIdentity: "\"fm-planar-sha256:current\"",
    scalarIdentity: "\"fm-planar-sha256:current\"",
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
      scalarIdentity: "\"fm-planar-sha256:stale\"",
      status: "ready",
    });

    expect(() => assertPlanarEvidenceReady(evidence, requested)).toThrow(
      /scalar identity mismatch/,
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

  it("keeps an already painted raster loading when the newly selected scalar identity differs", () => {
    expect(
      resolvePlanarEvidenceStatus({
        metaIdentity: '"fm-planar-sha256:new"',
        metaStatus: "ready",
        renderEvidence: {
          glyphCount: 64,
          overlayCounts: { contours: 12, meshSegments: 48 },
          raster: { checksum: "fnv1a32:deadbeef", max: 1, min: 0, sampleCount: 4 },
          sampleIdentity: '"fm-planar-sha256:old"',
        },
        scalarIdentity: '"fm-planar-sha256:old"',
        scalarStatus: "ready",
      }),
    ).toBe("loading");
  });
});
