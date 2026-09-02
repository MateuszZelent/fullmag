"use client";

import type { ModuleProps } from "@/kernel/types";
import { AnalysisPlotsView } from "./AnalysisPlotsView";
import { useAnalysisResultProjectionController } from "./useAnalysisResultProjectionController";
import { useAnalysisPlotsController } from "./useAnalysisPlotsController";

export { AnalysisPlotsView } from "./AnalysisPlotsView";

export default function AnalysisPlotsModule({ kernel }: ModuleProps) {
  const controller = useAnalysisPlotsController(kernel);
  const resultProjection = useAnalysisResultProjectionController(kernel);
  return <AnalysisPlotsView kernel={kernel} {...controller} onDatasetRefChange={controller.setSelectedDatasetRef} onSurfaceChange={controller.setActiveSurface} resultProjection={resultProjection} />;
}
