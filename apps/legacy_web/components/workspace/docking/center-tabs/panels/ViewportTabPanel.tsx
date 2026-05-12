"use client";

import { ViewportCanvasArea } from "@/components/runs/control-room/ViewportPanels";
import type { ViewportBridgeMode } from "@/features/viewport-unified/model/viewportBridgeActivity";

export function ViewportTabPanel({
  viewportVisible = true,
  viewportMode = "3D",
}: {
  viewportVisible?: boolean;
  viewportMode?: ViewportBridgeMode;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <ViewportCanvasArea viewportVisible={viewportVisible} viewportMode={viewportMode} />
    </div>
  );
}
