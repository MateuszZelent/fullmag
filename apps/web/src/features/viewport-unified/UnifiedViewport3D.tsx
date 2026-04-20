"use client";

import { memo, type ReactNode } from "react";

export interface UnifiedViewport3DProps {
  children?: ReactNode;
  fallback?: ReactNode;
}

/**
 * Canonical `src/` entrypoint for the unified 3-D viewport host.
 *
 * The concrete rendering is still injected by the control-room viewport router,
 * but this component gives the codebase one stable import target for the
 * unified 3-D surface.
 */
const UnifiedViewport3D = memo(function UnifiedViewport3D({
  children,
  fallback = null,
}: UnifiedViewport3DProps) {
  return <>{children ?? fallback}</>;
});

export default UnifiedViewport3D;
