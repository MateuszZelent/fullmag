"use client";

import { memo, useEffect, useRef } from "react";

import { useViewportDataBridge } from "@/features/viewport-unified/hooks/useViewportDataBridge";
import { ViewportTabContent } from "@/features/viewport-unified/renderers/ViewportTabContent";
import type { ViewportBridgeMode } from "@/features/viewport-unified/model/viewportBridgeActivity";
import type { Viewport3DHealthReport } from "@/components/preview/FemMeshView3D";

export { ViewportBar } from "./ViewportBar";

export const ViewportCanvasArea = memo(function ViewportCanvasArea({
  viewportVisible = true,
  viewportMode = "3D",
  onViewportHealthChange,
}: {
  viewportVisible?: boolean;
  viewportMode?: ViewportBridgeMode;
  onViewportHealthChange?: (report: Viewport3DHealthReport) => void;
}) {
  if (!viewportVisible) {
    return <div className="h-full min-h-0 min-w-0 flex-1 bg-background" />;
  }
  return (
    <ViewportCanvasAreaBridge
      viewportVisible={viewportVisible}
      viewportMode={viewportMode}
      onViewportHealthChange={onViewportHealthChange}
    />
  );
});

const ViewportCanvasAreaBridge = memo(function ViewportCanvasAreaBridge({
  viewportVisible = true,
  viewportMode = "3D",
  onViewportHealthChange,
}: {
  viewportVisible?: boolean;
  viewportMode?: ViewportBridgeMode;
  onViewportHealthChange?: (report: Viewport3DHealthReport) => void;
}) {
  const bridge = useViewportDataBridge({ active: viewportVisible, viewportMode });
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
