import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
  type TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { AnalysisFieldOverlayController } from "./AnalysisFieldOverlayController";
import { AnalysisFieldOverlayContextNotice } from "./AnalysisFieldOverlayContextNotice";

async function pressNativeButton(button: TestElement, key: " " | "Enter"): Promise<void> {
  button.focus();
  const keyDown = new TestEvent("keydown", { bubbles: true, key });
  await act(async () => {
    const shouldRunDefault = button.dispatchEvent(keyDown);
    if (shouldRunDefault && key === "Enter") button.click();
  });
  const keyUp = new TestEvent("keyup", { bubbles: true, key });
  await act(async () => {
    const shouldRunDefault = button.dispatchEvent(keyUp);
    if (shouldRunDefault && key === " ") button.click();
  });
}

describe("AnalysisFieldOverlayContextNotice", () => {
  it("activates Clear with Enter through the rendered notice", async () => {
    const controller = new AnalysisFieldOverlayController();
    controller.set({
      fieldId: "field-old",
      label: "Old mode",
      query: { phase_rad: 0, view: "phase_rotated_real" },
      source: "eigen-mode",
    });
    controller.setResultContext("run-new");
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <AnalysisFieldOverlayContextNotice
          context={controller.getContextSnapshot()}
          onClear={() => controller.clear()}
          onRebind={() => undefined}
          rebindDisabledReason="Select a complete target."
        />,
      ));
      const clear = findElement(container, (element) => element.textContent === "Clear", "Clear action");

      await pressNativeButton(clear, "Enter");

      expect(controller.getSnapshot()).toBeNull();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("activates Rebind with Space through the rendered notice", async () => {
    const controller = new AnalysisFieldOverlayController();
    controller.set({
      fieldId: "field-old",
      label: "Old mode",
      query: { phase_rad: 0, view: "phase_rotated_real" },
      source: "eigen-mode",
    });
    controller.setResultContext("run-new");
    const target = {
      fieldId: "field-new",
      frequencyHz: 13e9,
      label: "New mode",
      modeIndex: 2,
      provenance: {
        artifactRevision: 8,
        equilibriumId: "eq-new",
        kContextKind: "gamma" as const,
        representation: "complex-vector-xyz" as const,
        resourceRef: "data/fields/field-new",
        runId: "run-new",
        stageId: "stage-new",
        studyProduct: "modal_eigen",
      },
      query: { phase_rad: 0, view: "phase_rotated_real" },
      sampleIndex: 0,
      source: "eigen-mode" as const,
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <AnalysisFieldOverlayContextNotice
          context={controller.getContextSnapshot()}
          onClear={() => controller.clear()}
          onRebind={() => controller.rebind(target)}
          rebindDisabledReason={controller.rebindDisabledReason(target)}
        />,
      ));
      const rebind = findElement(container, (element) => element.textContent === "Rebind", "Rebind action");

      await pressNativeButton(rebind, " ");

      expect(controller.getSnapshot()?.fieldId).toBe("field-new");
      expect(controller.getContextSnapshot().status).toBe("compatible");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("disables Rebind and exposes the reason without hiding Clear", () => {
    const html = renderToStaticMarkup(
      <AnalysisFieldOverlayContextNotice
        context={{
          overlay: {
            fieldId: "field-unowned",
            label: "Unowned mode",
            query: { phase_rad: 0, view: "phase_rotated_real" },
            source: "eigen-mode",
          },
          reason: "Owner identity is incomplete.",
          resultRunId: "run-new",
          status: "unverified",
        }}
        onClear={() => undefined}
        onRebind={() => undefined}
        rebindDisabledReason="Select a typed analysis field in run-new."
      />,
    );

    expect(html).toContain("Select a typed analysis field in run-new.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Rebind<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Clear<\/button>/);
  });
});
