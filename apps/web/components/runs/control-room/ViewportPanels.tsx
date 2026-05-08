"use client";

import { memo, useEffect, useRef } from "react";

import { useViewportDataBridge } from "@/features/viewport-unified/hooks/useViewportDataBridge";
import { ViewportTabContent } from "@/features/viewport-unified/renderers/ViewportTabContent";
import type { Viewport3DHealthReport } from "@/components/preview/FemMeshView3D";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";

export { ViewportBar } from "./ViewportBar";

export const ViewportCanvasArea = memo(function ViewportCanvasArea({
  viewportVisible = true,
  onViewportHealthChange,
}: {
  viewportVisible?: boolean;
  onViewportHealthChange?: (report: Viewport3DHealthReport) => void;
}) {
  if (
    !viewportVisible &&
    !FRONTEND_DIAGNOSTIC_FLAGS.leakIsolation.enableHiddenViewportBridge
  ) {
    return <div className="h-full min-h-0 min-w-0 flex-1 bg-background" />;
  }
  return (
    <ViewportCanvasAreaBridge
      viewportVisible={viewportVisible}
      onViewportHealthChange={onViewportHealthChange}
    />
  );
});

const ViewportCanvasAreaBridge = memo(function ViewportCanvasAreaBridge({
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
