import { describe, expect, it } from "vitest";

import {
  assertPlanarEvidenceReady,
  createPlanarEvidence,
  resolvePlanarEvidenceStatus,
} from "./fieldMapEvidence";

describe("field-map evidence", () => {
  const requested = {
    canonicalUnit: "A/m",
    carrierRevision: "9007199254741003",
    component: "magnitude",
    defaultPlane: null,
    domainGenerationId: null,
    fieldBackend: "fem",
    fieldDevice: "cpu",
    fieldRevision: "9007199254741001",
    fieldSource: "live",
    fieldPrecision: "double",
    meshRevision: "9007199254741004",
    operatorThicknessM: 1e-9,
    positionFraction: null,
    resolvedCoordinateM: null,
    sampleToken: "planar-sample-v3:current",
    samplingExecution: "cpu",
    sourceKind: "monitor",
    sourceId: "xy-slab",
    sourceHash: "sha256:monitor-current",
    sourceRevision: "9007199254741002",
    operatorKind: "slab_average",
    operatorRevision: "9007199254741002",
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

  it("accepts the ready raster only when source, operator, revision, and identity match", () => {
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

  it("never reports ready without scalar/meta identities and render evidence", () => {
    expect(
      resolvePlanarEvidenceStatus({
        metaIdentity: undefined,
        metaStatus: "ready",
        renderEvidence: null,
        scalarIdentity: undefined,
        scalarStatus: "ready",
      }),
    ).toBe("loading");
  });
});
