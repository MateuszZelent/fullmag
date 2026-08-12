"use client";

import { useEffect } from "react";

import type { AnalysisFieldOverlayController } from "@/kernel/visualization/AnalysisFieldOverlayController";

export function useAnalysisFieldOverlayResultContext(
  controller: AnalysisFieldOverlayController,
  resultRunId: string | null,
): void {
  useEffect(() => {
    controller.setResultContext(resultRunId);
  }, [controller, resultRunId]);
}
