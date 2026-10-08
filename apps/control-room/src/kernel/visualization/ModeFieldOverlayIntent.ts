import {
  asDecodedComplexFieldVector,
  type DecodedComplexFieldVector,
  type DecodedFieldVector,
} from "../api/codecs";
import type {
  AnalysisResultFieldRef,
  FieldVectorQuery,
  FrequencyDomainFieldResource,
  FrequencyDomainJsonArtifactResource,
  ResourceRevision,
} from "../api/apiTypes";
import type { SelectionRef } from "../selection/selectionTypes";
import {
  type AnalysisResultFieldOverlayIntent,
  type AnalysisResultFieldOverlayMetadata,
  resolveAnalysisResultFieldOverlayMetadata,
  validateAnalysisResultFieldOverlayBinary,
} from "./AnalysisResultFieldOverlayIntent";

type FrequencyDomainSelectionRef = Extract<
  SelectionRef,
  { type: "frequency-domain" }
>;

export interface ModeFieldOverlayIntent {
  readonly analysisRunId: string;
  readonly analysisStageId: string;
  readonly artifactRevision: string;
  readonly fieldId: string;
  readonly equilibriumId?: string;
  readonly metadataResourceKey: string;
  readonly modeId: string;
  readonly modeIndex: number;
  readonly nodeId: string;
  readonly sampleId: string;
  readonly sampleIndex: number;
}

export interface ResolvedModeFieldOverlayMetadata {
  readonly analysisResultFieldRef?: AnalysisResultFieldRef;
  readonly artifactPath: string;
  readonly availableViews: readonly string[];
  readonly binaryQuery: FieldVectorQuery;
  readonly defaultPhaseRad: number;
  readonly fieldId: string;
  readonly intent: ModeFieldOverlayIntent;
  readonly payloadValueCount: number | null;
  readonly resourceRevision: string;
}

export interface ModeFieldOverlayTopologyIdentity {
  readonly domainGenerationId: string | null;
  readonly meshId?: string | null;
  readonly meshTopologyHash: string | null;
  readonly meshTopologyRevision: string | null;
  readonly pointCount: number;
}

export interface ValidatedModeFieldOverlayBinary {
  readonly binary: DecodedFieldVector;
  readonly complex: DecodedComplexFieldVector;
  readonly phasorAmplitudeMax: number;
}

export function isEigenModeFrequencyDomainSelectionKind(
  kind: string | null | undefined,
): boolean {
  return kind === "results.eigen.mode" ||
    kind === "results.dispersion.modal.mode_at_k" ||
    kind === "results.resonance.modal.mode";
}

/**
 * Creates the kernel-owned identity for an eigenmode handoff. Presentation
 * indices remain only the temporary generated-API lookup bridge; cache and
 * completion identity use the artifact's stable sample/mode IDs.
 */
export function createModeFieldOverlayIntent(
  selection: FrequencyDomainSelectionRef | null | undefined,
): ModeFieldOverlayIntent | null {
  if (!selection || !isEigenModeFrequencyDomainSelectionKind(selection.kind)) return null;
  const analysisRunId = requiredString(selection.analysisRunId);
  const analysisStageId = requiredString(selection.analysisStageId);
  const artifactRevision = requiredString(selection.artifactRevision);
  const fieldId = requiredString(selection.fieldId);
  const equilibriumId = selection.equilibriumId == null
    ? null
    : requiredString(selection.equilibriumId);
  const modeId = requiredString(selection.modeId);
  const sampleId = requiredString(selection.sampleId);
  if (
    !analysisRunId ||
    !analysisStageId ||
    !artifactRevision ||
    !fieldId ||
    (selection.equilibriumId != null && !equilibriumId) ||
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
    ...(equilibriumId ? { equilibriumId } : {}),
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
 * Admits the generated field metadata only after the owned mode artifact
 * proves any sample-specific Eq identity. Topology identity is owned by the
 * FMVP binary header and checked against the active viewport topology later.
 */
export function resolveModeFieldOverlayMetadata(
  intent: ModeFieldOverlayIntent,
  metadata: FrequencyDomainFieldResource | AnalysisResultFieldRef,
  resourceRevision: ResourceRevision | null,
  modeArtifact?: FrequencyDomainJsonArtifactResource | null,
): ResolvedModeFieldOverlayMetadata | null {
  if (isAnalysisResultFieldOverlayIntent(intent)) {
    if (!("field_revision" in metadata)) return null;
    return resolveAnalysisResultFieldOverlayMetadata(intent);
  }
  const legacyMetadata = metadata as FrequencyDomainFieldResource;
  const fieldId = requiredString(legacyMetadata.field_id);
  const artifactPath = requiredString(legacyMetadata.artifact_path);
  const revision = requiredRevision(resourceRevision);
  const payloadValueCount = positiveInteger(legacyMetadata.payload_value_count);
  const complexPairCount = positiveInteger(legacyMetadata.complex_pair_count);
  const defaultPhaseRad = finiteNumber(legacyMetadata.default_phase_rad);

  if (
    legacyMetadata.status !== "ready" ||
    legacyMetadata.schema_version !== "frequency_domain_mode_field.v1" ||
    legacyMetadata.source_family !== "analysis/eigen" ||
    legacyMetadata.quantity !== "delta_m" ||
    legacyMetadata.value_kind !== "complex_spatial_vector" ||
    legacyMetadata.component_basis !== "global_xyz" ||
    legacyMetadata.component_count !== 3 ||
    !stringArrayEquals(legacyMetadata.components, ["x", "y", "z"]) ||
    legacyMetadata.payload_encoding !== "f64_interleaved_real_imag_xyz" ||
    legacyMetadata.binary_layout !== "complex_f64_pairs_little_endian" ||
    fieldId !== intent.fieldId ||
    !modeArtifactMatchesIntent(intent, modeArtifact) ||
    !artifactPath ||
    !revision ||
    payloadValueCount === null ||
    complexPairCount === null ||
    payloadValueCount !== complexPairCount * 2 ||
    payloadValueCount % 6 !== 0 ||
    defaultPhaseRad === null ||
    !containsRequiredViews(legacyMetadata.available_views) ||
    !legacyMetadata.available_views.includes(legacyMetadata.default_view)
  ) {
    return null;
  }

  return Object.freeze({
    artifactPath,
    availableViews: Object.freeze([...legacyMetadata.available_views]),
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
  if (isAnalysisResultFieldOverlayIntent(metadata.intent)) {
    const validated = validateAnalysisResultFieldOverlayBinary(
      metadata as AnalysisResultFieldOverlayMetadata,
      field,
      topology,
    );
    return validated;
  }
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

function isAnalysisResultFieldOverlayIntent(
  intent: ModeFieldOverlayIntent,
): intent is AnalysisResultFieldOverlayIntent {
  return (
    (intent as ModeFieldOverlayIntent & { sourceKind?: unknown }).sourceKind ===
    "analysis-result"
  );
}

function modeArtifactMatchesIntent(
  intent: ModeFieldOverlayIntent,
  modeArtifact: FrequencyDomainJsonArtifactResource | null | undefined,
): boolean {
  if (!modeArtifact) return intent.equilibriumId === undefined;
  if (modeArtifact.status !== "ready") return false;

  const artifact = recordValue(modeArtifact);
  const payload = recordValue(modeArtifact.payload);
  if (
    !artifact ||
    !payload ||
    !(requiredString(modeArtifact.revision) ?? requiredString(modeArtifact.content_digest)) ||
    requiredString(modeArtifact.run_id) !== intent.analysisRunId ||
    requiredString(modeArtifact.stage_id) !== intent.analysisStageId
  ) {
    return false;
  }
  if (
    !optionalStringPropertyMatches(
      ownProperty(payload, "run_id"),
      intent.analysisRunId,
    ) ||
    !optionalStringPropertyMatches(
      ownProperty(payload, "stage_id"),
      intent.analysisStageId,
    ) ||
    !optionalStringPropertyMatches(
      ownProperty(payload, "sample_id"),
      intent.sampleId,
    ) ||
    !optionalStringPropertyMatches(
      ownProperty(payload, "mode_id"),
      intent.modeId,
    )
  ) {
    return false;
  }

  if (
    !numberPropertiesMatch([ownProperty(payload, "sample_index")], intent.sampleIndex) ||
    !numberPropertiesMatch([ownProperty(payload, "raw_mode_index")], intent.modeIndex) ||
    !stringPropertiesMatch([ownProperty(payload, "mode_field_id")], intent.fieldId)
  ) {
    return false;
  }

  const identitySources = [artifact, payload];
  const topLevelEquilibriumProperties = presentProperties(
    identitySources,
    "equilibrium_artifact_sha256",
  );
  const candidateProperties = identitySources.map(candidateEquilibriumProperty);
  if (candidateProperties.some((property) => property.malformed)) return false;
  const candidateEqProperties = candidateProperties.flatMap((property) =>
    property.equilibriumProperty.present
      ? [property.equilibriumProperty]
      : [],
  );
  const payloadCandidate = candidateEquilibriumProperty(payload);
  if (payloadCandidate.malformed) return false;

  if (intent.equilibriumId !== undefined) {
    const expected = requiredString(intent.equilibriumId);
    const payloadTopLevelEq = ownProperty(payload, "equilibrium_artifact_sha256");
    return expected !== null &&
      payloadTopLevelEq.present &&
      candidateEqProperties.length > 0 &&
      payloadCandidate.present &&
      payloadCandidate.equilibriumProperty.present &&
      candidateProperties.every((property) =>
        !property.present || property.equilibriumProperty.present,
      ) &&
      [...topLevelEquilibriumProperties, ...candidateEqProperties].every(
        (property) =>
          typeof property.value === "string" &&
          property.value.trim().length > 0 &&
          property.value === expected,
      );
  }

  // Historical selections without Eq remain valid only while the owned mode
  // artifact itself publishes no Eq-bearing identity fields.
  return topLevelEquilibriumProperties.length === 0 &&
    candidateEqProperties.length === 0;
}

interface PublishedIdentityProperty {
  present: boolean;
  value: unknown;
}

interface CandidateEquilibriumProperty {
  equilibriumProperty: PublishedIdentityProperty;
  malformed: boolean;
  present: boolean;
}

function presentProperties(
  sources: readonly Record<string, unknown>[],
  key: string,
): PublishedIdentityProperty[] {
  return sources
    .map((source) => ownProperty(source, key))
    .filter((property) => property.present);
}

function optionalStringPropertyMatches(
  property: PublishedIdentityProperty,
  expected: string,
): boolean {
  return !property.present || (
    typeof property.value === "string" &&
    property.value.trim().length > 0 &&
    property.value === expected
  );
}

function stringPropertiesMatch(
  properties: readonly PublishedIdentityProperty[],
  expected: string,
): boolean {
  return properties.length > 0 && properties.every((property) =>
    typeof property.value === "string" &&
    property.value.trim().length > 0 &&
    property.value === expected,
  );
}

function numberPropertiesMatch(
  properties: readonly PublishedIdentityProperty[],
  expected: number,
): boolean {
  return properties.length > 0 && properties.every((property) =>
    typeof property.value === "number" &&
    Number.isSafeInteger(property.value) &&
    property.value === expected,
  );
}

function candidateEquilibriumProperty(
  source: Record<string, unknown>,
): CandidateEquilibriumProperty {
  const candidate = ownProperty(source, "candidate_identity");
  if (!candidate.present || candidate.value === null) {
    return {
      equilibriumProperty: { present: false, value: undefined },
      malformed: false,
      present: false,
    };
  }
  const candidateRecord = recordValue(candidate.value);
  if (!candidateRecord) {
    return {
      equilibriumProperty: { present: false, value: undefined },
      malformed: true,
      present: true,
    };
  }
  return {
    equilibriumProperty: ownProperty(
      candidateRecord,
      "equilibrium_artifact_sha256",
    ),
    malformed: false,
    present: true,
  };
}

function ownProperty(
  source: Record<string, unknown>,
  key: string,
): PublishedIdentityProperty {
  if (!Object.prototype.hasOwnProperty.call(source, key)) {
    return { present: false, value: undefined };
  }
  return { present: true, value: source[key] };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
