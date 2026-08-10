import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_KITTEL_FIT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_PEAKS_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_RESONANCE_FITS_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
} from "../api/apiPaths";

const FREQUENCY_DOMAIN_ROUTE_PREFIX = ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH.slice(
  0,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH.lastIndexOf("/"),
);

const FREQUENCY_DOMAIN_RESOURCE_KEYS = new Set<string>([
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_KITTEL_FIT_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_PEAKS_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_FMR_RESONANCE_FITS_PATH,
  ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH,
]);

const MODE_FIELD_META_PREFIX = ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH.split(
  "{sample_index}",
)[0];
const MODE_FIELD_META_SUFFIX = ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH.split(
  "{mode_index}",
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
  if (isConcreteModeFieldMetaResourceKey(candidate)) return candidate;

  switch (candidate) {
    case "frequency_domain/manifest.v1.json":
      return ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH;
    case "eigen/spectrum.v2.json":
      return ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH;
    case "eigen/field_sweep.v1.json":
      return ANALYSIS_FREQUENCY_DOMAIN_EIGEN_FIELD_SWEEP_PATH;
    case "fmr/peaks.v1.json":
      return ANALYSIS_FREQUENCY_DOMAIN_FMR_PEAKS_PATH;
    case "fmr/resonance_fits.v1.json":
      return ANALYSIS_FREQUENCY_DOMAIN_FMR_RESONANCE_FITS_PATH;
    case "fmr/kittel_fit.v1.json":
      return ANALYSIS_FREQUENCY_DOMAIN_FMR_KITTEL_FIT_PATH;
    default:
      return modeFieldMetaResourceKeyFromArtifactPath(candidate);
  }
}

function isConcreteModeFieldMetaResourceKey(value: string): boolean {
  return (
    value.startsWith(MODE_FIELD_META_PREFIX) &&
    value.endsWith(MODE_FIELD_META_SUFFIX) &&
    value.slice(MODE_FIELD_META_PREFIX.length, -MODE_FIELD_META_SUFFIX.length)
      .split("/")
      .every((segment) => /^\d+$/.test(segment))
  );
}

function modeFieldMetaResourceKeyFromArtifactPath(
  artifactPath: string,
): string | null {
  const match = /^eigen\/modes\/sample_(\d+)\/mode_(\d+)\.json$/.exec(
    artifactPath,
  );
  return match
    ? frequencyDomainModeFieldMetaResourceKey(
        Number(match[1]),
        Number(match[2]),
      )
    : null;
}
