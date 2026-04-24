"use client";

import { ViewportCanvasArea } from "@/components/runs/control-room/ViewportPanels";

export function ViewportTabPanel() {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <ViewportCanvasArea />
    </div>
  );
}
