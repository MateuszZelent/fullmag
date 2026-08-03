"use client";

import type { ModuleProps } from "@/kernel/types";
import { AnalysisPlotsView } from "./AnalysisPlotsView";
import { useAnalysisPlotsController } from "./useAnalysisPlotsController";

export { AnalysisPlotsView } from "./AnalysisPlotsView";

export default function AnalysisPlotsModule({ kernel }: ModuleProps) {
  const controller = useAnalysisPlotsController(kernel);
  return <AnalysisPlotsView kernel={kernel} {...controller} onComparisonDatasetRefChange={controller.setComparisonDatasetRef} onDatasetRefChange={controller.setSelectedDatasetRef} onSurfaceChange={controller.setActiveSurface} />;
}
