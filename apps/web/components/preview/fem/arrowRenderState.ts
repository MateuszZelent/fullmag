/**
 * Arrow render-state model.
 *
 * Centralises the "requested / allowed / rendered" semantics so every layer
 * (container, toolbar, scene, renderer) can inspect exactly why arrows are
 * visible or hidden.
 */

export type ArrowBlockReason =
  | null
  | "requested_off"
  | "forced_hidden"
  | "layer_disabled"
  | "missing_field"
  | "no_visible_nodes"
  | "no_sampled_nodes";

/** Computed once per frame by the viewport model and passed down. */
export interface ArrowRenderState {
  /** User (or preset) toggle value. */
  requested: boolean;
  /** Diagnostic layer gate (`showArrowLayer`). */
  layerEnabled: boolean;
  /** Whether field data is present on meshData. */
  hasFieldData: boolean;
  /** Count of visible nodes that passed the domain mask. */
  visibleNodeCount: number;
  /** Final "should the arrow layer take effect?" boolean. */
  visible: boolean;
  /** Machine-readable reason when `visible === false` despite `requested`. */
  reason: ArrowBlockReason;
}

/** Subset forwarded to the toolbar for display. */
export interface ArrowToolbarState {
  requested: boolean;
  visible: boolean;
  reason: ArrowBlockReason;
  density: number;
  effectiveDensity: number;
}

/** Diagnostic payload emitted by FemArrows for debug logging. */
export interface ArrowRenderDiagnostics {
  boundaryCandidateCount: number;
  filteredCandidateCount: number;
  sampledNodeCount: number;
  hasMask: boolean;
  maskKind: "boolean" | "uint8" | "none";
}

/**
 * Compute the canonical `ArrowRenderState` from the viewport's
 * derived model values.
 */
export function computeArrowRenderState(input: {
  requested: boolean;
  forceHidden?: boolean;
  layerEnabled: boolean;
  missingMagneticMask: boolean;
  visibleNodeCount: number;
  hasFieldData: boolean;
}): ArrowRenderState {
  const {
    requested,
    forceHidden = false,
    layerEnabled,
    missingMagneticMask,
    visibleNodeCount,
    hasFieldData,
  } = input;

  if (!requested) {
    return {
      requested,
      layerEnabled,
      hasFieldData,
      visibleNodeCount,
      visible: false,
      reason: "requested_off",
    };
  }

  if (forceHidden) {
    return {
      requested,
      layerEnabled,
      hasFieldData,
      visibleNodeCount,
      visible: false,
      reason: "forced_hidden",
    };
  }

  if (!layerEnabled) {
    return {
      requested,
      layerEnabled,
      hasFieldData,
      visibleNodeCount,
      visible: false,
      reason: "layer_disabled",
    };
  }

  if (missingMagneticMask || !hasFieldData) {
    return {
      requested,
      layerEnabled,
      hasFieldData,
      visibleNodeCount,
      visible: false,
      reason: "missing_field",
    };
  }

  if (visibleNodeCount <= 0) {
    return {
      requested,
      layerEnabled,
      hasFieldData,
      visibleNodeCount,
      visible: false,
      reason: "no_visible_nodes",
    };
  }

  return {
    requested,
    layerEnabled,
    hasFieldData,
    visibleNodeCount,
    visible: true,
    reason: null,
  };
}
