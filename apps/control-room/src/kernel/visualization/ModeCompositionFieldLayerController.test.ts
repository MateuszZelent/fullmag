import { describe, expect, it, vi } from "vitest";

import type { FrequencyDomainFieldResource } from "../api/apiTypes";
import type { DecodedFieldVector } from "../api/codecs";
import type { ModeCompositionResource } from "./ModeCompositionController";
import {
  ModeCompositionFieldLayerController,
  type ModeCompositionFieldLayerTopologyIdentity,
} from "./ModeCompositionFieldLayerController";

const topology: ModeCompositionFieldLayerTopologyIdentity = {
  domainGenerationId: "generation-7",
  meshTopologyHash: "topology-9",
  meshTopologyRevision: "42",
};

function composition(overrides: {
  readonly appearance?: Record<string, unknown>;
  readonly component?: "vector" | "magnitude" | "x" | "y" | "z";
  readonly modeId?: string;
  readonly objectId?: string;
  readonly representation?: "phase_rotated_real" | "real" | "imag" | "abs" | "phase";
} = {}): ModeCompositionResource {
  const objectId = overrides.objectId ?? "object-a";
  return {
    artifact_revision: "artifact-5",
    composition_id: "composition-1",
    layers: [{
      amplitude_scale: 1,
      animation: {
        enabled: false,
        phase_offset_rad: 0,
        rate_hz: 0,
        synchronized: true,
      },
      appearance: {
        auto_range: true,
        colorbar_visible: true,
        colormap: "coolwarm",
        opacity: 1,
        symmetric_zero: true,
        vector_budget: 0,
        vector_length_scale: 1,
        vectors_visible: false,
        ...overrides.appearance,
      },
      component: overrides.component ?? "x",
      enabled: true,
      field_id: "analysis:eigen:sample-0:mode-0:delta_m_xyz",
      layer_id: "layer-a",
      mode: {
        artifact_revision: "artifact-5",
        mode_id: overrides.modeId ?? "mode-0",
        raw_mode_index: 0,
        run_id: "run-2",
        sample_id: "sample-0",
        sample_index: 0,
        stage_id: "stage-3",
      },
      normalization: "mode_global_max",
      object_id: objectId,
      phase_rad: 0,
      representation: overrides.representation ?? "phase_rotated_real",
      target_id: `object:${objectId}`,
    }],
    lifecycle: {
      artifact_revision: 5,
      mesh_revision: 42,
      run_id: "run-2",
      session_id: "session-1",
    },
    phase_clock: { master_rate_hz: 0, synchronized: true },
    revision: 1,
    run_id: "run-2",
    schema_version: "mode-composition.v1",
    stage_id: "stage-3",
  };
}

function metadata(fieldId: string): FrequencyDomainFieldResource {
  return {
    artifact_path: "eigen/modes/sample_0000_mode_0000.field.v1.json",
    available_views: ["complex", "real", "imag", "abs", "amplitude", "phase", "phase_rotated_real"],
    binary_layout: "complex_f64_pairs_little_endian",
    complex_pair_count: 6,
    component_basis: "global_xyz",
    component_count: 3,
    components: ["x", "y", "z"],
    content_digest: "sha256:immutable-field-payload",
    default_phase_rad: 0,
    default_view: "phase_rotated_real",
    field_id: fieldId,
    payload_encoding: "f64_interleaved_real_imag_xyz",
    payload_value_count: 12,
    quantity: "delta_m",
    resource_key: `data/fields/${encodeURIComponent(fieldId)}`,
    revision: "sha256:immutable-field-payload",
    schema_version: "frequency_domain_mode_field.v1",
    source_family: "analysis/eigen",
    status: "ready",
    value_kind: "complex_spatial_vector",
  };
}

function binary(fieldId: string, objectId = "object-a"): DecodedFieldVector {
  return {
    domainGenerationId: topology.domainGenerationId,
    dtype: "float64",
    formatVersion: 3,
    grid: [2, 1, 1],
    indexing: "explicit_node_indices",
    meshTopologyHash: topology.meshTopologyHash,
    meshTopologyRevision: topology.meshTopologyRevision,
    nComp: 6,
    nodeIndices: new Uint32Array([4, 9]),
    pointCount: 2,
    quantityId: fieldId,
    scopeId: objectId,
    scopeKind: "object",
    valueCount: 12,
    values: new Float64Array(12).fill(1),
  };
}

function loaders() {
  const loadMetadata = vi.fn(async (
    layer: ModeCompositionResource["layers"][number],
    _signal: AbortSignal,
  ) => metadata(layer.field_id));
  const loadBinary = vi.fn(async (
    layer: ModeCompositionResource["layers"][number],
    _signal: AbortSignal,
  ) => ({
    byteLength: 96,
    data: binary(layer.field_id, layer.object_id),
    etag: "field-etag-11",
    fieldRevision: "field-11",
    encoding: "FMVP;version=3",
  }));
  return { loadBinary, loadMetadata };
}

describe("ModeCompositionFieldLayerController", () => {
  it("loads one full complex object field and never refetches it for presentation-only mutations", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();

    await controller.activate(composition(), { "object:object-a": topology }, source);
    await controller.activate(
      composition({ component: "z", representation: "imag", appearance: { colormap: "viridis" } }),
      { "object:object-a": topology },
      source,
    );

    expect(source.loadMetadata).toHaveBeenCalledTimes(1);
    expect(source.loadBinary).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().get("object:object-a")).toMatchObject({
      identity: { fieldRevision: "field-11" },
      status: "ready",
    });
  });

  it("retains a ready field as degraded after a same-topology refresh failure", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();
    await controller.activate(composition(), { "object:object-a": topology }, source);
    source.loadMetadata.mockRejectedValueOnce(new Error("offline"));

    await controller.activate(
      composition({ modeId: "mode-1" }),
      { "object:object-a": topology },
      source,
    );

    expect(controller.getSnapshot().get("object:object-a")).toMatchObject({
      error: expect.objectContaining({ message: "offline" }),
      field: expect.any(Object),
      status: "degraded",
    });
  });

  it("keeps object-scoped node indices isolated when two targets use one mode", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();
    const twoObjects = composition();
    const first = twoObjects.layers[0]!;
    const second = {
      ...first,
      layer_id: "layer-b",
      object_id: "object-b",
      target_id: "object:object-b",
    };
    source.loadBinary.mockImplementation(async (
      layer: ModeCompositionResource["layers"][number],
    ) => ({
      byteLength: 96,
      data: {
        ...binary(layer.field_id, layer.object_id),
        nodeIndices: new Uint32Array(
          layer.object_id === "object-a" ? [4, 9] : [15, 23],
        ),
      },
      encoding: "FMVP;version=3",
      etag: `etag:${layer.object_id}`,
      fieldRevision: "field-11",
    }));

    await controller.activate(
      { ...twoObjects, layers: [first, second] },
      { "object:object-a": topology, "object:object-b": topology },
      source,
    );

    expect(source.loadMetadata).toHaveBeenCalledTimes(1);
    expect(source.loadBinary).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().get("object:object-a")?.field?.nodeIndices).toEqual(
      new Uint32Array([4, 9]),
    );
    expect(controller.getSnapshot().get("object:object-b")?.field?.nodeIndices).toEqual(
      new Uint32Array([15, 23]),
    );
  });

  it("drops retained data and fails closed when the topology identity changes", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();
    await controller.activate(composition(), { "object:object-a": topology }, source);

    await controller.activate(
      { ...composition(), revision: 2 },
      {
        "object:object-a": {
          ...topology,
          meshTopologyHash: "other-topology",
        },
      },
      source,
    );

    expect(controller.getSnapshot().get("object:object-a")).toMatchObject({
      field: null,
      status: "error",
    });
  });

  it("aborts a superseded request and ignores its late completion", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const first = loaders();
    let finishMetadata: ((value: FrequencyDomainFieldResource) => void) | undefined;
    let signal: AbortSignal | undefined;
    first.loadMetadata.mockImplementationOnce((
      _layer: ModeCompositionResource["layers"][number],
      requestSignal: AbortSignal,
    ) =>
      new Promise((resolve) => {
        signal = requestSignal;
        finishMetadata = resolve;
      }),
    );

    const stale = controller.activate(composition(), { "object:object-a": topology }, first);
    const current = controller.activate(
      composition({ modeId: "mode-1" }),
      { "object:object-a": topology },
      loaders(),
    );
    finishMetadata!(metadata("analysis:eigen:sample-0:mode-0:delta_m_xyz"));

    await stale;
    await current;
    expect(signal?.aborted).toBe(true);
    expect(controller.getSnapshot().get("object:object-a")?.layer?.mode.mode_id).toBe("mode-1");
  });
});
