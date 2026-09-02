import type {
  FrequencyDomainBranchesArtifactPayload,
  FrequencyDomainFieldSweepArtifactPayload,
  FrequencyDomainFmrPeaksArtifactPayload,
  FrequencyDomainJsonArtifactPayload,
  FrequencyDomainJsonArtifactResource,
  FrequencyDomainManifestResource,
  FrequencyDomainResponseSweepArtifactPayload,
  FrequencyDomainSpectrumArtifactPayload,
  FrequencyDomainSweepProgressResource,
  FrequencyDomainTextArtifactResource,
} from "@/kernel/api/apiTypes";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import type { components } from "@/kernel/api/generated/openapi-v2-types";

import type { ResultsSelectionRef } from "./resultsNavigatorSelection";

export type NavigatorNodeStatus =
  | "loading"
  | "ready"
  | "missing"
  | "unsupported"
  | "partial"
  | "error";

export type ResultsNavigatorNodeKind =
  | "results.root"
  | "results.runs"
  | "results.run"
  | "results.stage"
  | "results.frequency-domain"
  | "results.frequency-domain.overview"
  | "results.frequency-domain.modal-eigen"
  | "results.frequency-domain.spectrum"
  | "results.frequency-domain.field-sweep"
  | "results.frequency-domain.dispersion"
  | "results.frequency-domain.samples"
  | "results.frequency-domain.sample"
  | "results.frequency-domain.modes"
  | "results.frequency-domain.mode"
  | "results.frequency-domain.mode-metadata"
  | "results.frequency-domain.mode-field"
  | "results.frequency-domain.mode-residuals"
  | "results.frequency-domain.branches"
  | "results.frequency-domain.branch"
  | "results.frequency-domain.driven-response"
  | "results.frequency-domain.frequency-sweep"
  | "results.frequency-domain.frequency-points"
  | "results.frequency-domain.response-point"
  | "results.frequency-domain.response-observables"
  | "results.frequency-domain.response-field"
  | "results.frequency-domain.progress"
  | "results.frequency-domain.response-diagnostics"
  | "results.frequency-domain.fmr-views"
  | "results.frequency-domain.modal-resonances"
  | "results.frequency-domain.driven-sweep"
  | "results.frequency-domain.peaks"
  | "results.frequency-domain.peak"
  | "results.frequency-domain.resonance-fits"
  | "results.frequency-domain.resonance-fit"
  | "results.frequency-domain.kittel-fit"
  | "results.frequency-domain.field-frequency-map"
  | "results.frequency-domain.modal-driven-comparison"
  | "results.frequency-domain.validation"
  | "results.frequency-domain.validation-child"
  | "results.frequency-domain.artifacts";

export interface NavigatorIdentity {
  runId: string;
  stageId: string;
}

export interface NavigatorArtifactDescriptor {
  artifactPath: string;
  missingReason: string | null;
  resourceKey: string;
  resourceRevision: string | null;
  schemaVersion: string;
  status: string;
}

export interface NavigatorProgressDescriptor {
  complete: boolean;
  completedFrequencyPoints: number;
  missingReason: string | null;
  partialArtifactsAvailable: boolean;
  state: string;
  status: string;
  totalFrequencyPoints: number;
}

export interface NavigatorModeDescriptor {
  branchId: string | null;
  displayModeIndex: number;
  frequencyHz: number | null;
  modeId: string | null;
  rawModeIndex: number;
  residualNorm?: number | null;
}

export interface NavigatorSampleDescriptor {
  label?: string | null;
  modes: readonly NavigatorModeDescriptor[];
  sampleId: string;
  sampleIndex: number;
  stableIdentityAvailable?: boolean;
}

export interface NavigatorSpectrumPayload {
  samples: readonly NavigatorSampleDescriptor[];
}

export interface NavigatorFieldSweepDisplayConversion {
  name: string;
  scale: number;
  unit: string;
}

export interface NavigatorFieldSweepAxis {
  coordinate: string;
  displayConversions: readonly NavigatorFieldSweepDisplayConversion[];
  kind: string;
  unit: string;
}

export interface NavigatorFieldSweepSource {
  artifact: string;
  kind: string;
  revision: string;
}

export interface NavigatorFieldSweepUnits {
  angularFrequency: string;
  biasField: string;
  biasFieldDisplay: string;
  covariance: string | null;
  frequency: string;
  linewidth: string | null;
  qFactor: string | null;
  responseAmplitude: string | null;
}

export interface NavigatorFieldSweepTopology {
  indexing: string;
  meshId: string;
  modeAxis: string;
  nodeCount: number | null;
  sampleAxis: string;
  topologyRevision: string;
}

export interface NavigatorFieldSweepExecution {
  backend: string;
  device: string;
  engine: string;
  executionMode: string;
  fallbackReason: string | null;
  fallbackUsed: boolean | null;
  implementationId: string | null;
  precision: string;
  status: string;
}

export interface NavigatorFieldSweepReference {
  artifact: string;
  relation: string;
  revision: string;
}

export type NavigatorFieldSweepJoinState =
  | "compatible"
  | "not_checked"
  | "stale"
  | "unavailable";

export interface NavigatorFieldSweepModeDescriptor extends NavigatorModeDescriptor {
  angularFrequencyRadPerS: number | null;
  fieldAvailability: "available" | "unavailable";
  fieldStatus: string | null;
  modeArtifactPath: string | null;
  modeFieldId: string | null;
  modeFieldResourceKey: string | null;
  modeSourceRevision: string | null;
  sampleId: string;
  status: string;
}

export interface NavigatorFieldSweepSampleDescriptor extends NavigatorSampleDescriptor {
  biasFieldAPerM: readonly [number, number, number] | null;
  biasFieldMu0T: readonly [number, number, number] | null;
  branchIds: readonly string[];
  fieldAvailableCount: number;
  fieldModeCount: number;
  modes: readonly NavigatorFieldSweepModeDescriptor[];
  scanAxis: NavigatorFieldSweepAxis | null;
  sourceRevision: string | null;
  status: string;
  stopReason: string | null;
  topology: NavigatorFieldSweepTopology | null;
}

export interface NavigatorFieldSweepPayload {
  artifactId: string | null;
  axis: NavigatorFieldSweepAxis | null;
  complete: boolean | null;
  completedSampleCount: number | null;
  contentSha256: string | null;
  crossArtifactRefs: readonly NavigatorFieldSweepReference[];
  datasetRevision: string | null;
  interrupted: boolean | null;
  joins: {
    branches: NavigatorFieldSweepJoinState;
    spectrum: NavigatorFieldSweepJoinState;
  };
  requestedExecution: NavigatorFieldSweepExecution | null;
  requestedSampleCount: number | null;
  resolvedExecution: NavigatorFieldSweepExecution | null;
  runId: string | null;
  samples: readonly NavigatorFieldSweepSampleDescriptor[];
  scopeId: string | null;
  source: NavigatorFieldSweepSource | null;
  sourceBranchesRevision: string | null;
  sourceRevision: string | null;
  sourceSpectrumRevision: string | null;
  stageId: string | null;
  status: string | null;
  stopReason: string | null;
  topology: NavigatorFieldSweepTopology | null;
  units: NavigatorFieldSweepUnits | null;
  runtimeId: string | null;
}

export interface NavigatorBranchDescriptor {
  branchId: string;
  modeCount?: number | null;
  stableIdentityAvailable?: boolean;
}

export interface NavigatorBranchesPayload {
  branches: readonly NavigatorBranchDescriptor[];
}

export interface NavigatorResponsePointDescriptor {
  frequencyHz?: number | null;
  pointId: string | null;
  frequencyIndex: number;
  stableIdentityAvailable?: boolean;
}

export interface NavigatorResponsePayload {
  points: readonly NavigatorResponsePointDescriptor[];
}

export interface NavigatorFmrPeakDescriptor {
  frequencyHz: number;
  peakId: string;
  stableIdentityAvailable?: boolean;
}

export interface NavigatorFmrPayload {
  peaks: readonly NavigatorFmrPeakDescriptor[];
}

export interface NavigatorFmrFitDescriptor {
  fitId: string;
  stableIdentityAvailable?: boolean;
}

export interface NavigatorFmrResonanceFitsPayload {
  fits: readonly NavigatorFmrFitDescriptor[];
}

export interface NavigatorManifestSummary {
  eigenStatus: string;
  eigenReason?: string | null;
  responseStatus: string;
  responseReason?: string | null;
}

export interface FrequencyDomainNavigatorResources {
  branches: NavigatorArtifactDescriptor | null;
  dispersion: NavigatorArtifactDescriptor | null;
  fieldSweep?: NavigatorArtifactDescriptor | null;
  response: NavigatorArtifactDescriptor | null;
  responseDiagnostics?: NavigatorArtifactDescriptor | null;
  resultManifest?: NavigatorArtifactDescriptor | null;
  spectrum: NavigatorArtifactDescriptor | null;
  states?: Partial<Record<"branches" | "dispersion" | "fieldSweep" | "response" | "responseDiagnostics" | "resultManifest" | "spectrum", NavigatorNodeStatus>>;
}

export interface FrequencyDomainNavigatorInput {
  branches?: NavigatorBranchesPayload | null;
  fieldSweep?: NavigatorFieldSweepPayload | null;
  fmr?: {
    fieldFrequencyMap?: NavigatorArtifactDescriptor | null;
    kittelFit?: NavigatorArtifactDescriptor | null;
    modalResonances?: NavigatorArtifactDescriptor | null;
    modalDrivenComparison?: NavigatorArtifactDescriptor | null;
    peaks?: NavigatorArtifactDescriptor | null;
    resonanceFits?: NavigatorArtifactDescriptor | null;
    payload?: NavigatorFmrPayload | null;
    resonanceFitsPayload?: NavigatorFmrResonanceFitsPayload | null;
    states?: Partial<Record<"kittelFit" | "peaks" | "resonanceFits", NavigatorNodeStatus>>;
  } | null;
  identity: NavigatorIdentity | null;
  manifest: NavigatorManifestSummary | null;
  manifestState?: NavigatorNodeStatus;
  progress?: NavigatorProgressDescriptor | null;
  progressState?: NavigatorNodeStatus;
  response?: NavigatorResponsePayload | null;
  resources: FrequencyDomainNavigatorResources;
  spectrum: NavigatorSpectrumPayload | null;
}

export interface ResultsNavigatorCollection {
  pageCount: number;
  pageSize: number;
  totalCount: number;
}

export interface ResultsNavigatorNode {
  children?: ResultsNavigatorNode[];
  collection?: ResultsNavigatorCollection;
  id: string;
  inspectorId: string;
  kind: ResultsNavigatorNodeKind;
  label: string;
  parentId: string | null;
  resourceKey: string;
  resourceRevision?: string;
  selectionRef?: ResultsSelectionRef;
  status: NavigatorNodeStatus;
  statusReason?: string;
}

export interface NavigatorPage<T> {
  hasNext: boolean;
  hasPrevious: boolean;
  items: readonly T[];
  page: number;
  pageCount: number;
  pageSize: number;
  startIndex: number;
  total: number;
}

export type NavigatorResourceResult<T> = Pick<
  ResourceResult<T>,
  "data" | "error" | "revision" | "status"
>;

function artifactResourceRevision(
  resource: FrequencyDomainJsonArtifactResource | FrequencyDomainTextArtifactResource,
): string | null {
  if ("revision" in resource) {
    return resource.revision ?? (
      "content_digest" in resource ? resource.content_digest ?? null : null
    );
  }
  return "content_digest" in resource ? resource.content_digest ?? null : null;
}

export function navigatorArtifactFromResource(
  resource: FrequencyDomainJsonArtifactResource | FrequencyDomainTextArtifactResource | null | undefined,
): NavigatorArtifactDescriptor | null {
  if (!resource) return null;
  return {
    artifactPath: resource.artifact_path,
    missingReason: resource.missing_reason ?? null,
    resourceKey: resource.resource_key,
    resourceRevision: artifactResourceRevision(resource),
    schemaVersion: resource.schema_version,
    status: resource.status,
  };
}

type NavigatorFmrFitArtifactKind = "kittel" | "resonance-fits";

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizedStatusToken(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[-\s]+/g, "_")
    : "";
}

function corruptFitArtifact(
  descriptor: NavigatorArtifactDescriptor,
  label: string,
): NavigatorArtifactDescriptor {
  return {
    ...descriptor,
    missingReason: `${label} artifact payload is corrupt.`,
    status: "corrupt",
  };
}

function partialFitArtifact(
  descriptor: NavigatorArtifactDescriptor,
  label: string,
): NavigatorArtifactDescriptor {
  return {
    ...descriptor,
    missingReason:
      descriptor.missingReason ??
      `${label} artifact is partial; published units or source revision are incomplete.`,
    status: "partial",
  };
}

function hasPublishedUnits(payload: Record<string, unknown>): boolean {
  const units = objectRecord(payload.units);
  return Boolean(nonEmptyString(units?.frequency));
}

function hasCompleteResonanceFits(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.fits)) return false;
  return payload.fits.every((entry) => {
    const fit = objectRecord(entry);
    return Boolean(
      nonEmptyString(fit?.fit_id) &&
        nonEmptyString(fit?.source_peak_revision) &&
        objectRecord(fit?.uncertainty),
    );
  });
}

function hasCompleteKittelFit(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.parameters) || !Array.isArray(payload.points)) {
    return false;
  }
  const parametersAreValid = payload.parameters.every((entry) => {
    const parameter = objectRecord(entry);
    return Boolean(
      nonEmptyString(parameter?.name) &&
        nonEmptyString(parameter?.unit) &&
        typeof parameter?.value === "number" &&
        Number.isFinite(parameter.value),
    );
  });
  const pointsAreValid = payload.points.every((entry) => {
    const point = objectRecord(entry);
    return Boolean(
      nonEmptyString(point?.sample_id) &&
        Array.isArray(point?.bias_field_a_per_m) &&
        point.bias_field_a_per_m.every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ) &&
        typeof point?.solved_frequency_hz === "number" &&
        Number.isFinite(point.solved_frequency_hz),
    );
  });
  return parametersAreValid && pointsAreValid;
}

function navigatorFmrFitArtifactFromResource(
  resource: FrequencyDomainJsonArtifactResource | null | undefined,
  kind: NavigatorFmrFitArtifactKind,
): NavigatorArtifactDescriptor | null {
  const descriptor = navigatorArtifactFromResource(resource);
  if (!descriptor || !resource) return null;

  const label = kind === "kittel" ? "Kittel fit" : "Resonance fits";
  const artifactStatus = normalizedStatusToken(resource.status);
  if (
    artifactStatus === "missing" ||
    artifactStatus === "absent" ||
    artifactStatus === "not_found" ||
    resource.missing_reason
  ) {
    return descriptor;
  }
  if (
    artifactStatus === "corrupt" ||
    artifactStatus === "invalid" ||
    artifactStatus === "malformed" ||
    artifactStatus === "error" ||
    artifactStatus === "failed"
  ) {
    return corruptFitArtifact(descriptor, label);
  }

  const payload = objectRecord(resource.payload);
  const expectedSchema = kind === "kittel" ? "kittel_fit" : "resonance_fits";
  const schemaVersion = nonEmptyString(payload?.schema_version);
  if (!payload || !schemaVersion?.includes(expectedSchema)) {
    return corruptFitArtifact(descriptor, label);
  }

  const payloadStatus = normalizedStatusToken(payload.status);
  if (
    payloadStatus === "corrupt" ||
    payloadStatus === "invalid" ||
    payloadStatus === "malformed" ||
    payloadStatus === "error" ||
    payloadStatus === "failed"
  ) {
    return corruptFitArtifact(descriptor, label);
  }

  const requiredCollectionsAreValid =
    kind === "kittel"
      ? hasCompleteKittelFit(payload)
      : hasCompleteResonanceFits(payload);
  if (!requiredCollectionsAreValid) {
    return corruptFitArtifact(descriptor, label);
  }

  if (
    artifactStatus === "partial" ||
    payload.complete !== true ||
    payloadStatus === "partial" ||
    payloadStatus === "incomplete" ||
    !nonEmptyString(payload.source_revision) ||
    !hasPublishedUnits(payload)
  ) {
    return partialFitArtifact(descriptor, label);
  }

  return {
    ...descriptor,
    missingReason: null,
    status: "ready",
  };
}

export function navigatorResonanceFitsArtifactFromResource(
  resource: FrequencyDomainJsonArtifactResource | null | undefined,
): NavigatorArtifactDescriptor | null {
  return navigatorFmrFitArtifactFromResource(resource, "resonance-fits");
}

export function navigatorKittelFitArtifactFromResource(
  resource: FrequencyDomainJsonArtifactResource | null | undefined,
): NavigatorArtifactDescriptor | null {
  return navigatorFmrFitArtifactFromResource(resource, "kittel");
}

function payloadSchemaVersion(
  payload: FrequencyDomainJsonArtifactPayload,
): string | null {
  const value = payload["schema_version"];
  return typeof value === "string" ? value : null;
}

function isSpectrumPayload(
  payload: FrequencyDomainJsonArtifactPayload,
): payload is FrequencyDomainSpectrumArtifactPayload {
  const schemaVersion = payloadSchemaVersion(payload);
  return Boolean(schemaVersion?.includes("spectrum")) && Array.isArray(payload["samples"]);
}

function isBranchesPayload(
  payload: FrequencyDomainJsonArtifactPayload,
): payload is FrequencyDomainBranchesArtifactPayload {
  const schemaVersion = payloadSchemaVersion(payload);
  return Boolean(schemaVersion?.includes("branches")) && Array.isArray(payload["branches"]);
}

function isResponseSweepPayload(
  payload: FrequencyDomainJsonArtifactPayload,
): payload is FrequencyDomainResponseSweepArtifactPayload {
  const schemaVersion = payloadSchemaVersion(payload);
  return Boolean(schemaVersion?.includes("response")) && Array.isArray(payload["points"]);
}

function isFmrPeaksPayload(
  payload: FrequencyDomainJsonArtifactPayload,
): payload is FrequencyDomainFmrPeaksArtifactPayload {
  const schemaVersion = payloadSchemaVersion(payload);
  return Boolean(schemaVersion?.includes("fmr")) && Array.isArray(payload["peaks"]);
}

function isResonanceFitsPayload(
  payload: FrequencyDomainJsonArtifactPayload,
): payload is components["schemas"]["FrequencyDomainResonanceFitsArtifactPayload"] {
  const schemaVersion = payloadSchemaVersion(payload);
  return Boolean(schemaVersion?.includes("resonance_fits")) && Array.isArray(payload["fits"]);
}

function isFieldSweepPayload(
  payload: FrequencyDomainJsonArtifactPayload,
): payload is FrequencyDomainFieldSweepArtifactPayload {
  const schemaVersion = payloadSchemaVersion(payload);
  return Boolean(schemaVersion?.includes("field_sweep")) && Array.isArray(payload["samples"]);
}

function hasCompleteFieldSweepContract(
  payload: FrequencyDomainFieldSweepArtifactPayload,
): boolean {
  return Boolean(
    fieldSweepSourceFromPayload(payload.source)
      && nonEmptyString(payload.source_revision)
      && nonEmptyString(payload.revision)
      && finiteNumber(payload.requested_sample_count) != null
      && finiteNumber(payload.completed_sample_count) != null
      && fieldSweepAxisFromPayload(payload.scan_axis)
      && fieldSweepUnitsFromPayload(payload.units)
      && fieldSweepTopologyFromPayload(payload.topology)
      && fieldSweepExecutionFromPayload(payload.requested_execution)
      && fieldSweepExecutionFromPayload(payload.resolved_execution)
      && Array.isArray(payload.samples)
      && Array.isArray(payload.cross_artifact_refs),
  );
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteTuple(value: unknown): readonly [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const tuple = value.map(finiteNumber);
  return tuple.every((item): item is number => item != null)
    ? [tuple[0], tuple[1], tuple[2]]
    : null;
}

function fieldSweepAxisFromPayload(
  axis: FrequencyDomainFieldSweepArtifactPayload["scan_axis"],
): NavigatorFieldSweepAxis | null {
  if (!axis) return null;
  const kind = nonEmptyString(axis.kind);
  const coordinate = nonEmptyString(axis.coordinate);
  const unit = nonEmptyString(axis.unit);
  if (!kind || !coordinate || !unit) return null;
  return {
    coordinate,
    displayConversions: (axis.display_conversions ?? [])
      .map((conversion) => {
        const name = nonEmptyString(conversion.name);
        const conversionUnit = nonEmptyString(conversion.unit);
        const scale = finiteNumber(conversion.scale);
        return name && conversionUnit && scale != null
          ? { name, scale, unit: conversionUnit }
          : null;
      })
      .filter((conversion): conversion is NavigatorFieldSweepDisplayConversion => conversion != null),
    kind,
    unit,
  };
}

function fieldSweepSourceFromPayload(
  source: FrequencyDomainFieldSweepArtifactPayload["source"],
): NavigatorFieldSweepSource | null {
  if (!source) return null;
  const artifact = nonEmptyString(source.artifact);
  const kind = nonEmptyString(source.kind);
  const revision = nonEmptyString(source.revision);
  return artifact && kind && revision ? { artifact, kind, revision } : null;
}

function fieldSweepUnitsFromPayload(
  units: FrequencyDomainFieldSweepArtifactPayload["units"],
): NavigatorFieldSweepUnits | null {
  if (!units) return null;
  const frequency = nonEmptyString(units.frequency);
  const angularFrequency = nonEmptyString(units.angular_frequency);
  const biasField = nonEmptyString(units.bias_field);
  const biasFieldDisplay = nonEmptyString(units.bias_field_display);
  if (!frequency || !angularFrequency || !biasField || !biasFieldDisplay) return null;
  return {
    angularFrequency,
    biasField,
    biasFieldDisplay,
    covariance: nonEmptyString(units.covariance),
    frequency,
    linewidth: nonEmptyString(units.linewidth),
    qFactor: nonEmptyString(units.q_factor),
    responseAmplitude: nonEmptyString(units.response_amplitude),
  };
}

function fieldSweepTopologyFromPayload(
  topology: FrequencyDomainFieldSweepArtifactPayload["topology"],
): NavigatorFieldSweepTopology | null {
  if (!topology) return null;
  const meshId = nonEmptyString(topology.mesh_id);
  const topologyRevision = nonEmptyString(topology.topology_revision);
  const indexing = nonEmptyString(topology.indexing);
  const sampleAxis = nonEmptyString(topology.sample_axis);
  const modeAxis = nonEmptyString(topology.mode_axis);
  if (!meshId || !topologyRevision || !indexing || !sampleAxis || !modeAxis) return null;
  return {
    indexing,
    meshId,
    modeAxis,
    nodeCount: finiteNumber(topology.node_count),
    sampleAxis,
    topologyRevision,
  };
}

function fieldSweepExecutionFromPayload(
  execution: FrequencyDomainFieldSweepArtifactPayload["requested_execution"],
): NavigatorFieldSweepExecution | null {
  if (!execution) return null;
  const backend = nonEmptyString(execution.backend);
  const device = nonEmptyString(execution.device);
  const engine = nonEmptyString(execution.engine);
  const executionMode = nonEmptyString(execution.execution_mode);
  const precision = nonEmptyString(execution.precision);
  const status = nonEmptyString(execution.status);
  if (!backend || !device || !engine || !executionMode || !precision || !status) return null;
  return {
    backend,
    device,
    engine,
    executionMode,
    fallbackReason: nonEmptyString(execution.fallback_reason),
    fallbackUsed: execution.fallback_used ?? null,
    implementationId: nonEmptyString(execution.implementation_id),
    precision,
    status,
  };
}

function fieldSweepModeFromPayload(
  mode: NonNullable<
    NonNullable<FrequencyDomainFieldSweepArtifactPayload["samples"]>[number]["modes"]
  >[number],
  sampleId: string,
  position: number,
): NavigatorFieldSweepModeDescriptor {
  const rawModeIndex = Math.max(0, Math.trunc(finiteNumber(mode.raw_mode_index) ?? position));
  const modeFieldId = nonEmptyString(mode.mode_field_id);
  const modeFieldResourceKey = nonEmptyString(mode.mode_field_resource_key);
  const hasFieldIdentity = Boolean(modeFieldId && modeFieldResourceKey);
  return {
    angularFrequencyRadPerS: finiteNumber(mode.angular_frequency_rad_per_s),
    branchId: mode.branch_id == null ? null : String(mode.branch_id),
    displayModeIndex: rawModeIndex,
    fieldAvailability: hasFieldIdentity ? "available" : "unavailable",
    fieldStatus: nonEmptyString(mode.field_status),
    frequencyHz: finiteNumber(mode.frequency_hz),
    modeArtifactPath: nonEmptyString(mode.mode_artifact_path),
    modeFieldId: hasFieldIdentity ? modeFieldId : null,
    modeFieldResourceKey: hasFieldIdentity ? modeFieldResourceKey : null,
    modeId: nonEmptyString(mode.mode_id),
    modeSourceRevision: nonEmptyString(mode.source_revision),
    rawModeIndex,
    residualNorm: finiteNumber(mode.residual_relative_l2),
    sampleId: nonEmptyString(mode.sample_id) ?? sampleId,
    status: nonEmptyString(mode.status) ?? "unknown",
  };
}

function formatFieldSweepNumber(value: number): string {
  return value.toFixed(1);
}

export function formatFieldSweepSampleLabel(
  sample: Pick<
    NavigatorFieldSweepSampleDescriptor,
    "biasFieldAPerM" | "biasFieldMu0T" | "scanAxis" | "sampleId"
  >,
): string {
  const conversion = sample.scanAxis?.displayConversions.find(
    (item) => item.name === "mu0_H" || item.name === "μ₀H",
  );
  const displayField = sample.biasFieldMu0T
    ?? (sample.biasFieldAPerM && conversion
      ? [
          sample.biasFieldAPerM[0] * conversion.scale,
          sample.biasFieldAPerM[1] * conversion.scale,
          sample.biasFieldAPerM[2] * conversion.scale,
        ] as const
      : null);
  if (!displayField) return `Sample ${sample.sampleId}`;

  const componentIndex = displayField.reduce(
    (best, value, index, values) =>
      Math.abs(value) > Math.abs(values[best] ?? 0) ? index : best,
    0,
  );
  const component = ["x", "y", "z"][componentIndex] ?? "x";
  return `μ₀ H${component} = ${formatFieldSweepNumber(displayField[componentIndex] * 1000)} mT`;
}

function fieldSweepSampleFromPayload(
  sample: NonNullable<FrequencyDomainFieldSweepArtifactPayload["samples"]>[number],
  position: number,
  axis: NavigatorFieldSweepAxis | null,
  topology: NavigatorFieldSweepTopology | null,
  sourceRevision: string | null,
): NavigatorFieldSweepSampleDescriptor {
  const sampleId = nonEmptyString(sample.sample_id) ?? `sample-${position}`;
  const modes = (sample.modes ?? []).map((mode, modePosition) =>
    fieldSweepModeFromPayload(mode, sampleId, modePosition),
  );
  const sampleAxis = fieldSweepAxisFromPayload(sample.scan_axis) ?? axis;
  const sampleTopology = fieldSweepTopologyFromPayload(sample.topology) ?? topology;
  const biasFieldAPerM = finiteTuple(sample.bias_field_a_per_m);
  const biasFieldMu0T = finiteTuple(sample.bias_field_mu0_t);
  const branchIds = [...new Set((sample.branch_ids ?? []).map((branchId) => String(branchId)))];
  return {
    biasFieldAPerM,
    biasFieldMu0T,
    branchIds,
    fieldAvailableCount: modes.filter((mode) => mode.fieldAvailability === "available").length,
    fieldModeCount: modes.length,
    label: formatFieldSweepSampleLabel({
      biasFieldAPerM,
      biasFieldMu0T,
      sampleId,
      scanAxis: sampleAxis,
    }),
    modes,
    sampleId,
    sampleIndex: Math.max(0, Math.trunc(finiteNumber(sample.sample_index) ?? position)),
    scanAxis: sampleAxis,
    sourceRevision,
    stableIdentityAvailable: nonEmptyString(sample.sample_id) != null,
    status: nonEmptyString(sample.status) ?? "unknown",
    stopReason: nonEmptyString(sample.stop_reason),
    topology: sampleTopology,
  };
}

function fieldSweepSamplesMatchSpectrum(
  samples: readonly NavigatorFieldSweepSampleDescriptor[],
  spectrum: NavigatorSpectrumPayload,
): boolean {
  const bySampleId = new Map(spectrum.samples.map((sample) => [sample.sampleId, sample]));
  return samples.every((sample) => {
    if (sample.stableIdentityAvailable === false) return false;
    const companion = bySampleId.get(sample.sampleId);
    return Boolean(
      companion
        && sample.modes.every(
          (mode) =>
            mode.modeId == null
              || companion.modes.some((companionMode) => companionMode.modeId === mode.modeId),
        ),
    );
  });
}

function fieldSweepSamplesMatchBranches(
  samples: readonly NavigatorFieldSweepSampleDescriptor[],
  branches: NavigatorBranchesPayload,
): boolean {
  const branchIds = new Set(branches.branches.map((branch) => branch.branchId));
  return samples.every((sample) =>
    [...sample.branchIds, ...sample.modes.flatMap((mode) => mode.branchId ? [mode.branchId] : [])]
      .every((branchId) => branchIds.has(branchId)),
  );
}

function fieldSweepJoinState(
  sourceRevision: string | null,
  companionRevision: string | null | undefined,
  companionAvailable: boolean,
  matches: boolean,
): NavigatorFieldSweepJoinState {
  if (!companionAvailable) return "unavailable";
  if (!sourceRevision || !companionRevision) return "not_checked";
  return sourceRevision === companionRevision && matches ? "compatible" : "stale";
}

export interface NavigatorFieldSweepCompanions {
  branches?: NavigatorBranchesPayload | null;
  branchesRevision?: string | null;
  spectrum?: NavigatorSpectrumPayload | null;
  spectrumRevision?: string | null;
}

export function navigatorFieldSweepFromResource(
  resource: FrequencyDomainJsonArtifactResource | null | undefined,
  companions: NavigatorFieldSweepCompanions = {},
): NavigatorFieldSweepPayload | null {
  const payload = resource?.payload;
  if (!payload || !isFieldSweepPayload(payload)) return null;

  const hasTypedContract = hasCompleteFieldSweepContract(payload);
  const axis = fieldSweepAxisFromPayload(payload.scan_axis);
  const sourceRevision = nonEmptyString(payload.source_revision);
  const samples = (payload.samples ?? []).map((sample, position) =>
    fieldSweepSampleFromPayload(
      sample,
      position,
      axis,
      fieldSweepTopologyFromPayload(payload.topology),
      sourceRevision,
    ),
  );
  const crossArtifactRefs = (payload.cross_artifact_refs ?? [])
    .map((reference) => {
      const artifact = nonEmptyString(reference.artifact);
      const relation = nonEmptyString(reference.relation);
      const revision = nonEmptyString(reference.revision);
      return artifact && relation && revision ? { artifact, relation, revision } : null;
    })
    .filter((reference): reference is NavigatorFieldSweepReference => reference != null);
  const sourceSpectrumRevision =
    crossArtifactRefs.find((reference) => reference.relation === "source_spectrum")?.revision ?? null;
  const sourceBranchesRevision =
    crossArtifactRefs.find((reference) => reference.relation === "source_branches")?.revision ?? null;
  const datasetRevision =
    nonEmptyString(payload.revision) ?? artifactResourceRevision(resource);

  return {
    artifactId: nonEmptyString(payload.artifact_id),
    axis,
    complete: hasTypedContract ? payload.complete ?? null : false,
    completedSampleCount: finiteNumber(payload.completed_sample_count),
    contentSha256: nonEmptyString(payload.content_sha256),
    crossArtifactRefs,
    datasetRevision,
    interrupted: payload.interrupted ?? null,
    joins: {
      branches: fieldSweepJoinState(
        sourceBranchesRevision,
        companions.branchesRevision,
        companions.branches != null,
        companions.branches == null
          ? false
          : fieldSweepSamplesMatchBranches(samples, companions.branches),
      ),
      spectrum: fieldSweepJoinState(
        sourceSpectrumRevision,
        companions.spectrumRevision,
        companions.spectrum != null,
        companions.spectrum == null
          ? false
          : fieldSweepSamplesMatchSpectrum(samples, companions.spectrum),
      ),
    },
    requestedExecution: fieldSweepExecutionFromPayload(payload.requested_execution),
    requestedSampleCount: finiteNumber(payload.requested_sample_count),
    resolvedExecution: fieldSweepExecutionFromPayload(payload.resolved_execution),
    runId: nonEmptyString(payload.run_id),
    samples,
    scopeId: nonEmptyString(payload.scope_id),
    source: fieldSweepSourceFromPayload(payload.source),
    sourceBranchesRevision,
    sourceRevision,
    sourceSpectrumRevision,
    stageId: nonEmptyString(payload.stage_id),
    status: hasTypedContract ? nonEmptyString(payload.status) : "incomplete",
    stopReason: nonEmptyString(payload.stop_reason),
    topology: fieldSweepTopologyFromPayload(payload.topology),
    units: fieldSweepUnitsFromPayload(payload.units),
    runtimeId: nonEmptyString(payload.runtime_id),
  };
}

/**
 * Typed compatibility adapters for the generated A2 payload union.  The
 * generated schema is intentionally untagged, so the schema-owned property
 * shape is used as the discriminator; no `payload?: unknown` parsing occurs.
 */
export function navigatorSpectrumFromResource(
  resource: FrequencyDomainJsonArtifactResource | null | undefined,
): NavigatorSpectrumPayload | null {
  const payload = resource?.payload;
  if (!payload || !isSpectrumPayload(payload)) return null;

  return {
    samples: (payload.samples ?? []).map((sample, samplePosition) => {
      const sampleIndex = sample.sample_index ?? samplePosition;
      const sampleId = sample.sample_id ?? `sample-${sampleIndex}`;
      return {
        label: `Sample ${sampleId}`,
        modes: (sample.modes ?? []).map((mode, modePosition) => {
          const rawModeIndex = mode.raw_mode_index ?? modePosition;
          return {
            branchId:
              mode.branch_id == null
                ? null
                : String(mode.branch_id),
            displayModeIndex: rawModeIndex,
            frequencyHz: mode.frequency_hz ?? mode.frequency_real_hz ?? null,
            modeId: mode.mode_id ?? null,
            rawModeIndex,
          };
        }),
        sampleId,
        sampleIndex,
        stableIdentityAvailable: sample.sample_id != null,
      };
    }),
  };
}

export function navigatorBranchesFromResource(
  resource: FrequencyDomainJsonArtifactResource | null | undefined,
): NavigatorBranchesPayload | null {
  const payload = resource?.payload;
  if (!payload || !isBranchesPayload(payload)) return null;

  return {
    branches: payload.branches.map((branch, position) => {
      const branchId = branch.branch_id;
      return {
        branchId: branchId == null ? `branch-${position}` : String(branchId),
        modeCount: branch.points?.length ?? null,
        stableIdentityAvailable: branchId != null,
      };
    }),
  };
}

export function navigatorResponseFromResource(
  resource: FrequencyDomainJsonArtifactResource | null | undefined,
): NavigatorResponsePayload | null {
  const payload = resource?.payload;
  if (!payload || !isResponseSweepPayload(payload)) {
    return null;
  }

  return {
    points: (payload.points ?? []).map((point, position) => {
      const frequencyIndex = point.frequency_index ?? position;
      return {
        frequencyHz: point.frequency_hz ?? null,
        frequencyIndex,
        pointId: point.point_id ?? null,
        stableIdentityAvailable: point.point_id != null,
      };
    }),
  };
}

export function navigatorFmrFromResource(
  resource: FrequencyDomainJsonArtifactResource | null | undefined,
): NavigatorFmrPayload | null {
  const payload = resource?.payload;
  if (!payload || !isFmrPeaksPayload(payload)) return null;

  return {
    peaks: (payload.peaks ?? []).map((peak, position) => {
      const peakId = peak.peak_id ?? `peak-${position}`;
      return {
        frequencyHz: peak.frequency_hz ?? Number.NaN,
        peakId,
        stableIdentityAvailable: peak.peak_id != null,
      };
    }),
  };
}

export function navigatorResonanceFitsFromResource(
  resource: FrequencyDomainJsonArtifactResource | null | undefined,
): NavigatorFmrResonanceFitsPayload | null {
  const payload = resource?.payload;
  if (!payload || !isResonanceFitsPayload(payload)) return null;

  return {
    fits: (payload.fits ?? []).map((fit, index) => ({
      fitId: fit.fit_id ?? `fit-${index}`,
      stableIdentityAvailable: fit.fit_id != null,
    })),
  };
}

export function navigatorProgressFromResource(
  resource: FrequencyDomainSweepProgressResource | null | undefined,
): NavigatorProgressDescriptor | null {
  if (!resource) return null;
  return {
    complete: resource.complete,
    completedFrequencyPoints: resource.completed_frequency_points,
    missingReason: resource.missing_reason ?? null,
    partialArtifactsAvailable: resource.partial_artifacts_available,
    state: resource.state,
    status: resource.status,
    totalFrequencyPoints: resource.total_frequency_points,
  };
}

export function navigatorManifestFromResource(
  resource: FrequencyDomainManifestResource | null | undefined,
): NavigatorManifestSummary | null {
  if (!resource) return null;
  return {
    eigenReason: resource.eigenmodes.reason,
    eigenStatus: resource.eigenmodes.status,
    responseReason: resource.response.reason,
    responseStatus: resource.response.status,
  };
}
