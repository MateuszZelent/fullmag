"use client";

import React from "react";
import dynamic from "next/dynamic";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { DEFAULT_WORKSPACE_SYNC_STATE } from "@/src/features/workspaceSync";
import { ViewportHost } from "@/features";
import { UnifiedViewport3DRenderer, Viewport3DHost } from "@/features/viewport-unified";
import FemMeshView3D from "@/components/preview/FemMeshView3D";
import { ViewportErrorBoundary } from "@/components/preview/ViewportErrorBoundary";
import EmptyState from "@/components/ui/EmptyState";
import { defaultMeshEntityViewState } from "@/lib/session/types";
import { fmtExp, fmtSI } from "@/components/runs/control-room/shared";
import UnifiedViewport2DPresenter from "@/components/runs/control-room/UnifiedViewport2DPresenter";
import UnifiedViewport3DVectorSurface from "@/components/runs/control-room/UnifiedViewport3DVectorSurface";
import AnalyzeViewport from "@/components/runs/control-room/AnalyzeViewport";
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
}

/* ── Component ── */

export function ViewportTabContent({ bridge }: ViewportTabContentProps) {
  const ctx = bridge.ctx;
  const workspaceSyncState = DEFAULT_WORKSPACE_SYNC_STATE;
  const viewportSelectedObjectId = bridge.viewportSelectedObjectId;
  const geometryViewportPresetActive = bridge.geometryViewportPresetActive;
  const geometryPresetFemMeshEntityViewState = React.useMemo(() => {
    if (!geometryViewportPresetActive) {
      return bridge.effectiveFemMeshEntityViewState;
    }
    if (ctx.meshParts.length === 0) {
      return Object.fromEntries(
        Object.entries(bridge.effectiveFemMeshEntityViewState).map(([id, state]) => [
          id,
          {
            ...state,
            visible: state.visible,
            colorField: "none" as const,
            renderMode: "surface" as const,
            opacity: 100,
          },
        ]),
      );
    }
    return Object.fromEntries(
      ctx.meshParts.map((part) => {
        const base = bridge.effectiveFemMeshEntityViewState[part.id] ?? defaultMeshEntityViewState(part);
        return [
          part.id,
          {
            ...base,
            visible: part.role === "magnetic_object",
            colorField: "none" as const,
            renderMode: "surface" as const,
            opacity: part.role === "magnetic_object" ? 100 : base.opacity,
          },
        ];
      }),
    );
  }, [bridge.effectiveFemMeshEntityViewState, ctx.meshParts, geometryViewportPresetActive]);

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
            focusObjectRequest: ctx.focusObjectRequest,
            objectViewMode: ctx.objectViewMode,
            viewportDocumentId: bridge.graphActiveViewportDocumentId,
            persistedCameraState: bridge.graphActiveViewportCameraState,
            onPersistCameraState: bridge.persistViewportCameraState,
            viewportAxesScope: ctx.viewportAxesScope,
            universeWireframeVisible: ctx.universeWireframeVisible,
            onRequestObjectSelect: bridge.handleRequestObjectSelect,
            viewport3DModel: bridge.hostedFemBoundsViewportModel,
            toolbarMode: bridge.vectorToolbarMode,
            viewportVisible: true,
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
      sliceErrorMessage={bridge.slice2D.error?.message ?? null}
      grid={ctx.previewGrid}
      vectors={bridge.scaledVectors}
      sliceScalarValues={bridge.scaledSliceScalar}
      sliceScalarShape={bridge.sliceScalarShape}
      quantityLabel={bridge.resolvedSliceQuantityLabel}
      quantityId={bridge.sliceQuantityId}
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
      meshRenderMode={ctx.meshRenderMode}
      showPrimitives={bridge.femLayerState.showPrimitives}
      showMesh={bridge.femLayerState.showMesh}
      showQuantity={bridge.femLayerState.showQuantity}
      airSegmentVisible={ctx.airMeshVisible}
      objectViewMode={ctx.objectViewMode}
      visibleObjectIds={bridge.visibleObjectIds}
      vectorDomainFilter={ctx.femVectorDomainFilter}
      clipAxis={ctx.meshClipAxis}
      clipPos={ctx.meshClipPos}
      antennaOverlays={ctx.antennaOverlays}
      selectedAntennaId={bridge.selectedAntennaName}
      showArrows={bridge.femShowArrowsForRender}
      previewMaxPoints={ctx.requestedPreviewMaxPoints}
      onQuantityChange={ctx.requestDisplayQuantity}
      onComponentChange={bridge.handleFemSliceComponentChange}
      onPlaneChange={ctx.setPlane}
      onClipAxisChange={ctx.setMeshClipAxis}
      onClipPosChange={ctx.setMeshClipPos}
      onShowArrowsChange={ctx.setMeshShowArrows}
      onPreviewMaxPointsChange={bridge.handlePreviewMaxPointsChange}
    />
  );

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
            selectedSidebarNodeId={ctx.selectedSidebarNodeId}
            viewportFitSeed={bridge.viewportFitSeed}
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
            renderMode={
              FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe
                ? "wireframe"
                : ctx.meshRenderMode
            }
            opacity={bridge.femOpacityForRender}
            clipEnabled={
              FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceDisableClip
                ? false
                : ctx.meshClipEnabled
            }
            clipAxis={ctx.meshClipAxis}
            clipPos={ctx.meshClipPos}
            clipFlip={ctx.meshClipFlip}
            previewMaxPoints={ctx.requestedPreviewMaxPoints}
            femVectorGlyphBudget={ctx.femVectorGlyphBudget}
            onRenderModeChange={ctx.setMeshRenderMode}
            onOpacityChange={ctx.setMeshOpacity}
            onClipEnabledChange={ctx.setMeshClipEnabled}
            onClipAxisChange={ctx.setMeshClipAxis}
            onClipPosChange={ctx.setMeshClipPos}
            onClipFlipChange={ctx.setMeshClipFlip}
            onPreviewMaxPointsChange={bridge.handlePreviewMaxPointsChange}
            onSelectionChange={ctx.setMeshSelection}
            onRefine={ctx.handleLassoRefine}
            showArrowsRequested={bridge.femShowArrowsForRender}
            arrowColorMode={ctx.femArrowColorMode}
            arrowMonoColor={ctx.femArrowMonoColor}
            arrowAlpha={ctx.femArrowAlpha}
            arrowLengthScale={ctx.femArrowLengthScale}
            arrowThickness={ctx.femArrowThickness}
            vectorDomainFilter={ctx.femVectorDomainFilter}
            ferromagnetVisibilityMode={ctx.femFerromagnetVisibilityMode}
            antennaOverlays={ctx.antennaOverlays}
            selectedAntennaId={bridge.selectedAntennaName}
            objectOverlays={
              geometryViewportPresetActive
                ? bridge.geometryModeObjectOverlays
                : bridge.femObjectOverlaysForRender
            }
            selectedObjectId={bridge.selectedFemObjectId}
            selectedEntityId={ctx.selectedEntityId}
            focusedEntityId={ctx.focusedEntityId}
            objectViewMode={ctx.objectViewMode}
            objectSegments={ctx.effectiveFemMesh?.object_segments ?? []}
            meshParts={ctx.meshParts}
            elementMarkers={ctx.effectiveFemMesh?.element_markers ?? null}
            perDomainQuality={ctx.effectiveFemMesh?.per_domain_quality ?? null}
            meshEntityViewState={geometryPresetFemMeshEntityViewState}
            onMeshPartViewStatePatch={bridge.patchMeshPartViewState}
            visibleObjectIds={bridge.visibleObjectIds}
            airSegmentVisible={ctx.airMeshVisible}
            airSegmentOpacity={ctx.airMeshOpacity}
            viewportAxesScope={ctx.viewportAxesScope}
            universeWireframeVisible={ctx.universeWireframeVisible}
            focusObjectRequest={ctx.focusObjectRequest}
            onAntennaTranslate={ctx.applyAntennaTranslation}
            onGeometryTranslate={ctx.applyGeometryTranslation}
            onRequestObjectSelect={bridge.handleRequestObjectSelect}
            worldExtent={ctx.worldExtent}
            worldCenter={ctx.worldCenter}
            onEntitySelect={ctx.setSelectedEntityId}
            onEntityFocus={ctx.setFocusedEntityId}
            onQuantityChange={ctx.requestDisplayQuantity}
            activeTextureTransform={bridge.activeTextureTransform}
            textureGizmoMode={bridge.activeTextureGizmoMode}
            activeTexturePreviewProxy={bridge.activeTexturePreviewProxy}
            activeTransformScope={ctx.activeTransformScope}
            onTextureTransformChange={bridge.applyTextureTransform}
            onTextureTransformCommit={bridge.applyTextureTransform}
            partExplorerOpen={bridge.selectedSubmeshesToolboxOpen}
            onTogglePartExplorer={bridge.openSelectedSubmeshesToolbox}
            legendOpen={ctx.viewportLegendVisible}
            onLegendOpenChange={ctx.setViewportLegendVisible}
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
          <div className="relative h-full w-full">
            <FemMeshView3D
              topologyKey={requireFemTopologyKey(bridge.resolvedFemTopologyKey)}
              meshData={bridge.renderFemMeshData!}
              selectedSidebarNodeId={ctx.selectedSidebarNodeId}
              viewportFitSeed={bridge.viewportFitSeed}
              fieldLabel={
                geometryViewportPresetActive
                  ? "Geometry"
                  : (ctx.quantityDescriptor?.label ?? ctx.selectedQuantity)
              }
              liveRenderDebugData={bridge.femLiveRenderDebugData}
              quantityId={geometryViewportPresetActive ? undefined : ctx.requestedPreviewQuantity}
              quantityOptions={bridge.femQuantityOptions}
              toolbarMode={bridge.femToolbarMode}
              colorField={geometryViewportPresetActive ? "none" : bridge.femColorFieldForRender}
              showOrientationLegend={!geometryViewportPresetActive && ctx.femMagnetization3DActive}
              viewportDocumentId={bridge.graphActiveViewportDocumentId}
              persistedCameraState={bridge.graphActiveViewportCameraState}
              onPersistCameraState={bridge.persistViewportCameraState}
              renderMode={
                geometryViewportPresetActive
                  ? "surface"
                  : FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe
                  ? "wireframe"
                  : ctx.meshRenderMode
              }
              opacity={bridge.femOpacityForRender}
              clipEnabled={
                FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceDisableClip
                  ? false
                  : ctx.meshClipEnabled
              }
              clipAxis={ctx.meshClipAxis}
              clipPos={ctx.meshClipPos}
              clipFlip={ctx.meshClipFlip}
              showArrowsRequested={geometryViewportPresetActive ? false : bridge.femShowArrowsForRender}
              arrowColorMode={ctx.femArrowColorMode}
              arrowMonoColor={ctx.femArrowMonoColor}
              arrowAlpha={ctx.femArrowAlpha}
              arrowLengthScale={ctx.femArrowLengthScale}
              arrowThickness={ctx.femArrowThickness}
              vectorDomainFilter={geometryViewportPresetActive ? "magnetic_only" : ctx.femVectorDomainFilter}
              ferromagnetVisibilityMode={ctx.femFerromagnetVisibilityMode}
              previewMaxPoints={ctx.requestedPreviewMaxPoints}
              femVectorGlyphBudget={ctx.femVectorGlyphBudget}
              onRenderModeChange={ctx.setMeshRenderMode}
              onOpacityChange={ctx.setMeshOpacity}
              onClipEnabledChange={ctx.setMeshClipEnabled}
              onClipAxisChange={ctx.setMeshClipAxis}
              onClipPosChange={ctx.setMeshClipPos}
              onClipFlipChange={ctx.setMeshClipFlip}
              onShowArrowsChange={ctx.setMeshShowArrows}
              onArrowColorModeChange={ctx.setFemArrowColorMode}
              onArrowMonoColorChange={ctx.setFemArrowMonoColor}
              onArrowAlphaChange={ctx.setFemArrowAlpha}
              onArrowLengthScaleChange={ctx.setFemArrowLengthScale}
              onArrowThicknessChange={ctx.setFemArrowThickness}
              onVectorDomainFilterChange={ctx.setFemVectorDomainFilter}
              onFerromagnetVisibilityModeChange={ctx.setFemFerromagnetVisibilityMode}
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
              selectedEntityId={ctx.selectedEntityId}
              focusedEntityId={ctx.focusedEntityId}
              objectViewMode={ctx.objectViewMode}
              objectSegments={ctx.effectiveFemMesh?.object_segments ?? []}
              meshParts={ctx.meshParts}
              elementMarkers={ctx.effectiveFemMesh?.element_markers ?? null}
              perDomainQuality={ctx.effectiveFemMesh?.per_domain_quality ?? null}
              meshEntityViewState={geometryPresetFemMeshEntityViewState}
              onMeshPartViewStatePatch={bridge.patchMeshPartViewState}
              visibleObjectIds={bridge.visibleObjectIds}
              airSegmentVisible={ctx.airMeshVisible}
              airSegmentOpacity={ctx.airMeshOpacity}
              viewportAxesScope={ctx.viewportAxesScope}
              universeWireframeVisible={ctx.universeWireframeVisible}
              focusObjectRequest={ctx.focusObjectRequest}
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
            fieldLabel: geometryViewportPresetActive
              ? "Geometry"
              : bridge.vectorSurfaceSharedProps.fieldLabel,
            geometryMode: geometryViewportPresetActive || bridge.vectorSurfaceSharedProps.geometryMode,
            viewportDocumentId: bridge.graphActiveViewportDocumentId,
            persistedCameraState: bridge.graphActiveViewportCameraState,
            onPersistCameraState: bridge.persistViewportCameraState,
            viewport3DModel: bridge.hostedVectorSurfaceViewportModel,
            vectors: geometryViewportPresetActive ? null : bridge.vectorSurfaceVectors,
            toolbarMode: bridge.vectorToolbarMode,
            viewportVisible: true,
            viewportAxesScope: ctx.viewportAxesScope,
            universeWireframeVisible: ctx.universeWireframeVisible,
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
            selectedSidebarNodeId={ctx.selectedSidebarNodeId}
            viewportFitSeed={bridge.viewportFitSeed}
            colorField="none"
            toolbarMode={bridge.femToolbarMode}
            viewportDocumentId={bridge.graphActiveViewportDocumentId}
            persistedCameraState={bridge.graphActiveViewportCameraState}
            onPersistCameraState={bridge.persistViewportCameraState}
            renderMode={
              FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceWireframe
                ? "wireframe"
                : ctx.meshRenderMode
            }
            opacity={1}
            clipEnabled={
              FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceDisableClip
                ? false
                : ctx.meshClipEnabled
            }
            clipAxis={ctx.meshClipAxis}
            clipPos={ctx.meshClipPos}
            clipFlip={ctx.meshClipFlip}
            showArrowsRequested={false}
            showOrientationLegend={false}
            worldExtent={ctx.worldExtent}
            worldCenter={ctx.worldCenter}
            viewportAxesScope={ctx.viewportAxesScope}
            universeWireframeVisible={ctx.universeWireframeVisible}
            partExplorerOpen={bridge.selectedSubmeshesToolboxOpen}
            onTogglePartExplorer={bridge.openSelectedSubmeshesToolbox}
            legendOpen={ctx.viewportLegendVisible}
            onLegendOpenChange={ctx.setViewportLegendVisible}
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
              selectedEntityId: ctx.selectedEntityId,
              focusedEntityId: ctx.focusedEntityId,
              selectedSidebarNodeId: ctx.selectedSidebarNodeId,
              objectViewMode: ctx.objectViewMode,
            }}
            selectionActions={{
              onObjectSelect: (objectId) => {
                if (objectId) {
                  bridge.handleRequestObjectSelect(objectId);
                  return;
                }
                ctx.setSelectedObjectId(null);
              },
              onEntitySelect: ctx.setSelectedEntityId,
              onEntityFocus: ctx.setFocusedEntityId,
              onSidebarNodeSelect: (nodeId) => ctx.setSelectedSidebarNodeId(nodeId),
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
                  const viewport3D = (
                    <UnifiedViewport3DRenderer
                      showGeometryAuthoringViewport={false}
                      isFemMeshMode={false}
                      isFem3DMode={Boolean(
                        bridge.femDiscretization &&
                          (ctx.effectiveViewMode === "3D" || ctx.effectiveViewMode === "Mesh"),
                      )}
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
