import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import type { Viewport3DFieldRenderModel, Viewport3DNodeSelection, Viewport3DTopologyPartRenderModel } from "../viewport3dRenderModel";
import { type Viewport3DMeshPart } from "../viewport3dDomainAdapter";
import type { Viewport3DRenderAdoptionIdentity, Viewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";
import type { SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";
import { resolveViewport3DScalarColorBufferKey, type ScalarColorBuffer } from "../viewport3dFieldMapping";
import { type Viewport3DTargetRenderPlan } from "./viewport3DTargetRenderPlan";
import { RENDER_POLICIES, surfaceMaterialPolicyProps, surfaceMaterialPolicyPropsFront } from "./viewport3DRenderPolicy";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { canApplyScalarShaderColorBuffer, createScalarSurfaceShaderMaterial, type Viewport3DScalarSurfaceMaterial } from "../viewport3dScalarSurfaceShader";
import { type Viewport3DScalarColorUploadResult } from "../hooks/useViewport3DScalarColorUpload";
import { canApplyVertexScalarColorBuffer } from "../viewport3dGeometryColors";
import { sameRenderableFieldQuantityId } from "@/kernel/api/quantityIds";
import type { MeshElementFamily } from "@/kernel/selection/selectionTypes";
import { BufferAttribute, BufferGeometry } from "three";
import { attachViewport3DSharedTopologyPosition } from "../viewport3dSharedTopologyPositions";
import { resolveViewport3DTargetSurfaceLayerInput, resolveViewport3DTargetVectorLayerInput } from "./viewport3DLayerPassInputs";

export const MESH_PART_SURFACE_USER_DATA = {
  viewportMeshPartSurface: true,
} as const;

export function resolveMeshPartScalarColors({
  fieldModel,
  partId,
  scalarColorMode,
  settings,
}: {
  fieldModel: (
    Pick<
      Viewport3DFieldRenderModel,
      "scalarColorsByMode" | "scalarColorsByPartAndMode"
    > &
      Partial<Pick<Viewport3DFieldRenderModel, "targetPasses">>
  ) | null;
  partId: string;
  scalarColorMode: string | null;
  settings: Pick<
    VisualizationTargetSettings,
    "activeQuantityId" | "scalarColorPalette"
  > &
    Partial<Pick<VisualizationTargetSettings, "surfaceProjectionMode">>;
}): ScalarColorBuffer | null {
  if (!fieldModel || !scalarColorMode) return null;
  const { scalarColors } = resolveViewport3DTargetSurfaceLayerInput({
    fieldModel,
    partId,
    scalarColorMode,
  });
  return scalarColorBufferMatchesSettings(
    scalarColors,
    scalarColorMode,
    settings,
  )
    ? scalarColors
    : null;
}

export function resolveMeshPartVectorLayerInput({
  fieldModel,
  partId,
}: Parameters<typeof resolveViewport3DTargetVectorLayerInput>[0]) {
  return resolveViewport3DTargetVectorLayerInput({ fieldModel, partId });
}

export function createMeshPartSurfaceGeometry({
  expandSurfaceFaces,
  positions,
  surfaceIndices,
}: {
  expandSurfaceFaces: boolean;
  positions: Float32Array;
  surfaceIndices: Uint32Array | null;
}): BufferGeometry | null {
  if (!surfaceIndices?.length) return null;
  const next = new BufferGeometry();
  if (!expandSurfaceFaces) {
    attachViewport3DSharedTopologyPosition(next, positions);
    next.setIndex(new BufferAttribute(surfaceIndices, 1));
    return next;
  }

  const expandedPositions = new Float32Array(surfaceIndices.length * 3);
  for (let index = 0; index < surfaceIndices.length; index += 1) {
    const sourceNode = surfaceIndices[index] ?? -1;
    const sourceOffset = sourceNode * 3;
    const targetOffset = index * 3;
    if (sourceNode < 0 || sourceOffset + 2 >= positions.length) {
      return null;
    }
    expandedPositions[targetOffset] = positions[sourceOffset] ?? 0;
    expandedPositions[targetOffset + 1] = positions[sourceOffset + 1] ?? 0;
    expandedPositions[targetOffset + 2] = positions[sourceOffset + 2] ?? 0;
  }
  next.setAttribute("position", new BufferAttribute(expandedPositions, 3));
  return next;
}

export function resolveMeshPartBoundaryFaceIndexForPick({
  expandedSurfaceFaces,
  faceIndex,
  part,
  surfaceTriangleFacetIndices,
}: {
  expandedSurfaceFaces: boolean;
  faceIndex: number | null | undefined;
  part: Pick<
    Viewport3DMeshPart,
    "boundary_face_count" | "boundary_face_indices" | "boundary_face_start"
  >;
  surfaceTriangleFacetIndices?: Uint32Array | null;
}): number | null {
  if (faceIndex === null || faceIndex === undefined || faceIndex < 0) {
    return null;
  }
  if (
    !expandedSurfaceFaces &&
    part.boundary_face_count <= 0 &&
    !part.boundary_face_indices?.length
  ) {
    return null;
  }
  const localFaceIndex = Math.floor(faceIndex);
  const mappedFacetIndex = surfaceTriangleFacetIndices?.[localFaceIndex];
  if (expandedSurfaceFaces) return mappedFacetIndex ?? null;
  if (mappedFacetIndex !== undefined) return mappedFacetIndex;
  const explicitFaceIndex = part.boundary_face_indices?.[localFaceIndex];
  if (explicitFaceIndex !== undefined) return explicitFaceIndex;
  if (localFaceIndex >= part.boundary_face_count) return null;
  return part.boundary_face_start + localFaceIndex;
}

export function resolveMeshPartSurfacePickIdentity({
  expandedSurfaceFaces,
  faceIndex,
  part,
  surfaceHit,
  surfaceTriangleCellTypes,
  surfaceTriangleFacetIndices,
  surfaceTriangleGlobalCellOrdinals,
}: {
  expandedSurfaceFaces: boolean;
  faceIndex: number | null | undefined;
  part: Pick<
    Viewport3DMeshPart,
    "boundary_face_count" | "boundary_face_indices" | "boundary_face_start"
  >;
  surfaceHit: boolean;
  surfaceTriangleCellTypes?: Uint32Array | null;
  surfaceTriangleFacetIndices?: Uint32Array | null;
  surfaceTriangleGlobalCellOrdinals?: BigUint64Array | null;
}): {
  boundaryFaceIndex: number | null;
  elementFamily: MeshElementFamily | null;
  globalCellOrdinal: string | null;
} {
  if (
    !surfaceHit ||
    faceIndex === null ||
    faceIndex === undefined ||
    faceIndex < 0
  ) {
    return {
      boundaryFaceIndex: null,
      elementFamily: null,
      globalCellOrdinal: null,
    };
  }
  const localTriangleIndex = Math.floor(faceIndex);
  const hasCellTypes = surfaceTriangleCellTypes != null;
  const hasFacetIndices = surfaceTriangleFacetIndices != null;
  const hasGlobalCellOrdinals = surfaceTriangleGlobalCellOrdinals != null;
  const identityMapCount = Number(hasCellTypes) +
    Number(hasFacetIndices) +
    Number(hasGlobalCellOrdinals);
  if (identityMapCount === 0) {
    return {
      boundaryFaceIndex: resolveMeshPartBoundaryFaceIndexForPick({
        expandedSurfaceFaces,
        faceIndex: localTriangleIndex,
        part,
      }),
      elementFamily: null,
      globalCellOrdinal: null,
    };
  }
  if (
    identityMapCount !== 3 ||
    !surfaceTriangleCellTypes ||
    !surfaceTriangleFacetIndices ||
    !surfaceTriangleGlobalCellOrdinals ||
    surfaceTriangleCellTypes.length !== surfaceTriangleFacetIndices.length ||
    surfaceTriangleGlobalCellOrdinals.length !== surfaceTriangleFacetIndices.length ||
    localTriangleIndex >= surfaceTriangleFacetIndices.length
  ) {
    return {
      boundaryFaceIndex: null,
      elementFamily: null,
      globalCellOrdinal: null,
    };
  }
  const boundaryFaceIndex = resolveMeshPartBoundaryFaceIndexForPick({
    expandedSurfaceFaces,
    faceIndex: localTriangleIndex,
    part,
    surfaceTriangleFacetIndices,
  });
  const globalCellOrdinal =
    surfaceTriangleGlobalCellOrdinals?.[localTriangleIndex];
  const elementFamily = meshElementFamilyFromCellType(
    surfaceTriangleCellTypes?.[localTriangleIndex],
  );
  if (
    boundaryFaceIndex === null ||
    globalCellOrdinal === undefined ||
    !elementFamily
  ) {
    return {
      boundaryFaceIndex: null,
      elementFamily: null,
      globalCellOrdinal: null,
    };
  }
  return {
    boundaryFaceIndex,
    elementFamily,
    globalCellOrdinal: globalCellOrdinal.toString(10),
  };
}

function meshElementFamilyFromCellType(
  cellType: number | undefined,
): MeshElementFamily | null {
  switch (cellType) {
    case 1:
      return "tet4";
    case 2:
      return "prism6";
    case 3:
      return "pyramid5";
    case 4:
      return "hex8";
    default:
      return null;
  }
}

export function resolveRetainedMeshPartScalarColors({
  current,
  previous,
  scalarColorMode,
  settings,
  topologyRevision,
  vertexCount,
}: {
  current: ScalarColorBuffer | null;
  previous: ScalarColorBuffer | null;
  scalarColorMode: string | null;
  settings: Pick<
    VisualizationTargetSettings,
    "activeQuantityId" | "scalarColorPalette"
  > &
    Partial<Pick<VisualizationTargetSettings, "surfaceProjectionMode">>;
  topologyRevision?: number | string | null;
  vertexCount: number;
}): ScalarColorBuffer | null {
  if (current) return current;
  if (!scalarColorMode) return null;
  return scalarColorBufferMatchesRetainedSettings(
    previous,
    scalarColorMode,
    settings,
    topologyRevision,
    vertexCount,
  )
    ? previous
    : null;
}

export function resolveMeshPartVisibleScalarColorState({
  effectiveScalarColors,
  meshQualityColors,
  surfaceVertexCount,
  vertexColorsEnabled,
  visibleScalarColors,
}: {
  effectiveScalarColors: ScalarColorBuffer | null;
  meshQualityColors: ScalarColorBuffer | null;
  surfaceVertexCount: number;
  vertexColorsEnabled: boolean;
  visibleScalarColors:
    | Viewport3DScalarColorUploadResult
    | ScalarColorBuffer
    | null
    | undefined;
}): {
  canUseVertexScalarColors: boolean;
  hasScalarColors: boolean;
} {
  const actualBuffer =
    visibleScalarColors && typeof visibleScalarColors === "object" && "buffer" in visibleScalarColors
      ? visibleScalarColors.buffer
      : (visibleScalarColors ?? null);
  const visibleOrPendingColors = actualBuffer ?? effectiveScalarColors;
  const canUseVertexScalarColors =
    Boolean(meshQualityColors) ||
    (vertexColorsEnabled &&
      canApplyVertexScalarColorBuffer(
        visibleOrPendingColors,
        surfaceVertexCount,
      ));
  return {
    canUseVertexScalarColors,
    hasScalarColors: Boolean(canUseVertexScalarColors && actualBuffer),
  };
}

function scalarColorBufferMatchesSettings(
  buffer: ScalarColorBuffer | null,
  scalarColorMode: string,
  settings: Pick<
    VisualizationTargetSettings,
    "activeQuantityId" | "scalarColorPalette"
  > &
    Partial<Pick<VisualizationTargetSettings, "surfaceProjectionMode">>,
): buffer is ScalarColorBuffer {
  if (!buffer) return false;
  if (buffer.colorMode && buffer.colorMode !== scalarColorMode) return false;
  if (
    buffer.colorPalette &&
    settings.scalarColorPalette &&
    buffer.colorPalette !== settings.scalarColorPalette
  ) {
    return false;
  }
  if (
    buffer.quantityId &&
    !sameRenderableFieldQuantityId(buffer.quantityId, settings.activeQuantityId)
  ) {
    return false;
  }
  if (
    buffer.projectionMode &&
    settings.surfaceProjectionMode &&
    buffer.projectionMode !== settings.surfaceProjectionMode
  ) {
    return false;
  }
  return true;
}

export function scalarColorBufferMatchesRetainedSettings(
  buffer: ScalarColorBuffer | null,
  scalarColorMode: string,
  settings: Pick<
    VisualizationTargetSettings,
    "activeQuantityId" | "scalarColorPalette"
  > &
    Partial<Pick<VisualizationTargetSettings, "surfaceProjectionMode">>,
  topologyRevision: number | string | null | undefined,
  vertexCount: number,
): buffer is ScalarColorBuffer {
  if (!buffer) return false;
  if (buffer.colorMode && buffer.colorMode !== scalarColorMode) return false;
  if (
    buffer.colorPalette &&
    settings.scalarColorPalette &&
    buffer.colorPalette !== settings.scalarColorPalette
  ) {
    return false;
  }
  if (
    buffer.quantityId &&
    !sameRenderableFieldQuantityId(buffer.quantityId, settings.activeQuantityId)
  ) {
    return false;
  }
  if (
    buffer.topologyRevision &&
    topologyRevision !== undefined &&
    topologyRevision !== null &&
    buffer.topologyRevision !== String(topologyRevision)
  ) {
    return false;
  }
  if (
    buffer.projectionMode &&
    settings.surfaceProjectionMode &&
    buffer.projectionMode !== settings.surfaceProjectionMode
  ) {
    return false;
  }
  return (
    canApplyVertexScalarColorBuffer(buffer, vertexCount) ||
    canApplyScalarShaderColorBuffer(buffer, vertexCount)
  );
}

export function resolveMeshPartSurfacePassPolicies(surfaceOpacity: number): {
  back: ReturnType<typeof surfaceMaterialPolicyProps>;
  front: ReturnType<typeof surfaceMaterialPolicyPropsFront>;
  renderOrderBack: number;
  renderOrderFront: number | null;
} {
  const back = surfaceMaterialPolicyProps(surfaceOpacity);
  const front = surfaceMaterialPolicyPropsFront(surfaceOpacity);
  return {
    back,
    front,
    renderOrderBack: back.transparent
      ? RENDER_POLICIES.contextSurface.renderOrder
      : RENDER_POLICIES.solidSurface.renderOrder,
    renderOrderFront: front
      ? RENDER_POLICIES.contextSurfaceFront.renderOrder
      : null,
  };
}

export function createMeshPartScalarShaderMaterials({
  buffer,
  enabled,
  materialProfile,
  surfaceOpacity = 1,
  surfacePolicy = RENDER_POLICIES.solidSurface,
  surfacePolicyFront = RENDER_POLICIES.contextSurfaceFront,
  tracker,
}: {
  buffer: ScalarColorBuffer | null | undefined;
  enabled: boolean;
  materialProfile: Pick<Viewport3DMaterialProfile["magneticSurface"], "toneMapped" | "shadeStrength"> &
    Partial<Pick<Viewport3DMaterialProfile["magneticSurface"], "presentation">>;
  surfaceOpacity?: number;
  surfacePolicy?: ReturnType<typeof surfaceMaterialPolicyProps>;
  surfacePolicyFront?: ReturnType<typeof surfaceMaterialPolicyPropsFront> | null;
  tracker: Pick<Viewport3DResourceTracker, "track" | "release">;
}): {
  back: Viewport3DScalarSurfaceMaterial | null;
  front: Viewport3DScalarSurfaceMaterial | null;
} {
  if (!enabled || !buffer) {
    return { back: null, front: null };
  }
  const back = tracker.track(
    "material",
    createScalarSurfaceShaderMaterial(buffer, {
      ...surfacePolicy,
      opacity: surfaceOpacity,
      shadeStrength: materialProfile.shadeStrength,
      toneMapped: materialProfile.toneMapped,
      presentation: materialProfile.presentation,
    }),
  );
  const front = surfacePolicyFront
    ? tracker.track(
        "material",
        createScalarSurfaceShaderMaterial(buffer, {
          ...surfacePolicyFront,
          opacity: surfaceOpacity,
          shadeStrength: materialProfile.shadeStrength,
          toneMapped: materialProfile.toneMapped,
          presentation: materialProfile.presentation,
        }),
      )
    : null;
  return { back, front };
}

/** The handoff and actual layer render must agree on visible, realized content. */
export function hasMeshPartRenderableLayer({
  renderPlan, surfaceReady, wireframeReady, pointsReady, vectorsReady,
  modalSurfaceActive = false, modalVectorsActive = false,
}: {
  renderPlan: Viewport3DTargetRenderPlan;
  surfaceReady: boolean;
  wireframeReady: boolean;
  pointsReady: boolean;
  vectorsReady: boolean;
  modalSurfaceActive?: boolean;
  modalVectorsActive?: boolean;
}): boolean {
  return ((modalSurfaceActive || renderPlan.surface.visible) && surfaceReady) ||
    (renderPlan.wireframe.visible && wireframeReady) ||
    (renderPlan.points.visible && pointsReady) || renderPlan.bounds.visible ||
    ((modalVectorsActive || renderPlan.vectors.visible) && vectorsReady);
}

export function resolveMeshPartPointNodeSelection(
  geometryScope: "full" | "surface",
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>,
): Viewport3DNodeSelection {
  return geometryScope === "full"
    ? partModel.fullNodeSelection
    : partModel.surfaceNodeSelection ?? { nodeIndices: [] };
}

export function recordMeshPartSurfaceAdoption({
  carrierId,
  fieldBufferId,
  ownerId,
  registry,
  sessionIdentity,
  scalarBuffer,
}: {
  carrierId: string;
  fieldBufferId: string | null;
  ownerId?: string;
  registry: Viewport3DRenderAdoptionRegistry;
  sessionIdentity?: SessionResourceIdentity | null;
  scalarBuffer: ScalarColorBuffer;
}): Viewport3DRenderAdoptionIdentity {
  const adoption = {
    carrierId,
    fieldBufferId: scalarBuffer.sourceFieldBufferId ?? fieldBufferId,
    kind: "surface" as const,
    resourceKey: scalarBuffer.sourceResourceKey ?? null,
    scalarBufferKey: resolveViewport3DScalarColorBufferKey(scalarBuffer),
    vectorBuildKey: null,
  };
  registry.recordSurfaceAdoption({
    byteLength:
      scalarBuffer.colors.byteLength +
      (scalarBuffer.scalarValues?.byteLength ?? 0),
    ownerId,
    ...adoption,
    sessionIdentity,
  });
  return adoption;
}

export function resolveMeshPartWireframeEdgeIndices(
  geometryScope: VisualizationTargetSettings["geometryScope"],
  partModel: Pick<
    Viewport3DTopologyPartRenderModel<Viewport3DMeshPart>,
    "edgeIndices" | "volumeEdgeIndices"
  >,
  wireframeVisible = true,
): Uint32Array | null {
  if (!wireframeVisible) return null;
  if (geometryScope === "full") {
    return partModel.volumeEdgeIndices;
  }

  return partModel.edgeIndices;
}
