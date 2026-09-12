"use client";

import { useLayoutEffect } from "react";

import type { AnalysisFieldOverlayController } from "@/kernel/visualization/AnalysisFieldOverlayController";

export function useAnalysisFieldOverlayResultContext(
  controller: AnalysisFieldOverlayController,
  resultRunId: string | null,
): void {
  useLayoutEffect(() => {
    controller.setResultContext(resultRunId);
  }, [controller, resultRunId]);
}
