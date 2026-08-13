"use client";

import { useLayoutActions, useLayoutSelector } from "@/kernel/layout/useLayout";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";

import {
  resolveVisualizationViewContext,
  type VisualizationViewContext,
} from "./VisualizationViewContext";

export function VisualizationContextSwitch() {
  return <VisualizationContextSwitchControl />;
}

export function VisualizationContextSwitchControl({
  onPlanarActivate,
}: {
  onPlanarActivate?: () => void;
} = {}) {
  const context = useVisualizationViewContext();
  const { setActiveViewportMainModule } = useLayoutActions();

  return (
    <SegmentedControl<VisualizationViewContext>
      aria-label="Visualization context"
      className="w-full"
      columns={2}
      options={[
        { label: "3D", value: "three-d" },
        { label: "2D", value: "planar" },
      ]}
      value={context}
      onValueChange={(next) => {
        if (next === "planar") onPlanarActivate?.();
        setActiveViewportMainModule(next === "planar" ? "field-map" : "viewport-3d");
      }}
    />
  );
}

export function useVisualizationViewContext(): VisualizationViewContext {
  const layout = useLayoutSelector(
    (state) => ({
      activeModuleId: state.activeViewportMainModuleId,
      lastSpatialModuleId:
        state.lastSpatialViewportMainModuleId ?? "viewport-3d",
    }),
    {
      isEqual: (previous, next) =>
        previous.activeModuleId === next.activeModuleId &&
        previous.lastSpatialModuleId === next.lastSpatialModuleId,
    },
  );
  return resolveVisualizationViewContext(
    layout.activeModuleId,
    resolveVisualizationViewContext(layout.lastSpatialModuleId),
  );
}
