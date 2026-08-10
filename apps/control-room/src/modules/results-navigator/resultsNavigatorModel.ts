import {
  buildModalNodeId,
  buildResponsePointNodeId,
  modalSelectionRef,
  responseSelectionRef,
} from "./resultsNavigatorSelection";
import type {
  FrequencyDomainNavigatorInput,
  NavigatorArtifactDescriptor,
  NavigatorBranchDescriptor,
  NavigatorModeDescriptor,
  NavigatorNodeStatus,
  NavigatorPage,
  NavigatorResourceResult,
  NavigatorSampleDescriptor,
  ResultsNavigatorNode,
  ResultsNavigatorNodeKind,
} from "./resultsNavigatorTypes";

const DEFAULT_PAGE_SIZE = 50;

function segment(value: string): string {
  return encodeURIComponent(value);
}

function nodePath(...segments: string[]): string {
  return segments.map(segment).join(":");
}

function statusToken(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function stateFromToken(
  value: string | null | undefined,
  fallback: NavigatorNodeStatus = "missing",
): NavigatorNodeStatus {
  switch (statusToken(value)) {
    case "loading":
      return "loading";
    case "ready":
    case "available":
    case "complete":
    case "completed":
    case "published":
    case "ok":
    case "pass":
      return "ready";
    case "unsupported":
    case "unavailable":
    case "not_supported":
      return "unsupported";
    case "partial":
    case "incomplete":
    case "stale":
    case "degraded":
    case "warning":
      return "partial";
    case "error":
    case "failed":
    case "corrupt":
    case "invalid":
    case "malformed":
      return "error";
    case "missing":
    case "absent":
    case "not_found":
      return "missing";
    default:
      return fallback;
  }
}

export function mapResourceResultState<T>(
  resource: NavigatorResourceResult<T & { status?: string | null }>,
): NavigatorNodeStatus {
  if (resource.error) return "error";
  if (resource.status === "loading") return "loading";
  if (resource.status === "error") return "error";
  if (resource.status === "stale") return resource.data ? "partial" : "loading";
  if (!resource.data) return "missing";
  return stateFromToken(resource.data.status, "ready");
}

export function mapNavigatorArtifactState(
  artifact: NavigatorArtifactDescriptor | null | undefined,
): NavigatorNodeStatus {
  if (!artifact) return "missing";
  const state = stateFromToken(artifact.status, "partial");
  if (state === "error" || state === "loading" || state === "partial") {
    return state;
  }
  if (artifact.missingReason) return "missing";
  return state;
}

function capabilityStatus(
  value: string | null | undefined,
): NavigatorNodeStatus {
  return stateFromToken(value, "missing");
}

function combineStatuses(
  statuses: readonly NavigatorNodeStatus[],
): NavigatorNodeStatus {
  if (statuses.length === 0) return "missing";
  if (statuses.includes("error")) return "error";
  if (statuses.includes("loading")) return "loading";
  if (statuses.includes("partial")) return "partial";
  if (statuses.includes("ready") && statuses.includes("missing")) return "partial";
  if (statuses.includes("ready") && statuses.includes("unsupported")) return "partial";
  if (statuses.includes("ready")) return "ready";
  if (statuses.includes("missing")) return "missing";
  return "unsupported";
}

function node({
  children,
  collection,
  id,
  inspectorId,
  kind,
  label,
  parentId,
  resourceKey,
  selectionRef,
  status,
  statusReason,
}: {
  children?: ResultsNavigatorNode[];
  collection?: ResultsNavigatorNode["collection"];
  id: string;
  inspectorId: string;
  kind: ResultsNavigatorNodeKind;
  label: string;
  parentId: string | null;
  resourceKey: string;
  selectionRef?: ResultsNavigatorNode["selectionRef"];
  status: NavigatorNodeStatus;
  statusReason?: string;
}): ResultsNavigatorNode {
  return {
    ...(children ? { children } : {}),
    ...(collection ? { collection } : {}),
    id,
    inspectorId,
    kind,
    label,
    parentId,
    resourceKey,
    ...(selectionRef ? { selectionRef } : {}),
    status,
    ...(statusReason ? { statusReason } : {}),
  };
}

function collection(totalCount: number, pageSize = DEFAULT_PAGE_SIZE) {
  return {
    pageCount: Math.max(1, Math.ceil(totalCount / pageSize)),
    pageSize,
    totalCount,
  };
}

function modeNode(
  sample: NavigatorSampleDescriptor,
  mode: NavigatorModeDescriptor,
  parentId: string,
  input: FrequencyDomainNavigatorInput,
): ResultsNavigatorNode {
  const id = mode.modeId && input.identity
    ? buildModalNodeId(
        modalSelectionRef({
          artifactRevision: input.identity.artifactRevision,
          ...(mode.branchId ? { branchId: mode.branchId } : {}),
          modeId: mode.modeId,
          rawModeIndex: mode.rawModeIndex,
          runId: input.identity.runId,
          sampleId: sample.sampleId,
          sampleIndex: sample.sampleIndex,
          stageId: input.identity.stageId,
        }),
      )
    : nodePath(parentId, "mode", String(mode.rawModeIndex));
  const stableRef = mode.modeId && input.identity
    ? modalSelectionRef({
        artifactRevision: input.identity.artifactRevision,
        ...(mode.branchId ? { branchId: mode.branchId } : {}),
        modeId: mode.modeId,
        rawModeIndex: mode.rawModeIndex,
        runId: input.identity.runId,
        sampleId: sample.sampleId,
        sampleIndex: sample.sampleIndex,
        stageId: input.identity.stageId,
      })
    : undefined;
  const status = stableRef ? "ready" : "partial";
  return node({
    id,
    inspectorId: "frequency-domain/eigen/mode",
    kind: "results.frequency-domain.mode",
    label: mode.modeId ? `Mode ${mode.modeId}` : `Mode ${mode.rawModeIndex}`,
    parentId,
    resourceKey: `analysis:eigen:sample:${sample.sampleId}:modes`,
    ...(stableRef ? { selectionRef: stableRef } : {}),
    status,
    ...(stableRef ? {} : { statusReason: "Published mode is missing stable modeId." }),
  });
}

function sampleNode(
  sample: NavigatorSampleDescriptor,
  parentId: string,
  input: FrequencyDomainNavigatorInput,
): ResultsNavigatorNode {
  const sampleId = nodePath(parentId, "sample", sample.sampleId);
  const modesId = nodePath(sampleId, "modes");
  const modes = sample.modes.map((mode) => modeNode(sample, mode, modesId, input));
  const modesStatus = combineStatuses(modes.map((item) => item.status));
  const modesNode = node({
    children: modes,
    collection: collection(modes.length),
    id: modesId,
    inspectorId: "frequency-domain/eigen/modes",
    kind: "results.frequency-domain.modes",
    label: "Modes",
    parentId: sampleId,
    resourceKey: `analysis:eigen:sample:${sample.sampleId}:modes`,
    status: modesStatus,
  });
  return node({
    children: [modesNode],
    id: sampleId,
    inspectorId: "frequency-domain/eigen/sample",
    kind: "results.frequency-domain.sample",
    label: sample.label ?? `Sample ${sample.sampleId}`,
    parentId,
    resourceKey: `analysis:eigen:sample:${sample.sampleId}`,
    status: modes.length > 0 ? modesStatus : "partial",
    ...(modes.length === 0 ? { statusReason: "Sample contains no published modes." } : {}),
  });
}

function branchNode(
  branch: NavigatorBranchDescriptor,
  parentId: string,
  input: FrequencyDomainNavigatorInput,
): ResultsNavigatorNode {
  return node({
    id: nodePath(parentId, "branch", branch.branchId),
    inspectorId: "frequency-domain/eigen/branch",
    kind: "results.frequency-domain.branch",
    label: `Branch ${branch.branchId}`,
    parentId,
    resourceKey: input.resources.branches?.resourceKey ?? "analysis:eigen:branches",
    status: branch.stableIdentityAvailable === false ? "partial" : "ready",
    ...(branch.stableIdentityAvailable === false
      ? { statusReason: "Published branch is missing stable branchId." }
      : {}),
  });
}

function artifactNode(
  args: {
    artifact: NavigatorArtifactDescriptor | null | undefined;
    id: string;
    inspectorId: string;
    kind: ResultsNavigatorNodeKind;
    label: string;
    parentId: string;
    resourceKey: string;
    missingStatus?: NavigatorNodeStatus;
    statusOverride?: NavigatorNodeStatus;
    statusReason?: string;
  },
): ResultsNavigatorNode {
  const status = args.statusOverride ?? (args.artifact
    ? mapNavigatorArtifactState(args.artifact)
    : args.missingStatus ?? "missing");
  const statusReason =
    args.statusReason ??
    args.artifact?.missingReason ??
    (args.artifact?.status.toLowerCase() === "corrupt"
      ? "Artifact payload is corrupt."
      : undefined);
  return node({
    id: args.id,
    inspectorId: args.inspectorId,
    kind: args.kind,
    label: args.label,
    parentId: args.parentId,
    resourceKey: args.artifact?.resourceKey ?? args.resourceKey,
    status,
    ...(statusReason ? { statusReason } : {}),
  });
}

function buildFrequencyDomainTree(
  input: FrequencyDomainNavigatorInput,
): ResultsNavigatorNode {
  const rootId = "results";
  const runsId = nodePath(rootId, "runs");
  const runId = nodePath(runsId, "run", input.identity?.runId ?? "current");
  const stageId = nodePath(runId, "stage", input.identity?.stageId ?? "current");
  const frequencyId = nodePath(stageId, "frequency-domain");
  const manifestStatus = input.manifest
    ? combineStatuses([
        capabilityStatus(input.manifest.eigenStatus),
        capabilityStatus(input.manifest.responseStatus),
      ])
    : "missing";

  const overview = node({
    id: nodePath(frequencyId, "overview"),
    inspectorId: "frequency-domain/overview",
    kind: "results.frequency-domain.overview",
    label: "Overview",
    parentId: frequencyId,
    resourceKey: "analysis:frequency-domain:manifest",
    status: input.manifestState ?? (input.identity && input.manifest ? manifestStatus : "missing"),
    ...(!input.identity ? { statusReason: "No current run/stage identity is published." } : {}),
  });

  const modalId = nodePath(frequencyId, "modal-eigen");
  const spectrumStatus = input.resources.spectrum
    ? input.spectrum
      ? mapNavigatorArtifactState(input.resources.spectrum)
      : mapNavigatorArtifactState(input.resources.spectrum) === "ready"
        ? "partial"
        : mapNavigatorArtifactState(input.resources.spectrum)
    : "missing";
  const spectrum = artifactNode({
    artifact: input.resources.spectrum,
    id: nodePath(modalId, "spectrum"),
    inspectorId: "frequency-domain/eigen/spectrum",
    kind: "results.frequency-domain.spectrum",
    label: "Spectrum",
    parentId: modalId,
    resourceKey: "analysis:eigen:spectrum",
    statusOverride:
      input.spectrum || input.resources.states?.spectrum !== "ready"
        ? input.resources.states?.spectrum
        : "partial",
    ...(input.resources.spectrum && !input.spectrum && spectrumStatus === "partial"
      ? { statusReason: "Typed spectrum payload is not available on this transport." }
      : {}),
  });
  const fieldSweep = artifactNode({
    artifact: input.resources.fieldSweep,
    id: nodePath(modalId, "field-sweep"),
    inspectorId: "frequency-domain/eigen/scan",
    kind: "results.frequency-domain.field-sweep",
    label: "Field Sweep",
    parentId: modalId,
    resourceKey: "analysis:eigen:field-sweep",
    statusOverride: input.resources.states?.fieldSweep,
    ...(input.resources.fieldSweep ? {} : { missingStatus: "unsupported" as const }),
    statusReason: input.resources.fieldSweep
      ? undefined
      : "No typed bias-field sweep artifact is published.",
  });
  const dispersion = artifactNode({
    artifact: input.resources.dispersion,
    id: nodePath(modalId, "dispersion"),
    inspectorId: "frequency-domain/eigen/dispersion",
    kind: "results.frequency-domain.dispersion",
    label: "Dispersion",
    parentId: modalId,
    resourceKey: "analysis:eigen:dispersion",
    statusOverride: input.resources.states?.dispersion,
  });
  const samplesId = nodePath(modalId, "samples");
  const samples = input.spectrum?.samples ?? [];
  const sampleNodes = samples.map((sample) => sampleNode(sample, samplesId, input));
  const samplesStatus = input.resources.spectrum
    ? input.spectrum
      ? sampleNodes.length > 0
        ? combineStatuses(sampleNodes.map((item) => item.status))
        : "partial"
      : "partial"
    : input.resources.states?.spectrum ?? "missing";
  const samplesNode = node({
    children: sampleNodes,
    collection: collection(sampleNodes.length),
    id: samplesId,
    inspectorId: "frequency-domain/eigen/samples",
    kind: "results.frequency-domain.samples",
    label: "Samples",
    parentId: modalId,
    resourceKey: input.resources.spectrum?.resourceKey ?? "analysis:eigen:spectrum",
    status: samplesStatus,
    ...(samplesStatus === "partial" && !input.spectrum
      ? { statusReason: "Typed sample payload is not available on this transport." }
      : {}),
  });
  const branchesId = nodePath(modalId, "branches");
  const branchNodes = (input.branches?.branches ?? []).map((branch) =>
    branchNode(branch, branchesId, input),
  );
  const branchesStatus = input.resources.branches
    ? input.branches
      ? branchNodes.length > 0
        ? combineStatuses(branchNodes.map((item) => item.status))
        : "partial"
      : "partial"
    : input.resources.states?.branches ?? "missing";
  const branchesNode = node({
    children: branchNodes,
    collection: collection(branchNodes.length),
    id: branchesId,
    inspectorId: "frequency-domain/eigen/branches",
    kind: "results.frequency-domain.branches",
    label: "Branches",
    parentId: modalId,
    resourceKey: input.resources.branches?.resourceKey ?? "analysis:eigen:branches",
    status: branchesStatus,
  });
  const modal = node({
    children: [spectrum, fieldSweep, dispersion, samplesNode, branchesNode],
    id: modalId,
    inspectorId: "frequency-domain/eigen",
    kind: "results.frequency-domain.modal-eigen",
    label: "Modal Eigen",
    parentId: frequencyId,
    resourceKey: "analysis:frequency-domain:eigen",
    status: combineStatuses([
      spectrum.status,
      fieldSweep.status,
      dispersion.status,
      samplesNode.status,
      branchesNode.status,
    ]),
  });

  const responseId = nodePath(frequencyId, "driven-response");
  const responseSweep = artifactNode({
    artifact: input.resources.response,
    id: nodePath(responseId, "frequency-sweep"),
    inspectorId: "frequency-domain/scan",
    kind: "results.frequency-domain.frequency-sweep",
    label: "Frequency Sweep",
    parentId: responseId,
    resourceKey: "analysis:frequency-domain:response",
    statusOverride: input.resources.states?.response,
  });
  const pointsId = nodePath(responseId, "frequency-points");
  const points = input.response?.points ?? [];
  const pointNodes = points.map((point) => {
    const stableRef = point.pointId && input.identity
      ? responseSelectionRef({
          artifactRevision: input.identity.artifactRevision,
          frequencyIndex: point.frequencyIndex,
          pointId: point.pointId,
          runId: input.identity.runId,
          stageId: input.identity.stageId,
        })
      : undefined;
    const pointId = stableRef
      ? buildResponsePointNodeId(stableRef)
      : nodePath(pointsId, "point", point.pointId ?? `frequency-${point.frequencyIndex}`);
    return node({
      id: pointId,
      inspectorId: "frequency-domain/response/point",
      kind: "results.frequency-domain.response-point",
      label: point.pointId ? `Point ${point.pointId}` : `Frequency ${point.frequencyIndex}`,
      parentId: pointsId,
      resourceKey: `analysis:frequency-domain:response:point:${point.pointId ?? point.frequencyIndex}`,
      ...(stableRef ? { selectionRef: stableRef } : {}),
      status: stableRef
        ? point.stableIdentityAvailable === false
          ? "partial"
          : "ready"
        : "partial",
      ...(!stableRef
        ? {
            statusReason: input.identity
              ? "Published response point is missing stable pointId."
              : "No current run/stage identity is published.",
          }
        : point.stableIdentityAvailable === false
          ? { statusReason: "Published response point is missing stable pointId." }
          : {}),
    });
  });
  const pointsNode = node({
    children: pointNodes,
    collection: collection(pointNodes.length),
    id: pointsId,
    inspectorId: "frequency-domain/response/points",
    kind: "results.frequency-domain.frequency-points",
    label: "Frequency Points",
    parentId: responseId,
    resourceKey: input.resources.response?.resourceKey ?? "analysis:frequency-domain:response",
    status: input.resources.states?.response && !input.response
      ? input.resources.states.response
      : input.resources.response
      ? input.response
        ? pointNodes.length > 0
          ? combineStatuses(pointNodes.map((item) => item.status))
          : "partial"
        : "partial"
      : "missing",
  });
  const progress = node({
    id: nodePath(responseId, "progress"),
    inspectorId: "frequency-domain/response/progress",
    kind: "results.frequency-domain.progress",
    label: "Progress",
    parentId: responseId,
    resourceKey: "analysis:frequency-domain:response:progress",
    status: input.progressState ?? (input.progress ? stateFromToken(input.progress.status, "partial") : "missing"),
    ...(input.progress?.missingReason ? { statusReason: input.progress.missingReason } : {}),
  });
  const responseDiagnostics = artifactNode({
    artifact: input.resources.responseDiagnostics,
    id: nodePath(responseId, "diagnostics"),
    inspectorId: "frequency-domain/response/diagnostics",
    kind: "results.frequency-domain.response-diagnostics",
    label: "Diagnostics",
    parentId: responseId,
    resourceKey: "analysis:frequency-domain:response:diagnostics",
    statusOverride: input.resources.states?.responseDiagnostics,
  });
  const response = node({
    children: [responseSweep, pointsNode, progress, responseDiagnostics],
    id: responseId,
    inspectorId: "frequency-domain/response",
    kind: "results.frequency-domain.driven-response",
    label: "Driven Response",
    parentId: frequencyId,
    resourceKey: "analysis:frequency-domain:response",
    status: combineStatuses([
      responseSweep.status,
      pointsNode.status,
      progress.status,
      responseDiagnostics.status,
    ]),
  });

  const fmrId = nodePath(frequencyId, "fmr-views");
  const fmr = input.fmr;
  const peaksId = nodePath(fmrId, "peaks");
  const peakNodes = (fmr?.payload?.peaks ?? []).map((peak) =>
    node({
      id: nodePath(peaksId, "peak", peak.peakId),
      inspectorId: "frequency-domain/fmr/peak",
      kind: "results.frequency-domain.peak",
      label: `Peak ${peak.peakId}`,
      parentId: peaksId,
      resourceKey: fmr?.peaks?.resourceKey ?? "analysis:frequency-domain:fmr:peaks",
      status: peak.stableIdentityAvailable === false ? "partial" : "ready",
      ...(peak.stableIdentityAvailable === false
        ? { statusReason: "Published FMR peak is missing stable peakId." }
        : {}),
    }),
  );
  const peaksNode = node({
    children: peakNodes,
    collection: collection(peakNodes.length),
    id: peaksId,
    inspectorId: "frequency-domain/fmr/peaks",
    kind: "results.frequency-domain.peaks",
    label: "Peaks",
    parentId: fmrId,
    resourceKey: fmr?.peaks?.resourceKey ?? "analysis:frequency-domain:fmr:peaks",
    status: fmr?.payload
      ? fmr.states?.peaks ?? (peakNodes.length > 0
        ? combineStatuses(peakNodes.map((item) => item.status))
        : "partial")
      : fmr?.states?.peaks === "ready"
        ? "partial"
        : fmr?.states?.peaks ?? (fmr?.peaks ? "partial" : "missing"),
  });
  const fmrChildren: ResultsNavigatorNode[] = [
    artifactNode({
      artifact: fmr?.modalResonances,
      id: nodePath(fmrId, "modal-resonances"),
      inspectorId: "frequency-domain/fmr/modal-resonances",
      kind: "results.frequency-domain.modal-resonances",
      label: "Modal Resonances",
      parentId: fmrId,
      resourceKey: "analysis:frequency-domain:fmr:modal-resonances",
      missingStatus: "unsupported",
      ...(fmr?.modalResonances
        ? {}
        : { statusReason: "Modal frequencies have no RF coupling artifact." }),
    }),
    artifactNode({
      artifact: input.resources.response,
      id: nodePath(fmrId, "driven-sweep"),
      inspectorId: "frequency-domain/fmr/driven-sweep",
      kind: "results.frequency-domain.driven-sweep",
      label: "Driven Sweep",
      parentId: fmrId,
      resourceKey: "analysis:frequency-domain:fmr:driven-sweep",
    }),
    peaksNode,
    artifactNode({
      artifact: fmr?.resonanceFits,
      id: nodePath(fmrId, "resonance-fits"),
      inspectorId: "frequency-domain/fmr/resonance-fits",
      kind: "results.frequency-domain.resonance-fits",
      label: "Resonance Fits",
      parentId: fmrId,
      resourceKey: "analysis:frequency-domain:fmr:resonance-fits",
      statusOverride: fmr?.states?.resonanceFits,
    }),
    artifactNode({
      artifact: fmr?.kittelFit,
      id: nodePath(fmrId, "kittel-fit"),
      inspectorId: "frequency-domain/fmr/kittel-fit",
      kind: "results.frequency-domain.kittel-fit",
      label: "Kittel Fit",
      parentId: fmrId,
      resourceKey: "analysis:frequency-domain:fmr:kittel-fit",
      statusOverride: fmr?.states?.kittelFit,
    }),
    artifactNode({
      artifact: fmr?.fieldFrequencyMap,
      id: nodePath(fmrId, "field-frequency-map"),
      inspectorId: "frequency-domain/fmr/field-frequency-map",
      kind: "results.frequency-domain.field-frequency-map",
      label: "Field-Frequency Map",
      parentId: fmrId,
      resourceKey: "analysis:frequency-domain:fmr:field-frequency-map",
    }),
    artifactNode({
      artifact: fmr?.modalDrivenComparison,
      id: nodePath(fmrId, "modal-driven-comparison"),
      inspectorId: "frequency-domain/fmr/modal-driven-comparison",
      kind: "results.frequency-domain.modal-driven-comparison",
      label: "Modal vs Driven",
      parentId: fmrId,
      resourceKey: "analysis:frequency-domain:fmr:modal-driven-comparison",
    }),
  ];
  const fmrNode = node({
    children: fmrChildren,
    id: fmrId,
    inspectorId: "frequency-domain/fmr",
    kind: "results.frequency-domain.fmr-views",
    label: "FMR Views",
    parentId: frequencyId,
    resourceKey: "analysis:frequency-domain:fmr",
    status: combineStatuses(fmrChildren.map((item) => item.status)),
  });

  const validationId = nodePath(frequencyId, "validation");
  const validationChildren = [
    "Requested vs Resolved",
    "Equilibrium & Mesh",
    "Operator & Solver",
    "Residuals & Completeness",
    "Scope & Qualification",
    "CPU/GPU Parity",
  ].map((label) =>
    node({
      id: nodePath(validationId, label.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
      inspectorId: "frequency-domain/validation",
      kind: "results.frequency-domain.validation-child",
      label,
      parentId: validationId,
      resourceKey: `analysis:frequency-domain:validation:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      status: "unsupported",
      statusReason: "Validation artifact is not published by the current transport.",
    }),
  );
  const validation = node({
    children: validationChildren,
    id: validationId,
    inspectorId: "frequency-domain/validation",
    kind: "results.frequency-domain.validation",
    label: "Validation & Provenance",
    parentId: frequencyId,
    resourceKey: "analysis:frequency-domain:validation",
    status: input.manifest ? "partial" : "missing",
  });
  const artifacts = artifactNode({
    id: nodePath(frequencyId, "artifacts-group"),
    inspectorId: "frequency-domain/artifacts",
    kind: "results.frequency-domain.artifacts",
    label: "Artifacts & Exports",
    parentId: frequencyId,
    resourceKey: "analysis:frequency-domain:artifacts",
    statusOverride: input.resources.states?.resultManifest,
    artifact: input.resources.resultManifest,
  });
  const frequency = node({
    children: [
      overview,
      modal,
      response,
      fmrNode,
      validation,
      artifacts,
    ],
    id: frequencyId,
    inspectorId: "frequency-domain/overview",
    kind: "results.frequency-domain",
    label: "Frequency Domain",
    parentId: stageId,
    resourceKey: "analysis:frequency-domain:manifest",
    status: combineStatuses([
      overview.status,
      modal.status,
      response.status,
      fmrNode.status,
      validation.status,
      artifacts.status,
    ]),
  });
  const stage = node({
    children: [frequency],
    id: stageId,
    inspectorId: "frequency-domain/overview",
    kind: "results.stage",
    label: input.identity?.stageId ?? "Current stage",
    parentId: runId,
    resourceKey: input.identity ? `simulation:stage:${input.identity.stageId}` : "simulation:stage:current",
    status: input.identity ? frequency.status : "missing",
  });
  const run = node({
    children: [stage],
    id: runId,
    inspectorId: "frequency-domain/overview",
    kind: "results.run",
    label: input.identity?.runId ?? "Current run",
    parentId: runsId,
    resourceKey: input.identity ? `simulation:run:${input.identity.runId}` : "simulation:run:current",
    status: stage.status,
  });
  const runs = node({
    children: [run],
    id: runsId,
    inspectorId: "frequency-domain/overview",
    kind: "results.runs",
    label: "Runs",
    parentId: rootId,
    resourceKey: "simulation:runs:current",
    status: run.status,
  });
  return node({
    children: [runs],
    id: rootId,
    inspectorId: "frequency-domain/overview",
    kind: "results.root",
    label: "Results",
    parentId: null,
    resourceKey: "results:navigator",
    status: runs.status,
  });
}

export function buildFrequencyDomainResultsTree(
  input: FrequencyDomainNavigatorInput,
): ResultsNavigatorNode[] {
  return [buildFrequencyDomainTree(input)];
}

export function paginateNavigatorItems<T>(
  items: readonly T[],
  options: { page?: number; pageSize?: number } = {},
): NavigatorPage<T> {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE));
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(options.page ?? 1)));
  const startIndex = (page - 1) * pageSize;
  return {
    hasNext: page < pageCount,
    hasPrevious: page > 1,
    items: items.slice(startIndex, startIndex + pageSize),
    page,
    pageCount,
    pageSize,
    startIndex,
    total: items.length,
  };
}

export type {
  FrequencyDomainNavigatorInput,
  NavigatorArtifactDescriptor,
  NavigatorBranchesPayload,
  NavigatorFmrPayload,
  NavigatorModeDescriptor,
  NavigatorResponsePayload,
  NavigatorSampleDescriptor,
  NavigatorSpectrumPayload,
} from "./resultsNavigatorTypes";

export {
  navigatorBranchesFromResource,
  navigatorFmrFromResource,
  navigatorKittelFitArtifactFromResource,
  navigatorResonanceFitsArtifactFromResource,
  navigatorResponseFromResource,
  navigatorSpectrumFromResource,
} from "./resultsNavigatorTypes";
