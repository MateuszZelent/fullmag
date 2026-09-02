import { describe, expect, it, vi } from "vitest";

import type {
  AnalysisResultFieldRef,
  FrequencyDomainFieldResource,
} from "../api/apiTypes";
import type { DecodedFieldVector } from "../api/codecs";
import { analysisResultSelectionRef } from "@/shared/domain/analysis/results";

import {
  createModeFieldOverlayIntent,
  type ModeFieldOverlayTopologyIdentity,
} from "./ModeFieldOverlayIntent";
import { createAnalysisResultFieldOverlayIntent } from "./AnalysisResultFieldOverlayIntent";
import { ModeFieldOverlayIntentController } from "./ModeFieldOverlayIntentController";

function intent(modeId: string, modeIndex: number) {
  return createModeFieldOverlayIntent({
    analysisRunId: "run-k0",
    analysisStageId: "stage-eigen",
    artifactRevision: "sha256:artifact-v1",
    fieldId: `analysis:eigen:sample-k0:${modeId}:delta_m_xyz`,
    kind: "results.eigen.mode",
    modeId,
    modeIndex,
    nodeId: `results:eigen:sample-k0:${modeId}`,
    sampleId: "sample-k0",
    sampleIndex: 0,
    type: "frequency-domain",
  })!;
}

function metadata(fieldId: string): FrequencyDomainFieldResource {
  return {
    artifact_path: "eigen/modes/sample_0000_mode_0001.field.v1.json",
    available_views: ["complex", "real", "imag", "abs", "amplitude", "phase", "phase_rotated_real"],
    binary_layout: "complex_f64_pairs_little_endian",
    complex_pair_count: 3,
    component_basis: "global_xyz",
    component_count: 3,
    components: ["x", "y", "z"],
    default_phase_rad: 0,
    default_view: "phase_rotated_real",
    field_id: fieldId,
    payload_encoding: "f64_interleaved_real_imag_xyz",
    payload_value_count: 6,
    quantity: "delta_m",
    resource_key: `data/fields/${encodeURIComponent(fieldId)}`,
    schema_version: "frequency_domain_mode_field.v1",
    source_family: "analysis/eigen",
    status: "ready",
    value_kind: "complex_spatial_vector",
  };
}

function binary(fieldId: string): DecodedFieldVector {
  return {
    dtype: "float64",
    domainGenerationId: "domain-v7",
    formatVersion: 3,
    grid: [1, 1, 1],
    indexing: "full_domain",
    meshTopologyHash: "topology-hash-v4",
    meshTopologyRevision: "topology-v4",
    nComp: 6,
    pointCount: 1,
    quantityId: fieldId,
    valueCount: 6,
    values: new Float64Array(6).fill(1),
  };
}

const resultFieldRef: AnalysisResultFieldRef = {
  field_id: "analysis:eigen:sample-result:mode-result",
  field_revision: "sha256:result-field-v1",
  mesh_ref: {
    mesh_id: "mesh:result",
    mesh_revision: "mesh-revision-1",
    topology_fingerprint: "sha256:result-topology-v1",
  },
  quantity_id: "m",
  representation: "complex-vector-xyz",
  resource_key: "data/fields/analysis-result-mode",
  status: "ready",
};

function resultIntent() {
  return createAnalysisResultFieldOverlayIntent(
    analysisResultSelectionRef({
      datasetId: "result:dataset",
      datasetRevision: "sha256:dataset-v1",
      fieldId: resultFieldRef.field_id,
      fieldRef: resultFieldRef,
      fieldRevision: resultFieldRef.field_revision,
      focus: "item",
      itemId: "mode-result",
      itemKind: "eigen_mode",
      runId: "run-result",
      sampleId: "sample-result",
      stageId: "stage-result",
    }),
  )!;
}

function resultBinary(fieldId: string): DecodedFieldVector {
  return {
    ...binary(fieldId),
    domainGenerationId: "result-generation",
    grid: [1, 1, 1],
    meshTopologyHash: "sha256:result-topology-v1",
    meshTopologyRevision: "mesh-revision-1",
    quantityId: fieldId,
  };
}

describe("ModeFieldOverlayIntentController", () => {
  it("aborts and ignores a late mode completion after a newer intent supersedes it", async () => {
    const controller = new ModeFieldOverlayIntentController();
    const first = intent("mode-1", 1);
    const second = intent("mode-2", 2);
    let finishFirst: ((value: { data: FrequencyDomainFieldResource; revision: string }) => void) | undefined;
    const firstMetadata = vi.fn(
      (_intent: typeof first, signal: AbortSignal) =>
        new Promise<{ data: FrequencyDomainFieldResource; revision: string }>((resolve) => {
          signal.addEventListener("abort", () => undefined);
          finishFirst = resolve;
        }),
    );

    const firstRun = controller.activate(first, {
      loadBinary: async (resolved) => binary(resolved.fieldId),
      loadMetadata: firstMetadata,
    }, topology);
    const secondRun = controller.activate(second, {
      loadBinary: async (resolved) => binary(resolved.fieldId),
      loadMetadata: async (next) => ({
        data: metadata(next.fieldId),
        revision: "sha256:field-v1",
      }),
    }, topology);

    finishFirst!({ data: metadata(first.fieldId), revision: "sha256:field-v1" });
    await firstRun;
    await secondRun;

    expect(firstMetadata.mock.calls[0]?.[1].aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      intent: second,
      status: "ready",
    });
  });

  it("aborts an in-flight binary load on clear and never publishes its late payload", async () => {
    const controller = new ModeFieldOverlayIntentController();
    const active = intent("mode-1", 1);
    let finishBinary: ((value: DecodedFieldVector) => void) | undefined;
    let binarySignal: AbortSignal | undefined;

    const run = controller.activate(active, {
      loadMetadata: async (next) => ({
        data: metadata(next.fieldId),
        revision: "sha256:field-v1",
      }),
      loadBinary: (_resolved, signal) =>
        new Promise<DecodedFieldVector>((resolve) => {
          binarySignal = signal;
          finishBinary = resolve;
        }),
    }, topology);
    await vi.waitFor(() => expect(binarySignal).toBeDefined());

    controller.clear();
    finishBinary!(binary(active.fieldId));

    await expect(run).resolves.toBe("cancelled");
    expect(binarySignal?.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ field: null, status: "idle" });
  });

  it("loads a typed result field through the shared topology gate", async () => {
    const controller = new ModeFieldOverlayIntentController();
    const active = resultIntent();
    expect(active.sourceKind).toBe("analysis-result");
    if (active.sourceKind !== "analysis-result") {
      throw new Error("Expected an analysis-result overlay intent");
    }
    const resultTopology: ModeFieldOverlayTopologyIdentity = {
      domainGenerationId: "result-generation",
      meshId: "mesh:result",
      meshTopologyHash: "sha256:result-topology-v1",
      meshTopologyRevision: "mesh-revision-1",
      pointCount: 1,
    };

    await expect(
      controller.activate(
        active,
        {
          loadMetadata: async () => ({
            data: active.fieldRef,
            revision: active.fieldRevision,
          }),
          loadBinary: async (metadata) => resultBinary(metadata.fieldId),
        },
        resultTopology,
      ),
    ).resolves.toBe("ready");
    expect(controller.getSnapshot()).toMatchObject({
      intent: active,
      metadata: { fieldId: resultFieldRef.field_id },
      status: "ready",
    });
  });
});

const topology = {
  domainGenerationId: "domain-v7",
  meshTopologyHash: "topology-hash-v4",
  meshTopologyRevision: "topology-v4",
  pointCount: 1,
};
