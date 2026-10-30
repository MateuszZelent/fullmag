import { describe, expect, it } from "vitest";

import {
  assertPlanarEvidenceReady,
  createPlanarEvidence,
  resolvePlanarEvidenceStatus,
  samePlanarRenderEvidence,
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

  it("accepts a terminal zero range for a fully empty or masked raster", () => {
    const evidence = createPlanarEvidence({
      ...requested,
      glyphCount: 0,
      overlayCounts: { contours: 0, meshSegments: 0 },
      raster: { checksum: "fnv1a32:00000000", max: 0, min: 0, sampleCount: 4 },
      status: "ready",
    });

    expect(assertPlanarEvidenceReady(evidence, requested).raster).toMatchObject({
      max: 0,
      min: 0,
    });
  });

  it.each([
    ["minimum", Number.NaN, 1],
    ["maximum", 0, Number.POSITIVE_INFINITY],
  ])("rejects ready raster evidence with a non-finite %s", (_name, min, max) => {
    const evidence = createPlanarEvidence({
      ...requested,
      glyphCount: 0,
      overlayCounts: { contours: 0, meshSegments: 0 },
      raster: { checksum: "fnv1a32:00000000", max, min, sampleCount: 4 },
      status: "ready",
    });

    expect(() => assertPlanarEvidenceReady(evidence, requested)).toThrow(
      /range is non-finite/,
    );
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

  it("treats a republished frame with equal values as the same evidence", () => {
    const evidence = {
      glyphCount: 12,
      overlayCounts: { boundsSegments: 4, contours: 0, meshSegments: 886, pointMarkers: 0 },
      raster: { checksum: "fnv1a32:64aa6ccd", max: 1, min: 0.5, sampleCount: 262144 },
      sampleIdentity: "frame-a",
    };
    // The renderer builds a fresh object on every overlay redraw; equal values
    // must not count as a change, or the evidence state re-renders in a loop.
    const republished = structuredClone(evidence);

    expect(samePlanarRenderEvidence(null, evidence)).toBe(false);
    expect(samePlanarRenderEvidence(evidence, republished)).toBe(true);
    expect(samePlanarRenderEvidence(evidence, { ...republished, glyphCount: 13 })).toBe(false);
    expect(samePlanarRenderEvidence(evidence, {
      ...republished,
      overlayCounts: { ...republished.overlayCounts, meshSegments: 885 },
    })).toBe(false);
    expect(samePlanarRenderEvidence(evidence, {
      ...republished,
      raster: { ...republished.raster, checksum: "fnv1a32:00000000" },
    })).toBe(false);
    expect(samePlanarRenderEvidence(evidence, { ...republished, raster: null })).toBe(false);
    expect(samePlanarRenderEvidence({ ...evidence, raster: null }, { ...republished, raster: null })).toBe(true);
    expect(samePlanarRenderEvidence(evidence, { ...republished, sampleIdentity: "frame-b" })).toBe(false);
  });
});
