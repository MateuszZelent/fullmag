"use client";

import { memo, useEffect, useRef } from "react";

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
  const visibleBridgeRef = useRef(bridge);
  useEffect(() => {
    if (viewportVisible) {
      visibleBridgeRef.current = bridge;
    }
  }, [bridge, viewportVisible]);
  const renderedBridge = viewportVisible ? bridge : visibleBridgeRef.current;
  return (
    <ViewportTabContent
      bridge={renderedBridge}
      viewportVisible={viewportVisible}
      onViewportHealthChange={onViewportHealthChange}
    />
  );
});
