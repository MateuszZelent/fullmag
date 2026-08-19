import { describe, expect, it } from "vitest";

import type { DecodedComplexFieldVector } from "@/kernel/api/codecs";
import type { ModeCompositionLayer } from "@/kernel/visualization/ModeCompositionController";

import {
  buildModeCompositionScalarColorBuffer,
  modeCompositionTargetIdForMeshPart,
  resolveModeCompositionMeshPartRenderPlan,
} from "./modeCompositionViewportProjection";

function field(): DecodedComplexFieldVector {
  return {
    componentCount: 3,
    domainGenerationId: "generation-7",
    dtype: "complex128",
    formatVersion: 3,
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
