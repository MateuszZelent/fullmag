"use client";

import { memo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Viewport3DModel } from "@/features/viewport-unified/model/viewport3dContracts";
import { ArrowLayer } from "./layers/ArrowLayer";
import { BoundsLayer } from "./layers/BoundsLayer";
import { MeshLayer } from "./layers/MeshLayer";
import { WireframeLayer } from "./layers/WireframeLayer";

export interface UnifiedViewport3DProps {
  model?: Viewport3DModel | null;
  children?: ReactNode;
  fallback?: ReactNode;
  className?: string;
  mode?: "3D" | "Mesh";
  discretization?: "fem" | "fdm" | "mixed";
}

/**
 * Canonical `src/` entrypoint for the unified 3-D viewport host.
 *
 * The concrete rendering is still injected by the control-room viewport router,
 * but this component gives the codebase one stable import target for the
 * unified 3-D surface.
 */
const UnifiedViewport3D = memo(function UnifiedViewport3D({
  model = null,
  children,
  fallback = null,
  className,
  mode = "3D",
  discretization = "mixed",
}: UnifiedViewport3DProps) {
  const layerVisibility = model?.scene.layerVisibility;
  const fallbackMode = model?.scene.fallbackMode ?? "none";
  const renderMode = model?.scene.renderMode ?? "shaded";
  const showBoundsLayer = fallbackMode === "bounds-preview";
  const showWireframeLayer =
    renderMode === "wireframe" || renderMode === "shaded+wireframe";
  const showMeshLayer = layerVisibility
    ? layerVisibility.showPrimitives || layerVisibility.showMesh
    : true;
  const quantityLayerVisible = layerVisibility ? layerVisibility.showQuantity : true;
  const vectorField = model?.vectorField ?? null;
  const showArrowLayer = Boolean(
    (mode === "3D" || mode === "Mesh") &&
      quantityLayerVisible &&
      (vectorField?.visible ?? model?.fdm?.vectorsVisible ?? true) &&
      vectorField?.status !== "unsupported" &&
      vectorField?.status !== "mismatch" &&
      vectorField?.status !== "error",
  );
  const content = children ?? fallback;

  return (
    <div
      className={cn("relative h-full w-full", className)}
      data-viewport3d="unified"
      data-viewport-mode={mode}
      data-discretization={discretization}
      data-fallback-mode={fallbackMode}
      data-scene-loading={model?.status.loading ? "true" : "false"}
      data-layer-authoring-primitives={layerVisibility?.showPrimitives ? "on" : "off"}
      data-layer-explicit-topology={layerVisibility?.showMesh ? "on" : "off"}
      data-layer-vector-field={showArrowLayer ? "on" : "off"}
      data-vector-status={vectorField?.status ?? "idle"}
    >
      {showBoundsLayer ? (
        <BoundsLayer visible>{content}</BoundsLayer>
      ) : (
        <MeshLayer visible={showMeshLayer}>
          <WireframeLayer visible={showWireframeLayer}>
            <ArrowLayer
              visible={showArrowLayer}
              vectorField={vectorField}
              statusChipsVisible={model?.overlays.statusChipsVisible ?? true}
            >
              {content}
            </ArrowLayer>
          </WireframeLayer>
        </MeshLayer>
      )}
    </div>
  );
});

export default UnifiedViewport3D;
