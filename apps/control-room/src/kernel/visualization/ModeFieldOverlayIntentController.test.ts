import { describe, expect, it, vi } from "vitest";

import type { FrequencyDomainFieldResource } from "../api/apiTypes";
import type { DecodedFieldVector } from "../api/codecs";

import { createModeFieldOverlayIntent } from "./ModeFieldOverlayIntent";
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
});

const topology = {
  domainGenerationId: "domain-v7",
  meshTopologyHash: "topology-hash-v4",
  meshTopologyRevision: "topology-v4",
  pointCount: 1,
};
