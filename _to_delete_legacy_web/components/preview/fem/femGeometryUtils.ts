/**
 * Pure geometry utility functions for FEM viewport.
 *
 * Topology helpers (collectPart*, collectSegment*, markersForPart) are
 * canonical in @/features/viewport-fem/model/femTopologyCache.ts.
 * This module re-exports them for backward compatibility and provides
 * non-topology constants / helpers.
 */
import type { FemArrowColorMode } from "./femMeshTypes";
export { countActiveNodes, isNodeActive, normalizeNodeMask, maskKind } from "./femNodeMask";

// Re-export canonical topology helpers for backward compatibility.
export {
  markersForPart,
  collectPartBoundaryFaceIndices,
  collectPartElementIndices,
  collectPartNodeMask,
  collectSegmentBoundaryFaceIndicesByIds,
  collectSegmentElementIndicesByIds,
  collectSegmentNodeMask,
} from "@/features/viewport-fem/model/femTopologyCache";

export const SUPPORTED_ARROW_COLOR_FIELDS: ReadonlySet<FemArrowColorMode> = new Set([
  "orientation",
  "x",
  "y",
  "z",
  "magnitude",
]);
