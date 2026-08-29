import type { SelectionRef } from "@/kernel/selection/selectionTypes";

import type {
  ResultsNavigatorNode,
  ResultsNavigatorNodeKind,
} from "./resultsNavigatorTypes";

/**
 * Stable identity for one published modal mode.
 *
 * Display indexes are deliberately optional metadata. They may change when a
 * server artifact is re-ordered and therefore never participate in node or
 * cache identity.
 */
export interface ModalSelectionRef {
  artifactRevision: string;
  branchId?: string;
  kind: "modal-mode";
  modeId: string;
  rawModeIndex?: number;
  runId: string;
  sampleId: string;
  sampleIndex?: number;
  stageId: string;
}

/** Stable identity for one published driven-response frequency point. */
export interface ResponseSelectionRef {
  artifactRevision: string;
  frequencyIndex?: number;
  kind: "response-point";
  observableId?: string;
  pointId: string;
  runId: string;
  stageId: string;
}

export interface ModalDetailSelectionRef extends Omit<ModalSelectionRef, "kind"> {
  detail: "field" | "metadata" | "residuals";
  kind: "modal-detail";
}

export interface ResponseDetailSelectionRef extends Omit<ResponseSelectionRef, "kind"> {
  detail: "field" | "observables";
  kind: "response-detail";
}

export interface BranchSelectionRef {
  artifactRevision: string;
  branchId: string;
  kind: "eigen-branch";
  runId: string;
  stageId: string;
}

export interface FmrResonanceFitSelectionRef {
  artifactRevision: string;
  fitId: string;
  kind: "fmr-resonance-fit";
  runId: string;
  stageId: string;
}

export interface ResultsViewSelectionRef {
  artifactRevision: string;
  kind: "results-view";
  runId: string;
  stageId: string;
  viewId: "branches" | "field-sweep" | "response-sweep" | "spectrum";
}

export type ResultsSelectionRef =
  | BranchSelectionRef
  | FmrResonanceFitSelectionRef
  | ModalDetailSelectionRef
  | ModalSelectionRef
  | ResponseDetailSelectionRef
  | ResponseSelectionRef
  | ResultsViewSelectionRef;

export const RESULTS_NAVIGATOR_INSPECTOR_IDS = {
  "results.root": "results.frequency_domain.root",
  "results.runs": "results.frequency_domain.root",
  "results.run": "results.frequency_domain.run",
  "results.stage": "jobs.frequency_domain.stage_run",
  "results.frequency-domain": "results.frequency_domain.root",
  "results.frequency-domain.overview": "results.frequency_domain.root",
  "results.frequency-domain.modal-eigen": "results.eigen.root",
  "results.frequency-domain.spectrum": "results.eigen.spectrum",
  "results.frequency-domain.field-sweep": "results.eigen.field_sweep",
  "results.frequency-domain.dispersion": "results.eigen.dispersion",
  "results.frequency-domain.samples": "results.eigen.samples",
  "results.frequency-domain.sample": "results.eigen.sample",
  "results.frequency-domain.modes": "results.eigen.modes",
  "results.frequency-domain.mode": "results.eigen.mode",
  "results.frequency-domain.mode-metadata": "results.eigen.mode_metadata",
  "results.frequency-domain.mode-field": "results.eigen.mode_field",
  "results.frequency-domain.mode-residuals": "results.eigen.mode_residuals",
  "results.frequency-domain.branches": "results.eigen.branches",
  "results.frequency-domain.branch": "results.eigen.branch",
  "results.frequency-domain.driven-response": "results.frequency_response.root",
  "results.frequency-domain.frequency-sweep": "results.frequency_response.sweep",
  "results.frequency-domain.frequency-points": "results.frequency_response.frequency_points",
  "results.frequency-domain.response-point": "results.frequency_response.frequency_point",
  "results.frequency-domain.response-observables": "results.frequency_response.observables",
  "results.frequency-domain.response-field": "resources.analysis.frequency_response.field",
  "results.frequency-domain.progress": "results.frequency_response.progress",
  "results.frequency-domain.response-diagnostics": "results.frequency_response.diagnostics",
  "results.frequency-domain.fmr-views": "results.frequency_domain.fmr",
  "results.frequency-domain.modal-resonances": "results.frequency_domain.fmr_modal_spectrum",
  "results.frequency-domain.driven-sweep": "results.frequency_domain.fmr_response_sweep",
  "results.frequency-domain.peaks": "results.frequency_domain.fmr_peaks",
  "results.frequency-domain.peak": "results.frequency_domain.fmr_peak",
  "results.frequency-domain.resonance-fits": "results.frequency_domain.fmr_resonance_fits",
  "results.frequency-domain.resonance-fit": "results.frequency_domain.fmr_resonance_fit",
  "results.frequency-domain.kittel-fit": "results.frequency_domain.fmr_kittel_fit",
  "results.frequency-domain.field-frequency-map": "results.frequency_domain.response_map",
  "results.frequency-domain.modal-driven-comparison": "results.frequency_domain.comparison",
  "results.frequency-domain.validation": "results.eigen.provenance",
  "results.frequency-domain.validation-child": "results.eigen.provenance",
  "results.frequency-domain.artifacts": "results.frequency_domain.exports",
} satisfies Record<ResultsNavigatorNodeKind, string>;

export type ResultsNavigatorInspectorId =
  (typeof RESULTS_NAVIGATOR_INSPECTOR_IDS)[ResultsNavigatorNodeKind];

/**
 * Existing inspector panels use the long-lived dotted selection vocabulary.
 * Results Navigator node kinds stay module-local and are translated only at
 * the kernel boundary so the tree can evolve without breaking inspector
 * dispatch.
 */
export function inspectorSelectionKindForResultsNodeKind(
  kind: ResultsNavigatorNodeKind,
): ResultsNavigatorInspectorId {
  return RESULTS_NAVIGATOR_INSPECTOR_IDS[kind];
}

type ModalSelectionInput = Omit<ModalSelectionRef, "kind">;
type ResponseSelectionInput = Omit<ResponseSelectionRef, "kind">;

export function modalSelectionRef(input: ModalSelectionInput): ModalSelectionRef {
  return { kind: "modal-mode", ...input };
}

export function responseSelectionRef(
  input: ResponseSelectionInput,
): ResponseSelectionRef {
  return { kind: "response-point", ...input };
}

export function modalDetailSelectionRef(
  input: Omit<ModalDetailSelectionRef, "kind">,
): ModalDetailSelectionRef {
  return { ...input, kind: "modal-detail" };
}

export function responseDetailSelectionRef(
  input: Omit<ResponseDetailSelectionRef, "kind">,
): ResponseDetailSelectionRef {
  return { ...input, kind: "response-detail" };
}

export function branchSelectionRef(
  input: Omit<BranchSelectionRef, "kind">,
): BranchSelectionRef {
  return { ...input, kind: "eigen-branch" };
}

export function fmrResonanceFitSelectionRef(
  input: Omit<FmrResonanceFitSelectionRef, "kind">,
): FmrResonanceFitSelectionRef {
  return { ...input, kind: "fmr-resonance-fit" };
}

export function resultsViewSelectionRef(
  input: Omit<ResultsViewSelectionRef, "kind">,
): ResultsViewSelectionRef {
  return { ...input, kind: "results-view" };
}

function idSegment(value: string): string {
  return encodeURIComponent(value);
}

export function buildModalNodeId(ref: ModalSelectionRef): string {
  return [
    "results",
    "run",
    idSegment(ref.runId),
    "stage",
    idSegment(ref.stageId),
    "dynamics",
    "eigen",
    "sample",
    idSegment(ref.sampleId),
    "mode",
    idSegment(ref.modeId),
  ].join(":");
}

export function buildResponsePointNodeId(ref: ResponseSelectionRef): string {
  return [
    "results",
    "run",
    idSegment(ref.runId),
    "stage",
    idSegment(ref.stageId),
    "frequency-domain",
    "response",
    "point",
    idSegment(ref.pointId),
  ].join(":");
}

/** Compare only published identity; display indexes are intentionally ignored. */
export function resultsSelectionRefEquals(
  left: ResultsSelectionRef | null | undefined,
  right: ResultsSelectionRef | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (
    (left.kind === "modal-mode" || left.kind === "modal-detail") &&
    (right.kind === "modal-mode" || right.kind === "modal-detail")
  ) {
    return (
      left.kind === right.kind &&
      left.runId === right.runId &&
      left.stageId === right.stageId &&
      left.artifactRevision === right.artifactRevision &&
      left.sampleId === right.sampleId &&
      left.modeId === right.modeId &&
      (left.branchId ?? null) === (right.branchId ?? null) &&
      (left.kind !== "modal-detail" ||
        (right.kind === "modal-detail" && left.detail === right.detail))
    );
  }
  if (
    (left.kind === "response-point" || left.kind === "response-detail") &&
    (right.kind === "response-point" || right.kind === "response-detail")
  ) {
    return (
      left.kind === right.kind &&
      left.runId === right.runId &&
      left.stageId === right.stageId &&
      left.artifactRevision === right.artifactRevision &&
      left.pointId === right.pointId &&
      (left.observableId ?? null) === (right.observableId ?? null) &&
      (left.kind !== "response-detail" ||
        (right.kind === "response-detail" && left.detail === right.detail))
    );
  }
  if (left.kind === "eigen-branch" && right.kind === "eigen-branch") {
    return left.runId === right.runId && left.stageId === right.stageId &&
      left.artifactRevision === right.artifactRevision && left.branchId === right.branchId;
  }
  if (left.kind === "fmr-resonance-fit" && right.kind === "fmr-resonance-fit") {
    return left.runId === right.runId && left.stageId === right.stageId &&
      left.artifactRevision === right.artifactRevision && left.fitId === right.fitId;
  }
  return left.kind === "results-view" && right.kind === "results-view" &&
    left.runId === right.runId && left.stageId === right.stageId &&
    left.artifactRevision === right.artifactRevision && left.viewId === right.viewId;
}

/**
 * Compatibility handoff for the current kernel selection union.
 * The Results Navigator keeps the stable ref as its source of truth; this
 * adapter only exposes fields understood by today's Inspector/viewport.
 */
export function toKernelFrequencyDomainSelectionRef(
  ref: ResultsSelectionRef,
  nodeId: string,
  kind: string,
): Extract<SelectionRef, { type: "frequency-domain" }> {
  if (ref.kind === "modal-mode" || ref.kind === "modal-detail") {
    return {
      artifactRevision: ref.artifactRevision,
      analysisRunId: ref.runId,
      analysisStageId: ref.stageId,
      branchId: ref.branchId,
      kind,
      modeId: ref.modeId,
      modeIndex: ref.rawModeIndex,
      nodeId,
      rawModeIndex: ref.rawModeIndex,
      resourceRef: ref.artifactRevision,
      sampleId: ref.sampleId,
      sampleIndex: ref.sampleIndex,
      ...(ref.kind === "modal-detail" ? { detail: ref.detail } : {}),
      type: "frequency-domain",
    };
  }
  if (ref.kind === "response-point" || ref.kind === "response-detail") {
    return {
      artifactRevision: ref.artifactRevision,
      analysisRunId: ref.runId,
      analysisStageId: ref.stageId,
      frequencyIndex: ref.frequencyIndex,
      kind,
      nodeId,
      observableId: ref.observableId,
      pointId: ref.pointId,
      resourceRef: ref.artifactRevision,
      ...(ref.kind === "response-detail" ? { detail: ref.detail } : {}),
      type: "frequency-domain",
    };
  }
  return {
    artifactRevision: ref.artifactRevision,
    analysisRunId: ref.runId,
    analysisStageId: ref.stageId,
    kind,
    nodeId,
    resourceRef: ref.artifactRevision,
    ...(ref.kind === "eigen-branch" ? { branchId: ref.branchId } : {}),
    ...(ref.kind === "fmr-resonance-fit" ? { fitId: ref.fitId } : {}),
    ...(ref.kind === "results-view" ? { viewId: ref.viewId } : {}),
    type: "frequency-domain",
  };
}

/** Build a selection for semantic result nodes that have no item-level ref. */
export function toKernelFrequencyDomainNodeSelectionRef(
  kind: ResultsNavigatorNodeKind,
  nodeId: string,
  resourceRef: string,
): Extract<SelectionRef, { type: "frequency-domain" }> {
  return {
    kind: inspectorSelectionKindForResultsNodeKind(kind),
    nodeId,
    resourceRef,
    type: "frequency-domain",
  };
}

export function kernelSelectionForResultsNavigatorNode(
  node: Pick<ResultsNavigatorNode, "id" | "kind" | "resourceKey" | "selectionRef"> &
    Partial<Pick<ResultsNavigatorNode, "resourceRevision">> &
    Partial<Pick<ResultsNavigatorNode, "inspectorId">>,
): {
  kind: string;
  ref: Extract<SelectionRef, { type: "frequency-domain" }>;
} {
  const kind = node.inspectorId ?? inspectorSelectionKindForResultsNodeKind(node.kind);
  return {
    kind,
    ref: node.selectionRef
      ? toKernelFrequencyDomainSelectionRef(node.selectionRef, node.id, kind)
      : {
          kind,
          nodeId: node.id,
          resourceRef: node.resourceKey,
          ...(node.resourceRevision ? { artifactRevision: node.resourceRevision } : {}),
          type: "frequency-domain",
        },
  };
}
