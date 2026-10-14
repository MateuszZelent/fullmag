import { describe, expect, it } from "vitest";

import type { DecodedComplexFieldVector } from "@/kernel/api/codecs";
import type { ModeFieldComplexBinaryIdentity } from "@/kernel/resources/frequencyDomainResourceKeys";
import type { ModeCompositionLayer } from "@/kernel/visualization/ModeCompositionController";

import {
  buildModeCompositionScalarColorBuffer,
  buildModeCompositionVectorLayerInput,
  modeCompositionTargetIdForMeshPart,
  resolveModeCompositionMeshPartRenderPlan,
} from "./modeCompositionViewportProjection";

function field(formatVersion: 2 | 3 | 4 | 5 = 3): DecodedComplexFieldVector {
  return {
    componentCount: 3,
    domainGenerationId: "generation-7",
    dtype: "complex128",
    formatVersion,
    grid: [2, 1, 1],
    indexing: "explicit_node_indices",
    meshTopologyHash: "topology-a",
    meshTopologyRevision: "17",
    nodeIndices: new Uint32Array([1, 3]),
    pointCount: 2,
    quantityId: "analysis:eigen:sample-a:mode-a",
    scopeId: "film",
    scopeKind: "object",
    valueCount: 12,
    values: new Float64Array([
      1, 10, 2, 20, 3, 30,
      4, 40, 5, 50, 6, 60,
    ]),
  };
}

function layer(
  overrides: Partial<ModeCompositionLayer> = {},
): ModeCompositionLayer {
  return {
    amplitude_scale: 2,
    animation: {
      enabled: false,
      phase_offset_rad: 0,
      rate_hz: 1,
      synchronized: false,
    },
    appearance: {
      auto_range: true,
      colorbar_visible: true,
      colormap: "coolwarm",
      opacity: 0.8,
      range_max: null,
      range_min: null,
      symmetric_zero: true,
      vector_budget: 0,
      vector_length_scale: 1,
      vectors_visible: false,
    },
    component: "x",
    enabled: true,
    field_id: "analysis:eigen:sample-a:mode-a",
    layer_id: "layer:film",
    mode: {
      artifact_revision: "artifact-3",
      mode_id: "mode-a",
      raw_mode_index: 0,
      run_id: "run-a",
      sample_id: "sample-a",
      sample_index: 0,
      stage_id: "stage-a",
    },
    normalization: "mode_global_max",
    object_id: "film",
    phase_rad: 0.25,
    representation: "real",
    target_id: "object:film",
    ...overrides,
  };
}

function identity(
  artifactGenerationId: string,
  fieldRevision: string,
  binaryEncoding: "FMVP;version=3" | "FMVP;version=5" = "FMVP;version=3",
): ModeFieldComplexBinaryIdentity {
  return {
    artifactGenerationId,
    artifactRevision: "artifact-3",
    binaryEncoding,
    fieldId: "analysis:eigen:sample-a:mode-a",
    fieldRevision,
    generationId: "generation-7",
    modeId: "mode-a",
    runId: "run-a",
    sampleId: "sample-a",
    scopeId: "film",
    scopeKind: "object",
    stageId: "stage-a",
    topologyHash: "topology-a",
  };
}

describe("modeCompositionViewportProjection", () => {
  it("maps an object-scoped complex field onto the shared indexed topology", () => {
    const buffer = buildModeCompositionScalarColorBuffer({
      field: field(),
      layer: layer(),
      requiredSurfaceNodeIndices: new Uint32Array([1, 3]),
      topologyNodeCount: 5,
    });

    expect(buffer).not.toBeNull();
    expect(Array.from(buffer!.complexRealValues!)).toEqual([
      0, 0, 0,
      1, 2, 3,
      0, 0, 0,
      4, 5, 6,
      0, 0, 0,
    ]);
    expect(Array.from(buffer!.complexImagValues!)).toEqual([
      0, 0, 0,
      10, 20, 30,
      0, 0, 0,
      40, 50, 60,
      0, 0, 0,
    ]);
    expect(buffer).toMatchObject({
      amplitudeScale: 2,
      colorMode: "x",
      colorPalette: "coolwarm",
      complexPhaseRad: 0.25,
      complexRepresentation: "real",
      range: { min: -8, max: 8 },
    });
  });

  it.each([3, 5] as const)(
    "projects FMVP v%s fields with the same complex values, phase, and coverage",
    (formatVersion) => {
      const buffer = buildModeCompositionScalarColorBuffer({
        field: field(formatVersion),
        layer: layer({ phase_rad: 1.25, representation: "phase_rotated_real" }),
        requiredSurfaceNodeIndices: new Uint32Array([1, 3]),
        topologyNodeCount: 5,
      });

      expect(buffer).not.toBeNull();
      expect(buffer?.complexRealValues).toEqual(
        new Float32Array([0, 0, 0, 1, 2, 3, 0, 0, 0, 4, 5, 6, 0, 0, 0]),
      );
      expect(buffer?.complexImagValues).toEqual(
        new Float32Array([0, 0, 0, 10, 20, 30, 0, 0, 0, 40, 50, 60, 0, 0, 0]),
      );
      expect(buffer?.complexPhaseRad).toBe(1.25);
      expect(buffer?.complexRepresentation).toBe("phase_rotated_real");
    },
  );

  it.each([2, 4] as const)("rejects FMVP v%s fields from mode composition projection", (formatVersion) => {
    expect(buildModeCompositionScalarColorBuffer({
      field: field(formatVersion),
      layer: layer(),
      requiredSurfaceNodeIndices: new Uint32Array([1, 3]),
      topologyNodeCount: 5,
    })).toBeNull();
  });

  it("changes phase, representation and component without rebuilding raw attributes", () => {
    const complex = field();
    const requiredSurfaceNodeIndices = new Uint32Array([1, 3]);
    const realX = buildModeCompositionScalarColorBuffer({
      field: complex,
      layer: layer(),
      requiredSurfaceNodeIndices,
      topologyNodeCount: 5,
    });
    const imagZ = buildModeCompositionScalarColorBuffer({
      field: complex,
      layer: layer({
        component: "z",
        phase_rad: 1.75,
        representation: "imag",
      }),
      requiredSurfaceNodeIndices,
      topologyNodeCount: 5,
    });

    expect(realX).not.toBeNull();
    expect(imagZ).not.toBeNull();
    expect(imagZ!.complexRealValues).toBe(realX!.complexRealValues);
    expect(imagZ!.complexImagValues).toBe(realX!.complexImagValues);
    expect(imagZ!.buildKey).toBe(realX!.buildKey);
    expect(imagZ).toMatchObject({
      colorMode: "z",
      complexPhaseRad: 1.75,
      complexRepresentation: "imag",
    });
  });

  it("keys derived buffers by the committed artifact generation and field revision", () => {
    const common = {
      field: field(),
      layer: layer(),
      requiredSurfaceNodeIndices: new Uint32Array([1, 3]),
      topologyNodeCount: 5,
    };
    const publicationA = buildModeCompositionScalarColorBuffer({
      ...common,
      identity: identity("publication-a", "field-a"),
    });
    const publicationB = buildModeCompositionScalarColorBuffer({
      ...common,
      identity: identity("publication-b", "field-a"),
    });
    const updatedField = buildModeCompositionScalarColorBuffer({
      ...common,
      identity: identity("publication-a", "field-b"),
    });

    expect(publicationA).not.toBeNull();
    expect(publicationB?.buildKey).not.toBe(publicationA?.buildKey);
    expect(updatedField?.buildKey).not.toBe(publicationA?.buildKey);
    expect(publicationB?.sourceFieldBufferId).not.toBe(publicationA?.sourceFieldBufferId);
    expect(updatedField?.targetRevision).not.toBe(publicationA?.targetRevision);
  });

  it("keeps projected buffer identities distinct across actual FMVP encodings", () => {
    const common = {
      layer: layer(),
      requiredSurfaceNodeIndices: new Uint32Array([1, 3]),
      topologyNodeCount: 5,
    };
    const version3 = buildModeCompositionScalarColorBuffer({
      ...common,
      field: field(3),
      identity: identity("publication-a", "field-a", "FMVP;version=3"),
    });
    const version5 = buildModeCompositionScalarColorBuffer({
      ...common,
      field: field(5),
      identity: identity("publication-a", "field-a", "FMVP;version=5"),
    });

    expect(version5?.buildKey).not.toBe(version3?.buildKey);
    expect(version5?.sourceFieldBufferId).not.toBe(version3?.sourceFieldBufferId);
  });

  it("projects scoped values onto expanded surface-face vertices", () => {
    const buffer = buildModeCompositionScalarColorBuffer({
      field: field(),
      geometryNodeIndices: new Uint32Array([3, 1, 3]),
      layer: layer(),
      projectionKey: "part:film:expanded",
      requiredSurfaceNodeIndices: new Uint32Array([1, 3]),
      topologyNodeCount: 5,
    });

    expect(Array.from(buffer?.complexRealValues ?? [])).toEqual([
      4, 5, 6,
      1, 2, 3,
      4, 5, 6,
    ]);
  });

  it("fails closed when object coverage is incomplete or belongs to another object", () => {
    expect(buildModeCompositionScalarColorBuffer({
      field: field(),
      layer: layer(),
      requiredSurfaceNodeIndices: new Uint32Array([1, 2, 3]),
      topologyNodeCount: 5,
    })).toBeNull();
    expect(buildModeCompositionScalarColorBuffer({
      field: field(),
      layer: layer({ object_id: "other", target_id: "object:other" }),
      requiredSurfaceNodeIndices: new Uint32Array([1, 3]),
      topologyNodeCount: 5,
    })).toBeNull();
  });

  it("keeps a vector component glyph-only and projects its modal phasor into glyph segments", () => {
    const vectorLayer = layer({
      appearance: {
        ...layer().appearance,
        vector_budget: 2,
        vector_length_scale: 2,
        vectors_visible: true,
      },
      component: "vector",
      phase_rad: 0,
      representation: "phase_rotated_real",
    });

    expect(
      buildModeCompositionScalarColorBuffer({
        field: field(),
        layer: vectorLayer,
        requiredSurfaceNodeIndices: new Uint32Array([1, 3]),
        topologyNodeCount: 5,
      }),
    ).toBeNull();

    const vectorInput = buildModeCompositionVectorLayerInput({
      field: field(),
      layer: vectorLayer,
      topologyNodeCount: 5,
      topologyPositions: new Float32Array([
        0, 0, 0,
        1, 0, 0,
        2, 0, 0,
        3, 0, 0,
        4, 0, 0,
      ]),
      vectorScale: 1,
    });

    expect(vectorInput?.segments).toHaveLength(14);
    const firstSegment = vectorInput?.segments?.slice(0, 7);
    expect(firstSegment?.[0]).toBeCloseTo(1 - 1 / Math.sqrt(14));
    expect(firstSegment?.[1]).toBeCloseTo(-2 / Math.sqrt(14));
    expect(firstSegment?.[2]).toBeCloseTo(-3 / Math.sqrt(14));
    expect(firstSegment?.[3]).toBeCloseTo(1 + 1 / Math.sqrt(14));
    expect(firstSegment?.[4]).toBeCloseTo(2 / Math.sqrt(14));
    expect(firstSegment?.[5]).toBeCloseTo(3 / Math.sqrt(14));
    expect(firstSegment?.[6]).toBeCloseTo(Math.sqrt(14 / 77));
    expect(vectorInput?.buildReference?.resourceKey).toBe(
      "data/fields/analysis%3Aeigen%3Asample-a%3Amode-a",
    );
  });

  it("maps every mesh carrier to its canonical object target", () => {
    expect(modeCompositionTargetIdForMeshPart({ object_id: "film" })).toBe(
      "object:film",
    );
    expect(modeCompositionTargetIdForMeshPart({ object_id: "object:film" })).toBe(
      "object:film",
    );
    expect(modeCompositionTargetIdForMeshPart({ object_id: null })).toBeNull();
  });

  it("uses the render-plan owner per target and restores the exact base", () => {
    const baseA = { shader: "configured-a" };
    const baseB = { shader: "configured-b" };
    const activeLayer = layer();
    const targetA = resolveModeCompositionMeshPartRenderPlan({
      baseSurface: { kind: "surface", surface: baseA },
      compositionId: "composition:active",
      snapshot: {
        error: null,
        field: field(),
        identity: null,
        layer: activeLayer,
        reason: null,
        status: "ready",
      },
      targetId: "object:film",
    });
    const targetB = resolveModeCompositionMeshPartRenderPlan({
      baseSurface: { kind: "surface", surface: baseB },
      compositionId: "composition:active",
      snapshot: null,
      targetId: "object:reference",
    });

    expect(targetA.surfacePass).toMatchObject({
      owner: "modal",
      compositionId: "composition:active",
      layerId: "layer:film",
    });
    expect(targetB.surfacePass).toEqual({ owner: "base", surface: baseB });
    if (targetB.surfacePass.owner === "base") {
      expect(targetB.surfacePass.surface).toBe(baseB);
    }

    const disabled = resolveModeCompositionMeshPartRenderPlan({
      baseSurface: { kind: "surface", surface: baseA },
      compositionId: "composition:active",
      snapshot: {
        error: null,
        field: null,
        identity: null,
        layer: { ...activeLayer, enabled: false },
        reason: null,
        status: "absent",
      },
      targetId: "object:film",
    });
    expect(disabled.surfacePass).toEqual({ owner: "base", surface: baseA });
  });
});
