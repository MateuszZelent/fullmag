/**
 * useFemGeometryMaterials — focused hook for deriving all material configuration
 * from FemGeometry props.
 *
 * Extracted from FemGeometry.tsx so that material-only changes (opacity, color,
 * highlight) don't intermingle with geometry-build or resource-disposal logic.
 */

import { useMemo } from "react";
import { RENDER_POLICIES_V2 } from "../shared/renderPolicyV2";

export interface FemGeometryMaterialParams {
  /** 0.0–1.0 opacity for surface mesh material. */
  opacityVal: number;
  /** True when the mesh should render with transparency (opacity < 100 or mesh-edges mode). */
  isTransparent: boolean;
  /** Resolved CSS color string for wireframe / edge lines. */
  resolvedEdgeColor: string;
  /** Material render policy for the solid / semi-transparent surface. */
  surfacePolicy: typeof RENDER_POLICIES_V2.solidSurface;
  /** Material render policy for visible feature edges. */
  edgePolicy: typeof RENDER_POLICIES_V2.featureEdges;
  /** Material render policy for hidden / occluded edges (lower opacity, behind surface). */
  hiddenEdgePolicy: typeof RENDER_POLICIES_V2.hiddenEdges;
  /** Material render policy for points pass. */
  pointPolicy: typeof RENDER_POLICIES_V2.points;
  /** Material render policy for the selection highlight wireframe. */
  selectionEdgePolicy: typeof RENDER_POLICIES_V2.selectionShell;
}

export interface FemGeometryMaterialInputs {
  /** Opacity in 0–100 range as received from FemGeometry props. */
  opacity: number;
  highlight: boolean;
  uniformColor?: string;
  edgeColor?: string;
  /** True when the full tetrahedral mesh-edge pass is active (forces semi-transparent surface). */
  showMeshEdges: boolean;
  /** True when a non-"none" color field is active. */
  hasFieldColormap: boolean;
}

/**
 * Pure (non-hook) derivation of material params — exposed for unit testing.
 * The hook wrapper below adds memoisation via `useMemo`.
 */
export function resolveFemGeometryMaterialParams(
  input: FemGeometryMaterialInputs,
): FemGeometryMaterialParams {
  const { opacity, highlight, uniformColor, edgeColor, showMeshEdges, hasFieldColormap } = input;

  const resolvedEdgeColor = highlight
    ? edgeColor ?? "#67e8f9"
    : hasFieldColormap
      ? "#d1d5db"
      : edgeColor ?? uniformColor ?? "#dbeafe";

  const isTransparent = opacity < 100 || showMeshEdges;
  const opacityVal = showMeshEdges ? Math.min(opacity / 100, 0.35) : opacity / 100;
  const surfacePolicy = isTransparent
    ? RENDER_POLICIES_V2.contextSurface
    : RENDER_POLICIES_V2.solidSurface;

  return {
    opacityVal,
    isTransparent,
    resolvedEdgeColor,
    surfacePolicy,
    edgePolicy: RENDER_POLICIES_V2.featureEdges,
    hiddenEdgePolicy: RENDER_POLICIES_V2.hiddenEdges,
    pointPolicy: RENDER_POLICIES_V2.points,
    selectionEdgePolicy: RENDER_POLICIES_V2.selectionShell,
  };
}

export function useFemGeometryMaterials(input: FemGeometryMaterialInputs): FemGeometryMaterialParams {
  return useMemo(() => resolveFemGeometryMaterialParams(input), [
    input.opacity,
    input.showMeshEdges,
    input.highlight,
    input.edgeColor,
    input.uniformColor,
    input.hasFieldColormap,
  ]);
}
