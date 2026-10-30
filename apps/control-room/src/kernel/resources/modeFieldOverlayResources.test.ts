import { describe, expect, it, vi } from "vitest";

import type {
  AnalysisResultFieldRef,
  FieldVectorQuery,
  FrequencyDomainFieldResource,
  FrequencyDomainJsonArtifactResource,
} from "../api/apiTypes";
import type { DecodedFieldVector } from "../api/codecs";
import { fieldVectorResourceKey } from "../api/fieldQueryIdentity";
import {
  createModeFieldOverlayIntent,
  modeFieldOverlayArtifactGenerationMatches,
} from "../visualization/ModeFieldOverlayIntent";
import { ModeFieldOverlayIntentController } from "../visualization/ModeFieldOverlayIntentController";
import {
  createAnalysisResultFieldOverlayIntent,
  isAnalysisResultFieldOverlayIntent,
} from "../visualization/AnalysisResultFieldOverlayIntent";
import { analysisResultSelectionRef } from "@/shared/domain/analysis/results";
import {
  resolveModeFieldOverlayMetadataRevision,
  resolveModeFieldOverlayResource as resolveModeFieldOverlayResourceGate,
  loadEigenModeFieldOverlayMetadata,
} from "./modeFieldOverlayResources";

const intent = createModeFieldOverlayIntent({
  analysisRunId: "run-k0",
  analysisStageId: "stage-eigen",
  equilibriumId: "sha256:eq-k0",
  artifactRevision: "sha256:artifact-v1",
  fieldId: "analysis:eigen:sample-k0:mode-1:delta_m_xyz",
  kind: "results.eigen.mode",
  modeId: "mode-1",
  modeIndex: 1,
  nodeId: "results:eigen:sample-k0:mode-1",
  sampleId: "sample-k0",
  sampleIndex: 0,
  type: "frequency-domain",
})!;

const metadata: FrequencyDomainFieldResource = {
  artifact_path: "eigen/modes/sample_0000_mode_0001.field.v1.json",
  available_views: ["complex", "real", "imag", "abs", "amplitude", "phase", "phase_rotated_real"],
  binary_layout: "complex_f64_pairs_little_endian",
  complex_pair_count: 6,
  component_basis: "global_xyz",
  component_count: 3,
  components: ["x", "y", "z"],
  default_phase_rad: 0,
  default_view: "phase_rotated_real",
  field_id: "analysis:eigen:sample-k0:mode-1:delta_m_xyz",
  payload_encoding: "f64_interleaved_real_imag_xyz",
  payload_value_count: 12,
  quantity: "delta_m",
  resource_key: "data/fields/analysis%3Aeigen%3Asample-k0%3Amode-1%3Adelta_m_xyz",
  schema_version: "frequency_domain_mode_field.v1",
    generation_id: "publication-14",
    generation_status: "member_verified_owner_bound",
  source_family: "analysis/eigen",
  status: "ready",
  value_kind: "complex_spatial_vector",
};

function ownedArtifact(equilibriumId = "sha256:eq-k0"): FrequencyDomainJsonArtifactResource {
  return {
    schema_version: "frequency_domain_eigen_mode_resource.v1", status: "ready",
    artifact_path: "eigen/modes/sample_0000/mode_0001.json", resource_key: "mode-json",
    run_id: "run-k0", stage_id: "stage-eigen", revision: "sha256:mode-json-v1",
    generation_id: "publication-14", generation_status: "member_verified_owner_bound",
    payload: {
      schema_version: "eigen_mode.v2", sample_index: 0, raw_mode_index: 1,
      mode_field_id: intent.fieldId, equilibrium_artifact_sha256: equilibriumId,
      candidate_identity: { schema_version: "candidate.v1", source_identity: {}, equilibrium_artifact_sha256: equilibriumId },
    },
  } as FrequencyDomainJsonArtifactResource;
}

const readyModeArtifact = {
  data: ownedArtifact(), error: null, revision: "sha256:mode-json-v1", status: "ready" as const,
};

function resolveModeFieldOverlayResource(
  activeIntent: Parameters<typeof resolveModeFieldOverlayResourceGate>[0],
  resource: Parameters<typeof resolveModeFieldOverlayResourceGate>[1],
  modeArtifact = readyModeArtifact,
) {
  return resolveModeFieldOverlayResourceGate(activeIntent, resource, modeArtifact);
}

describe("mode field overlay resource", () => {
  it("passes the committed result generation through the vector request and rejects malformed keys before it", async () => {
    const fieldId = "analysis:eigen:sample-result:mode-1";
    const expectedQuery: FieldVectorQuery = {
      component: "full",
      expected_artifact_generation_id: "publication-14",
      phase_rad: 0,
      scope_kind: "full",
      view: "complex",
    };
    const fieldRef: AnalysisResultFieldRef = {
      field_id: fieldId,
      field_revision: "sha256:result-field-v1",
      mesh_ref: {
        mesh_id: "mesh:result",
        mesh_revision: "41",
        topology_fingerprint: "sha256:result-topology-v1",
      },
      quantity_id: "m",
      representation: "complex-vector-xyz",
      resource_key:
        `/v2/sessions/current/data/fields/${encodeURIComponent(fieldId)}/samples/vector` +
        `?phase_rad=0&view=phase_rotated_real&expected_artifact_generation_id=publication-14`,
      status: "ready",
    };
    const selection = analysisResultSelectionRef({
      datasetId: "result:dataset",
      datasetRevision: "sha256:dataset-v1",
      fieldId,
      fieldRef,
      fieldRevision: fieldRef.field_revision,
      focus: "item",
      itemId: "mode-1",
      itemKind: "eigen_mode",
      runId: "run-result",
      sampleId: "sample-result",
      stageId: "stage-result",
    });
    const intent = createAnalysisResultFieldOverlayIntent(selection)!;
    const vector = vi.fn(
      async (quantityId: string, _query: FieldVectorQuery): Promise<DecodedFieldVector> => ({
        dtype: "float64",
        domainGenerationId: "generation-1",
        formatVersion: 3,
        grid: [1, 1, 1],
        indexing: "full_domain",
        meshTopologyHash: "sha256:result-topology-v1",
        meshTopologyRevision: "41",
        nComp: 6,
        pointCount: 1,
        quantityId,
        valueCount: 6,
        values: new Float64Array(6).fill(0.25),
      }),
    );
    const controller = new ModeFieldOverlayIntentController();
    const topology = {
      domainGenerationId: "generation-1",
      meshId: "mesh:result",
      meshTopologyHash: "sha256:result-topology-v1",
      meshTopologyRevision: "41",
      pointCount: 1,
    };

    await expect(
      controller.activate(
        intent!,
        {
          loadMetadata: async (activeIntent) => {
            if (!isAnalysisResultFieldOverlayIntent(activeIntent)) {
              throw new Error("Expected an analysis-result field intent");
            }
            return {
              data: activeIntent.fieldRef,
              revision: activeIntent.fieldRevision,
            };
          },
          loadBinary: async (metadata) =>
            vector(metadata.fieldId, metadata.binaryQuery),
        },
        topology,
      ),
    ).resolves.toBe("ready");
    expect(vector).toHaveBeenCalledTimes(1);
    expect(vector).toHaveBeenCalledWith(fieldId, expect.objectContaining(expectedQuery));

    const malformedIntent = createAnalysisResultFieldOverlayIntent(selection, {
      ...fieldRef,
      resource_key: `https://foreign.invalid${fieldVectorResourceKey(fieldId, expectedQuery)}`,
    })!;
    const malformedController = new ModeFieldOverlayIntentController();
    await expect(
      malformedController.activate(
        malformedIntent,
        {
          loadMetadata: async (activeIntent) => {
            if (!isAnalysisResultFieldOverlayIntent(activeIntent)) {
              throw new Error("Expected an analysis-result field intent");
            }
            return {
              data: activeIntent.fieldRef,
              revision: activeIntent.fieldRevision,
            };
          },
          loadBinary: async (metadata) =>
            vector(metadata.fieldId, metadata.binaryQuery),
        },
        topology,
      ),
    ).resolves.toBe("error");
    expect(vector).toHaveBeenCalledTimes(1);
  });

  it("does not expose a binary request until metadata is verified against the active intent", () => {
    expect(
      resolveModeFieldOverlayResource(intent, {
        data: metadata,
        error: null,
        revision: "sha256:field-v1",
        status: "ready",
      }),
    ).toMatchObject({
      binaryResourceKey: "data/fields/analysis%3Aeigen%3Asample-k0%3Amode-1%3Adelta_m_xyz",
      metadataStatus: "ready",
      status: "ready",
    });
  });

  it("keeps a malformed or stale metadata payload fail-closed", () => {
    expect(
      resolveModeFieldOverlayResource(intent, {
        data: { ...metadata, component_basis: "local_tangent_frame" },
        error: null,
        revision: "sha256:field-v1",
        status: "ready",
      }),
    ).toMatchObject({ binaryResourceKey: null, status: "error" });
  });

  it("requests only owner-bound committed generations and rejects unbound members", () => {
    const ownerBound = resolveModeFieldOverlayResource(intent, {
      data: {
        ...metadata,
        generation_id: "publication-14",
        generation_status: "member_verified_owner_bound",
      },
      error: null,
      revision: "sha256:field-v1",
      status: "ready",
    });
    expect(ownerBound).toMatchObject({
      metadata: {
        artifactGenerationId: "publication-14",
        artifactGenerationStatus: "member_verified_owner_bound",
        binaryQuery: {
          expected_artifact_generation_id: "publication-14",
        },
      },
      status: "ready",
    });

    const unbound = resolveModeFieldOverlayResource(intent, {
      data: {
        ...metadata,
        generation_id: "publication-14",
        generation_status: "member_verified_unbound",
      },
      error: null,
      revision: "sha256:field-v1",
      status: "ready",
    });
    expect(unbound).toMatchObject({
      binaryResourceKey: null,
      error: expect.objectContaining({ message: expect.stringContaining("member_verified_unbound") }),
      status: "error",
    });
  });

  it("requires an exact binary generation header and rejects legacy eigen fields", () => {
    const ownerBound = resolveModeFieldOverlayResource(intent, {
      data: {
        ...metadata,
        generation_id: "publication-14",
        generation_status: "member_verified_owner_bound",
      },
      error: null,
      revision: "sha256:field-v1",
      status: "ready",
    }).metadata!;
    expect(modeFieldOverlayArtifactGenerationMatches(ownerBound, "publication-14")).toBe(true);
    expect(modeFieldOverlayArtifactGenerationMatches(ownerBound, null)).toBe(false);
    expect(modeFieldOverlayArtifactGenerationMatches(ownerBound, "publication-stale")).toBe(false);

    const legacy = resolveModeFieldOverlayResource(intent, {
      data: { ...metadata, generation_id: null, generation_status: "legacy_unverified" },
      error: null,
      revision: "sha256:field-v1",
      status: "ready",
    });
    expect(legacy.metadata).toBeNull();
    expect(legacy.binaryResourceKey).toBeNull();
    expect(legacy.status).toBe("error");
  });

  it("changes the field build revision when an artifact revision changes at the same metadata path", () => {
    const nextIntent = createModeFieldOverlayIntent({
      analysisRunId: "run-k0",
      analysisStageId: "stage-eigen",
  equilibriumId: "sha256:eq-k0",
      artifactRevision: "sha256:artifact-v2",
      fieldId: "analysis:eigen:sample-k0:mode-1:delta_m_xyz",
      kind: "results.eigen.mode",
      modeId: "mode-1",
      modeIndex: 1,
      nodeId: "results:eigen:sample-k0:mode-1",
      sampleId: "sample-k0",
      sampleIndex: 0,
      type: "frequency-domain",
    })!;

    const first = resolveModeFieldOverlayResource(intent, {
      data: metadata,
      error: null,
      revision: resolveModeFieldOverlayMetadataRevision(intent, metadata),
      status: "ready",
    });
    const next = resolveModeFieldOverlayResource(nextIntent, {
      data: metadata,
      error: null,
      revision: resolveModeFieldOverlayMetadataRevision(nextIntent, metadata),
      status: "ready",
    });

    expect(first.metadata?.resourceRevision).toContain("sha256:artifact-v1");
    expect(next.metadata?.resourceRevision).toContain("sha256:artifact-v2");
    expect(next.metadata?.resourceRevision).not.toBe(first.metadata?.resourceRevision);
  });

  it("changes the field build revision when payload content changes at the same artifact revision and path", () => {
    const first = resolveModeFieldOverlayMetadataRevision(intent, {
      ...metadata,
      content_digest: "sha256:field-v1",
      revision: "sha256:field-v1",
    });
    const next = resolveModeFieldOverlayMetadataRevision(intent, {
      ...metadata,
      content_digest: "sha256:field-v2",
      revision: "sha256:field-v2",
    });

    expect(next).not.toBe(first);
    expect(next).toContain("sha256:field-v2");
  });

  it("invalidates the metadata revision when committed artifact generation changes", () => {
    const first = resolveModeFieldOverlayMetadataRevision(intent, {
      ...metadata,
      generation_id: "publication-14",
      generation_status: "member_verified_owner_bound",
    });
    const next = resolveModeFieldOverlayMetadataRevision(intent, {
      ...metadata,
      generation_id: "publication-15",
      generation_status: "member_verified_owner_bound",
    });

    expect(next).not.toBe(first);
    expect(next).toContain("publication-15");
  });
});

const gateTopology = {
  domainGenerationId: "domain-v7", meshTopologyHash: "topology-v4",
  meshTopologyRevision: "4", pointCount: 2,
};
function gateBinary(): DecodedFieldVector {
  return {
    dtype: "float64", domainGenerationId: "domain-v7", formatVersion: 3,
    grid: [1, 1, 2], indexing: "full_domain", meshTopologyHash: "topology-v4",
    meshTopologyRevision: "4", nComp: 6, pointCount: 2, quantityId: intent.fieldId,
    valueCount: 12, values: new Float64Array(12).fill(0.25),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("owned eigen mode metadata loader", () => {
  it("changes cache identity when only the expected equilibrium changes", () => {
    expect(resolveModeFieldOverlayMetadataRevision({ ...intent, equilibriumId: "sha256:eq-next" }, metadata))
      .not.toBe(resolveModeFieldOverlayMetadataRevision(intent, metadata));
  });

  it("drops an aborted metadata completion before requesting binary", async () => {
    const pending = deferred<FrequencyDomainFieldResource>();
    const api = {
      eigenMode: vi.fn(async () => ownedArtifact()),
      eigenModeFieldMeta: vi.fn(() => pending.promise),
    };
    const binary = vi.fn(async () => gateBinary());
    const controller = new ModeFieldOverlayIntentController();
    const activation = controller.activate(intent, {
      loadMetadata: (activeIntent, signal) => loadEigenModeFieldOverlayMetadata(api, activeIntent, "scope", signal),
      loadBinary: binary,
    }, gateTopology);
    await Promise.resolve();
    await Promise.resolve();
    expect(api.eigenModeFieldMeta).toHaveBeenCalledTimes(1);
    controller.clear();
    pending.resolve(metadata);
    await expect(activation).resolves.toBe("cancelled");
    expect(binary).not.toHaveBeenCalled();
  });

  it("loads owned mode JSON before metadata with the same session scope and abort signal", async () => {
    const calls: string[] = [];
    const api = {
      eigenMode: vi.fn(async () => { calls.push("mode"); return ownedArtifact(); }),
      eigenModeFieldMeta: vi.fn(async () => { calls.push("meta"); return metadata; }),
    };
    const abort = new AbortController();
    const loaded = await loadEigenModeFieldOverlayMetadata(api, intent, "scope-1", abort.signal);
    expect(calls).toEqual(["mode", "meta"]);
    const options = { sessionScopeKey: "scope-1", signal: abort.signal };
    expect(api.eigenMode).toHaveBeenCalledWith(0, 1, options);
    expect(api.eigenModeFieldMeta).toHaveBeenCalledWith(0, 1, options);
    expect(loaded.revision).toContain("sha256:mode-json-v1");
    expect(loaded.revision).toContain("sha256:eq-k0");
  });

  it.each([
    ["foreign run", { ...ownedArtifact(), run_id: "foreign" }],
    ["foreign stage", { ...ownedArtifact(), stage_id: "foreign" }],
    ["foreign equilibrium", ownedArtifact("sha256:other-equilibrium")],
    ["missing mode generation", { ...ownedArtifact(), generation_id: null }],
    ["unbound mode", { ...ownedArtifact(), generation_status: "member_verified_unbound" }],
  ])("never requests metadata or binary for %s", async (_label, artifact) => {
    const api = {
      eigenMode: vi.fn(async () => artifact as FrequencyDomainJsonArtifactResource),
      eigenModeFieldMeta: vi.fn(async () => metadata),
    };
    const binary = vi.fn(async () => gateBinary());
    const controller = new ModeFieldOverlayIntentController();
    await expect(controller.activate(intent, {
      loadMetadata: (activeIntent, signal) => loadEigenModeFieldOverlayMetadata(api, activeIntent, "scope", signal),
      loadBinary: binary,
    }, gateTopology)).resolves.toBe("error");
    expect(api.eigenModeFieldMeta).not.toHaveBeenCalled();
    expect(binary).not.toHaveBeenCalled();
  });

  it.each([
    ["different generation", { ...metadata, generation_id: "publication-other" }],
    ["missing generation", { ...metadata, generation_id: null }],
    ["unbound generation", { ...metadata, generation_status: "member_verified_unbound" }],
  ])("never requests binary for metadata with %s", async (_label, data) => {
    const api = {
      eigenMode: vi.fn(async () => ownedArtifact()),
      eigenModeFieldMeta: vi.fn(async () => data as FrequencyDomainFieldResource),
    };
    const binary = vi.fn(async () => gateBinary());
    const controller = new ModeFieldOverlayIntentController();
    await expect(controller.activate(intent, {
      loadMetadata: (activeIntent, signal) => loadEigenModeFieldOverlayMetadata(api, activeIntent, "scope", signal),
      loadBinary: binary,
    }, gateTopology)).resolves.toBe("error");
    expect(binary).not.toHaveBeenCalled();
  });

  it("does not request metadata after an aborted mode JSON completion", async () => {
    const pending = deferred<FrequencyDomainJsonArtifactResource>();
    const api = {
      eigenMode: vi.fn(() => pending.promise),
      eigenModeFieldMeta: vi.fn(async () => metadata),
    };
    const binary = vi.fn(async () => gateBinary());
    const controller = new ModeFieldOverlayIntentController();
    const activation = controller.activate(intent, {
      loadMetadata: (activeIntent, signal) => loadEigenModeFieldOverlayMetadata(api, activeIntent, "scope", signal),
      loadBinary: binary,
    }, gateTopology);
    controller.clear();
    pending.resolve(ownedArtifact());
    await expect(activation).resolves.toBe("cancelled");
    expect(api.eigenModeFieldMeta).not.toHaveBeenCalled();
    expect(binary).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toBe("idle");
  });

  it("drops a superseded equilibrium request before it can request metadata", async () => {
    const pending = deferred<FrequencyDomainJsonArtifactResource>();
    const api = {
      eigenMode: vi.fn().mockImplementationOnce(() => pending.promise)
        .mockResolvedValueOnce(ownedArtifact("sha256:eq-next")),
      eigenModeFieldMeta: vi.fn(async () => metadata),
    };
    const binary = vi.fn(async () => gateBinary());
    const controller = new ModeFieldOverlayIntentController();
    const loaders = {
      loadMetadata: (activeIntent: typeof intent, signal: AbortSignal) =>
        loadEigenModeFieldOverlayMetadata(api, activeIntent, "scope", signal),
      loadBinary: binary,
    };
    const first = controller.activate(intent, loaders, gateTopology);
    const next = { ...intent, equilibriumId: "sha256:eq-next" };
    await expect(controller.activate(next, loaders, gateTopology)).resolves.toBe("ready");
    pending.resolve(ownedArtifact());
    await expect(first).resolves.toBe("cancelled");
    expect(api.eigenModeFieldMeta).toHaveBeenCalledTimes(1);
    expect(binary).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().intent?.equilibriumId).toBe("sha256:eq-next");
  });

  it("keeps a missing mode proof fail-closed in the standalone resource gate", () => {
    expect(resolveModeFieldOverlayResourceGate(intent, {
      data: metadata, error: null, revision: "field-v1", status: "ready",
    })).toMatchObject({ status: "error", binaryResourceKey: null });
  });
});
