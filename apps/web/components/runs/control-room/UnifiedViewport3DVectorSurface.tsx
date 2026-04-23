"use client";

import { memo, type ComponentProps } from "react";
import VectorFieldView3D from "../../preview/VectorFieldView3D";
import { ViewportErrorBoundary } from "../../preview/ViewportErrorBoundary";

type VectorFieldProps = ComponentProps<typeof VectorFieldView3D>;

interface UnifiedViewport3DVectorSurfaceProps {
  boundaryLabel: string;
  vectorFieldProps: VectorFieldProps;
}

/**
 * Transitional FDM/authoring renderer surface for the unified 3D host.
 *
 * This keeps legacy vector rendering wiring in one place while the router
 * and shell stay fully on the canonical Viewport3DHost path.
 */
const UnifiedViewport3DVectorSurface = memo(function UnifiedViewport3DVectorSurface({
  boundaryLabel,
  vectorFieldProps,
}: UnifiedViewport3DVectorSurfaceProps) {
  return (
    <ViewportErrorBoundary label={boundaryLabel}>
      <VectorFieldView3D {...vectorFieldProps} />
    </ViewportErrorBoundary>
  );
});

export default UnifiedViewport3DVectorSurface;
