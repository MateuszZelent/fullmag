import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

const selectedValues: string[] = [];
vi.mock("@/shared/ui/Select", () => ({
  Select: ({ children, onValueChange, value }: { children: React.ReactNode; onValueChange: (value: string) => void; value: string }) => {
    selectedValues.push(value);
    return <button aria-label="Display unit for Period" onClick={() => onValueChange("ns")} type="button">{children}</button>;
  },
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));

import { ChartDisplayUnitControls } from "./ChartDisplayUnitControls";

const series = [{
  id: "period",
  label: "Period",
  points: [{ rowIndex: 0, x: 0, y: 1e-9 }],
  quantity: "period",
  source: { kind: "data.table.rows" as const, resourceKey: "table-a", tableId: "table-a" },
  status: "ready" as const,
  unit: "s",
  xUnit: "1",
}];

describe("ChartDisplayUnitControls", () => {
  it("groups quantities sharing one source axis, emits one patch, and restores its persisted value", async () => {
    selectedValues.length = 0;
    const onDisplayUnitsChange = vi.fn();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ChartDisplayUnitControls displayUnits={{}} onDisplayUnitsChange={onDisplayUnitsChange} series={[...series, { ...series[0]!, id: "period-2", quantity: "decay", label: "Decay" }]} />));
      const control = container.querySelector("button")!;
      await act(async () => control.click());
      expect(onDisplayUnitsChange).toHaveBeenCalledWith({ decay: "ns", period: "ns" });

      await act(async () => root.render(<ChartDisplayUnitControls displayUnits={{ decay: "ns", period: "ns" }} onDisplayUnitsChange={onDisplayUnitsChange} series={[...series, { ...series[0]!, id: "period-2", quantity: "decay", label: "Decay" }]} />));
      expect(selectedValues).toContain("ns");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not render a no-op selector when the source unit has no alternatives", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ChartDisplayUnitControls displayUnits={{}} onDisplayUnitsChange={() => undefined} series={[{ ...series[0]!, unit: "a.u." }]} />));
      expect(container.querySelector("button")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
