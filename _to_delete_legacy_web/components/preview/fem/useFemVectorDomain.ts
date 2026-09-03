/**
 * Custom hook that computes vector-domain filtering, arrow masks,
 * arrow density, and render-time quality overrides for FemMeshView3D.
 *
 * Extracted from FemMeshView3D.tsx to reduce file size.
 */

import { useMemo } from "react";
import {
  collectSegmentBoundaryFaceIndicesByIds,
  collectSegmentElementIndicesByIds,
  collectSegmentNodeMask,
} from "@/features/viewport-fem/model/femTopologyCache";
import { countActiveNodes } from "./femNodeMask";
import { buildMagneticArrowNodeMask } from "@/features/viewport-fem/model/femSelectionMap";
import {
  GLYPH_BUDGET_MAX,
  GLYPH_BUDGET_MIN,
  maxPointsToGlyphBudget,
} from "./vectorDensityBudget";
import type { FemMeshData, FemVectorDomainFilter, FemFerromagnetVisibilityMode, RenderMode, RenderLayer } from "./femMeshTypes";
import type { FemLiveMeshObjectSegment, FemMeshPart } from "../../../lib/session/types";
import type { ViewportQualityProfileId } from "../shared/viewportQualityProfiles";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";

interface UseFemVectorDomainArgs {
  enableVectorDerivedModel: boolean;
  missingExactScopeSegment: boolean;
  selectedObjectId: string | null | undefined;
  magneticSegments: FemLiveMeshObjectSegment[];
  meshData: FemMeshData;
  visibleMagneticIds: Set<string>;
  objectSegments: FemLiveMeshObjectSegment[];
  airSegmentIds: Set<string>;
  hasMeshParts: boolean;
  visibleLayers: RenderLayer[];
  effectiveVectorDomainFilter: FemVectorDomainFilter;
  ferromagnetVisibilityMode: FemFerromagnetVisibilityMode;
  showArrowsForGeometry?: boolean;
  resolvedPreviewMaxPoints: number;
  femVectorGlyphBudget?: number | null;
  captureActive: boolean;
  interactionActive: boolean;
  qualityProfile: ViewportQualityProfileId;
  renderMode: RenderMode;
  airSegmentVisible: boolean;
  meshParts?: readonly FemMeshPart[];
  partRenderDataById?: ReadonlyMap<
    string,
    {
      boundaryFaceIndices: number[] | null;
      elementIndices: number[] | null;
      nodeMask: Uint8Array | null;
      surfaceFaces: [number, number, number][] | null;
    }
  >;
}

export function resolveRuntimeRenderMode(
  renderMode: RenderMode,
  interactionActive: boolean,
): RenderMode {
  if (!interactionActive) {
    return renderMode;
  }
  return renderMode === "surface+edges" ? "surface" : renderMode;
}

export function useFemVectorDomain({
  enableVectorDerivedModel,
  missingExactScopeSegment,
  selectedObjectId,
  magneticSegments,
  meshData,
  visibleMagneticIds,
  objectSegments,
  airSegmentIds,
  hasMeshParts,
  visibleLayers,
  effectiveVectorDomainFilter,
  ferromagnetVisibilityMode,
  showArrowsForGeometry,
  resolvedPreviewMaxPoints,
  femVectorGlyphBudget,
  captureActive,
  interactionActive,
  qualityProfile,
  renderMode,
  airSegmentVisible,
  meshParts,
  partRenderDataById,
}: UseFemVectorDomainArgs) {
  const magneticBoundaryFaceIndices = useMemo(() => {
    if (!enableVectorDerivedModel) {
      return null;
    }
    if (missingExactScopeSegment) {
      return null;
    }
    if (selectedObjectId) {
      return collectSegmentBoundaryFaceIndicesByIds(
        magneticSegments,
        Math.floor(meshData.boundaryFaces.length / 3),
        new Set([selectedObjectId]),
      );
    }
    return collectSegmentBoundaryFaceIndicesByIds(
      magneticSegments,
      Math.floor(meshData.boundaryFaces.length / 3),
      visibleMagneticIds,
    );
  }, [
    magneticSegments,
    meshData.boundaryFaces.length,
    missingExactScopeSegment,
    selectedObjectId,
    visibleMagneticIds,
    enableVectorDerivedModel,
  ]);

  const magneticElementIndices = useMemo(() => {
    if (!enableVectorDerivedModel) {
      return null;
    }
    if (missingExactScopeSegment) {
      return null;
    }
    if (selectedObjectId) {
      return collectSegmentElementIndicesByIds(
        magneticSegments,
        meshData.nElements,
        new Set([selectedObjectId]),
      );
    }
    return collectSegmentElementIndicesByIds(
      magneticSegments,
      meshData.nElements,
      visibleMagneticIds,
    );
  }, [
    magneticSegments,
    meshData.nElements,
    missingExactScopeSegment,
    selectedObjectId,
    visibleMagneticIds,
    enableVectorDerivedModel,
  ]);

  const airBoundaryFaceIndices = useMemo(
    () =>
      !enableVectorDerivedModel
        ? null
        : collectSegmentBoundaryFaceIndicesByIds(
            objectSegments,
            Math.floor(meshData.boundaryFaces.length / 3),
            airSegmentIds,
          ),
    [airSegmentIds, meshData.boundaryFaces.length, objectSegments, enableVectorDerivedModel],
  );

  const airElementIndices = useMemo(
    () =>
      !enableVectorDerivedModel
        ? null
        : collectSegmentElementIndicesByIds(objectSegments, meshData.nElements, airSegmentIds),
    [airSegmentIds, meshData.nElements, objectSegments, enableVectorDerivedModel],
  );

  // P3-2 consolidation: Delegate to pure buildMagneticArrowNodeMask from femSelectionMap.ts
  const magneticArrowNodeMask = useMemo(() => {
    if (!enableVectorDerivedModel) {
      return null;
    }
    return buildMagneticArrowNodeMask(
      visibleLayers,
      magneticSegments,
      visibleMagneticIds,
      meshData.nNodes,
      meshData.activeMask,
      hasMeshParts,
    );
  }, [
    hasMeshParts,
    magneticSegments,
    meshData.activeMask,
    meshData.nNodes,
    visibleLayers,
    visibleMagneticIds,
    enableVectorDerivedModel,
  ]);

  const fullDomainArrowNodeMask = useMemo(() => {
    if (!enableVectorDerivedModel) {
      return null;
    }
    if (meshData.quantityDomain !== "full_domain") {
      return null;
    }
    if (!hasMeshParts) {
      const mask = new Uint8Array(meshData.nNodes);
      mask.fill(1);
      return mask;
    }
    if (visibleLayers.length === 0) {
      return new Uint8Array(meshData.nNodes);
    }
    const combined = new Uint8Array(meshData.nNodes);
    let sawExplicitMask = false;
    for (const layer of visibleLayers) {
      const nodeMask = layer.nodeMask;
      if (!nodeMask) {
        continue;
      }
      sawExplicitMask = true;
      for (let index = 0; index < nodeMask.length; index += 1) {
        if (nodeMask[index]) combined[index] = 1;
      }
    }
    if (!sawExplicitMask) {
      const allOnes = new Uint8Array(meshData.nNodes);
      allOnes.fill(1);
      return allOnes;
    }
    return combined;
  }, [hasMeshParts, meshData.nNodes, meshData.quantityDomain, visibleLayers, enableVectorDerivedModel]);

  const airArrowNodeMask = useMemo(() => {
    if (!enableVectorDerivedModel) {
      return null;
    }
    if (hasMeshParts) {
      const airParts = meshParts?.filter((part) => part.role === "air") ?? [];
      if (airParts.length === 0) {
        return new Uint8Array(meshData.nNodes);
      }
      const combined = new Uint8Array(meshData.nNodes);
      for (const part of airParts) {
        const nodeMask = partRenderDataById?.get(part.id)?.nodeMask;
        if (!nodeMask) {
          continue;
        }
        for (let index = 0; index < nodeMask.length; index += 1) {
          if (nodeMask[index]) combined[index] = 1;
        }
      }
      return combined;
    }
    const nodeMask = collectSegmentNodeMask(objectSegments, meshData.nNodes, airSegmentIds);
    return nodeMask ?? new Uint8Array(meshData.nNodes);
  }, [
    airSegmentIds,
    hasMeshParts,
    meshData.nNodes,
    objectSegments,
    meshParts,
    partRenderDataById,
    enableVectorDerivedModel,
  ]);

  const resolvedVectorDomain: "magnetic_only" | "full_domain" | "airbox_only" = useMemo(() => {
    if (effectiveVectorDomainFilter === "airbox_only") {
      return "airbox_only";
    }
    if (effectiveVectorDomainFilter === "full_domain") {
      return "full_domain";
    }
    if (effectiveVectorDomainFilter === "magnetic_only") {
      return "magnetic_only";
    }
    return meshData.quantityDomain === "full_domain" ? "full_domain" : "magnetic_only";
  }, [effectiveVectorDomainFilter, meshData.quantityDomain]);

  const arrowActiveNodeMask = useMemo(() => {
    if (resolvedVectorDomain === "full_domain") {
      return fullDomainArrowNodeMask;
    }
    if (resolvedVectorDomain === "airbox_only") {
      return airArrowNodeMask;
    }
    return magneticArrowNodeMask;
  }, [airArrowNodeMask, fullDomainArrowNodeMask, magneticArrowNodeMask, resolvedVectorDomain]);

  const arrowBoundaryFaceIndices = useMemo(() => {
    if (resolvedVectorDomain === "full_domain") {
      return null;
    }
    if (resolvedVectorDomain === "airbox_only") {
      return airBoundaryFaceIndices;
    }
    return magneticBoundaryFaceIndices;
  }, [airBoundaryFaceIndices, magneticBoundaryFaceIndices, resolvedVectorDomain]);

  const baseArrowDensity = useMemo(
    () => {
      if (typeof femVectorGlyphBudget === "number" && Number.isFinite(femVectorGlyphBudget)) {
        return Math.max(
          GLYPH_BUDGET_MIN,
          Math.min(GLYPH_BUDGET_MAX, Math.round(femVectorGlyphBudget)),
        );
      }
      return maxPointsToGlyphBudget(resolvedPreviewMaxPoints);
    },
    [femVectorGlyphBudget, resolvedPreviewMaxPoints],
  );

  const baselineArrowNodeCount = useMemo(() => {
    if (meshData.nNodes <= 0) {
      return 0;
    }
    if (resolvedVectorDomain === "full_domain") {
      return meshData.nNodes;
    }
    if (meshData.activeMask && meshData.activeMask.length === meshData.nNodes) {
      const count = countActiveNodes(meshData.activeMask);
      return count > 0 ? count : meshData.nNodes;
    }
    return meshData.nNodes;
  }, [meshData.activeMask, meshData.nNodes, resolvedVectorDomain]);

  const visibleArrowNodeCount = useMemo(() => {
    if (
      arrowActiveNodeMask &&
      arrowActiveNodeMask.length === meshData.nNodes
    ) {
      return countActiveNodes(arrowActiveNodeMask);
    }
    return baselineArrowNodeCount;
  }, [arrowActiveNodeMask, baselineArrowNodeCount, meshData.nNodes]);

  const effectiveArrowDensity = useMemo(() => {
    if (baseArrowDensity <= 0 || baselineArrowNodeCount <= 0 || visibleArrowNodeCount <= 0) {
      return 0;
    }
    const visibleRatio = Math.min(
      1,
      Math.max(0, visibleArrowNodeCount / baselineArrowNodeCount),
    );
    const scaled = Math.round(baseArrowDensity * visibleRatio);
    if (visibleRatio >= 0.999) {
      return Math.max(1, Math.min(baseArrowDensity, scaled));
    }
    const minBudget = Math.min(GLYPH_BUDGET_MIN, baseArrowDensity);
    return Math.max(minBudget, Math.min(baseArrowDensity, scaled));
  }, [baseArrowDensity, baselineArrowNodeCount, visibleArrowNodeCount]);

  // Compute directly (no useMemo) because FRONTEND_DIAGNOSTIC_FLAGS is a
  // mutable singleton that cannot participate in React dependency arrays.
  const runtimeQualityProfile: ViewportQualityProfileId = (() => {
    if (FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceLowQualityProfile) {
      return "interactive-lite";
    }
    if (captureActive) {
      return "capture";
    }
    if (
      interactionActive &&
      !FRONTEND_DIAGNOSTIC_FLAGS.femViewport.disableSimplifiedMode
    ) {
      return "interactive-lite";
    }
    return qualityProfile;
  })();

  const runtimeRenderMode = useMemo<RenderMode>(
    () => resolveRuntimeRenderMode(renderMode, interactionActive),
    [interactionActive, renderMode],
  );

  const runtimeArrowDensity = useMemo(() => {
    if (!interactionActive || effectiveArrowDensity <= 0) {
      return effectiveArrowDensity;
    }
    return Math.max(GLYPH_BUDGET_MIN, Math.round(effectiveArrowDensity * 0.45));
  }, [effectiveArrowDensity, interactionActive]);

  const hasMagneticDisplayContent = useMemo(() => {
    if (missingExactScopeSegment) {
      return false;
    }
    const faceCount =
      magneticBoundaryFaceIndices == null
        ? Math.floor(meshData.boundaryFaces.length / 3)
        : magneticBoundaryFaceIndices.length;
    const elementCount =
      magneticElementIndices == null ? meshData.nElements : magneticElementIndices.length;
    return faceCount > 0 || elementCount > 0;
  }, [
    magneticBoundaryFaceIndices,
    magneticElementIndices,
    meshData.boundaryFaces.length,
    meshData.nElements,
    missingExactScopeSegment,
  ]);

  const hasAirDisplayContent = useMemo(() => {
    const faceCount =
      airBoundaryFaceIndices == null
        ? Math.floor(meshData.boundaryFaces.length / 3)
        : airBoundaryFaceIndices.length;
    const elementCount = airElementIndices == null ? meshData.nElements : airElementIndices.length;
    return faceCount > 0 || elementCount > 0;
  }, [airBoundaryFaceIndices, airElementIndices, meshData.boundaryFaces.length, meshData.nElements]);

  const shouldRenderMagneticGeometry =
    !hasMeshParts &&
    !missingExactScopeSegment &&
    (selectedObjectId != null || visibleMagneticIds.size > 0) &&
    hasMagneticDisplayContent;

  const shouldRenderMagneticGeometryResolved =
    shouldRenderMagneticGeometry &&
    !(
      effectiveVectorDomainFilter === "airbox_only" &&
      showArrowsForGeometry !== false &&
      ferromagnetVisibilityMode === "hide"
    );

  const shouldRenderAirGeometry =
    !hasMeshParts &&
    (!selectedObjectId || effectiveVectorDomainFilter === "airbox_only") &&
    airSegmentVisible &&
    airSegmentIds.size > 0 &&
    hasAirDisplayContent;

  return {
    magneticBoundaryFaceIndices,
    magneticElementIndices,
    airBoundaryFaceIndices,
    airElementIndices,
    arrowActiveNodeMask,
    arrowBoundaryFaceIndices,
    baseArrowDensity,
    effectiveArrowDensity,
    resolvedVectorDomain,
    runtimeQualityProfile,
    runtimeRenderMode,
    runtimeArrowDensity,
    shouldRenderMagneticGeometry,
    shouldRenderMagneticGeometryResolved,
    shouldRenderAirGeometry,
    visibleArrowNodeCount,
  };
}
