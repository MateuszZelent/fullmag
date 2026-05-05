import { useCallback, useEffect, useMemo, useState } from "react";
import type { Viewport3DHealthReport } from "@/components/preview/FemMeshView3D";
import type { PreviewState } from "@/lib/session/types";
import type { ModelContextValue, ViewportContextValue } from "./context-hooks";

type Viewport3DStatusValue = {
  status: "active" | "inactive" | "warning";
  reason: string;
  detail: string;
};

interface ComputeViewport3DStatusArgs {
  femDiscretization: boolean;
  model: Pick<
    ModelContextValue,
    | "airMeshVisible"
    | "femMeshData"
    | "femTopologyKey"
    | "femViewportLayers"
    | "meshShowArrows"
    | "objectViewMode"
    | "selectedEntityId"
    | "selectedObjectId"
  >;
  spatialPreview: Extract<PreviewState, { kind: "spatial" }> | null;
  viewport: Pick<ViewportContextValue, "effectiveViewMode" | "previewBusy" | "previewGrid">;
  viewportRuntimeHealth: Viewport3DHealthReport | null;
}

export function computeViewport3DStatus({
  femDiscretization,
  model,
  spatialPreview,
  viewport,
  viewportRuntimeHealth,
}: ComputeViewport3DStatusArgs): Viewport3DStatusValue {
  if (viewport.effectiveViewMode !== "3D" && viewport.effectiveViewMode !== "Mesh") {
    return {
      status: "inactive",
      reason: `Current viewport mode is ${viewport.effectiveViewMode}; switch to 3D Viewport or Mesh.`,
      detail: "The 3D renderer is mounted only for the 3D and Mesh viewports.",
    };
  }
  if (viewport.previewBusy) {
    return {
      status: "warning",
      reason: "3D preview data is still loading or recomputing.",
      detail: "Visualization can be temporarily empty while field or mesh preview resources are pending.",
    };
  }
  if (femDiscretization) {
    if (!model.femMeshData || model.femMeshData.nNodes <= 0) {
      return {
        status: "inactive",
        reason: "FEM mesh data is not available.",
        detail: "Build or load a FEM mesh before the 3D visualization can render.",
      };
    }
    if (!model.femTopologyKey && !model.femMeshData.meshGenerationId) {
      return {
        status: "inactive",
        reason: "FEM topology key is missing.",
        detail: "The 3D viewport needs a stable topology key to mount the FEM renderer.",
      };
    }
    const any3DLayerVisible =
      model.femViewportLayers.showPrimitives ||
      model.femViewportLayers.showMesh ||
      model.femViewportLayers.showQuantity ||
      model.femViewportLayers.showMagneticTexture ||
      model.meshShowArrows ||
      model.airMeshVisible;
    if (!any3DLayerVisible) {
      return {
        status: "inactive",
        reason: "All 3D layers are disabled.",
        detail: "Enable Primitive, Mesh View, Quantity, Texture, Vectors, or Airbox in the View ribbon.",
      };
    }
    if (model.objectViewMode === "isolate" && !model.selectedObjectId && !model.selectedEntityId) {
      return {
        status: "warning",
        reason: "Object isolate mode is active without a selected object.",
        detail: "Switch Display > Context or select an object to restore a visible 3D scope.",
      };
    }
    if (viewportRuntimeHealth && viewportRuntimeHealth.status !== "active") {
      return viewportRuntimeHealth;
    }
    return {
      status: "active",
      reason: viewportRuntimeHealth?.reason ?? "3D visualization is active.",
      detail:
        viewportRuntimeHealth?.detail ??
        `FEM mesh: ${model.femMeshData.nNodes.toLocaleString()} nodes, ${model.femMeshData.nElements.toLocaleString()} elements.`,
    };
  }
  if (!viewport.previewGrid && !spatialPreview) {
    return {
      status: "inactive",
      reason: "No 3D preview/grid data is available.",
      detail: "Run or compute a preview quantity before using the 3D visualization.",
    };
  }
  return {
    status: "active",
    reason: "3D visualization is active.",
    detail: "Structured-grid preview data is available for the 3D renderer.",
  };
}

export function useViewport3DStatus({
  femDiscretization,
  model,
  spatialPreview,
  viewport,
}: {
  femDiscretization: boolean;
  model: Pick<
    ModelContextValue,
    | "airMeshVisible"
    | "femMeshData"
    | "femTopologyKey"
    | "femViewportLayers"
    | "meshShowArrows"
    | "objectViewMode"
    | "selectedEntityId"
    | "selectedObjectId"
  >;
  spatialPreview: Extract<PreviewState, { kind: "spatial" }> | null;
  viewport: Pick<ViewportContextValue, "effectiveViewMode" | "previewBusy" | "previewGrid">;
}) {
  const [viewportRuntimeHealth, setViewportRuntimeHealth] =
    useState<Viewport3DHealthReport | null>(null);
  const viewport3DStatus = useMemo(() => computeViewport3DStatus({
    femDiscretization,
    model,
    spatialPreview,
    viewport,
    viewportRuntimeHealth,
  }), [
    femDiscretization,
    model.airMeshVisible,
    model.femMeshData,
    model.femTopologyKey,
    model.femViewportLayers.showMagneticTexture,
    model.femViewportLayers.showMesh,
    model.femViewportLayers.showPrimitives,
    model.femViewportLayers.showQuantity,
    model.meshShowArrows,
    model.objectViewMode,
    model.selectedEntityId,
    model.selectedObjectId,
    spatialPreview,
    viewport.effectiveViewMode,
    viewport.previewBusy,
    viewport.previewGrid,
    viewportRuntimeHealth,
  ]);

  const handleViewportHealthChange = useCallback((report: Viewport3DHealthReport) => {
    setViewportRuntimeHealth((previous) => {
      if (
        previous?.status === report.status &&
        previous.reason === report.reason &&
        previous.detail === report.detail
      ) {
        return previous;
      }
      return report;
    });
  }, []);

  useEffect(() => {
    const handleHealthEvent = (event: Event) => {
      const detail = (event as CustomEvent<Viewport3DHealthReport>).detail;
      if (
        !detail ||
        (detail.status !== "active" &&
          detail.status !== "inactive" &&
          detail.status !== "warning")
      ) {
        return;
      }
      handleViewportHealthChange(detail);
    };
    window.addEventListener("fullmag:viewport3d-health", handleHealthEvent);
    return () => window.removeEventListener("fullmag:viewport3d-health", handleHealthEvent);
  }, [handleViewportHealthChange]);

  return {
    handleViewportHealthChange,
    viewport3DStatus,
  };
}
