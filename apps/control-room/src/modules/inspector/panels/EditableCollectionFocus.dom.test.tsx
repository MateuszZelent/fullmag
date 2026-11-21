import { act, useState } from "react";
import { describe, expect, it } from "vitest";
import {
  findElement, installSimulationPreparationTestDom, TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { TransportCollectionFields } from "./TransportCollectionFields";
import { DEFAULT_STAGE_AUTOSAVE_DRAFT } from "./StageAutosaveDraft";
import { StageAutosaveSection } from "./stages/StageAutosaveSection";

function TransportFixture() {
  const [value, setValue] = useState('[{"id":"left","surfaces":[]},{"id":"right","surfaces":[]}]');
  return <TransportCollectionFields family="spin_transport" collection="boundaries" value={value} scene={null} onChange={setValue} />;
}

function AutosaveFixture() {
  const [draft, setDraft] = useState({
    ...DEFAULT_STAGE_AUTOSAVE_DRAFT,
    enabled: true,
    fields: [{ quantity: "left", cadence: "10" }, { quantity: "right", cadence: "10" }],
  });
  return <StageAutosaveSection draft={draft} onChange={setDraft} owner="relax" />;
}

describe("editable Inspector rows", () => {
  it.each([
    { Fixture: TransportFixture, label: "Boundary ID", remove: "Remove row from draft" },
    { Fixture: AutosaveFixture, label: "Quantity", remove: "Remove field left" },
  ])("retains the $label input across rename, duplicate values and sibling deletion", async ({ Fixture, label, remove }) => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<Fixture />));
      const inputs = () => container.querySelectorAll("input").filter(node => node.getAttribute("aria-label") === label);
      const second = inputs()[1];
      second.focus();
      for (const value of ["r", "ri", "left"]) {
        await act(async () => {
          second.value = value;
          second.dispatchEvent(new TestEvent("input", { bubbles: true }));
        });
        expect(inputs()[1] === second).toBe(true);
        expect(dom.document.activeElement === second).toBe(true);
      }
      const removeFirst = findElement(container, node => node.tagName === "BUTTON"
        && (node.getAttribute("aria-label") === remove || node.textContent.trim() === remove), remove);
      await act(async () => removeFirst.click());
      expect(inputs()).toHaveLength(1);
      expect(inputs()[0] === second).toBe(true);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
