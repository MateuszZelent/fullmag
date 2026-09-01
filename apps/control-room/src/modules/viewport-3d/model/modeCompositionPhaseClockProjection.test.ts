import { describe, expect, it } from "vitest";

import type { DecodedComplexFieldVector } from "@/kernel/api/codecs";
import type { ModeCompositionLayer } from "@/kernel/visualization/ModeCompositionController";

import { buildModeCompositionScalarColorBuffer } from "./modeCompositionViewportProjection";

function field(): DecodedComplexFieldVector {
  return {
    componentCount: 3,
    domainGenerationId: "generation-7",
    dtype: "complex128",
    formatVersion: 3,
    grid: [1, 1, 1],
    indexing: "explicit_node_indices",
    meshTopologyHash: "topology-a",
    meshTopologyRevision: "17",
    nodeIndices: new Uint32Array([0]),
    pointCount: 1,
    quantityId: "analysis:eigen:sample-a:mode-a",
    scopeId: "film",
    scopeKind: "object",
    valueCount: 6,
    values: new Float64Array([1, 10, 2, 20, 3, 30]),
  };
}

function layer(): ModeCompositionLayer {
  return {
    amplitude_scale: 1,
    animation: {
      enabled: true,
      phase_offset_rad: 0.25,
      rate_hz: 2,
      synchronized: false,
    },
    appearance: {
      auto_range: true,
      colorbar_visible: true,
      colormap: "coolwarm",
      opacity: 1,
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
    phase_rad: 0.5,
    representation: "phase_rotated_real",
    target_id: "object:film",
  };
}

describe("mode composition phase-clock projection", () => {
  it("updates only the phase uniform from the live layer clock", () => {
    const complex = field();
    const staticProjection = buildModeCompositionScalarColorBuffer({
      field: complex,
      layer: layer(),
      requiredSurfaceNodeIndices: new Uint32Array([0]),
      topologyNodeCount: 1,
    });
    const animatedProjection = buildModeCompositionScalarColorBuffer({
      field: complex,
      layer: layer(),
      phaseRad: 1.75,
      requiredSurfaceNodeIndices: new Uint32Array([0]),
      topologyNodeCount: 1,
    });

    expect(animatedProjection).not.toBeNull();
    expect(animatedProjection?.complexPhaseRad).toBe(1.75);
    expect(animatedProjection?.complexRealValues).toBe(
      staticProjection?.complexRealValues,
    );
    expect(animatedProjection?.complexImagValues).toBe(
      staticProjection?.complexImagValues,
    );
  });
});
