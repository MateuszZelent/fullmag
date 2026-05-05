import { useMemo } from "react";
import { buildPartRenderDataCache } from "@/features/viewport-fem/model/femTopologyCache";
import { buildVisibleLayers } from "@/features/viewport-fem/model/femRenderModel";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { defaultMeshEntityViewState } from "../../../lib/session/types";
import type {
  FemLiveMeshObjectSegment,
  FemMeshPart,
  MeshEntityViewState,
  MeshEntityViewStateMap,
  MeshQualityStats,
} from "../../../lib/session/types";
import type { BuilderObjectOverlay, ObjectViewMode } from "../../runs/control-room/shared";
import type { VisibleSubmeshSnapshot } from "../../runs/control-room/submeshSnapshot";
import { useFemSubmeshSnapshot } from "./useFemSubmeshSnapshot";
import { useFemVectorDomain } from "./useFemVectorDomain";
import { useFemToolbarModel } from "./useFemToolbarModel";
import type {
  FemArrowColorMode,
  FemColorField,
  FemFerromagnetVisibilityMode,
  FemMeshData,
  FemVectorDomainFilter,
  RenderLayer,
  RenderMode,
} from "./femMeshTypes";
import type { ViewportQualityProfileId } from "../shared/viewportQualityProfiles";

const AIR_OBJECT_SEGMENT_ID = "__air__";

export function shouldWarnMissingMagneticMask({
  quantityDomain,
  activeMaskLength,
  nNodes,
  hasMeshParts,
  magneticSegmentCount,
  field,
  showArrowsRequested,
}: {
  quantityDomain: FemMeshData["quantityDomain"];
  activeMaskLength: number | null;
  nNodes: number;
  hasMeshParts: boolean;
  magneticSegmentCount: number;
  field: FemColorField;
  showArrowsRequested: boolean;
}): boolean {
  if (quantityDomain !== "magnetic_only") {
    return false;
  }
  const magneticFieldLayerActive = field !== "none" || showArrowsRequested;
  if (!magneticFieldLayerActive) {
    return false;
  }
  if (hasMeshParts || magneticSegmentCount > 0) {
    return false;
  }
  return activeMaskLength !== nNodes;
}

export function shouldFlagMissingExactScopeSegment({
  selectedObjectId,
  selectedObjectOverlayFidelity,
  nElements,
  hasExactScopeSegment,
}: {
  selectedObjectId: string | null | undefined;
  selectedObjectOverlayFidelity: "mesh-backed" | "bounds-backed" | null;
  nElements: number;
  hasExactScopeSegment: boolean;
}): boolean {
  if (!selectedObjectId || nElements <= 0) {
    return false;
  }
  if (selectedObjectOverlayFidelity === "bounds-backed") {
    return false;
  }
  return !hasExactScopeSegment;
}

interface UseFemViewportDerivedModelArgs {
  meshData: FemMeshData;
  objectOverlays: BuilderObjectOverlay[];
  selectedObjectId?: string | null;
  visibleObjectIds?: string[];
  objectSegments: FemLiveMeshObjectSegment[];
  airSegmentVisible: boolean;
  meshParts: FemMeshPart[];
  meshEntityViewState: MeshEntityViewStateMap;
  objectViewMode: ObjectViewMode;
  vectorDomainFilter: FemVectorDomainFilter;
  ferromagnetVisibilityMode: FemFerromagnetVisibilityMode;
  selectedEntityId?: string | null;
  focusedEntityId?: string | null;
  elementMarkers?: number[] | null;
  perDomainQuality?: Record<number, MeshQualityStats> | null;
  onVisibleSubmeshSnapshotChange?: (snapshot: VisibleSubmeshSnapshot | null) => void;
  resolvedPreviewMaxPoints: number;
  captureActive: boolean;
  interactionActive: boolean;
  qualityProfile: ViewportQualityProfileId;
  renderMode: RenderMode;
  field: FemColorField;
  opacity: number;
  arrowColorMode: FemArrowColorMode;
  showArrowsRequested: boolean;
  femVectorGlyphBudget?: number | null;
  qualityPerFace?: number[] | null;
  sampledArrowCount?: number;
  quantityOptions?: Array<{
    id: string;
    shortLabel: string;
    label?: string;
    available: boolean;
  }>;
  selectedSidebarNodeId?: string | null;
}

export function useFemViewportDerivedModel({
  meshData,
  objectOverlays,
  selectedObjectId = null,
  visibleObjectIds,
  objectSegments,
  airSegmentVisible,
  meshParts,
  meshEntityViewState,
  objectViewMode,
  vectorDomainFilter,
  ferromagnetVisibilityMode,
  selectedEntityId = null,
  focusedEntityId = null,
  elementMarkers = null,
  perDomainQuality = null,
  onVisibleSubmeshSnapshotChange,
  resolvedPreviewMaxPoints,
  captureActive,
  interactionActive,
  qualityProfile,
  renderMode,
  field,
  opacity,
  arrowColorMode,
  showArrowsRequested,
  femVectorGlyphBudget,
  qualityPerFace,
  sampledArrowCount,
  quantityOptions = [],
  selectedSidebarNodeId = null,
}: UseFemViewportDerivedModelArgs) {
  const wrapperFlags = FRONTEND_DIAGNOSTIC_FLAGS.femWrapper;
  const hasMeshParts = meshParts.length > 0;
  const selectedObjectOverlay = useMemo(
    () =>
      selectedObjectId
        ? objectOverlays.find((overlay) => overlay.id === selectedObjectId) ?? null
        : null,
    [objectOverlays, selectedObjectId],
  );
  const magneticSegments = useMemo(
    () => objectSegments.filter((segment) => segment.object_id !== AIR_OBJECT_SEGMENT_ID),
    [objectSegments],
  );
  const visibleMagneticIds = useMemo(() => {
    if (visibleObjectIds && visibleObjectIds.length > 0) {
      return new Set(visibleObjectIds);
    }
    return new Set(magneticSegments.map((segment) => segment.object_id));
  }, [magneticSegments, visibleObjectIds]);
  const airSegmentIds = useMemo(
    () => (airSegmentVisible ? new Set([AIR_OBJECT_SEGMENT_ID]) : new Set<string>()),
    [airSegmentVisible],
  );
  const supportsAirboxOnlyVectors = meshData.quantityDomain === "full_domain";
  const effectiveVectorDomainFilter: FemVectorDomainFilter =
    vectorDomainFilter === "airbox_only" && !supportsAirboxOnlyVectors
      ? "auto"
      : vectorDomainFilter;

  const partRenderDataById = useMemo(() => {
    if (!wrapperFlags.enablePartDerivedModel) {
      return new Map<
        string,
        {
          boundaryFaceIndices: number[] | null;
          elementIndices: number[] | null;
          nodeMask: Uint8Array | null;
          surfaceFaces: [number, number, number][] | null;
        }
      >();
    }
    return buildPartRenderDataCache(
      meshParts,
      meshData.boundaryFaces.length,
      meshData.nElements,
      meshData.nNodes,
    );
  }, [
    meshData.boundaryFaces.length,
    meshData.nElements,
    meshData.nNodes,
    meshParts,
    wrapperFlags.enablePartDerivedModel,
  ]);

  const visibleLayers = useMemo<RenderLayer[]>(() => {
    if (!wrapperFlags.enablePartDerivedModel || !hasMeshParts) {
      return [];
    }
    return buildVisibleLayers({
      meshParts,
      partRenderDataById,
      meshEntityViewState,
      objectViewMode,
      vectorDomainFilter: effectiveVectorDomainFilter,
      ferromagnetVisibilityMode,
      selectedObjectId,
      selectedEntityId,
      focusedEntityId,
      airSegmentVisible,
      showArrows: showArrowsRequested,
    });
  }, [
    airSegmentVisible,
    effectiveVectorDomainFilter,
    ferromagnetVisibilityMode,
    focusedEntityId,
    hasMeshParts,
    meshEntityViewState,
    meshParts,
    objectViewMode,
    partRenderDataById,
    selectedEntityId,
    selectedObjectId,
    showArrowsRequested,
    wrapperFlags.enablePartDerivedModel,
  ]);

  useFemSubmeshSnapshot({
    meshParts,
    elementMarkers,
    perDomainQuality,
    hasMeshParts,
    visibleLayers,
    selectedEntityId,
    focusedEntityId,
    onVisibleSubmeshSnapshotChange,
  });

  const missingMagneticMask = shouldWarnMissingMagneticMask({
    quantityDomain: meshData.quantityDomain,
    activeMaskLength: meshData.activeMask?.length ?? null,
    nNodes: meshData.nNodes,
    hasMeshParts,
    magneticSegmentCount: magneticSegments.length,
    field,
    showArrowsRequested,
  });
  const hasExactScopeSegment = hasMeshParts
    ? meshParts.some(
        (part) => part.role === "magnetic_object" && part.object_id === selectedObjectId,
      )
    : magneticSegments.some((segment) => segment.object_id === selectedObjectId);
  const missingExactScopeSegment = shouldFlagMissingExactScopeSegment({
    selectedObjectId,
    selectedObjectOverlayFidelity: selectedObjectOverlay?.fidelity ?? null,
    nElements: meshData.nElements,
    hasExactScopeSegment,
  });

  const vectorDomain = useFemVectorDomain({
    enableVectorDerivedModel: wrapperFlags.enableVectorDerivedModel,
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
    showArrowsForGeometry: showArrowsRequested,
    resolvedPreviewMaxPoints,
    femVectorGlyphBudget,
    captureActive,
    interactionActive,
    qualityProfile,
    renderMode,
    airSegmentVisible,
  });

  const baseViewStateByPartId = useMemo(() => {
    const next = new Map<string, MeshEntityViewState>();
    if (!hasMeshParts) {
      return next;
    }
    for (const part of meshParts) {
      next.set(part.id, meshEntityViewState[part.id] ?? defaultMeshEntityViewState(part));
    }
    return next;
  }, [hasMeshParts, meshEntityViewState, meshParts]);

  const toolbarModel = useFemToolbarModel({
    hasMeshParts,
    meshParts,
    visibleLayers,
    baseViewStateByPartId,
    renderMode,
    field,
    opacity,
    arrowColorMode,
    showArrows: showArrowsRequested,
    missingMagneticMask,
    visibleArrowNodeCount: vectorDomain.visibleArrowNodeCount,
    meshData,
    baseArrowDensity: vectorDomain.baseArrowDensity,
    effectiveArrowDensity: vectorDomain.effectiveArrowDensity,
    qualityPerFace,
    sampledArrowCount,
    quantityOptions,
    selectedSidebarNodeId,
    selectedObjectId,
    selectedEntityId,
  });

  return {
    wrapperFlags,
    hasMeshParts,
    selectedObjectOverlay,
    supportsAirboxOnlyVectors,
    effectiveVectorDomainFilter,
    visibleLayers,
    missingMagneticMask,
    missingExactScopeSegment,
    vectorDomain,
    baseViewStateByPartId,
    toolbarModel,
  };
}
