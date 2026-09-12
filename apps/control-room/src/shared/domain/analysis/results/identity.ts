import type {
  AnalysisResultCoordinateResource,
  AnalysisResultDatasetManifestResource,
} from "./types";
import type {
  AnalysisResultCoordinateRef,
  AnalysisResultCursor,
  AnalysisResultDatasetIdentity,
  AnalysisResultProjectionPointSelection,
  AnalysisResultSelectionRef,
} from "./types";

const IDENTITY_SEPARATOR = ":";

function encodeIdentityPart(value: string): string {
  return encodeURIComponent(value);
}

export function analysisResultDatasetIdentity(
  manifest: AnalysisResultDatasetManifestResource,
): AnalysisResultDatasetIdentity {
  return {
    datasetId: manifest.dataset_id,
    datasetRevision: manifest.dataset_revision,
    runId: manifest.run_id,
    stageId: manifest.stage_id,
  };
}

export function analysisResultCoordinateFromResource(
  coordinate: AnalysisResultCoordinateResource,
): AnalysisResultCoordinateRef {
  const vector = coordinate.vector3_si;
  return {
    axisId: coordinate.axis_id,
    category: coordinate.category ?? null,
    entityRef: coordinate.entity_ref ?? null,
    label: coordinate.label ?? null,
    scalarSI: coordinate.scalar_si ?? null,
    token: coordinate.token,
    vector3SI:
      vector && vector.length === 3
        ? [vector[0], vector[1], vector[2]]
        : null,
  };
}

export function analysisResultCoordinateKey(
  coordinate: Pick<AnalysisResultCoordinateRef, "axisId" | "token">,
): string {
  return `${encodeIdentityPart(coordinate.axisId)}${IDENTITY_SEPARATOR}${encodeIdentityPart(coordinate.token)}`;
}

export function analysisResultNodeId(
  ref: Omit<AnalysisResultSelectionRef, "nodeId">,
): string {
  const axisFilters = ref.axisFilters
    ? Object.entries(ref.axisFilters)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([axisId, token]) => `${axisId}=${token}`)
        .join(",")
    : undefined;
  const parts = [
    "analysis-result",
    ref.runId,
    ref.datasetId,
    ref.focus,
    ref.sampleId,
    ref.itemId,
    ref.branchId,
    ref.axisId,
    ref.axisValueToken,
    axisFilters,
    ref.fieldId,
    ref.projectionId,
    ref.projectionOrdinal == null ? undefined : String(ref.projectionOrdinal),
  ];
  return parts
    .filter((part): part is string => Boolean(part))
    .map(encodeIdentityPart)
    .join(IDENTITY_SEPARATOR);
}

export function analysisResultSelectionRef(
  input: Omit<AnalysisResultSelectionRef, "nodeId" | "type" | "kind"> & {
    nodeId?: string;
  },
): AnalysisResultSelectionRef {
  const refWithoutNode = {
    ...input,
    type: "analysis-result" as const,
    kind: "analysis.result" as const,
  };
  return {
    ...refWithoutNode,
    nodeId: input.nodeId ?? analysisResultNodeId(refWithoutNode),
  };
}

export function analysisResultSelectionForProjection(
  selection: AnalysisResultSelectionRef,
  projectionId: string,
): AnalysisResultSelectionRef {
  const {
    kind: _kind,
    nodeId: _nodeId,
    projectionOrdinal: _projectionOrdinal,
    projectionRevision: _projectionRevision,
    type: _type,
    ...identity
  } = selection;
  return analysisResultSelectionRef({
    ...identity,
    projectionId,
  });
}

export function analysisResultSelectionEquals(
  left: AnalysisResultSelectionRef | null | undefined,
  right: AnalysisResultSelectionRef | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.type === right.type &&
    left.kind === right.kind &&
    left.nodeId === right.nodeId &&
    left.focus === right.focus &&
    left.runId === right.runId &&
    left.stageId === right.stageId &&
    left.datasetId === right.datasetId &&
    left.datasetRevision === right.datasetRevision &&
    (left.itemKind ?? null) === (right.itemKind ?? null) &&
    (left.sampleId ?? null) === (right.sampleId ?? null) &&
    (left.itemId ?? null) === (right.itemId ?? null) &&
    (left.branchId ?? null) === (right.branchId ?? null) &&
    (left.axisId ?? null) === (right.axisId ?? null) &&
    (left.axisValueToken ?? null) === (right.axisValueToken ?? null) &&
    recordEquals(left.axisFilters, right.axisFilters) &&
    coordinateRefsEqual(left.coordinates, right.coordinates) &&
    (left.fieldId ?? null) === (right.fieldId ?? null) &&
    (left.fieldRevision ?? null) === (right.fieldRevision ?? null) &&
    fieldRefIdentityEquals(left.fieldRef, right.fieldRef) &&
    (left.projectionId ?? null) === (right.projectionId ?? null) &&
    (left.projectionRevision ?? null) === (right.projectionRevision ?? null) &&
    (left.projectionOrdinal ?? null) === (right.projectionOrdinal ?? null)
  );
}

function coordinateRefsEqual(
  left: readonly AnalysisResultCoordinateRef[] | undefined,
  right: readonly AnalysisResultCoordinateRef[] | undefined,
): boolean {
  const leftKeys = (left ?? [])
    .map((coordinate) => analysisResultCoordinateKey(coordinate))
    .sort();
  const rightKeys = (right ?? [])
    .map((coordinate) => analysisResultCoordinateKey(coordinate))
    .sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
}

function fieldRefIdentityEquals(
  left: AnalysisResultSelectionRef["fieldRef"],
  right: AnalysisResultSelectionRef["fieldRef"],
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.field_id === right.field_id &&
    left.field_revision === right.field_revision &&
    left.resource_key === right.resource_key &&
    left.status === right.status &&
    left.representation === right.representation &&
    left.quantity_id === right.quantity_id &&
    left.mesh_ref?.mesh_id === right.mesh_ref?.mesh_id &&
    left.mesh_ref?.mesh_revision === right.mesh_ref?.mesh_revision &&
    left.mesh_ref?.topology_fingerprint === right.mesh_ref?.topology_fingerprint
  );
}

function recordEquals(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {});
  const rightEntries = Object.entries(right ?? {});
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) => right?.[key] === value)
  );
}

export function analysisResultCursorFromSelection(
  selection: AnalysisResultSelectionRef,
  coordinates?: readonly AnalysisResultCoordinateRef[],
): AnalysisResultCursor {
  return {
    branchId: selection.branchId ?? null,
    coordinates: coordinates ?? selection.coordinates ?? [],
    datasetId: selection.datasetId,
    datasetRevision: selection.datasetRevision,
    fieldId: selection.fieldId ?? null,
    fieldRevision: selection.fieldRevision ?? null,
    itemId: selection.itemId ?? null,
    itemKind: selection.itemKind ?? null,
    projectionId: selection.projectionId ?? null,
    projectionRevision: selection.projectionRevision ?? null,
    runId: selection.runId,
    sampleId: selection.sampleId ?? null,
    stageId: selection.stageId,
  };
}

export function analysisResultCursorFromProjectionPoint(
  identity: AnalysisResultDatasetIdentity,
  point: AnalysisResultProjectionPointSelection,
): AnalysisResultCursor {
  return {
    ...identity,
    branchId: point.branchId,
    coordinates: [],
    fieldId: null,
    fieldRevision: null,
    itemId: point.itemId,
    itemKind: null,
    projectionId: point.projectionId,
    projectionRevision: point.projectionRevision,
    sampleId: point.sampleId,
  };
}

export function analysisResultSnapshotMatches(
  identity: AnalysisResultDatasetIdentity,
  ref: Pick<AnalysisResultDatasetIdentity, "runId" | "datasetId" | "datasetRevision">,
): boolean {
  return (
    identity.runId === ref.runId &&
    identity.datasetId === ref.datasetId &&
    identity.datasetRevision === ref.datasetRevision
  );
}
