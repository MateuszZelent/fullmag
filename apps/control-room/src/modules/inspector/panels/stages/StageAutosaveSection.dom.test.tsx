import { act, useState } from "react";
import { describe, expect, it } from "vitest";

import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import {
  DEFAULT_STAGE_AUTOSAVE_DRAFT,
  type StageAutosaveDraft,
} from "../StageAutosaveDraft";
import { StageAutosaveSection } from "./StageAutosaveSection";

describe("StageAutosaveSection row identity", () => {
  it("keeps the edited input focused and preserves the following row when an earlier row is removed", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => root.render(<StatefulAutosaveSection />));

      const [firstQuantity, secondQuantity] = quantityInputs(container);
      firstQuantity.focus();
      await act(async () => editControl(firstQuantity, "mx"));

      expect(quantityInputs(container)[0]).toBe(firstQuantity);
      expect(dom.document.activeElement).toBe(firstQuantity);
      expect(quantityInputs(container)[1]).toBe(secondQuantity);

      const removeFirst = findElement(
        container,
        (element) => element.tagName === "BUTTON" &&
          element.getAttribute("aria-label") === "Remove field mx",
        "remove button for the edited first field",
      );
      await act(async () => removeFirst.click());

      const remaining = quantityInputs(container);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toBe(secondQuantity);
      expect(remaining[0].value).toBe("H_demag");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function StatefulAutosaveSection() {
  const [draft, setDraft] = useState<StageAutosaveDraft>(() => ({
    ...DEFAULT_STAGE_AUTOSAVE_DRAFT,
    enabled: true,
    fields: [
      { cadence: "1e-12", quantity: "m", rowKey: "original-0" },
      { cadence: "2e-12", quantity: "H_demag", rowKey: "original-1" },
    ],
  }));
  return <StageAutosaveSection draft={draft} owner="run" onChange={setDraft} />;
}

function quantityInputs(root: TestNode): TestElement[] {
  return findElements(
    root,
    (element) => element.tagName === "INPUT" &&
      element.getAttribute("aria-label") === "Quantity",
  );
}

function editControl(control: TestElement, value: string): void {
  const tracker = (control as TestElement & {
    _valueTracker?: { setValue: (next: string) => void };
  })._valueTracker;
  const previous = control.value;
  control.value = value;
  tracker?.setValue(previous);
  control.dispatchEvent(new TestEvent("input", { bubbles: true }));
}
