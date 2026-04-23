"use client";

import { memo, type ReactNode } from "react";
import UnifiedViewport3D from "@/src/features/viewport-unified/UnifiedViewport3D";
import type { Viewport3DModel } from "../model/viewport3dContracts";

export interface Viewport3DHostProps {
  model?: Viewport3DModel | null;
  mode?: "3D" | "Mesh";
  discretization?: "fem" | "fdm" | "mixed";
  className?: string;
  children?: ReactNode;
  fallback?: ReactNode;
}

/**
 * Canonical host for routing all 3D panels through one viewport surface.
 *
 * This wrapper keeps rollout simple: call-sites can provide a canonical
 * `Viewport3DModel` while still reusing existing renderer children during
 * staged migration.
 */
export const Viewport3DHost = memo(function Viewport3DHost({
  model,
  mode,
  discretization,
  className,
  children,
  fallback = null,
}: Viewport3DHostProps) {
  const resolvedMode =
    mode ?? (model?.scene.fallbackMode === "bounds-preview" ? "Mesh" : "3D");
  const resolvedDiscretization = discretization ?? model?.scene.discretization ?? "mixed";
  return (
    <UnifiedViewport3D
      model={model}
      className={className}
      mode={resolvedMode}
      discretization={resolvedDiscretization}
      fallback={fallback}
    >
      {children ?? fallback}
    </UnifiedViewport3D>
  );
});
