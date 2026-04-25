"use client";

import { memo, type ComponentProps } from "react";
import UnifiedVectorFieldRenderer from "@/features/viewport-unified/renderers/UnifiedVectorFieldRenderer";
import { ViewportErrorBoundary } from "../../preview/ViewportErrorBoundary";

type VectorFieldProps = ComponentProps<typeof UnifiedVectorFieldRenderer>;

interface UnifiedViewport3DVectorSurfaceProps {
  boundaryLabel: string;
  vectorFieldProps: VectorFieldProps;
}

/**
 * FDM/authoring vector renderer surface for the unified 3D host.
 * FEM and FDM share the host/shell; concrete renderers stay domain-specific.
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
