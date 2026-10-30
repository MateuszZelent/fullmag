import { describe, expect, it } from "vitest";

import type {
  AnalysisResultDatasetManifestResource,
  CurrentRunResource,
  FrequencyDomainManifestResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";
import { analysisResultSelectionRef } from "@/shared/domain/analysis/results";

import {
  resolveResultsNavigatorIdentity,
  resultSelectionForAnalysis,
} from "./ResultsNavigatorModule";

const manifest = {
  dataset_id: "result:run-1:stage-1:modal-eigen-field-sweep",
  dataset_revision: "dataset-revision-1",
  run_id: "run-1",
  stage_id: "stage-1",
} as AnalysisResultDatasetManifestResource;

function currentRun(
  overrides: Partial<CurrentRunResource> = {},
): CurrentRunResource {
  return {
    active_stage_index: null,
    run_id: "run-1",
    session_id: "session-1",
    ...overrides,
  } as CurrentRunResource;
}

function stageExecution(
  overrides: Partial<StageExecutionResource> = {},
): StageExecutionResource {
  return {
    active_stage_index: null,
    completed_stage_indexes: [],
    run_id: "run-1",
    session_id: "session-1",
    stages: [],
    ...overrides,
  } as StageExecutionResource;
}

function frequencyManifest({
  envelope = {},
  payload = {},
}: {
  envelope?: Record<string, unknown>;
  payload?: Record<string, unknown>;
} = {}): FrequencyDomainManifestResource {
  return {
    result_manifest: {
      artifact_path: "frequency_domain/manifest.v1.json",
      generation_id: "generation-1",
      generation_status: "member_verified_owner_bound",
      payload: {
        schema_version: "frequency_domain_manifest.v1",
        run_id: "run-1",
        session_id: "session-1",
        stage_id: "stage-result",
        ...payload,
      },
      resource_key: "/v2/sessions/current/analysis/frequency-domain/manifest.v1",
      run_id: "run-1",
      schema_version: "frequency_domain_manifest.v1",
      session_id: "session-1",
      stage_id: "stage-result",
      status: "ready",
      ...envelope,
    },
  } as unknown as FrequencyDomainManifestResource;
}

describe("resolveResultsNavigatorIdentity", () => {
  it("preserves the active stage identity", () => {
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun({ active_stage_index: 1 }),
        stageExecution: stageExecution({
          stages: [
            { index: 0, stage_id: "stage-first" },
            { index: 1, stage_id: "stage-active" },
          ] as StageExecutionResource["stages"],
        }),
        manifest: null,
      }),
    ).toEqual({ runId: "run-1", stageId: "stage-active" });
  });

  it("preserves the stage-execution active index when current run metadata has none", () => {
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun(),
        stageExecution: stageExecution({
          active_stage_index: 0,
          stages: [{ index: 0, stage_id: "stage-active" }] as StageExecutionResource["stages"],
        }),
        manifest: frequencyManifest(),
      }),
    ).toEqual({ runId: "run-1", stageId: "stage-active" });
  });

  it("uses a ready result manifest when the run has no active stage", () => {
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun(),
        stageExecution: null,
        manifest: frequencyManifest(),
      }),
    ).toEqual({ runId: "run-1", stageId: "stage-result" });
  });

  it("uses the exact payload stage when the ready envelope has no stage id", () => {
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun(),
        stageExecution: null,
        manifest: frequencyManifest({
          envelope: {
            generation_id: null,
            generation_status: "legacy_unverified",
            stage_id: null,
          },
        }),
      }),
    ).toEqual({ runId: "run-1", stageId: "stage-result" });
  });

  it("selects the artifact-bound stage when a completed run has multiple stages", () => {
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun(),
        stageExecution: stageExecution({
          completed_stage_indexes: [0, 1],
          stages: [
            { index: 0, stage_id: "stage-result", status: "completed" },
            { index: 1, stage_id: "stage-later", status: "completed" },
          ] as StageExecutionResource["stages"],
        }),
        manifest: frequencyManifest(),
      }),
    ).toEqual({ runId: "run-1", stageId: "stage-result" });
  });

  it("does not guess the last completed stage without a bound result manifest", () => {
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun(),
        stageExecution: stageExecution({
          completed_stage_indexes: [0, 1],
          stages: [
            { index: 0, stage_id: "stage-first", status: "completed" },
            { index: 1, stage_id: "stage-last", status: "completed" },
          ] as StageExecutionResource["stages"],
        }),
        manifest: null,
      }),
    ).toBeNull();
  });

  it("rejects a result manifest owned by another run or session", () => {
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun({ run_id: "run-foreign" }),
        stageExecution: null,
        manifest: frequencyManifest(),
      }),
    ).toBeNull();
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun({ session_id: "session-foreign" }),
        stageExecution: null,
        manifest: frequencyManifest(),
      }),
    ).toBeNull();
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun(),
        stageExecution: stageExecution({ run_id: "run-foreign" }),
        manifest: frequencyManifest(),
      }),
    ).toBeNull();
  });

  it("rejects contradictory envelope and payload stage ownership", () => {
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun(),
        stageExecution: null,
        manifest: frequencyManifest({
          payload: { stage_id: "stage-other" },
        }),
      }),
    ).toBeNull();
  });

  it("rejects foreign run or session identity recorded in the payload", () => {
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun(),
        stageExecution: null,
        manifest: frequencyManifest({ payload: { run_id: "run-foreign" } }),
      }),
    ).toBeNull();
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun(),
        stageExecution: null,
        manifest: frequencyManifest({ payload: { session_id: "session-foreign" } }),
      }),
    ).toBeNull();
  });

  it("rejects absent or ambiguous stage identity and non-ready artifacts", () => {
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun(),
        stageExecution: null,
        manifest: frequencyManifest({
          envelope: { stage_id: null },
          payload: { stage_id: null },
        }),
      }),
    ).toBeNull();
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun(),
        stageExecution: null,
        manifest: frequencyManifest({
          envelope: { stage_id: "stage-result" },
          payload: { stage_id: "stage-other" },
        }),
      }),
    ).toBeNull();
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun(),
        stageExecution: null,
        manifest: frequencyManifest({ envelope: { status: "missing" } }),
      }),
    ).toBeNull();
  });

  it("rejects a stage that disagrees with available stage execution", () => {
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun(),
        stageExecution: stageExecution({
          stages: [{ index: 0, stage_id: "stage-other", status: "completed" }] as StageExecutionResource["stages"],
        }),
        manifest: frequencyManifest(),
      }),
    ).toBeNull();
  });

  it("rejects duplicate stage ids in available stage execution as ambiguous", () => {
    expect(
      resolveResultsNavigatorIdentity({
        currentRun: currentRun(),
        stageExecution: stageExecution({
          stages: [
            { index: 0, stage_id: "stage-result", status: "completed" },
            { index: 1, stage_id: "stage-result", status: "completed" },
          ] as StageExecutionResource["stages"],
        }),
        manifest: frequencyManifest(),
      }),
    ).toBeNull();
  });
});

describe("resultSelectionForAnalysis", () => {
  it("selects the manifest dataset when Analysis is opened without a selection", () => {
    expect(resultSelectionForAnalysis(manifest, null)).toMatchObject({
      datasetId: manifest.dataset_id,
      datasetRevision: manifest.dataset_revision,
      focus: "dataset",
      runId: manifest.run_id,
      stageId: manifest.stage_id,
    });
  });

  it("preserves an item selection from the same immutable dataset", () => {
    const selection = analysisResultSelectionRef({
      datasetId: manifest.dataset_id,
      datasetRevision: manifest.dataset_revision,
      focus: "item",
      itemId: "sample-0007/mode-0002",
      itemKind: "eigen_mode",
      runId: manifest.run_id,
      sampleId: "bias-field-sample-0007",
      stageId: manifest.stage_id,
    });

    expect(resultSelectionForAnalysis(manifest, selection)).toBe(selection);
  });

  it("replaces a selection from another dataset with the manifest dataset", () => {
    const foreign = analysisResultSelectionRef({
      datasetId: "result:foreign",
      datasetRevision: "foreign-revision",
      focus: "item",
      itemId: "foreign-item",
      runId: "run-foreign",
      stageId: "stage-foreign",
    });

    expect(resultSelectionForAnalysis(manifest, foreign)).toMatchObject({
      datasetId: manifest.dataset_id,
      datasetRevision: manifest.dataset_revision,
      focus: "dataset",
      runId: manifest.run_id,
      stageId: manifest.stage_id,
    });
  });

  it("returns null while the manifest is unavailable", () => {
    expect(resultSelectionForAnalysis(null, null)).toBeNull();
  });
});
