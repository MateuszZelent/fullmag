import { describe, expect, it } from "vitest";
import type { StudyResultStateResource, StudyStageResult } from "./apiTypes";
import { studyResultCompletionLabel, studyResultDomainLabel, studyResultInitialStateLabel, studyResultPredecessorLabel, validateStudyResultMagnetization, validateStudyResultState, verifyStudyResultBinary } from "./studyResultPlayback";

const result: StudyStageResult = {
  project_id: "project", study_id: "study", artifact_id: "final", artifact_sha256: "a".repeat(64),
  source: { run_id: "old", task_id: "task", step_id: "relax", case_id: "default", attempt_id: "attempt", ownership_epoch: 2 },
  codec_id: "state", codec_version: "1", accepted_at: "", authored_relation: "authored_input_changed",
  supports_magnetization_input: true,
};
const state: StudyResultStateResource = {
  ...result, step: 4, time_s: 1e-9, sample_count: 1, domain_generation_id: "b".repeat(64),
  topology_fingerprint: `sha256:${"c".repeat(64)}`,
  geometry: { kind: "fdm", grid_cells: [1, 1, 1], origin_m: [0, 0, 0], cell_size_m: [1e-9, 1e-9, 1e-9] },
  support_available: false,
};

describe("project-owned saved Study playback", () => {
  it("distinguishes solver convergence, step exhaustion and missing evidence", () => {
    expect(studyResultCompletionLabel({ converged: true, reason: "torque" })).toBe("Converged by torque tolerance");
    expect(studyResultCompletionLabel({ converged: false, reason: "max_steps" })).toBe("Step limit reached");
    expect(studyResultCompletionLabel(undefined)).toBe("Completion details unavailable");
    expect(studyResultCompletionLabel({})).toBe("Completed");
  });

  it("distinguishes the published layout comparison from missing evidence", () => {
    expect(studyResultDomainLabel("matching_published_layout")).toBe("Matches the current published layout");
    expect(studyResultDomainLabel("different_published_layout")).toBe("Differs from the current published layout");
    expect(studyResultDomainLabel("unavailable")).toBe("Published layout comparison unavailable");
    expect(studyResultDomainLabel(undefined)).toBe("Published layout comparison unavailable");
  });

  it("reports later predecessor outputs only for an inherited input", () => {
    const source = {
      kind: "stage_result", run_id: "run-a", step_id: "relax-a", case_id: "default",
      artifact_id: "state-a", content_sha256: "a".repeat(64), selection: "predecessor",
    } as const;
    const initial_state = { source, reset_scopes: [] };
    expect(studyResultPredecessorLabel({ initial_state, predecessor_relation: "newer_different_output" }))
      .toBe("The predecessor has a newer, different saved output from the same input");
    expect(studyResultPredecessorLabel({ initial_state, predecessor_relation: "earlier_predecessor_changed" }))
      .toBe("An earlier predecessor has a newer, different saved output from the same input");
    expect(studyResultPredecessorLabel({ initial_state, predecessor_relation: "newer_same_output" }))
      .toBe("The predecessor saved the same output again");
    expect(studyResultPredecessorLabel({ initial_state, predecessor_relation: "no_later_matching_input" }))
      .toBe("No later matching result in the inherited chain");
    expect(studyResultPredecessorLabel({ initial_state })).toBe("Predecessor comparison unavailable");
    expect(studyResultPredecessorLabel({
      initial_state: { source: { ...source, selection: "selected_result" }, reset_scopes: [] },
      predecessor_relation: "newer_different_output",
    })).toBeNull();
  });

  it("distinguishes a scoped inherited input from an authored or selected state", () => {
    const source = {
      kind: "stage_result", run_id: "run-a", step_id: "relax-a", case_id: "default",
      artifact_id: "state-a", content_sha256: "a".repeat(64), selection: "predecessor",
    } as const;
    expect(studyResultInitialStateLabel({ source, reset_scopes: [{ object_id: "mag", region_id: "left" }] }))
      .toBe("Predecessor result · relax-a · run-a · with an authored reset");
    expect(studyResultInitialStateLabel({ source: { ...source, selection: "selected_result" }, reset_scopes: [] }))
      .toBe("Selected result · relax-a · run-a");
    expect(studyResultInitialStateLabel({ source: { kind: "authored", reference: "m0" }, reset_scopes: [] }))
      .toBe("Authored magnetization");
    expect(studyResultInitialStateLabel(undefined)).toBe("Initial state evidence unavailable");
  });

  it("requires the selected attempt and rejects a stale equal-size domain", () => {
    expect(validateStudyResultState(state, result)).toBe(state);
    expect(() => validateStudyResultState({ ...state, source: { ...state.source, attempt_id: "other" } }, result)).toThrow("selected result");
    const headers = new Headers({
      "x-fullmag-source-id": state.artifact_id, "x-fullmag-field-generation-id": state.artifact_sha256,
      "x-fullmag-domain-generation-id": state.domain_generation_id, "x-fullmag-mesh-topology-hash": state.topology_fingerprint,
    });
    expect(() => verifyStudyResultBinary(headers, state)).not.toThrow();
    headers.set("x-fullmag-mesh-topology-hash", "d".repeat(64));
    expect(() => verifyStudyResultBinary(headers, state)).toThrow("different result or domain");
  });

  it("validates field indexing and native layout even when the artifact header matches", () => {
    const field = {
      formatVersion: 3 as const, dtype: "float64" as const, quantityId: "m", indexing: "full_domain" as const,
      scopeKind: "full" as const, domainGenerationId: state.domain_generation_id, meshTopologyHash: "c".repeat(64),
      nComp: 3, pointCount: 1, grid: [1, 1, 1] as [number, number, number], valueCount: 3, values: new Float64Array([1, 0, 0]),
    };
    expect(validateStudyResultMagnetization(field, state)).toBe(field.values);
    expect(() => validateStudyResultMagnetization({ ...field, domainGenerationId: "d".repeat(64) }, state)).toThrow("pinned layout");
  });
});
