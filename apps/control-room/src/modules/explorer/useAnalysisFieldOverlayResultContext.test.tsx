import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import {
  installSimulationPreparationTestDom,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { AnalysisFieldOverlayController } from "@/kernel/visualization/AnalysisFieldOverlayController";

import { useAnalysisFieldOverlayResultContext } from "./useAnalysisFieldOverlayResultContext";

function ResultContextBridge({
  controller,
  runId,
}: {
  controller: AnalysisFieldOverlayController;
  runId: string | null;
}) {
  useAnalysisFieldOverlayResultContext(controller, runId);
  return null;
}

describe("useAnalysisFieldOverlayResultContext", () => {
  it("makes an owned overlay non-renderable when the selected Results run changes", async () => {
    const controller = new AnalysisFieldOverlayController();
    controller.set({
      fieldId: "field-owned",
      frequencyHz: 12.5e9,
      label: "Mode 2",
      modeIndex: 2,
      provenance: {
        artifactRevision: 7,
        equilibriumId: "eq-1",
        kContextKind: "finite_open",
        representation: "complex-vector-xyz",
        resourceRef: "data/fields/field-owned",
        runId: "run-1",
        stageId: "stage-1",
        studyProduct: "modal_eigen",
      },
      query: { phase_rad: 0, view: "phase_rotated_real" },
      sampleIndex: 0,
      source: "eigen-mode",
    });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => {
        root.render(<ResultContextBridge controller={controller} runId="run-1" />);
      });
      expect(controller.getRenderableSnapshot()?.fieldId).toBe("field-owned");

      await act(async () => {
        root.render(<ResultContextBridge controller={controller} runId="run-2" />);
      });
      expect(controller.getContextSnapshot().status).toBe("foreign");
      expect(controller.getRenderableSnapshot()).toBeNull();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
