import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

vi.mock("@/shared/ui/Select", () => ({
  Select: ({ onValueChange }: { onValueChange: (value: string) => void }) => (
    <button
      aria-label="Contextual analysis subview"
      onKeyDown={(event: React.KeyboardEvent) => {
        if (event.key === "ArrowDown") onValueChange("dynamics.temporal-fft");
      }}
      type="button"
    >
      Change subview
    </button>
  ),
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

import { AnalysisSurfaceTabs } from "./AnalysisSurfaceTabs";

describe("AnalysisSurfaceTabs interaction", () => {
  it("forwards a keyboard-driven contextual subview change", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const onSubviewChange = vi.fn();
    try {
      await act(async () => root.render(
        <AnalysisSurfaceTabs
          active="dynamics"
          activeSubview="dynamics.time-traces"
          onChange={() => undefined}
          onSubviewChange={onSubviewChange}
          subviews={["dynamics.time-traces", "dynamics.temporal-fft", "dynamics.s-k-f"]}
        />,
      ));
      const control = findElement(
        container,
        (element) => element.getAttribute("aria-label") === "Contextual analysis subview",
        "contextual analysis subview control",
      );
      await act(async () => control.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "ArrowDown" })));
      expect(onSubviewChange).toHaveBeenCalledWith("dynamics.temporal-fft");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
