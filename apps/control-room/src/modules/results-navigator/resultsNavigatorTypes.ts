import type {
  FrequencyDomainBranchesArtifactPayload,
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
