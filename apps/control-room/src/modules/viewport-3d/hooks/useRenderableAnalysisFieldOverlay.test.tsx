import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import {
  AnalysisFieldOverlayController,
  useRenderableAnalysisFieldOverlay,
} from "@/kernel/visualization/AnalysisFieldOverlayController";

function RenderableOverlayProbe({ controller }: { controller: AnalysisFieldOverlayController }) {
  const overlay = useRenderableAnalysisFieldOverlay(controller);
  return <output>{overlay?.fieldId ?? "none"}</output>;
}

function completeOverlay(runId: string) {
  return {
    fieldId: `field-${runId}`,
    frequencyHz: 12.5e9,
    label: `Mode ${runId}`,
    modeIndex: 2,
    provenance: {
      artifactRevision: 7,
      equilibriumId: "eq-1",
      kContextKind: "gamma" as const,
      representation: "complex-vector-xyz" as const,
      resourceRef: `data/fields/field-${runId}`,
      runId,
      stageId: "stage-1",
      studyProduct: "modal_eigen",
    },
    query: { phase_rad: 0, view: "phase_rotated_real" },
    sampleIndex: 0,
    source: "eigen-mode" as const,
  };
}

describe("viewport renderable analysis overlay hook", () => {
  it("exposes only a compatible overlay and removes foreign or unverified overlays", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const controller = new AnalysisFieldOverlayController();
    try {
      await act(async () => root.render(<RenderableOverlayProbe controller={controller} />));
      await act(async () => {
        controller.setResultContext("run-1");
        controller.set(completeOverlay("run-1"));
      });
      expect(container.textContent).toBe("field-run-1");

      await act(async () => controller.setResultContext("run-2"));
      expect(controller.getContextSnapshot().status).toBe("foreign");
      expect(container.textContent).toBe("none");

      await act(async () => controller.set({
        fieldId: "field-unverified",
        label: "Unverified",
        query: { phase_rad: 0, view: "phase_rotated_real" },
        source: "eigen-mode",
      }));
      expect(controller.getContextSnapshot().status).toBe("unverified");
      expect(container.textContent).toBe("none");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
