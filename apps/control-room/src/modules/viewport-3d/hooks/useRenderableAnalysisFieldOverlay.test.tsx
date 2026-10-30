import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import {
  AnalysisFieldOverlayController,
  useRenderableAnalysisFieldOverlay,
} from "@/kernel/visualization/AnalysisFieldOverlayController";

import { createModeFieldOverlayIntent } from "@/kernel/visualization/ModeFieldOverlayIntent";
import { createAnalysisResultFieldOverlayIntent } from "@/kernel/visualization/AnalysisResultFieldOverlayIntent";
import { analysisResultSelectionRef } from "@/shared/domain/analysis/results";

function RenderableOverlayProbe({ controller }: { controller: AnalysisFieldOverlayController }) {
  const overlay = useRenderableAnalysisFieldOverlay(controller);
  return <output>{overlay?.fieldId ?? "none"}</output>;
}

function completeOverlay(runId: string) {
  return {
    fieldId: `field-${runId}`,
    modeIntent: createModeFieldOverlayIntent({
      analysisRunId: runId, analysisStageId: "stage-1", artifactRevision: "7",
      equilibriumId: "eq-1", fieldId: `field-${runId}`, kind: "results.eigen.mode",
      modeId: "mode-2", modeIndex: 2, nodeId: `mode-${runId}`, sampleId: "sample-0", sampleIndex: 0,
      type: "frequency-domain",
    })!,
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
  it("blocks bare eigen state before viewport consumption while preserving both typed and response contracts", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const controller = new AnalysisFieldOverlayController();
    const complete = completeOverlay("run-1");
    try {
      await act(async () => root.render(<RenderableOverlayProbe controller={controller} />));
      await act(async () => {
        controller.setResultContext("run-1");
        controller.set({ ...complete, modeIntent: undefined });
      });
      expect(controller.getContextSnapshot().status).toBe("unverified");
      expect(controller.getRenderableSnapshot()).toBeNull();
      expect(container.textContent).toBe("none");

      await act(async () => controller.set(complete));
      expect(controller.getContextSnapshot().status).toBe("compatible");
      expect(container.textContent).toBe("field-run-1");

      const fieldRef = {
        field_id: complete.fieldId, field_revision: "sha256:field-v1",
        mesh_ref: { mesh_id: "mesh-1", mesh_revision: "4", topology_fingerprint: "sha256:mesh-1" },
        quantity_id: "m", representation: "complex-vector-xyz", status: "ready",
        resource_key: `/v2/sessions/current/data/fields/${complete.fieldId}/samples/vector?view=complex`,
      } as const;
      const resultIntent = createAnalysisResultFieldOverlayIntent(analysisResultSelectionRef({
        datasetId: "dataset-1", datasetRevision: "sha256:dataset-v1", focus: "item",
        fieldId: complete.fieldId, fieldRef, fieldRevision: fieldRef.field_revision,
        itemId: "mode-2", itemKind: "eigen_mode", runId: "run-1", sampleId: "sample-0", stageId: "stage-1",
      }))!;
      expect(resultIntent).not.toBeNull();
      await act(async () => controller.set({
        ...complete, modeIntent: undefined, analysisResultFieldIntent: resultIntent,
        provenance: { ...complete.provenance, datasetId: resultIntent.datasetId,
          datasetRevision: resultIntent.datasetRevision, fieldRevision: resultIntent.fieldRevision },
      }));
      expect(controller.getContextSnapshot().status).toBe("compatible");
      expect(controller.getRenderableSnapshot()?.analysisResultFieldIntent).toBe(resultIntent);
      expect(container.textContent).toBe("field-run-1");

      await act(async () => controller.set({
        ...complete, modeIntent: undefined, source: "frequency-response", frequencyIndex: 2,
        provenance: { ...complete.provenance, studyProduct: "driven_response" },
      }));
      expect(controller.getContextSnapshot().status).toBe("compatible");
      expect(controller.getRenderableSnapshot()?.source).toBe("frequency-response");
      expect(container.textContent).toBe("field-run-1");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

});
