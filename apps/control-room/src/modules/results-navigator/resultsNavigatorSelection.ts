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

export type ResultsSelectionRef = ModalSelectionRef | ResponseSelectionRef;

/**
 * Existing inspector panels use the long-lived dotted selection vocabulary.
 * Results Navigator node kinds stay module-local and are translated only at
 * the kernel boundary so the tree can evolve without breaking inspector
 * dispatch.
 */
export function inspectorSelectionKindForResultsNodeKind(
  kind: ResultsNavigatorNodeKind,
): string {
  switch (kind) {
    case "results.root":
    case "results.runs":
    case "results.frequency-domain":
    case "results.frequency-domain.overview":
      return "results.frequency_domain.root";
    case "results.run":
      return "results.frequency_domain.run";
    case "results.stage":
      return "jobs.frequency_domain.stage_run";
    case "results.frequency-domain.modal-eigen":
      return "results.eigen.root";
    case "results.frequency-domain.spectrum":
      return "results.eigen.spectrum";
    case "results.frequency-domain.samples":
      return "results.eigen.modes";
    case "results.frequency-domain.sample":
      return "jobs.frequency_domain.eigen_sample";
    case "results.frequency-domain.modes":
      return "results.eigen.modes";
    case "results.frequency-domain.mode":
      return "results.eigen.mode";
    case "results.frequency-domain.branches":
      return "results.eigen.branches";
    case "results.frequency-domain.branch":
      return "results.eigen.branch";
    case "results.frequency-domain.dispersion":
      return "results.eigen.dispersion";
    case "results.frequency-domain.field-sweep":
      return "results.eigen.root";
    case "results.frequency-domain.driven-response":
      return "results.frequency_response.root";
    case "results.frequency-domain.frequency-sweep":
      return "results.frequency_response.sweep";
    case "results.frequency-domain.frequency-points":
      return "results.frequency_response.frequency_points";
    case "results.frequency-domain.response-point":
      return "results.frequency_response.frequency_point";
    case "results.frequency-domain.progress":
      return "results.frequency_response.progress";
    case "results.frequency-domain.response-diagnostics":
      return "results.frequency_response.diagnostics";
    case "results.frequency-domain.fmr-views":
      return "results.frequency_domain.fmr";
    case "results.frequency-domain.modal-resonances":
      return "results.frequency_domain.fmr_modal_spectrum";
    case "results.frequency-domain.driven-sweep":
      return "results.frequency_domain.fmr_response_sweep";
    case "results.frequency-domain.peaks":
      return "results.frequency_domain.fmr_peaks";
    case "results.frequency-domain.peak":
      return "results.frequency_domain.fmr_peak";
    case "results.frequency-domain.resonance-fits":
    case "results.frequency-domain.resonance-fit":
      return "results.frequency_domain.fmr_resonance_fits";
    case "results.frequency-domain.kittel-fit":
      return "results.frequency_domain.fmr_kittel_fit";
    case "results.frequency-domain.field-frequency-map":
      return "results.frequency_domain.response_map";
    case "results.frequency-domain.modal-driven-comparison":
      return "results.frequency_domain.comparison";
    case "results.frequency-domain.validation":
    case "results.frequency-domain.validation-child":
      return "results.eigen.provenance";
    case "results.frequency-domain.artifacts":
      return "results.frequency_domain.exports";
    default:
      return "results.frequency_domain.root";
  }
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
    "frequency-domain",
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
  if (left.kind === "modal-mode" && right.kind === "modal-mode") {
    return (
      left.runId === right.runId &&
      left.stageId === right.stageId &&
      left.artifactRevision === right.artifactRevision &&
      left.sampleId === right.sampleId &&
      left.modeId === right.modeId &&
      (left.branchId ?? null) === (right.branchId ?? null)
    );
  }
  if (left.kind !== "response-point" || right.kind !== "response-point") {
    return false;
  }
  return (
    left.runId === right.runId &&
    left.stageId === right.stageId &&
    left.artifactRevision === right.artifactRevision &&
    left.pointId === right.pointId &&
    (left.observableId ?? null) === (right.observableId ?? null)
  );
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
  if (ref.kind === "modal-mode") {
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
      type: "frequency-domain",
    };
  }
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
  node: Pick<ResultsNavigatorNode, "id" | "kind" | "resourceKey" | "selectionRef">,
): {
  kind: string;
  ref: Extract<SelectionRef, { type: "frequency-domain" }>;
} {
  const kind = inspectorSelectionKindForResultsNodeKind(node.kind);
  return {
    kind,
    ref: node.selectionRef
      ? toKernelFrequencyDomainSelectionRef(node.selectionRef, node.id, kind)
      : toKernelFrequencyDomainNodeSelectionRef(node.kind, node.id, node.resourceKey),
  };
}
