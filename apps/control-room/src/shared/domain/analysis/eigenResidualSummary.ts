export interface EigenResidualSummary {
  absoluteL2: number | null;
  relativeL2: number | null;
  reportedSpectrumResidual: number | null;
  scope: string;
}

function nonnegativeFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Preserve producer residual meanings; magnitude alone cannot certify a pencil. */
export function buildEigenResidualSummary(
  modePayload: unknown,
  spectrumResidual: unknown,
): EigenResidualSummary {
  const mode = record(modePayload);
  const block = record(mode?.block_residuals);
  const scopeLabels: Record<string, string> = {
    native_descriptor: "Full native descriptor",
    full_projected_weak_form_and_periodic_seams: "Full projected weak form and periodic seams",
    reduced_original_blocks_only: "Reduced original blocks only",
  };
  const scope = typeof block?.scope === "string" && Object.hasOwn(scopeLabels, block.scope)
    ? scopeLabels[block.scope] : "Not available";
  return {
    // The artifact contract defines residual_norm as the legacy absolute L2 alias.
    absoluteL2: nonnegativeFinite(mode?.residual_absolute_l2) ?? nonnegativeFinite(mode?.residual_norm),
    relativeL2: nonnegativeFinite(mode?.residual_relative_l2),
    reportedSpectrumResidual: nonnegativeFinite(spectrumResidual),
    scope,
  };
}

/** Read only the artifact matching the currently selected sample and raw mode. */
export function readEigenModeResourcePayload(
  resource: unknown,
  sampleIndex: number | null,
  rawModeIndex: number | null,
): Record<string, unknown> | null {
  if (sampleIndex == null || rawModeIndex == null ||
      !Number.isInteger(sampleIndex) || !Number.isInteger(rawModeIndex) ||
      sampleIndex < 0 || rawModeIndex < 0) return null;
  const envelope = record(resource);
  if (envelope?.status !== "ready") return null;
  const payload = record(envelope.payload);
  if (payload?.sample_index !== sampleIndex || payload?.raw_mode_index !== rawModeIndex) return null;
  return payload;
}
