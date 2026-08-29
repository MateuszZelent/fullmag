import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V3_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_KITTEL_FIT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_PEAKS_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_RESONANCE_FITS_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_COMPAT_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
} from "../api/apiPaths";

const FREQUENCY_DOMAIN_ROUTE_PREFIX = ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH.slice(
  0,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH.lastIndexOf("/"),
);

const FREQUENCY_DOMAIN_RESOURCE_KEYS = new Set<string>([
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V3_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_KITTEL_FIT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_PEAKS_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_RESONANCE_FITS_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH,
]);

const MODE_FIELD_META_PREFIX = ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH.split(
  "{sample_index}",
)[0];
const MODE_FIELD_META_SUFFIX = ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH.split(
  "{mode_index}",
)[1];

/**
 * Identity of an immutable complex mode-field payload. Appearance is excluded
 * deliberately: phase, component, representation, palette and range are GPU
 * projections of this same buffer and must never trigger another data-plane
 * request.
 */
export interface ModeFieldComplexBinaryIdentity {
  readonly artifactRevision: string;
  readonly binaryEncoding: string;
  readonly fieldId: string;
  readonly fieldRevision: string;
  readonly generationId: string;
  readonly modeId: string;
  readonly runId: string;
  readonly sampleId: string;
  readonly scopeId: string;
  readonly scopeKind: "full" | "magnetic_only" | "object";
  readonly stageId: string;
  readonly topologyHash: string;
}

export function modeFieldComplexBinaryResourceKey(
  identity: ModeFieldComplexBinaryIdentity,
): string {
  return [
    "data:frequency-domain:mode-field:complex",
    identity.runId,
    identity.stageId,
    identity.artifactRevision,
    identity.sampleId,
    identity.modeId,
    identity.fieldId,
    identity.fieldRevision,
    identity.scopeKind,
    identity.scopeId,
    identity.generationId,
    identity.topologyHash,
    identity.binaryEncoding,
  ]
    .map(encodeURIComponent)
    .join(":");
}
const MODE_PREFIX = ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_PATH.split(
  "{sample_index}",
)[0];
const MODE_SUFFIX = ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_PATH.split(
  "{mode_index}",
)[1];
const RESPONSE_FREQUENCY_POINT_PREFIX =
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.split(
    "{frequency_index}",
  )[0];
const RESPONSE_FREQUENCY_POINT_SUFFIX =
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.split(
    "{frequency_index}",
  )[1];
const RESPONSE_FIELD_META_PREFIX =
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH.split(
    "{frequency_index}",
  )[0];
const RESPONSE_FIELD_META_SUFFIX =
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH.split(
    "{frequency_index}",
  )[1];

export function frequencyDomainModeFieldMetaResourceKey(
  sampleIndex: number | string,
  modeIndex: number | string,
): string {
  return ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH.replace(
    "{sample_index}",
    String(sampleIndex),
  ).replace("{mode_index}", String(modeIndex));
}

/**
 * Resolves event identities to the same keys used by frequency-domain hooks.
 * Artifact paths are accepted only as an event compatibility form; HTTP
 * payloads still flow through the canonical generated resource paths.
 */
export function canonicalFrequencyDomainResourceKey(
  value: string | null | undefined,
): string | null {
  if (!value) return null;

  const normalized = value.split("#", 1)[0]!.split("?", 1)[0]!;
  const candidate = normalized.startsWith("analysis/frequency-domain/")
    ? `${FREQUENCY_DOMAIN_ROUTE_PREFIX}/${normalized.slice("analysis/frequency-domain/".length)}`
    : normalized.startsWith("/analysis/frequency-domain/")
      ? `${FREQUENCY_DOMAIN_ROUTE_PREFIX}/${normalized.slice("/analysis/frequency-domain/".length)}`
      : normalized;

  if (FREQUENCY_DOMAIN_RESOURCE_KEYS.has(candidate)) return candidate;
  if (candidate === ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_COMPAT_V1_PATH) {
    return ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH;
  }

  const concreteModeFieldMetaKey = concreteModeFieldMetaResourceKey(candidate);
  if (concreteModeFieldMetaKey) return concreteModeFieldMetaKey;

  const concreteModeKey = concreteModeResourceKey(candidate);
  if (concreteModeKey) return concreteModeKey;

  const concreteFrequencyPointKey = concreteResponseFrequencyPointResourceKey(candidate);
  if (concreteFrequencyPointKey) return concreteFrequencyPointKey;

  const concreteFieldMetaKey = concreteResponseFieldMetaResourceKey(candidate);
  if (concreteFieldMetaKey) return concreteFieldMetaKey;

  switch (candidate) {
    case "frequency_domain/manifest.v1.json":
      return ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH;
    case "eigen/spectrum.v2.json":
      return ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH;
    case "eigen/spectrum.v3.json":
      return ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V3_PATH;
    case "eigen/field_sweep.v1.json":
      return ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH;
    case "eigen/branches.v2.json":
      return ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH;
    case "eigen/dispersion.csv":
      return ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH;
    case "eigen/diagnostics.v2.json":
      return ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH;
    case "response/magnetic_response_sweep.v1.json":
    case "response/magnetic_response_sweep.v2.json":
      return ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH;
    case "response/progress.v1.json":
      return ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH;
    case "response/cancel_requested.v1.json":
      return ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH;
    case "response/diagnostics/solver.v1.json":
      return ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH;
    case "fmr/peaks.v1.json":
      return ANALYSIS_FREQUENCY_DOMAIN_FMR_PEAKS_PATH;
    case "fmr/resonance_fits.v1.json":
      return ANALYSIS_FREQUENCY_DOMAIN_FMR_RESONANCE_FITS_PATH;
    case "fmr/kittel_fit.v1.json":
      return ANALYSIS_FREQUENCY_DOMAIN_FMR_KITTEL_FIT_PATH;
    default:
      return (
        modeResourceKeyFromArtifactPath(candidate) ??
        modeFieldMetaResourceKeyFromPayloadPath(candidate) ??
        responseFrequencyPointResourceKeyFromArtifactPath(candidate) ??
        responseFieldMetaResourceKeyFromArtifactPath(candidate)
      );
  }
}

function concreteModeResourceKey(value: string): string | null {
  const indices = concreteU32PathSegments(value, MODE_PREFIX, MODE_SUFFIX, 2);
  return indices
    ? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_PATH.replace(
        "{sample_index}",
        indices[0]!,
      ).replace("{mode_index}", indices[1]!)
    : null;
}

function concreteModeFieldMetaResourceKey(value: string): string | null {
  const indices = concreteU32PathSegments(
    value,
    MODE_FIELD_META_PREFIX,
    MODE_FIELD_META_SUFFIX,
    2,
  );
  return indices
    ? frequencyDomainModeFieldMetaResourceKey(indices[0]!, indices[1]!)
    : null;
}

function concreteResponseFrequencyPointResourceKey(value: string): string | null {
  const indices = concreteU32PathSegments(
    value,
    RESPONSE_FREQUENCY_POINT_PREFIX,
    RESPONSE_FREQUENCY_POINT_SUFFIX,
    1,
  );
  return indices
    ? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
        "{frequency_index}",
        indices[0]!,
      )
    : null;
}

function concreteResponseFieldMetaResourceKey(value: string): string | null {
  const indices = concreteU32PathSegments(
    value,
    RESPONSE_FIELD_META_PREFIX,
    RESPONSE_FIELD_META_SUFFIX,
    1,
  );
  return indices
    ? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH.replace(
        "{frequency_index}",
        indices[0]!,
      )
    : null;
}

function concreteU32PathSegments(
  value: string,
  prefix: string,
  suffix: string,
  count: number,
): string[] | null {
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;

  const end = suffix.length > 0 ? value.length - suffix.length : value.length;
  const segments = value.slice(prefix.length, end).split("/");
  if (segments.length !== count || !segments.every(isU32PathSegment)) return null;

  return segments.map((segment) => String(Number(segment)));
}

function isU32PathSegment(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffff_ffff;
}

function modeResourceKeyFromArtifactPath(
  artifactPath: string,
): string | null {
  const match = /^eigen\/modes\/sample_(\d+)\/mode_(\d+)\.json$/.exec(
    artifactPath,
  );
  return match && isU32PathSegment(match[1]!) && isU32PathSegment(match[2]!)
    ? ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_PATH.replace(
        "{sample_index}",
        String(Number(match[1])),
      ).replace("{mode_index}", String(Number(match[2])))
    : null;
}

function modeFieldMetaResourceKeyFromPayloadPath(
  artifactPath: string,
): string | null {
  const binaryMatch =
    /^eigen\/mode_fields\/sample_(\d+)\/mode_(\d+)\/vector\.bin$/.exec(
      artifactPath,
    );
  const zarrMatch =
    /^eigen\/mode_fields\.zarr\/sample_(\d+)\/mode_(\d+)\/vector_xyz_complex(?:\/0\.0\.0)?$/.exec(
      artifactPath,
    );
  const match = binaryMatch ?? zarrMatch;
  return match && isU32PathSegment(match[1]!) && isU32PathSegment(match[2]!)
    ? frequencyDomainModeFieldMetaResourceKey(
        Number(match[1]),
        Number(match[2]),
      )
    : null;
}

function responseFrequencyPointResourceKeyFromArtifactPath(
  artifactPath: string,
): string | null {
  const match = /^response\/frequency_points\/frequency_(\d+)\.json$/.exec(
    artifactPath,
  );
  return match && isU32PathSegment(match[1]!)
    ? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH.replace(
        "{frequency_index}",
        String(Number(match[1]!)),
      )
    : null;
}

function responseFieldMetaResourceKeyFromArtifactPath(
  artifactPath: string,
): string | null {
  const binaryMatch =
    /^response\/field_payloads\/frequency_(\d+)\/(?:vector|vector_xyz)\.bin$/.exec(
      artifactPath,
    );
  const zarrMatch =
    /^response\/field_payloads\.zarr\/frequency_(\d+)\/vector_xyz_complex(?:\/0\.0\.0)?$/.exec(
      artifactPath,
    );
  const frequencyIndex = binaryMatch?.[1] ?? zarrMatch?.[1];
  return frequencyIndex && isU32PathSegment(frequencyIndex)
    ? ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH.replace(
        "{frequency_index}",
        String(Number(frequencyIndex)),
      )
    : null;
}
