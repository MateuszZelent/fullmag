import type { StudyResultCompletion, StudyResultGridGeometry, StudyResultInitialState, StudyResultScalarWindow, StudyResultSeriesIdentity, StudyResultStateResource, StudyStageResult } from "./apiTypes";
import type { DecodedFieldVector } from "./codecs/types";

export const MAX_STUDY_RESULT_BYTES = 256 * 1024 * 1024;
const digest = (value: string) => value.replace(/^sha256:/, "");

export function studyResultCacheKey(result: StudyStageResult): string {
  const source = result.source;
  return JSON.stringify([result.project_id, source.run_id, source.task_id, source.step_id,
    source.case_id, source.attempt_id, source.ownership_epoch, result.artifact_id, digest(result.artifact_sha256)]);
}

export function studyResultCompletionLabel(completion: StudyResultCompletion | undefined): string {
  if (!completion) return "Completion details unavailable";
  switch (completion.reason) {
    case "torque": return "Converged by torque tolerance";
    case "energy": return "Converged by energy tolerance";
    case "max_steps": return "Step limit reached";
    case "max_pseudotime": return "Pseudotime limit reached";
    case "max_physical_time": return "Time limit reached";
    case "gradient": return "Numerical resolution limit reached";
    case "user_cancelled": return "Cancelled";
    case "backend_error": return "Solver error";
    default:
      if (completion.metric_name === "all_active_dofs_frozen_relaxation") return "All active spins were frozen";
      if (completion.converged === false) return "Finished without convergence";
      return "Completed";
  }
}

export function studyResultDomainLabel(relation: StudyStageResult["domain_relation"]): string {
  switch (relation) {
    case "matching_published_layout": return "Matches the current published layout";
    case "different_published_layout": return "Differs from the current published layout";
    default: return "Published layout comparison unavailable";
  }
}

export function studyResultPredecessorLabel(
  result: Pick<StudyStageResult, "initial_state" | "predecessor_relation">,
): string | null {
  const source = result.initial_state?.source;
  if (source?.kind !== "stage_result" || source.selection !== "predecessor") return null;
  switch (result.predecessor_relation) {
    case "newer_different_output": return "The predecessor has a newer, different saved output from the same input";
    case "earlier_predecessor_changed": return "An earlier predecessor has a newer, different saved output from the same input";
    case "newer_same_output": return "The predecessor saved the same output again";
    case "no_later_matching_input": return "No later matching result in the inherited chain";
    default: return "Predecessor comparison unavailable";
  }
}

export function studyResultInitialStateLabel(initialState: StudyResultInitialState | undefined): string {
  if (!initialState) return "Initial state evidence unavailable";
  const { source, reset_scopes } = initialState;
  if (source.kind === "authored") return "Authored magnetization";
  if (source.kind === "prepared") return `Prepared magnetization · ${source.publication_id}`;
  const labels = {
    predecessor: "Predecessor result",
    selected_result: "Selected result",
    latest_compatible: "Latest compatible result at start",
    pinned_result: "Pinned result",
  };
  const reset = reset_scopes.length ? " · with an authored reset" : "";
  return `${labels[source.selection]} · ${source.step_id} · ${source.run_id}${reset}`;
}

function sameSeries(left: StudyResultSeriesIdentity, right: StudyResultSeriesIdentity): boolean {
  return left.run_id === right.run_id && left.task_id === right.task_id &&
    left.step_id === right.step_id && left.case_id === right.case_id &&
    left.attempt_id === right.attempt_id && left.ownership_epoch === right.ownership_epoch;
}

function gridCount(grid: StudyResultGridGeometry): number {
  if (grid.grid_cells.length !== 3 || grid.cell_size_m.length !== 3 || grid.origin_m.length !== 3 ||
      grid.grid_cells.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      grid.cell_size_m.some((value) => !Number.isFinite(value) || value <= 0) ||
      grid.origin_m.some((value) => !Number.isFinite(value))) {
    throw new Error("Saved Study grid geometry is invalid.");
  }
  return grid.grid_cells.reduce((product, value) => product * value, 1);
}

export function validateStudyResultState(state: StudyResultStateResource, selected: StudyStageResult) {
  if (state.project_id !== selected.project_id || state.artifact_id !== selected.artifact_id ||
      !sameSeries(state.source, selected.source) ||
      !/^[a-f0-9]{64}$/.test(digest(state.artifact_sha256)) ||
      digest(state.artifact_sha256) !== digest(selected.artifact_sha256) ||
      !/^[a-f0-9]{64}$/.test(digest(state.domain_generation_id)) ||
      !/^[a-f0-9]{64}$/.test(digest(state.topology_fingerprint)) ||
      !Number.isSafeInteger(state.step) || state.step < 0 ||
      !Number.isFinite(state.time_s) || state.time_s < 0 ||
      !Number.isSafeInteger(state.sample_count) || state.sample_count <= 0 ||
      state.sample_count * 24 > MAX_STUDY_RESULT_BYTES) {
    throw new Error("Saved Study state differs from the selected result.");
  }
  const geometry = state.geometry;
  let count: number;
  switch (geometry.kind) {
    case "fdm":
      count = gridCount(geometry);
      break;
    case "fdm_multilayer":
      count = 0;
      for (const layer of geometry.layers) {
        if (layer.value_offset !== count || layer.value_count !== gridCount(layer)) {
          throw new Error("Saved Study layer offsets differ from the magnetization order.");
        }
        count += layer.value_count;
      }
      break;
    case "fem":
      if (!Number.isSafeInteger(geometry.element_count) || geometry.element_count <= 0 || !state.support_available) {
        throw new Error("Saved FEM state is missing qualified topology or magnetic support.");
      }
      count = geometry.node_count;
      break;
    default:
      throw new Error("Saved Study result uses an unsupported spatial layout.");
  }
  if (count !== state.sample_count) {
    throw new Error("Saved Study geometry does not match its sample count.");
  }
  return state;
}

export function verifyStudyResultBinary(headers: Headers, state: StudyResultStateResource): void {
  if (headers.get("x-fullmag-source-id") !== state.artifact_id ||
      digest(headers.get("x-fullmag-field-generation-id") ?? "") !== digest(state.artifact_sha256) ||
      headers.get("x-fullmag-domain-generation-id") !== state.domain_generation_id ||
      digest(headers.get("x-fullmag-mesh-topology-hash") ?? "") !== digest(state.topology_fingerprint)) {
    throw new Error("Saved Study binary belongs to a different result or domain.");
  }
}

export function validateStudyResultMagnetization(field: DecodedFieldVector, state: StudyResultStateResource): Float64Array {
  const expectedGrid = state.geometry.kind === "fdm" ? state.geometry.grid_cells : [state.sample_count, 1, 1];
  if (field.formatVersion !== 3 || field.dtype !== "float64" || field.quantityId !== "m" ||
      field.indexing !== "full_domain" || field.scopeKind !== "full" ||
      field.domainGenerationId !== state.domain_generation_id ||
      digest(field.meshTopologyHash ?? "") !== digest(state.topology_fingerprint) ||
      field.nComp !== 3 || field.pointCount !== state.sample_count ||
      field.grid.some((extent, axis) => extent !== expectedGrid[axis]) ||
      field.values.some((value) => !Number.isFinite(value))) {
    throw new Error("Saved Study magnetization differs from its pinned layout.");
  }
  return field.values;
}

export function validateStudyResultScalars(window: StudyResultScalarWindow, result: StudyStageResult) {
  if (!sameSeries(window.series, result.source)) {
    throw new Error("Saved scalar samples belong to a different Study attempt.");
  }
  return window;
}
