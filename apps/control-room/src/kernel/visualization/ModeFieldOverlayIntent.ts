import {
  asDecodedComplexFieldVector,
  type DecodedComplexFieldVector,
  type DecodedFieldVector,
} from "../api/codecs";
import type {
  FieldVectorQuery,
  FrequencyDomainFieldResource,
  ResourceRevision,
} from "../api/apiTypes";
import type { SelectionRef } from "../selection/selectionTypes";

type FrequencyDomainSelectionRef = Extract<
  SelectionRef,
  { type: "frequency-domain" }
>;

export interface ModeFieldOverlayIntent {
  readonly analysisRunId: string;
  readonly analysisStageId: string;
  readonly artifactRevision: string;
  readonly fieldId: string;
  readonly metadataResourceKey: string;
  readonly modeId: string;
  readonly modeIndex: number;
  readonly nodeId: string;
  readonly sampleId: string;
  readonly sampleIndex: number;
}

export interface ResolvedModeFieldOverlayMetadata {
  readonly artifactPath: string;
  readonly availableViews: readonly string[];
  readonly binaryQuery: FieldVectorQuery;
  readonly defaultPhaseRad: number;
  readonly fieldId: string;
  readonly intent: ModeFieldOverlayIntent;
  readonly payloadValueCount: number;
  readonly resourceRevision: string;
}

export interface ModeFieldOverlayTopologyIdentity {
  readonly domainGenerationId: string | null;
  readonly meshTopologyHash: string | null;
  readonly meshTopologyRevision: string | null;
  readonly pointCount: number;
}

export interface ValidatedModeFieldOverlayBinary {
  readonly binary: DecodedFieldVector;
  readonly complex: DecodedComplexFieldVector;
  readonly phasorAmplitudeMax: number;
}

/**
 * Creates the kernel-owned identity for an eigenmode handoff. Presentation
 * indices remain only the temporary generated-API lookup bridge; cache and
 * completion identity use the artifact's stable sample/mode IDs.
 */
export function createModeFieldOverlayIntent(
  selection: FrequencyDomainSelectionRef | null | undefined,
): ModeFieldOverlayIntent | null {
  if (!selection || !selection.kind.startsWith("results.eigen")) return null;
  const analysisRunId = requiredString(selection.analysisRunId);
  const analysisStageId = requiredString(selection.analysisStageId);
  const artifactRevision = requiredString(selection.artifactRevision);
  const fieldId = requiredString(selection.fieldId);
  const modeId = requiredString(selection.modeId);
  const sampleId = requiredString(selection.sampleId);
  if (
    !analysisRunId ||
    !analysisStageId ||
    !artifactRevision ||
    !fieldId ||
    !modeId ||
    !sampleId ||
    !isNonNegativeInteger(selection.modeIndex) ||
    !isNonNegativeInteger(selection.sampleIndex)
  ) {
    return null;
  }

  return Object.freeze({
    analysisRunId,
    analysisStageId,
    artifactRevision,
    fieldId,
    metadataResourceKey:
      `analysis/frequency-domain/eigen/samples/${encodeURIComponent(sampleId)}` +
      `/modes/${encodeURIComponent(modeId)}/fields/${encodeURIComponent(fieldId)}/meta`,
    modeId,
    modeIndex: selection.modeIndex,
    nodeId: selection.nodeId,
    sampleId,
    sampleIndex: selection.sampleIndex,
  });
}

/**
 * Admits only the canonical generated FrequencyDomainFieldResource contract.
 * Topology identity is owned by the FMVP binary header and is checked at the
 * next gate against the active viewport topology, never reconstructed here.
 */
export function resolveModeFieldOverlayMetadata(
  intent: ModeFieldOverlayIntent,
  metadata: FrequencyDomainFieldResource,
  resourceRevision: ResourceRevision | null,
): ResolvedModeFieldOverlayMetadata | null {
  const fieldId = requiredString(metadata.field_id);
  const artifactPath = requiredString(metadata.artifact_path);
  const revision = requiredRevision(resourceRevision);
  const payloadValueCount = positiveInteger(metadata.payload_value_count);
  const complexPairCount = positiveInteger(metadata.complex_pair_count);
  const defaultPhaseRad = finiteNumber(metadata.default_phase_rad);

  if (
    metadata.status !== "ready" ||
    metadata.schema_version !== "frequency_domain_mode_field.v1" ||
    metadata.source_family !== "analysis/eigen" ||
    metadata.quantity !== "delta_m" ||
    metadata.value_kind !== "complex_spatial_vector" ||
    metadata.component_basis !== "global_xyz" ||
    metadata.component_count !== 3 ||
    !stringArrayEquals(metadata.components, ["x", "y", "z"]) ||
    metadata.payload_encoding !== "f64_interleaved_real_imag_xyz" ||
    metadata.binary_layout !== "complex_f64_pairs_little_endian" ||
    fieldId !== intent.fieldId ||
    !artifactPath ||
    !revision ||
    payloadValueCount === null ||
    complexPairCount === null ||
    payloadValueCount !== complexPairCount * 2 ||
    payloadValueCount % 6 !== 0 ||
    defaultPhaseRad === null ||
    !containsRequiredViews(metadata.available_views) ||
    !metadata.available_views.includes(metadata.default_view)
  ) {
    return null;
  }

  return Object.freeze({
    artifactPath,
    availableViews: Object.freeze([...metadata.available_views]),
    binaryQuery: Object.freeze({
      component: "full",
      scope_kind: "full",
      view: "complex",
    }),
    defaultPhaseRad,
    fieldId,
    intent,
    payloadValueCount,
    resourceRevision: revision,
  });
}

/**
 * Rejects a binary response unless it is exactly the metadata-bound complex
 * global XYZ field. This is deliberately stricter than the generic complex
 * codec, which also supports non-XYZ component counts for other consumers.
 */
export function validateModeFieldOverlayBinary(
  metadata: ResolvedModeFieldOverlayMetadata,
  field: DecodedFieldVector | null | undefined,
  topology: ModeFieldOverlayTopologyIdentity,
): ValidatedModeFieldOverlayBinary | null {
  const complex = asDecodedComplexFieldVector(field);
  if (
    !field ||
    !complex ||
    field.dtype !== "float64" ||
    field.formatVersion !== 3 ||
    field.nComp !== 6 ||
    complex.componentCount !== 3 ||
    field.quantityId !== metadata.fieldId ||
    !requiredString(field.domainGenerationId) ||
    field.domainGenerationId !== topology.domainGenerationId ||
    !requiredString(field.meshTopologyHash) ||
    field.meshTopologyHash !== topology.meshTopologyHash ||
    !requiredString(field.meshTopologyRevision) ||
    field.meshTopologyRevision !== topology.meshTopologyRevision ||
    field.indexing !== "full_domain" ||
    field.pointCount <= 0 ||
    field.pointCount !== topology.pointCount ||
    gridPointCount(field.grid) !== field.pointCount ||
    field.valueCount !== field.pointCount * field.nComp ||
    field.valueCount !== metadata.payloadValueCount ||
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

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requiredRevision(value: ResourceRevision | null): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return requiredString(value);
}

function stringArrayEquals(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function positiveInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function containsRequiredViews(views: readonly string[]): boolean {
  return ["complex", "real", "imag", "abs", "amplitude", "phase", "phase_rotated_real"]
    .every((view) => views.includes(view));
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
