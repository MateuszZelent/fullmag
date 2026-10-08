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

import { DispersionModeAction, type DispersionModeTarget } from "./DispersionModeAction";

const target: DispersionModeTarget = {
  runId: "run-a",
  stageId: "stage-a",
  sampleIndex: 3,
  modeIndex: 4,
  sampleId: "sample-a",
  modeId: "mode-a",
};

const targetModeRef: SelectionRef = {
  analysisRunId: "run-a",
  analysisStageId: "stage-a",
  kind: "results.eigen.mode",
  modeId: "mode-a",
  modeIndex: 4,
  nodeId: "mode-a",
  sampleId: "sample-a",
  sampleIndex: 3,
  type: "frequency-domain",
};

const otherModeRef: SelectionRef = {
  analysisRunId: "run-a",
  analysisStageId: "stage-a",
  kind: "results.eigen.mode",
  modeId: "mode-b",
  modeIndex: 5,
  nodeId: "mode-b",
  sampleId: "sample-b",
  sampleIndex: 7,
  type: "frequency-domain",
};

function makeSelection(ref: SelectionRef): SelectionController {
  const selection = new SelectionController(new EventBus<KernelEventMap>());
  selection.set({ ref }, "analysis-plots");
  return selection;
}

describe("DispersionModeAction", () => {
  it("rebinds the clicked chart mode before dispatching the 3D command", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const selection = makeSelection(otherModeRef);
    const order: string[] = [];
    const execute = vi.fn(async () => {
      order.push("command");
      expect(selection.get().ref).toEqual(targetModeRef);
      return { status: "success" as const };
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
          identity="run-a:stage-a:sample-a:mode-a"
          kernel={kernel}
          target={target}
          onSelectPoint={onSelectPoint}
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

  it("fails closed when selection guards block rebinding to the clicked chart mode", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const selection = makeSelection(otherModeRef);
    const removeGuard = selection.addChangeGuard(() => false);
    const execute = vi.fn(async () => ({ status: "success" as const }));
    const kernel = { commands: { execute }, selection } as unknown as KernelApi;
    const onSelectPoint = vi.fn(() => selection.set({ ref: targetModeRef }, "analysis-plots"));

    try {
      await act(async () => root.render(
        <DispersionModeAction
          available
          identity="run-a:stage-a:sample-a:mode-a"
          kernel={kernel}
          target={target}
          onSelectPoint={onSelectPoint}
        />,
      ));
      const button = findElement(container, (element) => element.tagName === "BUTTON", "view selected mode button");
      await act(async () => {
        button.click();
        await Promise.resolve();
      });

      expect(onSelectPoint).toHaveBeenCalledTimes(1);
      expect(selection.get().ref).toEqual(otherModeRef);
      expect(execute).not.toHaveBeenCalled();
      expect(container.textContent).toContain("could not be bound to the current mode");
    } finally {
      removeGuard();
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
