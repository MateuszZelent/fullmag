"use client";

import { memo } from "react";

import { useViewportDataBridge } from "@/features/viewport-unified/hooks/useViewportDataBridge";
import { ViewportTabContent } from "@/features/viewport-unified/renderers/ViewportTabContent";
import type { Viewport3DHealthReport } from "@/components/preview/FemMeshView3D";

export { ViewportBar } from "./ViewportBar";

export const ViewportCanvasArea = memo(function ViewportCanvasArea({
  viewportVisible = true,
  onViewportHealthChange,
}: {
  viewportVisible?: boolean;
  onViewportHealthChange?: (report: Viewport3DHealthReport) => void;
}) {
  const bridge = useViewportDataBridge();
  return (
    <ViewportTabContent
      bridge={bridge}
      viewportVisible={viewportVisible}
      onViewportHealthChange={onViewportHealthChange}
    />
  );
});
