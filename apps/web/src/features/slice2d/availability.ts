import type { Slice2DToolbarState } from "./types";

export type Slice2DAvailabilityMaturity = "ready" | "staged" | "semantic_only";

export interface Slice2DAvailabilityGate {
  enabled: boolean;
  reason: string | null;
  maturity: Slice2DAvailabilityMaturity;
}

export interface Slice2DAvailability {
  heatmap: Slice2DAvailabilityGate;
  vectors: Slice2DAvailabilityGate;
  meshOverlay: Slice2DAvailabilityGate;
  airbox: Slice2DAvailabilityGate;
  airboxVectors: Slice2DAvailabilityGate;
  contour: Slice2DAvailabilityGate;
  slab: Slice2DAvailabilityGate;
  primitives: Slice2DAvailabilityGate;
}

export interface Slice2DAvailabilityInput {
  isFemBackend: boolean;
  mode: Slice2DToolbarState["mode"];
  hasAirboxParts?: boolean | null;
}

function gate(
  enabled: boolean,
  reason: string | null,
  maturity: Slice2DAvailabilityMaturity,
): Slice2DAvailabilityGate {
  return {
    enabled,
    reason: enabled ? null : reason,
    maturity,
  };
}

function femSingleReason(input: Slice2DAvailabilityInput, label: string): string | null {
  if (!input.isFemBackend) {
    return `${label} requires FEM explicit topology`;
  }
  if (input.mode !== "single") {
    return `${label} currently supports Single mode only`;
  }
  return null;
}

export function resolveSlice2DAvailability(
  input: Slice2DAvailabilityInput,
): Slice2DAvailability {
  const vectorsReason =
    input.mode === "single" ? null : "2D vectors currently support Single mode only";
  const meshReason = femSingleReason(input, "2D mesh overlay");
  const airboxBaseReason = femSingleReason(input, "2D airbox overlay");
  const airboxReason =
    airboxBaseReason ?? (
      input.hasAirboxParts
        ? null
        : "No airbox mesh part in current domain"
    );

  return {
    heatmap: gate(true, null, "ready"),
    vectors: gate(vectorsReason === null, vectorsReason, "ready"),
    meshOverlay: gate(meshReason === null, meshReason, "ready"),
    airbox: gate(airboxReason === null, airboxReason, "ready"),
    airboxVectors: gate(false, "2D airbox vectors are staged until vector domains are split", "staged"),
    contour: gate(false, "2D contour rendering is not implemented E2E yet", "semantic_only"),
    slab: gate(false, "Slab mode is not implemented E2E yet", "semantic_only"),
    primitives: gate(false, "2D primitive overlays are not implemented E2E yet", "semantic_only"),
  };
}
