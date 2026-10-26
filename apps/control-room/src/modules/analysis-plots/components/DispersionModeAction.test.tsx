import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import {
  findElement,
  installSimulationPreparationTestDom,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { KernelApi } from "@/kernel/types";

import {
  DispersionModeAction,
  dispersionModeSelectionMatches,
  type DispersionModeTarget,
} from "./DispersionModeAction";

const target: DispersionModeTarget = {
  analysisRunId: "run-a",
  analysisStageId: "stage-a",
  artifactPath: "artifact://dispersion",
  artifactRevision: "revision-7",
  equilibriumId: "eq-sample-3",
  fieldId: "field-sample-3-mode-4",
  modeId: "mode-sample-3-4",
  modeIndex: 4,
  resourceRef: "field://mode-4",
  sampleId: "sample-3",
  sampleIndex: 3,
};

const targetModeRef: SelectionRef = {
  analysisRunId: "run-a",
  analysisStageId: "stage-a",
  artifactPath: "artifact://dispersion",
  artifactRevision: "revision-7",
  equilibriumId: "eq-sample-3",
  fieldId: "field-sample-3-mode-4",
  kind: "results.eigen.mode",
  modeId: "mode-sample-3-4",
  modeIndex: 4,
  nodeId: "mode-sample-3-4",
  resourceRef: "field://mode-4",
  sampleId: "sample-3",
  sampleIndex: 3,
  type: "frequency-domain",
};

function makeSelection(ref: SelectionRef): SelectionController {
  const selection = new SelectionController(new EventBus<KernelEventMap>());
  selection.set({ ref }, "analysis-plots");
  return selection;
}

describe("DispersionModeAction", () => {
  it("requires the exact owner, revision, sample equilibrium, mode, and field", () => {
    expect(dispersionModeSelectionMatches(targetModeRef, target)).toBe(true);
    for (const changed of [
      { analysisRunId: "other-run" },
      { analysisStageId: "other-stage" },
      { artifactRevision: "revision-8" },
      { equilibriumId: "eq-other-sample" },
      { sampleId: "sample-4" },
      { sampleIndex: 4 },
      { modeId: "other-mode" },
      { modeIndex: 5 },
      { fieldId: "other-field" },
      { resourceRef: "field://other-mode" },
    ]) {
      expect(dispersionModeSelectionMatches(
        { ...targetModeRef, ...changed } as SelectionRef,
        target,
      )).toBe(false);
    }
    expect(dispersionModeSelectionMatches(
      { ...targetModeRef, equilibriumId: undefined },
      target,
    )).toBe(false);
  });

  it("reselects the displayed chart mode before dispatching the existing 3D command", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const selection = makeSelection({ ...targetModeRef, sampleId: "other-sample" });
    const order: string[] = [];
    const execute = vi.fn(async () => {
      order.push("command");
      expect(selection.get().ref).toEqual(targetModeRef);
      return { status: "completed" as const };
    });
    const kernel = { commands: { execute }, selection } as unknown as KernelApi;
    const onSelectPoint = vi.fn(() => {
      order.push("select-point");
      selection.set({ ref: targetModeRef }, "analysis-plots");
    });

    try {
      await act(async () => root.render(
        <DispersionModeAction
          available
          kernel={kernel}
          onSelectPoint={onSelectPoint}
          target={target}
        />,
      ));
      const button = findElement(container, (element) => element.tagName === "BUTTON", "view selected mode button");
      await act(async () => {
        button.click();
        await Promise.resolve();
      });

      expect(onSelectPoint).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["select-point", "command"]);
      expect(execute).toHaveBeenCalledWith(
        "analysis.eigen.plot-mode-3d",
        expect.objectContaining({
          selection,
          source: "analysis-plots",
          sourceDetail: "dispersion-mode",
        }),
        { source: "eigen-mode", view: "phase_rotated_real" },
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not dispatch if exact chart selection cannot be established", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const selection = makeSelection(targetModeRef);
    const removeGuard = selection.addChangeGuard(() => false);
    const execute = vi.fn(async () => ({ status: "completed" as const }));
    const kernel = { commands: { execute }, selection } as unknown as KernelApi;
    const onSelectPoint = vi.fn(() => selection.set({ ref: { ...targetModeRef, sampleIndex: 9 } }, "analysis-plots"));

    try {
      await act(async () => root.render(
        <DispersionModeAction
          available
          kernel={kernel}
          onSelectPoint={onSelectPoint}
          target={target}
        />,
      ));
      const button = findElement(container, (element) => element.tagName === "BUTTON", "view selected mode button");
      await act(async () => {
        button.click();
        await Promise.resolve();
      });

      expect(selection.get().ref).toEqual(targetModeRef);
      expect(execute).not.toHaveBeenCalled();
      expect(container.textContent).toContain("could not be bound to the current mode");
    } finally {
      removeGuard();
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("disables the action when a field or exact identity is unavailable", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <DispersionModeAction
          available={false}
          kernel={{} as KernelApi}
          onSelectPoint={() => undefined}
          target={{ ...target, equilibriumId: null }}
        />,
      ));
      const button = findElement(container, (element) => element.tagName === "BUTTON", "view selected mode button");
      expect(button.disabled).toBe(true);
      expect(container.textContent).toContain("This point has no published mode field.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
