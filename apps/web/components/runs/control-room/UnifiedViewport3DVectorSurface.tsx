"use client";

import { memo, type ComponentProps } from "react";
import UnifiedVectorFieldRenderer from "../../preview/UnifiedVectorFieldRenderer";
import { ViewportErrorBoundary } from "../../preview/ViewportErrorBoundary";

type VectorFieldProps = ComponentProps<typeof UnifiedVectorFieldRenderer>;

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
      <UnifiedVectorFieldRenderer {...vectorFieldProps} />
    </ViewportErrorBoundary>
  );
});

export default UnifiedViewport3DVectorSurface;
