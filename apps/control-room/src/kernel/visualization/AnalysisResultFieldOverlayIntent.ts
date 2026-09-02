import {
  asDecodedComplexFieldVector,
  type DecodedComplexFieldVector,
  type DecodedFieldVector,
} from "../api/codecs";
import type {
  AnalysisResultFieldRef,
  FieldVectorQuery,
  FieldVectorResponseMetadata,
} from "../api/apiTypes";
import type { AnalysisResultItemKind } from "@/shared/domain/analysis/results";
import type { AnalysisResultSelectionRef } from "@/shared/domain/analysis/results";

import type {
  ModeFieldOverlayIntent,
  ModeFieldOverlayTopologyIdentity,
} from "./ModeFieldOverlayIntent";

export type AnalysisResultFieldOverlaySource =
  | "eigen-mode"
  | "frequency-response"
  | "time-domain-response";

/**
 * Stable result-field identity. The compatibility locator fields inherited
 * from ModeFieldOverlayIntent are never used as cache or selection identity.
 */
export interface AnalysisResultFieldOverlayIntent
  extends ModeFieldOverlayIntent {
  readonly datasetId: string;
  readonly datasetRevision: string;
  readonly fieldRef: AnalysisResultFieldRef;
  readonly itemId: string;
  readonly itemKind: AnalysisResultItemKind;
  readonly fieldRevision: string;
  readonly source: AnalysisResultFieldOverlaySource;
  readonly sourceKind: "analysis-result";
}

export interface AnalysisResultFieldOverlayAdapter {
  readonly itemKind: AnalysisResultItemKind;
  readonly label: string;
  readonly plotCommandId: string;
  readonly source: AnalysisResultFieldOverlaySource;
}

const ANALYSIS_RESULT_FIELD_OVERLAY_ADAPTERS: Readonly<
  Record<AnalysisResultItemKind, AnalysisResultFieldOverlayAdapter>
> = Object.freeze({
  eigen_mode: {
    itemKind: "eigen_mode",
    label: "Eigen mode field",
    plotCommandId: "analysis.eigen.plot-mode-3d",
    source: "eigen-mode",
  },
  driven_frequency_point: {
    itemKind: "driven_frequency_point",
    label: "Driven response field",
    plotCommandId: "analysis.frequency-response.plot-response-field-3d",
    source: "frequency-response",
  },
  spectral_feature: {
    itemKind: "spectral_feature",
    label: "Time-domain response field",
    plotCommandId: "analysis.time-domain.plot-response-field-3d",
    source: "time-domain-response",
  },
  dsf_point: {
    itemKind: "dsf_point",
    label: "Time-domain response field",
    plotCommandId: "analysis.time-domain.plot-response-field-3d",
    source: "time-domain-response",
  },
});

export function analysisResultFieldOverlayAdapter(
  itemKind: AnalysisResultItemKind,
): AnalysisResultFieldOverlayAdapter {
  return ANALYSIS_RESULT_FIELD_OVERLAY_ADAPTERS[itemKind];
}

export interface AnalysisResultFieldOverlayMetadata {
  readonly analysisResultFieldRef: AnalysisResultFieldRef;
  readonly artifactPath: string;
  readonly availableViews: readonly string[];
  readonly binaryQuery: FieldVectorQuery;
  readonly defaultPhaseRad: number;
  readonly fieldId: string;
  readonly intent: AnalysisResultFieldOverlayIntent;
  readonly payloadValueCount: null;
  readonly resourceRevision: string;
}

export interface ValidatedAnalysisResultFieldOverlayBinary {
  readonly binary: DecodedFieldVector;
  readonly complex: DecodedComplexFieldVector;
  readonly phasorAmplitudeMax: number;
}

const AVAILABLE_ANALYSIS_RESULT_FIELD_VIEWS = Object.freeze([
  "complex",
  "real",
  "imag",
  "abs",
  "amplitude",
  "phase",
  "phase_rotated_real",
]);

export function analysisResultFieldOverlaySource(
  itemKind: AnalysisResultItemKind,
): AnalysisResultFieldOverlaySource {
  return analysisResultFieldOverlayAdapter(itemKind).source;
}

export function createAnalysisResultFieldOverlayIntent(
  selection: AnalysisResultSelectionRef | null | undefined,
  fieldRef: AnalysisResultFieldRef | null | undefined = selection?.fieldRef,
): AnalysisResultFieldOverlayIntent | null {
  if (
    !selection ||
    (selection.focus !== "item" && selection.focus !== "field") ||
    !nonEmpty(selection.runId) ||
    !nonEmpty(selection.stageId) ||
    !nonEmpty(selection.datasetId) ||
    !nonEmpty(selection.datasetRevision) ||
    !nonEmpty(selection.sampleId) ||
    !nonEmpty(selection.itemId) ||
    !selection.itemKind ||
    !fieldRef ||
    fieldRef.status !== "ready" ||
    !nonEmpty(fieldRef.field_id) ||
    !nonEmpty(fieldRef.field_revision) ||
    !nonEmpty(fieldRef.resource_key) ||
    fieldRef.representation !== "complex-vector-xyz" ||
    !fieldRef.mesh_ref ||
    !nonEmpty(fieldRef.mesh_ref.mesh_id) ||
    !nonEmpty(fieldRef.mesh_ref.mesh_revision) ||
    !nonEmpty(fieldRef.mesh_ref.topology_fingerprint)
  ) {
    return null;
  }
  if (
    (selection.fieldId && selection.fieldId !== fieldRef.field_id) ||
    (selection.fieldRevision &&
      selection.fieldRevision !== fieldRef.field_revision)
  ) {
    return null;
  }

  const source = analysisResultFieldOverlaySource(selection.itemKind);
  const intent = {
    analysisRunId: selection.runId,
    analysisStageId: selection.stageId,
    artifactRevision: selection.datasetRevision,
    datasetId: selection.datasetId,
    datasetRevision: selection.datasetRevision,
    fieldId: fieldRef.field_id,
    fieldRevision: fieldRef.field_revision,
    fieldRef,
    metadataResourceKey: fieldRef.resource_key,
    modeId: selection.itemId,
    // These are only retained for the legacy controller shape. Result IDs
    // above remain the only identity used by this adapter.
    modeIndex: selection.displayIndex ?? 0,
    nodeId: selection.nodeId,
    sampleId: selection.sampleId,
    sampleIndex: selection.sampleIndex ?? 0,
    source,
    sourceKind: "analysis-result" as const,
    itemId: selection.itemId,
    itemKind: selection.itemKind,
  } satisfies AnalysisResultFieldOverlayIntent;
  return Object.freeze({
    ...intent,
    fieldRef: Object.freeze({
      ...fieldRef,
      ...(fieldRef.mesh_ref
        ? { mesh_ref: Object.freeze({ ...fieldRef.mesh_ref }) }
        : {}),
    }),
  });
}

export function isAnalysisResultFieldOverlayIntent(
  intent: ModeFieldOverlayIntent | null | undefined,
): intent is AnalysisResultFieldOverlayIntent {
  return (
    (intent as (ModeFieldOverlayIntent & { sourceKind?: unknown }) | null | undefined)
      ?.sourceKind === "analysis-result"
  );
}

export function resolveAnalysisResultFieldOverlayMetadata(
  intent: AnalysisResultFieldOverlayIntent,
): AnalysisResultFieldOverlayMetadata | null {
  const fieldRef = intent.fieldRef;
  if (
    fieldRef.status !== "ready" ||
    fieldRef.field_id !== intent.fieldId ||
    fieldRef.representation !== "complex-vector-xyz" ||
    !nonEmpty(fieldRef.resource_key) ||
    !fieldRef.mesh_ref ||
    !nonEmpty(fieldRef.mesh_ref.mesh_id) ||
    !nonEmpty(fieldRef.mesh_ref.mesh_revision) ||
    !nonEmpty(fieldRef.mesh_ref.topology_fingerprint)
  ) {
    return null;
  }
  return Object.freeze({
    analysisResultFieldRef: fieldRef,
    artifactPath: fieldRef.resource_key,
    availableViews: AVAILABLE_ANALYSIS_RESULT_FIELD_VIEWS,
    binaryQuery: Object.freeze({
      component: "full",
      scope_kind: "full",
      view: "complex",
    }),
    defaultPhaseRad: 0,
    fieldId: fieldRef.field_id,
    intent,
    payloadValueCount: null,
    resourceRevision: fieldRef.field_revision,
  });
}

export function validateAnalysisResultFieldResponseMetadata(
  intent: AnalysisResultFieldOverlayIntent,
  metadata: FieldVectorResponseMetadata | null | undefined,
): boolean {
  // The result index revision identifies the immutable source field. The
  // binary data-plane revision is a separate transport/cache revision (the
  // legacy analysis endpoints derive it from the active domain and payload
  // path), so it must be present and internally consistent but need not be
  // byte-for-byte equal to the result-index revision.
  return Boolean(
    metadata &&
      metadata.fieldRevision &&
      metadata.component === "full" &&
      metadata.encoding === "FMVP;version=3" &&
      metadata.fieldIndexing === "full_domain" &&
      metadata.nComp === 6 &&
      metadata.pointCount !== null &&
      metadata.pointCount > 0 &&
      metadata.valueCount === metadata.pointCount * metadata.nComp &&
      metadata.meshTopologyHash ===
        intent.fieldRef.mesh_ref?.topology_fingerprint &&
      metadata.quantityId === intent.fieldRef.field_id &&
      metadata.identityIssues.length === 0,
  );
}

export function validateAnalysisResultFieldOverlayBinary(
  metadata: AnalysisResultFieldOverlayMetadata,
  field: DecodedFieldVector | null | undefined,
  topology: ModeFieldOverlayTopologyIdentity,
): ValidatedAnalysisResultFieldOverlayBinary | null {
  const meshRef = metadata.analysisResultFieldRef.mesh_ref;
  const complex = asDecodedComplexFieldVector(field);
  if (
    !field ||
    !complex ||
    !meshRef ||
    field.dtype !== "float64" ||
    field.formatVersion !== 3 ||
    field.nComp !== 6 ||
    complex.componentCount !== 3 ||
    field.quantityId !== metadata.fieldId ||
    !nonEmpty(field.domainGenerationId) ||
    !nonEmpty(topology.domainGenerationId) ||
    !nonEmpty(topology.meshId) ||
    topology.meshId !== meshRef.mesh_id ||
    !sameTopologyToken(field.meshTopologyHash, meshRef.topology_fingerprint) ||
    !sameTopologyToken(topology.meshTopologyHash, meshRef.topology_fingerprint) ||
    !sameTopologyToken(field.meshTopologyRevision, meshRef.mesh_revision) ||
    !sameTopologyToken(topology.meshTopologyRevision, meshRef.mesh_revision) ||
    field.domainGenerationId !== topology.domainGenerationId ||
    field.indexing !== "full_domain" ||
    field.pointCount <= 0 ||
    field.pointCount !== topology.pointCount ||
    gridPointCount(field.grid) !== field.pointCount ||
    field.valueCount !== field.pointCount * field.nComp ||
    field.values.length !== field.valueCount ||
    !allFinite(field.values)
  ) {
    return null;
  }
  return Object.freeze({
    binary: field,
    complex,
    phasorAmplitudeMax: complexAmplitudeMax(complex),
  });
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sameTopologyToken(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!nonEmpty(left) || !nonEmpty(right)) return false;
  return stripSha256Prefix(left) === stripSha256Prefix(right);
}

function stripSha256Prefix(value: string): string {
  return value.replace(/^sha256:/i, "").toLowerCase();
}

function gridPointCount(grid: readonly number[]): number | null {
  if (
    grid.length !== 3 ||
    grid.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    return null;
  }
  return grid[0]! * grid[1]! * grid[2]!;
}

function complexAmplitudeMax(field: DecodedComplexFieldVector): number {
  let maximum = 0;
  for (let point = 0; point < field.pointCount; point += 1) {
    let squaredAmplitude = 0;
    for (let component = 0; component < field.componentCount; component += 1) {
      const offset = (point * field.componentCount + component) * 2;
      const real = field.values[offset] ?? 0;
      const imaginary = field.values[offset + 1] ?? 0;
      squaredAmplitude += real * real + imaginary * imaginary;
    }
    maximum = Math.max(maximum, Math.sqrt(squaredAmplitude));
  }
  return maximum;
}

function allFinite(values: Float64Array): boolean {
  for (const value of values) {
    if (!Number.isFinite(value)) return false;
  }
  return true;
}
