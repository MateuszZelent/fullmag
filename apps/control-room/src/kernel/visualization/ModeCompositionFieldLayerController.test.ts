import { describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "../api/ControlRoomApi";
import type { FrequencyDomainFieldResource } from "../api/apiTypes";
import type { DecodedFieldVector } from "../api/codecs";
import type { ModeCompositionResource } from "./ModeCompositionController";
import {
  ModeCompositionFieldLayerController,
  type ModeCompositionFieldLayerSnapshot,
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

function metadata(
  fieldId: string,
  overrides: Partial<FrequencyDomainFieldResource> = {},
): FrequencyDomainFieldResource {
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
    generation_id: "publication-12",
    generation_status: "member_verified_owner_bound",
    payload_encoding: "f64_interleaved_real_imag_xyz",
    payload_value_count: 12,
    quantity: "delta_m",
    resource_key: `data/fields/${encodeURIComponent(fieldId)}`,
    revision: "sha256:immutable-field-payload",
    schema_version: "frequency_domain_mode_field.v1",
    source_family: "analysis/eigen",
    status: "ready",
    value_kind: "complex_spatial_vector",
    ...overrides,
  };
}

function binary(
  fieldId: string,
  objectId = "object-a",
  formatVersion: 2 | 3 | 4 | 5 = 3,
): DecodedFieldVector {
  return {
    domainGenerationId: topology.domainGenerationId,
    dtype: "float64",
    formatVersion,
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

function loaders(formatVersion: 3 | 5 = 3) {
  const loadMetadata = vi.fn(async (
    layer: ModeCompositionResource["layers"][number],
    _signal: AbortSignal,
  ) => metadata(layer.field_id));
  const loadBinary = vi.fn(async (
    layer: ModeCompositionResource["layers"][number],
    _signal: AbortSignal,
    expectedArtifactGenerationId: string,
  ) => ({
    artifactGenerationId: expectedArtifactGenerationId as string | null,
    byteLength: 96,
    data: binary(layer.field_id, layer.object_id, formatVersion),
    etag: "field-etag-11",
    fieldRevision: "field-11",
    encoding: `FMVP;version=${formatVersion}`,
  }));
  return { loadBinary, loadMetadata };
}

function twoLayerComposition() {
  const resource = composition();
  const first = resource.layers[0]!;
  const second = {
    ...first,
    field_id: "analysis:eigen:sample-0:mode-1:delta_m_xyz",
    layer_id: "layer-b",
    mode: { ...first.mode, mode_id: "mode-1", raw_mode_index: 1 },
    object_id: "object-b",
    target_id: "object:object-b",
  };
  return {
    resource: { ...resource, layers: [first, second] },
    topologyByTarget: { "object:object-a": topology, "object:object-b": topology },
  };
}

describe("ModeCompositionFieldLayerController", () => {
  it("refreshes metadata but reuses unchanged binary data for presentation-only mutations", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();

    await controller.activate(composition(), { "object:object-a": topology }, source);
    await controller.activate(
      composition({ component: "z", representation: "imag", appearance: { colormap: "viridis" } }),
      { "object:object-a": topology },
      source,
    );

    expect(source.loadMetadata).toHaveBeenCalledTimes(2);
    expect(source.loadBinary).toHaveBeenCalledTimes(1);
    expect(source.loadBinary).toHaveBeenCalledWith(
      expect.objectContaining({ field_id: "analysis:eigen:sample-0:mode-0:delta_m_xyz" }),
      expect.any(AbortSignal),
      "publication-12",
      null,
    );
    expect(controller.getSnapshot().get("object:object-a")).toMatchObject({
      identity: { fieldRevision: "field-11" },
      status: "ready",
    });
  });

  it.each([3, 5] as const)(
    "loads and reuses version %s identities for both object layers",
    async (formatVersion) => {
      const controller = new ModeCompositionFieldLayerController();
      const source = loaders(formatVersion);
      const { resource, topologyByTarget } = twoLayerComposition();

      await controller.activate(resource, topologyByTarget, source);
      for (const [targetId, objectId] of [
        ["object:object-a", "object-a"],
        ["object:object-b", "object-b"],
      ] as const) {
        expect(controller.getSnapshot().get(targetId)).toMatchObject({
          identity: {
            binaryEncoding: `FMVP;version=${formatVersion}`,
            scopeId: objectId,
            scopeKind: "object",
          },
          status: "ready",
        });
      }

      await controller.activate({ ...resource, revision: 2 }, topologyByTarget, source);

      expect(source.loadBinary).toHaveBeenCalledTimes(2);
      for (const [targetId, objectId] of [
        ["object:object-a", "object-a"],
        ["object:object-b", "object-b"],
      ] as const) {
        expect(controller.getSnapshot().get(targetId)).toMatchObject({
          identity: {
            binaryEncoding: `FMVP;version=${formatVersion}`,
            scopeId: objectId,
            scopeKind: "object",
          },
          status: "ready",
        });
      }
    },
  );

  it.each([
    { encoding: "FMVP;version=3", formatVersion: 5 },
    { encoding: "FMVP;version=5", formatVersion: 3 },
  ] as const)(
    "rejects an FMVP header $encoding with decoded format $formatVersion",
    async ({ encoding, formatVersion }) => {
      const controller = new ModeCompositionFieldLayerController();
      const source = loaders();
      source.loadBinary.mockImplementationOnce(async (layer) => ({
        artifactGenerationId: "publication-12",
        byteLength: 96,
        data: binary(layer.field_id, layer.object_id, formatVersion),
        encoding,
        etag: "field-etag-11",
        fieldRevision: "field-11",
      }));

      await controller.activate(composition(), { "object:object-a": topology }, source);

      expect(controller.getSnapshot().get("object:object-a")).toMatchObject({
        field: null,
        identity: null,
        reason: "identity_mismatch",
        status: "error",
      });
    },
  );

  it.each([2, 4] as const)("rejects unsupported FMVP v%s mode fields", async (formatVersion) => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();
    source.loadBinary.mockImplementationOnce(async (layer) => ({
      artifactGenerationId: "publication-12",
      byteLength: 96,
      data: binary(layer.field_id, layer.object_id, formatVersion),
      encoding: `FMVP;version=${formatVersion}`,
      etag: "field-etag-11",
      fieldRevision: "field-11",
    }));

    await controller.activate(composition(), { "object:object-a": topology }, source);

    expect(controller.getSnapshot().get("object:object-a")).toMatchObject({
      field: null,
      identity: null,
      reason: "identity_mismatch",
      status: "error",
    });
  });

  it("rejects an unbound member before requesting composition bytes", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();
    const resource = composition();
    const first = resource.layers[0]!;
    const second = {
      ...first,
      layer_id: "layer-b",
      mode: { ...first.mode, mode_id: "mode-1", raw_mode_index: 1 },
      object_id: "object-b",
      target_id: "object:object-b",
    };
    source.loadMetadata.mockImplementation(async (layer) =>
      metadata(layer.field_id, {
        generation_status:
          layer.mode.mode_id === "mode-0"
            ? "member_verified_unbound"
            : "member_verified_owner_bound",
      }),
    );

    await controller.activate(
      { ...resource, layers: [first, second] },
      { "object:object-a": topology, "object:object-b": topology },
      source,
    );

    expect(source.loadBinary).not.toHaveBeenCalled();
    expect(controller.getSnapshot().get("object:object-a")).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining("member_verified_unbound") }),
      reason: "identity_mismatch",
      status: "error",
    });
    expect(controller.getSnapshot().get("object:object-b")).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining("cannot join fields") }),
      reason: "identity_mismatch",
      status: "error",
    });
  });

  it("does not admit legacy field metadata into a multi-artifact composition", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();
    source.loadMetadata.mockResolvedValueOnce(metadata(
      "analysis:eigen:sample-0:mode-0:delta_m_xyz",
      {
        generation_id: null,
        generation_status: "legacy_unverified",
      },
    ));

    await controller.activate(composition(), { "object:object-a": topology }, source);

    expect(source.loadBinary).not.toHaveBeenCalled();
    expect(controller.getSnapshot().get("object:object-a")).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining("legacy fields cannot join") }),
      reason: "identity_mismatch",
      status: "error",
    });
  });

  it("rejects a missing artifact-generation response header", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();
    source.loadBinary.mockImplementationOnce(async (layer) => ({
      artifactGenerationId: null,
      byteLength: 96,
      data: binary(layer.field_id, layer.object_id),
      etag: "field-etag-11",
      fieldRevision: "field-11",
      encoding: "FMVP;version=3",
    }));

    await controller.activate(composition(), { "object:object-a": topology }, source);

    expect(controller.getSnapshot().get("object:object-a")).toMatchObject({
      error: expect.objectContaining({ message: expect.stringContaining("artifact generation header") }),
      field: null,
      reason: "identity_mismatch",
      status: "error",
    });
  });

  it("rejects a composition whose mode fields belong to different committed publications", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();
    const resource = composition();
    const first = resource.layers[0]!;
    const second = {
      ...first,
      layer_id: "layer-b",
      mode: { ...first.mode, mode_id: "mode-1", raw_mode_index: 1 },
      object_id: "object-b",
      target_id: "object:object-b",
    };
    source.loadMetadata.mockImplementation(async (layer) =>
      metadata(layer.field_id, {
        generation_id: layer.mode.mode_id === "mode-0" ? "publication-12" : "publication-13",
      }),
    );

    await controller.activate(
      { ...resource, layers: [first, second] },
      { "object:object-a": topology, "object:object-b": topology },
      source,
    );

    expect(source.loadBinary).not.toHaveBeenCalled();
    for (const targetId of ["object:object-a", "object:object-b"]) {
      expect(controller.getSnapshot().get(targetId)).toMatchObject({
        error: expect.objectContaining({ message: expect.stringContaining("different committed artifact generations") }),
        reason: "identity_mismatch",
        status: "error",
      });
    }
  });

  it("does not reuse decoded mode fields after the session scope changes", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();

    await controller.activate(
      composition(),
      { "object:object-a": topology },
      source,
      "session-a\u0000epoch-1",
    );
    await controller.activate(
      composition(),
      { "object:object-a": topology },
      source,
      "session-b\u0000epoch-1",
    );

    expect(source.loadMetadata).toHaveBeenCalledTimes(2);
    expect(source.loadBinary).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().get("object:object-a")).toMatchObject({
      status: "ready",
    });
  });

  it("rereads metadata and fetches binary data when the committed generation changes under stable IDs", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();
    const fieldId = "analysis:eigen:sample-0:mode-0:delta_m_xyz";
    source.loadMetadata
      .mockResolvedValueOnce(metadata(fieldId, {
        content_digest: "sha256:publication-a",
        generation_id: "publication-a",
        revision: "metadata-a",
      }))
      .mockResolvedValueOnce(metadata(fieldId, {
        content_digest: "sha256:publication-b",
        generation_id: "publication-b",
        revision: "metadata-b",
      }));
    source.loadBinary.mockImplementation(async (layer, _signal, generationId) => ({
      artifactGenerationId: generationId,
      byteLength: 96,
      data: binary(layer.field_id, layer.object_id),
      etag: `etag:${generationId}`,
      fieldRevision: `field:${generationId}`,
      encoding: "FMVP;version=3",
    }));

    const resource = composition();
    await controller.activate(resource, { "object:object-a": topology }, source);
    await controller.activate(resource, { "object:object-a": topology }, source);

    expect(source.loadMetadata).toHaveBeenCalledTimes(2);
    expect(source.loadBinary).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().get("object:object-a")).toMatchObject({
      identity: {
        artifactGenerationId: "publication-b",
        fieldRevision: "field:publication-b",
      },
      status: "ready",
    });
  });

  it("clears cached metadata when the controller is cleared", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();

    await controller.activate(composition(), { "object:object-a": topology }, source);
    controller.clear();
    await controller.activate(composition(), { "object:object-a": topology }, source);

    expect(source.loadMetadata).toHaveBeenCalledTimes(2);
    expect(source.loadBinary).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().get("object:object-a")).toMatchObject({ status: "ready" });
  });

  it("retains the exact ready field after a same-generation binary transport failure", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();
    await controller.activate(composition(), { "object:object-a": topology }, source);
    // Simulate an evicted binary entry while keeping the immutable field revision
    // known, so this activation must exercise the transport-failure fallback.
    (controller as unknown as { fieldCache: { clear(): void } }).fieldCache.clear();
    source.loadBinary.mockRejectedValueOnce(new Error("offline"));

    await controller.activate(
      { ...composition(), revision: 2 },
      { "object:object-a": topology },
      source,
    );

    expect(source.loadMetadata).toHaveBeenCalledTimes(2);
    expect(source.loadBinary).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().get("object:object-a")).toMatchObject({
      error: expect.objectContaining({ message: "offline" }),
      field: expect.any(Object),
      identity: { artifactGenerationId: "publication-12", fieldRevision: "field-11" },
      reason: "transport_error",
      status: "degraded",
    });
  });

  it("removes stale-generation fields before per-target binary publication after a generic 409", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();
    const { resource, topologyByTarget } = twoLayerComposition();
    source.loadMetadata.mockImplementation(async (layer) => metadata(layer.field_id, {
      content_digest: "sha256:publication-a",
      generation_id: "publication-a",
      revision: "metadata-a",
    }));
    await controller.activate(resource, topologyByTarget, source);

    source.loadMetadata.mockImplementation(async (layer) => metadata(layer.field_id, {
      content_digest: "sha256:publication-b",
      generation_id: "publication-b",
      revision: "metadata-b",
    }));
    source.loadBinary.mockImplementation(async (layer, _signal, generationId) => {
      if (generationId === "publication-b" && layer.mode.mode_id === "mode-1") {
        throw new ControlRoomApiError("conflict", 409);
      }
      return {
        artifactGenerationId: generationId,
        byteLength: 96,
        data: binary(layer.field_id, layer.object_id),
        etag: `etag:${generationId}`,
        fieldRevision: `field:${generationId}`,
        encoding: "FMVP;version=3",
      };
    });
    const frames: Array<ReadonlyMap<string, ModeCompositionFieldLayerSnapshot>> = [];
    const unsubscribe = controller.subscribe(() => {
      frames.push(new Map(controller.getSnapshot()));
    });
    await controller.activate(resource, topologyByTarget, source);
    unsubscribe();

    expect(frames.some((frame) => {
      const generations = [...frame.values()]
        .map((snapshot) => snapshot.identity?.artifactGenerationId)
        .filter((generation): generation is string => Boolean(generation));
      return generations.includes("publication-a") && generations.includes("publication-b");
    })).toBe(false);
    expect(controller.getSnapshot().get("object:object-a")).toMatchObject({
      identity: { artifactGenerationId: "publication-b" },
      status: "ready",
    });
    expect(controller.getSnapshot().get("object:object-b")).toMatchObject({
      field: null,
      reason: "identity_mismatch",
      status: "error",
    });
  });

  it("fails closed when one fresh metadata member cannot prove the collection generation", async () => {
    const controller = new ModeCompositionFieldLayerController();
    const source = loaders();
    const { resource, topologyByTarget } = twoLayerComposition();
    source.loadMetadata.mockImplementation(async (layer) => metadata(layer.field_id, {
      content_digest: "sha256:publication-a",
      generation_id: "publication-a",
      revision: "metadata-a",
    }));
    await controller.activate(resource, topologyByTarget, source);
    const binaryCallCount = source.loadBinary.mock.calls.length;

    source.loadMetadata.mockImplementation(async (layer) => {
      if (layer.mode.mode_id === "mode-1") throw new Error("metadata offline");
      return metadata(layer.field_id, {
        content_digest: "sha256:publication-b",
        generation_id: "publication-b",
        revision: "metadata-b",
      });
    });
    const frames: Array<ReadonlyMap<string, ModeCompositionFieldLayerSnapshot>> = [];
    const unsubscribe = controller.subscribe(() => {
      frames.push(new Map(controller.getSnapshot()));
    });
    await controller.activate(resource, topologyByTarget, source);
    unsubscribe();

    expect(source.loadBinary).toHaveBeenCalledTimes(binaryCallCount);
    expect(frames.every((frame) => [...frame.values()].every((snapshot) => snapshot.field === null))).toBe(true);
    expect(controller.getSnapshot().get("object:object-a")).toMatchObject({
      field: null,
      status: "error",
    });
    expect(controller.getSnapshot().get("object:object-b")).toMatchObject({
      error: expect.objectContaining({ message: "metadata offline" }),
      field: null,
      reason: "transport_error",
      status: "error",
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
      artifactGenerationId: "publication-12",
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
