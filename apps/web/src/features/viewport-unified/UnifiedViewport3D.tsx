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
  const showArrowLayer = layerVisibility ? layerVisibility.showQuantity : true;
  const content = children ?? fallback;

  return (
    <div
      className={cn("relative h-full w-full", className)}
      data-viewport3d="unified"
      data-viewport-mode={mode}
      data-discretization={discretization}
      data-fallback-mode={fallbackMode}
      data-scene-loading={model?.status.loading ? "true" : "false"}
      data-layer-primitives={layerVisibility?.showPrimitives ? "on" : "off"}
      data-layer-mesh={layerVisibility?.showMesh ? "on" : "off"}
      data-layer-quantity={layerVisibility?.showQuantity ? "on" : "off"}
    >
      {showBoundsLayer ? (
        <BoundsLayer visible>{content}</BoundsLayer>
      ) : (
        <MeshLayer visible={showMeshLayer}>
          <WireframeLayer visible={showWireframeLayer}>
            <ArrowLayer visible={showArrowLayer}>{content}</ArrowLayer>
          </WireframeLayer>
        </MeshLayer>
      )}
    </div>
  );
});

export default UnifiedViewport3D;
