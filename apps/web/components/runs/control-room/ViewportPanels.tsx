"use client";

import { memo, useMemo, useCallback, useEffect } from "react";

import { MAGNETIC_PRESET_CATALOG } from "@/lib/magnetizationPresetCatalog";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
import type { TextureTransform3D as PreviewTextureTransform3D } from "@/lib/textureTransform";
import type { TextureGizmoMode } from "../../preview/TextureTransformGizmo";
import MagnetizationSlice2D from "../../preview/MagnetizationSlice2D";
import VectorFieldView3D from "../../preview/VectorFieldView3D";
import FemMeshView3D from "../../preview/FemMeshView3D";
import { ViewportErrorBoundary } from "../../preview/ViewportErrorBoundary";
import FemMeshSlice2D from "../../preview/FemMeshSlice2DPlotly";
import PreviewScalarField2D from "../../preview/PreviewScalarField2D";
import BoundsPreview3D from "../../preview/BoundsPreview3D";
import EmptyState from "../../ui/EmptyState";
import AnalyzeViewport from "./AnalyzeViewport";

import {
  fmtExp,
  fmtSI,
  resolveAntennaNodeName,
} from "./shared";
import { useTransport, useViewport, useCommand, useModel } from "./context-hooks";
import type {
  MeshEntityViewStateMap,
} from "../../../lib/session/types";
import { defaultMeshEntityViewState } from "../../../lib/session/types";
import {
  toPreviewTextureTransform,
  toSceneTextureTransform,
  textureTransformToWorld,
  textureTransformToLocal,
} from "./viewportUtils";
import type { Vec3, Quat } from "./viewportUtils";
export { ViewportBar } from "./ViewportBar";
import { TelemetryHUD } from "./ViewportBar";

export const ViewportCanvasArea = memo(function ViewportCanvasArea() {
  /* Granular hooks replacing useControlRoom */
  const _transport = useTransport();
  const _viewport = useViewport();
  const _cmd = useCommand();
  const _model = useModel();
  const ctx = { ..._transport, ..._viewport, ..._cmd, ..._model };
  const minimalViewportSelectionPath = FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.useMinimalViewportSelectionPath;
  const setSelectedObjectId = ctx.setSelectedObjectId;
  const setSelectedSidebarNodeId = ctx.setSelectedSidebarNodeId;
  const meshParts = ctx.meshParts;
  const setMeshEntityViewState = ctx.setMeshEntityViewState;
  const rightInspectorOpen = useWorkspaceStore((state) => state.rightInspectorOpen);
  const setRightInspectorOpen = useWorkspaceStore((state) => state.setRightInspectorOpen);
  const rightInspectorTab = useWorkspaceStore((state) => state.rightInspectorTab);
  const setRightInspectorTab = useWorkspaceStore((state) => state.setRightInspectorTab);
  const effectiveViewMode = ctx.effectiveViewMode;
  const femMeshData = ctx.femMeshData;
  const visibleSubmeshSnapshot = ctx.visibleSubmeshSnapshot;
  const setVisibleSubmeshSnapshot = ctx.setVisibleSubmeshSnapshot;
  const updatePreview = ctx.updatePreview;
  const spatialPreview = ctx.preview?.kind === "spatial" ? ctx.preview : null;
  const globalScalarPreview = ctx.preview?.kind === "global_scalar" ? ctx.preview : null;
  const hasVectorData = Boolean(ctx.selectedVectors && ctx.selectedVectors.length > 0);
  const selectedMagnetizationAsset = useMemo(() => {
    if (!ctx.sceneDocument || !ctx.selectedObjectId) {
      return null;
    }
    const selectedObject = ctx.sceneDocument.objects.find(
      (object) =>
        object.id === ctx.selectedObjectId || object.name === ctx.selectedObjectId,
    );
    if (!selectedObject) {
      return null;
    }
    return (
      ctx.sceneDocument.magnetization_assets.find(
        (asset) => asset.id === selectedObject.magnetization_ref,
      ) ?? null
    );
  }, [ctx.sceneDocument, ctx.selectedObjectId]);
  const selectedSceneObject = useMemo(() => {
    if (!ctx.sceneDocument || !ctx.selectedObjectId) {
      return null;
    }
    return (
      ctx.sceneDocument.objects.find(
        (object) =>
          object.id === ctx.selectedObjectId || object.name === ctx.selectedObjectId,
      ) ?? null
    );
  }, [ctx.sceneDocument, ctx.selectedObjectId]);
  const activeTextureMappingSpace =
    selectedMagnetizationAsset?.mapping?.space === "world" ? "world" : "object";
  const selectedObjectTransform = useMemo(() => {
    if (!selectedSceneObject) {
      return {
        translation: [0, 0, 0] as Vec3,
        rotation_quat: [0, 0, 0, 1] as Quat,
        scale: [1, 1, 1] as Vec3,
      };
    }
    return {
      translation: [...selectedSceneObject.transform.translation] as Vec3,
      rotation_quat: [...selectedSceneObject.transform.rotation_quat] as Quat,
      scale: [...selectedSceneObject.transform.scale] as Vec3,
    };
  }, [selectedSceneObject]);
  const activeTextureTransform =
    selectedMagnetizationAsset?.kind === "preset_texture" && ctx.activeTransformScope !== "object"
      ? (() => {
          const base = toPreviewTextureTransform(selectedMagnetizationAsset.texture_transform);
          if (activeTextureMappingSpace !== "object") {
            return base;
          }
          // In object-space mapping, we author texture transform in object-local coordinates.
          // The viewport gizmo operates in world-space, so apply full object transform for display.
          return textureTransformToWorld(base, selectedObjectTransform);
        })()
      : null;
  const activeTexturePreviewProxy =
    selectedMagnetizationAsset?.preset_kind
      ? (
          MAGNETIC_PRESET_CATALOG.find(
            (descriptor) => descriptor.kind === selectedMagnetizationAsset.preset_kind,
          )?.previewProxy ?? "box"
        )
      : "box";
  const activeTextureGizmoMode: TextureGizmoMode =
    ctx.sceneDocument?.editor.gizmo_mode === "rotate"
      ? "rotate"
      : ctx.sceneDocument?.editor.gizmo_mode === "scale"
        ? "scale"
        : "translate";
  const applyTextureTransform = (next: PreviewTextureTransform3D) => {
    if (!ctx.selectedObjectId) {
      return;
    }
    ctx.setSceneDocument((previousScene) => {
      if (!previousScene) {
        return previousScene;
      }
      const selectedObject = previousScene.objects.find(
        (object) =>
          object.id === ctx.selectedObjectId || object.name === ctx.selectedObjectId,
      );
      if (!selectedObject) {
        return previousScene;
      }
      const selectedMagnetization = previousScene.magnetization_assets.find(
        (asset) => asset.id === selectedObject.magnetization_ref,
      );
      if (!selectedMagnetization) {
        return previousScene;
      }
      const mappingSpace =
        selectedMagnetization.mapping?.space === "world" ? "world" : "object";
      const nextLocalTransform =
        mappingSpace === "world"
          ? next
          : textureTransformToLocal(next, {
              translation: [...selectedObject.transform.translation] as Vec3,
              rotation_quat: [...selectedObject.transform.rotation_quat] as Quat,
              scale: [...selectedObject.transform.scale] as Vec3,
            });
      const normalizedTransform =
        selectedMagnetization.kind === "preset_texture" &&
        selectedMagnetization.preset_kind === "vortex"
          ? {
              ...nextLocalTransform,
              pivot: [0, 0, 0] as Vec3,
            }
          : nextLocalTransform;
      return {
        ...previousScene,
        magnetization_assets: previousScene.magnetization_assets.map((asset) =>
          asset.id === selectedObject.magnetization_ref
            ? {
                ...asset,
                texture_transform: toSceneTextureTransform(normalizedTransform),
              }
            : asset,
        ),
        editor: {
          ...previousScene.editor,
          active_transform_scope: "texture",
        },
      };
    });
  };

  const handleRequestObjectSelect = useCallback(
    (objectId: string) => {
      setSelectedObjectId(objectId);
      setSelectedSidebarNodeId(`obj-${objectId}`);
    },
    [setSelectedObjectId, setSelectedSidebarNodeId],
  );

  const selectedAntennaName = resolveAntennaNodeName(
    ctx.selectedSidebarNodeId,
    ctx.scriptBuilderCurrentModules.map((module) => module.name),
  );
  const visibleObjectIds = useMemo(
    () =>
      (ctx.sceneDocument?.objects ?? [])
        .filter((object) => object.visible !== false)
        .map((object) => object.name || object.id)
        .filter((id) => id.length > 0),
    [ctx.sceneDocument?.objects],
  );
  const antennaPreviewBadgeVisible =
    ctx.antennaOverlays.length > 0 &&
    (ctx.requestedPreviewQuantity === "H_ant" || selectedAntennaName != null);
  const selectedFemObjectId = ctx.selectedObjectId;
  const selectedObjectOverlay = useMemo(
    () =>
      selectedFemObjectId
        ? ctx.objectOverlays.find((overlay) => overlay.id === selectedFemObjectId) ?? null
        : null,
    [ctx.objectOverlays, selectedFemObjectId],
  );
  const displayObjectOverlays = useMemo(
    () => {
      if (ctx.isFemBackend && ctx.meshParts.length > 0) {
        return ctx.objectOverlays.filter((overlay) =>
          ctx.visibleMagneticObjectIds.includes(overlay.id),
        );
      }
      return ctx.objectOverlays.filter((overlay) => visibleObjectIds.includes(overlay.id));
    },
    [ctx.isFemBackend, ctx.meshParts.length, ctx.objectOverlays, ctx.visibleMagneticObjectIds, visibleObjectIds],
  );
  const patchMeshPartViewState = useCallback(
    (partIds: string[], patch: Partial<MeshEntityViewStateMap[string]>) => {
      if (partIds.length === 0) {
        return;
      }
      setMeshEntityViewState((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const partId of partIds) {
          const part = meshParts.find((candidate) => candidate.id === partId);
          const current = next[partId] ?? (part ? defaultMeshEntityViewState(part) : null);
          if (!current) continue;
          const updated = { ...current, ...patch };
          if (
            !next[partId] ||
            updated.visible !== current.visible ||
            updated.renderMode !== current.renderMode ||
            updated.opacity !== current.opacity ||
            updated.colorField !== current.colorField
          ) {
            next[partId] = updated;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [meshParts, setMeshEntityViewState],
  );
  const openSelectedSubmeshesToolbox = useCallback(() => {
    setRightInspectorOpen(true);
    setRightInspectorTab("selected-submeshes");
  }, [setRightInspectorOpen, setRightInspectorTab]);
  const selectedSubmeshesToolboxOpen =
    rightInspectorOpen && rightInspectorTab === "selected-submeshes";
  useEffect(() => {
    const femSubmeshViewportActive =
      Boolean(femMeshData) &&
      (effectiveViewMode === "3D" || effectiveViewMode === "Mesh");
    if (femSubmeshViewportActive) {
      return;
    }
    if (visibleSubmeshSnapshot != null) {
      setVisibleSubmeshSnapshot(null);
    }
  }, [
    effectiveViewMode,
    femMeshData,
    setVisibleSubmeshSnapshot,
    visibleSubmeshSnapshot,
  ]);
  const femQuantityOptions = useMemo(
    () =>
      ctx.previewQuantityOptions.map((option) => ({
        id: option.value,
        shortLabel: option.label,
        label: option.label,
        available: !option.disabled,
      })),
    [ctx.previewQuantityOptions],
  );
  const handlePreviewMaxPointsChange = useCallback(
    (nextMaxPoints: number) => void updatePreview("/maxPoints", { maxPoints: nextMaxPoints }),
    [updatePreview],
  );
  const hasExactScopeSegment = useMemo(
    () => {
      if (!selectedFemObjectId) {
        return false;
      }
      const meshParts = ctx.effectiveFemMesh?.mesh_parts ?? [];
      if (meshParts.length > 0) {
        return meshParts.some(
          (part) => part.role === "magnetic_object" && part.object_id === selectedFemObjectId,
        );
      }
      return (ctx.effectiveFemMesh?.object_segments ?? []).some(
        (segment) => segment.object_id === selectedFemObjectId,
      );
    },
    [ctx.effectiveFemMesh?.mesh_parts, ctx.effectiveFemMesh?.object_segments, selectedFemObjectId],
  );
  const missingExactScopeSegment = Boolean(
    ctx.isFemBackend &&
      ctx.femMeshData &&
      ctx.femMeshData.nElements > 0 &&
      selectedFemObjectId &&
      !hasExactScopeSegment,
  );

  /* ── Determine which viewport is active ── */
  const isFdm3DActive =
    ctx.effectiveViewMode === "3D" &&
    !ctx.isFemBackend &&
    (ctx.isVectorQuantity || hasVectorData) &&
    !globalScalarPreview;
  // Use classic FDM mesh view ONLY if no unstructured mesh data is available
  const isFdmMeshActive = ctx.effectiveViewMode === "Mesh" && !ctx.isFemBackend && !ctx.femMeshData;
  const showFdm3D =
    (isFdm3DActive && FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFdm3D) ||
    (isFdmMeshActive && FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFdmMeshWorkspace);
  const showFemBoundsPreview =
    ctx.isFemBackend &&
    !ctx.femMeshData &&
    (ctx.effectiveViewMode === "3D" || ctx.effectiveViewMode === "Mesh") &&
    displayObjectOverlays.length > 0;

  /* ── Determine what goes into the conditional slot ── */
  let conditionalContent: React.ReactNode = null;

  if (minimalViewportSelectionPath) {
    if (ctx.femMeshData) {
      conditionalContent = (
        <ViewportErrorBoundary label="Minimal FEM Wireframe Viewport">
          <FemMeshView3D
            topologyKey={ctx.femTopologyKey ?? undefined}
            meshData={ctx.femMeshData}
            colorField="none"
            toolbarMode={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showToolbar ? "visible" : "hidden"}
            renderMode={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe ? "wireframe" : ctx.meshRenderMode}
            opacity={1}
            clipEnabled={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceDisableClip ? false : ctx.meshClipEnabled}
            clipAxis={ctx.meshClipAxis}
            clipPos={ctx.meshClipPos}
            showArrowsRequested={false}
            showOrientationLegend={false}
            worldExtent={ctx.worldExtent}
            worldCenter={ctx.worldCenter}
            partExplorerOpen={selectedSubmeshesToolboxOpen}
            onTogglePartExplorer={openSelectedSubmeshesToolbox}
            onVisibleSubmeshSnapshotChange={ctx.setVisibleSubmeshSnapshot}
          />
        </ViewportErrorBoundary>
      );
    } else if (
      FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableBoundsPreview &&
      displayObjectOverlays.length > 0
    ) {
      conditionalContent = (
        <BoundsPreview3D
          objectOverlays={displayObjectOverlays}
          selectedObjectId={selectedFemObjectId}
          focusObjectRequest={ctx.focusObjectRequest}
          worldExtent={ctx.worldExtent}
          worldCenter={ctx.worldCenter}
          onRequestObjectSelect={handleRequestObjectSelect}
          onGeometryTranslate={ctx.applyGeometryTranslation}
        />
      );
    } else {
      conditionalContent = (
        <div className="flex h-full w-full items-center justify-center opacity-70">
          <EmptyState
            title="Minimal Diagnostic View"
            description="Aktywny jest tymczasowy tryb diagnostyczny frontendu. Pozostawiono tylko prosty viewport."
            tone="info"
            compact
          />
        </div>
      );
    }
  } else if (
    globalScalarPreview &&
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableGlobalScalarCard
  ) {
    conditionalContent = (
      <div className="flex h-full w-full items-center justify-center p-6">
        <div className="flex min-w-[280px] max-w-[520px] flex-col gap-4 rounded-2xl border border-border/50 bg-card/70 p-8 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur">
          <div className="space-y-1">
            <p className="text-[0.68rem] font-semibold uppercase tracking-widest text-muted-foreground">
              Global Scalar
            </p>
            <h3 className="text-base font-semibold text-foreground">
              {ctx.quantityDescriptor?.label ?? globalScalarPreview.quantity}
            </h3>
          </div>
          <div className="font-mono text-lg font-medium tracking-tight text-foreground">
            {fmtExp(globalScalarPreview.value)}
          </div>
          <div className="flex flex-wrap gap-3 text-[0.72rem] text-muted-foreground">
            <span>{globalScalarPreview.unit}</span>
            <span>step {globalScalarPreview.source_step.toLocaleString()}</span>
            <span>{fmtSI(globalScalarPreview.source_time, "s")}</span>
          </div>
        </div>
      </div>
    );
  } else if (!ctx.isVectorQuantity && !hasVectorData && !ctx.femMeshData) {
    conditionalContent = (
      <div className="flex flex-col items-center justify-center h-full w-full opacity-60">
        <EmptyState
          title={ctx.quantityDescriptor?.label ?? "Scalar quantity"}
          description={
            ctx.selectedScalarValue !== null
              ? `Latest: ${ctx.selectedScalarValue.toExponential(4)} ${ctx.quantityDescriptor?.unit ?? ""}`
              : "Scalar — see Scalars in sidebar."
          }
          tone="info"
          compact
        />
      </div>
    );
  } else if (
    spatialPreview &&
    spatialPreview.spatial_kind === "grid" &&
    spatialPreview.type === "2D" &&
    spatialPreview.scalar_field.length > 0 &&
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableGridScalar2D
  ) {
    conditionalContent = (
      <PreviewScalarField2D
        data={spatialPreview.scalar_field}
        grid={spatialPreview.preview_grid}
        quantityLabel={ctx.quantityDescriptor?.label ?? spatialPreview.quantity}
        quantityUnit={spatialPreview.unit}
        component={spatialPreview.component}
        min={spatialPreview.min}
        max={spatialPreview.max}
      />
    );
  } else if (
    ctx.effectiveViewMode === "Mesh" &&
    ctx.femMeshData &&
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFemMeshWorkspace
  ) {
    conditionalContent = (
      <ViewportErrorBoundary label="FEM Mesh Viewport">
      <FemMeshView3D
        topologyKey={ctx.femTopologyKey ?? undefined}
        meshData={ctx.femMeshData}
        quantityId={ctx.requestedPreviewQuantity}
        quantityOptions={femQuantityOptions}
        colorField="none"
        toolbarMode={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showToolbar ? "visible" : "hidden"}
        renderMode={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe ? "wireframe" : ctx.meshRenderMode}
        opacity={ctx.meshOpacity}
        clipEnabled={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceDisableClip ? false : ctx.meshClipEnabled}
        clipAxis={ctx.meshClipAxis}
        clipPos={ctx.meshClipPos}
        previewMaxPoints={ctx.requestedPreviewMaxPoints}
        onRenderModeChange={ctx.setMeshRenderMode}
        onOpacityChange={ctx.setMeshOpacity}
        onClipEnabledChange={ctx.setMeshClipEnabled}
        onClipAxisChange={ctx.setMeshClipAxis}
        onClipPosChange={ctx.setMeshClipPos}
        onPreviewMaxPointsChange={handlePreviewMaxPointsChange}
        onSelectionChange={ctx.setMeshSelection}
        onRefine={ctx.handleLassoRefine}
        antennaOverlays={ctx.antennaOverlays}
        selectedAntennaId={selectedAntennaName}
        objectOverlays={displayObjectOverlays}
        selectedObjectId={selectedFemObjectId}
        selectedEntityId={ctx.selectedEntityId}
        focusedEntityId={ctx.focusedEntityId}
        objectViewMode={ctx.objectViewMode}
        objectSegments={ctx.effectiveFemMesh?.object_segments ?? []}
        meshParts={ctx.meshParts}
        elementMarkers={ctx.effectiveFemMesh?.element_markers ?? null}
        perDomainQuality={ctx.effectiveFemMesh?.per_domain_quality ?? null}
        meshEntityViewState={ctx.meshEntityViewState}
        onMeshPartViewStatePatch={patchMeshPartViewState}
        visibleObjectIds={visibleObjectIds}
        airSegmentVisible={ctx.airMeshVisible}
        airSegmentOpacity={ctx.airMeshOpacity}
        focusObjectRequest={ctx.focusObjectRequest}
        onAntennaTranslate={ctx.applyAntennaTranslation}
        worldExtent={ctx.worldExtent}
        worldCenter={ctx.worldCenter}
        onEntitySelect={ctx.setSelectedEntityId}
        onEntityFocus={ctx.setFocusedEntityId}
        onQuantityChange={ctx.requestPreviewQuantity}
        activeTextureTransform={activeTextureTransform}
        textureGizmoMode={activeTextureGizmoMode}
        activeTexturePreviewProxy={activeTexturePreviewProxy}
        activeTransformScope={ctx.activeTransformScope}
        onTextureTransformChange={applyTextureTransform}
        onTextureTransformCommit={applyTextureTransform}
        partExplorerOpen={selectedSubmeshesToolboxOpen}
        onTogglePartExplorer={openSelectedSubmeshesToolbox}
        onVisibleSubmeshSnapshotChange={ctx.setVisibleSubmeshSnapshot}
      />
      </ViewportErrorBoundary>
    );
  } else if (
    ctx.effectiveViewMode === "3D" &&
    ctx.femMeshData &&
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFem3D
  ) {
    conditionalContent = (
      <ViewportErrorBoundary label="FEM 3D Viewport">
      <FemMeshView3D
        topologyKey={ctx.femTopologyKey ?? undefined}
        meshData={ctx.femMeshData}
        fieldLabel={ctx.quantityDescriptor?.label ?? ctx.selectedQuantity}
        quantityId={ctx.requestedPreviewQuantity}
        quantityOptions={femQuantityOptions}
        colorField={ctx.femColorField}
        showOrientationLegend={ctx.femMagnetization3DActive}
        renderMode={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe ? "wireframe" : ctx.meshRenderMode}
        opacity={ctx.meshOpacity}
        clipEnabled={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceDisableClip ? false : ctx.meshClipEnabled}
        clipAxis={ctx.meshClipAxis}
        clipPos={ctx.meshClipPos}
        showArrowsRequested={ctx.meshShowArrows}
        arrowColorMode={ctx.femArrowColorMode}
        arrowMonoColor={ctx.femArrowMonoColor}
        arrowAlpha={ctx.femArrowAlpha}
        arrowLengthScale={ctx.femArrowLengthScale}
        arrowThickness={ctx.femArrowThickness}
        vectorDomainFilter={ctx.femVectorDomainFilter}
        ferromagnetVisibilityMode={ctx.femFerromagnetVisibilityMode}
        previewMaxPoints={ctx.requestedPreviewMaxPoints}
        onRenderModeChange={ctx.setMeshRenderMode}
        onOpacityChange={ctx.setMeshOpacity}
        onClipEnabledChange={ctx.setMeshClipEnabled}
        onClipAxisChange={ctx.setMeshClipAxis}
        onClipPosChange={ctx.setMeshClipPos}
        onShowArrowsChange={ctx.setMeshShowArrows}
        onArrowColorModeChange={ctx.setFemArrowColorMode}
        onArrowMonoColorChange={ctx.setFemArrowMonoColor}
        onArrowAlphaChange={ctx.setFemArrowAlpha}
        onArrowLengthScaleChange={ctx.setFemArrowLengthScale}
        onArrowThicknessChange={ctx.setFemArrowThickness}
        onVectorDomainFilterChange={ctx.setFemVectorDomainFilter}
        onFerromagnetVisibilityModeChange={ctx.setFemFerromagnetVisibilityMode}
        onPreviewMaxPointsChange={handlePreviewMaxPointsChange}
        onSelectionChange={ctx.setMeshSelection}
        antennaOverlays={ctx.antennaOverlays}
        selectedAntennaId={selectedAntennaName}
        objectOverlays={displayObjectOverlays}
        selectedObjectId={selectedFemObjectId}
        selectedEntityId={ctx.selectedEntityId}
        focusedEntityId={ctx.focusedEntityId}
        objectViewMode={ctx.objectViewMode}
        objectSegments={ctx.effectiveFemMesh?.object_segments ?? []}
        meshParts={ctx.meshParts}
        elementMarkers={ctx.effectiveFemMesh?.element_markers ?? null}
        perDomainQuality={ctx.effectiveFemMesh?.per_domain_quality ?? null}
        meshEntityViewState={ctx.meshEntityViewState}
        onMeshPartViewStatePatch={patchMeshPartViewState}
        visibleObjectIds={visibleObjectIds}
        airSegmentVisible={ctx.airMeshVisible}
        airSegmentOpacity={ctx.airMeshOpacity}
        focusObjectRequest={ctx.focusObjectRequest}
        onAntennaTranslate={ctx.applyAntennaTranslation}
        worldExtent={ctx.worldExtent}
        worldCenter={ctx.worldCenter}
        onQuantityChange={ctx.requestPreviewQuantity}
        activeTextureTransform={activeTextureTransform}
        textureGizmoMode={activeTextureGizmoMode}
        activeTexturePreviewProxy={activeTexturePreviewProxy}
        activeTransformScope={ctx.activeTransformScope}
        onTextureTransformChange={applyTextureTransform}
        onTextureTransformCommit={applyTextureTransform}
        partExplorerOpen={selectedSubmeshesToolboxOpen}
        onTogglePartExplorer={openSelectedSubmeshesToolbox}
        onVisibleSubmeshSnapshotChange={ctx.setVisibleSubmeshSnapshot}
      />
      </ViewportErrorBoundary>
    );
  } else if (
    ctx.effectiveViewMode === "2D" &&
    ctx.femMeshData &&
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFemSlice2D
  ) {
    conditionalContent = (
      <FemMeshSlice2D
        meshData={ctx.femMeshData}
        quantityLabel={ctx.quantityDescriptor?.label ?? ctx.selectedQuantity}
        quantityId={ctx.selectedQuantity}
        component={ctx.effectiveVectorComponent}
        plane={ctx.plane}
        meshParts={ctx.meshParts}
        meshEntityViewState={ctx.meshEntityViewState}
        airSegmentVisible={ctx.airMeshVisible}
        objectViewMode={ctx.objectViewMode}
        visibleObjectIds={visibleObjectIds}
        vectorDomainFilter={ctx.femVectorDomainFilter}
        clipAxis={ctx.meshClipAxis}
        clipPos={ctx.meshClipPos}
        antennaOverlays={ctx.antennaOverlays}
        selectedAntennaId={selectedAntennaName}
        showArrows={ctx.meshShowArrows}
        previewMaxPoints={ctx.requestedPreviewMaxPoints}
        onPlaneChange={ctx.setPlane}
        onClipAxisChange={ctx.setMeshClipAxis}
        onClipPosChange={ctx.setMeshClipPos}
        onShowArrowsChange={ctx.setMeshShowArrows}
        onPreviewMaxPointsChange={handlePreviewMaxPointsChange}
      />
    );
  } else if (
    ctx.effectiveViewMode === "2D" &&
    !showFdm3D &&
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFdmSlice2D
  ) {
    conditionalContent = (
      <MagnetizationSlice2D
        grid={ctx.previewGrid}
        vectors={ctx.selectedVectors}
        quantityLabel={ctx.quantityDescriptor?.label ?? spatialPreview?.quantity ?? ctx.selectedQuantity}
        quantityId={spatialPreview?.quantity ?? ctx.selectedQuantity}
        component={ctx.component}
        plane={ctx.plane}
        sliceIndex={ctx.sliceIndex}
      />
    );
  } else if (
    ctx.effectiveViewMode === "Analyze" &&
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableAnalyzeViewport
  ) {
    conditionalContent = <AnalyzeViewport />;
  } else if (
    showFemBoundsPreview &&
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableBoundsPreview
  ) {
    conditionalContent = (
      <BoundsPreview3D
        objectOverlays={displayObjectOverlays}
        selectedObjectId={selectedFemObjectId}
        focusObjectRequest={ctx.focusObjectRequest}
        worldExtent={ctx.worldExtent}
        worldCenter={ctx.worldCenter}
        onRequestObjectSelect={handleRequestObjectSelect}
        onGeometryTranslate={ctx.applyGeometryTranslation}
      />
    );
  } else if (!showFdm3D) {
    conditionalContent = (
      <div className="flex flex-col items-center justify-center h-full w-full opacity-60">
        <EmptyState
          title={ctx.emptyStateMessage.title}
          description={ctx.emptyStateMessage.description}
          tone="info"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 h-full min-h-0 min-w-0 relative overflow-hidden [&>*]:min-w-0 [&>*]:min-h-0 [&>*:not(.viewportOverlay)]:flex-1 [&>*:not(.viewportOverlay)]:w-full">
      <TelemetryHUD solverSettings={ctx.solverSettings} />
      {FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showAntennaPreviewBadge && antennaPreviewBadgeVisible ? (
        <div className="viewportOverlay absolute right-4 top-4 z-50 rounded-full border border-cyan-400/25 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-cyan-200 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
          physics 2.5D · preview extruded
        </div>
      ) : null}
      {FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showFemSelectionBadges && ctx.isFemBackend ? (
        <div className="viewportOverlay absolute right-4 top-14 z-50 flex items-center gap-2">
          <div className="pointer-events-auto rounded-full border border-border/40 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
            {ctx.visibleMeshPartIds.length}/{ctx.meshParts.length || 0} parts visible
          </div>
          {ctx.selectedMeshPart || selectedFemObjectId ? (
            <div className="pointer-events-auto flex overflow-hidden rounded-full border border-border/40 bg-background/85 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
              <button
                type="button"
                className={cn(
                  "px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] transition-colors",
                  ctx.objectViewMode === "context"
                    ? "bg-primary/20 text-primary"
                    : "text-muted-foreground hover:bg-muted/50",
                )}
                onClick={() => ctx.setObjectViewMode("context")}
              >
                Context
              </button>
              <button
                type="button"
                className={cn(
                  "px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] transition-colors",
                  ctx.objectViewMode === "isolate"
                    ? "bg-primary/20 text-primary"
                    : "text-muted-foreground hover:bg-muted/50",
                )}
                onClick={() => ctx.setObjectViewMode("isolate")}
              >
                Isolate
              </button>
            </div>
          ) : null}
          {selectedFemObjectId ? (
            <button
              type="button"
              className="pointer-events-auto rounded-full border border-amber-300/25 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-amber-100 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md transition-colors hover:bg-amber-400/15"
              onClick={() => {
                ctx.setViewMode("3D");
                ctx.requestFocusObject(selectedFemObjectId);
              }}
            >
              Focus {selectedFemObjectId}
            </button>
          ) : null}
          {ctx.selectedMeshPart ? (
            <div className="pointer-events-auto rounded-full border border-amber-300/25 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-amber-100 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
              {ctx.selectedMeshPart.role === "air"
                ? "Airbox Selected"
                : ctx.selectedMeshPart.label || ctx.selectedMeshPart.id}
            </div>
          ) : null}
          {ctx.focusedMeshPart ? (
            <div className="pointer-events-auto rounded-full border border-cyan-300/25 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-cyan-100 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
              Part: {ctx.focusedMeshPart.label || ctx.focusedMeshPart.id}
            </div>
          ) : null}
          {missingExactScopeSegment ? (
            <div className="pointer-events-auto rounded-full border border-rose-300/25 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-rose-200 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
              Missing exact object segmentation
            </div>
          ) : null}
        </div>
      ) : FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showFdmSelectionBadges && ctx.selectedObjectId ? (
        <div className="viewportOverlay absolute right-4 top-14 z-50 flex items-center gap-2">
          <button
            type="button"
            className="pointer-events-auto rounded-full border border-amber-300/25 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-amber-100 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md transition-colors hover:bg-amber-400/15"
            onClick={() => {
              ctx.setViewMode("3D");
              ctx.requestFocusObject(ctx.selectedObjectId!);
            }}
          >
            Focus {ctx.selectedObjectId}
          </button>
          <div className="pointer-events-auto flex overflow-hidden rounded-full border border-border/40 bg-background/85 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
            <button
              type="button"
              className={cn(
                "px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] transition-colors",
                ctx.objectViewMode === "context"
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
              onClick={() => ctx.setObjectViewMode("context")}
            >
              Context
            </button>
            <button
              type="button"
              className={cn(
                "px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] transition-colors",
                ctx.objectViewMode === "isolate"
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
              onClick={() => ctx.setObjectViewMode("isolate")}
            >
              Isolate
            </button>
          </div>
          <div className="pointer-events-auto rounded-full border border-border/40 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
            {selectedObjectOverlay?.source === "mesh_parts"
              ? "Mesh Part"
              : "Object Segment"}
          </div>
        </div>
      ) : null}

      {showFdm3D ? (
        <div className="absolute inset-0">
          <ViewportErrorBoundary label="FDM 3D Viewport">
          <VectorFieldView3D
            grid={ctx.previewGrid}
            vectors={isFdm3DActive ? ctx.selectedVectors : null}
            fieldLabel={
              isFdmMeshActive
                ? "Geometry"
                : ctx.quantityDescriptor?.label ?? spatialPreview?.quantity ?? ctx.selectedQuantity
            }
            geometryMode={isFdmMeshActive}
            activeMask={ctx.activeMask}
            worldExtent={ctx.worldExtent}
            objectOverlays={ctx.objectOverlays}
            selectedObjectId={ctx.selectedObjectId}
            universeCenter={ctx.worldCenter}
            focusObjectRequest={ctx.focusObjectRequest}
            objectViewMode={ctx.objectViewMode}
            settings={ctx.fdmVisualizationSettings}
            onSettingsChange={ctx.setFdmVisualizationSettings}
            onAntennaTranslate={ctx.applyAntennaTranslation}
            onGeometryTranslate={ctx.applyGeometryTranslation}
            onRequestObjectSelect={handleRequestObjectSelect}
            activeTextureTransform={activeTextureTransform}
            textureGizmoMode={activeTextureGizmoMode}
            activeTexturePreviewProxy={activeTexturePreviewProxy}
            onTextureTransformChange={applyTextureTransform}
            onTextureTransformCommit={applyTextureTransform}
            activeTransformScope={ctx.activeTransformScope}
            onTransformScopeChange={(scope) => ctx.setActiveTransformScope(scope)}
            viewportVisible={showFdm3D}
          />
          </ViewportErrorBoundary>
        </div>
      ) : null}

      {/* ── Conditionally-rendered non-GL viewports ── */}
      {conditionalContent}
    </div>
  );
});
