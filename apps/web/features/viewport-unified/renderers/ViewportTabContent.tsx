"use client";

import React from "react";
import dynamic from "next/dynamic";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { DEFAULT_WORKSPACE_SYNC_STATE } from "@/src/features/workspaceSync";
import { ViewportHost } from "@/features";
import { Viewport3DHost } from "@/features/viewport-unified/components/Viewport3DHost";
import {
  resolveViewport3DModeFlags,
  UnifiedViewport3DRenderer,
} from "@/features/viewport-unified/registry/viewport3dRenderRegistry";
import FemMeshView3D from "@/components/preview/FemMeshView3D";
import type { Viewport3DHealthReport } from "@/components/preview/FemMeshView3D";
import { ViewportErrorBoundary } from "@/components/preview/ViewportErrorBoundary";
import EmptyState from "@/components/ui/EmptyState";
import { fmtExp, fmtSI } from "@/components/runs/control-room/shared";
import UnifiedViewport2DPresenter from "@/components/runs/control-room/UnifiedViewport2DPresenter";
import UnifiedViewport3DVectorSurface from "@/components/runs/control-room/UnifiedViewport3DVectorSurface";
import AnalyzeViewport from "@/components/runs/control-room/AnalyzeViewport";
import {
  visualizationPatchForClip,
  visualizationPatchForOpacity,
  visualizationPatchForRenderMode,
  visualizationPatchForVectorStyle,
} from "@/components/runs/control-room/visualizationStateSync";
import { useVectorState, useViewportRenderState } from "@/features/visualization/hooks/useVizSlice";
import { useVisualizationStore } from "@/features/visualization/store/useVisualizationStore";
import { useSelectionActions, useSelectionState } from "@/features/selection";
import type { ViewportDataBridge } from "@/features/viewport-unified/hooks/useViewportDataBridge";

/* ── Dynamic imports ── */

function ViewportModuleLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

const PreviewScalarField2D = dynamic(() => import("@/components/preview/PreviewScalarField2D"), {
  ssr: false,
  loading: () => <ViewportModuleLoading label="Loading scalar viewport..." />,
});

const ResultNodeViewport = dynamic(() => import("@/components/runs/control-room/ResultNodeViewport"), {
  ssr: false,
  loading: () => <ViewportModuleLoading label="Loading result viewport..." />,
});

/* ── Utility ── */

function requireFemTopologyKey(value: string | null): string {
  if (value && value.length > 0) return value;
  throw new Error("[ViewportTabContent] Missing required FEM topologyKey for FemMeshView3D.");
}

const VIEWPORT_BADGE_STYLE = { zIndex: "var(--z-viewport-badge)" } as const;

/* ── Props ── */

export interface ViewportTabContentProps {
  bridge: ViewportDataBridge;
  viewportVisible?: boolean;
  onViewportHealthChange?: (report: Viewport3DHealthReport) => void;
}

/* ── Component ── */

export function ViewportTabContent({
  bridge,
  viewportVisible = true,
  onViewportHealthChange,
}: ViewportTabContentProps) {
  const ctx = bridge.ctx;
  const viz = useViewportRenderState();
  const vectorViz = useVectorState();
  const selection = useSelectionState();
  const selectionActions = useSelectionActions();
  const workspaceSyncState = DEFAULT_WORKSPACE_SYNC_STATE;
  const cameraFitRequestSeed = ctx.cameraFitRequestSeed > 0 ? ctx.cameraFitRequestSeed : null;
  const handleMeshRenderModeChange = React.useCallback(
    (renderMode: React.SetStateAction<typeof viz.meshRenderMode>) => {
      const resolvedRenderMode =
        typeof renderMode === "function" ? renderMode(viz.meshRenderMode) : renderMode;
      void ctx.patchDisplay(visualizationPatchForRenderMode(resolvedRenderMode));
    },
    [ctx, viz.meshRenderMode],
  );
  const handleMeshOpacityChange = React.useCallback(
    (opacity: React.SetStateAction<typeof viz.meshOpacity>) => {
      const resolvedOpacity =
        typeof opacity === "function" ? opacity(viz.meshOpacity) : opacity;
      void ctx.patchDisplay(visualizationPatchForOpacity(resolvedOpacity));
    },
    [ctx, viz.meshOpacity],
  );
  const handleShowArrowsChange = React.useCallback(
    (visible: React.SetStateAction<typeof vectorViz.showArrows>) => {
      const resolvedVisible =
        typeof visible === "function" ? visible(vectorViz.showArrows) : visible;
      void ctx.patchDisplay({
        layers: {
          vectors: {
            visible: resolvedVisible,
          },
        },
      });
    },
    [ctx, vectorViz.showArrows],
  );
  const handleVectorDomainFilterChange = React.useCallback(
    (domain: React.SetStateAction<typeof vectorViz.domainFilter>) => {
      const resolvedDomain =
        typeof domain === "function" ? domain(vectorViz.domainFilter) : domain;
      void ctx.patchDisplay({
        layers: {
          vectors: {
            domain: resolvedDomain,
          },
        },
      });
    },
    [ctx, vectorViz.domainFilter],
  );
  const handleClipEnabledChange = React.useCallback(
    (enabled: React.SetStateAction<typeof viz.meshClipEnabled>) => {
      const resolvedEnabled =
        typeof enabled === "function" ? enabled(viz.meshClipEnabled) : enabled;
      void ctx.patchDisplay(visualizationPatchForClip({ enabled: resolvedEnabled }));
    },
    [ctx, viz.meshClipEnabled],
  );
  const handleClipAxisChange = React.useCallback(
    (axis: React.SetStateAction<typeof viz.meshClipAxis>) => {
      const resolvedAxis = typeof axis === "function" ? axis(viz.meshClipAxis) : axis;
      void ctx.patchDisplay(visualizationPatchForClip({ axis: resolvedAxis }));
    },
    [ctx, viz.meshClipAxis],
  );
  const handleClipPosChange = React.useCallback(
    (positionPercent: React.SetStateAction<typeof viz.meshClipPos>) => {
      const resolvedPosition =
        typeof positionPercent === "function"
          ? positionPercent(viz.meshClipPos)
          : positionPercent;
      void ctx.patchDisplay(visualizationPatchForClip({ positionPercent: resolvedPosition }));
    },
    [ctx, viz.meshClipPos],
  );
  const handleClipFlipChange = React.useCallback(
    (flipped: React.SetStateAction<typeof viz.meshClipFlip>) => {
      const resolvedFlipped =
        typeof flipped === "function" ? flipped(viz.meshClipFlip) : flipped;
      void ctx.patchDisplay(visualizationPatchForClip({ flipped: resolvedFlipped }));
    },
    [ctx, viz.meshClipFlip],
  );
  const handleArrowColorModeChange = React.useCallback(
    (colorMode: React.SetStateAction<typeof vectorViz.colorMode>) => {
      const resolvedColorMode =
        typeof colorMode === "function" ? colorMode(vectorViz.colorMode) : colorMode;
      void ctx.patchDisplay(visualizationPatchForVectorStyle({ colorMode: resolvedColorMode }));
    },
    [ctx, vectorViz.colorMode],
  );
  const handleArrowMonoColorChange = React.useCallback(
    (monoColor: React.SetStateAction<typeof vectorViz.monoColor>) => {
      const resolvedMonoColor =
        typeof monoColor === "function" ? monoColor(vectorViz.monoColor) : monoColor;
      void ctx.patchDisplay(visualizationPatchForVectorStyle({ monoColor: resolvedMonoColor }));
    },
    [ctx, vectorViz.monoColor],
  );
  const handleArrowAlphaChange = React.useCallback(
    (alpha: React.SetStateAction<typeof vectorViz.alpha>) => {
      const resolvedAlpha =
        typeof alpha === "function" ? alpha(vectorViz.alpha) : alpha;
      void ctx.patchDisplay(visualizationPatchForVectorStyle({ alpha: resolvedAlpha }));
    },
    [ctx, vectorViz.alpha],
  );
  const handleArrowLengthScaleChange = React.useCallback(
    (lengthScale: React.SetStateAction<typeof vectorViz.lengthScale>) => {
      const resolvedLengthScale =
        typeof lengthScale === "function" ? lengthScale(vectorViz.lengthScale) : lengthScale;
      void ctx.patchDisplay(
        visualizationPatchForVectorStyle({ lengthScale: resolvedLengthScale }),
      );
    },
    [ctx, vectorViz.lengthScale],
  );
  const handleArrowThicknessChange = React.useCallback(
    (thickness: React.SetStateAction<typeof vectorViz.thickness>) => {
      const resolvedThickness =
        typeof thickness === "function" ? thickness(vectorViz.thickness) : thickness;
      void ctx.patchDisplay(visualizationPatchForVectorStyle({ thickness: resolvedThickness }));
    },
    [ctx, vectorViz.thickness],
  );
  const handleFerromagnetVisibilityModeChange = React.useCallback(
    (ferromagnetVisibility: React.SetStateAction<typeof vectorViz.ferromagnetVisibilityMode>) => {
      const resolvedFerromagnetVisibility =
        typeof ferromagnetVisibility === "function"
          ? ferromagnetVisibility(vectorViz.ferromagnetVisibilityMode)
          : ferromagnetVisibility;
      void ctx.patchDisplay(
        visualizationPatchForVectorStyle({
          ferromagnetVisibility: resolvedFerromagnetVisibility,
        }),
      );
    },
    [ctx, vectorViz.ferromagnetVisibilityMode],
  );
  const handleLegendOpenChange = React.useCallback((open: boolean) => {
    useVisualizationStore.getState().setViewportLegendVisible(open);
  }, []);
  const viewportSelectedObjectId = bridge.viewportSelectedObjectId;
  const geometryViewportPresetActive = bridge.geometryViewportPresetActive;

  /* ── Render helpers ── */

  function renderHostedFemBoundsViewport(mode: "3D" | "Mesh") {
    return (
      <Viewport3DHost
        model={bridge.hostedFemBoundsViewportModel}
        mode={mode}
        discretization="fem"
      >
        <UnifiedViewport3DVectorSurface
          boundaryLabel="Hosted FEM Bounds Fallback Viewport"
          vectorFieldProps={{
            grid: ctx.previewGrid,
            vectors: null,
            fieldLabel: "Bounds Preview",
            geometryMode: true,
            activeMask: null,
            worldExtent: ctx.worldExtent,
            objectOverlays: bridge.femObjectOverlaysForRender,
            selectedObjectId: bridge.selectedFemObjectId,
            universeCenter: ctx.worldCenter,
            focusObjectRequest: selection.focusObjectRequest,
            objectViewMode: ctx.objectViewMode,
            viewportDocumentId: bridge.graphActiveViewportDocumentId,
            persistedCameraState: bridge.graphActiveViewportCameraState,
            onPersistCameraState: bridge.persistViewportCameraState,
            onCameraInteractionChange: bridge.setViewportCameraInteractionActive,
            viewportAxesScope: viz.viewportAxesScope,
            universeWireframeVisible: viz.universeWireframeVisible,
            onRequestObjectSelect: bridge.handleRequestObjectSelect,
            viewport3DModel: bridge.hostedFemBoundsViewportModel,
            toolbarMode: bridge.vectorToolbarMode,
            viewportVisible,
          }}
        />
      </Viewport3DHost>
    );
  }

  const renderUnified2DViewport = ({
    preferFemMesh = Boolean(bridge.scaledFemMeshData),
    femQuantityId = ctx.selectedQuantity,
  }: {
    preferFemMesh?: boolean;
    femQuantityId?: string | null;
  } = {}): React.ReactNode => (
      <UnifiedViewport2DPresenter
        slice2DModel={bridge.slice2DModel}
        workspaceSelection={bridge.workspaceSelection}
        shouldUseSliceApi2D={bridge.shouldUseSliceApi2D}
        hasSliceScalar={bridge.hasSliceScalar}
        sliceLoading={bridge.slice2D.loading}
        sliceStateKind={bridge.slice2D.stateKind}
        sliceErrorMessage={bridge.slice2D.error?.message ?? bridge.slice2D.unsupportedReason ?? null}
        sliceMeta={bridge.slice2D.meta}
        sliceArrows={bridge.slice2D.arrows}
        runtimeResourceRevisions={bridge.runtimeResourceRevisions}
        grid={ctx.previewGrid}
        vectors={bridge.scaledVectors}
        sliceScalarValues={bridge.scaledSliceScalar}
        sliceScalarShape={bridge.sliceScalarShape}
        quantityLabel={bridge.resolvedSliceQuantityLabel}
        quantityId={bridge.sliceQuantityId}
        quantityUnit={ctx.quantityDescriptor?.unit ?? null}
        quantityComponentCount={ctx.quantityDescriptor?.n_comp ?? null}
        component={bridge.sliceComponent}
        plane={ctx.plane}
        sliceIndex={ctx.sliceIndex}
        preferFemMesh={preferFemMesh}
        femMeshData={bridge.scaledFemMeshData}
        femQuantityLabel={bridge.resolvedFemSliceQuantityLabel}
        femQuantityId={femQuantityId ?? undefined}
        femQuantityUnit={ctx.quantityDescriptor?.unit ?? undefined}
        femQuantityOptions={bridge.femQuantityOptions}
        femComponent={ctx.effectiveVectorComponent}
        meshParts={ctx.meshParts}
        meshEntityViewState={bridge.effectiveFemMeshEntityViewState}
        meshRenderMode={viz.meshRenderMode}
        showPrimitives={bridge.femLayerState.showPrimitives}
        showMesh={bridge.femLayerState.showMesh}
        showQuantity={bridge.femLayerState.showQuantity}
        airSegmentVisible={viz.airMeshVisible}
        objectViewMode={ctx.objectViewMode}
        visibleObjectIds={bridge.visibleObjectIds}
        vectorDomainFilter={vectorViz.domainFilter}
        clipAxis={viz.meshClipAxis}
        clipPos={viz.meshClipPos}
        antennaOverlays={ctx.antennaOverlays}
        selectedAntennaId={bridge.selectedAntennaName}
        showArrows={bridge.femShowArrowsForRender}
        vectorColorMode={vectorViz.colorMode}
        vectorMonoColor={vectorViz.monoColor}
        previewMaxPoints={ctx.requestedPreviewMaxPoints}
        onQuantityChange={ctx.requestDisplayQuantity}
        onComponentChange={bridge.handleFemSliceComponentChange}
        onPlaneChange={ctx.setPlane}
        onClipAxisChange={handleClipAxisChange}
        onClipPosChange={handleClipPosChange}
        onShowArrowsChange={handleShowArrowsChange}
        onPreviewMaxPointsChange={bridge.handlePreviewMaxPointsChange}
      />
  );

  const femRenderPassesForViewport = bridge.viewport3DRenderState.renderPasses;
  const femAirboxPassesForViewport = bridge.viewport3DRenderState.airboxPasses;

  const renderHostedFemMeshViewport = () => {
    if (!ctx.femMeshData) {
      if (
        bridge.showFemBoundsPreview &&
        FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableBoundsPreview
      ) {
        return renderHostedFemBoundsViewport("Mesh");
      }
      return (
        <div className="flex h-full w-full items-center justify-center opacity-80">
          <EmptyState
            title="Mesh topology unavailable"
            description="Build FEM mesh to render Mesh workspace."
            tone="info"
          />
        </div>
      );
    }
    return (
      <Viewport3DHost model={bridge.hostedFemViewportModel} mode="Mesh" discretization="fem">
        <ViewportErrorBoundary label="Hosted FEM Mesh Viewport">
          <FemMeshView3D
            topologyKey={requireFemTopologyKey(bridge.resolvedFemTopologyKey)}
            meshData={bridge.renderFemMeshData!}
            viewportVisible={viewportVisible}
            onViewportHealthChange={onViewportHealthChange}
            selectedSidebarNodeId={selection.selectedSidebarNodeId}
            viewportFitSeed={bridge.viewportFitSeed}
            cameraFitRequestSeed={cameraFitRequestSeed}
            quantityId={ctx.requestedPreviewQuantity}
            quantityOptions={bridge.femQuantityOptions}
            colorField={bridge.femColorFieldForRender}
            airColorField={bridge.femAirColorFieldForRender}
            magneticColorField={bridge.femMagneticColorFieldForRender}
            showOrientationLegend={ctx.femMagnetization3DActive}
            toolbarMode={bridge.femToolbarMode}
            viewportDocumentId={bridge.graphActiveViewportDocumentId}
            persistedCameraState={bridge.graphActiveViewportCameraState}
            onPersistCameraState={bridge.persistViewportCameraState}
            onCameraInteractionChange={bridge.setViewportCameraInteractionActive}
            renderMode={
              FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe
                ? "wireframe"
                : viz.meshRenderMode
            }
            renderPasses={
              FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe
                ? undefined
                : femRenderPassesForViewport
            }
            airboxPasses={
              FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe
                ? undefined
                : femAirboxPassesForViewport
            }
            opacity={bridge.femOpacityForRender}
            trim={viz.meshTrim}
            clipEnabled={
              FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceDisableClip
                ? false
                : viz.meshClipEnabled
            }
            clipAxis={viz.meshClipAxis}
            clipPos={viz.meshClipPos}
            clipFlip={viz.meshClipFlip}
            previewMaxPoints={ctx.requestedPreviewMaxPoints}
            femVectorGlyphBudget={vectorViz.glyphBudget}
            onRenderModeChange={handleMeshRenderModeChange}
            onOpacityChange={handleMeshOpacityChange}
            onClipEnabledChange={handleClipEnabledChange}
            onClipAxisChange={handleClipAxisChange}
            onClipPosChange={handleClipPosChange}
            onClipFlipChange={handleClipFlipChange}
            onPreviewMaxPointsChange={bridge.handlePreviewMaxPointsChange}
            onSelectionChange={ctx.setMeshSelection}
            onRefine={ctx.handleLassoRefine}
            showArrowsRequested={bridge.femShowArrowsForRender}
            arrowColorMode={vectorViz.colorMode}
            arrowMonoColor={vectorViz.monoColor}
            arrowAlpha={vectorViz.alpha}
            arrowLengthScale={vectorViz.lengthScale}
            arrowThickness={vectorViz.thickness}
            vectorDomainFilter={vectorViz.domainFilter}
            ferromagnetVisibilityMode={vectorViz.ferromagnetVisibilityMode}
            antennaOverlays={ctx.antennaOverlays}
            selectedAntennaId={bridge.selectedAntennaName}
            objectOverlays={
              geometryViewportPresetActive
                ? bridge.geometryModeObjectOverlays
                : bridge.femObjectOverlaysForRender
            }
            selectedObjectId={bridge.selectedFemObjectId}
            selectedEntityId={selection.selectedEntityId}
            focusedEntityId={selection.focusedEntityId}
            objectViewMode={ctx.objectViewMode}
            objectSegments={ctx.effectiveFemMesh?.object_segments ?? []}
            meshParts={ctx.meshParts}
            elementMarkers={ctx.effectiveFemMesh?.element_markers ?? null}
            perDomainQuality={ctx.effectiveFemMesh?.per_domain_quality ?? null}
            meshEntityViewState={bridge.effectiveFemMeshEntityViewState}
            onMeshPartViewStatePatch={bridge.patchMeshPartViewState}
            visibleObjectIds={bridge.visibleObjectIds}
            airSegmentVisible={viz.airMeshVisible}
            airSegmentOpacity={viz.airMeshOpacity}
            viewportAxesScope={viz.viewportAxesScope}
            universeWireframeVisible={viz.universeWireframeVisible}
            focusObjectRequest={selection.focusObjectRequest}
            onAntennaTranslate={ctx.applyAntennaTranslation}
            onGeometryTranslate={ctx.applyGeometryTranslation}
            onRequestObjectSelect={bridge.handleRequestObjectSelect}
            worldExtent={ctx.worldExtent}
            worldCenter={ctx.worldCenter}
            onEntitySelect={selectionActions.setSelectedEntityId}
            onEntityFocus={selectionActions.setFocusedEntityId}
            onQuantityChange={ctx.requestDisplayQuantity}
            activeTextureTransform={bridge.activeTextureTransform}
            textureGizmoMode={bridge.activeTextureGizmoMode}
            activeTexturePreviewProxy={bridge.activeTexturePreviewProxy}
            activeTransformScope={ctx.activeTransformScope}
            onTextureTransformChange={bridge.applyTextureTransform}
            onTextureTransformCommit={bridge.applyTextureTransform}
            partExplorerOpen={bridge.selectedSubmeshesToolboxOpen}
            onTogglePartExplorer={bridge.openSelectedSubmeshesToolbox}
            legendOpen={viz.viewportLegendVisible}
            onLegendOpenChange={handleLegendOpenChange}
            onVisibleSubmeshSnapshotChange={ctx.setVisibleSubmeshSnapshot}
          />
        </ViewportErrorBoundary>
      </Viewport3DHost>
    );
  };

  const renderHostedFem3DViewport = () => {
    if (!ctx.femMeshData) {
      if (
        bridge.showFemBoundsPreview &&
        FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableBoundsPreview
      ) {
        return renderHostedFemBoundsViewport("3D");
      }
      return (
        <div className="flex h-full w-full items-center justify-center opacity-80">
          <EmptyState
            title="FEM 3D preview unavailable"
            description="Build FEM mesh topology to enable 3D field rendering."
            tone="info"
          />
        </div>
      );
    }
    return (
      <Viewport3DHost model={bridge.hostedFemViewportModel} mode="3D" discretization="fem">
        <ViewportErrorBoundary label="Hosted Unified 3D Viewport">
          <div className="relative flex flex-col flex-1 h-full min-h-0 min-w-0 w-full">
            <FemMeshView3D
              topologyKey={requireFemTopologyKey(bridge.resolvedFemTopologyKey)}
              meshData={bridge.renderFemMeshData!}
              viewportVisible={viewportVisible}
              onViewportHealthChange={onViewportHealthChange}
              selectedSidebarNodeId={selection.selectedSidebarNodeId}
              viewportFitSeed={bridge.viewportFitSeed}
              cameraFitRequestSeed={cameraFitRequestSeed}
              fieldLabel={ctx.quantityDescriptor?.label ?? ctx.selectedQuantity}
              liveRenderDebugData={bridge.femLiveRenderDebugData}
              quantityId={ctx.requestedPreviewQuantity}
              quantityOptions={bridge.femQuantityOptions}
              toolbarMode={bridge.femToolbarMode}
              colorField={bridge.femColorFieldForRender}
              showOrientationLegend={ctx.femMagnetization3DActive}
              viewportDocumentId={bridge.graphActiveViewportDocumentId}
              persistedCameraState={bridge.graphActiveViewportCameraState}
              onPersistCameraState={bridge.persistViewportCameraState}
              onCameraInteractionChange={bridge.setViewportCameraInteractionActive}
              renderMode={
                FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe
                  ? "wireframe"
                  : viz.meshRenderMode
              }
              renderPasses={
                FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe
                  ? undefined
                  : femRenderPassesForViewport
              }
              airboxPasses={
                FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe
                  ? undefined
                  : femAirboxPassesForViewport
              }
              opacity={bridge.femOpacityForRender}
              trim={viz.meshTrim}
              clipEnabled={
                FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceDisableClip
                  ? false
                  : viz.meshClipEnabled
              }
              clipAxis={viz.meshClipAxis}
              clipPos={viz.meshClipPos}
              clipFlip={viz.meshClipFlip}
              showArrowsRequested={bridge.femShowArrowsForRender}
              arrowColorMode={vectorViz.colorMode}
              arrowMonoColor={vectorViz.monoColor}
              arrowAlpha={vectorViz.alpha}
              arrowLengthScale={vectorViz.lengthScale}
              arrowThickness={vectorViz.thickness}
              vectorDomainFilter={vectorViz.domainFilter}
              ferromagnetVisibilityMode={vectorViz.ferromagnetVisibilityMode}
              previewMaxPoints={ctx.requestedPreviewMaxPoints}
              femVectorGlyphBudget={vectorViz.glyphBudget}
              onRenderModeChange={handleMeshRenderModeChange}
              onOpacityChange={handleMeshOpacityChange}
              onClipEnabledChange={handleClipEnabledChange}
              onClipAxisChange={handleClipAxisChange}
              onClipPosChange={handleClipPosChange}
              onClipFlipChange={handleClipFlipChange}
              onShowArrowsChange={handleShowArrowsChange}
              onArrowColorModeChange={handleArrowColorModeChange}
              onArrowMonoColorChange={handleArrowMonoColorChange}
              onArrowAlphaChange={handleArrowAlphaChange}
              onArrowLengthScaleChange={handleArrowLengthScaleChange}
              onArrowThicknessChange={handleArrowThicknessChange}
              onVectorDomainFilterChange={handleVectorDomainFilterChange}
              onFerromagnetVisibilityModeChange={handleFerromagnetVisibilityModeChange}
              onPreviewMaxPointsChange={bridge.handlePreviewMaxPointsChange}
              onSelectionChange={ctx.setMeshSelection}
              antennaOverlays={ctx.antennaOverlays}
              selectedAntennaId={bridge.selectedAntennaName}
              objectOverlays={
                geometryViewportPresetActive
                  ? bridge.geometryModeObjectOverlays
                  : bridge.femObjectOverlaysForRender
              }
              selectedObjectId={bridge.selectedFemObjectId}
              selectedEntityId={selection.selectedEntityId}
              focusedEntityId={selection.focusedEntityId}
              objectViewMode={ctx.objectViewMode}
              objectSegments={ctx.effectiveFemMesh?.object_segments ?? []}
              meshParts={ctx.meshParts}
              elementMarkers={ctx.effectiveFemMesh?.element_markers ?? null}
              perDomainQuality={ctx.effectiveFemMesh?.per_domain_quality ?? null}
              meshEntityViewState={bridge.effectiveFemMeshEntityViewState}
              onMeshPartViewStatePatch={bridge.patchMeshPartViewState}
              visibleObjectIds={bridge.visibleObjectIds}
              airSegmentVisible={viz.airMeshVisible}
              airSegmentOpacity={viz.airMeshOpacity}
              viewportAxesScope={viz.viewportAxesScope}
              universeWireframeVisible={viz.universeWireframeVisible}
              focusObjectRequest={selection.focusObjectRequest}
              onAntennaTranslate={ctx.applyAntennaTranslation}
              onGeometryTranslate={ctx.applyGeometryTranslation}
              onRequestObjectSelect={bridge.handleRequestObjectSelect}
              worldExtent={ctx.worldExtent}
              worldCenter={ctx.worldCenter}
              onQuantityChange={ctx.requestDisplayQuantity}
              activeTextureTransform={bridge.activeTextureTransform}
              textureGizmoMode={bridge.activeTextureGizmoMode}
              activeTexturePreviewProxy={bridge.activeTexturePreviewProxy}
              activeTransformScope={ctx.activeTransformScope}
              onTextureTransformChange={bridge.applyTextureTransform}
              onTextureTransformCommit={bridge.applyTextureTransform}
              partExplorerOpen={bridge.selectedSubmeshesToolboxOpen}
              onTogglePartExplorer={bridge.openSelectedSubmeshesToolbox}
              onVisibleSubmeshSnapshotChange={ctx.setVisibleSubmeshSnapshot}
            />
          </div>
        </ViewportErrorBoundary>
      </Viewport3DHost>
    );
  };

  const renderHostedVectorSurfaceViewport = () => (
    <Viewport3DHost
      model={bridge.hostedVectorSurfaceViewportModel}
      mode={bridge.isVectorSurfaceMeshActive ? "Mesh" : "3D"}
      discretization="fdm"
    >
      <div className="relative h-full w-full">
        <UnifiedViewport3DVectorSurface
          boundaryLabel="Hosted Unified 3D Viewport"
          vectorFieldProps={{
            ...bridge.vectorSurfaceSharedProps,
            viewportDocumentId: bridge.graphActiveViewportDocumentId,
            persistedCameraState: bridge.graphActiveViewportCameraState,
            onPersistCameraState: bridge.persistViewportCameraState,
            onCameraInteractionChange: bridge.setViewportCameraInteractionActive,
            viewport3DModel: bridge.hostedVectorSurfaceViewportModel,
            vectors: bridge.vectorSurfaceVectors,
            toolbarMode: bridge.vectorToolbarMode,
            viewportVisible,
            viewportAxesScope: viz.viewportAxesScope,
            universeWireframeVisible: viz.universeWireframeVisible,
          }}
        />
      </div>
    </Viewport3DHost>
  );

  /* ── Conditional content (non-graph path) ── */
  let conditionalContent: React.ReactNode = null;

  if (bridge.minimalViewportSelectionPath) {
    if (ctx.femMeshData) {
      conditionalContent = (
        <ViewportErrorBoundary label="Minimal FEM Wireframe Viewport">
          <FemMeshView3D
            topologyKey={requireFemTopologyKey(bridge.resolvedFemTopologyKey)}
            meshData={bridge.scaledFemMeshData ?? ctx.femMeshData}
            viewportVisible={viewportVisible}
            onViewportHealthChange={onViewportHealthChange}
            selectedSidebarNodeId={selection.selectedSidebarNodeId}
            viewportFitSeed={bridge.viewportFitSeed}
            cameraFitRequestSeed={cameraFitRequestSeed}
            colorField="none"
            toolbarMode={bridge.femToolbarMode}
            viewportDocumentId={bridge.graphActiveViewportDocumentId}
            persistedCameraState={bridge.graphActiveViewportCameraState}
            onPersistCameraState={bridge.persistViewportCameraState}
            onCameraInteractionChange={bridge.setViewportCameraInteractionActive}
            renderMode={
              FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe
                ? "wireframe"
                : viz.meshRenderMode
            }
            opacity={1}
            trim={viz.meshTrim}
            clipEnabled={
              FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceDisableClip
                ? false
                : viz.meshClipEnabled
            }
            clipAxis={viz.meshClipAxis}
            clipPos={viz.meshClipPos}
            clipFlip={viz.meshClipFlip}
            showArrowsRequested={false}
            showOrientationLegend={false}
            worldExtent={ctx.worldExtent}
            worldCenter={ctx.worldCenter}
            viewportAxesScope={viz.viewportAxesScope}
            universeWireframeVisible={viz.universeWireframeVisible}
            partExplorerOpen={bridge.selectedSubmeshesToolboxOpen}
            onTogglePartExplorer={bridge.openSelectedSubmeshesToolbox}
            legendOpen={viz.viewportLegendVisible}
            onLegendOpenChange={handleLegendOpenChange}
            onVisibleSubmeshSnapshotChange={ctx.setVisibleSubmeshSnapshot}
          />
        </ViewportErrorBoundary>
      );
    } else if (
      FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableBoundsPreview &&
      bridge.femObjectOverlaysForRender.length > 0
    ) {
      conditionalContent = renderHostedFemBoundsViewport("Mesh");
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
    bridge.globalScalarPreview &&
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
              {ctx.quantityDescriptor?.label ?? bridge.scaledGlobalScalarPreview!.quantity}
            </h3>
          </div>
          <div className="font-mono text-lg font-medium tracking-tight text-foreground">
            {fmtExp(bridge.scaledGlobalScalarPreview!.value)}
          </div>
          <div className="flex flex-wrap gap-3 text-[0.72rem] text-muted-foreground">
            <span>{bridge.scaledGlobalScalarPreview!.unit}</span>
            <span>step {bridge.scaledGlobalScalarPreview!.source_step.toLocaleString()}</span>
            <span>{fmtSI(bridge.scaledGlobalScalarPreview!.source_time, "s")}</span>
          </div>
        </div>
      </div>
    );
  } else if (!ctx.isVectorQuantity && !bridge.hasVectorData && !ctx.femMeshData) {
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
    bridge.scaledSpatialPreview &&
    bridge.scaledSpatialPreview.spatial_kind === "grid" &&
    bridge.scaledSpatialPreview.type === "2D" &&
    bridge.scaledSpatialPreview.scalar_field.length > 0 &&
    FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableGridScalar2D
  ) {
    conditionalContent = (
      <PreviewScalarField2D
        data={bridge.scaledSpatialPreview.scalar_field}
        grid={bridge.scaledSpatialPreview.preview_grid}
        quantityLabel={ctx.quantityDescriptor?.label ?? bridge.scaledSpatialPreview.quantity}
        quantityUnit={bridge.scaledSpatialPreview.unit}
        component={bridge.scaledSpatialPreview.component}
        quantityComponentCount={bridge.scaledSpatialPreview.n_comp}
        min={bridge.scaledSpatialPreview.min}
        max={bridge.scaledSpatialPreview.max}
        axisExtent={
          ctx.worldExtent
            ? {
                x: ctx.worldCenter
                  ? [
                      ctx.worldCenter[0] - ctx.worldExtent[0] * 0.5,
                      ctx.worldCenter[0] + ctx.worldExtent[0] * 0.5,
                    ]
                  : [0, ctx.worldExtent[0]],
                y: ctx.worldCenter
                  ? [
                      ctx.worldCenter[1] - ctx.worldExtent[1] * 0.5,
                      ctx.worldCenter[1] + ctx.worldExtent[1] * 0.5,
                    ]
                  : [0, ctx.worldExtent[1]],
                unit: "m",
              }
            : null
        }
      />
    );
  }

  /* ── Graph-hosted content ── */
  const graphHostedContent =
    !bridge.minimalViewportSelectionPath &&
    !bridge.globalScalarPreview &&
    !(
      bridge.spatialPreview &&
      bridge.spatialPreview.spatial_kind === "grid" &&
      bridge.spatialPreview.type === "2D" &&
      bridge.spatialPreview.scalar_field.length > 0 &&
      FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableGridScalar2D
    )
      ? (
          <ViewportHost
            context={{
              viewportMode: ctx.effectiveViewMode,
              hasSessionData: Boolean(
                ctx.selectedVectors?.length ||
                  ctx.preview ||
                  ctx.femMeshData ||
                  bridge.showVectorSurface3D ||
                  bridge.showGeometryAuthoringViewport ||
                  bridge.showFemBoundsPreview ||
                  (ctx.effectiveViewMode === "3D" && Boolean(bridge.femDiscretization)),
              ),
              hasFemMesh: Boolean(ctx.femMeshData),
              selectedResultNodeId: bridge.graphViewportResultNodeId,
              discretization: bridge.femDiscretization ? "fem" : "fdm",
            }}
            selection={{
              selectedObjectId: bridge.viewportSelectedObjectId,
              selectedEntityId: selection.selectedEntityId,
              focusedEntityId: selection.focusedEntityId,
              selectedSidebarNodeId: selection.selectedSidebarNodeId,
              objectViewMode: ctx.objectViewMode,
            }}
            selectionActions={{
              onObjectSelect: (objectId) => {
                if (objectId) {
                  bridge.handleRequestObjectSelect(objectId);
                  return;
                }
                selectionActions.setSelectedObjectId(null);
              },
              onEntitySelect: selectionActions.setSelectedEntityId,
              onEntityFocus: selectionActions.setFocusedEntityId,
              onSidebarNodeSelect: (nodeId) => selectionActions.setSelectedSidebarNodeId(nodeId),
              onObjectViewModeChange: ctx.setObjectViewMode,
            }}
            overlays={{
              telemetryHudVisible:
                FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showTelemetryHud,
              overlays: [
                {
                  id: "telemetry",
                  kind: "telemetry-hud",
                  visible: FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showTelemetryHud,
                },
              ],
            }}
            diagnosticFlags={{
              useMinimalViewportSelectionPath:
                FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.useMinimalViewportSelectionPath,
              enableGlobalScalarCard:
                FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableGlobalScalarCard,
              enableGridScalar2D:
                FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableGridScalar2D,
              enableUnifiedViewport3D:
                FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableUnifiedViewport3D,
              enableUnifiedViewportToolbar:
                FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableUnifiedViewportToolbar,
              enableSlice2D:
                FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFemSlice2D ||
                FRONTEND_DIAGNOSTIC_FLAGS.viewportRouting.enableFdmSlice2D,
              femViewportShowToolbar: FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showToolbar,
              femViewportForceWireframe:
                FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe,
              femViewportForceDisableClip:
                FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceDisableClip,
              viewport3dStages: bridge.viewport3dStages,
            }}
            renderComponent={(componentKey) => {
              switch (componentKey) {
                case "UnifiedViewport3D": {
                  const viewport3DModeFlags = resolveViewport3DModeFlags({
                    isFemDiscretization: Boolean(bridge.femDiscretization),
                    viewMode: ctx.effectiveViewMode,
                  });
                  const viewport3D = (
                    <UnifiedViewport3DRenderer
                      showGeometryAuthoringViewport={false}
                      isFemMeshMode={viewport3DModeFlags.isFemMeshMode}
                      isFem3DMode={viewport3DModeFlags.isFem3DMode}
                      renderGeometryAuthoring={renderHostedFem3DViewport}
                      renderFemMesh={renderHostedFemMeshViewport}
                      renderFem3D={renderHostedFem3DViewport}
                      renderFdm={renderHostedVectorSurfaceViewport}
                    />
                  );
                  return viewport3D;
                }
                case "UnifiedViewport2D":
                  return renderUnified2DViewport({
                    preferFemMesh: Boolean(bridge.scaledFemMeshData),
                    femQuantityId: ctx.selectedQuantity,
                  });
                case "AnalyzeViewport":
                  return <AnalyzeViewport />;
                case "ResultChartViewport":
                  return <ResultNodeViewport mode="chart" />;
                case "ResultTableViewport":
                  return <ResultNodeViewport mode="table" />;
                case "ResultReportViewport":
                  return <ResultNodeViewport mode="report" />;
                default:
                  return null;
              }
            }}
            fallback={
              <div className="flex flex-col items-center justify-center h-full w-full opacity-60">
                <EmptyState
                  title={ctx.emptyStateMessage.title}
                  description={ctx.emptyStateMessage.description}
                  tone="info"
                />
              </div>
            }
          />
        )
      : null;

  /* ── Render ── */
  return (
    <div className="flex flex-col flex-1 h-full min-h-0 min-w-0 relative overflow-hidden [&>*]:min-w-0 [&>*]:min-h-0 [&>*:not(.viewportOverlay)]:flex-1 [&>*:not(.viewportOverlay)]:w-full">
      {FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showAntennaPreviewBadge &&
      bridge.antennaPreviewBadgeVisible ? (
        <div
          className="viewportOverlay absolute right-4 top-4 rounded-full border border-primary/30 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-primary shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md"
          style={VIEWPORT_BADGE_STYLE}
        >
          physics 2.5D · preview extruded
        </div>
      ) : null}

      {FRONTEND_DIAGNOSTIC_FLAGS.viewportChrome.showFemSelectionBadges &&
      bridge.femDiscretization ? (
        <div
          className="viewportOverlay absolute right-4 top-14 flex items-center gap-2"
          style={VIEWPORT_BADGE_STYLE}
        >
          {bridge.missingExactScopeSegment && viewportSelectedObjectId ? (
            <button
              type="button"
              className="pointer-events-auto rounded-full border border-warning/30 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-warning shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md transition-colors hover:bg-warning/20"
              onClick={() => {
                ctx.handleViewModeChange("3D");
                ctx.requestFocusObject(viewportSelectedObjectId);
              }}
            >
              Focus {viewportSelectedObjectId}
            </button>
          ) : null}

          {bridge.selectedObjectOverlay ? (
            <div className="pointer-events-auto rounded-full border border-border/40 bg-background/85 px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-md">
              {bridge.selectedObjectOverlay.source === "mesh_parts"
                ? "Mesh Part"
                : "Object Segment"}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── Graph-hosted path or fallback content ── */}
      {graphHostedContent ?? conditionalContent}
    </div>
  );
}
