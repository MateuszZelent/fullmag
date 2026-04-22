"use client";

import { memo, useCallback, useMemo } from "react";

import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { getLiveApiClient } from "@/src/api/client/LiveApiClient";
import { useLiveStatus } from "@/src/hooks/resources/useLiveStatus";
import type { DisplayPatchRequest } from "@/src/api/types";
import { synthesizeCapabilitiesFromDiscretization } from "@/src/domain/capabilities";
import { UnifiedViewportBar } from "@/features/viewport-unified";
import { useUnifiedDisplayControls } from "@/features/viewport-unified/hooks/useUnifiedDisplayControls";
import {
  DEFAULT_FEM_VIEWPORT_LAYER_STATE,
  type UnifiedRenderState,
} from "@/features/viewport-unified/model/unifiedViewportTypes";

import type { RenderMode } from "../../preview/FemMeshView3D";
import type { VectorComponent } from "./shared";
import { useCommand, useModel, useViewport } from "./context-hooks";

function toUnifiedVectorComponent(
  component: string,
): UnifiedRenderState["vectorComponent"] {
  if (component === "x" || component === "y" || component === "z" || component === "3D") {
    return component;
  }
  return "|v|";
}

function fromUnifiedVectorComponent(
  component: UnifiedRenderState["vectorComponent"],
): "3D" | VectorComponent {
  if (component === "3D") {
    return "3D";
  }
  if (component === "x" || component === "y" || component === "z") {
    return component;
  }
  return "magnitude";
}

function toUnifiedMeshRenderMode(
  mode: RenderMode,
): NonNullable<UnifiedRenderState["meshRenderMode"]> {
  return mode === "surface" || mode === "surface+edges" ? "solid" : mode;
}

function fromUnifiedMeshRenderMode(
  mode: UnifiedRenderState["meshRenderMode"],
): RenderMode {
  if (mode === "wireframe" || mode === "points") {
    return mode;
  }
  return "surface";
}

export const ViewportBar = memo(function ViewportBar() {
  const command = useCommand();
  const viewport = useViewport();
  const model = useModel();
  const { status } = useLiveStatus({
    enabled: FRONTEND_DIAGNOSTIC_FLAGS.shell.showViewportBar,
  });

  const patchDisplay = useCallback(async (patch: DisplayPatchRequest): Promise<void> => {
    await getLiveApiClient().display.patch(patch);
  }, []);

  const displayControls = useUnifiedDisplayControls(patchDisplay);

  const capabilities =
    status?.capabilities ??
    command.domainCapabilities ??
    synthesizeCapabilitiesFromDiscretization(command.isFemBackend);

  const renderState = useMemo<UnifiedRenderState>(() => ({
    selectedLayer: status?.display.slice_layer ?? viewport.requestedPreviewLayer ?? viewport.sliceIndex,
    allLayersVisible:
      (status?.display.slice_mode ?? (viewport.requestedPreviewAllLayers ? "all" : "single")) === "all",
    vectorComponent: toUnifiedVectorComponent(
      status
        ? (status.display.view_mode === "3d" ? "3D" : status.display.field_component)
        : (viewport.previewControlsActive ? viewport.requestedPreviewComponent : viewport.component),
    ),
    colorScale: status?.display.colormap ?? "viridis",
    autoScale: status?.display.auto_contrast ?? viewport.requestedPreviewAutoScale,
    maxPoints: status?.display.max_points ?? viewport.requestedPreviewMaxPoints,
    everyN: status?.display.vector_density ?? viewport.requestedPreviewEveryN,
    meshRenderMode: toUnifiedMeshRenderMode(model.meshRenderMode),
    meshOpacity: model.meshOpacity,
    clipEnabled: model.meshClipEnabled,
    clipAxis: model.meshClipAxis,
    clipPosition: model.meshClipPos,
    femLayers: model.femViewportLayers,
  }), [
    model.meshClipAxis,
    model.meshClipEnabled,
    model.meshClipPos,
    model.meshOpacity,
    model.meshRenderMode,
    model.femViewportLayers,
    status,
    viewport.component,
    viewport.previewControlsActive,
    viewport.requestedPreviewAllLayers,
    viewport.requestedPreviewAutoScale,
    viewport.requestedPreviewComponent,
    viewport.requestedPreviewEveryN,
    viewport.requestedPreviewLayer,
    viewport.requestedPreviewMaxPoints,
    viewport.sliceIndex,
  ]);

  const onRenderStateChange = useCallback((next: UnifiedRenderState) => {
    if (next.vectorComponent !== renderState.vectorComponent) {
      const nextComponent = fromUnifiedVectorComponent(next.vectorComponent);
      viewport.setComponent(nextComponent === "3D" ? "magnitude" : nextComponent);
      void displayControls.setComponent(nextComponent);
    }

    if (next.selectedLayer !== renderState.selectedLayer) {
      viewport.setSliceIndex(next.selectedLayer);
      void displayControls.setLayer(next.selectedLayer);
    }

    if (next.allLayersVisible !== renderState.allLayersVisible) {
      void displayControls.setAllLayers(next.allLayersVisible);
    }

    if (next.everyN !== renderState.everyN) {
      void displayControls.setEveryN(next.everyN);
    }

    if (next.colorScale !== renderState.colorScale) {
      void displayControls.setColormap(next.colorScale);
    }

    if (next.autoScale !== renderState.autoScale) {
      void displayControls.setAutoScale(next.autoScale);
    }

    if (next.meshRenderMode !== renderState.meshRenderMode) {
      model.setMeshRenderMode(fromUnifiedMeshRenderMode(next.meshRenderMode));
    }

    if (next.meshOpacity !== renderState.meshOpacity && typeof next.meshOpacity === "number") {
      model.setMeshOpacity(next.meshOpacity);
    }

    if (next.clipEnabled !== renderState.clipEnabled) {
      model.setMeshClipEnabled(Boolean(next.clipEnabled));
    }

    if (next.clipAxis !== renderState.clipAxis && next.clipAxis) {
      model.setMeshClipAxis(next.clipAxis);
    }

    if (next.clipPosition !== renderState.clipPosition && typeof next.clipPosition === "number") {
      model.setMeshClipPos(next.clipPosition);
    }

    const currentLayers = renderState.femLayers ?? DEFAULT_FEM_VIEWPORT_LAYER_STATE;
    const nextLayers = next.femLayers ?? DEFAULT_FEM_VIEWPORT_LAYER_STATE;
    if (
      nextLayers.showPrimitives !== currentLayers.showPrimitives ||
      nextLayers.showMesh !== currentLayers.showMesh ||
      nextLayers.showQuantity !== currentLayers.showQuantity
    ) {
      model.setFemViewportLayers(nextLayers);
    }
  }, [displayControls, model, renderState, viewport]);

  if (!FRONTEND_DIAGNOSTIC_FLAGS.shell.showViewportBar) {
    return null;
  }

  return (
    <UnifiedViewportBar
      capabilities={capabilities}
      renderState={renderState}
      onRenderStateChange={onRenderStateChange}
      gridDepth={viewport.solverGrid[2] > 0 ? viewport.solverGrid[2] : undefined}
      disabled={viewport.previewBusy}
    />
  );
});
